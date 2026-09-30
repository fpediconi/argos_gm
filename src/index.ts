import { createServer } from 'node:http'
import { cargarConfig } from './config.js'
import { abrirDb } from './db/db.js'
import { Repos } from './db/repos.js'
import { cargarUniverso } from './universos/fallout/index.js'
import { TelegramReal } from './telegram/api.js'
import { CerebroOpenAI, costo } from './dj/cerebro.js'
import { herramientasDe } from './dj/herramientas.js'
import { rngReal } from './motor/dados.js'
import { Colas } from './util.js'
import { COMANDOS, procesarUpdate } from './telegram/router.js'
import { recuperar, tick } from './juego/planificador.js'
import type { Ctx } from './ctx.js'

async function main() {
  const cfg = cargarConfig()
  if (!cfg.telegramToken) throw new Error('Falta TELEGRAM_TOKEN en el .env')
  if (!cfg.openaiKey) console.warn('⚠️ Falta OPENAI_API_KEY: el bot arranca pero el DJ no va a poder narrar.')

  const db = new Repos(abrirDb(cfg.dbPath))
  const u = cargarUniverso('fallout')
  const api = new TelegramReal(cfg.telegramToken)
  const reloj = { ahora: () => Date.now() }
  const h = herramientasDe(u)
  const cerebro = new CerebroOpenAI(cfg, h, ({ partidaId, rol, modelo, uso, ok }) => {
    const usd = costo(uso, cfg.precios[rol])
    db.registrarLlamada({ partida_id: partidaId, rol, modelo, tok_in: uso.tok_in, tok_cache: uso.tok_cache, tok_out: uso.tok_out, usd, ms: uso.ms, ok }, reloj.ahora())
  })

  await api.quitarWebhook().catch(() => undefined)
  const yo = await api.getMe()
  await api.setComandos(COMANDOS).catch((e) => console.warn('setComandos:', e))

  const ctx: Ctx = {
    cfg, db, api, cerebro, reloj, rng: rngReal, u, colas: new Colas(),
    botUsername: yo.username ?? '', botId: yo.id,
    log: (...a) => console.log(new Date().toISOString(), ...a),
  }
  ctx.log(`Argos DJ arriba como @${ctx.botUsername} | narrador=${cfg.modelos.narrador} util=${cfg.modelos.util}`)

  const salud = createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, bot: ctx.botUsername })) }
    else { res.writeHead(404); res.end() }
  })
  salud.listen(cfg.puerto, '127.0.0.1')

  await recuperar(ctx).catch((e) => ctx.log('recuperar:', e))
  const timer = setInterval(() => { tick(ctx).catch((e) => ctx.log('tick:', e)) }, 60_000)

  let parar = false
  const cerrar = () => { parar = true; clearInterval(timer); salud.close(); ctx.log('Apagando…'); setTimeout(() => process.exit(0), 1500) }
  process.on('SIGTERM', cerrar)
  process.on('SIGINT', cerrar)

  let offset = 0
  while (!parar) {
    try {
      const ups = await api.getUpdates(offset, 30)
      for (const up of ups) {
        offset = up.update_id + 1
        procesarUpdate(ctx, up).catch((e) => ctx.log('update', up.update_id, e))
      }
    } catch (e) {
      ctx.log('getUpdates:', (e as Error).message)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
