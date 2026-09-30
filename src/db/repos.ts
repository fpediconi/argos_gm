import type { DatabaseSync } from 'node:sqlite'
import type { Creacion, Jugador, Partida, Personaje, Ficha, ConfigPartida } from '../motor/tipos.js'
import { mundoVacio } from '../motor/estado.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
const J = (s: string | null | undefined, def: any = null) => (s ? JSON.parse(s) : def)
const S = (o: unknown) => JSON.stringify(o)

export interface Bitacora { id: number; partida_id: number; n: number; ronda: number; jugador_id: number | null; tipo: string; texto: string; cronica: string; creada_en: number }
export interface Votacion { id: number; partida_id: number; tipo: string; objetivo_id: number | null; msg_id: number | null; abre: number; cierra: number; resultado: string; votos: Record<string, 's' | 'e'> }
export interface Usuario { user_id: string; nombre: string; username: string; dm_chat_id: string | null; contexto_partida_id: number | null }

export class Repos {
  constructor(public db: DatabaseSync) {}

  // ---------- usuarios ----------
  upsertUsuario(user_id: string, nombre: string, username: string, dm_chat_id: string | null) {
    this.db.prepare(`INSERT INTO usuarios(user_id,nombre,username,dm_chat_id) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET nombre=excluded.nombre, username=excluded.username,
      dm_chat_id=COALESCE(excluded.dm_chat_id, usuarios.dm_chat_id)`).run(user_id, nombre, username, dm_chat_id)
  }
  usuario(user_id: string): Usuario | undefined {
    return this.db.prepare('SELECT * FROM usuarios WHERE user_id=?').get(user_id) as any
  }
  setContexto(user_id: string, partidaId: number | null) {
    this.db.prepare('UPDATE usuarios SET contexto_partida_id=? WHERE user_id=?').run(partidaId, user_id)
  }

  // ---------- partidas ----------
  crearPartida(chat_id: string, thread_id: number | null, anfitrion_id: string, config: ConfigPartida, ahora: number): Partida {
    const r = this.db.prepare(`INSERT INTO partidas(chat_id,thread_id,anfitrion_id,estado,config,paso,mundo,creada_en)
      VALUES(?,?,?,?,?,?,?,?)`).run(chat_id, thread_id, anfitrion_id, 'CONFIG', S(config), S({ tipo: 'libre' }), S(mundoVacio()), ahora)
    return this.partida(Number(r.lastInsertRowid))!
  }
  private mapP(r: any): Partida {
    return { ...r, config: J(r.config), guion: J(r.guion), paso: J(r.paso), mundo: J(r.mundo) }
  }
  partida(id: number): Partida | undefined {
    const r = this.db.prepare('SELECT * FROM partidas WHERE id=?').get(id)
    return r ? this.mapP(r) : undefined
  }
  partidaActivaDeChat(chat_id: string): Partida | undefined {
    const r = this.db.prepare(`SELECT * FROM partidas WHERE chat_id=? AND estado!='FINALIZADA' ORDER BY id DESC LIMIT 1`).get(chat_id)
    return r ? this.mapP(r) : undefined
  }
  partidasEnJuego(): Partida[] {
    return this.db.prepare(`SELECT * FROM partidas WHERE estado='EN_JUEGO'`).all().map((r) => this.mapP(r))
  }
  partidasNoFinalizadas(): Partida[] {
    return this.db.prepare(`SELECT * FROM partidas WHERE estado!='FINALIZADA'`).all().map((r) => this.mapP(r))
  }
  guardarPartida(p: Partida) {
    this.db.prepare(`UPDATE partidas SET chat_id=?,thread_id=?,anfitrion_id=?,estado=?,config=?,guion=?,resumen=?,resumen_hasta=?,
      capitulo=?,ronda=?,rondas_cap=?,modo_escena=?,turno_jugador_id=?,turno_n=?,turno_desde=?,turno_vence=?,recordado=?,paso=?,
      tablero_msg_id=?,wizard_msg_id=?,turno_msg_id=?,mundo=? WHERE id=?`).run(
      p.chat_id, p.thread_id, p.anfitrion_id, p.estado, S(p.config), p.guion ? S(p.guion) : null, p.resumen, p.resumen_hasta,
      p.capitulo, p.ronda, p.rondas_cap, p.modo_escena, p.turno_jugador_id, p.turno_n, p.turno_desde, p.turno_vence, p.recordado,
      S(p.paso), p.tablero_msg_id, p.wizard_msg_id, p.turno_msg_id, S(p.mundo), p.id)
  }

  // ---------- jugadores ----------
  private mapJ(r: any): Jugador {
    return { ...r, creacion: J(r.creacion) as Creacion | null, mejora_pendiente: !!r.mejora_pendiente }
  }
  crearJugador(partida_id: number, user_id: string, nombre: string, username: string, dm_chat_id: string | null): Jugador {
    const orden = (this.db.prepare('SELECT COALESCE(MAX(orden),0)+1 AS o FROM jugadores WHERE partida_id=?').get(partida_id) as any).o
    const r = this.db.prepare(`INSERT INTO jugadores(partida_id,user_id,nombre,username,dm_chat_id,estado,orden)
      VALUES(?,?,?,?,?,'creando',?)`).run(partida_id, user_id, nombre, username, dm_chat_id, orden)
    return this.jugador(Number(r.lastInsertRowid))!
  }
  jugador(id: number): Jugador | undefined {
    const r = this.db.prepare('SELECT * FROM jugadores WHERE id=?').get(id)
    return r ? this.mapJ(r) : undefined
  }
  jugadorDeUsuario(partida_id: number, user_id: string): Jugador | undefined {
    const r = this.db.prepare('SELECT * FROM jugadores WHERE partida_id=? AND user_id=?').get(partida_id, user_id)
    return r ? this.mapJ(r) : undefined
  }
  jugadores(partida_id: number): Jugador[] {
    return this.db.prepare('SELECT * FROM jugadores WHERE partida_id=? ORDER BY orden').all(partida_id).map((r) => this.mapJ(r))
  }
  jugadoresConAusenciaVencida(ahora: number): Jugador[] {
    return this.db.prepare(`SELECT * FROM jugadores WHERE estado='ausente' AND ausente_hasta>0 AND ausente_hasta<=?`).all(ahora).map((r) => this.mapJ(r))
  }
  partidasDeUsuario(user_id: string): Partida[] {
    return this.db.prepare(`SELECT p.* FROM partidas p JOIN jugadores j ON j.partida_id=p.id
      WHERE j.user_id=? AND p.estado!='FINALIZADA' AND j.estado!='fuera' ORDER BY p.id DESC`).all(user_id).map((r) => this.mapP(r))
  }
  guardarJugador(j: Jugador) {
    this.db.prepare(`UPDATE jugadores SET nombre=?,username=?,dm_chat_id=?,estado=?,orden=?,ausente_hasta=?,ultimo_visto_n=?,
      foco=?,saltos_seguidos=?,creacion=?,mejora_pendiente=? WHERE id=?`).run(
      j.nombre, j.username, j.dm_chat_id, j.estado, j.orden, j.ausente_hasta, j.ultimo_visto_n, j.foco, j.saltos_seguidos,
      j.creacion ? S(j.creacion) : null, j.mejora_pendiente ? 1 : 0, j.id)
  }

  // ---------- personajes ----------
  private mapPj(r: any): Personaje {
    return { ...r, ficha: J(r.ficha) as Ficha, inventario: J(r.inventario, []), condiciones: J(r.condiciones, []), vivo: !!r.vivo, cubierto: !!r.cubierto }
  }
  crearPersonaje(partida_id: number, jugador_id: number, base: Omit<Personaje, 'id' | 'partida_id' | 'jugador_id'>): Personaje {
    const r = this.db.prepare(`INSERT INTO personajes(partida_id,jugador_id,ficha,salud,salud_max,penal_salud,rads,suerte,chapas,
      inventario,condiciones,trasfondo,gancho,vivo,cubierto) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,0)`).run(
      partida_id, jugador_id, S(base.ficha), base.salud, base.salud_max, base.penal_salud, base.rads, base.suerte, base.chapas,
      S(base.inventario), S(base.condiciones), base.trasfondo, base.gancho)
    return this.personaje(Number(r.lastInsertRowid))!
  }
  personaje(id: number): Personaje | undefined {
    const r = this.db.prepare('SELECT * FROM personajes WHERE id=?').get(id)
    return r ? this.mapPj(r) : undefined
  }
  personajeVivoDe(jugador_id: number): Personaje | undefined {
    const r = this.db.prepare('SELECT * FROM personajes WHERE jugador_id=? AND vivo=1 ORDER BY id DESC LIMIT 1').get(jugador_id)
    return r ? this.mapPj(r) : undefined
  }
  ultimoPersonajeDe(jugador_id: number): Personaje | undefined {
    const r = this.db.prepare('SELECT * FROM personajes WHERE jugador_id=? ORDER BY id DESC LIMIT 1').get(jugador_id)
    return r ? this.mapPj(r) : undefined
  }
  personajesVivos(partida_id: number): Personaje[] {
    return this.db.prepare('SELECT * FROM personajes WHERE partida_id=? AND vivo=1 ORDER BY id').all(partida_id).map((r) => this.mapPj(r))
  }
  personajesTodos(partida_id: number): Personaje[] {
    return this.db.prepare('SELECT * FROM personajes WHERE partida_id=? ORDER BY id').all(partida_id).map((r) => this.mapPj(r))
  }
  guardarPersonaje(p: Personaje) {
    this.db.prepare(`UPDATE personajes SET ficha=?,salud=?,salud_max=?,penal_salud=?,rads=?,suerte=?,chapas=?,inventario=?,
      condiciones=?,trasfondo=?,gancho=?,vivo=?,cubierto=? WHERE id=?`).run(
      S(p.ficha), p.salud, p.salud_max, p.penal_salud, p.rads, p.suerte, p.chapas, S(p.inventario), S(p.condiciones),
      p.trasfondo, p.gancho, p.vivo ? 1 : 0, p.cubierto ? 1 : 0, p.id)
  }

  // ---------- bitácora ----------
  agregarBitacora(partida_id: number, ronda: number, jugador_id: number | null, tipo: string, texto: string, cronica: string, ahora: number): number {
    const n = (this.db.prepare('SELECT COALESCE(MAX(n),0)+1 AS n FROM bitacora WHERE partida_id=?').get(partida_id) as any).n
    this.db.prepare(`INSERT INTO bitacora(partida_id,n,ronda,jugador_id,tipo,texto,cronica,creada_en) VALUES(?,?,?,?,?,?,?,?)`)
      .run(partida_id, n, ronda, jugador_id, tipo, texto, cronica, ahora)
    return n
  }
  maxBitacora(partida_id: number): number {
    return (this.db.prepare('SELECT COALESCE(MAX(n),0) AS n FROM bitacora WHERE partida_id=?').get(partida_id) as any).n
  }
  ultimasBitacora(partida_id: number, k: number, tipos?: string[]): Bitacora[] {
    const filtro = tipos ? `AND tipo IN (${tipos.map(() => '?').join(',')})` : ''
    const rows = this.db.prepare(`SELECT * FROM bitacora WHERE partida_id=? ${filtro} ORDER BY n DESC LIMIT ?`).all(partida_id, ...(tipos ?? []), k) as any[]
    return rows.reverse()
  }
  bitacoraDesde(partida_id: number, n: number): Bitacora[] {
    return this.db.prepare('SELECT * FROM bitacora WHERE partida_id=? AND n>? ORDER BY n').all(partida_id, n) as any
  }
  bitacoraTodas(partida_id: number): Bitacora[] {
    return this.db.prepare('SELECT * FROM bitacora WHERE partida_id=? ORDER BY n').all(partida_id) as any
  }

  // ---------- tiradas ----------
  registrarTirada(partida_id: number, jugador_id: number, t: { atributo: string; habilidad: string; tn: number; dificultad: number; dados: number[]; exitos: number; complicaciones: number; impulso: number; extra: string; motivo: string }, ahora: number) {
    this.db.prepare(`INSERT INTO tiradas(partida_id,jugador_id,atributo,habilidad,tn,dificultad,dados,exitos,complicaciones,impulso,extra,motivo,creada_en)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(partida_id, jugador_id, t.atributo, t.habilidad, t.tn, t.dificultad, S(t.dados), t.exitos, t.complicaciones, t.impulso, t.extra, t.motivo, ahora)
  }
  ultimasTiradas(partida_id: number, k: number): any[] {
    return (this.db.prepare(`SELECT t.*, j.nombre AS jugador FROM tiradas t LEFT JOIN jugadores j ON j.id=t.jugador_id
      WHERE t.partida_id=? ORDER BY t.id DESC LIMIT ?`).all(partida_id, k) as any[]).reverse()
  }

  // ---------- votaciones ----------
  crearVotacion(partida_id: number, tipo: string, objetivo_id: number, abre: number, cierra: number): Votacion {
    const r = this.db.prepare('INSERT INTO votaciones(partida_id,tipo,objetivo_id,abre,cierra) VALUES(?,?,?,?,?)').run(partida_id, tipo, objetivo_id, abre, cierra)
    return this.votacion(Number(r.lastInsertRowid))!
  }
  votacion(id: number): Votacion | undefined {
    const r = this.db.prepare('SELECT * FROM votaciones WHERE id=?').get(id) as any
    return r ? { ...r, votos: J(r.votos, {}) } : undefined
  }
  votacionAbierta(partida_id: number): Votacion | undefined {
    const r = this.db.prepare(`SELECT * FROM votaciones WHERE partida_id=? AND resultado='abierta' ORDER BY id DESC LIMIT 1`).get(partida_id) as any
    return r ? { ...r, votos: J(r.votos, {}) } : undefined
  }
  votacionesAbiertas(): Votacion[] {
    return (this.db.prepare(`SELECT * FROM votaciones WHERE resultado='abierta'`).all() as any[]).map((r) => ({ ...r, votos: J(r.votos, {}) }))
  }
  guardarVotacion(v: Votacion) {
    this.db.prepare('UPDATE votaciones SET msg_id=?,resultado=?,votos=? WHERE id=?').run(v.msg_id, v.resultado, S(v.votos), v.id)
  }

  // ---------- llamadas IA / gasto ----------
  registrarLlamada(x: { partida_id: number | null; rol: string; modelo: string; tok_in: number; tok_cache: number; tok_out: number; usd: number; ms: number; ok: boolean }, ahora: number) {
    this.db.prepare(`INSERT INTO llamadas_ia(partida_id,rol,modelo,tok_in,tok_cache,tok_out,usd,ms,ok,creada_en) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(x.partida_id, x.rol, x.modelo, x.tok_in, x.tok_cache, x.tok_out, x.usd, x.ms, x.ok ? 1 : 0, ahora)
  }
  gastoDesde(desde: number, partida_id?: number): number {
    const r = partida_id === undefined
      ? this.db.prepare('SELECT COALESCE(SUM(usd),0) AS s FROM llamadas_ia WHERE creada_en>=?').get(desde)
      : this.db.prepare('SELECT COALESCE(SUM(usd),0) AS s FROM llamadas_ia WHERE creada_en>=? AND partida_id=?').get(desde, partida_id)
    return (r as any).s
  }
  gastoPorRol(partida_id: number): { rol: string; llamadas: number; usd: number; tok_in: number; tok_cache: number; tok_out: number }[] {
    return this.db.prepare(`SELECT rol, COUNT(*) AS llamadas, SUM(usd) AS usd, SUM(tok_in) AS tok_in, SUM(tok_cache) AS tok_cache, SUM(tok_out) AS tok_out
      FROM llamadas_ia WHERE partida_id=? GROUP BY rol`).all(partida_id) as any
  }
}
