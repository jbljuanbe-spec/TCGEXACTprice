# Servidor de sala online (Cloudflare Worker)

Backend de la sala online (varios jugadores, cada uno en su dispositivo, adivinando a la vez). Un Durable Object por sala — guarda su estado, decide qué carta toca y calcula los puntos, para que nadie pueda ver el precio antes de tiempo. No usa D1: el estado de una sala vive en el propio Durable Object mientras dura la partida.

## Desplegar

Necesitas una cuenta de Cloudflare (gratis) y `wrangler` (ya está en `devDependencies`).

```bash
cd worker
npx wrangler login      # una vez, abre el navegador
npx wrangler deploy
```

Al terminar te da una URL del tipo `https://pokemon-precio-justo-sala.<tu-subdominio>.workers.dev`.

Copia esa URL en `../sala.js`, constante `SALA_SERVER_URL` (línea 7), y vuelve a publicar el sitio estático (GitHub Pages). Sin ese paso, el botón "Sala online" del juego avisa de que el servidor no está configurado — no rompe el resto del juego (modo mismo dispositivo sigue funcionando igual).

## Probar en local sin desplegar

```bash
cd worker
npx wrangler dev
```

Levanta el worker en `http://localhost:8787` (Durable Objects simulados en local, sin tocar tu cuenta de Cloudflare). Para probarlo con la web, cambia temporalmente `SALA_SERVER_URL` en `sala.js` a `http://localhost:8787` y sirve `pokemon-precio-justo/` con cualquier servidor estático (`python3 -m http.server`, por ejemplo).

## Cómo funciona

- `GET /crear` — genera un código de sala de 4 caracteres (sin 0/O ni 1/I/L, para que se pueda dictar en voz alta) y lo devuelve. No crea nada todavía: el Durable Object se crea solo la primera vez que alguien se conecta a `/sala/<codigo>`.
- `GET /sala/<codigo>` (con cabecera `Upgrade: websocket`) — conecta a la sala. El primer jugador en entrar es el anfitrión (host); puede elegir el número de rondas y arrancar la partida. Los demás solo juegan.
- El worker pide las cartas a pokemontcg.io **él mismo** (no el navegador de cada jugador): así todos ven la misma carta, y el precio no viaja al cliente hasta la fase de revelado. Reutiliza la misma estrategia de lotes + reintentos que el modo local (ver `LOGICA.md` en la carpeta de arriba).
- Cada ronda, el servidor espera a que **todos los jugadores conectados** manden su estimación (mensaje `adivinar`) y entonces calcula puntos y revela — no hay temporizador; si alguien tarda mucho, la ronda simplemente espera.
- Si un jugador pierde la conexión (wifi, el móvil se bloquea…), el cliente reintenta solo cada 2s con el mismo id de jugador (guardado en `localStorage`), y recupera su sitio en la sala con su puntuación y su respuesta de esa ronda intactas si aún no se había revelado.

## Limitación conocida

Un código de sala no "existe" de forma independiente — se crea el momento en que alguien se conecta a él. Si alguien teclea mal el código al unirse, no le sale un error de "sala no encontrada": entra silenciosamente a una sala nueva y vacía. Para una partida entre amigos que se pasan el código de viva voz no suele ser un problema real (se nota enseguida que no hay nadie más), pero si en algún momento molesta, se podría arreglar registrando los códigos activos en un Workers KV con expiración y comprobándolo antes de conectar.

## Probado

Antes de subir este worker se probó de punta a punta con `wrangler dev` en local (Durable Object real, API de cartas simulada): 2 jugadores por WebSocket directo (protocolo) y también a través de la interfaz real con Playwright (2 pestañas de navegador) — lobby, ronda simultánea sin fugas de precio, revelado con puntos correctos, desconexión de un jugador a media ronda, reconexión con el mismo id conservando la respuesta ya dada, y partida completa hasta el ranking final. No se ha probado contra la API real de pokemontcg.io ni contra Cloudflare en producción (esta sesión no tiene acceso a ninguna de las dos) — conviene jugar una partida real de verdad tras desplegar.
