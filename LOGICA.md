# Lógica del juego — Precio Justo Pokémon

Documento de referencia de cómo funciona el juego por dentro, para pensar el apartado gráfico sin romper la mecánica.

## Objetivo
Adivinar el precio de mercado (Cardmarket) de una carta Pokémon mostrada al azar. Gana quien acumule más puntos tras varias rondas.

## Fuente de datos
- API pública y gratuita: `https://api.pokemontcg.io/v2/cards` (sin clave, sin coste).
- Por cada carta interesan: `name`, `set.name`, `rarity`, `images.large` / `images.small`, y el precio en `cardmarket.prices.trendPrice` (si no existe, se usa `cardmarket.prices.averageSellPrice`).
- No toda carta tiene precio de Cardmarket (promos, cartas muy nuevas...), así que se descartan las que no lo tienen.

## Carga de cartas (rendimiento)
Pedir 1 carta por ronda con página aleatoria era lento (paginación profunda). Un filtro de precio en el servidor (`q=cardmarket.prices...`) también daba error 500 y se quitó. Solución actual:
1. Al abrir la app (pantalla de configuración) y cada vez que la cola de cartas baja de `REFILL_THRESHOLD` (5), se pide en segundo plano un **lote de 50 cartas** (`BATCH_SIZE`) de una página aleatoria, sin filtro de servidor. (Se probó con lotes de 250 pero provocaban 500 con más frecuencia — 50 es un punto intermedio razonable.)
2. Ese lote se filtra en el cliente (solo cartas con precio) y se mezcla (`shuffle`) en una cola local (`state.cardQueue`).
3. Cada ronda simplemente saca la siguiente carta de la cola (`shift()`) — normalmente ya está en memoria, sin esperar red.
4. Mientras se muestra una carta, se precargan (`new Image()`) las imágenes de las 2 siguientes de la cola, para que al pasar de ronda ya estén en caché del navegador.
5. Con 5-15 rondas por partida, casi siempre bastan 1-2 lotes para toda la partida.

**Reintentos:** la API de pokemontcg.io no tiene SLA y falla de forma intermitente (500, timeout). `fetchJSON` reintenta cada petición hasta 3 veces con backoff exponencial (400ms, 800ms) y aborta si tarda más de 8s. Si aun así el lote falla, `loadCard` cae a `fetchSingleCard` (pide 1 sola carta, petición más pequeña y con más probabilidad de responder) antes de mostrar el error final. Si el error persiste siempre y no de forma intermitente, es que la API está caída de verdad, no un bug del juego.

**Percepción de la espera:** mientras se carga (haya o no reintentos de por medio), en vez de un simple "Cargando...":
- `#card-skeleton` muestra un bloque gris pulsante con el tamaño de una carta (`style.css`, animación `skeleton-pulse`), en vez de un hueco vacío o un icono de imagen rota.
- `#card-meta` rota entre `LOADING_MESSAGES` cada 3s ("Buscando una carta al azar...", "Consultando el precio en Cardmarket...", "Casi lista...") para transmitir que el proceso avanza, no que se ha colgado.
- La imagen no se muestra hasta que termina de descargarse (`waitForImage`, con `img.onload`/`onerror`), así no hay parpadeo de imagen a medio cargar.

Si algún día se quiere garantizar variedad entre partidas distintas, el lote se pide de una página aleatoria dentro del total de cartas, así que cambia entre partidas.

## Flujo de pantallas
`index.html` tiene un selector de modo (`#screen-modo`) y luego dos flujos de pantallas independientes que nunca coexisten visibles (todo con `hidden`):

**Modo mismo dispositivo** (`game.js`):
1. **`#screen-setup`** — configuración: número de jugadores (1-4), nombre de cada uno, número de rondas (5/10/15). Botón "Empezar partida".
2. **`#screen-round`** — la ronda en curso:
   - `#card-image` + `#card-meta`: imagen y datos de la carta (nombre, set, rareza). Precio oculto.
   - `#guess-form`: un input numérico por jugador activo, para su estimación en euros.
   - Botón "Revelar precio" → calcula y muestra `#reveal-area` (precio real + puntos de cada jugador) y cambia a botón "Siguiente carta".
3. **`#screen-final`** — ranking ordenado por puntuación total, botón "Jugar de nuevo" (vuelve a `#screen-setup` sin perder nada del histórico de la página).

Aparte, `#error-box` (fuera de las secciones) se muestra si falla la carga de una carta, con botón "Reintentar".

**Modo sala online** (`sala.js`, ver sección propia más abajo): `#screen-online-setup` → `#screen-lobby` → `#screen-online-round` → `#screen-online-final`, con `#online-error-box` para fallos de conexión.

## Estado del juego (`state` en `game.js`)
```
state = {
  numPlayers,                   // elegido en el selector de la pantalla de configuración
  numRounds,                    // idem, antes de empezar la partida
  players: [{ name, score }],   // uno por jugador, fijado al pulsar "Empezar partida"
  totalRounds,                  // = numRounds en el momento de empezar
  currentRound,                 // ronda actual (1-indexed)
  totalCardCount,               // total de cartas en la API (se cachea una vez)
  currentCard,                  // objeto carta de la API mostrado ahora mismo
  currentPrice,                 // precio real de la carta actual (número)
  cardQueue,                    // cola local de { card, price } ya descargados
}
```
No hay backend ni persistencia entre partidas: todo vive en memoria de la pestaña. Al recargar la página se pierde el progreso.

## Modos de juego
No hay un "modo solo" separado en el código: 1 jugador es simplemente `players.length === 1`. La mecánica de puntuación es la misma para 1 o para 4 — en solitario, el objetivo pasa a ser superar tu propia puntuación de partidas anteriores (no hay comparación entre jugadores).

Es **hotseat**: todos los jugadores están delante de la misma pantalla y meten su estimación en el mismo formulario antes de revelar. No hay turnos ocultos ni pantallas separadas por jugador.

## Puntuación
Por ronda, cada jugador recibe puntos según lo cerca que quede su estimación del precio real, independientemente de los demás jugadores:

```
error% = |estimación - precio_real| / precio_real * 100
puntos = max(0, round(100 - error%))
```

- Acertar exacto → 100 puntos.
- Error del 50% → 50 puntos.
- Error ≥100% → 0 puntos.

Es una puntuación absoluta (no relativa a los rivales), así que funciona igual con 1 o con 4 jugadores. En pantalla se resalta (`.winner`) a quien más puntos saca esa ronda, pero no le quita puntos a nadie. Al final se suman los puntos de todas las rondas y se ordena el ranking.

## Diseño visual
Sistema de tokens en `style.css` (mismo patrón que Hazte con Todos): variables de color en `:root` (`--fondo`, `--panel`, `--tinta`, `--suave`, `--rojo`, `--oro`, `--verde`, `--azul`, `--radio`, `--sombra`), redefinidas bajo `prefers-color-scheme: dark` y bajo `:root[data-tema="oscuro"]` para el toggle manual. Cambiar la paleta es solo tocar esas variables, no hay colores sueltos por el CSS.

Tipografías (Google Fonts, cargadas en `index.html`, con fallback a fuentes del sistema si no cargan):
- `--f-display` (Pixelify Sans): títulos, botones, cifras grandes.
- `--f-cuerpo` (Space Grotesk): texto normal.
- `--f-mini` (Silkscreen): etiquetas pequeñas en mayúsculas (`.field-label`, `.badge`).

`game.js` genera estructura dinámica en:
- `#player-names`: una `.player-name-row` (avatar circular con el número + input) por jugador.
- `#guess-form`: una `.guess-row` (label + `.input-euro` con el símbolo € superpuesto) por jugador, cada ronda.
- `#scoreboard`: un `.score-chip` por jugador con su puntuación total, actualizado al empezar cada ronda y al revelar; el/los que van primero llevan la clase `.leader`.
- `#reveal-area`: precio real destacado (`.real-price .amount`, en dorado) + una `.result-row` por jugador (`.winner` si ganó la ronda).
- `#final-ranking`: igual que `#reveal-area` pero con `.rank` (#1, #2...) delante del nombre.

El número de jugadores y de rondas ya no son `<select>`: son controles segmentados (`.segmented` + `.segmented-option[aria-pressed]`) en `#players-picker` y `#rounds-picker`, con el valor elegido en `state.numPlayers` / `state.numRounds`.

Toggle de tema: botón `#btn-theme` alterna `data-tema="claro"/"oscuro"` en `<html>` y lo guarda en `localStorage` (clave `ppj-tema`); sin elección manual, sigue el tema del sistema.

## Modo sala online
Además del hotseat, cada jugador puede jugar desde su propio dispositivo (móvil, portátil...) con un código de sala de 4 caracteres, todos adivinando la misma carta a la vez. Necesita un backend — ver `worker/README.md` para desplegarlo. `sala.js` reutiliza `el()`, `wireSegmented()` y las referencias a las pantallas del modo local (`screenSetup`, etc.) que `game.js` deja en el ámbito global del script — por eso `game.js` se carga antes que `sala.js` en `index.html`.

**Por qué el servidor pide las cartas, no el navegador de cada jugador:** si cada cliente pidiera su propia carta, dos jugadores en la misma sala podrían acabar viendo cartas distintas, y cualquiera podría abrir las herramientas de desarrollador y ver el precio en la respuesta de la API antes de adivinar. El Worker (`worker/src/index.js`) hace exactamente lo mismo que hacía el cliente en modo local (lotes de 50 cartas, reintentos con backoff — ver la sección "Carga de cartas" de arriba) pero él es quien decide la carta y guarda el precio; a los jugadores solo les llega el precio cuando la ronda pasa a fase `revelado`.

**Arquitectura:** un Durable Object de Cloudflare (`SalaJuego`) por código de sala (`env.SALAS.idFromName(codigo)`), sin base de datos — el estado vive en `this.state.storage` mientras dura la partida. Cada jugador abre un WebSocket a `/sala/<codigo>`; el servidor es la única fuente de verdad y, ante cualquier cambio, difunde el estado completo a todos los conectados (`difundir()`) — no hay diffs ni parches, cada mensaje `estado` es un snapshot autosuficiente, así que un cliente que se ha perdido un mensaje se pone al día con el siguiente sin lógica especial.

**Fases de una sala** (`sala.fase`): `lobby` (esperando jugadores, el anfitrión configura rondas) → `ronda` (carta visible, precio oculto, cada uno manda su estimación) → `revelado` (precio + estimaciones + puntos de todos, el anfitrión pasa a la siguiente) → `final`. `cargarSiguienteCarta()` es el único sitio donde se pone `fase = 'ronda'`, tanto al empezar la partida como en cada "siguiente carta" — ojo si se toca, un bug ahí (fase que no vuelve a `ronda`) deja la sala congelada en `revelado` a partir de la ronda 2 (así se encontró, ver commit).

**Anfitrión (host):** el primer jugador en conectar (`sala.hostId`), no cambia aunque se desconecte — no hay traspaso de anfitrión. Solo el host puede mandar `configurar`, `empezar` y `siguiente`; el servidor ignora esos mensajes de cualquier otro `jugadorId` (`esHost` se comprueba en cada mensaje).

**Quién completa una ronda:** el servidor no espera a "todos los jugadores de la sala", solo a los que tienen `conectado: true` en ese momento (`registrarEstimacion`). Si alguien se desconecta a media ronda, el resto no se queda esperando indefinidamente — la ronda se resuelve solo con los que siguen conectados en cuanto todos ellos han respondido.

**Reconexión:** el cliente genera un id (`crypto.randomUUID()`, lo manda el propio servidor en el mensaje `tu-id`) y lo guarda en `localStorage` por código de sala (`ppj-sala-id-<codigo>`). Si el WebSocket se cierra sin que el jugador haya pulsado "volver" (`sala.js`, `cerrandoIntencionalmente`), reintenta solo a los 2s con el mismo id — el servidor lo reconoce (`this.sala.jugadores[jugadorId]` ya existe), actualiza `conectado: true` y el jugador recupera su puntuación y, si la ronda seguía abierta, su estimación ya enviada.

**Antitrampas:** `snapshotPublico()` (en el worker) solo incluye `precio` y `estimaciones` cuando `fase` es `revelado` o `final`; durante `ronda` cada jugador solo sabe *quién* ha respondido (`respondio: true/false`), nunca el valor. Verificado explícitamente en las pruebas (ver abajo): un jugador no puede ver ni el precio ni la estimación de otro antes de que la ronda se revele.

**Limitación conocida:** un código de sala no se valida contra una lista de salas existentes — se crea el momento en que alguien se conecta a él (`idFromName` de Durable Objects es así: perezoso). Si alguien teclea mal el código, no hay error de "sala no encontrada": entra a una sala nueva vacía, sin más jugadores. Aceptable para jugar con amigos que se dictan el código en voz alta; si molestara, se arreglaría registrando los códigos activos en un Workers KV con expiración.

**Probado con `wrangler dev` en local** (Durable Object real, API de cartas simulada, sin tocar Cloudflare ni la red real): protocolo WebSocket puro (2 clientes simulados) y también la interfaz real con 2 pestañas de navegador (Playwright) — lobby con 2 jugadores, ambos ven la misma carta, ninguno ve el precio ni la respuesta del otro antes de tiempo, revelado con puntos correctos, solo el host ve "siguiente carta", desconexión de un jugador a media ronda (la sala no se queda esperándolo), reconexión con el mismo id conservando puntuación y estimación ya enviada, y partida completa hasta el ranking final. No probado contra pokemontcg.io real ni contra Cloudflare en producción — recomendable jugar una partida real tras desplegar.
