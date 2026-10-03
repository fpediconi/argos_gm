import type { Config, Precio } from '../config.js'
import type { PedidoTirada, GuionMaestro, AtribId } from '../motor/tipos.js'
import type { Cambios } from '../motor/estado.js'
import type { PedidoEnemigos } from '../motor/combate.js'
import { ATRIBUTOS } from '../motor/tipos.js'
import type { OpHilo, CorteEscena } from '../motor/canon.js'
import { normalizarGuion } from '../motor/canon.js'
import { sleep } from '../util.js'

export type RolIA = 'narrador' | 'util' | 'guionista'
export type Tarea = 'turno' | 'apertura' | 'guion' | 'premisas' | 'intencion' | 'trasfondo' | 'reaccion' | 'resumen' | 'radio' | 'epilogo' | 'ronda_combate' | 'prueba'
  | 'auditor' | 'dj' | 'entrevista' | 'compilar' | 'capitulo'

export interface SalidaNarrar {
  narracion: string
  cronica: string
  sugerencias: string[]
  cambios?: Cambios
  combate?: { enemigos: PedidoEnemigos[]; sorpresa?: 'jugadores' | 'enemigos' | 'ninguna' }
  cerrar_capitulo?: boolean
  terminar_combate?: boolean
  vinculos?: string[]
  /** Hechos del turno (la memoria de la historia): la crónica sale de acá. */
  hechos?: string[]
  escena?: CorteEscena & { pregunta: string }
  hilos?: OpHilo[]
  hito_cumplido?: string
  beat_jugado?: string
  agenda_frenada?: string
  secreto_pj?: { pj: string; estado: 'sospechado' | 'revelado' }
  privado?: { pj: string; texto: string }
  contradice_valor?: { pj: string; texto: string }
  recurso?: string
  libreta?: string
}

export type Decision =
  | { tipo: 'tirada'; preambulo: string; pedido: PedidoTirada }
  | { tipo: 'narrar'; salida: SalidaNarrar }

export interface PeticionDecidir {
  tarea: Tarea
  rol: RolIA
  partidaId: number | null
  sistema: string
  usuario: string
  forzarNarrar: boolean
  maxSalida: number
  /** Solo para el cerebro simulado */
  pista?: Record<string, unknown>
}

export interface PeticionTexto {
  tarea: Tarea
  rol: RolIA
  partidaId: number | null
  sistema: string
  usuario: string
  maxSalida: number
  json?: boolean
  pista?: Record<string, unknown>
}

export interface Cerebro {
  decidir(p: PeticionDecidir): Promise<Decision>
  texto(p: PeticionTexto): Promise<string>
}

export interface Uso { tok_in: number; tok_cache: number; tok_out: number; usd: number; ms: number; tok_razon?: number }
export type RegistrarUso = (x: { partidaId: number | null; rol: RolIA; modelo: string; uso: Uso; ok: boolean }) => void

export function costo(uso: { tok_in: number; tok_cache: number; tok_out: number }, p: Precio): number {
  const nuevos = Math.max(0, uso.tok_in - uso.tok_cache)
  return (nuevos * p.in + uso.tok_cache * p.cache + uso.tok_out * p.out) / 1_000_000
}

/** Tokens extra de salida para que el razonamiento no se coma la respuesta (en /responses cuentan dentro del tope). */
const MARGEN_RAZONAMIENTO: Record<string, number> = { minimal: 500, low: 2000, medium: 5000, high: 10000, xhigh: 16000 }

/**
 * Cerebro real de OpenAI, sin dependencias (fetch). Por defecto usa /responses, que deja razonar también en los
 * turnos con herramientas. Si la cuenta o el modelo no lo aceptan, cae solo a /chat/completions (sin razonar con herramientas).
 */
export class CerebroOpenAI implements Cerebro {
  /** Se pone en true si /responses falló con un error de pedido: desde ahí todo va por /chat/completions. */
  private sinResponses = false
  constructor(private cfg: Config, private herramientas: { pedirTirada: unknown; narrar: unknown }, private registrar: RegistrarUso, private log: (...a: unknown[]) => void = console.log) {}

  private get responses(): boolean {
    return this.cfg.api === 'responses' && !this.sinResponses
  }

  /** Cómo está hablando con OpenAI ahora mismo (para /estado y probar-ia). */
  modoActivo(): string {
    if (this.cfg.api !== 'responses') return '/chat/completions (configurado)'
    return this.sinResponses ? '/chat/completions (cayó desde /responses)' : '/responses'
  }

  /** Esfuerzo de razonamiento de una llamada. En /responses el narrador razona aunque use herramientas. */
  esfuerzo(conHerramientas: boolean): string {
    if (this.responses) return conHerramientas ? this.cfg.reasoningNarrador ?? this.cfg.reasoningEffort : this.cfg.reasoningEffort
    return conHerramientas ? this.cfg.reasoningEffortTools : this.cfg.reasoningEffort
  }

  private async llamar(rol: RolIA, partidaId: number | null, cuerpo: Record<string, unknown>): Promise<any> {
    const modelo = this.cfg.modelos[rol]
    const razona = /^(gpt-5|o\d)/.test(modelo)
    let body: Record<string, unknown>
    let ruta = '/chat/completions'
    const usaResponses = this.responses
    if (usaResponses) {
      // Responses API: admite razonamiento JUNTO con herramientas (en /chat/completions gpt-5.4+ no).
      ruta = '/responses'
      body = aResponses(modelo, cuerpo)
      const esfuerzo = this.esfuerzo(!!cuerpo.tools)
      if (esfuerzo && razona) {
        body.reasoning = { effort: esfuerzo }
        body.max_output_tokens = Number(body.max_output_tokens ?? 1000) + (MARGEN_RAZONAMIENTO[esfuerzo] ?? 0)
      }
    } else {
      body = { model: modelo, ...cuerpo }
      // Algunos modelos (gpt-5.x) no aceptan herramientas junto con razonamiento en /chat/completions: para esas llamadas se usa otro nivel (por defecto 'none').
      const esfuerzo = body.tools ? this.cfg.reasoningEffortTools : this.cfg.reasoningEffort
      if (esfuerzo && razona) body.reasoning_effort = esfuerzo
    }
    let ultimoError: unknown
    for (let intento = 0; intento < 3; intento++) {
      const t0 = Date.now()
      try {
        const res = await fetch(`${this.cfg.openaiBase}${ruta}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.openaiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90_000),
        })
        const txt = await res.text()
        if (!res.ok) {
          if (res.status === 429 || res.status >= 500) throw new ErrorReintentable(`OpenAI ${res.status}: ${txt.slice(0, 200)}`)
          this.registrar({ partidaId, rol, modelo, uso: { tok_in: 0, tok_cache: 0, tok_out: 0, usd: 0, ms: Date.now() - t0 }, ok: false })
          // /responses no disponible para esta cuenta o modelo: se sigue por /chat/completions sin cortar el juego.
          if (usaResponses && [400, 404, 405].includes(res.status)) {
            this.sinResponses = true
            this.log(`⚠️ /responses respondió ${res.status}; sigo por /chat/completions sin razonamiento en herramientas. Detalle: ${txt.slice(0, 300)}`)
            return this.llamar(rol, partidaId, cuerpo)
          }
          throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 400)}`)
        }
        const json = this.responses ? deResponses(JSON.parse(txt)) : JSON.parse(txt)
        const u = json.usage ?? {}
        const uso = {
          tok_in: u.prompt_tokens ?? u.input_tokens ?? 0,
          tok_cache: u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0,
          tok_out: u.completion_tokens ?? u.output_tokens ?? 0,
          tok_razon: u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? 0,
        }
        this.registrar({ partidaId, rol, modelo, uso: { ...uso, usd: costo(uso, this.cfg.precios[rol]), ms: Date.now() - t0 }, ok: true })
        return json
      } catch (e) {
        ultimoError = e
        if (e instanceof ErrorReintentable || (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'TypeError') {
          await sleep(1500 * 2 ** intento)
          continue
        }
        throw e
      }
    }
    throw ultimoError
  }

  async decidir(p: PeticionDecidir): Promise<Decision> {
    const tools = p.forzarNarrar ? [this.herramientas.narrar] : [this.herramientas.pedirTirada, this.herramientas.narrar]
    const toolChoice = p.forzarNarrar ? { type: 'function', function: { name: 'narrar' } } : 'required'
    const json = await this.llamar(p.rol, p.partidaId, {
      messages: [{ role: 'system', content: p.sistema }, { role: 'user', content: p.usuario }],
      tools,
      tool_choice: toolChoice,
      max_completion_tokens: p.maxSalida,
    })
    const msg = json.choices?.[0]?.message
    const call = msg?.tool_calls?.[0]
    if (call?.function) {
      const args = seguroJson(call.function.arguments)
      if (call.function.name === 'pedir_tirada' && !p.forzarNarrar) {
        const pedido = normalizarPedido(args)
        if (pedido) return { tipo: 'tirada', preambulo: String(args.preambulo ?? ''), pedido }
      }
      return { tipo: 'narrar', salida: normalizarSalida(args) }
    }
    // Sin tool call: el modelo contestó texto. Lo usamos como narración en vez de perder el turno.
    return { tipo: 'narrar', salida: { narracion: String(msg?.content ?? '').trim() || '…', cronica: '', sugerencias: [] } }
  }

  async texto(p: PeticionTexto): Promise<string> {
    const json = await this.llamar(p.rol, p.partidaId, {
      messages: [{ role: 'system', content: p.sistema }, { role: 'user', content: p.usuario }],
      max_completion_tokens: p.maxSalida,
      ...(p.json ? { response_format: { type: 'json_object' } } : {}),
    })
    return String(json.choices?.[0]?.message?.content ?? '').trim()
  }
}

class ErrorReintentable extends Error {}

/** Traduce un cuerpo de /chat/completions al formato de /responses. */
export function aResponses(modelo: string, c: Record<string, any>): Record<string, unknown> {
  const msgs = (c.messages ?? []) as { role: string; content: string }[]
  const body: Record<string, unknown> = {
    model: modelo,
    instructions: msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n'),
    input: msgs.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
    max_output_tokens: c.max_completion_tokens,
    store: false,
  }
  if (Array.isArray(c.tools)) body.tools = c.tools.map((t: any) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters }))
  if (c.tool_choice) body.tool_choice = typeof c.tool_choice === 'string' ? c.tool_choice : { type: 'function', name: c.tool_choice.function?.name }
  if (c.response_format?.type === 'json_object') body.text = { format: { type: 'json_object' } }
  return body
}

/** Lleva la respuesta de /responses a la forma de /chat/completions que usa el resto del código. */
export function deResponses(r: any): any {
  const out = Array.isArray(r?.output) ? r.output : []
  const llamadas = out.filter((o: any) => o.type === 'function_call').map((o: any) => ({ type: 'function', id: o.call_id, function: { name: o.name, arguments: o.arguments } }))
  const texto = out.filter((o: any) => o.type === 'message').flatMap((o: any) => (o.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text)).join('')
  return { choices: [{ message: { content: r?.output_text ?? texto, tool_calls: llamadas } }], usage: r?.usage }
}

function seguroJson(s: unknown): any {
  try {
    return JSON.parse(String(s))
  } catch {
    return {}
  }
}

function normalizarPedido(a: any): PedidoTirada | null {
  const atributo = String(a?.atributo ?? '').toUpperCase() as AtribId
  if (!ATRIBUTOS.includes(atributo) || !a?.habilidad) return null
  const d = Math.round(Number(a.dificultad))
  return { atributo, habilidad: String(a.habilidad), dificultad: d >= 1 && d <= 4 ? d : 1, motivo: String(a.motivo ?? '').slice(0, 120) }
}

export function normalizarSalida(a: any): SalidaNarrar {
  const s: SalidaNarrar = {
    narracion: String(a?.narracion ?? '').trim() || '…',
    cronica: String(a?.cronica ?? '').trim().slice(0, 160),
    sugerencias: Array.isArray(a?.sugerencias) ? a.sugerencias.map(String).slice(0, 3) : [],
  }
  if (a?.cambios && typeof a.cambios === 'object') s.cambios = a.cambios
  if (a?.combate?.enemigos && Array.isArray(a.combate.enemigos)) s.combate = { enemigos: a.combate.enemigos, sorpresa: a.combate.sorpresa }
  if (a?.cerrar_capitulo === true) s.cerrar_capitulo = true
  if (a?.terminar_combate === true) s.terminar_combate = true
  if (Array.isArray(a?.vinculos)) s.vinculos = a.vinculos.map(String).slice(0, 8)
  const txt = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined)
  if (Array.isArray(a?.hechos)) s.hechos = a.hechos.map((x: unknown) => String(x).trim().slice(0, 160)).filter(Boolean).slice(0, 3)
  if (!s.cronica && s.hechos?.length) s.cronica = s.hechos.join(' · ').slice(0, 220)
  if (a?.escena && typeof a.escena === 'object' && txt(a.escena.pregunta, 160)) {
    s.escena = { pregunta: txt(a.escena.pregunta, 160)!, lugar: txt(a.escena.lugar, 80), presentes: Array.isArray(a.escena.presentes) ? a.escena.presentes.map(String).slice(0, 6) : [] }
  }
  if (Array.isArray(a?.hilos)) s.hilos = a.hilos.filter((h: any) => h && ['abrir', 'tocar', 'cerrar', 'abandonar'].includes(h.accion)).slice(0, 4)
  for (const k of ['hito_cumplido', 'beat_jugado', 'agenda_frenada', 'recurso', 'libreta'] as const) {
    const v = txt(a?.[k], k === 'libreta' ? 400 : 60)
    if (v) (s as unknown as Record<string, unknown>)[k] = v
  }
  if (a?.secreto_pj?.pj && ['sospechado', 'revelado'].includes(a.secreto_pj.estado)) s.secreto_pj = { pj: String(a.secreto_pj.pj), estado: a.secreto_pj.estado }
  if (a?.privado?.pj && txt(a.privado.texto, 300)) s.privado = { pj: String(a.privado.pj), texto: txt(a.privado.texto, 300)! }
  if (a?.contradice_valor?.pj && txt(a.contradice_valor.texto, 200)) s.contradice_valor = { pj: String(a.contradice_valor.pj), texto: txt(a.contradice_valor.texto, 200)! }
  return s
}

export function parsearGuion(txt: string): GuionMaestro | null {
  try {
    const j = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    if (!j || typeof j !== 'object' || !j.titulo || !j.premisa) return null
    return normalizarGuion({
      titulo: String(j.titulo),
      premisa: String(j.premisa),
      gancho: String(j.gancho ?? ''),
      actos: Array.isArray(j.actos) ? j.actos : [],
      facciones: Array.isArray(j.facciones) ? j.facciones : [],
      npcs: Array.isArray(j.npcs) ? j.npcs : [],
      arcos: Array.isArray(j.arcos) ? j.arcos.filter((x: any) => x && Array.isArray(x.beats)).map((x: any) => ({ pj: String(x.pj), beats: x.beats.map(String).slice(0, 3) })) : [],
      lugares: Array.isArray(j.lugares) ? j.lugares : [],
      secretos: Array.isArray(j.secretos) ? j.secretos.map(String) : [],
      amenaza: j.amenaza ?? { nombre: 'La amenaza', reloj: 'Cuenta atrás', segmentos: 6 },
      finales: Array.isArray(j.finales) ? j.finales.map(String) : [],
      encuentros: Array.isArray(j.encuentros) ? j.encuentros.map(String) : [],
    })
  } catch {
    return null
  }
}
