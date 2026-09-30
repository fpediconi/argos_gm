import type { Ctx } from '../ctx.js'
import type { Jugador, Partida, Personaje } from '../motor/tipos.js'
import { ATRIBUTOS } from '../motor/tipos.js'
import { esc, fechaCorta, formatoDuracion } from '../util.js'
import { saludMaxEfectiva } from '../motor/personaje.js'
import { armaPrincipal, cargaMax, defensaDe, proteccionDe, textoDificultad } from '../motor/reglas.js'
import { cantidadItems } from '../motor/personaje.js'
import { SIN_LIMITE } from '../motor/turnos.js'

export const mencion = (j: Pick<Jugador, 'user_id' | 'nombre'>) => `<a href="tg://user?id=${j.user_id}">${esc(j.nombre)}</a>`

export function barra(llenos: number, total: number): string {
  return '▰'.repeat(Math.max(0, llenos)) + '▱'.repeat(Math.max(0, total - llenos))
}

export function fichaTexto(ctx: Ctx, p: Personaje): string {
  const f = p.ficha
  const u = ctx.u
  const o = u.origenes.find((x) => x.id === f.origen)
  const attrs = ATRIBUTOS.map((a) => `<b>${a}</b> ${f.atributos[a]}`).join('  ')
  const habs = u.habilidades
    .filter((h) => (f.habilidades[h.id] ?? 0) > 0)
    .sort((a, b) => (f.habilidades[b.id] ?? 0) - (f.habilidades[a.id] ?? 0))
    .map((h) => `${f.especialidades.includes(h.id) ? '⭐' : '▫️'} ${esc(h.nombre)} ${f.habilidades[h.id]}`)
    .join('\n')
  const arma = armaPrincipal(p, u)
  const l: string[] = []
  l.push(`${o?.emoji ?? '🧑'} <b>${esc(f.nombre)}</b> — ${esc(o?.nombre ?? f.origen)}${p.vivo ? '' : ' ☠️'}`)
  if (f.frase) l.push(`<i>"${esc(f.frase)}"</i>`)
  if (f.aspecto) l.push(esc(f.aspecto))
  l.push('')
  l.push(attrs)
  l.push(`❤️ Salud ${p.salud}/${saludMaxEfectiva(p)} · ☢️ Rads ${p.rads} · 🍀 Suerte ${p.suerte}/${f.atributos.SUE} · 🔩 Chapas ${p.chapas} · 🛡️ Def ${defensaDe(p)} · Prot ${proteccionDe(p, u)}`)
  if (p.condiciones.length) l.push(`⚠️ ${esc(p.condiciones.join(', '))}`)
  l.push('')
  l.push(habs || '(sin habilidades)')
  l.push('')
  l.push(`🔫 Arma: ${esc(arma.nombre)} (daño ${arma.danio})`)
  if (p.gancho) l.push(`🎯 Gancho: ${esc(p.gancho)}`)
  if (p.trasfondo) l.push(`📖 ${esc(p.trasfondo)}`)
  return l.join('\n')
}

export function inventarioTexto(ctx: Ctx, p: Personaje): string {
  const items = p.inventario.map((i) => {
    const d = ctx.u.objetos.find((o) => o.id === i.id) ?? ctx.u.armas.find((a) => a.id === i.id)
    return `• ${esc(d?.nombre ?? i.id)}${i.n > 1 ? ' ×' + i.n : ''}`
  })
  return `🎒 <b>Inventario de ${esc(p.ficha.nombre)}</b> (${cantidadItems(p)}/${cargaMax(p.ficha)})\n${items.join('\n') || '(vacío)'}\n🔩 Chapas: ${p.chapas}`
}

export function estadoJugadorIcono(j: Jugador, partida: Partida, tienePj: boolean): string {
  if (partida.estado === 'EN_JUEGO' && partida.turno_jugador_id === j.id) return '🎯'
  switch (j.estado) {
    case 'creando': return '⏳'
    case 'listo': return '✅'
    case 'activo': return tienePj ? '🟢' : '⏳'
    case 'ausente': return '😴'
    case 'dormido': return '💤'
    default: return '⚫'
  }
}

export function tableroTexto(ctx: Ctx, partida: Partida, jugadores: Jugador[], pjs: Personaje[]): string {
  const cfg = partida.config
  const esc0 = ctx.u.escenarios.find((e) => e.id === cfg.escenario)
  const titulo = partida.guion?.titulo ?? 'Nueva partida'
  const l: string[] = []
  l.push(`☢️ <b>${esc(titulo)}</b>`)
  if (partida.estado === 'CREANDO') l.push(`Preparativos · ${esc(esc0?.nombre ?? '')}`)
  else if (partida.estado === 'EN_JUEGO' || partida.estado === 'PAUSADA') l.push(`Cap. ${partida.capitulo} · Ronda ${partida.ronda}${partida.modo_escena === 'combate' ? ' · ⚔️ COMBATE' : ''}${partida.estado === 'PAUSADA' ? ' · ⏸ PAUSADA' : ''}`)
  else if (partida.estado === 'FINALIZADA') l.push('🏁 Partida finalizada')
  if (partida.mundo.ubicacion) l.push(`📍 ${esc(partida.mundo.ubicacion)}`)
  l.push('')
  for (const j of jugadores.filter((x) => x.estado !== 'fuera')) {
    const pj = pjs.find((p) => p.jugador_id === j.id && p.vivo)
    const ic = estadoJugadorIcono(j, partida, !!pj)
    const info = pj ? ` — ${esc(pj.ficha.nombre)} ❤️${pj.salud}/${saludMaxEfectiva(pj)}${pj.condiciones.includes('caido') ? ' 🩸' : ''}` : j.estado === 'creando' ? ' — creando personaje' : ''
    l.push(`${ic} ${esc(j.nombre)}${info}`)
  }
  if (partida.mundo.relojes.length) {
    l.push('')
    for (const r of partida.mundo.relojes) l.push(`⏰ ${esc(r.nombre)} ${barra(r.llenos, r.segmentos)} (${r.llenos}/${r.segmentos})`)
  }
  if (partida.mundo.impulso) l.push(`⚡ Impulso del grupo: ${partida.mundo.impulso}/3`)
  if (partida.estado === 'EN_JUEGO' && partida.turno_vence && partida.turno_vence !== SIN_LIMITE) {
    l.push('')
    l.push(`⏱ El turno vence ${fechaCorta(partida.turno_vence, ctx.cfg.tzMin)}`)
  }
  return l.join('\n')
}

export function tarjetaTurnoTexto(ctx: Ctx, partida: Partida, j: Jugador, pj: Personaje | undefined, mientrasNoEstabas: string[]): string {
  const l: string[] = []
  const combate = partida.mundo.combate
  if (combate) {
    l.push(`⚔️ <b>COMBATE — ronda ${combate.ronda}</b>`)
    l.push(combate.enemigos.filter((e) => e.salud > 0).map((e) => `👹 ${esc(e.nombre)} ${e.salud}/${e.salud_max}`).join(' · ') || 'Sin enemigos')
    l.push('')
  }
  l.push(`👉 <b>Turno de ${mencion(j)}</b>${pj ? ` (${esc(pj.ficha.nombre)})` : ''}`)
  if (partida.turno_vence && partida.turno_vence !== SIN_LIMITE) {
    l.push(`⏱ Plazo: ${formatoDuracion(partida.turno_vence - partida.turno_desde)} · vence ${fechaCorta(partida.turno_vence, ctx.cfg.tzMin)}`)
  }
  if (mientrasNoEstabas.length) {
    l.push('')
    l.push('📻 <b>Mientras no estabas</b>')
    for (const c of mientrasNoEstabas) l.push(`• ${esc(c)}`)
  }
  l.push('')
  l.push(combate ? 'Elegí una acción con los botones.' : '✍️ <b>Respondé a este mensaje</b> (o usá <code>/a tu acción</code>) para actuar.')
  return l.join('\n')
}

export function tarjetaTiradaTexto(ctx: Ctx, pj: Personaje, preambulo: string, atributo: string, habilidad: string, tn: number, dificultad: number, motivo: string): string {
  const h = ctx.u.habilidades.find((x) => x.id === habilidad)
  const l: string[] = []
  if (preambulo) l.push(`<i>${esc(preambulo)}</i>`)
  l.push('')
  l.push(`🎲 <b>${esc(pj.ficha.nombre)}</b> — ${esc(motivo)}`)
  l.push(`${atributo} ${pj.ficha.atributos[atributo as keyof typeof pj.ficha.atributos] ?? 0} + ${esc(h?.nombre ?? habilidad)} ${pj.ficha.habilidades[habilidad] ?? 0}${pj.ficha.especialidades.includes(habilidad) ? ' ⭐' : ''} = <b>TN ${tn}</b> · Dificultad ${dificultad} (${textoDificultad(dificultad)})`)
  return l.join('\n')
}

export const AYUDA_GRUPO = `🎲 <b>Argos DJ — cómo se juega</b>

• Cuando es tu turno, <b>respondé al mensaje del DJ</b> (o usá <code>/a lo que hacés</code>). Contá qué intenta tu personaje, no cómo termina.
• Si hay riesgo, el DJ pide una prueba: tocás <b>🎲 Tirar</b>. Podés gastar 🍀 Suerte o ⚡ Impulso para sumar un dado.
• Las tiradas son 2d20: cada dado igual o menor a tu <b>TN</b> (atributo + habilidad) es un éxito.
• Podés charlar libremente en el grupo: el DJ solo lee tu acción cuando es tu turno.

<b>Comandos</b>
/ficha /inventario /donde /misiones — tu info (sin gastar IA)
/resumen — lo que te perdiste · /radio — versión Radio Yermo
/pasar — cedés tu turno · /saltear — propone saltear a quien está demorado
/ausente 3d — avisás que no vas a estar · /volver
/x — pedís cambiar el rumbo de la escena (anónimo)
/regla tema — explica una regla · /tiradas — últimas tiradas
/costo — gasto de IA · /pausa /reanudar /fin /libro — anfitrión`

export const REGLAS: Record<string, string> = {
  prueba: 'Tirás 2d20. Cada dado menor o igual a tu TN (atributo + habilidad) es un éxito. Con especialidad, un dado menor o igual al rango de la habilidad vale 2 éxitos. Un 20 es una complicación. La dificultad (1 a 4) es cuántos éxitos necesitás.',
  suerte: 'Cada punto de Suerte que gastás antes de tirar suma 1d20 (máximo 3d20). Tenés tantos puntos como tu atributo Suerte y se recuperan al cerrar cada capítulo.',
  impulso: 'Los éxitos de sobra en una prueba llenan el Impulso del grupo (máximo 3). Cualquiera puede gastar 1 para sumar 1d20 a una prueba.',
  especialidad: 'Tenés 3 especialidades. Esas habilidades empiezan en 2 y generan más éxitos críticos (un dado menor o igual al rango vale 2 éxitos).',
  combate: 'En combate cada jugador actúa en su turno con botones. El daño es fijo: arma + éxitos de sobra − protección del enemigo (mínimo 1). Al final de la ronda actúan los enemigos y el DJ narra todo junto.',
  salud: 'Salud = Resistencia + Suerte (+ bonus de origen). A 0 quedás Caído: un aliado puede levantarte con Medicina (dificultad 2). Al terminar el combate, según la letalidad, podés quedar herido o morir.',
  rads: 'Cada punto de radiación baja tu salud máxima hasta que lo curés (RadAway o Medicina). Necróticos, supermutantes y robots son inmunes.',
  relojes: 'Un reloj es una barra de tensión que avanza con las decisiones del grupo (no con el tiempo real). Cuando se llena, pasa algo.',
  turnos: 'Cada uno juega en su turno. Si el plazo vence, cualquiera puede proponer saltear con /saltear y los demás votan. También podés avisar con /ausente.',
  letalidad: 'Suave: nadie muere, solo secuelas. Normal: un caído que nadie levanta tira Suerte; si falla con complicación, muere. Hardcore: a 0 salud, muerte.',
}
