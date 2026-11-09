// ONLY PARAGUAY
// https://listahu.org/
module.exports = {
  name: 'ListaHu',
  check: async ({ numero }) => {
    if (!numero) return null
    try {
      const res = await fetch(`https://listahu.org/api/v1/denuncias/?numero=${numero}`)
      if (!res.ok) return null
      const data = await res.json()
      if (!data.count) return { texto: 'ListaHu: ✅' }
      const tipos = [...new Set(data.results.map((r) => r.tipo))].join(', ')
      const conImagen = data.results.find((r) => r.screenshot)
      return {
        texto: `ListaHu: ${tipos} (${data.count})`,
        imagen: conImagen ? conImagen.screenshot : null,
      }
    } catch {
      return null
    }
  },
}
