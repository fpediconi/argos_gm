import type { Ctx } from '../ctx.js'
import type { TgCallback, TgMessage, TgMyChatMember, TgUpdate, TgUser, Teclado } from './api.js'
import type { Partida } from '../motor/tipos.js'
import { AYUDA_GRUPO, partyTexto } from './textos.js'
import { esc, recortar } from '../util.js'
import { callbackConfig, callbackWizard, comandoConfig, comandoNueva, empezarPartida, premisaEscrita } from '../juego/setup.js'
import { callbackCreacion, callbackMejora, contextoDe, esperaTextoCreacion, textoCreacion, unirse } from '../juego/creacion.js'
import { avisarFueraDeTurno, confirmarDecision, finalizarPartida, procesarAccion, saltarTurno, reintentarNarracion, resolverTirada } from '../juego/turno.js'
import { accionCombate, elegirAliado, elegirObjetivo, elegirObjeto } from '../juego/combate.js'
import { proponerSaltear, votar } from '../juego/votos.js'
import { cmdCerrarVotacion, iniciarVotacion, votoEncuesta } from '../juego/decisiones.js'
import * as info from '../juego/info.js'
import { aGrupo, botonGrupo, botonPrivado, cargar, fijarSolo, urlUnirse } from '../juego/comun.js'
import { estadoPresupuesto } from '../dj/presupuesto.js'
import { callbackLegado } from '../juego/narrativa.js'
import { fichaTexto, inventarioTexto } from './textos.js'

export const COMANDOS = [
  { command: 'nueva', description: 'Crear una partida en este grupo' },
  { command: 'a', description: 'Actuar en tu turno: /a lo que hacés' },
  { command: 'dj', description: 'Preguntarle al DJ (quién es quién, qué pasó…)' },
  { command: 'ficha', description: 'Ver tu personaje' },
  { command: 'party', description: 'Ver a los personajes de la party' },
  { command: 'inventario', description: 'Ver tu mochila' },
  { command: 'resumen', description: 'Últimos hechos, lugar y objetivo (gratis)' },
  { command: 'misiones', description: 'Misiones activas' },
  { command: 'radio', description: 'Resumen narrado por Radio Yermo' },
  { command: 'votacion', description: 'Decisión del grupo: /votacion pregunta | op1 | op2' },
  { command: 'pasar', description: 'Ceder tu turno' },
  { command: 'saltear', description: 'Saltear un turno (vencido o con skip directo)' },
  { command: 'ausente', description: 'Avisar que no vas a estar: /ausente 3d' },
  { command: 'volver', description: 'Volver de una ausencia' },
  { command: 'regla', description: 'Explicar una regla' },
  { command: 'tiradas', description: 'Últimas tiradas (con la cuenta)' },
  { command: 'x', description: 'Pedir que el DJ cambie el rumbo' },
  { command: 'config', description: 'Cambiar la configuración (anfitrión)' },
  { command: 'final', description: 'Cerrar la historia en N turnos (anfitrión)' },
  { command: 'limpiar_fijados', description: 'Dejar fijados solo tablero y turno (anfitrión)' },
  { command: 'costo', description: 'Gasto de IA (anfitrión)' },
  { command: 'fe_de_erratas', description: 'Corregir un hecho de la historia (anfitrión)' },
  { command: 'ayuda', description: 'Cómo se juega' },
]

export async function procesarUpdate(ctx: Ctx, u: TgUpdate): Promise<void> {
  try {
    if (u.my_chat_member) await miembro(ctx, u.my_chat_member)
    else if (u.message) await mensaje(ctx, u.message)
    else if (u.callback_query) await callback(ctx, u.callback_query)
    else if (u.poll_answer) await votoEncuesta(ctx, u.poll_answer)
  } catch (e) {
    ctx.log('Error procesando update', u.update_id, (e as Error).stack ?? (e as Error).message)
  }
}

async function miembro(ctx: Ctx, m: TgMyChatMember): Promise<void> {
  if (m.chat.type === 'private' || m.chat.type === 'channel') return
  if (['member', 'administrator'].includes(m.new_chat_member.status) && m.new_chat_member.user.id === ctx.botId) {
    await ctx.api.enviar(String(m.chat.id), '☢️ <b>¡Buenas, sobrevivientes!</b> Soy el DJ de esta mesa de rol.\n\nPara armar una aventura de Fallout, escriban /nueva. Cada uno crea su personaje conmigo por privado y jugamos por turnos, a su ritmo.\n\n💡 Si me dan permiso de <b>fijar mensajes</b>, dejo el tablero y el turno siempre arriba.')
  }
}

function parseComando(texto: string, botUsername: string): { cmd: string; args: string } | null {
  const m = /^\/([a-zA-Z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/.exec(texto.trim())
  if (!m) return null
  if (m[2] && m[2].toLowerCase() !== botUsername.toLowerCase()) return null
  return { cmd: m[1].toLowerCase(), args: (m[3] ?? '').trim() }
}

// ------------------------------------------------------------------ bienvenida

/** Tarjeta para alguien que todavía no está en la partida: directo a crear personaje. */
function textoInvitacion(ctx: Ctx, p: Partida, nombre: string): string {
  const titulo = p.guion?.titulo ? `«${esc(p.guion.titulo)}»` : 'la partida'
  if (p.estado === 'CREANDO' || p.estado === 'CONFIG') {
    return `👋 <b>¡Bienvenido, ${esc(nombre)}!</b> Estamos armando personajes para ${titulo}. Tocá <b>Crear mi personaje</b> y te lo armo por privado en 3 minutos.`
  }
  const actual = p.turno_jugador_id ? ctx.db.jugador(p.turno_jugador_id) : undefined
  return `👋 <b>¡Bienvenido, ${esc(nombre)}!</b> Estamos jugando ${titulo} (capítulo ${p.capitulo}${actual ? `, ahora juega ${esc(actual.nombre)}` : ''}). Tocá <b>Sumarme a la partida</b>, armamos tu personaje por privado y entrás en el próximo turno.`
}

function tecladoInvitacion(ctx: Ctx, p: Partida): Teclado {
  const txt = p.estado === 'CREANDO' || p.estado === 'CONFIG' ? '🧑‍🚀 Crear mi personaje' : '➕ Sumarme a la partida'
  return [[{ text: txt, url: urlUnirse(ctx, p.id) }]]
}

async function bienvenida(ctx: Ctx, msg: TgMessage): Promise<void> {
  const p = ctx.db.partidaActivaDeChat(String(msg.chat.id))
  if (!p || p.estado === 'CONFIG') return
  await ctx.colas.correr(`p${p.id}`, async () => {
    const partida = ctx.db.partida(p.id)!
    for (const u of msg.new_chat_members ?? []) {
      if (u.is_bot) continue
      const uid = String(u.id)
      if (ctx.db.jugadorDeUsuario(partida.id, uid)) continue
      partida.mundo.bienvenidos = partida.mundo.bienvenidos ?? []
      if (partida.mundo.bienvenidos.includes(uid)) continue
      partida.mundo.bienvenidos.push(uid)
      ctx.db.guardarPartida(partida)
      await aGrupo(ctx, partida, textoInvitacion(ctx, partida, u.first_name || u.username || 'sobreviviente'), { teclado: tecladoInvitacion(ctx, partida), responderA: msg.message_id })
    }
  })
}

// ------------------------------------------------------------------ audios

/** ¿Vale la pena transcribir este audio? Solo si alguien lo está esperando (no se gasta en charla). */
function esperaAudio(ctx: Ctx, msg: TgMessage, userId: string): Partida | 'privado' | null {
  if (msg.chat.type === 'private') return esperaTextoCreacion(ctx, userId) ? 'privado' : null
  const p = ctx.db.partidaActivaDeChat(String(msg.chat.id))
  if (!p || p.estado !== 'EN_JUEGO') return null
  if (p.thread_id && msg.message_thread_id !== p.thread_id) return null
  const r = msg.reply_to_message
  if (!r || r.from?.id !== ctx.botId) return null
  const j = ctx.db.jugadorDeUsuario(p.id, userId)
  if (!j || p.turno_jugador_id !== j.id) return null
  const acepta = p.paso.tipo === 'esperando_libre' || (p.paso.tipo === 'esperando_accion' && !p.mundo.combate)
  return acepta ? p : null
}

async function escuchar(ctx: Ctx, msg: TgMessage, userId: string): Promise<string | null> {
  const audio = msg.voice ?? msg.audio
  if (!audio) return null
  const destino = esperaAudio(ctx, msg, userId)
  if (!destino) return null
  const chatId = String(msg.chat.id)
  const aviso = (html: string) => ctx.api.enviar(chatId, html, { threadId: msg.message_thread_id, responderA: msg.message_id })
  if (!ctx.oido) {
    await aviso('🎙️ Todavía no puedo escuchar audios: escribilo, porfa.')
    return null
  }
  if (audio.duration > ctx.cfg.maxAudioSeg) {
    await aviso(`🎙️ El audio es muy largo (máximo ${ctx.cfg.maxAudioSeg} segundos). Contalo más corto o escribilo.`)
    return null
  }
  const pid = destino === 'privado' ? contextoDe(ctx, userId)?.id ?? null : destino.id
  if (estadoPresupuesto(ctx, pid).nivel === 'parado') {
    await aviso('💸 Sin presupuesto de IA por hoy: escribilo, porfa.')
    return null
  }
  try {
    const { datos, ruta } = await ctx.api.descargar(audio.file_id)
    const texto = recortar(await ctx.oido.transcribir(datos, ruta, pid, audio.duration), 600)
    if (!texto) throw new Error('transcripción vacía')
    return texto
  } catch (e) {
    ctx.log('No pude transcribir:', (e as Error).message)
    await aviso('📡 No te pude escuchar, ¿me lo escribís?')
    return null
  }
}

// ------------------------------------------------------------------ mensajes

async function mensaje(ctx: Ctx, msgOriginal: TgMessage): Promise<void> {
  let msg = msgOriginal
  if (msg.migrate_to_chat_id) {
    const p = ctx.db.partidaActivaDeChat(String(msg.chat.id))
    if (p) {
      p.chat_id = String(msg.migrate_to_chat_id)
      ctx.db.guardarPartida(p)
    }
    return
  }
  if (msg.new_chat_members?.length) return bienvenida(ctx, msg)
  // El aviso "Argos fijó un mensaje" no suma nada: se borra (si el bot tiene permiso).
  if (msg.pinned_message && msg.from?.id === ctx.botId) {
    await ctx.api.borrar(String(msg.chat.id), msg.message_id)
    return
  }
  if (!msg.from || msg.from.is_bot) return
  const privado = msg.chat.type === 'private'
  const userId = String(msg.from.id)
  const nombre = msg.from.first_name || msg.from.username || 'Jugador'
  ctx.db.upsertUsuario(userId, nombre, msg.from.username ?? '', privado ? String(msg.chat.id) : null)
  if (!msg.text && (msg.voice || msg.audio)) {
    const texto = await escuchar(ctx, msg, userId)
    if (!texto) return
    msg = { ...msg, text: texto }
  }
  if (!msg.text) return
  const c = parseComando(msg.text, ctx.botUsername)
  if (c) return comando(ctx, msg, c.cmd, c.args, privado)
  if (msg.text.startsWith('/')) return // comando para otro bot
  if (privado) {
    const usado = await textoCreacion(ctx, msg.from!, msg.text)
    if (usado) return
    // Por privado, lo que no es creación de personaje es una pregunta al DJ (si la partida está en juego).
    const pc = contextoDe(ctx, userId)
    const jj = pc ? ctx.db.jugadorDeUsuario(pc.id, userId) : undefined
    if (pc && jj?.creacion) {
      await ctx.api.enviar(String(msg.chat.id), '🧑‍🚀 Estás armando tu personaje: usá los botones del último mensaje (o ✍️ para escribir un campo).')
      return
    }
    if (pc && jj && (pc.estado === 'EN_JUEGO' || pc.estado === 'PAUSADA')) {
      const chat = String(msg.chat.id)
      const texto = msg.text
      await ctx.colas.correr(`p${pc.id}`, () => info.cmdDj(ctx, ctx.db.partida(pc.id)!, jj, texto, async (html, teclado) => { await ctx.api.enviar(chat, html, { teclado: teclado ?? tecladoVolver(ctx, userId) }) }))
      return
    }
    await ctx.api.enviar(String(msg.chat.id), 'Para jugar, andá al grupo y respondé a la tarjeta de tu turno. Usá /ayuda para ver los comandos.', { teclado: tecladoVolver(ctx, userId) })
    return
  }
  // Grupo: solo se procesa la respuesta a un mensaje del bot.
  const p = ctx.db.partidaActivaDeChat(String(msg.chat.id))
  if (!p) return
  if (p.thread_id && msg.message_thread_id !== p.thread_id) return
  const r = msg.reply_to_message
  if (!r || r.from?.id !== ctx.botId) return
  const texto = msg.text
  // El anfitrión escribe su propia premisa respondiendo al asistente.
  if (p.estado === 'CONFIG') {
    if (r.message_id === p.wizard_msg_id) await ctx.colas.correr(`p${p.id}`, () => premisaEscrita(ctx, p.id, userId, texto).then(() => undefined))
    return
  }
  if (p.estado !== 'EN_JUEGO') return
  const j = ctx.db.jugadorDeUsuario(p.id, userId)
  if (!j || j.estado === 'fuera') {
    await ctx.api.enviar(String(msg.chat.id), textoInvitacion(ctx, p, nombre), { threadId: p.thread_id, responderA: msg.message_id, teclado: tecladoInvitacion(ctx, p) })
    return
  }
  if (p.turno_jugador_id !== j.id) {
    await ctx.colas.correr(`p${p.id}`, () => avisarFueraDeTurno(ctx, p.id, userId, msg.message_id).then(() => undefined))
    return
  }
  await ctx.colas.correr(`p${p.id}`, () => procesarAccion(ctx, p.id, userId, texto, msg.message_id))
}

/** Desde el privado: botón para volver al grupo de la partida en contexto. */
function tecladoVolver(ctx: Ctx, userId: string): Teclado | undefined {
  const p = contextoDe(ctx, userId)
  if (!p) return undefined
  const t = botonGrupo(p)
  return t.length ? t : undefined
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
    const api = 'modoActivo' in ctx.cerebro ? ` · OpenAI: ${(ctx.cerebro as { modoActivo(): string }).modoActivo()}` : ''
    return resp(`🛠️ Partidas abiertas: ${n} · gasto hoy US$ ${pres.gastoGlobal.toFixed(3)} / ${pres.topeGlobal} · fusible: ${pres.nivel}${api}`)
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
    return resp(textoInvitacion(ctx, partida, from.first_name || 'sobreviviente'), tecladoInvitacion(ctx, partida))
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
    if (cmd === 'limpiar_fijados') {
      if (p.anfitrion_id !== userId) return resp('Solo el anfitrión puede limpiar los fijados.')
      await ctx.api.desfijarTodos(p.chat_id)
      p.mundo.fijados = []
      await fijarSolo(ctx, p, [p.tablero_msg_id, p.estado === 'EN_JUEGO' ? p.turno_msg_id : null])
      ctx.db.guardarPartida(p)
      return resp('📌 Listo: quedaron fijados solo el tablero y el turno actual.')
    }
    if (cmd === 'config' || cmd === 'configuracion') {
      const r = await comandoConfig(ctx, p, userId)
      if (r) await resp(r)
      return
    }
    if (!j || j.estado === 'fuera') return resp(textoInvitacion(ctx, p, from.first_name || 'sobreviviente'), tecladoInvitacion(ctx, p))
    switch (cmd) {
      case 'a': case 'accion':
        if (!args) return resp('Contame qué hace tu personaje: <code>/a abro la puerta con cuidado</code>')
        return procesarAccion(ctx, pid, userId, args, privado ? undefined : msg.message_id)
      case 'tirar': return resp('Cuando haya una prueba pendiente, tocá el botón 🎲 Tirar en el mensaje del DJ.')
      case 'ficha': return info.cmdFicha(ctx, p, j, resp, privado)
      case 'party': case 'grupo': return info.cmdParty(ctx, p, j, resp)
      case 'inventario': case 'inv': return info.cmdInventario(ctx, p, j, resp)
      case 'donde': return info.cmdDonde(ctx, p, j, resp)
      case 'misiones': return info.cmdMisiones(ctx, p, j, resp)
      case 'resumen': return info.cmdResumen(ctx, p, j, resp)
      case 'dj': case 'preguntar': return info.cmdDj(ctx, p, j, args, resp)
      case 'fe_de_erratas': case 'corregir': return info.cmdFeDeErratas(ctx, p, j, args, resp)
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
      case 'final': return info.cmdFinal(ctx, p, j, args, resp)
      case 'libro': return info.cmdLibro(ctx, p, resp)
      case 'votacion': case 'votar': {
        if (privado) return resp('Las votaciones se hacen en el grupo.')
        const r = await iniciarVotacion(ctx, p, userId, args)
        if (r) await resp(r)
        return
      }
      case 'cerrar_votacion': {
        const r = await cmdCerrarVotacion(ctx, p, userId)
        if (r) await resp(r)
        return
      }
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
  if (msg.chat.type !== 'private') return resp('Escribime por privado para crear tu personaje.', botonPrivado(ctx))
  const dj = /^dj_(\d+)$/.exec(payload)
  if (dj) {
    const p = ctx.db.partida(Number(dj[1]))
    if (p && ctx.db.jugadorDeUsuario(p.id, String(msg.from!.id))) {
      ctx.db.setContexto(String(msg.from!.id), p.id)
      return resp(info.TEXTO_MENU_DJ, info.tecladoDj(p.id))
    }
  }
  const m = /^u_(\d+)$/.exec(payload)
  if (m) {
    const pid = Number(m[1])
    return ctx.colas.correr(`p${pid}`, () => unirse(ctx, msg.from!, String(msg.chat.id), pid))
  }
  await resp('☢️ <b>Argos DJ</b> — soy el Director de Juego de tu mesa de rol.\n\nAgregame a un grupo de Telegram, escribí /nueva y armamos una aventura de Fallout entre amigos. Después cada uno crea su personaje acá conmigo.\n\nUsá /ayuda para ver cómo se juega.', tecladoVolver(ctx, String(msg.from!.id)))
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
      case 'w': case 'b': case 'r': case 'a': case 't': case 'o': case 'l': case 'n': case 'i': case 'g': case 'd': case 'j': case 'u': pid = num(r[0]); break
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
        case 'g': return callbackConfig(ctx, P, userId, msgId, r[1], r[2])
        case 'b':
          if (r[1] === 'empezar') return empezarPartida(ctx, P, userId)
          if (r[1] === 'fin') {
            const p = ctx.db.partida(P)
            if (!p || p.estado === 'FINALIZADA') return 'La partida ya terminó.'
            if (p.anfitrion_id !== userId) return 'Solo el anfitrión puede terminar la historia.'
            await finalizarPartida(ctx, P)
          }
          return undefined
        case 'r': return resolverTirada(ctx, P, userId, num(r[1]), r[2], msgId)
        case 'd': return confirmarDecision(ctx, P, userId, num(r[1]), r[2] === 's')
        case 'a': return accionCombate(ctx, P, userId, num(r[1]), r[2])
        case 't': return elegirObjetivo(ctx, P, userId, num(r[1]), r[2])
        case 'o': return elegirObjeto(ctx, P, userId, num(r[1]), r[2])
        case 'l': return elegirAliado(ctx, P, userId, num(r[1]), num(r[2]))
        case 'n': return reintentarNarracion(ctx, P, num(r[1]))
        case 'v': return votar(ctx, num(r[0]), userId, r[1] === 's' ? 's' : 'e')
        case 'c': return callbackCreacion(ctx, cb.from, msgId, ['c', ...r])
        case 'm': return callbackMejora(ctx, cb.from, msgId, ['m', ...r])
        case 'i': return botonInfo(ctx, P, userId, r[1])
        case 'j': return botonInfo(ctx, P, userId, `dj_${r[1]}`)
        case 'u': return callbackLegado(ctx, P, userId, num(r[1]), r[2], r[3], msgId)
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
  const { partida: p, jugadores, pjs } = cargar(ctx, pid)
  const j = ctx.db.jugadorDeUsuario(pid, userId)
  if (!j) return 'No estás en esta partida.'
  // Las ideas son cortas: van como aviso emergente, sin mensajes.
  if (que === 'pasar') {
    if (p.turno_jugador_id !== j.id || p.estado !== 'EN_JUEGO') return 'No es tu turno.'
    await saltarTurno(ctx, pid, 'pasar')
    return
  }
  if (que === 'ideas') {
    const ideas = p.mundo.ideas ?? []
    return ideas.length ? `💡 ${ideas.join(' · ')}` : 'El DJ no dejó ideas esta vez.'
  }
  const usuario = ctx.db.usuario(userId)
  const dm = usuario?.dm_chat_id ?? j.dm_chat_id ?? null
  let enPrivado = !!dm
  const volver = botonGrupo(p)
  const resp = async (html: string) => {
    if (dm) {
      try {
        await ctx.api.enviar(dm, html, { teclado: volver.length ? volver : undefined })
        return
      } catch (e) {
        ctx.log('no pude escribir por privado, uso el grupo:', (e as Error).message)
        enPrivado = false
      }
    }
    await ctx.api.enviar(p.chat_id, html, { threadId: p.thread_id })
  }
  const respConTeclado = async (html: string, teclado: Teclado) => {
    if (dm) {
      try { await ctx.api.enviar(dm, html, { teclado }); return } catch { enPrivado = false }
    }
    await ctx.api.enviar(p.chat_id, html, { threadId: p.thread_id, teclado })
  }
  if (!dm) await ctx.api.enviar(p.chat_id, '💡 Tip: escribime por privado y estas consultas te llegan ahí sin llenar el grupo.', { threadId: p.thread_id, teclado: botonPrivado(ctx) })
  switch (que) {
    case 'ficha': { const pj = ctx.db.ultimoPersonajeDe(j.id); await resp(pj ? fichaTexto(ctx, pj, !!dm) : 'Sin personaje.'); break }
    case 'inv': { const pj = ctx.db.personajeVivoDe(j.id); await resp(pj ? inventarioTexto(ctx, pj) : 'Sin personaje.'); break }
    case 'party': await resp(partyTexto(ctx, pjs, jugadores)); break
    case 'donde': case 'resumen': await info.cmdResumen(ctx, p, j, resp); break
    case 'dj': await respConTeclado(info.TEXTO_MENU_DJ, info.tecladoDj(pid)); break
    default:
      if (que === 'dj_paso') { await info.cmdResumen(ctx, p, j, resp); break }
      if (que.startsWith('dj_')) { await resp(info.respuestaDj(ctx, p, j, que.slice(3))); break }
      return
  }
  return enPrivado ? '📩 Te lo mandé por privado (chat con el bot).' : undefined
}
