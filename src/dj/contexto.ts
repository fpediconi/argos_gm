import type { Ctx } from '../ctx.js'
import type { Jugador, Partida, Personaje } from '../motor/tipos.js'
import { claveJugador, npcsVivos } from '../motor/estado.js'
import { saludMaxEfectiva } from '../motor/personaje.js'
import { PROMPT_DJ, textoViolencia } from './prompts.js'
import { vivos } from '../motor/combate.js'
import { actoActual, bloqueRitmo } from '../motor/ritmo.js'

export function fichaCompacta(ctx: Ctx, p: Personaje): string {
  const f = p.ficha
  const o = ctx.u.origenes.find((x) => x.id === f.origen)
  const habs = ctx.u.habilidades
    .filter((h) => (f.habilidades[h.id] ?? 0) > 0)
    .map((h) => `${h.id}${f.habilidades[h.id]}${f.especialidades.includes(h.id) ? '*' : ''}`)
    .join(' ')
  const attrs = Object.entries(f.atributos).map(([k, v]) => `${k}${v}`).join(' ')
  const inv = p.inventario.map((i) => (i.n > 1 ? `${i.id}x${i.n}` : i.id)).join(', ') || '-'
  const cond = p.condiciones.length ? p.condiciones.join(',') : '-'
  return `${claveJugador(p)} ${f.nombre} (${o?.nombre ?? f.origen}; ${f.aspecto}) salud ${p.salud}/${saludMaxEfectiva(p)} rads ${p.rads} suerte ${p.suerte} chapas ${p.chapas} | ${attrs} | hab: ${habs || '-'} | inv: ${inv} | cond: ${cond}${p.gancho ? ` | gancho: ${p.gancho}` : ''}${o?.rasgo ? ` | rasgo: ${o.rasgo}` : ''}`
}

/** El guion con el acto actual en detalle y los otros en una línea. */
function guionCompacto(p: Partida): string {
  const g = p.guion
  if (!g) return '(sin guion)'
  const l: string[] = []
  l.push(`Título: ${g.titulo}. Premisa: ${g.premisa}`)
  if (g.actos.length) {
    const a = Math.min(actoActual(p), g.actos.length)
    l.push(`ACTO ACTUAL (${a} de ${g.actos.length}): ${g.actos[a - 1]}`)
    if (a < g.actos.length) l.push(`Para pasar al acto ${a + 1} tiene que ocurrir lo que lleva a: ${g.actos[a]}`)
    const otros = g.actos.map((x, i) => (i + 1 === a ? null : `${i + 1}) ${x.slice(0, 80)}`)).filter(Boolean)
    if (otros.length) l.push(`Otros actos (referencia): ${otros.join(' ')}`)
  }
  if (g.facciones.length) l.push(`Facciones: ${g.facciones.map((f) => `${f.nombre} (quiere: ${f.quiere}; NO REVELAR: ${f.esconde})`).join(' | ')}`)
  if (g.npcs.length) l.push(`NPC clave: ${g.npcs.map((n) => `${n.nombre} [${n.voz}] quiere ${n.motivacion}; NO REVELAR: ${n.secreto}`).join(' | ')}`)
  if (g.lugares.length) l.push(`Lugares: ${g.lugares.map((x) => `${x.nombre} (${x.rasgo})`).join(' | ')}`)
  if (g.secretos.length) l.push(`Secretos (NO REVELAR hasta un evento o descubrimiento): ${g.secretos.join(' | ')}`)
  l.push(`Amenaza: ${g.amenaza.nombre} (reloj "${g.amenaza.reloj}")`)
  if (g.encuentros.length) l.push(`Encuentros sugeridos (bestiario): ${g.encuentros.join(', ')}`)
  return l.join('\n')
}

/** Estado real para elegir el final. */
export function estadoParaFinal(p: Partida, pjs: Personaje[]): string {
  const m = p.mundo
  const principal = m.misiones.find((x) => x.principal)
  const partes: string[] = []
  if (principal) partes.push(`objetivo principal ${principal.estado}`)
  const cumplidas = m.misiones.filter((x) => x.estado === 'cumplida' && !x.principal).length
  const fallidas = m.misiones.filter((x) => x.estado === 'fallida' && !x.principal).length
  partes.push(`misiones cumplidas ${cumplidas}, fallidas ${fallidas}`)
  if (m.muertos?.length) partes.push(`NPC muertos: ${m.muertos.join(', ')}`)
  const amenaza = m.relojes.find((r) => r.id === 'amenaza')
  if (amenaza) partes.push(`reloj de amenaza ${amenaza.llenos}/${amenaza.segmentos}`)
  partes.push(`personajes en pie: ${pjs.filter((x) => x.vivo).map((x) => x.ficha.nombre).join(', ') || 'ninguno'}`)
  if (m.decisiones?.length) partes.push(`decisiones del grupo: ${m.decisiones.slice(-3).join('; ')}`)
  return partes.join(' · ')
}

export interface OpcionesContexto {
  turnoPj?: Personaje
  economico?: boolean
  extra?: string
}

/**
 * Arma el mensaje de sistema en el orden pensado para el caché de prompts:
 * estable -> semi-estable (partida) -> volátil (estado y últimas entradas).
 */
export function sistemaTurno(ctx: Ctx, partida: Partida, pjs: Personaje[], jugadores: Jugador[], op: OpcionesContexto = {}): string {
  const cfg = partida.config
  const escenario = ctx.u.escenarios.find((e) => e.id === cfg.escenario)
  const tono = ctx.u.tonos.find((t) => t.id === cfg.tono)
  const partes: string[] = []

  // 1) ESTABLE
  partes.push(PROMPT_DJ)
  partes.push(`Objetos válidos: ${ctx.u.objetos.map((o) => o.id).join(', ')}. Armas: ${ctx.u.armas.map((a) => a.id).join(', ')}. Enemigos: ${ctx.u.bestiario.map((b) => `${b.id}`).join(', ')}.`)

  // 2) SEMI-ESTABLE (por partida)
  partes.push(`UNIVERSO Y TONO\n${ctx.u.estilo.trim()}\nEscenario: ${escenario?.nombre ?? ''}. ${escenario?.semilla ?? ''}\nTono: ${tono?.prompt ?? ''}.\n${textoViolencia(cfg.violencia)}\nLíneas y velos (evitar o mostrar con discreción): ${cfg.evitar.length ? cfg.evitar.join(', ') : 'ninguna en particular'}.\nLetalidad: ${cfg.letalidad}${cfg.letalidad === 'suave' ? ' (los personajes no mueren)' : ' (los personajes pueden morir)'}.\nTraiciones entre personajes: ${cfg.pvp ? 'permitidas' : 'no (los personajes no se atacan entre sí)'}.`)
  partes.push(`GUION MAESTRO (secreto)\n${guionCompacto(partida)}`)
  partes.push(`HISTORIA HASTA AHORA\n${partida.resumen || '(recién empieza)'}`)

  // 3) VOLÁTIL
  const m = partida.mundo
  const foco = [...jugadores].sort((a, b) => a.foco - b.foco)[0]
  const focoPj = foco ? pjs.find((p) => p.jugador_id === foco.id) : undefined
  const est: string[] = []
  const ritmo = bloqueRitmo(partida, partida.guion?.finales ?? [], estadoParaFinal(partida, pjs))
  if (ritmo) est.push(ritmo)
  est.push(`Modo: ${partida.modo_escena} · ronda ${partida.ronda}`)
  est.push(`Ubicación: ${m.ubicacion || 'por definir'}`)
  const principal = m.misiones.find((x) => x.principal)
  if (principal) est.push(`OBJETIVO PRINCIPAL DEL GRUPO (${principal.estado}): ${principal.texto}`)
  if (m.relojes.length) est.push(`Relojes: ${m.relojes.map((r) => `${r.nombre} ${r.llenos}/${r.segmentos}${r.llenos >= r.segmentos ? ' (¡LLENO!)' : ''}`).join(' | ')}`)
  const otras = m.misiones.filter((x) => x.estado === 'activa' && !x.principal)
  if (otras.length) est.push(`Misiones secundarias: ${otras.map((x) => x.texto).join(' | ')}`)
  const presentes = npcsVivos(m)
  if (presentes.length) est.push(`NPC presentes: ${presentes.map((n) => `${n.nombre} (${n.actitud}${n.estado === 'herido' ? ', herido' : ''}${n.nota ? '; ' + n.nota : ''})`).join(' | ')}`)
  if (m.muertos?.length) est.push(`NPC MUERTOS (no pueden reaparecer): ${m.muertos.join(', ')}`)
  if (m.vinculos.length) est.push(`Vínculos: ${m.vinculos.join(' | ')}`)
  if (m.decisiones?.length) est.push(`Decisiones del grupo (son hechos, respetalas): ${m.decisiones.slice(-5).join(' | ')}`)
  if (m.impulso) est.push(`Impulso del grupo: ${m.impulso}`)
  if (m.combate) {
    est.push(`COMBATE en curso, ronda ${m.combate.ronda}. Enemigos: ${vivos(m.combate).map((e) => `${e.nombre} ${e.salud}/${e.salud_max}`).join(' | ') || 'ninguno'}`)
  }
  est.push(`PERSONAJES\n${pjs.filter((p) => p.vivo).map((p) => fichaCompacta(ctx, p)).join('\n')}`)
  if (op.turnoPj) est.push(`Turno de: ${claveJugador(op.turnoPj)} (${op.turnoPj.ficha.nombre}).`)
  if (focoPj && focoPj !== op.turnoPj && foco.foco < (jugadores.reduce((s, j) => s + j.foco, 0) / Math.max(1, jugadores.length)) - 1) {
    est.push(`Foco: ${focoPj.ficha.nombre} (${claveJugador(focoPj)}) lleva poco protagonismo; dale un gancho pronto.`)
  }
  partes.push(`ESTADO ACTUAL\n${est.join('\n')}`)

  const ult = ctx.db.ultimasBitacora(partida.id, 6, ['accion', 'narracion', 'tirada'])
  if (ult.length) {
    partes.push(`ÚLTIMAS ENTRADAS\n${ult.map((b) => `[${b.tipo}] ${b.texto}`).join('\n')}`)
  }
  if (m.ritmo?.eventoPendiente && !m.combate) partes.push(`EVENTO OBLIGATORIO (ocurre en esta narración, no lo anuncies: hacelo pasar): ${m.ritmo.eventoPendiente}`)
  if (partida.mundo.senalX) partes.push('<señal_x/> Alguien de la mesa pidió suavizar o cambiar el rumbo de la escena. Hacelo con naturalidad, sin mencionarlo ni preguntar por qué.')
  if (op.economico) partes.push('MODO ECONÓMICO: sé breve (máximo 60 palabras) y sin sugerencias.')
  if (op.extra) partes.push(op.extra)
  return partes.join('\n\n')
}
