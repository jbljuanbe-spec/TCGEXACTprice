# Precio Justo Pokémon

Adivina el precio de mercado de Cardmarket de una carta Pokémon al azar, por rondas. Dos modos:
- **Mismo dispositivo**: 1 a 4 jugadores pasándose el móvil/portátil.
- **Sala online**: cada jugador desde su dispositivo, con un código de sala, adivinando todos a la vez.

Un único Cloudflare Worker sirve la web y la sala online desde el mismo dominio, así que no hay ninguna URL que configurar.

## Estructura
```
public/          la web (index.html, style.css, game.js, sala.js)
src/index.js     el Worker: /crear y /sala/<codigo> (Durable Object por sala)
wrangler.toml    config de Cloudflare (assets = public/, Durable Object SALAS)
LOGICA.md        cómo funciona el juego por dentro
```

## Desplegar
Desde la raíz del repo:

```bash
npm install
npx wrangler login     # solo la primera vez
npx wrangler deploy
```

Al terminar, wrangler imprime la URL (`https://pokemon-precio-justo-sala.<tu-subdominio>.workers.dev`). Copia esa, no la escribas a mano: el subdominio es el de tu cuenta de Cloudflare (Workers & Pages → tu cuenta → subdominio workers.dev), no tiene por qué coincidir con tu usuario de GitHub.

Con la integración de Git de Cloudflare (Workers & Pages → Create → Import a repository) funciona igual: directorio raíz `/`, comando de deploy `npx wrangler deploy`.

## Probar en local
```bash
npx wrangler dev
```
Abre `http://localhost:8787`: misma web y misma sala, con el Durable Object simulado en local.

## Datos
Cartas e imágenes de [TCGdex](https://tcgdex.dev) (API gratuita, sin clave), precios de Cardmarket incluidos en la propia API. El modo mismo dispositivo los pide desde el navegador; en la sala online los pide el Worker, para que todos vean la misma carta y nadie vea el precio antes de tiempo. Detalle en `LOGICA.md`.

## Limitación conocida
Un código de sala se crea en cuanto alguien se conecta a él. Si alguien teclea mal el código, entra a una sala nueva vacía en vez de recibir un error.
