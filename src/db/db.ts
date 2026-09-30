import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  user_id TEXT PRIMARY KEY, nombre TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
  dm_chat_id TEXT, contexto_partida_id INTEGER
);
CREATE TABLE IF NOT EXISTS partidas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL, thread_id INTEGER, anfitrion_id TEXT NOT NULL,
  estado TEXT NOT NULL, config TEXT NOT NULL, guion TEXT,
  resumen TEXT NOT NULL DEFAULT '', resumen_hasta INTEGER NOT NULL DEFAULT 0,
  capitulo INTEGER NOT NULL DEFAULT 1, ronda INTEGER NOT NULL DEFAULT 0, rondas_cap INTEGER NOT NULL DEFAULT 0,
  modo_escena TEXT NOT NULL DEFAULT 'exploracion',
  turno_jugador_id INTEGER, turno_n INTEGER NOT NULL DEFAULT 0,
  turno_desde INTEGER NOT NULL DEFAULT 0, turno_vence INTEGER NOT NULL DEFAULT 0, recordado INTEGER NOT NULL DEFAULT 0,
  paso TEXT NOT NULL, tablero_msg_id INTEGER, wizard_msg_id INTEGER, turno_msg_id INTEGER,
  mundo TEXT NOT NULL, creada_en INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_partidas_chat ON partidas(chat_id);
CREATE TABLE IF NOT EXISTS jugadores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partida_id INTEGER NOT NULL, user_id TEXT NOT NULL, nombre TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
  dm_chat_id TEXT, estado TEXT NOT NULL, orden INTEGER NOT NULL,
  ausente_hasta INTEGER NOT NULL DEFAULT 0, ultimo_visto_n INTEGER NOT NULL DEFAULT 0,
  foco INTEGER NOT NULL DEFAULT 0, saltos_seguidos INTEGER NOT NULL DEFAULT 0,
  creacion TEXT, mejora_pendiente INTEGER NOT NULL DEFAULT 0,
  UNIQUE(partida_id, user_id)
);
CREATE TABLE IF NOT EXISTS personajes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partida_id INTEGER NOT NULL, jugador_id INTEGER NOT NULL, ficha TEXT NOT NULL,
  salud INTEGER NOT NULL, salud_max INTEGER NOT NULL, penal_salud INTEGER NOT NULL DEFAULT 0,
  rads INTEGER NOT NULL DEFAULT 0, suerte INTEGER NOT NULL, chapas INTEGER NOT NULL DEFAULT 0,
  inventario TEXT NOT NULL, condiciones TEXT NOT NULL, trasfondo TEXT NOT NULL DEFAULT '', gancho TEXT NOT NULL DEFAULT '',
  vivo INTEGER NOT NULL DEFAULT 1, cubierto INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_personajes_partida ON personajes(partida_id);
CREATE TABLE IF NOT EXISTS bitacora (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partida_id INTEGER NOT NULL, n INTEGER NOT NULL, ronda INTEGER NOT NULL DEFAULT 0, jugador_id INTEGER,
  tipo TEXT NOT NULL, texto TEXT NOT NULL, cronica TEXT NOT NULL DEFAULT '', creada_en INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bitacora ON bitacora(partida_id, n);
CREATE TABLE IF NOT EXISTS tiradas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partida_id INTEGER NOT NULL, jugador_id INTEGER, atributo TEXT, habilidad TEXT, tn INTEGER, dificultad INTEGER,
  dados TEXT, exitos INTEGER, complicaciones INTEGER, impulso INTEGER, extra TEXT, motivo TEXT, creada_en INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS votaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partida_id INTEGER NOT NULL, tipo TEXT NOT NULL, objetivo_id INTEGER, msg_id INTEGER,
  abre INTEGER NOT NULL, cierra INTEGER NOT NULL, resultado TEXT NOT NULL DEFAULT 'abierta', votos TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS llamadas_ia (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partida_id INTEGER, rol TEXT NOT NULL, modelo TEXT NOT NULL, tok_in INTEGER, tok_cache INTEGER, tok_out INTEGER,
  usd REAL NOT NULL DEFAULT 0, ms INTEGER, ok INTEGER NOT NULL DEFAULT 1, creada_en INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_llamadas ON llamadas_ia(creada_en);
`

export function abrirDb(ruta: string): DatabaseSync {
  if (ruta !== ':memory:') mkdirSync(dirname(ruta), { recursive: true })
  const db = new DatabaseSync(ruta)
  if (ruta !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  return db
}
