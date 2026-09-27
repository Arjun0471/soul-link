import { firebaseConfig } from './firebase-config.js';

const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const POKEAPI = 'https://pokeapi.co/api/v2';
const spriteUrl = (dexId) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${dexId}.png`;

const PARTY_LIMIT = 6;
// A link is alive, dead or missed as a whole. Party vs box is tracked per
// player on each encounter (`inParty`), since partners needn't both be in the party.
const STATUSES = ['alive', 'dead', 'missed'];
const EMPTY_TEXT = {
  alive: 'No living Pokémon yet.',
  dead: 'Nobody has fallen. Yet.',
  missed: 'No failed encounters.',
};
const KEYS = {
  recent: 'slt:recent-runs',
  speciesList: 'slt:species-list',
  pokemonCache: 'slt:pokemon-cache',
  evolutionCache: 'slt:evolution-cache',
  localRun: (id) => `slt:run:${id}`,
};

// ---------- small helpers ----------

const $ = (sel) => document.querySelector(sel);

function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked; the app still works for this session.
  }
}

function newId(length = 10) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Firebase rejects `undefined`; round-tripping through JSON drops those keys.
const clean = (value) => JSON.parse(JSON.stringify(value));

function toSlug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/♀/g, '-f')
    .replace(/♂/g, '-m')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.'’:]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const prettySpecies = (slug) =>
  String(slug || '').split('-').filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ---------- storage backends ----------
// Both stores expose the same interface. Data is written as multi-path patches
// ({"links/abc": {...}, "meta": {...}}) so two people editing different
// encounters at the same time never overwrite each other.

const firebaseEnabled = () => Boolean(firebaseConfig && firebaseConfig.databaseURL);

async function createStore(runId) {
  if (firebaseEnabled()) {
    try {
      return await createFirebaseStore(runId);
    } catch (err) {
      console.error(err);
      toast('Could not reach Firebase. Using local-only mode.');
    }
  }
  return createLocalStore(runId);
}

async function createFirebaseStore(runId) {
  const [{ initializeApp }, fb] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`),
    import(`${FIREBASE_SDK}/firebase-database.js`),
  ]);
  const db = fb.getDatabase(initializeApp(firebaseConfig));
  const runRef = fb.ref(db, `runs/${runId}`);
  return {
    mode: 'firebase',
    subscribe(callback) {
      fb.onValue(runRef, (snap) => callback(snap.val()), (err) => {
        console.error(err);
        toast(`Firebase refused access: ${err.message}`);
      });
    },
    onConnection(callback) {
      fb.onValue(fb.ref(db, '.info/connected'), (snap) => callback(Boolean(snap.val())));
    },
    write(patches) {
      return fb.update(runRef, clean(patches));
    },
  };
}

function applyPatches(data, patches) {
  const root = structuredClone(data || {});
  for (const [path, value] of Object.entries(patches)) {
    const parts = path.split('/');
    const last = parts.pop();
    let node = root;
    for (const part of parts) {
      if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
      node = node[part];
    }
    if (value === null) delete node[last];
    else node[last] = clean(value);
  }
  return root;
}

function createLocalStore(runId) {
  const key = KEYS.localRun(runId);
  let data = lsGet(key, null);
  let listener = () => {};
  // Keeps other tabs on the same machine in sync.
  window.addEventListener('storage', (event) => {
    if (event.key !== key) return;
    data = lsGet(key, null);
    listener(data);
  });
  return {
    mode: 'local',
    subscribe(callback) {
      listener = callback;
      callback(data);
    },
    onConnection(callback) {
      callback(false);
    },
    async write(patches) {
      data = applyPatches(data, patches);
      lsSet(key, data);
      listener(data);
    },
  };
}

// ---------- run data ----------

function initialRun({ runName, game, playerNames, versions = [] }) {
  const players = {};
  playerNames.forEach((name, order) => {
    players[newId(8)] = clean({ name, order, version: versions[order] || undefined });
  });
  return {
    meta: { runName, game, uniqueTypes: true, createdAt: Date.now() },
    players,
  };
}

function normalize(raw) {
  const data = raw || {};
  const meta = { runName: 'Soul Link', game: '', uniqueTypes: true, ...data.meta };
  const players = Object.entries(data.players || {})
    .map(([id, p]) => ({ id, name: p.name || 'Player', order: p.order ?? 0, version: p.version || '' }))
    .sort((a, b) => a.order - b.order);
  const links = Object.entries(data.links || {})
    .map(([id, link]) => normalizeLink(id, link))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return { exists: Boolean(data.meta), meta, players, links };
}

function normalizeLink(id, raw) {
  const link = { id, location: '', status: 'alive', ...raw };
  link.encounters = structuredClone(raw.encounters || {});
  // Older runs stored party/box on the whole link.
  if (link.status === 'party' || link.status === 'box') {
    for (const enc of Object.values(link.encounters)) enc.inParty ??= link.status === 'party';
    link.status = 'alive';
    link.legacyStatus = true;
  }
  if (!STATUSES.includes(link.status)) link.status = 'alive';
  return link;
}

function parseRunId(text) {
  const match = String(text || '').match(/run=([a-z0-9]+)/i);
  if (match) return match[1].toLowerCase();
  const bare = String(text || '').trim();
  return /^[a-z0-9]{10,}$/i.test(bare) ? bare.toLowerCase() : null;
}

const runUrl = (id) => `${location.origin}${location.pathname}#run=${id}`;

function rememberRecent(id, name) {
  const recent = lsGet(KEYS.recent, []).filter((r) => r.id !== id);
  recent.unshift({ id, name, at: Date.now() });
  lsSet(KEYS.recent, recent.slice(0, 8));
}

// ---------- Pokémon data (PokéAPI) ----------

async function loadSpeciesList() {
  let names = lsGet(KEYS.speciesList, null);
  if (!names) {
    try {
      const res = await fetch(`${POKEAPI}/pokemon?limit=2000`);
      if (!res.ok) return;
      names = (await res.json()).results.map((r) => r.name);
      lsSet(KEYS.speciesList, names);
    } catch {
      return; // Offline: species can still be typed by hand.
    }
  }
  $('#species-list').innerHTML = names
    .map((n) => `<option value="${esc(prettySpecies(n))}">`).join('');
}

const pokemonCache = lsGet(KEYS.pokemonCache, {});

async function fetchJson(url) {
  const res = await fetch(url);
  return res.ok ? res.json() : null;
}

async function lookupPokemon(slug) {
  if (!slug) return null;
  if (pokemonCache[slug]) return pokemonCache[slug];
  try {
    let pokemon = await fetchJson(`${POKEAPI}/pokemon/${slug}`);
    if (!pokemon) {
      // Species like "deoxys" only exist as forms; fall back to the default variety.
      const species = await fetchJson(`${POKEAPI}/pokemon-species/${slug}`);
      const variety = species?.varieties?.find((v) => v.is_default) || species?.varieties?.[0];
      if (variety) pokemon = await fetchJson(variety.pokemon.url);
    }
    if (!pokemon) return null;
    const info = {
      dexId: pokemon.id,
      types: pokemon.types.sort((a, b) => a.slot - b.slot).map((t) => t.type.name),
    };
    pokemonCache[slug] = info;
    lsSet(KEYS.pokemonCache, pokemonCache);
    return info;
  } catch {
    return null;
  }
}

// Next stages in the evolution chain, e.g. "sentret" -> ["furret"], "eevee" -> 8 options.
// Resolves [] when fully evolved and null when the lookup failed.
async function evolutionOptions(slug) {
  try {
    const pokemon = await fetchJson(`${POKEAPI}/pokemon/${slug}`);
    const speciesName = pokemon?.species?.name || slug;
    const species = await fetchJson(`${POKEAPI}/pokemon-species/${speciesName}`);
    if (!species) return null;
    if (!species.evolution_chain?.url) return [];
    const chain = (await fetchJson(species.evolution_chain.url))?.chain;
    if (!chain) return null;
    const find = (node) => (node.species.name === speciesName
      ? node : node.evolves_to.map(find).find(Boolean));
    const node = find(chain);
    return node ? node.evolves_to.map((next) => next.species.name) : [];
  } catch {
    return null;
  }
}

// Evolution options per species, cached so Evolve buttons can appear only
// for Pokémon that actually have an evolution.
const evolutionCache = lsGet(KEYS.evolutionCache, {});
const evolutionLookups = new Set();

async function loadEvolutions(slug) {
  if (evolutionCache[slug]) return evolutionCache[slug];
  const next = await evolutionOptions(slug);
  if (next) {
    evolutionCache[slug] = next;
    lsSet(KEYS.evolutionCache, evolutionCache);
  }
  return next;
}

function prefetchEvolutions() {
  for (const link of state.links) {
    if (link.status !== 'alive') continue;
    for (const enc of Object.values(link.encounters || {})) {
      const slug = enc?.species;
      if (!slug || evolutionCache[slug] || evolutionLookups.has(slug)) continue;
      evolutionLookups.add(slug);
      loadEvolutions(slug).then((next) => { if (next?.length) scheduleRender(); });
    }
  }
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderRun();
  });
}

// ---------- app state ----------

let store = null;
let runId = null;
let state = normalize(null);
const lookupsAttempted = new Set();

// Fills in sprite/type data for encounters that don't have it yet. Whoever
// sees it first writes it to the shared run, so the partner gets it too.
function resolveMissingPokemonData() {
  for (const link of state.links) {
    for (const player of state.players) {
      const enc = link.encounters?.[player.id];
      if (!enc?.species || enc.types?.length) continue;
      const key = `${link.id}/${player.id}/${enc.species}`;
      if (lookupsAttempted.has(key)) continue;
      lookupsAttempted.add(key);
      lookupPokemon(enc.species).then((info) => {
        if (!info) return;
        const current = state.links.find((l) => l.id === link.id)?.encounters?.[player.id];
        if (current?.species !== enc.species) return;
        store.write({
          [`links/${link.id}/encounters/${player.id}/dexId`]: info.dexId,
          [`links/${link.id}/encounters/${player.id}/types`]: info.types,
        });
      });
    }
  }
}

function groupLinks() {
  const groups = { alive: [], dead: [], missed: [] };
  for (const link of state.links) groups[link.status].push(link);
  return groups;
}

// One player's party: their living Pokémon flagged inParty.
function partyOf(playerId) {
  return state.links.filter((link) => {
    const enc = link.encounters?.[playerId];
    return link.status === 'alive' && enc?.species && enc.inParty;
  });
}

function boxOf(playerId) {
  return state.links.filter((link) => {
    const enc = link.encounters?.[playerId];
    return link.status === 'alive' && enc?.species && !enc.inParty;
  });
}

const playerName = (playerId) => state.players.find((p) => p.id === playerId)?.name || 'That player';

// Every party/box change goes through here, so no party can ever exceed PARTY_LIMIT.
// `moves` is a list of { linkId, playerId, inParty }; applied together (for swaps)
// or not at all. Returns false when refused.
function movePokemon(moves) {
  const sizes = Object.fromEntries(state.players.map((p) => [p.id, partyOf(p.id).length]));
  const joining = new Set();
  const patches = {};
  for (const { linkId, playerId, inParty } of moves) {
    const link = state.links.find((l) => l.id === linkId);
    const enc = link?.encounters?.[playerId];
    if (!enc?.species || link.status !== 'alive' || Boolean(enc.inParty) === inParty) continue;
    sizes[playerId] += inParty ? 1 : -1;
    if (inParty) joining.add(playerId);
    if (link.legacyStatus) {
      // Links saved before per-player parties: store every flag explicitly.
      patches[`links/${linkId}/status`] = 'alive';
      for (const [pid, other] of Object.entries(link.encounters)) {
        patches[`links/${linkId}/encounters/${pid}/inParty`] ??= Boolean(other.inParty);
      }
    }
    patches[`links/${linkId}/encounters/${playerId}/inParty`] = inParty;
    if (inParty) patches[`links/${linkId}/encounters/${playerId}/partySince`] = Date.now();
  }
  const full = [...joining].filter((pid) => sizes[pid] > PARTY_LIMIT);
  if (full.length) {
    toast(`${full.map(playerName).join(' and ')}'s party is full (${PARTY_LIMIT}/${PARTY_LIMIT}). Box someone first.`);
    return false;
  }
  if (Object.keys(patches).length) store.write(patches);
  return true;
}

function sendToParty(linkId, playerId) {
  if (partyOf(playerId).length >= PARTY_LIMIT) return openSwapDialog(linkId, playerId);
  return movePokemon([{ linkId, playerId, inParty: true }]);
}

// Safety net for simultaneous edits on two machines (each saw room for one
// more). Keeps the six that joined first and boxes the newest arrivals; every
// client picks the same ones, so their fixes agree.
function enforcePartyLimit() {
  const patches = {};
  const boxed = [];
  const rank = (link, pid) => [link.encounters[pid].partySince || 0, link.createdAt || 0, link.id];
  for (const player of state.players) {
    const party = partyOf(player.id);
    if (party.length <= PARTY_LIMIT) continue;
    party.sort((a, b) => {
      const [x, y] = [rank(a, player.id), rank(b, player.id)];
      return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : 1);
    });
    for (const link of party.slice(PARTY_LIMIT)) {
      patches[`links/${link.id}/encounters/${player.id}/inParty`] = false;
      boxed.push(`${player.name}'s ${monName(link.encounters[player.id])}`);
    }
  }
  if (!boxed.length) return false;
  store.write(patches);
  toast(`Parties hold ${PARTY_LIMIT}: moved ${boxed.join(', ')} to the box.`);
  return true;
}

// Common Soul Link rule: no two Pokémon in one player's party may share a primary type.
// Keys in byMon are "<linkId>/<playerId>".
function findTypeConflicts() {
  const byMon = new Map();
  const messages = [];
  if (!state.meta.uniqueTypes) return { byMon, messages };
  for (const player of state.players) {
    const byType = {};
    for (const link of partyOf(player.id)) {
      const type = link.encounters[player.id].types?.[0];
      if (type) (byType[type] ||= []).push(link);
    }
    for (const [type, links] of Object.entries(byType)) {
      if (links.length < 2) continue;
      const names = links.map((l) => monName(l.encounters[player.id]));
      messages.push(`${player.name}'s party has ${links.length} ${prettySpecies(type)}-type primaries: ${names.join(', ')}.`);
      for (const link of links) byMon.set(`${link.id}/${player.id}`, prettySpecies(type));
    }
  }
  return { byMon, messages };
}

const monName = (enc) => enc?.nickname || prettySpecies(enc?.species) || '—';

// ---------- rendering ----------

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  dots: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  grave: '<path d="M6 21V10a6 6 0 0 1 12 0v11z"/><path d="M3 21h18M12 8v6M9.5 10.5h5"/>',
  ball: '<circle cx="12" cy="12" r="9"/><path d="M3 12h6M15 12h6"/><circle cx="12" cy="12" r="3"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

const artworkUrl = (dexId) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${dexId}.png`;

// Players are colour-coded like the games: Red, Blue, then Green and Yellow.
function playerStyle(playerId) {
  const index = Math.max(0, state.players.findIndex((p) => p.id === playerId));
  return `--pc: var(--p${(index % 4) + 1})`;
}

const avatar = (player, extra = '') =>
  `<span class="avatar ${extra}" style="${playerStyle(player.id)}" aria-hidden="true">${esc((player.name || '?').trim().charAt(0).toUpperCase())}</span>`;

function renderSync(connected) {
  const pill = $('#sync-status');
  if (store?.mode === 'firebase') {
    pill.textContent = connected ? 'Live' : 'Offline · will sync';
    pill.className = `pill ${connected ? 'ok' : 'warn'}`;
    pill.title = connected
      ? 'Changes are shared with everyone who has the link.'
      : 'Reconnecting. Your changes are saved and will sync when the connection is back.';
  } else {
    pill.textContent = 'Local only';
    pill.className = 'pill warn';
    pill.title = 'Firebase is not configured, so this run is only saved in this browser. See README.md.';
  }
}

// Official artwork, falling back to the pixel sprite, then to a Poké Ball outline.
function artHtml(enc, cls = 'art') {
  if (!enc?.dexId) return `<span class="${cls} placeholder">${icon('ball')}</span>`;
  const fallback = spriteUrl(enc.dexId);
  return `<img class="${cls}" src="${artworkUrl(enc.dexId)}" alt="" loading="lazy" onerror="if(this.dataset.fb){this.remove()}else{this.dataset.fb=1;this.classList.add('pixel');this.src='${fallback}'}">`;
}

function miniSprite(enc) {
  return enc?.dexId
    ? `<img class="mini" src="${spriteUrl(enc.dexId)}" alt="" loading="lazy" onerror="this.remove()">`
    : '';
}

const typesHtml = (enc) =>
  `<div class="types">${(enc.types || []).map((t) => `<span class="type t-${esc(t)}">${esc(t)}</span>`).join('')}</div>`;

// Tints a tile with its primary type colour.
const tint = (enc) => (enc?.types?.[0] ? ` tint t-${esc(enc.types[0])}` : ' tint');

function speciesLine(enc) {
  const parts = [];
  if (enc.nickname) parts.push(esc(prettySpecies(enc.species)));
  if (enc.caughtAs) parts.push(`caught as ${esc(prettySpecies(enc.caughtAs))}`);
  return parts.length ? `<div class="species">${parts.join(' · ')}</div>` : '';
}

// Shown only once we know this species has somewhere to evolve to.
function evolveButton(linkId, playerId, enc) {
  const next = evolutionCache[enc.species];
  if (!next?.length) return '';
  const hint = next.length === 1 ? `Evolve into ${prettySpecies(next[0])}` : `Evolve (${next.length} options)`;
  return `<button type="button" class="evolve" data-action="evolve" data-id="${esc(linkId)}" data-player="${esc(playerId)}" title="${esc(hint)}">${icon('spark')}Evolve</button>`;
}

function moveButton(linkId, playerId, inParty, compact = false) {
  const attrs = `data-id="${esc(linkId)}" data-player="${esc(playerId)}"`;
  return inParty
    ? `<button type="button" class="move to-box" data-action="to-box" ${attrs} title="Move to the box">${icon('down')}${compact ? '' : 'Box'}</button>`
    : `<button type="button" class="move to-party" data-action="to-party" ${attrs} title="Move to the party">${icon('up')}${compact ? '' : 'Party'}</button>`;
}

function renderMon(link, player, conflicts) {
  const enc = link.encounters?.[player.id];
  const head = (extra = '') => `<div class="mon-head">${avatar(player, 'sm')}<span class="owner">${esc(player.name)}</span>${extra}</div>`;
  if (!enc?.species) {
    const add = link.status === 'alive'
      ? `<button type="button" class="add-catch" data-action="add-catch" data-id="${esc(link.id)}" data-player="${esc(player.id)}" title="Add ${esc(player.name)}'s catch">${icon('plus')}Add catch</button>`
      : '<div class="muted">No encounter</div>';
    return `<div class="mon empty${link.status === 'alive' ? ' waiting' : ''}" style="${playerStyle(player.id)}">${head()}<span class="art placeholder">${icon('ball')}</span>${add}</div>`;
  }
  const alive = link.status === 'alive';
  const fainted = link.status === 'dead' && (link.fainted === player.id || link.fainted === 'all');
  const clash = conflicts.byMon.get(`${link.id}/${player.id}`);
  const badge = alive
    ? `<span class="where ${enc.inParty ? 'party' : 'box'}">${enc.inParty ? 'Party' : 'Box'}</span>`
    : fainted ? `<span class="where fainted-badge">${icon('grave')}Fainted</span>` : '';
  const controls = alive ? `
      <div class="mon-actions">
        ${moveButton(link.id, player.id, enc.inParty)}
        ${evolveButton(link.id, player.id, enc)}
      </div>` : '';
  return `
    <div class="mon${tint(enc)}${fainted ? ' fainted' : ''}${clash ? ' clash' : ''}" style="${playerStyle(player.id)}">
      ${head(badge)}
      ${artHtml(enc)}
      <div class="nickname">${esc(monName(enc))}</div>
      ${speciesLine(enc)}
      ${typesHtml(enc)}
      ${clash ? `<div class="clash-note">${esc(clash)}-type clash</div>` : ''}
      ${controls}
    </div>`;
}

function renderCard(link, conflicts) {
  const edit = `<button type="button" class="ghost icon-only" data-action="edit" data-id="${esc(link.id)}" title="Edit" aria-label="Edit">${icon('edit')}</button>`;
  const location = `<span class="loc">${icon('pin')}${esc(link.location || 'Unknown location')}</span>`;

  if (link.status === 'missed') {
    const who = state.players
      .map((p) => {
        const enc = link.encounters?.[p.id];
        return enc?.species ? `${esc(p.name)}: ${esc(monName(enc))}` : '';
      }).filter(Boolean).join(' · ');
    return `
      <article class="card compact status-missed" data-id="${esc(link.id)}">
        <header>${location}${edit}</header>
        ${who ? `<p class="muted">${who}</p>` : ''}
        ${link.notes ? `<p class="notes">${esc(link.notes)}</p>` : ''}
      </article>`;
  }

  const mons = state.players.map((p) => renderMon(link, p, conflicts))
    .join(`<span class="chain" aria-hidden="true">${icon('link')}</span>`);
  const actions = [];
  if (link.status === 'alive') {
    actions.push(['kill', `${icon('grave')}Fainted…`, 'ghost danger push']);
  }
  const cause = link.status === 'dead'
    ? `<p class="epitaph">${link.cause ? esc(link.cause) : 'Fell in battle.'}</p>` : '';
  return `
    <article class="card status-${esc(link.status)}" data-id="${esc(link.id)}">
      <header>${location}${edit}</header>
      <div class="pair">${mons}</div>
      ${cause}
      ${link.notes ? `<p class="notes">${esc(link.notes)}</p>` : ''}
      ${actions.length ? `<footer>${actions.map(([a, label, cls]) => `<button type="button" class="${cls}" data-action="${a}" data-id="${esc(link.id)}">${label}</button>`).join('')}</footer>` : ''}
    </article>`;
}

function partnerLine(link, playerId) {
  return state.players.filter((p) => p.id !== playerId)
    .map((p) => {
      const other = link.encounters?.[p.id];
      if (!other?.species) {
        return `<button type="button" class="partner-missing" data-action="add-catch" data-id="${esc(link.id)}" data-player="${esc(p.id)}" title="Add ${esc(p.name)}'s catch from ${esc(link.location)}">${icon('plus')}${esc(p.name)}'s catch</button>`;
      }
      return `<span class="partner-mon">${miniSprite(other)}${esc(monName(other))}${other.inParty ? '' : '<em>box</em>'}</span>`;
    }).filter(Boolean).join('');
}

function slotHtml(link, player, conflicts) {
  const enc = link.encounters[player.id];
  const partners = partnerLine(link, player.id);
  const clash = conflicts.byMon.has(`${link.id}/${player.id}`);
  return `
    <div class="slot${tint(enc)}${clash ? ' clash' : ''}" draggable="true" data-id="${esc(link.id)}" data-player="${esc(player.id)}" title="${esc(link.location)}">
      ${artHtml(enc)}
      <div class="nickname">${esc(monName(enc))}</div>
      ${speciesLine(enc)}
      ${typesHtml(enc)}
      ${partners ? `<div class="partner" title="Soul-linked partner">${icon('link')}${partners}</div>` : ''}
      <div class="slot-actions">
        ${moveButton(link.id, player.id, true)}
        ${evolveButton(link.id, player.id, enc)}
        <button type="button" class="faint" data-action="kill" data-id="${esc(link.id)}" data-player="${esc(player.id)}" title="${esc(monName(enc))} fainted (the linked pair dies)">${icon('grave')}Fainted</button>
      </div>
    </div>`;
}

function boxChipHtml(link, player) {
  const enc = link.encounters[player.id];
  return `
    <div class="slot chip${tint(enc)}" draggable="true" data-id="${esc(link.id)}" data-player="${esc(player.id)}" title="${esc(link.location)}">
      ${artHtml(enc, 'art sm')}
      <div class="chip-text">
        <div class="nickname">${esc(monName(enc))}</div>
        ${typesHtml(enc)}
      </div>
      ${moveButton(link.id, player.id, false, true)}
    </div>`;
}

// One panel per player: their party (6 slots) with their PC box underneath.
// Slots can be dragged between the two on desktop; buttons work everywhere.
function renderTeams(conflicts) {
  $('#parties').innerHTML = state.players.map((player) => {
    const party = partyOf(player.id);
    const box = boxOf(player.id);
    const pips = Array.from({ length: PARTY_LIMIT }, (_, i) => `<i class="${i < party.length ? 'on' : ''}"></i>`).join('');
    const open = Array.from({ length: Math.max(0, PARTY_LIMIT - party.length) },
      () => `<div class="slot open">${icon('ball')}<span>Empty</span></div>`).join('');
    return `
      <div class="team" style="${playerStyle(player.id)}">
        <header class="team-head">
          ${avatar(player)}
          <div>
            <h3>${esc(player.name)}${versionTag(player.version)}</h3>
            <div class="pips" title="${party.length} of ${PARTY_LIMIT} party slots used">${pips}<span class="party-count">${party.length}/${PARTY_LIMIT}</span></div>
          </div>
        </header>
        <div class="party-grid drop" data-drop="party" data-player="${esc(player.id)}">
          ${party.map((link) => slotHtml(link, player, conflicts)).join('')}${open}
        </div>
        <div class="box-tray">
          <div class="tray-label">PC Box <span class="count">${box.length}</span></div>
          <div class="box-grid drop" data-drop="box" data-player="${esc(player.id)}">
            ${box.length ? box.map((link) => boxChipHtml(link, player)).join('') : '<p class="empty">Empty. Drag Pokémon here to box them.</p>'}
          </div>
        </div>
      </div>`;
  }).join('');
}

function renderRun() {
  $('#run-loading').hidden = true;
  $('#run-missing').hidden = state.exists;
  $('#run-content').hidden = !state.exists;
  $('#section-nav').hidden = !state.exists;
  if (!state.exists) return;

  const { meta, players } = state;
  document.title = `${meta.runName} · Soul Link Tracker`;
  $('#run-name').textContent = meta.runName;
  const versionNames = [...new Set(players.map((p) => GAME_VERSIONS[p.version]?.name).filter(Boolean))];
  $('#run-game').textContent = meta.game
    ? `Pokémon ${meta.game.replace(/^pok[eé]mon\s+/i, '')}`
    : versionNames.length ? `Pokémon ${versionNames.join(' & ')}` : 'Soul Link run';
  $('#run-players').innerHTML = players
    .map((p) => `<span class="player-chip">${avatar(p, 'sm')}${esc(p.name)}</span>`)
    .join(`<span class="chain-sm">${icon('link')}</span>`);
  rememberRecent(runId, meta.runName);

  // A fix-up write re-renders through the subscription, so stop here.
  if (enforcePartyLimit()) return;

  const groups = groupLinks();
  const conflicts = findTypeConflicts();
  renderTeams(conflicts);
  for (const status of STATUSES) {
    const links = groups[status];
    $(`#count-${status}`).textContent = links.length;
    $(`#nav-${status}`).textContent = links.length;
    const ordered = status === 'dead' ? [...links].reverse() : links;
    $(`#list-${status}`).innerHTML = links.length
      ? ordered.map((l) => renderCard(l, conflicts)).join('')
      : `<p class="empty">${EMPTY_TEXT[status]}</p>`;
  }

  const caught = groups.alive.length + groups.dead.length;
  const survival = caught ? Math.round((groups.alive.length / caught) * 100) : null;
  $('#stats').innerHTML = [
    ['Encounters', state.links.length, ''],
    ['Alive', groups.alive.length, 'good'],
    ['Fallen', groups.dead.length, 'bad'],
    ['Failed', groups.missed.length, ''],
  ].map(([label, value, cls]) => `<div class="stat ${cls}"><span class="value">${value}</span><span class="label">${label}</span></div>`).join('')
    + `<div class="stat survival"><span class="value">${survival == null ? '—' : `${survival}%`}</span><span class="label">Survival</span><span class="bar"><i style="width:${survival ?? 0}%"></i></span></div>`;

  $('#warnings').innerHTML = conflicts.messages.map((w) => `<p class="warning">${esc(w)}</p>`).join('');

  resolveMissingPokemonData();
  prefetchEvolutions();
  preloadGameData();
}

function renderRecentRuns() {
  const recent = lsGet(KEYS.recent, []);
  $('#recent-runs').innerHTML = recent.length
    ? `<h3>Recent runs</h3><ul>${recent.map((r) => `<li><a href="#run=${esc(r.id)}">${icon('ball')}<span>${esc(r.name || r.id)}</span><span class="muted">${esc(r.id)}</span></a></li>`).join('')}</ul>`
    : '';
}

// ---------- route data (what can be caught where) ----------

// Encounter tables per game version, built by tools/build_oras_encounters.py.
// Another game can be added by generating its file and listing its versions here.
const GAME_VERSIONS = {
  'omega-ruby': { name: 'Omega Ruby', short: 'OR', file: 'data/oras.json' },
  'alpha-sapphire': { name: 'Alpha Sapphire', short: 'AS', file: 'data/oras.json' },
};
const gameFiles = new Map();
const gameData = new Map();

function loadGameFile(file) {
  if (!gameFiles.has(file)) {
    gameFiles.set(file, fetch(file)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return null;
        data.byName = new Map(data.locations.map((l) => [l.name.toLowerCase(), l]));
        data.bySpecies = new Map();
        for (const loc of data.locations) for (const p of loc.pokemon) data.bySpecies.set(p.species, p);
        gameData.set(file, data);
        return data;
      })
      .catch(() => null));
  }
  return gameFiles.get(file);
}

const dataFor = (version) => gameData.get(GAME_VERSIONS[version]?.file);

function preloadGameData() {
  for (const player of state.players) {
    const file = GAME_VERSIONS[player.version]?.file;
    if (file && !gameFiles.has(file)) loadGameFile(file).then((data) => data && scheduleRender());
  }
}

// Every location in the players' games, in story order.
function knownLocations() {
  const seen = new Map();
  for (const player of state.players) {
    for (const loc of dataFor(player.version)?.locations || []) {
      if (!seen.has(loc.name.toLowerCase())) seen.set(loc.name.toLowerCase(), loc.name);
    }
  }
  return [...seen.values()];
}

// What `version` can catch at `location`, or null when there's no data for it.
function catchableAt(version, location) {
  const data = dataFor(version);
  const loc = data?.byName.get(String(location || '').trim().toLowerCase());
  if (!loc) return null;
  const others = Object.keys(data.versions).filter((v) => v !== version);
  return loc.pokemon
    .filter((p) => p.methods[version])
    .map((p) => ({ ...p, here: p.methods[version], exclusive: others.length > 0 && others.every((o) => !p.methods[o]) }));
}

// Sprite/type info straight from the route data, so no lookup is needed.
function knownPokemon(slug) {
  for (const data of gameData.values()) {
    const p = data.bySpecies.get(slug);
    if (p) return { dexId: p.dex, types: p.types };
  }
  return null;
}

const versionTag = (version) => {
  const info = GAME_VERSIONS[version];
  return info ? `<span class="version-tag v-${esc(version)}" title="${esc(info.name)}">${esc(info.short)}</span>` : '';
};

// ---------- species dropdown ----------

const levelText = ([lo, hi]) => (lo === hi ? `Lv ${lo}` : `Lv ${lo}–${hi}`);

function pickerRowHtml(option, { caught, versionShort }) {
  return `
    <button type="button" class="picker-row" role="option" data-action="picker-pick" data-species="${esc(option.species)}" data-name="${esc(prettySpecies(option.species).toLowerCase())}">
      <img class="mini" src="${spriteUrl(option.dex)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <span class="row-main">
        <span class="row-name">${esc(prettySpecies(option.species))}</span>
        ${typesHtml(option)}
      </span>
      <span class="row-meta">
        <span class="row-tags">${option.here.map((m) => `<span class="method">${esc(m)}</span>`).join('')}</span>
        <span class="row-sub">${levelText(option.levels)}${option.exclusive ? ` · <span class="excl">${esc(versionShort)} only</span>` : ''}${caught ? ' · <span class="dupe">caught before</span>' : ''}</span>
      </span>
    </button>`;
}

// A dropdown of what this player's game has at `location`; falls back to a
// plain text field when there's no route data. The chosen species always
// lives in the text input named `field`, so saving code just reads that.
function speciesPickerHtml(field, player, location, current, { placeholder = 'Leave blank if none', excludeLinkId = null } = {}) {
  const options = catchableAt(player.version, location);
  const input = (hidden) => `<input name="${esc(field)}" class="picker-input" list="species-list" value="${esc(prettySpecies(current))}" placeholder="${esc(placeholder)}" autocomplete="off"${hidden ? ' hidden' : ''}>`;
  if (!options) return `<label>Pokémon${input(false)}</label>`;

  const info = GAME_VERSIONS[player.version];
  const caughtBefore = new Set(state.links
    .filter((l) => l.id !== excludeLinkId)
    .map((l) => l.encounters?.[player.id]?.species)
    .filter(Boolean));
  const groups = new Map();
  for (const option of options) {
    const key = option.here[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(option);
  }
  const list = [...groups].map(([method, opts]) => `
      <div class="picker-group">
        <div class="picker-group-title">${esc(method)}</div>
        ${opts.map((o) => pickerRowHtml(o, { caught: caughtBefore.has(o.species), versionShort: info.short })).join('')}
      </div>`).join('');
  const selected = options.some((o) => o.species === current);
  const other = Boolean(current) && !selected;
  return `
    <div class="picker" data-field="${esc(field)}">
      <span class="picker-label">Pokémon <span class="muted">· ${esc(info.name)}, ${esc(location)}</span></span>
      <button type="button" class="picker-trigger" data-action="picker-toggle" aria-expanded="false"></button>
      <div class="picker-panel" hidden>
        <input type="search" class="picker-filter" placeholder="Filter ${options.length} Pokémon…" autocomplete="off">
        <div class="picker-list" role="listbox">
          ${list}
          <div class="picker-group">
            <button type="button" class="picker-row picker-extra" data-action="picker-pick" data-species="">None yet</button>
            <button type="button" class="picker-row picker-extra" data-action="picker-other">Other species…</button>
          </div>
        </div>
      </div>
      ${input(!other)}
    </div>`;
}

// Shows the current choice on the dropdown button.
function syncPicker(picker) {
  const input = picker.querySelector('.picker-input');
  const slug = toSlug(input.value);
  const row = slug && picker.querySelector(`.picker-row[data-species="${CSS.escape(slug)}"]`);
  picker.querySelectorAll('.picker-row').forEach((r) => r.setAttribute('aria-selected', String(r === row)));
  const trigger = picker.querySelector('.picker-trigger');
  if (row) {
    trigger.innerHTML = `${row.innerHTML}<span class="chevron">▾</span>`;
  } else if (!input.hidden) {
    trigger.innerHTML = '<span class="picker-placeholder">Other species (type it below)</span><span class="chevron">▾</span>';
  } else {
    trigger.innerHTML = '<span class="picker-placeholder">Choose a Pokémon…</span><span class="chevron">▾</span>';
  }
}

function initPickers(root) {
  root.querySelectorAll('.picker').forEach(syncPicker);
}

function closePickers(except) {
  document.querySelectorAll('.picker-panel:not([hidden])').forEach((panel) => {
    if (panel.closest('.picker') === except) return;
    panel.hidden = true;
    panel.closest('.picker').querySelector('.picker-trigger').setAttribute('aria-expanded', 'false');
  });
}

function togglePicker(picker) {
  const panel = picker.querySelector('.picker-panel');
  closePickers(picker);
  panel.hidden = !panel.hidden;
  picker.querySelector('.picker-trigger').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) {
    const filter = panel.querySelector('.picker-filter');
    filter.value = '';
    filterPicker(filter);
    (panel.querySelector('.picker-row[aria-selected="true"]') || filter).scrollIntoView({ block: 'nearest' });
    filter.focus();
  }
}

function pickSpecies(picker, slug) {
  const input = picker.querySelector('.picker-input');
  input.value = slug ? prettySpecies(slug) : '';
  input.hidden = true;
  syncPicker(picker);
  closePickers();
  picker.querySelector('.picker-trigger').focus();
}

function pickOther(picker) {
  const input = picker.querySelector('.picker-input');
  if (picker.querySelector(`.picker-row[data-species="${CSS.escape(toSlug(input.value))}"]`)) input.value = '';
  input.hidden = false;
  syncPicker(picker);
  closePickers();
  input.focus();
}

function filterPicker(filter) {
  const query = filter.value.trim().toLowerCase();
  const panel = filter.closest('.picker-panel');
  panel.querySelectorAll('.picker-row[data-name]').forEach((row) => {
    row.hidden = Boolean(query) && !row.dataset.name.includes(query);
  });
  panel.querySelectorAll('.picker-group').forEach((group) => {
    group.hidden = ![...group.querySelectorAll('.picker-row')].some((r) => !r.hidden);
  });
}

// ---------- location dropdown ----------

const OTHER_LOCATION = '__other';

function setupLocationField(current, editingLinkId) {
  const form = $('#link-form');
  const select = form.locationPick;
  const input = form.location;
  const locations = knownLocations();
  input.value = current;
  if (!locations.length) {
    select.hidden = true;
    select.required = false;
    input.hidden = false;
    input.required = true;
    return;
  }
  const used = new Set(state.links.filter((l) => l.id !== editingLinkId).map((l) => (l.location || '').trim().toLowerCase()));
  select.innerHTML = '<option value="">Choose a location…</option>'
    + locations.map((name) => `<option value="${esc(name)}">${esc(name)}${used.has(name.toLowerCase()) ? '  ✓ done' : ''}</option>`).join('')
    + `<option value="${OTHER_LOCATION}">Other location…</option>`;
  const match = locations.find((name) => name.toLowerCase() === current.trim().toLowerCase());
  select.value = match || (current ? OTHER_LOCATION : '');
  if (match) input.value = match;
  select.hidden = false;
  select.required = true;
  const typing = select.value === OTHER_LOCATION;
  input.hidden = !typing;
  input.required = typing;
}

function onLocationPicked() {
  const form = $('#link-form');
  const typing = form.locationPick.value === OTHER_LOCATION;
  form.location.hidden = !typing;
  form.location.required = typing;
  if (typing) {
    form.location.value = '';
    form.location.focus();
  } else {
    form.location.value = form.locationPick.value;
  }
  renderLinkPlayerFields(state.links.find((l) => l.id === editingId), { keepEntries: true });
}

// ---------- encounter dialog ----------

let editingId = null;

// Player sections of the encounter dialog. Re-rendered when the location
// changes so each player's dropdown shows what their game has there.
function renderLinkPlayerFields(link, { keepEntries = false } = {}) {
  const form = $('#link-form');
  const location = form.location.value;
  $('#player-fields').innerHTML = state.players.map((p) => {
    const enc = link?.encounters?.[p.id] || {};
    const typed = keepEntries ? {
      species: toSlug(form[`species-${p.id}`]?.value),
      nickname: form[`nickname-${p.id}`]?.value ?? '',
      inParty: form[`party-${p.id}`]?.checked,
    } : null;
    const alreadyIn = link?.status === 'alive' && enc.species && enc.inParty;
    const room = alreadyIn || partyOf(p.id).length < PARTY_LIMIT;
    // New catches go to the party while that player has room.
    const inParty = room && (typed ? typed.inParty : (link ? enc.inParty : true));
    const species = typed ? typed.species : enc.species;
    const nickname = typed ? typed.nickname : enc.nickname;
    return `
      <fieldset style="${playerStyle(p.id)}">
        <legend>${avatar(p, 'sm')}${esc(p.name)}${versionTag(p.version)}</legend>
        ${speciesPickerHtml(`species-${p.id}`, p, location, species, { excludeLinkId: link?.id })}
        <div class="row">
          <label>Nickname
            <input name="nickname-${esc(p.id)}" value="${esc(nickname)}" autocomplete="off">
          </label>
          <label class="checkbox party-check">
            <input type="checkbox" name="party-${esc(p.id)}"${inParty ? ' checked' : ''}${room ? '' : ' disabled'}>
            ${room ? `In ${esc(p.name)}'s party` : `${esc(p.name)}'s party is full (${PARTY_LIMIT}/${PARTY_LIMIT}), goes to the box`}
          </label>
        </div>
      </fieldset>`;
  }).join('');
  initPickers($('#player-fields'));
}

function openLinkDialog(link, presetStatus, faintedPlayerId) {
  editingId = link?.id || null;
  const form = $('#link-form');
  form.reset();
  $('#link-dialog-title').textContent = link ? 'Edit encounter' : 'Add encounter';
  form.querySelector('[data-action="delete-link"]').hidden = !link;

  setupLocationField(link?.location || '', link?.id);
  renderLinkPlayerFields(link);

  const faintedOptions = state.players.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}'s Pokémon</option>`);
  faintedOptions.push('<option value="all">Both / all</option>');
  form.fainted.innerHTML = faintedOptions.join('');

  form.status.value = presetStatus || link?.status || 'alive';
  form.fainted.value = faintedPlayerId || link?.fainted || state.players[0]?.id || 'all';
  form.cause.value = link?.cause || '';
  form.notes.value = link?.notes || '';
  updateDeathFields();

  renderIncompleteShortcuts(link);
  $('#link-dialog').showModal();
  if (presetStatus === 'dead') form.cause.focus();
  else (form.locationPick.hidden ? form.location : form.locationPick).focus();
}

function updateDeathFields() {
  const form = $('#link-form');
  form.querySelector('.death-fields').hidden = form.status.value !== 'dead';
}

function saveLinkForm() {
  const form = $('#link-form');
  const existing = state.links.find((l) => l.id === editingId);
  const id = editingId || newId();
  const status = form.status.value;
  const encounters = {};
  const bumped = [];
  for (const p of state.players) {
    const species = toSlug(form[`species-${p.id}`].value);
    if (!species) continue;
    const prev = existing?.encounters?.[p.id];
    const wasIn = existing?.status === 'alive' && prev?.species && prev.inParty;
    let inParty = form[`party-${p.id}`].checked;
    // Re-checked on save: the partner may have filled the party meanwhile.
    if (inParty && !wasIn && partyOf(p.id).length >= PARTY_LIMIT) {
      inParty = false;
      bumped.push(p.name);
    }
    encounters[p.id] = { species, nickname: form[`nickname-${p.id}`].value.trim(), inParty };
    if (inParty) encounters[p.id].partySince = (wasIn && prev.partySince) || Date.now();
    if (prev?.caughtAs && prev.caughtAs !== species) encounters[p.id].caughtAs = prev.caughtAs;
    // Keep looked-up sprite/types unless the species changed.
    if (prev?.species === species && prev.types) {
      encounters[p.id].dexId = prev.dexId;
      encounters[p.id].types = prev.types;
    } else {
      Object.assign(encounters[p.id], knownPokemon(species));
    }
  }
  const link = {
    location: form.location.value.trim(),
    status,
    encounters,
    notes: form.notes.value.trim(),
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  if (status === 'dead') {
    link.fainted = form.fainted.value;
    link.cause = form.cause.value.trim();
  }
  store.write({ [`links/${id}`]: link });
  if (bumped.length && status === 'alive') {
    toast(`${bumped.join(' and ')}'s party is full, so that Pokémon went to the box.`);
  }
}

// ---------- completing a pair ----------

// Living links where some player hasn't caught their half yet.
function incompleteLinks() {
  return state.links
    .filter((link) => link.status === 'alive')
    .map((link) => ({ link, missing: state.players.filter((p) => !link.encounters?.[p.id]?.species) }))
    .filter(({ link, missing }) => missing.length && missing.length < state.players.length);
}

// In the Add encounter dialog: one-click shortcuts to finish half-caught pairs.
function renderIncompleteShortcuts(editing) {
  const box = $('#incomplete-pairs');
  const pending = editing ? [] : incompleteLinks();
  box.hidden = !pending.length;
  box.innerHTML = pending.length ? `
    <p class="shortcut-title">Waiting on a partner's catch</p>
    <div class="shortcut-list">
      ${pending.flatMap(({ link, missing }) => missing.map((p) => `
        <button type="button" class="shortcut" data-action="add-catch" data-id="${esc(link.id)}" data-player="${esc(p.id)}" style="${playerStyle(p.id)}">
          ${avatar(p, 'sm')}<span><strong>${esc(link.location || 'Unknown location')}</strong><span class="muted">Add ${esc(p.name)}'s catch</span></span>
        </button>`)).join('')}
    </div>` : '';
}

let catching = null;

function openCatchDialog(linkId, playerId) {
  const link = state.links.find((l) => l.id === linkId);
  const player = state.players.find((p) => p.id === playerId);
  if (!link || !player) return;
  $('#link-dialog').open && $('#link-dialog').close();
  catching = { linkId, playerId };
  const form = $('#catch-form');
  form.reset();
  $('#catch-title').textContent = `${player.name}'s catch at ${link.location || 'this location'}`;
  const partners = state.players.filter((p) => p.id !== playerId && link.encounters?.[p.id]?.species);
  $('#catch-linked').innerHTML = partners.map((p) => {
    const enc = link.encounters[p.id];
    return `<div class="linked-to${tint(enc)}" style="${playerStyle(p.id)}">${artHtml(enc, 'art sm')}<span>Linked to <strong>${esc(p.name)}'s ${esc(monName(enc))}</strong>${enc.nickname ? ` <span class="muted">(${esc(prettySpecies(enc.species))})</span>` : ''}</span></div>`;
  }).join('');
  // Follow the partner's placement when there's room.
  const room = partyOf(playerId).length < PARTY_LIMIT;
  const partnerInParty = partners.some((p) => link.encounters[p.id].inParty);
  form.inParty.checked = room && (partnerInParty || !partners.length);
  form.inParty.disabled = !room;
  $('#catch-species').innerHTML = speciesPickerHtml('species', player, link.location, '', { placeholder: 'What did you catch?', excludeLinkId: link.id });
  initPickers($('#catch-species'));
  $('#catch-party-label').textContent = room
    ? `In ${player.name}'s party`
    : `${player.name}'s party is full (${PARTY_LIMIT}/${PARTY_LIMIT}), goes to the box`;
  $('#catch-dialog').showModal();
  ($('#catch-species .picker-trigger') || form.species).focus();
}

function saveCatch() {
  const form = $('#catch-form');
  const species = toSlug(form.species.value);
  if (!catching) return false;
  if (!species) {
    toast('Pick the Pokémon that was caught first.');
    return false;
  }
  const { linkId, playerId } = catching;
  const link = state.links.find((l) => l.id === linkId);
  if (!link) return false;
  let inParty = form.inParty.checked;
  // Re-checked on save: the partner may have filled the party meanwhile.
  if (inParty && partyOf(playerId).length >= PARTY_LIMIT) {
    inParty = false;
    toast(`${playerName(playerId)}'s party is full, so it went to the box.`);
  }
  const enc = { species, nickname: form.nickname.value.trim(), inParty, ...knownPokemon(species) };
  if (inParty) enc.partySince = Date.now();
  // Writes only this player's half so it can't clobber a partner's edit.
  store.write({ [`links/${linkId}/encounters/${playerId}`]: enc });
  catching = null;
  return true;
}

// ---------- evolve dialog ----------

let evolving = null;
const OTHER = '__other';

async function openEvolveDialog(linkId, playerId) {
  const link = state.links.find((l) => l.id === linkId);
  const enc = link?.encounters?.[playerId];
  if (!enc?.species) return;
  evolving = { linkId, playerId };
  const form = $('#evolve-form');
  form.reset();
  $('#evolve-title').textContent = `Evolve ${monName(enc)}`;
  $('#evolve-other').hidden = true;
  $('#evolve-choice').hidden = true;
  $('#evolve-other-toggle').hidden = true;
  $('#evolve-preview').innerHTML = `${previewMon(enc)}<span class="evolve-arrow">${icon('spark')}</span><div class="preview-mon muted">Looking up evolutions…</div>`;
  $('#evolve-dialog').showModal();

  const next = (await loadEvolutions(enc.species)) || [];
  if (evolving?.linkId !== linkId || evolving.playerId !== playerId) return;
  const select = form.evolveTo;
  select.innerHTML = next.map((s) => `<option value="${esc(s)}">${esc(prettySpecies(s))}</option>`).join('')
    + `<option value="${OTHER}">Other species…</option>`;
  select.value = next[0] || OTHER;
  // A single evolution is simply preselected; several get a dropdown.
  $('#evolve-choice').hidden = next.length < 2;
  $('#evolve-other-toggle').hidden = next.length !== 1;
  if (!next.length) showOtherSpecies();
  updateEvolvePreview();
}

function previewMon(enc, label = '') {
  return `
    <div class="preview-mon${tint(enc)}">
      ${artHtml(enc)}
      <div class="nickname">${esc(label || prettySpecies(enc.species))}</div>
      ${typesHtml(enc)}
    </div>`;
}

function showOtherSpecies() {
  const form = $('#evolve-form');
  form.evolveTo.value = OTHER;
  $('#evolve-other').hidden = false;
  $('#evolve-other-toggle').hidden = true;
  form.species.focus();
  updateEvolvePreview();
}

async function updateEvolvePreview() {
  if (!evolving) return;
  const { linkId, playerId } = evolving;
  const enc = state.links.find((l) => l.id === linkId)?.encounters?.[playerId];
  const target = $('#evolve-form').evolveTo.value;
  if (target !== OTHER) $('#evolve-other').hidden = true;
  const preview = $('#evolve-preview');
  if (!enc) return;
  if (target === OTHER) {
    preview.innerHTML = previewMon(enc);
    return;
  }
  const info = (await lookupPokemon(target)) || {};
  if ($('#evolve-form').evolveTo.value !== target) return;
  preview.innerHTML = `${previewMon(enc)}<span class="evolve-arrow">${icon('spark')}</span>${previewMon({ species: target, ...info })}`;
}

function saveEvolution() {
  const form = $('#evolve-form');
  const choice = form.evolveTo.value;
  const species = toSlug(choice === OTHER ? form.species.value : choice);
  if (!evolving || !species) return false;
  const { linkId, playerId } = evolving;
  const enc = state.links.find((l) => l.id === linkId)?.encounters?.[playerId];
  if (!enc || species === enc.species) return false;
  // dexId and types are dropped so the new form is looked up again.
  const { dexId, types, ...rest } = enc;
  store.write({
    [`links/${linkId}/encounters/${playerId}`]: { ...rest, species, caughtAs: enc.caughtAs || enc.species },
  });
  toast(`${monName(enc)} evolved into ${prettySpecies(species)}!`);
  return true;
}

// ---------- settings dialog ----------

const versionOptions = (selected) => '<option value="">Other game (no route data)</option>'
  + Object.entries(GAME_VERSIONS).map(([id, v]) => `<option value="${id}"${id === selected ? ' selected' : ''}>Pokémon ${esc(v.name)}</option>`).join('');

function renderPlayerNameFields(count) {
  const names = [...document.querySelectorAll('#player-name-fields input')].map((i) => i.value);
  const versions = [...document.querySelectorAll('#player-name-fields select')].map((s) => s.value);
  $('#player-name-fields').innerHTML = Array.from({ length: count }, (_, i) => {
    const name = names[i] ?? state.players[i]?.name ?? '';
    const version = versions[i] ?? state.players[i]?.version ?? '';
    return `
      <div class="row">
        <label>Player ${i + 1}<input name="player-${i}" required value="${esc(name)}" autocomplete="off"></label>
        <label>Playing<select name="version-${i}">${versionOptions(version)}</select></label>
      </div>`;
  }).join('');
}

function openSettings() {
  const form = $('#settings-form');
  form.runName.value = state.meta.runName;
  form.game.value = state.meta.game || '';
  form.playerCount.value = String(Math.max(2, state.players.length));
  form.uniqueTypes.checked = state.meta.uniqueTypes !== false;
  $('#player-name-fields').innerHTML = '';
  renderPlayerNameFields(Number(form.playerCount.value));
  $('#settings-dialog').showModal();
}

function saveSettings() {
  const form = $('#settings-form');
  const count = Number(form.playerCount.value);
  const removed = state.players.slice(count);
  if (removed.length && !confirm(`Remove ${removed.map((p) => p.name).join(', ')} and their encounters from this run?`)) {
    return;
  }
  const patches = {
    meta: {
      ...state.meta,
      runName: form.runName.value.trim() || 'Soul Link',
      game: form.game.value.trim(),
      uniqueTypes: form.uniqueTypes.checked,
    },
  };
  for (let i = 0; i < count; i++) {
    const id = state.players[i]?.id || newId(8);
    patches[`players/${id}`] = clean({
      name: form[`player-${i}`].value.trim() || `Player ${i + 1}`,
      order: i,
      version: form[`version-${i}`].value || undefined,
    });
  }
  for (const player of removed) {
    patches[`players/${player.id}`] = null;
    for (const link of state.links) {
      if (link.encounters?.[player.id]) patches[`links/${link.id}/encounters/${player.id}`] = null;
    }
  }
  store.write(patches);
  $('#settings-dialog').close();
}

// ---------- import / export ----------

function exportRun() {
  const players = Object.fromEntries(state.players.map(({ id, name, order }) => [id, { name, order }]));
  const links = Object.fromEntries(state.links.map(({ id, legacyStatus, ...rest }) => [id, rest]));
  const payload = {
    format: 'soul-link-tracker',
    version: 1,
    exportedAt: new Date().toISOString(),
    run: { meta: state.meta, players, links },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `soul-link-${toSlug(state.meta.runName) || 'run'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importRun(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const run = parsed.run || parsed;
    if (!run.meta || typeof run.players !== 'object' || !run.players) throw new Error('missing run data');
    if (!confirm('Replace everything in this run (for both of you) with the imported file?')) return;
    await store.write({ meta: run.meta, players: run.players, links: run.links || null });
    toast('Run imported.');
  } catch (err) {
    toast(`Could not import that file (${err.message}).`);
  }
}

// ---------- events ----------

async function copyShareLink() {
  const url = runUrl(runId);
  try {
    await navigator.clipboard.writeText(url);
    toast(store.mode === 'firebase'
      ? 'Link copied. Send it to your partner.'
      : 'Link copied. Firebase isn\'t set up yet, so your partner won\'t see your data.');
  } catch {
    prompt('Copy this link and send it to your partner:', url);
  }
}

// ---------- swap dialog ----------

let swapping = null;

function openSwapDialog(linkId, playerId) {
  const incoming = state.links.find((l) => l.id === linkId)?.encounters?.[playerId];
  if (!incoming) return;
  swapping = { linkId, playerId };
  $('#swap-title').textContent = `${playerName(playerId)}'s party is full. Swap in ${monName(incoming)}?`;
  $('#swap-options').innerHTML = partyOf(playerId).map((link) => {
    const enc = link.encounters[playerId];
    return `
      <button type="button" class="swap-option" data-action="swap-pick" data-id="${esc(link.id)}">
        ${artHtml(enc, 'art sm')}
        <span class="nickname">${esc(monName(enc))}</span>
        ${typesHtml(enc)}
      </button>`;
  }).join('');
  $('#swap-dialog').showModal();
}

function swapInto(outLinkId, inLinkId, playerId) {
  return movePokemon([
    { linkId: outLinkId, playerId, inParty: false },
    { linkId: inLinkId, playerId, inParty: true },
  ]);
}

// ---------- drag and drop (desktop) ----------

let dragged = null;

function bindDragAndDrop() {
  const root = $('#parties');
  root.addEventListener('dragstart', (event) => {
    const slot = event.target.closest('.slot[data-id]');
    if (!slot) return;
    dragged = { linkId: slot.dataset.id, playerId: slot.dataset.player };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragged.linkId);
    slot.classList.add('dragging');
  });
  root.addEventListener('dragend', () => {
    dragged = null;
    root.querySelectorAll('.dragging, .drag-over').forEach((el) => el.classList.remove('dragging', 'drag-over'));
  });
  root.addEventListener('dragover', (event) => {
    const zone = event.target.closest('.drop');
    // Pokémon only move within their own player's party and box.
    if (!dragged || !zone || zone.dataset.player !== dragged.playerId) return;
    event.preventDefault();
    root.querySelectorAll('.drag-over').forEach((el) => el !== zone && el.classList.remove('drag-over'));
    zone.classList.add('drag-over');
  });
  root.addEventListener('drop', (event) => {
    const zone = event.target.closest('.drop');
    if (!dragged || !zone || zone.dataset.player !== dragged.playerId) return;
    event.preventDefault();
    const { linkId, playerId } = dragged;
    const inParty = Boolean(state.links.find((l) => l.id === linkId)?.encounters?.[playerId]?.inParty);
    if (zone.dataset.drop === 'box') {
      if (inParty) movePokemon([{ linkId, playerId, inParty: false }]);
      return;
    }
    if (inParty) return;
    // Dropped onto a party member: swap the two.
    const target = event.target.closest('.slot[data-id]');
    if (target && target.dataset.id !== linkId) swapInto(target.dataset.id, linkId, playerId);
    else sendToParty(linkId, playerId);
  });
}

function handleAction(action, id, button) {
  const link = state.links.find((l) => l.id === id);
  switch (action) {
    case 'add': return openLinkDialog(null);
    case 'edit': return openLinkDialog(link);
    case 'kill': return openLinkDialog(link, 'dead', button.dataset.player);
    case 'add-catch': return openCatchDialog(id, button.dataset.player);
    case 'to-party': return sendToParty(id, button.dataset.player);
    case 'to-box': return movePokemon([{ linkId: id, playerId: button.dataset.player, inParty: false }]);
    case 'swap-pick':
      if (swapping) swapInto(id, swapping.linkId, swapping.playerId);
      swapping = null;
      return $('#swap-dialog').close();
    case 'evolve': return openEvolveDialog(id, button.dataset.player);
    case 'evolve-other': return showOtherSpecies();
    case 'picker-toggle': return togglePicker(button.closest('.picker'));
    case 'picker-pick': return pickSpecies(button.closest('.picker'), button.dataset.species);
    case 'picker-other': return pickOther(button.closest('.picker'));
    case 'share': return copyShareLink();
    case 'jump': return document.getElementById(button.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    case 'settings': return openSettings();
    case 'export': return exportRun();
    case 'close-dialog': return document.querySelector('dialog[open]')?.close();
    case 'delete-link':
      if (editingId && confirm('Delete this encounter for everyone?')) {
        store.write({ [`links/${editingId}`]: null });
        $('#link-dialog').close();
      }
      return;
    case 'reset':
      if (confirm('Delete every encounter in this run for everyone? Players and settings are kept.')) {
        store.write({ links: null });
        $('#settings-dialog').close();
      }
      return;
    case 'init-missing':
      return store.write(initialRun({ runName: 'Soul Link', game: '', playerNames: ['Player 1', 'Player 2'] }));
  }
}

function bindRunEvents() {
  bindDragAndDrop();
  document.addEventListener('click', (event) => {
    // Close the ⋯ menu on any click outside it or on one of its items.
    const menu = $('.menu[open]');
    if (menu && (!menu.contains(event.target) || event.target.closest('.menu-list'))) menu.open = false;
    if (!event.target.closest('.picker')) closePickers();
    const button = event.target.closest('[data-action]');
    if (button) handleAction(button.dataset.action, button.dataset.id, button);
  });
  $('#link-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveLinkForm();
    $('#link-dialog').close();
  });
  $('#catch-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (saveCatch()) $('#catch-dialog').close();
  });
  $('#evolve-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (saveEvolution()) $('#evolve-dialog').close();
    else if (event.target.evolveTo.value === OTHER) event.target.species.focus();
  });
  $('#evolve-form').evolveTo.addEventListener('change', (event) => {
    if (event.target.value === OTHER) showOtherSpecies();
    else updateEvolvePreview();
  });
  document.addEventListener('input', (event) => {
    if (event.target.matches('.picker-filter')) filterPicker(event.target);
  });
  document.addEventListener('keydown', (event) => {
    const picker = event.target.closest?.('.picker');
    if (!picker) return;
    const panel = picker.querySelector('.picker-panel');
    if (event.key === 'Escape' && !panel.hidden) {
      // Close the dropdown, not the whole dialog.
      event.preventDefault();
      closePickers();
      picker.querySelector('.picker-trigger').focus();
    } else if (event.key === 'Enter' && event.target.matches('.picker-filter')) {
      event.preventDefault();
      const first = [...panel.querySelectorAll('.picker-row[data-species]')].find((r) => !r.hidden && r.dataset.species);
      if (first) pickSpecies(picker, first.dataset.species);
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !panel.hidden) {
      event.preventDefault();
      const rows = [...panel.querySelectorAll('.picker-row')].filter((r) => !r.hidden && !r.closest('.picker-group[hidden]'));
      const at = rows.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown' ? rows[Math.min(rows.length - 1, at + 1)] : (at <= 0 ? panel.querySelector('.picker-filter') : rows[at - 1]);
      next?.focus();
    }
  });
  $('#link-form').locationPick.addEventListener('change', onLocationPicked);
  $('#link-form').location.addEventListener('change', () => {
    if ($('#link-form').locationPick.value === OTHER_LOCATION) {
      renderLinkPlayerFields(state.links.find((l) => l.id === editingId), { keepEntries: true });
    }
  });
  $('#link-form').status.addEventListener('change', updateDeathFields);
  $('#settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveSettings();
  });
  $('#settings-form').playerCount.addEventListener('change', (event) => {
    renderPlayerNameFields(Number(event.target.value));
  });
  $('#import-file').addEventListener('change', (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (file) importRun(file);
  });
}

function bindHomeEvents() {
  document.querySelectorAll('.version-select').forEach((select) => { select.innerHTML = versionOptions(''); });
  $('#create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Creating…';
    const id = newId(12);
    const newStore = await createStore(id);
    await newStore.write(initialRun({
      runName: form.runName.value.trim() || 'Soul Link',
      game: form.game.value.trim(),
      playerNames: [form.p1.value.trim(), form.p2.value.trim()],
      versions: [form.v1.value, form.v2.value],
    }));
    location.hash = `run=${id}`;
  });
  $('#join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const id = parseRunId(event.target.code.value);
    if (id) location.hash = `run=${id}`;
    else toast('That doesn\'t look like a run link or code.');
  });
}

// ---------- boot ----------

async function main() {
  document.querySelectorAll('[data-icon]').forEach((el) => el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)));
  // Switching runs gets a clean page so no old subscription lingers.
  window.addEventListener('hashchange', () => location.reload());
  runId = parseRunId(location.hash);

  if (!runId) {
    $('#home-view').hidden = false;
    if (!firebaseEnabled()) {
      const note = $('#home-mode');
      note.hidden = false;
      note.textContent = 'Firebase isn\'t configured, so runs are saved in this browser only and can\'t be shared yet. See README.md to set it up.';
    }
    renderRecentRuns();
    bindHomeEvents();
    return;
  }

  $('#run-view').hidden = false;
  bindRunEvents();
  loadSpeciesList();
  store = await createStore(runId);
  renderSync(false);
  store.onConnection(renderSync);
  store.subscribe((raw) => {
    state = normalize(raw);
    renderRun();
  });
}

main();
