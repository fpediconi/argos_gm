import type { Ctx } from '../ctx.js'
import { inicioDelDia } from '../util.js'

export type NivelPresupuesto = 'ok' | 'aviso' | 'economico' | 'parado'

export interface EstadoPresupuesto {
  nivel: NivelPresupuesto
  gastoPartida: number
  gastoGlobal: number
  topePartida: number
  topeGlobal: number
}

/**
 * Fusible: 80% avisa, 100% pasa a modo económico (modelo barato, salida corta), 200% corta.
 * Se calcula con lo gastado desde las 00:00 hora local.
 */
export function estadoPresupuesto(ctx: Ctx, partidaId: number | null): EstadoPresupuesto {
  const desde = inicioDelDia(ctx.reloj.ahora(), ctx.cfg.tzMin)
  const gastoPartida = partidaId === null ? 0 : ctx.db.gastoDesde(desde, partidaId)
  const gastoGlobal = ctx.db.gastoDesde(desde)
  const topePartida = ctx.cfg.presupuestoPartidaUsd
  const topeGlobal = ctx.cfg.presupuestoGlobalUsd
  const rp = topePartida > 0 ? gastoPartida / topePartida : 0
  const rg = topeGlobal > 0 ? gastoGlobal / topeGlobal : 0
  const r = Math.max(rp, rg)
  let nivel: NivelPresupuesto = 'ok'
  if (!ctx.cfg.fusibleOff) {
    if (r >= 2) nivel = 'parado'
    else if (r >= 1) nivel = 'economico'
    else if (r >= 0.8) nivel = 'aviso'
  }
  return { nivel, gastoPartida, gastoGlobal, topePartida, topeGlobal }
}
