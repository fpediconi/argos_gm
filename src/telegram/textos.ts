import type { Ctx } from '../ctx.js'
import type { Jugador, Partida, Personaje } from '../motor/tipos.js'
import { ATRIBUTOS } from '../motor/tipos.js'
import { esc, fechaCorta, formatoDuracion } from '../util.js'
import { saludMaxEfectiva } from '../motor/personaje.js'
import { armaPrincipal, cargaMax, defensaDe, proteccionDe, probabilidadExito, semaforo, textoDificultad } from '../motor/reglas.js'
import type { TiradaResuelta } from '../motor/tipos.js'
import { DURACIONES, FASES, faseDe, limite, totalCapitulos } from '../motor/ritmo.js'
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
  else if (partida.estado === 'EN_JUEGO' || partida.estado === 'PAUSADA') {
    const r = partida.mundo.ritmo
    const total = totalCapitulos(cfg)
    const cap = `Cap. ${partida.capitulo}${total > 0 ? '/' + total : ''}`
    const fase = r ? ` · turno ${Math.min(r.turnos + 1, limite(r))}/${limite(r)} · ${FASES[faseDe(r)].emoji} ${FASES[faseDe(r)].nombre}` : ` · Ronda ${partida.ronda}`
    l.push(`${cap}${fase}${partida.modo_escena === 'combate' ? ' · ⚔️ COMBATE' : ''}${partida.estado === 'PAUSADA' ? ' · ⏸ PAUSADA' : ''}`)
  }
  const principal = partida.mundo.misiones.find((m) => m.principal)
  if (principal) l.push(`🎯 Objetivo${principal.estado !== 'activa' ? ` (${principal.estado})` : ''}: ${esc(principal.texto)}`)
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
  } else if (partida.estado === 'EN_JUEGO' && cfg.plazoH === -1) {
    l.push('')
    l.push('⚡ Skip directo: si alguien tarda, /saltear pasa el turno al toque.')
  }
  return l.join('\n')
}

export function tarjetaTurnoTexto(ctx: Ctx, partida: Partida, j: Jugador, pj: Personaje | undefined): string {
  const l: string[] = []
  const combate = partida.mundo.combate
  if (combate) {
    l.push(`⚔️ <b>COMBATE — ronda ${combate.ronda}</b>`)
    l.push(combate.enemigos.filter((e) => e.salud > 0).map((e) => `👹 ${esc(e.nombre)} ${e.salud}/${e.salud_max}`).join(' · ') || 'Sin enemigos')
    l.push('')
  }
  l.push('━━━━━━━━━━━━━━')
  l.push(`🎯 <b>TURNO DE ${esc(j.nombre.toUpperCase())}</b>`)
  if (pj) l.push(`${esc(pj.ficha.nombre)} · ❤️ ${pj.salud}/${saludMaxEfectiva(pj)}`)
  l.push('━━━━━━━━━━━━━━')
  if (partida.turno_vence && partida.turno_vence !== SIN_LIMITE) {
    l.push(`⏱ Vence ${fechaCorta(partida.turno_vence, ctx.cfg.tzMin)}`)
  } else if (partida.config.plazoH === -1) {
    l.push('⚡ Skip directo: si tarda, cualquiera puede /saltear')
  }
  l.push(combate ? `${mencion(j)}, elegí una acción con los botones.` : `✍️ ${mencion(j)}, <b>respondé a este mensaje</b> con lo que hacés (o <code>/a tu acción</code>).`)
  return l.join('\n')
}

/** Tarjeta antes de tirar: en lenguaje de mesa, sin la cuenta. */
export function tarjetaTiradaTexto(ctx: Ctx, pj: Personaje, preambulo: string, habilidad: string, tn: number, dificultad: number, motivo: string, dados = 2): string {
  const h = ctx.u.habilidades.find((x) => x.id === habilidad)
  const esp = pj.ficha.especialidades.includes(habilidad)
  const chances = semaforo(probabilidadExito(tn, pj.ficha.habilidades[habilidad] ?? 0, esp, dificultad, dados))
  const l: string[] = []
  if (preambulo) l.push(`<i>${esc(preambulo)}</i>`, '')
  l.push(`🎲 <b>${esc(pj.ficha.nombre)}</b> intenta ${esc(motivo.charAt(0).toLowerCase() + motivo.slice(1))}`)
  l.push(`Habilidad: ${esc(h?.nombre ?? habilidad)}${esp ? ' ⭐' : ''} · ${textoDificultad(dificultad)} (necesitás ${dificultad} acierto${dificultad === 1 ? '' : 's'})`)
  l.push(`Cada dado que saque <b>${tn} o menos</b> es un acierto.`)
  l.push(`Chances: ${chances.emoji} ${chances.texto}`)
  return l.join('\n')
}

/** Resultado de una tirada: cada dado marcado y un veredicto grande. */
export function resultadoTiradaTexto(t: TiradaResuelta, rango: number, especialidad: boolean): string {
  const dados = t.dados.map((d) => {
    const acierto = d <= t.tn
    const critico = acierto && especialidad && rango > 0 && d <= rango
    return `🎲 ${d} ${critico ? '⭐⭐' : acierto ? '✅' : '❌'}${d === 20 ? '⚠️' : ''}`
  }).join('   ')
  const extra = t.extra === 'suerte' ? ' (+1 dado 🍀)' : t.extra === 'impulso' ? ' (+1 dado ⚡)' : ''
  const veredicto = t.exito ? (t.complicaciones ? '✅ <b>LO LOGRÁS, PERO…</b>' : '✅ <b>LO LOGRÁS</b>') : '❌ <b>NO ALCANZA</b>'
  const l = [`${dados}${extra}`, `${t.exitos} de ${t.pedido.dificultad} acierto${t.pedido.dificultad === 1 ? '' : 's'} → ${veredicto}`]
  if (t.impulso) l.push(`⚡ +${t.impulso} Impulso para el grupo`)
  return l.join('\n')
}

/** La party: un bloque por personaje, sin IA ni secretos. */
export function partyTexto(ctx: Ctx, pjs: Personaje[], jugadores: Jugador[]): string {
  if (!pjs.length) return '👥 Todavía no hay personajes en la party.'
  const bloques = pjs.map((p) => {
    const f = p.ficha
    const o = ctx.u.origenes.find((x) => x.id === f.origen)
    const j = jugadores.find((x) => x.id === p.jugador_id)
    const habs = ctx.u.habilidades
      .filter((h) => (f.habilidades[h.id] ?? 0) > 0)
      .sort((a, b) => (f.habilidades[b.id] ?? 0) - (f.habilidades[a.id] ?? 0) || Number(f.especialidades.includes(b.id)) - Number(f.especialidades.includes(a.id)))
      .slice(0, 3)
      .map((h) => `${f.especialidades.includes(h.id) ? '⭐ ' : ''}${esc(h.nombre)} ${f.habilidades[h.id]}`)
      .join(' · ')
    const l = [`${o?.emoji ?? '🧑'} <b>${esc(f.nombre)}</b>${j ? ` (${esc(j.nombre)})` : ''} — ${esc(o?.nombre ?? f.origen)} · ❤️ ${p.salud}/${saludMaxEfectiva(p)}${p.condiciones.includes('caido') ? ' 🩸' : ''}`]
    if (f.frase) l.push(`<i>"${esc(f.frase)}"</i>`)
    if (f.aspecto) l.push(esc(f.aspecto))
    if (habs) l.push(habs)
    if (f.bio) l.push(`📖 ${esc(f.bio)}`)
    return l.join('\n')
  })
  return `👥 <b>La party</b>\n\n${bloques.join('\n\n')}`
}

export function nombreDuracion(d: string): string {
  return DURACIONES[d as keyof typeof DURACIONES]?.nombre ?? d
}

export const AYUDA_GRUPO = `🎲 <b>Argos DJ — cómo se juega</b>

• Cuando es tu turno, <b>respondé al mensaje del DJ</b> (o usá <code>/a lo que hacés</code>). Contá qué intenta tu personaje, no cómo termina.
• Si hay riesgo, el DJ pide una prueba: tocás <b>🎲 Tirar</b>. Podés gastar 🍀 Suerte o ⚡ Impulso para sumar un dado.
• En las tiradas, cada dado que saque el número indicado o menos es un acierto. El DJ te dice cuántos aciertos necesitás.
• También podés mandar un 🎙️ <b>audio respondiendo a tu turno</b>: el DJ lo transcribe y te muestra lo que entendió.
• Podés charlar libremente en el grupo: el DJ solo lee tu acción cuando es tu turno.

<b>Comandos</b>
/ficha /inventario /party /misiones — info (sin gastar IA)
/resumen — los últimos hechos · /radio — versión Radio Yermo
/votacion pregunta | opción | opción — decisión del grupo
/pasar — cedés tu turno · /saltear — propone saltear a quien está demorado
/ausente 3d — avisás que no vas a estar · /volver
/x — pedís cambiar el rumbo de la escena (anónimo)
/regla tema — explica una regla · /tiradas — últimas tiradas
/costo — gasto de IA · /config /final /pausa /reanudar /fin /libro — anfitrión`

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
  letalidad: 'Suave: nadie muere, solo secuelas. Normal: un caído que nadie levanta tira Suerte; si falla, muere. Hardcore: a 0 salud, muerte. Fuera de combate también se puede morir (si lo decidís vos o por una tirada con riesgo mortal).',
}
