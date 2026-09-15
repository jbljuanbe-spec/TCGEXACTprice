// Modo "sala online": varios jugadores, cada uno desde su dispositivo,
// adivinando la misma carta a la vez. Habla por WebSocket con el Worker de
// worker/ (Durable Object por sala). El worker es quien pide las cartas y
// decide el precio real, para que nadie pueda verlo antes de tiempo.

// Sustituye esto por la URL que te da `wrangler deploy` (worker/README.md).
const SALA_SERVER_URL = 'https://TU-SUBDOMINIO.workers.dev';

const salaState = {
  ws: null,
  codigo: null,
  miId: null,
  esHost: false,
  cerrandoIntencionalmente: false,
};

const screenModo = el('screen-modo');
const screenOnlineSetup = el('screen-online-setup');
const screenLobby = el('screen-lobby');
const screenOnlineRound = el('screen-online-round');
const screenOnlineFinal = el('screen-online-final');
const onlineErrorBox = el('online-error-box');

function ocultarTodasLasPantallas() {
  [screenModo, screenSetup, screenRound, screenFinal, errorBox,
   screenOnlineSetup, screenLobby, screenOnlineRound, screenOnlineFinal, onlineErrorBox]
    .forEach(s => { s.hidden = true; });
}

function servidorConfigurado() {
  return !SALA_SERVER_URL.includes('TU-SUBDOMINIO');
}

function mostrarErrorOnline(mensaje) {
  el('online-error-msg').textContent = mensaje;
  onlineErrorBox.hidden = false;
}

// ── Navegación entre modos ──────────────────────────────────────────
el('btn-modo-local').addEventListener('click', () => {
  ocultarTodasLasPantallas();
  screenSetup.hidden = false;
});
el('btn-modo-online').addEventListener('click', () => {
  ocultarTodasLasPantallas();
  screenOnlineSetup.hidden = false;
});
el('btn-setup-volver').addEventListener('click', () => {
  ocultarTodasLasPantallas();
  screenModo.hidden = false;
});
el('btn-online-volver').addEventListener('click', volverAlInicio);
el('btn-online-restart').addEventListener('click', volverAlInicio);

function volverAlInicio() {
  salaState.cerrandoIntencionalmente = true;
  if (salaState.ws) salaState.ws.close();
  salaState.ws = null;
  salaState.codigo = null;
  salaState.miId = null;
  ocultarTodasLasPantallas();
  screenModo.hidden = false;
}

// ── Crear / unirse ───────────────────────────────────────────────────
el('btn-crear-sala').addEventListener('click', async () => {
  if (!servidorConfigurado()) {
    mostrarErrorOnline('La sala online todavía no está configurada (falta desplegar el servidor). Mira worker/README.md.');
    onlineErrorBox.hidden = false;
    return;
  }
  try {
    const res = await fetch(`${SALA_SERVER_URL}/crear`);
    if (!res.ok) throw new Error(`el servidor respondió ${res.status}`);
    const { codigo } = await res.json();
    conectar(codigo);
  } catch (err) {
    mostrarErrorOnline('No se pudo crear la sala: ' + err.message);
  }
});

el('btn-unirse-sala').addEventListener('click', () => {
  const codigo = el('online-codigo').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(codigo)) {
    mostrarErrorOnline('El código de sala tiene 4 letras/números, revisa lo que has escrito.');
    onlineErrorBox.hidden = false;
    return;
  }
  conectar(codigo);
});

el('btn-online-retry').addEventListener('click', () => {
  onlineErrorBox.hidden = true;
  if (salaState.codigo) conectar(salaState.codigo);
});

function conectar(codigo) {
  if (!servidorConfigurado()) {
    mostrarErrorOnline('La sala online todavía no está configurada (falta desplegar el servidor). Mira worker/README.md.');
    return;
  }
  salaState.codigo = codigo;
  salaState.cerrandoIntencionalmente = false;

  const nombre = (el('online-nombre').value.trim() || 'Jugador').slice(0, 24);
  let idGuardado = '';
  try { idGuardado = localStorage.getItem(`ppj-sala-id-${codigo}`) || ''; } catch (err) { /* sin storage disponible */ }

  const base = SALA_SERVER_URL.replace(/^http/, 'ws');
  const params = new URLSearchParams({ nombre });
  if (idGuardado) params.set('id', idGuardado);
  const ws = new WebSocket(`${base}/sala/${codigo}?${params}`);
  salaState.ws = ws;

  ws.addEventListener('message', (ev) => manejarMensaje(JSON.parse(ev.data)));
  ws.addEventListener('error', () => mostrarErrorOnline('No se pudo conectar con la sala.'));
  ws.addEventListener('close', () => {
    if (salaState.cerrandoIntencionalmente) return;
    // corte de red inesperado (wifi, móvil que se bloquea...): reintenta solo
    mostrarErrorOnline('Se perdió la conexión con la sala. Reintentando…');
    setTimeout(() => { if (!salaState.cerrandoIntencionalmente) conectar(codigo); }, 2000);
  });
}

function manejarMensaje(msg) {
  if (msg.tipo === 'tu-id') {
    salaState.miId = msg.id;
    try { localStorage.setItem(`ppj-sala-id-${salaState.codigo}`, msg.id); } catch (err) { /* sin storage disponible */ }
  } else if (msg.tipo === 'estado') {
    onlineErrorBox.hidden = true;
    salaState.esHost = msg.sala.hostId === salaState.miId;
    renderizarSala(msg.sala);
  } else if (msg.tipo === 'error') {
    mostrarErrorOnline(msg.mensaje);
  }
}

function renderizarSala(sala) {
  if (sala.fase === 'lobby') mostrarLobby(sala);
  else if (sala.fase === 'ronda') mostrarRonda(sala);
  else if (sala.fase === 'revelado') mostrarRevelado(sala);
  else if (sala.fase === 'final') mostrarFinalOnline(sala);
}

// ── Lobby ─────────────────────────────────────────────────────────────
let rondasElegidas = 10;

wireSegmented('lobby-rondas-picker', rondasElegidas, (valor) => {
  rondasElegidas = valor;
  salaState.ws.send(JSON.stringify({ tipo: 'configurar', rondas: valor }));
});

el('btn-lobby-empezar').addEventListener('click', () => {
  salaState.ws.send(JSON.stringify({ tipo: 'empezar' }));
});

function mostrarLobby(sala) {
  ocultarTodasLasPantallas();
  screenLobby.hidden = false;

  el('lobby-codigo').textContent = salaState.codigo;

  const lista = el('lobby-jugadores');
  lista.innerHTML = '';
  Object.entries(sala.jugadores).forEach(([id, j]) => {
    const fila = document.createElement('div');
    fila.className = 'lobby-jugador' + (j.conectado ? '' : ' desconectado');
    const nombre = document.createElement('span');
    nombre.textContent = j.nombre + (id === sala.hostId ? ' (anfitrión)' : '');
    const estado = document.createElement('span');
    estado.className = 'punto-estado';
    fila.appendChild(nombre);
    fila.appendChild(estado);
    lista.appendChild(fila);
  });

  el('lobby-config-host').hidden = !salaState.esHost;
  el('lobby-espera-msg').hidden = salaState.esHost;
  if (salaState.esHost) {
    document.querySelectorAll('#lobby-rondas-picker .segmented-option').forEach(btn => {
      btn.setAttribute('aria-pressed', String(Number(btn.dataset.value) === sala.totalRondas));
    });
  }
}

// ── Ronda ────────────────────────────────────────────────────────────
function renderScoreboardOnline(sala) {
  const board = el('online-scoreboard');
  board.innerHTML = '';
  const puntuaciones = Object.values(sala.jugadores).map(j => j.puntuacion);
  const maxScore = Math.max(0, ...puntuaciones);
  Object.values(sala.jugadores).forEach(j => {
    const chip = document.createElement('div');
    chip.className = 'score-chip' + (maxScore > 0 && j.puntuacion === maxScore ? ' leader' : '');
    const nombre = document.createElement('span');
    nombre.textContent = j.nombre;
    const puntos = document.createElement('b');
    puntos.textContent = String(j.puntuacion);
    chip.appendChild(nombre);
    chip.appendChild(puntos);
    board.appendChild(chip);
  });
}

let ultimaCartaMostrada = null;

function mostrarRonda(sala) {
  ocultarTodasLasPantallas();
  screenOnlineRound.hidden = false;

  el('online-round-badge').textContent = `Ronda ${sala.rondaActual} / ${sala.totalRondas}`;
  renderScoreboardOnline(sala);

  el('online-reveal-area').hidden = true;
  el('btn-online-siguiente').hidden = true;
  el('online-espera-siguiente').hidden = true;

  const img = el('online-card-image');
  const skeleton = el('online-card-skeleton');
  if (ultimaCartaMostrada !== sala.carta?.imagen) {
    ultimaCartaMostrada = sala.carta?.imagen;
    img.hidden = true;
    skeleton.hidden = false;
    img.onload = () => { skeleton.hidden = true; img.hidden = false; };
    img.onerror = () => { skeleton.hidden = true; img.hidden = false; };
    img.src = sala.carta?.imagen || '';
    img.alt = sala.carta?.nombre || '';
  }
  el('online-card-meta').textContent = sala.carta
    ? `${sala.carta.nombre} — ${sala.carta.set} — ${sala.carta.rareza}`
    : '';

  const yo = sala.jugadores[salaState.miId];
  const form = el('online-guess-form');
  const btnEnviar = el('btn-online-enviar');
  const esperaTexto = el('online-espera-respuestas');

  const conectados = Object.values(sala.jugadores).filter(j => j.conectado).length;
  const respondidos = Object.values(sala.jugadores).filter(j => j.respondio).length;
  esperaTexto.hidden = false;
  esperaTexto.textContent = `${respondidos}/${conectados} jugadores han respondido`;

  if (yo && yo.respondio) {
    form.innerHTML = '';
    btnEnviar.hidden = true;
  } else {
    btnEnviar.hidden = false;
    if (!form.querySelector('input')) {
      form.innerHTML = '';
      const row = document.createElement('div');
      row.className = 'guess-row';
      const label = document.createElement('label');
      label.textContent = 'Tu estimación';
      const wrap = document.createElement('div');
      wrap.className = 'input-euro';
      const input = document.createElement('input');
      input.type = 'number';
      input.id = 'online-guess-input';
      input.min = '0';
      input.step = '0.01';
      input.placeholder = '0.00';
      wrap.appendChild(input);
      row.appendChild(label);
      row.appendChild(wrap);
      form.appendChild(row);
    }
  }
}

el('btn-online-enviar').addEventListener('click', () => {
  const input = el('online-guess-input');
  if (!input) return;
  const valor = Number(input.value);
  if (!Number.isFinite(valor) || valor < 0) return;
  salaState.ws.send(JSON.stringify({ tipo: 'adivinar', valor }));
  el('btn-online-enviar').hidden = true;
});

// ── Revelado ─────────────────────────────────────────────────────────
function mostrarRevelado(sala) {
  ocultarTodasLasPantallas();
  screenOnlineRound.hidden = false;

  el('online-round-badge').textContent = `Ronda ${sala.rondaActual} / ${sala.totalRondas}`;
  renderScoreboardOnline(sala);

  el('online-guess-form').innerHTML = '';
  el('btn-online-enviar').hidden = true;
  el('online-espera-respuestas').hidden = true;

  const area = el('online-reveal-area');
  area.innerHTML = '';

  const priceBlock = document.createElement('div');
  priceBlock.className = 'real-price';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Precio real (Cardmarket)';
  const amount = document.createElement('span');
  amount.className = 'amount';
  amount.textContent = `${Number(sala.precio).toFixed(2)} €`;
  priceBlock.appendChild(label);
  priceBlock.appendChild(amount);
  area.appendChild(priceBlock);

  const maxPuntos = Math.max(0, ...Object.values(sala.jugadores).map(j => j.puntosRonda ?? 0));
  Object.entries(sala.jugadores).forEach(([id, j]) => {
    if (!(id in (sala.estimaciones || {}))) return; // no respondió esta ronda (ej. se desconectó)
    const fila = document.createElement('div');
    fila.className = 'result-row' + (j.puntosRonda === maxPuntos && maxPuntos > 0 ? ' winner' : '');
    const nombre = document.createElement('span');
    nombre.textContent = `${j.nombre}: ${Number(sala.estimaciones[id]).toFixed(2)} €`;
    const puntos = document.createElement('span');
    puntos.className = 'points';
    puntos.textContent = `${j.puntosRonda} pts`;
    fila.appendChild(nombre);
    fila.appendChild(puntos);
    area.appendChild(fila);
  });
  area.hidden = false;

  if (salaState.esHost) {
    el('btn-online-siguiente').hidden = false;
  } else {
    el('online-espera-siguiente').hidden = false;
  }
}

el('btn-online-siguiente').addEventListener('click', () => {
  salaState.ws.send(JSON.stringify({ tipo: 'siguiente' }));
});

// ── Final ────────────────────────────────────────────────────────────
function mostrarFinalOnline(sala) {
  ocultarTodasLasPantallas();
  screenOnlineFinal.hidden = false;

  const ranking = Object.values(sala.jugadores).sort((a, b) => b.puntuacion - a.puntuacion);
  const container = el('online-final-ranking');
  container.innerHTML = '';
  ranking.forEach((j, i) => {
    const fila = document.createElement('div');
    fila.className = 'result-row';
    const nombre = document.createElement('span');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = `#${i + 1}`;
    nombre.appendChild(rank);
    nombre.appendChild(document.createTextNode(j.nombre));
    const puntos = document.createElement('span');
    puntos.className = 'points';
    puntos.textContent = `${j.puntuacion} pts`;
    fila.appendChild(nombre);
    fila.appendChild(puntos);
    container.appendChild(fila);
  });
}
