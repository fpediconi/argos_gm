import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { CerebroOpenAI } from '../src/dj/cerebro.js'
import { herramientasDe } from '../src/dj/herramientas.js'
import { cargarUniverso } from '../src/universos/fallout/index.js'
import { cfgPrueba } from '../scripts/harness.js'

/** Servidor falso de OpenAI: anota lo que recibe y contesta según la ruta. */
async function servidor(responder: (ruta: string, body: any) => { status: number; json: unknown }) {
  const pedidos: { ruta: string; body: any }[] = []
  const srv = createServer((req, res) => {
    let d = ''
    req.on('data', (c) => (d += c))
    req.on('end', () => {
      const body = JSON.parse(d)
      pedidos.push({ ruta: req.url!, body })
      const r = responder(req.url!, body)
      res.writeHead(r.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(r.json))
    })
  })
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok))
  const port = (srv.address() as { port: number }).port
  return { pedidos, base: `http://127.0.0.1:${port}`, cerrar: () => srv.close() }
}

const u = cargarUniverso('fallout')
const narrarResp = { output: [{ type: 'reasoning' }, { type: 'function_call', name: 'narrar', call_id: 'c1', arguments: JSON.stringify({ hechos: ['Pasó algo'], narracion: 'Pasa algo.' }) }], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 200 } } }
const narrarChat = { choices: [{ message: { tool_calls: [{ function: { name: 'narrar', arguments: JSON.stringify({ hechos: ['x'], narracion: 'Por chat.' }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }

test('openai: por defecto va por /responses, razona con herramientas y suma margen de salida', async () => {
  const s = await servidor(() => ({ status: 200, json: narrarResp }))
  const usos: number[] = []
  const c = new CerebroOpenAI({ ...cfgPrueba, openaiBase: s.base, api: 'responses', reasoningNarrador: 'low', modelos: { narrador: 'gpt-5.4-mini', util: 'gpt-5.4-nano', guionista: 'gpt-5.4-mini' } }, herramientasDe(u), ({ uso }) => usos.push(uso.tok_razon ?? 0), () => {})
  const d = await c.decidir({ tarea: 'turno', rol: 'narrador', partidaId: 1, sistema: 'S', usuario: 'U', forzarNarrar: true, maxSalida: 1500 })
  s.cerrar()
  assert.equal(d.tipo, 'narrar')
  assert.equal(s.pedidos[0].ruta, '/responses')
  assert.deepEqual(s.pedidos[0].body.reasoning, { effort: 'low' })
  assert.equal(s.pedidos[0].body.max_output_tokens, 3500)
  assert.deepEqual(s.pedidos[0].body.tool_choice, { type: 'function', name: 'narrar' })
  assert.deepEqual(usos, [200])
  assert.equal(c.modoActivo(), '/responses')
})

test('openai: si /responses no anda, cae solo a /chat/completions y el turno sigue', async () => {
  const s = await servidor((ruta) => (ruta === '/responses' ? { status: 400, json: { error: { message: 'unsupported' } } } : { status: 200, json: narrarChat }))
  const c = new CerebroOpenAI({ ...cfgPrueba, openaiBase: s.base, api: 'responses', modelos: { narrador: 'gpt-5.4-mini', util: 'm', guionista: 'm' } }, herramientasDe(u), () => {}, () => {})
  const d = await c.decidir({ tarea: 'turno', rol: 'narrador', partidaId: 1, sistema: 'S', usuario: 'U', forzarNarrar: true, maxSalida: 900 })
  const d2 = await c.decidir({ tarea: 'turno', rol: 'narrador', partidaId: 1, sistema: 'S', usuario: 'U', forzarNarrar: true, maxSalida: 900 })
  s.cerrar()
  assert.equal(d.tipo === 'narrar' && d.salida.narracion, 'Por chat.')
  assert.equal(d2.tipo, 'narrar')
  assert.deepEqual(s.pedidos.map((p) => p.ruta), ['/responses', '/chat/completions', '/chat/completions'])
  assert.match(c.modoActivo(), /cayó/)
})
