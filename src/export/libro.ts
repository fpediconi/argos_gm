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
    l.push(`- **${p.ficha.nombre}** (${j?.nombre ?? '?'}) — ${p.vivo ? 'vivo' : 'murió'}. ${p.trasfondo}`)
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
