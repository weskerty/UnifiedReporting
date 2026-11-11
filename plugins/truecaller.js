// Plugin de investigacion opcional para UnifiedReporting. Copiar (o el .bundled.js) a
// media/report/plugins/ en el bot. veto:true (isFraud) bloquea la aprobacion automatica.
// Requiere tu propio installationId de Truecaller (ver notas del repo sobre como obtenerlo).
const { search } = require('truecallerjs')
const axios = require('axios')
const { SocksProxyAgent } = require('socks-proxy-agent')

const INSTALLATION_ID = '' // fallback si no se usa ctx.TRUECALLER_INSTALLATION_ID - vacio = desactivado
const COUNTRY_CODE = 'PY'

// ctx.TOR / process.env.TOR: "ip:puerto" (ej. "127.0.0.1:9050"), o solo "puerto" -> localhost.
function parseTor(raw) {
  const s = raw ? String(raw).trim() : ''
  if (!s) return null
  const idx = s.lastIndexOf(':')
  return idx === -1 ? { host: '127.0.0.1', port: s } : { host: s.slice(0, idx) || '127.0.0.1', port: s.slice(idx + 1) }
}

// truecallerjs trae su propio node_modules/axios anidado (version distinta a la nuestra),
// asi que tocar axios.defaults aca no afecta su llamada interna - por eso esto hace el
// request a mano, con una instancia propia de axios.create() para poder pasarle el agente.
async function searchDirect(numero, installationId, agent) {
  const client = axios.create(agent ? { httpAgent: agent, httpsAgent: agent, proxy: false } : {})
  const { data } = await client.get('https://search5-noneu.truecaller.com/v2/search', {
    params: { q: numero, countryCode: COUNTRY_CODE, type: 4, locAddr: '', placement: 'SEARCHRESULTS,HISTORY,DETAILS', encoding: 'json' },
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'accept-encoding': 'gzip',
      'user-agent': 'Truecaller/11.75.5 (Android;10)',
      Authorization: `Bearer ${installationId}`,
    },
  })
  return data
}

module.exports = {
  name: 'Truecaller',
  check: async ({ numero, ctx }) => {
    const installationId = ctx?.TRUECALLER_INSTALLATION_ID || INSTALLATION_ID
    if (!installationId || !numero) return null
    const tor = parseTor(ctx?.TOR || process.env.TOR)
    try {
      let j
      if (tor) {
        const agent = new SocksProxyAgent(`socks5h://${tor.host}:${tor.port}`) // socks5h: DNS tambien via Tor
        j = await searchDirect(numero, installationId, agent)
      } else {
        const res = await search({ number: `+${numero}`, countryCode: COUNTRY_CODE, installationId })
        j = res.json()
        if (j instanceof Error) throw j
      }
      if (!j?.data?.length) return { texto: 'Truecaller: ✅' }
      const d = j.data[0]
      const phone = (d.phones && d.phones[0]) || {}
      const partes = [d.name, typeof d.score === 'number' ? `score ${d.score.toFixed(2)}` : null, phone.carrier, phone.numberType].filter(Boolean)
      let texto = `Truecaller: ${partes.join(' | ') || 'sin datos'}`

      const tags = (d.electedTags || []).map((t) => t.value).filter(Boolean)
      if (tags.length) texto += `\nTags: ${tags.join(', ')}`

      const internet = (d.internetAddresses || []).map((a) => a.id || a.caption).filter(Boolean)
      if (internet.length) texto += `\nInternet: ${internet.join(', ')}`

      if (d.isFraud) texto += '\nFraud: True'
      return { texto, veto: !!d.isFraud }
    } catch {
      return null
    }
  },
}
