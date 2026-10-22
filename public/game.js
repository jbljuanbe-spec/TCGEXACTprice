const API_BASE = 'https://api.tcgdex.net/v2/en';
const BATCH_SIZE = 12;
const REFILL_THRESHOLD = 5; // cuando quedan pocas cartas en cola, se rellena en segundo plano

const state = {
  numPlayers: 4,
  numRounds: 10,
  players: [],
  totalRounds: 10,
  currentRound: 0,
  totalCardCount: null,
  currentCard: null,
  currentPrice: null,
  cardQueue: [],
};

let prefetchPromise = null;

const el = (id) => document.getElementById(id);

const screenSetup = el('screen-setup');
const screenRound = el('screen-round');
const screenFinal = el('screen-final');
const errorBox = el('error-box');

function wireSegmented(containerId, defaultValue, onSelect) {
  const buttons = [...el(containerId).querySelectorAll('.segmented-option')];
  buttons.forEach(btn => {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.value) === defaultValue));
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      onSelect(Number(btn.dataset.value));
    });
  });
}

wireSegmented('players-picker', state.numPlayers, (value) => {
  state.numPlayers = value;
  renderPlayerNameInputs();
});
wireSegmented('rounds-picker', state.numRounds, (value) => {
  state.numRounds = value;
});

el('btn-theme').addEventListener('click', toggleTheme);
el('btn-start').addEventListener('click', startGame);
el('btn-reveal').addEventListener('click', reveal);
el('btn-next').addEventListener('click', goToNextRound);
el('btn-restart').addEventListener('click', restart);
el('btn-retry').addEventListener('click', loadCard);

initTheme();
renderPlayerNameInputs();
fetchBatch(); // precarga en segundo plano mientras el jugador rellena la configuración

const THEME_KEY = 'ppj-tema';

function initTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) document.documentElement.setAttribute('data-tema', saved);
  } catch (err) {
    // almacenamiento no disponible (modo privado, etc.): se queda con el tema del sistema
  }
}

function toggleTheme() {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const current = document.documentElement.getAttribute('data-tema') || (prefersDark ? 'oscuro' : 'claro');
  const next = current === 'oscuro' ? 'claro' : 'oscuro';
  document.documentElement.setAttribute('data-tema', next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (err) {
    // sin persistencia si el almacenamiento no está disponible
  }
}

function renderPlayerNameInputs() {
  const container = el('player-names');
  container.innerHTML = '';
  for (let i = 1; i <= state.numPlayers; i++) {
    const row = document.createElement('div');
    row.className = 'player-name-row';

    const avatar = document.createElement('div');
    avatar.className = 'player-avatar';
    avatar.textContent = String(i);

    const input = document.createElement('input');
    input.type = 'text';
    input.id = `player-name-${i}`;
    input.placeholder = `Jugador ${i}`;

    row.appendChild(avatar);
    row.appendChild(input);
    container.appendChild(row);
  }
}

function renderScoreboard() {
  const board = el('scoreboard');
  board.innerHTML = '';
  const maxScore = Math.max(0, ...state.players.map(p => p.score));
  state.players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'score-chip' + (maxScore > 0 && p.score === maxScore ? ' leader' : '');
    const name = document.createElement('span');
    name.textContent = p.name;
    const score = document.createElement('b');
    score.textContent = String(p.score);
    chip.appendChild(name);
    chip.appendChild(score);
    board.appendChild(chip);
  });
}

function startGame() {
  state.players = [];
  for (let i = 1; i <= state.numPlayers; i++) {
    const input = el(`player-name-${i}`);
    const name = input.value.trim() || `Jugador ${i}`;
    state.players.push({ name, score: 0 });
  }
  state.totalRounds = state.numRounds;
  state.currentRound = 1;

  screenSetup.hidden = true;
  screenFinal.hidden = true;
  screenRound.hidden = false;

  startRound();
}

function startRound() {
  el('round-badge').textContent = `Ronda ${state.currentRound} / ${state.totalRounds}`;
  el('btn-reveal').hidden = false;
  el('btn-next').hidden = true;
  el('reveal-area').hidden = true;
  el('reveal-area').innerHTML = '';
  renderScoreboard();
  loadCard();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// La API pública de pokemontcg.io no tiene SLA y da 500/timeout de vez en
// cuando, más aún con páginas grandes. Reintenta con backoff antes de rendirse.
async function fetchJSON(url, { retries = 2, timeoutMs = 8000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.ok) return await res.json();
      const body = await res.text().catch(() => '');
      lastErr = new Error(`API respondió ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error('Tiempo de espera agotado') : err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(400 * 2 ** attempt);
  }
  throw lastErr;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardWithPrice(card) {
  const price = card?.pricing?.cardmarket?.trend || card?.pricing?.cardmarket?.avg;
  if (!price || !card.image) return null;
  return {
    card: {
      ...card,
      images: { large: `${card.image}/high.png`, small: `${card.image}/low.png` },
      set: { name: card.set?.name || '' },
    },
    price,
  };
}

// Pide un lote de cartas de golpe (en vez de 1 carta por ronda): las páginas
// profundas de 1 en 1 son lentas, y con un puñado de lotes basta para toda
// la partida.
function fetchBatch() {
  if (prefetchPromise) return prefetchPromise; // ya hay una petición en curso: reutilizarla
  prefetchPromise = (async () => {
    try {
      const summaries = await fetchJSON(`${API_BASE}/cards`);
      const candidates = shuffle(summaries.filter(card => card.image)).slice(0, BATCH_SIZE);
      const details = await Promise.all(candidates.map(card => fetchJSON(`${API_BASE}/cards/${card.id}`)));
      state.cardQueue.push(...shuffle(details.map(cardWithPrice).filter(Boolean)));
    } finally {
      prefetchPromise = null;
    }
  })();
  return prefetchPromise;
}

// Último recurso si el lote falla tras los reintentos: pide cartas sueltas
// (petición mucho más pequeña, con más posibilidades de responder bien).
async function fetchSingleCard() {
  for (let i = 0; i < 3; i++) {
    try {
      const summaries = await fetchJSON(`${API_BASE}/cards`);
      const candidate = summaries[Math.floor(Math.random() * summaries.length)];
      const result = cardWithPrice(await fetchJSON(`${API_BASE}/cards/${candidate.id}`, { retries: 1 }));
      if (result) return result;
    } catch (err) {
      // se prueba con otra página
    }
  }
  return null;
}

function preloadImages(items) {
  items.forEach(item => {
    const img = new Image();
    img.src = item.card.images.large || item.card.images.small;
  });
}

const LOADING_MESSAGES = [
  'Buscando una carta al azar...',
  'Consultando el precio en Cardmarket...',
  'Casi lista...',
];

// Rota mensajes mientras se espera, para que la carga se perciba como
// progreso y no como que la app se ha quedado colgada.
function startLoadingMessages(target) {
  let i = 0;
  target.textContent = LOADING_MESSAGES[0];
  const timer = setInterval(() => {
    i = (i + 1) % LOADING_MESSAGES.length;
    target.textContent = LOADING_MESSAGES[i];
  }, 3000);
  return () => clearInterval(timer);
}

function waitForImage(img, src) {
  return new Promise(resolve => {
    img.onload = resolve;
    img.onerror = resolve; // no bloquear el juego si la imagen falla al cargar
    img.src = src;
  });
}

async function loadCard() {
  errorBox.hidden = true;
  const img = el('card-image');
  const skeleton = el('card-skeleton');
  img.hidden = true;
  img.src = '';
  skeleton.hidden = false;
  el('guess-form').innerHTML = '';
  el('btn-reveal').disabled = true;

  const stopMessages = startLoadingMessages(el('card-meta'));

  try {
    let lastErr = null;
    for (let attempt = 0; state.cardQueue.length === 0 && attempt < 2; attempt++) {
      try {
        await fetchBatch();
      } catch (err) {
        lastErr = err;
      }
    }
    if (state.cardQueue.length === 0) {
      const single = await fetchSingleCard().catch(err => { lastErr = err; return null; });
      if (single) state.cardQueue.push(single);
    }
    if (state.cardQueue.length === 0) {
      throw lastErr || new Error('No se encontraron cartas con precio');
    }

    const { card, price } = state.cardQueue.shift();
    state.currentCard = card;
    state.currentPrice = price;

    await waitForImage(img, card.images.large || card.images.small);
    img.alt = card.name;
    skeleton.hidden = true;
    img.hidden = false;
    el('card-meta').textContent = `${card.name} — ${card.set.name} — ${card.rarity || 'Rareza desconocida'}`;

    renderGuessForm();
    el('btn-reveal').disabled = false;

    preloadImages(state.cardQueue.slice(0, 2));
    if (state.cardQueue.length < REFILL_THRESHOLD) {
      fetchBatch(); // en segundo plano, no bloquea la ronda actual
    }
  } catch (err) {
    skeleton.hidden = true;
    showError('No se pudo cargar la carta. Comprueba tu conexión e inténtalo de nuevo. ' + err.message);
  } finally {
    stopMessages();
  }
}

function renderGuessForm() {
  const form = el('guess-form');
  form.innerHTML = '';
  state.players.forEach((player, i) => {
    const row = document.createElement('div');
    row.className = 'guess-row';

    const label = document.createElement('label');
    label.textContent = player.name;

    const wrap = document.createElement('div');
    wrap.className = 'input-euro';

    const input = document.createElement('input');
    input.type = 'number';
    input.id = `guess-${i}`;
    input.min = '0';
    input.step = '0.01';
    input.placeholder = '0.00';

    wrap.appendChild(input);
    row.appendChild(label);
    row.appendChild(wrap);
    form.appendChild(row);
  });
}

function pointsForGuess(guess, real) {
  if (real <= 0) return 0;
  const errorPct = Math.abs(guess - real) / real * 100;
  return Math.max(0, Math.round(100 - errorPct));
}

function reveal() {
  const real = state.currentPrice;
  const results = state.players.map((player, i) => {
    const input = el(`guess-${i}`);
    const guess = Number(input.value) || 0;
    const points = pointsForGuess(guess, real);
    player.score += points;
    return { name: player.name, guess, points };
  });

  const maxPoints = Math.max(...results.map(r => r.points));

  const area = el('reveal-area');
  area.innerHTML = '';

  const priceBlock = document.createElement('div');
  priceBlock.className = 'real-price';
  const priceLabel = document.createElement('span');
  priceLabel.className = 'label';
  priceLabel.textContent = 'Precio real (Cardmarket)';
  const priceAmount = document.createElement('span');
  priceAmount.className = 'amount';
  priceAmount.textContent = `${real.toFixed(2)} €`;
  priceBlock.appendChild(priceLabel);
  priceBlock.appendChild(priceAmount);
  area.appendChild(priceBlock);

  results.forEach(r => {
    const row = document.createElement('div');
    row.className = 'result-row' + (r.points === maxPoints ? ' winner' : '');

    const name = document.createElement('span');
    name.textContent = `${r.name}: ${r.guess.toFixed(2)} €`;

    const points = document.createElement('span');
    points.className = 'points';
    points.textContent = `${r.points} pts`;

    row.appendChild(name);
    row.appendChild(points);
    area.appendChild(row);
  });

  area.hidden = false;
  el('btn-reveal').hidden = true;
  el('btn-next').hidden = false;
  renderScoreboard();
}

function goToNextRound() {
  state.currentRound++;
  if (state.currentRound > state.totalRounds) {
    showFinal();
  } else {
    startRound();
  }
}

function showFinal() {
  screenRound.hidden = true;
  screenFinal.hidden = false;

  const ranking = [...state.players].sort((a, b) => b.score - a.score);
  const container = el('final-ranking');
  container.innerHTML = '';
  ranking.forEach((player, i) => {
    const row = document.createElement('div');
    row.className = 'result-row';

    const name = document.createElement('span');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = `#${i + 1}`;
    name.appendChild(rank);
    name.appendChild(document.createTextNode(player.name));

    const points = document.createElement('span');
    points.className = 'points';
    points.textContent = `${player.score} pts`;

    row.appendChild(name);
    row.appendChild(points);
    container.appendChild(row);
  });
}

function restart() {
  screenFinal.hidden = true;
  screenSetup.hidden = false;
}

function showError(msg) {
  el('error-msg').textContent = msg;
  errorBox.hidden = false;
}
