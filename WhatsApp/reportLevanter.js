// Plugin de reportes federados por LID. Requiere la misma copia instalada en cada sesion
// (eplugins/<id>report.js) para que cada cuenta vea sus propios grupos/solicitudes.
const REPORT_OWNER = 'weskerty'
const REPORT_REPO = 'UnifiedReporting'
const REPORT_TAG = 'data' // tag de la Release, no una rama - el asset no pesa sobre el repo git

const fs = require('fs').promises
const path = require('path')
const crypto = require('crypto')
const sqlite3 = require('sqlite3')
const { bot, logger, setVar, getVars, sleep } = require('../lib/')

const MEDIA_DIR = path.join(process.cwd(), 'media')
const REPORT_DIR = path.join(MEDIA_DIR, 'report') // todo lo que este script guarda vive aca
const REPORTADOS_DB_PATH = path.join(REPORT_DIR, 'reportados.db') // espejo descargado, de solo lectura, se reemplaza entero
const LOCAL_DB_PATH = path.join(REPORT_DIR, 'local.db') // lidcache + ya_informado, lectura/escritura propia del bot
const PLUGINS_DIR = path.join(REPORT_DIR, 'plugins')
const REFRESH_MS = 60 * 60 * 1000
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
const LIDCACHE_POS_TTL = 365 * 24 * 60 * 60 * 1000 // un lid encontrado se confia por 1 ano
const LIDCACHE_NEG_TTL = 24 * 60 * 60 * 1000 // un numero no encontrado se re-intenta despues de 1 dia
const SCAN_MIN_MS = 10 * 1000
const SCAN_MAX_MS = 30 * 1000
const randomScanDelay = () => SCAN_MIN_MS + Math.floor(Math.random() * (SCAN_MAX_MS - SCAN_MIN_MS))
const RELEASE_API_URL = `https://api.github.com/repos/${REPORT_OWNER}/${REPORT_REPO}/releases/tags/${REPORT_TAG}`

// ---- helpers promise sobre sqlite3 (callback-style por defecto) ----
const dbRun = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this) }))
const dbGet = (db, sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))))
const dbAll = (db, sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))))

let reportadosDb = null // de solo lectura, se reabre cada vez que se descarga una version nueva
let localDb = null
let etag = null
let CATEGORIAS = []
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

// ---- local.db: lidcache + ya_informado. SQLite maneja la concurrencia entre las 3 sesiones solo. ----
function openLocalDb() {
  localDb = new sqlite3.Database(LOCAL_DB_PATH, (err) => {
    if (err) return logger.error('[report] open local.db: ' + err.message)
    localDb.run('PRAGMA journal_mode=WAL')
    localDb.run('CREATE TABLE IF NOT EXISTS lidcache (numero TEXT PRIMARY KEY, lid TEXT, checked INTEGER)')
    localDb.run('CREATE TABLE IF NOT EXISTS ya_informado (lid TEXT, gid TEXT, ts INTEGER, PRIMARY KEY (lid, gid))')
  })
}

async function yaInformadoCheck(lid, gid) {
  const row = await dbGet(localDb, 'SELECT ts FROM ya_informado WHERE lid = ? AND gid = ?', [lid, gid]).catch(() => null)
  return !!(row && Date.now() - row.ts < COOLDOWN_MS)
}

async function yaInformadoSet(lid, gid) {
  const now = Date.now()
  await dbRun(
    localDb,
    'INSERT INTO ya_informado (lid, gid, ts) VALUES (?, ?, ?) ON CONFLICT(lid, gid) DO UPDATE SET ts = ?',
    [lid, gid, now, now]
  ).catch((e) => logger.error('[report] yaInformadoSet: ' + e.message))
}

async function yaInformadoPrune() {
  await dbRun(localDb, 'DELETE FROM ya_informado WHERE ts < ?', [Date.now() - COOLDOWN_MS]).catch(() => {})
}

// Guarda TODOS los participantes vistos en el grupo, no solo el que se busca - ya que la
// llamada trae la lista completa igual, asi los proximos numeros de ese grupo salen gratis.
async function cacheParticipants(participants) {
  const now = Date.now()
  for (const p of participants) {
    if (!p.phoneNumber || !p.id) continue
    const numero = p.phoneNumber.split('@')[0]
    await dbRun(
      localDb,
      'INSERT INTO lidcache (numero, lid, checked) VALUES (?, ?, ?) ON CONFLICT(numero) DO UPDATE SET lid = ?, checked = ?',
      [numero, p.id, now, p.id, now]
    ).catch((e) => logger.error('[report] cacheParticipants: ' + e.message))
  }
}

async function findLidByNumero(numero) {
  const cached = await dbGet(localDb, 'SELECT lid, checked FROM lidcache WHERE numero = ?', [numero]).catch(() => null)
  if (cached) {
    const age = Date.now() - cached.checked
    if (cached.lid && age < LIDCACHE_POS_TTL) return cached.lid
    if (!cached.lid && age < LIDCACHE_NEG_TTL) return null
    // vencido (positivo de mas de 1 ano, o negativo de mas de 1 dia): se re-escanea
  }
  for (const sess of Object.values(global.__xreport || {})) {
    try {
      const gids = await sess.getGids()
      for (const gid of Object.keys(gids)) {
        try {
          const participants = await sess.groupMetadata(gid)
          await cacheParticipants(participants)
          const hit = await dbGet(localDb, 'SELECT lid FROM lidcache WHERE numero = ? AND lid IS NOT NULL', [numero]).catch(() => null)
          if (hit) return hit.lid
        } catch {}
        await sleep(randomScanDelay()) // 10-30s aleatorio entre grupos, prioridad anti-ban sobre velocidad
      }
    } catch {}
  }
  const now = Date.now()
  await dbRun(
    localDb,
    'INSERT INTO lidcache (numero, lid, checked) VALUES (?, NULL, ?) ON CONFLICT(numero) DO UPDATE SET lid = NULL, checked = ?',
    [numero, now, now]
  ).catch(() => {})
  return null
}

// ---- reportados.db: espejo descargado. Se reemplaza entero via temp+rename, nunca se edita en el lugar. ----
function openReportadosDb() {
  if (reportadosDb) { try { reportadosDb.close() } catch {} }
  reportadosDb = new sqlite3.Database(REPORTADOS_DB_PATH, sqlite3.OPEN_READONLY, async (err) => {
    if (err) { reportadosDb = null; return }
    const rows = await dbAll(reportadosDb, 'SELECT emoji FROM categorias_meta').catch(() => [])
    CATEGORIAS = rows.map((r) => r.emoji)
  })
}

async function getReporte(lid) {
  if (!reportadosDb) return null
  const row = await dbGet(reportadosDb, 'SELECT numero, categorias, extra FROM reportes WHERE lid = ?', [lid]).catch(() => null)
  if (!row) return null
  return { numero: row.numero, categorias: JSON.parse(row.categorias || '{}'), extra: JSON.parse(row.extra || '{}') }
}

async function refreshReportados() {
  try {
    const headers = { Accept: 'application/vnd.github+json' }
    if (etag) headers['If-None-Match'] = etag
    const res = await fetch(RELEASE_API_URL, { headers })
    if (res.status === 304) return // no cambio nada, barato - no se toca el asset para nada
    if (!res.ok) return
    etag = res.headers.get('etag')
    const release = await res.json()
    const asset = (release.assets || []).find((a) => a.name === 'reportados.db')
    if (!asset) return
    const expectedHash = (release.body || '').match(/sha256:([0-9a-f]{64})/i)?.[1]?.toLowerCase()

    const dlRes = await fetch(asset.browser_download_url)
    if (!dlRes.ok) return
    const buf = Buffer.from(await dlRes.arrayBuffer())

    if (expectedHash) {
      const actualHash = crypto.createHash('sha256').update(buf).digest('hex')
      if (actualHash !== expectedHash) {
        logger.error('[report] refresh: hash no coincide, se descarta la descarga')
        return
      }
    }

    await fs.mkdir(REPORT_DIR, { recursive: true })
    await fs.writeFile(REPORTADOS_DB_PATH + '.tmp', buf)
    await fs.rename(REPORTADOS_DB_PATH + '.tmp', REPORTADOS_DB_PATH)
    openReportadosDb()
  } catch (e) {
    logger.error('[report] refresh: ' + e.message)
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
// Decision de aprobar depende SOLO de reportados.db. Los plugins de media/report/plugins/
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
      if (!lid && numero) {
        const cached = await dbGet(localDb, 'SELECT lid FROM lidcache WHERE numero = ? AND lid IS NOT NULL', [numero]).catch(() => null)
        if (cached) lid = cached.lid
      }

      const reporte = lid ? await getReporte(lid) : null
      await client.sendMessage(e.id, {
        text: reporte ? `UnifiedReporting: ${catsLine(reporte)}` : 'UnifiedReporting: ✅',
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

      if (reporte) return // no aprueba ni rechaza

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
  await fs.mkdir(REPORT_DIR, { recursive: true })
  openLocalDb()
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
    if (!lid) return
    if (!shouldSendInfo(ctx)) return
    const reporte = await getReporte(lid)
    if (!reporte) return
    if (await yaInformadoCheck(lid, message.jid)) return
    await message.send(catsLine(reporte), { quoted: message.data })
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
