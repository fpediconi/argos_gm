import type { Ctx } from '../ctx.js'
import type { Intencion, Jugador, Partida, Personaje, PedidoTirada, TiradaResuelta } from '../motor/tipos.js'
import type { SalidaNarrar } from '../dj/cerebro.js'
import { ErrorPresupuesto, clasificarAccionCombate, clasificarIntencion, decidirTurno, epilogo, recomprimirResumen, transmisionRadio } from '../dj/servicios.js'
import { aplicarCambios, buscarPj, claveJugador, esNpcMuerto, marcarNpcMuerto, npcsVivos } from '../motor/estado.js'
import { esCaido } from '../motor/personaje.js'
import { armaPrincipal, resolverPrueba, tnDe, type Extra } from '../motor/reglas.js'
import { crearCombate, golpeCreativo, resolverCaidos, vivos } from '../motor/combate.js'
import { siguienteJugador, vencimiento } from '../motor/turnos.js'
import {
  esCapituloFinal, forzarClimax, faseDe, intervaloEvento, puedeCerrarAntes, recalcularObjetivo, registrarTurno, ritmoDe, ritmoNuevo, sortearEvento,
} from '../motor/ritmo.js'
import { esc, recortar, textoIA } from '../util.js'
import { mencion, resultadoTiradaTexto, tarjetaCoNarradorTexto, tarjetaTiradaTexto, tarjetaTurnoTexto } from '../telegram/textos.js'
import { tecladoAbandono, tecladoInfo, tecladoMejora, tecladoMuerte, tecladoTiradaBotones } from '../telegram/teclados.js'
import { aGrupo, aPrivado, botonGrupo, botonPrivado, cargar, fijarSolo, pjDe, refrescarTablero, registrar, urlUnirse } from './comun.js'
import { comenzarCombate, tecladoCombateDe } from './combate.js'
import { exportarLibro } from '../export/libro.js'
import { cancelarObsoletas } from './votos.js'
import {
  INSTRUCCION_CO_NARRADOR, INSTRUCCION_CONVENCER, INSTRUCCION_DESENLACE, INSTRUCCION_GOLPE, INSTRUCCION_DESENLACE_FINAL, INSTRUCCION_MATAR, INSTRUCCION_MUERTE_ARREPENTIDA,
  INSTRUCCION_MUERTE_CONFIRMADA, INSTRUCCION_SE_QUEDA, INSTRUCCION_SE_VA, INSTRUCCION_TRAICION,
} from '../dj/prompts.js'

const MAX_ACCION = 600

// ------------------------------------------------------------------ turnos

/** Partidas creadas con la versión anterior: se completan al vuelo (ritmo y objetivo principal). */
function migrar(partida: Partida, activos: number): void {
  ritmoDe(partida, activos)
  if (partida.guion && !partida.mundo.misiones.some((m) => m.principal)) {
    partida.mundo.misiones.unshift({ id: 'principal', texto: recortar(partida.config.premisa || partida.guion.premisa, 120), estado: 'activa', principal: true })
  }
  if (!partida.config.violencia) partida.config.violencia = 'implicita'
}

export async function iniciarTurno(ctx: Ctx, pid: number): Promise<void> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  if (partida.estado !== 'EN_JUEGO') return
  migrar(partida, jugadores.filter((j) => j.estado === 'activo').length)
  const combate = partida.mundo.combate
  // Nadie en pie: la partida no se traba, se ofrecen personajes nuevos o terminar.
  if (pjs.length === 0 && ctx.db.personajesTodos(pid).length > 0) return sinSobrevivientes(ctx, partida)
  const puede = (j: Jugador) => {
    const pj = pjDe(pjs, j)
    if (!pj) return !combate && esCoNarrador(ctx, j)
    if (combate) return !esCaido(pj) && !combate.orden.includes(j.id)
    return true
  }
  const sig = siguienteJugador(jugadores, partida.turno_jugador_id, puede)
  if (!sig) {
    if (combate) return // el combate decide qué hacer al no haber pendientes
    partida.estado = 'PAUSADA'
    ctx.db.guardarPartida(partida)
    await aGrupo(ctx, partida, '⏸ <b>No hay nadie disponible</b> (todos ausentes, dormidos o sin personaje). La partida queda en pausa. Cuando alguien vuelva, usen /reanudar.')
    await refrescarTablero(ctx, pid)
    return
  }

  if (sig.saltados.length && !combate) {
    const conPj = sig.saltados.filter((j) => j.estado !== 'activo' && j.estado !== 'listo')
    if (conPj.length) {
      const nombres = conPj.map((j) => `${esc(j.nombre)} (${j.estado})`).join(', ')
      registrar(ctx, partida, null, 'sistema', `Se saltea a ${conPj.map((j) => j.nombre).join(', ')} (no disponibles).`)
      await aGrupo(ctx, partida, `😴 Se saltea a ${nombres}: sus personajes quedan cubriendo la retaguardia.`)
    }
  }

  const ahora = ctx.reloj.ahora()
  if (sig.nuevaRonda && !combate) {
    partida.ronda++
    partida.rondas_cap++
    if (partida.ronda > 1) await avanzarAmenaza(ctx, partida, 1)
  }
  const anterior = partida.turno_msg_id
  partida.turno_jugador_id = sig.jugador.id
  partida.turno_n++
  partida.turno_desde = ahora
  partida.turno_vence = vencimiento(ahora, partida.config.plazoH, partida.config.silencio, ctx.cfg.tzMin)
  partida.recordado = 0
  partida.paso = { tipo: 'esperando_accion' }
  partida.mundo.avisos = { turno: partida.turno_n, ids: [] }

  const pj = pjDe(pjs, sig.jugador)
  const coNarrador = !pj
  const texto = coNarrador ? tarjetaCoNarradorTexto(ctx, partida, sig.jugador) : tarjetaTurnoTexto(ctx, partida, sig.jugador, pj, pjs)
  const teclado = coNarrador
    ? [[{ text: '🧑‍🚀 Crear otro personaje', url: urlUnirse(ctx, partida.id) }], [{ text: '⏭️ Pasar', callback_data: `i:${partida.id}:pasar` }]]
    : combate && pj ? tecladoCombateDe(ctx, partida, pj, pjs) : tecladoInfo(partida.id, !!partida.mundo.ideas?.length)
  partida.turno_msg_id = await aGrupo(ctx, partida, texto, { teclado })
  sig.jugador.ultimo_visto_n = ctx.db.maxBitacora(partida.id)
  ctx.db.guardarJugador(sig.jugador)
  ctx.db.guardarPartida(partida)

  // Quedan fijados solo el tablero y la tarjeta de este turno.
  if (anterior && !(partida.mundo.fijados ?? []).includes(anterior) && anterior !== partida.tablero_msg_id) await ctx.api.desfijar(partida.chat_id, anterior)
  await fijarSolo(ctx, partida, [partida.tablero_msg_id, partida.turno_msg_id])
  ctx.db.guardarPartida(partida)

  await cancelarObsoletas(ctx, pid)
  await aPrivado(ctx, partida, sig.jugador, `🎲 <b>Te toca</b> en «${esc(partida.guion?.titulo ?? 'la partida')}». Respondé a la tarjeta de tu turno en el grupo.`, botonGrupo(partida, '👉 Ir a mi turno', partida.turno_msg_id))
  await refrescarTablero(ctx, pid)
}

/** Jugador sin personaje vivo que ya jugó uno (murió o se fue): juega como voz del mundo. */
export function esCoNarrador(ctx: Ctx, j: Jugador): boolean {
  if (j.estado !== 'activo') return false
  const ultimo = ctx.db.ultimoPersonajeDe(j.id)
  return !!ultimo && !ultimo.vivo
}

/** Todos los personajes murieron o se fueron: pausa con salida clara (personajes nuevos o terminar). */
async function sinSobrevivientes(ctx: Ctx, partida: Partida): Promise<void> {
  if (partida.estado === 'PAUSADA') return
  partida.estado = 'PAUSADA'
  partida.paso = { tipo: 'libre' }
  partida.turno_jugador_id = null
  ctx.db.guardarPartida(partida)
  registrar(ctx, partida, null, 'sistema', 'No queda ningún personaje en pie.', 'No quedó nadie en pie.')
  await aGrupo(ctx, partida, '💀 <b>No queda nadie en pie.</b>\nLa historia puede seguir con personajes nuevos (apenas alguien crea uno, el juego sigue solo) o terminar acá con su epílogo.', {
    teclado: [[{ text: '🧑‍🚀 Crear un personaje nuevo', url: urlUnirse(ctx, partida.id) }], [{ text: '🏁 Terminar la historia (anfitrión)', callback_data: `b:${partida.id}:fin` }]],
  })
  await refrescarTablero(ctx, partida.id)
}

/** El reloj de la amenaza avanza solo. Si se llena, la historia salta al clímax. */
async function avanzarAmenaza(ctx: Ctx, partida: Partida, n: number): Promise<void> {
  const r = partida.mundo.relojes.find((x) => x.id === 'amenaza')
  if (!r || r.llenos >= r.segmentos) return
  r.llenos = Math.min(r.segmentos, r.llenos + n)
  if (r.llenos >= r.segmentos) {
    const ritmo = ritmoDe(partida, ctx.db.jugadores(partida.id).filter((j) => j.estado === 'activo').length)
    forzarClimax(ritmo)
    registrar(ctx, partida, null, 'sistema', `El reloj «${r.nombre}» se llenó.`, `La amenaza (${r.nombre}) llegó a su punto máximo.`)
    await aGrupo(ctx, partida, '⚠️ <b>La tensión llegó al máximo.</b> Algo grande está por pasar: arranca el clímax.')
  }
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

export type MotivoSalto = 'voto' | 'auto' | 'pasar' | 'directo'

export async function saltarTurno(ctx: Ctx, pid: number, motivo: MotivoSalto): Promise<void> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  const j = jugadores.find((x) => x.id === partida.turno_jugador_id)
  if (!j || partida.estado !== 'EN_JUEGO') return
  const pj = pjDe(pjs, j)
  const nombre = pj?.ficha.nombre ?? j.nombre
  const razon = { voto: 'por decisión del grupo', auto: 'por inactividad', pasar: 'por decisión propia', directo: 'con skip directo' }[motivo]
  // Skip directo es parte del modo de juego: no cuenta para pasar a dormido.
  if (motivo === 'voto' || motivo === 'auto') {
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
  partida.mundo.confirmacion = null
  partida.paso = { tipo: 'libre' }
  ctx.db.guardarPartida(partida)
  await avanzarTurno(ctx, pid)
}

// ------------------------------------------------------------------ fuera de turno

/**
 * Alguien respondió al DJ sin ser su turno: se le avisa claro, una vez por turno.
 * Devuelve true si mandó el aviso.
 */
export async function avisarFueraDeTurno(ctx: Ctx, pid: number, userId: string, responderA?: number): Promise<boolean> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  const actual = jugadores.find((x) => x.id === partida.turno_jugador_id)
  if (!actual || partida.estado !== 'EN_JUEGO') return false
  const avisos = partida.mundo.avisos?.turno === partida.turno_n ? partida.mundo.avisos : { turno: partida.turno_n, ids: [] as string[] }
  if (avisos.ids.includes(userId)) return false
  avisos.ids.push(userId)
  partida.mundo.avisos = avisos
  ctx.db.guardarPartida(partida)
  const pj = pjDe(pjs, actual)
  const extra = partida.config.plazoH === -1 ? ' Si tarda mucho, /saltear pasa el turno al toque.' : ' Mientras, podés charlar tu idea con el grupo.'
  await aGrupo(ctx, partida, `✋ <b>Esperá tu turno</b>: ahora juega <b>${esc(actual.nombre)}</b>${pj ? ` (${esc(pj.ficha.nombre)})` : ''}.${extra}`, { responderA })
  return true
}

// ------------------------------------------------------------------ acciones libres

export async function procesarAccion(ctx: Ctx, pid: number, userId: string, textoCrudo: string, responderA?: number): Promise<void> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  const j = jugadores.find((x) => x.user_id === userId)
  if (!j || partida.estado !== 'EN_JUEGO') return
  const enCombate = !!partida.mundo.combate
  const aceptaTexto = partida.paso.tipo === 'esperando_libre' || (partida.paso.tipo === 'esperando_accion' && !enCombate)
  if (partida.turno_jugador_id !== j.id) {
    await avisarFueraDeTurno(ctx, pid, userId, responderA)
    return
  }
  if (!aceptaTexto) {
    if (enCombate && partida.paso.tipo === 'esperando_accion') {
      await aGrupo(ctx, partida, '⚔️ En combate elegí una acción con los botones (o tocá <b>💬 Acción libre</b>).', { responderA: partida.turno_msg_id ?? undefined })
    }
    return
  }
  const texto = recortar(textoCrudo.replace(/[<>]/g, ' ').replace(/\s+/g, ' '), MAX_ACCION)
  if (!texto) return
  const pj = pjDe(pjs, j)
  if (!pj) {
    if (!enCombate && esCoNarrador(ctx, j)) return sugerenciaCoNarrador(ctx, pid, j, texto)
    return
  }

  // Acción libre en combate: si es un ataque (aunque sea creativo), hay tirada y daño de verdad.
  if (enCombate) return accionLibreCombate(ctx, pid, j, pj, pjs, texto, responderA)

  // Acciones drásticas: el motor decide el flujo (confirmar, tirar, convencer); la IA solo narra.
  const intencion: Intencion = await clasificarIntencion(ctx, partida, pj, texto)
  if (intencion.tipo === 'matar') {
    const objetivoPj = intencion.objetivo ? buscarPj(pjs.filter((x) => x.id !== pj.id), intencion.objetivo) : undefined
    if (objetivoPj && !partida.config.pvp) {
      await aGrupo(ctx, partida, `🗡️ En esta partida los personajes no se atacan entre sí. El anfitrión puede habilitar las traiciones con /config. ${mencion(j)}, contá otra acción.`, { responderA })
      return
    }
  }
  registrar(ctx, partida, j.id, 'accion', `${pj.ficha.nombre}: ${texto}`)
  partida.paso = { tipo: 'narrando', accion: texto, jugadorId: j.id, intencion }
  ctx.db.guardarPartida(partida)
  switch (intencion.tipo) {
    case 'muerte_propia':
      if (partida.config.letalidad === 'suave') {
        return narrarAccion(ctx, pid, j, pj, texto, undefined, { extra: `En esta mesa (letalidad suave) los personajes no mueren: el intento de ${pj.ficha.nombre} no termina en muerte (lo frenan, falla o sobrevive con secuelas). Narralo con peso.` })
      }
      return pedirConfirmacion(ctx, pid, j, pj, 'muerte')
    case 'matar':
      return intentoDeMatar(ctx, pid, j, pj, texto, intencion)
    case 'abandonar':
      return narrarAccion(ctx, pid, j, pj, texto, undefined, { extra: INSTRUCCION_CONVENCER(pj.ficha.nombre), convencer: true, intencion })
    default:
      return narrarAccion(ctx, pid, j, pj, texto, undefined, { intencion })
  }
}

/** Un co-narrador (jugador sin personaje) sugiere algo del mundo; el DJ lo usa como inspiración. */
async function sugerenciaCoNarrador(ctx: Ctx, pid: number, j: Jugador, texto: string): Promise<void> {
  const partida = ctx.db.partida(pid)!
  const pj = ctx.db.ultimoPersonajeDe(j.id)!
  registrar(ctx, partida, j.id, 'accion', `🎙️ ${j.nombre} (voz del mundo) sugiere: ${texto}`)
  partida.paso = { tipo: 'narrando', accion: texto, jugadorId: j.id }
  ctx.db.guardarPartida(partida)
  await narrarAccion(ctx, pid, j, pj, texto, undefined, { extra: INSTRUCCION_CO_NARRADOR(j.nombre), coNarrador: true })
}

/** Acción libre en medio de un combate. */
async function accionLibreCombate(ctx: Ctx, pid: number, j: Jugador, pj: Personaje, pjs: Personaje[], texto: string, responderA?: number): Promise<void> {
  const partida = ctx.db.partida(pid)!
  const c = partida.mundo.combate!
  const it = await clasificarAccionCombate(ctx, partida, pj, pjs, texto)
  if ((it.tipo === 'ataque' || it.tipo === 'traicion') && it.prueba) {
    const obj = (it.objetivo ?? '').toLowerCase()
    const otroPj = obj ? pjs.find((x) => x.id !== pj.id && x.vivo && (x.ficha.nombre.toLowerCase().includes(obj) || obj.includes(x.ficha.nombre.toLowerCase()))) : undefined
    if (otroPj || it.tipo === 'traicion') {
      if (!partida.config.pvp || !otroPj) {
        await aGrupo(ctx, partida, `🗡️ ${otroPj ? 'En esta partida los personajes no se atacan entre sí' : 'No queda claro a qué compañero atacás'}.${!partida.config.pvp ? ' El anfitrión puede habilitar las traiciones con /config.' : ''} ${mencion(j)}, contá otra acción.`, { responderA })
        return
      }
      it.blanco = { tipo: 'pj', id: otroPj.id }
      it.objetivo = otroPj.ficha.nombre
    } else {
      const enemigos = vivos(c)
      const e = enemigos.find((x) => obj && (x.nombre.toLowerCase().includes(obj) || obj.includes(x.nombre.toLowerCase()))) ?? enemigos[0]
      if (!e) return narrarAccion(ctx, pid, j, pj, texto, undefined, {})
      it.blanco = { tipo: 'enemigo', uid: e.uid }
      it.objetivo = e.nombre
    }
    registrar(ctx, partida, j.id, 'accion', `${pj.ficha.nombre}: ${texto}`)
    partida.paso = { tipo: 'narrando', accion: texto, jugadorId: j.id, intencion: it }
    ctx.db.guardarPartida(partida)
    const preambulo = `${pj.ficha.nombre} va por ${it.objetivo}.`
    return pedirTirada(ctx, pid, j, pj, texto, preambulo, it.prueba, it)
  }
  registrar(ctx, partida, j.id, 'accion', `${pj.ficha.nombre}: ${texto}`)
  partida.paso = { tipo: 'narrando', accion: texto, jugadorId: j.id, intencion: it }
  ctx.db.guardarPartida(partida)
  if (it.tipo === 'muerte_propia') {
    if (partida.config.letalidad === 'suave') return narrarAccion(ctx, pid, j, pj, texto, undefined, { extra: `En esta mesa (letalidad suave) los personajes no mueren: el intento de ${pj.ficha.nombre} no termina en muerte.` })
    return pedirConfirmacion(ctx, pid, j, pj, 'muerte')
  }
  return narrarAccion(ctx, pid, j, pj, texto, undefined, { intencion: it })
}

interface OpNarrar {
  extra?: string
  msgTirada?: number
  intencion?: Intencion
  /** La narración es un intento de convencer: no cierra el turno, pide confirmación. */
  convencer?: boolean
  /** Turno de un jugador sin personaje (voz del mundo). */
  coNarrador?: boolean
  notas?: string[]
}

async function narrarAccion(ctx: Ctx, pid: number, j: Jugador, pj: Personaje, texto: string, tirada: TiradaResuelta | undefined, op: OpNarrar = {}): Promise<void> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  await ctx.api.escribiendo(partida.chat_id, partida.thread_id)
  let usuario = op.coNarrador ? `<sugerencia de="${j.nombre}">${texto}</sugerencia>` : `<accion jugador="${pj.ficha.nombre} (${claveJugador(pj)})">${texto}</accion>`
  if (tirada) usuario += `\n<resultado_tirada>${resumenTirada(ctx, pj, tirada)}</resultado_tirada>\nNarrá exactamente ese resultado y cerrá el turno con "narrar".`
  const ritmo = ritmoDe(partida, jugadores.filter((x) => x.estado === 'activo').length)
  const desenlace = !!ritmo.cierrePendiente && !partida.mundo.combate && !op.convencer
  const extras: string[] = []
  if (partida.mundo.combate) extras.push('COMBATE en curso: los golpes los resuelve el motor. Esta es una acción libre no estándar; narrala y proponé su efecto sin inventar daño.')
  if (desenlace) extras.push(esCapituloFinal(partida) ? INSTRUCCION_DESENLACE_FINAL : INSTRUCCION_DESENLACE)
  if (op.intencion?.tipo === 'matar' && tirada) extras.push(INSTRUCCION_MATAR(op.intencion.objetivo || 'el objetivo', tirada.exito))
  if (op.extra) extras.push(op.extra)
  try {
    const d = await decidirTurno(ctx, partida, pjs, jugadores, { tarea: 'turno', usuario, turnoPj: op.coNarrador ? undefined : pj, forzarNarrar: !!tirada || desenlace || !!op.extra, extra: extras.join('\n') || undefined })
    if (d.tipo === 'tirada') {
      await pedirTirada(ctx, pid, j, pj, texto, d.preambulo, d.pedido, op.intencion)
    } else if (op.convencer) {
      await mostrarConvencimiento(ctx, pid, j, pj, d.salida)
    } else {
      await cerrarTurnoConNarracion(ctx, pid, j, pj, d.salida, tirada, { msgTirada: op.msgTirada, intencion: op.intencion, notas: op.notas })
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
  const convencer = paso.intencion?.tipo === 'abandonar' && !paso.tirada
  await narrarAccion(ctx, pid, j, pj, paso.accion, paso.tirada, { msgTirada: paso.msgTirada, intencion: paso.intencion, convencer, extra: convencer ? INSTRUCCION_CONVENCER(pj.ficha.nombre) : undefined })
}

function resumenTirada(ctx: Ctx, pj: Personaje, t: TiradaResuelta): string {
  const h = ctx.u.habilidades.find((x) => x.id === t.pedido.habilidad)
  return `${pj.ficha.nombre} intentó: ${t.pedido.motivo}. ${t.pedido.atributo}+${h?.nombre ?? t.pedido.habilidad} TN ${t.tn}, dificultad ${t.pedido.dificultad}. Dados ${t.dados.join(', ')} → ${t.exitos} éxito(s)${t.criticos ? ` (${t.criticos} crítico)` : ''}. ${t.exito ? 'ÉXITO' : 'FRACASO'}${t.impulso ? ` con ${t.impulso} de impulso` : ''}${t.complicaciones ? '. COMPLICACIÓN (sacó 20): agregá un giro' : ''}.`
}

// ------------------------------------------------------------------ tiradas

async function pedirTirada(ctx: Ctx, pid: number, j: Jugador, pj: Personaje, accion: string, preambulo: string, pedido: PedidoTirada, intencion?: Intencion): Promise<void> {
  const partida = ctx.db.partida(pid)!
  if (!ctx.u.habilidades.some((h) => h.id === pedido.habilidad)) pedido.habilidad = 'supervivencia'
  partida.paso = { tipo: 'esperando_tirada', accion, jugadorId: j.id, pedido, intencion }
  ctx.db.guardarPartida(partida)
  const tn = tnDe(pj, pedido.atributo, pedido.habilidad)
  const texto = tarjetaTiradaTexto(ctx, pj, preambulo, pedido.habilidad, tn, pedido.dificultad, pedido.motivo)
  await aGrupo(ctx, partida, `${texto}\n\n${mencion(j)}, tocá el botón para tirar.`, { teclado: tecladoTiradaBotones(pid, partida.turno_n, pj, partida.mundo.impulso) })
}

/** Matar nunca es inmediato: el motor arma la tirada con el arma del personaje y decide el azar. */
async function intentoDeMatar(ctx: Ctx, pid: number, j: Jugador, pj: Personaje, accion: string, intencion: Intencion): Promise<void> {
  const arma = armaPrincipal(pj, ctx.u)
  const hab = ctx.u.habilidades.find((h) => h.id === arma.habilidad) ?? ctx.u.habilidades.find((h) => h.id === 'armas_pequenas')!
  const objetivo = intencion.objetivo || 'su objetivo'
  const pedido: PedidoTirada = { atributo: hab.attr, habilidad: hab.id, dificultad: 2, motivo: `Matar a ${objetivo}` }
  const preambulo = `${pj.ficha.nombre} va por ${objetivo}. Un segundo de silencio antes de que todo se decida.`
  await pedirTirada(ctx, pid, j, pj, accion, preambulo, pedido, intencion)
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

  const rango = pj.ficha.habilidades[t.pedido.habilidad] ?? 0
  const esp = pj.ficha.especialidades.includes(t.pedido.habilidad)
  const resultado = resultadoTiradaTexto(t, rango, esp)
  let msgTirada = mensajeId
  if (mensajeId) {
    const previo = tarjetaTiradaTexto(ctx, pj, '', t.pedido.habilidad, t.tn, t.pedido.dificultad, t.pedido.motivo, t.dados.length)
    await ctx.api.editar(partida.chat_id, mensajeId, `${previo}\n\n${resultado}`, [])
  } else {
    msgTirada = await aGrupo(ctx, partida, resultado)
  }
  partida.paso = { tipo: 'narrando', accion: paso.accion, jugadorId: j.id, tirada: t, msgTirada, intencion: paso.intencion }
  // Acción libre de ataque en combate: el motor aplica el golpe con esta tirada.
  const it = paso.intencion
  const c = partida.mundo.combate
  if (it?.tipo === 'ataque' || it?.tipo === 'traicion') {
    const blancoE = it.blanco?.tipo === 'enemigo' && c ? vivos(c).find((e) => e.uid === (it.blanco as { uid: string }).uid) : undefined
    const blancoP = it.blanco?.tipo === 'pj' ? pjs.find((x) => x.id === (it.blanco as { id: number }).id) : undefined
    if (c && (blancoE || blancoP)) {
      const r = golpeCreativo(ctx.u, pj, t, blancoE ? { tipo: 'enemigo', e: blancoE } : { tipo: 'pj', pj: blancoP! })
      c.log.push(r.linea)
      if (blancoP) {
        ctx.db.guardarPersonaje(blancoP)
        partida.mundo.decisiones = [...(partida.mundo.decisiones ?? []), `${pj.ficha.nombre} atacó a ${blancoP.ficha.nombre} en pleno combate`].slice(-8)
      }
      ctx.db.guardarPartida(partida)
      await aGrupo(ctx, partida, esc(r.linea), { responderA: msgTirada })
      await narrarAccion(ctx, pid, j, pj, paso.accion, t, { msgTirada, intencion: it, extra: INSTRUCCION_GOLPE(r.linea) })
      return
    }
  }
  ctx.db.guardarPartida(partida)
  await narrarAccion(ctx, pid, j, pj, paso.accion, t, { msgTirada, intencion: paso.intencion })
}

// ------------------------------------------------------------------ decisiones que se confirman (muerte, abandono)

type Veredicto = { tipo: 'aplicar'; pj: Personaje } | { tipo: 'confirmar'; pj: Personaje } | { tipo: 'rechazar'; nota?: string }

/** Decide qué hacer con una muerte propuesta por el DJ fuera de combate. */
function evaluarMuerte(partida: Partida, pjs: Personaje[], actor: Personaje, salida: SalidaNarrar, tirada: TiradaResuelta | undefined, confirmada: boolean): Veredicto {
  const m = salida.cambios?.muerte
  if (!m || partida.mundo.combate) return { tipo: 'rechazar' }
  const objetivo = buscarPj(pjs, String(m.pj ?? ''))
  if (!objetivo || !objetivo.vivo) return { tipo: 'rechazar' }
  if (partida.config.letalidad === 'suave') return { tipo: 'rechazar', nota: 'En letalidad suave nadie muere: queda con secuelas.' }
  if (objetivo.id === actor.id) {
    if (m.elegida) return confirmada ? { tipo: 'aplicar', pj: objetivo } : { tipo: 'confirmar', pj: objetivo }
    return tirada && !tirada.exito ? { tipo: 'aplicar', pj: objetivo } : { tipo: 'rechazar' }
  }
  // Matar a otro personaje: solo con traiciones habilitadas y una tirada de por medio.
  return partida.config.pvp && tirada && tirada.exito ? { tipo: 'aplicar', pj: objetivo } : { tipo: 'rechazar' }
}

async function morir(ctx: Ctx, partida: Partida, pj: Personaje, motivo: string): Promise<string> {
  pj.vivo = false
  pj.condiciones = pj.condiciones.filter((c) => c !== 'caido')
  ctx.db.guardarPersonaje(pj)
  registrar(ctx, partida, pj.jugador_id, 'sistema', `${pj.ficha.nombre} murió${motivo ? ` (${motivo})` : ''}.`, `${pj.ficha.nombre} murió.`)
  const j = ctx.db.jugador(pj.jugador_id)
  if (j) await avisarMuerte(ctx, partida, j, pj)
  return `☠️ ${pj.ficha.nombre} murió`
}

/** Al jugador de un personaje muerto: botón para crear otro. */
export async function avisarMuerte(ctx: Ctx, partida: Partida, j: Jugador, pj: Personaje): Promise<void> {
  await aPrivado(ctx, partida, j, `☠️ <b>${esc(pj.ficha.nombre)}</b> murió. Si querés seguir jugando, armá otro personaje: el DJ lo mete en la próxima escena.`, [[{ text: '🧑‍🚀 Crear otro personaje', url: urlUnirse(ctx, partida.id) }]])
}

/** El personaje deja el grupo para siempre (no muere): sale de la historia y el jugador puede crear otro. */
async function retirar(ctx: Ctx, partida: Partida, pj: Personaje): Promise<string> {
  pj.vivo = false
  pj.condiciones = ['se fue']
  ctx.db.guardarPersonaje(pj)
  registrar(ctx, partida, pj.jugador_id, 'sistema', `${pj.ficha.nombre} dejó el grupo.`, `${pj.ficha.nombre} dejó el grupo para siempre.`)
  partida.mundo.decisiones = [...(partida.mundo.decisiones ?? []), `${pj.ficha.nombre} abandonó el grupo`].slice(-8)
  const j = ctx.db.jugador(pj.jugador_id)
  if (j) await aPrivado(ctx, partida, j, `🚪 <b>${esc(pj.ficha.nombre)}</b> dejó el grupo. Si querés seguir jugando, armá otro personaje: el DJ lo mete en la próxima escena.`, [[{ text: '🧑‍🚀 Crear otro personaje', url: urlUnirse(ctx, partida.id) }]])
  return `🚪 ${pj.ficha.nombre} deja el grupo`
}

async function pedirConfirmacion(ctx: Ctx, pid: number, j: Jugador, pj: Personaje, que: 'muerte' | 'abandono', salida?: SalidaNarrar): Promise<void> {
  const partida = ctx.db.partida(pid)!
  const accion = partida.paso.tipo === 'narrando' ? partida.paso.accion : ''
  partida.mundo.confirmacion = { que, pjId: pj.id, jugadorId: j.id, accion, salida }
  partida.paso = { tipo: 'confirmando', jugadorId: j.id, que }
  ctx.db.guardarPartida(partida)
  if (que === 'muerte') {
    await aGrupo(ctx, partida, `☠️ ${mencion(j)}, <b>esto mata a ${esc(pj.ficha.nombre)} de verdad</b>. No hay vuelta atrás. ¿Confirmás?`, { teclado: tecladoMuerte(pid, partida.turno_n, pj.ficha.nombre) })
  } else {
    await aGrupo(ctx, partida, `🚪 ${mencion(j)}, ¿<b>${esc(pj.ficha.nombre)}</b> se va igual?`, { teclado: tecladoAbandono(pid, partida.turno_n) })
  }
}

/** El DJ intentó convencer al que se quiere ir: se muestra y el jugador decide con botones. */
async function mostrarConvencimiento(ctx: Ctx, pid: number, j: Jugador, pj: Personaje, salida: SalidaNarrar): Promise<void> {
  const partida = ctx.db.partida(pid)!
  registrar(ctx, partida, j.id, 'narracion', salida.narracion, salida.cronica || `Intentan convencer a ${pj.ficha.nombre} de quedarse.`)
  await aGrupo(ctx, partida, `🎲 <i>${textoIA(salida.narracion)}</i>`)
  await pedirConfirmacion(ctx, pid, j, pj, 'abandono')
}

/** Botones de confirmación (muerte o abandono). */
export async function confirmarDecision(ctx: Ctx, pid: number, userId: string, turnoN: number, si: boolean): Promise<string | void> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  const pend = partida.mundo.confirmacion
  if (!pend || partida.paso.tipo !== 'confirmando' || partida.turno_n !== turnoN) return 'Esa decisión ya no está pendiente.'
  const j = jugadores.find((x) => x.id === pend.jugadorId)
  if (!j || j.user_id !== userId) return 'Esa decisión es de otra persona.'
  const pj = pjs.find((x) => x.id === pend.pjId)
  if (!pj) return
  partida.mundo.confirmacion = null
  partida.paso = { tipo: 'narrando', accion: pend.accion, jugadorId: j.id }
  ctx.db.guardarPartida(partida)
  const nombre = pj.ficha.nombre
  if (pend.que === 'muerte' && pend.salida) {
    // Muerte que propuso el DJ en su narración: se muestra tal cual si confirma.
    if (si) return cerrarTurnoConNarracion(ctx, pid, j, pj, pend.salida as SalidaNarrar, undefined, { muerteConfirmada: true })
    return narrarAccion(ctx, pid, j, pj, pend.accion, undefined, { extra: INSTRUCCION_MUERTE_ARREPENTIDA(nombre) })
  }
  if (pend.que === 'muerte') {
    if (!si) return narrarAccion(ctx, pid, j, pj, pend.accion, undefined, { extra: INSTRUCCION_MUERTE_ARREPENTIDA(nombre) })
    const nota = await morir(ctx, partida, pj, 'decisión propia')
    ctx.db.guardarPartida(partida)
    return narrarAccion(ctx, pid, j, pj, pend.accion, undefined, { extra: INSTRUCCION_MUERTE_CONFIRMADA(nombre), notas: [nota] })
  }
  // Abandono
  if (!si) return narrarAccion(ctx, pid, j, pj, pend.accion, undefined, { extra: INSTRUCCION_SE_QUEDA(nombre) })
  const nota = await retirar(ctx, partida, pj)
  ctx.db.guardarPartida(partida)
  ajustarRitmo(ctx, pid)
  return narrarAccion(ctx, pid, j, pj, pend.accion, undefined, { extra: INSTRUCCION_SE_VA(nombre), notas: [nota] })
}

// ------------------------------------------------------------------ cierre de turno

export async function cerrarTurnoConNarracion(
  ctx: Ctx, pid: number, j: Jugador, pj: Personaje, salida: SalidaNarrar, tirada?: TiradaResuelta,
  op: { muerteConfirmada?: boolean; msgTirada?: number; intencion?: Intencion; notas?: string[] } = {},
): Promise<void> {
  const { partida, pjs, jugadores } = cargar(ctx, pid)
  const enCombate = !!partida.mundo.combate

  // Muerte elegida que propuso el DJ: antes de mostrar nada, el jugador confirma.
  const veredicto = evaluarMuerte(partida, pjs, pj, salida, tirada, !!op.muerteConfirmada)
  if (veredicto.tipo === 'confirmar') {
    await pedirConfirmacion(ctx, pid, j, veredicto.pj, 'muerte', salida)
    return
  }

  // Intento de matar: el azar manda. Si la tirada falló, nadie muere; si salió, el objetivo muere aunque la IA no lo marque.
  const notasMatar: string[] = []
  if (op.intencion?.tipo === 'matar' && tirada) {
    const obj = op.intencion.objetivo ?? ''
    if (!tirada.exito) {
      if (salida.cambios?.npcs) salida.cambios.npcs = salida.cambios.npcs.map((n) => (n.estado === 'muerto' ? { ...n, estado: 'herido' as const } : n))
      if (salida.cambios?.muerte) delete salida.cambios.muerte
    } else if (obj) {
      const npc = partida.mundo.npcs.find((n) => n.nombre.toLowerCase() === obj.toLowerCase() || n.id === obj.toLowerCase())
      const otroPj = buscarPj(pjs.filter((x) => x.id !== pj.id), obj)
      if (otroPj && partida.config.pvp && partida.config.letalidad !== 'suave' && otroPj.vivo) notasMatar.push(await morir(ctx, partida, otroPj, `a manos de ${pj.ficha.nombre}`))
      else if (npc && !esNpcMuerto(partida.mundo, npc.nombre)) {
        const r = { aplicados: [] as string[] }
        marcarNpcMuerto(partida.mundo, npc.nombre, r)
        notasMatar.push(...r.aplicados)
      }
    }
  }

  const ritmo = ritmoDe(partida, jugadores.filter((x) => x.estado === 'activo').length)
  const eraDesenlace = !!ritmo.cierrePendiente && !enCombate

  const res = aplicarCambios(ctx.u, partida.mundo, pjs, salida.cambios, { enCombate })
  const notas = [...(op.notas ?? []), ...notasMatar, ...res.aplicados]
  if (veredicto.tipo === 'aplicar') notas.push(await morir(ctx, partida, veredicto.pj, salida.cambios?.muerte?.motivo ?? ''))
  else if (veredicto.nota) notas.push(veredicto.nota)
  if (res.caidos.length) notas.push(...res.caidos.map((n) => `🩸 ${n} queda CAÍDO`))
  if (res.relojesLlenos.length) notas.push('⚠️ La tensión llegó al máximo')
  // Fuera de combate, un caído se resuelve al final del turno según la letalidad.
  if (!enCombate) {
    const caidos = pjs.filter((p) => p.vivo && esCaido(p))
    if (caidos.length) {
      const lineas = resolverCaidos(caidos, partida.config.letalidad, ctx.rng)
      notas.push(...lineas)
      for (const p of caidos) if (!p.vivo) {
        registrar(ctx, partida, p.jugador_id, 'sistema', `${p.ficha.nombre} murió.`, `${p.ficha.nombre} murió.`)
        const jj = ctx.db.jugador(p.jugador_id)
        if (jj) await avisarMuerte(ctx, partida, jj, p)
      }
    }
  }
  for (const p of pjs) ctx.db.guardarPersonaje(p)
  if (res.relojesLlenos.some((n) => n === partida.mundo.relojes.find((r) => r.id === 'amenaza')?.nombre)) forzarClimax(ritmo)

  const cronica = salida.cronica || `${pj.ficha.nombre}: ${recortar(salida.narracion, 90)}`
  registrar(ctx, partida, j.id, 'narracion', salida.narracion, cronica)
  // En combate, una acción libre cuenta como la acción de la ronda.
  if (enCombate && partida.mundo.combate) {
    const c = partida.mundo.combate
    c.log.push(`${pj.ficha.nombre}: ${cronica}`)
    if (!c.orden.includes(j.id)) c.orden.push(j.id)
  }
  j.foco += 1
  j.saltos_seguidos = 0
  ctx.db.guardarJugador(j)

  // Evento obligatorio: si la narración cambió algo, ocurrió; si no, queda pendiente.
  const cambioAlgo = res.aplicados.length > 0 || res.internos.length > 0 || notasMatar.length > 0 || !!salida.combate || veredicto.tipo === 'aplicar'
  if (ritmo.eventoPendiente && cambioAlgo) {
    ritmo.eventoPendiente = undefined
    ritmo.proximoEvento = ritmo.turnos + 1 + intervaloEvento(ritmo.objetivo)
  }
  // Traición: queda como hecho y la consecuencia llega en la escena siguiente.
  if (op.intencion?.tipo === 'traicion') {
    const obj = op.intencion.objetivo ?? ''
    partida.mundo.decisiones = [...(partida.mundo.decisiones ?? []), `${pj.ficha.nombre} traicionó al grupo${obj ? ` y se pasó a ${obj}` : ''}`].slice(-8)
    ritmo.eventoPendiente = INSTRUCCION_TRAICION(pj.ficha.nombre, obj)
    ritmo.proximoEvento = ritmo.turnos + 1 + intervaloEvento(ritmo.objetivo)
    notas.push(`🗡️ ${pj.ficha.nombre} traicionó al grupo`)
  }
  registrarTurno(ritmo)
  if (!ritmo.eventoPendiente && !ritmo.cierrePendiente && ritmo.turnos >= ritmo.proximoEvento) {
    await programarEvento(ctx, partida)
  }
  partida.mundo.ideas = !enCombate && salida.sugerencias.length ? salida.sugerencias : []

  // ¿Se cierra el capítulo con este turno?
  const cierraCapitulo = eraDesenlace || (!!salida.cerrar_capitulo && !enCombate && puedeCerrarAntes(ritmo))
  const empiezaCombate = !!salida.combate && !enCombate

  const l: string[] = [`🎲 <i>${textoIA(salida.narracion)}</i>`]
  if (notas.length) l.push('', '📋 ' + notas.map(esc).join(' · '))
  if (!cierraCapitulo && !empiezaCombate && !enCombate) {
    const vivosIds = new Set(ctx.db.personajesVivos(pid).map((p) => p.jugador_id))
    const prox = siguienteJugador(jugadores, partida.turno_jugador_id, (x) => vivosIds.has(x.id))
    if (prox) l.push('', `👉 Ahora le toca a <b>${esc(prox.jugador.nombre)}</b>`)
  }
  await aGrupo(ctx, partida, l.join('\n'), { responderA: op.msgTirada })

  partida.paso = { tipo: 'libre' }
  partida.mundo.senalX = false
  ctx.db.guardarPartida(partida)

  // Una acción libre terminó el combate (rendición, huida, tregua).
  if (enCombate && salida.terminar_combate) {
    const { cerrarCombate } = await import('./combate.js')
    await cerrarCombate(ctx, pid, 'tregua')
    return
  }

  // Combate nuevo: el motor toma el control (el cierre de capítulo espera a que termine).
  if (empiezaCombate) {
    // Los NPC muertos no vuelven a aparecer como enemigos.
    const enemigos = salida.combate!.enemigos.filter((e) => !(e.nombre && esNpcMuerto(partida.mundo, e.nombre)))
    const c = crearCombate(ctx.u, enemigos, salida.combate!.sorpresa ?? 'ninguna')
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

  if (cierraCapitulo) {
    await cerrarCapitulo(ctx, pid)
    if (ctx.db.partida(pid)!.estado === 'FINALIZADA') return
  }
  await avanzarTurno(ctx, pid)
}

/** Sortea el próximo evento obligatorio con material del guion. */
async function programarEvento(ctx: Ctx, partida: Partida): Promise<void> {
  const r = partida.mundo.ritmo!
  const g = partida.guion
  const ev = sortearEvento({
    encuentros: g?.encuentros ?? [],
    bestiario: ctx.u.bestiario.filter((b) => !['civil', 'guardia', 'jefe'].includes(b.id)).map((b) => b.id),
    npcs: (g?.npcs ?? []).filter((n) => !(partida.mundo.muertos ?? []).some((m) => m.toLowerCase() === n.nombre.toLowerCase())).map((n) => ({ nombre: n.nombre, secreto: n.secreto })),
    npcsPresentes: npcsVivos(partida.mundo).map((n) => n.nombre),
    secretos: g?.secretos ?? [],
    secretosRevelados: r.secretosRevelados,
    facciones: (g?.facciones ?? []).map((f) => ({ nombre: f.nombre, quiere: f.quiere })),
    amenaza: g?.amenaza.nombre ?? 'La amenaza',
  }, ctx.rng, faseDe(r))
  r.eventoPendiente = ev.instruccion
  if (ev.tipo === 'descubrimiento') r.secretosRevelados++
  if (ev.avanzaAmenaza) await avanzarAmenaza(ctx, partida, ev.avanzaAmenaza)
  registrar(ctx, partida, null, 'sistema', `Evento programado: ${ev.tipo}.`)
}

// ------------------------------------------------------------------ capítulos y final

export async function cerrarCapitulo(ctx: Ctx, pid: number): Promise<void> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  const cronicas = ctx.db.bitacoraDesde(pid, 0).filter((b) => b.cronica).slice(-14).map((b) => b.cronica)
  let radio = ''
  try {
    radio = await transmisionRadio(ctx, partida, cronicas)
  } catch (e) {
    ctx.log('radio falló', (e as Error).message)
  }
  const capCerrado = partida.capitulo
  if (esCapituloFinal(partida)) {
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
  const activos = jugadores.filter((j) => j.estado === 'activo').length
  partida.mundo.ritmo = ritmoNuevo(partida.config, activos, partida.mundo.ritmo?.secretosRevelados ?? 0)
  registrar(ctx, partida, null, 'sistema', `Capítulo ${capCerrado} cerrado.`, `Fin del capítulo ${capCerrado}.`)
  ctx.db.guardarPartida(partida)
  await aGrupo(ctx, partida, `📻 <b>Fin del capítulo ${capCerrado}</b>\n\n${radio ? '<i>' + textoIA(radio) + '</i>\n\n' : ''}🍀 Se recuperó la Suerte y la salud. Cada jugador puede elegir una <b>mejora</b> por privado.`, { teclado: botonPrivado(ctx, '⬆️ Elegir mi mejora') })
  for (const j of jugadores) {
    if (j.estado === 'fuera') continue
    j.mejora_pendiente = true
    ctx.db.guardarJugador(j)
    await aPrivado(ctx, partida, j, `⬆️ <b>Mejora de capítulo</b>: elegí cómo crece tu personaje.`, tecladoMejora(ctx, capCerrado))
  }
}

/** /final del anfitrión: cerrar la historia en N turnos. */
export function pedirFinal(ctx: Ctx, pid: number, turnos: number): Partida {
  const { partida, jugadores } = cargar(ctx, pid)
  const r = ritmoDe(partida, jugadores.filter((j) => j.estado === 'activo').length)
  r.tope = r.turnos + Math.max(1, turnos)
  r.finalPedido = true
  if (r.turnos >= r.tope) r.cierrePendiente = true
  ctx.db.guardarPartida(partida)
  return partida
}

/** Entró o salió gente: el objetivo del capítulo se ajusta sin perder lo jugado. */
export function ajustarRitmo(ctx: Ctx, pid: number): void {
  const { partida, jugadores } = cargar(ctx, pid)
  if (partida.estado !== 'EN_JUEGO' && partida.estado !== 'PAUSADA') return
  const r = ritmoDe(partida, 1)
  recalcularObjetivo(r, partida.config, jugadores.filter((j) => j.estado === 'activo').length)
  ctx.db.guardarPartida(partida)
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
  await fijarSolo(ctx, partida, [partida.tablero_msg_id])
  ctx.db.guardarPartida(partida)
  await aGrupo(ctx, partida, `🏁 <b>FIN DE LA AVENTURA</b>\n\n${radio ? '<i>' + textoIA(radio) + '</i>\n\n' : ''}${ep ? textoIA(ep) + '\n\n' : ''}📚 Acá va el libro de la partida.`)
  await refrescarTablero(ctx, pid)
  await enviarLibro(ctx, pid)
}

export async function enviarLibro(ctx: Ctx, pid: number): Promise<void> {
  const partida = ctx.db.partida(pid)!
  const md = exportarLibro(ctx, partida)
  const nombre = `cronicas-${(partida.guion?.titulo ?? 'partida').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.md`
  await ctx.api.documento(partida.chat_id, nombre, md, '📚 Crónicas de la partida', { threadId: partida.thread_id })
}
