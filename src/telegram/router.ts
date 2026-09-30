import type { Ctx } from '../ctx.js'
import type { TgCallback, TgMessage, TgMyChatMember, TgUpdate, TgUser, Teclado } from './api.js'
import { AYUDA_GRUPO } from './textos.js'
import { esc } from '../util.js'
import { callbackWizard, comandoNueva, empezarPartida } from '../juego/setup.js'
import { callbackCreacion, callbackMejora, contextoDe, textoCreacion, unirse } from '../juego/creacion.js'
import { procesarAccion, reintentarNarracion, resolverTirada } from '../juego/turno.js'
import { accionCombate, elegirAliado, elegirObjetivo, elegirObjeto } from '../juego/combate.js'
import { proponerSaltear, votar } from '../juego/votos.js'
import * as info from '../juego/info.js'
import { urlUnirse } from '../juego/comun.js'
import { estadoPresupuesto } from '../dj/presupuesto.js'
import { fichaTexto, inventarioTexto } from './textos.js'

export const COMANDOS = [
  { command: 'nueva', description: 'Crear una partida en este grupo' },
  { command: 'a', description: 'Actuar en tu turno: /a lo que hacés' },
  { command: 'ficha', description: 'Ver tu personaje' },
  { command: 'inventario', description: 'Ver tu mochila' },
  { command: 'donde', description: 'Dónde estamos y qué pasa' },
  { command: 'misiones', description: 'Misiones activas' },
  { command: 'resumen', description: 'Lo que te perdiste (gratis)' },
  { command: 'radio', description: 'Resumen narrado por Radio Yermo' },
  { command: 'pasar', description: 'Ceder tu turno' },
  { command: 'saltear', description: 'Proponer saltear un turno vencido' },
  { command: 'ausente', description: 'Avisar que no vas a estar: /ausente 3d' },
  { command: 'volver', description: 'Volver de una ausencia' },
  { command: 'regla', description: 'Explicar una regla' },
  { command: 'tiradas', description: 'Últimas tiradas' },
  { command: 'x', description: 'Pedir que el DJ cambie el rumbo' },
  { command: 'costo', description: 'Gasto de IA (anfitrión)' },
  { command: 'ayuda', description: 'Cómo se juega' },
]

export async function procesarUpdate(ctx: Ctx, u: TgUpdate): Promise<void> {
  try {
    if (u.my_chat_member) await miembro(ctx, u.my_chat_member)
    else if (u.message) await mensaje(ctx, u.message)
    else if (u.callback_query) await callback(ctx, u.callback_query)
  } catch (e) {
    ctx.log('Error procesando update', u.update_id, (e as Error).stack ?? (e as Error).message)
  }
}

async function miembro(ctx: Ctx, m: TgMyChatMember): Promise<void> {
  if (m.chat.type === 'private' || m.chat.type === 'channel') return
  if (['member', 'administrator'].includes(m.new_chat_member.status) && m.new_chat_member.user.id === ctx.botId) {
    await ctx.api.enviar(String(m.chat.id), '☢️ <b>¡Buenas, sobrevivientes!</b> Soy el DJ de esta mesa de rol.\n\nPara armar una aventura de Fallout, escriban /nueva. Cada uno crea su personaje conmigo por privado y jugamos por turnos, a su ritmo.\n\n💡 Si me dan permiso de <b>fijar mensajes</b>, dejo el tablero de la partida siempre arriba.')
  }
}

function parseComando(texto: string, botUsername: string): { cmd: string; args: string } | null {
  const m = /^\/([a-zA-Z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/.exec(texto.trim())
  if (!m) return null
  if (m[2] && m[2].toLowerCase() !== botUsername.toLowerCase()) return null
  return { cmd: m[1].toLowerCase(), args: (m[3] ?? '').trim() }
}

async function mensaje(ctx: Ctx, msg: TgMessage): Promise<void> {
  if (msg.migrate_to_chat_id) {
    const p = ctx.db.partidaActivaDeChat(String(msg.chat.id))
    if (p) {
      p.chat_id = String(msg.migrate_to_chat_id)
      ctx.db.guardarPartida(p)
    }
    return
  }
  if (!msg.from || msg.from.is_bot || !msg.text) return
  const privado = msg.chat.type === 'private'
  const userId = String(msg.from.id)
  const nombre = msg.from.first_name || msg.from.username || 'Jugador'
  ctx.db.upsertUsuario(userId, nombre, msg.from.username ?? '', privado ? String(msg.chat.id) : null)
  const c = parseComando(msg.text, ctx.botUsername)
  if (c) return comando(ctx, msg, c.cmd, c.args, privado)
  if (msg.text.startsWith('/')) return // comando para otro bot
  if (privado) {
    const usado = await textoCreacion(ctx, msg.from, msg.text)
    if (!usado) await ctx.api.enviar(String(msg.chat.id), 'Para jugar, andá al grupo y respondé al mensaje del DJ en tu turno. Usá /ayuda para ver los comandos.')
    return
  }
  // Grupo: solo se procesa la respuesta a un mensaje del bot.
  const p = ctx.db.partidaActivaDeChat(String(msg.chat.id))
  if (!p || p.estado !== 'EN_JUEGO') return
  if (p.thread_id && msg.message_thread_id !== p.thread_id) return
  const r = msg.reply_to_message
  if (!r || r.from?.id !== ctx.botId) return
  const j = ctx.db.jugadorDeUsuario(p.id, userId)
  if (!j) return
  if (p.turno_jugador_id !== j.id) {
    if (r.message_id === p.turno_msg_id) {
      const actual = ctx.db.jugador(p.turno_jugador_id ?? 0)
      await ctx.api.enviar(String(msg.chat.id), `⏳ Ahora es el turno de ${esc(actual?.nombre ?? 'otro jugador')}.`, { threadId: p.thread_id, responderA: msg.message_id })
    }
    return
  }
  const texto = msg.text
  await ctx.colas.correr(`p${p.id}`, () => procesarAccion(ctx, p.id, userId, texto))
}

async function comando(ctx: Ctx, msg: TgMessage, cmd: string, args: string, privado: boolean): Promise<void> {
  const chatId = String(msg.chat.id)
  const from = msg.from as TgUser
  const userId = String(from.id)
  const resp = async (html: string, teclado?: Teclado) => {
    await ctx.api.enviar(chatId, html, { threadId: msg.message_thread_id, teclado })
  }

  if (cmd === 'start') return start(ctx, msg, args, resp)
  if (cmd === 'ayuda' || cmd === 'help') return resp(AYUDA_GRUPO)
  if (cmd === 'regla') return info.cmdRegla(ctx, args, resp)
  if (cmd === 'nueva') return comandoNueva(ctx, msg)
  if (cmd === 'estado' && userId === ctx.cfg.adminId) {
    const pres = estadoPresupuesto(ctx, null)
    const n = ctx.db.partidasNoFinalizadas().length
    return resp(`🛠️ Partidas abiertas: ${n} · gasto hoy US$ ${pres.gastoGlobal.toFixed(3)} / ${pres.topeGlobal} · fusible: ${pres.nivel}`)
  }
  if (cmd === 'mis_partidas' && privado) {
    const ps = ctx.db.partidasDeUsuario(userId)
    if (!ps.length) return resp('No estás en ninguna partida. Tocá «Crear mi personaje» en el tablero de tu grupo.')
    return resp('Tus partidas (tocá una para hablar de ella):', ps.map((p) => [{ text: `${p.guion?.titulo ?? 'Partida ' + p.id} · ${p.estado}`, callback_data: `k:${p.id}` }]))
  }

  const partida = privado ? contextoDe(ctx, userId) : ctx.db.partidaActivaDeChat(String(msg.chat.id))
  if (!partida) return resp(privado ? 'No encuentro tu partida. Tocá «Crear mi personaje» en el tablero del grupo.' : 'No hay ninguna partida en este grupo. Escriban /nueva.')
  if (!privado && partida.thread_id && msg.message_thread_id !== partida.thread_id) return

  if (cmd === 'unirse') {
    return resp('🧑‍🚀 Tocá el botón para crear tu personaje conmigo por privado:', [[{ text: 'Crear mi personaje', url: urlUnirse(ctx, partida.id) }]])
  }
  const pid = partida.id
  await ctx.colas.correr(`p${pid}`, async () => {
    const p = ctx.db.partida(pid)!
    const j = ctx.db.jugadorDeUsuario(pid, userId)
    if (cmd === 'empezar') {
      const r = await empezarPartida(ctx, pid, userId)
      if (r) await resp(r)
      return
    }
    if (!j || j.estado === 'fuera') return resp('No estás en esta partida. Usá /unirse.')
    switch (cmd) {
      case 'a': case 'accion':
        if (!args) return resp('Contame qué hace tu personaje: <code>/a abro la puerta con cuidado</code>')
        return procesarAccion(ctx, pid, userId, args)
      case 'tirar': return resp('Cuando haya una prueba pendiente, tocá el botón 🎲 Tirar en el mensaje del DJ.')
      case 'ficha': return info.cmdFicha(ctx, p, j, resp)
      case 'inventario': case 'inv': return info.cmdInventario(ctx, p, j, resp)
      case 'donde': return info.cmdDonde(ctx, p, j, resp)
      case 'misiones': return info.cmdMisiones(ctx, p, j, resp)
      case 'resumen': return info.cmdResumen(ctx, p, j, resp)
      case 'radio': return info.cmdRadio(ctx, p, j, resp, false)
      case 'previamente': return info.cmdRadio(ctx, p, j, resp, true)
      case 'tiradas': return info.cmdTiradas(ctx, p, j, resp)
      case 'costo': return info.cmdCosto(ctx, p, j, resp)
      case 'x': return info.cmdX(ctx, p, resp)
      case 'ausente': return info.cmdAusente(ctx, p, j, args, resp)
      case 'volver': return info.cmdVolver(ctx, p, j, resp)
      case 'pasar': return info.cmdPasar(ctx, p, j, resp)
      case 'salir': return info.cmdSalir(ctx, p, j, resp)
      case 'pausa': return info.cmdPausa(ctx, p, j, resp)
      case 'reanudar': return info.cmdReanudar(ctx, p, j, resp)
      case 'fin': return info.cmdFin(ctx, p, j, resp)
      case 'libro': return info.cmdLibro(ctx, p, resp)
      case 'saltear': {
        const r = await proponerSaltear(ctx, pid, userId)
        if (r) await resp(r)
        return
      }
      case 'crear':
        if (privado) return unirse(ctx, from, chatId, pid)
        return
      default:
        return
    }
  })
}

async function start(ctx: Ctx, msg: TgMessage, payload: string, resp: (h: string, t?: Teclado) => Promise<void>): Promise<void> {
  if (msg.chat.type !== 'private') return resp('Escribime por privado para crear tu personaje.')
  const m = /^u_(\d+)$/.exec(payload)
  if (m) {
    const pid = Number(m[1])
    return ctx.colas.correr(`p${pid}`, () => unirse(ctx, msg.from!, String(msg.chat.id), pid))
  }
  await resp('☢️ <b>Argos DJ</b> — soy el Director de Juego de tu mesa de rol.\n\nAgregame a un grupo de Telegram, escribí /nueva y armamos una aventura de Fallout entre amigos. Después cada uno crea su personaje acá conmigo.\n\nUsá /ayuda para ver cómo se juega.')
}

async function callback(ctx: Ctx, cb: TgCallback): Promise<void> {
  const data = cb.data ?? ''
  const [t, ...r] = data.split(':')
  const userId = String(cb.from.id)
  const msgId = cb.message?.message_id
  const chatId = cb.message ? String(cb.message.chat.id) : undefined
  ctx.db.upsertUsuario(userId, cb.from.first_name || cb.from.username || 'Jugador', cb.from.username ?? '', cb.message?.chat.type === 'private' ? chatId! : null)

  let respondido = false
  const responder = (txt?: string) => {
    if (respondido) return
    respondido = true
    void ctx.api.responderCallback(cb.id, txt, !!txt && txt.length > 60)
  }
  const timer = setTimeout(() => responder(), 2500)
  const fin = (res?: unknown) => {
    clearTimeout(timer)
    responder(typeof res === 'string' ? res : undefined)
  }

  try {
    let pid: number | undefined
    const num = (s: string | undefined) => (s === undefined ? NaN : Number(s))
    switch (t) {
      case 'x': return fin()
      case 'w': case 'b': case 'r': case 'a': case 't': case 'o': case 'l': case 'n': case 'i': pid = num(r[0]); break
      case 'v': pid = ctx.db.votacion(num(r[0]))?.partida_id; break
      case 'c': case 'm': pid = contextoDe(ctx, userId)?.id; break
      case 'k': {
        const p = ctx.db.partida(num(r[0]))
        if (p && ctx.db.jugadorDeUsuario(p.id, userId)) {
          ctx.db.setContexto(userId, p.id)
          if (chatId) await ctx.api.enviar(chatId, `✅ Ahora hablamos de «${esc(p.guion?.titulo ?? 'la partida')}».`)
        }
        return fin()
      }
      default: return fin()
    }
    if (pid === undefined || Number.isNaN(pid)) return fin('Esa partida ya no existe.')
    const P = pid
    const res = await ctx.colas.correr(`p${P}`, async () => {
      switch (t) {
        case 'w': return callbackWizard(ctx, P, userId, r[1], r[2])
        case 'b': return r[1] === 'empezar' ? empezarPartida(ctx, P, userId) : undefined
        case 'r': return resolverTirada(ctx, P, userId, num(r[1]), r[2], msgId)
        case 'a': return accionCombate(ctx, P, userId, num(r[1]), r[2])
        case 't': return elegirObjetivo(ctx, P, userId, num(r[1]), r[2])
        case 'o': return elegirObjeto(ctx, P, userId, num(r[1]), r[2])
        case 'l': return elegirAliado(ctx, P, userId, num(r[1]), num(r[2]))
        case 'n': return reintentarNarracion(ctx, P, num(r[1]))
        case 'v': return votar(ctx, num(r[0]), userId, r[1] === 's' ? 's' : 'e')
        case 'c': return callbackCreacion(ctx, cb.from, msgId, ['c', ...r])
        case 'm': return callbackMejora(ctx, cb.from, msgId, ['m', ...r])
        case 'i': return botonInfo(ctx, P, userId, r[1])
      }
    })
    fin(res)
  } catch (e) {
    ctx.log('Error en callback', data, (e as Error).stack ?? (e as Error).message)
    fin('Algo falló. Probá de nuevo.')
  }
}

/** Botones de info del turno: la respuesta va por privado si se puede (para no llenar el grupo). */
async function botonInfo(ctx: Ctx, pid: number, userId: string, que: string): Promise<string | void> {
  const p = ctx.db.partida(pid)
  const j = p && ctx.db.jugadorDeUsuario(pid, userId)
  if (!p || !j) return 'No estás en esta partida.'
  const usuario = ctx.db.usuario(userId)
  const chat = usuario?.dm_chat_id ?? j.dm_chat_id ?? p.chat_id
  const resp = async (html: string) => {
    await ctx.api.enviar(chat, html, { threadId: chat === p.chat_id ? p.thread_id : undefined })
  }
  if (chat === p.chat_id) await resp('💡 Tip: escribime por privado (/start) y estas consultas te llegan ahí sin llenar el grupo.')
  switch (que) {
    case 'ficha': { const pj = ctx.db.ultimoPersonajeDe(j.id); return void (await resp(pj ? fichaTexto(ctx, pj) : 'Sin personaje.')) }
    case 'inv': { const pj = ctx.db.personajeVivoDe(j.id); return void (await resp(pj ? inventarioTexto(ctx, pj) : 'Sin personaje.')) }
    case 'donde': return info.cmdDonde(ctx, p, j, resp)
    case 'resumen': return info.cmdResumen(ctx, p, j, resp)
  }
}
