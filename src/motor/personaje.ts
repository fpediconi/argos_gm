import type { AtribId, Ficha, ItemInv, Personaje, Universo } from './tipos.js'
import { ATRIBUTOS } from './tipos.js'

// --- Reglas de creación (ver PROYECTO-DJ.md §4) ---
export const ATTR_BASE = 5
export const ATTR_TOTAL = 40 // 7 atributos: 35 base + 5 puntos a repartir
export const ATTR_MIN = 4
export const ATTR_MAX_CREACION = 8
export const ATTR_MAX = 10
export const HAB_MAX = 6
export const HAB_MAX_CREACION = 3
export const HAB_PUNTOS = 8
export const N_ESPECIALIDADES = 3

export function atributosBase(): Record<AtribId, number> {
  return Object.fromEntries(ATRIBUTOS.map((a) => [a, ATTR_BASE])) as Record<AtribId, number>
}

export function habilidadesVacias(u: Universo): Record<string, number> {
  return Object.fromEntries(u.habilidades.map((h) => [h.id, 0]))
}

export function puntosAtributoLibres(attrs: Record<AtribId, number>): number {
  return ATTR_TOTAL - ATRIBUTOS.reduce((s, a) => s + (attrs[a] ?? 0), 0)
}

/** Puntos gastados: cada habilidad cuenta su rango menos los 2 que regala la especialidad. */
export function puntosHabilidadUsados(hab: Record<string, number>, esp: string[]): number {
  return Object.entries(hab).reduce((s, [id, r]) => s + Math.max(0, r - (esp.includes(id) ? 2 : 0)), 0)
}

export function puntosHabilidadLibres(hab: Record<string, number>, esp: string[]): number {
  return HAB_PUNTOS - puntosHabilidadUsados(hab, esp)
}

export function cambiarAtributo(attrs: Record<AtribId, number>, a: AtribId, delta: 1 | -1): boolean {
  const nuevo = attrs[a] + delta
  if (nuevo < ATTR_MIN || nuevo > ATTR_MAX_CREACION) return false
  if (delta === 1 && puntosAtributoLibres(attrs) <= 0) return false
  attrs[a] = nuevo
  return true
}

export function cambiarHabilidad(hab: Record<string, number>, esp: string[], id: string, delta: 1 | -1): boolean {
  const minimo = esp.includes(id) ? 2 : 0
  const nuevo = (hab[id] ?? 0) + delta
  if (nuevo < minimo || nuevo > HAB_MAX_CREACION) return false
  if (delta === 1 && puntosHabilidadLibres(hab, esp) <= 0) return false
  hab[id] = nuevo
  return true
}

/** Activa/desactiva una especialidad. Devuelve false si no se puede (ya hay 3 o no alcanzan los puntos). */
export function alternarEspecialidad(hab: Record<string, number>, esp: string[], id: string): boolean {
  const i = esp.indexOf(id)
  if (i >= 0) {
    esp.splice(i, 1)
    hab[id] = Math.max(0, (hab[id] ?? 0) - 2)
    return true
  }
  if (esp.length >= N_ESPECIALIDADES) return false
  esp.push(id)
  hab[id] = Math.max(hab[id] ?? 0, 2)
  return true
}

export function aplicarArquetipo(u: Universo, id: string) {
  const a = u.arquetipos.find((x) => x.id === id)
  if (!a) throw new Error(`Arquetipo desconocido: ${id}`)
  const hab = habilidadesVacias(u)
  const esp = [...a.especialidades]
  for (const e of esp) hab[e] = 2
  for (const [h, p] of Object.entries(a.puntos)) hab[h] = (hab[h] ?? 0) + p
  return { atributos: { ...a.atributos }, habilidades: hab, especialidades: esp }
}

/** Errores de una ficha antes de aplicar el origen (vacío = válida). */
export function validarReparto(u: Universo, f: Pick<Ficha, 'atributos' | 'habilidades' | 'especialidades'>): string[] {
  const err: string[] = []
  for (const a of ATRIBUTOS) {
    const v = f.atributos[a]
    if (v === undefined || v < ATTR_MIN || v > ATTR_MAX_CREACION) err.push(`${a} fuera de rango (${ATTR_MIN}-${ATTR_MAX_CREACION})`)
  }
  const libres = puntosAtributoLibres(f.atributos)
  if (libres > 0) err.push(`Te quedan ${libres} puntos de atributo sin repartir`)
  if (libres < 0) err.push(`Te pasaste ${-libres} puntos de atributo`)
  if (f.especialidades.length !== N_ESPECIALIDADES) err.push(`Tenés que elegir ${N_ESPECIALIDADES} especialidades`)
  for (const h of u.habilidades) {
    const r = f.habilidades[h.id] ?? 0
    if (r > HAB_MAX_CREACION) err.push(`${h.nombre} supera ${HAB_MAX_CREACION} al crear`)
    if (f.especialidades.includes(h.id) && r < 2) err.push(`${h.nombre} es especialidad y debería ser al menos 2`)
  }
  const lib = puntosHabilidadLibres(f.habilidades, f.especialidades)
  if (lib > 0) err.push(`Te quedan ${lib} puntos de habilidad sin repartir`)
  if (lib < 0) err.push(`Te pasaste ${-lib} puntos de habilidad`)
  return err
}

export function saludMaxBase(f: Ficha, u: Universo): number {
  const o = u.origenes.find((x) => x.id === f.origen)
  return f.atributos.RES + f.atributos.SUE + (o?.saludExtra ?? 0)
}

/** Convierte una ficha completa (ya con el reparto) en un personaje jugable, aplicando el origen. */
export function construirPersonaje(u: Universo, fichaBase: Ficha): Omit<Personaje, 'id' | 'partida_id' | 'jugador_id'> {
  const o = u.origenes.find((x) => x.id === fichaBase.origen)
  if (!o) throw new Error(`Origen desconocido: ${fichaBase.origen}`)
  const ficha: Ficha = JSON.parse(JSON.stringify(fichaBase))
  for (const [a, d] of Object.entries(o.atributos) as [AtribId, number][]) {
    ficha.atributos[a] = Math.min(ATTR_MAX, ficha.atributos[a] + d)
  }
  for (const [h, d] of Object.entries(o.habilidades)) {
    ficha.habilidades[h] = Math.min(HAB_MAX, (ficha.habilidades[h] ?? 0) + d)
  }
  const inv: ItemInv[] = []
  const meter = (id: string) => {
    const it = inv.find((x) => x.id === id)
    if (it) it.n++
    else inv.push({ id, n: 1 })
  }
  o.kit.forEach(meter)
  meter(ficha.arma)
  const saludMax = saludMaxBase(ficha, u)
  return {
    ficha,
    salud: saludMax,
    salud_max: saludMax,
    penal_salud: 0,
    rads: 0,
    suerte: ficha.atributos.SUE,
    chapas: o.chapas,
    inventario: inv,
    condiciones: [],
    trasfondo: '',
    gancho: '',
    vivo: true,
    cubierto: false,
  }
}

export function saludMaxEfectiva(p: Personaje): number {
  return Math.max(1, p.salud_max - p.penal_salud - p.rads)
}

export function esCaido(p: Personaje): boolean {
  return p.condiciones.includes('caido')
}

export function puedeSubirAtributo(capitulo: number): boolean {
  return capitulo % 2 === 0
}

export function subirHabilidad(p: Personaje, id: string): boolean {
  const r = p.ficha.habilidades[id] ?? 0
  if (r >= HAB_MAX) return false
  p.ficha.habilidades[id] = r + 1
  return true
}

export function subirAtributo(p: Personaje, a: AtribId): boolean {
  if (p.ficha.atributos[a] >= ATTR_MAX) return false
  p.ficha.atributos[a]++
  if (a === 'RES' || a === 'SUE') p.salud_max++
  if (a === 'SUE') p.suerte++
  return true
}

export function tieneItem(p: Personaje, id: string): boolean {
  return p.inventario.some((i) => i.id === id && i.n > 0)
}

export function cantidadItems(p: Personaje): number {
  return p.inventario.reduce((s, i) => s + i.n, 0)
}

export function darItem(p: Personaje, id: string, n = 1): void {
  const it = p.inventario.find((i) => i.id === id)
  if (it) it.n += n
  else p.inventario.push({ id, n })
}

export function quitarItem(p: Personaje, id: string, n = 1): boolean {
  const it = p.inventario.find((i) => i.id === id)
  if (!it || it.n < n) return false
  it.n -= n
  if (it.n <= 0) p.inventario.splice(p.inventario.indexOf(it), 1)
  return true
}
