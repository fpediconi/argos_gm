import type { ConfigPartida, Duracion, Partida, Ritmo } from './tipos.js'
import type { Rng } from './dados.js'

/**
 * Director de ritmo: el motor cuenta los turnos y le dice al DJ en qué momento de la historia está.
 * La IA narra; cuándo escala, cuándo pasa algo y cuándo termina lo decide el código.
 */

export const DURACIONES: Record<Duracion, { nombre: string; capitulos: number; rondas: number; etiqueta: string }> = {
  corta: { nombre: 'Sesión corta', capitulos: 1, rondas: 4, etiqueta: 'Sesión corta (1 capítulo, ~4 rondas)' },
  oneshot: { nombre: 'One-shot', capitulos: 1, rondas: 6, etiqueta: 'One-shot (1 capítulo, ~6 rondas)' },
  mini: { nombre: 'Mini-campaña', capitulos: 4, rondas: 5, etiqueta: 'Mini-campaña (4 capítulos de ~5 rondas)' },
  abierta: { nombre: 'Campaña abierta', capitulos: 0, rondas: 6, etiqueta: 'Campaña abierta (sin final fijo, /final para cerrar)' },
}

export function totalCapitulos(cfg: ConfigPartida): number {
  return (DURACIONES[cfg.duracion] ?? DURACIONES.oneshot).capitulos
}

export function objetivoTurnos(cfg: ConfigPartida, jugadores: number): number {
  const d = DURACIONES[cfg.duracion] ?? DURACIONES.oneshot
  return d.rondas * Math.max(1, jugadores)
}

/** Cada cuántos turnos el motor fuerza un evento concreto. */
export function intervaloEvento(objetivo: number): number {
  return Math.max(2, Math.floor(objetivo / 4))
}

export function ritmoNuevo(cfg: ConfigPartida, jugadores: number, secretosRevelados = 0): Ritmo {
  const objetivo = objetivoTurnos(cfg, jugadores)
  return { turnos: 0, objetivo, proximoEvento: intervaloEvento(objetivo), secretosRevelados }
}

/** Asegura que la partida tenga ritmo (partidas creadas antes de esta versión). */
export function ritmoDe(p: Partida, jugadores: number): Ritmo {
  if (!p.mundo.ritmo) p.mundo.ritmo = ritmoNuevo(p.config, jugadores)
  return p.mundo.ritmo
}

/** Recalcula el objetivo si entra o sale gente, sin perder lo jugado. */
export function recalcularObjetivo(r: Ritmo, cfg: ConfigPartida, jugadores: number): void {
  r.objetivo = Math.max(r.turnos + 1, objetivoTurnos(cfg, jugadores))
}

export type Fase = 'planteo' | 'escalada' | 'giro' | 'climax'

export const FASES: Record<Fase, { nombre: string; emoji: string; instruccion: string }> = {
  planteo: {
    nombre: 'Planteo', emoji: '🌅',
    instruccion: 'Presentá el problema, los lugares y los NPC. Que los jugadores entiendan qué está en juego y tengan algo concreto que perseguir.',
  },
  escalada: {
    nombre: 'Escalada', emoji: '🔥',
    instruccion: 'Subí la presión: cada escena cuesta algo (tiempo, recursos, un aliado). Los obstáculos son concretos, no rumores.',
  },
  giro: {
    nombre: 'Giro', emoji: '🌀',
    instruccion: 'Revelá algo que cambie la situación: un secreto, una traición o una verdad sobre la amenaza. El plan del grupo tiene que ajustarse.',
  },
  climax: {
    nombre: 'Clímax', emoji: '⚡',
    instruccion: 'La amenaza está acá. Cada turno tiene que haber un enfrentamiento o una decisión irreversible. Nada de preparación: pasan cosas.',
  },
}

export function limite(r: Ritmo): number {
  return r.tope !== undefined ? Math.min(r.tope, r.objetivo) : r.objetivo
}

export function progreso(r: Ritmo): number {
  return r.turnos / Math.max(1, limite(r))
}

export function faseDe(r: Ritmo): Fase {
  if (r.tope !== undefined || r.climaxForzado) return 'climax'
  const x = progreso(r)
  if (x < 0.25) return 'planteo'
  if (x < 0.6) return 'escalada'
  if (x < 0.75) return 'giro'
  return 'climax'
}

export function turnosRestantes(r: Ritmo): number {
  return Math.max(0, limite(r) - r.turnos)
}

export function esCapituloFinal(p: Partida): boolean {
  const total = totalCapitulos(p.config)
  return !!p.mundo.ritmo?.finalPedido || (total > 0 && p.capitulo >= total)
}

/** Acto del guion (1 a 3) según el avance de toda la historia. */
export function actoActual(p: Partida): number {
  const r = p.mundo.ritmo
  const total = totalCapitulos(p.config)
  if (!r) return 1
  if (r.finalPedido) return 3
  if (total === 1) {
    const f = faseDe(r)
    return f === 'planteo' ? 1 : f === 'climax' ? 3 : 2
  }
  if (total === 0) return Math.min(3, p.capitulo)
  const global = (p.capitulo - 1 + Math.min(1, progreso(r))) / total
  return global < 0.25 ? 1 : global < 0.75 ? 2 : 3
}

/** Salta directo al clímax (reloj de amenaza lleno): quedan ~25 % de los turnos, mínimo 2. */
export function forzarClimax(r: Ritmo): void {
  if (r.climaxForzado) return
  r.climaxForzado = true
  r.objetivo = Math.min(r.objetivo, r.turnos + Math.max(2, Math.ceil(r.objetivo * 0.25)))
}

/**
 * Registra un turno narrado. Devuelve true si con este turno se alcanzó el límite
 * (el próximo turno es el desenlace del capítulo).
 */
export function registrarTurno(r: Ritmo): boolean {
  r.turnos++
  if (!r.cierrePendiente && r.turnos >= limite(r)) {
    r.cierrePendiente = true
    return true
  }
  return false
}

/** Si la IA quiere cerrar el capítulo, solo se acepta a partir del Giro. */
export function puedeCerrarAntes(r: Ritmo): boolean {
  return progreso(r) >= 0.6
}

// ------------------------------------------------------------------ eventos obligatorios

export type TipoEvento = 'emboscada' | 'traicion' | 'descubrimiento' | 'perdida' | 'faccion' | 'amenaza'

export interface Evento { tipo: TipoEvento; instruccion: string; avanzaAmenaza: number }

interface DatosEvento {
  encuentros: string[]
  bestiario: string[]
  npcs: { nombre: string; secreto: string }[]
  npcsPresentes: string[]
  secretos: string[]
  secretosRevelados: number
  facciones: { nombre: string; quiere: string }[]
  amenaza: string
}

const elegir = <T>(xs: T[], rng: Rng): T => xs[(rng() - 1) % xs.length]

/** Sortea un evento concreto con material del guion. */
export function sortearEvento(d: DatosEvento, rng: Rng, fase: Fase): Evento {
  const tipos: TipoEvento[] = ['emboscada', 'perdida', 'amenaza']
  if (d.npcs.some((n) => n.nombre)) tipos.push('traicion')
  if (d.secretos.length > d.secretosRevelados) tipos.push('descubrimiento', 'descubrimiento')
  if (d.facciones.some((f) => f.nombre)) tipos.push('faccion')
  if (fase === 'climax') tipos.push('emboscada', 'amenaza')
  const tipo = elegir(tipos, rng)
  switch (tipo) {
    case 'emboscada': {
      const pool = d.encuentros.filter((e) => d.bestiario.includes(e))
      const enemigo = pool.length ? elegir(pool, rng) : elegir(d.bestiario, rng)
      return { tipo, avanzaAmenaza: 0, instruccion: `EMBOSCADA: los atacan ahora mismo. Usá "combate" con enemigos "${enemigo}" (cantidad acorde al grupo). No es una amenaza a lo lejos: el primer golpe ya está en el aire.` }
    }
    case 'traicion': {
      const presentes = d.npcs.filter((n) => d.npcsPresentes.some((p) => p.toLowerCase() === n.nombre.toLowerCase()))
      const n = elegir(presentes.length ? presentes : d.npcs.filter((x) => x.nombre), rng)
      const secreto = n.secreto ? ` según su secreto ("${n.secreto}")` : ''
      return { tipo, avanzaAmenaza: 0, instruccion: `GIRO DE NPC: ${n.nombre} actúa${secreto}: traiciona, huye con algo o revela su verdadera cara. Mostralo en acción, con consecuencias.` }
    }
    case 'descubrimiento': {
      const s = d.secretos[Math.min(d.secretosRevelados, d.secretos.length - 1)]
      return { tipo, avanzaAmenaza: 0, instruccion: `DESCUBRIMIENTO: el grupo encuentra una prueba concreta (un documento, un cadáver, una grabación, un testigo) que revela: "${s}". Ya no es una pista: es la verdad, a la vista.` }
    }
    case 'perdida':
      return { tipo, avanzaAmenaza: 0, instruccion: 'PÉRDIDA: algo se rompe o se pierde ahora mismo: un arma se traba o se parte, se roban un objeto, un aliado NPC se va o cae. Reflejalo en "cambios".' }
    case 'faccion': {
      const f = elegir(d.facciones.filter((x) => x.nombre), rng)
      return { tipo, avanzaAmenaza: 0, instruccion: `LLEGA UNA FACCIÓN: ${f.nombre} aparece en escena con una exigencia concreta${f.quiere ? ` (quieren: ${f.quiere})` : ''}. Dan un ultimátum o un trato; el grupo tiene que responder ya.` }
    }
    case 'amenaza':
    default:
      return { tipo: 'amenaza', avanzaAmenaza: 2, instruccion: `GOLPE DE LA AMENAZA: ${d.amenaza} golpea de forma visible y directa en esta escena (daño, destrucción, víctimas). El reloj de la amenaza avanza 2.` }
  }
}

/** Texto del bloque RITMO que se inyecta en el prompt en cada turno. */
export function bloqueRitmo(p: Partida, finales: string[], estadoFinal: string): string {
  const r = p.mundo.ritmo
  if (!r) return ''
  const f = faseDe(r)
  const total = totalCapitulos(p.config)
  const l: string[] = []
  const cap = total > 0 ? `Capítulo ${p.capitulo} de ${total}` : `Capítulo ${p.capitulo} (campaña abierta)`
  l.push(`RITMO (lo lleva el motor, respetalo): ${cap} · turno ${r.turnos + 1} de ${limite(r)} · acto ${actoActual(p)} de 3 · fase ${FASES[f].nombre.toUpperCase()} · quedan ${turnosRestantes(r)} turnos.`)
  l.push(`En esta fase: ${FASES[f].instruccion}`)
  if (f === 'climax' && esCapituloFinal(p) && finales.length) {
    l.push(`FINAL DE LA HISTORIA: este es el último capítulo. Elegí UNO de estos finales según lo que realmente pasó y encaminalo sin vueltas: ${finales.map((x, i) => `(${i + 1}) ${x}`).join(' | ')}. Estado real: ${estadoFinal}`)
  } else if (f === 'climax') {
    l.push('Cierre del capítulo cerca: resolvé el conflicto del capítulo y dejá un gancho para el siguiente.')
  }
  return l.join('\n')
}
