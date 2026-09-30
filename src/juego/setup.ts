import type { Ctx } from '../ctx.js'
import type { ConfigPartida, Partida } from '../motor/tipos.js'
import type { TgMessage, Teclado } from '../telegram/api.js'
import { ErrorPresupuesto, crearMundo, decidirTurno } from '../dj/servicios.js'
import { aplicarCambios } from '../motor/estado.js'
import { esc } from '../util.js'
import { aGrupo, cargar, refrescarTablero, registrar, urlUnirse } from './comun.js'
import { iniciarTurno } from './turno.js'

export const CONFIG_DEFECTO: ConfigPartida = {
  universo: 'fallout', escenario: 'yermo', tono: 'humor', duracion: 'oneshot', plazoH: 24,
  letalidad: 'normal', evitar: [], silencio: [0, 8], plazoMaxH: 72,
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
  multi?: boolean
}

const PASOS: Paso[] = [
  {
    key: 'esc', pregunta: 'Escenario',
    opciones: (ctx) => ctx.u.escenarios.map((e) => ({ label: `${e.emoji} ${e.nombre}`, val: e.id })),
    aplicar: (c, v) => { c.escenario = v },
  },
  {
    key: 'ton', pregunta: 'Tono',
    opciones: (ctx) => ctx.u.tonos.map((t) => ({ label: t.nombre, val: t.id })),
    aplicar: (c, v) => { c.tono = v },
  },
  {
    key: 'dur', pregunta: 'Duración',
    opciones: () => [
      { label: 'One-shot (1 capítulo, ~6-8 rondas)', val: 'oneshot' },
      { label: 'Mini-campaña (4 capítulos)', val: 'mini' },
      { label: 'Campaña abierta', val: 'abierta' },
    ],
    aplicar: (c, v) => { c.duracion = v as ConfigPartida['duracion'] },
  },
  {
    key: 'pla', pregunta: 'Plazo por turno',
    opciones: () => [
      { label: '12 horas', val: '12' }, { label: '24 horas (recomendado)', val: '24' },
      { label: '48 horas', val: '48' }, { label: 'Sin plazo', val: '0' },
    ],
    aplicar: (c, v) => { c.plazoH = Number(v); c.plazoMaxH = Number(v) === 0 ? 0 : Number(v) * 3 },
  },
  {
    key: 'let', pregunta: 'Letalidad',
    opciones: () => [
      { label: 'Suave (nadie muere)', val: 'suave' },
      { label: 'Normal (recomendado)', val: 'normal' },
      { label: 'Hardcore (a 0 salud, muerte)', val: 'hardcore' },
    ],
    aplicar: (c, v) => { c.letalidad = v as ConfigPartida['letalidad'] },
  },
  {
    key: 'evi', pregunta: 'Líneas y velos: ¿qué temas evitamos? (tocá los que NO quieren y después «Listo»)', multi: true,
    opciones: () => EVITAR.map((e) => ({ label: e.label, val: e.id })),
    aplicar: (c, v) => { c.evitar = c.evitar.includes(v) ? c.evitar.filter((x) => x !== v) : [...c.evitar, v] },
  },
  {
    key: 'sil', pregunta: 'Horas de silencio (sin avisos con sonido y el plazo no corre)',
    opciones: () => [{ label: '🌙 De 00:00 a 08:00', val: 'noche' }, { label: 'Sin horas de silencio', val: 'no' }],
    aplicar: (c, v) => { c.silencio = v === 'noche' ? [0, 8] : null },
  },
]

function textoWizard(ctx: Ctx, cfg: ConfigPartida, idx: number): string {
  const paso = PASOS[idx]
  const resumen: string[] = []
  const e = ctx.u.escenarios.find((x) => x.id === cfg.escenario)
  if (idx > 0) resumen.push(`Escenario: ${e?.nombre}`)
  if (idx > 1) resumen.push(`Tono: ${ctx.u.tonos.find((x) => x.id === cfg.tono)?.nombre}`)
  if (idx > 2) resumen.push(`Duración: ${cfg.duracion}`)
  if (idx > 3) resumen.push(`Plazo: ${cfg.plazoH ? cfg.plazoH + ' h' : 'sin plazo'}`)
  if (idx > 4) resumen.push(`Letalidad: ${cfg.letalidad}`)
  return `🎲 <b>Configuración de la partida</b> · paso ${idx + 1}/${PASOS.length}\n${resumen.length ? '<i>' + esc(resumen.join(' · ')) + '</i>\n' : ''}\n<b>${esc(paso.pregunta)}</b>\n(Solo elige el anfitrión.)`
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
    await ctx.api.enviar(chatId, `Ya hay una partida en este grupo (${existente.estado === 'CONFIG' ? 'configurándose' : existente.estado.toLowerCase()}). Terminala con /fin o seguí jugando.`, { threadId: msg.message_thread_id })
    return
  }
  const cfg: ConfigPartida = JSON.parse(JSON.stringify(CONFIG_DEFECTO))
  const partida = ctx.db.crearPartida(chatId, msg.message_thread_id ?? null, String(msg.from!.id), cfg, ctx.reloj.ahora())
  const id = await aGrupo(ctx, partida, textoWizard(ctx, cfg, 0), { teclado: tecladoWizard(ctx, partida.id, cfg, 0) })
  partida.wizard_msg_id = id
  ctx.db.guardarPartida(partida)
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
  if (val !== 'ok') paso.aplicar(partida.config, val)
  ctx.db.guardarPartida(partida)
  if (idx + 1 < PASOS.length) {
    await ctx.api.editar(partida.chat_id, partida.wizard_msg_id!, textoWizard(ctx, partida.config, idx + 1), tecladoWizard(ctx, pid, partida.config, idx + 1))
    return
  }
  // Fin del asistente.
  partida.estado = 'CREANDO'
  ctx.db.guardarPartida(partida)
  const e = ctx.u.escenarios.find((x) => x.id === partida.config.escenario)
  await ctx.api.editar(partida.chat_id, partida.wizard_msg_id!, `✅ <b>Historia configurada</b>\n${esc(e?.emoji ?? '')} ${esc(e?.nombre ?? '')} · ${esc(ctx.u.tonos.find((t) => t.id === partida.config.tono)?.nombre ?? '')} · ${partida.config.plazoH ? partida.config.plazoH + ' h por turno' : 'sin plazo'} · letalidad ${partida.config.letalidad}`, [])
  await aGrupo(ctx, partida, `🧑‍🚀 <b>Ahora, a crear los personajes.</b>\nCada uno toca el botón: se abre mi chat privado y armamos la ficha en unos minutos. Cuando estén todos listos, el anfitrión toca <b>▶️ Empezar</b> en el tablero.`, { teclado: [[{ text: '🧑‍🚀 Crear mi personaje', url: urlUnirse(ctx, pid) }]] })
  await refrescarTablero(ctx, pid)
}

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
  const usuario = 'APERTURA DE LA AVENTURA. Narrá la escena inicial (máximo 180 palabras) que reúna a los personajes en la acción usando el gancho del guion. Definí en "cambios" la ubicación inicial, una misión y los NPC que aparezcan. Devolvé "vinculos": un vínculo de una línea entre cada par de personajes.'
  try {
    const d = await decidirTurno(ctx, partida, pjsAct, jugadoresAct, { tarea: 'apertura', usuario, forzarNarrar: true, rol: 'guionista', maxSalida: 3000 })
    if (d.tipo !== 'narrar') throw new Error('apertura sin narración')
    const s = d.salida
    aplicarCambios(ctx.u, partida.mundo, pjsAct, s.cambios, { enCombate: false })
    if (s.vinculos?.length) partida.mundo.vinculos = s.vinculos
    ctx.db.guardarPartida(partida)
    registrar(ctx, partida, null, 'narracion', s.narracion, s.cronica || 'Comienza la aventura.')
    await aGrupo(ctx, partida, `📖 <b>${esc(g.titulo)}</b>\n\n<i>${esc(s.narracion)}</i>${partida.mundo.vinculos.length ? '\n\n🔗 <b>Vínculos</b>\n' + partida.mundo.vinculos.map((v) => '• ' + esc(v)).join('\n') : ''}`)
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
