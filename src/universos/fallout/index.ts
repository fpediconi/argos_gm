import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Universo } from '../../motor/tipos.js'

const dir = dirname(fileURLToPath(import.meta.url))

/** Carga un paquete de universo (datos + estilo). Agregar otro universo = otra carpeta igual. */
export function cargarUniverso(id = 'fallout'): Universo {
  const base = join(dir, '..', id)
  const datos = JSON.parse(readFileSync(join(base, 'universo.json'), 'utf8'))
  const estilo = readFileSync(join(base, 'estilo.md'), 'utf8')
  return { ...datos, estilo } as Universo
}
