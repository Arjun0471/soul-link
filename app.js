import { firebaseConfig } from './firebase-config.js';

const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const POKEAPI = 'https://pokeapi.co/api/v2';
const spriteUrl = (dexId) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${dexId}.png`;

const PARTY_LIMIT = 6;
const STATUSES = ['party', 'box', 'dead', 'missed'];
const EMPTY_TEXT = {
  party: 'No one in the party yet.',
  box: 'The box is empty.',
  dead: 'Nobody has fallen. Yet.',
  missed: 'No failed encounters.',
};
const KEYS = {
  recent: 'slt:recent-runs',
  speciesList: 'slt:species-list',
  pokemonCache: 'slt:pokemon-cache',
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

function initialRun({ runName, game, playerNames }) {
  const players = {};
  playerNames.forEach((name, order) => {
    players[newId(8)] = { name, order };
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
    .map(([id, p]) => ({ id, name: p.name || 'Player', order: p.order ?? 0 }))
    .sort((a, b) => a.order - b.order);
  const links = Object.entries(data.links || {})
    .map(([id, link]) => ({ id, location: '', status: 'box', encounters: {}, ...link }))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return { exists: Boolean(data.meta), meta, players, links };
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
  const groups = { party: [], box: [], dead: [], missed: [] };
  for (const link of state.links) (groups[link.status] || groups.box).push(link);
  return groups;
}

// Common Soul Link rule: no two Pokémon in one player's party may share a primary type.
function findTypeConflicts(partyLinks) {
  const byLink = new Map();
  const messages = [];
  if (!state.meta.uniqueTypes) return { byLink, messages };
  for (const player of state.players) {
    const byType = {};
    for (const link of partyLinks) {
      const type = link.encounters?.[player.id]?.types?.[0];
      if (type) (byType[type] ||= []).push(link);
    }
    for (const [type, links] of Object.entries(byType)) {
      if (links.length < 2) continue;
      const names = links.map((l) => monName(l.encounters[player.id]));
      messages.push(`${player.name}'s party has ${links.length} ${prettySpecies(type)}-type primaries: ${names.join(', ')}.`);
      for (const link of links) {
        if (!byLink.has(link.id)) byLink.set(link.id, []);
        byLink.get(link.id).push(`${player.name}: ${prettySpecies(type)}`);
      }
    }
  }
  return { byLink, messages };
}

const monName = (enc) => enc?.nickname || prettySpecies(enc?.species) || '—';

// ---------- rendering ----------

function renderSync(connected) {
  const pill = $('#sync-status');
  if (store?.mode === 'firebase') {
    pill.textContent = connected ? '● Live' : '○ Offline, will sync';
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

function renderMon(link, player) {
  const enc = link.encounters?.[player.id];
  if (!enc?.species) {
    return `<div class="mon empty"><div class="owner">${esc(player.name)}</div><div class="muted">No encounter</div></div>`;
  }
  const fainted = link.status === 'dead' && (link.fainted === player.id || link.fainted === 'all');
  const sprite = enc.dexId
    ? `<img src="${spriteUrl(enc.dexId)}" alt="" loading="lazy" onerror="this.remove()">`
    : '<div class="sprite-placeholder">?</div>';
  const types = (enc.types || []).map((t) => `<span class="type t-${esc(t)}">${esc(t)}</span>`).join('');
  const speciesLine = enc.nickname ? `<div class="species">${esc(prettySpecies(enc.species))}</div>` : '';
  return `
    <div class="mon${fainted ? ' fainted' : ''}">
      <div class="owner">${esc(player.name)}${fainted ? ' <span title="Fainted">💀</span>' : ''}</div>
      ${sprite}
      <div class="nickname">${esc(monName(enc))}</div>
      ${speciesLine}
      <div class="types">${types}</div>
    </div>`;
}

function renderCard(link, conflicts) {
  const mons = state.players.map((p) => renderMon(link, p)).join('<span class="chain" aria-hidden="true">⛓</span>');
  const clash = conflicts.byLink.get(link.id);
  const actions = [];
  if (link.status === 'party') actions.push(['to-box', 'To box']);
  if (link.status === 'box') actions.push(['to-party', 'To party']);
  if (link.status === 'party' || link.status === 'box') actions.push(['kill', 'Fainted…']);
  actions.push(['edit', 'Edit']);
  const cause = link.status === 'dead' && link.cause ? `<p class="cause">☠ ${esc(link.cause)}</p>` : '';
  return `
    <article class="card status-${esc(link.status)}${clash ? ' clash' : ''}" data-id="${esc(link.id)}">
      <header><span class="location">${esc(link.location || 'Unknown location')}</span></header>
      <div class="pair">${mons}</div>
      ${clash ? `<p class="clash-note">Type clash (${esc(clash.join('; '))})</p>` : ''}
      ${cause}
      ${link.notes ? `<p class="notes">${esc(link.notes)}</p>` : ''}
      <footer>${actions.map(([a, label]) => `<button type="button" data-action="${a}" data-id="${esc(link.id)}">${label}</button>`).join('')}</footer>
    </article>`;
}

function renderRun() {
  $('#run-loading').hidden = true;
  $('#run-missing').hidden = state.exists;
  $('#run-content').hidden = !state.exists;
  if (!state.exists) return;

  const { meta, players } = state;
  document.title = `${meta.runName} · Soul Link Tracker`;
  $('#run-name').textContent = meta.runName;
  $('#run-meta').textContent = [meta.game, players.map((p) => p.name).join(' ⛓ ')].filter(Boolean).join(' · ');
  rememberRecent(runId, meta.runName);

  const groups = groupLinks();
  const conflicts = findTypeConflicts(groups.party);
  for (const status of STATUSES) {
    const links = groups[status];
    $(`#count-${status}`).textContent = status === 'party' ? `${links.length}/${PARTY_LIMIT}` : links.length;
    $(`#list-${status}`).innerHTML = links.length
      ? links.map((l) => renderCard(l, conflicts)).join('')
      : `<p class="empty">${EMPTY_TEXT[status]}</p>`;
  }

  const alive = groups.party.length + groups.box.length;
  const caught = alive + groups.dead.length;
  $('#stats').innerHTML = [
    ['Encounters', state.links.length],
    ['Alive', alive],
    ['Dead', groups.dead.length],
    ['Failed', groups.missed.length],
    ['Survival', caught ? `${Math.round((alive / caught) * 100)}%` : '—'],
  ].map(([label, value]) => `<div class="stat"><span class="value">${value}</span><span class="label">${label}</span></div>`).join('');

  const warnings = [...conflicts.messages];
  if (groups.party.length > PARTY_LIMIT) {
    warnings.unshift(`The party has ${groups.party.length} links. Only ${PARTY_LIMIT} fit.`);
  }
  $('#warnings').innerHTML = warnings.map((w) => `<p class="warning">⚠ ${esc(w)}</p>`).join('');

  resolveMissingPokemonData();
}

function renderRecentRuns() {
  const recent = lsGet(KEYS.recent, []);
  $('#recent-runs').innerHTML = recent.length
    ? `<h3>Recent runs</h3><ul>${recent.map((r) => `<li><a href="#run=${esc(r.id)}">${esc(r.name || r.id)}</a></li>`).join('')}</ul>`
    : '';
}

// ---------- encounter dialog ----------

let editingId = null;

function openLinkDialog(link, presetStatus) {
  editingId = link?.id || null;
  const form = $('#link-form');
  form.reset();
  $('#link-dialog-title').textContent = link ? 'Edit encounter' : 'Add encounter';
  form.querySelector('[data-action="delete-link"]').hidden = !link;

  $('#player-fields').innerHTML = state.players.map((p) => {
    const enc = link?.encounters?.[p.id] || {};
    return `
      <fieldset>
        <legend>${esc(p.name)}</legend>
        <div class="row">
          <label>Pokémon
            <input name="species-${esc(p.id)}" list="species-list" value="${esc(prettySpecies(enc.species))}" placeholder="Leave blank if none" autocomplete="off">
          </label>
          <label>Nickname
            <input name="nickname-${esc(p.id)}" value="${esc(enc.nickname)}" autocomplete="off">
          </label>
        </div>
      </fieldset>`;
  }).join('');

  const faintedOptions = state.players.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}'s Pokémon</option>`);
  faintedOptions.push('<option value="all">Both / all</option>');
  form.fainted.innerHTML = faintedOptions.join('');

  const partyFull = groupLinks().party.length >= PARTY_LIMIT;
  form.location.value = link?.location || '';
  form.status.value = presetStatus || link?.status || (partyFull ? 'box' : 'party');
  form.fainted.value = link?.fainted || state.players[0]?.id || 'all';
  form.cause.value = link?.cause || '';
  form.notes.value = link?.notes || '';
  updateDeathFields();

  $('#link-dialog').showModal();
  (presetStatus === 'dead' ? form.cause : form.location).focus();
}

function updateDeathFields() {
  const form = $('#link-form');
  form.querySelector('.death-fields').hidden = form.status.value !== 'dead';
}

function saveLinkForm() {
  const form = $('#link-form');
  const existing = state.links.find((l) => l.id === editingId);
  const id = editingId || newId();
  const encounters = {};
  for (const p of state.players) {
    const species = toSlug(form[`species-${p.id}`].value);
    if (!species) continue;
    const prev = existing?.encounters?.[p.id];
    encounters[p.id] = { species, nickname: form[`nickname-${p.id}`].value.trim() };
    // Keep looked-up sprite/types unless the species changed (e.g. it evolved).
    if (prev?.species === species && prev.types) {
      encounters[p.id].dexId = prev.dexId;
      encounters[p.id].types = prev.types;
    }
  }
  const status = form.status.value;
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
}

// ---------- settings dialog ----------

function renderPlayerNameFields(count) {
  const current = [...document.querySelectorAll('#player-name-fields input')].map((i) => i.value);
  $('#player-name-fields').innerHTML = Array.from({ length: count }, (_, i) => {
    const value = current[i] ?? state.players[i]?.name ?? '';
    return `<label>Player ${i + 1}<input name="player-${i}" required value="${esc(value)}" autocomplete="off"></label>`;
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
    patches[`players/${id}`] = { name: form[`player-${i}`].value.trim() || `Player ${i + 1}`, order: i };
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
  const links = Object.fromEntries(state.links.map(({ id, ...rest }) => [id, rest]));
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

function handleAction(action, id) {
  const link = state.links.find((l) => l.id === id);
  switch (action) {
    case 'add': return openLinkDialog(null);
    case 'edit': return openLinkDialog(link);
    case 'kill': return openLinkDialog(link, 'dead');
    case 'to-box': return store.write({ [`links/${id}/status`]: 'box' });
    case 'to-party':
      if (groupLinks().party.length >= PARTY_LIMIT) toast(`Heads up: the party already has ${PARTY_LIMIT}.`);
      return store.write({ [`links/${id}/status`]: 'party' });
    case 'share': return copyShareLink();
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
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (button) handleAction(button.dataset.action, button.dataset.id);
  });
  $('#link-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveLinkForm();
    $('#link-dialog').close();
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
