import assert from 'node:assert/strict'
import { crearMundo, partidaLista, GRUPO, HORA, type Mundo, type Jugadores } from './harness.js'
import { tick } from '../src/juego/planificador.js'

const silencioso = process.argv.includes('--silencioso')
const log = (...a: unknown[]) => { if (!silencioso) console.log(...a) }
const limpio = (h: string) => h.replace(/<[^>]+>/g, '')

async function jugarTurno(m: Mundo, j: Jugadores, pid: number, texto: string) {
  const p = m.ctx.db.partida(pid)!
  const jug = m.ctx.db.jugador(p.turno_jugador_id!)!
  const uid = Number(jug.user_id)
  if (p.modo_escena === 'combate') {
    let d = m.api.botonData(GRUPO, new RegExp(`^a:${pid}:${p.turno_n}:at`))
    assert.ok(d, 'combate: falta botón Atacar')
    await j.tocar(uid, d.data, GRUPO, d.msg.id)
    const t = m.api.botonData(GRUPO, new RegExp(`^t:${pid}:${p.turno_n}:`))
    if (t && m.ctx.db.partida(pid)!.turno_n === p.turno_n) await j.tocar(uid, t.data, GRUPO, t.msg.id)
  } else {
    await j.grupo(uid, texto, p.turno_msg_id ?? undefined)
    const r = m.api.botonData(GRUPO, new RegExp(`^r:${pid}:${p.turno_n}:n`))
    if (r && m.ctx.db.partida(pid)!.paso.tipo === 'esperando_tirada') await j.tocar(uid, r.data, GRUPO, r.msg.id)
  }
  return jug.nombre
}

async function main() {
  const m = crearMundo()
  const { j, pid } = await partidaLista(m)
  let p = m.ctx.db.partida(pid)!
  assert.equal(m.ctx.db.personajesVivos(pid).length, 3, 'tres personajes creados')
  log('✔ configuración y creación de 3 personajes')

  await j.tocar(101, `b:${pid}:empezar`, GRUPO)
  p = m.ctx.db.partida(pid)!
  assert.equal(p.estado, 'EN_JUEGO', 'la partida arrancó')
  assert.ok(p.turno_jugador_id, 'hay un jugador con turno')
  log('✔ partida en juego:', p.guion?.titulo)

  let combatesVistos = 0
  for (let i = 0; i < 14; i++) {
    p = m.ctx.db.partida(pid)!
    if (p.estado !== 'EN_JUEGO') break
    if (p.paso.tipo === 'esperando_mejora') {
      for (const jug of m.ctx.db.jugadores(pid)) {
        const b = m.api.botonData(String(jug.user_id), /^m:g:/)
        if (b) await j.tocar(Number(jug.user_id), b.data, String(jug.user_id), b.msg.id)
      }
      continue
    }
    if (p.modo_escena === 'combate') combatesVistos++
    const nombre = await jugarTurno(m, j, pid, `Exploro con cuidado (${i})`)
    log(`  turno ${i + 1}: ${nombre} → capítulo ${m.ctx.db.partida(pid)!.capitulo}, escena ${m.ctx.db.partida(pid)!.modo_escena}`)
    m.reloj.t += HORA
  }
  assert.ok(m.ctx.db.bitacoraTodas(pid).length > 5, 'la bitácora tiene entradas')
  log('✔ turnos, tiradas', combatesVistos ? 'y combate' : '')

  // Saltear por votación: vence el plazo y se propone.
  p = m.ctx.db.partida(pid)!
  if (p.estado === 'EN_JUEGO') {
    const actual = m.ctx.db.jugador(p.turno_jugador_id!)!
    m.reloj.t = p.turno_vence + HORA
    await tick(m.ctx)
    const otros = m.ctx.db.jugadores(pid).filter((x) => x.id !== actual.id)
    await j.grupo(Number(otros[0].user_id), '/saltear')
    const v = m.api.botonData(GRUPO, /^v:\d+:s$/)
    assert.ok(v, 'hay botón de votación')
    await j.tocar(Number(otros[1].user_id), v.data, GRUPO, v.msg.id)
    const despues = m.ctx.db.partida(pid)!
    assert.notEqual(despues.turno_jugador_id, actual.id, 'el turno pasó al siguiente tras la votación')
    log('✔ voto para saltear')

    await j.grupo(Number(actual.user_id), '/ausente 1d')
    await j.grupo(Number(actual.user_id), '/volver')
    await j.grupo(Number(actual.user_id), '/resumen')
    await j.grupo(Number(actual.user_id), '/ficha')
    await j.grupo(Number(actual.user_id), '/costo')
    log('✔ comandos de info')
  }

  await j.grupo(101, '/fin')
  const fin = m.ctx.db.partida(pid)!
  log('  estado final:', fin.estado)
  await j.grupo(101, '/libro')
  const errores = m.api.msgs.filter((x) => /Error|undefined|NaN|\[object/.test(limpio(x.html)))
  assert.equal(errores.length, 0, 'ningún mensaje con basura: ' + errores.map((x) => limpio(x.html).slice(0, 80)).join(' | '))
  log(`✔ simulación completa · ${m.api.msgs.length} mensajes · ${m.mock.llamadas} llamadas IA simuladas`)
  if (!silencioso) console.log('\nÚltimos mensajes del grupo:\n' + m.api.msgs.filter((x) => x.chatId === GRUPO).slice(-4).map((x) => '— ' + limpio(x.html).slice(0, 300)).join('\n'))
  console.log('SIMULACIÓN OK')
}

main().catch((e) => { console.error('SIMULACIÓN FALLÓ:', e); process.exit(1) })
