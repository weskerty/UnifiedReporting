// Plugin de investigacion opcional para UnifiedReporting. Copiar (o el .bundled.js) a
// media/report/plugins/ en el bot. Solo informa, nunca veta la aprobacion automatica.
// Requiere tu propio installationId de Truecaller (ver notas del repo sobre como obtenerlo).
const { search } = require('truecallerjs')

const INSTALLATION_ID = '' // completar con tu propio installationId - vacio = desactivado
const COUNTRY_CODE = 'PY'

module.exports = {
  name: 'Truecaller',
  check: async ({ numero }) => {
    if (!INSTALLATION_ID || !numero) return null
    try {
      const res = await search({ number: `+${numero}`, countryCode: COUNTRY_CODE, installationId: INSTALLATION_ID })
      const j = res.json()
      if (j instanceof Error || !j?.data?.length) return { texto: 'Truecaller: ✅' }
      const d = j.data[0]
      const partes = [d.name].filter(Boolean)
      if (d.isFraud) partes.push('⚠️ marcado como fraude')
      return { texto: `Truecaller: ${partes.join(' | ') || 'sin datos'}` }
    } catch {
      return null
    }
  },
}
