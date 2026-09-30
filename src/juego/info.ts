import type { Ctx } from '../ctx.js'
import type { Jugador, Partida } from '../motor/tipos.js'
import { esc, parseDuracion, formatoDuracion, fechaCorta } from '../util.js'
import { fichaTexto, inventarioTexto, partyTexto, REGLAS } from '../telegram/textos.js'
import { npcsVivos } from '../motor/estado.js'
import { estadoPresupuesto } from '../dj/presupuesto.js'
import { transmisionRadio } from '../dj/servicios.js'
import { registrar, refrescarTablero, pjDe, cargar } from './comun.js'
import { ajustarRitmo, avanzarTurno, enviarLibro, finalizarPartida, iniciarTurno, pedirFinal, saltarTurno } from './turno.js'
import { SIN_LIMITE } from '../motor/turnos.js'

type Resp = (html: string) => Promise<void>

export async function cmdFicha(ctx: Ctx, p: Partida, j: Jugador, resp: Resp) {
  const pj = ctx.db.ultimoPersonajeDe(j.id)
  await resp(pj ? fichaTexto(ctx, pj) : 'Todavía no tenés personaje. Tocá «Crear mi personaje» en el tablero.')
}

export async function cmdInventario(ctx: Ctx, p: Partida, j: Jugador, resp: Resp) {
  const pj = ctx.db.personajeVivoDe(j.id)
  await resp(pj ? inventarioTexto(ctx, pj) : 'No tenés personaje vivo.')
}

/** /donde quedó como alias del resumen (que ahora incluye lugar, NPC y relojes). */
export async function cmdDonde(ctx: Ctx, p: Partida, j: Jugador, resp: Resp) {
  await cmdResumen(ctx, p, j, resp)
}

export async function cmdParty(ctx: Ctx, p: Partida, _j: Jugador, resp: Resp) {
  await resp(partyTexto(ctx, ctx.db.personajesVivos(p.id), ctx.db.jugadores(p.id)))
}

export async function cmdMisiones(ctx: Ctx, p: Partida, _j: Jugador, resp: Resp) {
  const ms = p.mundo.misiones
  await resp(ms.length ? '🎯 <b>Misiones</b>\n' + ms.map((m) => `${m.estado === 'activa' ? '▫️' : m.estado === 'cumplida' ? '✅' : '❌'} ${esc(m.texto)}`).join('\n') : 'Todavía no hay misiones.')
}

/**
 * Resumen (gratis, sin IA): siempre muestra los últimos hechos de la partida.
 * Lo que pasó desde la última vez que lo miraste va marcado como nuevo.
 */
export async function cmdResumen(ctx: Ctx, p: Partida, j: Jugador, resp: Resp) {
  const todas = ctx.db.bitacoraTodas(p.id).filter((b) => b.cronica)
  const ultimas = todas.slice(-10)
  const nuevasDesde = j.ultimo_visto_n
  j.ultimo_visto_n = ctx.db.maxBitacora(p.id)
  ctx.db.guardarJugador(j)
  const l: string[] = [`📻 <b>Resumen — ${esc(p.guion?.titulo ?? 'la partida')}</b>`]
  const principal = p.mundo.misiones.find((m) => m.principal)
  if (principal) l.push(`🎯 Objetivo${principal.estado !== 'activa' ? ` (${principal.estado})` : ''}: ${esc(principal.texto)}`)
  l.push('')
  if (ultimas.length === 0) l.push('La historia recién empieza.')
  else {
    const hayNuevas = ultimas.some((b) => b.n > nuevasDesde)
    l.push(hayNuevas ? '<b>Últimos hechos</b> (🆕 = desde tu última consulta)' : '<b>Últimos hechos</b>')
    for (const b of ultimas) l.push(`${b.n > nuevasDesde ? '🆕' : '•'} ${esc(b.cronica)}`)
  }
  const m = p.mundo
  l.push('')
  if (m.ubicacion) l.push(`📍 ${esc(m.ubicacion)}`)
  if (p.modo_escena === 'combate' && m.combate) l.push(`⚔️ Combate, ronda ${m.combate.ronda}: ${m.combate.enemigos.filter((e) => e.salud > 0).map((e) => `${esc(e.nombre)} ${e.salud}/${e.salud_max}`).join(' · ')}`)
  const act = m.misiones.filter((x) => x.estado === 'activa' && !x.principal)
  if (act.length) l.push('📌 ' + act.map((x) => esc(x.texto)).join(' · '))
  const presentes = npcsVivos(m)
  if (presentes.length) l.push('👥 ' + presentes.map((n) => `${esc(n.nombre)} (${esc(n.actitud)})`).join(' · '))
  if (m.muertos?.length) l.push('💀 ' + m.muertos.map(esc).join(', '))
  for (const r of m.relojes) l.push(`⏰ ${esc(r.nombre)} ${'▰'.repeat(r.llenos)}${'▱'.repeat(Math.max(0, r.segmentos - r.llenos))}`)
  if (m.decisiones?.length) l.push('🗳️ ' + m.decisiones.slice(-3).map(esc).join(' · '))
  await resp(l.join('\n').replace(/\n{3,}/g, '\n\n').trim())
}

/** /final N: el anfitrión pide cerrar la historia en N turnos (por defecto 3). */
export async function cmdFinal(ctx: Ctx, p: Partida, j: Jugador, args: string, resp: Resp) {
  if (p.anfitrion_id !== j.user_id) return resp('Solo el anfitrión puede pedir el final.')
  if (p.estado !== 'EN_JUEGO' && p.estado !== 'PAUSADA') return resp('La partida no está en juego.')
  const n = Math.max(1, Math.min(20, Number(args.trim()) || 3))
  pedirFinal(ctx, p.id, n)
  registrar(ctx, p, j.id, 'sistema', `El anfitrión pidió el final en ${n} turnos.`)
  await resp(`🏁 <b>Se viene el final.</b> La historia entra en el clímax y se cierra en ${n} turno${n === 1 ? '' : 's'}.`)
  await refrescarTablero(ctx, p.id)
}

/** Versión Radio Yermo: una llamada corta a la IA barata. */
export async function cmdRadio(ctx: Ctx, p: Partida, j: Jugador, resp: Resp, largo: boolean) {
  const base = largo ? 0 : j.ultimo_visto_n
  let cronicas = ctx.db.bitacoraDesde(p.id, base).filter((b) => b.cronica).map((b) => b.cronica)
  if (!largo && cronicas.length === 0) cronicas = ctx.db.ultimasBitacora(p.id, 8).filter((b) => b.cronica).map((b) => b.cronica)
  if (cronicas.length === 0) return resp('Todavía no hay nada para transmitir.')
  const pres = estadoPresupuesto(ctx, p.id)
  if (pres.nivel === 'parado') return resp('💸 Sin presupuesto de IA por hoy. Usá /resumen (es gratis).')
  try {
    const t = await transmisionRadio(ctx, p, cronicas.slice(-25), largo)
    j.ultimo_visto_n = ctx.db.maxBitacora(p.id)
    ctx.db.guardarJugador(j)
    await resp(`📻 <b>Radio Yermo</b>\n\n<i>${esc(t)}</i>`)
  } catch {
    await resp('📡 Radio Yermo no tiene señal ahora. Probá /resumen.')
  }
}

export async function cmdTiradas(ctx: Ctx, p: Partida, _j: Jugador, resp: Resp) {
  const ts = ctx.db.ultimasTiradas(p.id, 8)
  if (!ts.length) return resp('Todavía no hubo tiradas.')
  await resp('🎲 <b>Últimas tiradas</b>\n' + ts.map((t) => `${esc(t.jugador ?? '?')}: ${esc(t.atributo)}+${esc(t.habilidad)} TN ${t.tn} → [${JSON.parse(t.dados).join(', ')}] ${t.exitos} éxito(s) / dif ${t.dificultad}${t.extra !== 'ninguno' ? ' (+1d20)' : ''}`).join('\n'))
}

export async function cmdCosto(ctx: Ctx, p: Partida, j: Jugador, resp: Resp) {
  if (p.anfitrion_id !== j.user_id && ctx.cfg.adminId !== j.user_id) return resp('Solo el anfitrión puede ver el gasto.')
  const pres = estadoPresupuesto(ctx, p.id)
  const por = ctx.db.gastoPorRol(p.id)
  await resp(`💸 <b>Gasto de IA</b>\nHoy: US$ ${pres.gastoPartida.toFixed(3)} de ${pres.topePartida.toFixed(2)} (partida) · global US$ ${pres.gastoGlobal.toFixed(3)} de ${pres.topeGlobal.toFixed(2)}\nEstado del fusible: <b>${pres.nivel}</b>\n\nTotal por tipo:\n${por.map((r) => `• ${esc(r.rol)}: ${r.llamadas} llamadas · ${r.tok_in} in (${r.tok_cache} en caché) · ${r.tok_out} out · US$ ${r.usd.toFixed(3)}`).join('\n') || '(sin llamadas todavía)'}`)
}

export async function cmdRegla(ctx: Ctx, args: string, resp: Resp) {
  const q = args.trim().toLowerCase()
  const clave = Object.keys(REGLAS).find((k) => q.includes(k) || k.includes(q))
  if (q && clave) return resp(`📘 <b>${esc(clave)}</b>\n${esc(REGLAS[clave])}`)
  await resp(`📘 Temas: ${Object.keys(REGLAS).map((k) => '<code>' + k + '</code>').join(', ')}\nEjemplo: <code>/regla suerte</code>`)
}

export async function cmdX(ctx: Ctx, p: Partida, resp: Resp) {
  p.mundo.senalX = true
  ctx.db.guardarPartida(p)
  await resp('🛑 Recibido. El DJ va a cambiar el rumbo de la escena con naturalidad (nadie sabe quién lo pidió).')
}

export async function cmdAusente(ctx: Ctx, p: Partida, j: Jugador, args: string, resp: Resp) {
  const ms = parseDuracion(args.trim() || '1d')
  if (!ms || ms > 30 * 86_400_000) return resp('Usá por ejemplo <code>/ausente 3d</code>, <code>/ausente 12h</code> (máximo 30 días).')
  j.estado = 'ausente'
  j.ausente_hasta = ctx.reloj.ahora() + ms
  ctx.db.guardarJugador(j)
  registrar(ctx, p, j.id, 'sistema', `${j.nombre} estará ausente ${formatoDuracion(ms)}.`)
  await resp(`😴 Listo, <b>${esc(j.nombre)}</b> queda ausente hasta el ${fechaCorta(j.ausente_hasta, ctx.cfg.tzMin)}. Tu personaje queda cubriendo la retaguardia. Vuelve solo, o antes con /volver.`)
  if (p.turno_jugador_id === j.id && p.estado === 'EN_JUEGO') await saltarTurno(ctx, p.id, 'pasar')
  else await refrescarTablero(ctx, p.id)
}

export async function cmdVolver(ctx: Ctx, p: Partida, j: Jugador, resp: Resp) {
  if (j.estado !== 'ausente' && j.estado !== 'dormido') return resp('Ya estás en juego.')
  j.estado = 'activo'
  j.ausente_hasta = 0
  j.saltos_seguidos = 0
  ctx.db.guardarJugador(j)
  ajustarRitmo(ctx, p.id)
  await resp(`👋 ¡Bienvenido de vuelta, ${esc(j.nombre)}!`)
  await cmdResumen(ctx, p, j, resp)
  if (p.estado === 'PAUSADA') {
    p.estado = 'EN_JUEGO'
    p.turno_jugador_id = null
    ctx.db.guardarPartida(p)
    await iniciarTurno(ctx, p.id)
  } else await refrescarTablero(ctx, p.id)
}

export async function cmdPasar(ctx: Ctx, p: Partida, j: Jugador, resp: Resp) {
  if (p.estado !== 'EN_JUEGO' || p.turno_jugador_id !== j.id) return resp('No es tu turno.')
  if (p.paso.tipo === 'narrando') return resp('El DJ está narrando tu acción.')
  await saltarTurno(ctx, p.id, 'pasar')
}

export async function cmdSalir(ctx: Ctx, p: Partida, j: Jugador, resp: Resp) {
  j.estado = 'fuera'
  ctx.db.guardarJugador(j)
  const pj = ctx.db.personajeVivoDe(j.id)
  registrar(ctx, p, j.id, 'sistema', `${j.nombre} deja la partida.`, `${pj?.ficha.nombre ?? j.nombre} se despide del grupo.`)
  ajustarRitmo(ctx, p.id)
  await resp(`👋 ${esc(j.nombre)} sale de la partida. Su personaje se retira de escena.`)
  if (p.turno_jugador_id === j.id && p.estado === 'EN_JUEGO') {
    p.paso = { tipo: 'libre' }
    ctx.db.guardarPartida(p)
    await avanzarTurno(ctx, p.id)
  } else await refrescarTablero(ctx, p.id)
}

export async function cmdPausa(ctx: Ctx, p: Partida, j: Jugador, resp: Resp) {
  if (p.anfitrion_id !== j.user_id) return resp('Solo el anfitrión.')
  if (p.estado !== 'EN_JUEGO') return resp('La partida no está en juego.')
  p.estado = 'PAUSADA'
  p.turno_vence = SIN_LIMITE
  ctx.db.guardarPartida(p)
  await resp('⏸ Partida en pausa. Los plazos están congelados. /reanudar para seguir.')
  await refrescarTablero(ctx, p.id)
}

export async function cmdReanudar(ctx: Ctx, p: Partida, j: Jugador, resp: Resp) {
  if (p.anfitrion_id !== j.user_id) return resp('Solo el anfitrión.')
  if (p.estado !== 'PAUSADA') return resp('La partida no está en pausa.')
  p.estado = 'EN_JUEGO'
  ctx.db.guardarPartida(p)
  await resp('▶️ ¡Seguimos!')
  // Se repite el turno actual con plazo nuevo.
  p.turno_jugador_id = null
  ctx.db.guardarPartida(p)
  await iniciarTurno(ctx, p.id)
}

export async function cmdFin(ctx: Ctx, p: Partida, j: Jugador, resp: Resp) {
  if (p.anfitrion_id !== j.user_id) return resp('Solo el anfitrión puede terminar la partida.')
  if (p.estado === 'CONFIG' || p.estado === 'CREANDO') {
    p.estado = 'FINALIZADA'
    ctx.db.guardarPartida(p)
    await resp('🏁 Partida cancelada. Cuando quieran, /nueva.')
    return
  }
  await finalizarPartida(ctx, p.id)
}

export async function cmdLibro(ctx: Ctx, p: Partida, resp: Resp) {
  if (ctx.db.maxBitacora(p.id) === 0) return resp('Todavía no hay historia para el libro.')
  await enviarLibro(ctx, p.id)
}

export { cargar, pjDe }
