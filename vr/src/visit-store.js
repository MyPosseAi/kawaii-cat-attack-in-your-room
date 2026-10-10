/* vr/src/visit-store.js - W3 (Code Review B 07:2x SHOULD 2): the local save of the visit that makes the end card's
   "Tomorrow: a new kitten is in the box" TRUE. Gaming Engineer 2, 2026-10-09.
   PURE and engine-neutral: no DOM, no Date, no globals. The host hands in a localStorage-LIKE adapter ({ getItem(key),
   setItem(key, value) }, strings in / out) and the clock; node-tested in vr/test/visit-store.test.mjs with
   memoryStorage(). What is stored: ONE small JSON record under VISIT_STORE_KEY:
     { v: 1, day, visit, memory? }  = the local calendar day of the last visit, its number and (W4, Legal) the
     kitten memory `memory = { v, cats }`: per fixed-roster kitten id ONLY { bond (int 0-60), met (visit NUMBER, int),
     spot (null | { kind, label }: one word each from MEMORY_KINDS / MEMORY_LABELS) }, max 24 kittens. Nothing else,
     nothing sent anywhere (legal/SK-77-VR-COMPETITION.md 10, 10.1, 10.2; FOR-DEV): never anchors, coordinates,
     poses, sizes, planes, meshes, surface counts or a time; try/catch around every storage call; the start card says
     so (vr/index.html #privacy = the 10.2 three-sentence line word for word, in the SAME build as this flag).
   KITTEN_MEMORY_PERSIST (the Legal gate) is TRUE since 2026-10-09 11:xx. sanitizeMemoryFields is the ONE
   whitelist, applied on read AND write (return-visit.js sanitizeMemory adds the roster; writeVisit re-applies it to a
   memory it carries across beginVisit, so a tampered record never keeps arbitrary text: Code Review L W4 SHOULD 2).
   Were the gate ever closed again: writeVisit drops the field, return-visit.js keeps the memory in a session map.
   Build rule: only `export function` / `export const`; private names carry the `vs` prefix. */
import { localDay, visitFor } from './end-card.js';

export const VISIT_STORE_VERSION = 1;
export const VISIT_STORE_KEY = 'kca.vr.visit';
/** LEGAL GATE (Code Review J W4 MUST 1; opened 2026-10-09 per legal/SK-77-VR-COMPETITION.md 10.2 / FOR-DEV,
 *  together with the new start-card sentence in vr/index.html). While false nothing but { v, day, visit } is ever written
 *  under VISIT_STORE_KEY (vr/test/return-visit.test.mjs proves both states through the gate argument). */
export const KITTEN_MEMORY_PERSIST = true;
/** The fixed vocabularies a nap spot may be stored as (legal 10.2): ONE word each, nothing else ever. */
export const MEMORY_KINDS = Object.freeze(['floor', 'rug', 'seat', 'bed', 'table', 'shelf', 'perch']);
export const MEMORY_LABELS = Object.freeze(['floor', 'rug', 'couch', 'bed', 'table', 'storage', 'shelf', 'desk', 'chair', 'other']);
export const MEMORY_LIMITS = Object.freeze({ maxBond: 60, maxCats: 24, maxMet: 100000 });
const VS_ID = /^[A-Za-z0-9_-]{1,24}$/; // a roster-style id (never free text); with a roster only its ids pass

/** The ONE label word stored for a nap spot: the room label when it is in MEMORY_LABELS, else the kind when that word is
 *  in MEMORY_LABELS too (floor / rug / bed / table / shelf), else 'other' ('seat' / 'perch' are kinds, not label words).
 *  Never a word outside MEMORY_LABELS: this is the rule legal 10.2 bullet 1 is being aligned to (Code Review N, SHOULD 1:
 *  "unknown label -> the kind when that word is in the label list, else 'other'"). */
export function memoryLabel(label, kind) {
  if (MEMORY_LABELS.indexOf(label) >= 0) return label;
  return MEMORY_LABELS.indexOf(kind) >= 0 ? kind : 'other';
}

function vsClamp(n, lo, hi) { n = Math.floor(Number(n)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }

/** THE memory whitelist (read AND write): a fresh { v, cats } holding, per allowed id, exactly { bond, met, spot } with
 *  spot = null | { kind, label } from MEMORY_KINDS / MEMORY_LABELS (unknown label -> memoryLabel). roster = the allowed ids
 *  (strings or { id }); omitted = any roster-style id (the next read with a roster drops the rest). Never throws. */
export function sanitizeMemoryFields(raw, roster, limits) {
  const L = limits || MEMORY_LIMITS;
  const ok = Array.isArray(roster) ? new Set(roster.map((e) => (typeof e === 'string' ? e : e && e.id != null ? String(e.id) : '')).filter(Boolean)) : null;
  const out = { v: 1, cats: {} };
  const cats = raw && typeof raw === 'object' && raw.cats && typeof raw.cats === 'object' && !Array.isArray(raw.cats) ? raw.cats : {};
  let n = 0;
  for (const id of Object.keys(cats)) {
    if (id === '__proto__' || (ok ? !ok.has(id) : !VS_ID.test(id)) || n >= L.maxCats) continue; // never re-prototype out.cats (Code Review N NIT 1)
    const c = cats[id]; if (!c || typeof c !== 'object') continue;
    let spot = null;
    if (c.spot && typeof c.spot === 'object' && MEMORY_KINDS.indexOf(c.spot.kind) >= 0) spot = { kind: c.spot.kind, label: memoryLabel(c.spot.label, c.spot.kind) };
    out.cats[id] = { bond: vsClamp(c.bond, 0, L.maxBond), met: vsClamp(c.met, 1, L.maxMet), spot };
    n++;
  }
  return out;
}

/** The memory shape allowed INTO the record: { v, cats } with every cat whitelisted (sanitizeMemoryFields), or null when
 *  there is nothing valid to carry (Code Review J W4 SHOULD 2 + L SHOULD 2: a tampered record's extra fields or text never
 *  ride along). */
export function visitMemoryShape(m, roster) {
  if (!m || typeof m !== 'object' || !m.cats || typeof m.cats !== 'object' || Array.isArray(m.cats)) return null;
  const clean = sanitizeMemoryFields(m, roster);
  return Object.keys(clean.cats).length ? clean : null;
}

/** A localStorage-like adapter in memory (tests, private browsing, a host with no storage). */
export function memoryStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

function vsValid(rec) {
  return !!rec && typeof rec === 'object' && Number.isFinite(rec.day) && Number.isFinite(rec.visit) && rec.visit >= 1 && rec.day >= 0;
}

/** The saved visit { day, visit } or null (missing, unreadable, corrupt, or no storage). Never throws. */
export function readVisit(storage, key) {
  const k = key || VISIT_STORE_KEY;
  try {
    if (!storage || typeof storage.getItem !== 'function') return null;
    const raw = storage.getItem(k);
    if (typeof raw !== 'string' || !raw) return null;
    const rec = JSON.parse(raw);
    return vsValid(rec) ? { day: Math.floor(rec.day), visit: Math.floor(rec.visit) } : null;
  } catch (e) { return null; }
}

/** Save { day, visit }. Returns true when the write went through (false = no storage, quota, private mode, ...). */
export function writeVisit(storage, saved, key, roster) {
  const k = key || VISIT_STORE_KEY;
  if (!vsValid(saved)) return false;
  try {
    if (!storage || typeof storage.setItem !== 'function') return false;
    // the kitten memory (W4) rides along ONLY while KITTEN_MEMORY_PERSIST is true (Legal gate), and then only as
    // { v, cats } re-whitelisted field by field (roster ids when a roster is given); anything else in the record is dropped
    let memory = null;
    if (KITTEN_MEMORY_PERSIST) { try { const old = JSON.parse(storage.getItem(k)); memory = old && typeof old === 'object' ? visitMemoryShape(old.memory, roster) : null; } catch (e) { memory = null; } }
    storage.setItem(k, JSON.stringify(Object.assign({ v: VISIT_STORE_VERSION, day: Math.floor(saved.day), visit: Math.floor(saved.visit) }, memory ? { memory } : {})));
    // read back: a storage that silently drops writes (some private modes) must not make the end card promise
    const back = readVisit(storage, k);
    return !!back && back.day === Math.floor(saved.day) && back.visit === Math.floor(saved.visit);
  } catch (e) { return false; }
}

/**
 * Start a visit: reads the save, works out today's visit number (end-card.js visitFor: same local day = same visit, any
 * later day = +1, never a backlog) and saves it. nowMs = the UTC clock, tzOffsetMin = Date#getTimezoneOffset().
 * roster (optional) = today's kitten ids: a carried kitten memory is re-whitelisted against it.
 * Returns { visit, day, isNew, persisted } where persisted = true only when the save is on disk (read back), which is
 * what lets the end card promise a new kitten tomorrow (buildEndCard { persisted }).
 */
export function beginVisit(storage, nowMs, tzOffsetMin, key, roster) {
  const day = localDay(Number.isFinite(nowMs) ? nowMs : 0, tzOffsetMin);
  const v = visitFor(readVisit(storage, key), day);
  const persisted = writeVisit(storage, { day: v.day, visit: v.visit }, key, roster);
  return { visit: v.visit, day: v.day, isNew: v.isNew, persisted };
}
