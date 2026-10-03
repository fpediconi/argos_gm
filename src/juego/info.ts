import type { Ctx } from '../ctx.js'
import type { Jugador, Partida } from '../motor/tipos.js'
import { esc, parseDuracion, formatoDuracion, fechaCorta, textoIA } from '../util.js'
import { alertasTexto, fichaTexto, inventarioTexto, partyTexto, REGLAS } from '../telegram/textos.js'
import { claveJugador, npcsConocidos } from '../motor/estado.js'
import { contarMencionJugador, hilosAbiertos, menciona, narrativaDe, presentes } from '../motor/canon.js'
import { proximoJugador } from '../dj/contexto.js'
import { responderPregunta } from '../dj/servicios.js'
import type { Teclado } from '../telegram/api.js'
import { registrarHecho } from './narrativa.js'
import { estadoPresupuesto } from '../dj/presupuesto.js'
import { transmisionRadio } from '../dj/servicios.js'

import { registrar, refrescarTablero, pjDe, cargar } from './comun.js'
import { ajustarRitmo, avanzarTurno, enviarLibro, finalizarPartida, iniciarTurno, pedirFinal, saltarTurno } from './turno.js'
import { SIN_LIMITE } from '../motor/turnos.js'

type Resp = (html: string) => Promise<void>

export async function cmdFicha(ctx: Ctx, p: Partida, j: Jugador, resp: Resp, privado = false) {
  const pj = ctx.db.ultimoPersonajeDe(j.id)
  await resp(pj ? fichaTexto(ctx, pj, privado) : 'Todavía no tenés personaje. Tocá «Crear mi personaje» en el tablero.')
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
  const enEscena = presentes(m, p.turno_n).filter((n) => n.conocido !== false)
  if (enEscena.length) l.push('👥 ' + enEscena.map((n) => `${esc(n.nombre)} (${esc(n.actitud)})`).join(' · '))
  if (m.muertos?.length) l.push('💀 ' + m.muertos.map(esc).join(', '))
  l.push(...alertasTexto(p))
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
    await resp(`📻 <b>Radio Yermo</b>\n\n<i>${textoIA(t)}</i>`)
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
  const n = p.mundo.narrativa
  const coherencia = n ? `\n\n🧭 Coherencia: ${n.auditorias ?? 0} narraciones auditadas · ${n.reparaciones ?? 0} reparadas · ${n.contradicciones ?? 0} contradicciones detectadas` : ''
  await resp(`💸 <b>Gasto de IA</b>\nHoy: US$ ${pres.gastoPartida.toFixed(3)} de ${pres.topePartida.toFixed(2)} (partida) · global US$ ${pres.gastoGlobal.toFixed(3)} de ${pres.topeGlobal.toFixed(2)}\nEstado del fusible: <b>${pres.nivel}</b>\n\nTotal por tipo:\n${por.map((r) => `• ${esc(r.rol)}: ${r.llamadas} llamadas · ${r.tok_in} in (${r.tok_cache} en caché) · ${r.tok_out} out · US$ ${r.usd.toFixed(3)}`).join('\n') || '(sin llamadas todavía)'}${coherencia}`)
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
  if (ctx.db.personajesVivos(p.id).length === 0) return resp('💀 No queda nadie en pie. Creen un personaje nuevo (la partida sigue sola apenas alguien lo termina) o terminen la historia con /fin.')
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

// ------------------------------------------------------------------ /dj: preguntarle al DJ entre turnos

const MAX_PREGUNTAS_IA = 5

export function tecladoDj(pid: number): Teclado {
  return [
    [{ text: '👥 ¿Quién es quién?', callback_data: `j:${pid}:quien` }, { text: '🎯 ¿Qué buscamos?', callback_data: `j:${pid}:obj` }],
    [{ text: '📜 ¿Qué pasó?', callback_data: `j:${pid}:paso` }, { text: '📍 ¿Dónde estamos?', callback_data: `j:${pid}:donde` }],
  ]
}

export const TEXTO_MENU_DJ = '❓ <b>Preguntale al DJ</b> (no gasta tu turno)\nTocá una opción o escribí tu pregunta. En el grupo: <code>/dj ¿quién era la Colorada?</code> · por privado: escribila directo.\n<i>Solo te dice lo que tu personaje sabe.</i>'

/** Nivel 0: respuestas armadas desde el Canon, sin IA y sin spoilers. */
export function respuestaDj(ctx: Ctx, p: Partida, j: Jugador | undefined, que: string): string {
  const m = p.mundo
  const jugadores = ctx.db.jugadores(p.id)
  const pjs = ctx.db.personajesVivos(p.id)
  const miPj = j ? pjs.find((x) => x.jugador_id === j.id) : undefined
  const l: string[] = []
  if (que === 'quien') {
    const prox = proximoJugador(p, jugadores, pjs)
    l.push('👥 <b>Quién es quién</b>', '', '<b>La mesa</b>')
    for (const jj of jugadores.filter((x) => x.estado !== 'fuera' && x.estado !== 'creando')) {
      const pj = pjs.find((x) => x.jugador_id === jj.id)
      const marca = p.turno_jugador_id === jj.id ? ' 🎯 juega ahora' : prox?.id === jj.id ? ' ⏭ juega después' : ''
      l.push(`• ${esc(jj.nombre)} → ${pj ? `<b>${esc(pj.ficha.nombre)}</b>${pj.ficha.bio ? ` — ${esc(pj.ficha.bio)}` : ''}` : '<i>sin personaje</i>'}${marca}`)
    }
    const conocidos = npcsConocidos(m)
    const enEscena = new Set(presentes(m, p.turno_n).map((x) => x.id))
    if (conocidos.length) {
      l.push('', '<b>La gente que conocieron</b>')
      for (const n of conocidos.sort((a, b) => Number(enEscena.has(b.id)) - Number(enEscena.has(a.id)))) {
        const rel = miPj ? n.relacion?.[claveJugador(miPj)] : undefined
        const relTxt = rel ? (rel.valor > 0 ? ' · te tiene simpatía' : rel.valor < 0 ? ' · no te quiere' : '') : ''
        const estado = n.estado === 'muerto' ? ' 💀' : n.estado === 'huido' ? ' (se fue)' : n.estado === 'herido' ? ' (herido)' : ''
        l.push(`• <b>${esc(n.nombre)}</b>${estado}${enEscena.has(n.id) ? ' 📍 está acá' : ''} — ${esc(n.publico || n.nota || n.actitud || '')}${relTxt}`)
      }
    } else l.push('', 'Todavía no conocieron a nadie con nombre.')
  } else if (que === 'obj') {
    const principal = m.misiones.find((x) => x.principal)
    l.push('🎯 <b>Qué buscamos</b>')
    if (principal) l.push(`<b>Objetivo:</b> ${esc(principal.texto)}${principal.estado !== 'activa' ? ` (${principal.estado})` : ''}`)
    const logrados = (p.guion?.actos ?? []).flatMap((a) => a.hitos.filter((h) => h.cumplido))
    if (logrados.length) l.push('', '<b>Lo que ya lograron</b>', ...logrados.map((h) => `✅ ${esc(h.texto)}`))
    const otras = m.misiones.filter((x) => x.estado === 'activa' && !x.principal)
    if (otras.length) l.push('', '<b>Pendientes</b>', ...otras.map((x) => `▫️ ${esc(x.texto)}`))
    const hilos = hilosAbiertos(m).filter((h) => h.tipo !== 'principal' && (h.tipo !== 'personal' || h.pj === miPj?.id))
    if (hilos.length) l.push('', '<b>Preguntas abiertas</b>', ...hilos.map((h) => `❔ ${esc(h.pregunta)}`))
    if (miPj?.ficha.objetivo) l.push('', `<i>Lo tuyo (solo vos lo ves): ${esc(miPj.ficha.objetivo)}</i>`)
  } else if (que === 'paso') {
    const desde = j?.ultimo_visto_n ?? 0
    const todas = ctx.db.bitacoraTodas(p.id).filter((b) => b.cronica)
    const nuevas = todas.filter((b) => b.n > desde)
    const lista = (nuevas.length ? nuevas : todas).slice(-10)
    l.push(`📜 <b>${nuevas.length ? 'Lo que pasó desde tu último turno' : 'Lo último que pasó'}</b>`)
    l.push(...(lista.length ? lista.map((b) => `• ${esc(b.cronica)}`) : ['La historia recién empieza.']))
    if (m.capitulos?.length) l.push('', `<i>Antes: ${esc(m.capitulos.at(-1)!)}</i>`)
  } else if (que === 'donde') {
    const e = m.escena
    l.push('📍 <b>Dónde estamos</b>')
    l.push(`<b>${esc(e?.lugar || m.ubicacion || 'Lugar sin nombre')}</b>`)
    const lugar = (m.lugares ?? []).find((x) => x.conocido && (e?.lugar ?? m.ubicacion) && menciona(e?.lugar ?? m.ubicacion, x.nombre))
    if (lugar?.rasgo) l.push(esc(lugar.rasgo))
    if (e?.pregunta) l.push('', `<b>Lo que está en juego:</b> ${esc(e.pregunta)}`)
    const acá = presentes(m, p.turno_n).filter((x) => x.conocido !== false)
    l.push('', acá.length ? `<b>Acá están:</b> ${acá.map((x) => esc(x.nombre)).join(', ')}` : 'No hay nadie más a la vista.')
    const otros = (m.lugares ?? []).filter((x) => x.conocido && x !== lugar)
    if (otros.length) l.push('', `<b>Lugares conocidos:</b> ${otros.map((x) => esc(x.nombre)).join(', ')}`)
  }
  return l.join('\n')
}

/** /dj [pregunta]: sin texto muestra el menú; con texto responde con la IA barata y SOLO lo que el personaje sabe. */
export async function cmdDj(ctx: Ctx, p: Partida, j: Jugador, args: string, resp: (html: string, teclado?: Teclado) => Promise<void>) {
  if (p.estado !== 'EN_JUEGO' && p.estado !== 'PAUSADA') return resp('La historia todavía no empezó.')
  const pregunta = args.replace(/[<>]/g, ' ').trim().slice(0, 300)
  if (!pregunta) return resp(TEXTO_MENU_DJ, tecladoDj(p.id))
  const n = narrativaDe(p.mundo)
  const uso = n.dj[j.user_id]?.turno === p.turno_n ? n.dj[j.user_id] : { turno: p.turno_n, n: 0 }
  if (uso.n >= MAX_PREGUNTAS_IA) return resp(`🙊 Ya hiciste ${MAX_PREGUNTAS_IA} preguntas este turno. Mientras, los botones responden al toque:`, tecladoDj(p.id))
  if (estadoPresupuesto(ctx, p.id).nivel === 'parado') return resp('💸 Sin presupuesto de IA por hoy. Los botones siguen andando:', tecladoDj(p.id))
  uso.n++
  n.dj[j.user_id] = uso
  // La confusión es una señal: lo que la mesa pregunta, el DJ lo aclara en la ficción.
  for (const npc of p.mundo.npcs) if (menciona(pregunta, npc.nombre)) n.preguntas[npc.id] = (n.preguntas[npc.id] ?? 0) + 1
  if (/objetivo|qu[eé] (hay que|tenemos que|buscamos)|para qu[eé]/i.test(pregunta)) n.preguntas.objetivo = (n.preguntas.objetivo ?? 0) + 1
  contarMencionJugador(p.mundo, pregunta)
  ctx.db.guardarPartida(p)
  const pj = ctx.db.personajeVivoDe(j.id)
  registrar(ctx, p, j.id, 'ooc', `${j.nombre} preguntó al DJ: ${pregunta}`)
  try {
    const r = await responderPregunta(ctx, p, pj, pregunta)
    await resp(`❓ <i>${esc(pregunta)}</i>\n\n🎲 ${textoIA(r)}`)
  } catch {
    await resp('📡 El DJ no tiene señal ahora. Probá con los botones:', tecladoDj(p.id))
  }
}

/** /fe_de_erratas texto (anfitrión): deja un hecho que corrige la historia. */
export async function cmdFeDeErratas(ctx: Ctx, p: Partida, j: Jugador, args: string, resp: Resp) {
  if (p.anfitrion_id !== j.user_id) return resp('Solo el anfitrión puede corregir la historia.')
  const texto = args.replace(/[<>]/g, ' ').trim().slice(0, 240)
  if (!texto) return resp('Escribí la corrección: <code>/fe_de_erratas Tomás no murió: quedó herido en el muelle</code>')
  const n = narrativaDe(p.mundo)
  n.correcciones.push({ texto, hasta: p.turno_n + 3 })
  registrarHecho(ctx, p, `Corrección: ${texto}`, { fuente: 'jugador' })
  registrar(ctx, p, j.id, 'motor', `corrección del anfitrión: ${texto}`, `Corrección: ${texto}`)
  ctx.db.guardarPartida(p)
  await resp(`📝 Anotado. El DJ lo toma como verdad desde ahora: <i>${esc(texto)}</i>`)
}

export { cargar, pjDe }
