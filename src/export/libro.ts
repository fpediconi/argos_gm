import type { Ctx } from '../ctx.js'
import type { Partida } from '../motor/tipos.js'
import { fechaCorta } from '../util.js'

/** Exporta la crónica completa de la partida a Markdown (sin IA: sale de la bitácora). */
export function exportarLibro(ctx: Ctx, partida: Partida): string {
  const g = partida.guion
  const jugadores = ctx.db.jugadores(partida.id)
  const pjs = ctx.db.personajesTodos(partida.id)
  const l: string[] = []
  l.push(`# ${g?.titulo ?? 'Crónicas del Yermo'}`)
  l.push('')
  if (g?.premisa) l.push(`> ${g.premisa}`, '')
  l.push('## Personajes', '')
  for (const p of pjs) {
    const j = jugadores.find((x) => x.id === p.jugador_id)
    const f = p.ficha
    const o = ctx.u.origenes.find((x) => x.id === f.origen)
    const sub = o?.sub?.find((x) => x.id === f.subOrigen)
    const estado = p.vivo ? 'vivo' : p.condiciones.includes('se fue') ? 'se fue' : 'murió'
    l.push(`- **${f.nombre}** (${j?.nombre ?? '?'}) — ${o?.nombre ?? f.origen}${sub ? `, ${sub.nombre.toLowerCase()}` : ''}. ${estado}. ${f.bio ?? p.trasfondo}`)
    if (f.objetivo) l.push(`  - Quería: ${f.objetivo}`)
    // El secreto solo entra al libro si se supo en la historia.
    if (f.secreto && f.secretoEstado === 'revelado') l.push(`  - Su secreto: ${f.secreto}`)
    if (f.cicatrices?.length) l.push(`  - Cicatrices: ${f.cicatrices.join(', ')}`)
  }
  if (partida.mundo.capitulos?.length) {
    l.push('', '## En resumen', '')
    partida.mundo.capitulos.forEach((c, i) => l.push(`**Capítulo ${i + 1}.** ${c}`, ''))
  }
  l.push('', '## La historia', '')
  let capitulo = 1
  for (const b of ctx.db.bitacoraTodas(partida.id)) {
    if (b.tipo === 'sistema' && /^Capítulo \d+ cerrado/.test(b.texto)) {
      capitulo++
      l.push('', `---`, '', `## Capítulo ${capitulo}`, '')
      continue
    }
    if (b.tipo === 'accion') l.push(`**${b.texto}**`, '')
    else if (b.tipo === 'narracion') l.push(b.texto, '')
    else if (b.tipo === 'tirada') l.push(`> 🎲 ${b.texto}`, '')
  }
  l.push('', `_Generado el ${fechaCorta(ctx.reloj.ahora(), ctx.cfg.tzMin)}._`)
  return l.join('\n')
}
