import type { EstadoNpc, Mundo, Personaje, Universo, Reloj, PesoNpc, RolNpc } from './tipos.js'
import type { Fase } from './ritmo.js'
import { altaLugar, presupuestoNuevos, registrarNuevo } from './canon.js'
import { cantidadItems, darItem, esCaido, quitarItem, saludMaxEfectiva, tieneItem } from './personaje.js'
import { cargaMax } from './reglas.js'

/** Cambios que la IA puede PROPONER. El motor los valida y aplica; lo que no cumple las reglas se rechaza. */
export interface Cambios {
  salud?: { pj: string; delta: number; motivo?: string }[]
  objetos?: { pj: string; item?: string; nombre_libre?: string; delta: number }[]
  chapas?: { pj: string; delta: number; motivo?: string }[]
  rads?: { pj: string; delta: number }[]
  condiciones?: { pj: string; condicion: string; accion: 'poner' | 'quitar' }[]
  relojes?: { id: string; nombre?: string; delta: number; segmentos?: number }[]
  ubicacion?: string
  misiones?: { id: string; texto: string; estado?: 'activa' | 'cumplida' | 'fallida' }[]
  npcs?: {
    id: string; nombre: string; actitud?: string; nota?: string; estado?: EstadoNpc
    rol?: RolNpc; quiere?: string; teme?: string; voz?: string; publico?: string
    /** false = sale de escena; por defecto, un NPC que aparece en "cambios" está en escena. */
    presente?: boolean
    relacion?: { pj: string; delta: number; nota?: string }
  }[]
  lugares?: { nombre: string; rasgo?: string }[]
  /** Muerte de un personaje fuera de combate. La valida y aplica el juego (letalidad, confirmación). */
  muerte?: { pj: string; motivo?: string; elegida?: boolean }
}

export interface ResultadoCambios {
  /** Lo que ven los jugadores (en lenguaje natural). */
  aplicados: string[]
  /** Cambios que solo conoce el DJ (relojes): cuentan como "pasó algo" pero no se muestran. */
  internos: string[]
  rechazados: string[]
  relojesLlenos: string[]
  caidos: string[]
  /** Rechazos que la narración probablemente da por hechos: obligan a reparar el texto. */
  graves: string[]
  /** NPC nuevos que no se dieron de alta (sin presupuesto). */
  sinAlta: string[]
  /** NPC nuevos dados de alta. */
  altas: string[]
}

export interface OpcionesCambios {
  enCombate: boolean
  /** Con fase, el motor aplica la economía narrativa (presupuesto de NPC nuevos). */
  fase?: Fase
  turno?: number
  ronda?: number
}

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n))
const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24)
const RESERVADAS = ['caido', 'muerto']
const ROLES: RolNpc[] = ['antagonista', 'aliado', 'rival', 'informante', 'neutral', 'victima']
const MAX_NPCS = 40

/** "una_crecida_toxica" → "Una crecida tóxica" (sin tildes, pero legible). */
export function humano(id: string): string {
  const t = id.replace(/[_-]+/g, ' ').trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

const mayus = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function fraseEstadoNpc(nombre: string, estado: EstadoNpc): string {
  const n = mayus(nombre)
  return { vivo: `${n} sigue con vida`, herido: `${n} queda herido`, huido: `${n} se escapa`, muerto: `💀 ${n} muere` }[estado]
}

const ESTADOS_NPC: EstadoNpc[] = ['vivo', 'herido', 'muerto', 'huido']
export const MAX_MISIONES_ACTIVAS = 4

export function claveJugador(p: Personaje): string {
  return `P${p.id}`
}

export function buscarPj(pjs: Personaje[], ref: string): Personaje | undefined {
  const r = String(ref ?? '').trim().toLowerCase()
  return pjs.find((p) => claveJugador(p).toLowerCase() === r || p.ficha.nombre.toLowerCase() === r || String(p.id) === r)
}

export function aplicarCambios(u: Universo, mundo: Mundo, pjs: Personaje[], c: Cambios | undefined, opciones: OpcionesCambios): ResultadoCambios {
  const res: ResultadoCambios = { aplicados: [], internos: [], rechazados: [], relojesLlenos: [], caidos: [], graves: [], sinAlta: [], altas: [] }
  if (!c || typeof c !== 'object') return res
  const origen = (p: Personaje) => u.origenes.find((o) => o.id === p.ficha.origen)

  for (const s of c.salud ?? []) {
    const p = buscarPj(pjs, s.pj)
    if (!p || !p.vivo) { res.rechazados.push(`salud: personaje ${s.pj} inexistente`); continue }
    if (opciones.enCombate) {
      res.rechazados.push('salud: en combate el daño lo maneja el motor')
      res.graves.push(`en combate la salud de ${p.ficha.nombre} la cambia solo el motor (no narres heridas ni curas que no salieron de los botones)`)
      continue
    }
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
    // Objeto narrativo (fuera del catálogo): va a la mochila con su nombre, sin efecto de reglas.
    const libre = !o.item && typeof o.nombre_libre === 'string' ? o.nombre_libre.replace(/[<>:]/g, ' ').trim().slice(0, 40) : ''
    if (libre) {
      const id = `libre:${libre}`
      if (d > 0) {
        if (cantidadItems(p) + d > cargaMax(p.ficha, u)) { res.rechazados.push(`objeto: ${p.ficha.nombre} no tiene lugar para ${libre}`); continue }
        darItem(p, id, d)
        res.aplicados.push(`${p.ficha.nombre} recibe ${libre}`)
      } else if (d < 0 && tieneItem(p, id) && quitarItem(p, id, -d)) res.aplicados.push(`${p.ficha.nombre} pierde ${libre}`)
      continue
    }
    if (!o.item) { res.rechazados.push('objeto: falta el id o el nombre_libre'); continue }
    const item = o.item
    const def = u.objetos.find((x) => x.id === item) ?? u.armas.find((x) => x.id === item)
    if (d > 0) {
      if (!def) { res.rechazados.push(`objeto: "${o.item}" no existe en el catálogo`); continue }
      if (cantidadItems(p) + d > cargaMax(p.ficha, u)) { res.rechazados.push(`objeto: ${p.ficha.nombre} no tiene lugar para ${def.nombre}`); continue }
      darItem(p, def.id, d)
      res.aplicados.push(`${p.ficha.nombre} recibe ${def.nombre}${d > 1 ? ' ×' + d : ''}`)
    } else if (d < 0) {
      if (!tieneItem(p, item) || !quitarItem(p, item, -d)) { res.rechazados.push(`objeto: ${p.ficha.nombre} no tiene ${item}`); continue }
      res.aplicados.push(`${p.ficha.nombre} pierde ${def?.nombre ?? item}`)
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
      reloj = { id, nombre: (r.nombre?.trim() || humano(id)).slice(0, 40), segmentos: clamp(Math.trunc(r.segmentos ?? 6), 3, 8), llenos: 0 }
      mundo.relojes.push(reloj)
      res.internos.push(`nuevo reloj: ${reloj.nombre} (0/${reloj.segmentos})`)
    }
    const d = clamp(Math.trunc(Number(r.delta) || 0), -2, 2)
    if (d !== 0) {
      const antes = reloj.llenos
      reloj.llenos = clamp(reloj.llenos + d, 0, reloj.segmentos)
      if (reloj.llenos !== antes) res.internos.push(`reloj ${reloj.nombre}: ${reloj.llenos}/${reloj.segmentos}`)
      if (reloj.llenos >= reloj.segmentos && antes < reloj.segmentos) res.relojesLlenos.push(reloj.nombre)
    }
  }

  if (typeof c.ubicacion === 'string' && c.ubicacion.trim()) mundo.ubicacion = c.ubicacion.trim().slice(0, 80)

  for (const m of c.misiones ?? []) {
    const id = slug(m.id || m.texto || '')
    if (!id) continue
    const ex = mundo.misiones.find((x) => x.id === id)
    if (ex) {
      if (m.estado && m.estado !== ex.estado) {
        ex.estado = m.estado
        res.aplicados.push(`misión ${m.estado === 'cumplida' ? 'cumplida ✅' : m.estado === 'fallida' ? 'fallida ❌' : 'reabierta'}: ${ex.texto}`)
      }
      // La misión principal (la premisa del grupo) no se reescribe.
      if (m.texto && !ex.principal) ex.texto = m.texto.slice(0, 120)
    } else if (mundo.misiones.filter((x) => x.estado === 'activa' && !x.principal).length < MAX_MISIONES_ACTIVAS) {
      mundo.misiones.push({ id, texto: (m.texto ?? id).slice(0, 120), estado: m.estado ?? 'activa' })
    } else {
      res.rechazados.push('misiones: demasiadas abiertas, cerrá alguna antes')
    }
  }
  mundo.misiones = mundo.misiones.filter((m) => m.principal || m.estado === 'activa' || mundo.misiones.indexOf(m) >= mundo.misiones.length - 8)

  for (const n of c.npcs ?? []) {
    const id = slug(n.id || n.nombre || '')
    if (!id) continue
    const estado = ESTADOS_NPC.includes(n.estado as EstadoNpc) ? (n.estado as EstadoNpc) : undefined
    const ex = mundo.npcs.find((x) => x.id === id) ?? mundo.npcs.find((x) => n.nombre && x.nombre.toLowerCase() === n.nombre.toLowerCase())
    const nombre = (n.nombre ?? ex?.nombre ?? id).slice(0, 40)
    if (esNpcMuerto(mundo, nombre) && estado !== 'muerto') {
      res.rechazados.push(`npc: ${nombre} está muerto y no puede volver`)
      res.graves.push(`${nombre} está muerto: no puede aparecer, hablar ni actuar`)
      continue
    }
    const rol = ROLES.includes(n.rol as RolNpc) ? (n.rol as RolNpc) : undefined
    const texto = (v: unknown, k: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, k) : undefined)
    if (ex) {
      if (n.actitud) ex.actitud = n.actitud.slice(0, 30)
      if (n.nota) ex.nota = n.nota.slice(0, 80)
      if (rol && ex.peso !== 'principal') ex.rol = rol
      ex.quiere = ex.quiere || texto(n.quiere, 140)
      ex.teme = ex.teme || texto(n.teme, 100)
      ex.voz = ex.voz || texto(n.voz, 100)
      if (texto(n.publico, 140)) ex.publico = texto(n.publico, 140)
      // Un extra al que la IA le da deseo y voz pasa a secundario.
      if (ex.peso === 'extra' && ex.quiere && ex.voz) ex.peso = 'secundario'
      if (n.presente !== undefined || ex.presente !== undefined || opciones.turno !== undefined) ex.presente = n.presente !== false && estado !== 'muerto' && estado !== 'huido'
      if (opciones.turno !== undefined) ex.visto = opciones.turno
      ex.conocido = true
      if (estado && estado !== (ex.estado ?? 'vivo')) {
        ex.estado = estado
        if (estado === 'muerto') marcarNpcMuerto(mundo, ex.nombre, res)
        else res.aplicados.push(fraseEstadoNpc(ex.nombre, estado))
      }
      if (n.relacion) relacionar(ex, pjs, n.relacion, res)
    } else {
      // Economía narrativa: un NPC con nombre nuevo cuesta presupuesto.
      if (opciones.fase && presupuestoNuevos(mundo, opciones.fase, opciones.turno ?? 0, opciones.ronda ?? 0) <= 0 && estado !== 'muerto') {
        res.rechazados.push(`npc: no hay presupuesto para presentar a alguien nuevo (${nombre}) en esta fase; usá a un NPC que ya existe`)
        res.sinAlta.push(nombre)
        continue
      }
      const quiere = texto(n.quiere, 140)
      const voz = texto(n.voz, 100)
      const peso: PesoNpc = quiere && voz ? 'secundario' : 'extra'
      const nuevo = {
        id, nombre: mayus(nombre), actitud: (n.actitud ?? 'neutral').slice(0, 30), nota: (n.nota ?? '').slice(0, 80), estado: estado ?? 'vivo',
        peso, presente: n.presente !== false && estado !== 'muerto', conocido: true,
        ...(rol ? { rol } : {}), ...(quiere ? { quiere } : {}), ...(voz ? { voz } : {}),
        ...(texto(n.teme, 100) ? { teme: texto(n.teme, 100) } : {}), ...(texto(n.publico, 140) ? { publico: texto(n.publico, 140) } : {}),
        ...(opciones.turno !== undefined ? { visto: opciones.turno } : {}),
      }
      mundo.npcs.push(nuevo)
      res.altas.push(nuevo.nombre)
      if (opciones.fase) registrarNuevo(mundo, `npc: ${nuevo.nombre}`, opciones.turno ?? 0, opciones.ronda ?? 0)
      if (estado === 'muerto') marcarNpcMuerto(mundo, nombre, res)
      if (n.relacion) relacionar(nuevo, pjs, n.relacion, res)
      // El Canon no olvida a nadie importante: se descartan extras muertos o idos, después extras viejos.
      while (mundo.npcs.length > MAX_NPCS) {
        let i = mundo.npcs.findIndex((x) => x.peso !== 'principal' && (x.estado === 'muerto' || x.estado === 'huido'))
        if (i < 0) i = mundo.npcs.findIndex((x) => x.peso === 'extra')
        if (i < 0) i = mundo.npcs.findIndex((x) => x.peso !== 'principal')
        mundo.npcs.splice(Math.max(0, i), 1)
      }
    }
  }

  for (const l of c.lugares ?? []) {
    if (!l?.nombre) continue
    const ya = (mundo.lugares ?? []).some((x) => x.nombre.toLowerCase() === String(l.nombre).toLowerCase())
    if (ya) continue
    if (opciones.fase && presupuestoNuevos(mundo, opciones.fase, opciones.turno ?? 0, opciones.ronda ?? 0) <= 0) { res.rechazados.push(`lugar: sin presupuesto para "${l.nombre}"`); continue }
    const nuevo = altaLugar(mundo, l.nombre, l.rasgo)
    if (nuevo && opciones.fase) registrarNuevo(mundo, `lugar: ${nuevo.nombre}`, opciones.turno ?? 0, opciones.ronda ?? 0)
  }
  return res
}

function relacionar(npc: { relacion?: Record<string, { valor: number; nota: string }>; nombre: string }, pjs: Personaje[], r: { pj: string; delta: number; nota?: string }, res: ResultadoCambios): void {
  const p = buscarPj(pjs, r.pj)
  const d = clamp(Math.trunc(Number(r.delta) || 0), -1, 1)
  if (!p || d === 0) return
  npc.relacion ??= {}
  const k = claveJugador(p)
  const ant = npc.relacion[k]?.valor ?? 0
  npc.relacion[k] = { valor: clamp(ant + d, -2, 2), nota: (r.nota ?? npc.relacion[k]?.nota ?? '').slice(0, 80) }
  if (npc.relacion[k].valor !== ant) res.internos.push(`relación ${npc.nombre}–${p.ficha.nombre}: ${npc.relacion[k].valor}`)
}

export function esNpcMuerto(mundo: Mundo, nombre: string): boolean {
  return (mundo.muertos ?? []).some((m) => m.toLowerCase() === nombre.toLowerCase())
}

export function marcarNpcMuerto(mundo: Mundo, nombre: string, res?: Pick<ResultadoCambios, 'aplicados'>): void {
  mundo.muertos = mundo.muertos ?? []
  if (!esNpcMuerto(mundo, nombre)) {
    mundo.muertos.push(nombre)
    res?.aplicados.push(fraseEstadoNpc(nombre, 'muerto'))
  }
  const n = mundo.npcs.find((x) => x.nombre.toLowerCase() === nombre.toLowerCase())
  if (n) n.estado = 'muerto'
}

export function npcsVivos(mundo: Mundo) {
  return mundo.npcs.filter((n) => n.estado !== 'muerto' && n.estado !== 'huido')
}

/** NPC que la mesa conoce (para /resumen y /dj: nunca los que no aparecieron todavía). */
export function npcsConocidos(mundo: Mundo) {
  return mundo.npcs.filter((n) => n.conocido !== false)
}

export function mundoVacio(): Mundo {
  return { ubicacion: '', npcs: [], misiones: [], relojes: [], vinculos: [], impulso: 0, combate: null }
}
