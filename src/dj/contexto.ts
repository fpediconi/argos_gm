import type { Ctx } from '../ctx.js'
import type { Jugador, NpcActivo, Partida, Personaje } from '../motor/tipos.js'
import { claveJugador } from '../motor/estado.js'
import { saludMaxEfectiva } from '../motor/personaje.js'
import { PROMPT_DJ, textoViolencia } from './prompts.js'
import { vivos } from '../motor/combate.js'
import { actoActual, bloqueRitmo, faseDe, FASES, progreso, totalCapitulos } from '../motor/ritmo.js'
import { siguienteJugador } from '../motor/turnos.js'
import {
  actoPorHitos, asegurarEsteTurno, beatQueToca, escenaDe, evitarEsteTurno, fueraDeEscena, hilosAbiertos, hilosOlvidados, narrativaDe, pideCorte,
  presentes, presupuestoNuevos, topeHilos,
} from '../motor/canon.js'

export function fichaCompacta(ctx: Ctx, p: Personaje): string {
  const f = p.ficha
  const o = ctx.u.origenes.find((x) => x.id === f.origen)
  const habs = ctx.u.habilidades
    .filter((h) => (f.habilidades[h.id] ?? 0) > 0)
    .map((h) => `${h.id}${f.habilidades[h.id]}${f.especialidades.includes(h.id) ? '*' : ''}`)
    .join(' ')
  const attrs = Object.entries(f.atributos).map(([k, v]) => `${k}${v}`).join(' ')
  const inv = p.inventario.map((i) => (i.n > 1 ? `${i.id}x${i.n}` : i.id)).join(', ') || '-'
  const cond = [...p.condiciones, ...(f.cicatrices ?? []).map((c) => `cicatriz: ${c}`)].join(', ') || '-'
  const extras = [...(f.extras ?? []), ...(f.rasgos ?? [])].map((id) => ctx.u.extras.find((x) => x.id === id)?.nombre ?? ctx.u.rasgos.find((x) => x.id === id)?.nombre ?? id)
  return `${claveJugador(p)} ${f.nombre} (${o?.nombre ?? f.origen}; ${f.aspecto}) salud ${p.salud}/${saludMaxEfectiva(p)} rads ${p.rads} suerte ${p.suerte} chapas ${p.chapas} | ${attrs} | hab: ${habs || '-'}${extras.length ? ` | extras: ${extras.join(', ')}` : ''} | inv: ${inv} | cond: ${cond}${o?.rasgo ? ` | rasgo: ${o.rasgo}` : ''}`
}

/** La parte narrativa de un PJ (semi-estable: cambia poco). El secreto va marcado como del jugador. */
export function fichaNarrativa(ctx: Ctx, p: Personaje): string {
  const f = p.ficha
  const sub = ctx.u.origenes.find((x) => x.id === f.origen)?.sub?.find((s) => s.id === f.subOrigen)
  const partes: string[] = []
  if (sub) partes.push(sub.nombre)
  if (f.oficio) partes.push(`oficio: ${f.oficio}`)
  if (f.voz) partes.push(`habla: ${f.voz}`)
  if (f.virtudes?.length) partes.push(`virtudes: ${f.virtudes.join(', ')}`)
  if (f.defecto) partes.push(`defecto: ${f.defecto}`)
  if (f.vicio) partes.push(`vicio: ${f.vicio}`)
  if (f.valor) partes.push(`valora: ${f.valor}`)
  if (f.objetivo) partes.push(`quiere: ${f.objetivo}`)
  if (f.miedo) partes.push(`teme: ${f.miedo}`)
  if (f.marca) partes.push(`lo marcó: ${f.marca}`)
  if (f.persona) partes.push(`persona importante: ${f.persona}`)
  if (f.deuda) partes.push(`deuda: ${f.deuda}`)
  if (f.objetoPersonal) partes.push(`objeto personal: ${f.objetoPersonal}`)
  if (f.lazo) partes.push(`lazo con la historia: ${f.lazo}`)
  if (p.gancho) partes.push(`gancho: ${p.gancho}`)
  if (f.mentira) partes.push(`dice de sí (y es mentira): ${f.mentira}`)
  if (f.secreto) partes.push(`SECRETO DEL JUGADOR (${f.secretoEstado ?? 'oculto'}; NO REVELAR vos): ${f.secreto}`)
  else if (p.trasfondo) partes.push(`trasfondo: ${p.trasfondo}`)
  return `${claveJugador(p)} ${f.nombre}: ${partes.join(' · ') || '(sin trasfondo)'}`
}

/** El guion sin el estado de los hitos (eso va en el Brief): es semi-estable y se cachea. */
function guionCompacto(p: Partida): string {
  const g = p.guion
  if (!g) return '(sin guion)'
  const l: string[] = []
  l.push(`Título: ${g.titulo}. Premisa: ${g.premisa}`)
  if (g.actos.length) l.push(`Actos: ${g.actos.map((a, i) => `${i + 1}) ${a.objetivo}${a.giro ? ` (giro: ${a.giro})` : ''}`).join(' ')}`)
  if (g.facciones.length) l.push(`Facciones: ${g.facciones.map((f) => `${f.nombre} (quiere: ${f.quiere}; NO REVELAR: ${f.esconde})`).join(' | ')}`)
  if (g.lugares.length) l.push(`Lugares: ${g.lugares.map((x) => `${x.nombre} (${x.rasgo})`).join(' | ')}`)
  if (g.secretos.length) l.push(`Secretos (NO REVELAR hasta un evento o descubrimiento): ${g.secretos.join(' | ')}`)
  l.push(`Amenaza: ${g.amenaza.nombre}`)
  if (g.encuentros.length) l.push(`Encuentros sugeridos (bestiario): ${g.encuentros.join(', ')}`)
  return l.join('\n')
}

/** Estado real para elegir el final. */
export function estadoParaFinal(p: Partida, pjs: Personaje[]): string {
  const m = p.mundo
  const principal = m.misiones.find((x) => x.principal)
  const partes: string[] = []
  if (principal) partes.push(`objetivo principal ${principal.estado}`)
  const cumplidas = m.misiones.filter((x) => x.estado === 'cumplida' && !x.principal).length
  const fallidas = m.misiones.filter((x) => x.estado === 'fallida' && !x.principal).length
  partes.push(`misiones cumplidas ${cumplidas}, fallidas ${fallidas}`)
  if (m.muertos?.length) partes.push(`NPC muertos: ${m.muertos.join(', ')}`)
  const amenaza = m.relojes.find((r) => r.id === 'amenaza')
  if (amenaza) partes.push(`reloj de amenaza ${amenaza.llenos}/${amenaza.segmentos}`)
  partes.push(`personajes en pie: ${pjs.filter((x) => x.vivo).map((x) => x.ficha.nombre).join(', ') || 'ninguno'}`)
  if (m.decisiones?.length) partes.push(`decisiones del grupo: ${m.decisiones.slice(-3).join('; ')}`)
  return partes.join(' · ')
}

/**
 * Cada cuántos turnos puede tocarle un beat de arco a un mismo personaje: los 3 beats se reparten en toda la historia
 * (en un one-shot, cada ~5 turnos; en una mini-campaña, cada ~15).
 */
export function espacioBeats(p: Partida): number {
  const r = p.mundo.ritmo
  const caps = totalCapitulos(p.config) || 3
  return Math.max(4, Math.round(((r?.objetivo ?? 12) * caps) / 4))
}

/** ¿Puede jugar este personaje? (los que entraron tarde esperan al próximo cambio de escena). */
export function pjHabilitado(p: Partida, pj: Personaje | undefined): boolean {
  if (!pj || !pj.vivo) return false
  const e = pj.ficha.entraEscena
  return e === undefined || (p.mundo.escena?.n ?? 1) >= e
}

/** Quién juega después del turno actual (para que la narración le deje algo y las sugerencias sean suyas). */
export function proximoJugador(p: Partida, jugadores: Jugador[], pjs: Personaje[]): Jugador | undefined {
  const con = (j: Jugador) => pjHabilitado(p, pjs.find((x) => x.jugador_id === j.id))
  return siguienteJugador(jugadores, p.turno_jugador_id, con)?.jugador
}

/** Bloque MESA: personas reales → personajes, quién juega y quién sigue. */
export function bloqueMesa(ctx: Ctx, p: Partida, jugadores: Jugador[], pjs: Personaje[], turnoPj?: Personaje): string {
  const prox = proximoJugador(p, jugadores, pjs)
  const l: string[] = ['MESA (personas reales → sus personajes. Solo ellas deciden por sus PJ)']
  for (const j of jugadores.filter((x) => x.estado !== 'fuera' && x.estado !== 'creando')) {
    const pj = pjs.find((x) => x.jugador_id === j.id)
    const marca = turnoPj && pj?.id === turnoPj.id ? '  ← JUEGA AHORA' : prox?.id === j.id ? '  ← juega después' : ''
    if (pj) {
      const espera = !pjHabilitado(p, pj) ? ' (entra en la próxima escena: presentalo)' : ''
      const estado = j.estado === 'ausente' || j.estado === 'dormido' ? ` (${j.estado}: su personaje acompaña sin decidir)` : ''
      l.push(`  ${j.nombre} → ${claveJugador(pj)} ${pj.ficha.nombre}${estado}${espera}${marca}`)
    } else {
      const ult = ctx.db.ultimoPersonajeDe(j.id)
      l.push(`  ${j.nombre} → sin personaje${ult && !ult.vivo ? ` (${ult.ficha.nombre} ${ult.condiciones.includes('se fue') ? 'se fue' : 'murió'}; juega como voz del mundo)` : ''}${marca}`)
    }
  }
  return l.join('\n')
}

function lineaNpc(n: NpcActivo, pjs: Personaje[], conSecreto: boolean): string {
  const rel = Object.entries(n.relacion ?? {})
    .map(([k, r]) => {
      const pj = pjs.find((x) => claveJugador(x) === k)
      return pj ? `con ${pj.ficha.nombre}: ${r.valor > 0 ? '+' : ''}${r.valor}${r.nota ? ` (${r.nota})` : ''}` : ''
    })
    .filter(Boolean)
  const partes = [
    `${n.nombre} [${[n.rol, n.peso].filter(Boolean).join(', ') || 'npc'}${n.estado === 'herido' ? ', herido' : ''}]`,
    n.actitud ? `actitud: ${n.actitud}` : '',
    n.quiere ? `quiere: ${n.quiere}` : '',
    n.teme ? `teme: ${n.teme}` : '',
    n.voz ? `voz: ${n.voz}` : '',
    n.nota ? `nota: ${n.nota}` : '',
    rel.length ? rel.join(', ') : '',
    conSecreto && n.secreto ? `NO REVELAR: ${n.secreto}` : '',
  ].filter(Boolean)
  return `    · ${partes.join(' · ')}`
}

export interface OpcionesContexto {
  turnoPj?: Personaje
  economico?: boolean
  extra?: string
}

/**
 * Arma el mensaje de sistema en el orden pensado para el caché de prompts:
 * estable -> semi-estable (partida) -> volátil (el Brief del turno).
 */
export function sistemaTurno(ctx: Ctx, partida: Partida, pjs: Personaje[], jugadores: Jugador[], op: OpcionesContexto = {}): string {
  const cfg = partida.config
  const escenario = ctx.u.escenarios.find((e) => e.id === cfg.escenario)
  const tono = ctx.u.tonos.find((t) => t.id === cfg.tono)
  const m = partida.mundo
  const turno = partida.turno_n
  const partes: string[] = []

  // 1) ESTABLE
  partes.push(PROMPT_DJ)
  partes.push(`Objetos válidos: ${ctx.u.objetos.map((o) => o.id).join(', ')}. Armas: ${ctx.u.armas.map((a) => a.id).join(', ')}. Enemigos: ${ctx.u.bestiario.map((b) => `${b.id}`).join(', ')}.`)

  // 2) SEMI-ESTABLE (por partida)
  partes.push(`UNIVERSO Y TONO\n${ctx.u.estilo.trim()}\nEscenario: ${escenario?.nombre ?? ''}. ${escenario?.semilla ?? ''}\nTono: ${tono?.prompt ?? ''}.\n${textoViolencia(cfg.violencia)}\nLíneas y velos (evitar o mostrar con discreción): ${cfg.evitar.length ? cfg.evitar.join(', ') : 'ninguna en particular'}.\nLetalidad: ${cfg.letalidad}${cfg.letalidad === 'suave' ? ' (los personajes no mueren)' : ' (los personajes pueden morir)'}.\nTraiciones entre personajes: ${cfg.pvp ? 'permitidas' : 'no (los personajes no se atacan entre sí)'}.`)
  partes.push(`GUION MAESTRO (secreto)\n${guionCompacto(partida)}`)
  const vivosPj = pjs.filter((p) => p.vivo)
  if (vivosPj.length) partes.push(`QUIÉNES SON LOS PERSONAJES (lo que los mueve)\n${vivosPj.map((p) => fichaNarrativa(ctx, p)).join('\n')}`)
  if (m.capitulos?.length) partes.push(`CAPÍTULOS ANTERIORES\n${m.capitulos.map((c, i) => `Cap. ${i + 1}: ${c}`).join('\n')}`)
  partes.push(`ESTE CAPÍTULO HASTA AHORA\n${partida.resumen || '(recién empieza)'}`)

  // 3) VOLÁTIL — el Brief
  const n = narrativaDe(m)
  const r = m.ritmo
  const fase = r ? faseDe(r) : 'planteo'
  const est: string[] = []
  est.push(bloqueMesa(ctx, partida, jugadores, pjs, op.turnoPj))
  const ritmo = bloqueRitmo(partida, partida.guion?.finales ?? [], estadoParaFinal(partida, pjs))
  if (ritmo) est.push(ritmo)

  const principal = m.misiones.find((x) => x.principal)
  if (principal) est.push(`OBJETIVO PRINCIPAL DEL GRUPO (${principal.estado}): ${principal.texto}`)
  const g = partida.guion
  if (g?.actos.length) {
    const a = Math.min(actoPorHitos(g), g.actos.length)
    const acto = g.actos[a - 1]
    const porRitmo = actoActual(partida)
    est.push(`ACTO ${a} de ${g.actos.length}: ${acto.objetivo}\n  Hitos: ${acto.hitos.map((h) => `${h.cumplido ? '✓' : '○'} ${h.id} ${h.texto}`).join(' | ')}${porRitmo > a ? `\n  (El ritmo ya pide el acto ${porRitmo}: empujá hacia los hitos pendientes.)` : ''}`)
  }

  if (!m.combate) {
    const e = escenaDe(m, turno)
    const activos = jugadores.filter((j) => j.estado === 'activo').length
    est.push(`ESCENA ${e.n} · ${e.lugar || m.ubicacion || 'lugar por definir'} · turno ${e.turnos + 1} de la escena${e.pregunta ? `\n  Pregunta: ${e.pregunta}` : '\n  (Sin pregunta dramática: definila con "escena" si cambia el lugar o el momento.)'}${pideCorte(m, activos) ? '\n  La escena ya dio lo suyo: si la pregunta se respondió, cortá a otra escena con "escena".' : ''}`)
  } else {
    est.push(`COMBATE en curso, ronda ${m.combate.ronda}. Enemigos: ${vivos(m.combate).map((x) => `${x.nombre} ${x.salud}/${x.salud_max}`).join(' | ') || 'ninguno'}`)
  }

  const enEscena = presentes(m, turno)
  est.push(enEscena.length
    ? `NPC EN ESCENA (son los únicos que pueden hablar o actuar):\n${enEscena.slice(0, 5).map((x) => lineaNpc(x, pjs, x.peso === 'principal')).join('\n')}${enEscena.length > 5 ? `\n    · también: ${enEscena.slice(5).map((x) => x.nombre).join(', ')} (en segundo plano)` : ''}`
    : 'NPC EN ESCENA: nadie (los personajes están solos).')
  const fuera = fueraDeEscena(m, turno)
  if (fuera.length) {
    est.push(`FUERA DE ESCENA (no hablan ahora; traerlos a la escena es gratis): ${fuera.map((x) => {
      const a = x.agenda
      const plan = a && a.hechos < a.pasos.length ? ` — próximo paso de su plan: ${a.pasos[a.hechos]}` : ''
      return `${x.nombre}${x.rol ? ` [${x.rol}]` : ''}${plan}`
    }).join(' | ')}`)
  }
  if (m.muertos?.length) est.push(`NPC MUERTOS (no pueden reaparecer): ${m.muertos.join(', ')}`)

  const hilos = hilosAbiertos(m)
  const olvidados = new Set(hilosOlvidados(m, turno).map((h) => h.id))
  if (hilos.length) {
    est.push(`HILOS ABIERTOS (${hilos.length} de ${topeHilos(fase)}) — mejor tocar o cerrar uno que abrir otro:\n${hilos.map((h) => `  · [${h.tipo}] ${h.id}: ${h.pregunta}${olvidados.has(h.id) ? ' (olvidado hace rato)' : ''}`).join('\n')}`)
  }
  const resto = presupuestoNuevos(m, fase, turno, partida.ronda)
  est.push(`PRESUPUESTO: fase ${FASES[fase].nombre.toUpperCase()} · ${resto > 0 ? `podés presentar ${resto} elemento nuevo (NPC con nombre, lugar, facción o misterio), anclado a algo que ya existe` : 'NO presentes NPC, lugares, facciones ni misterios nuevos: usá los que ya existen'}.`)
  const evitar = evitarEsteTurno(m, turno, fase)
  if (evitar.length) est.push(`EVITAR ESTE TURNO:\n${evitar.map((x) => `  · ${x}`).join('\n')}`)
  const asegurar = r ? asegurarEsteTurno(m, fase, progreso(r)) : []
  if (asegurar.length) est.push(`ASEGURÁ PRONTO:\n${asegurar.map((x) => `  · ${x}`).join('\n')}`)

  const arco = r && !m.combate && !r.eventoPendiente ? beatQueToca(m, pjs, jugadores, op.turnoPj, turno, espacioBeats(partida)) : null
  if (arco) est.push(`OPORTUNIDAD DE ARCO PERSONAL (${arco.pj.ficha.nombre}, ${arco.beat.tipo}): ${arco.beat.texto} Si lo jugás, marcá "beat_jugado": "${claveJugador(arco.pj)}".`)

  if (m.relojes.length) est.push(`Relojes: ${m.relojes.map((x) => `${x.nombre} ${x.llenos}/${x.segmentos}${x.llenos >= x.segmentos ? ' (¡LLENO!)' : ''}`).join(' | ')}`)
  const otras = m.misiones.filter((x) => x.estado === 'activa' && !x.principal)
  if (otras.length) est.push(`Misiones secundarias: ${otras.map((x) => x.texto).join(' | ')}`)
  if (m.vinculos.length) est.push(`Vínculos entre personajes: ${m.vinculos.join(' | ')}`)
  if (m.decisiones?.length) est.push(`Decisiones del grupo (son hechos, respetalas): ${m.decisiones.slice(-5).join(' | ')}`)
  if (n.muertosRecientes.length) est.push(`MUERTOS RECIENTES (el mundo los recuerda: quien los conocía reacciona): ${n.muertosRecientes.join(', ')}`)
  if (m.impulso) est.push(`Impulso del grupo: ${m.impulso}`)
  est.push(`PERSONAJES (estado)\n${vivosPj.map((p) => fichaCompacta(ctx, p)).join('\n')}`)
  const correcciones = n.correcciones.filter((c) => c.hasta >= turno)
  if (correcciones.length) est.push(`CORRECCIONES (la historia es así, aunque antes se haya dicho otra cosa): ${correcciones.map((c) => c.texto).join(' | ')}`)
  if (n.pendientes.length) est.push(`PARA ESTA NARRACIÓN: ${n.pendientes.join(' | ')}`)
  const confusos = Object.entries(n.preguntas).filter(([, k]) => k >= 2).map(([id]) => (id === 'objetivo' ? 'el objetivo del grupo' : m.npcs.find((x) => x.id === id)?.nombre)).filter(Boolean)
  if (confusos.length) est.push(`LA MESA ESTÁ CONFUNDIDA con: ${confusos.join(', ')}. Aclaralo dentro de la ficción (que alguien lo nombre, lo explique o lo muestre).`)
  if (n.libreta) est.push(`TU LIBRETA (lo que anotaste el turno pasado):\n  ${n.libreta}`)
  partes.push(`BRIEF DEL TURNO\n${est.join('\n\n')}`)

  const ult = ctx.db.ultimasBitacora(partida.id, 7, ['accion', 'narracion', 'tirada', 'motor'])
  if (ult.length) partes.push(`ÚLTIMAS ENTRADAS\n${ult.map((b) => `[${b.tipo}] ${b.texto}`).join('\n')}`)
  if (r?.eventoPendiente && !m.combate) partes.push(`EVENTO OBLIGATORIO (ocurre en esta narración, no lo anuncies: hacelo pasar): ${r.eventoPendiente}`)
  if (m.senalX) partes.push('<señal_x/> Alguien de la mesa pidió suavizar o cambiar el rumbo de la escena. Hacelo con naturalidad, sin mencionarlo ni preguntar por qué.')
  if (op.economico) partes.push('MODO ECONÓMICO: sé breve (máximo 60 palabras) y sin sugerencias.')
  if (op.extra) partes.push(op.extra)
  return partes.join('\n\n')
}
