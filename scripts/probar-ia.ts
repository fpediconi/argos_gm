// Prueba rápida de la conexión con OpenAI: `npm run probar-ia`
// Verifica la API key, que los 3 modelos del .env existan en tu cuenta y que el narrador sepa usar herramientas.
import { cargarConfig } from '../src/config.js'
import { CerebroOpenAI, costo } from '../src/dj/cerebro.js'
import { herramientasDe } from '../src/dj/herramientas.js'
import { cargarUniverso } from '../src/universos/fallout/index.js'

const cfg = cargarConfig()
if (!cfg.openaiKey) { console.error('❌ Falta OPENAI_API_KEY en el .env'); process.exit(1) }
const u = cargarUniverso('fallout')
let total = 0
const cerebro = new CerebroOpenAI(cfg, herramientasDe(u), ({ rol, modelo, uso, ok }) => {
  const usd = costo(uso, cfg.precios[rol])
  total += usd
  console.log(`   · ${rol} (${modelo}) ${ok ? 'ok' : 'ERROR'} — ${uso.tok_in} in / ${uso.tok_out} out — ~US$ ${usd.toFixed(5)} — ${uso.ms} ms`)
})

async function paso(nombre: string, fn: () => Promise<string>) {
  process.stdout.write(`▶ ${nombre}\n`)
  try { console.log('   ✅', (await fn()).replace(/\s+/g, ' ').slice(0, 160)) }
  catch (e) { console.error('   ❌', (e as Error).message); process.exitCode = 1 }
}

await paso('Modelo UTIL (texto simple)', () => cerebro.texto({ tarea: 'prueba', rol: 'util', partidaId: null, sistema: 'Respondé en una frase corta, en español rioplatense.', usuario: 'Decime hola como narrador de un juego de rol post-apocalíptico.', maxSalida: 200 }))
await paso('Modelo NARRADOR (herramienta narrar)', async () => {
  const d = await cerebro.decidir({
    tarea: 'prueba', rol: 'narrador', partidaId: null, forzarNarrar: true, maxSalida: cfg.maxSalidaNarrador,
    sistema: 'Sos el Director de Juego de una partida de Fallout. Narrás en español rioplatense, breve. Usá la herramienta narrar.',
    usuario: 'Jugadora Caro (P1): "Me asomo por la puerta del refugio". Narrá qué ve.',
  })
  if (d.tipo !== 'narrar') throw new Error('devolvió una tirada en vez de narrar')
  return d.salida.narracion
})
await paso('Modelo GUIONISTA (JSON)', () => cerebro.texto({ tarea: 'prueba', rol: 'guionista', partidaId: null, sistema: 'Devolvé solo JSON válido.', usuario: 'Devolvé {"ok":true,"idea":"una idea de aventura en una frase"}', maxSalida: 300, json: true }))
console.log(`\nGasto total de la prueba: ~US$ ${total.toFixed(5)}`)
