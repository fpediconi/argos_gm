import type { Jugador } from './tipos.js'

const H = 3_600_000
const MIN10 = 10 * 60_000

/** Hora local (0-23) de un instante, con offset fijo en minutos (Argentina = -180, sin horario de verano). */
export function horaLocal(ms: number, tzMin: number): number {
  const d = new Date(ms + tzMin * 60_000)
  return d.getUTCHours()
}

export function enSilencio(ms: number, silencio: [number, number] | null, tzMin: number): boolean {
  if (!silencio) return false
  const [ini, fin] = silencio
  const h = horaLocal(ms, tzMin)
  return ini <= fin ? h >= ini && h < fin : h >= ini || h < fin
}

export const SIN_LIMITE = Number.MAX_SAFE_INTEGER

/** Instante en que vence un plazo. El reloj no corre durante las horas de silencio. */
export function vencimiento(desdeMs: number, plazoH: number, silencio: [number, number] | null, tzMin: number): number {
  if (plazoH <= 0) return SIN_LIMITE
  let restante = plazoH * H
  let t = desdeMs
  // Cota dura por seguridad: 30 días de pasos de 10 minutos.
  for (let i = 0; i < 30 * 24 * 6 && restante > 0; i++) {
    if (!enSilencio(t, silencio, tzMin)) restante -= MIN10
    t += MIN10
  }
  return t
}

export interface SiguienteTurno {
  jugador: Jugador
  saltados: Jugador[]
  nuevaRonda: boolean
}

/**
 * Elige quién juega después de `actualId`. Los ausentes y dormidos se saltan (y se devuelven
 * para poder avisarlo). Devuelve null si no hay nadie disponible.
 */
export function siguienteJugador(
  jugadores: Jugador[],
  actualId: number | null,
  puede: (j: Jugador) => boolean = () => true,
): SiguienteTurno | null {
  const orden = [...jugadores].filter((j) => j.estado !== 'fuera' && j.estado !== 'creando').sort((a, b) => a.orden - b.orden)
  if (orden.length === 0) return null
  const idx = actualId === null ? -1 : orden.findIndex((j) => j.id === actualId)
  const saltados: Jugador[] = []
  const n = orden.length
  for (let paso = 1; paso <= n; paso++) {
    const raw = idx + paso
    const j = orden[raw % n]
    if ((j.estado === 'activo' || j.estado === 'listo') && puede(j)) {
      return { jugador: j, saltados, nuevaRonda: actualId === null || (idx >= 0 && raw >= n) }
    }
    saltados.push(j)
  }
  return null
}
