import type { Mundo, Personaje } from './tipos.js'
import type { Cambios } from './estado.js'
import { buscarPj, claveJugador, esNpcMuerto } from './estado.js'
import { menciona, norm, npcPorRef } from './canon.js'

/**
 * Reconciliación: compara lo que la narración AFIRMA con lo que el motor APLICÓ (en un ensayo sobre copias).
 * - Si falta algo legítimo (una herida leve fuera de combate, un objeto narrativo, un NPC de paso), el estado sigue a la narración.
 * - Si falta algo que el motor no permite (una muerte sin tirada, un PJ que decide por otro, un muerto que habla), es GRAVE:
 *   la narración se repara antes de mostrarse.
 */

export type Afirmacion =
  | { tipo: 'dano' | 'cura' | 'muerte' | 'se_va' | 'actua_muerto'; quien: string }
  | { tipo: 'objeto'; quien: string; que: string; accion: 'gana' | 'pierde' }
  | { tipo: 'npc_nuevo'; nombre: string }
  | { tipo: 'decide_por_pj'; quien: string; texto: string }

export interface Ensayo {
  /** Estado ANTES de aplicar (originales). */
  antes: { mundo: Mundo; pjs: Personaje[] }
  /** Estado DESPUÉS de aplicar los cambios propuestos (copias). */
  despues: { mundo: Mundo; pjs: Personaje[] }
  /** PJ del turno (sus decisiones sí se pueden narrar). */
  actor?: Personaje
  enCombate: boolean
  /** Intento de matar que falló: el objetivo no puede morir este turno. */
  matarFallido?: string
  /** NPC nuevos que el motor no dio de alta por falta de presupuesto. */
  sinAlta: string[]
  /** ¿Se pueden presentar NPC nuevos ahora? */
  hayPresupuesto: boolean
  /** Muerte de PJ que el motor va a aplicar igual (veredicto). */
  muerteAplicada?: number
  /** Nombres de PJ muertos de antes (no pueden actuar). No incluye a los que se fueron ni a los que mueren este turno. */
  pjMuertos?: string[]
}

export interface Reconciliacion { aplicar: Cambios; graves: string[] }

const pjDe = (pjs: Personaje[], ref: string) => buscarPj(pjs, ref) ?? pjs.find((p) => menciona(ref, p.ficha.nombre))

export function reconciliar(afirmaciones: Afirmacion[], e: Ensayo): Reconciliacion {
  const aplicar: Cambios = {}
  const graves: string[] = []
  const add = <K extends keyof Cambios>(k: K, v: NonNullable<Cambios[K]> extends (infer T)[] ? T : never) => {
    const arr = ((aplicar[k] as unknown[] | undefined) ?? []) as unknown[]
    arr.push(v)
    ;(aplicar as Record<string, unknown>)[k] = arr
  }
  const muertosPj = new Set([...e.antes.pjs.filter((p) => !p.vivo).map((p) => p.ficha.nombre), ...(e.pjMuertos ?? [])].map(norm))

  for (const a of afirmaciones) {
    switch (a.tipo) {
      case 'dano': {
        const antes = pjDe(e.antes.pjs, a.quien)
        const despues = antes && e.despues.pjs.find((p) => p.id === antes.id)
        if (!antes || !despues || e.enCombate) break // en combate el daño viene de los botones
        if (despues.salud < antes.salud) break
        add('salud', { pj: claveJugador(antes), delta: -2, motivo: 'herida narrada' })
        break
      }
      case 'cura': {
        const antes = pjDe(e.antes.pjs, a.quien)
        const despues = antes && e.despues.pjs.find((p) => p.id === antes.id)
        if (!antes || !despues || e.enCombate || despues.salud > antes.salud) break
        add('salud', { pj: claveJugador(antes), delta: 2, motivo: 'cura narrada' })
        break
      }
      case 'muerte': {
        const pj = pjDe(e.antes.pjs, a.quien)
        if (pj) {
          const despues = e.despues.pjs.find((p) => p.id === pj.id)
          if (pj.vivo && despues?.vivo && e.muerteAplicada !== pj.id && !despues.condiciones.includes('caido')) {
            graves.push(`${pj.ficha.nombre} NO murió (el motor no lo aplicó): está vivo`)
          }
          break
        }
        const npc = npcPorRef(e.antes.mundo, a.quien) ?? e.antes.mundo.npcs.find((n) => menciona(a.quien, n.nombre))
        if (!npc || esNpcMuerto(e.despues.mundo, npc.nombre)) break
        if (e.matarFallido && (menciona(e.matarFallido, npc.nombre) || norm(e.matarFallido) === norm(npc.nombre))) {
          graves.push(`${npc.nombre} sobrevive: el intento de matarlo falló`)
          break
        }
        add('npcs', { id: npc.id, nombre: npc.nombre, estado: 'muerto' })
        break
      }
      case 'se_va': {
        const pj = pjDe(e.antes.pjs, a.quien)
        if (pj && pj.vivo && e.despues.pjs.find((p) => p.id === pj.id)?.vivo) graves.push(`${pj.ficha.nombre} sigue en el grupo: irse para siempre lo decide su jugador`)
        break
      }
      case 'actua_muerto': {
        const q = norm(String(a.quien ?? ''))
        if (muertosPj.has(q) || [...muertosPj].some((x) => x.split(' ')[0] === q || menciona(a.quien, x) || menciona(x, a.quien))) graves.push(`${a.quien} está muerto: no puede actuar ni hablar`)
        else if (esNpcMuerto(e.antes.mundo, a.quien) || (e.antes.mundo.muertos ?? []).some((m) => menciona(a.quien, m))) graves.push(`${a.quien} está muerto: no puede actuar ni hablar`)
        break
      }
      case 'objeto': {
        const pj = pjDe(e.antes.pjs, a.quien)
        const despues = pj && e.despues.pjs.find((p) => p.id === pj.id)
        if (!pj || !despues || !a.que) break
        const firma = (p: Personaje) => p.inventario.map((i) => `${i.id}:${i.n}`).join('|')
        if (firma(pj) !== firma(despues)) break // ya hubo un cambio de objetos: alcanza
        if (a.accion === 'gana') add('objetos', { pj: claveJugador(pj), nombre_libre: a.que.slice(0, 40), delta: 1 })
        else {
          const it = pj.inventario.find((i) => menciona(i.id.replace(/^libre:/, '').replace(/_/g, ' '), a.que) || menciona(a.que, i.id.replace(/^libre:/, '').replace(/_/g, ' ')))
          if (it) add('objetos', { pj: claveJugador(pj), ...(it.id.startsWith('libre:') ? { nombre_libre: it.id.slice(6) } : { item: it.id }), delta: -1 })
        }
        break
      }
      case 'npc_nuevo': {
        const nombre = String(a.nombre ?? '').trim()
        if (!nombre || nombre.length < 3) break
        const existe = e.despues.mundo.npcs.some((n) => menciona(nombre, n.nombre) || menciona(n.nombre, nombre)) || e.antes.pjs.some((p) => menciona(nombre, p.ficha.nombre))
        if (existe) break
        if (e.sinAlta.some((x) => norm(x) === norm(nombre)) || !e.hayPresupuesto) {
          graves.push(`no hay lugar para un personaje nuevo con nombre (${nombre}): usá a alguien que ya existe o dejalo sin nombre`)
          break
        }
        add('npcs', { id: nombre, nombre, presente: true })
        break
      }
      case 'decide_por_pj': {
        const pj = pjDe(e.antes.pjs, a.quien)
        if (pj && pj.vivo && pj.id !== e.actor?.id) graves.push(`decidiste por ${pj.ficha.nombre} ("${String(a.texto ?? '').slice(0, 80)}"): eso lo elige su jugador; mostrá la situación y dejale la decisión`)
        break
      }
    }
  }
  return { aplicar, graves: [...new Set(graves)] }
}

/** Junta dos conjuntos de cambios (los propuestos y los que agrega la reconciliación). */
export function sumarCambios(a: Cambios | undefined, b: Cambios): Cambios {
  const r: Cambios = { ...(a ?? {}) }
  for (const [k, v] of Object.entries(b)) {
    if (Array.isArray(v)) (r as Record<string, unknown>)[k] = [...(((r as Record<string, unknown>)[k] as unknown[]) ?? []), ...v]
  }
  return r
}
