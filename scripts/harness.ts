import { abrirDb } from '../src/db/db.js'
import { Repos } from '../src/db/repos.js'
import { cargarUniverso } from '../src/universos/fallout/index.js'
import { FakeApi } from '../src/telegram/fake.js'
import { CerebroMock } from '../src/dj/mock.js'
import { Colas } from '../src/util.js'
import { procesarUpdate } from '../src/telegram/router.js'
import type { Ctx } from '../src/ctx.js'
import type { Config } from '../src/config.js'
import type { TgUpdate } from '../src/telegram/api.js'
import type { Rng } from '../src/motor/dados.js'

export const GRUPO = '-100500'
export const HORA = 60 * 60 * 1000

export const cfgPrueba: Config = {
  telegramToken: 'x', adminId: '101', openaiKey: 'x', openaiBase: 'http://localhost', reasoningEffort: '', reasoningEffortTools: '',
  modelos: { narrador: 'm', util: 'm', guionista: 'm' },
  precios: { narrador: { in: 1, cache: 0.1, out: 4 }, util: { in: 0.2, cache: 0.02, out: 1 }, guionista: { in: 1, cache: 0.1, out: 4 } },
  maxSalidaNarrador: 800, presupuestoPartidaUsd: 0.5, presupuestoGlobalUsd: 2, dbPath: ':memory:', tzMin: -180, puerto: 0, fusibleOff: false,
  modeloTranscripcion: 'whisper-1', precioTranscripcionMin: 0.006, maxAudioSeg: 90,
}

/** Dados deterministas: secuencia pseudoaleatoria reproducible en 1..20. */
export function rngLcg(semilla = 7): Rng {
  // mulberry32: rápido, reproducible y bien distribuido.
  let a = semilla >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 20) + 1
  }
}

export interface Mundo { ctx: Ctx; api: FakeApi; mock: CerebroMock; reloj: { t: number; ahora(): number }; enviar(u: TgUpdate): Promise<void> }

export function crearMundo(opts: { mock?: CerebroMock; rng?: Rng; cfg?: Partial<Config> } = {}): Mundo {
  const api = new FakeApi()
  const mock = opts.mock ?? new CerebroMock()
  // Miércoles 12:00 hora argentina.
  const reloj = { t: Date.UTC(2026, 8, 30, 15, 0), ahora() { return this.t } }
  const ctx: Ctx = {
    cfg: { ...cfgPrueba, ...opts.cfg }, db: new Repos(abrirDb(':memory:')), api, cerebro: mock, reloj: { ahora: () => reloj.t },
    rng: opts.rng ?? rngLcg(), u: cargarUniverso('fallout'), colas: new Colas(), botUsername: 'argos_dj_bot', botId: 999, log: () => {},
  }
  return { ctx, api, mock, reloj, enviar: (u) => procesarUpdate(ctx, u) }
}

let uid = 1
const user = (id: number) => ({ id, first_name: NOMBRES[id] ?? `U${id}`, username: `u${id}` })
export const NOMBRES: Record<number, string> = { 101: 'Fran', 102: 'Caro', 103: 'Nico', 104: 'Lu' }

export class Jugadores {
  constructor(private m: Mundo) {}
  /** Mensaje en el grupo; `respondiendoA` = message_id de un mensaje del bot. */
  async grupo(id: number, text: string, respondiendoA?: number) {
    await this.m.enviar({ update_id: uid++, message: { message_id: uid + 5000, from: user(id), chat: { id: Number(GRUPO), type: 'supergroup', title: 'Mesa' }, date: 0, text, ...(respondiendoA ? { reply_to_message: { message_id: respondiendoA, from: { id: 999, first_name: 'DJ', is_bot: true } } } : {}) } })
  }
  async privado(id: number, text: string) {
    await this.m.enviar({ update_id: uid++, message: { message_id: uid + 5000, from: user(id), chat: { id, type: 'private' }, date: 0, text } })
  }
  /** Toca un botón (callback_data) del mensaje `msg` de un chat. */
  async tocar(id: number, data: string, chat: string, msgId = 1) {
    await this.m.enviar({ update_id: uid++, callback_query: { id: `cb${uid}`, from: user(id), data, message: { message_id: msgId, chat: { id: Number(chat), type: chat === GRUPO ? 'supergroup' : 'private' }, date: 0 } } })
  }
  async agregarBot(id = 101) {
    await this.m.enviar({ update_id: uid++, my_chat_member: { chat: { id: Number(GRUPO), type: 'supergroup', title: 'Mesa' }, from: user(id), new_chat_member: { status: 'member', user: { id: 999, first_name: 'DJ', is_bot: true } } } })
  }

  /** Crea el personaje de un jugador recorriendo el flujo real por privado. */
  async crearPersonaje(id: number, pid: number, opts: { origen?: string; arq?: string } = {}) {
    const dm = String(id)
    await this.privado(id, `/start u_${pid}`)
    for (let i = 0; i < 30; i++) {
      const ult = this.m.api.ultimo(dm)
      if (!ult) throw new Error('el bot no respondió en privado')
      const datos = (ult.teclado ?? []).flat().map((b) => b.callback_data ?? '')
      if (/^✅ ¡Personaje listo/.test(ult.html.replace(/<[^>]+>/g, ''))) return
      // Con la partida en marcha, después de "Personaje listo" puede llegar otro aviso (por ejemplo "Te toca").
      const jj = this.m.ctx.db.jugadorDeUsuario(pid, String(id))
      if (jj && !jj.creacion && this.m.ctx.db.personajeVivoDe(jj.id) && i > 0) return
      const tocarLo = async (re: RegExp) => { const d = datos.find((x) => re.test(x)); if (!d) return false; await this.tocar(id, d, dm, ult.id); return true }
      if (datos.includes('c:md:r')) { await this.tocar(id, 'c:md:r', dm, ult.id); continue }
      if (datos.some((d) => d.startsWith('c:or:'))) { await this.tocar(id, `c:or:${opts.origen ?? 'refugio'}`, dm, ult.id); continue }
      if (datos.some((d) => d.startsWith('c:aq:'))) { await this.tocar(id, `c:aq:${opts.arq ?? 'soldado'}`, dm, ult.id); continue }
      if (datos.includes('c:aj:ok')) { await this.tocar(id, 'c:aj:ok', dm, ult.id); continue }
      if (await tocarLo(/^c:ar:/)) continue
      if (datos.includes('c:ok')) { await this.tocar(id, 'c:ok', dm, ult.id); continue }
      await this.privado(id, `Respuesta de ${NOMBRES[id]} número ${i}`)
    }
    throw new Error(`creación de ${id} no terminó`)
  }
}

/** Monta grupo + partida configurada + N personajes; devuelve pid. */
export async function partidaLista(m: Mundo, ids = [101, 102, 103], opts: Record<string, string> = {}) {
  const j = new Jugadores(m)
  await j.agregarBot()
  await j.grupo(101, '/nueva')
  const p = m.ctx.db.partidaActivaDeChat(GRUPO)!
  for (const k of ['esc', 'ton', 'dur', 'pla', 'let', 'vio', 'pvp', 'evi', 'sil', 'pre']) await j.tocar(101, `w:${p.id}:${k}:${opts[k] ?? (k === 'dur' ? 'mini' : 'ok')}`, GRUPO, p.wizard_msg_id ?? 1)
  const orig = ['refugio', 'superviviente', 'necrotico', 'hermandad']
  const arqs = ['soldado', 'explorador', 'cara', 'tecnico']
  for (let i = 0; i < ids.length; i++) await j.crearPersonaje(ids[i], p.id, { origen: orig[i], arq: arqs[i] })
  return { j, pid: p.id }
}
