import type { Config } from './config.js'
import type { Repos } from './db/repos.js'
import type { Cerebro } from './dj/cerebro.js'
import type { Oido } from './dj/oido.js'
import type { ApiTelegram } from './telegram/api.js'
import type { Rng } from './motor/dados.js'
import type { Universo } from './motor/tipos.js'
import type { Colas } from './util.js'

export interface Reloj { ahora(): number }

/** Todo lo que los módulos necesitan, inyectable para poder probar sin red ni reloj real. */
export interface Ctx {
  cfg: Config
  db: Repos
  api: ApiTelegram
  cerebro: Cerebro
  /** Transcripción de audios (opcional: sin ella, los audios se rechazan con aviso). */
  oido?: Oido
  reloj: Reloj
  rng: Rng
  u: Universo
  colas: Colas
  botUsername: string
  botId: number
  log: (...a: unknown[]) => void
}
