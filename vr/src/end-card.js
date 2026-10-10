/* vr/src/end-card.js - W3: the end card data + the "new kitten tomorrow" return loop (plan 1.3: 9:30-10:00 end
   card with hearts per kitten and a silhouette of tomorrow's kitten; Reason to Come Back: 3 kittens on day 1, +1 per
   return day, up to 8 on screen, from the 24 original cats).
   Gaming Engineer 2, 2026-10-09. PURE: no DOM / storage / Date (the host passes the clock; the local save of the visit is
   vr/src/visit-store.js, an engine-neutral localStorage-like adapter). Node-tested in vr/test/end-card.test.mjs.
   The "Tomorrow: a new kitten" promise is only made when it is TRUE (Code Review B 07:2x SHOULD 2): the host passes
   `persisted: true` (the visit was saved, so tomorrow IS visit + 1) and tomorrow's newcomer is not already in today's box.
   Entry rules honoured here: no in-game currency, store or sign-up text (legal section 12 item 6); the roster the
   host passes must be the starter / free cats only (item 4) - this module takes ids / names as data and never names a cat. */
export const END_CARD_VERSION = 2; // 2: the tomorrow line needs a saved visit + a real newcomer
export const RETURN_TUNING = Object.freeze({ day1: 3, perDay: 1, maxCats: 8, heartBond: 2, maxHearts: 5 });
const DAY_MS = 86400000;

/** Local calendar day index from a UTC clock (ms) and the device's timezone offset in MINUTES (Date#getTimezoneOffset
 *  sign: minutes to ADD to local to get UTC, so local = utc - offset). */
export function localDay(nowMs, tzOffsetMin) {
  const off = Number.isFinite(tzOffsetMin) ? tzOffsetMin : 0;
  return Math.floor((nowMs - off * 60000) / DAY_MS);
}

/**
 * Which visit this is. saved = { day, visit } from the last session (or null). Same local day = the same visit (no new
 * kitten until tomorrow); any later day = visit + 1 (a missed week still gives ONE new kitten, never a backlog).
 * Returns { visit, day, isNew }.
 */
export function visitFor(saved, day) {
  if (!saved || !Number.isFinite(saved.visit) || !Number.isFinite(saved.day)) return { visit: 1, day, isNew: true };
  if (day <= saved.day) return { visit: saved.visit, day: saved.day, isNew: false };
  return { visit: saved.visit + 1, day, isNew: true };
}

function ecId(entry) { return typeof entry === 'string' ? entry : entry && entry.id != null ? String(entry.id) : ''; }
function ecName(entry) { return typeof entry === 'string' ? entry : (entry && (entry.name || entry.id)) != null ? String(entry.name || entry.id) : ''; }

/**
 * The kittens for a visit (plan 1.3). roster = ordered list of ids or { id, name }. Visit n has min(day1 + (n-1) * perDay,
 * maxCats) kittens: the newest ones of roster[0 .. day1 + (n-1)), so a newcomer arrives every visit and, once the cap is
 * reached, the oldest kitten stays home (it is still in the collection). Past the roster end it wraps.
 * Returns { ids, newId (today's newcomer, null on visit 1), count }.
 */
export function rosterForVisit(roster, visit, tuning) {
  const T = tuning || RETURN_TUNING;
  const list = Array.isArray(roster) ? roster.map(ecId).filter(Boolean) : [];
  if (!list.length) return { ids: [], newId: null, count: 0 };
  const n = Math.max(1, Math.floor(visit) || 1);
  const want = Math.min(T.day1 + (n - 1) * T.perDay, T.maxCats, list.length);
  const end = T.day1 + (n - 1) * T.perDay; // exclusive index of the newest kitten + 1
  const ids = [];
  if (want >= list.length) ids.push(...list); // a tiny roster: everyone, in order
  else for (let i = end - want; i < end; i++) ids.push(list[((i % list.length) + list.length) % list.length]);
  return { ids, newId: n > 1 ? list[((end - 1) % list.length + list.length) % list.length] : null, count: ids.length };
}

/** Tomorrow's newcomer (the silhouette on the end card) = the newest kitten of visit + 1, or null when that kitten is
 *  already in today's box (a roster no longer than today's visit: nothing new would come). */
export function tomorrowKitten(roster, visit, tuning) {
  const v = Math.floor(visit) || 1;
  const r = rosterForVisit(roster, v + 1, tuning);
  const id = r.ids.length ? r.ids[r.ids.length - 1] : null;
  if (id == null) return null;
  return rosterForVisit(roster, v, tuning).ids.indexOf(id) >= 0 ? null : id;
}

/** Hearts for a bond count: one heart per heartBond bond points, capped at maxHearts; a touched kitten always shows one. */
export function heartsFor(bond, tuning) {
  const T = tuning || RETURN_TUNING;
  const b = Math.max(0, Math.floor(bond) || 0);
  if (b === 0) return 0;
  return Math.max(1, Math.min(T.maxHearts, Math.floor(b / T.heartBond)));
}

const EC_NAP = { seat: 'on your couch', bed: 'on your bed', floor: 'on the floor', rug: 'on the rug', table: 'on the table', shelf: 'on a shelf' };

/**
 * Build the end card. { state (roomcat state), room (createRoom), roster, visit, names?: { [id]: name }, playedS,
 * persisted: true when the host SAVED this visit locally (visit-store.js), so a return tomorrow really is visit + 1;
 * without it (or with a roster that has no newcomer) the tomorrow line and silhouette are left out, never a false promise }.
 * Returns plain data for the host to draw: { title, kittens: [{ id, name, bond, hearts, napSpot }], totalHearts,
 * tomorrow: { id, name, silhouette: true, line }, played: { s, text }, lines: [...] (the whole card as text, for the 2D
 * page / captions) }.
 */
export function buildEndCard(o) {
  const state = o && o.state, room = o && o.room, roster = (o && o.roster) || [], visit = (o && o.visit) || 1;
  const names = (o && o.names) || {};
  const nameOf = (id) => names[id] || ecName(roster.find((e) => ecId(e) === id)) || id;
  const kittens = [];
  for (const k of (state && state.cats) || []) {
    const surf = room && room.byId && k.surf ? room.byId[k.surf] : null;
    const kind = surf ? surf.kind : null;
    kittens.push({ id: k.id, name: nameOf(k.id), bond: k.bond || 0, hearts: heartsFor(k.bond), napSpot: k.mode === 'nap' ? (EC_NAP[kind] || 'in your room') : null });
  }
  kittens.sort((a, b) => b.hearts - a.hearts || b.bond - a.bond || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const totalHearts = kittens.reduce((n, k) => n + k.hearts, 0);
  const tid = o && o.persisted === true ? tomorrowKitten(roster, visit) : null;
  const tomorrow = { id: tid, name: tid ? nameOf(tid) : null, silhouette: true, line: 'Tomorrow: a new kitten is in the box' };
  const s = Math.max(0, Math.round((o && o.playedS) || 0));
  const played = { s, text: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} with the kittens` };
  const lines = ['Nap time'];
  for (const k of kittens) lines.push(`${k.name}  ${'♥'.repeat(k.hearts)}${k.hearts ? '' : '♡'}${k.napSpot ? '  asleep ' + k.napSpot : ''}`);
  lines.push(played.text);
  if (tid) lines.push(tomorrow.line);
  lines.push('Come back tomorrow. Take a break now!');
  return { title: 'Nap time', kittens, totalHearts, tomorrow, played, lines };
}

/** Should the end card show? From 9:30 (the sim's nap phase has run its course) or the 'end' phase, plan 1.3. */
export function endCardDue(state, sessionS) { return !!state && (state.phase === 'end' || (state.phase === 'nap' && sessionS >= 570)); }
