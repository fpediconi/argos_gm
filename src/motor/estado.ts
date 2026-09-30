import type { Mundo, Personaje, Universo, Reloj } from './tipos.js'
import { cantidadItems, darItem, esCaido, quitarItem, saludMaxEfectiva, tieneItem } from './personaje.js'
import { cargaMax } from './reglas.js'

/** Cambios que la IA puede PROPONER. El motor los valida y aplica; lo que no cumple las reglas se rechaza. */
export interface Cambios {
  salud?: { pj: string; delta: number; motivo?: string }[]
  objetos?: { pj: string; item: string; delta: number }[]
  chapas?: { pj: string; delta: number; motivo?: string }[]
  rads?: { pj: string; delta: number }[]
  condiciones?: { pj: string; condicion: string; accion: 'poner' | 'quitar' }[]
  relojes?: { id: string; nombre?: string; delta: number; segmentos?: number }[]
  ubicacion?: string
  misiones?: { id: string; texto: string; estado?: 'activa' | 'cumplida' | 'fallida' }[]
  npcs?: { id: string; nombre: string; actitud?: string; nota?: string }[]
}

export interface ResultadoCambios {
  aplicados: string[]
  rechazados: string[]
  relojesLlenos: string[]
  caidos: string[]
}

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n))
const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24)
const RESERVADAS = ['caido', 'muerto']

export function claveJugador(p: Personaje): string {
  return `P${p.id}`
}

function buscarPj(pjs: Personaje[], ref: string): Personaje | undefined {
  const r = String(ref ?? '').trim().toLowerCase()
  return pjs.find((p) => claveJugador(p).toLowerCase() === r || p.ficha.nombre.toLowerCase() === r || String(p.id) === r)
}

export function aplicarCambios(u: Universo, mundo: Mundo, pjs: Personaje[], c: Cambios | undefined, opciones: { enCombate: boolean }): ResultadoCambios {
  const res: ResultadoCambios = { aplicados: [], rechazados: [], relojesLlenos: [], caidos: [] }
  if (!c || typeof c !== 'object') return res
  const origen = (p: Personaje) => u.origenes.find((o) => o.id === p.ficha.origen)

  for (const s of c.salud ?? []) {
    const p = buscarPj(pjs, s.pj)
    if (!p || !p.vivo) { res.rechazados.push(`salud: personaje ${s.pj} inexistente`); continue }
    if (opciones.enCombate) { res.rechazados.push('salud: en combate el daño lo maneja el motor'); continue }
    const d = clamp(Math.trunc(Number(s.delta) || 0), -6, 6)
    if (d === 0) continue
    const antes = p.salud
    p.salud = clamp(p.salud + d, 0, saludMaxEfectiva(p))
    res.aplicados.push(`${p.ficha.nombre} ${d > 0 ? '+' : ''}${p.salud - antes} salud${s.motivo ? ` (${s.motivo})` : ''}`)
    if (p.salud <= 0 && !esCaido(p)) { p.condiciones.push('caido'); res.caidos.push(p.ficha.nombre) }
    if (p.salud > 0 && esCaido(p)) p.condiciones = p.condiciones.filter((x) => x !== 'caido')
  }

  for (const o of c.objetos ?? []) {
    const p = buscarPj(pjs, o.pj)
    if (!p) { res.rechazados.push(`objeto: personaje ${o.pj} inexistente`); continue }
    const d = clamp(Math.trunc(Number(o.delta) || 0), -3, 2)
    const def = u.objetos.find((x) => x.id === o.item) ?? u.armas.find((x) => x.id === o.item)
    if (d > 0) {
      if (!def) { res.rechazados.push(`objeto: "${o.item}" no existe en el catálogo`); continue }
      if (cantidadItems(p) + d > cargaMax(p.ficha)) { res.rechazados.push(`objeto: ${p.ficha.nombre} no tiene lugar para ${def.nombre}`); continue }
      darItem(p, def.id, d)
      res.aplicados.push(`${p.ficha.nombre} recibe ${def.nombre}${d > 1 ? ' ×' + d : ''}`)
    } else if (d < 0) {
      if (!tieneItem(p, o.item) || !quitarItem(p, o.item, -d)) { res.rechazados.push(`objeto: ${p.ficha.nombre} no tiene ${o.item}`); continue }
      res.aplicados.push(`${p.ficha.nombre} pierde ${def?.nombre ?? o.item}`)
    }
  }

  for (const ch of c.chapas ?? []) {
    const p = buscarPj(pjs, ch.pj)
    if (!p) { res.rechazados.push(`chapas: personaje ${ch.pj} inexistente`); continue }
    const d = clamp(Math.trunc(Number(ch.delta) || 0), -40, 40)
    if (d === 0) continue
    const antes = p.chapas
    p.chapas = Math.max(0, p.chapas + d)
    res.aplicados.push(`${p.ficha.nombre} ${p.chapas - antes >= 0 ? '+' : ''}${p.chapas - antes} chapas`)
  }

  for (const r of c.rads ?? []) {
    const p = buscarPj(pjs, r.pj)
    if (!p) { res.rechazados.push(`rads: personaje ${r.pj} inexistente`); continue }
    if (origen(p)?.radInmune) { res.rechazados.push(`rads: ${p.ficha.nombre} es inmune`); continue }
    const d = clamp(Math.trunc(Number(r.delta) || 0), -3, 3)
    if (d === 0) continue
    p.rads = clamp(p.rads + d, 0, Math.max(0, p.salud_max - 1))
    p.salud = Math.min(p.salud, saludMaxEfectiva(p))
    res.aplicados.push(`${p.ficha.nombre} ${d > 0 ? '+' : ''}${d} rads`)
  }

  for (const co of c.condiciones ?? []) {
    const p = buscarPj(pjs, co.pj)
    const nombre = String(co.condicion ?? '').trim().toLowerCase().slice(0, 24)
    if (!p || !nombre) { res.rechazados.push('condición inválida'); continue }
    if (RESERVADAS.includes(nombre)) { res.rechazados.push(`condición "${nombre}" la maneja el motor`); continue }
    if (co.accion === 'quitar') p.condiciones = p.condiciones.filter((x) => x !== nombre)
    else if (!p.condiciones.includes(nombre) && p.condiciones.length < 4) p.condiciones.push(nombre)
    else continue
    res.aplicados.push(`${p.ficha.nombre}: ${co.accion === 'quitar' ? 'ya no está' : 'queda'} ${nombre}`)
  }

  for (const r of c.relojes ?? []) {
    const id = slug(r.id || r.nombre || '')
    if (!id) continue
    let reloj: Reloj | undefined = mundo.relojes.find((x) => x.id === id)
    if (!reloj) {
      if (mundo.relojes.length >= 3) { res.rechazados.push('relojes: máximo 3 a la vez'); continue }
      reloj = { id, nombre: (r.nombre ?? id).slice(0, 40), segmentos: clamp(Math.trunc(r.segmentos ?? 6), 3, 8), llenos: 0 }
      mundo.relojes.push(reloj)
      res.aplicados.push(`nuevo reloj: ${reloj.nombre} (0/${reloj.segmentos})`)
    }
    const d = clamp(Math.trunc(Number(r.delta) || 0), -2, 2)
    if (d !== 0) {
      const antes = reloj.llenos
      reloj.llenos = clamp(reloj.llenos + d, 0, reloj.segmentos)
      if (reloj.llenos !== antes) res.aplicados.push(`reloj ${reloj.nombre}: ${reloj.llenos}/${reloj.segmentos}`)
      if (reloj.llenos >= reloj.segmentos && antes < reloj.segmentos) res.relojesLlenos.push(reloj.nombre)
    }
  }

  if (typeof c.ubicacion === 'string' && c.ubicacion.trim()) mundo.ubicacion = c.ubicacion.trim().slice(0, 80)

  for (const m of c.misiones ?? []) {
    const id = slug(m.id || m.texto || '')
    if (!id) continue
    const ex = mundo.misiones.find((x) => x.id === id)
    if (ex) {
      if (m.estado) ex.estado = m.estado
      if (m.texto) ex.texto = m.texto.slice(0, 120)
    } else if (mundo.misiones.filter((x) => x.estado === 'activa').length < 6) {
      mundo.misiones.push({ id, texto: (m.texto ?? id).slice(0, 120), estado: m.estado ?? 'activa' })
    }
  }
  mundo.misiones = mundo.misiones.filter((m) => m.estado === 'activa' || mundo.misiones.indexOf(m) >= mundo.misiones.length - 8)

  for (const n of c.npcs ?? []) {
    const id = slug(n.id || n.nombre || '')
    if (!id) continue
    const ex = mundo.npcs.find((x) => x.id === id)
    if (ex) {
      if (n.actitud) ex.actitud = n.actitud.slice(0, 30)
      if (n.nota) ex.nota = n.nota.slice(0, 80)
    } else {
      mundo.npcs.push({ id, nombre: (n.nombre ?? id).slice(0, 40), actitud: (n.actitud ?? 'neutral').slice(0, 30), nota: (n.nota ?? '').slice(0, 80) })
      if (mundo.npcs.length > 8) mundo.npcs.shift()
    }
  }
  return res
}

export function mundoVacio(): Mundo {
  return { ubicacion: '', npcs: [], misiones: [], relojes: [], vinculos: [], impulso: 0, combate: null }
}
