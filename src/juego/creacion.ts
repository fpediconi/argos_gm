import type { Ctx } from '../ctx.js'
import type { AtribId, Creacion, Ficha, Jugador, Partida, Personaje } from '../motor/tipos.js'
import { ATRIBUTOS } from '../motor/tipos.js'
import type { TgUser, Teclado } from '../telegram/api.js'
import {
  aplicarArquetipo, alternarEspecialidad, atributosBase, cambiarAtributo, cambiarHabilidad, construirPersonaje,
  habilidadesVacias, puntosAtributoLibres, puntosHabilidadLibres, subirAtributo, subirHabilidad, validarReparto,
} from '../motor/personaje.js'
import { generarTrasfondo, reaccionar } from '../dj/servicios.js'
import { esc, recortar } from '../util.js'
import { fichaTexto } from '../telegram/textos.js'
import { tecladoArmas, tecladoArquetipos, tecladoAtributos, tecladoHabilidades, tecladoMejora, tecladoOrigenes } from '../telegram/teclados.js'
import { aGrupo, botonGrupo, refrescarTablero, registrar } from './comun.js'
import { ajustarRitmo } from './turno.js'

const PREGUNTAS = [
  '¿Qué te sacó de casa (o del refugio)?',
  '¿Qué es lo que no querés que nadie sepa de vos?',
  '¿A quién o a qué protegerías con tu vida?',
]
const PASOS_TEXTO = ['nombre', 'aspecto', 'frase', 'q0', 'q1', 'q2']
const MAX_JUGADORES = 6

/** Partida con la que el usuario está hablando por privado. */
export function contextoDe(ctx: Ctx, userId: string): Partida | undefined {
  const u = ctx.db.usuario(userId)
  if (u?.contexto_partida_id) {
    const p = ctx.db.partida(u.contexto_partida_id)
    if (p && p.estado !== 'FINALIZADA' && ctx.db.jugadorDeUsuario(p.id, userId)) return p
  }
  const ps = ctx.db.partidasDeUsuario(userId)
  return ps[0]
}

export function jugadorDe(ctx: Ctx, p: Partida, userId: string): Jugador | undefined {
  return ctx.db.jugadorDeUsuario(p.id, userId)
}

async function mostrar(ctx: Ctx, chatId: string, msgId: number | undefined, html: string, teclado?: Teclado) {
  if (msgId) {
    try {
      await ctx.api.editar(chatId, msgId, html, teclado ?? [])
      return
    } catch {
      /* si no se puede editar, mandamos uno nuevo */
    }
  }
  await ctx.api.enviar(chatId, html, { teclado })
}

// ------------------------------------------------------------------ alta

export async function unirse(ctx: Ctx, from: TgUser, dmChatId: string, pid: number): Promise<void> {
  const userId = String(from.id)
  const partida = ctx.db.partida(pid)
  if (!partida || partida.estado === 'FINALIZADA' || partida.estado === 'CONFIG') {
    await ctx.api.enviar(dmChatId, '🤔 Esa partida no está abierta. Pedile al anfitrión que la configure (/nueva en el grupo).')
    return
  }
  ctx.db.setContexto(userId, pid)
  let j = ctx.db.jugadorDeUsuario(pid, userId)
  const nombre = from.first_name || from.username || 'Jugador'
  if (!j) {
    const activos = ctx.db.jugadores(pid).filter((x) => x.estado !== 'fuera')
    if (activos.length >= MAX_JUGADORES) {
      await ctx.api.enviar(dmChatId, `La mesa está llena (máximo ${MAX_JUGADORES}).`)
      return
    }
    j = ctx.db.crearJugador(pid, userId, nombre, from.username ?? '', dmChatId)
  } else {
    j.dm_chat_id = dmChatId
    j.nombre = nombre
  }
  const pjVivo = ctx.db.personajeVivoDe(j.id)
  if (pjVivo && j.estado !== 'fuera' && j.estado !== 'creando') {
    ctx.db.guardarJugador(j)
    await ctx.api.enviar(dmChatId, `Ya estás dentro de la partida con <b>${esc(pjVivo.ficha.nombre)}</b>. Usá /ficha para verlo.`)
    return
  }
  j.estado = 'creando'
  j.creacion = { paso: 'modo', modo: 'rapido', borrador: {} }
  ctx.db.guardarJugador(j)
  await ctx.api.enviar(dmChatId, `🎲 ¡Bienvenido a <b>${esc(partida.guion?.titulo ?? 'la partida')}</b>, ${esc(nombre)}!\nVamos a crear tu personaje: son unos 3 minutos, casi todo con botones.\n\n¿Cómo lo armamos?`, {
    teclado: [[{ text: '⚡ Rápido (solo botones)', callback_data: 'c:md:r' }], [{ text: '🎙️ Entrevista (el DJ te pregunta)', callback_data: 'c:md:e' }]],
  })
  await refrescarTablero(ctx, pid)
}

// ------------------------------------------------------------------ pasos

async function mostrarPaso(ctx: Ctx, partida: Partida, j: Jugador, msgId?: number, prefijo = ''): Promise<void> {
  const c = j.creacion!
  const chat = j.dm_chat_id!
  const b = c.borrador
  switch (c.paso) {
    case 'origen':
      return mostrar(ctx, chat, msgId, `🧬 <b>Elegí tu origen</b>\n\n${ctx.u.origenes.map((o) => `${o.emoji} <b>${esc(o.nombre)}</b> — ${esc(o.desc)}\n<i>${esc(o.rasgo)}</i>`).join('\n\n')}`, tecladoOrigenes(ctx))
    case 'arq':
      return mostrar(ctx, chat, msgId, '🎭 <b>¿Qué tipo de personaje querés ser?</b>\nUn arquetipo te arma atributos y habilidades de una (después podés ajustar), o lo armás a mano.', tecladoArquetipos(ctx))
    case 'ajuste':
      return mostrar(ctx, chat, msgId, `${resumenReparto(ctx, b)}\n\n¿Lo dejamos así?`, [
        [{ text: '✅ Seguir', callback_data: 'c:aj:ok' }],
        [{ text: '🔧 Ajustar atributos', callback_data: 'c:aj:at' }, { text: '🔧 Ajustar habilidades', callback_data: 'c:aj:hb' }],
      ])
    case 'attr':
      return mostrar(ctx, chat, msgId, `💪 <b>Atributos S.P.E.C.I.A.L.</b> (de 4 a 8, sumando 40)\nPuntos libres: <b>${puntosAtributoLibres(b.atributos as Record<AtribId, number>)}</b>\n\n${ctx.u.atributos.map((a) => `<b>${a.id}</b> ${esc(a.nombre)}: ${esc(a.desc)}`).join('\n')}`, tecladoAtributos(b))
    case 'hab': {
      const g = c.grupoHab ?? 'combate'
      const gd = ctx.u.grupos.find((x) => x.id === g)
      const hab = b.habilidades as Record<string, number>
      const esp = b.especialidades as string[]
      return mostrar(ctx, chat, msgId, `🛠️ <b>Habilidades — ${esc(gd?.nombre ?? '')}</b>\nRepartí <b>${puntosHabilidadLibres(hab, esp)}</b> puntos libres (máx. 3 por habilidad) y marcá <b>3 ⭐ especialidades</b> (arrancan en 2 y dan más críticos).\n\n${ctx.u.habilidades.filter((h) => h.grupo === g).map((h) => `<b>${esc(h.nombre)}</b> (${h.attr}): ${esc(h.desc)}`).join('\n')}`, tecladoHabilidades(ctx, b, g))
    }
    case 'nombre':
      return mostrar(ctx, chat, msgId, '✍️ <b>¿Cómo se llama tu personaje?</b> (escribilo)')
    case 'aspecto':
      return mostrar(ctx, chat, undefined, '👀 ¿Cómo es a simple vista? Una línea (edad, pinta, algo que se note).')
    case 'frase':
      return mostrar(ctx, chat, undefined, '💬 Una frase típica que diría tu personaje.')
    case 'q0': case 'q1': case 'q2': {
      const n = Number(c.paso[1])
      return mostrar(ctx, chat, undefined, `${prefijo}📖 <b>Pregunta ${n + 1}/3</b>\n${PREGUNTAS[n]}`)
    }
    case 'arma':
      return mostrar(ctx, chat, msgId, `${prefijo}🔫 <b>Elegí tu arma principal</b> (el número es el daño)`, tecladoArmas(ctx, b))
    case 'confirmar': {
      const ficha = fichaDesdeBorrador(c)
      const base = construirPersonaje(ctx.u, ficha)
      const pj: Personaje = { id: 0, partida_id: partida.id, jugador_id: j.id, ...base }
      return mostrar(ctx, chat, msgId, `${fichaTexto(ctx, pj)}\n\n¿Confirmás tu personaje?`, [
        [{ text: '✅ Confirmar', callback_data: 'c:ok' }],
        [{ text: '🔁 Empezar de nuevo', callback_data: 'c:re' }],
      ])
    }
  }
}

function resumenReparto(ctx: Ctx, b: Creacion['borrador']): string {
  const attrs = ATRIBUTOS.map((a) => `${a} ${(b.atributos as Record<AtribId, number>)[a]}`).join('  ')
  const hab = b.habilidades as Record<string, number>
  const esp = b.especialidades as string[]
  const habs = ctx.u.habilidades.filter((h) => (hab[h.id] ?? 0) > 0).map((h) => `${esp.includes(h.id) ? '⭐' : ''}${h.nombre} ${hab[h.id]}`).join(', ')
  return `📋 <b>Tu reparto</b>\n${attrs}\n${esc(habs)}`
}

function fichaDesdeBorrador(c: Creacion): Ficha {
  const b = c.borrador
  return {
    origen: b.origen!, atributos: b.atributos as Record<AtribId, number>, habilidades: b.habilidades as Record<string, number>,
    especialidades: b.especialidades as string[], nombre: b.nombre ?? 'Sin nombre', aspecto: b.aspecto ?? '', frase: b.frase ?? '',
    arma: b.arma ?? 'pistola_10mm', respuestas: b.respuestas ?? [],
  }
}

// ------------------------------------------------------------------ callbacks (c:...)

export async function callbackCreacion(ctx: Ctx, from: TgUser, msgId: number | undefined, partes: string[]): Promise<string | void> {
  const userId = String(from.id)
  const partida = contextoDe(ctx, userId)
  if (!partida) return 'No encuentro tu partida. Tocá «Crear mi personaje» en el grupo.'
  const j = jugadorDe(ctx, partida, userId)
  if (!j || !j.creacion) return 'Tu personaje ya está creado (usá /ficha).'
  const c = j.creacion
  const b = c.borrador
  const [, acc, a1, a2] = partes
  const guardar = () => ctx.db.guardarJugador(j)
  const ir = async (paso: string) => { c.paso = paso; guardar(); await mostrarPaso(ctx, partida, j, msgId) }

  switch (acc) {
    case 'md':
      c.modo = a1 === 'e' ? 'entrevista' : 'rapido'
      return ir('origen')
    case 'or':
      if (!ctx.u.origenes.some((o) => o.id === a1)) return
      b.origen = a1
      return ir('arq')
    case 'aq':
      if (a1 === 'manual') {
        b.atributos = atributosBase()
        b.habilidades = habilidadesVacias(ctx.u)
        b.especialidades = []
        c.volver = 'nombre'
        return ir('attr')
      }
      Object.assign(b, aplicarArquetipo(ctx.u, a1))
      return ir('ajuste')
    case 'aj':
      if (a1 === 'ok') return ir('nombre')
      c.volver = 'ajuste'
      if (a1 === 'at') return ir('attr')
      c.grupoHab = 'combate'
      return ir('hab')
    case 'at': {
      const attrs = b.atributos as Record<AtribId, number>
      if (a1 === 'ok') {
        if (puntosAtributoLibres(attrs) !== 0) return 'Te quedan puntos por repartir.'
        if (c.volver === 'ajuste') return ir('ajuste')
        c.grupoHab = 'combate'
        return ir('hab')
      }
      cambiarAtributo(attrs, a1 as AtribId, a2 === '+' ? 1 : -1)
      guardar()
      return mostrarPaso(ctx, partida, j, msgId)
    }
    case 'hg':
      c.grupoHab = a1
      guardar()
      return mostrarPaso(ctx, partida, j, msgId)
    case 'hb': {
      const hab = b.habilidades as Record<string, number>
      const esp = b.especialidades as string[]
      if (a1 === 'ok') {
        const errores = validarReparto(ctx.u, { atributos: b.atributos as Record<AtribId, number>, habilidades: hab, especialidades: esp })
        if (errores.length) return errores[0]
        return ir(c.volver === 'ajuste' ? 'ajuste' : 'nombre')
      }
      if (a2 === 'e') {
        if (!alternarEspecialidad(hab, esp, a1)) return 'Ya tenés 3 especialidades. Sacá una primero.'
      } else if (!cambiarHabilidad(hab, esp, a1, a2 === '+' ? 1 : -1)) return
      guardar()
      return mostrarPaso(ctx, partida, j, msgId)
    }
    case 'ar':
      if (!ctx.u.armas.some((x) => x.id === a1)) return
      b.arma = a1
      return ir('confirmar')
    case 're':
      j.creacion = { paso: 'origen', modo: c.modo, borrador: {} }
      guardar()
      return mostrarPaso(ctx, partida, j, msgId)
    case 'ok':
      return confirmarPersonaje(ctx, partida, j, msgId)
  }
}

// ------------------------------------------------------------------ texto libre

export async function textoCreacion(ctx: Ctx, from: TgUser, texto: string): Promise<boolean> {
  const userId = String(from.id)
  const partida = contextoDe(ctx, userId)
  if (!partida) return false
  const j = jugadorDe(ctx, partida, userId)
  if (!j?.creacion || !PASOS_TEXTO.includes(j.creacion.paso)) return false
  const c = j.creacion
  const b = c.borrador
  const t = recortar(texto.replace(/[<>]/g, ' ').replace(/\s+/g, ' '), 200)
  if (!t) return true
  const sigue = async (paso: string, prefijo = '') => { c.paso = paso; ctx.db.guardarJugador(j); await mostrarPaso(ctx, partida, j, undefined, prefijo) }
  switch (c.paso) {
    case 'nombre': b.nombre = recortar(t, 40); return (await sigue('aspecto'), true)
    case 'aspecto': b.aspecto = t; return (await sigue('frase'), true)
    case 'frase': b.frase = t; return (await sigue('q0'), true)
    case 'q0': case 'q1': case 'q2': {
      const n = Number(c.paso[1])
      b.respuestas = [...(b.respuestas ?? [])]
      b.respuestas[n] = t
      // El comentario del DJ va en el mismo mensaje que la próxima pregunta: una sola voz pregunta.
      let prefijo = ''
      if (c.modo === 'entrevista') {
        const r = await reaccionar(ctx, PREGUNTAS[n], t)
        if (r) prefijo = `🎙️ <i>${esc(r)}</i>\n\n`
      }
      return (await sigue(n < 2 ? `q${n + 1}` : 'arma', prefijo), true)
    }
  }
  return false
}

// ------------------------------------------------------------------ confirmación

async function confirmarPersonaje(ctx: Ctx, partida: Partida, j: Jugador, msgId: number | undefined): Promise<string | void> {
  const c = j.creacion!
  const ficha = fichaDesdeBorrador(c)
  const errores = validarReparto(ctx.u, ficha)
  if (errores.length) return errores[0]
  const base = construirPersonaje(ctx.u, ficha)
  const { trasfondo, gancho, bio } = await generarTrasfondo(ctx, partida.id, ficha)
  base.trasfondo = trasfondo
  base.gancho = gancho
  if (bio) base.ficha.bio = bio
  const pj = ctx.db.crearPersonaje(partida.id, j.id, base)
  const enJuego = partida.estado === 'EN_JUEGO' || partida.estado === 'PAUSADA'
  j.estado = enJuego ? 'activo' : 'listo'
  j.creacion = null
  ctx.db.guardarJugador(j)
  if (msgId) await ctx.api.quitarTeclado(j.dm_chat_id!, msgId)
  await ctx.api.enviar(j.dm_chat_id!, `✅ <b>¡Personaje listo!</b>\n\n${fichaTexto(ctx, pj)}\n\nVolvé al grupo. ${enJuego ? 'Entrás en el próximo turno.' : 'Cuando estén todos, el anfitrión empieza la aventura.'}`, { teclado: botonGrupo(partida) })
  if (enJuego) {
    registrar(ctx, partida, j.id, 'sistema', `${pj.ficha.nombre} se une a la aventura.`, `${pj.ficha.nombre} se une al grupo.`)
    await aGrupo(ctx, partida, `🧑‍🚀 <b>${esc(pj.ficha.nombre)}</b> (${esc(j.nombre)}) se suma a la aventura.`)
    if (partida.estado === 'PAUSADA') { partida.estado = 'EN_JUEGO'; ctx.db.guardarPartida(partida) }
    ajustarRitmo(ctx, partida.id)
  } else {
    await aGrupo(ctx, partida, `✅ <b>${esc(j.nombre)}</b> ya tiene personaje.`)
  }
  await refrescarTablero(ctx, partida.id)
}

// ------------------------------------------------------------------ mejoras de capítulo (m:...)

export async function callbackMejora(ctx: Ctx, from: TgUser, msgId: number | undefined, partes: string[]): Promise<string | void> {
  const userId = String(from.id)
  const ps = ctx.db.partidasDeUsuario(userId)
  const partida = ps.find((p) => ctx.db.jugadorDeUsuario(p.id, userId)?.mejora_pendiente)
  if (!partida) return 'No tenés ninguna mejora pendiente.'
  const j = ctx.db.jugadorDeUsuario(partida.id, userId)!
  const pj = ctx.db.personajeVivoDe(j.id)
  if (!pj) return 'No tenés personaje vivo.'
  const chat = j.dm_chat_id!
  const [, acc, a1] = partes
  if (acc === 'g') {
    const teclado: Teclado = ctx.u.habilidades.filter((h) => h.grupo === a1 && (pj.ficha.habilidades[h.id] ?? 0) < 6).map((h) => [{ text: `${h.nombre} (${pj.ficha.habilidades[h.id] ?? 0} → ${(pj.ficha.habilidades[h.id] ?? 0) + 1})`, callback_data: `m:h:${h.id}` }])
    await mostrar(ctx, chat, msgId, '⬆️ ¿Qué habilidad subís?', teclado)
    return
  }
  if (acc === 'a') {
    const teclado: Teclado = ATRIBUTOS.filter((a) => pj.ficha.atributos[a] < 10).map((a) => [{ text: `${a} (${pj.ficha.atributos[a]} → ${pj.ficha.atributos[a] + 1})`, callback_data: `m:t:${a}` }])
    await mostrar(ctx, chat, msgId, '⬆️ ¿Qué atributo subís?', teclado)
    return
  }
  let ok = false
  let que = ''
  if (acc === 'h' && ctx.u.habilidades.some((h) => h.id === a1)) { ok = subirHabilidad(pj, a1); que = ctx.u.habilidades.find((h) => h.id === a1)!.nombre }
  if (acc === 't' && (ATRIBUTOS as string[]).includes(a1)) { ok = subirAtributo(pj, a1 as AtribId); que = a1 }
  if (!ok) return 'No se puede subir eso.'
  ctx.db.guardarPersonaje(pj)
  j.mejora_pendiente = false
  ctx.db.guardarJugador(j)
  await mostrar(ctx, chat, msgId, `✅ <b>${esc(pj.ficha.nombre)}</b> mejoró: ${esc(que)}.`, botonGrupo(partida))
}

export function tecladoMejoraInicial(ctx: Ctx, capitulo: number): Teclado {
  return tecladoMejora(ctx, capitulo)
}

/** ¿El usuario está en un paso de la creación que espera texto? (para decidir si vale transcribir un audio). */
export function esperaTextoCreacion(ctx: Ctx, userId: string): boolean {
  const partida = contextoDe(ctx, userId)
  if (!partida) return false
  const j = jugadorDe(ctx, partida, userId)
  return !!j?.creacion && PASOS_TEXTO.includes(j.creacion.paso)
}
