import type { Ctx } from '../ctx.js'
import type { GuionMaestro, Intencion, Jugador, Partida, Personaje, Ficha, TipoIntencion } from '../motor/tipos.js'
import type { Decision, RolIA } from './cerebro.js'
import { parsearGuion } from './cerebro.js'
import { sistemaTurno, fichaCompacta } from './contexto.js'
import { estadoPresupuesto } from './presupuesto.js'
import {
  PROMPT_AUDITOR, PROMPT_CAPITULO, PROMPT_COMPILAR, PROMPT_DJ_PREGUNTA, PROMPT_ENTREVISTA, PROMPT_EPILOGO, PROMPT_GUIONISTA, PROMPT_INTENCION,
  PROMPT_INTENCION_COMBATE, PROMPT_PREMISAS, PROMPT_RADIO, PROMPT_REACCION, PROMPT_RESUMEN, PROMPT_RONDA, PROMPT_TRASFONDO,
} from './prompts.js'
import { fichaNarrativa } from './contexto.js'
import { claveJugador } from '../motor/estado.js'
import { hilosAbiertos, menciona, normalizarGuion } from '../motor/canon.js'
import { DURACIONES } from '../motor/ritmo.js'
import { ATRIBUTOS, type AtribId } from '../motor/tipos.js'
import { vivos } from '../motor/combate.js'
import { recortar, sinTags } from '../util.js'

export class ErrorPresupuesto extends Error {
  constructor() {
    super('presupuesto agotado')
  }
}

/** Una decisión del DJ para el turno: pide tirada o narra. Aplica el fusible de presupuesto. */
export async function decidirTurno(
  ctx: Ctx,
  partida: Partida,
  pjs: Personaje[],
  jugadores: Jugador[],
  op: { tarea: 'turno' | 'apertura'; usuario: string; turnoPj?: Personaje; forzarNarrar: boolean; extra?: string; rol?: RolIA; maxSalida?: number },
): Promise<Decision> {
  const pres = estadoPresupuesto(ctx, partida.id)
  if (pres.nivel === 'parado') throw new ErrorPresupuesto()
  const economico = pres.nivel === 'economico'
  const rol: RolIA = economico ? 'util' : op.rol ?? 'narrador'
  const sistema = sistemaTurno(ctx, partida, pjs, jugadores, { turnoPj: op.turnoPj, economico, extra: op.extra })
  return ctx.cerebro.decidir({
    tarea: op.tarea,
    rol,
    partidaId: partida.id,
    sistema,
    usuario: op.usuario,
    forzarNarrar: op.forzarNarrar,
    maxSalida: economico ? Math.min(900, op.maxSalida ?? ctx.cfg.maxSalidaNarrador) : op.maxSalida ?? ctx.cfg.maxSalidaNarrador,
    pista: { pjs: pjs.map((p) => p.id), turnoPj: op.turnoPj?.id },
  })
}

export async function crearMundo(ctx: Ctx, partida: Partida, pjs: Personaje[]): Promise<GuionMaestro> {
  const cfg = partida.config
  const esc = ctx.u.escenarios.find((e) => e.id === cfg.escenario)
  const tono = ctx.u.tonos.find((t) => t.id === cfg.tono)
  const d = DURACIONES[cfg.duracion] ?? DURACIONES.oneshot
  const duracion = d.capitulos === 1 ? `una aventura de un solo capítulo (${d.nombre})` : d.capitulos > 1 ? `una mini-campaña de ${d.capitulos} capítulos` : 'una campaña abierta por capítulos'
  const usuario = [
    `Universo: ${ctx.u.nombre}. ${ctx.u.estilo.trim()}`,
    `Escenario: ${esc?.nombre}. ${esc?.semilla}`,
    `Tono: ${tono?.prompt}. Duración: ${duracion}. Evitar: ${cfg.evitar.join(', ') || 'nada en particular'}.`,
    cfg.premisa ? `PREMISA ELEGIDA POR EL GRUPO (obligatoria, el guion gira alrededor de ella): ${cfg.premisa}` : 'Premisa: inventala vos, con un objetivo concreto.',
    `Bestiario disponible (ids): ${ctx.u.bestiario.map((b) => b.id).join(', ')}.`,
    `Personajes (integrá sus ganchos y armá un arco para cada uno con su id):\n${pjs.map((p) => `${fichaCompacta(ctx, p)}\n   ${fichaNarrativa(ctx, p)}`).join('\n')}`,
  ].join('\n')
  const txt = await ctx.cerebro.texto({ tarea: 'guion', rol: 'guionista', partidaId: partida.id, sistema: PROMPT_GUIONISTA, usuario, maxSalida: 4000, json: true })
  return (
    parsearGuion(txt) ?? normalizarGuion({
      titulo: 'Crónicas del Yermo',
      premisa: esc?.semilla ?? 'Un grupo de sobrevivientes se cruza en el camino.',
      gancho: 'Una radio vieja capta una señal de auxilio.',
      actos: ['Encontrar el origen de la señal', 'Descubrir quién la envió y por qué', 'Decidir el destino del lugar'],
      facciones: [], npcs: [], lugares: [], secretos: [],
      amenaza: { nombre: 'La tormenta de radiación', reloj: 'Tormenta', segmentos: 6 },
      finales: [], encuentros: [],
    } as unknown as GuionMaestro)
  )
}

/** Tres premisas de una línea para que el anfitrión elija antes de arrancar. Modelo barato. */
export async function generarPremisas(ctx: Ctx, partida: Partida): Promise<string[]> {
  const cfg = partida.config
  const esc = ctx.u.escenarios.find((e) => e.id === cfg.escenario)
  const tono = ctx.u.tonos.find((t) => t.id === cfg.tono)
  const usuario = `Universo: ${ctx.u.nombre}. Escenario: ${esc?.nombre}. ${esc?.semilla}\nTono: ${tono?.prompt}.`
  try {
    const txt = await ctx.cerebro.texto({ tarea: 'premisas', rol: 'util', partidaId: partida.id, sistema: PROMPT_PREMISAS, usuario, maxSalida: 500, json: true })
    const j = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    return (Array.isArray(j.premisas) ? j.premisas : []).map((x: unknown) => recortar(String(x), 140)).filter(Boolean).slice(0, 3)
  } catch {
    return []
  }
}

export async function generarTrasfondo(ctx: Ctx, partidaId: number | null, f: Ficha): Promise<{ trasfondo: string; gancho: string; bio: string }> {
  const o = ctx.u.origenes.find((x) => x.id === f.origen)
  const sub = o?.sub?.find((x) => x.id === f.subOrigen)
  const datos = [
    f.oficio && `Oficio: ${f.oficio}`, f.marca && `Lo que lo marcó: ${f.marca}`, f.objetivo && `Quiere: ${f.objetivo}`, f.miedo && `Teme: ${f.miedo}`,
    f.virtudes?.length && `Virtudes: ${f.virtudes.join(', ')}`, f.defecto && `Defecto: ${f.defecto}`, f.valor && `Valora: ${f.valor}`,
    f.persona && `Persona importante: ${f.persona}`, f.deuda && `Deuda: ${f.deuda}`, f.mentira && `Dice de sí (mentira): ${f.mentira}`,
    f.secreto && `Secreto (NO va en la bio pública): ${f.secreto}`,
    f.respuestas[0] && `¿Qué te sacó de casa? ${f.respuestas[0]}`, f.respuestas[1] && `¿Qué no querés que nadie sepa? ${f.respuestas[1]}`, f.respuestas[2] && `¿A quién protegerías? ${f.respuestas[2]}`,
  ].filter(Boolean).join('\n')
  const usuario = `Personaje: ${f.nombre}, ${o?.nombre}${sub ? ` (${sub.nombre}: ${sub.desc})` : ''}. Aspecto: ${f.aspecto}. Frase: "${f.frase}".\n${datos}`
  try {
    const txt = await ctx.cerebro.texto({ tarea: 'trasfondo', rol: 'util', partidaId, sistema: PROMPT_TRASFONDO, usuario, maxSalida: 700, json: true })
    const j = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    return { trasfondo: recortar(String(j.trasfondo ?? ''), 400), gancho: recortar(String(j.gancho ?? ''), 200), bio: recortar(String(j.bio_publica ?? ''), 260) }
  } catch {
    // Sin IA: la bio pública nunca usa el secreto.
    const base = f.marca || f.oficio || f.respuestas[0] || ''
    return { trasfondo: recortar(base, 300), gancho: recortar(f.objetivo || f.respuestas[1] || '', 200), bio: recortar(f.oficio ? `${f.oficio}. ${f.aspecto}` : base, 200) }
  }
}

export async function reaccionar(ctx: Ctx, pregunta: string, respuesta: string): Promise<string> {
  try {
    const r = recortar(await ctx.cerebro.texto({ tarea: 'reaccion', rol: 'util', partidaId: null, sistema: PROMPT_REACCION, usuario: `Pregunta: ${pregunta}\nRespuesta del jugador: ${respuesta}`, maxSalida: 200 }), 200)
    // Red de seguridad: el narrador comenta, no pregunta (una repregunta confunde el flujo de preguntas fijas).
    return /[?¿]/.test(r) ? '' : r
  } catch {
    return ''
  }
}

/**
 * Memoria en capas: el resumen del CAPÍTULO EN CURSO se rearma desde sus crónicas (no desde el resumen anterior),
 * así no se deforma con cada reescritura. Los capítulos cerrados quedan congelados aparte.
 */
export async function recomprimirResumen(ctx: Ctx, partida: Partida): Promise<void> {
  const desde = partida.mundo.inicioCap ?? 0
  const delCap = ctx.db.bitacoraDesde(partida.id, desde).filter((b) => b.cronica)
  if (delCap.length === 0) return
  const ultimas = delCap.slice(-60)
  const usuario = `${delCap.length > ultimas.length ? `Lo anterior del capítulo, resumido: ${partida.resumen}\n\n` : ''}Hechos del capítulo, en orden:\n${ultimas.map((b) => `- ${b.cronica}`).join('\n')}`
  try {
    const r = await ctx.cerebro.texto({ tarea: 'resumen', rol: 'util', partidaId: partida.id, sistema: PROMPT_RESUMEN, usuario, maxSalida: 700 })
    if (r) {
      partida.resumen = r
      partida.resumen_hasta = ctx.db.maxBitacora(partida.id)
    }
  } catch (e) {
    ctx.log('recomprimirResumen falló:', (e as Error).message)
  }
}

/** Resumen definitivo de un capítulo que se cierra: queda congelado y no se vuelve a reescribir. */
export async function resumenCapitulo(ctx: Ctx, partida: Partida): Promise<string> {
  const delCap = ctx.db.bitacoraDesde(partida.id, partida.mundo.inicioCap ?? 0).filter((b) => b.cronica).slice(-60)
  if (!delCap.length) return partida.resumen
  try {
    const r = await ctx.cerebro.texto({ tarea: 'capitulo', rol: 'util', partidaId: partida.id, sistema: PROMPT_CAPITULO, usuario: delCap.map((b) => `- ${b.cronica}`).join('\n'), maxSalida: 500 })
    return recortar(r || partida.resumen, 1200)
  } catch {
    return recortar(partida.resumen || delCap.map((b) => b.cronica).join(' '), 1200)
  }
}

export async function transmisionRadio(ctx: Ctx, partida: Partida, crónicas: string[], largo = false): Promise<string> {
  const base = largo ? `Resumen general:\n${partida.resumen || '(sin resumen)'}\n\nÚltimos hechos:\n` : 'Hechos:\n'
  const usuario = base + crónicas.map((c) => `- ${c}`).join('\n')
  const sistema = largo ? PROMPT_RADIO.replace('máximo 140 palabras', 'máximo 260 palabras') : PROMPT_RADIO
  return ctx.cerebro.texto({ tarea: 'radio', rol: 'util', partidaId: partida.id, sistema, usuario, maxSalida: 900 })
}

export async function epilogo(ctx: Ctx, partida: Partida, pjs: Personaje[]): Promise<string> {
  const usuario = `Historia:\n${partida.resumen}\n\nPersonajes:\n${pjs.map((p) => `${p.ficha.nombre}${p.vivo ? '' : ' (murió)'}: ${p.trasfondo}`).join('\n')}\n\nÚltimos hechos:\n${ctx.db.ultimasBitacora(partida.id, 8).filter((b) => b.cronica).map((b) => '- ' + b.cronica).join('\n')}`
  return ctx.cerebro.texto({ tarea: 'epilogo', rol: 'guionista', partidaId: partida.id, sistema: PROMPT_EPILOGO, usuario, maxSalida: 900 })
}

export async function narrarRondaCombate(ctx: Ctx, partida: Partida, pjs: Personaje[], jugadores: Jugador[], lineas: string[], cierre: string): Promise<string> {
  const pres = estadoPresupuesto(ctx, partida.id)
  if (pres.nivel === 'parado') throw new ErrorPresupuesto()
  const sistema = sistemaTurno(ctx, partida, pjs, jugadores, { economico: pres.nivel === 'economico' }) + '\n\n' + PROMPT_RONDA
  const usuario = `Registro mecánico de la ronda:\n${lineas.map(sinTags).join('\n')}\n${cierre}`
  return ctx.cerebro.texto({ tarea: 'ronda_combate', rol: pres.nivel === 'economico' ? 'util' : 'narrador', partidaId: partida.id, sistema, usuario, maxSalida: 600 })
}

/**
 * Palabras que pueden indicar una acción drástica. Solo si aparece alguna se gasta la llamada
 * (barata) al clasificador; el resto de las acciones van directo al narrador.
 */
const PREFILTRO = /(\bmat(o|a|ar|arlo|arla|arme|arte)\b|le parto|le reviento|le vuelo la|l[oa] liquido|l[oa] fusilo|l[oa] estrangulo|l[oa] ahogo|le corto el cuello|le rompo el cuello|l[oa] apuñalo|me voy a (tirar|matar|disparar|colgar|ahorcar|lanzar)|voy a (tirarme|matarme|dispararme)|(me )?quiero (morir|matarme)|\bmorir(me)?\b|me cuelgo|colgarme|asesin|degoll|degüell|apuñal|acuchill|ejecut|ahorc|suicid|\bme tiro\b|tirarme|\bme mato\b|matarme|terminar con todo|quitarme la vida|me dejo morir|me dejo caer|me arrojo|arrojarme|me lanzo al vac|saltar al vac|me sacrific|sacrificarme|me pego un tiro|me disparo|dispararme|me vuelo la|volarme|me clavo|me corto|me apuñalo|me degüello|volarle|le pego un tiro|le disparo|\bme voy\b|me largo|me rajo|me abro|abandon|dejo el grupo|dejo a los|me separo|me paso|pasarme|traicion|traiciono|les cuento todo|le cuento todo|delat|vendo al grupo|entrego al grupo|me uno a)/i

export function podriaSerDrastica(texto: string): boolean {
  return PREFILTRO.test(texto)
}

const TIPOS: TipoIntencion[] = ['muerte_propia', 'matar', 'abandonar', 'traicion', 'otra']

/** Clasifica una acción drástica. Ante cualquier error devuelve "otra" (el turno sigue normal). */
export async function clasificarIntencion(ctx: Ctx, partida: Partida, pj: Personaje, texto: string): Promise<Intencion> {
  if (!podriaSerDrastica(texto)) return { tipo: 'otra' }
  if (estadoPresupuesto(ctx, partida.id).nivel === 'parado') return { tipo: 'otra' }
  try {
    const npcs = partida.mundo.npcs.filter((n) => n.estado !== 'muerto').map((n) => n.nombre).join(', ')
    const usuario = `Personaje que actúa: ${pj.ficha.nombre}. NPC en escena: ${npcs || 'ninguno'}.\nAcción: ${texto}`
    const txt = await ctx.cerebro.texto({ tarea: 'intencion', rol: 'util', partidaId: partida.id, sistema: PROMPT_INTENCION, usuario, maxSalida: 300, json: true })
    const j = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    const tipo = TIPOS.includes(j.intencion) ? (j.intencion as TipoIntencion) : 'otra'
    return { tipo, objetivo: recortar(String(j.objetivo ?? ''), 60) || undefined }
  } catch {
    return { tipo: 'otra' }
  }
}

const TIPOS_COMBATE: TipoIntencion[] = ['ataque', 'muerte_propia', 'traicion', 'otra']

/**
 * Acción libre en combate: siempre se clasifica (es rara y barata). Si es un ataque, devuelve la prueba
 * que corresponde a lo que se intenta; el motor la tira y aplica el daño.
 */
export async function clasificarAccionCombate(ctx: Ctx, partida: Partida, pj: Personaje, pjs: Personaje[], texto: string): Promise<Intencion> {
  const c = partida.mundo.combate
  if (!c || estadoPresupuesto(ctx, partida.id).nivel === 'parado') return { tipo: 'otra' }
  try {
    const usuario = `Personaje que actúa: ${pj.ficha.nombre}. Enemigos: ${vivos(c).map((e) => e.nombre).join(', ') || 'ninguno'}. Compañeros: ${pjs.filter((x) => x.id !== pj.id && x.vivo).map((x) => x.ficha.nombre).join(', ') || 'ninguno'}.\nHabilidades válidas: ${ctx.u.habilidades.map((h) => h.id).join(', ')}.\nAcción: ${texto}`
    const txt = await ctx.cerebro.texto({ tarea: 'intencion', rol: 'util', partidaId: partida.id, sistema: PROMPT_INTENCION_COMBATE, usuario, maxSalida: 400, json: true })
    const j = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    const tipo = TIPOS_COMBATE.includes(j.intencion) ? (j.intencion as TipoIntencion) : 'otra'
    const objetivo = recortar(String(j.objetivo ?? ''), 60) || undefined
    if (tipo !== 'ataque' && tipo !== 'traicion') return { tipo, objetivo }
    const hab = ctx.u.habilidades.find((h) => h.id === j.habilidad) ?? ctx.u.habilidades.find((h) => h.id === 'desarmado')!
    const atributo = ATRIBUTOS.includes(String(j.atributo).toUpperCase() as AtribId) ? (String(j.atributo).toUpperCase() as AtribId) : hab.attr
    const d = Math.round(Number(j.dificultad))
    const prueba = { atributo, habilidad: hab.id, dificultad: d >= 1 && d <= 4 ? d : 2, motivo: recortar(String(j.motivo ?? 'Atacar'), 60) }
    return { tipo, objetivo, prueba }
  } catch {
    return { tipo: 'otra' }
  }
}

// ------------------------------------------------------------------ auditor de coherencia

export type Afirmacion =
  | { tipo: 'dano' | 'cura' | 'muerte' | 'se_va' | 'actua_muerto'; quien: string }
  | { tipo: 'objeto'; quien: string; que: string; accion: 'gana' | 'pierde' }
  | { tipo: 'npc_nuevo'; nombre: string }
  | { tipo: 'decide_por_pj'; quien: string; texto: string }

const PALABRAS_ESTADO = /(herid|sangr|golpe|dispar|balazo|cuchill|apuñal|muer|mat[oóa]|cad[aá]ver|cae |cay[oó]|desmaya|se va|se fue|se aleja para siempre|abandona|recib|entreg|agarr|le da |le pasa|pierd|perdi[oó]|rob[aóo]|guard[aóo]|cur[aóo]|venda|estimulante|decide|acepta|promete|jura)/i

/** Prefiltro barato: solo vale la pena auditar si el texto nombra personajes o habla de daño, muerte u objetos. */
export function valeAuditar(texto: string, nombres: string[]): boolean {
  if (PALABRAS_ESTADO.test(texto)) return true
  return nombres.some((n) => menciona(texto, n))
}

/** Pide al modelo barato las afirmaciones de estado que hace una narración. Ante error: ninguna. */
export async function auditarNarracion(ctx: Ctx, partida: Partida, pjs: Personaje[], texto: string, turnoPj?: Personaje): Promise<Afirmacion[]> {
  if (estadoPresupuesto(ctx, partida.id).nivel === 'parado') return []
  // Los PJ que se fueron o que mueren en este mismo turno (su jugador lo eligió) no cuentan como muertos que actúan.
  const muertos = [...(partida.mundo.muertos ?? []), ...ctx.db.personajesTodos(partida.id).filter((p) => !p.vivo && !p.condiciones.includes('se fue') && p.jugador_id !== turnoPj?.jugador_id).map((p) => p.ficha.nombre)]
  const usuario = [
    `Personajes jugadores: ${pjs.filter((p) => p.vivo).map((p) => `${claveJugador(p)} ${p.ficha.nombre}`).join(', ') || 'ninguno'}.`,
    turnoPj ? `Juega este turno: ${claveJugador(turnoPj)} ${turnoPj.ficha.nombre} (sus decisiones SÍ las puede narrar).` : '',
    `NPC conocidos: ${partida.mundo.npcs.filter((n) => n.estado !== 'muerto').map((n) => n.nombre).join(', ') || 'ninguno'}.`,
    `Muertos: ${muertos.join(', ') || 'ninguno'}.`,
    `Texto del narrador:\n${texto}`,
  ].filter(Boolean).join('\n')
  try {
    const txt = await ctx.cerebro.texto({ tarea: 'auditor', rol: 'util', partidaId: partida.id, sistema: PROMPT_AUDITOR, usuario, maxSalida: 500, json: true })
    const j = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    const tipos = ['dano', 'cura', 'muerte', 'se_va', 'actua_muerto', 'objeto', 'npc_nuevo', 'decide_por_pj']
    return (Array.isArray(j.afirmaciones) ? j.afirmaciones : []).filter((a: any) => a && tipos.includes(a.tipo)).slice(0, 10)
  } catch {
    return []
  }
}

// ------------------------------------------------------------------ /dj: preguntas entre turnos

/**
 * La vista del jugador: SOLO lo que su personaje sabe. Los secretos del guion, de los NPC y de los otros
 * personajes no están acá, así que no hay forma de sacárselos al DJ.
 */
export function vistaJugador(ctx: Ctx, partida: Partida, pj: Personaje | undefined, pregunta: string): string {
  const m = partida.mundo
  const l: string[] = []
  const principal = m.misiones.find((x) => x.principal)
  if (principal) l.push(`Objetivo del grupo (${principal.estado}): ${principal.texto}`)
  const otras = m.misiones.filter((x) => x.estado === 'activa' && !x.principal)
  if (otras.length) l.push(`Misiones abiertas: ${otras.map((x) => x.texto).join(' | ')}`)
  if (m.escena?.pregunta) l.push(`Escena actual (${m.escena.lugar || m.ubicacion}): ${m.escena.pregunta}`)
  else if (m.ubicacion) l.push(`Lugar: ${m.ubicacion}`)
  const hilos = hilosAbiertos(m).filter((h) => h.tipo !== 'personal' || (pj && h.pj === pj.id))
  if (hilos.length) l.push(`Preguntas abiertas de la historia: ${hilos.map((h) => h.pregunta).join(' | ')}`)
  const conocidos = m.npcs.filter((n) => n.conocido !== false)
  const relevantes = conocidos.filter((n) => menciona(pregunta, n.nombre))
  const lista = (relevantes.length ? relevantes : conocidos).slice(0, 12)
  if (lista.length) {
    l.push(`Gente conocida:\n${lista.map((n) => {
      const rel = pj ? n.relacion?.[claveJugador(pj)] : undefined
      return `- ${n.nombre}${n.estado && n.estado !== 'vivo' ? ` (${n.estado})` : ''}: ${[n.publico, n.actitud && `actitud ${n.actitud}`, n.nota, rel && `con vos: ${rel.valor > 0 ? 'bien' : rel.valor < 0 ? 'mal' : 'neutral'}${rel.nota ? ` (${rel.nota})` : ''}`, n.presente ? 'está en la escena' : ''].filter(Boolean).join(' · ')}`
    }).join('\n')}`)
  }
  const lugares = (m.lugares ?? []).filter((x) => x.conocido)
  if (lugares.length) l.push(`Lugares conocidos: ${lugares.map((x) => `${x.nombre} (${x.rasgo})`).join(' | ')}`)
  if (m.capitulos?.length) l.push(`Capítulos anteriores: ${m.capitulos.join(' ')}`)
  if (partida.resumen) l.push(`Este capítulo: ${partida.resumen}`)
  const ult = ctx.db.ultimasBitacora(partida.id, 12, ['narracion', 'accion', 'sistema']).filter((b) => b.cronica).map((b) => `- ${b.cronica}`)
  if (ult.length) l.push(`Últimos hechos:\n${ult.join('\n')}`)
  const party = ctx.db.personajesVivos(partida.id)
  if (party.length) l.push(`La party: ${party.map((p) => `${p.ficha.nombre}${p.ficha.bio ? ` (${p.ficha.bio})` : ''}`).join(' | ')}`)
  if (pj) {
    l.push(`Tu personaje: ${pj.ficha.nombre}. ${pj.ficha.objetivo ? `Querés: ${pj.ficha.objetivo}. ` : ''}${pj.ficha.secreto ? `Tu secreto (solo vos lo sabés): ${pj.ficha.secreto}. ` : ''}${pj.gancho ? `Gancho: ${pj.gancho}.` : ''}`)
    const propios = ctx.db.hechos(partida.id, { vis: [`pj:${pj.id}`] }).slice(-6)
    if (propios.length) l.push(`Lo que solo vos sabés:\n${propios.map((h) => `- ${h.texto}`).join('\n')}`)
  }
  return l.join('\n\n')
}

export async function responderPregunta(ctx: Ctx, partida: Partida, pj: Personaje | undefined, pregunta: string): Promise<string> {
  const usuario = `LO QUE SABE EL PERSONAJE\n${vistaJugador(ctx, partida, pj, pregunta)}\n\nPREGUNTA DEL JUGADOR: ${pregunta}`
  return recortar(await ctx.cerebro.texto({ tarea: 'dj', rol: 'util', partidaId: partida.id, sistema: PROMPT_DJ_PREGUNTA, usuario, maxSalida: 400 }), 700)
}

// ------------------------------------------------------------------ creación guiada

export const TEMAS_ENTREVISTA = ['concepto', 'pasado', 'competencia', 'personalidad', 'defecto', 'objetivo', 'miedo', 'secreto', 'lazos']

export async function pasoEntrevista(ctx: Ctx, pid: number | null, charla: { p: string; r: string }[]): Promise<{ cubiertos: string[]; pregunta: string }> {
  const usuario = `Lo que contó el jugador:\n${charla.map((x) => `DJ: ${x.p}\nJugador: ${x.r}`).join('\n')}\n\nTemas: ${TEMAS_ENTREVISTA.join(', ')}.`
  try {
    const txt = await ctx.cerebro.texto({ tarea: 'entrevista', rol: 'util', partidaId: pid, sistema: PROMPT_ENTREVISTA, usuario, maxSalida: 400, json: true })
    const j = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    const cubiertos = (Array.isArray(j.cubiertos) ? j.cubiertos.map(String) : []).filter((x: string) => TEMAS_ENTREVISTA.includes(x))
    return { cubiertos, pregunta: recortar(String(j.pregunta ?? ''), 220) }
  } catch {
    const faltan = TEMAS_ENTREVISTA.slice(charla.length)
    const preguntas: Record<string, string> = {
      pasado: '¿De dónde viene y qué lo sacó de ahí?', competencia: '¿En qué es bueno de verdad?', personalidad: '¿Cómo es con la gente?',
      defecto: '¿Cuál es su peor defecto?', objetivo: '¿Qué quiere conseguir?', miedo: '¿Qué le da miedo?', secreto: '¿Qué esconde?', lazos: '¿A quién quiere o le debe algo?',
    }
    return { cubiertos: TEMAS_ENTREVISTA.slice(0, charla.length), pregunta: faltan[0] ? preguntas[faltan[0]] ?? '' : '' }
  }
}

export async function compilarFicha(ctx: Ctx, pid: number | null, charla: { p: string; r: string }[]): Promise<Record<string, unknown> | null> {
  const u = ctx.u
  const catalogo = [
    `Orígenes: ${u.origenes.map((o) => `${o.id} (${o.nombre}; sub: ${(o.sub ?? []).map((x) => `${x.id}=${x.nombre}`).join(', ')})`).join(' | ')}`,
    `Arquetipos: ${u.arquetipos.map((a) => `${a.id} (${a.nombre})`).join(', ')}`,
    `Habilidades: ${u.habilidades.map((h) => `${h.id} (${h.nombre})`).join(', ')}`,
    `Extras (elegí 0 o 1): ${u.extras.map((e) => `${e.id} (${e.desc})`).join(' | ')}`,
    `Rasgos (0 o 1, más hasta 2 taras si encajan): ${u.rasgos.map((e) => `${e.id} (${e.desc})`).join(' | ')}`,
    `Armas: ${u.armas.map((a) => `${a.id} (${a.nombre})`).join(', ')}`,
    `Valores posibles: ${u.tablas.valores.join(', ')}`,
  ].join('\n')
  const usuario = `CATÁLOGO\n${catalogo}\n\nLO QUE CONTÓ EL JUGADOR\n${charla.map((x) => `DJ: ${x.p}\nJugador: ${x.r}`).join('\n')}`
  try {
    const txt = await ctx.cerebro.texto({ tarea: 'compilar', rol: 'guionista', partidaId: pid, sistema: PROMPT_COMPILAR, usuario, maxSalida: 1500, json: true })
    const j = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}
