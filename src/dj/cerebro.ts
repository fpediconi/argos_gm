import type { Config, Precio } from '../config.js'
import type { PedidoTirada, GuionMaestro, AtribId } from '../motor/tipos.js'
import type { Cambios } from '../motor/estado.js'
import type { PedidoEnemigos } from '../motor/combate.js'
import { ATRIBUTOS } from '../motor/tipos.js'
import { sleep } from '../util.js'

export type RolIA = 'narrador' | 'util' | 'guionista'
export type Tarea = 'turno' | 'apertura' | 'guion' | 'premisas' | 'trasfondo' | 'reaccion' | 'resumen' | 'radio' | 'epilogo' | 'ronda_combate' | 'prueba'

export interface SalidaNarrar {
  narracion: string
  cronica: string
  sugerencias: string[]
  cambios?: Cambios
  combate?: { enemigos: PedidoEnemigos[]; sorpresa?: 'jugadores' | 'enemigos' | 'ninguna' }
  cerrar_capitulo?: boolean
  vinculos?: string[]
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

export interface Uso { tok_in: number; tok_cache: number; tok_out: number; usd: number; ms: number }
export type RegistrarUso = (x: { partidaId: number | null; rol: RolIA; modelo: string; uso: Uso; ok: boolean }) => void

export function costo(uso: { tok_in: number; tok_cache: number; tok_out: number }, p: Precio): number {
  const nuevos = Math.max(0, uso.tok_in - uso.tok_cache)
  return (nuevos * p.in + uso.tok_cache * p.cache + uso.tok_out * p.out) / 1_000_000
}

/** Cerebro real: OpenAI Chat Completions con function calling. Sin dependencias (fetch). */
export class CerebroOpenAI implements Cerebro {
  constructor(private cfg: Config, private herramientas: { pedirTirada: unknown; narrar: unknown }, private registrar: RegistrarUso) {}

  private async llamar(rol: RolIA, partidaId: number | null, cuerpo: Record<string, unknown>): Promise<any> {
    const modelo = this.cfg.modelos[rol]
    const body: Record<string, unknown> = { model: modelo, ...cuerpo }
    // Algunos modelos (gpt-5.x) no aceptan herramientas junto con razonamiento en /chat/completions: para esas llamadas se usa otro nivel (por defecto 'none').
    const esfuerzo = body.tools ? this.cfg.reasoningEffortTools : this.cfg.reasoningEffort
    if (esfuerzo && /^(gpt-5|o\d)/.test(modelo)) body.reasoning_effort = esfuerzo
    let ultimoError: unknown
    for (let intento = 0; intento < 3; intento++) {
      const t0 = Date.now()
      try {
        const res = await fetch(`${this.cfg.openaiBase}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.openaiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90_000),
        })
        const txt = await res.text()
        if (!res.ok) {
          if (res.status === 429 || res.status >= 500) throw new ErrorReintentable(`OpenAI ${res.status}: ${txt.slice(0, 200)}`)
          this.registrar({ partidaId, rol, modelo, uso: { tok_in: 0, tok_cache: 0, tok_out: 0, usd: 0, ms: Date.now() - t0 }, ok: false })
          throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 400)}`)
        }
        const json = JSON.parse(txt)
        const u = json.usage ?? {}
        const uso = {
          tok_in: u.prompt_tokens ?? 0,
          tok_cache: u.prompt_tokens_details?.cached_tokens ?? 0,
          tok_out: u.completion_tokens ?? 0,
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
  if (Array.isArray(a?.vinculos)) s.vinculos = a.vinculos.map(String).slice(0, 8)
  return s
}

export function parsearGuion(txt: string): GuionMaestro | null {
  try {
    const j = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    if (!j || typeof j !== 'object' || !j.titulo || !j.premisa) return null
    return {
      titulo: String(j.titulo),
      premisa: String(j.premisa),
      gancho: String(j.gancho ?? ''),
      actos: Array.isArray(j.actos) ? j.actos.map(String) : [],
      facciones: Array.isArray(j.facciones) ? j.facciones : [],
      npcs: Array.isArray(j.npcs) ? j.npcs : [],
      lugares: Array.isArray(j.lugares) ? j.lugares : [],
      secretos: Array.isArray(j.secretos) ? j.secretos.map(String) : [],
      amenaza: j.amenaza ?? { nombre: 'La amenaza', reloj: 'Cuenta atrás', segmentos: 6 },
      finales: Array.isArray(j.finales) ? j.finales.map(String) : [],
      encuentros: Array.isArray(j.encuentros) ? j.encuentros.map(String) : [],
    }
  } catch {
    return null
  }
}
