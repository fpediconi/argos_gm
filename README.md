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
npm run probar-coherencia [turnos]  # partida real de 20 turnos con métricas de coherencia y lectura en frío (gasta centavos)
npm run transcripcion [archivo]     # partida simulada de punta a punta volcada como la ve cada jugador (revisar UX, gratis)
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

## Narrativa coherente (Canon, Brief y reconciliación)

Diseño completo: doc «Argos GM — Narrativa coherente y personajes vivos». En corto:

- **Canon** (`src/motor/canon.ts`): NPC con peso (principal/secundario/extra), rol, deseo, miedo, voz, relación con cada PJ y agenda;
  lugares y facciones; **hilos** (preguntas abiertas con tope por fase); **escena** con pregunta dramática y NPC presentes;
  **hechos** con visibilidad (`mesa` / `dj` / `pj:N`, tabla `hechos`). El guion siembra el Canon al empezar.
- **Brief del turno** (`src/dj/contexto.ts`): MESA (persona → PJ, quién juega y quién sigue), acto e hitos, escena, NPC en
  escena y fuera de escena, hilos, presupuesto de cosas nuevas, lista EVITAR (antagonista fuera del giro, radios y
  altavoces, golpes repetidos, NPC omnipresentes), arco personal, libreta del DJ y lo que el motor aplicó el turno anterior.
- **Reconciliación** (`src/motor/coherencia.ts`, `src/juego/narrativa.ts`): cada narración se ensaya sobre copias del estado
  y un auditor barato lista lo que afirma. Lo legítimo que falta se aplica; lo grave (un PJ que muere sin tirada, decidir
  por otro jugador, un muerto que habla, un NPC nuevo sin presupuesto) se repara antes de mostrarse.
- **Memoria en capas**: el capítulo en curso se resume desde sus crónicas; los capítulos cerrados quedan congelados.
- **Actos con hitos**: el acto avanza por lo que pasa; si el ritmo aprieta, el hito pendiente se vuelve evento.
- **Frentes**: las agendas de NPC y facciones avanzan cada ronda y sus logros llegan como consecuencias visibles.
- **Personajes**: ficha ampliada (sub-origen, extras, rasgos y taras, personalidad, objetivo, miedo, secreto, mentira, lazos),
  Hub de ficha no lineal, creación guiada por entrevista, arcos de 3 beats, secretos con estado, información privada,
  última oportunidad con cicatriz, legado al morir y duelo antes del reemplazo.
- OpenAI por `/responses` (por defecto): el narrador razona aunque use herramientas (`OPENAI_REASONING_NARRADOR`, `low`);
  si no está disponible cae solo a `/chat/completions`. `AUDITOR=auto|siempre|nunca`.

## Comandos nuevos

- `/dj` (o botón ❓): preguntarle al DJ entre turnos sin gastar el turno. Botones sin IA (quién es quién, qué buscamos,
  qué pasó, dónde estamos) o una pregunta libre que responde la IA barata **solo con lo que el personaje sabe**.
  Por privado, cualquier texto es una pregunta al DJ.
- `/fe_de_erratas texto` (anfitrión): deja un hecho que corrige la historia; el DJ lo toma como verdad.

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
