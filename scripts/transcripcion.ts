// Transcripción de una partida simulada de punta a punta, como la ve cada jugador: `npm run transcripcion [archivo]`
// Sirve para revisar la experiencia (mensajes, botones, orden, ruido) sin gastar IA. Grupo y privados, en orden.
import { writeFileSync } from 'node:fs'
import { crearMundo, GRUPO, Jugadores, NOMBRES } from './harness.js'
import { CerebroMock } from '../src/dj/mock.js'
import type { Decision } from '../src/dj/cerebro.js'

const m = crearMundo({ mock: new CerebroMock(9999, 9999) })
const j = new Jugadores(m)
const N = (s: Partial<Extract<Decision, { tipo: 'narrar' }>['salida']>): Decision => ({ tipo: 'narrar', salida: { narracion: '', cronica: '', sugerencias: [], ...s } })
const ult = (chat: string) => m.api.ultimo(chat)!
const tocar = (uid: number, data: string, chat = String(uid)) => j.tocar(uid, data, chat, ult(chat).id)
const marca = (t: string) => m.api.eventos.push({ tipo: 'aviso', chatId: '##', html: t })

marca('El anfitrión agrega el bot y arma la partida')
await j.agregarBot()
await j.grupo(101, '/nueva')
const pid = m.ctx.db.partidaActivaDeChat(GRUPO)!.id
for (const [k, v] of [['esc', 'costa'], ['ton', 'humor'], ['dur', 'oneshot'], ['pla', '24'], ['let', 'normal'], ['vio', 'implicita'], ['pvp', 'no'], ['evi', 'ok'], ['sil', 'noche'], ['pre', 'p0']]) {
  await j.tocar(101, `w:${pid}:${k}:${v}`, GRUPO, m.ctx.db.partida(pid)!.wizard_msg_id ?? 1)
}

marca('Fran crea su personaje con el modo rápido y edita dos cosas')
await j.privado(101, `/start u_${pid}`)
await tocar(101, 'c:md:r'); await tocar(101, 'c:or:refugio'); await tocar(101, 'c:so:mantenimiento'); await tocar(101, 'c:aq:tecnico')
await tocar(101, 'c:hub:id'); await tocar(101, 'c:tx:nombre'); await j.privado(101, 'Marta Ruiz')
await tocar(101, 'c:hub:h'); await tocar(101, 'c:ok')

marca('Caro crea su personaje con el modo rápido sin tocar nada')
await j.privado(102, `/start u_${pid}`)
await tocar(102, 'c:md:r'); await tocar(102, 'c:or:exsaqueador'); await tocar(102, 'c:so:r'); await tocar(102, 'c:aq:maton'); await tocar(102, 'c:ok')

marca('Nico crea su personaje con la entrevista guiada')
await j.privado(103, `/start u_${pid}`)
await tocar(103, 'c:md:e')
await j.privado(103, 'Una chatarrera pelirroja de la costa que busca a su hermano')
await tocar(103, 'c:ent:ya')
await tocar(103, 'c:ok')

marca('Empieza la aventura')
await j.tocar(101, `b:${pid}:empezar`, GRUPO)

const turno = async (texto: string, d?: Decision, tirar = false) => {
  const p = m.ctx.db.partida(pid)!
  const jug = m.ctx.db.jugador(p.turno_jugador_id!)!
  marca(`Turno de ${jug.nombre}: "${texto}"`)
  if (tirar) m.mock.cola.push({ tipo: 'tirada', preambulo: 'El muelle cruje bajo los pies.', pedido: { atributo: 'AGI', habilidad: 'sigilo', dificultad: 2, motivo: 'Cruzar el muelle sin que la vean' } })
  if (d) m.mock.cola.push(d)
  await j.grupo(Number(jug.user_id), texto, p.turno_msg_id ?? undefined)
  const r = m.api.botonData(GRUPO, new RegExp(`^r:${pid}:${p.turno_n}:n`))
  if (r && m.ctx.db.partida(pid)!.paso.tipo === 'esperando_tirada') await j.tocar(Number(jug.user_id), r.data, GRUPO, r.msg.id)
}

await turno('Me acerco a la caseta del muelle con la linterna apagada', N({
  narracion: 'Marta se pega a la pared de chapa. Adentro, Don Aldo cuenta chapas a la luz de una vela y levanta la vista: "¿Venís por la válvula o por tu hermano?". Afuera, una patrulla de los Lobos dobla la esquina.',
  hechos: ['Marta encontró a Don Aldo en la caseta del muelle', 'Una patrulla de los Lobos se acerca'],
  cambios: { npcs: [{ id: 'aldo', nombre: 'Don Aldo', quiere: 'Saldar su deuda con el casino', voz: 'Pregunta todo dos veces', publico: 'Viejo prestamista del puerto' }] },
  escena: { lugar: 'Caseta del muelle 3', pregunta: '¿Consiguen la válvula antes de que llegue la patrulla?', presentes: ['Don Aldo'] },
  libreta: 'Aldo vendió la válvula a Varela. Si lo presionan, se quiebra.', recurso: 'pregunta del NPC',
  sugerencias: ['Cubrir la puerta', 'Distraer a la patrulla'],
}), true)

marca('Lu (no está en la partida) responde en el grupo; Caro pregunta al DJ por privado')
await j.privado(102, '¿Quién es Don Aldo?')
await j.tocar(102, `i:${pid}:dj`, GRUPO)
await j.tocar(102, `j:${pid}:quien`, '102')

await turno('Le pongo el cuchillo en la garganta a Aldo y le pregunto dónde está la válvula', N({
  narracion: 'Aldo traga saliva. "La válvula... la válvula se la vendí a los Lobos, ¿entendés? A los Lobos." La patrulla ya golpea la puerta.',
  hechos: ['Aldo confesó que vendió la válvula a los Lobos'],
  cambios: { npcs: [{ id: 'aldo', nombre: 'Don Aldo', actitud: 'aterrado', relacion: { pj: 'P2', delta: -1, nota: 'lo amenazó' } }] },
  hilos: [{ accion: 'abrir', pregunta: '¿Dónde tienen los Lobos la válvula?', tipo: 'acto' }],
  hito_cumplido: 'a1h1',
}))

await turno('Atranco la puerta con una mesa y busco otra salida', N({
  narracion: 'La puerta aguanta dos golpes. Al tercero, tres Lobos entran con caños y cadenas.',
  hechos: ['Los Lobos irrumpieron en la caseta'],
  combate: { enemigos: [{ plantilla_id: 'saqueador', cantidad: 2 }], sorpresa: 'ninguna' },
}))

marca('Combate: cada uno elige con botones (hasta que termina)')
for (let i = 0; i < 15; i++) {
  const p = m.ctx.db.partida(pid)!
  if (!p.mundo.combate) break
  const jug = m.ctx.db.jugador(p.turno_jugador_id!)!
  const uid = Number(jug.user_id)
  const a = m.api.botonData(GRUPO, new RegExp(`^a:${pid}:${p.turno_n}:at`))
  if (a) await j.tocar(uid, a.data, GRUPO, a.msg.id)
  const t = m.api.botonData(GRUPO, new RegExp(`^t:${pid}:${p.turno_n}:`))
  if (t && m.ctx.db.partida(pid)!.turno_n === p.turno_n) await j.tocar(uid, t.data, GRUPO, t.msg.id)
}

await turno('Revisamos los cuerpos y salimos por la ventana de atrás', N({
  narracion: 'Entre las cadenas, uno de los Lobos lleva un tatuaje de válvula. Afuera, el viento trae olor a gasoil desde el galpón 7.',
  hechos: ['Encontraron una pista: los Lobos guardan la válvula en el galpón 7'],
  escena: { lugar: 'Galpón 7', pregunta: '¿Entran sin que los vean?', presentes: [] },
  hilos: [{ accion: 'tocar', pregunta: '¿Dónde tienen los Lobos la válvula?' }],
}))

marca('Nico decide que su personaje muere (y confirma)')
{
  const p = m.ctx.db.partida(pid)!
  const jug = m.ctx.db.jugador(p.turno_jugador_id!)!
  m.mock.textos.intencion = JSON.stringify({ intencion: 'muerte_propia' })
  m.mock.cola.push(N({ narracion: 'Se queda en el muelle, de espaldas al grupo, mientras la marea sube. Nadie la vuelve a ver.', hechos: ['Un personaje eligió quedarse atrás para siempre'] }))
  await j.grupo(Number(jug.user_id), 'Me quedo atrás y me tiro al agua: no doy más', p.turno_msg_id ?? undefined)
  const b = m.api.botonData(GRUPO, new RegExp(`^d:${pid}:\\d+:s`))
  if (b) await j.tocar(Number(jug.user_id), b.data, GRUPO, b.msg.id)
  delete m.mock.textos.intencion
  const muerto = m.ctx.db.personajesTodos(pid).find((x) => !x.vivo)
  if (muerto) {
    const otro = m.ctx.db.personajesVivos(pid)[0]
    marca(`${jug.nombre} elige el legado`)
    await j.tocar(Number(jug.user_id), `u:${pid}:${muerto.id}:obj`, jug.dm_chat_id!, ult(jug.dm_chat_id!).id)
    await j.tocar(Number(jug.user_id), `u:${pid}:${muerto.id}:obj:${otro.id}`, jug.dm_chat_id!, ult(jug.dm_chat_id!).id)
  }
}

marca('Alguien consulta /resumen y /dj en el grupo')
await j.grupo(101, '/resumen')
await j.grupo(102, '/dj ¿qué pasó con la válvula?')

marca('Fin de la transcripción (estado del tablero)')
const salida: string[] = []
const nombre = (c: string) => (c === GRUPO ? 'GRUPO' : c === '##' ? '' : c === '-' ? 'aviso emergente' : `privado ${NOMBRES[Number(c)] ?? c}`)
for (const e of m.api.eventos) {
  if (e.chatId === '##') { salida.push('', `════════ ${e.html} ════════`); continue }
  const txt = e.html.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  const botones = e.teclado?.length ? '\n   ' + e.teclado.map((f) => f.map((b) => `[${b.text}]`).join(' ')).join('\n   ') : ''
  salida.push(`--- ${e.tipo} · ${nombre(e.chatId)}${e.id ? ` #${e.id}` : ''}\n${txt}${botones}`)
}
const archivo = process.argv[2] ?? 'transcripcion.txt'
writeFileSync(archivo, salida.join('\n'))
console.log(`Transcripción en ${archivo}: ${m.api.eventos.length} eventos (${m.api.eventos.filter((e) => e.chatId === GRUPO && e.tipo === 'envía').length} mensajes nuevos en el grupo).`)
