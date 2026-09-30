import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crearMundo, partidaLista, GRUPO } from '../scripts/harness.js'

test('flujo: crear partida, personajes por privado y empezar', async () => {
  const m = crearMundo()
  const { j, pid } = await partidaLista(m)
  assert.equal(m.ctx.db.personajesVivos(pid).length, 3)
  await j.tocar(102, `b:${pid}:empezar`, GRUPO) // no es anfitrión
  assert.equal(m.ctx.db.partida(pid)!.estado, 'CREANDO')
  await j.tocar(101, `b:${pid}:empezar`, GRUPO)
  const p = m.ctx.db.partida(pid)!
  assert.equal(p.estado, 'EN_JUEGO')
  assert.ok(p.turno_jugador_id)
})

test('flujo: el que no tiene el turno no juega, y el DJ narra al que sí', async () => {
  const m = crearMundo()
  const { j, pid } = await partidaLista(m)
  await j.tocar(101, `b:${pid}:empezar`, GRUPO)
  let p = m.ctx.db.partida(pid)!
  const actual = m.ctx.db.jugador(p.turno_jugador_id!)!
  const otro = m.ctx.db.jugadores(pid).find((x) => x.id !== actual.id)!
  const llamadas = m.mock.llamadas
  await j.grupo(Number(otro.user_id), 'Hago algo fuera de turno', p.turno_msg_id ?? undefined)
  assert.equal(m.mock.llamadas, llamadas, 'no se gasta IA si no es tu turno')
  await j.grupo(Number(actual.user_id), 'Miro alrededor', p.turno_msg_id ?? undefined)
  assert.ok(m.mock.llamadas > llamadas)
})

test('flujo: un mensaje suelto en el grupo no gasta tokens', async () => {
  const m = crearMundo()
  const { j, pid } = await partidaLista(m)
  await j.tocar(101, `b:${pid}:empezar`, GRUPO)
  const llamadas = m.mock.llamadas
  await j.grupo(101, 'jaja qué bueno')
  await j.grupo(102, 'che, ¿jugamos?')
  assert.equal(m.mock.llamadas, llamadas)
})

test('votación: no se puede proponer antes de que venza el turno', async () => {
  const m = crearMundo()
  const { j, pid } = await partidaLista(m)
  await j.tocar(101, `b:${pid}:empezar`, GRUPO)
  const p = m.ctx.db.partida(pid)!
  const actual = m.ctx.db.jugador(p.turno_jugador_id!)!
  const otro = m.ctx.db.jugadores(pid).find((x) => x.id !== actual.id)!
  await j.grupo(Number(otro.user_id), '/saltear')
  assert.match(m.api.ultimo(GRUPO)!.html, /Todavía no venció/)
})
