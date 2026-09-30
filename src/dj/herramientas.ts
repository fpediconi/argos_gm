import type { Universo } from '../motor/tipos.js'
import { ATRIBUTOS } from '../motor/tipos.js'

/** Esquemas de function calling. Se generan desde el universo para que los IDs válidos viajen como enum. */
export function herramientasDe(u: Universo) {
  const habIds = u.habilidades.map((h) => h.id)
  const itemIds = [...u.objetos.map((o) => o.id), ...u.armas.map((a) => a.id)]
  const enemigoIds = u.bestiario.map((b) => b.id)

  const pedirTirada = {
    type: 'function',
    function: {
      name: 'pedir_tirada',
      description: 'Pedí una prueba cuando la acción tenga riesgo o incertidumbre real. El motor tira los dados; vos narrás después.',
      parameters: {
        type: 'object',
        properties: {
          atributo: { type: 'string', enum: ATRIBUTOS },
          habilidad: { type: 'string', enum: habIds },
          dificultad: { type: 'integer', enum: [1, 2, 3, 4], description: '1 normal, 2 difícil, 3 muy difícil, 4 épico' },
          motivo: { type: 'string', description: 'Qué se está intentando, en una frase corta' },
          preambulo: { type: 'string', description: 'Una o dos frases de tensión antes de tirar (máx 40 palabras). No resuelvas el resultado.' },
        },
        required: ['atributo', 'habilidad', 'dificultad', 'motivo', 'preambulo'],
      },
    },
  }

  const narrar = {
    type: 'function',
    function: {
      name: 'narrar',
      description: 'Narración final del turno, con los cambios de estado que propones. Es la única forma de cerrar un turno.',
      parameters: {
        type: 'object',
        properties: {
          narracion: { type: 'string', description: 'Máximo 120 palabras. Termina con una situación abierta.' },
          cronica: { type: 'string', description: 'Resumen del turno en máximo 20 palabras, tercera persona.' },
          sugerencias: { type: 'array', items: { type: 'string' }, description: 'Hasta 3 ideas cortas para el próximo jugador' },
          cambios: {
            type: 'object',
            description: 'Cambios propuestos; el motor los valida. Los ids de personaje son P1, P2... como figuran en el estado.',
            properties: {
              salud: { type: 'array', items: { type: 'object', properties: { pj: { type: 'string' }, delta: { type: 'integer' }, motivo: { type: 'string' } }, required: ['pj', 'delta'] } },
              objetos: { type: 'array', items: { type: 'object', properties: { pj: { type: 'string' }, item: { type: 'string', enum: itemIds }, delta: { type: 'integer' } }, required: ['pj', 'item', 'delta'] } },
              chapas: { type: 'array', items: { type: 'object', properties: { pj: { type: 'string' }, delta: { type: 'integer' }, motivo: { type: 'string' } }, required: ['pj', 'delta'] } },
              rads: { type: 'array', items: { type: 'object', properties: { pj: { type: 'string' }, delta: { type: 'integer' } }, required: ['pj', 'delta'] } },
              condiciones: { type: 'array', items: { type: 'object', properties: { pj: { type: 'string' }, condicion: { type: 'string' }, accion: { type: 'string', enum: ['poner', 'quitar'] } }, required: ['pj', 'condicion', 'accion'] } },
              relojes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, nombre: { type: 'string' }, delta: { type: 'integer' }, segmentos: { type: 'integer' } }, required: ['id', 'delta'] } },
              ubicacion: { type: 'string' },
              misiones: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, texto: { type: 'string' }, estado: { type: 'string', enum: ['activa', 'cumplida', 'fallida'] } }, required: ['id', 'texto'] } },
              npcs: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, nombre: { type: 'string' }, actitud: { type: 'string' }, nota: { type: 'string' } }, required: ['id', 'nombre'] } },
            },
          },
          combate: {
            type: 'object',
            description: 'Usalo SOLO si empieza un combate. Elegí enemigos del bestiario por ID.',
            properties: {
              enemigos: { type: 'array', items: { type: 'object', properties: { plantilla_id: { type: 'string', enum: enemigoIds }, cantidad: { type: 'integer' }, elite: { type: 'boolean' } }, required: ['plantilla_id'] } },
              sorpresa: { type: 'string', enum: ['jugadores', 'enemigos', 'ninguna'] },
            },
            required: ['enemigos'],
          },
          cerrar_capitulo: { type: 'boolean', description: 'true si este turno cierra el capítulo (el arco del capítulo se resolvió)' },
          vinculos: { type: 'array', items: { type: 'string' }, description: 'SOLO en la apertura: un vínculo de una línea por cada par de personajes' },
        },
        required: ['narracion', 'cronica'],
      },
    },
  }
  return { pedirTirada, narrar }
}
