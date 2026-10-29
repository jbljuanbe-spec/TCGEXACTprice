const API_BASE = 'https://api.tcgdex.net/v2/en';
const BATCH_SIZE = 12;
const CODIGO_ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I/L, se lee fácil en voz alta

function generarCodigo() {
  let codigo = '';
  for (let i = 0; i < 4; i++) codigo += CODIGO_ALFABETO[Math.floor(Math.random() * CODIGO_ALFABETO.length)];
  return codigo;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJSON(url, intentos = 3) {
  let ultimoError;
  for (let intento = 0; intento < intentos; intento++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      ultimoError = new Error(`API respondió ${res.status}`);
    } catch (err) {
      ultimoError = err;
    }
    if (intento < intentos - 1) await sleep(400 * 2 ** intento);
  }
  throw ultimoError;
}

function cardConPrecio(card) {
  const precio = card?.pricing?.cardmarket?.trend || card?.pricing?.cardmarket?.avg;
  return precio && card?.image ? { card, precio } : null;
}

function mezclar(lista) {
  for (let i = lista.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [lista[i], lista[j]] = [lista[j], lista[i]];
  }
  return lista;
}

// `GET /cards` devuelve el resumen de TODAS las cartas de TCGdex (~20.000,
// varios MB). Parsear eso no cabe en los 10 ms de CPU de un Worker gratuito.
// En su lugar: listado de expansiones (pequeño, cacheado en el isolate), una
// expansión al azar ponderada por su número de cartas (así cada carta tiene la
// misma probabilidad que antes) y solo las cartas de esa expansión.
let expansionesCache = null;

async function expansionesConCartas() {
  if (expansionesCache) return expansionesCache;
  const sets = await fetchJSON(`${API_BASE}/sets`);
  const utiles = (Array.isArray(sets) ? sets : []).filter(s => s?.id && (s.cardCount?.total ?? 0) > 0);
  if (!utiles.length) throw new Error('La API no devolvió expansiones');
  expansionesCache = utiles;
  return utiles;
}

function expansionAlAzar(sets) {
  const total = sets.reduce((suma, s) => suma + s.cardCount.total, 0);
  let r = Math.random() * total;
  for (const s of sets) {
    r -= s.cardCount.total;
    if (r <= 0) return s;
  }
  return sets[sets.length - 1];
}

async function cartasDeExpansionAlAzar() {
  const sets = await expansionesConCartas();
  // Algunas expansiones antiguas o promocionales no traen precios: si una no
  // da nada, se prueba con otra antes de rendirse.
  for (let intento = 0; intento < 3; intento++) {
    const set = await fetchJSON(`${API_BASE}/sets/${encodeURIComponent(expansionAlAzar(sets).id)}`);
    const candidatos = mezclar((set?.cards ?? []).filter(c => c?.id && c.image)).slice(0, BATCH_SIZE);
    const detalles = await Promise.all(candidatos.map(c =>
      fetchJSON(`${API_BASE}/cards/${encodeURIComponent(c.id)}`, 2).catch(() => null)));
    const conPrecio = detalles.map(cardConPrecio).filter(Boolean);
    if (conPrecio.length) return conPrecio;
  }
  return [];
}

// Camino antiguo, intacto, como red de seguridad: si el nuevo fallara por lo
// que sea, el juego se comporta exactamente como antes de este cambio.
async function cartasDelListadoCompleto() {
  const resumenes = await fetchJSON(`${API_BASE}/cards`);
  const candidatos = mezclar(resumenes.filter(c => c.image)).slice(0, BATCH_SIZE);
  const detalles = await Promise.all(candidatos.map(c => fetchJSON(`${API_BASE}/cards/${c.id}`)));
  return detalles.map(cardConPrecio).filter(Boolean);
}

async function obtenerLoteCartas() {
  try {
    const lote = await cartasDeExpansionAlAzar();
    if (lote.length) return lote;
  } catch {
    // se cae al camino antiguo
  }
  return cartasDelListadoCompleto();
}

function puntosPorEstimacion(valor, real) {
  if (!(real > 0)) return 0;
  const errorPct = Math.abs(valor - real) / real * 100;
  return Math.max(0, Math.round(100 - errorPct));
}

// Una sala = una instancia de este Durable Object (una por código, vía
// idFromName). Guarda su estado en Durable Object storage para sobrevivir
// a reinicios; en memoria solo viven los WebSocket abiertos.
export class SalaJuego {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map(); // jugadorId -> WebSocket
    this.sala = null;
  }

  async cargarSala() {
    if (this.sala) return this.sala;
    const guardada = await this.state.storage.get('sala');
    if (guardada) {
      // Instancia nueva (Cloudflare reinició la sala): los WebSocket de antes
      // ya no existen aunque el almacenamiento diga `conectado: true`. Si no se
      // limpia, la ronda espera para siempre a jugadores fantasma. Quien siga
      // ahí se reconecta solo a los 2 s (sala.js) y vuelve a quedar conectado.
      for (const j of Object.values(guardada.jugadores ?? {})) j.conectado = false;
    }
    this.sala = guardada || {
      fase: 'lobby', // lobby | ronda | revelado | final
      hostId: null,
      totalRondas: 10,
      rondaActual: 0,
      jugadores: {}, // jugadorId -> { nombre, puntuacion, conectado, puntosRonda }
      cartaActual: null,
      precioActual: null,
      estimaciones: {}, // jugadorId -> valor, solo de la ronda en curso
      cardQueue: [],
    };
    return this.sala;
  }

  async guardarSala() {
    await this.state.storage.put('sala', this.sala);
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Sala Precio Justo Pokémon', { status: 200 });
    }

    const url = new URL(request.url);
    const jugadorId = url.searchParams.get('id') || crypto.randomUUID();
    const nombre = (url.searchParams.get('nombre') || 'Jugador').slice(0, 24);

    const pair = new WebSocketPair();
    const [cliente, servidor] = Object.values(pair);
    servidor.accept();

    await this.cargarSala();
    // Si el anfitrión no está conectado, quien entra pasa a serlo: una sala sin
    // nadie que pueda pulsar "empezar" o "siguiente" se queda bloqueada.
    if (!this.sala.hostId || !this.sala.jugadores[this.sala.hostId]?.conectado) this.sala.hostId = jugadorId;
    if (this.sala.jugadores[jugadorId]) {
      this.sala.jugadores[jugadorId].conectado = true;
      this.sala.jugadores[jugadorId].nombre = nombre;
    } else {
      this.sala.jugadores[jugadorId] = { nombre, puntuacion: 0, conectado: true, puntosRonda: null };
    }
    this.sockets.set(jugadorId, servidor);
    await this.guardarSala();

    servidor.addEventListener('message', (ev) => {
      this.mensaje(jugadorId, ev.data).catch(err => this.enviarA(jugadorId, { tipo: 'error', mensaje: err.message }));
    });
    servidor.addEventListener('close', () => this.desconectar(jugadorId));
    servidor.addEventListener('error', () => this.desconectar(jugadorId));

    this.enviarA(jugadorId, { tipo: 'tu-id', id: jugadorId });
    this.difundir();

    return new Response(null, { status: 101, webSocket: cliente });
  }

  async desconectar(jugadorId) {
    this.sockets.delete(jugadorId);
    await this.cargarSala();
    if (this.sala.jugadores[jugadorId]) {
      this.sala.jugadores[jugadorId].conectado = false;
      if (this.sala.hostId === jugadorId) {
        const relevo = Object.entries(this.sala.jugadores).find(([, j]) => j.conectado)?.[0];
        if (relevo) this.sala.hostId = relevo;
      }
      // Si quien faltaba por responder era el que se ha ido, la ronda se
      // resuelve ya con los que quedan en vez de esperar a nadie.
      if (this.sala.fase === 'ronda' && this.todosHanRespondido()) {
        await this.revelar();
        return;
      }
      await this.guardarSala();
      this.difundir();
    }
  }

  todosHanRespondido() {
    const conectados = Object.entries(this.sala.jugadores).filter(([, j]) => j.conectado).map(([id]) => id);
    return conectados.length > 0 && conectados.every(id => id in this.sala.estimaciones);
  }

  enviarA(jugadorId, mensaje) {
    const ws = this.sockets.get(jugadorId);
    if (!ws) return;
    try {
      ws.send(JSON.stringify(mensaje));
    } catch (err) {
      // socket roto: se limpiará cuando llegue el evento close
    }
  }

  async mensaje(jugadorId, datos) {
    const msg = JSON.parse(datos);
    await this.cargarSala();
    const esHost = jugadorId === this.sala.hostId;

    if (msg.tipo === 'configurar' && esHost && this.sala.fase === 'lobby') {
      this.sala.totalRondas = [5, 10, 15].includes(msg.rondas) ? msg.rondas : 10;
      await this.guardarSala();
      this.difundir();
    } else if (msg.tipo === 'empezar' && esHost && this.sala.fase === 'lobby') {
      await this.cargarSiguienteCarta(1);
    } else if (msg.tipo === 'adivinar' && this.sala.fase === 'ronda') {
      await this.registrarEstimacion(jugadorId, Number(msg.valor));
    } else if (msg.tipo === 'siguiente' && esHost && this.sala.fase === 'revelado') {
      if (this.sala.rondaActual + 1 > this.sala.totalRondas) {
        this.sala.fase = 'final';
        await this.guardarSala();
        this.difundir();
      } else {
        await this.cargarSiguienteCarta(this.sala.rondaActual + 1);
      }
    }
  }

  // La ronda solo avanza cuando la carta ya está cargada. Antes se sumaba
  // primero, y si la API fallaba el reintento del anfitrión se saltaba una ronda.
  async cargarSiguienteCarta(ronda) {
    try {
      for (let intento = 0; this.sala.cardQueue.length === 0 && intento < 2; intento++) {
        this.sala.cardQueue = await obtenerLoteCartas();
      }
      if (this.sala.cardQueue.length === 0) throw new Error('ninguna carta con precio');
      const { card, precio } = this.sala.cardQueue.shift();
      this.sala.rondaActual = ronda;
      this.sala.cartaActual = {
        nombre: card.name,
        set: card.set?.name || '',
        rareza: card.rarity || 'Rareza desconocida',
        imagen: `${card.image}/high.png`,
      };
      this.sala.precioActual = precio;
      this.sala.fase = 'ronda';
      this.sala.estimaciones = {};
      for (const j of Object.values(this.sala.jugadores)) j.puntosRonda = null;
      await this.guardarSala();
      this.difundir();
      if (this.sala.cardQueue.length < 5) {
        obtenerLoteCartas().then(async (extra) => {
          this.sala.cardQueue.push(...extra);
          await this.guardarSala();
        }).catch(() => {}); // relleno en segundo plano: si falla, se reintenta en la siguiente ronda
      }
    } catch (err) {
      this.difundirError('No se pudo cargar una carta (' + err.message + '). El anfitrión puede reintentar.');
    }
  }

  async registrarEstimacion(jugadorId, valor) {
    if (!Number.isFinite(valor) || valor < 0) return;
    if (!this.sala.jugadores[jugadorId]) return;
    this.sala.estimaciones[jugadorId] = valor;
    await this.guardarSala();

    if (this.todosHanRespondido()) {
      await this.revelar();
    } else {
      this.difundir();
    }
  }

  async revelar() {
    this.sala.fase = 'revelado';
    for (const [jugadorId, valor] of Object.entries(this.sala.estimaciones)) {
      const puntos = puntosPorEstimacion(valor, this.sala.precioActual);
      this.sala.jugadores[jugadorId].puntuacion += puntos;
      this.sala.jugadores[jugadorId].puntosRonda = puntos;
    }
    await this.guardarSala();
    this.difundir();
  }

  snapshotPublico() {
    const revelando = this.sala.fase === 'revelado' || this.sala.fase === 'final';
    return {
      fase: this.sala.fase,
      rondaActual: this.sala.rondaActual,
      totalRondas: this.sala.totalRondas,
      hostId: this.sala.hostId,
      carta: this.sala.cartaActual,
      precio: revelando ? this.sala.precioActual : null,
      estimaciones: revelando ? this.sala.estimaciones : null,
      jugadores: Object.fromEntries(Object.entries(this.sala.jugadores).map(([id, j]) => [id, {
        nombre: j.nombre,
        puntuacion: j.puntuacion,
        conectado: j.conectado,
        puntosRonda: j.puntosRonda,
        respondio: id in this.sala.estimaciones,
      }])),
    };
  }

  difundir() {
    const publico = this.snapshotPublico();
    for (const jugadorId of this.sockets.keys()) {
      this.enviarA(jugadorId, { tipo: 'estado', sala: publico });
    }
  }

  difundirError(mensaje) {
    for (const jugadorId of this.sockets.keys()) {
      this.enviarA(jugadorId, { tipo: 'error', mensaje });
    }
  }
}

function conCors(response) {
  response.headers.set('Access-Control-Allow-Origin', '*');
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/crear') {
      return conCors(Response.json({ codigo: generarCodigo() }));
    }

    const match = url.pathname.match(/^\/sala\/([A-Za-z0-9]{4,8})$/);
    if (match) {
      const id = env.SALAS.idFromName(match[1].toUpperCase());
      const stub = env.SALAS.get(id);
      return stub.fetch(request);
    }

    return new Response('Sala Precio Justo Pokémon — conéctate a /sala/<codigo>', { status: 200 });
  },
};
