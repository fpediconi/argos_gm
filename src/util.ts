/** Escapa texto para parse_mode HTML de Telegram. */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n))

export function recortar(s: string, max: number): string {
  const t = String(s ?? '').trim()
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…'
}

/** Cola por clave: procesa de a una tarea por clave, sin bloquear a las demás claves. */
export class Colas {
  private m = new Map<string, Promise<unknown>>()
  correr<T>(clave: string, fn: () => Promise<T>): Promise<T> {
    const previa = this.m.get(clave) ?? Promise.resolve()
    const p = previa.catch(() => undefined).then(fn)
    this.m.set(clave, p)
    p.finally(() => {
      if (this.m.get(clave) === p) this.m.delete(clave)
    }).catch(() => undefined)
    return p
  }
}

export function formatoDuracion(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`
  return `${Math.round(h / 24)} d`
}

/** Parsea "3d", "12h", "90m" a milisegundos. */
export function parseDuracion(s: string): number | null {
  const m = /^(\d+)\s*(d|h|m)$/i.exec(s.trim())
  if (!m) return null
  const n = Number(m[1])
  return n * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2].toLowerCase() as 'd' | 'h' | 'm']
}

export function fechaCorta(ms: number, tzMin: number): string {
  const d = new Date(ms + tzMin * 60_000)
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  return `${dd}/${mm} ${hh}:${mi}`
}

export function inicioDelDia(ms: number, tzMin: number): number {
  const local = ms + tzMin * 60_000
  return local - (local % 86_400_000) - tzMin * 60_000
}

/** Barra de vida corta (5 segmentos) para las tarjetas de combate. */
export function barraVida(salud: number, max: number, segmentos = 5): string {
  const llenos = max > 0 && salud > 0 ? Math.max(1, Math.min(segmentos, Math.round((salud / max) * segmentos))) : 0
  return '▰'.repeat(llenos) + '▱'.repeat(segmentos - llenos)
}

/** Dados con su resultado al lado: "🎲 4 ✅  🎲 12 ❌". */
export function dadosTexto(dados: number[], tn: number): string {
  return dados.map((d) => `🎲 ${d} ${d <= tn ? '✅' : '❌'}${d === 20 ? '⚠️' : ''}`).join('  ')
}

/**
 * Texto de la IA → HTML de Telegram: escapa y convierte el markdown que a veces se le escapa
 * (**negrita**, *cursiva*, _cursiva_) en vez de mostrar asteriscos.
 */
export function textoIA(s: unknown): string {
  return esc(String(s ?? '').trim())
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/(^|[\s(¡¿"«])\*(\S(?:[^*\n]*\S)?)\*(?=[\s).,;:!?"»]|$)/g, '$1<i>$2</i>')
    .replace(/(^|[\s(¡¿"«])_(\S(?:[^_\n]*\S)?)_(?=[\s).,;:!?"»]|$)/g, '$1<i>$2</i>')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*|\*/g, '')
}

/** Saca las etiquetas HTML (para mandar líneas del motor a la IA o a la bitácora). */
export function sinTags(s: string): string {
  return String(s ?? '').replace(/<[^>]+>/g, '')
}
