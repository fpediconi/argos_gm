# Argos DJ

Game Master de rol por Telegram (Fallout primero). Los jugadores crean su personaje por privado y juegan de forma asincrónica por turnos en un grupo; un motor de reglas decide (dados, combate, salud) y la IA de OpenAI solo narra.

- Guía completa de instalación y uso: **[DEPLOY.md](./DEPLOY.md)**
- Diseño y reglas: `PROYECTO-DJ.md` (en la carpeta padre)

## Desarrollo

```bash
npm install
cp .env.example .env     # completar tokens
npm start                # bot real
npm run verificar        # typecheck + tests + simulación completa sin red
npm run simular          # partida completa con Telegram e IA simulados (muestra el desarrollo)
npm run probar-ia        # prueba tu API key y modelos de OpenAI (gasta centavos)
npm run probar-libertad  # le pasa al narrador real 6 acciones drásticas y marca las que frena (gasta centavos)
```

Requiere Node 22.13+ (usa `node:sqlite`). Sin dependencias en producción salvo `tsx`.

## Estructura

- `src/motor/` reglas puras (dados, personaje, combate, turnos, votaciones, ritmo), sin IA ni red
- `src/dj/` cerebro OpenAI (function calling), prompts, presupuesto
- `src/telegram/` API, teclados, textos, router
- `src/juego/` orquestación (setup, creación, turnos, combate, votos, planificador)
- `src/universos/fallout/` datos del universo (`universo.json`, `estilo.md`); para otro universo, crear otra carpeta
- `scripts/` simulador y prueba de IA · `tests/` pruebas

## Cómo se mueve la historia (director de ritmo)

El motor, no la IA, cuenta los turnos de cada capítulo (`src/motor/ritmo.ts`): objetivo = rondas × jugadores activos
según la duración (sesión corta, one-shot, mini-campaña, abierta). Con eso define la fase (planteo, escalada, giro,
clímax), programa eventos obligatorios con material del guion, avanza solo el reloj de la amenaza y, al llegar al
límite, pide el desenlace y cierra el capítulo aunque la IA no lo marque. En el último capítulo el DJ elige uno de los
finales del guion según lo que pasó. `/final N` cierra la historia en N turnos en cualquier modo.

## Comandos nuevos

- `/party` (o botón 👥 Party): la party con bio pública, sin secretos.
- `/resumen`: siempre muestra los últimos hechos (🆕 lo nuevo), objetivo, lugar, NPC, muertos y relojes. `/donde` es un alias.
- `/votacion pregunta | op1 | op2`: encuesta nativa; el resultado queda como hecho para el DJ. `/cerrar_votacion` la cierra.
- `/config` (anfitrión): cambia tono, duración, plazo (incluye ⚡ Skip directo), letalidad, violencia, traiciones, líneas y velos y silencio con la partida empezada.
- `/final N` (anfitrión): cierra la historia en N turnos.
- Audios: una nota de voz que responde a la tarjeta del turno se transcribe con Whisper y se juega como texto.
- `/limpiar_fijados` (anfitrión): deja fijados solo el tablero y el turno actual.
- Quien pierde su personaje sigue en la ronda como 🎙️ voz del mundo: sugiere rumores, NPC o giros que el DJ usa como inspiración.
- Si no queda nadie en pie, la partida ofrece personajes nuevos (sigue sola) o terminar con epílogo.
- En combate, una acción libre que es un ataque (aunque sea creativo) tira según su dificultad y hace daño real; otras acciones libres (rendirse, huir) pueden terminar el combate.
