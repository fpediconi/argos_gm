export type AtribId = 'FUE' | 'PER' | 'RES' | 'CAR' | 'INT' | 'AGI' | 'SUE'
export const ATRIBUTOS: AtribId[] = ['FUE', 'PER', 'RES', 'CAR', 'INT', 'AGI', 'SUE']

export interface AtribDef { id: AtribId; nombre: string; desc: string }
export interface HabDef { id: string; nombre: string; corto: string; grupo: string; attr: AtribId; desc: string }
export interface SubOrigenDef { id: string; nombre: string; desc: string }
export interface OrigenDef {
  id: string; nombre: string; emoji: string; desc: string
  atributos: Partial<Record<AtribId, number>>
  habilidades: Record<string, number>
  saludExtra: number; chapas: number; kit: string[]; rasgo: string
  radInmune?: boolean; robot?: boolean
  /** Variantes del origen (3 por origen): dan color narrativo y un contacto o reputación inicial. */
  sub?: SubOrigenDef[]
}

/** Efecto mecánico de un Extra o un Rasgo. Lo aplica el motor (nunca la IA). */
export type Efecto =
  | { tipo: 'hab'; id: string; v: number }
  | { tipo: 'atr'; id: AtribId; v: number }
  | { tipo: 'salud' | 'carga' | 'suerte' | 'prot' | 'defensa' | 'chapas'; v: number }
  | { tipo: 'danio'; grupo: 'cc' | 'distancia' | 'todo'; v: number }

export interface ExtraDef { id: string; nombre: string; desc: string; efectos: Efecto[]; req?: Partial<Record<AtribId, number>> }
/** Rasgo: una ventaja con su contrapartida (o una tara que da puntos). */
export interface RasgoDef { id: string; nombre: string; desc: string; efectos: Efecto[]; tara?: boolean }

export interface TablasCreacion {
  nombres: Record<string, string[]>
  edades: string[]
  aspectos: string[]
  voces: string[]
  frases: string[]
  virtudes: string[]
  defectos: string[]
  vicios: string[]
  valores: string[]
  oficios: string[]
  marcas: string[]
  objetivos: string[]
  miedos: string[]
  secretos: string[]
  mentiras: string[]
  personas: string[]
  deudas: string[]
  objetosPersonales: string[]
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
  extras: ExtraDef[]
  rasgos: RasgoDef[]
  tablas: TablasCreacion
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
  /** Biografía pública (la ve la party). El trasfondo completo es privado. */
  bio?: string
  // --- ficha ampliada (todo opcional: las fichas viejas siguen valiendo) ---
  subOrigen?: string
  arma2?: string
  extras?: string[]
  rasgos?: string[]
  edad?: string
  voz?: string
  virtudes?: string[]
  defecto?: string
  vicio?: string
  valor?: string
  oficio?: string
  /** El hecho que lo marcó. */
  marca?: string
  objetivo?: string
  miedo?: string
  secreto?: string
  /** Lo que dice de sí mismo y no es verdad. */
  mentira?: string
  /** Una persona importante fuera del grupo (nace como NPC en el Canon). */
  persona?: string
  deuda?: string
  objetoPersonal?: string
  /** Lazo con algo que ya existe en la historia (obligatorio para quien entra tarde). */
  lazo?: string
  secretoEstado?: 'oculto' | 'sospechado' | 'revelado'
  /** Marcas permanentes de haber esquivado la muerte. */
  cicatrices?: string[]
  /** Personaje que entra a mitad de partida: juega a partir de esta escena (duelo antes del reemplazo). */
  entraEscena?: number
  /** Veces que actuó contra su valor (momentos de definición). */
  contradicciones?: number
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
  duracion: Duracion
  plazoH: number // 0 = nunca se vence · -1 = skip directo (/saltear sin esperar ni votar)
  letalidad: 'suave' | 'normal' | 'hardcore'
  evitar: string[]
  silencio: [number, number] | null // horas [ini, fin) en hora local
  plazoMaxH: number // piloto automático (0 = nunca)
  violencia?: 'implicita' | 'explicita'
  pvp?: boolean
  /** Premisa de campaña elegida antes de arrancar (vacía = la decide el DJ). */
  premisa?: string
  /** Premisas propuestas por el guionista durante el asistente. */
  premisasOpc?: string[]
  esperandoPremisa?: boolean
}

export type Duracion = 'corta' | 'oneshot' | 'mini' | 'abierta'

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
  | { tipo: 'narrando'; accion: string; jugadorId: number; tirada?: TiradaResuelta; msgTirada?: number; intencion?: Intencion }
  | { tipo: 'esperando_tirada'; accion: string; jugadorId: number; pedido: PedidoTirada; intencion?: Intencion }
  | { tipo: 'esperando_libre'; jugadorId: number }
  | { tipo: 'esperando_mejora' }
  | { tipo: 'confirmando'; jugadorId: number; que: 'muerte' | 'abandono' }

/** Qué quiere hacer el jugador cuando la acción es drástica (lo decide un clasificador barato). */
export type TipoIntencion = 'muerte_propia' | 'matar' | 'abandonar' | 'traicion' | 'ataque' | 'otra'
export interface Intencion {
  tipo: TipoIntencion
  objetivo?: string
  /** Ataque creativo en combate: la prueba que propone el DJ para lo que se intenta. */
  prueba?: PedidoTirada
  /** Blanco resuelto por el motor (uid de enemigo o id de personaje). */
  blanco?: { tipo: 'enemigo'; uid: string } | { tipo: 'pj'; id: number }
}

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
  /** Hub: secciones que tocó el jugador (las demás quedaron sorteadas). */
  tocadas?: string[]
  /** Campo de texto libre que el jugador está escribiendo (paso "txt"). */
  campo?: string
  /** Entrevista guiada: lo que contó el jugador y lo que preguntó el DJ. */
  entrevista?: { p: string; r: string }[]
  cubiertos?: string[]
  /** Última pregunta que hizo el DJ en la entrevista. */
  ultima?: string
  /** Mensaje del hub (para editarlo en vez de mandar otro). */
  hubMsg?: number
  /** Ajustes que hizo el motor al compilar la entrevista. */
  ajustes?: string[]
}

export interface Reloj { id: string; nombre: string; segmentos: number; llenos: number }
export type EstadoNpc = 'vivo' | 'herido' | 'muerto' | 'huido'
export type RolNpc = 'antagonista' | 'aliado' | 'rival' | 'informante' | 'neutral' | 'victima'
export type PesoNpc = 'principal' | 'secundario' | 'extra'
/** Frente (Dungeon World): lo que un NPC o facción logra si nadie lo frena, paso a paso. */
export interface Agenda { meta: string; pasos: string[]; hechos: number; progreso: number; segmentos: number }
export interface Relacion { valor: number; nota: string }
/** Un NPC del Canon. Los campos nuevos son opcionales: las partidas viejas siguen valiendo. */
export interface NpcActivo {
  id: string; nombre: string; actitud: string; nota: string; estado?: EstadoNpc
  rol?: RolNpc
  peso?: PesoNpc
  quiere?: string
  teme?: string
  /** Solo lo sabe el DJ. */
  secreto?: string
  voz?: string
  /** Lo que la mesa sabe de él (lo usa /dj). */
  publico?: string
  /** La mesa ya lo vio o lo escuchó nombrar. */
  conocido?: boolean
  /** Está en la escena actual (solo los presentes pueden hablar). */
  presente?: boolean
  /** turno_n de la última vez que apareció. */
  visto?: number
  relacion?: Record<string, Relacion>
  agenda?: Agenda
  /** Veces que los jugadores lo nombraron (acciones y /dj): promueve extras. */
  menciones?: number
}
export interface Lugar { id: string; nombre: string; rasgo: string; conocido?: boolean }
export interface Faccion { id: string; nombre: string; quiere: string; esconde: string; publico?: string; conocido?: boolean; agenda?: Agenda }
export type TipoHilo = 'principal' | 'acto' | 'personal' | 'secundario'
/** Pregunta narrativa abierta. Cerrar hilos es tan importante como abrirlos. */
export interface Hilo { id: string; pregunta: string; tipo: TipoHilo; estado: 'abierto' | 'resuelto' | 'abandonado'; abierto: number; tocado: number; pj?: number }
/** Escena: unidad de juego con su pregunta dramática. */
export interface Escena { n: number; lugar: string; pregunta: string; desde: number; turnos: number }
export type TipoBeat = 'planteo' | 'presion' | 'definicion'
export interface Beat { tipo: TipoBeat; texto: string; estado: 'pendiente' | 'jugado' }
/** Arco personal de un PJ: tres beats que el motor programa según el foco. */
export interface Arco { pj: number; beats: Beat[]; ultimo?: number; definiendo?: boolean }

/** Memoria de trabajo del director (lo lleva el motor; la IA lo lee en el Brief). */
export interface Narrativa {
  /** Plan privado que dejó la IA para el turno siguiente. */
  libreta?: string
  /** Golpes de cierre usados ("emboscada", "voz que amenaza"...): no se repiten en 3 turnos. */
  recursos: { r: string; t: number }[]
  /** turno_n del último medio a distancia (radio, altavoz, megáfono...). */
  medios?: number
  /** id de NPC → turnos en que apareció. */
  apariciones: Record<string, number[]>
  /** Elementos nuevos introducidos (economía narrativa). */
  nuevos: { t: number; ronda: number; que: string }[]
  /** Entidades por las que preguntó la mesa en /dj (señal de confusión). */
  preguntas: Record<string, number>
  /** Fe de erratas: hechos que corrigen la historia durante unos turnos. */
  correcciones: { texto: string; hasta: number }[]
  /** PJ muertos en el capítulo (el mundo los recuerda). */
  muertosRecientes: string[]
  /** Instrucciones de una sola vez (legados, entradas de PJ nuevos). */
  pendientes: string[]
  /** Uso de /dj con IA por usuario en el turno. */
  dj: Record<string, { turno: number; n: number }>
  /** Métricas de coherencia. */
  auditorias?: number
  reparaciones?: number
  contradicciones?: number
}
export interface Mision { id: string; texto: string; estado: 'activa' | 'cumplida' | 'fallida'; principal?: boolean }
export interface EnemigoEnCombate {
  uid: string; plantilla: string; nombre: string; salud: number; salud_max: number
  tn: number; danio: number; prot: number
  /** Si el enemigo es un NPC con nombre, su id en mundo.npcs (al morir queda muerto). */
  npc?: string
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
  ritmo?: Ritmo
  /** Hechos decididos por el grupo (votaciones, líder, repartos). */
  decisiones?: string[]
  /** NPC muertos: no pueden reaparecer. */
  muertos?: string[]
  /** Usuarios que ya recibieron la bienvenida automática. */
  bienvenidos?: string[]
  /** A quién ya se le avisó "esperá tu turno" en el turno actual. */
  avisos?: { turno: number; ids: string[] }
  /** Ideas del DJ para el próximo turno (se muestran a pedido). */
  ideas?: string[]
  votacion?: VotacionGrupo | null
  /** Mensajes que fijó el bot (solo deberían quedar el tablero y el turno actual). */
  fijados?: number[]
  /** Decisión drástica esperando que el jugador confirme con botones. */
  confirmacion?: Confirmacion | null
  // --- Canon ---
  lugares?: Lugar[]
  facciones?: Faccion[]
  hilos?: Hilo[]
  escena?: Escena
  arcos?: Arco[]
  narrativa?: Narrativa
  /** Resúmenes congelados de los capítulos cerrados. */
  capitulos?: string[]
  /** Bitácora n en la que arrancó el capítulo actual. */
  inicioCap?: number
}

/** Director de ritmo: lo lleva el motor, no la IA. */
export interface Ritmo {
  /** Turnos narrados en el capítulo actual. */
  turnos: number
  /** Turnos objetivo del capítulo (rondas × jugadores). */
  objetivo: number
  /** Tope pedido con /final (turnos absolutos del capítulo). */
  tope?: number
  /** /final: este capítulo es el último aunque la campaña sea abierta. */
  finalPedido?: boolean
  /** Turno del capítulo en el que toca el próximo evento obligatorio. */
  proximoEvento: number
  /** Instrucción del evento que todavía no ocurrió. */
  eventoPendiente?: string
  secretosRevelados: number
  /** El próximo turno cierra el capítulo. */
  cierrePendiente?: boolean
  /** El reloj de amenaza se llenó: el capítulo está en clímax pase lo que pase. */
  climaxForzado?: boolean
}

export interface VotacionGrupo {
  pollId: string
  msgId: number
  pregunta: string
  opciones: string[]
  votos: Record<string, number>
  cierra: number
  autor: string
}

export interface Confirmacion {
  que: 'muerte' | 'abandono'
  pjId: number
  jugadorId: number
  accion: string
  /** Muerte propuesta por el DJ en su narración (se muestra solo si confirma). */
  salida?: unknown
}

export interface Hito { id: string; texto: string; cumplido?: boolean }
export interface Acto { objetivo: string; hitos: Hito[]; giro?: string }
export interface GuionMaestro {
  titulo: string
  premisa: string
  gancho: string
  actos: Acto[]
  facciones: { nombre: string; quiere: string; esconde: string; agenda?: { meta: string; pasos: string[] } }[]
  npcs: { nombre: string; motivacion: string; secreto: string; voz: string; rol?: RolNpc; teme?: string; publico?: string; agenda?: { meta: string; pasos: string[] } }[]
  /** Arco personal por personaje (P1, P2...): planteo, presión, definición. */
  arcos?: { pj: string; beats: string[] }[]
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
