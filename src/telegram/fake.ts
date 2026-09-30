import type { ApiTelegram, OpcionesEnvio, Teclado, TgUpdate, TgUser } from './api.js'

export interface MsgFake { chatId: string; id: number; html: string; teclado?: Teclado; responderA?: number; editado: number; borradoTeclado: boolean }

/** API de Telegram en memoria: registra todo lo que el bot dice, para simular y testear. */
export class FakeApi implements ApiTelegram {
  msgs: MsgFake[] = []
  docs: { chatId: string; nombre: string; contenido: string }[] = []
  fijados: number[] = []
  encuestas: { chatId: string; id: number; pollId: string; pregunta: string; opciones: string[]; cerrada: boolean }[] = []
  audios = new Map<string, Uint8Array>()
  callbacks: { id: string; texto?: string }[] = []
  private n = 1000
  yo: TgUser = { id: 999, first_name: 'Argos DJ', username: 'argos_dj_bot', is_bot: true }
  async getMe() { return this.yo }
  async getUpdates(): Promise<TgUpdate[]> { return [] }
  async enviar(chatId: string, html: string, op: OpcionesEnvio = {}) {
    const id = ++this.n
    this.msgs.push({ chatId, id, html, teclado: op.teclado, responderA: op.responderA, editado: 0, borradoTeclado: false })
    return id
  }
  async editar(chatId: string, messageId: number, html: string, teclado?: Teclado | null) {
    const m = this.msgs.find((x) => x.chatId === chatId && x.id === messageId)
    if (!m) return
    m.html = html; m.editado++
    if (teclado !== undefined) m.teclado = teclado ?? undefined
  }
  async quitarTeclado(chatId: string, messageId: number) {
    const m = this.msgs.find((x) => x.chatId === chatId && x.id === messageId)
    if (m) { m.teclado = undefined; m.borradoTeclado = true }
  }
  async responderCallback(id: string, texto?: string) { this.callbacks.push({ id, texto }) }
  async fijar(_c: string, messageId: number) { this.fijados.push(messageId); return true }
  async desfijar(_c: string, messageId: number) { this.fijados = this.fijados.filter((x) => x !== messageId) }
  async desfijarTodos() { this.fijados = [] }
  borrados: number[] = []
  async borrar(_c: string, messageId: number) { this.borrados.push(messageId) }
  async encuesta(chatId: string, pregunta: string, opciones: string[]) {
    const id = ++this.n
    const pollId = `poll${id}`
    this.encuestas.push({ chatId, id, pollId, pregunta, opciones, cerrada: false })
    this.msgs.push({ chatId, id, html: `📊 ${pregunta}`, editado: 0, borradoTeclado: false })
    return { messageId: id, pollId }
  }
  async cerrarEncuesta(_c: string, messageId: number) { const e = this.encuestas.find((x) => x.id === messageId); if (e) e.cerrada = true }
  async descargar(fileId: string) { return { datos: this.audios.get(fileId) ?? new Uint8Array([1, 2, 3]), ruta: `voice/${fileId}.oga` } }
  async documento(chatId: string, nombre: string, contenido: string) { this.docs.push({ chatId, nombre, contenido }) }
  async escribiendo() {}
  async setComandos() {}
  async quitarWebhook() {}

  ultimo(chatId?: string) {
    const l = chatId ? this.msgs.filter((m) => m.chatId === chatId) : this.msgs
    return l[l.length - 1]
  }
  /** Último mensaje con teclado que contenga un botón cuyo texto matchee. */
  boton(chatId: string, re: RegExp) {
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const m = this.msgs[i]
      if (m.chatId !== chatId || !m.teclado) continue
      for (const f of m.teclado) for (const b of f) if (b.callback_data && re.test(b.text)) return { msg: m, data: b.callback_data }
    }
    return null
  }
  botonData(chatId: string, re: RegExp) {
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const m = this.msgs[i]
      if (m.chatId !== chatId || !m.teclado) continue
      for (const f of m.teclado) for (const b of f) if (b.callback_data && re.test(b.callback_data)) return { msg: m, data: b.callback_data, text: b.text }
    }
    return null
  }
}
