import type { Ctx } from '../ctx.js'
import type { Combate, Jugador, Partida, Personaje } from '../motor/tipos.js'
import { ataqueJugador, levantarAliado, resolverCaidos, turnoEnemigos, usarObjeto, vivos } from '../motor/combate.js'
import { esCaido, quitarItem, saludMaxEfectiva } from '../motor/personaje.js'
import { armaPrincipal } from '../motor/reglas.js'
import { ErrorPresupuesto, narrarRondaCombate } from '../dj/servicios.js'
import { esc, sinTags, textoIA } from '../util.js'
import { inicioCombateTexto, tarjetaTurnoTexto } from '../telegram/textos.js'
import { tecladoAliadosCaidos, tecladoCombate, tecladoObjetivos } from '../telegram/teclados.js'
import type { Teclado } from '../telegram/api.js'
import { aGrupo, cargar, pjDe, refrescarTablero, registrar } from './comun.js'
import { avanzarTurno, avisarMuerte, iniciarTurno } from './turno.js'
import { marcarNpcMuerto } from '../motor/estado.js'
import { ofrecerFinal } from './narrativa.js'

function consumiblesDe(ctx: Ctx, pj: Personaje) {
  const robot = ctx.u.origenes.find((o) => o.id === pj.ficha.origen)?.robot
  return pj.inventario
    .map((i) => ({ i, def: ctx.u.objetos.find((o) => o.id === i.id) }))
    .filter((x) => x.def && (x.def.efecto === 'cura' || x.def.efecto === 'rads') && (robot ? x.def.id === 'kit_reparacion' : x.def.id !== 'kit_reparacion'))
}

export function tecladoCombateDe(ctx: Ctx, partida: Partida, pj: Personaje, pjs: Personaje[]): Teclado {
  const caidos = pjs.some((p) => p.id !== pj.id && p.vivo && esCaido(p))
  return tecladoCombate(partida.id, partida.turno_n, partida.mundo.combate!, caidos, consumiblesDe(ctx, pj).length > 0, armaPrincipal(pj, ctx.u).nombre)
}

export async function comenzarCombate(ctx: Ctx, pid: number, combate: Combate, actorJugadorId: number): Promise<void> {
  const { partida, pjs } = cargar(ctx, pid)
  partida.mundo.combate = combate
  partida.modo_escena = 'combate'
  combate.orden.push(actorJugadorId) // el que disparó el combate ya actuó en esta ronda
  partida.paso = { tipo: 'libre' }
  ctx.db.guardarPartida(partida)
  const sorp = { jugadores: '¡Los enemigos no los vieron venir!', enemigos: '¡Los enemigos los sorprenden!', ninguna: '' }[combate.sorpresa]
  await aGrupo(ctx, partida, inicioCombateTexto(combate, sorp))
  if (combate.sorpresa === 'enemigos') {
    const lineas = turnoEnemigos(ctx.u, pjs, combate, ctx.rng)
    combate.log.push(...lineas)
    for (const p of pjs) ctx.db.guardarPersonaje(p)
    ctx.db.guardarPartida(partida)
    if (lineas.length) await aGrupo(ctx, partida, faseEnemigos(lineas))
  }
  await refrescarTablero(ctx, pid)
  await finTurnoCombate(ctx, pid)
}

export async function finTurnoCombate(ctx: Ctx, pid: number): Promise<void> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  const c = partida.mundo.combate
  if (!c) return iniciarTurno(ctx, pid)
  if (vivos(c).length === 0) return cerrarCombate(ctx, pid, 'victoria')
  if (pjs.every((p) => esCaido(p))) return cerrarCombate(ctx, pid, 'derrota')
  const hayPendientes = jugadores.some((j) => {
    if (j.estado !== 'activo' && j.estado !== 'listo') return false
    const pj = pjDe(pjs, j)
    return !!pj && !esCaido(pj) && !c.orden.includes(j.id)
  })
  if (hayPendientes) return iniciarTurno(ctx, pid)
  return cerrarRonda(ctx, pid)
}

async function narrarYEnviar(ctx: Ctx, pid: number, cierre: string): Promise<void> {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  const c = partida.mundo.combate!
  let texto = ''
  try {
    texto = await narrarRondaCombate(ctx, partida, pjs, jugadores, c.log, cierre)
  } catch (e) {
    if (!(e instanceof ErrorPresupuesto)) ctx.log('narrarRonda falló', (e as Error).message)
  }
  // Crónica legible (la leen /resumen y el aviso de "te toca"): quién cayó y cómo quedó.
  const sinTagsLog = c.log.map(sinTags).join(' ')
  const cayeron = [...sinTagsLog.matchAll(/💀 (.+?) cae/g)].map((x) => x[1])
  const heridos = [...sinTagsLog.matchAll(/(?:pega a |a )([^:]+?):? .*?queda caído/g)].map((x) => x[1])
  const quedan = vivos(c).length
  const partes = [cayeron.length ? `cayó ${cayeron.join(', ')}` : '', heridos.length ? `${heridos.join(', ')} quedó en el piso` : '', quedan === 1 ? 'queda 1 enemigo' : quedan ? `quedan ${quedan} enemigos` : 'no queda ningún enemigo en pie']
  const cronica = `Combate, ronda ${c.ronda}: ${partes.filter(Boolean).join('; ')}.`
  registrar(ctx, partida, null, 'narracion', texto || c.log.join(' '), cronica)
  if (texto) await aGrupo(ctx, partida, `🎲 <i>${textoIA(texto)}</i>`)
}

async function cerrarRonda(ctx: Ctx, pid: number): Promise<void> {
  const { partida, pjs } = cargar(ctx, pid)
  const c = partida.mundo.combate!
  if (!(c.sorpresa === 'jugadores' && c.ronda === 1)) {
    const lineas = turnoEnemigos(ctx.u, pjs, c, ctx.rng)
    c.log.push(...lineas)
    for (const p of pjs) ctx.db.guardarPersonaje(p)
    if (lineas.length) await aGrupo(ctx, partida, faseEnemigos(lineas))
  } else {
    c.log.push('Los enemigos están desprevenidos y no reaccionan esta ronda.')
  }
  ctx.db.guardarPartida(partida)
  const todosCaidos = pjs.every((p) => esCaido(p))
  if (todosCaidos) return cerrarCombate(ctx, pid, 'derrota', true)
  await narrarYEnviar(ctx, pid, 'La ronda terminó y el combate continúa.')
  const p2 = ctx.db.partida(pid)!
  const c2 = p2.mundo.combate!
  c2.ronda++
  c2.orden = []
  c2.log = []
  p2.turno_jugador_id = null
  ctx.db.guardarPartida(p2)
  await iniciarTurno(ctx, pid)
}

export async function cerrarCombate(ctx: Ctx, pid: number, resultado: 'victoria' | 'derrota' | 'tregua', enemigosYaActuaron = false): Promise<void> {
  const { partida, pjs } = cargar(ctx, pid)
  const c = partida.mundo.combate
  if (!c) return iniciarTurno(ctx, pid)
  void enemigosYaActuaron
  if (resultado !== 'tregua') await narrarYEnviar(
    ctx,
    pid,
    resultado === 'victoria'
      ? 'Todos los enemigos fueron derrotados: el combate terminó con victoria. Cerrá la escena.'
      : partida.config.letalidad === 'hardcore'
        ? 'Todos los personajes cayeron: los enemigos ganaron. En esta mesa caer es morir: narrá el final de los caídos.'
        : 'Todos los personajes cayeron: los enemigos ganaron. Narrá la escena; el motor decide después quién sobrevive según la Suerte de cada uno.',
  )
  const salvados: Personaje[] = []
  const lineas = resolverCaidos(pjs, partida.config.letalidad, ctx.rng, salvados)
  for (const p of pjs) ctx.db.guardarPersonaje(p)
  for (const p of salvados) {
    const jj = ctx.db.jugador(p.jugador_id)
    if (jj) await ofrecerFinal(ctx, partida, jj, p)
  }
  const p2 = ctx.db.partida(pid)!
  // Los NPC con nombre que cayeron en combate quedan muertos en la historia.
  for (const e of c.enemigos) if (e.npc && e.salud <= 0) marcarNpcMuerto(p2.mundo, e.nombre)
  for (const p of pjs) if (!p.vivo) {
    registrar(ctx, p2, p.jugador_id, 'sistema', `${p.ficha.nombre} murió en combate.`, `${p.ficha.nombre} murió en combate.`)
    const j = ctx.db.jugador(p.jugador_id)
    if (j) await avisarMuerte(ctx, p2, j, p)
  }
  p2.mundo.combate = null
  p2.modo_escena = 'exploracion'
  p2.paso = { tipo: 'libre' }
  ctx.db.guardarPartida(p2)
  registrar(ctx, p2, null, 'sistema', `Combate terminado (${resultado}) tras ${c.ronda} ronda(s).`)
  const titulo = { victoria: '🏆 <b>Ganaron el combate.</b>', derrota: '💀 <b>Perdieron el combate.</b>', tregua: '🕊️ <b>El combate terminó.</b>' }[resultado]
  await aGrupo(ctx, p2, [titulo, ...lineas.map(esc)].join('\n'))
  await refrescarTablero(ctx, pid)
  await iniciarTurno(ctx, pid)
}

// ------------------------------------------------------------------ acciones del jugador en combate

async function validar(ctx: Ctx, pid: number, userId: string, turnoN: number) {
  const { partida, jugadores, pjs } = cargar(ctx, pid)
  if (partida.estado !== 'EN_JUEGO' || !partida.mundo.combate) return { err: 'No hay un combate en curso.' as const }
  if (partida.turno_n !== turnoN) return { err: 'Ese botón ya no vale.' as const }
  const j = jugadores.find((x) => x.id === partida.turno_jugador_id)
  if (!j || j.user_id !== userId) return { err: 'No es tu turno.' as const }
  if (partida.paso.tipo !== 'esperando_accion') return { err: 'Ya elegiste tu acción.' as const }
  const pj = pjDe(pjs, j)
  if (!pj) return { err: 'No tenés personaje.' as const }
  return { partida, j, pj, pjs, c: partida.mundo.combate }
}

/** Vuelve a mostrar la tarjeta del turno con sus botones (al tocar "↩️ Volver"). */
async function mostrarOpciones(ctx: Ctx, partida: Partida, j: Jugador, pj: Personaje, pjs: Personaje[]): Promise<void> {
  if (!partida.turno_msg_id) return
  await ctx.api.editar(partida.chat_id, partida.turno_msg_id, tarjetaTurnoTexto(ctx, partida, j, pj, pjs), tecladoCombateDe(ctx, partida, pj, pjs))
}

const volver = (pid: number, turnoN: number) => [{ text: '↩️ Volver', callback_data: `a:${pid}:${turnoN}:vo` }]

export async function accionCombate(ctx: Ctx, pid: number, userId: string, turnoN: number, cod: string): Promise<string | void> {
  // "Volver" también sirve para arrepentirse de una acción libre que todavía no escribiste.
  if (cod === 'vo') {
    const { partida, jugadores, pjs } = cargar(ctx, pid)
    const j = jugadores.find((x) => x.id === partida.turno_jugador_id)
    if (!partida.mundo.combate || partida.turno_n !== turnoN) return 'Ese botón ya no vale.'
    if (!j || j.user_id !== userId) return 'No es tu turno.'
    if (partida.paso.tipo !== 'esperando_accion' && partida.paso.tipo !== 'esperando_libre') return 'Ya elegiste tu acción.'
    const pj = pjDe(pjs, j)
    if (!pj) return
    partida.paso = { tipo: 'esperando_accion' }
    ctx.db.guardarPartida(partida)
    await mostrarOpciones(ctx, partida, j, pj, pjs)
    return
  }
  const v = await validar(ctx, pid, userId, turnoN)
  if ('err' in v) return v.err
  const { partida, j, pj, pjs, c } = v
  const cardId = partida.turno_msg_id
  switch (cod) {
    case 'at': {
      const arma = armaPrincipal(pj, ctx.u)
      const v2 = vivos(c)
      if (v2.length > 1 && !arma.area) {
        if (cardId) await ctx.api.editar(partida.chat_id, cardId, `⚔️ <b>${esc(pj.ficha.nombre)}</b>, ¿a quién atacás con ${esc(arma.nombre)}?`, [...tecladoObjetivos(pid, turnoN, c), volver(pid, turnoN)])
        return
      }
      return resolverAtaque(ctx, pid, j, pj, v2[0]?.uid ?? null)
    }
    case 'cu': {
      pj.cubierto = true
      ctx.db.guardarPersonaje(pj)
      return terminarAccion(ctx, pid, j, `🛡️ <b>${pj.ficha.nombre}</b> se cubre: más difícil de golpear hasta que actúen los enemigos.`)
    }
    case 'ob': {
      const cons = consumiblesDe(ctx, pj)
      if (!cons.length) return 'No tenés nada para usar.'
      const teclado: Teclado = cons.map((x) => [{ text: `${x.def!.nombre} ×${x.i.n} — ${x.def!.desc}`, callback_data: `o:${pid}:${turnoN}:${x.def!.id}` }])
      if (cardId) await ctx.api.editar(partida.chat_id, cardId, `🩹 <b>${esc(pj.ficha.nombre)}</b>, ¿qué usás?`, [...teclado, volver(pid, turnoN)])
      return
    }
    case 'lv': {
      const teclado = tecladoAliadosCaidos(pid, turnoN, pjs, pj)
      if (!teclado.length) return 'No hay aliados caídos.'
      if (cardId) await ctx.api.editar(partida.chat_id, cardId, `🤝 <b>${esc(pj.ficha.nombre)}</b>, ¿a quién levantás?`, [...teclado, volver(pid, turnoN)])
      return
    }
    case 'li': {
      partida.paso = { tipo: 'esperando_libre', jugadorId: j.id }
      ctx.db.guardarPartida(partida)
      if (cardId) await ctx.api.editar(partida.chat_id, cardId, `💬 <b>${esc(pj.ficha.nombre)}</b>: respondé a este mensaje con lo que hacés.\nPuede ser un ataque a tu manera (hay tirada según lo difícil que sea) o cualquier otra cosa: huir, rendirte, negociar, ayudar…`, [volver(pid, turnoN)])
      return
    }
  }
}

export async function elegirObjetivo(ctx: Ctx, pid: number, userId: string, turnoN: number, uid: string) {
  const v = await validar(ctx, pid, userId, turnoN)
  if ('err' in v) return v.err
  if (!vivos(v.c).some((e) => e.uid === uid)) return 'Ese enemigo ya no está.'
  return resolverAtaque(ctx, pid, v.j, v.pj, uid)
}

export async function elegirObjeto(ctx: Ctx, pid: number, userId: string, turnoN: number, itemId: string) {
  const v = await validar(ctx, pid, userId, turnoN)
  if ('err' in v) return v.err
  const linea = usarObjeto(ctx.u, v.pj, v.pj, itemId)
  if (!linea) return 'No podés usar eso.'
  ctx.db.guardarPersonaje(v.pj)
  return terminarAccion(ctx, pid, v.j, linea)
}

export async function elegirAliado(ctx: Ctx, pid: number, userId: string, turnoN: number, pjId: number) {
  const v = await validar(ctx, pid, userId, turnoN)
  if ('err' in v) return v.err
  const caido = v.pjs.find((p) => p.id === pjId)
  if (!caido || !esCaido(caido)) return 'Ese aliado ya está en pie.'
  const r = levantarAliado(ctx.u, v.pj, caido, ctx.rng)
  ctx.db.guardarPersonaje(caido)
  return terminarAccion(ctx, pid, v.j, r.linea)
}

async function resolverAtaque(ctx: Ctx, pid: number, j: Jugador, pj: Personaje, uid: string | null): Promise<void> {
  const { partida } = cargar(ctx, pid)
  const c = partida.mundo.combate!
  const arma = armaPrincipal(pj, ctx.u)
  const r = ataqueJugador(ctx.u, pj, c, uid, 'ninguno', ctx.rng)
  if (arma.consumible) quitarItem(pj, arma.id)
  partida.mundo.impulso = Math.min(3, partida.mundo.impulso + r.tirada.impulso)
  ctx.db.guardarPersonaje(pj)
  ctx.db.guardarPartida(partida)
  await terminarAccion(ctx, pid, j, r.linea)
}

async function terminarAccion(ctx: Ctx, pid: number, j: Jugador, linea: string): Promise<void> {
  const partida = ctx.db.partida(pid)!
  const c = partida.mundo.combate!
  c.log.push(linea)
  c.orden.push(j.id)
  j.foco += 1
  j.saltos_seguidos = 0
  ctx.db.guardarJugador(j)
  partida.paso = { tipo: 'libre' }
  ctx.db.guardarPartida(partida)
  registrar(ctx, partida, j.id, 'tirada', sinTags(linea))
  // La tarjeta del turno no queda diciendo "¿a quién atacás?": se cierra.
  const pj = ctx.db.personajeVivoDe(j.id)
  if (partida.turno_msg_id) await ctx.api.editar(partida.chat_id, partida.turno_msg_id, `✅ <b>${esc(pj?.ficha.nombre ?? j.nombre)}</b> ya jugó su turno de esta ronda.`, [])
  await aGrupo(ctx, partida, esc(linea).replace(/&lt;(\/?)b&gt;/g, '<$1b>'))
  await avanzarTurno(ctx, pid)
}

export function estadoCombateTexto(partida: Partida): string {
  const c = partida.mundo.combate
  if (!c) return ''
  return `⚔️ Ronda ${c.ronda}: ${vivos(c).map((e) => `${e.nombre} ${e.salud}/${e.salud_max}`).join(' · ')}`
}

export { saludMaxEfectiva }

/** Fase de los enemigos, agrupada en un solo mensaje. */
function faseEnemigos(lineas: string[]): string {
  return `👹 <b>Turno de los enemigos</b>\n${lineas.map((x) => esc(x).replace(/&lt;(\/?)b&gt;/g, '<$1b>')).join('\n')}`
}
