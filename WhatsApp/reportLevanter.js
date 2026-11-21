// NEED https://levanter.site/
const REPORT_OWNER = 'weskerty'
const REPORT_REPO = 'UnifiedReporting'
const REPORT_TAG = 'data'

const fs = require('fs').promises
const path = require('path')
const crypto = require('crypto')
const sqlite3 = require('sqlite3')
const { bot, logger, setVar, getVars, sleep, isAdmin } = require('../lib/')

const MEDIA_DIR = path.join(process.cwd(), 'media')
const REPORT_DIR = path.join(MEDIA_DIR, 'report')
const REPORTADOS_DB_PATH = path.join(REPORT_DIR, 'reportados.db')
const LOCAL_DB_PATH = path.join(REPORT_DIR, 'local.db')
const PLUGINS_DIR = path.join(REPORT_DIR, 'plugins')
const REFRESH_MS = 60 * 60 * 1000
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
const SCAN_START_DELAY_MS = 10 * 60 * 1000
const LIDCACHE_REFRESH_MS = 72 * 60 * 60 * 1000
const POLL_MS = 24 * 60 * 60 * 1000
const GROUP_FETCH_GAP_MS = 2 * 60 * 60 * 1000
const GROUP_STEP_MIN_MS = 60 * 1000
const GROUP_STEP_MAX_MS = 180 * 1000
const REQUEST_STEP_MIN_MS = 15 * 1000
const REQUEST_STEP_MAX_MS = 45 * 1000
const randomDelay = (min, max) => min + Math.floor(Math.random() * (max - min))
const groupStepDelay = () => randomDelay(GROUP_STEP_MIN_MS, GROUP_STEP_MAX_MS)
const requestStepDelay = () => randomDelay(REQUEST_STEP_MIN_MS, REQUEST_STEP_MAX_MS)
const RELEASE_API_URL = `https://api.github.com/repos/${REPORT_OWNER}/${REPORT_REPO}/releases/tags/${REPORT_TAG}`


const dbRun = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this) }))
const dbGet = (db, sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))))
const dbAll = (db, sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))))

let reportadosDb = null
let localDb = null
let etag = null
let CATEGORIAS = []
let investigationPlugins = [] // media/report/plugins/*.js, cada uno: { name, check({numero, lid, ctx}) -> {texto, imagen?, veto?} }

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


function openLocalDb() {
  localDb = new sqlite3.Database(LOCAL_DB_PATH, (err) => {
    if (err) return logger.error('[report] open local.db: ' + err.message)
    localDb.run('PRAGMA journal_mode=WAL')
    localDb.run('CREATE TABLE IF NOT EXISTS lidcache (numero TEXT PRIMARY KEY, lid TEXT)')
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


async function cacheParticipants(participants) {
  for (const p of participants) {
    if (!p.phoneNumber || !p.id) continue
    const numero = p.phoneNumber.split('@')[0]
    await dbRun(
      localDb,
      'INSERT INTO lidcache (numero, lid) VALUES (?, ?) ON CONFLICT(numero) DO UPDATE SET lid = excluded.lid',
      [numero, p.id]
    ).catch((e) => logger.error('[report] cacheParticipants: ' + e.message))
  }
}

// lidcache es solo cache: el lid es identidad permanente de la cuenta, no vence. Se repuebla
// entero en cada fetchGroups y las busquedas puntuales solo leen lo que ya este cacheado.
async function findLidByNumero(numero) {
  const cached = await dbGet(localDb, 'SELECT lid FROM lidcache WHERE numero = ?', [numero]).catch(() => null)
  return (cached && cached.lid) || null
}

// Toda consulta masiva de grupos pasa por aqui: el timestamp se marca antes de pedir, asi un
// fallo tambien cuenta como trafico hacia WhatsApp para el margen GROUP_FETCH_GAP_MS.
const groupFetchTs = new WeakMap()
const groupSnapshot = new WeakMap()
const msSinceGroupFetch = (client) => Date.now() - (groupFetchTs.get(client) || 0)

async function fetchGroups(client) {
  groupFetchTs.set(client, Date.now())
  const groups = await client.groupFetchAllParticipating()
  groupSnapshot.set(client, { ts: Date.now(), groups })
  for (const meta of Object.values(groups)) {
    await cacheParticipants(meta.participants)
  }
  return groups
}

async function recentGroups(client) {
  const snap = groupSnapshot.get(client)
  if (snap && Date.now() - snap.ts < GROUP_FETCH_GAP_MS) return snap.groups
  return fetchGroups(client)
}

function openReportadosDb() {
  if (reportadosDb) { try { reportadosDb.close() } catch {} }
  reportadosDb = new sqlite3.Database(REPORTADOS_DB_PATH, sqlite3.OPEN_READONLY, async (err) => {
    if (err) { reportadosDb = null; return }
    const rows = await dbAll(reportadosDb, 'SELECT emoji FROM categorias_meta ORDER BY idx').catch(() => [])
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
    if (res.status === 304) return
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


const boundClients = new WeakSet()
const scanTimers = new WeakMap()
const scanRunning = new WeakSet()

async function registerSession(message, ctx) {
  const client = message.client
  // El escaneo de grupos corre siempre (report/search necesitan lidcache aunque no haya token),
  // con arranque diferido para no sumarse a la rafaga de consultas del inicio de sesion.
  if (!scanTimers.has(client)) scheduleGroupScan(client, message.id, SCAN_START_DELAY_MS)
  // Sin token ni REPORTSENDINFO=true: no se suscribe a group.join-request ni carga
  // los plugins de investigacion - queda puramente pasiva.
  if (!boundClients.has(client) && shouldSendInfo(ctx)) {
    boundClients.add(client)
    await loadInvestigationPlugins()
    bindGjoin(client, message.id)
    if (!scanRunning.has(client)) scheduleGroupScan(client, message.id, SCAN_START_DELAY_MS)
  }
}

function scheduleGroupScan(client, sessionId, delay) {
  clearTimeout(scanTimers.get(client))
  scanTimers.set(client, setTimeout(() => runGroupScan(client, sessionId), delay))
}

// Un solo ciclo por cliente: con poll activo, pollJoinRequests ya repuebla lidcache con su
// propio fetchGroups, asi que no hay un refresh de lidcache aparte duplicando la consulta.
// Nunca corre si hubo una consulta masiva de grupos hace menos de GROUP_FETCH_GAP_MS.
async function runGroupScan(client, sessionId) {
  if (scanRunning.has(client)) return
  const wait = GROUP_FETCH_GAP_MS - msSinceGroupFetch(client)
  if (wait > 0) return scheduleGroupScan(client, sessionId, wait + groupStepDelay())
  const polling = boundClients.has(client)
  scanRunning.add(client)
  try {
    if (polling) await pollJoinRequests(client, sessionId)
    else await fetchGroups(client)
  } catch (e) {
    logger.error('[report] scan: ' + e.message)
  } finally {
    scanRunning.delete(client)
  }
  let next = polling ? POLL_MS : LIDCACHE_REFRESH_MS
  if (!polling && boundClients.has(client)) next = GROUP_FETCH_GAP_MS
  scheduleGroupScan(client, sessionId, next + groupStepDelay())
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

async function investigate(lid, numero, ctx) {
  const reporte = lid ? await getReporte(lid) : null
  const parts = [{ texto: reporte ? `UnifiedReporting: ${catsLine(reporte)}` : 'UnifiedReporting: ✅' }]
  let veto = false
  for (const plugin of investigationPlugins) {
    try {
      const r = await plugin.check({ numero, lid, ctx })
      if (r) {
        parts.push(r)
        if (r.veto) veto = true
      }
    } catch (err) {
      logger.error(`[report] plugin ${plugin.name || '?'}: ${err.message}`)
    }
  }
  return { reporte, parts, veto }
}

// Decision de aprobar: reportados.db, o cualquier plugin de media/report/plugins/ que devuelva veto:true.
async function notifyAndMaybeApprove(client, gid, lid, numero, targetJid, ctx) {
  const { reporte, parts, veto } = await investigate(lid, numero, ctx)
  for (const part of parts) {
    if (part.imagen) {
      await client.sendMessage(gid, { image: { url: part.imagen }, caption: part.texto || '' }).catch(() => {})
    } else if (part.texto) {
      await client.sendMessage(gid, { text: part.texto }).catch(() => {})
    }
  }

  if (reporte || veto) return // no aprueba ni rechaza

  if (numero && allowedCountry(numero, ctx)) {
    await client.groupRequestParticipantsUpdate(gid, [targetJid], 'approve').catch(() => {})
  }
  // resto de casos: queda pendiente, sin accion
}

// group.join-request solo llega si WhatsApp entrega trafico en vivo a ese grupo (el evento se
// emite al procesar un mensaje de protocolo, no es una suscripcion independiente). pollJoinRequests
// cubre los grupos sin trafico reciente consultando directo con groupRequestParticipantsList.
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
      if (!lid && !numero) return
      if (!lid && numero) {
        const cached = await dbGet(localDb, 'SELECT lid FROM lidcache WHERE numero = ? AND lid IS NOT NULL', [numero]).catch(() => null)
        if (cached) lid = cached.lid
      }

      const ctx = await getVars(sessionId)
      await notifyAndMaybeApprove(client, e.id, lid, numero, e.participant || e.participantPn, ctx)
    } catch (err) {
      logger.error('[report] gjoin: ' + err.message)
    }
  })
}

// Un solo groupFetchAllParticipating trae joinApprovalMode + participantes de todos los grupos
// en una llamada; groupRequestParticipantsList (consulta directa, no eventos) se pide solo por
// grupo donde aplica, con pausa anti-ban antes de cada uno y entre cada solicitud notificada.
// ya_informado dedupea entre corridas para no re-notificar una solicitud que queda pendiente
// indefinidamente (sin pais permitido).
async function pollJoinRequests(client, sessionId) {
  const ctx = await getVars(sessionId)
  const myJid = client.user.jid
  const groups = await fetchGroups(client)
  for (const meta of Object.values(groups)) {
    if (!meta.joinApprovalMode) continue
    if (!(await isAdmin(meta.participants, myJid))) continue
    await sleep(groupStepDelay())
    try {
      const pending = await client.groupRequestParticipantsList(meta.id)
      for (const p of pending) {
        const s = String(p.jid)
        let lid = s.endsWith('@lid') ? s : null
        const numero = lid ? null : s.split('@')[0].split(':')[0]
        if (!lid && numero) {
          const cached = await dbGet(localDb, 'SELECT lid FROM lidcache WHERE numero = ? AND lid IS NOT NULL', [numero]).catch(() => null)
          if (cached) lid = cached.lid
        }
        const key = lid || numero
        if (key && (await yaInformadoCheck(key, meta.id))) continue
        await notifyAndMaybeApprove(client, meta.id, lid, numero, p.jid, ctx)
        if (key) await yaInformadoSet(key, meta.id)
        await sleep(requestStepDelay())
      }
    } catch (e) {
      logger.error(`[report] poll ${meta.id}: ${e.message}`)
    }
  }
}

// groupParticipantsUpdate puede no lanzar excepcion al fallar (devuelve status por id).
async function kickFromGroup(message, gid, lid, numero) {
  try {
    const participants = await message.groupMetadata(gid)
    const target = participants.find((p) => p.id === lid || (numero && p.phoneNumber === `${numero}@s.whatsapp.net`))
    if (!target) return false
    if (!(await isAdmin(participants, message.client.user.jid))) return false
    await message.Kick(target.id, gid)
    return true
  } catch {
    return false
  }
}

// Usa la foto de grupos de la ultima consulta masiva si tiene menos de GROUP_FETCH_GAP_MS; si no,
// hace una sola. Solo hay trafico (y pausa) en los grupos donde el objetivo esta y el bot es admin.
async function kickSweep(message, lid, numero, skipGid) {
  try {
    const client = message.client
    const myJid = client.user.jid
    const groups = await recentGroups(client)
    for (const meta of Object.values(groups)) {
      if (meta.id === skipGid) continue
      const target = (meta.participants || []).find((p) => p.id === lid || (numero && p.phoneNumber === `${numero}@s.whatsapp.net`))
      if (!target) continue
      if (!(await isAdmin(meta.participants, myJid))) continue
      await sleep(groupStepDelay())
      try { await message.Kick(target.id, meta.id) } catch {}
    }
  } catch (e) {
    logger.error('[report] kickSweep: ' + e.message)
  }
}

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

;(async () => {
  await fs.mkdir(REPORT_DIR, { recursive: true })
  openLocalDb()
  await yaInformadoPrune()
  await refreshReportados()
  setInterval(refreshReportados, REFRESH_MS)
})().catch((e) => logger.error('[report] boot: ' + e.message))

bot({ on: 'text', fromMe: false, type: 'report_core' }, async (message, match, ctx) => {
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

bot(
  {
    pattern: 'report ?(.*)',
    fromMe: true,
    desc: 'Reportar un usuario Globalmente',
    type: 'misc',
  },
  async (message, match, ctx) => {
    const arg = (match || '').trim()

    if (/^login\s+/i.test(arg)) {
      const token = arg.replace(/^login\s+/i, '').trim()
      if (token) await setVar({ GITHUB_REPORT_TOKEN: token }, message.id)
      return message.send('👌')
    }

    if (/^search(\s|$)/i.test(arg)) {
      const searchArg = arg.replace(/^search\s*/i, '').trim()
      const joined = searchArg.replace(/[^\d+]/g, '')
      const numeroArg = /^\+?\d{6,15}$/.test(joined) ? joined.replace(/^\+/, '') : null

      if (numeroArg) {
        message.send('🔎').catch(() => {})
        ;(async () => {
          const lid = await findLidByNumero(numeroArg)
          if (!lid) return message.send('no encontrado en los grupos en comun').catch(() => {})
          const { parts } = await investigate(lid, numeroArg, ctx)
          for (const part of parts) {
            if (part.imagen) await message.send(part.imagen, { caption: part.texto || '' }, 'image').catch(() => {})
            else if (part.texto) await message.send(part.texto).catch(() => {})
          }
        })()
        return
      }

      const info = message.reply_message ? quotedInfo(message) : {}
      if (!info.lid) return message.send('> Example:\n- report search <numero>\n- report search (citando un mensaje)')

      const { parts } = await investigate(info.lid, info.numero, ctx)
      for (const part of parts) {
        if (part.imagen) await message.send(part.imagen, { caption: part.texto || '' }, 'image')
        else if (part.texto) await message.send(part.texto)
      }
      return
    }

    const rawParts = arg.split(/\s+/).filter(Boolean)
    let categoria = null
    let kickFlag = false
    const rest = []
    for (const p of rawParts) {
      if (CATEGORIAS.includes(p)) categoria = p
      else if (p.toLowerCase() === 'kick') kickFlag = true
      else rest.push(p)
    }
    const joined = rest.join('').replace(/[^\d+]/g, '')
    const numeroArg = /^\+?\d{6,15}$/.test(joined) ? joined.replace(/^\+/, '') : null
    if (!categoria) {
      return message.send(`categorias disponibles: ${CATEGORIAS.join(' ') || '(sin cargar)'}`)
    }

    const token = ctx.GITHUB_REPORT_TOKEN
    if (!token) return message.send('inicia sesion en github y pega tu token con: .report login <token>')

    if (numeroArg) {
      message.send('🔎').catch(() => {})
      ;(async () => {
        const lid = await findLidByNumero(numeroArg)
        if (!lid) return message.send('debo estar en el mismo grupo').catch(() => {})
        await fileReportIssue({ lid, numero: numeroArg, categoria, token }).catch((e) => logger.error('[report] issue: ' + e.message))
        if (kickFlag) await kickSweep(message, lid, numeroArg)
        await message.send('👌').catch(() => {})
      })()
      return
    }

    const info = message.reply_message ? quotedInfo(message) : {}
    if (!info.lid) return message.send('debo estar en el mismo grupo')

    fileReportIssue({ lid: info.lid, numero: info.numero, categoria, token }).catch((e) => logger.error('[report] issue: ' + e.message))

    if (kickFlag) {
      message.send('🔎').catch(() => {})
      ;(async () => {
        await kickFromGroup(message, message.jid, info.lid, info.numero)
        await kickSweep(message, info.lid, info.numero, message.jid)
        await message.send('👌').catch(() => {})
      })()
      return
    }

    return message.send('👌')
  }
)

module.exports = {}
