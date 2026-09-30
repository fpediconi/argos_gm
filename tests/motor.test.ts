import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cargarUniverso } from '../src/universos/fallout/index.js'
import { contarExitos, rngSecuencia, tirarDados } from '../src/motor/dados.js'
import { evaluarVotacion } from '../src/motor/votaciones.js'
import { enSilencio, vencimiento, SIN_LIMITE, siguienteJugador } from '../src/motor/turnos.js'
import { aplicarArquetipo, validarReparto, construirPersonaje, atributosBase, cambiarAtributo, puntosAtributoLibres } from '../src/motor/personaje.js'
import { aplicarCambios, mundoVacio } from '../src/motor/estado.js'
import { resolverPrueba } from '../src/motor/reglas.js'
import type { Ficha, Jugador, Personaje } from '../src/motor/tipos.js'
import { rngLcg } from '../scripts/harness.js'

const u = cargarUniverso('fallout')

function ficha(arq: string, origen = 'refugio'): Ficha {
  const r = aplicarArquetipo(u, arq)
  return { origen, ...r, nombre: 'Test', aspecto: '', frase: '', arma: 'pistola_10mm', respuestas: [] }
}
function pj(arq = 'soldado', origen = 'refugio'): Personaje {
  return { id: 1, partida_id: 1, jugador_id: 1, ...construirPersonaje(u, ficha(arq, origen)) }
}

test('dados: éxitos, críticos y complicaciones', () => {
  assert.deepEqual(contarExitos([5, 12, 20], 10, 0, false), { exitos: 1, criticos: 0, complicaciones: 1 })
  assert.deepEqual(contarExitos([1, 2], 10, 2, true), { exitos: 4, criticos: 2, complicaciones: 0 })
  assert.deepEqual(contarExitos([3], 10, 2, false), { exitos: 1, criticos: 0, complicaciones: 0 })
  assert.equal(tirarDados(3, rngSecuencia([4, 5, 6])).length, 3)
})

test('dados: la distribución de éxitos con TN 10 y 2d20 coincide con la teoría', () => {
  const rng = rngLcg(12345)
  const N = 40000
  const cuenta = [0, 0, 0]
  for (let i = 0; i < N; i++) cuenta[contarExitos(tirarDados(2, rng), 10, 0, false).exitos]++
  // P(éxito por dado) = 0.5 → 25% / 50% / 25%
  assert.ok(Math.abs(cuenta[0] / N - 0.25) < 0.03, `0 éxitos ${cuenta[0] / N}`)
  assert.ok(Math.abs(cuenta[1] / N - 0.5) < 0.03, `1 éxito ${cuenta[1] / N}`)
  assert.ok(Math.abs(cuenta[2] / N - 0.25) < 0.03, `2 éxitos ${cuenta[2] / N}`)
})

test('votaciones: mayoría estricta', () => {
  assert.equal(evaluarVotacion(0, 0, 0, false), 'pasa')
  assert.equal(evaluarVotacion(2, 1, 0, false), 'abierta')
  assert.equal(evaluarVotacion(2, 2, 0, false), 'pasa')
  assert.equal(evaluarVotacion(3, 2, 0, false), 'pasa')
  assert.equal(evaluarVotacion(3, 1, 2, false), 'falla')
  assert.equal(evaluarVotacion(3, 1, 0, true), 'falla')
})

test('turnos: el reloj se pausa en horas de silencio (ART, 00–08)', () => {
  const ART = -180
  const t = (h: number) => Date.UTC(2026, 8, 30, h + 3, 0) // hora argentina h
  assert.equal(enSilencio(t(3), [0, 8], ART), true)
  assert.equal(enSilencio(t(9), [0, 8], ART), false)
  // 22:00 + 6 h con silencio 0–8: 2 h antes de medianoche + 4 h desde las 08:00 → 12:00
  assert.equal(vencimiento(t(22), 6, [0, 8], ART), t(24 + 12))
  assert.equal(vencimiento(t(22), 6, null, ART), t(28))
  assert.equal(vencimiento(t(22), 0, [0, 8], ART), SIN_LIMITE)
})

function jug(id: number, orden: number, estado: Jugador['estado'] = 'activo'): Jugador {
  return { id, partida_id: 1, user_id: String(id), nombre: 'J' + id, username: '', dm_chat_id: null, estado, orden, ausente_hasta: 0, ultimo_visto_n: 0 } as Jugador
}

test('turnos: rotación, salteo de ausentes y nueva ronda', () => {
  const js = [jug(1, 0), jug(2, 1, 'ausente'), jug(3, 2)]
  const a = siguienteJugador(js, 1)!
  assert.equal(a.jugador.id, 3)
  assert.deepEqual(a.saltados.map((x) => x.id), [2])
  assert.equal(a.nuevaRonda, false)
  const b = siguienteJugador(js, 3)!
  assert.equal(b.jugador.id, 1)
  assert.equal(b.nuevaRonda, true)
  assert.equal(siguienteJugador([jug(1, 0, 'ausente')], null), null)
})

test('arquetipos y reparto: todos los arquetipos son válidos', () => {
  for (const a of u.arquetipos) assert.deepEqual(validarReparto(u, aplicarArquetipo(u, a.id)), [], a.id)
})

test('reparto: valida atributos y habilidades inválidos', () => {
  const r = aplicarArquetipo(u, 'soldado')
  const malo = { ...r, atributos: { ...r.atributos, FUE: 9 } }
  assert.ok(validarReparto(u, malo).length > 0)
  const attrs = atributosBase()
  assert.equal(puntosAtributoLibres(attrs), 5)
  assert.equal(cambiarAtributo(attrs, 'FUE', 1), true)
})

test('personaje: orígenes aplican bonos y cada origen construye una ficha válida', () => {
  for (const o of u.origenes) {
    const p = pj('soldado', o.id)
    assert.ok(p.salud > 0 && p.salud === p.salud_max, `${o.id} salud`)
    for (const v of Object.values(p.ficha.atributos)) assert.ok(v >= 1 && v <= 10, `${o.id} atributo ${v}`)
  }
})

test('aplicarCambios: valida y limita lo que propone la IA', () => {
  const p = pj()
  const mundo = mundoVacio()
  const antes = p.salud
  const r = aplicarCambios(u, mundo, [p], { salud: [{ pj: 'P1', delta: -100 }, { pj: 'P99', delta: -1 }] }, { enCombate: false })
  assert.equal(p.salud, Math.max(0, antes - 6), 'daño limitado a 6 por llamada')
  assert.ok(r.rechazados.some((x) => /inexistente/.test(x)))
  const c = aplicarCambios(u, mundo, [p], { salud: [{ pj: 'P1', delta: -1 }] }, { enCombate: true })
  assert.ok(c.rechazados.length === 1, 'en combate la salud la maneja el motor')
})

test('resolverPrueba: usa TN = atributo + habilidad y suma dado extra con suerte', () => {
  const p = pj()
  const base = resolverPrueba(p, { atributo: 'AGI', habilidad: 'sigilo', dificultad: 1, motivo: 'x' }, 'ninguno', rngSecuencia([1, 1, 1]))
  assert.equal(base.dados.length, 2)
  const s = resolverPrueba(p, { atributo: 'AGI', habilidad: 'sigilo', dificultad: 1, motivo: 'x' }, 'suerte', rngSecuencia([1, 1, 1]))
  assert.equal(s.dados.length, 3)
})
