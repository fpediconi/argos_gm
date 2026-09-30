import { existsSync } from 'node:fs'

try {
  if (existsSync('.env')) process.loadEnvFile('.env')
} catch {
  /* sin .env: se usan las variables del entorno */
}

const env = (k: string, def = '') => process.env[k] ?? def
const num = (k: string, def: number) => {
  const v = Number(process.env[k])
  return Number.isFinite(v) && process.env[k] !== undefined && process.env[k] !== '' ? v : def
}

export interface Precio { in: number; cache: number; out: number } // USD por millón de tokens

export interface Config {
  telegramToken: string
  adminId: string
  openaiKey: string
  openaiBase: string
  modelos: { narrador: string; util: string; guionista: string }
  precios: { narrador: Precio; util: Precio; guionista: Precio }
  reasoningEffort: string
  maxSalidaNarrador: number
  presupuestoPartidaUsd: number
  presupuestoGlobalUsd: number
  dbPath: string
  tzMin: number
  puerto: number
  fusibleOff: boolean
}

export function cargarConfig(): Config {
  return {
    telegramToken: env('TELEGRAM_TOKEN'),
    adminId: env('TELEGRAM_ADMIN_ID'),
    openaiKey: env('OPENAI_API_KEY'),
    openaiBase: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    modelos: {
      narrador: env('MODELO_NARRADOR', 'gpt-5.4-mini'),
      util: env('MODELO_UTIL', 'gpt-5.4-nano'),
      guionista: env('MODELO_GUIONISTA', 'gpt-5.4-mini'),
    },
    // Precios de referencia: verificar en https://openai.com/api/pricing y ajustar por .env
    precios: {
      narrador: { in: num('PRECIO_NARRADOR_IN', 0.75), cache: num('PRECIO_NARRADOR_CACHE', 0.075), out: num('PRECIO_NARRADOR_OUT', 4.5) },
      util: { in: num('PRECIO_UTIL_IN', 0.2), cache: num('PRECIO_UTIL_CACHE', 0.02), out: num('PRECIO_UTIL_OUT', 1.25) },
      guionista: { in: num('PRECIO_GUIONISTA_IN', 0.75), cache: num('PRECIO_GUIONISTA_CACHE', 0.075), out: num('PRECIO_GUIONISTA_OUT', 4.5) },
    },
    reasoningEffort: env('OPENAI_REASONING_EFFORT', 'low'),
    maxSalidaNarrador: num('MAX_SALIDA_NARRADOR', 1500),
    presupuestoPartidaUsd: num('PRESUPUESTO_PARTIDA_USD', 0.5),
    presupuestoGlobalUsd: num('PRESUPUESTO_GLOBAL_USD', 2),
    dbPath: env('DB_PATH', './data/dj.sqlite'),
    tzMin: num('TZ_OFFSET_MIN', -180),
    puerto: num('PUERTO', 3100),
    fusibleOff: env('FUSIBLE_OFF') === 'true',
  }
}
