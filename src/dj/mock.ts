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
        hechos: [`Suceso simulado ${this.n}.`],
        sugerencias: ['Explorar', 'Hablar', 'Esperar'],
        combate,
        cerrar_capitulo: p.tarea === 'turno' && this.n === 11,
      },
    }
  }
  /** Últimas peticiones de texto (para inspeccionar prompts en tests). */
  vistasTexto: PeticionTexto[] = []
  ultimaTexto(tarea: string): PeticionTexto | undefined {
    return [...this.vistasTexto].reverse().find((x) => x.tarea === tarea)
  }
  async texto(p: PeticionTexto): Promise<string> {
    this.llamadas++
    this.vistasTexto.push(p)
    if (this.vistasTexto.length > 40) this.vistasTexto.shift()
    const forzado = this.textos[p.tarea]
    if (forzado !== undefined) return forzado
    switch (p.tarea) {
      case 'guion':
        return JSON.stringify({
          titulo: 'La señal de Radio Ceniza', premisa: 'Una señal de auxilio guía al grupo.', gancho: 'La radio crepita en plena noche.',
          actos: [
            { objetivo: 'Seguir la señal', hitos: [{ id: 'a1h1', texto: 'Encuentran la torre de radio' }, { id: 'a1h2', texto: 'Descubren quién emite' }], giro: 'La señal es una trampa' },
            { objetivo: 'Encontrar al emisor', hitos: [{ id: 'a2h1', texto: 'Rescatan a Nora' }], giro: 'Nora mintió' },
            { objetivo: 'Decidir su destino', hitos: [{ id: 'a3h1', texto: 'Enfrentan a Varela' }] },
          ],
          facciones: [{ nombre: 'Cazadores de Chatarra', quiere: 'Controlar el agua', esconde: 'Envenenaron el pozo', agenda: { meta: 'Quedarse con el agua', pasos: ['Compran a los guardias', 'Cortan el agua del barrio', 'Toman la torre'] } }],
          npcs: [
            { nombre: 'Nora', rol: 'aliado', motivacion: 'Salir viva', teme: 'A Varela', secreto: 'Trabaja para Varela', voz: 'Habla bajito', publico: 'Técnica de radio' },
            { nombre: 'Varela', rol: 'antagonista', motivacion: 'El agua de la costa', teme: 'Perder a sus hombres', secreto: 'Está enfermo', voz: 'Seco y educado', publico: 'Jefe de los Cazadores', agenda: { meta: 'Controlar la costa', pasos: ['Cierra el puerto', 'Quema el mercado', 'Toma el Torreón'] } },
          ],
          arcos: [{ pj: 'P1', beats: ['Su hermano aparece en la radio', 'Varela le ofrece a su hermano a cambio de traicionar', 'Elegir entre su hermano y el grupo'] }],
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
      case 'auditor': return '{"afirmaciones":[]}'
      case 'dj': return 'Respuesta simulada del DJ con lo que sabés.'
      case 'capitulo': return 'Capítulo simulado: pasaron cosas.'
      case 'entrevista': return JSON.stringify({ cubiertos: ['concepto'], pregunta: '¿Qué lo sacó de su casa?' })
      case 'compilar': return JSON.stringify({ origen: 'superviviente', subOrigen: 'chatarrero', arquetipo: 'explorador', especialidades: ['supervivencia', 'sigilo', 'armas_pequenas'], extras: ['explorador_nato'], rasgos: [], arma: 'rifle_caza', nombre: 'La Colorada', edad: 'En sus treinta', aspecto: 'Pelirroja y flaca', voz: 'Habla poco', frase: 'Ni un paso atrás.', virtudes: ['Leal', 'Tenaz'], defecto: 'Desconfiada', valor: 'Lealtad', objetivo: 'Encontrar a su hermano', miedo: 'Quedarse sola', secreto: 'Robó el mapa', mentira: 'Dice que nunca mató', persona: 'Su hermano Tino', deuda: 'Le debe 200 chapas al prestamista', objetoPersonal: 'Un mapa con una X' })
      default: return 'ok'
    }
  }
}
