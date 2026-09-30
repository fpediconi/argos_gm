import type { Ctx } from '../ctx.js'
import type { AtribId, Creacion, Ficha, Personaje } from '../motor/tipos.js'
import { ATRIBUTOS } from '../motor/tipos.js'
import type { Teclado } from './api.js'
import { puntosAtributoLibres, puntosHabilidadLibres } from '../motor/personaje.js'
import { esCaido } from '../motor/personaje.js'
import type { Combate } from '../motor/tipos.js'
import { vivos } from '../motor/combate.js'

const noop = 'x:0'

export function tecladoOrigenes(ctx: Ctx): Teclado {
  const filas: Teclado = []
  for (let i = 0; i < ctx.u.origenes.length; i += 2) {
    filas.push(ctx.u.origenes.slice(i, i + 2).map((o) => ({ text: `${o.emoji} ${o.nombre}`, callback_data: `c:or:${o.id}` })))
  }
  return filas
}

export function tecladoArquetipos(ctx: Ctx): Teclado {
  const filas: Teclado = []
  for (let i = 0; i < ctx.u.arquetipos.length; i += 2) {
    filas.push(ctx.u.arquetipos.slice(i, i + 2).map((a) => ({ text: `${a.emoji} ${a.nombre}`, callback_data: `c:aq:${a.id}` })))
  }
  filas.push([{ text: '🛠️ Armarlo a mano', callback_data: 'c:aq:manual' }])
  return filas
}

export function tecladoAtributos(b: Creacion['borrador']): Teclado {
  const attrs = b.atributos as Record<AtribId, number>
  const filas: Teclado = ATRIBUTOS.map((a) => [
    { text: `${a}  ${attrs[a]}`, callback_data: noop },
    { text: '−', callback_data: `c:at:${a}:-` },
    { text: '+', callback_data: `c:at:${a}:+` },
  ])
  const libres = puntosAtributoLibres(attrs)
  filas.push([{ text: libres === 0 ? '✅ Listo' : `Faltan ${libres} puntos`, callback_data: libres === 0 ? 'c:at:ok' : noop }])
  return filas
}

export function tecladoHabilidades(ctx: Ctx, b: Creacion['borrador'], grupo: string): Teclado {
  const hab = b.habilidades as Record<string, number>
  const esp = b.especialidades as string[]
  const filas: Teclado = ctx.u.habilidades
    .filter((h) => h.grupo === grupo)
    .map((h) => [
      { text: `${esp.includes(h.id) ? '⭐' : ''}${h.corto} ${hab[h.id] ?? 0}`, callback_data: noop },
      { text: '−', callback_data: `c:hb:${h.id}:-` },
      { text: '+', callback_data: `c:hb:${h.id}:+` },
      { text: esp.includes(h.id) ? '★' : '☆', callback_data: `c:hb:${h.id}:e` },
    ])
  filas.push(ctx.u.grupos.map((g) => ({ text: g.id === grupo ? `• ${g.nombre.split(' ')[0]} •` : g.nombre.split(' ')[0], callback_data: `c:hg:${g.id}` })))
  const libres = puntosHabilidadLibres(hab, esp)
  const ok = libres === 0 && esp.length === 3
  filas.push([{ text: ok ? '✅ Listo' : `Puntos: ${libres} · Especialidades: ${esp.length}/3`, callback_data: ok ? 'c:hb:ok' : noop }])
  return filas
}

export function tecladoArmas(ctx: Ctx, f: Partial<Ficha>): Teclado {
  const armas = ['pistola_10mm', 'rifle_caza', 'escopeta', 'bate_clavos', 'rifle_laser', 'cuchillos_arroj']
  const filas: Teclado = []
  const lista = armas.map((id) => ctx.u.armas.find((a) => a.id === id)!).filter(Boolean)
  for (let i = 0; i < lista.length; i += 2) {
    filas.push(lista.slice(i, i + 2).map((a) => ({ text: `${a.nombre} (${a.danio})`, callback_data: `c:ar:${a.id}` })))
  }
  void f
  return filas
}

export function tecladoInfo(pid: number): Teclado {
  return [[
    { text: '📜 Mi ficha', callback_data: `i:${pid}:ficha` },
    { text: '🗺️ Dónde estoy', callback_data: `i:${pid}:donde` },
  ], [
    { text: '📻 Resumen', callback_data: `i:${pid}:resumen` },
    { text: '🎒 Inventario', callback_data: `i:${pid}:inv` },
  ]]
}

export function tecladoTiradaBotones(pid: number, turnoN: number, pj: Personaje, impulso: number): Teclado {
  const fila = [{ text: '🎲 Tirar', callback_data: `r:${pid}:${turnoN}:n` }]
  const f2: Teclado[number] = []
  if (pj.suerte > 0) f2.push({ text: `🍀 +1d20 (Suerte ${pj.suerte})`, callback_data: `r:${pid}:${turnoN}:s` })
  if (impulso > 0) f2.push({ text: `⚡ +1d20 (Impulso ${impulso})`, callback_data: `r:${pid}:${turnoN}:i` })
  return f2.length ? [fila, f2] : [fila]
}

export function tecladoCombate(pid: number, turnoN: number, c: Combate, aliadosCaidos: boolean, tieneConsumibles: boolean): Teclado {
  const f1 = [
    { text: '🔫 Atacar', callback_data: `a:${pid}:${turnoN}:at` },
    { text: '🛡️ Cubrirse', callback_data: `a:${pid}:${turnoN}:cu` },
  ]
  const f2: Teclado[number] = []
  if (tieneConsumibles) f2.push({ text: '🩹 Usar objeto', callback_data: `a:${pid}:${turnoN}:ob` })
  if (aliadosCaidos) f2.push({ text: '🤝 Levantar aliado', callback_data: `a:${pid}:${turnoN}:lv` })
  f2.push({ text: '💬 Acción libre', callback_data: `a:${pid}:${turnoN}:li` })
  void c
  return [f1, f2]
}

export function tecladoObjetivos(pid: number, turnoN: number, c: Combate): Teclado {
  return vivos(c).map((e) => [{ text: `👹 ${e.nombre} (${e.salud}/${e.salud_max})`, callback_data: `t:${pid}:${turnoN}:${e.uid}` }])
}

export function tecladoAliadosCaidos(pid: number, turnoN: number, pjs: Personaje[], yo: Personaje): Teclado {
  return pjs.filter((p) => p.vivo && esCaido(p) && p.id !== yo.id).map((p) => [{ text: `🩸 ${p.ficha.nombre}`, callback_data: `l:${pid}:${turnoN}:${p.id}` }])
}

export function tecladoVoto(vid: number): Teclado {
  return [[{ text: '✅ Saltear', callback_data: `v:${vid}:s` }, { text: '⏳ Esperar', callback_data: `v:${vid}:e` }]]
}

export function tecladoMejora(ctx: Ctx, capitulo: number): Teclado {
  const f: Teclado = ctx.u.grupos.map((g) => [{ text: `⬆️ Habilidad de ${g.nombre.toLowerCase()}`, callback_data: `m:g:${g.id}` }])
  if (capitulo % 2 === 0) f.push([{ text: '⬆️ Un atributo', callback_data: 'm:a' }])
  return f
}
