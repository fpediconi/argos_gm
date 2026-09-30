import type { Ctx } from '../ctx.js'
import { SIN_LIMITE, vencimiento } from '../motor/turnos.js'
import { esc, fechaCorta } from '../util.js'
import { mencion } from '../telegram/textos.js'
import { aGrupo, aPrivado, refrescarTablero } from './comun.js'
import { saltarTurno } from './turno.js'
import { cerrarVencidas } from './votos.js'

/**
 * Se ejecuta cada minuto. Todo el estado está en la base, así que un reinicio no pierde plazos.
 * Recordatorio al 50%, aviso al vencer y piloto automático por abandono.
 */
export async function tick(ctx: Ctx): Promise<void> {
  const ahora = ctx.reloj.ahora()

  for (const p of ctx.db.partidasEnJuego()) {
    await ctx.colas.correr(`p${p.id}`, async () => {
      const partida = ctx.db.partida(p.id)!
      if (partida.estado !== 'EN_JUEGO' || !partida.turno_jugador_id) return
      if (partida.paso.tipo === 'narrando') return
      const j = ctx.db.jugador(partida.turno_jugador_id)
      if (!j) return

      if (partida.turno_vence !== SIN_LIMITE) {
        const dur = partida.turno_vence - partida.turno_desde
        if (partida.recordado < 1 && ahora >= partida.turno_desde + dur / 2 && ahora < partida.turno_vence) {
          partida.recordado = 1
          ctx.db.guardarPartida(partida)
          await aPrivado(ctx, partida, j, `⏰ Recordatorio: te toca en «${esc(partida.guion?.titulo ?? 'la partida')}». Vence ${fechaCorta(partida.turno_vence, ctx.cfg.tzMin)}.`)
        }
        if (partida.recordado < 2 && ahora >= partida.turno_vence) {
          partida.recordado = 2
          ctx.db.guardarPartida(partida)
          await aGrupo(ctx, partida, `⌛ El turno de ${mencion(j)} venció. Cualquiera puede proponer saltearlo con /saltear (se vota), o esperarlo.`)
          await aPrivado(ctx, partida, j, '⌛ Tu turno venció. Si no vas a poder jugar, usá /pasar o /ausente 2d para que el grupo siga.')
        }
      }

      // Piloto automático por abandono.
      if (partida.config.plazoMaxH > 0) {
        const limite = vencimiento(partida.turno_desde, partida.config.plazoMaxH, partida.config.silencio, ctx.cfg.tzMin)
        if (ahora >= limite) {
          await aGrupo(ctx, partida, `🤖 Pasaron más de ${partida.config.plazoMaxH} h sin novedades de ${mencion(j)}: el DJ salta el turno automáticamente.`)
          await saltarTurno(ctx, partida.id, 'auto')
        }
      }
    })
  }

  await cerrarVencidas(ctx)

  for (const j of ctx.db.jugadoresConAusenciaVencida(ahora)) {
    const p = ctx.db.partida(j.partida_id)
    if (!p || p.estado === 'FINALIZADA') continue
    await ctx.colas.correr(`p${p.id}`, async () => {
      const jj = ctx.db.jugador(j.id)!
      if (jj.estado !== 'ausente') return
      jj.estado = 'activo'
      jj.ausente_hasta = 0
      ctx.db.guardarJugador(jj)
      await aPrivado(ctx, p, jj, '👋 Terminó tu ausencia: volvés a la partida. Usá /resumen para ponerte al día.')
      if (p.estado === 'PAUSADA') {
        p.estado = 'EN_JUEGO'
        p.turno_jugador_id = null
        ctx.db.guardarPartida(p)
        const { iniciarTurno } = await import('./turno.js')
        await iniciarTurno(ctx, p.id)
      } else await refrescarTablero(ctx, p.id)
    })
  }
}

/** Al arrancar: si el bot se cayó en medio de una narración, ofrece reintentar. */
export async function recuperar(ctx: Ctx): Promise<void> {
  for (const p of ctx.db.partidasEnJuego()) {
    if (p.paso.tipo === 'narrando') {
      await aGrupo(ctx, p, '🔌 Me reinicié en medio de un turno. Tu acción está guardada: tocá reintentar.', { teclado: [[{ text: '🔄 Reintentar', callback_data: `n:${p.id}:${p.turno_n}` }]] })
    }
  }
}
