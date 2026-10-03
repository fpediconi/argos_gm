import type { Combate, EnemigoEnCombate, Personaje, Universo, TiradaResuelta, PedidoTirada } from './tipos.js'
import type { Rng } from './dados.js'
import { armaPrincipal, danioArma, defensaDe, proteccionDe, resolverPrueba, type Extra } from './reglas.js'
import { ATRIBUTOS } from './tipos.js'
import { contarExitos, tirarDados } from './dados.js'
import { barraVida, dadosTexto } from '../util.js'
import { esCaido, saludMaxEfectiva, quitarItem, tieneItem } from './personaje.js'

export const MAX_ENEMIGOS = 6

export interface PedidoEnemigos {
  plantilla_id: string; cantidad?: number; elite?: boolean
  /** Nombre propio (un NPC de la historia que pelea). Implica cantidad 1. */
  nombre?: string
  /** id del NPC en mundo.npcs: si muere en combate queda muerto en la historia. */
  npc_id?: string
}

export function crearCombate(u: Universo, pedidos: PedidoEnemigos[], sorpresa: Combate['sorpresa']): Combate | null {
  const enemigos: EnemigoEnCombate[] = []
  const contador = new Map<string, number>()
  for (const p of pedidos) {
    const def = u.bestiario.find((b) => b.id === p.plantilla_id)
    if (!def) continue
    const propio = typeof p.nombre === 'string' && p.nombre.trim() ? p.nombre.trim().slice(0, 40) : ''
    const cant = propio ? 1 : Math.max(1, Math.min(4, Math.floor(p.cantidad ?? 1)))
    for (let i = 0; i < cant && enemigos.length < MAX_ENEMIGOS; i++) {
      const n = (contador.get(def.id) ?? 0) + 1
      contador.set(def.id, n)
      const salud = p.elite ? Math.ceil(def.salud * 1.5) : def.salud
      enemigos.push({
        uid: `e${enemigos.length + 1}`,
        plantilla: def.id,
        nombre: propio || `${p.elite ? 'Élite: ' : ''}${def.nombre}${cant > 1 || n > 1 ? ' ' + n : ''}`,
        salud,
        salud_max: salud,
        tn: def.tn,
        danio: def.danio + (p.elite ? 1 : 0),
        prot: def.prot,
        ...(propio ? { npc: (p.npc_id ? String(p.npc_id) : propio).slice(0, 40) } : {}),
      })
    }
  }
  if (enemigos.length === 0) return null
  return { ronda: 1, enemigos, orden: [], log: [], sorpresa }
}

export function vivos(c: Combate): EnemigoEnCombate[] {
  return c.enemigos.filter((e) => e.salud > 0)
}

export function danioAJugador(p: Personaje, cant: number): boolean {
  p.salud = Math.max(0, p.salud - cant)
  if (p.salud <= 0 && !esCaido(p)) {
    p.condiciones.push('caido')
    return true
  }
  return false
}

export interface ResultadoAtaque {
  tirada: TiradaResuelta
  linea: string
  danio: number
  muertos: string[]
  complicacion: boolean
}

/** Ataque de un jugador. Determinista salvo por los dados: daño = arma + impulso - protección (mínimo 1). */
export function ataqueJugador(u: Universo, p: Personaje, c: Combate, objetivoUid: string | null, extra: Extra, rng: Rng): ResultadoAtaque {
  const arma = armaPrincipal(p, u)
  const hab = u.habilidades.find((h) => h.id === arma.habilidad)!
  const pedido: PedidoTirada = { atributo: hab.attr, habilidad: hab.id, dificultad: 1, motivo: `Ataque con ${arma.nombre}` }
  const tirada = resolverPrueba(p, pedido, extra, rng)
  const nombre = p.ficha.nombre
  const objetivos = arma.area ? vivos(c) : [vivos(c).find((e) => e.uid === objetivoUid) ?? vivos(c)[0]].filter(Boolean)
  const muertos: string[] = []
  let danioTotal = 0
  const blanco = arma.area ? 'a todos' : `a ${objetivos[0]?.nombre ?? 'nadie'}`
  const dados = dadosTexto(tirada.dados, tirada.tn)
  if (!tirada.exito) {
    const linea = `🔫 <b>${nombre}</b> ataca ${blanco} con ${arma.nombre}\n${dados} → ❌ <b>Falla</b>${tirada.complicaciones ? ' ⚠️ ¡y algo sale mal!' : ''}`
    return { tirada, linea, danio: 0, muertos, complicacion: tirada.complicaciones > 0 }
  }
  const partes: string[] = []
  for (const e of objetivos) {
    const prot = Math.max(0, e.prot - (arma.perfora ?? 0))
    const d = Math.max(1, danioArma(p, u, arma) + tirada.impulso - prot)
    e.salud = Math.max(0, e.salud - d)
    danioTotal += d
    partes.push(e.salud <= 0 ? `💀 ${e.nombre} cae (−${d})` : `${e.nombre} −${d} ❤️ ${barraVida(e.salud, e.salud_max)} ${e.salud}/${e.salud_max}`)
    if (e.salud <= 0) muertos.push(e.nombre)
  }
  const linea = `🔫 <b>${nombre}</b> ataca ${blanco} con ${arma.nombre}\n${dados} → ✅ <b>Acierta</b>: ${partes.join(' · ')}${tirada.complicaciones ? ' ⚠️ ¡pero algo sale mal!' : ''}`
  return { tirada, linea, danio: danioTotal, muertos, complicacion: tirada.complicaciones > 0 }
}

/** Fase de los enemigos: cada uno ataca a un jugador en pie al azar. */
export function turnoEnemigos(u: Universo, personajes: Personaje[], c: Combate, rng: Rng): string[] {
  const lineas: string[] = []
  for (const e of vivos(c)) {
    const blancos = personajes.filter((p) => p.vivo && !esCaido(p))
    if (blancos.length === 0) break
    const p = blancos[Math.floor(rng() % blancos.length)]
    const dados = tirarDados(2, rng)
    const r = contarExitos(dados, e.tn, 0, false)
    const def = defensaDe(p, u)
    if (r.exitos >= def) {
      const impulso = r.exitos - def
      const prot = proteccionDe(p, u)
      const d = Math.max(1, e.danio + impulso - prot)
      const cayo = danioAJugador(p, d)
      lineas.push(`💥 ${e.nombre} le pega a <b>${p.ficha.nombre}</b>: −${d} ❤️ ${barraVida(p.salud, saludMaxEfectiva(p))} ${p.salud}/${saludMaxEfectiva(p)}${cayo ? ' 🩸 <b>¡queda caído!</b>' : ''}`)
    } else {
      lineas.push(`🛡️ ${e.nombre} ataca a ${p.ficha.nombre} y no le acierta.`)
    }
  }
  for (const p of personajes) p.cubierto = false
  return lineas
}

/** Usar un consumible de curación sobre uno mismo o un aliado. */
export function usarObjeto(u: Universo, usuario: Personaje, objetivo: Personaje, itemId: string): string | null {
  const o = u.objetos.find((x) => x.id === itemId)
  if (!o || !tieneItem(usuario, itemId)) return null
  if (o.efecto === 'cura') {
    quitarItem(usuario, itemId)
    const antes = objetivo.salud
    objetivo.salud = Math.min(saludMaxEfectiva(objetivo), objetivo.salud + o.valor)
    if (objetivo.salud > 0) objetivo.condiciones = objetivo.condiciones.filter((c) => c !== 'caido')
    return `🩹 ${usuario.ficha.nombre} usa ${o.nombre}${objetivo === usuario ? '' : ' sobre ' + objetivo.ficha.nombre}: +${objetivo.salud - antes} salud (${objetivo.salud}/${saludMaxEfectiva(objetivo)})`
  }
  if (o.efecto === 'rads') {
    quitarItem(usuario, itemId)
    const antes = objetivo.rads
    objetivo.rads = Math.max(0, objetivo.rads - o.valor)
    return `💊 ${usuario.ficha.nombre} usa ${o.nombre}: rads ${antes} → ${objetivo.rads}`
  }
  return null
}

/** Levantar a un aliado caído: Inteligencia + Medicina (o Reparación si es robot), dificultad 2. */
export function levantarAliado(u: Universo, actor: Personaje, caido: Personaje, rng: Rng): { linea: string; exito: boolean } {
  const robot = u.origenes.find((o) => o.id === caido.ficha.origen)?.robot
  const hab = robot ? 'reparacion' : 'medicina'
  const pedido: PedidoTirada = { atributo: 'INT', habilidad: hab, dificultad: 2, motivo: 'Levantar a un aliado caído' }
  const t = resolverPrueba(actor, pedido, 'ninguno', rng)
  if (t.exito) {
    caido.condiciones = caido.condiciones.filter((c) => c !== 'caido')
    caido.salud = 1
    return { linea: `🤝 ${actor.ficha.nombre} levanta a ${caido.ficha.nombre} (${t.exitos} éxitos ✅). Vuelve con 1 de salud.`, exito: true }
  }
  return { linea: `🤝 ${actor.ficha.nombre} intenta levantar a ${caido.ficha.nombre} pero no lo logra (${t.exitos} éxito${t.exitos === 1 ? '' : 's'} ❌).`, exito: false }
}

/** Fin de combate: qué pasa con los caídos según la letalidad. */
export function resolverCaidos(
  personajes: Personaje[],
  letalidad: 'suave' | 'normal' | 'hardcore',
  rng: Rng,
  /** Los que esquivaron la muerte gastando toda su Suerte (pueden elegir morir igual). */
  salvados: Personaje[] = [],
): string[] {
  const lineas: string[] = []
  for (const p of personajes) {
    if (!p.vivo || !esCaido(p)) continue
    const n = p.ficha.nombre
    const quitarCaido = () => { p.condiciones = p.condiciones.filter((c) => c !== 'caido') }
    if (letalidad === 'hardcore') {
      p.vivo = false
      lineas.push(`☠️ ${n} no sobrevivió.`)
    } else if (letalidad === 'suave') {
      quitarCaido()
      p.salud = 1
      p.penal_salud = Math.min(3, p.penal_salud + 1)
      lineas.push(`🩹 ${n} se recupera con secuelas (salud máxima −1 hasta el próximo capítulo).`)
    } else {
      // Normal: prueba de Suerte, dificultad 1.
      const dado = tirarDados(2, rng)
      const r = contarExitos(dado, p.ficha.atributos.SUE, 0, false)
      if (r.exitos >= 1) {
        quitarCaido()
        p.salud = 1
        p.penal_salud = Math.min(3, p.penal_salud + 1)
        lineas.push(`🍀 ${n} se salva por poco (Suerte ${dado.join('·')}): queda magullado (salud máxima −1 hasta el próximo capítulo).`)
      } else if (p.suerte > 0) {
        // Última oportunidad: gasta toda su Suerte y vive, con una cicatriz para siempre.
        quitarCaido()
        p.salud = 1
        p.suerte = 0
        const c = cicatriz(p, rng)
        lineas.push(`🍀 ${n} tendría que haber muerto (Suerte ${dado.join('·')}), pero se aferra a la vida gastando toda su Suerte. Le queda una cicatriz: ${c}.`)
        salvados.push(p)
      } else {
        // Letalidad Normal: si falla la Suerte y no le queda Suerte para gastar, muere.
        p.vivo = false
        lineas.push(`☠️ ${n} no lo logró (Suerte ${dado.join('·')}). Murió.`)
      }
    }
  }
  return lineas
}

const CICATRICES: Record<string, string> = {
  FUE: 'un brazo que ya no responde igual', PER: 'un ojo nublado', RES: 'los pulmones quemados', CAR: 'la cara marcada',
  INT: 'lagunas en la memoria', AGI: 'una rodilla destrozada', SUE: 'la sensación de que la muerte le debe una',
}

/** Marca permanente de haber esquivado la muerte: −1 a un atributo (mínimo 4). */
export function cicatriz(p: Personaje, rng: Rng): string {
  const opciones = ATRIBUTOS.filter((a) => p.ficha.atributos[a] > 4)
  const a = opciones.length ? opciones[(rng() - 1) % opciones.length] : 'SUE'
  if (p.ficha.atributos[a] > 4) p.ficha.atributos[a]--
  const texto = `${CICATRICES[a]} (−1 ${a})`
  p.ficha.cicatrices = [...(p.ficha.cicatrices ?? []), texto]
  return texto
}

/**
 * Golpe creativo (acción libre en combate: "le parto el cráneo con la llave inglesa").
 * La tirada ya la resolvió el jugador con la dificultad que puso el DJ; más difícil, más daño si sale.
 */
export function golpeCreativo(
  u: Universo, p: Personaje, tirada: TiradaResuelta,
  blanco: { tipo: 'enemigo'; e: EnemigoEnCombate } | { tipo: 'pj'; pj: Personaje },
): ResultadoAtaque {
  const arma = armaPrincipal(p, u)
  const pedido = tirada.pedido
  const nombreBlanco = blanco.tipo === 'enemigo' ? blanco.e.nombre : blanco.pj.ficha.nombre
  const muertos: string[] = []
  if (!tirada.exito) {
    return { tirada, linea: `💬 ${p.ficha.nombre} intenta ${pedido.motivo.toLowerCase()} contra ${nombreBlanco}: ❌ no sale${tirada.complicaciones ? ' ⚠️ ¡y algo sale mal!' : ''}`, danio: 0, muertos, complicacion: tirada.complicaciones > 0 }
  }
  const base = danioArma(p, u, arma) + tirada.impulso + (pedido.dificultad - 1) * 2
  let d: number
  let parte: string
  if (blanco.tipo === 'enemigo') {
    const e = blanco.e
    d = Math.max(1, base - Math.max(0, e.prot - (arma.perfora ?? 0)))
    e.salud = Math.max(0, e.salud - d)
    if (e.salud <= 0) muertos.push(e.nombre)
    parte = e.salud <= 0 ? `💀 ${nombreBlanco} cae (−${d})` : `${nombreBlanco} −${d} ❤️ ${barraVida(e.salud, e.salud_max)} ${e.salud}/${e.salud_max}`
  } else {
    const q = blanco.pj
    d = Math.max(1, base - proteccionDe(q, u))
    const cayo = danioAJugador(q, d)
    parte = `${nombreBlanco} −${d} ❤️ ${barraVida(q.salud, saludMaxEfectiva(q))} ${q.salud}/${saludMaxEfectiva(q)}${cayo ? ' 🩸 ¡queda caído!' : ''}`
  }
  return { tirada, linea: `💬 ${p.ficha.nombre}: ${pedido.motivo} → ✅ ${parte}${tirada.complicaciones ? ' ⚠️ ¡pero algo sale mal!' : ''}`, danio: d, muertos, complicacion: tirada.complicaciones > 0 }
}
