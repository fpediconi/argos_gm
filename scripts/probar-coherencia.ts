// Prueba de coherencia contra la IA real: `npm run probar-coherencia [turnos]`
// Arma una partida completa con el guionista REAL, tres jugadores con acciones guionadas y N turnos (20 por defecto),
// y mide lo que hace que una historia se entienda o se enrosque: contradicciones, reparaciones, presencia del
// antagonista, radios y altavoces, concentración de NPC, hilos abiertos, hitos cumplidos y foco.
// Al final, un lector "en frío" que no vio la partida lee solo lo que se mostró y responde qué entendió.
import { cargarConfig } from '../src/config.js'
import { CerebroOpenAI, costo } from '../src/dj/cerebro.js'
import { herramientasDe } from '../src/dj/herramientas.js'
import { crearMundo, partidaLista, GRUPO } from './harness.js'
import { rngReal } from '../src/motor/dados.js'
import { MEDIOS, menciona } from '../src/motor/canon.js'
import { faseDe } from '../src/motor/ritmo.js'

const cfg = cargarConfig()
const MOCK = !!process.env.MOCK // MOCK=1: corre con el cerebro de prueba (para probar el script sin gastar)
if (!cfg.openaiKey && !MOCK) { console.error('❌ Falta OPENAI_API_KEY en el .env'); process.exit(1) }
const TURNOS = Number(process.argv[2]) || 20

const ACCIONES: Record<number, string[]> = {
  101: ['Miro alrededor buscando pistas de quién estuvo acá', 'Le pregunto al NPC más cercano qué sabe del objetivo', 'Reviso los papeles que hay sobre la mesa', 'Sigo el rastro que encontramos', 'Comparo lo que dijo cada uno: ¿alguien miente?', 'Le muestro la prueba al que sospechamos'],
  102: ['Me adelanto con el arma lista, cubriendo al grupo', 'Si alguien nos amenaza, le disparo primero', 'Trepo para ver desde arriba', 'Busco una salida por si esto se pone feo', 'Encaro al que nos sigue', 'Protejo al más herido del grupo'],
  103: ['Intento negociar un trato que nos convenga', 'Le ofrezco chapas a cambio de información', 'Me separo un rato del grupo para seguir mi propia pista', 'Le miento sobre quiénes somos', 'Voto que vayamos directo al objetivo', 'Le cuento al grupo lo que descubrí por mi cuenta'],
}

let gasto = 0
const reparaciones: string[] = []
const m = crearMundo()
const { j, pid } = await partidaLista(m, [101, 102, 103], { dur: 'oneshot' })
if (!MOCK) m.ctx.cfg = { ...cfg, dbPath: ':memory:' }
m.ctx.rng = rngReal
m.ctx.log = (...a: unknown[]) => { const t = a.map(String).join(' '); if (/reparando/.test(t)) reparaciones.push(t); else if (process.env.VERBOSO) console.log(...a) }
if (!MOCK) m.ctx.cerebro = new CerebroOpenAI(cfg, herramientasDe(m.ctx.u), ({ rol, uso }) => { gasto += costo(uso, cfg.precios[rol]) })
console.log(`▶ Armando el mundo con la IA real (${cfg.api === 'responses' ? '/responses' : '/chat/completions'})…`)
await j.tocar(101, `b:${pid}:empezar`, GRUPO)

const narraciones: { turno: number; fase: string; texto: string }[] = []
let mostrado = m.api.msgs.length
const idx: Record<number, number> = { 101: 0, 102: 0, 103: 0 }
for (let t = 0; t < TURNOS; t++) {
  const p = m.ctx.db.partida(pid)!
  if (p.estado !== 'EN_JUEGO') break
  const jug = m.ctx.db.jugador(p.turno_jugador_id!)!
  const uid = Number(jug.user_id)
  if (p.modo_escena === 'combate') {
    const a = m.api.botonData(GRUPO, new RegExp(`^a:${pid}:${p.turno_n}:at`))
    if (a) await j.tocar(uid, a.data, GRUPO, a.msg.id)
    const o = m.api.botonData(GRUPO, new RegExp(`^t:${pid}:${p.turno_n}:`))
    if (o && m.ctx.db.partida(pid)!.turno_n === p.turno_n) await j.tocar(uid, o.data, GRUPO, o.msg.id)
  } else {
    const acciones = ACCIONES[uid] ?? ACCIONES[101]
    const accion = acciones[idx[uid]++ % acciones.length]
    await j.grupo(uid, accion, p.turno_msg_id ?? undefined)
    const p2 = m.ctx.db.partida(pid)!
    if (p2.paso.tipo === 'esperando_tirada') {
      const r = m.api.botonData(GRUPO, new RegExp(`^r:${pid}:${p2.turno_n}:n`))
      if (r) await j.tocar(uid, r.data, GRUPO, r.msg.id)
    }
    if (m.ctx.db.partida(pid)!.paso.tipo === 'confirmando') {
      const d = m.api.botonData(GRUPO, new RegExp(`^d:${pid}:\\d+:n`))
      if (d) await j.tocar(uid, d.data, GRUPO, d.msg.id)
    }
  }
  const p3 = m.ctx.db.partida(pid)!
  const nuevos = m.api.msgs.slice(mostrado).filter((x) => x.chatId === GRUPO && /^🎲 <i>|^📖/.test(x.html))
  mostrado = m.api.msgs.length
  for (const x of nuevos) narraciones.push({ turno: t + 1, fase: p3.mundo.ritmo ? faseDe(p3.mundo.ritmo) : '?', texto: x.html.replace(/<[^>]+>/g, '') })
  process.stdout.write('.')
}
console.log('\n')

const p = m.ctx.db.partida(pid)!
const mundo = p.mundo
const n = mundo.narrativa!
const ants = mundo.npcs.filter((x) => x.rol === 'antagonista')
const fueraDeLugar = narraciones.filter((x) => x.fase !== 'giro' && x.fase !== 'climax' && ants.some((a) => menciona(x.texto, a.nombre))).length
const medios = narraciones.filter((x) => MEDIOS.test(x.texto)).length
const conteo = mundo.npcs.map((x) => ({ nombre: x.nombre, veces: narraciones.filter((y) => menciona(y.texto, x.nombre)).length })).sort((a, b) => b.veces - a.veces)
const totalMenciones = conteo.reduce((s, x) => s + x.veces, 0) || 1
const hitos = (p.guion?.actos ?? []).flatMap((a) => a.hitos)
const jugadores = m.ctx.db.jugadores(pid)
const focos = jugadores.map((x) => x.foco)
const pct = (a: number, b: number) => `${Math.round((100 * a) / Math.max(1, b))}%`
const linea = (ok: boolean, txt: string) => console.log(`${ok ? '✅' : '⚠️ '} ${txt}`)

console.log(`📖 «${p.guion?.titulo}» — ${narraciones.length} narraciones en ${TURNOS} turnos · Gasto ~US$ ${gasto.toFixed(4)}\n`)
linea((n.contradicciones ?? 0) / Math.max(1, narraciones.length) < 0.1, `Contradicciones detectadas: ${n.contradicciones ?? 0} (${n.auditorias ?? 0} narraciones auditadas, ${n.reparaciones ?? 0} reparadas)`)
for (const r of reparaciones) console.log(`     · ${r.replace(/^reparando narración \(partida \d+\): /, '')}`)
linea(fueraDeLugar / Math.max(1, narraciones.length) <= 0.15, `Antagonista en escena fuera del giro/clímax: ${fueraDeLugar} de ${narraciones.length} (${pct(fueraDeLugar, narraciones.length)}, meta ≤ 15%)`)
linea(medios <= Math.ceil(narraciones.length / 8), `Radios, altavoces y transmisiones: ${medios} (meta ≤ 1 cada 8)`)
linea((conteo[0]?.veces ?? 0) / totalMenciones <= 0.4, `NPC más presente: ${conteo[0]?.nombre ?? '-'} con ${pct(conteo[0]?.veces ?? 0, totalMenciones)} de las menciones (meta ≤ 40%)`)
console.log(`   NPC: ${conteo.filter((x) => x.veces).map((x) => `${x.nombre} ${x.veces}`).join(' · ')}`)
linea(true, `Elementos nuevos presentados: ${n.nuevos.length} (${n.nuevos.map((x) => x.que).join(', ') || '-'})`)
const abiertos = (mundo.hilos ?? []).filter((h) => h.estado === 'abierto')
linea(abiertos.length <= 4, `Hilos abiertos al final: ${abiertos.length} · cerrados: ${(mundo.hilos ?? []).filter((h) => h.estado !== 'abierto').length}`)
linea(true, `Hitos cumplidos: ${hitos.filter((h) => h.cumplido).length} de ${hitos.length}`)
linea(Math.max(...focos) - Math.min(...focos) <= 2, `Foco por jugador: ${jugadores.map((x) => `${x.nombre} ${x.foco}`).join(' · ')}`)
linea(true, `Arcos jugados: ${(mundo.arcos ?? []).map((a) => `P${a.pj} ${a.beats.filter((b) => b.estado === 'jugado').length}/3`).join(' · ')}`)

// Lectura en frío: alguien que no vio nada lee solo lo que se mostró.
const lector = await m.ctx.cerebro.texto({
  tarea: 'prueba', rol: 'util', partidaId: pid, json: true, maxSalida: 700,
  sistema: 'Leíste una historia de rol. Respondé SOLO JSON: {"objetivo":str,"antagonista":str,"que_quiere_el_antagonista":str,"personajes":[{"nombre":str,"que_le_paso":str}],"lo_mas_confuso":str}. Si algo no se entiende, decilo.',
  usuario: narraciones.map((x) => x.texto).join('\n\n'),
})
console.log('\n🧐 Lectura en frío (lo que entendió alguien que solo leyó las narraciones):')
console.log(lector)
console.log(`\n   Canon real → objetivo: ${mundo.misiones.find((x) => x.principal)?.texto ?? '-'} · antagonista: ${ants.map((a) => `${a.nombre} (quiere ${a.quiere ?? '?'})`).join(', ') || '-'}`)
console.log(`\n💸 Gasto total: ~US$ ${gasto.toFixed(4)}`)
