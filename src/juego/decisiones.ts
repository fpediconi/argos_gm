import type { Ctx } from '../ctx.js'
import type { Partida } from '../motor/tipos.js'
import type { TgPollAnswer } from '../telegram/api.js'
import { esc, recortar } from '../util.js'
import { aGrupo, registrar } from './comun.js'

const H = 3_600_000
const CIERRE_H = 12
const MAX_DECISIONES = 8

/**
 * Decisiones del grupo con encuesta nativa de Telegram (/votacion).
 * El resultado queda como hecho en el estado: el DJ lo respeta y no lo arbitra.
 */
export async function iniciarVotacion(ctx: Ctx, partida: Partida, userId: string, args: string): Promise<string | void> {
  if (partida.estado !== 'EN_JUEGO' && partida.estado !== 'PAUSADA') return 'La votación se usa con la partida en juego.'
  const j = ctx.db.jugadorDeUsuario(partida.id, userId)
  if (!j || j.estado === 'fuera') return 'Solo jugadores de la partida pueden abrir una votación.'
  if (partida.mundo.votacion) return 'Ya hay una votación abierta. Se cierra cuando votan todos o con /cerrar_votacion.'
  const partes = args.split('|').map((x) => recortar(x.replace(/[<>]/g, ' ').trim(), 100)).filter(Boolean)
  const pregunta = partes.shift()
  if (!pregunta) return 'Usalo así: <code>/votacion ¿Quién lidera? | Marta | Tito</code>. Sin opciones, se vota entre los personajes.'
  let opciones = partes
  if (opciones.length === 0) opciones = ctx.db.personajesVivos(partida.id).map((p) => p.ficha.nombre)
  opciones = [...new Set(opciones)].slice(0, 10)
  if (opciones.length < 2) return 'Hacen falta al menos dos opciones: <code>/votacion pregunta | opción 1 | opción 2</code>.'
  const { messageId, pollId } = await ctx.api.encuesta(partida.chat_id, `🗳️ ${pregunta}`, opciones, { threadId: partida.thread_id })
  partida.mundo.votacion = { pollId, msgId: messageId, pregunta, opciones, votos: {}, cierra: ctx.reloj.ahora() + CIERRE_H * H, autor: userId }
  ctx.db.guardarPartida(partida)
  await aGrupo(ctx, partida, `🗳️ <b>Votación del grupo</b>: ${esc(pregunta)}\nSe cierra cuando votan todos (o con /cerrar_votacion). El resultado queda como hecho de la historia.`, { responderA: messageId })
}

function partidaDeEncuesta(ctx: Ctx, pollId: string): Partida | undefined {
  return ctx.db.partidasNoFinalizadas().find((p) => p.mundo.votacion?.pollId === pollId)
}

export async function votoEncuesta(ctx: Ctx, a: TgPollAnswer): Promise<void> {
  if (!a.user) return
  const p0 = partidaDeEncuesta(ctx, a.poll_id)
  if (!p0) return
  await ctx.colas.correr(`p${p0.id}`, async () => {
    const partida = ctx.db.partida(p0.id)!
    const v = partida.mundo.votacion
    if (!v || v.pollId !== a.poll_id) return
    const uid = String(a.user!.id)
    if (a.option_ids.length === 0) delete v.votos[uid]
    else v.votos[uid] = a.option_ids[0]
    ctx.db.guardarPartida(partida)
    const votantes = ctx.db.jugadores(partida.id).filter((j) => j.estado === 'activo')
    if (votantes.length > 0 && votantes.every((j) => v.votos[j.user_id] !== undefined)) await cerrarVotacionGrupo(ctx, partida.id)
  })
}

/** Cierra la votación abierta, anuncia el resultado y lo guarda como decisión del grupo. */
export async function cerrarVotacionGrupo(ctx: Ctx, pid: number): Promise<string | void> {
  const partida = ctx.db.partida(pid)
  const v = partida?.mundo.votacion
  if (!partida || !v) return 'No hay ninguna votación abierta.'
  await ctx.api.cerrarEncuesta(partida.chat_id, v.msgId)
  const cuenta = v.opciones.map(() => 0)
  for (const o of Object.values(v.votos)) if (o >= 0 && o < cuenta.length) cuenta[o]++
  const max = Math.max(...cuenta)
  const ganadoras = v.opciones.filter((_, i) => cuenta[i] === max)
  partida.mundo.votacion = null
  let texto: string
  if (max === 0) {
    texto = `🗳️ La votación «${esc(v.pregunta)}» se cerró sin votos: no se decidió nada.`
  } else if (ganadoras.length > 1) {
    texto = `🗳️ <b>Empate</b> en «${esc(v.pregunta)}»: ${ganadoras.map(esc).join(' / ')} (${max} voto${max === 1 ? '' : 's'} cada una). Desempaten charlando o voten de nuevo.`
  } else {
    const decision = `${v.pregunta} → ${ganadoras[0]}`
    partida.mundo.decisiones = [...(partida.mundo.decisiones ?? []), decision].slice(-MAX_DECISIONES)
    registrar(ctx, partida, null, 'sistema', `Votación: ${decision} (${max} votos).`, `El grupo decidió: ${decision}.`)
    texto = `🗳️ <b>El grupo decidió</b>: ${esc(v.pregunta)} → <b>${esc(ganadoras[0])}</b> (${max} de ${Object.keys(v.votos).length} votos). Queda como hecho de la historia.`
  }
  ctx.db.guardarPartida(partida)
  await aGrupo(ctx, partida, texto)
}

export async function cmdCerrarVotacion(ctx: Ctx, partida: Partida, userId: string): Promise<string | void> {
  const v = partida.mundo.votacion
  if (!v) return 'No hay ninguna votación abierta.'
  if (v.autor !== userId && partida.anfitrion_id !== userId) return 'Solo quien la abrió o el anfitrión pueden cerrarla.'
  return cerrarVotacionGrupo(ctx, partida.id)
}

/** Planificador: cierra votaciones del grupo vencidas. */
export async function cerrarVotacionesGrupoVencidas(ctx: Ctx): Promise<void> {
  const ahora = ctx.reloj.ahora()
  for (const p of ctx.db.partidasNoFinalizadas()) {
    if (p.mundo.votacion && p.mundo.votacion.cierra <= ahora) await ctx.colas.correr(`p${p.id}`, () => cerrarVotacionGrupo(ctx, p.id).then(() => undefined))
  }
}
