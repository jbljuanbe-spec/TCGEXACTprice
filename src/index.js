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

// Misma estrategia que el cliente: un lote grande de una página aleatoria en
// vez de 1 carta por ronda (paginación profunda de la API es lenta y poco fiable).
async function obtenerLoteCartas() {
  const resumenes = await fetchJSON(`${API_BASE}/cards`);
  const candidatos = resumenes.filter(c => c.image).sort(() => Math.random() - 0.5).slice(0, BATCH_SIZE);
  const detalles = await Promise.all(candidatos.map(c => fetchJSON(`${API_BASE}/cards/${c.id}`)));
  return detalles.map(cardConPrecio).filter(Boolean);
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
    if (!this.sala.hostId) this.sala.hostId = jugadorId;
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
      await this.guardarSala();
      this.difundir();
    }
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
      this.sala.rondaActual = 1;
      await this.cargarSiguienteCarta();
    } else if (msg.tipo === 'adivinar' && this.sala.fase === 'ronda') {
      await this.registrarEstimacion(jugadorId, Number(msg.valor));
    } else if (msg.tipo === 'siguiente' && esHost && this.sala.fase === 'revelado') {
      this.sala.rondaActual++;
      if (this.sala.rondaActual > this.sala.totalRondas) {
        this.sala.fase = 'final';
        await this.guardarSala();
        this.difundir();
      } else {
        await this.cargarSiguienteCarta();
      }
    }
  }

  async cargarSiguienteCarta() {
    try {
      if (this.sala.cardQueue.length === 0) {
        this.sala.cardQueue = await obtenerLoteCartas();
      }
      const { card, precio } = this.sala.cardQueue.shift();
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

    const conectados = Object.entries(this.sala.jugadores).filter(([, j]) => j.conectado).map(([id]) => id);
    const todosListos = conectados.length > 0 && conectados.every(id => id in this.sala.estimaciones);
    if (todosListos) {
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
