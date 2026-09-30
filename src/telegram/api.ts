import { sleep } from '../util.js'

export interface TgUser { id: number; first_name: string; last_name?: string; username?: string; is_bot?: boolean }
export interface TgChat { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string }
export interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  date: number
  text?: string
  message_thread_id?: number
  reply_to_message?: { message_id: number; from?: TgUser }
  migrate_to_chat_id?: number
  migrate_from_chat_id?: number
  new_chat_members?: TgUser[]
  pinned_message?: { message_id: number }
  voice?: TgAudio
  audio?: TgAudio
}
export interface TgAudio { file_id: string; duration: number; mime_type?: string; file_size?: number }
export interface TgPollAnswer { poll_id: string; user?: TgUser; option_ids: number[] }
export interface TgCallback { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgMyChatMember { chat: TgChat; from: TgUser; new_chat_member: { status: string; user: TgUser } }
export interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback; my_chat_member?: TgMyChatMember; poll_answer?: TgPollAnswer }

export type Boton = { text: string; callback_data?: string; url?: string }
export type Teclado = Boton[][]

export interface OpcionesEnvio {
  teclado?: Teclado
  responderA?: number
  threadId?: number | null
  silencioso?: boolean
}

/** La parte de la Bot API que usa el juego. La implementación real y la simulada cumplen la misma interfaz. */
export interface ApiTelegram {
  getMe(): Promise<TgUser>
  getUpdates(offset: number, timeoutSeg: number): Promise<TgUpdate[]>
  enviar(chatId: string, html: string, op?: OpcionesEnvio): Promise<number>
  editar(chatId: string, messageId: number, html: string, teclado?: Teclado | null): Promise<void>
  quitarTeclado(chatId: string, messageId: number): Promise<void>
  responderCallback(id: string, texto?: string, alerta?: boolean): Promise<void>
  fijar(chatId: string, messageId: number): Promise<boolean>
  desfijar(chatId: string, messageId: number): Promise<void>
  desfijarTodos(chatId: string): Promise<void>
  borrar(chatId: string, messageId: number): Promise<void>
  /** Encuesta nativa (no anónima, para saber quién votó). */
  encuesta(chatId: string, pregunta: string, opciones: string[], op?: OpcionesEnvio): Promise<{ messageId: number; pollId: string }>
  cerrarEncuesta(chatId: string, messageId: number): Promise<void>
  /** Descarga un archivo (audio) de Telegram. */
  descargar(fileId: string): Promise<{ datos: Uint8Array; ruta: string }>
  documento(chatId: string, nombre: string, contenido: string, caption?: string, op?: OpcionesEnvio): Promise<void>
  escribiendo(chatId: string, threadId?: number | null): Promise<void>
  setComandos(comandos: { command: string; description: string }[]): Promise<void>
  quitarWebhook(): Promise<void>
}

export class ErrorTelegram extends Error {
  constructor(msg: string, public codigo: number, public retryAfter?: number) {
    super(msg)
  }
}

export function partir(texto: string, max = 3900): string[] {
  if (texto.length <= max) return [texto]
  const partes: string[] = []
  let resto = texto
  while (resto.length > max) {
    let corte = resto.lastIndexOf('\n', max)
    if (corte < max * 0.5) corte = resto.lastIndexOf(' ', max)
    if (corte < max * 0.5) corte = max
    partes.push(resto.slice(0, corte))
    resto = resto.slice(corte).trimStart()
  }
  if (resto) partes.push(resto)
  return partes
}

export class TelegramReal implements ApiTelegram {
  private ultimo = new Map<string, number>()
  constructor(private token: string) {}

  private url(m: string) {
    return `https://api.telegram.org/bot${this.token}/${m}`
  }

  private async llamar<T>(metodo: string, params: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
    for (let intento = 0; intento < 4; intento++) {
      let res: Response
      try {
        res = await fetch(this.url(metodo), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        if (intento === 3) throw e
        await sleep(1000 * (intento + 1))
        continue
      }
      const j = (await res.json().catch(() => ({}))) as any
      if (j.ok) return j.result as T
      const retry = j.parameters?.retry_after as number | undefined
      if (res.status === 429 && retry && intento < 3) {
        await sleep((retry + 1) * 1000)
        continue
      }
      throw new ErrorTelegram(`${metodo}: ${j.description ?? res.status}`, j.error_code ?? res.status, retry)
    }
    throw new ErrorTelegram(`${metodo}: sin respuesta`, 0)
  }

  private async espaciar(chatId: string) {
    const min = 900
    const t = this.ultimo.get(chatId) ?? 0
    const espera = t + min - Date.now()
    if (espera > 0) await sleep(espera)
    this.ultimo.set(chatId, Date.now())
  }

  getMe() {
    return this.llamar<TgUser>('getMe', {})
  }
  getUpdates(offset: number, timeoutSeg: number) {
    return this.llamar<TgUpdate[]>('getUpdates', { offset, timeout: timeoutSeg, allowed_updates: ['message', 'callback_query', 'my_chat_member', 'poll_answer'] }, (timeoutSeg + 15) * 1000)
  }

  async enviar(chatId: string, html: string, op: OpcionesEnvio = {}): Promise<number> {
    const partes = partir(html)
    let ultimoId = 0
    for (let i = 0; i < partes.length; i++) {
      await this.espaciar(chatId)
      const esUltima = i === partes.length - 1
      const r = await this.llamar<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text: partes[i],
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(esUltima && op.teclado ? { reply_markup: { inline_keyboard: op.teclado } } : {}),
        ...(op.responderA && i === 0 ? { reply_parameters: { message_id: op.responderA, allow_sending_without_reply: true } } : {}),
        ...(op.threadId ? { message_thread_id: op.threadId } : {}),
        ...(op.silencioso ? { disable_notification: true } : {}),
      })
      ultimoId = r.message_id
    }
    return ultimoId
  }

  async editar(chatId: string, messageId: number, html: string, teclado?: Teclado | null): Promise<void> {
    try {
      await this.llamar('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: partir(html)[0],
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(teclado !== undefined ? { reply_markup: { inline_keyboard: teclado ?? [] } } : {}),
      })
    } catch (e) {
      if (e instanceof ErrorTelegram && /not modified/i.test(e.message)) return
      throw e
    }
  }

  async quitarTeclado(chatId: string, messageId: number): Promise<void> {
    try {
      await this.llamar('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
    } catch {
      /* el mensaje pudo haberse borrado o ya no tener botones */
    }
  }

  async responderCallback(id: string, texto?: string, alerta = false): Promise<void> {
    try {
      await this.llamar('answerCallbackQuery', { callback_query_id: id, ...(texto ? { text: texto.slice(0, 190), show_alert: alerta } : {}) })
    } catch {
      /* callbacks viejos vencen: no es un error del juego */
    }
  }

  async fijar(chatId: string, messageId: number): Promise<boolean> {
    try {
      await this.llamar('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true })
      return true
    } catch {
      return false
    }
  }

  async desfijar(chatId: string, messageId: number): Promise<void> {
    try {
      await this.llamar('unpinChatMessage', { chat_id: chatId, message_id: messageId })
    } catch {
      /* ya no estaba fijado o no hay permiso */
    }
  }

  async desfijarTodos(chatId: string): Promise<void> {
    try {
      await this.llamar('unpinAllChatMessages', { chat_id: chatId })
    } catch {
      /* sin permiso */
    }
  }

  async borrar(chatId: string, messageId: number): Promise<void> {
    try {
      await this.llamar('deleteMessage', { chat_id: chatId, message_id: messageId })
    } catch {
      /* sin permiso o ya borrado */
    }
  }

  async encuesta(chatId: string, pregunta: string, opciones: string[], op: OpcionesEnvio = {}): Promise<{ messageId: number; pollId: string }> {
    await this.espaciar(chatId)
    const r = await this.llamar<{ message_id: number; poll: { id: string } }>('sendPoll', {
      chat_id: chatId,
      question: pregunta.slice(0, 300),
      options: opciones.map((o) => ({ text: o.slice(0, 100) })),
      is_anonymous: false,
      ...(op.threadId ? { message_thread_id: op.threadId } : {}),
    })
    return { messageId: r.message_id, pollId: r.poll.id }
  }

  async cerrarEncuesta(chatId: string, messageId: number): Promise<void> {
    try {
      await this.llamar('stopPoll', { chat_id: chatId, message_id: messageId })
    } catch {
      /* ya estaba cerrada */
    }
  }

  async descargar(fileId: string): Promise<{ datos: Uint8Array; ruta: string }> {
    const f = await this.llamar<{ file_path: string }>('getFile', { file_id: fileId })
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${f.file_path}`, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new ErrorTelegram(`descarga: ${res.status}`, res.status)
    return { datos: new Uint8Array(await res.arrayBuffer()), ruta: f.file_path }
  }

  async documento(chatId: string, nombre: string, contenido: string, caption?: string, op: OpcionesEnvio = {}): Promise<void> {
    await this.espaciar(chatId)
    const form = new FormData()
    form.append('chat_id', chatId)
    form.append('document', new Blob([contenido], { type: 'text/markdown' }), nombre)
    if (caption) form.append('caption', caption.slice(0, 1000))
    if (op.threadId) form.append('message_thread_id', String(op.threadId))
    const res = await fetch(this.url('sendDocument'), { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) })
    const j = (await res.json().catch(() => ({}))) as any
    if (!j.ok) throw new ErrorTelegram(`sendDocument: ${j.description ?? res.status}`, res.status)
  }

  async escribiendo(chatId: string, threadId?: number | null): Promise<void> {
    try {
      await this.llamar('sendChatAction', { chat_id: chatId, action: 'typing', ...(threadId ? { message_thread_id: threadId } : {}) })
    } catch {
      /* cosmético */
    }
  }

  async quitarWebhook(): Promise<void> {
    await this.llamar('deleteWebhook', { drop_pending_updates: false })
  }

  async setComandos(comandos: { command: string; description: string }[]): Promise<void> {
    await this.llamar('setMyCommands', { commands: comandos })
  }
}
