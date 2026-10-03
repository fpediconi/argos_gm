import type {
  Acto, Agenda, Arco, Beat, Escena, Faccion, GuionMaestro, Hilo, Jugador, Lugar, Mundo, Narrativa, NpcActivo, Personaje, TipoHilo,
} from './tipos.js'
import type { Fase } from './ritmo.js'

/**
 * El Canon: la historia como datos. Quién existe, qué se sabe, qué preguntas siguen abiertas
 * y qué escena se juega. El motor lo guarda y lo hace cumplir; la IA lo lee en el Brief y propone cambios.
 * Todo acá es puro (sin red ni base) para poder probarlo con datos fijos.
 */

export const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
export const slug = (s: string) => norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24)
const corto = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

export function narrativaDe(m: Mundo): Narrativa {
  if (!m.narrativa) m.narrativa = { recursos: [], apariciones: {}, nuevos: [], preguntas: {}, correcciones: [], muertosRecientes: [], pendientes: [], dj: {} }
  const n = m.narrativa
  n.recursos ??= []; n.apariciones ??= {}; n.nuevos ??= []; n.preguntas ??= {}; n.correcciones ??= []
  n.muertosRecientes ??= []; n.pendientes ??= []; n.dj ??= {}
  return n
}

// ------------------------------------------------------------------ guion

/** Las partidas viejas tienen actos como texto: se convierten a actos con un hito cada uno. */
export function normalizarGuion(g: GuionMaestro): GuionMaestro {
  g.actos = (g.actos as unknown[]).map((a, i): Acto => {
    if (typeof a === 'string') return { objetivo: a, hitos: [{ id: `a${i + 1}h1`, texto: a }] }
    const o = a as Partial<Acto> & { hitos?: unknown[] }
    const hitos = (Array.isArray(o.hitos) ? o.hitos : []).slice(0, 4).map((h, k) => {
      const hh = (typeof h === 'string' ? { texto: h } : h) as { id?: string; texto?: string; cumplido?: boolean }
      return { id: corto(hh.id, 12) || `a${i + 1}h${k + 1}`, texto: corto(hh.texto, 160), ...(hh.cumplido ? { cumplido: true } : {}) }
    }).filter((h) => h.texto)
    const objetivo = corto(o.objetivo, 200) || hitos[0]?.texto || `Acto ${i + 1}`
    return { objetivo, hitos: hitos.length ? hitos : [{ id: `a${i + 1}h1`, texto: objetivo }], ...(o.giro ? { giro: corto(o.giro, 200) } : {}) }
  })
  // Ids únicos aunque la IA los repita.
  const vistos = new Set<string>()
  g.actos.forEach((a, i) => a.hitos.forEach((h, k) => {
    if (vistos.has(h.id)) h.id = `a${i + 1}h${k + 1}`
    vistos.add(h.id)
  }))
  return g
}

/** Acto según los hitos: el primero que tiene hitos sin cumplir (o el último si están todos). */
export function actoPorHitos(g: GuionMaestro | null): number {
  if (!g || !g.actos.length) return 1
  const i = g.actos.findIndex((a) => a.hitos.some((h) => !h.cumplido))
  return i < 0 ? g.actos.length : i + 1
}

export function hitosPendientes(g: GuionMaestro | null): { acto: number; hito: { id: string; texto: string } }[] {
  if (!g) return []
  const a = actoPorHitos(g)
  return g.actos[a - 1]?.hitos.filter((h) => !h.cumplido).map((h) => ({ acto: a, hito: h })) ?? []
}

/** Marca un hito del acto actual (o anterior) como cumplido. No deja saltar actos. */
export function cumplirHito(g: GuionMaestro | null, id: string): string | null {
  if (!g) return null
  const a = actoPorHitos(g)
  for (let i = 0; i < Math.min(a, g.actos.length); i++) {
    const h = g.actos[i].hitos.find((x) => x.id === id || norm(x.texto) === norm(id))
    if (h && !h.cumplido) {
      h.cumplido = true
      return h.texto
    }
  }
  return null
}

// ------------------------------------------------------------------ entidades

export function npcPorRef(m: Mundo, ref: string): NpcActivo | undefined {
  const r = norm(String(ref ?? '').trim())
  if (!r) return undefined
  return m.npcs.find((n) => n.id === r || norm(n.nombre) === r || n.id === slug(r))
}

const agendaDe = (a?: { meta: string; pasos: string[] }): Agenda | undefined =>
  a && Array.isArray(a.pasos) && a.pasos.length
    ? { meta: corto(a.meta, 140), pasos: a.pasos.map((x) => corto(x, 140)).filter(Boolean).slice(0, 5), hechos: 0, progreso: 0, segmentos: 3 }
    : undefined

/** Carga en el Canon a los NPC, facciones y lugares del guion (una sola vez, al empezar o al migrar). */
export function sembrarCanon(m: Mundo, g: GuionMaestro): void {
  for (const n of g.npcs ?? []) {
    if (!n?.nombre) continue
    const id = slug(n.nombre)
    const ex = m.npcs.find((x) => x.id === id || norm(x.nombre) === norm(n.nombre))
    const roles = ['antagonista', 'aliado', 'rival', 'informante', 'neutral', 'victima']
    const datos: Partial<NpcActivo> = {
      peso: 'principal', rol: roles.includes(String(n.rol)) ? n.rol : undefined, quiere: corto(n.motivacion, 140), teme: corto(n.teme, 100), secreto: corto(n.secreto, 160),
      voz: corto(n.voz, 100), publico: corto(n.publico, 140), agenda: agendaDe(n.agenda),
    }
    if (ex) {
      for (const [k, v] of Object.entries(datos)) if (v && !(ex as unknown as Record<string, unknown>)[k]) (ex as unknown as Record<string, unknown>)[k] = v
    } else {
      m.npcs.push({ id, nombre: corto(n.nombre, 40), actitud: n.rol === 'antagonista' ? 'hostil' : 'neutral', nota: '', estado: 'vivo', presente: false, conocido: false, ...datos })
    }
  }
  m.facciones ??= []
  for (const f of g.facciones ?? []) {
    if (!f?.nombre || m.facciones.some((x) => norm(x.nombre) === norm(f.nombre))) continue
    m.facciones.push({ id: slug(f.nombre), nombre: corto(f.nombre, 40), quiere: corto(f.quiere, 140), esconde: corto(f.esconde, 160), conocido: false, agenda: agendaDe(f.agenda) })
  }
  m.lugares ??= []
  for (const l of g.lugares ?? []) {
    if (!l?.nombre || m.lugares.some((x) => norm(x.nombre) === norm(l.nombre))) continue
    m.lugares.push({ id: slug(l.nombre), nombre: corto(l.nombre, 50), rasgo: corto(l.rasgo, 140), conocido: false })
  }
}

/** NPC en la escena: los marcados presentes (o, en partidas viejas, los vistos hace poco). */
export function presentes(m: Mundo, turno: number): NpcActivo[] {
  return m.npcs.filter((n) => n.estado !== 'muerto' && n.estado !== 'huido' && (n.presente === true || (n.presente === undefined && (n.visto ?? -99) >= turno - 2)))
}

export function fueraDeEscena(m: Mundo, turno: number): NpcActivo[] {
  const p = new Set(presentes(m, turno).map((n) => n.id))
  return m.npcs.filter((n) => !p.has(n.id) && n.estado !== 'muerto' && (n.peso === 'principal' || n.conocido))
}

const palabraEn = (texto: string, palabra: string) => {
  if (palabra.length < 3) return false
  return new RegExp(`(^|[^a-z0-9])${palabra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(texto)
}

/** Nombres con los que se reconoce a una entidad en un texto (nombre completo y primera palabra larga). */
function claves(nombre: string): string[] {
  const n = norm(nombre).replace(/^(el|la|los|las|don|dona|doña) /, '')
  const primera = n.split(/\s+/).find((w) => w.length >= 4)
  return [...new Set([n, primera].filter((x): x is string => !!x))]
}

export function menciona(texto: string, nombre: string): boolean {
  const t = norm(texto)
  return claves(nombre).some((c) => palabraEn(t, c))
}

/** Después de cada narración: quién apareció (para dosificar y para saber qué conoce la mesa). */
export function marcarApariciones(m: Mundo, texto: string, turno: number): string[] {
  const n = narrativaDe(m)
  const ids: string[] = []
  for (const npc of m.npcs) {
    if (npc.estado === 'muerto' || !menciona(texto, npc.nombre)) continue
    ids.push(npc.id)
    npc.visto = turno
    npc.conocido = true
    const ap = (n.apariciones[npc.id] ??= [])
    if (ap.at(-1) !== turno) ap.push(turno)
    if (ap.length > 12) ap.splice(0, ap.length - 12)
  }
  for (const l of m.lugares ?? []) if (menciona(texto, l.nombre)) l.conocido = true
  for (const f of m.facciones ?? []) if (menciona(texto, f.nombre)) f.conocido = true
  return ids
}

/** Los jugadores nombran a un NPC (acciones, /dj): un extra nombrado dos veces pasa a secundario. */
export function contarMencionJugador(m: Mundo, texto: string): NpcActivo[] {
  const promovidos: NpcActivo[] = []
  for (const npc of m.npcs) {
    if (npc.estado === 'muerto' || !menciona(texto, npc.nombre)) continue
    npc.menciones = (npc.menciones ?? 0) + 1
    if (npc.peso === 'extra' && npc.menciones >= 2) {
      npc.peso = 'secundario'
      promovidos.push(npc)
    }
  }
  return promovidos
}

// ------------------------------------------------------------------ dosificación y anti-muletillas

/** Voces a distancia (la muletilla de "el villano habla por el altavoz"). Frases, no palabras sueltas: una "planta de transmisión" no cuenta. */
export const MEDIOS = /(altavoz|altavoces|altoparlantes?|meg[aá]fonos?|parlantes?|intercomunicador|walkie|interfono|holocinta|pantalla gigante|por (?:la|una|el) (?:radio|transmisor|frecuencia)|desde (?:la|una) radio|la radio (?:crepita|escupe|anuncia|dice|suena|vuelve|chilla|cruje)|una voz (?:sale|brota|crepita|llega|suena|retumba|resuena) (?:de|por|desde)|una transmisi[oó]n (?:interrumpe|corta|anuncia|dice)|transmite (?:un|una|el|la)|la grabaci[oó]n (?:dice|suena|repite|sigue))/i
const ENFRIAMIENTO_MEDIOS = 4
const ENFRIAMIENTO_RECURSO = 3

export function registrarNarracion(m: Mundo, texto: string, turno: number, recurso?: string): void {
  const n = narrativaDe(m)
  if (MEDIOS.test(texto)) n.medios = turno
  const r = corto(recurso, 30).toLowerCase()
  if (r) {
    n.recursos.push({ r, t: turno })
    if (n.recursos.length > 10) n.recursos.splice(0, n.recursos.length - 10)
  }
}

export function antagonistas(m: Mundo): NpcActivo[] {
  return m.npcs.filter((x) => x.rol === 'antagonista' && x.estado !== 'muerto')
}

/** Lo que la IA NO debe hacer este turno (lo decide el código, no el prompt). */
export function evitarEsteTurno(m: Mundo, turno: number, fase: Fase): string[] {
  const n = narrativaDe(m)
  const l: string[] = []
  const enEscena = new Set(presentes(m, turno).map((x) => x.id))
  for (const a of antagonistas(m)) {
    if (enEscena.has(a.id)) continue
    const ap = n.apariciones[a.id] ?? []
    const reciente = ap.some((t) => t >= turno - 3)
    if (fase !== 'giro' && fase !== 'climax') l.push(`que ${a.nombre} aparezca o hable en persona (actúa por sus agentes y por consecuencias visibles; nombrarlo sí está bien)`)
    else if (reciente) l.push(`que ${a.nombre} vuelva a hablar (apareció hace poco)`)
  }
  if (n.medios !== undefined && turno - n.medios < ENFRIAMIENTO_MEDIOS) l.push('voces a distancia: radios, altavoces, megáfonos, transmisiones o grabaciones (se usaron hace poco)')
  const usados = [...new Set(n.recursos.filter((x) => turno - x.t < ENFRIAMIENTO_RECURSO).map((x) => x.r))]
  if (usados.length) l.push(`repetir estos golpes de cierre: ${usados.join(', ')}`)
  // Ningún NPC omnipresente: si habló en 3 de los últimos 4 turnos, descansa.
  for (const npc of m.npcs) {
    const ap = n.apariciones[npc.id] ?? []
    if (npc.rol !== 'antagonista' && ap.filter((t) => t >= turno - 4).length >= 3) l.push(`que ${npc.nombre} hable otra vez (estuvo en los últimos turnos: que actúe otro o que calle)`)
  }
  return l
}

/** Lo que la historia necesita y todavía no tiene: por ejemplo, que la mesa sepa quién es el antagonista antes del giro. */
export function asegurarEsteTurno(m: Mundo, fase: Fase, progreso: number): string[] {
  const l: string[] = []
  for (const a of antagonistas(m)) {
    if (a.conocido) continue
    if (fase !== 'planteo' || progreso >= 0.15) l.push(`la mesa todavía no sabe quién es ${a.nombre}: que alguien lo nombre, que sus agentes digan para quién trabajan o que una consecuencia lleve su marca (sin que aparezca en persona)`)
  }
  const delGuion = m.npcs.filter((n) => n.peso === 'principal' && n.rol !== 'antagonista' && !n.conocido && n.estado !== 'muerto')
  if (delGuion.length && fase === 'escalada') l.push(`hay NPC del guion que todavía no aparecieron (${delGuion.map((n) => n.nombre).join(', ')}): traé alguno si encaja, antes que inventar gente nueva`)
  return l
}

// ------------------------------------------------------------------ economía narrativa

const TOPE_HILOS: Record<Fase, number> = { planteo: 5, escalada: 5, giro: 4, climax: 3 }

/** Cuántos elementos nuevos (NPC con nombre, lugar, facción, hilo) se pueden introducir ahora. */
export function presupuestoNuevos(m: Mundo, fase: Fase, turno: number, ronda: number): number {
  const n = narrativaDe(m)
  if (fase === 'giro' || fase === 'climax') return 0
  if (fase === 'planteo') return Math.max(0, 1 - n.nuevos.filter((x) => x.t === turno).length)
  return Math.max(0, 1 - n.nuevos.filter((x) => x.ronda === ronda).length)
}

export function registrarNuevo(m: Mundo, que: string, turno: number, ronda: number): void {
  const n = narrativaDe(m)
  n.nuevos.push({ t: turno, ronda, que: corto(que, 40) })
  if (n.nuevos.length > 30) n.nuevos.splice(0, n.nuevos.length - 30)
}

export function topeHilos(fase: Fase): number {
  return TOPE_HILOS[fase]
}

export function hilosAbiertos(m: Mundo): Hilo[] {
  return (m.hilos ?? []).filter((h) => h.estado === 'abierto')
}

export interface OpHilo { id?: string; pregunta?: string; accion: 'abrir' | 'tocar' | 'cerrar' | 'abandonar'; tipo?: TipoHilo; pj?: string }

export function aplicarHilos(
  m: Mundo, ops: OpHilo[] | undefined, ctx: { turno: number; ronda: number; fase: Fase; pjId?: (ref: string) => number | undefined },
): { aplicados: string[]; rechazados: string[] } {
  const res = { aplicados: [] as string[], rechazados: [] as string[] }
  if (!Array.isArray(ops)) return res
  m.hilos ??= []
  for (const op of ops.slice(0, 4)) {
    const buscar = () => m.hilos!.find((h) => (op.id && h.id === slug(op.id)) || (op.pregunta && norm(h.pregunta) === norm(op.pregunta)))
    if (op.accion === 'abrir') {
      const pregunta = corto(op.pregunta, 140)
      if (!pregunta || buscar()) continue
      const tipo: TipoHilo = op.tipo === 'personal' || op.tipo === 'acto' ? op.tipo : 'secundario'
      if (hilosAbiertos(m).length >= topeHilos(ctx.fase)) { res.rechazados.push(`hilos: ya hay ${hilosAbiertos(m).length} abiertos; cerrá uno antes de abrir "${pregunta}"`); continue }
      if (tipo === 'secundario' && presupuestoNuevos(m, ctx.fase, ctx.turno, ctx.ronda) <= 0) { res.rechazados.push(`hilos: sin presupuesto para abrir "${pregunta}" en esta fase`); continue }
      const pj = op.pj && ctx.pjId ? ctx.pjId(op.pj) : undefined
      m.hilos.push({ id: slug(op.id || pregunta), pregunta, tipo, estado: 'abierto', abierto: ctx.turno, tocado: ctx.turno, ...(pj ? { pj } : {}) })
      if (tipo === 'secundario') registrarNuevo(m, `hilo: ${pregunta}`, ctx.turno, ctx.ronda)
      continue
    }
    const h = buscar()
    if (!h) continue
    if (op.accion === 'tocar') h.tocado = ctx.turno
    else if (h.estado === 'abierto') {
      if (h.tipo === 'principal') { res.rechazados.push('hilos: el hilo principal se cierra con la misión principal'); continue }
      h.estado = op.accion === 'cerrar' ? 'resuelto' : 'abandonado'
      h.tocado = ctx.turno
      res.aplicados.push(`hilo ${h.estado}: ${h.pregunta}`)
    }
  }
  // Se guardan los últimos 20 para no crecer sin fin.
  if (m.hilos.length > 20) m.hilos = [...m.hilos.filter((h) => h.estado === 'abierto'), ...m.hilos.filter((h) => h.estado !== 'abierto').slice(-8)]
  return res
}

/** Los hilos que más piden ser tocados (los más olvidados primero). */
export function hilosOlvidados(m: Mundo, turno: number, desde = 6): Hilo[] {
  return hilosAbiertos(m).filter((h) => turno - h.tocado >= desde).sort((a, b) => a.tocado - b.tocado)
}

// ------------------------------------------------------------------ escenas

export function escenaDe(m: Mundo, turno: number): Escena {
  if (!m.escena) m.escena = { n: 1, lugar: m.ubicacion || '', pregunta: '', desde: turno, turnos: 0 }
  return m.escena
}

export interface CorteEscena { lugar?: string; pregunta?: string; presentes?: string[] }

/** Corta a una escena nueva: cambia el lugar y la pregunta, y define quiénes están (los demás salen). */
export function cortarEscena(m: Mundo, c: CorteEscena, turno: number): Escena {
  const prev = escenaDe(m, turno)
  const e: Escena = { n: prev.n + 1, lugar: corto(c.lugar, 80) || m.ubicacion || prev.lugar, pregunta: corto(c.pregunta, 160), desde: turno, turnos: 0 }
  m.escena = e
  if (e.lugar) m.ubicacion = e.lugar
  const quedan = new Set((c.presentes ?? []).map((r) => npcPorRef(m, r)?.id).filter(Boolean))
  for (const n of m.npcs) n.presente = quedan.has(n.id)
  return e
}

/** ¿Conviene cortar? La escena lleva una ronda completa sin que se mueva el hito. */
export function pideCorte(m: Mundo, activos: number): boolean {
  const e = m.escena
  return !!e && e.turnos >= Math.max(2, activos + 1)
}

// ------------------------------------------------------------------ frentes (agendas)

export interface LogroAgenda { quien: string; paso: string; final: boolean }

/** Al final de cada ronda avanza la agenda más urgente. Cuando un paso se completa, es un hecho visible. */
export function avanzarAgendas(m: Mundo): LogroAgenda | null {
  const candidatos: { quien: string; a: Agenda }[] = []
  for (const n of m.npcs) if (n.agenda && n.estado !== 'muerto' && n.agenda.hechos < n.agenda.pasos.length) candidatos.push({ quien: n.nombre, a: n.agenda })
  for (const f of m.facciones ?? []) if (f.agenda && f.agenda.hechos < f.agenda.pasos.length) candidatos.push({ quien: f.nombre, a: f.agenda })
  if (!candidatos.length) return null
  candidatos.sort((x, y) => y.a.progreso / y.a.segmentos - x.a.progreso / x.a.segmentos || x.a.hechos - y.a.hechos)
  const c = candidatos[0]
  c.a.progreso++
  if (c.a.progreso < c.a.segmentos) return null
  c.a.progreso = 0
  const paso = c.a.pasos[c.a.hechos]
  c.a.hechos++
  return { quien: c.quien, paso, final: c.a.hechos >= c.a.pasos.length }
}

/** Los jugadores frenan una agenda: retrocede su progreso (y si estaba en 0, se pierde un paso hecho no; solo progreso). */
export function frenarAgenda(m: Mundo, ref: string): string | null {
  const n = npcPorRef(m, ref)
  const f = (m.facciones ?? []).find((x) => x.id === slug(ref) || norm(x.nombre) === norm(ref))
  const a = n?.agenda ?? f?.agenda
  if (!a) return null
  a.progreso = Math.max(0, a.progreso - 2)
  return n?.nombre ?? f?.nombre ?? null
}

// ------------------------------------------------------------------ arcos personales

export function arcoDesdeFicha(p: Personaje, beats?: string[]): Arco {
  const f = p.ficha
  const nombre = f.nombre
  const textos = beats && beats.length >= 3 ? beats.slice(0, 3) : [
    f.persona || f.deuda || f.marca
      ? `El pasado de ${nombre} aparece: ${f.persona ? `noticias de ${f.persona}` : f.deuda ? `la deuda (${f.deuda})` : `lo que lo marcó (${f.marca})`}.`
      : `Algo del pasado de ${nombre} aparece en el camino (${p.gancho || 'su gancho'}).`,
    `Lo que ${nombre} quiere${f.objetivo ? ` (${f.objetivo})` : ''} choca con el grupo${f.miedo ? ` o con su miedo (${f.miedo})` : ''}.`,
    `${nombre} tiene que elegir entre ${f.objetivo ? `lo que quiere (${f.objetivo})` : 'su objetivo'} y ${f.valor ? `lo que valora (${f.valor})` : 'el grupo'}. La elección es del jugador.`,
  ]
  const tipos = ['planteo', 'presion', 'definicion'] as const
  return { pj: p.id, beats: tipos.map((tipo, i): Beat => ({ tipo, texto: corto(textos[i], 220), estado: 'pendiente' })) }
}

export function asegurarArcos(m: Mundo, pjs: Personaje[], g: GuionMaestro | null): void {
  m.arcos ??= []
  for (const p of pjs) {
    if (!p.vivo || m.arcos.some((a) => a.pj === p.id)) continue
    const delGuion = g?.arcos?.find((a) => a.pj === `P${p.id}` || norm(a.pj) === norm(p.ficha.nombre))
    m.arcos.push(arcoDesdeFicha(p, delGuion?.beats))
  }
}

/** El beat que toca: del PJ del turno si hace rato no tiene uno, o del que menos foco tiene. */
export function beatQueToca(m: Mundo, pjs: Personaje[], jugadores: Jugador[], turnoPj: Personaje | undefined, turno: number, espacio = 4): { pj: Personaje; beat: Beat } | null {
  const arcos = m.arcos ?? []
  const pendiente = (p: Personaje) => {
    const a = arcos.find((x) => x.pj === p.id)
    if (!a || a.definiendo) return null
    if (a.ultimo !== undefined && turno - a.ultimo < espacio) return null
    const b = a.beats.find((x) => x.estado === 'pendiente')
    return b ? { pj: p, beat: b } : null
  }
  if (turnoPj) {
    const r = pendiente(turnoPj)
    if (r) return r
  }
  const foco = (p: Personaje) => jugadores.find((j) => j.id === p.jugador_id)?.foco ?? 0
  for (const p of [...pjs].filter((x) => x.vivo).sort((a, b) => foco(a) - foco(b))) {
    const r = pendiente(p)
    if (r) return r
  }
  return null
}

export function jugarBeat(m: Mundo, pjId: number, turno: number): Beat | null {
  const a = (m.arcos ?? []).find((x) => x.pj === pjId)
  const b = a?.beats.find((x) => x.estado === 'pendiente')
  if (!a || !b) return null
  b.estado = 'jugado'
  a.ultimo = turno
  if (b.tipo === 'definicion') a.definiendo = true
  return b
}

// ------------------------------------------------------------------ selector de eventos

export type MotivoEvento = 'hito' | 'agenda' | 'hilo' | 'arco' | 'azar'
export interface EventoCanon { motivo: MotivoEvento; instruccion: string }

/**
 * El evento obligatorio sale del estado, no del azar: un hito atrasado, un hilo olvidado o el arco de quien
 * tiene menos foco. Devuelve null si no hay nada (entonces se usa el sorteo de siempre).
 */
export function eventoDesdeEstado(m: Mundo, g: GuionMaestro | null, opts: { actoPorRitmo: number; turno: number; arco: { pj: Personaje; beat: Beat } | null }): EventoCanon | null {
  const aHitos = actoPorHitos(g)
  const pend = hitosPendientes(g)
  if (g && pend.length && opts.actoPorRitmo > aHitos) {
    const h = pend[0].hito
    return { motivo: 'hito', instruccion: `LA HISTORIA SE ATRASÓ: esta escena entrega de forma inevitable el hito "${h.texto}" (id ${h.id}). Conectalo con lo que el grupo está haciendo y marcá "hito_cumplido": "${h.id}".` }
  }
  const olvidado = hilosOlvidados(m, opts.turno)[0]
  if (olvidado) return { motivo: 'hilo', instruccion: `UN HILO PIDE PAGO: "${olvidado.pregunta}" lleva rato sin tocarse. Que vuelva con una consecuencia concreta (una respuesta parcial, un costo o una persona que lo trae) y marcalo en "hilos".` }
  if (opts.arco) return { motivo: 'arco', instruccion: `ARCO PERSONAL DE ${opts.arco.pj.ficha.nombre.toUpperCase()} (${opts.arco.beat.tipo}): ${opts.arco.beat.texto} Hacelo pasar en la escena y marcá "beat_jugado": "P${opts.arco.pj.id}".` }
  return null
}

// ------------------------------------------------------------------ lugares y facciones nuevos

export function altaLugar(m: Mundo, nombre: string, rasgo = ''): Lugar | null {
  const n = corto(nombre, 50)
  if (!n) return null
  m.lugares ??= []
  const ex = m.lugares.find((x) => norm(x.nombre) === norm(n))
  if (ex) return ex
  const l: Lugar = { id: slug(n), nombre: n, rasgo: corto(rasgo, 140), conocido: true }
  m.lugares.push(l)
  return l
}

export function faccionPorRef(m: Mundo, ref: string): Faccion | undefined {
  return (m.facciones ?? []).find((x) => x.id === slug(ref) || norm(x.nombre) === norm(ref))
}
