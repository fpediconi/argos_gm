export type VotoResultado = 'pasa' | 'falla' | 'abierta'

/**
 * Mayoría estricta de los votantes elegibles (todos menos el afectado).
 * - Sin votantes (juega uno solo): pasa.
 * - Falla apenas es imposible alcanzar la mayoría, o si cierra el plazo sin decisión.
 */
export function evaluarVotacion(votantes: number, si: number, no: number, cerrada: boolean): VotoResultado {
  if (votantes <= 0) return 'pasa'
  if (si > votantes / 2) return 'pasa'
  if (votantes - no <= votantes / 2) return 'falla'
  return cerrada ? 'falla' : 'abierta'
}
