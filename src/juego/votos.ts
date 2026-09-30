import type { Ctx } from '../ctx.js'
import type { Votacion } from '../db/repos.js'
import { evaluarVotacion } from '../motor/votaciones.js'
import { SIN_LIMITE } from '../motor/turnos.js'
import { esc, formatoDuracion } from '../util.js'
import { tecladoVoto } from '../telegram/teclados.js'
import { mencion } from '../telegram/textos.js'
import { aGrupo, cargar, pjDe } from './comun.js'
import { saltarTurno } from './turno.js'

const H = 3_600_000
const CIERRE_H = 6

function votantes(ctx: Ctx, pid: number, objetivoId: number) {
  return ctx.db.jugadores(pid).filter((j) => (j.estado === 'activo' || j.estado === 'listo') && j.id !== objetivoId)
}

export async function proponerSaltear(ctx: Ctx, pid: number, userId: string): Promise<string | void> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  if (partida.estado !== 'EN_JUEGO' || !partida.turno_jugador_id) return 'No hay un turno en curso.'
  const solicitante = jugadores.find((j) => j.user_id === userId && j.estado !== 'fuera')
  if (!solicitante) return 'Solo jugadores de la partida pueden proponerlo.'
  const objetivo = jugadores.find((j) => j.id === partida.turno_jugador_id)!
  if (objetivo.id === solicitante.id) return 'Si no vas a poder jugar, usá /pasar o /ausente.'
  if (partida.paso.tipo === 'narrando') return 'El DJ está narrando: esperá un segundo.'
  if (ctx.db.votacionAbierta(pid)) return 'Ya hay una votación abierta.'
  const ahora = ctx.reloj.ahora()
  const skip = partida.config.plazoH === -1
  const vence = partida.turno_vence === SIN_LIMITE ? partida.turno_desde + 48 * H : partida.turno_vence
  // Skip directo: no hay que esperar a que venza el turno (pero se vota igual).
  if (!skip && ahora < vence) return `Todavía no venció el turno (vence en ${formatoDuracion(vence - ahora)}).`

  const vs = votantes(ctx, pid, objetivo.id)
  // Con menos de 3 jugadores no hay votación que valga: se saltea directo.
  if (vs.length < 2) {
    await saltarTurno(ctx, pid, skip ? 'directo' : 'voto')
    return
  }
  const v = ctx.db.crearVotacion(pid, 'saltear', objetivo.id, ahora, ahora + CIERRE_H * H)
  v.votos[userId] = 's'
  const pj = pjDe(pjs, objetivo)
  const porque = skip ? 'Skip directo: no hace falta esperar a que venza.' : `Su turno venció hace ${formatoDuracion(ahora - vence)}.`
  v.msg_id = await aGrupo(ctx, partida, `🗳️ <b>¿Salteamos el turno de ${mencion(objetivo)}${pj ? ' (' + esc(pj.ficha.nombre) + ')' : ''}?</b>\n${porque} Si vota que sí la mayoría, su personaje se queda cubriendo la retaguardia (sin riesgos ni botín). Si ${esc(objetivo.nombre)} juega antes, la votación se cancela.\nCierra en ${CIERRE_H} h.`, { teclado: tecladoVoto(v.id) })
  ctx.db.guardarVotacion(v)
  return resolver(ctx, v, false)
}

export async function votar(ctx: Ctx, vid: number, userId: string, voto: 's' | 'e'): Promise<string | void> {
  const v = ctx.db.votacion(vid)
  if (!v || v.resultado !== 'abierta') return 'Esa votación ya cerró.'
  const elegibles = votantes(ctx, v.partida_id, v.objetivo_id!)
  if (!elegibles.some((j) => j.user_id === userId)) return 'No podés votar en esta.'
  v.votos[userId] = voto
  ctx.db.guardarVotacion(v)
  return resolver(ctx, v, false)
}

/** Evalúa la votación y, si se decidió, la cierra y ejecuta el resultado. */
async function resolver(ctx: Ctx, v: Votacion, cerrada: boolean): Promise<string | void> {
  const partida = ctx.db.partida(v.partida_id)!
  const elegibles = votantes(ctx, v.partida_id, v.objetivo_id!)
  const si = elegibles.filter((j) => v.votos[j.user_id] === 's').length
  const no = elegibles.filter((j) => v.votos[j.user_id] === 'e').length
  // Quien propone cuenta como voto a favor aunque ya no sea elegible (p. ej. si cambió el estado).
  const r = evaluarVotacion(elegibles.length, si, no, cerrada)
  if (r === 'abierta') return
  v.resultado = r === 'pasa' ? 'pasa' : 'falla'
  ctx.db.guardarVotacion(v)
  if (v.msg_id) {
    await ctx.api.editar(partida.chat_id, v.msg_id, `🗳️ Votación cerrada: <b>${r === 'pasa' ? 'se saltea el turno' : 'se espera'}</b> (${si} a favor, ${no} en contra).`, [])
  }
  // Si el turno ya cambió (el afectado jugó), no hay nada que saltear.
  if (r === 'pasa' && partida.turno_jugador_id === v.objetivo_id && partida.estado === 'EN_JUEGO') {
    await saltarTurno(ctx, v.partida_id, partida.config.plazoH === -1 ? 'directo' : 'voto')
  }
}

/** Cancela votaciones abiertas cuyo objetivo ya no tiene el turno (jugó o cambió). */
export async function cancelarObsoletas(ctx: Ctx, pid: number): Promise<void> {
  const v = ctx.db.votacionAbierta(pid)
  if (!v) return
  const partida = ctx.db.partida(pid)!
  if (partida.turno_jugador_id === v.objetivo_id && partida.estado === 'EN_JUEGO') return
  v.resultado = 'cancelada'
  ctx.db.guardarVotacion(v)
  if (v.msg_id) await ctx.api.editar(partida.chat_id, v.msg_id, '🗳️ Votación cancelada: el turno ya avanzó.', [])
}

export async function cerrarVencidas(ctx: Ctx): Promise<void> {
  const ahora = ctx.reloj.ahora()
  for (const v of ctx.db.votacionesAbiertas()) {
    if (v.cierra <= ahora) await ctx.colas.correr(`p${v.partida_id}`, () => resolver(ctx, ctx.db.votacion(v.id)!, true).then(() => undefined))
  }
}
