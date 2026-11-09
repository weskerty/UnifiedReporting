// .plugin https://gist.github.com/weskerty/fa4dec51ffb404a82f246e42a837af4d

// Plugin de reportes federados por LID. Requiere la misma copia instalada en cada sesion
const REPORT_OWNER = 'weskerty'
const REPORT_REPO = 'UnifiedReporting'
const REPORT_BRANCH = 'data'

const fs = require('fs').promises
const path = require('path')
const { bot, logger, setVar, getVars, sleep } = require('../lib/')

const MEDIA_DIR = path.join(process.cwd(), 'media')
const REPORT_DIR = path.join(MEDIA_DIR, 'report') // todo lo que este script guarda vive aca
const REPORTADOS_PATH = path.join(REPORT_DIR, 'reportados.json')
const YA_PATH = path.join(REPORT_DIR, 'ya_informado.json')
const LIDCACHE_PATH = path.join(REPORT_DIR, 'lidcache.json')
const PLUGINS_DIR = path.join(REPORT_DIR, 'plugins')
const REFRESH_MS = 60 * 60 * 1000
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
const LIDCACHE_NEG_TTL = 24 * 60 * 60 * 1000 // re-intenta un numero no encontrado despues de 1 dia
const SCAN_MIN_MS = 10 * 1000
const SCAN_MAX_MS = 30 * 1000
const randomScanDelay = () => SCAN_MIN_MS + Math.floor(Math.random() * (SCAN_MAX_MS - SCAN_MIN_MS))
const RAW_URL = `https://raw.githubusercontent.com/${REPORT_OWNER}/${REPORT_REPO}/${REPORT_BRANCH}/reportados.json`

let CATEGORIAS = []
let REPORTES = new Map()
let etag = null
let lidCacheData = {} // numero -> { lid: string|null, checked: ms } - persistido en disco
let investigationPlugins = [] // media/report/plugins/*.js, cada uno: { name, check({numero, lid}) }

async function loadInvestigationPlugins() {
  investigationPlugins = []
  let files = []
  try { files = await fs.readdir(PLUGINS_DIR) } catch { return }
  for (const f of files) {
    if (!f.endsWith('.js')) continue
    try {
      const mod = require(path.join(PLUGINS_DIR, f))
      if (mod && typeof mod.check === 'function') investigationPlugins.push(mod)
    } catch (e) {
      logger.error(`[report] plugin ${f}: ${e.message}`)
    }
  }
}

// ---- escritura segura: cola de promesas en memoria + lockfile con PID en disco ----
const writeQueues = new Map()

async function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function withLock(file, fn) {
  const lockPath = file + '.lock'
  for (let i = 0; i < 20; i++) {
    try {
      await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' })
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        const pid = parseInt(await fs.readFile(lockPath, 'utf8'), 10)
        if (!(await isAlive(pid))) { await fs.unlink(lockPath).catch(() => {}); continue }
      } catch {}
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  try {
    return await fn()
  } finally {
    await fs.unlink(lockPath).catch(() => {})
  }
}

function writeJsonLocked(file, data) {
  const prev = writeQueues.get(file) || Promise.resolve()
  const next = prev
    .then(() =>
      withLock(file, async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file + '.tmp', JSON.stringify(data, null, 2), 'utf8')
        await fs.rename(file + '.tmp', file)
      })
    )
    .catch((e) => logger.error(`[report] write ${file}: ${e.message}`))
  writeQueues.set(file, next)
  return next
}

async function readJsonSafe(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return fallback }
}

async function cleanStaleLocks() {
  try {
    const files = await fs.readdir(REPORT_DIR)
    for (const f of files) {
      if (!f.endsWith('.lock')) continue
      const full = path.join(REPORT_DIR, f)
      try {
        const pid = parseInt(await fs.readFile(full, 'utf8'), 10)
        if (!(await isAlive(pid))) await fs.unlink(full).catch(() => {})
      } catch {
        await fs.unlink(full).catch(() => {})
      }
    }
  } catch {}
}

// ---- cooldown de aviso por lid+grupo (1 semana) ----
async function yaInformadoCheck(lid, gid) {
  const d = await readJsonSafe(YA_PATH, {})
  const t = d[lid]?.[gid]
  return !!(t && Date.now() - t < COOLDOWN_MS)
}

async function yaInformadoSet(lid, gid) {
  const d = await readJsonSafe(YA_PATH, {})
  d[lid] = d[lid] || {}
  d[lid][gid] = Date.now()
  await writeJsonLocked(YA_PATH, d)
}

async function yaInformadoPrune() {
  const d = await readJsonSafe(YA_PATH, {})
  let changed = false
  for (const lid of Object.keys(d)) {
    for (const gid of Object.keys(d[lid])) {
      if (Date.now() - d[lid][gid] > COOLDOWN_MS) { delete d[lid][gid]; changed = true }
    }
    if (!Object.keys(d[lid]).length) { delete d[lid]; changed = true }
  }
  if (changed) await writeJsonLocked(YA_PATH, d)
}

// ---- sync de reportados.json (ETag, 1 dia) ----
async function refreshReportados() {
  try {
    const headers = etag ? { 'If-None-Match': etag } : {}
    const res = await fetch(RAW_URL, { headers })
    if (res.status === 304) return
    if (!res.ok) return
    etag = res.headers.get('etag')
    const data = await res.json()
    CATEGORIAS = Array.isArray(data.categorias) ? data.categorias : []
    REPORTES = new Map(Object.entries(data.reportes || {}))
    await writeJsonLocked(REPORTADOS_PATH, data)
  } catch (e) {
    logger.error('[report] refresh: ' + e.message)
  }
}

async function loadLocalReportados() {
  const local = await readJsonSafe(REPORTADOS_PATH, null)
  if (local) {
    CATEGORIAS = Array.isArray(local.categorias) ? local.categorias : []
    REPORTES = new Map(Object.entries(local.reportes || {}))
  }
}

// ---- resolucion lid/numero desde un mensaje (igual patron que autojoin.js) ----
function infoFromKey(key, fallbackParticipant) {
  let lid = null, numero = null
  if (key) {
    if (String(key.participant || '').endsWith('@lid')) lid = key.participant
    if (String(key.participantAlt || '').endsWith('@s.whatsapp.net')) numero = key.participantAlt.split('@')[0]
  }
  if (!numero && fallbackParticipant && String(fallbackParticipant).endsWith('@s.whatsapp.net')) {
    numero = fallbackParticipant.split('@')[0]
  }
  if (!lid && String(fallbackParticipant || '').endsWith('@lid')) lid = fallbackParticipant
  return { lid, numero }
}

const senderInfo = (message) => infoFromKey(message.message?.key, message.participant)
const quotedInfo = (message) => infoFromKey(message.reply_message?.key, message.reply_message?.participant)

// ---- registro en memoria compartido entre las 3 sesiones (mismo proceso) ----
const boundClients = new WeakSet()

async function registerSession(message, ctx) {
  global.__xreport = global.__xreport || {}
  global.__xreport[message.id] = {
    groupMetadata: (gid) => message.groupMetadata(gid), // wrapper de Levanter: array plano de participantes
    getGids: () => message.getGids(),
  }
  // Sin token ni REPORTSENDINFO=true: no se suscribe a group.join-request ni carga
  // los plugins de investigacion - queda puramente pasiva (solo alimenta __xreport).
  if (!boundClients.has(message.client) && shouldSendInfo(ctx)) {
    boundClients.add(message.client)
    await loadInvestigationPlugins()
    bindGjoin(message.client, message.id)
  }
}

async function loadLidCache() {
  lidCacheData = await readJsonSafe(LIDCACHE_PATH, {})
}

// Guarda TODOS los participantes vistos en el grupo, no solo el que se busca - ya que la
// llamada trae la lista completa igual, asi los proximos numeros de ese grupo salen gratis.
// Mergea con lo que haya en disco antes de escribir, porque las 3 copias del plugin
// (una por sesion) comparten este archivo pero cada una tiene su propia copia en memoria.
async function cacheParticipants(participants) {
  const now = Date.now()
  const updates = {}
  for (const p of participants) {
    if (p.phoneNumber && p.id) updates[p.phoneNumber.split('@')[0]] = { lid: p.id, checked: now }
  }
  if (!Object.keys(updates).length) return
  const onDisk = await readJsonSafe(LIDCACHE_PATH, {})
  lidCacheData = { ...onDisk, ...lidCacheData, ...updates }
  await writeJsonLocked(LIDCACHE_PATH, lidCacheData)
}

async function findLidByNumero(numero) {
  const cached = lidCacheData[numero]
  if (cached) {
    if (cached.lid) return cached.lid
    if (Date.now() - cached.checked < LIDCACHE_NEG_TTL) return null
  }
  for (const sess of Object.values(global.__xreport || {})) {
    try {
      const gids = await sess.getGids()
      for (const gid of Object.keys(gids)) {
        try {
          const participants = await sess.groupMetadata(gid)
          await cacheParticipants(participants)
          if (lidCacheData[numero]?.lid) return lidCacheData[numero].lid
        } catch {}
        await sleep(randomScanDelay()) // 10-30s aleatorio entre grupos, prioridad anti-ban sobre velocidad
      }
    } catch {}
  }
  if (!lidCacheData[numero]) {
    const onDisk = await readJsonSafe(LIDCACHE_PATH, {})
    lidCacheData = { ...onDisk, ...lidCacheData, [numero]: { lid: null, checked: Date.now() } }
    await writeJsonLocked(LIDCACHE_PATH, lidCacheData)
  }
  return null
}

function shouldSendInfo(ctx) {
  if (ctx?.GITHUB_REPORT_TOKEN) return true
  return String(ctx?.REPORTSENDINFO).toLowerCase() === 'true'
}

function allowedCountry(numero, ctx) {
  const raw = (ctx?.GJOIN_PAISES || '').trim()
  if (!raw) return false
  if (raw.toLowerCase() === 'all') return true
  return raw.split(',').map((s) => s.trim()).filter(Boolean).some((p) => numero.startsWith(p))
}

function catsLine(entry) {
  return Object.entries(entry.categorias || {}).map(([em, c]) => `${em} ${c}`).join(' ')
}

// ---- auto-aprobar solicitudes de grupo ----
// Decision de aprobar depende SOLO de reportados.json. Los plugins de media/report/plugins/
// (listahu.js, etc.) nunca vetan - son puramente informativos, uno al grupo por cada uno.
function bindGjoin(client, sessionId) {
  client.ev.on('group.join-request', async (e) => {
    try {
      if (e.action !== 'created') return
      let lid = null, numero = null
      for (const c of [e.participant, e.participantPn]) {
        if (!c) continue
        const s = String(c)
        if (s.endsWith('@lid')) lid = s
        else numero = s.split('@')[0].split(':')[0]
      }
      if (!lid && !numero) return // no identificable, se ignora
      if (!lid && numero && lidCacheData[numero]?.lid) lid = lidCacheData[numero].lid

      const reportado = lid && REPORTES.has(lid)
      await client.sendMessage(e.id, {
        text: reportado ? `UnifiedReporting: ${catsLine(REPORTES.get(lid))}` : 'UnifiedReporting: ✅',
      }).catch(() => {})

      for (const plugin of investigationPlugins) {
        try {
          const r = await plugin.check({ numero, lid })
          if (!r) continue
          if (r.imagen) {
            await client.sendMessage(e.id, { image: { url: r.imagen }, caption: r.texto || '' }).catch(() => {})
          } else if (r.texto) {
            await client.sendMessage(e.id, { text: r.texto }).catch(() => {})
          }
        } catch (err) {
          logger.error(`[report] plugin ${plugin.name || '?'}: ${err.message}`)
        }
      }

      if (reportado) return // no aprueba ni rechaza

      if (numero) {
        const ctx = await getVars(sessionId)
        if (allowedCountry(numero, ctx)) {
          const target = e.participant || e.participantPn
          await client.groupRequestParticipantsUpdate(e.id, [target], 'approve').catch(() => {})
        }
      }
      // resto de casos: queda pendiente, sin accion
    } catch (err) {
      logger.error('[report] gjoin: ' + err.message)
    }
  })
}

// ---- abrir issue de reporte ----
async function fileReportIssue({ lid, numero, categoria, token }) {
  const payload = { lid, numero: numero || '', categoria }
  const body = '```report\n' + JSON.stringify(payload) + '\n```'
  const res = await fetch(`https://api.github.com/repos/${REPORT_OWNER}/${REPORT_REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'levanter-report-plugin',
    },
    body: JSON.stringify({ title: '[report] sync', body }),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
}

// ---- boot ----
;(async () => {
  await loadLocalReportados()
  await loadLidCache()
  await cleanStaleLocks()
  await yaInformadoPrune()
  await refreshReportados()
  setInterval(refreshReportados, REFRESH_MS)
})().catch((e) => logger.error('[report] boot: ' + e.message))

// ---- detector pasivo ----
// Sin GITHUB_REPORT_TOKEN, la cuenta solo investiga en silencio (alimenta global.__xreport)
// salvo que ctx.REPORTSENDINFO sea 'true' - asi solo la cuenta principal avisa por defecto.
bot({ on: 'message', fromMe: false, type: 'report_core' }, async (message, match, ctx) => {
  try {
    await registerSession(message, ctx)
    const { lid } = senderInfo(message)
    if (!lid || !REPORTES.has(lid)) return
    if (!shouldSendInfo(ctx)) return
    if (await yaInformadoCheck(lid, message.jid)) return
    await message.send(catsLine(REPORTES.get(lid)), { quoted: message.data })
    await yaInformadoSet(lid, message.jid)
  } catch (e) {
    logger.error('[report] detector: ' + e.message)
  }
})

// ---- comando .report ----
bot(
  {
    pattern: 'report ?(.*)',
    fromMe: true,
    desc: 'Reportar un usuario por LID a la lista federada',
    type: 'misc',
  },
  async (message, match, ctx) => {
    const arg = (match || '').trim()

    if (/^login\s+/i.test(arg)) {
      const token = arg.replace(/^login\s+/i, '').trim()
      if (token) await setVar({ GITHUB_REPORT_TOKEN: token }, message.id)
      return message.send('👌')
    }

    const rawParts = arg.split(/\s+/).filter(Boolean)
    let categoria = null
    const rest = []
    for (const p of rawParts) {
      if (CATEGORIAS.includes(p)) categoria = p
      else rest.push(p)
    }
    // junta el resto y quita espacios/guiones/parentesis antes de validar el numero completo
    const joined = rest.join('').replace(/[^\d+]/g, '')
    const numeroArg = /^\+?\d{6,15}$/.test(joined) ? joined.replace(/^\+/, '') : null
    if (!categoria) {
      return message.send(`categorias disponibles: ${CATEGORIAS.join(' ') || '(sin cargar)'}`)
    }

    const token = ctx.GITHUB_REPORT_TOKEN
    if (!token) return message.send('inicia sesion en github y pega tu token con: .report login <token>')

    // numero suelto: el escaneo de grupos puede tardar minutos (10-30s por grupo, anti-ban).
    // se avisa y se sigue en segundo plano, no se bloquea el handler.
    if (numeroArg) {
      message.send('🔎').catch(() => {})
      ;(async () => {
        const lid = await findLidByNumero(numeroArg)
        if (!lid) return message.send('debo estar en el mismo grupo').catch(() => {})
        await fileReportIssue({ lid, numero: numeroArg, categoria, token }).catch((e) => logger.error('[report] issue: ' + e.message))
        await message.send('👌').catch(() => {})
      })()
      return
    }

    const info = message.reply_message ? quotedInfo(message) : {}
    if (!info.lid) return message.send('debo estar en el mismo grupo')

    fileReportIssue({ lid: info.lid, numero: info.numero, categoria, token }).catch((e) => logger.error('[report] issue: ' + e.message))
    return message.send('👌')
  }
)

module.exports = {}
