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
          sugerencias: { type: 'array', items: { type: 'string' }, description: 'Hasta 3 ideas cortas para el próximo jugador (se muestran solo si las pide)' },
          cambios: {
            type: 'object',
            description: 'Cambios propuestos; el motor los valida. Los ids de personaje son P1, P2... como figuran en el estado.',
            properties: {
              salud: { type: 'array', items: { type: 'object', properties: { pj: { type: 'string' }, delta: { type: 'integer' }, motivo: { type: 'string' } }, required: ['pj', 'delta'] } },
              objetos: { type: 'array', items: { type: 'object', properties: { pj: { type: 'string' }, item: { type: 'string', enum: itemIds }, nombre_libre: { type: 'string', description: 'Objeto que no está en el catálogo (una llave, una carta, un amuleto). Sin efecto de reglas.' }, delta: { type: 'integer' } }, required: ['pj', 'delta'] } },
              chapas: { type: 'array', items: { type: 'object', properties: { pj: { type: 'string' }, delta: { type: 'integer' }, motivo: { type: 'string' } }, required: ['pj', 'delta'] } },
              rads: { type: 'array', items: { type: 'object', properties: { pj: { type: 'string' }, delta: { type: 'integer' } }, required: ['pj', 'delta'] } },
              condiciones: { type: 'array', items: { type: 'object', properties: { pj: { type: 'string' }, condicion: { type: 'string' }, accion: { type: 'string', enum: ['poner', 'quitar'] } }, required: ['pj', 'condicion', 'accion'] } },
              relojes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, nombre: { type: 'string' }, delta: { type: 'integer' }, segmentos: { type: 'integer' } }, required: ['id', 'delta'] } },
              ubicacion: { type: 'string' },
              misiones: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, texto: { type: 'string' }, estado: { type: 'string', enum: ['activa', 'cumplida', 'fallida'] } }, required: ['id', 'texto'] } },
              npcs: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, nombre: { type: 'string' }, actitud: { type: 'string' }, nota: { type: 'string' }, estado: { type: 'string', enum: ['vivo', 'herido', 'muerto', 'huido'] } }, required: ['id', 'nombre'] } },
              muerte: {
                type: 'object',
                description: 'Muerte de un personaje FUERA de combate: la elige su propio jugador (elegida=true) o viene de una tirada fallida con riesgo mortal.',
                properties: { pj: { type: 'string' }, motivo: { type: 'string' }, elegida: { type: 'boolean' } },
                required: ['pj'],
              },
            },
          },
          combate: {
            type: 'object',
            description: 'Usalo SOLO si empieza un combate. Elegí enemigos del bestiario por ID.',
            properties: {
              enemigos: { type: 'array', items: { type: 'object', properties: { plantilla_id: { type: 'string', enum: enemigoIds }, cantidad: { type: 'integer' }, elite: { type: 'boolean' }, nombre: { type: 'string', description: 'Nombre propio si es un NPC de la historia (civil, guardia o jefe)' }, npc_id: { type: 'string' } }, required: ['plantilla_id'] } },
              sorpresa: { type: 'string', enum: ['jugadores', 'enemigos', 'ninguna'] },
            },
            required: ['enemigos'],
          },
          terminar_combate: { type: 'boolean', description: 'Solo en combate: true si esta acción libre lo termina (rendición aceptada, huida, tregua)' },
          cerrar_capitulo: { type: 'boolean', description: 'true si este turno cierra el capítulo (el arco del capítulo se resolvió)' },
          vinculos: { type: 'array', items: { type: 'string' }, description: 'SOLO en la apertura: un vínculo de una línea por cada par de personajes' },
        },
        required: ['narracion', 'cronica'],
      },
    },
  }
  return { pedirTirada, narrar }
}
