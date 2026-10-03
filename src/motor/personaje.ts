import type { AtribId, Efecto, Ficha, ItemInv, Personaje, Universo } from './tipos.js'
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

export const MAX_EXTRAS_CREACION = 1
export const MAX_RASGOS_CREACION = 1
export const MAX_TARAS = 2
export const PUNTOS_POR_TARA = 2

// ------------------------------------------------------------------ extras y rasgos (efectos mecánicos)

export function efectosDe(u: Universo, f: Pick<Ficha, 'extras' | 'rasgos'>): Efecto[] {
  const ef: Efecto[] = []
  for (const id of f.extras ?? []) ef.push(...(u.extras?.find((x) => x.id === id)?.efectos ?? []))
  for (const id of f.rasgos ?? []) ef.push(...(u.rasgos?.find((x) => x.id === id)?.efectos ?? []))
  return ef
}

/** Suma de un efecto simple (salud, carga, suerte, prot, defensa, chapas). */
export function bono(u: Universo, f: Pick<Ficha, 'extras' | 'rasgos'>, tipo: 'salud' | 'carga' | 'suerte' | 'prot' | 'defensa' | 'chapas'): number {
  return efectosDe(u, f).reduce((s, e) => s + (e.tipo === tipo ? e.v : 0), 0)
}

/** Bono de daño según el tipo de arma (cuerpo a cuerpo o a distancia). */
export function bonoDanio(u: Universo, f: Pick<Ficha, 'extras' | 'rasgos'>, habilidad: string): number {
  const cc = habilidad === 'armas_cc' || habilidad === 'desarmado'
  return efectosDe(u, f).reduce((s, e) => s + (e.tipo === 'danio' && (e.grupo === 'todo' || (e.grupo === 'cc') === cc) ? e.v : 0), 0)
}

export function tarasDe(u: Universo, f: Pick<Ficha, 'rasgos'>): number {
  return (f.rasgos ?? []).filter((id) => u.rasgos?.find((x) => x.id === id)?.tara).length
}

/** Puntos de habilidad para repartir: los de siempre más los que dan las taras. */
export function puntosHabilidadTotal(u: Universo, f: Pick<Ficha, 'rasgos'>): number {
  return HAB_PUNTOS + PUNTOS_POR_TARA * tarasDe(u, f)
}

export function cumpleRequisito(u: Universo, attrs: Record<AtribId, number>, extraId: string): boolean {
  const e = u.extras?.find((x) => x.id === extraId)
  if (!e) return false
  return Object.entries(e.req ?? {}).every(([a, v]) => (attrs[a as AtribId] ?? 0) >= (v ?? 0))
}

export function suerteMax(u: Universo, p: Pick<Personaje, 'ficha'>): number {
  return Math.max(1, p.ficha.atributos.SUE + bono(u, p.ficha, 'suerte'))
}

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

export function puntosHabilidadLibres(hab: Record<string, number>, esp: string[], total = HAB_PUNTOS): number {
  return total - puntosHabilidadUsados(hab, esp)
}

export function cambiarAtributo(attrs: Record<AtribId, number>, a: AtribId, delta: 1 | -1): boolean {
  const nuevo = attrs[a] + delta
  if (nuevo < ATTR_MIN || nuevo > ATTR_MAX_CREACION) return false
  if (delta === 1 && puntosAtributoLibres(attrs) <= 0) return false
  attrs[a] = nuevo
  return true
}

export function cambiarHabilidad(hab: Record<string, number>, esp: string[], id: string, delta: 1 | -1, total = HAB_PUNTOS): boolean {
  const minimo = esp.includes(id) ? 2 : 0
  const nuevo = (hab[id] ?? 0) + delta
  if (nuevo < minimo || nuevo > HAB_MAX_CREACION) return false
  if (delta === 1 && puntosHabilidadLibres(hab, esp, total) <= 0) return false
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
export function validarReparto(u: Universo, f: Pick<Ficha, 'atributos' | 'habilidades' | 'especialidades'> & Partial<Pick<Ficha, 'extras' | 'rasgos'>>): string[] {
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
  const lib = puntosHabilidadLibres(f.habilidades, f.especialidades, puntosHabilidadTotal(u, f))
  if (lib > 0) err.push(`Te quedan ${lib} puntos de habilidad sin repartir`)
  if (lib < 0) err.push(`Te pasaste ${-lib} puntos de habilidad`)
  const extras = f.extras ?? []
  if (extras.length > MAX_EXTRAS_CREACION) err.push(`Al crear se elige ${MAX_EXTRAS_CREACION} Extra`)
  for (const id of extras) {
    if (!u.extras?.some((x) => x.id === id)) err.push(`Extra desconocido: ${id}`)
    else if (!cumpleRequisito(u, f.atributos, id)) err.push(`No cumplís el requisito de ${u.extras.find((x) => x.id === id)!.nombre}`)
  }
  const rasgos = f.rasgos ?? []
  if (rasgos.some((id) => !u.rasgos?.some((x) => x.id === id))) err.push('Rasgo desconocido')
  if (rasgos.length - tarasDe(u, f) > MAX_RASGOS_CREACION) err.push(`Al crear se elige ${MAX_RASGOS_CREACION} rasgo (más hasta ${MAX_TARAS} taras)`)
  if (tarasDe(u, f) > MAX_TARAS) err.push(`Máximo ${MAX_TARAS} taras`)
  return err
}

export function saludMaxBase(f: Ficha, u: Universo): number {
  const o = u.origenes.find((x) => x.id === f.origen)
  return Math.max(3, f.atributos.RES + f.atributos.SUE + (o?.saludExtra ?? 0) + bono(u, f, 'salud'))
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
  // Extras y rasgos: lo que toca atributos y habilidades queda en la ficha; lo demás se calcula al usarlo.
  for (const e of efectosDe(u, ficha)) {
    if (e.tipo === 'atr') ficha.atributos[e.id] = Math.max(ATTR_MIN, Math.min(ATTR_MAX, ficha.atributos[e.id] + e.v))
    if (e.tipo === 'hab') ficha.habilidades[e.id] = Math.max(0, Math.min(HAB_MAX, (ficha.habilidades[e.id] ?? 0) + e.v))
  }
  const inv: ItemInv[] = []
  const meter = (id: string) => {
    const it = inv.find((x) => x.id === id)
    if (it) it.n++
    else inv.push({ id, n: 1 })
  }
  o.kit.forEach(meter)
  meter(ficha.arma)
  if (ficha.arma2 && ficha.arma2 !== ficha.arma && u.armas.some((a) => a.id === ficha.arma2)) meter(ficha.arma2)
  const saludMax = saludMaxBase(ficha, u)
  return {
    ficha,
    salud: saludMax,
    salud_max: saludMax,
    penal_salud: 0,
    rads: 0,
    suerte: Math.max(1, ficha.atributos.SUE + bono(u, ficha, 'suerte')),
    chapas: Math.max(0, o.chapas + bono(u, ficha, 'chapas')),
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
