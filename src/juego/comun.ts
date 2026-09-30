import type { Ctx } from '../ctx.js'
import type { Jugador, Partida, Personaje } from '../motor/tipos.js'
import type { OpcionesEnvio, Teclado } from '../telegram/api.js'
import { enSilencio } from '../motor/turnos.js'
import { tableroTexto } from '../telegram/textos.js'

export function cargar(ctx: Ctx, pid: number) {
  const partida = ctx.db.partida(pid)
  if (!partida) throw new Error(`Partida ${pid} inexistente`)
  return { partida, jugadores: ctx.db.jugadores(pid), pjs: ctx.db.personajesVivos(pid) }
}

export function silencioso(ctx: Ctx, p: Partida): boolean {
  return enSilencio(ctx.reloj.ahora(), p.config.silencio, ctx.cfg.tzMin)
}

/** Manda un mensaje al grupo de la partida (en su tema, y sin sonido en horas de silencio). */
export async function aGrupo(ctx: Ctx, p: Partida, html: string, op: OpcionesEnvio = {}): Promise<number> {
  return ctx.api.enviar(p.chat_id, html, { threadId: p.thread_id, silencioso: silencioso(ctx, p), ...op })
}

export async function aPrivado(ctx: Ctx, p: Partida | null, j: Pick<Jugador, 'dm_chat_id'>, html: string, teclado?: Teclado): Promise<boolean> {
  if (!j.dm_chat_id) return false
  try {
    await ctx.api.enviar(j.dm_chat_id, html, { teclado, silencioso: p ? silencioso(ctx, p) : false })
    return true
  } catch (e) {
    ctx.log('No pude escribirle por privado:', (e as Error).message)
    return false
  }
}

export function registrar(ctx: Ctx, p: Partida, jugadorId: number | null, tipo: string, texto: string, cronica = ''): number {
  return ctx.db.agregarBitacora(p.id, p.ronda, jugadorId, tipo, texto, cronica, ctx.reloj.ahora())
}

export function urlUnirse(ctx: Ctx, pid: number): string {
  return `https://t.me/${ctx.botUsername}?start=u_${pid}`
}

export async function refrescarTablero(ctx: Ctx, pid: number): Promise<void> {
  const partida = ctx.db.partida(pid)
  if (!partida) return
  const jugadores = ctx.db.jugadores(pid)
  const pjs = ctx.db.personajesVivos(pid)
  const texto = tableroTexto(ctx, partida, jugadores, pjs)
  let teclado: Teclado | undefined
  if (partida.estado === 'CREANDO') {
    teclado = [
      [{ text: '🧑‍🚀 Crear mi personaje', url: urlUnirse(ctx, pid) }],
      [{ text: '▶️ Empezar la aventura (anfitrión)', callback_data: `b:${pid}:empezar` }],
    ]
  } else if (partida.estado === 'EN_JUEGO' || partida.estado === 'PAUSADA') {
    teclado = [[{ text: '➕ Sumarme a la partida', url: urlUnirse(ctx, pid) }]]
  }
  if (partida.tablero_msg_id) {
    try {
      await ctx.api.editar(partida.chat_id, partida.tablero_msg_id, texto, teclado ?? [])
      return
    } catch {
      /* el tablero pudo haberse borrado: mandamos uno nuevo */
    }
  }
  const id = await ctx.api.enviar(partida.chat_id, texto, { teclado, threadId: partida.thread_id, silencioso: true })
  partida.tablero_msg_id = id
  ctx.db.guardarPartida(partida)
  await ctx.api.fijar(partida.chat_id, id)
}

export function pjDe(pjs: Personaje[], j: Jugador): Personaje | undefined {
  return pjs.find((p) => p.jugador_id === j.id)
}

export function palabras(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length
}
