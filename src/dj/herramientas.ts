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

  const pj = { type: 'string', description: 'P1, P2... como figuran en MESA' }
  const narrar = {
    type: 'function',
    function: {
      name: 'narrar',
      description: 'Cierra el turno. Primero decidí QUÉ CAMBIA (cambios, escena, hilos, hitos, hechos) y recién después escribí la narración, coherente con eso. El motor valida todo y puede rechazarlo.',
      parameters: {
        type: 'object',
        properties: {
          cambios: {
            type: 'object',
            description: 'Cambios de estado propuestos; el motor los valida. Si la narración dice que alguien se lastima, gana o pierde algo, o muere, TIENE que estar acá.',
            properties: {
              salud: { type: 'array', items: { type: 'object', properties: { pj, delta: { type: 'integer' }, motivo: { type: 'string' } }, required: ['pj', 'delta'] } },
              objetos: { type: 'array', items: { type: 'object', properties: { pj, item: { type: 'string', enum: itemIds }, nombre_libre: { type: 'string', description: 'Objeto que no está en el catálogo (una llave, una carta, un amuleto). Sin efecto de reglas.' }, delta: { type: 'integer' } }, required: ['pj', 'delta'] } },
              chapas: { type: 'array', items: { type: 'object', properties: { pj, delta: { type: 'integer' }, motivo: { type: 'string' } }, required: ['pj', 'delta'] } },
              rads: { type: 'array', items: { type: 'object', properties: { pj, delta: { type: 'integer' } }, required: ['pj', 'delta'] } },
              condiciones: { type: 'array', items: { type: 'object', properties: { pj, condicion: { type: 'string' }, accion: { type: 'string', enum: ['poner', 'quitar'] } }, required: ['pj', 'condicion', 'accion'] } },
              relojes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, nombre: { type: 'string' }, delta: { type: 'integer' }, segmentos: { type: 'integer' } }, required: ['id', 'delta'] } },
              ubicacion: { type: 'string' },
              misiones: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, texto: { type: 'string' }, estado: { type: 'string', enum: ['activa', 'cumplida', 'fallida'] } }, required: ['id', 'texto'] } },
              npcs: {
                type: 'array',
                description: 'NPC que aparecen o cambian. Uno NUEVO con nombre necesita "quiere" y "voz" (si no, queda como extra) y cuesta presupuesto. presente=false lo saca de escena.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' }, nombre: { type: 'string' }, actitud: { type: 'string' }, nota: { type: 'string', description: 'Lo que se ve de él ahora (lo ve la mesa: nada secreto)' },
                    estado: { type: 'string', enum: ['vivo', 'herido', 'muerto', 'huido'] },
                    rol: { type: 'string', enum: ['antagonista', 'aliado', 'rival', 'informante', 'neutral', 'victima'] },
                    quiere: { type: 'string' }, teme: { type: 'string' }, voz: { type: 'string', description: 'Cómo habla, en pocas palabras' },
                    publico: { type: 'string', description: 'Lo que la mesa sabe de este NPC, en una línea' },
                    presente: { type: 'boolean' },
                    relacion: { type: 'object', properties: { pj, delta: { type: 'integer', enum: [-1, 1] }, nota: { type: 'string' } }, required: ['pj', 'delta'] },
                  },
                  required: ['id', 'nombre'],
                },
              },
              lugares: { type: 'array', items: { type: 'object', properties: { nombre: { type: 'string' }, rasgo: { type: 'string' } }, required: ['nombre'] } },
              muerte: {
                type: 'object',
                description: 'Muerte de un personaje FUERA de combate: la elige su propio jugador (elegida=true) o viene de una tirada fallida con riesgo mortal.',
                properties: { pj, motivo: { type: 'string' }, elegida: { type: 'boolean' } },
                required: ['pj'],
              },
            },
          },
          escena: {
            type: 'object',
            description: 'Solo si la escena CAMBIA (otro lugar, otro momento): la nueva pregunta dramática y quiénes están. Los NPC que no listes salen de escena.',
            properties: { lugar: { type: 'string' }, pregunta: { type: 'string', description: '¿Qué está en juego en la escena nueva? Una pregunta de sí o no' }, presentes: { type: 'array', items: { type: 'string' } } },
            required: ['pregunta'],
          },
          hilos: {
            type: 'array',
            description: 'Preguntas narrativas: abrir (si hay lugar), tocar, cerrar (se respondió) o abandonar.',
            items: { type: 'object', properties: { id: { type: 'string' }, pregunta: { type: 'string' }, accion: { type: 'string', enum: ['abrir', 'tocar', 'cerrar', 'abandonar'] }, tipo: { type: 'string', enum: ['acto', 'personal', 'secundario'] }, pj }, required: ['accion'] },
          },
          hito_cumplido: { type: 'string', description: 'id del hito del acto que ESTE turno cumplió (solo si pasó de verdad)' },
          beat_jugado: { type: 'string', description: 'P1, P2...: si esta escena jugó el beat de arco personal que pedía el Brief' },
          agenda_frenada: { type: 'string', description: 'NPC o facción cuya agenda frenaron los jugadores este turno' },
          secreto_pj: { type: 'object', description: 'El secreto de un PJ queda sospechado (hay una pista) o revelado (solo si su jugador lo confiesa o lo descubren con una tirada).', properties: { pj, estado: { type: 'string', enum: ['sospechado', 'revelado'] } }, required: ['pj', 'estado'] },
          privado: { type: 'object', description: 'Un dato que SOLO recibe un jugador por privado (algo que su personaje nota o recuerda). El grupo ve la reacción, no el dato.', properties: { pj, texto: { type: 'string' } }, required: ['pj', 'texto'] },
          contradice_valor: { type: 'object', description: 'Si un PJ actuó claramente contra su valor o sus virtudes: queda como hecho y los NPC reaccionan.', properties: { pj, texto: { type: 'string' } }, required: ['pj', 'texto'] },
          hechos: { type: 'array', items: { type: 'string' }, description: '1 a 3 hechos de este turno, en tercera persona, máximo 20 palabras cada uno. Solo lo que pasó de verdad (es la memoria de la historia).' },
          recurso: { type: 'string', description: 'El golpe con el que cerrás la escena, en 1 a 3 palabras (ej. "emboscada", "confesión", "puerta que cede")' },
          libreta: { type: 'string', description: 'Tu plan privado para los próximos turnos (máx 50 palabras): qué escondés, qué pasa si el grupo hace X. Lo vas a leer el turno que viene.' },
          narracion: { type: 'string', description: 'Máximo 120 palabras, coherente con todo lo anterior. Termina dejándole algo concreto a quien juega después.' },
          sugerencias: { type: 'array', items: { type: 'string' }, description: 'Hasta 3 ideas cortas para quien juega DESPUÉS (se muestran solo si las pide)' },
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
        required: ['hechos', 'narracion'],
      },
    },
  }
  return { pedirTirada, narrar }
}
