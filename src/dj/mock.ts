import type { Cerebro, Decision, PeticionDecidir, PeticionTexto } from './cerebro.js'

/** Cerebro determinista para simulaciones y tests. No usa red. */
export class CerebroMock implements Cerebro {
  llamadas = 0
  private n = 0
  /** Decisiones de turno forzadas (tests): se consumen en orden antes que las simuladas. */
  cola: Decision[] = []
  /** Respuestas de texto forzadas por tarea (tests). */
  textos: Partial<Record<string, string>> = {}
  /** Últimas peticiones de turno (para inspeccionar el prompt en tests). */
  vistas: PeticionDecidir[] = []
  /** Cada N decisiones de turno pide una tirada (si no forzarNarrar). */
  constructor(private cadaTirada = 2, private combateEn = 4) {}
  async decidir(p: PeticionDecidir): Promise<Decision> {
    this.llamadas++
    this.n++
    this.vistas.push(p)
    if (this.vistas.length > 20) this.vistas.shift()
    if ((p.tarea === 'turno') && this.cola.length) {
      const d = this.cola.shift()!
      if (!(p.forzarNarrar && d.tipo === 'tirada')) return d
    }
    if (!p.forzarNarrar && this.n % this.cadaTirada === 0 && p.tarea === 'turno') {
      return { tipo: 'tirada', preambulo: 'El DJ entrecierra los ojos.', pedido: { atributo: 'AGI', habilidad: 'sigilo', dificultad: 1, motivo: 'Pasar sin que te vean' } }
    }
    const combate = p.tarea === 'turno' && this.n === this.combateEn + 1 ? { enemigos: [{ plantilla_id: 'saqueador', cantidad: 2 }], sorpresa: 'ninguna' as const } : undefined
    return {
      tipo: 'narrar',
      salida: {
        narracion: `El viento arrastra polvo radiactivo (narración simulada #${this.n}).`,
        cronica: `Suceso simulado ${this.n}.`,
        sugerencias: ['Explorar', 'Hablar', 'Esperar'],
        combate,
        cerrar_capitulo: p.tarea === 'turno' && this.n === 11,
      },
    }
  }
  async texto(p: PeticionTexto): Promise<string> {
    this.llamadas++
    const forzado = this.textos[p.tarea]
    if (forzado !== undefined) return forzado
    switch (p.tarea) {
      case 'guion':
        return JSON.stringify({
          titulo: 'La señal de Radio Ceniza', premisa: 'Una señal de auxilio guía al grupo.', gancho: 'La radio crepita en plena noche.',
          actos: ['Seguir la señal', 'Encontrar al emisor', 'Decidir su destino'],
          facciones: [{ id: 'cazadores', nombre: 'Cazadores de Chatarra', deseo: 'Controlar el agua' }],
          npcs: [{ id: 'nora', nombre: 'Nora', rol: 'Técnica de radio', actitud: 'desconfiada' }],
          lugares: [{ id: 'torre', nombre: 'Torre de radio', desc: 'Antena caída' }], secretos: ['La señal es una trampa'],
          amenaza: { nombre: 'Tormenta rad', reloj: 'Tormenta', segmentos: 6 }, finales: ['Salvar a Nora'], encuentros: [{ plantilla_id: 'saqueador', cuando: 'Al llegar a la torre' }],
        })
      case 'trasfondo': return JSON.stringify({ bio_publica: 'Chatarrero conocido en toda la costa.', trasfondo: 'Salió de casa buscando respuestas.', gancho: 'Un secreto lo persigue.' })
      case 'premisas': return JSON.stringify({ premisas: ['Recuperar el reactor del Torreón antes que los Hijos del Puerto', 'Escoltar una caravana de agua hasta el Refugio 88', 'Encontrar al que envenenó el pozo de Punta Mogotes'] })
      case 'reaccion': return 'Buena elección.'
      case 'resumen': return 'Resumen simulado de la aventura hasta ahora.'
      case 'radio': return '📻 Transmisión simulada: los últimos sucesos.'
      case 'epilogo': return 'Epílogo simulado: el yermo recuerda.'
      case 'ronda_combate': return 'La ronda estalla en disparos y polvo.'
      default: return 'ok'
    }
  }
}
