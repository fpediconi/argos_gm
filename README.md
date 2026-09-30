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
```

Requiere Node 22.13+ (usa `node:sqlite`). Sin dependencias en producción salvo `tsx`.

## Estructura

- `src/motor/` reglas puras (dados, personaje, combate, turnos, votaciones), sin IA ni red
- `src/dj/` cerebro OpenAI (function calling), prompts, presupuesto
- `src/telegram/` API, teclados, textos, router
- `src/juego/` orquestación (setup, creación, turnos, combate, votos, planificador)
- `src/universos/fallout/` datos del universo (`universo.json`, `estilo.md`); para otro universo, crear otra carpeta
- `scripts/` simulador y prueba de IA · `tests/` pruebas
