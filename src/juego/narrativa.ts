import type { Ctx } from '../ctx.js'
import type { Intencion, Jugador, Partida, Personaje, TiradaResuelta } from '../motor/tipos.js'
import type { SalidaNarrar } from '../dj/cerebro.js'
import type { Teclado } from '../telegram/api.js'
import { aplicarCambios, buscarPj, claveJugador, type ResultadoCambios } from '../motor/estado.js'
import {
  asegurarArcos, aplicarHilos, avanzarAgendas, cortarEscena, cumplirHito, escenaDe, frenarAgenda, jugarBeat, marcarApariciones,
  narrativaDe, normalizarGuion, presupuestoNuevos, registrarNarracion, sembrarCanon, slug,
} from '../motor/canon.js'
import { reconciliar, sumarCambios } from '../motor/coherencia.js'
import { faseDe, ritmoDe } from '../motor/ritmo.js'
import { auditarNarracion, valeAuditar } from '../dj/servicios.js'
import { INSTRUCCION_REPARAR } from '../dj/prompts.js'
import { esc, recortar } from '../util.js'
import { aPrivado } from './comun.js'

// ------------------------------------------------------------------ hechos

export function registrarHecho(ctx: Ctx, p: Partida, texto: string, op: { vis?: string; fuente?: 'motor' | 'ia' | 'jugador'; sobre?: string[] } = {}): void {
  const t = recortar(texto.replace(/\s+/g, ' ').trim(), 300)
  if (!t) return
  ctx.db.agregarHecho(p.id, { turno: p.turno_n, escena: p.mundo.escena?.n ?? 0, capitulo: p.capitulo, texto: t, sobre: op.sobre, vis: op.vis ?? 'mesa', fuente: op.fuente ?? 'motor' }, ctx.reloj.ahora())
}

// ------------------------------------------------------------------ migración

/** Partidas creadas antes del Canon: se completan al vuelo (como hace `migrar` con el ritmo). */
export function migrarCanon(ctx: Ctx, p: Partida, pjs: Personaje[]): void {
  const m = p.mundo
  if (p.guion) {
    normalizarGuion(p.guion)
    if (!m.narrativa) sembrarCanon(m, p.guion)
  }
  narrativaDe(m)
  if (m.inicioCap === undefined) m.inicioCap = 0
  m.hilos ??= []
  const principal = m.misiones.find((x) => x.principal)
  if (principal && !m.hilos.some((h) => h.tipo === 'principal')) {
    m.hilos.unshift({ id: 'principal', pregunta: principal.texto, tipo: 'principal', estado: 'abierto', abierto: 0, tocado: p.turno_n })
  }
  escenaDe(m, p.turno_n)
  asegurarArcos(m, pjs, p.guion)
  void ctx
}

// ------------------------------------------------------------------ reconciliación

export interface ContextoReparacion {
  /** Vuelve a pedir la narración con una corrección. */
  reparar: (correccion: string) => Promise<SalidaNarrar | null>
  intencion?: Intencion
  tirada?: TiradaResuelta
  /** Muerte de PJ que el motor va a aplicar (muerte elegida confirmada, tirada mortal). */
  muerteAplicada?: number
}

/**
 * Antes de mostrar una narración: ensaya los cambios sobre copias, audita lo que el texto afirma y lo compara.
 * Lo legítimo que falta se agrega a los cambios; lo grave obliga a reparar el texto (un intento).
 */
export async function reconciliarSalida(
  ctx: Ctx, partida: Partida, pjs: Personaje[], actor: Personaje | undefined, salida: SalidaNarrar, rc: ContextoReparacion,
): Promise<{ salida: SalidaNarrar; notas: string[] }> {
  const n = narrativaDe(partida.mundo)
  const enCombate = !!partida.mundo.combate
  const ritmo = partida.mundo.ritmo
  const fase = ritmo ? faseDe(ritmo) : 'planteo'
  const matarFallido = rc.intencion?.tipo === 'matar' && rc.tirada && !rc.tirada.exito ? rc.intencion.objetivo ?? '' : undefined
  const modo = ctx.cfg.auditor ?? 'auto'
  let actual = salida
  for (let intento = 0; intento < 2; intento++) {
    // Un intento de matar que falló no puede matar a nadie (lo mismo que hace el turno después).
    if (matarFallido !== undefined) {
      if (actual.cambios?.npcs) actual.cambios.npcs = actual.cambios.npcs.map((x) => (x.estado === 'muerto' ? { ...x, estado: 'herido' as const } : x))
      if (actual.cambios?.muerte) delete actual.cambios.muerte
    }
    const despues = { mundo: structuredClone(partida.mundo), pjs: structuredClone(pjs) }
    const res = aplicarCambios(ctx.u, despues.mundo, despues.pjs, actual.cambios, { enCombate, fase, turno: partida.turno_n, ronda: partida.ronda })
    const graves = [...res.graves]
    const m = actual.cambios?.muerte
    if (m && !enCombate) {
      const objetivo = buscarPj(pjs, String(m.pj ?? ''))
      const vale = objetivo && objetivo.vivo && partida.config.letalidad !== 'suave' && (
        (objetivo.id === actor?.id && (m.elegida || (rc.tirada && !rc.tirada.exito))) || (partida.config.pvp && rc.tirada?.exito) || rc.muerteAplicada === objetivo.id)
      if (objetivo && !vale) graves.push(`${objetivo.ficha.nombre} no muere: ${partida.config.letalidad === 'suave' ? 'en esta mesa nadie muere (queda con secuelas)' : 'no hubo decisión de su jugador ni tirada mortal'}`)
    }
    const texto = [actual.narracion, ...(actual.hechos ?? [])].join('\n')
    const nombres = [...pjs.map((p) => p.ficha.nombre), ...partida.mundo.npcs.map((x) => x.nombre)]
    const auditar = modo === 'siempre' || (modo === 'auto' && valeAuditar(texto, nombres))
    if (auditar) {
      n.auditorias = (n.auditorias ?? 0) + 1
      const afirmaciones = await auditarNarracion(ctx, partida, pjs, texto, actor)
      const pjMuertos = ctx.db.personajesTodos(partida.id)
        .filter((x) => !x.vivo && !x.condiciones.includes('se fue') && x.id !== rc.muerteAplicada && x.jugador_id !== actor?.jugador_id)
        .map((x) => x.ficha.nombre)
      const r = reconciliar(afirmaciones, {
        antes: { mundo: partida.mundo, pjs }, despues, actor, enCombate, matarFallido, sinAlta: res.sinAlta, pjMuertos,
        hayPresupuesto: presupuestoNuevos(despues.mundo, fase, partida.turno_n, partida.ronda) > 0, muerteAplicada: rc.muerteAplicada,
      })
      graves.push(...r.graves)
      if (Object.keys(r.aplicar).length) actual = { ...actual, cambios: sumarCambios(actual.cambios, r.aplicar) }
    }
    const unicos = [...new Set(graves)]
    if (!unicos.length) return { salida: actual, notas: [] }
    n.contradicciones = (n.contradicciones ?? 0) + unicos.length
    if (intento === 0) {
      n.reparaciones = (n.reparaciones ?? 0) + 1
      ctx.log(`reparando narración (partida ${partida.id}):`, unicos.join(' | '))
      try {
        const nueva = await rc.reparar(INSTRUCCION_REPARAR(unicos))
        if (nueva) { actual = nueva; continue }
      } catch (e) {
        ctx.log('la reparación falló:', (e as Error).message)
      }
    }
    // No se pudo reparar: la narración sale con la corrección del motor, que además queda en el Brief.
    n.correcciones.push(...unicos.map((g) => ({ texto: g, hasta: partida.turno_n + 3 })))
    if (n.correcciones.length > 8) n.correcciones.splice(0, n.correcciones.length - 8)
    return { salida: actual, notas: [notaParaMesa(unicos)] }
  }
  return { salida: actual, notas: [] }
}

/** Lo que ve la mesa cuando una contradicción no se pudo reparar: claro y sin jerga de motor. */
export function notaParaMesa(graves: string[]): string {
  const concretas = graves.map((g) => {
    const m1 = /^(.+?) NO murió/.exec(g) ?? /^(.+?) no muere/.exec(g)
    if (m1) return `${m1[1]} sigue con vida`
    const m2 = /^(.+?) sigue en el grupo/.exec(g)
    if (m2) return `${m2[1]} sigue en el grupo`
    const m3 = /^(.+?) sobrevive/.exec(g)
    if (m3) return `${m3[1]} sobrevive`
    const m4 = /^(.+?) está muerto/.exec(g)
    if (m4) return `${m4[1]} sigue muerto`
    return ''
  }).filter(Boolean)
  return concretas.length ? `⚖️ Aclaración del DJ: ${concretas.join(' · ')}` : '⚖️ Si algo de esta escena no cierra con el tablero, vale el tablero.'
}

// ------------------------------------------------------------------ efectos narrativos del turno

/** Antes de aplicar los cambios: si la narración cambia de escena, el corte va primero (define quién queda). */
export function prepararEscena(partida: Partida, pjs: Personaje[], salida: SalidaNarrar, enCombate: boolean): boolean {
  const m = partida.mundo
  const e = escenaDe(m, partida.turno_n)
  if (salida.escena && !enCombate) {
    const nueva = cortarEscena(m, salida.escena, partida.turno_n)
    // Los personajes que esperaban (duelo) entran en esta escena.
    for (const p of pjs) {
      if (p.ficha.entraEscena !== undefined && p.ficha.entraEscena <= nueva.n) {
        narrativaDe(m).pendientes.push(`${p.ficha.nombre} (${claveJugador(p)}) entra a la historia en esta escena${p.ficha.lazo ? `: su lazo es ${p.ficha.lazo}` : ''}. Presentalo con peso.`)
        delete p.ficha.entraEscena
      }
    }
    return true
  }
  e.turnos++
  return false
}

/**
 * Después de aplicar los cambios: hilos, hitos, arcos, agendas, secretos, información privada, apariciones,
 * libreta y hechos. Devuelve las notas que ve la mesa (las internas quedan en el Brief).
 */
export async function aplicarNarrativa(
  ctx: Ctx, partida: Partida, pjs: Personaje[], j: Jugador, actor: Personaje | undefined, salida: SalidaNarrar, res: ResultadoCambios,
  op: { tirada?: TiradaResuelta; enCombate: boolean },
): Promise<{ notas: string[]; movio: boolean }> {
  const m = partida.mundo
  const n = narrativaDe(m)
  const turno = partida.turno_n
  const ritmo = m.ritmo ? m.ritmo : ritmoDe(partida, 1)
  const fase = faseDe(ritmo)
  const notas: string[] = []
  let movio = false
  const pjId = (ref: string) => buscarPj(pjs, ref)?.id

  const h = aplicarHilos(m, salida.hilos, { turno, ronda: partida.ronda, fase, pjId })
  if (h.aplicados.length) movio = true
  if (h.rechazados.length) ctx.log('hilos rechazados:', h.rechazados.join(' | '))

  if (salida.hito_cumplido && !op.enCombate) {
    const t = cumplirHito(partida.guion, salida.hito_cumplido)
    if (t) {
      movio = true
      registrarHecho(ctx, partida, `Hito cumplido: ${t}`, { vis: 'dj', fuente: 'ia' })
    }
  }

  if (salida.beat_jugado) {
    const p = buscarPj(pjs, salida.beat_jugado)
    const b = p ? jugarBeat(m, p.id, turno) : null
    if (p && b) {
      movio = true
      ctx.db.guardarPersonaje(p)
      const jj = ctx.db.jugador(p.jugador_id)
      if (jj && b.tipo === 'definicion') await aPrivado(ctx, partida, jj, `🎭 <b>Momento de definición para ${esc(p.ficha.nombre)}.</b> Lo que hagas en tu próximo turno queda como su elección.`)
    }
  }

  if (salida.agenda_frenada) {
    const quien = frenarAgenda(m, salida.agenda_frenada)
    if (quien) { movio = true; registrarHecho(ctx, partida, `El grupo frenó los planes de ${quien}.`, { fuente: 'ia' }) }
  }

  if (salida.secreto_pj) {
    const p = buscarPj(pjs, salida.secreto_pj.pj)
    if (p?.ficha.secreto && p.ficha.secretoEstado !== 'revelado') {
      const otroConTirada = !!op.tirada?.exito && actor && actor.id !== p.id
      if (salida.secreto_pj.estado === 'revelado' && (actor?.id === p.id || otroConTirada)) {
        p.ficha.secretoEstado = 'revelado'
        registrarHecho(ctx, partida, `Se supo el secreto de ${p.ficha.nombre}: ${p.ficha.secreto}`, { fuente: 'motor', sobre: [claveJugador(p)] })
        notas.push(`🗝️ Se supo el secreto de ${p.ficha.nombre}`)
        movio = true
      } else if (salida.secreto_pj.estado === 'sospechado' && !p.ficha.secretoEstado) {
        p.ficha.secretoEstado = 'sospechado'
        movio = true
      }
      ctx.db.guardarPersonaje(p)
    }
  }

  if (salida.privado) {
    const p = buscarPj(pjs, salida.privado.pj)
    const jj = p ? ctx.db.jugador(p.jugador_id) : undefined
    if (p && jj && (await aPrivado(ctx, partida, jj, `🤫 <b>Solo para vos</b> (${esc(p.ficha.nombre)}): <i>${esc(salida.privado.texto)}</i>`))) {
      registrarHecho(ctx, partida, salida.privado.texto, { vis: `pj:${p.id}`, fuente: 'ia', sobre: [claveJugador(p)] })
      notas.push(`🤫 ${p.ficha.nombre} recibió algo por privado`)
    }
  }

  if (salida.contradice_valor) {
    const p = buscarPj(pjs, salida.contradice_valor.pj)
    if (p) {
      p.ficha.contradicciones = (p.ficha.contradicciones ?? 0) + 1
      ctx.db.guardarPersonaje(p)
      registrarHecho(ctx, partida, `${p.ficha.nombre} actuó contra lo que valora: ${salida.contradice_valor.texto}`, { fuente: 'ia', sobre: [claveJugador(p)] })
      if (p.ficha.contradicciones === 2) await ofrecerCambioDeValor(ctx, partida, p)
    }
  }

  // Apariciones (dosificación), medios y recursos usados (anti-muletillas).
  marcarApariciones(m, salida.narracion, turno)
  registrarNarracion(m, salida.narracion, turno, salida.recurso)
  if (salida.libreta) n.libreta = recortar(salida.libreta, 400)
  n.pendientes = []

  // Hechos: los que declaró la IA (ya reconciliados) y lo que aplicó el motor.
  for (const x of salida.hechos ?? []) registrarHecho(ctx, partida, x, { fuente: 'ia' })
  for (const x of res.aplicados.filter((a) => /muere|murió|cumplida|fallida|recibe|pierde/.test(a))) registrarHecho(ctx, partida, x, { fuente: 'motor' })
  if (res.altas.length) movio = true
  void j
  return { notas, movio }
}

// ------------------------------------------------------------------ rondas: agendas y llegadas

/** Al empezar una ronda nueva: avanza el frente más urgente y habilita a los que esperaban entrar. */
export function nuevaRondaNarrativa(ctx: Ctx, partida: Partida, pjs: Personaje[]): void {
  const m = partida.mundo
  const n = narrativaDe(m)
  const logro = avanzarAgendas(m)
  if (logro) {
    registrarHecho(ctx, partida, `${logro.quien} logró: ${logro.paso}`, { vis: 'dj', fuente: 'motor' })
    const instr = `LA AGENDA DE ${logro.quien.toUpperCase()} AVANZA: logró "${logro.paso}"${logro.final ? ' (era su último paso: su plan se cumplió)' : ''}. Mostrá la CONSECUENCIA a la vista del grupo (algo que cambió en el mundo) y que se sepa que fue obra de ${logro.quien} (una marca, un testigo, sus hombres), sin que aparezca hablando.`
    const r = m.ritmo
    if (r && !r.eventoPendiente && !r.cierrePendiente) {
      r.eventoPendiente = instr
    } else n.pendientes.push(instr)
  }
  const e = escenaDe(m, partida.turno_n)
  for (const p of pjs) {
    if (p.ficha.entraEscena !== undefined && p.ficha.entraEscena > e.n) {
      delete p.ficha.entraEscena
      ctx.db.guardarPersonaje(p)
      n.pendientes.push(`${p.ficha.nombre} (${claveJugador(p)}) llega a la escena ahora${p.ficha.lazo ? `: su lazo es ${p.ficha.lazo}` : ''}. Presentalo.`)
    }
  }
}

// ------------------------------------------------------------------ muerte con peso

/** Al morir un PJ: el mundo lo recuerda y su jugador elige su legado. */
export async function despedida(ctx: Ctx, partida: Partida, j: Jugador, pj: Personaje): Promise<void> {
  const n = narrativaDe(partida.mundo)
  if (!n.muertosRecientes.includes(pj.ficha.nombre)) n.muertosRecientes.push(pj.ficha.nombre)
  registrarHecho(ctx, partida, `${pj.ficha.nombre} murió.`, { fuente: 'motor', sobre: [claveJugador(pj)] })
  // Los NPC que lo conocían lo recuerdan: queda en su nota.
  for (const npc of partida.mundo.npcs) {
    const rel = npc.relacion?.[claveJugador(pj)]
    if (rel && npc.estado !== 'muerto') npc.nota = recortar(`${rel.valor > 0 ? 'Llora' : 'No olvida'} la muerte de ${pj.ficha.nombre}. ${npc.nota}`, 80)
  }
  const teclado: Teclado = [
    [{ text: '🎒 Dejarle mis cosas a alguien', callback_data: `u:${partida.id}:${pj.id}:obj` }],
    ...(pj.ficha.secreto && pj.ficha.secretoEstado !== 'revelado' ? [[{ text: '🗝️ Que se sepa mi secreto', callback_data: `u:${partida.id}:${pj.id}:rev` }]] : []),
    ...(pj.ficha.objetivo ? [[{ text: '📜 Que el grupo cumpla lo que quería', callback_data: `u:${partida.id}:${pj.id}:enc` }]] : []),
  ]
  await aPrivado(ctx, partida, j, `🕯️ <b>El legado de ${esc(pj.ficha.nombre)}</b>\nSu muerte no pasa sin dejar marca. Elegí qué deja (una sola cosa):`, teclado)
}

/** Tras esquivar la muerte gastando la Suerte: el jugador puede preferir el final. */
export async function ofrecerFinal(ctx: Ctx, partida: Partida, j: Jugador, pj: Personaje): Promise<void> {
  await aPrivado(ctx, partida, j, `🍀 <b>${esc(pj.ficha.nombre)}</b> se salvó por un pelo gastando toda su Suerte (y le quedó una cicatriz). Si preferís que este sea su final, todavía podés elegirlo.`, [[{ text: '☠️ Prefiero que muera acá', callback_data: `u:${partida.id}:${pj.id}:morir` }]])
}

async function ofrecerCambioDeValor(ctx: Ctx, partida: Partida, p: Personaje): Promise<void> {
  const jj = ctx.db.jugador(p.jugador_id)
  if (!jj) return
  const valores = ctx.u.tablas.valores.filter((v) => v !== p.ficha.valor).slice(0, 8)
  const filas: Teclado = []
  for (let i = 0; i < valores.length; i += 2) filas.push(valores.slice(i, i + 2).map((v) => ({ text: v, callback_data: `u:${partida.id}:${p.id}:val:${ctx.u.tablas.valores.indexOf(v)}` })))
  filas.push([{ text: `Sigo valorando ${p.ficha.valor ?? 'lo mismo'}`, callback_data: `u:${partida.id}:${p.id}:val:x` }])
  await aPrivado(ctx, partida, jj, `🎭 <b>${esc(p.ficha.nombre)}</b> ya actuó dos veces contra lo que decía valorar (${esc(p.ficha.valor ?? 'sus principios')}). ¿Cambió? Si querés, su ficha lo refleja:`, filas)
}

/** Botones del legado, del final elegido y del cambio de valor (callback u:pid:pjId:accion[:arg]). */
export async function callbackLegado(ctx: Ctx, pid: number, userId: string, pjId: number, accion: string, arg?: string, msgId?: number): Promise<string | void> {
  const partida = ctx.db.partida(pid)
  const pj = ctx.db.personaje(pjId)
  if (!partida || !pj || pj.partida_id !== pid) return 'Eso ya no vale.'
  const j = ctx.db.jugador(pj.jugador_id)
  if (!j || j.user_id !== userId) return 'Eso es de otra persona.'
  const n = narrativaDe(partida.mundo)
  const guardar = () => { ctx.db.guardarPartida(partida); ctx.db.guardarPersonaje(pj) }
  const yaDejo = () => n.pendientes.some((x) => x.startsWith(`LEGADO DE ${pj.ficha.nombre.toUpperCase()}`)) || ctx.db.hechos(pid, {}).some((h) => h.texto.startsWith(`Legado de ${pj.ficha.nombre}`))

  if (accion === 'morir') {
    if (!pj.vivo) return 'Ya no hace falta.'
    if (partida.mundo.combate) return 'Esperá a que termine el combate.'
    pj.vivo = false
    pj.condiciones = pj.condiciones.filter((c) => c !== 'caido')
    guardar()
    const { avisarMuerte } = await import('./turno.js')
    n.pendientes.push(`${pj.ficha.nombre.toUpperCase()} MUERE: su jugador eligió que las heridas fueran su final. Narralo con peso y elipsis.`)
    await avisarMuerte(ctx, partida, j, pj)
    ctx.db.guardarPartida(partida)
    return '☠️ Así será.'
  }
  if (accion === 'val') {
    if (arg === 'x') return 'Bien: sigue firme.'
    const v = ctx.u.tablas.valores[Number(arg)]
    if (!v) return
    const antes = pj.ficha.valor
    pj.ficha.valor = v
    pj.ficha.contradicciones = 0
    registrarHecho(ctx, partida, `${pj.ficha.nombre} cambió: ya no valora ${antes ?? 'lo de antes'}, ahora valora ${v}.`, { sobre: [claveJugador(pj)] })
    guardar()
    return `✅ ${pj.ficha.nombre} ahora valora: ${v}.`
  }
  if (pj.vivo) return 'Tu personaje sigue vivo.'
  if (yaDejo()) return 'Ya elegiste su legado.'
  const marcar = async (texto: string, pendiente: string) => {
    registrarHecho(ctx, partida, `Legado de ${pj.ficha.nombre}: ${texto}`, { sobre: [claveJugador(pj)] })
    n.pendientes.push(`LEGADO DE ${pj.ficha.nombre.toUpperCase()}: ${pendiente}`)
    guardar()
    // El mensaje de la elección queda como registro, sin botones.
    if (msgId && j.dm_chat_id) await ctx.api.editar(j.dm_chat_id, msgId, `🕯️ <b>El legado de ${esc(pj.ficha.nombre)}</b>: ${esc(texto)}.\nEl DJ lo va a hacer sentir en la próxima escena.`, [])
  }
  if (accion === 'obj') {
    const vivos = ctx.db.personajesVivos(pid).filter((x) => x.id !== pj.id)
    if (!vivos.length) return 'No queda nadie para recibirlo.'
    if (!arg) {
      const t: Teclado = vivos.map((x) => [{ text: x.ficha.nombre, callback_data: `u:${pid}:${pj.id}:obj:${x.id}` }])
      if (msgId && j.dm_chat_id) await ctx.api.editar(j.dm_chat_id, msgId, `🎒 ¿A quién le deja sus cosas ${esc(pj.ficha.nombre)}?`, t)
      else await aPrivado(ctx, partida, j, '🎒 ¿A quién le dejás tus cosas?', t)
      return
    }
    const destino = vivos.find((x) => x.id === Number(arg))
    if (!destino) return 'Esa persona ya no está.'
    const cosas = pj.inventario.filter((i) => ctx.u.armas.some((a) => a.id === i.id) || i.id.startsWith('libre:')).slice(0, 2)
    for (const c of cosas) destino.inventario.push({ id: c.id, n: 1 })
    if (pj.ficha.objetoPersonal) destino.inventario.push({ id: `libre:${pj.ficha.objetoPersonal.slice(0, 40)}`, n: 1 })
    ctx.db.guardarPersonaje(destino)
    const nombres = [...cosas.map((c) => ctx.u.armas.find((a) => a.id === c.id)?.nombre ?? c.id.replace(/^libre:/, '')), pj.ficha.objetoPersonal].filter(Boolean)
    await marcar(`le dejó a ${destino.ficha.nombre} ${nombres.join(' y ') || 'lo poco que tenía'}`, `${destino.ficha.nombre} recibe lo que dejó ${pj.ficha.nombre} (${nombres.join(', ') || 'sus cosas'}). Que se sienta.`)
    const jd = ctx.db.jugador(destino.jugador_id)
    if (jd) await aPrivado(ctx, partida, jd, `🎒 <b>${esc(pj.ficha.nombre)}</b> te dejó ${esc(nombres.join(' y ') || 'sus cosas')}. Ya está en tu mochila.`)
    return `✅ ${destino.ficha.nombre} recibe lo tuyo.`
  }
  if (accion === 'rev' && pj.ficha.secreto) {
    pj.ficha.secretoEstado = 'revelado'
    await marcar(`se supo su secreto: ${pj.ficha.secreto}`, `el grupo descubre el secreto de ${pj.ficha.nombre}: ${pj.ficha.secreto}. Mostralo con una prueba concreta.`)
    return '✅ Su secreto sale a la luz.'
  }
  if (accion === 'enc' && pj.ficha.objetivo) {
    partida.mundo.hilos ??= []
    partida.mundo.hilos.push({ id: slug(`legado ${pj.ficha.nombre}`), pregunta: `¿Cumplirá el grupo lo que quería ${pj.ficha.nombre}? (${pj.ficha.objetivo})`, tipo: 'personal', estado: 'abierto', abierto: partida.turno_n, tocado: partida.turno_n })
    await marcar(`le encargó al grupo: ${pj.ficha.objetivo}`, `${pj.ficha.nombre} le deja al grupo un encargo: ${pj.ficha.objetivo}. Que alguien lo recuerde en escena.`)
    return '✅ El grupo carga con su encargo.'
  }
}
