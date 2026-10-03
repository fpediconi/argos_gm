import type { Ctx } from '../ctx.js'
import type { AtribId, Creacion, Ficha, Jugador, Partida, Personaje, TablasCreacion } from '../motor/tipos.js'
import { ATRIBUTOS } from '../motor/tipos.js'
import type { TgUser, Teclado } from '../telegram/api.js'
import {
  aplicarArquetipo, alternarEspecialidad, atributosBase, cambiarAtributo, cambiarHabilidad, construirPersonaje, cumpleRequisito,
  habilidadesVacias, HAB_MAX_CREACION, MAX_TARAS, N_ESPECIALIDADES, puntosAtributoLibres, puntosHabilidadLibres, puntosHabilidadTotal,
  subirAtributo, subirHabilidad, tarasDe, validarReparto,
} from '../motor/personaje.js'
import { compilarFicha, generarTrasfondo, pasoEntrevista, TEMAS_ENTREVISTA } from '../dj/servicios.js'
import { esc, recortar } from '../util.js'
import { fichaTexto } from '../telegram/textos.js'
import { tecladoArquetipos, tecladoAtributos, tecladoHabilidades, tecladoMejora, tecladoOrigenes } from '../telegram/teclados.js'
import { aGrupo, botonGrupo, refrescarTablero, registrar } from './comun.js'
import { ajustarRitmo, iniciarTurno } from './turno.js'
import { escenaDe, narrativaDe } from '../motor/canon.js'
import { migrarCanon } from './narrativa.js'
import type { Rng } from '../motor/dados.js'

const MAX_JUGADORES = 6
const MAX_REPREGUNTAS = 6
/** Pasos que esperan texto (o audio) del jugador. */
const PASOS_TEXTO = ['txt', 'ent']

/** Campos de texto que se pueden escribir o sortear, y la tabla de donde sale el sorteo. */
const CAMPOS: Record<string, { label: string; tabla: keyof TablasCreacion | 'nombres'; max: number }> = {
  nombre: { label: 'Nombre', tabla: 'nombres', max: 40 },
  edad: { label: 'Edad', tabla: 'edades', max: 40 },
  aspecto: { label: 'Aspecto', tabla: 'aspectos', max: 160 },
  voz: { label: 'Cómo habla', tabla: 'voces', max: 100 },
  frase: { label: 'Frase típica', tabla: 'frases', max: 140 },
  oficio: { label: 'Oficio', tabla: 'oficios', max: 60 },
  marca: { label: 'Lo que lo marcó', tabla: 'marcas', max: 160 },
  objetivo: { label: 'Qué quiere', tabla: 'objetivos', max: 160 },
  miedo: { label: 'Qué teme', tabla: 'miedos', max: 120 },
  secreto: { label: 'Su secreto (privado)', tabla: 'secretos', max: 160 },
  mentira: { label: 'Lo que dice y es mentira', tabla: 'mentiras', max: 140 },
  persona: { label: 'Persona importante', tabla: 'personas', max: 140 },
  deuda: { label: 'Deuda', tabla: 'deudas', max: 140 },
  objetoPersonal: { label: 'Objeto personal', tabla: 'objetosPersonales', max: 80 },
  defecto: { label: 'Defecto', tabla: 'defectos', max: 40 },
  vicio: { label: 'Vicio', tabla: 'vicios', max: 60 },
  valor: { label: 'Lo que valora', tabla: 'valores', max: 40 },
  lazo: { label: 'Lazo con la historia', tabla: 'personas', max: 160 },
}

/** Secciones del Hub: qué campos muestra cada una. */
const SECCIONES: Record<string, { titulo: string; emoji: string; campos: string[] }> = {
  id: { titulo: 'Identidad', emoji: '🧍', campos: ['nombre', 'edad', 'aspecto', 'voz', 'frase'] },
  pe: { titulo: 'Personalidad', emoji: '🎭', campos: ['defecto', 'vicio', 'valor'] },
  pa: { titulo: 'Pasado', emoji: '📖', campos: ['oficio', 'marca'] },
  mi: { titulo: 'Motor interno', emoji: '🧩', campos: ['objetivo', 'miedo', 'secreto', 'mentira'] },
  la: { titulo: 'Lazos', emoji: '🔗', campos: ['persona', 'deuda', 'lazo'] },
  eq: { titulo: 'Equipo', emoji: '🔫', campos: ['objetoPersonal'] },
}
/** Campos que se eligen de una lista (botones) además de sortear o escribir. */
const CON_LISTA = ['edad', 'defecto', 'vicio', 'valor']

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

async function mostrar(ctx: Ctx, chatId: string, msgId: number | undefined, html: string, teclado?: Teclado): Promise<number | undefined> {
  if (msgId) {
    try {
      await ctx.api.editar(chatId, msgId, html, teclado ?? [])
      return msgId
    } catch {
      /* si no se puede editar, mandamos uno nuevo */
    }
  }
  return ctx.api.enviar(chatId, html, { teclado })
}

// ------------------------------------------------------------------ sorteo coherente

/** Elige de una lista con los dados del motor (dos d20 para cubrir listas largas). */
function elegir<T>(xs: T[], rng: Rng): T {
  return xs[((rng() - 1) * 20 + (rng() - 1)) % xs.length]
}

function tablaDe(ctx: Ctx, campo: string, b: Creacion['borrador']): string[] {
  const t = ctx.u.tablas
  const def = CAMPOS[campo]
  if (!def) return []
  if (def.tabla === 'nombres') return t.nombres[b.origen ?? ''] ?? Object.values(t.nombres).flat()
  return t[def.tabla] as string[]
}

/** Opciones de lazo para quien entra a mitad de partida: gente y hechos que ya existen en la historia. */
function opcionesLazo(ctx: Ctx, p: Partida): string[] {
  const muertos = ctx.db.personajesTodos(p.id).filter((x) => !x.vivo).map((x) => `Conocía a ${x.ficha.nombre}, que murió`)
  const npcs = p.mundo.npcs.filter((n) => n.conocido && n.estado !== 'muerto').slice(0, 4).map((n) => `Tiene historia con ${n.nombre}`)
  const vivos = ctx.db.personajesVivos(p.id).slice(0, 3).map((x) => `Le debe algo a ${x.ficha.nombre}`)
  return [...muertos, ...npcs, ...vivos].slice(0, 8)
}

function sortearCampo(ctx: Ctx, campo: string, b: Creacion['borrador'], partida?: Partida): string {
  if (campo === 'lazo') {
    const ops = partida && partida.estado !== 'CREANDO' ? opcionesLazo(ctx, partida) : []
    return ops.length ? elegir(ops, ctx.rng) : ''
  }
  const xs = tablaDe(ctx, campo, b)
  if (!xs.length) return ''
  if (campo === 'vicio') return elegir(xs, ctx.rng) === 'Ninguno' ? 'Ninguno' : elegir(xs, ctx.rng)
  return elegir(xs, ctx.rng)
}

const armaDeHabilidad = (ctx: Ctx, hab: string) => ctx.u.armas.filter((a) => a.habilidad === hab && !a.consumible)

/** Completa todo lo que falta con valores coherentes con el origen y el arquetipo. No pisa lo que ya está. */
export function completarBorrador(ctx: Ctx, b: Creacion['borrador'], partida?: Partida): void {
  const u = ctx.u
  if (!b.arma) {
    const combate = (b.especialidades ?? []).find((h) => armaDeHabilidad(ctx, h).length)
    const armas = combate ? armaDeHabilidad(ctx, combate) : armaDeHabilidad(ctx, 'armas_pequenas')
    b.arma = (armas.length ? elegir(armas, ctx.rng) : u.armas[0]).id
  }
  if (!b.extras) {
    const esp = b.especialidades ?? []
    const validos = (u.extras ?? []).filter((e) => cumpleRequisito(u, b.atributos as Record<AtribId, number>, e.id))
    const afines = validos.filter((e) => e.efectos.some((x) => x.tipo === 'hab' && esp.includes(x.id)))
    const pool = afines.length ? afines : validos
    b.extras = pool.length ? [elegir(pool, ctx.rng).id] : []
  }
  b.rasgos ??= []
  if (!b.subOrigen) {
    const subs = u.origenes.find((o) => o.id === b.origen)?.sub ?? []
    if (subs.length) b.subOrigen = elegir(subs, ctx.rng).id
  }
  for (const campo of Object.keys(CAMPOS)) {
    const actual = (b as Record<string, unknown>)[campo]
    if (actual === undefined || actual === '') {
      const v = sortearCampo(ctx, campo, b, partida)
      if (v) (b as Record<string, unknown>)[campo] = v
    }
  }
  if (!b.virtudes?.length) {
    const vs = [...u.tablas.virtudes]
    const a = elegir(vs, ctx.rng)
    const resto = vs.filter((x) => x !== a)
    b.virtudes = [a, elegir(resto, ctx.rng)]
  }
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
  await ctx.api.enviar(dmChatId, `🎲 ¡Bienvenido a <b>${esc(partida.guion?.titulo ?? 'la partida')}</b>, ${esc(nombre)}!\nVamos a crear tu personaje.\n\n⚡ <b>Rápido</b>: elegís origen y estilo, y te armo una ficha completa en 4 toques. Después cambiás lo que quieras.\n🎙️ <b>Guiado</b>: me contás (escrito o en audio) quién querés jugar, te hago unas preguntas y lo armo yo.`, {
    teclado: [[{ text: '⚡ Rápido', callback_data: 'c:md:r' }], [{ text: '🎙️ Guiado (me contás y lo armo)', callback_data: 'c:md:e' }]],
  })
  await refrescarTablero(ctx, pid)
}

// ------------------------------------------------------------------ pantallas

function tecladoSubOrigen(ctx: Ctx, origen: string): Teclado {
  const subs = ctx.u.origenes.find((o) => o.id === origen)?.sub ?? []
  return [...subs.map((s) => [{ text: s.nombre, callback_data: `c:so:${s.id}` }]), [{ text: '🎲 Que lo elija el DJ', callback_data: 'c:so:r' }]]
}

function personajePrevio(ctx: Ctx, partida: Partida, j: Jugador, c: Creacion): Personaje | null {
  try {
    const base = construirPersonaje(ctx.u, fichaDesdeBorrador(c))
    return { id: 0, partida_id: partida.id, jugador_id: j.id, ...base }
  } catch {
    return null
  }
}

function textoHub(ctx: Ctx, partida: Partida, j: Jugador, c: Creacion, prefijo = ''): string {
  const b = c.borrador
  const o = ctx.u.origenes.find((x) => x.id === b.origen)
  const sub = o?.sub?.find((x) => x.id === b.subOrigen)
  const pj = personajePrevio(ctx, partida, j, c)
  const l: string[] = []
  if (prefijo) l.push(prefijo, '')
  l.push(`📋 <b>Tu personaje</b> — tocá una sección para cambiarla, o ✅ si ya está.`)
  l.push('')
  // La ficha ya trae extras, personalidad, objetivo, secreto y mentira (en privado): acá solo se suma lo que no está.
  if (pj) l.push(fichaTexto(ctx, pj, true).replace(/\n🎯 Gancho:.*$/m, '').replace(/\n📖 .*$/m, ''))
  if (sub) l.push(`🧬 ${esc(sub.nombre)}: <i>${esc(sub.desc)}</i>`)
  if (b.oficio || b.marca) l.push(`📖 ${esc([b.oficio, b.marca].filter(Boolean).join(' · '))}`)
  if (b.persona || b.deuda) l.push(`🔗 ${esc([b.persona, b.deuda].filter(Boolean).join(' · '))}`)
  if (b.lazo) l.push(`🧵 Lazo con la historia: ${esc(b.lazo)}`)
  if (c.ajustes?.length) l.push('', `🔧 <i>Ajusté: ${esc(c.ajustes.join(' · '))}</i>`)
  return l.join('\n')
}

function tecladoHub(c: Creacion): Teclado {
  const t = (id: string, txt: string) => ({ text: `${(c.tocadas ?? []).includes(id) ? '✏️ ' : ''}${txt}`, callback_data: `c:hub:${id}` })
  return [
    [t('at', '💪 Atributos'), t('hb', '🛠️ Habilidades')],
    [t('ex', '⭐ Extras y rasgos'), t('eq', '🔫 Equipo')],
    [t('id', '🧍 Identidad'), t('pe', '🎭 Personalidad')],
    [t('pa', '📖 Pasado'), t('mi', '🧩 Motor interno')],
    [t('la', '🔗 Lazos')],
    [{ text: '✅ Confirmar personaje', callback_data: 'c:ok' }],
    [{ text: '🔁 Empezar de nuevo', callback_data: 'c:re' }],
  ]
}

const volverHub: Teclado[number] = [{ text: '↩️ Volver a la ficha', callback_data: 'c:hub:h' }]

function filasCampo(campo: string): Teclado {
  const f: Teclado[number] = [{ text: `🎲 ${CAMPOS[campo].label}`, callback_data: `c:rn:${campo}` }, { text: '✍️ Escribir', callback_data: `c:tx:${campo}` }]
  if (CON_LISTA.includes(campo)) f.push({ text: '📋 Elegir', callback_data: `c:ls:${campo}` })
  return [f]
}

function textoSeccion(ctx: Ctx, sec: string, b: Creacion['borrador']): string {
  const s = SECCIONES[sec]
  const l = [`${s.emoji} <b>${s.titulo}</b>`, '']
  for (const campo of s.campos) {
    const v = (b as Record<string, unknown>)[campo]
    l.push(`<b>${CAMPOS[campo].label}:</b> ${v ? esc(String(v)) : '<i>(vacío)</i>'}`)
  }
  if (sec === 'pe') l.splice(2, 0, `<b>Virtudes (2):</b> ${esc((b.virtudes ?? []).join(', ') || '-')}`)
  if (sec === 'pa') {
    const o = ctx.u.origenes.find((x) => x.id === b.origen)
    const sub = o?.sub?.find((x) => x.id === b.subOrigen)
    l.splice(2, 0, `<b>Origen:</b> ${esc(o?.nombre ?? '')}${sub ? ` — ${esc(sub.nombre)}` : ''}`)
  }
  if (sec === 'eq') {
    const a1 = ctx.u.armas.find((x) => x.id === b.arma)
    const a2 = ctx.u.armas.find((x) => x.id === b.arma2)
    l.splice(2, 0, `<b>Arma principal:</b> ${esc(a1?.nombre ?? '-')}`, `<b>Arma secundaria:</b> ${esc(a2?.nombre ?? 'ninguna')}`)
  }
  if (sec === 'mi') l.push('', '<i>El secreto y la mentira son tuyos: el DJ los usa, pero nunca los revela por su cuenta.</i>')
  if (sec === 'la') l.push('', '<i>El DJ va a usar a tu persona importante y tu deuda en tu arco personal.</i>')
  l.push('', 'Tocá 🎲 para otra opción, ✍️ para escribirla vos (o mandá un audio).')
  return l.join('\n')
}

function tecladoSeccion(ctx: Ctx, sec: string, b: Creacion['borrador'], partida: Partida): Teclado {
  const filas: Teclado = []
  if (sec === 'pe') {
    const vs = ctx.u.tablas.virtudes
    for (let i = 0; i < vs.length; i += 3) filas.push(vs.slice(i, i + 3).map((v, k) => ({ text: `${(b.virtudes ?? []).includes(v) ? '✅ ' : ''}${v}`, callback_data: `c:vi:${i + k}` })))
  }
  if (sec === 'pa') filas.push([{ text: '🧬 Cambiar variante del origen', callback_data: 'c:hub:so' }])
  if (sec === 'eq') filas.push([{ text: '🔫 Arma principal', callback_data: 'c:hub:ar' }, { text: '🗡️ Secundaria', callback_data: 'c:hub:a2' }])
  for (const campo of SECCIONES[sec].campos) {
    if (campo === 'lazo' && partida.estado === 'CREANDO') continue
    filas.push(...filasCampo(campo))
  }
  filas.push(volverHub)
  return filas
}

function textoExtras(ctx: Ctx, b: Creacion['borrador'], rasgos: boolean): string {
  const u = ctx.u
  if (!rasgos) {
    return `⭐ <b>Extras</b> (elegís 1 al crear; después ganás más con las mejoras)\n\n${u.extras.map((e) => `${(b.extras ?? []).includes(e.id) ? '✅' : '▫️'} <b>${esc(e.nombre)}</b>: ${esc(e.desc)}${e.req ? ` <i>(pide ${Object.entries(e.req).map(([a, v]) => `${a} ${v}`).join(', ')})</i>` : ''}`).join('\n')}`
  }
  const total = puntosHabilidadTotal(u, b)
  return `🧷 <b>Rasgos</b> (1 rasgo con ventaja y contra; y hasta ${MAX_TARAS} taras, que te dan puntos de habilidad)\nPuntos de habilidad con tus taras: <b>${total}</b>\n\n${u.rasgos.map((r) => `${(b.rasgos ?? []).includes(r.id) ? '✅' : '▫️'} <b>${esc(r.nombre)}</b>: ${esc(r.desc)}`).join('\n')}`
}

function tecladoExtras(ctx: Ctx, b: Creacion['borrador'], rasgos: boolean): Teclado {
  const filas: Teclado = []
  const xs = rasgos ? ctx.u.rasgos : ctx.u.extras
  for (let i = 0; i < xs.length; i += 2) {
    filas.push(xs.slice(i, i + 2).map((x) => {
      const sel = (rasgos ? b.rasgos : b.extras)?.includes(x.id)
      const ok = rasgos || cumpleRequisito(ctx.u, b.atributos as Record<AtribId, number>, x.id)
      return { text: `${sel ? '✅ ' : ok ? '' : '🔒 '}${x.nombre}`, callback_data: `c:${rasgos ? 'xr' : 'xe'}:${x.id}` }
    }))
  }
  filas.push([{ text: rasgos ? '⭐ Ver extras' : '🧷 Ver rasgos y taras', callback_data: `c:hub:${rasgos ? 'ex' : 'ra'}` }])
  filas.push(volverHub)
  return filas
}

function tecladoArmasTodas(ctx: Ctx, campo: 'ar' | 'a2'): Teclado {
  const filas: Teclado = []
  const xs = ctx.u.armas.filter((a) => a.id !== 'punos' || campo === 'ar')
  for (let i = 0; i < xs.length; i += 2) filas.push(xs.slice(i, i + 2).map((a) => ({ text: `${a.nombre} (${a.danio})`, callback_data: `c:${campo}:${a.id}` })))
  if (campo === 'a2') filas.push([{ text: 'Ninguna', callback_data: 'c:a2:-' }])
  filas.push([{ text: '↩️ Volver', callback_data: 'c:hub:eq' }])
  return filas
}

function tecladoLista(ctx: Ctx, campo: string, b: Creacion['borrador']): Teclado {
  const xs = tablaDe(ctx, campo, b)
  const filas: Teclado = []
  for (let i = 0; i < xs.length; i += 2) filas.push(xs.slice(i, i + 2).map((v, k) => ({ text: v.slice(0, 40), callback_data: `c:pk:${campo}:${i + k}` })))
  filas.push([{ text: '↩️ Volver', callback_data: `c:hub:${seccionDe(campo)}` }])
  return filas
}

const seccionDe = (campo: string) => Object.entries(SECCIONES).find(([, s]) => s.campos.includes(campo))?.[0] ?? 'h'

async function mostrarPaso(ctx: Ctx, partida: Partida, j: Jugador, msgId?: number, prefijo = ''): Promise<void> {
  const c = j.creacion!
  const chat = j.dm_chat_id!
  const b = c.borrador
  const ir = async (html: string, t?: Teclado) => {
    const id = await mostrar(ctx, chat, msgId, html, t)
    if (id && c.hubMsg !== id) { c.hubMsg = id; ctx.db.guardarJugador(j) }
  }
  switch (c.paso) {
    case 'origen':
      return ir(`${prefijo}🧬 <b>Elegí tu origen</b>\n\n${ctx.u.origenes.map((o) => `${o.emoji} <b>${esc(o.nombre)}</b> — ${esc(o.desc)}`).join('\n')}`, tecladoOrigenes(ctx))
    case 'sub': {
      const o = ctx.u.origenes.find((x) => x.id === b.origen)
      return ir(`🧬 <b>${esc(o?.nombre ?? '')}</b>: ¿de qué tipo?\n\n${(o?.sub ?? []).map((s) => `<b>${esc(s.nombre)}</b> — ${esc(s.desc)}`).join('\n')}`, tecladoSubOrigen(ctx, b.origen!))
    }
    case 'arq':
      return ir('🎭 <b>¿Qué estilo de personaje querés?</b>\nEl estilo arma atributos y habilidades de una (después ajustás todo), o lo armás a mano.', tecladoArquetipos(ctx))
    case 'attr':
      return ir(`💪 <b>Atributos S.P.E.C.I.A.L.</b> (de 4 a 8, sumando 40)\nPuntos libres: <b>${puntosAtributoLibres(b.atributos as Record<AtribId, number>)}</b>\n\n${ctx.u.atributos.map((a) => `<b>${a.id}</b> ${esc(a.nombre)}: ${esc(a.desc)}`).join('\n')}`, tecladoAtributos(b))
    case 'hab': {
      const g = c.grupoHab ?? 'combate'
      const gd = ctx.u.grupos.find((x) => x.id === g)
      const hab = b.habilidades as Record<string, number>
      const esp = b.especialidades as string[]
      const total = puntosHabilidadTotal(ctx.u, b)
      return ir(`🛠️ <b>Habilidades — ${esc(gd?.nombre ?? '')}</b>\nRepartí <b>${puntosHabilidadLibres(hab, esp, total)}</b> puntos libres (máx. ${HAB_MAX_CREACION} por habilidad) y marcá <b>${N_ESPECIALIDADES} ⭐ especialidades</b> (arrancan en 2 y dan más críticos).\n\n${ctx.u.habilidades.filter((h) => h.grupo === g).map((h) => `<b>${esc(h.nombre)}</b> (${h.attr}): ${esc(h.desc)}`).join('\n')}`, tecladoHabilidades(ctx, b, g, total))
    }
    case 'hub':
      return ir(textoHub(ctx, partida, j, c, prefijo), tecladoHub(c))
    case 'sec': {
      const sec = c.volver ?? 'id'
      if (sec === 'ex' || sec === 'ra') return ir(textoExtras(ctx, b, sec === 'ra'), tecladoExtras(ctx, b, sec === 'ra'))
      if (sec === 'ar' || sec === 'a2') return ir(`🔫 <b>${sec === 'ar' ? 'Arma principal' : 'Arma secundaria'}</b> (el número es el daño)`, tecladoArmasTodas(ctx, sec))
      if (sec === 'so') return ir('🧬 <b>Variante del origen</b>', [...tecladoSubOrigen(ctx, b.origen!).slice(0, -1), [{ text: '↩️ Volver', callback_data: 'c:hub:pa' }]])
      if (sec.startsWith('ls:')) {
        const campo = sec.slice(3)
        return ir(`📋 <b>${esc(CAMPOS[campo]?.label ?? campo)}</b>: elegí una`, tecladoLista(ctx, campo, b))
      }
      return ir(`${prefijo}${textoSeccion(ctx, sec, b)}`, tecladoSeccion(ctx, sec, b, partida))
    }
    case 'txt': {
      const campo = c.campo ?? 'nombre'
      const actual = (b as Record<string, unknown>)[campo]
      return ir(`✍️ <b>${esc(CAMPOS[campo]?.label ?? campo)}</b>: escribilo en el chat (o mandá un audio).${actual ? `\n<i>Ahora: ${esc(String(actual))}</i>` : ''}`, [[{ text: '↩️ Cancelar', callback_data: `c:hub:${c.volver ?? seccionDe(campo)}` }]])
    }
    case 'ent': {
      // La pregunta anterior pierde su botón: solo la última ofrece «Ya está».
      if (!msgId && c.hubMsg) await ctx.api.quitarTeclado(chat, c.hubMsg)
      const teclado = c.entrevista?.length ? [[{ text: '⏭ Ya está, armalo', callback_data: 'c:ent:ya' }]] : undefined
      return ir(prefijo || '🎙️ <b>Contame quién es tu personaje</b>, como se lo contarías a un amigo: de dónde viene, qué hace, cómo es. Escribilo o mandame un audio.', teclado)
    }
  }
}

export function fichaDesdeBorrador(c: Creacion): Ficha {
  const b = c.borrador
  return {
    origen: b.origen!, atributos: b.atributos as Record<AtribId, number>, habilidades: b.habilidades as Record<string, number>,
    especialidades: b.especialidades as string[], nombre: b.nombre ?? 'Sin nombre', aspecto: b.aspecto ?? '', frase: b.frase ?? '',
    arma: b.arma ?? 'pistola_10mm', respuestas: b.respuestas ?? [],
    subOrigen: b.subOrigen, arma2: b.arma2, extras: b.extras ?? [], rasgos: b.rasgos ?? [], edad: b.edad, voz: b.voz,
    virtudes: b.virtudes, defecto: b.defecto, vicio: b.vicio, valor: b.valor, oficio: b.oficio, marca: b.marca,
    objetivo: b.objetivo, miedo: b.miedo, secreto: b.secreto, mentira: b.mentira, persona: b.persona, deuda: b.deuda,
    objetoPersonal: b.objetoPersonal, lazo: b.lazo, secretoEstado: b.secreto ? 'oculto' : undefined,
  }
}

// ------------------------------------------------------------------ callbacks (c:...)

const tocar = (c: Creacion, sec: string) => { c.tocadas = [...new Set([...(c.tocadas ?? []), sec])] }

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
  const ir = async (paso: string, volver?: string) => { c.paso = paso; if (volver !== undefined) c.volver = volver; guardar(); await mostrarPaso(ctx, partida, j, msgId) }
  const hub = () => ir('hub')
  const seccion = (sec: string) => ir('sec', sec)

  switch (acc) {
    case 'md':
      c.modo = a1 === 'e' ? 'entrevista' : 'rapido'
      if (c.modo === 'entrevista') { c.entrevista = []; c.hubMsg = msgId; return ir('ent') }
      return ir('origen')
    case 'or':
      if (!ctx.u.origenes.some((o) => o.id === a1)) return
      b.origen = a1
      return ir('sub')
    case 'so': {
      const subs = ctx.u.origenes.find((o) => o.id === b.origen)?.sub ?? []
      b.subOrigen = a1 === 'r' ? subs[(ctx.rng() - 1) % Math.max(1, subs.length)]?.id : subs.find((s) => s.id === a1)?.id
      if (c.paso === 'sec') { tocar(c, 'pa'); return seccion('pa') }
      return ir('arq')
    }
    case 'aq':
      if (a1 === 'manual') {
        b.atributos = atributosBase()
        b.habilidades = habilidadesVacias(ctx.u)
        b.especialidades = []
        c.volver = 'hub'
        tocar(c, 'at')
        return ir('attr')
      }
      if (!ctx.u.arquetipos.some((x) => x.id === a1)) return
      Object.assign(b, aplicarArquetipo(ctx.u, a1))
      completarBorrador(ctx, b, partida)
      c.paso = 'hub'
      guardar()
      return mostrarPaso(ctx, partida, j, msgId, '✨ <b>Listo, te armé una ficha completa.</b> Cambiá lo que quieras.')
    case 'hub': {
      if (a1 === 'h') return hub()
      if (a1 === 'at') { c.volver = 'hub'; tocar(c, 'at'); return ir('attr') }
      if (a1 === 'hb') { c.volver = 'hub'; c.grupoHab = 'combate'; tocar(c, 'hb'); return ir('hab') }
      return seccion(a1)
    }
    case 'at': {
      const attrs = b.atributos as Record<AtribId, number>
      if (a1 === 'ok') {
        if (puntosAtributoLibres(attrs) !== 0) return 'Te quedan puntos por repartir.'
        // Si un Extra elegido ya no cumple el requisito, se saca.
        b.extras = (b.extras ?? []).filter((id) => cumpleRequisito(ctx.u, attrs, id))
        if (c.volver === 'hub' && (b.especialidades ?? []).length === N_ESPECIALIDADES) return hub()
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
      const total = puntosHabilidadTotal(ctx.u, b)
      if (a1 === 'ok') {
        const errores = validarReparto(ctx.u, { atributos: b.atributos as Record<AtribId, number>, habilidades: hab, especialidades: esp, rasgos: b.rasgos })
        if (errores.length) return errores[0]
        completarBorrador(ctx, b, partida)
        return hub()
      }
      if (a2 === 'e') {
        if (!alternarEspecialidad(hab, esp, a1)) return `Ya tenés ${N_ESPECIALIDADES} especialidades. Sacá una primero.`
      } else if (!cambiarHabilidad(hab, esp, a1, a2 === '+' ? 1 : -1, total)) return
      guardar()
      return mostrarPaso(ctx, partida, j, msgId)
    }
    case 'xe': {
      if (!ctx.u.extras.some((x) => x.id === a1)) return
      if (!cumpleRequisito(ctx.u, b.atributos as Record<AtribId, number>, a1)) return 'No cumplís el requisito de ese Extra.'
      b.extras = (b.extras ?? []).includes(a1) ? [] : [a1]
      tocar(c, 'ex')
      guardar()
      return mostrarPaso(ctx, partida, j, msgId)
    }
    case 'xr': {
      const r = ctx.u.rasgos.find((x) => x.id === a1)
      if (!r) return
      const actuales = b.rasgos ?? []
      let nuevos: string[]
      if (actuales.includes(a1)) nuevos = actuales.filter((x) => x !== a1)
      else if (r.tara) {
        if (tarasDe(ctx.u, { rasgos: actuales }) >= MAX_TARAS) return `Máximo ${MAX_TARAS} taras.`
        nuevos = [...actuales, a1]
      } else nuevos = [...actuales.filter((x) => ctx.u.rasgos.find((y) => y.id === x)?.tara), a1]
      // Sacar una tara quita puntos: si ya estaban gastados, primero hay que bajar habilidades.
      if (puntosHabilidadLibres(b.habilidades as Record<string, number>, b.especialidades as string[], puntosHabilidadTotal(ctx.u, { rasgos: nuevos })) < 0) return 'Esa tara te daba puntos que ya usaste: bajá alguna habilidad primero.'
      b.rasgos = nuevos
      tocar(c, 'ex')
      guardar()
      return mostrarPaso(ctx, partida, j, msgId)
    }
    case 'ar': case 'a2': {
      if (a1 === '-' && acc === 'a2') delete b.arma2
      else if (ctx.u.armas.some((x) => x.id === a1)) { if (acc === 'ar') b.arma = a1; else b.arma2 = a1 }
      else return
      tocar(c, 'eq')
      return seccion('eq')
    }
    case 'vi': {
      const v = ctx.u.tablas.virtudes[Number(a1)]
      if (!v) return
      const vs = b.virtudes ?? []
      b.virtudes = vs.includes(v) ? vs.filter((x) => x !== v) : [...vs, v].slice(-2)
      tocar(c, 'pe')
      guardar()
      return mostrarPaso(ctx, partida, j, msgId)
    }
    case 'rn': {
      if (!CAMPOS[a1]) return
      const v = sortearCampo(ctx, a1, b, partida)
      if (v) (b as Record<string, unknown>)[a1] = v
      tocar(c, seccionDe(a1))
      return seccion(seccionDe(a1))
    }
    case 'ls':
      if (!CAMPOS[a1]) return
      return seccion(`ls:${a1}`)
    case 'pk': {
      const v = tablaDe(ctx, a1, b)[Number(a2)]
      if (!v) return
      ;(b as Record<string, unknown>)[a1] = v
      tocar(c, seccionDe(a1))
      return seccion(seccionDe(a1))
    }
    case 'tx':
      if (!CAMPOS[a1]) return
      c.campo = a1
      c.volver = seccionDe(a1)
      c.paso = 'txt'
      guardar()
      return mostrarPaso(ctx, partida, j, msgId)
    case 'ent':
      if (a1 === 'ya') return compilarEntrevista(ctx, partida, j)
      return
    case 're':
      j.creacion = { paso: 'modo', modo: c.modo, borrador: {} }
      guardar()
      await ctx.api.enviar(j.dm_chat_id!, 'Empezamos de nuevo. ¿Cómo lo armamos?', { teclado: [[{ text: '⚡ Rápido', callback_data: 'c:md:r' }], [{ text: '🎙️ Guiado', callback_data: 'c:md:e' }]] })
      return
    case 'ok':
      return confirmarPersonaje(ctx, partida, j, msgId)
  }
}

// ------------------------------------------------------------------ texto libre (y audios transcriptos)

export async function textoCreacion(ctx: Ctx, from: TgUser, texto: string): Promise<boolean> {
  const userId = String(from.id)
  const partida = contextoDe(ctx, userId)
  if (!partida) return false
  const j = jugadorDe(ctx, partida, userId)
  if (!j?.creacion || !PASOS_TEXTO.includes(j.creacion.paso)) return false
  const c = j.creacion
  const b = c.borrador
  if (c.paso === 'txt') {
    const campo = c.campo ?? 'nombre'
    const t = recortar(texto.replace(/[<>]/g, ' ').replace(/\s+/g, ' '), CAMPOS[campo]?.max ?? 160)
    if (!t) return true
    ;(b as Record<string, unknown>)[campo] = t
    tocar(c, seccionDe(campo))
    c.paso = 'sec'
    c.volver = seccionDe(campo)
    ctx.db.guardarJugador(j)
    // El pedido queda como registro sin botones y la sección sigue en un mensaje nuevo (abajo de lo que escribió).
    if (c.hubMsg) await ctx.api.editar(j.dm_chat_id!, c.hubMsg, `✍️ ${esc(CAMPOS[campo]?.label ?? campo)}: <b>${esc(t)}</b> ✅`, [])
    await mostrarPaso(ctx, partida, j)
    return true
  }
  // Entrevista guiada: cada respuesta se suma a la charla y el DJ pregunta por lo que falta.
  const t = recortar(texto.replace(/[<>]/g, ' ').replace(/\s+/g, ' '), 800)
  if (!t) return true
  const charla = c.entrevista ?? []
  charla.push({ p: c.ultima ?? 'Contame quién es tu personaje.', r: t })
  c.entrevista = charla
  ctx.db.guardarJugador(j)
  if (charla.length > MAX_REPREGUNTAS) return compilarEntrevista(ctx, partida, j).then(() => true)
  const r = await pasoEntrevista(ctx, partida.id, charla)
  c.cubiertos = r.cubiertos
  const completo = TEMAS_ENTREVISTA.every((x) => r.cubiertos.includes(x))
  if (!r.pregunta || completo) return compilarEntrevista(ctx, partida, j).then(() => true)
  c.ultima = r.pregunta
  ctx.db.guardarJugador(j)
  const quedan = Math.max(1, Math.min(TEMAS_ENTREVISTA.filter((x) => !r.cubiertos.includes(x)).length, MAX_REPREGUNTAS + 1 - charla.length))
  await mostrarPaso(ctx, partida, j, undefined, `🎙️ ${esc(r.pregunta)}\n\n<i>(${quedan === 1 ? 'Una pregunta más' : `Unas ${quedan} preguntas más`} y lo armo. Si preferís, tocá «Ya está» y completo yo el resto.)</i>`)
  return true
}

/** La IA convierte la charla en una ficha con ids del catálogo; el motor la valida y la repara. */
async function compilarEntrevista(ctx: Ctx, partida: Partida, j: Jugador): Promise<void> {
  const c = j.creacion!
  if (c.hubMsg) await ctx.api.quitarTeclado(j.dm_chat_id!, c.hubMsg)
  c.hubMsg = undefined
  await ctx.api.enviar(j.dm_chat_id!, '🛠️ Armando tu personaje…')
  const crudo = await compilarFicha(ctx, partida.id, c.entrevista ?? [])
  const { borrador, ajustes } = fichaDesdeCompilado(ctx, crudo)
  completarBorrador(ctx, borrador, partida)
  c.borrador = borrador
  c.ajustes = ajustes
  c.paso = 'hub'
  c.tocadas = []
  ctx.db.guardarJugador(j)
  await mostrarPaso(ctx, partida, j, undefined, '✨ <b>Así me lo imagino.</b> Revisalo: podés cambiar cualquier sección.')
}

/** Valida lo que devolvió la IA contra el catálogo y las reglas. Lo inválido se corrige y se avisa. */
export function fichaDesdeCompilado(ctx: Ctx, j: Record<string, unknown> | null): { borrador: Creacion['borrador']; ajustes: string[] } {
  const u = ctx.u
  const ajustes: string[] = []
  const s = (k: string, n = 160) => (typeof j?.[k] === 'string' && (j[k] as string).trim() ? (j[k] as string).trim().slice(0, n) : undefined)
  const arr = (k: string) => (Array.isArray(j?.[k]) ? (j![k] as unknown[]).map(String) : [])
  let origen = s('origen', 30)
  if (!u.origenes.some((o) => o.id === origen)) { if (j) ajustes.push('origen por defecto'); origen = 'superviviente' }
  const arqId = u.arquetipos.some((a) => a.id === s('arquetipo', 30)) ? s('arquetipo', 30)! : u.arquetipos[0].id
  const base = aplicarArquetipo(u, arqId)
  const b: Creacion['borrador'] = { origen, ...base }
  const subs = u.origenes.find((o) => o.id === origen)?.sub ?? []
  if (subs.some((x) => x.id === s('subOrigen', 30))) b.subOrigen = s('subOrigen', 30)
  // Extras y rasgos (con sus límites).
  const extras = arr('extras').filter((id) => u.extras.some((e) => e.id === id) && cumpleRequisito(u, b.atributos as Record<AtribId, number>, id)).slice(0, 1)
  if (arr('extras').length && !extras.length) ajustes.push('cambié el Extra por uno que tu personaje puede tener')
  b.extras = extras
  const rasgos = arr('rasgos').filter((id) => u.rasgos.some((r) => r.id === id))
  const ventajas = rasgos.filter((id) => !u.rasgos.find((r) => r.id === id)!.tara).slice(0, 1)
  const taras = rasgos.filter((id) => u.rasgos.find((r) => r.id === id)!.tara).slice(0, MAX_TARAS)
  b.rasgos = [...ventajas, ...taras]
  // Especialidades: las que pidió la IA (si son válidas) con los puntos repartidos de nuevo.
  const esp = [...new Set(arr('especialidades').filter((h) => u.habilidades.some((x) => x.id === h)))].slice(0, N_ESPECIALIDADES)
  if (esp.length === N_ESPECIALIDADES) {
    const prioridad = [...esp, ...arr('habilidades_extra').filter((h) => u.habilidades.some((x) => x.id === h) && !esp.includes(h))]
    const arq = u.arquetipos.find((a) => a.id === arqId)!
    const r = repartirHabilidades(ctx, esp, prioridad, puntosHabilidadTotal(u, b), arq.puntos, b.atributos as Record<AtribId, number>)
    b.habilidades = r
    b.especialidades = esp
  } else {
    if (j) ajustes.push('especialidades del estilo elegido')
    if (tarasDe(u, b) > 0) {
      const arq = u.arquetipos.find((a) => a.id === arqId)!
      b.habilidades = repartirHabilidades(ctx, b.especialidades as string[], [], puntosHabilidadTotal(u, b), arq.puntos, b.atributos as Record<AtribId, number>)
    }
  }
  const arma = s('arma', 30)
  if (u.armas.some((a) => a.id === arma)) b.arma = arma
  const arma2 = s('arma2', 30)
  if (arma2 && arma2 !== arma && u.armas.some((a) => a.id === arma2)) b.arma2 = arma2
  for (const campo of Object.keys(CAMPOS)) {
    const v = s(campo, CAMPOS[campo].max)
    if (v) (b as Record<string, unknown>)[campo] = v
  }
  const virtudes = arr('virtudes').map((v) => v.slice(0, 30)).filter(Boolean).slice(0, 2)
  if (virtudes.length) b.virtudes = virtudes
  const errores = validarReparto(u, { atributos: b.atributos as Record<AtribId, number>, habilidades: b.habilidades as Record<string, number>, especialidades: b.especialidades as string[], extras: b.extras, rasgos: b.rasgos })
  if (errores.length) {
    // Red de seguridad: si algo no cierra, el estilo base siempre es válido.
    Object.assign(b, aplicarArquetipo(u, arqId), { rasgos: [], extras: [] })
    ajustes.push('reparto de puntos del estilo base')
  }
  return { borrador: b, ajustes }
}

/**
 * Reparte los puntos de habilidad como lo haría una persona: primero sube las especialidades, después llena las
 * habilidades pedidas, después las del estilo base y, si sobra, las que usan sus mejores atributos. Concentrado, no salpicado.
 */
function repartirHabilidades(ctx: Ctx, esp: string[], prioridad: string[], total: number, base: Record<string, number> = {}, attrs?: Record<AtribId, number>): Record<string, number> {
  const hab = habilidadesVacias(ctx.u)
  for (const e of esp) hab[e] = 2
  let quedan = total
  const subir = (h: string, hasta: number) => {
    while (quedan > 0 && (hab[h] ?? 0) < Math.min(hasta, HAB_MAX_CREACION)) { hab[h] = (hab[h] ?? 0) + 1; quedan-- }
  }
  for (const e of esp) subir(e, 3)
  for (const h of prioridad.filter((x) => !esp.includes(x))) subir(h, 2)
  for (const [h, v] of Object.entries(base).filter(([h]) => !esp.includes(h))) subir(h, v)
  const porAtributo = [...ctx.u.habilidades].sort((a, b) => (attrs?.[b.attr] ?? 0) - (attrs?.[a.attr] ?? 0)).map((h) => h.id)
  for (const h of porAtributo) subir(h, (hab[h] ?? 0) + 1)
  return hab
}

// ------------------------------------------------------------------ confirmación

async function confirmarPersonaje(ctx: Ctx, partida: Partida, j: Jugador, msgId: number | undefined): Promise<string | void> {
  const c = j.creacion!
  if (!c.borrador.origen || !c.borrador.atributos || !c.borrador.especialidades) return 'Todavía falta elegir origen y estilo.'
  completarBorrador(ctx, c.borrador, partida)
  const ficha = fichaDesdeBorrador(c)
  const errores = validarReparto(ctx.u, ficha)
  if (errores.length) return errores[0]
  if (!ficha.nombre.trim() || ficha.nombre === 'Sin nombre') return 'Ponele un nombre en 🧍 Identidad.'
  const enJuego = partida.estado === 'EN_JUEGO' || partida.estado === 'PAUSADA'
  if (enJuego) {
    // Quien entra a mitad de partida trae un lazo con algo que ya existe, y entra en la próxima escena (duelo antes del reemplazo).
    if (!ficha.lazo) ficha.lazo = opcionesLazo(ctx, partida)[0]
    const otrosEnPie = ctx.db.personajesVivos(partida.id).some((p) => p.jugador_id !== j.id && (p.ficha.entraEscena === undefined))
    if (otrosEnPie && partida.estado === 'EN_JUEGO') ficha.entraEscena = escenaDe(partida.mundo, partida.turno_n).n + 1
  }
  const base = construirPersonaje(ctx.u, ficha)
  const { trasfondo, gancho, bio } = await generarTrasfondo(ctx, partida.id, ficha)
  base.trasfondo = trasfondo
  base.gancho = gancho
  if (bio) base.ficha.bio = bio
  const pj = ctx.db.crearPersonaje(partida.id, j.id, base)
  j.estado = enJuego ? 'activo' : 'listo'
  j.creacion = null
  ctx.db.guardarJugador(j)
  if (msgId) await ctx.api.quitarTeclado(j.dm_chat_id!, msgId)
  await ctx.api.enviar(j.dm_chat_id!, `✅ <b>¡Personaje listo!</b>\n\n${fichaTexto(ctx, pj, true)}\n\nVolvé al grupo. ${enJuego ? (pj.ficha.entraEscena !== undefined ? 'Entrás a la historia en la próxima escena.' : 'Entrás en el próximo turno.') : 'Cuando estén todos, el anfitrión empieza la aventura.'}`, { teclado: botonGrupo(partida) })
  if (enJuego) {
    registrar(ctx, partida, j.id, 'sistema', `${pj.ficha.nombre} se une a la aventura.`, `${pj.ficha.nombre} se une al grupo.`)
    const p2 = ctx.db.partida(partida.id)!
    migrarCanon(ctx, p2, ctx.db.personajesVivos(partida.id))
    if (pj.ficha.entraEscena !== undefined) narrativaDe(p2.mundo).pendientes.push(`Se viene ${pj.ficha.nombre} (${pj.ficha.lazo ?? 'sin lazo'}): preparale la entrada para la próxima escena.`)
    ctx.db.guardarPartida(p2)
    await aGrupo(ctx, p2, `🧑‍🚀 <b>${esc(pj.ficha.nombre)}</b> (${esc(j.nombre)}) se suma a la aventura${pj.ficha.entraEscena !== undefined ? ' en la próxima escena' : ''}.`)
    const estabaPausada = p2.estado === 'PAUSADA'
    if (estabaPausada) { p2.estado = 'EN_JUEGO'; ctx.db.guardarPartida(p2) }
    ajustarRitmo(ctx, partida.id)
    // Si la partida estaba frenada (por ejemplo, porque no quedaba nadie en pie), sigue sola.
    if (estabaPausada) {
      const p3 = ctx.db.partida(partida.id)!
      p3.turno_jugador_id = null
      ctx.db.guardarPartida(p3)
      await aGrupo(ctx, p3, '▶️ <b>La historia sigue.</b>')
      await iniciarTurno(ctx, partida.id)
    }
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
  if (acc === 'x') {
    const disponibles = ctx.u.extras.filter((e) => !(pj.ficha.extras ?? []).includes(e.id) && cumpleRequisito(ctx.u, pj.ficha.atributos, e.id))
    const teclado: Teclado = disponibles.map((e) => [{ text: `${e.nombre}: ${e.desc}`.slice(0, 60), callback_data: `m:e:${e.id}` }])
    await mostrar(ctx, chat, msgId, '⭐ ¿Qué Extra suma?', teclado)
    return
  }
  let ok = false
  let que = ''
  if (acc === 'h' && ctx.u.habilidades.some((h) => h.id === a1)) { ok = subirHabilidad(pj, a1); que = ctx.u.habilidades.find((h) => h.id === a1)!.nombre }
  if (acc === 't' && (ATRIBUTOS as string[]).includes(a1)) { ok = subirAtributo(pj, a1 as AtribId); que = a1 }
  if (acc === 'e') {
    const e = ctx.u.extras.find((x) => x.id === a1)
    if (e && !(pj.ficha.extras ?? []).includes(e.id) && cumpleRequisito(ctx.u, pj.ficha.atributos, e.id)) {
      pj.ficha.extras = [...(pj.ficha.extras ?? []), e.id]
      for (const ef of e.efectos) {
        if (ef.tipo === 'hab') pj.ficha.habilidades[ef.id] = Math.min(6, (pj.ficha.habilidades[ef.id] ?? 0) + ef.v)
        if (ef.tipo === 'atr') pj.ficha.atributos[ef.id] = Math.min(10, pj.ficha.atributos[ef.id] + ef.v)
        if (ef.tipo === 'salud') { pj.salud_max += ef.v; pj.salud += ef.v }
      }
      ok = true
      que = e.nombre
    }
  }
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
