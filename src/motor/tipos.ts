export type AtribId = 'FUE' | 'PER' | 'RES' | 'CAR' | 'INT' | 'AGI' | 'SUE'
export const ATRIBUTOS: AtribId[] = ['FUE', 'PER', 'RES', 'CAR', 'INT', 'AGI', 'SUE']

export interface AtribDef { id: AtribId; nombre: string; desc: string }
export interface HabDef { id: string; nombre: string; corto: string; grupo: string; attr: AtribId; desc: string }
export interface OrigenDef {
  id: string; nombre: string; emoji: string; desc: string
  atributos: Partial<Record<AtribId, number>>
  habilidades: Record<string, number>
  saludExtra: number; chapas: number; kit: string[]; rasgo: string
  radInmune?: boolean; robot?: boolean
}
export interface ArquetipoDef {
  id: string; nombre: string; emoji: string
  atributos: Record<AtribId, number>
  especialidades: string[]
  puntos: Record<string, number>
}
export interface ArmaDef {
  id: string; nombre: string; habilidad: string; danio: number; rasgo: string
  perfora?: number; area?: boolean; consumible?: boolean
}
export interface ObjetoDef { id: string; nombre: string; efecto: 'cura' | 'rads' | 'armadura' | 'ninguno'; valor: number; desc: string }
export interface EnemigoDef { id: string; nombre: string; salud: number; tn: number; danio: number; prot: number; rasgo: string }
export interface EscenarioDef { id: string; nombre: string; emoji: string; semilla: string }
export interface TonoDef { id: string; nombre: string; prompt: string }

export interface Universo {
  id: string
  nombre: string
  atributos: AtribDef[]
  grupos: { id: string; nombre: string }[]
  habilidades: HabDef[]
  origenes: OrigenDef[]
  arquetipos: ArquetipoDef[]
  armas: ArmaDef[]
  objetos: ObjetoDef[]
  bestiario: EnemigoDef[]
  escenarios: EscenarioDef[]
  tonos: TonoDef[]
  estilo: string
}

/** Lo que el jugador arma en la creación. */
export interface Ficha {
  origen: string
  atributos: Record<AtribId, number>
  habilidades: Record<string, number>
  especialidades: string[]
  nombre: string
  aspecto: string
  frase: string
  arma: string
  respuestas: string[]
}

export interface ItemInv { id: string; n: number }

export interface Personaje {
  id: number
  partida_id: number
  jugador_id: number
  ficha: Ficha
  salud: number
  salud_max: number
  penal_salud: number
  rads: number
  suerte: number
  chapas: number
  inventario: ItemInv[]
  condiciones: string[]
  trasfondo: string
  gancho: string
  vivo: boolean
  cubierto: boolean
}

export type EstadoPartida = 'CONFIG' | 'CREANDO' | 'EN_JUEGO' | 'PAUSADA' | 'FINALIZADA'
export type EstadoJugador = 'creando' | 'listo' | 'activo' | 'ausente' | 'dormido' | 'fuera'

export interface ConfigPartida {
  universo: string
  escenario: string
  tono: string
  duracion: 'oneshot' | 'mini' | 'abierta'
  plazoH: number // 0 = sin plazo
  letalidad: 'suave' | 'normal' | 'hardcore'
  evitar: string[]
  silencio: [number, number] | null // horas [ini, fin) en hora local
  plazoMaxH: number // piloto automático (0 = nunca)
}

export interface Partida {
  id: number
  chat_id: string
  thread_id: number | null
  anfitrion_id: string
  estado: EstadoPartida
  config: ConfigPartida
  guion: GuionMaestro | null
  resumen: string
  resumen_hasta: number
  capitulo: number
  ronda: number
  rondas_cap: number
  modo_escena: 'exploracion' | 'combate'
  turno_jugador_id: number | null
  turno_n: number
  turno_desde: number
  turno_vence: number
  recordado: number
  paso: Paso
  tablero_msg_id: number | null
  wizard_msg_id: number | null
  turno_msg_id: number | null
  mundo: Mundo
  creada_en: number
}

export type Paso =
  | { tipo: 'libre' }
  | { tipo: 'esperando_accion' }
  | { tipo: 'narrando'; accion: string; jugadorId: number; tirada?: TiradaResuelta }
  | { tipo: 'esperando_tirada'; accion: string; jugadorId: number; pedido: PedidoTirada }
  | { tipo: 'esperando_libre'; jugadorId: number }
  | { tipo: 'esperando_mejora' }

export interface Jugador {
  id: number
  partida_id: number
  user_id: string
  nombre: string
  username: string
  dm_chat_id: string | null
  estado: EstadoJugador
  orden: number
  ausente_hasta: number
  ultimo_visto_n: number
  foco: number
  saltos_seguidos: number
  creacion: Creacion | null
  mejora_pendiente: boolean
}

export interface Creacion {
  paso: string
  modo: 'rapido' | 'entrevista'
  borrador: Partial<Ficha> & { puntosAttr?: number }
  grupoHab?: string
  pregunta?: number
  volver?: string
}

export interface Reloj { id: string; nombre: string; segmentos: number; llenos: number }
export interface NpcActivo { id: string; nombre: string; actitud: string; nota: string }
export interface Mision { id: string; texto: string; estado: 'activa' | 'cumplida' | 'fallida' }
export interface EnemigoEnCombate {
  uid: string; plantilla: string; nombre: string; salud: number; salud_max: number
  tn: number; danio: number; prot: number
}
export interface Combate {
  ronda: number
  enemigos: EnemigoEnCombate[]
  orden: number[] // jugador ids que ya actuaron en esta ronda
  log: string[]
  sorpresa: 'jugadores' | 'enemigos' | 'ninguna'
}
export interface Mundo {
  ubicacion: string
  npcs: NpcActivo[]
  misiones: Mision[]
  relojes: Reloj[]
  vinculos: string[]
  impulso: number
  combate: Combate | null
  senalX?: boolean
}

export interface GuionMaestro {
  titulo: string
  premisa: string
  gancho: string
  actos: string[]
  facciones: { nombre: string; quiere: string; esconde: string }[]
  npcs: { nombre: string; motivacion: string; secreto: string; voz: string }[]
  lugares: { nombre: string; rasgo: string }[]
  secretos: string[]
  amenaza: { nombre: string; reloj: string; segmentos: number }
  finales: string[]
  encuentros: string[]
}

export interface PedidoTirada {
  atributo: AtribId
  habilidad: string
  dificultad: number
  motivo: string
}

export interface TiradaResuelta {
  pedido: PedidoTirada
  tn: number
  dados: number[]
  exitos: number
  criticos: number
  complicaciones: number
  exito: boolean
  impulso: number
  extra: 'ninguno' | 'suerte' | 'impulso'
}
