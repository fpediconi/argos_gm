import type { AtribId, Ficha, PedidoTirada, Personaje, TiradaResuelta, Universo } from './tipos.js'
import { contarExitos, tirarDados, type Rng } from './dados.js'

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

export function defensaDe(p: Personaje): number {
  const base = (p.ficha.atributos.AGI ?? 0) >= 9 ? 2 : 1
  return base + (p.cubierto ? 1 : 0)
}

export function cargaMax(ficha: Ficha): number {
  return 6 + Math.floor((ficha.atributos.FUE ?? 0) / 2)
}

export function proteccionDe(p: Personaje, u: Universo): number {
  let mejor = 0
  for (const it of p.inventario) {
    const o = u.objetos.find((x) => x.id === it.id)
    if (o?.efecto === 'armadura') mejor = Math.max(mejor, o.valor)
  }
  return mejor
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
