import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crearMundo, partidaLista, GRUPO, HORA, type Mundo, type Jugadores } from '../scripts/harness.js'
import { cargarUniverso } from '../src/universos/fallout/index.js'
import { aplicarCambios, mundoVacio } from '../src/motor/estado.js'
import { probabilidadExito, semaforo } from '../src/motor/reglas.js'
import { faseDe, forzarClimax, objetivoTurnos, puedeCerrarAntes, registrarTurno, ritmoNuevo, sortearEvento } from '../src/motor/ritmo.js'
import { resolverCaidos } from '../src/motor/combate.js'
import { rngSecuencia } from '../src/motor/dados.js'
import { CONFIG_DEFECTO } from '../src/juego/setup.js'
import type { Decision } from '../src/dj/cerebro.js'
import type { Personaje } from '../src/motor/tipos.js'

const u = cargarUniverso('fallout')
const limpio = (h: string) => h.replace(/<[^>]+>/g, '')
const delGrupo = (m: Mundo) => m.api.msgs.filter((x) => x.chatId === GRUPO)

async function enJuego(opts: Record<string, string> = {}, ids = [101, 102, 103]) {
  const m = crearMundo()
  const { j, pid } = await partidaLista(m, ids, opts)
  await j.tocar(101, `b:${pid}:empezar`, GRUPO)
  return { m, j, pid }
}

/** Juega el turno actual con un texto (y tira si el DJ pide prueba). */
async function jugar(m: Mundo, j: Jugadores, pid: number, texto = 'Avanzo') {
  const p = m.ctx.db.partida(pid)!
  const jug = m.ctx.db.jugador(p.turno_jugador_id!)!
  const uid = Number(jug.user_id)
  if (p.modo_escena === 'combate') {
    const d = m.api.botonData(GRUPO, new RegExp(`^a:${pid}:${p.turno_n}:at`))
    if (d) await j.tocar(uid, d.data, GRUPO, d.msg.id)
    const t = m.api.botonData(GRUPO, new RegExp(`^t:${pid}:${p.turno_n}:`))
    if (t && m.ctx.db.partida(pid)!.turno_n === p.turno_n) await j.tocar(uid, t.data, GRUPO, t.msg.id)
    return
  }
  await j.grupo(uid, texto, p.turno_msg_id ?? undefined)
  const r = m.api.botonData(GRUPO, new RegExp(`^r:${pid}:${p.turno_n}:n`))
  if (r && m.ctx.db.partida(pid)!.paso.tipo === 'esperando_tirada') await j.tocar(uid, r.data, GRUPO, r.msg.id)
}

const narrar = (extra: Partial<Extract<Decision, { tipo: 'narrar' }>['salida']> = {}): Decision =>
  ({ tipo: 'narrar', salida: { narracion: 'Pasa algo concreto.', cronica: 'Algo pasó.', sugerencias: [], ...extra } })

// ------------------------------------------------------------------ motor

test('ritmo: objetivo en turnos, fases y cierre al llegar al límite', () => {
  const cfg = { ...CONFIG_DEFECTO, duracion: 'corta' as const }
  assert.equal(objetivoTurnos(cfg, 3), 12)
  const r = ritmoNuevo(cfg, 3)
  assert.equal(faseDe(r), 'planteo')
  for (let i = 0; i < 5; i++) registrarTurno(r)
  assert.equal(faseDe(r), 'escalada')
  assert.equal(puedeCerrarAntes(r), false)
  for (let i = 0; i < 4; i++) registrarTurno(r)
  assert.equal(faseDe(r), 'climax')
  assert.equal(puedeCerrarAntes(r), true)
  let cierra = false
  for (let i = 0; i < 3; i++) cierra = registrarTurno(r) || cierra
  assert.ok(cierra && r.cierrePendiente, 'al llegar a 12 turnos el próximo es el desenlace')
})

test('ritmo: el reloj de amenaza lleno salta al clímax', () => {
  const r = ritmoNuevo({ ...CONFIG_DEFECTO, duracion: 'oneshot' }, 4)
  registrarTurno(r)
  assert.equal(faseDe(r), 'planteo')
  forzarClimax(r)
  assert.equal(faseDe(r), 'climax')
})

test('eventos: son concretos y usan el guion', () => {
  const ev = sortearEvento({ encuentros: ['saqueador'], bestiario: ['saqueador', 'rata_topo'], npcs: [{ nombre: 'Nora', secreto: 'vende al grupo' }], npcsPresentes: ['Nora'], secretos: ['La señal es una trampa'], secretosRevelados: 0, facciones: [{ nombre: 'Los Hijos del Puerto', quiere: 'el reactor' }], amenaza: 'La tormenta' }, rngSecuencia([1, 2, 3, 4, 5, 6, 7]), 'escalada')
  assert.ok(ev.instruccion.length > 40)
  assert.doesNotMatch(ev.instruccion, /undefined/)
  assert.doesNotMatch(ev.instruccion, /algo se (aproxima|acerca)/i)
})

test('dados: probabilidad exacta y semáforo', () => {
  assert.ok(Math.abs(probabilidadExito(10, 0, false, 1) - 0.75) < 1e-9)
  assert.ok(Math.abs(probabilidadExito(10, 0, false, 2) - 0.25) < 1e-9)
  assert.ok(probabilidadExito(10, 3, true, 2) > 0.25, 'la especialidad suma críticos')
  assert.equal(semaforo(0.8).texto, 'fácil')
  assert.equal(semaforo(0.5).texto, 'parejas')
  assert.equal(semaforo(0.1).texto, 'difícil')
})

test('npc: muere, queda en la lista de muertos y no puede volver', () => {
  const mundo = mundoVacio()
  aplicarCambios(u, mundo, [], { npcs: [{ id: 'nora', nombre: 'Nora', actitud: 'hostil' }] }, { enCombate: false })
  const r = aplicarCambios(u, mundo, [], { npcs: [{ id: 'nora', nombre: 'Nora', estado: 'muerto' }] }, { enCombate: false })
  assert.deepEqual(mundo.muertos, ['Nora'])
  assert.ok(r.aplicados.some((x) => /Nora muere/.test(x)))
  const r2 = aplicarCambios(u, mundo, [], { npcs: [{ id: 'nora', nombre: 'Nora', actitud: 'amable' }] }, { enCombate: false })
  assert.ok(r2.rechazados.some((x) => /muerto/.test(x)))
})

test('misión principal: la IA puede cumplirla pero no reescribirla', () => {
  const mundo = mundoVacio()
  mundo.misiones.push({ id: 'principal', texto: 'Recuperar el reactor', estado: 'activa', principal: true })
  aplicarCambios(u, mundo, [], { misiones: [{ id: 'principal', texto: 'Otra cosa', estado: 'cumplida' }] }, { enCombate: false })
  assert.equal(mundo.misiones[0].texto, 'Recuperar el reactor')
  assert.equal(mundo.misiones[0].estado, 'cumplida')
})

test('letalidad normal: si falla la Suerte, muere', () => {
  const pj = { ficha: { nombre: 'Tito', atributos: { SUE: 5 } }, vivo: true, condiciones: ['caido'], salud: 0, penal_salud: 0 } as unknown as Personaje
  resolverCaidos([pj], 'normal', rngSecuencia([15, 16]))
  assert.equal(pj.vivo, false)
})

// ------------------------------------------------------------------ juego

test('la sesión corta termina sola con desenlace y epílogo', async () => {
  const { m, j, pid } = await enJuego({ dur: 'corta' })
  for (let i = 0; i < 40 && m.ctx.db.partida(pid)!.estado === 'EN_JUEGO'; i++) {
    await jugar(m, j, pid, `Acción ${i}`)
    m.reloj.t += HORA
  }
  assert.equal(m.ctx.db.partida(pid)!.estado, 'FINALIZADA')
  assert.ok(delGrupo(m).some((x) => /FIN DE LA AVENTURA/.test(x.html)))
  assert.ok(m.mock.vistas.some((v) => /DESENLACE FINAL/.test(v.sistema)), 'el último turno pidió el desenlace')
})

test('el prompt lleva ritmo, acto actual y objetivo principal (sin "capítulo final" desde el turno 1)', async () => {
  const { m, j, pid } = await enJuego({ dur: 'oneshot' })
  await jugar(m, j, pid)
  const sistema = m.mock.vistas.at(-1)!.sistema
  assert.match(sistema, /RITMO/)
  assert.match(sistema, /ACTO ACTUAL \(1 de 3\)/)
  assert.match(sistema, /OBJETIVO PRINCIPAL/)
  assert.doesNotMatch(sistema, /ES EL CAPÍTULO FINAL/)
})

test('fuera de turno: "esperá tu turno" una vez por turno y sin gastar IA', async () => {
  const { m, j, pid } = await enJuego()
  const p = m.ctx.db.partida(pid)!
  const otro = m.ctx.db.jugadores(pid).find((x) => x.id !== p.turno_jugador_id)!
  const llamadas = m.mock.llamadas
  const tablero = p.tablero_msg_id!
  await j.grupo(Number(otro.user_id), 'Yo disparo', tablero)
  await j.grupo(Number(otro.user_id), 'Yo disparo otra vez', tablero)
  await j.grupo(Number(otro.user_id), '/a me escondo')
  const avisos = delGrupo(m).filter((x) => /Esperá tu turno/.test(x.html))
  assert.equal(avisos.length, 1)
  assert.equal(m.mock.llamadas, llamadas)
})

test('tarjeta de turno: grande, fijada, sin "Mientras no estabas", y el privado linkea al turno', async () => {
  const { m, pid } = await enJuego()
  const p = m.ctx.db.partida(pid)!
  const tarjeta = m.api.msgs.find((x) => x.id === p.turno_msg_id)!
  assert.match(limpio(tarjeta.html), /TURNO DE/)
  assert.doesNotMatch(tarjeta.html, /Mientras no estabas/)
  assert.ok(m.api.fijados.includes(p.turno_msg_id!))
  const jug = m.ctx.db.jugador(p.turno_jugador_id!)!
  const dm = m.api.msgs.filter((x) => x.chatId === jug.dm_chat_id && /Te toca/.test(x.html)).at(-1)!
  assert.match(dm.teclado![0][0].url!, /^https:\/\/t\.me\/c\/500\/\d+$/)
})

test('skip directo: /saltear pasa el turno al toque y no duerme a nadie', async () => {
  const { m, j, pid } = await enJuego({ pla: '-1' })
  for (let i = 0; i < 3; i++) {
    const p = m.ctx.db.partida(pid)!
    const actual = p.turno_jugador_id!
    const otro = m.ctx.db.jugadores(pid).find((x) => x.id !== actual)!
    await j.grupo(Number(otro.user_id), '/saltear')
    assert.notEqual(m.ctx.db.partida(pid)!.turno_jugador_id, actual)
  }
  assert.ok(m.ctx.db.jugadores(pid).every((x) => x.estado === 'activo'))
})

test('/config: el anfitrión activa skip directo con la partida empezada', async () => {
  const { m, j, pid } = await enJuego()
  await j.grupo(102, '/config')
  assert.match(m.api.ultimo(GRUPO)!.html, /Solo el anfitrión/)
  await j.grupo(101, '/config')
  const menu = m.api.ultimo(GRUPO)!
  await j.tocar(101, `g:${pid}:pla`, GRUPO, menu.id)
  await j.tocar(101, `g:${pid}:pla:-1`, GRUPO, menu.id)
  assert.equal(m.ctx.db.partida(pid)!.config.plazoH, -1)
  const p = m.ctx.db.partida(pid)!
  const otro = m.ctx.db.jugadores(pid).find((x) => x.id !== p.turno_jugador_id)!
  await j.grupo(Number(otro.user_id), '/saltear')
  assert.notEqual(m.ctx.db.partida(pid)!.turno_jugador_id, p.turno_jugador_id, 'saltea sin esperar ni votar')
})

test('bienvenida: el que entra al grupo recibe la invitación con botón, una sola vez', async () => {
  const { m, pid } = await enJuego()
  const entra = async () => m.enviar({ update_id: 90000 + Math.floor(Math.random() * 1000), message: { message_id: 7777, chat: { id: Number(GRUPO), type: 'supergroup' }, date: 0, new_chat_members: [{ id: 104, first_name: 'Lu' }] } })
  await entra()
  await entra()
  const inv = delGrupo(m).filter((x) => /Bienvenido, Lu/.test(x.html))
  assert.equal(inv.length, 1)
  assert.match(inv[0].teclado![0][0].url!, new RegExp(`start=u_${pid}$`))
})

test('no jugador que responde al DJ: recibe la invitación en vez de silencio', async () => {
  const { m, j, pid } = await enJuego()
  const p = m.ctx.db.partida(pid)!
  await j.grupo(104, 'Che, ¿puedo jugar?', p.turno_msg_id!)
  assert.match(m.api.ultimo(GRUPO)!.html, /Bienvenido, Lu/)
})

test('party: muestra a todos con bio pública y sin el secreto', async () => {
  const { m, j } = await enJuego()
  await j.grupo(101, '/party')
  const t = limpio(m.api.ultimo(GRUPO)!.html)
  assert.match(t, /La party/)
  assert.equal((t.match(/Chatarrero conocido/g) ?? []).length, 3)
  assert.doesNotMatch(t, /Un secreto lo persigue/)
})

test('resumen: siempre muestra los últimos hechos, aunque no haya nada nuevo', async () => {
  const { m, j, pid } = await enJuego()
  await jugar(m, j, pid)
  await j.grupo(101, '/resumen')
  await j.grupo(101, '/resumen')
  const t = limpio(m.api.ultimo(GRUPO)!.html)
  assert.match(t, /Últimos hechos/)
  assert.doesNotMatch(t, /No pasó nada nuevo/)
  assert.match(t, /Objetivo/)
})

test('muerte elegida: pide confirmación; con "no" el personaje sigue vivo', async () => {
  const { m, j, pid } = await enJuego()
  const p = m.ctx.db.partida(pid)!
  const jug = m.ctx.db.jugador(p.turno_jugador_id!)!
  const pj = m.ctx.db.personajeVivoDe(jug.id)!
  m.mock.cola.push(narrar({ narracion: 'Se tira al vacío.', cambios: { muerte: { pj: `P${pj.id}`, elegida: true } } }))
  await j.grupo(Number(jug.user_id), 'Me tiro del puente', p.turno_msg_id!)
  const b = m.api.botonData(GRUPO, new RegExp(`^d:${pid}:${p.turno_n}:n`))
  assert.ok(b, 'hay botones de confirmación')
  await j.tocar(102 === Number(jug.user_id) ? 101 : 102, b.data, GRUPO, b.msg.id) // otro no puede decidir
  assert.equal(m.ctx.db.partida(pid)!.paso.tipo, 'confirmando_muerte')
  await j.tocar(Number(jug.user_id), b.data, GRUPO, b.msg.id)
  assert.equal(m.ctx.db.personaje(pj.id)!.vivo, true)
})

test('muerte elegida confirmada: muere y recibe botón para crear otro personaje', async () => {
  const { m, j, pid } = await enJuego()
  const p = m.ctx.db.partida(pid)!
  const jug = m.ctx.db.jugador(p.turno_jugador_id!)!
  const pj = m.ctx.db.personajeVivoDe(jug.id)!
  m.mock.cola.push(narrar({ narracion: 'Toma su decisión.', cambios: { muerte: { pj: `P${pj.id}`, elegida: true } } }))
  await j.grupo(Number(jug.user_id), 'Me sacrifico', p.turno_msg_id!)
  const b = m.api.botonData(GRUPO, new RegExp(`^d:${pid}:${p.turno_n}:s`))!
  await j.tocar(Number(jug.user_id), b.data, GRUPO, b.msg.id)
  assert.equal(m.ctx.db.personaje(pj.id)!.vivo, false)
  const dm = m.api.msgs.filter((x) => x.chatId === jug.dm_chat_id).at(-1)!
  assert.match(dm.teclado![0][0].text, /Crear otro personaje/)
  assert.notEqual(m.ctx.db.partida(pid)!.turno_jugador_id, jug.id, 'el turno siguió')
})

test('muerte en letalidad suave: se rechaza', async () => {
  const { m, j, pid } = await enJuego({ let: 'suave' })
  const p = m.ctx.db.partida(pid)!
  const jug = m.ctx.db.jugador(p.turno_jugador_id!)!
  const pj = m.ctx.db.personajeVivoDe(jug.id)!
  m.mock.cola.push(narrar({ cambios: { muerte: { pj: `P${pj.id}`, elegida: true } } }))
  await j.grupo(Number(jug.user_id), 'Me tiro', p.turno_msg_id!)
  assert.equal(m.ctx.db.personaje(pj.id)!.vivo, true)
  assert.ok(delGrupo(m).some((x) => /letalidad suave/.test(x.html)))
})

test('combate contra un NPC con nombre: al morir queda muerto en la historia', async () => {
  const { m, j, pid } = await enJuego()
  const p = m.ctx.db.partida(pid)!
  const jug = m.ctx.db.jugador(p.turno_jugador_id!)!
  m.mock.cola.push(narrar({ cambios: { npcs: [{ id: 'nora', nombre: 'Nora', actitud: 'hostil' }] }, combate: { enemigos: [{ plantilla_id: 'civil', nombre: 'Nora', npc_id: 'nora' }] } }))
  await j.grupo(Number(jug.user_id), 'Ataco a Nora', p.turno_msg_id!)
  assert.ok(m.ctx.db.partida(pid)!.mundo.combate?.enemigos.some((e) => e.nombre === 'Nora' && e.npc))
  for (let i = 0; i < 30 && m.ctx.db.partida(pid)!.mundo.combate; i++) await jugar(m, j, pid)
  assert.deepEqual(m.ctx.db.partida(pid)!.mundo.muertos, ['Nora'])
})

test('eventos obligatorios: el motor los programa y los inyecta en el prompt', async () => {
  const { m, j, pid } = await enJuego({ dur: 'oneshot' })
  for (let i = 0; i < 8; i++) await jugar(m, j, pid)
  assert.ok(m.mock.vistas.some((v) => /EVENTO OBLIGATORIO/.test(v.sistema)))
})

test('/final: el anfitrión cierra la historia en N turnos', async () => {
  const { m, j, pid } = await enJuego({ dur: 'abierta' })
  await j.grupo(101, '/final 1')
  for (let i = 0; i < 6 && m.ctx.db.partida(pid)!.estado === 'EN_JUEGO'; i++) await jugar(m, j, pid)
  assert.equal(m.ctx.db.partida(pid)!.estado, 'FINALIZADA')
})

test('/votacion: encuesta nativa y el resultado queda como decisión del grupo', async () => {
  const { m, j, pid } = await enJuego()
  await j.grupo(102, '/votacion ¿Quién lidera? | Caro | Nico')
  const enc = m.api.encuestas.at(-1)!
  assert.deepEqual(enc.opciones, ['Caro', 'Nico'])
  let n = 1
  for (const [uid, op] of [[101, 0], [102, 0], [103, 1]] as const) {
    await m.enviar({ update_id: 80000 + n++, poll_answer: { poll_id: enc.pollId, user: { id: uid, first_name: 'x' }, option_ids: [op] } })
  }
  assert.ok(enc.cerrada)
  assert.deepEqual(m.ctx.db.partida(pid)!.mundo.decisiones, ['¿Quién lidera? → Caro'])
  await jugar(m, j, pid)
  assert.match(m.mock.vistas.at(-1)!.sistema, /Decisiones del grupo.*Caro/)
})

test('creación: si el narrador repregunta, la reacción se descarta', async () => {
  const m = crearMundo()
  m.mock.textos.reaccion = '¿Y por qué te fuiste?'
  const { j } = await partidaLista(m, [101])
  void j
  assert.ok(!m.api.msgs.some((x) => /Y por qué te fuiste/.test(x.html)))
})

test('premisa: el anfitrión la elige y queda como objetivo fijo', async () => {
  const m = crearMundo()
  const { j, pid } = await partidaLista(m, [101, 102], { pre: 'p1' })
  await j.tocar(101, `b:${pid}:empezar`, GRUPO)
  const principal = m.ctx.db.partida(pid)!.mundo.misiones.find((x) => x.principal)!
  assert.match(principal.texto, /caravana de agua/)
})

test('audio: se transcribe solo si es la acción del turno', async () => {
  const { m, j, pid } = await enJuego()
  const oidas: number[] = []
  m.ctx.oido = { async transcribir(_a, _n, _p, seg) { oidas.push(seg); return 'le apunto al guardia' } }
  const p = m.ctx.db.partida(pid)!
  const jug = m.ctx.db.jugador(p.turno_jugador_id!)!
  const otro = m.ctx.db.jugadores(pid).find((x) => x.id !== jug.id)!
  const audio = (uid: number, respondiendo?: number, seg = 5) => m.enviar({ update_id: 70000 + Math.floor(Math.random() * 9999), message: { message_id: 6000, from: { id: uid, first_name: 'x' }, chat: { id: Number(GRUPO), type: 'supergroup' }, date: 0, voice: { file_id: 'f1', duration: seg }, ...(respondiendo ? { reply_to_message: { message_id: respondiendo, from: { id: 999, first_name: 'DJ', is_bot: true } } } : {}) } })
  await audio(Number(otro.user_id), p.turno_msg_id!)
  await audio(Number(jug.user_id))
  assert.equal(oidas.length, 0, 'no se gasta en audios de charla ni fuera de turno')
  await audio(Number(jug.user_id), p.turno_msg_id!, 200)
  assert.equal(oidas.length, 0, 'audio muy largo: se rechaza sin transcribir')
  await audio(Number(jug.user_id), p.turno_msg_id!)
  assert.equal(oidas.length, 1)
  assert.ok(delGrupo(m).some((x) => /Entendí: "le apunto al guardia"/.test(limpio(x.html))))
  assert.ok(m.ctx.db.bitacoraTodas(pid).some((b) => b.tipo === 'accion' && /le apunto al guardia/.test(b.texto)))
})

test('partida vieja (sin ritmo ni objetivo): sigue andando y se completa sola', async () => {
  const { m, j, pid } = await enJuego()
  const p = m.ctx.db.partida(pid)!
  delete p.mundo.ritmo
  p.mundo.misiones = p.mundo.misiones.filter((x) => !x.principal)
  delete (p.config as { violencia?: string }).violencia
  ;(p.config as { duracion: string }).duracion = 'oneshot'
  m.ctx.db.guardarPartida(p)
  await j.grupo(101, '/config')
  const menu = m.api.ultimo(GRUPO)!
  await j.tocar(101, `g:${pid}:pla:-1`, GRUPO, menu.id)
  for (let i = 0; i < 4; i++) await jugar(m, j, pid)
  const d = m.ctx.db.partida(pid)!
  assert.ok(d.mundo.ritmo && d.mundo.ritmo.turnos > 0)
  assert.ok(d.mundo.misiones.some((x) => x.principal))
  assert.equal(d.config.plazoH, -1)
})
