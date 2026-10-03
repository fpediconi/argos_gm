import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crearMundo, partidaLista, GRUPO, type Mundo, type Jugadores } from '../scripts/harness.js'
import { cargarUniverso } from '../src/universos/fallout/index.js'
import { aplicarCambios, mundoVacio } from '../src/motor/estado.js'
import {
  actoPorHitos, aplicarHilos, avanzarAgendas, cortarEscena, cumplirHito, evitarEsteTurno, eventoDesdeEstado, marcarApariciones, normalizarGuion,
  presentes, presupuestoNuevos, registrarNarracion, sembrarCanon,
} from '../src/motor/canon.js'
import { reconciliar } from '../src/motor/coherencia.js'
import { resolverCaidos } from '../src/motor/combate.js'
import { rngSecuencia } from '../src/motor/dados.js'
import { construirPersonaje, aplicarArquetipo, validarReparto, puntosHabilidadTotal } from '../src/motor/personaje.js'
import { aResponses, deResponses, normalizarSalida } from '../src/dj/cerebro.js'
import { CerebroMock } from '../src/dj/mock.js'
import type { Decision } from '../src/dj/cerebro.js'
import type { GuionMaestro, Personaje } from '../src/motor/tipos.js'

const u = cargarUniverso('fallout')
const limpio = (h: string) => h.replace(/<[^>]+>/g, '')
const delGrupo = (m: Mundo) => m.api.msgs.filter((x) => x.chatId === GRUPO)

async function enJuego(opts: Record<string, string> = {}, ids = [101, 102, 103]) {
  const m = crearMundo({ mock: new CerebroMock(9999, 9999) })
  const { j, pid } = await partidaLista(m, ids, opts)
  await j.tocar(101, `b:${pid}:empezar`, GRUPO)
  return { m, j, pid }
}

async function jugar(m: Mundo, j: Jugadores, pid: number, texto = 'Avanzo') {
  const p = m.ctx.db.partida(pid)!
  const jug = m.ctx.db.jugador(p.turno_jugador_id!)!
  await j.grupo(Number(jug.user_id), texto, p.turno_msg_id ?? undefined)
  const r = m.api.botonData(GRUPO, new RegExp(`^r:${pid}:${p.turno_n}:n`))
  if (r && m.ctx.db.partida(pid)!.paso.tipo === 'esperando_tirada') await j.tocar(Number(jug.user_id), r.data, GRUPO, r.msg.id)
}

const narrar = (extra: Partial<Extract<Decision, { tipo: 'narrar' }>['salida']> = {}): Decision =>
  ({ tipo: 'narrar', salida: { narracion: 'Pasa algo concreto.', cronica: 'Algo pasó.', sugerencias: [], hechos: ['Algo pasó.'], ...extra } })

function pjFalso(id: number, nombre: string, extra: Partial<Personaje> = {}): Personaje {
  const base = construirPersonaje(u, { origen: 'superviviente', ...aplicarArquetipo(u, 'soldado'), nombre, aspecto: '', frase: '', arma: 'pistola_10mm', respuestas: [] })
  return { id, partida_id: 1, jugador_id: id, ...base, ...extra }
}

const guion = (): GuionMaestro => normalizarGuion({
  titulo: 'T', premisa: 'P', gancho: 'G',
  actos: [{ objetivo: 'Entrar al casino', hitos: [{ id: 'a1h1', texto: 'Consiguen entrada' }, { id: 'a1h2', texto: 'Ven al dueño' }] }, 'Escapar', 'Decidir'] as never,
  facciones: [{ nombre: 'Lobos', quiere: 'el puerto', esconde: 'nada', agenda: { meta: 'puerto', pasos: ['cierran el muelle', 'queman barcos'] } }],
  npcs: [{ nombre: 'Varela', rol: 'antagonista', motivacion: 'el agua', secreto: 'está enfermo', voz: 'seco', agenda: { meta: 'costa', pasos: ['cierra el puerto', 'toma el torreón'] } }, { nombre: 'Nora', motivacion: 'vivir', secreto: 'miente', voz: 'bajito' }],
  lugares: [{ nombre: 'Torreón', rasgo: 'alto' }], secretos: [], amenaza: { nombre: 'Tormenta', reloj: 'Tormenta', segmentos: 6 }, finales: [], encuentros: [],
})

// ------------------------------------------------------------------ Canon (puro)

test('canon: el guion siembra NPC, facciones y lugares; nadie está en escena hasta aparecer', () => {
  const m = mundoVacio()
  sembrarCanon(m, guion())
  assert.equal(m.npcs.length, 2)
  assert.equal(m.npcs.find((n) => n.nombre === 'Varela')!.rol, 'antagonista')
  assert.equal(presentes(m, 1).length, 0)
  assert.ok(m.facciones![0].agenda)
  const r = aplicarCambios(u, m, [], { npcs: [{ id: 'nora', nombre: 'Nora' }] }, { enCombate: false, turno: 3 })
  assert.deepEqual(r.rechazados, [])
  assert.deepEqual(presentes(m, 3).map((n) => n.nombre), ['Nora'])
  cortarEscena(m, { lugar: 'El muelle', pregunta: '¿Escapan?', presentes: [] }, 4)
  assert.equal(presentes(m, 4).length, 0, 'el corte de escena saca a los que no se listan')
  assert.equal(m.ubicacion, 'El muelle')
})

test('canon: partidas viejas (sin "presente") cuentan como presentes solo si aparecieron hace poco', () => {
  const m = mundoVacio()
  m.npcs.push({ id: 'a', nombre: 'Aldo', actitud: '', nota: '', visto: 10 }, { id: 'b', nombre: 'Berta', actitud: '', nota: '', visto: 2 })
  assert.deepEqual(presentes(m, 11).map((n) => n.nombre), ['Aldo'])
})

test('economía narrativa: en el giro no se presentan NPC nuevos, en el planteo uno por turno', () => {
  const m = mundoVacio()
  const r = aplicarCambios(u, m, [], { npcs: [{ id: 'x', nombre: 'Xavier', quiere: 'plata', voz: 'grave' }] }, { enCombate: false, fase: 'giro', turno: 5, ronda: 2 })
  assert.equal(m.npcs.length, 0)
  assert.deepEqual(r.sinAlta, ['Xavier'])
  const r2 = aplicarCambios(u, m, [], { npcs: [{ id: 'x', nombre: 'Xavier', quiere: 'plata', voz: 'grave' }, { id: 'y', nombre: 'Yoli' }] }, { enCombate: false, fase: 'planteo', turno: 5, ronda: 2 })
  assert.equal(m.npcs.length, 1)
  assert.equal(m.npcs[0].peso, 'secundario', 'con quiere y voz es secundario')
  assert.deepEqual(r2.sinAlta, ['Yoli'])
  assert.equal(presupuestoNuevos(m, 'planteo', 5, 2), 0)
  assert.equal(presupuestoNuevos(m, 'planteo', 6, 2), 1)
})

test('hilos: tope por fase y cierre', () => {
  const m = mundoVacio()
  const ctx = { turno: 1, ronda: 1, fase: 'giro' as const }
  for (let i = 0; i < 5; i++) aplicarHilos(m, [{ accion: 'abrir', pregunta: `¿Pregunta ${i}?`, tipo: 'acto' }], ctx)
  assert.equal(m.hilos!.filter((h) => h.estado === 'abierto').length, 4, 'en el giro el tope es 4')
  const r = aplicarHilos(m, [{ accion: 'cerrar', pregunta: '¿Pregunta 0?' }], ctx)
  assert.equal(r.aplicados.length, 1)
  assert.equal(m.hilos!.filter((h) => h.estado === 'abierto').length, 3)
})

test('hitos: el acto avanza por lo que pasa, y un hito atrasado se vuelve evento', () => {
  const g = guion()
  assert.equal(actoPorHitos(g), 1)
  assert.equal(cumplirHito(g, 'a1h1'), 'Consiguen entrada')
  assert.equal(actoPorHitos(g), 1)
  const ev = eventoDesdeEstado(mundoVacio(), g, { actoPorRitmo: 2, turno: 5, arco: null })
  assert.equal(ev?.motivo, 'hito')
  assert.match(ev!.instruccion, /a1h2/)
  cumplirHito(g, 'a1h2')
  assert.equal(actoPorHitos(g), 2)
})

test('dosificación: el antagonista no aparece fuera del giro, y la radio se enfría', () => {
  const m = mundoVacio()
  sembrarCanon(m, guion())
  assert.ok(evitarEsteTurno(m, 5, 'escalada').some((x) => /Varela/.test(x)))
  marcarApariciones(m, 'Una voz por el altavoz anuncia el toque de queda.', 5)
  registrarNarracion(m, 'Una voz por el altavoz anuncia el toque de queda.', 5, 'voz que amenaza')
  const ev = evitarEsteTurno(m, 6, 'escalada')
  assert.ok(ev.some((x) => /altavoces/.test(x)))
  assert.ok(ev.some((x) => /voz que amenaza/.test(x)))
})

test('frentes: la agenda más urgente avanza y cada 3 rondas logra un paso', () => {
  const m = mundoVacio()
  sembrarCanon(m, guion())
  let logro = null
  for (let i = 0; i < 6 && !logro; i++) logro = avanzarAgendas(m)
  assert.ok(logro)
  assert.match(logro!.paso, /cierra|muelle/)
})

// ------------------------------------------------------------------ reconciliación (pura)

test('reconciliación: herida narrada se aplica; muerte no aplicada y decisión ajena son graves', () => {
  const a = pjFalso(1, 'Marta')
  const b = pjFalso(2, 'Tomás')
  const antes = { mundo: mundoVacio(), pjs: [a, b] }
  const despues = structuredClone(antes)
  const r = reconciliar([
    { tipo: 'dano', quien: 'P1' },
    { tipo: 'muerte', quien: 'Tomás' },
    { tipo: 'decide_por_pj', quien: 'P2', texto: 'Tomás acepta el trato' },
  ], { antes, despues, actor: a, enCombate: false, sinAlta: [], hayPresupuesto: true })
  assert.deepEqual(r.aplicar.salud, [{ pj: 'P1', delta: -2, motivo: 'herida narrada' }])
  assert.equal(r.graves.length, 2)
  assert.ok(r.graves.some((g) => /Tomás NO murió/.test(g)))
  assert.ok(r.graves.some((g) => /decidiste por Tomás/.test(g)))
})

test('reconciliación: un NPC nuevo sin presupuesto obliga a reparar; con presupuesto se da de alta', () => {
  const antes = { mundo: mundoVacio(), pjs: [pjFalso(1, 'Marta')] }
  const despues = structuredClone(antes)
  assert.equal(reconciliar([{ tipo: 'npc_nuevo', nombre: 'La Colorada' }], { antes, despues, enCombate: false, sinAlta: [], hayPresupuesto: false }).graves.length, 1)
  const ok = reconciliar([{ tipo: 'npc_nuevo', nombre: 'La Colorada' }], { antes, despues, enCombate: false, sinAlta: [], hayPresupuesto: true })
  assert.equal(ok.graves.length, 0)
  assert.equal(ok.aplicar.npcs?.[0].nombre, 'La Colorada')
})

// ------------------------------------------------------------------ juego (integración)

test('brief: MESA con personas, quién juega y quién sigue; libreta y regla de no decidir por otros', async () => {
  const { m, j, pid } = await enJuego()
  m.mock.cola.push(narrar({ libreta: 'Nora miente sobre la llave.' }))
  await jugar(m, j, pid)
  await jugar(m, j, pid)
  const sis = m.mock.vistas.at(-1)!.sistema
  assert.match(sis, /MESA \(personas reales/)
  assert.match(sis, /← JUEGA AHORA/)
  assert.match(sis, /← juega después/)
  assert.match(sis, /Fran → P\d+/)
  assert.match(sis, /TU LIBRETA[\s\S]*Nora miente sobre la llave/)
  assert.match(sis, /Nunca decidas por un PJ que no es el del turno/)
  assert.match(sis, /FUERA DE ESCENA[\s\S]*Varela \[antagonista\]/)
  assert.match(sis, /EVITAR ESTE TURNO[\s\S]*Varela/)
})

test('reparación: si la narración mata a un PJ sin permiso, se reescribe antes de mostrarse', async () => {
  const { m, j, pid } = await enJuego()
  const p = m.ctx.db.partida(pid)!
  const actor = m.ctx.db.personajeVivoDe(p.turno_jugador_id!)!
  const otro = m.ctx.db.personajesVivos(pid).find((x) => x.id !== actor.id)!
  m.mock.textos.auditor = JSON.stringify({ afirmaciones: [{ tipo: 'muerte', quien: `P${otro.id}` }] })
  m.mock.cola.push(narrar({ narracion: `${otro.ficha.nombre} cae muerto en el muelle.` }), narrar({ narracion: 'La bala pasa rozando a todos.' }))
  await jugar(m, j, pid)
  assert.ok(m.mock.vistas.some((v) => /<correccion>/.test(v.usuario)), 'pidió la reparación')
  assert.ok(!delGrupo(m).some((x) => /cae muerto en el muelle/.test(x.html)), 'la narración contradictoria no se mostró')
  assert.ok(delGrupo(m).some((x) => /pasa rozando/.test(x.html)))
  assert.equal(m.ctx.db.personaje(otro.id)!.vivo, true)
})

test('reconciliación: una herida narrada fuera de combate queda en la ficha', async () => {
  const { m, j, pid } = await enJuego()
  const p = m.ctx.db.partida(pid)!
  const actor = m.ctx.db.personajeVivoDe(p.turno_jugador_id!)!
  m.mock.textos.auditor = JSON.stringify({ afirmaciones: [{ tipo: 'dano', quien: `P${actor.id}` }] })
  m.mock.cola.push(narrar({ narracion: `${actor.ficha.nombre} se corta con un vidrio y sangra.` }))
  await jugar(m, j, pid)
  assert.equal(m.ctx.db.personaje(actor.id)!.salud, actor.salud - 2)
  assert.ok(m.ctx.db.bitacoraTodas(pid).some((b) => b.tipo === 'motor' && /salud/.test(b.texto)), 'la IA ve lo aplicado en el turno siguiente')
})

test('escena: la IA corta a otra escena y define quiénes están; los demás no pueden hablar', async () => {
  const { m, j, pid } = await enJuego()
  m.mock.cola.push(narrar({ escena: { lugar: 'Casino subterráneo', pregunta: '¿Los descubren?', presentes: ['Nora'] }, cambios: { npcs: [{ id: 'nora', nombre: 'Nora' }] } }))
  await jugar(m, j, pid)
  const p = m.ctx.db.partida(pid)!
  assert.equal(p.mundo.escena!.lugar, 'Casino subterráneo')
  assert.deepEqual(presentes(p.mundo, p.turno_n).map((x) => x.nombre), ['Nora'])
  await jugar(m, j, pid)
  const sis = m.mock.vistas.at(-1)!.sistema
  assert.match(sis, /ESCENA \d+ · Casino subterráneo/)
  assert.match(sis, /NPC EN ESCENA[\s\S]*Nora/)
})

test('/dj: menú sin IA, respuestas del Canon y preguntas con IA sin secretos', async () => {
  const { m, j, pid } = await enJuego()
  await j.grupo(102, '/dj')
  assert.ok(delGrupo(m).some((x) => /Preguntale al DJ/.test(x.html)))
  await j.tocar(102, `j:${pid}:quien`, GRUPO)
  const quien = m.api.msgs.filter((x) => x.chatId === '102').at(-1)!
  assert.match(limpio(quien.html), /La mesa/)
  assert.match(limpio(quien.html), /Fran → /)
  await j.grupo(102, '/dj ¿Quién es Varela y qué quiere?')
  const pedido = m.mock.ultimaTexto('dj')!
  assert.doesNotMatch(pedido.usuario, /está enfermo|Trabaja para Varela/, 'los secretos no llegan al que responde')
  assert.ok(delGrupo(m).some((x) => /Respuesta simulada del DJ/.test(x.html)))
  // Por privado, el texto libre es una pregunta.
  await j.privado(103, '¿Qué buscamos?')
  assert.ok(m.api.msgs.some((x) => x.chatId === '103' && /Respuesta simulada del DJ/.test(x.html)))
})

test('/fe_de_erratas: el anfitrión corrige y el DJ lo recibe como verdad', async () => {
  const { m, j, pid } = await enJuego()
  await j.grupo(101, '/fe_de_erratas Tomás no murió: quedó herido')
  await jugar(m, j, pid)
  assert.match(m.mock.vistas.at(-1)!.sistema, /CORRECCIONES[\s\S]*Tomás no murió/)
})

test('arco personal: el Brief ofrece el beat y la definición queda como elección del jugador', async () => {
  const { m, j, pid } = await enJuego()
  const p = m.ctx.db.partida(pid)!
  const actor = m.ctx.db.personajeVivoDe(p.turno_jugador_id!)!
  m.mock.cola.push(narrar({ beat_jugado: `P${actor.id}` }), narrar({ beat_jugado: `P${actor.id}` }))
  await jugar(m, j, pid)
  assert.match(m.mock.vistas.at(-1)!.sistema, /OPORTUNIDAD DE ARCO PERSONAL/)
  const arco = m.ctx.db.partida(pid)!.mundo.arcos!.find((a) => a.pj === actor.id)!
  assert.equal(arco.beats[0].estado, 'jugado')
  // Forzamos la definición y que le toque de nuevo.
  const p2 = m.ctx.db.partida(pid)!
  const a2 = p2.mundo.arcos!.find((a) => a.pj === actor.id)!
  a2.beats[1].estado = 'jugado'
  a2.definiendo = true
  m.ctx.db.guardarPartida(p2)
  for (let i = 0; i < 3 && m.ctx.db.partida(pid)!.turno_jugador_id !== actor.jugador_id; i++) await jugar(m, j, pid)
  await jugar(m, j, pid, 'Elijo salvar a mi hermano aunque el grupo se arriesgue')
  assert.ok(m.ctx.db.hechos(pid).some((h) => /eligió: Elijo salvar a mi hermano/.test(h.texto)))
})

test('última oportunidad: con Suerte, en vez de morir queda con una cicatriz', () => {
  const pj = pjFalso(1, 'Tito', { condiciones: ['caido'], salud: 0, suerte: 2 })
  const sue = pj.ficha.atributos
  const antes = JSON.stringify(sue)
  const salvados: Personaje[] = []
  resolverCaidos([pj], 'normal', rngSecuencia([20, 20, 3, 3]), salvados)
  assert.equal(pj.vivo, true)
  assert.equal(pj.suerte, 0)
  assert.equal(salvados.length, 1)
  assert.equal(pj.ficha.cicatrices?.length, 1)
  assert.notEqual(JSON.stringify(pj.ficha.atributos), antes)
})

test('legado: al morir, el jugador elige qué deja; sus cosas pasan a otro personaje', async () => {
  const { m, j, pid } = await enJuego({ let: 'normal' })
  const p = m.ctx.db.partida(pid)!
  const jug = m.ctx.db.jugador(p.turno_jugador_id!)!
  const pj = m.ctx.db.personajeVivoDe(jug.id)!
  const otro = m.ctx.db.personajesVivos(pid).find((x) => x.id !== pj.id)!
  m.mock.textos.intencion = JSON.stringify({ intencion: 'muerte_propia' })
  await j.grupo(Number(jug.user_id), 'Me tiro al vacío, no doy más', p.turno_msg_id ?? undefined)
  const b = m.api.botonData(GRUPO, new RegExp(`^d:${pid}:\\d+:s`))!
  await j.tocar(Number(jug.user_id), b.data, GRUPO, b.msg.id)
  assert.equal(m.ctx.db.personaje(pj.id)!.vivo, false)
  const dm = m.api.msgs.filter((x) => x.chatId === jug.dm_chat_id && /legado/i.test(x.html)).at(-1)
  assert.ok(dm, 'recibió la elección de legado')
  await j.tocar(Number(jug.user_id), `u:${pid}:${pj.id}:obj:${otro.id}`, jug.dm_chat_id!)
  const arma = pj.ficha.arma
  assert.ok(m.ctx.db.personaje(otro.id)!.inventario.filter((i) => i.id === arma).length >= 1)
  assert.match(m.ctx.db.partida(pid)!.mundo.narrativa!.pendientes.join(' '), /LEGADO/)
})

test('duelo: un personaje que entra a mitad de partida espera a la próxima escena', async () => {
  const { m, j, pid } = await enJuego({}, [101, 102])
  await j.crearPersonaje(103, pid, { origen: 'tribal', arq: 'maton' })
  const pj = m.ctx.db.personajeVivoDe(m.ctx.db.jugadorDeUsuario(pid, '103')!.id)!
  assert.ok(pj.ficha.entraEscena !== undefined, 'queda esperando')
  assert.ok(pj.ficha.lazo, 'trae un lazo con la historia')
  const turnos: number[] = []
  for (let i = 0; i < 2; i++) { turnos.push(m.ctx.db.partida(pid)!.turno_jugador_id!); await jugar(m, j, pid) }
  assert.ok(!turnos.includes(pj.jugador_id), 'no juega en la escena actual')
  m.mock.cola.push(narrar({ escena: { lugar: 'La ruta', pregunta: '¿Llegan?', presentes: [] } }))
  for (let i = 0; i < 3; i++) await jugar(m, j, pid)
  assert.equal(m.ctx.db.personaje(pj.id)!.ficha.entraEscena, undefined, 'con la escena nueva ya está habilitado')
})

// ------------------------------------------------------------------ creación

test('creación rápida: 4 toques dan una ficha completa (narrativa incluida) y válida', async () => {
  const m = crearMundo()
  const { pid } = await partidaLista(m, [101])
  const pj = m.ctx.db.personajeVivoDe(m.ctx.db.jugadorDeUsuario(pid, '101')!.id)!
  const f = pj.ficha
  for (const k of ['subOrigen', 'objetivo', 'miedo', 'secreto', 'mentira', 'valor', 'voz', 'oficio', 'persona', 'deuda', 'objetoPersonal'] as const) assert.ok(f[k], `falta ${k}`)
  assert.equal(f.virtudes?.length, 2)
  assert.equal(f.extras?.length, 1)
  assert.deepEqual(validarReparto(u, { ...f, atributos: aplicarArquetipo(u, 'soldado').atributos, habilidades: aplicarArquetipo(u, 'soldado').habilidades }), [])
})

test('hub: escribir un campo, sortear otro, elegir extra y tara (que da puntos)', async () => {
  const m = crearMundo()
  const j0 = await partidaLista(m, [101])
  const j = j0.j
  const t = (d: string) => j.tocar(102, d, '102', m.api.ultimo('102')!.id)
  await j.privado(102, `/start u_${j0.pid}`)
  await t('c:md:r')
  await t('c:or:refugio')
  await t('c:so:supervisor')
  await t('c:aq:tecnico')
  assert.match(limpio(m.api.ultimo('102')!.html), /Tu personaje/)
  await t('c:hub:id')
  await t('c:tx:nombre')
  await j.privado(102, 'Ezequiel "Chispa" Paz')
  await t('c:rn:objetivo')
  await t('c:xe:duro_de_matar')
  await t('c:xr:fragil')
  const jug = m.ctx.db.jugadorDeUsuario(j0.pid, '102')!
  const b = jug.creacion!.borrador
  assert.equal(b.nombre, 'Ezequiel "Chispa" Paz')
  assert.equal(b.subOrigen, 'supervisor')
  assert.deepEqual(b.extras, ['duro_de_matar'])
  assert.equal(puntosHabilidadTotal(u, b), 10, 'la tara da 2 puntos')
  // Con puntos libres no confirma; los reparte y confirma.
  await t('c:ok')
  assert.ok(m.ctx.db.jugadorDeUsuario(j0.pid, '102')!.creacion, 'no confirmó con puntos sin repartir')
  await t('c:hb:sigilo:+')
  await t('c:hb:conversacion:+')
  await t('c:ok')
  const pj = m.ctx.db.personajeVivoDe(jug.id)!
  assert.equal(pj.ficha.nombre, 'Ezequiel "Chispa" Paz')
  assert.equal(pj.salud_max, pj.ficha.atributos.RES + pj.ficha.atributos.SUE + 2 - 2, 'duro de matar +2 y frágil −2')
})

test('creación guiada: el DJ repregunta, compila con ids del catálogo y termina en el hub', async () => {
  const m = crearMundo()
  const j0 = await partidaLista(m, [101])
  const j = j0.j
  await j.privado(102, `/start u_${j0.pid}`)
  await j.tocar(102, 'c:md:e', '102')
  await j.privado(102, 'Es una chatarrera pelirroja que busca a su hermano en la costa.')
  assert.match(limpio(m.api.ultimo('102')!.html), /Qué lo sacó de su casa/)
  await j.tocar(102, 'c:ent:ya', '102')
  const b = m.ctx.db.jugadorDeUsuario(j0.pid, '102')!.creacion!.borrador
  assert.equal(b.nombre, 'La Colorada')
  assert.equal(b.origen, 'superviviente')
  assert.deepEqual(b.especialidades, ['supervivencia', 'sigilo', 'armas_pequenas'])
  assert.match(limpio(m.api.ultimo('102')!.html), /Así me lo imagino/)
  await j.tocar(102, 'c:ok', '102')
  assert.equal(m.ctx.db.personajeVivoDe(m.ctx.db.jugadorDeUsuario(j0.pid, '102')!.id)!.ficha.objetivo, 'Encontrar a su hermano')
})

test('creación guiada: lo inválido que devuelve la IA se repara', async () => {
  const m = crearMundo()
  const j0 = await partidaLista(m, [101])
  m.mock.textos.compilar = JSON.stringify({ origen: 'marciano', arquetipo: 'nada', especialidades: ['volar'], extras: ['genio'], nombre: 'Zed', arma: 'sable_laser' })
  await j0.j.privado(102, `/start u_${j0.pid}`)
  await j0.j.tocar(102, 'c:md:e', '102')
  await j0.j.tocar(102, 'c:ent:ya', '102')
  const c = m.ctx.db.jugadorDeUsuario(j0.pid, '102')!.creacion!
  assert.equal(c.borrador.origen, 'superviviente')
  assert.ok(c.ajustes!.length > 0)
  await j0.j.tocar(102, 'c:ok', '102')
  assert.ok(m.ctx.db.personajeVivoDe(m.ctx.db.jugadorDeUsuario(j0.pid, '102')!.id), 'igual queda un personaje válido')
})

// ------------------------------------------------------------------ cerebro

test('responses API: traduce herramientas, elección forzada y la respuesta', () => {
  const body = aResponses('gpt-5.4-mini', {
    messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
    tools: [{ type: 'function', function: { name: 'narrar', description: 'd', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'narrar' } }, max_completion_tokens: 900,
  })
  assert.equal(body.instructions, 'S')
  assert.deepEqual(body.tools, [{ type: 'function', name: 'narrar', description: 'd', parameters: { type: 'object' } }])
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'narrar' })
  const r = deResponses({ output: [{ type: 'reasoning' }, { type: 'function_call', name: 'narrar', arguments: '{"narracion":"x"}', call_id: 'c1' }], usage: { input_tokens: 10, output_tokens: 2 } })
  assert.equal(r.choices[0].message.tool_calls[0].function.name, 'narrar')
})

test('salida: la crónica sale de los hechos y se normalizan los campos nuevos', () => {
  const s = normalizarSalida({ narracion: 'x', hechos: ['Marta entra al casino', 'Aldo confiesa'], escena: { pregunta: '¿Huyen?', lugar: 'Muelle' }, hilos: [{ accion: 'abrir', pregunta: '¿Quién?' }, { accion: 'nada' }], libreta: 'plan' })
  assert.equal(s.cronica, 'Marta entra al casino · Aldo confiesa')
  assert.equal(s.escena?.lugar, 'Muelle')
  assert.equal(s.hilos?.length, 1)
  assert.equal(s.libreta, 'plan')
})

test('reconciliación: un personaje muerto que actúa obliga a reparar', () => {
  const antes = { mundo: mundoVacio(), pjs: [pjFalso(1, 'Marta')] }
  const r = reconciliar([{ tipo: 'actua_muerto', quien: 'Lu' }], { antes, despues: structuredClone(antes), enCombate: false, sinAlta: [], hayPresupuesto: true, pjMuertos: ['Lu Ferreyra'] })
  assert.equal(r.graves.length, 1)
})

test('mesa: una contradicción sin reparar se explica en lenguaje de jugador', async () => {
  const { notaParaMesa } = await import('../src/juego/narrativa.js')
  assert.equal(notaParaMesa(['Tomás NO murió (el motor no lo aplicó): está vivo']), '⚖️ Aclaración del DJ: Tomás sigue con vida')
  assert.match(notaParaMesa(['decidiste por Lu ("acepta")']), /vale el tablero/)
})

test('aviso privado de turno: novedades, escena y cómo jugar (sin IA)', async () => {
  const { m, j, pid } = await enJuego()
  m.mock.cola.push(narrar({ cronica: '', hechos: ['Marta encontró a Aldo'], escena: { lugar: 'El muelle', pregunta: '¿Consiguen la válvula?', presentes: [] } }))
  await jugar(m, j, pid)
  const p = m.ctx.db.partida(pid)!
  const jug = m.ctx.db.jugador(p.turno_jugador_id!)!
  const dm = m.api.msgs.filter((x) => x.chatId === jug.dm_chat_id && /Te toca/.test(x.html)).at(-1)!
  const t = limpio(dm.html)
  assert.match(t, /Desde tu último turno/)
  assert.match(t, /Marta encontró a Aldo/)
  assert.match(t, /El muelle/)
  assert.match(t, /Escribime acá/)
  const tarjeta = limpio(m.api.msgs.find((x) => x.id === p.turno_msg_id)!.html)
  assert.match(tarjeta, /¿Consiguen la válvula\?/)
})
