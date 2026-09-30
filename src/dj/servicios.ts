import type { Ctx } from '../ctx.js'
import type { GuionMaestro, Jugador, Partida, Personaje, Ficha } from '../motor/tipos.js'
import type { Decision, RolIA } from './cerebro.js'
import { parsearGuion } from './cerebro.js'
import { sistemaTurno, fichaCompacta } from './contexto.js'
import { estadoPresupuesto } from './presupuesto.js'
import { PROMPT_EPILOGO, PROMPT_GUIONISTA, PROMPT_PREMISAS, PROMPT_RADIO, PROMPT_REACCION, PROMPT_RESUMEN, PROMPT_RONDA, PROMPT_TRASFONDO } from './prompts.js'
import { DURACIONES } from '../motor/ritmo.js'
import { recortar } from '../util.js'

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
    `Personajes (integrá sus ganchos):\n${pjs.map((p) => fichaCompacta(ctx, p)).join('\n')}`,
  ].join('\n')
  const txt = await ctx.cerebro.texto({ tarea: 'guion', rol: 'guionista', partidaId: partida.id, sistema: PROMPT_GUIONISTA, usuario, maxSalida: 4000, json: true })
  return (
    parsearGuion(txt) ?? {
      titulo: 'Crónicas del Yermo',
      premisa: esc?.semilla ?? 'Un grupo de sobrevivientes se cruza en el camino.',
      gancho: 'Una radio vieja capta una señal de auxilio.',
      actos: ['Encontrar el origen de la señal', 'Descubrir quién la envió y por qué', 'Decidir el destino del lugar'],
      facciones: [], npcs: [], lugares: [], secretos: [],
      amenaza: { nombre: 'La tormenta de radiación', reloj: 'Tormenta', segmentos: 6 },
      finales: [], encuentros: [],
    }
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
  const usuario = `Personaje: ${f.nombre}, ${o?.nombre}. Aspecto: ${f.aspecto}. Frase: "${f.frase}".\nRespuestas del jugador:\n1) ¿Qué te sacó de casa? ${f.respuestas[0] ?? ''}\n2) ¿Qué no querés que nadie sepa? ${f.respuestas[1] ?? ''}\n3) ¿A quién o qué protegerías? ${f.respuestas[2] ?? ''}`
  try {
    const txt = await ctx.cerebro.texto({ tarea: 'trasfondo', rol: 'util', partidaId, sistema: PROMPT_TRASFONDO, usuario, maxSalida: 700, json: true })
    const j = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    return { trasfondo: recortar(String(j.trasfondo ?? ''), 400), gancho: recortar(String(j.gancho ?? ''), 200), bio: recortar(String(j.bio_publica ?? ''), 260) }
  } catch {
    // Sin IA: la bio pública nunca usa la respuesta secreta (respuestas[1]).
    return { trasfondo: recortar(f.respuestas[0] ?? '', 300), gancho: recortar(f.respuestas[1] ?? '', 200), bio: recortar(f.respuestas[0] ?? '', 200) }
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

/** Recomprime la memoria: resumen anterior + crónicas nuevas -> resumen nuevo. Modelo barato. */
export async function recomprimirResumen(ctx: Ctx, partida: Partida): Promise<void> {
  const nuevas = ctx.db.bitacoraDesde(partida.id, partida.resumen_hasta).filter((b) => b.cronica)
  if (nuevas.length === 0) return
  const principal = partida.mundo.misiones.find((m) => m.principal)
  const usuario = `Objetivo principal: ${principal ? `${principal.texto} (${principal.estado})` : '(sin definir)'}\n\nResumen anterior:\n${partida.resumen || '(ninguno)'}\n\nCrónicas nuevas:\n${nuevas.map((b) => `- ${b.cronica}`).join('\n')}`
  try {
    const r = await ctx.cerebro.texto({ tarea: 'resumen', rol: 'util', partidaId: partida.id, sistema: PROMPT_RESUMEN, usuario, maxSalida: 900 })
    if (r) {
      partida.resumen = r
      partida.resumen_hasta = ctx.db.maxBitacora(partida.id)
    }
  } catch (e) {
    ctx.log('recomprimirResumen falló:', (e as Error).message)
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
  const usuario = `Registro mecánico de la ronda:\n${lineas.join('\n')}\n${cierre}`
  return ctx.cerebro.texto({ tarea: 'ronda_combate', rol: pres.nivel === 'economico' ? 'util' : 'narrador', partidaId: partida.id, sistema, usuario, maxSalida: 600 })
}
