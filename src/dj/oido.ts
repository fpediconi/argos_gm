import type { Config } from '../config.js'
import type { Repos } from '../db/repos.js'

/** Oídos del DJ: convierte una nota de voz en texto. */
export interface Oido {
  transcribir(audio: Uint8Array, nombreArchivo: string, partidaId: number | null, segundos: number): Promise<string>
}

/** Whisper por la API de OpenAI (misma OPENAI_API_KEY). El gasto se registra como rol "transcripcion". */
export class OidoOpenAI implements Oido {
  constructor(private cfg: Config, private db: Repos, private ahora: () => number) {}

  async transcribir(audio: Uint8Array, nombreArchivo: string, partidaId: number | null, segundos: number): Promise<string> {
    const form = new FormData()
    // Telegram manda OGG/Opus como .oga; la API lo acepta con extensión .ogg.
    const nombre = nombreArchivo.replace(/\.oga$/i, '.ogg')
    form.append('file', new Blob([audio as BlobPart]), nombre.split('/').pop() || 'audio.ogg')
    form.append('model', this.cfg.modeloTranscripcion)
    form.append('language', 'es')
    form.append('response_format', 'json')
    const t0 = Date.now()
    let ok = false
    try {
      const res = await fetch(`${this.cfg.openaiBase}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.openaiKey}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      })
      const txt = await res.text()
      if (!res.ok) throw new Error(`transcripción ${res.status}: ${txt.slice(0, 200)}`)
      ok = true
      return String(JSON.parse(txt).text ?? '').trim()
    } finally {
      const usd = ok ? (Math.max(1, segundos) / 60) * this.cfg.precioTranscripcionMin : 0
      this.db.registrarLlamada({ partida_id: partidaId, rol: 'transcripcion', modelo: this.cfg.modeloTranscripcion, tok_in: 0, tok_cache: 0, tok_out: 0, usd, ms: Date.now() - t0, ok }, this.ahora())
    }
  }
}
