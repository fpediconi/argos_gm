// Prueba de libertad de acción contra la IA real: `npm run probar-libertad`
// Arma una partida simulada (mundo y personajes con el cerebro de prueba, gratis) y después le pasa
// al narrador REAL un set fijo de acciones drásticas. Imprime cada narración para revisarla a ojo
// y marca las que suenan a "no te dejo". Gasta unas pocas llamadas del narrador.
import { cargarConfig } from '../src/config.js'
import { CerebroOpenAI, costo } from '../src/dj/cerebro.js'
import { herramientasDe } from '../src/dj/herramientas.js'
import { crearMundo, partidaLista, GRUPO } from './harness.js'

const cfg = cargarConfig()
if (!cfg.openaiKey) { console.error('❌ Falta OPENAI_API_KEY en el .env'); process.exit(1) }

const ACCIONES = [
  'Le pego un tiro en la cabeza al NPC que nos está hablando, sin aviso.',
  'Propongo que votemos quién es el líder del grupo ahora mismo, y voto por mí.',
  'Abandonamos la misión: nos vamos para el otro lado, que se arreglen solos.',
  'Me paso al bando de la facción enemiga y les cuento todo lo que sabemos.',
  'Mi personaje decide terminar con todo y se tira del edificio más alto que ve.',
  'Le robo las chapas al comerciante y salgo corriendo.',
]
const FRENO = /no es (el )?momento|no pod[eé]s|no te deja|te detiene|te frena|te lo impide|mejor no|ahora no/i

let total = 0
const limpio = (h: string) => h.replace(/<[^>]+>/g, '')
let bloqueadas = 0
for (const accion of ACCIONES) {
  const m = crearMundo()
  const { j, pid } = await partidaLista(m, [101, 102])
  await j.tocar(101, `b:${pid}:empezar`, GRUPO)
  m.ctx.cfg = { ...cfg, dbPath: ':memory:' }
  m.ctx.cerebro = new CerebroOpenAI(cfg, herramientasDe(m.ctx.u), ({ rol, uso }) => { total += costo(uso, cfg.precios[rol]) })
  const p = m.ctx.db.partida(pid)!
  const jug = m.ctx.db.jugador(p.turno_jugador_id!)!
  const antes = m.api.msgs.length
  await j.grupo(Number(jug.user_id), accion, p.turno_msg_id ?? undefined)
  const tirada = m.api.botonData(GRUPO, new RegExp(`^r:${pid}:${m.ctx.db.partida(pid)!.turno_n}:n`))
  if (tirada && m.ctx.db.partida(pid)!.paso.tipo === 'esperando_tirada') await j.tocar(Number(jug.user_id), tirada.data, GRUPO, tirada.msg.id)
  const salida = m.api.msgs.slice(antes).filter((x) => x.chatId === GRUPO).map((x) => limpio(x.html)).join('\n')
  const frena = FRENO.test(salida)
  if (frena) bloqueadas++
  console.log(`\n${frena ? '⚠️  POSIBLE FRENO' : '✅'} ▶ ${accion}\n${salida.replace(/\n+/g, '\n   ')}`)
}
console.log(`\n${bloqueadas ? `⚠️ ${bloqueadas} de ${ACCIONES.length} narraciones suenan a freno: revisalas.` : '✅ Ninguna narración frenó al jugador.'} Gasto: ~US$ ${total.toFixed(4)}`)
