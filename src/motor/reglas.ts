import type { AtribId, Ficha, PedidoTirada, Personaje, TiradaResuelta, Universo } from './tipos.js'
import { contarExitos, tirarDados, type Rng } from './dados.js'
import { bono, bonoDanio } from './personaje.js'

export const DADOS_BASE = 2
export const DADOS_MAX = 3

export function tnDe(p: Personaje, atributo: AtribId, habilidad: string): number {
  return (p.ficha.atributos[atributo] ?? 0) + (p.ficha.habilidades[habilidad] ?? 0)
}

export type Extra = 'ninguno' | 'suerte' | 'impulso'

/** Resuelve una prueba completa. `extra` suma 1d20 (máximo 3d20 en total). */
export function resolverPrueba(p: Personaje, pedido: PedidoTirada, extra: Extra, rng: Rng): TiradaResuelta {
  const tn = tnDe(p, pedido.atributo, pedido.habilidad)
  const n = Math.min(DADOS_MAX, DADOS_BASE + (extra === 'ninguno' ? 0 : 1))
  const dados = tirarDados(n, rng)
  const rango = p.ficha.habilidades[pedido.habilidad] ?? 0
  const esp = p.ficha.especialidades.includes(pedido.habilidad)
  const r = contarExitos(dados, tn, rango, esp)
  const dif = Math.max(1, pedido.dificultad)
  return {
    pedido,
    tn,
    dados,
    exitos: r.exitos,
    criticos: r.criticos,
    complicaciones: r.complicaciones,
    exito: r.exitos >= dif,
    impulso: Math.max(0, r.exitos - dif),
    extra,
  }
}

export function defensaDe(p: Personaje, u?: Universo): number {
  const base = (p.ficha.atributos.AGI ?? 0) >= 9 ? 2 : 1
  return Math.max(1, base + (u ? bono(u, p.ficha, 'defensa') : 0)) + (p.cubierto ? 1 : 0)
}

export function cargaMax(ficha: Ficha, u?: Universo): number {
  return 6 + Math.floor((ficha.atributos.FUE ?? 0) / 2) + (u ? bono(u, ficha, 'carga') : 0)
}

export function proteccionDe(p: Personaje, u: Universo): number {
  let mejor = 0
  for (const it of p.inventario) {
    const o = u.objetos.find((x) => x.id === it.id)
    if (o?.efecto === 'armadura') mejor = Math.max(mejor, o.valor)
  }
  return Math.max(0, mejor + bono(u, p.ficha, 'prot'))
}

/** Daño del arma principal con los extras y rasgos del personaje. */
export function danioArma(p: Personaje, u: Universo, arma = armaPrincipal(p, u)): number {
  return Math.max(1, arma.danio + bonoDanio(u, p.ficha, arma.habilidad))
}

export function armaPrincipal(p: Personaje, u: Universo) {
  return u.armas.find((a) => a.id === p.ficha.arma) ?? u.armas.find((a) => a.id === 'punos')!
}

export function nombreHab(u: Universo, id: string): string {
  return u.habilidades.find((h) => h.id === id)?.nombre ?? id
}

export function textoDificultad(d: number): string {
  return ['trivial', 'Normal', 'Difícil', 'Muy difícil', 'Épica'][Math.min(4, Math.max(0, d))] ?? 'Normal'
}

/**
 * Probabilidad exacta de alcanzar `dificultad` éxitos con `n` d20 contra `tn`
 * (con críticos de especialidad: un dado <= rango vale 2). Enumera 20^n casos (n <= 3).
 */
export function probabilidadExito(tn: number, rango: number, especialidad: boolean, dificultad: number, n = DADOS_BASE): number {
  const exitosDe = (d: number) => (d <= tn ? (especialidad && rango > 0 && d <= rango ? 2 : 1) : 0)
  let ok = 0
  let casos = 0
  const rec = (k: number, acum: number) => {
    if (k === 0) {
      casos++
      if (acum >= dificultad) ok++
      return
    }
    for (let d = 1; d <= 20; d++) rec(k - 1, acum + exitosDe(d))
  }
  rec(Math.max(1, Math.min(DADOS_MAX, n)), 0)
  return ok / casos
}

export type Semaforo = { emoji: string; texto: string }

export function semaforo(p: number): Semaforo {
  if (p >= 0.65) return { emoji: '🟩', texto: 'fácil' }
  if (p >= 0.35) return { emoji: '🟨', texto: 'parejas' }
  return { emoji: '🟥', texto: 'difícil' }
}
