# Precio Justo Pokémon

Adivina el precio de mercado de Cardmarket de una carta Pokémon al azar, por rondas. Dos modos:
- **Mismo dispositivo**: 1 a 4 jugadores pasándose el móvil/portátil (hotseat).
- **Sala online**: cada jugador desde su propio dispositivo, con un código de sala, adivinando todos a la vez.

Jugar: https://jbljuanbe-spec.github.io/ITEX-GAME/pokemon-precio-justo/

## Cómo funciona
- Cada ronda pide una carta aleatoria con precio a la API pública de [pokemontcg.io](https://pokemontcg.io), que incluye los precios de Cardmarket (`cardmarket.prices`).
- Cada jugador introduce su estimación en euros.
- Al revelar, se compara con el precio real (`trendPrice`, o `averageSellPrice` si no hay trend) y se reparten puntos según el error: 100 pts si aciertas exacto, 0 pts si el error es ≥100%.
- Tras el número de rondas elegido, gana quien más puntos acumule.

## Estructura
`index.html`, `style.css`, `game.js` (modo mismo dispositivo), `sala.js` (modo sala online). Sitio estático sin dependencias — el modo local pide las cartas directamente desde el navegador del jugador.

El modo sala online necesita un pequeño backend (Cloudflare Worker + Durable Objects) para poder sincronizar a los jugadores en tiempo real — está en `worker/`, con sus propias instrucciones de despliegue en `worker/README.md`. Sin desplegarlo, el modo mismo dispositivo funciona igual que siempre; solo el botón de sala online avisa de que falta configurar el servidor.

## Rendimiento y fiabilidad
Pedir una carta por ronda (con `page` aleatorio y `pageSize=1`) era lento. Ahora se piden lotes de 50 cartas sin filtro de servidor, se filtran en el cliente las que tienen precio de Cardmarket, y se guardan en una cola local; la mayoría de partidas (5-15 rondas) se juegan enteras con 1-2 lotes.

La API de pokemontcg.io no tiene SLA y da error 500 o timeout de vez en cuando, sobre todo sin API key. Por eso cada petición reintenta con backoff (hasta 3 intentos) y, si el lote sigue fallando, cae a pedir una carta suelta antes de rendirse. Si el error 500 persiste siempre (no de forma intermitente), es la API la que está caída — revisar `LOGICA.md` y la consola del navegador para el detalle exacto (status/cuerpo de la respuesta).

## Notas
- La API de pokemontcg.io no requiere clave para uso puntual (límite ~30 peticiones/min). Si se juega mucho, se puede añadir una API key gratuita como cabecera `X-Api-Key`.
