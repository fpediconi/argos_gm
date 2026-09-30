import type { Ctx } from '../ctx.js'
import type { ConfigPartida, Partida } from '../motor/tipos.js'
import type { TgMessage, Teclado } from '../telegram/api.js'
import { ErrorPresupuesto, crearMundo, decidirTurno, generarPremisas } from '../dj/servicios.js'
import { aplicarCambios } from '../motor/estado.js'
import { vencimiento } from '../motor/turnos.js'
import { DURACIONES, recalcularObjetivo, ritmoDe, ritmoNuevo, totalCapitulos } from '../motor/ritmo.js'
import { esc, recortar } from '../util.js'
import { aGrupo, cargar, refrescarTablero, registrar, urlUnirse } from './comun.js'
import { iniciarTurno } from './turno.js'

export const CONFIG_DEFECTO: ConfigPartida = {
  universo: 'fallout', escenario: 'yermo', tono: 'humor', duracion: 'oneshot', plazoH: 24,
  letalidad: 'normal', evitar: [], silencio: [0, 8], plazoMaxH: 72, violencia: 'implicita', pvp: false,
}

const EVITAR = [
  { id: 'gore', label: 'Gore explícito' },
  { id: 'tortura', label: 'Tortura' },
  { id: 'adicciones', label: 'Adicciones' },
  { id: 'animales', label: 'Daño a animales' },
]

interface Paso {
  key: string
  pregunta: string
  opciones: (ctx: Ctx, cfg: ConfigPartida) => { label: string; val: string }[]
  aplicar: (cfg: ConfigPartida, val: string) => void
  valor: (ctx: Ctx, cfg: ConfigPartida) => string
  multi?: boolean
  /** Se puede cambiar con /config en una partida empezada. */
  enJuego?: boolean
}

export function textoPlazo(h: number): string {
  return h === -1 ? '⚡ Skip directo' : h === 0 ? 'Nunca se vence' : `${h} h por turno`
}

const PASOS: Paso[] = [
  {
    key: 'esc', pregunta: 'Escenario',
    opciones: (ctx) => ctx.u.escenarios.map((e) => ({ label: `${e.emoji} ${e.nombre}`, val: e.id })),
    aplicar: (c, v) => { c.escenario = v },
    valor: (ctx, c) => ctx.u.escenarios.find((x) => x.id === c.escenario)?.nombre ?? c.escenario,
  },
  {
    key: 'ton', pregunta: 'Tono',
    opciones: (ctx) => ctx.u.tonos.map((t) => ({ label: t.nombre, val: t.id })),
    aplicar: (c, v) => { c.tono = v },
    valor: (ctx, c) => ctx.u.tonos.find((x) => x.id === c.tono)?.nombre ?? c.tono,
    enJuego: true,
  },
  {
    key: 'dur', pregunta: 'Duración',
    opciones: () => (Object.keys(DURACIONES) as (keyof typeof DURACIONES)[]).map((k) => ({ label: DURACIONES[k].etiqueta, val: k })),
    aplicar: (c, v) => { if (v in DURACIONES) c.duracion = v as ConfigPartida['duracion'] },
    valor: (_ctx, c) => DURACIONES[c.duracion]?.nombre ?? c.duracion,
    enJuego: true,
  },
  {
    key: 'pla', pregunta: 'Plazo por turno',
    opciones: () => [
      { label: '⚡ Skip directo (/saltear sin esperar ni votar)', val: '-1' },
      { label: '12 horas', val: '12' }, { label: '24 horas (recomendado)', val: '24' },
      { label: 'Nunca se vence', val: '0' },
    ],
    aplicar: (c, v) => { const n = Number(v); c.plazoH = n; c.plazoMaxH = n > 0 ? n * 3 : 0 },
    valor: (_ctx, c) => textoPlazo(c.plazoH),
    enJuego: true,
  },
  {
    key: 'let', pregunta: 'Letalidad',
    opciones: () => [
      { label: 'Suave (nadie muere)', val: 'suave' },
      { label: 'Normal (recomendado)', val: 'normal' },
      { label: 'Hardcore (a 0 salud, muerte)', val: 'hardcore' },
    ],
    aplicar: (c, v) => { c.letalidad = v as ConfigPartida['letalidad'] },
    valor: (_ctx, c) => c.letalidad,
    enJuego: true,
  },
  {
    key: 'vio', pregunta: 'Violencia',
    opciones: () => [
      { label: 'Implícita (pasa, pero con cortes de escena)', val: 'implicita' },
      { label: 'Explícita (el Yermo sin filtro)', val: 'explicita' },
    ],
    aplicar: (c, v) => { c.violencia = v === 'explicita' ? 'explicita' : 'implicita' },
    valor: (_ctx, c) => (c.violencia === 'explicita' ? 'explícita' : 'implícita'),
    enJuego: true,
  },
  {
    key: 'pvp', pregunta: '¿Se permite traicionar y atacar a otros personajes?',
    opciones: () => [{ label: 'No (recomendado)', val: 'no' }, { label: 'Sí, que haya traiciones', val: 'si' }],
    aplicar: (c, v) => { c.pvp = v === 'si' },
    valor: (_ctx, c) => (c.pvp ? 'sí' : 'no'),
    enJuego: true,
  },
  {
    key: 'evi', pregunta: 'Líneas y velos: ¿qué temas evitamos? (tocá los que NO quieren y después «Listo»)', multi: true,
    opciones: () => EVITAR.map((e) => ({ label: e.label, val: e.id })),
    aplicar: (c, v) => { c.evitar = c.evitar.includes(v) ? c.evitar.filter((x) => x !== v) : [...c.evitar, v] },
    valor: (_ctx, c) => (c.evitar.length ? c.evitar.map((x) => EVITAR.find((e) => e.id === x)?.label ?? x).join(', ') : 'nada'),
    enJuego: true,
  },
  {
    key: 'sil', pregunta: 'Horas de silencio (sin avisos con sonido y el plazo no corre)',
    opciones: () => [{ label: '🌙 De 00:00 a 08:00', val: 'noche' }, { label: 'Sin horas de silencio', val: 'no' }],
    aplicar: (c, v) => { c.silencio = v === 'noche' ? [0, 8] : null },
    valor: (_ctx, c) => (c.silencio ? '00:00–08:00' : 'no'),
    enJuego: true,
  },
  {
    key: 'pre', pregunta: '¿De qué va la historia? Elegí la premisa',
    opciones: (_ctx, c) => [
      ...(c.premisasOpc ?? []).map((_p, i) => ({ label: `${['1️⃣', '2️⃣', '3️⃣'][i]} Opción ${i + 1}`, val: `p${i}` })),
      { label: '🎲 Que la invente el DJ', val: 'dj' },
      { label: '✍️ La escribo yo', val: 'txt' },
    ],
    aplicar: (c, v) => {
      if (v === 'dj') c.premisa = ''
      else if (/^p\d$/.test(v)) c.premisa = c.premisasOpc?.[Number(v[1])] ?? ''
    },
    valor: (_ctx, c) => c.premisa || 'la decide el DJ',
  },
]

const IDX_PREMISA = PASOS.findIndex((p) => p.key === 'pre')

function textoWizard(ctx: Ctx, cfg: ConfigPartida, idx: number): string {
  const paso = PASOS[idx]
  const resumen = PASOS.slice(0, idx).filter((p) => p.key !== 'evi').map((p) => `${p.pregunta.split(/[?:(]/)[0].replace('¿', '').trim()}: ${p.valor(ctx, cfg)}`)
  let cuerpo = `<b>${esc(paso.pregunta)}</b>`
  if (paso.key === 'pre') {
    const ops = cfg.premisasOpc ?? []
    cuerpo += ops.length ? '\n\n' + ops.map((p, i) => `${['1️⃣', '2️⃣', '3️⃣'][i]} ${esc(p)}`).join('\n') : ''
    cuerpo += '\n\nLa premisa es el objetivo del grupo: queda fija arriba en el tablero toda la partida.'
    if (cfg.esperandoPremisa) cuerpo += '\n\n✍️ <b>Respondé a este mensaje</b> con tu premisa (una línea).'
  }
  return `🎲 <b>Configuración de la partida</b> · paso ${idx + 1}/${PASOS.length}\n${resumen.length ? '<i>' + esc(resumen.join(' · ')) + '</i>\n' : ''}\n${cuerpo}\n(Solo elige el anfitrión.)`
}

function tecladoWizard(ctx: Ctx, pid: number, cfg: ConfigPartida, idx: number): Teclado {
  const paso = PASOS[idx]
  const filas: Teclado = paso.opciones(ctx, cfg).map((o) => [{
    text: paso.multi ? `${cfg.evitar.includes(o.val) ? '🚫' : '▫️'} ${o.label}` : o.label,
    callback_data: `w:${pid}:${paso.key}:${o.val}`,
  }])
  if (paso.multi) filas.push([{ text: '✅ Listo', callback_data: `w:${pid}:${paso.key}:ok` }])
  return filas
}

export async function comandoNueva(ctx: Ctx, msg: TgMessage): Promise<void> {
  const chatId = String(msg.chat.id)
  if (msg.chat.type === 'private') {
    await ctx.api.enviar(chatId, '🎲 Para armar una partida agregame a un <b>grupo</b> de Telegram y escribí /nueva ahí. Con mis amigos, en privado, después creamos los personajes.')
    return
  }
  const existente = ctx.db.partidaActivaDeChat(chatId)
  if (existente) {
    await ctx.api.enviar(chatId, `Ya hay una partida en este grupo (${existente.estado === 'CONFIG' ? 'configurándose' : existente.estado.toLowerCase()}). Terminala con /fin o seguí jugando. El anfitrión puede cambiar la configuración con /config.`, { threadId: msg.message_thread_id })
    return
  }
  const cfg: ConfigPartida = JSON.parse(JSON.stringify(CONFIG_DEFECTO))
  const partida = ctx.db.crearPartida(chatId, msg.message_thread_id ?? null, String(msg.from!.id), cfg, ctx.reloj.ahora())
  const id = await aGrupo(ctx, partida, textoWizard(ctx, cfg, 0), { teclado: tecladoWizard(ctx, partida.id, cfg, 0) })
  partida.wizard_msg_id = id
  ctx.db.guardarPartida(partida)
}

async function mostrarPasoWizard(ctx: Ctx, partida: Partida, idx: number): Promise<void> {
  // La premisa se genera recién al llegar a ese paso (una llamada barata, una sola vez).
  if (idx === IDX_PREMISA && !partida.config.premisasOpc) {
    await ctx.api.editar(partida.chat_id, partida.wizard_msg_id!, '🎲 <b>El guionista está pensando premisas…</b>', [])
    partida.config.premisasOpc = await generarPremisas(ctx, partida)
    ctx.db.guardarPartida(partida)
  }
  await ctx.api.editar(partida.chat_id, partida.wizard_msg_id!, textoWizard(ctx, partida.config, idx), tecladoWizard(ctx, partida.id, partida.config, idx))
}

export async function callbackWizard(ctx: Ctx, pid: number, userId: string, key: string, val: string): Promise<string | void> {
  const partida = ctx.db.partida(pid)
  if (!partida || partida.estado !== 'CONFIG') return 'Esa configuración ya terminó.'
  if (partida.anfitrion_id !== userId) return 'Solo elige el anfitrión.'
  const idx = PASOS.findIndex((p) => p.key === key)
  if (idx < 0) return
  const paso = PASOS[idx]
  if (paso.multi && val !== 'ok') {
    paso.aplicar(partida.config, val)
    ctx.db.guardarPartida(partida)
    await ctx.api.editar(partida.chat_id, partida.wizard_msg_id!, textoWizard(ctx, partida.config, idx), tecladoWizard(ctx, pid, partida.config, idx))
    return
  }
  if (paso.key === 'pre' && val === 'txt') {
    partida.config.esperandoPremisa = true
    ctx.db.guardarPartida(partida)
    await ctx.api.editar(partida.chat_id, partida.wizard_msg_id!, textoWizard(ctx, partida.config, idx), tecladoWizard(ctx, pid, partida.config, idx))
    return
  }
  if (val !== 'ok') paso.aplicar(partida.config, val)
  partida.config.esperandoPremisa = false
  ctx.db.guardarPartida(partida)
  if (idx + 1 < PASOS.length) {
    await mostrarPasoWizard(ctx, partida, idx + 1)
    return
  }
  await terminarWizard(ctx, partida)
}

/** El anfitrión respondió al asistente con su propia premisa. */
export async function premisaEscrita(ctx: Ctx, pid: number, userId: string, texto: string): Promise<boolean> {
  const partida = ctx.db.partida(pid)
  if (!partida || partida.estado !== 'CONFIG' || !partida.config.esperandoPremisa || partida.anfitrion_id !== userId) return false
  const t = recortar(texto.replace(/[<>]/g, ' ').replace(/\s+/g, ' '), 140)
  if (!t) return false
  partida.config.premisa = t
  partida.config.esperandoPremisa = false
  ctx.db.guardarPartida(partida)
  await terminarWizard(ctx, partida)
  return true
}

async function terminarWizard(ctx: Ctx, partida: Partida): Promise<void> {
  const cfg = partida.config
  partida.estado = 'CREANDO'
  cfg.premisasOpc = undefined
  ctx.db.guardarPartida(partida)
  const e = ctx.u.escenarios.find((x) => x.id === cfg.escenario)
  const linea = [
    `${esc(e?.emoji ?? '')} ${esc(e?.nombre ?? '')}`, esc(ctx.u.tonos.find((t) => t.id === cfg.tono)?.nombre ?? ''),
    esc(DURACIONES[cfg.duracion]?.nombre ?? ''), textoPlazo(cfg.plazoH), `letalidad ${cfg.letalidad}`,
  ].join(' · ')
  await ctx.api.editar(partida.chat_id, partida.wizard_msg_id!, `✅ <b>Historia configurada</b>\n${linea}${cfg.premisa ? `\n🎯 ${esc(cfg.premisa)}` : ''}\n\nEl anfitrión puede cambiar esto después con /config.`, [])
  await aGrupo(ctx, partida, `🧑‍🚀 <b>Ahora, a crear los personajes.</b>\nCada uno toca el botón: se abre mi chat privado y armamos la ficha en unos minutos. Cuando estén todos listos, el anfitrión toca <b>▶️ Empezar</b> en el tablero.`, { teclado: [[{ text: '🧑‍🚀 Crear mi personaje', url: urlUnirse(ctx, partida.id) }]] })
  await refrescarTablero(ctx, partida.id)
}

// ------------------------------------------------------------------ /config en partida

function textoConfig(ctx: Ctx, cfg: ConfigPartida, aviso = ''): string {
  const l = PASOS.filter((p) => p.enJuego).map((p) => `• ${esc(p.pregunta.split(/[?:(]/)[0].replace('¿', '').trim())}: <b>${esc(p.valor(ctx, cfg))}</b>`)
  return `⚙️ <b>Configuración de la partida</b>\n${l.join('\n')}${aviso ? `\n\n${aviso}` : ''}\n\nTocá lo que quieras cambiar (solo el anfitrión).`
}

function tecladoConfig(pid: number): Teclado {
  const nombres: Record<string, string> = { ton: '🎭 Tono', dur: '⏳ Duración', pla: '⏱ Plazo por turno', let: '☠️ Letalidad', vio: '🩸 Violencia', pvp: '🗡️ Traiciones', evi: '🚫 Líneas y velos', sil: '🌙 Silencio' }
  const keys = PASOS.filter((p) => p.enJuego).map((p) => p.key)
  const filas: Teclado = []
  for (let i = 0; i < keys.length; i += 2) filas.push(keys.slice(i, i + 2).map((k) => ({ text: nombres[k] ?? k, callback_data: `g:${pid}:${k}` })))
  filas.push([{ text: '✅ Listo', callback_data: `g:${pid}:cerrar` }])
  return filas
}

/** /config: el anfitrión cambia la configuración de una partida ya creada. */
export async function comandoConfig(ctx: Ctx, partida: Partida, userId: string): Promise<string | void> {
  if (partida.anfitrion_id !== userId) return 'Solo el anfitrión puede cambiar la configuración.'
  if (partida.estado === 'CONFIG') return 'La partida se está configurando: seguí con el asistente.'
  await aGrupo(ctx, partida, textoConfig(ctx, partida.config), { teclado: tecladoConfig(partida.id) })
}

export async function callbackConfig(ctx: Ctx, pid: number, userId: string, msgId: number | undefined, key: string, val: string | undefined): Promise<string | void> {
  const partida = ctx.db.partida(pid)
  if (!partida || partida.estado === 'FINALIZADA') return 'Esa partida ya terminó.'
  if (partida.anfitrion_id !== userId) return 'Solo el anfitrión puede cambiar la configuración.'
  if (!msgId) return
  if (key === 'cerrar') {
    await ctx.api.editar(partida.chat_id, msgId, textoConfig(ctx, partida.config), [])
    return
  }
  if (key === 'menu') {
    await ctx.api.editar(partida.chat_id, msgId, textoConfig(ctx, partida.config), tecladoConfig(pid))
    return
  }
  const paso = PASOS.find((p) => p.key === key && p.enJuego)
  if (!paso) return
  const volver = [{ text: '↩️ Volver', callback_data: `g:${pid}:menu` }]
  if (val === undefined) {
    const filas: Teclado = paso.opciones(ctx, partida.config).map((o) => [{
      text: paso.multi ? `${partida.config.evitar.includes(o.val) ? '🚫' : '▫️'} ${o.label}` : o.label,
      callback_data: `g:${pid}:${key}:${o.val}`,
    }])
    filas.push(volver)
    await ctx.api.editar(partida.chat_id, msgId, `⚙️ <b>${esc(paso.pregunta)}</b>\nAhora: ${esc(paso.valor(ctx, partida.config))}`, filas)
    return
  }
  paso.aplicar(partida.config, val)
  const aviso = efectoCambio(ctx, partida, key)
  registrar(ctx, partida, null, 'sistema', `Configuración: ${paso.pregunta} → ${paso.valor(ctx, partida.config)}.`)
  ctx.db.guardarPartida(partida)
  if (paso.multi) {
    await callbackConfig(ctx, pid, userId, msgId, key, undefined)
    return
  }
  await ctx.api.editar(partida.chat_id, msgId, textoConfig(ctx, partida.config, `✅ ${esc(paso.pregunta.split(/[?:(]/)[0].replace('¿', '').trim())}: <b>${esc(paso.valor(ctx, partida.config))}</b>${aviso ? ` · ${aviso}` : ''}`), tecladoConfig(pid))
  await refrescarTablero(ctx, pid)
  return 'Listo, cambiado.'
}

/** Consecuencias inmediatas de cambiar algo con la partida en curso. */
function efectoCambio(ctx: Ctx, partida: Partida, key: string): string {
  const enJuego = partida.estado === 'EN_JUEGO' || partida.estado === 'PAUSADA'
  if (key === 'pla' && enJuego && partida.turno_jugador_id) {
    partida.turno_vence = vencimiento(partida.turno_desde, partida.config.plazoH, partida.config.silencio, ctx.cfg.tzMin)
    partida.recordado = 0
    return partida.config.plazoH === -1 ? 'ya se puede /saltear sin esperar' : 'el turno actual toma el plazo nuevo'
  }
  if (key === 'sil' && enJuego && partida.turno_jugador_id && partida.config.plazoH > 0) {
    partida.turno_vence = vencimiento(partida.turno_desde, partida.config.plazoH, partida.config.silencio, ctx.cfg.tzMin)
  }
  if (key === 'dur' && enJuego) {
    const activos = ctx.db.jugadores(partida.id).filter((j) => j.estado === 'activo').length
    const r = ritmoDe(partida, activos)
    recalcularObjetivo(r, partida.config, activos)
    const total = totalCapitulos(partida.config)
    if (total > 0 && partida.capitulo > total) partida.mundo.ritmo!.finalPedido = true
    return 'el ritmo del capítulo se recalculó'
  }
  return ''
}

// ------------------------------------------------------------------ empezar

/** Botón «Empezar» del tablero o /empezar. */
export async function empezarPartida(ctx: Ctx, pid: number, userId: string): Promise<string | void> {
  const { partida, jugadores } = cargar(ctx, pid)
  if (partida.anfitrion_id !== userId) return 'Solo el anfitrión puede empezar.'
  if (partida.estado !== 'CREANDO') return 'La partida ya empezó.'
  const listos = jugadores.filter((j) => j.estado === 'listo')
  if (listos.length === 0) return 'Todavía no hay ningún personaje listo.'
  const faltan = jugadores.filter((j) => j.estado === 'creando')
  await aGrupo(ctx, partida, `🌍 <b>El DJ está armando el mundo…</b>${faltan.length ? `\n(Los que siguen creando personaje —${faltan.map((j) => esc(j.nombre)).join(', ')}— se suman cuando terminen.)` : ''}`)
  const pjs = ctx.db.personajesVivos(pid).filter((p) => listos.some((j) => j.id === p.jugador_id))
  try {
    partida.guion = await crearMundo(ctx, partida, pjs)
  } catch (e) {
    ctx.log('crearMundo falló', (e as Error).message)
    await aGrupo(ctx, partida, '📡 No pude armar el mundo (falló la conexión con la IA). Probá <b>▶️ Empezar</b> de nuevo en un rato.')
    return
  }
  const g = partida.guion!
  partida.mundo.relojes.push({ id: 'amenaza', nombre: g.amenaza.reloj.slice(0, 40), segmentos: Math.min(8, Math.max(4, g.amenaza.segmentos || 6)), llenos: 0 })
  // La premisa es el objetivo del grupo: queda fija toda la partida.
  partida.mundo.misiones.push({ id: 'principal', texto: recortar(partida.config.premisa || g.premisa, 120), estado: 'activa', principal: true })
  partida.mundo.ritmo = ritmoNuevo(partida.config, listos.length)
  partida.estado = 'EN_JUEGO'
  partida.capitulo = 1
  partida.ronda = 0
  partida.rondas_cap = 0
  for (const j of listos) {
    j.estado = 'activo'
    ctx.db.guardarJugador(j)
  }
  ctx.db.guardarPartida(partida)

  const jugadoresAct = ctx.db.jugadores(pid)
  const pjsAct = ctx.db.personajesVivos(pid)
  const usuario = 'APERTURA DE LA AVENTURA. Narrá la escena inicial (máximo 180 palabras) que reúna a los personajes en la acción usando el gancho del guion y deje claro el OBJETIVO PRINCIPAL. Arrancá con algo que ya está pasando. Definí en "cambios" la ubicación inicial y los NPC que aparezcan (el objetivo principal ya existe como misión "principal"). Devolvé "vinculos": un vínculo de una línea entre cada par de personajes.'
  try {
    const d = await decidirTurno(ctx, partida, pjsAct, jugadoresAct, { tarea: 'apertura', usuario, forzarNarrar: true, rol: 'guionista', maxSalida: 3000 })
    if (d.tipo !== 'narrar') throw new Error('apertura sin narración')
    const s = d.salida
    aplicarCambios(ctx.u, partida.mundo, pjsAct, s.cambios, { enCombate: false })
    if (s.vinculos?.length) partida.mundo.vinculos = s.vinculos
    ctx.db.guardarPartida(partida)
    registrar(ctx, partida, null, 'narracion', s.narracion, s.cronica || 'Comienza la aventura.')
    const principal = partida.mundo.misiones.find((m) => m.principal)
    await aGrupo(ctx, partida, `📖 <b>${esc(g.titulo)}</b>\n\n<i>${esc(s.narracion)}</i>${principal ? `\n\n🎯 <b>Objetivo:</b> ${esc(principal.texto)}` : ''}${partida.mundo.vinculos.length ? '\n\n🔗 <b>Vínculos</b>\n' + partida.mundo.vinculos.map((v) => '• ' + esc(v)).join('\n') : ''}`)
  } catch (e) {
    ctx.log('apertura falló', (e as Error).message)
    if (e instanceof ErrorPresupuesto) await aGrupo(ctx, partida, '💸 Sin presupuesto para la apertura hoy. Los personajes ya están listos: la aventura empieza cuando se libere.')
    registrar(ctx, partida, null, 'narracion', g.gancho || g.premisa, 'Comienza la aventura.')
    await aGrupo(ctx, partida, `📖 <b>${esc(g.titulo)}</b>\n\n<i>${esc(g.gancho || g.premisa)}</i>`)
  }
  await refrescarTablero(ctx, pid)
  await iniciarTurno(ctx, pid)
}

export function partidaTitulo(p: Partida): string {
  return p.guion?.titulo ?? 'la partida'
}
