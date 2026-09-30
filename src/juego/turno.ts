import type { Ctx } from '../ctx.js'
import type { Jugador, Partida, Personaje, PedidoTirada, TiradaResuelta } from '../motor/tipos.js'
import type { SalidaNarrar } from '../dj/cerebro.js'
import { ErrorPresupuesto, decidirTurno, epilogo, recomprimirResumen, transmisionRadio } from '../dj/servicios.js'
import { aplicarCambios, claveJugador } from '../motor/estado.js'
import { esCaido } from '../motor/personaje.js'
import { resolverPrueba, tnDe, type Extra } from '../motor/reglas.js'
import { crearCombate } from '../motor/combate.js'
import { siguienteJugador, vencimiento } from '../motor/turnos.js'
import { esc, recortar } from '../util.js'
import { tarjetaTiradaTexto, tarjetaTurnoTexto, mencion } from '../telegram/textos.js'
import { tecladoCombate, tecladoInfo, tecladoMejora, tecladoTiradaBotones } from '../telegram/teclados.js'
import { aGrupo, aPrivado, cargar, palabras, pjDe, refrescarTablero, registrar } from './comun.js'
import { comenzarCombate, tecladoCombateDe } from './combate.js'
import { exportarLibro } from '../export/libro.js'
import { cancelarObsoletas } from './votos.js'

const MAX_ACCION = 600
const CAPS: Record<string, number> = { oneshot: 1, mini: 4, abierta: 0 }

// ------------------------------------------------------------------ turnos

export async function iniciarTurno(ctx: Ctx, pid: number): Promise<void> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  if (partida.estado !== 'EN_JUEGO') return
  const combate = partida.mundo.combate
  const puede = (j: Jugador) => {
    const pj = pjDe(pjs, j)
    if (!pj) return false
    if (combate) return !esCaido(pj) && !combate.orden.includes(j.id)
    return true
  }
  const sig = siguienteJugador(jugadores, partida.turno_jugador_id, puede)
  if (!sig) {
    if (combate) return // el combate decide qué hacer al no haber pendientes
    partida.estado = 'PAUSADA'
    ctx.db.guardarPartida(partida)
    await aGrupo(ctx, partida, '⏸ <b>No hay nadie disponible</b> (todos ausentes o dormidos). La partida queda en pausa. Cuando alguien vuelva, usen /reanudar.')
    await refrescarTablero(ctx, pid)
    return
  }

  if (sig.saltados.length && !combate) {
    const nombres = sig.saltados.map((j) => `${esc(j.nombre)} (${j.estado})`).join(', ')
    registrar(ctx, partida, null, 'sistema', `Se saltea a ${sig.saltados.map((j) => j.nombre).join(', ')} (no disponibles).`)
    await aGrupo(ctx, partida, `😴 Se saltea a ${nombres}: sus personajes quedan cubriendo la retaguardia.`)
  }

  const ahora = ctx.reloj.ahora()
  if (sig.nuevaRonda && !combate) {
    partida.ronda++
    partida.rondas_cap++
  }
  partida.turno_jugador_id = sig.jugador.id
  partida.turno_n++
  partida.turno_desde = ahora
  partida.turno_vence = vencimiento(ahora, partida.config.plazoH, partida.config.silencio, ctx.cfg.tzMin)
  partida.recordado = 0
  partida.paso = { tipo: 'esperando_accion' }

  const pj = pjDe(pjs, sig.jugador)
  const nuevas = ctx.db.bitacoraDesde(partida.id, sig.jugador.ultimo_visto_n).filter((b) => b.cronica && b.jugador_id !== sig.jugador.id)
  const mientras = nuevas.length >= 2 ? nuevas.slice(-4).map((b) => b.cronica) : []
  const texto = tarjetaTurnoTexto(ctx, partida, sig.jugador, pj, mientras)
  const teclado = combate && pj ? tecladoCombateDe(ctx, partida, pj, pjs) : tecladoInfo(partida.id)
  partida.turno_msg_id = await aGrupo(ctx, partida, texto, { teclado })
  sig.jugador.ultimo_visto_n = ctx.db.maxBitacora(partida.id)
  ctx.db.guardarJugador(sig.jugador)
  ctx.db.guardarPartida(partida)

  await cancelarObsoletas(ctx, pid)
  await aPrivado(ctx, partida, sig.jugador, `🎲 <b>Te toca</b> en «${esc(partida.guion?.titulo ?? 'la partida')}». Andá al grupo y respondé al mensaje del DJ.`)
  await refrescarTablero(ctx, pid)
}

/** Termina el turno actual y pasa al siguiente (o continúa el combate). */
export async function avanzarTurno(ctx: Ctx, pid: number): Promise<void> {
  const partida = ctx.db.partida(pid)!
  if (partida.mundo.combate) {
    const { finTurnoCombate } = await import('./combate.js')
    return finTurnoCombate(ctx, pid)
  }
  return iniciarTurno(ctx, pid)
}

export async function saltarTurno(ctx: Ctx, pid: number, motivo: 'voto' | 'auto' | 'pasar'): Promise<void> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  const j = jugadores.find((x) => x.id === partida.turno_jugador_id)
  if (!j || partida.estado !== 'EN_JUEGO') return
  const pj = pjDe(pjs, j)
  const nombre = pj?.ficha.nombre ?? j.nombre
  const razon = { voto: 'por decisión del grupo', auto: 'por inactividad', pasar: 'por decisión propia' }[motivo]
  if (motivo !== 'pasar') {
    j.saltos_seguidos++
    if (j.saltos_seguidos >= 3) {
      j.estado = 'dormido'
      await aPrivado(ctx, partida, j, '💤 Te saltearon tres veces seguidas: tu personaje pasa a modo dormido (te acompaña sin decidir). Usá /volver cuando quieras retomar.')
    }
  }
  ctx.db.guardarJugador(j)
  registrar(ctx, partida, j.id, 'sistema', `Turno de ${nombre} salteado ${razon}.`, `${nombre} se queda cubriendo la retaguardia.`)
  await aGrupo(ctx, partida, `😴 Turno de <b>${esc(nombre)}</b> salteado ${razon}: se queda cubriendo la retaguardia (sin riesgos ni botín).${j.estado === 'dormido' ? ' Queda 💤 dormido.' : ''}`)
  if (partida.mundo.combate && pj) partida.mundo.combate.orden.push(j.id)
  partida.paso = { tipo: 'libre' }
  ctx.db.guardarPartida(partida)
  await avanzarTurno(ctx, pid)
}

// ------------------------------------------------------------------ acciones libres

export async function procesarAccion(ctx: Ctx, pid: number, userId: string, textoCrudo: string): Promise<void> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  const j = jugadores.find((x) => x.user_id === userId)
  if (!j || partida.estado !== 'EN_JUEGO') return
  const enCombate = !!partida.mundo.combate
  const aceptaTexto = partida.paso.tipo === 'esperando_libre' || (partida.paso.tipo === 'esperando_accion' && !enCombate)
  if (partida.turno_jugador_id !== j.id) return
  if (!aceptaTexto) {
    if (enCombate && partida.paso.tipo === 'esperando_accion') {
      await aGrupo(ctx, partida, '⚔️ En combate elegí una acción con los botones (o tocá <b>💬 Acción libre</b>).', { responderA: partida.turno_msg_id ?? undefined })
    }
    return
  }
  const pj = pjDe(pjs, j)
  if (!pj) return
  const texto = recortar(textoCrudo.replace(/[<>]/g, ' ').replace(/\s+/g, ' '), MAX_ACCION)
  if (!texto) return

  registrar(ctx, partida, j.id, 'accion', `${pj.ficha.nombre}: ${texto}`)
  partida.paso = { tipo: 'narrando', accion: texto, jugadorId: j.id }
  ctx.db.guardarPartida(partida)
  await narrarAccion(ctx, pid, j, pj, texto, undefined)
}

async function narrarAccion(ctx: Ctx, pid: number, j: Jugador, pj: Personaje, texto: string, tirada: TiradaResuelta | undefined): Promise<void> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  await ctx.api.escribiendo(partida.chat_id, partida.thread_id)
  let usuario = `<accion jugador="${pj.ficha.nombre} (${claveJugador(pj)})">${texto}</accion>`
  if (tirada) usuario += `\n<resultado_tirada>${resumenTirada(ctx, pj, tirada)}</resultado_tirada>\nNarrá exactamente ese resultado y cerrá el turno con "narrar".`
  try {
    const extra = partida.mundo.combate ? 'COMBATE en curso: los golpes los resuelve el motor. Esta es una acción libre no estándar; narrala y proponé su efecto sin inventar daño.' : undefined
    const d = await decidirTurno(ctx, partida, pjs, jugadores, { tarea: 'turno', usuario, turnoPj: pj, forzarNarrar: !!tirada, extra })
    if (d.tipo === 'tirada') {
      await pedirTirada(ctx, pid, j, pj, texto, d.preambulo, d.pedido)
    } else {
      await cerrarTurnoConNarracion(ctx, pid, j, pj, d.salida, tirada)
    }
  } catch (e) {
    const p2 = ctx.db.partida(pid)!
    const boton = [[{ text: '🔄 Reintentar', callback_data: `n:${pid}:${p2.turno_n}` }]]
    if (e instanceof ErrorPresupuesto) {
      await aGrupo(ctx, p2, '💸 <b>El DJ se quedó sin presupuesto por hoy.</b> Tu turno se conserva: cuando vuelva el presupuesto tocá reintentar. El anfitrión puede ver /costo.', { teclado: boton })
    } else {
      ctx.log('Error narrando:', (e as Error).message)
      await aGrupo(ctx, p2, '📡 El DJ se quedó sin señal un momento. Tu turno se conserva: tocá reintentar.', { teclado: boton })
    }
  }
}

/** Reintenta una narración que falló (o quedó a medias por un reinicio). */
export async function reintentarNarracion(ctx: Ctx, pid: number, turnoN: number): Promise<string | void> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  const paso = partida.paso
  if (paso.tipo !== 'narrando' || partida.turno_n !== turnoN) return 'Ya no hace falta reintentar.'
  const j = jugadores.find((x) => x.id === paso.jugadorId)
  const pj = j ? pjDe(pjs, j) : undefined
  if (!j || !pj) return
  await narrarAccion(ctx, pid, j, pj, paso.accion, paso.tirada)
}

function resumenTirada(ctx: Ctx, pj: Personaje, t: TiradaResuelta): string {
  const h = ctx.u.habilidades.find((x) => x.id === t.pedido.habilidad)
  return `${pj.ficha.nombre} intentó: ${t.pedido.motivo}. ${t.pedido.atributo}+${h?.nombre ?? t.pedido.habilidad} TN ${t.tn}, dificultad ${t.pedido.dificultad}. Dados ${t.dados.join(', ')} → ${t.exitos} éxito(s)${t.criticos ? ` (${t.criticos} crítico)` : ''}. ${t.exito ? 'ÉXITO' : 'FRACASO'}${t.impulso ? ` con ${t.impulso} de impulso` : ''}${t.complicaciones ? '. COMPLICACIÓN (sacó 20): agregá un giro' : ''}.`
}

// ------------------------------------------------------------------ tiradas

async function pedirTirada(ctx: Ctx, pid: number, j: Jugador, pj: Personaje, accion: string, preambulo: string, pedido: PedidoTirada): Promise<void> {
  const partida = ctx.db.partida(pid)!
  if (!ctx.u.habilidades.some((h) => h.id === pedido.habilidad)) pedido.habilidad = 'supervivencia'
  partida.paso = { tipo: 'esperando_tirada', accion, jugadorId: j.id, pedido }
  ctx.db.guardarPartida(partida)
  const tn = tnDe(pj, pedido.atributo, pedido.habilidad)
  const texto = tarjetaTiradaTexto(ctx, pj, preambulo, pedido.atributo, pedido.habilidad, tn, pedido.dificultad, pedido.motivo)
  await aGrupo(ctx, partida, `${texto}\n\n${mencion(j)}, tocá el botón para tirar.`, { teclado: tecladoTiradaBotones(pid, partida.turno_n, pj, partida.mundo.impulso) })
}

export async function resolverTirada(ctx: Ctx, pid: number, userId: string, turnoN: number, extraCod: string, mensajeId: number | undefined): Promise<string | void> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  const paso = partida.paso
  if (paso.tipo !== 'esperando_tirada' || partida.turno_n !== turnoN) return 'Esa tirada ya no está pendiente.'
  const j = jugadores.find((x) => x.id === paso.jugadorId)
  if (!j || j.user_id !== userId) return 'Esta tirada es de otra persona.'
  const pj = pjDe(pjs, j)!
  let extra: Extra = 'ninguno'
  if (extraCod === 's') {
    if (pj.suerte <= 0) return 'No te quedan puntos de Suerte.'
    pj.suerte--
    extra = 'suerte'
  } else if (extraCod === 'i') {
    if (partida.mundo.impulso <= 0) return 'No hay Impulso en el grupo.'
    partida.mundo.impulso--
    extra = 'impulso'
  }
  const t = resolverPrueba(pj, paso.pedido, extra, ctx.rng)
  partida.mundo.impulso = Math.min(3, partida.mundo.impulso + t.impulso)
  ctx.db.guardarPersonaje(pj)
  ctx.db.registrarTirada(pid, j.id, {
    atributo: t.pedido.atributo, habilidad: t.pedido.habilidad, tn: t.tn, dificultad: t.pedido.dificultad,
    dados: t.dados, exitos: t.exitos, complicaciones: t.complicaciones, impulso: t.impulso, extra, motivo: t.pedido.motivo,
  }, ctx.reloj.ahora())
  registrar(ctx, partida, j.id, 'tirada', resumenTirada(ctx, pj, t))
  partida.paso = { tipo: 'narrando', accion: paso.accion, jugadorId: j.id, tirada: t }
  ctx.db.guardarPartida(partida)

  const dadosTxt = t.dados.map((d) => (d <= t.tn ? `<b>${d}</b>` : `${d}`) + (d === 20 ? '⚠️' : '')).join(' · ')
  const linea = `🎲 ${dadosTxt}  vs TN ${t.tn}${extra !== 'ninguno' ? ` (+1d20 ${extra === 'suerte' ? '🍀' : '⚡'})` : ''} → <b>${t.exitos} éxito${t.exitos === 1 ? '' : 's'}</b>${t.criticos ? ' ⭐' : ''} (necesitabas ${t.pedido.dificultad}) ${t.exito ? '✅' : '❌'}${t.impulso ? ` · ⚡ +${t.impulso} Impulso` : ''}${t.complicaciones ? ' · ⚠️ Complicación' : ''}`
  if (mensajeId) {
    const previo = tarjetaTiradaTexto(ctx, pj, '', t.pedido.atributo, t.pedido.habilidad, t.tn, t.pedido.dificultad, t.pedido.motivo)
    await ctx.api.editar(partida.chat_id, mensajeId, `${previo}\n\n${linea}`, [])
  } else {
    await aGrupo(ctx, partida, linea)
  }
  await narrarAccion(ctx, pid, j, pj, paso.accion, t)
}

// ------------------------------------------------------------------ cierre de turno

export async function cerrarTurnoConNarracion(ctx: Ctx, pid: number, j: Jugador, pj: Personaje, salida: SalidaNarrar, tirada?: TiradaResuelta): Promise<void> {
  const { partida, pjs, jugadores } = cargar(ctx, pid)
  const res = aplicarCambios(ctx.u, partida.mundo, pjs, salida.cambios, { enCombate: !!partida.mundo.combate })
  for (const p of pjs) ctx.db.guardarPersonaje(p)
  const cronica = salida.cronica || `${pj.ficha.nombre}: ${recortar(salida.narracion, 90)}`
  registrar(ctx, partida, j.id, 'narracion', salida.narracion, cronica)
  j.foco += 1
  j.saltos_seguidos = 0
  ctx.db.guardarJugador(j)

  const l: string[] = [`🎲 <i>${esc(salida.narracion)}</i>`]
  const notas = [...res.aplicados]
  if (res.caidos.length) notas.push(...res.caidos.map((n) => `🩸 ${n} queda CAÍDO`))
  if (res.relojesLlenos.length) notas.push(...res.relojesLlenos.map((n) => `⏰ ¡Se llenó el reloj «${n}»!`))
  if (notas.length) l.push('', '📋 ' + notas.map(esc).join(' · '))
  if (salida.sugerencias.length && !partida.mundo.combate) l.push('', '💡 ' + salida.sugerencias.map(esc).join(' · '))
  void tirada
  await aGrupo(ctx, partida, l.join('\n'))

  partida.paso = { tipo: 'libre' }
  partida.mundo.senalX = false
  ctx.db.guardarPartida(partida)

  // Combate nuevo: el motor toma el control.
  if (salida.combate && !partida.mundo.combate) {
    const c = crearCombate(ctx.u, salida.combate.enemigos, salida.combate.sorpresa ?? 'ninguna')
    if (c) {
      await comenzarCombate(ctx, pid, c, j.id)
      return
    }
  }

  // Memoria: recomprimir cuando se acumularon crónicas.
  const p2 = ctx.db.partida(pid)!
  const pendientes = ctx.db.bitacoraDesde(pid, p2.resumen_hasta).filter((b) => b.cronica).length
  if (pendientes >= 6) {
    await recomprimirResumen(ctx, p2)
    ctx.db.guardarPartida(p2)
  }

  if (salida.cerrar_capitulo) {
    await cerrarCapitulo(ctx, pid)
    if (ctx.db.partida(pid)!.estado === 'FINALIZADA') return
  }
  void jugadores
  await avanzarTurno(ctx, pid)
}

// ------------------------------------------------------------------ capítulos y final

export async function cerrarCapitulo(ctx: Ctx, pid: number): Promise<void> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  const total = CAPS[partida.config.duracion] ?? 0
  const cronicas = ctx.db.bitacoraDesde(pid, 0).filter((b) => b.cronica).slice(-14).map((b) => b.cronica)
  let radio = ''
  try {
    radio = await transmisionRadio(ctx, partida, cronicas)
  } catch (e) {
    ctx.log('radio falló', (e as Error).message)
  }
  const capCerrado = partida.capitulo
  if (total > 0 && capCerrado >= total) {
    await finalizarPartida(ctx, pid, radio)
    return
  }
  for (const p of pjs) {
    p.suerte = p.ficha.atributos.SUE
    p.penal_salud = 0
    p.salud = Math.min(p.salud_max, Math.max(p.salud, Math.ceil(p.salud_max / 2)))
    p.condiciones = p.condiciones.filter((c) => c !== 'caido')
    ctx.db.guardarPersonaje(p)
  }
  partida.capitulo++
  partida.rondas_cap = 0
  registrar(ctx, partida, null, 'sistema', `Capítulo ${capCerrado} cerrado.`, `Fin del capítulo ${capCerrado}.`)
  ctx.db.guardarPartida(partida)
  await aGrupo(ctx, partida, `📻 <b>Fin del capítulo ${capCerrado}</b>\n\n${radio ? '<i>' + esc(radio) + '</i>\n\n' : ''}🍀 Se recuperó la Suerte y la salud. Cada jugador puede elegir una <b>mejora</b> por privado.`)
  for (const j of jugadores) {
    if (j.estado === 'fuera') continue
    j.mejora_pendiente = true
    ctx.db.guardarJugador(j)
    await aPrivado(ctx, partida, j, `⬆️ <b>Mejora de capítulo</b>: elegí cómo crece tu personaje.`, tecladoMejora(ctx, capCerrado))
  }
}

export async function finalizarPartida(ctx: Ctx, pid: number, radio = ''): Promise<void> {
  const { partida, pjs } = cargar(ctx, pid)
  let ep = ''
  try {
    const todos = ctx.db.personajesTodos(pid)
    ep = await epilogo(ctx, partida, todos.length ? todos : pjs)
  } catch (e) {
    ctx.log('epílogo falló', (e as Error).message)
  }
  partida.estado = 'FINALIZADA'
  partida.paso = { tipo: 'libre' }
  partida.mundo.combate = null
  ctx.db.guardarPartida(partida)
  await aGrupo(ctx, partida, `🏁 <b>FIN DE LA AVENTURA</b>\n\n${radio ? '<i>' + esc(radio) + '</i>\n\n' : ''}${ep ? esc(ep) + '\n\n' : ''}📚 Acá va el libro de la partida.`)
  await refrescarTablero(ctx, pid)
  await enviarLibro(ctx, pid)
}

export async function enviarLibro(ctx: Ctx, pid: number): Promise<void> {
  const partida = ctx.db.partida(pid)!
  const md = exportarLibro(ctx, partida)
  const nombre = `cronicas-${(partida.guion?.titulo ?? 'partida').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.md`
  await ctx.api.documento(partida.chat_id, nombre, md, '📚 Crónicas de la partida', { threadId: partida.thread_id })
}
