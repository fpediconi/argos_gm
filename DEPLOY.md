# Argos DJ — Guía de deploy (VPS → grupo de Telegram → a jugar)

Tiempo estimado: **30–40 minutos** la primera vez. Todo el bot corre en **un solo contenedor Docker** (`argos-dj`) con su propia base SQLite, sin tocar Argos ni Conexy.

Resumen del camino:

1. Crear el bot en Telegram (BotFather)
2. Crear la API key de OpenAI y ponerle un tope de gasto
3. Elegir los modelos y probar la conexión
4. Subir el proyecto al VPS
5. Configurar el `.env` y levantar el contenedor
6. Backup de la base
7. Armar el grupo, meter al bot y empezar a jugar
8. Problemas comunes

---

## 1. Crear el bot en Telegram

En Telegram hablá con **@BotFather**:

1. `/newbot` → nombre visible (por ej. `Argos DJ`) → username que termine en `bot` (por ej. `argos_dj_bot`).
2. Guardá el **token** que te da (`123456:ABC...`). Es la contraseña del bot.
3. Configurá estas opciones (mandá cada comando y elegí tu bot):
   - `/setprivacy` → **Enable**. (El bot no necesita leer todo lo que se charla en el grupo: los jugadores actúan respondiendo al mensaje del DJ o con `/a`. Así además ahorrás tokens y respetás la privacidad.)
   - `/setjoingroups` → **Enable**.
   - `/setdescription` (opcional) → "Director de juego de rol para grupos de amigos."
   - Los comandos los registra el bot solo al arrancar, no hace falta `/setcommands`.
4. Averiguá tu **user id** numérico: hablale a **@userinfobot** y copiá el número. Va en `TELEGRAM_ADMIN_ID`.

## 2. API key de OpenAI

1. Entrá a https://platform.openai.com/api-keys → **Create new secret key** (guardala, se muestra una sola vez).
2. Cargá crédito prepago (Billing) y **poné un límite mensual** (Billing → Limits), por ejemplo US$ 10. Es tu red de seguridad principal; el bot además tiene su propio fusible (ver §8).

## 3. Elegir modelos y precios

El bot usa tres "roles" y cada uno se configura en el `.env`:

| Rol | Para qué | Qué conviene |
|---|---|---|
| `MODELO_NARRADOR` | Narra cada turno (lo que más se usa) | Un modelo de gama media, buen español, buen uso de herramientas |
| `MODELO_UTIL` | Trasfondos, `/radio`, resúmenes, modo económico | El más barato disponible |
| `MODELO_GUIONISTA` | Arma el guion al empezar y el epílogo (2 llamadas por partida) | Igual que el narrador o mejor |

**Importante:** los nombres que vienen en `.env.example` (`gpt-5.4-mini`, `gpt-5.4-nano`) y sus precios son valores de referencia que tomé de fuentes de terceros y **no pude verificarlos contra OpenAI**. Antes de jugar:

1. Mirá qué modelos tenés en https://platform.openai.com/docs/models y los precios en https://openai.com/api/pricing.
2. Ajustá `MODELO_*` y `PRECIO_*` en el `.env` (los precios solo alimentan `/costo` y el fusible; si están mal, el bot calcula mal el gasto, pero funciona).
3. Corré la prueba de conexión (paso 5.4). Te dice si la key y los tres modelos andan, y cuánto costó la prueba (centavos).

**Razonamiento (Responses API).** Por defecto el bot habla con OpenAI por `/responses` (`OPENAI_API=responses`), que deja que el
narrador **piense antes de narrar** aunque use herramientas (por `/chat/completions`, los gpt-5.4 o más nuevos no aceptan
herramientas y razonamiento juntos). El nivel se elige con `OPENAI_REASONING_NARRADOR` (`low` por defecto; `medium` da mejor hilo
narrativo pero tarda y cuesta más, porque los tokens de razonamiento se cobran como salida). Si `/responses` no anda con tu cuenta
o modelo, el bot cae solo a `/chat/completions` y lo deja en el log. `npm run probar-ia` te dice por dónde quedó hablando y cuántos
tokens de razonamiento usó; `/estado` también lo muestra.

Orden de magnitud: con un modelo de gama media, un turno cuesta del orden de **US$ 0,005–0,01**. Una aventura de 4 jugadores × 20 rondas ronda US$ 0,5–1. El bot ordena el prompt para aprovechar el caché de OpenAI y limita las salidas para gastar poco.

## 4. Subir el proyecto al VPS

Elegí **una** de las dos opciones.

### Opción A — Git (recomendada, después actualizás con `git pull`)

En tu PC, dentro de `C:\Users\PC\Documents\vsc\Argos\Argos Recreativo\argos-dj`:

```powershell
git init
git add .
git commit -m "Argos DJ"
git branch -M main
git remote add origin git@github.com:fpediconi/argos-dj.git   # creá antes el repo PRIVADO en GitHub
git push -u origin main
```

En el VPS:

```bash
cd /opt
git clone git@github.com:fpediconi/argos-dj.git
cd argos-dj
```

(Si el VPS todavía no tiene acceso al repo privado, usá el mismo método que usaste para Argos: deploy key o token.)

### Opción B — Copiar la carpeta con scp (sin GitHub)

En tu PC (PowerShell), sin `node_modules` ni `.env`:

```powershell
cd "C:\Users\PC\Documents\vsc\Argos\Argos Recreativo"
tar --exclude=node_modules --exclude=.env --exclude=data -czf argos-dj.tgz argos-dj
scp argos-dj.tgz USUARIO@IP_DEL_VPS:/opt/
```

En el VPS:

```bash
cd /opt && tar -xzf argos-dj.tgz && cd argos-dj
```

## 5. Configurar y levantar

Todo esto en el VPS, dentro de `/opt/argos-dj`.

**5.1 Crear el `.env`**

```bash
cp .env.example .env
nano .env
```

Completá como mínimo:

```
TELEGRAM_TOKEN=el_token_de_botfather
TELEGRAM_ADMIN_ID=tu_user_id
OPENAI_API_KEY=sk-...
MODELO_NARRADOR=...      # los que verificaste en el paso 3
MODELO_UTIL=...
MODELO_GUIONISTA=...
```

Protegelo: `chmod 600 .env`.

**5.2 Construir y arrancar**

```bash
docker compose up -d --build
```

El primer build tarda unos minutos. El contenedor queda limitado a 0,25 CPU y 384 MB de RAM para no pisar a Argos ni a Conexy.

**5.3 Verificar que está vivo**

```bash
docker compose ps                      # debe decir "healthy" a los ~30 s
docker compose logs -f --tail=50       # debe decir "Argos DJ arriba como @tu_bot"
docker exec argos-dj node -e "fetch('http://127.0.0.1:3100/health').then(r=>r.text()).then(console.log)"
```

Cortá los logs con `Ctrl+C` (el bot sigue corriendo).

**5.4 Probar la conexión con OpenAI**

```bash
docker exec argos-dj npm run probar-ia
```

Tiene que mostrar tres ✅ (modelo útil, narrador con herramientas, guionista) y el gasto de la prueba. Si algo da ❌, casi siempre es el nombre de un modelo o la key: corregí el `.env` y hacé `docker compose up -d` (recrea el contenedor con el `.env` nuevo).

## 6. Backup de la base (recomendado)

La partida entera vive en un archivo SQLite dentro del volumen `dj-data`. Backup diario a las 3:40 (para no chocar con otros crons), con verificación de integridad:

```bash
sudo mkdir -p /opt/backups/argos-dj
sudo tee /opt/argos-dj/backup.sh >/dev/null <<'EOS'
#!/bin/bash
set -e
DEST=/opt/backups/argos-dj
F=$DEST/dj-$(date +%F).sqlite
docker exec argos-dj node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/dj.sqlite');d.exec(\"VACUUM INTO '/data/backup.sqlite'\")"
docker cp argos-dj:/data/backup.sqlite "$F"
docker exec argos-dj rm -f /data/backup.sqlite
gzip -f "$F" && gzip -t "$F.gz"
find $DEST -name 'dj-*.gz' -mtime +14 -delete
EOS
sudo chmod +x /opt/argos-dj/backup.sh
( crontab -l 2>/dev/null; echo '40 3 * * * /opt/argos-dj/backup.sh >> /opt/backups/argos-dj/backup.log 2>&1' ) | crontab -
```

Probalo una vez a mano: `/opt/argos-dj/backup.sh && ls -la /opt/backups/argos-dj`.

Para restaurar: `docker compose down`, descomprimí el `.gz`, copialo sobre `/data/dj.sqlite` del volumen (`docker cp`), y `docker compose up -d`.

## 7. A jugar: grupo, bot y primera partida

**7.1 Armar el grupo**

1. En Telegram creá un **grupo** (o usá uno existente) e invitá a tus amigos. Sirve el grupo normal o supergrupo; los temas (foros) también funcionan y el bot usa el tema donde escribas `/nueva`.
2. Agregá al bot por su username (`@argos_dj_bot`). Va a saludar solo.
3. **Hacelo administrador** (Ajustes del grupo → Administradores → el bot) con permiso de **fijar mensajes**. Es opcional, pero así deja el *tablero* de la partida fijado arriba. No hace falta ningún otro permiso.

**7.2 Configurar la historia (solo el anfitrión, quien escribe `/nueva`)**

Escribí `/nueva` en el grupo. El bot arma un asistente con botones, en un solo mensaje que se va editando:

1. Escenario (Yermo clásico, costa post-nuclear estilo Mar del Plata, Refugio 88 o sorpresa)
2. Tono (oscuro, humor negro, absurdo)
3. Duración (one-shot, mini-campaña de 4 capítulos, abierta)
4. Plazo por turno (12 h, 24 h recomendado, 48 h, sin plazo)
5. Letalidad (suave, normal, hardcore)
6. Temas a evitar
7. Horas de silencio (de 00 a 08 hora argentina el reloj de los turnos se pausa)

**7.3 Crear los personajes (cada jugador, por privado)**

1. El bot publica un botón **🧑‍🚀 Crear mi personaje**. Cada jugador lo toca: se abre el chat privado con el bot y toca **Iniciar** (Telegram exige que el usuario le escriba primero al bot; por eso el botón).
2. Ahí eligen modo (rápido o entrevista), **origen**, **arquetipo** (soldado, explorador, cara, técnico, médico, sigiloso; o "armarlo a mano"), ajustan atributos S.P.E.C.I.A.L. y habilidades si quieren, escriben nombre, aspecto, una frase y tres respuestas de trasfondo, y eligen arma. Son unos 3 minutos y casi todo con botones.
3. Cada vez que alguien termina, el grupo se entera y el tablero se actualiza.

**7.4 Empezar**

Cuando estén los que van a jugar, el anfitrión toca **▶️ Empezar** en el tablero (o `/empezar`). El DJ arma el guion (una llamada más cara, una sola vez), abre la escena y le da el primer turno a un jugador.

**7.5 Cómo se juega**

- En tu turno, **respondé al mensaje del DJ** (deslizá / "Responder") o escribí `/a lo que hacés`. Los mensajes sueltos del grupo no gastan tokens.
- Si hace falta una prueba, aparece **🎲 Tirar**; podés gastar Suerte o Impulso del grupo para sumar un dado.
- En combate hay botones: 🔫 Atacar, 🛡️ Cubrirse, 🩹 Usar objeto, 🤝 Levantar aliado, 💬 Acción libre.
- Si volvés de un rato sin jugar: `/resumen` (gratis, sin IA) o `/radio` (resumen narrado, barato).
- Si no vas a estar: `/ausente 3d` (el grupo sigue sin vos), `/volver`, o `/pasar` para ceder un turno.
- Si un jugador no aparece, cuando su turno vence cualquiera propone `/saltear`: se abre una votación y, si la mayoría de los demás dice que sí, se saltea. Si el afectado juega antes, se cancela. Si pasan 3× el plazo sin señales, el DJ lo salta solo.
- `/ficha`, `/inventario`, `/donde`, `/misiones`, `/regla <tema>`, `/tiradas`, `/costo`, `/pausa`, `/reanudar`, `/fin`, `/libro` (exporta la crónica de la aventura en Markdown).

**Prueba antes con amigos:** armá un grupo de dos (vos y un amigo o una segunda cuenta), hacé una partida one-shot corta y mirá `/costo` al final.

## 8. Costos y fusible de gasto

- `/costo` muestra el gasto real de la partida (calculado con los `PRECIO_*` del `.env`).
- **Fusible automático** por partida (`PRESUPUESTO_PARTIDA_USD`, por defecto 0,5): al 80 % avisa al grupo, al 100 % el DJ pasa al modelo económico, al 200 % se frena esa partida. Hay además un tope diario global (`PRESUPUESTO_GLOBAL_USD`). Subilos en el `.env` si tu grupo juega mucho.
- El límite mensual de OpenAI (paso 2) es la última barrera.

## 9. Mantenimiento

```bash
cd /opt/argos-dj
docker compose logs -f --tail=100        # ver qué pasa
docker compose restart                    # reiniciar (no se pierde nada: el estado está en la base)
git pull && docker compose up -d --build  # actualizar (opción A)
docker compose down                       # apagar (el volumen con las partidas se conserva)
```

Si el contenedor se reinicia en medio de un turno, el bot lo detecta al arrancar y pone un botón **🔄 Reintentar** en el grupo; la acción del jugador no se pierde.

`/estado` (solo vos, el admin) muestra partidas abiertas, gasto del día y si OpenAI está yendo por `/responses` o `/chat/completions`.

**Después de actualizar a la versión de narrativa (octubre 2026):** sumá al `.env` del VPS (o copiá las líneas de `.env.example`):
`OPENAI_API=responses`, `OPENAI_REASONING_NARRADOR=low` y `AUDITOR=auto`. Si no las ponés, esos son igual los valores por defecto.
Antes de jugar con amigos: `docker compose exec argos-dj npm run probar-ia` y `docker compose exec argos-dj npm run probar-coherencia`
(una partida de 20 turnos con IA real, centavos). Las partidas en curso se migran solas.

## 10. Problemas comunes

| Síntoma | Causa probable y solución |
|---|---|
| El bot no responde nada | `docker compose logs`: ¿token mal copiado? ¿Hay otro proceso usando el mismo token (por ej. corriste el bot en tu PC)? Un token solo puede tener un consumidor de `getUpdates`. |
| "Falta TELEGRAM_TOKEN" al arrancar | El `.env` no está en `/opt/argos-dj` o quedó vacío. Recreá con `docker compose up -d`. |
| Al tocar "Crear mi personaje" el bot no escribe | El jugador tiene que tocar **Iniciar** en el chat privado; Telegram no deja que un bot escriba primero. |
| En el grupo el bot no ve mi respuesta | Tenés que **responder al mensaje del DJ** (o usar `/a ...`). Con `/setprivacy` en *Enable* el bot no lee charla suelta. |
| "No pude armar el mundo" / errores de IA | Modelo mal escrito, sin crédito o key inválida. Corré `docker exec argos-dj npm run probar-ia`. Después tocá **▶️ Empezar** de nuevo. |
| No se fija el tablero | Falta el permiso de fijar mensajes. Es opcional. |
| El grupo se convirtió en supergrupo | Lo maneja el bot solo (migración automática de chat). |
| Se cortó justo mientras narraba | Botón **🔄 Reintentar** en el grupo. |
| Quiero cambiar de modelo | Editá `.env` y `docker compose up -d`. Las partidas en curso siguen. |

## Nota legal

Fallout es marca de Bethesda y el sistema 2d20 es de Modiphius. Este proyecto es de uso privado y sin fines de lucro, con reglas propias simplificadas ("Yermo Lite") inspiradas en ese estilo. No lo publiques ni lo cobres.
