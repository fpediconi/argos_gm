import { randomInt } from 'node:crypto'

/** Fuente de azar inyectable: en producción es criptográfica; en pruebas es una secuencia fija. */
export type Rng = () => number // devuelve 1..20

export const rngReal: Rng = () => randomInt(1, 21)

export function rngSecuencia(valores: number[]): Rng {
  let i = 0
  return () => {
    const v = valores[i % valores.length]
    i++
    return v
  }
}

export function tirarDados(n: number, rng: Rng): number[] {
  return Array.from({ length: n }, () => rng())
}

export interface ResultadoDados {
  exitos: number
  criticos: number
  complicaciones: number
}

/**
 * Cada dado <= TN es un éxito. Si la habilidad es especialidad, un dado <= rango de la
 * habilidad vale 2 éxitos (crítico). Un 20 es una complicación.
 */
export function contarExitos(dados: number[], tn: number, rango: number, especialidad: boolean): ResultadoDados {
  let exitos = 0
  let criticos = 0
  let complicaciones = 0
  for (const d of dados) {
    if (d <= tn) {
      if (especialidad && rango > 0 && d <= rango) {
        exitos += 2
        criticos++
      } else exitos += 1
    }
    if (d === 20) complicaciones++
  }
  return { exitos, criticos, complicaciones }
}
