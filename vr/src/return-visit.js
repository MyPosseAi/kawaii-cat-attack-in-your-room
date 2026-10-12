/* vr/src/return-visit.js - W4: the return-visit loop beyond "a new kitten tomorrow" (plan 1.3 Reason to Come Back:
   kittens remember their favourite spots in your room, matched by semantic label; bond hearts unlock a trick per kitten;
   a collection page shows the cats met so far). Gaming Engineer 2, 2026-10-09.
   PURE and engine-neutral: no DOM / Date / globals. The kitten MEMORY is plain data { v, cats: { [id]: { bond, met, spot:
   { kind, label } | null } } }. readMemory / writeMemory never throw and whitelist everything they load (ids from the
   roster the host passes, labels from the room vocabulary, numbers clamped), so a tampered record can't inject text.
   LEGAL GATE (Code Review J W4 MUST 1; legal/SK-77-VR-COMPETITION.md 10.1 forbids new stored data without a re-check):
   visit-store.js KITTEN_MEMORY_PERSIST is TRUE since 2026-10-09 (legal 10.2, FOR-DEV; the start card's third
   sentence changed in the same build): the memory lives INSIDE the visit record (visit-store.js key, fields day / visit
   kept) through the same localStorage-like adapter: per kitten a bond number, the visit NUMBER it was first met and the
   KIND + LABEL of its nap spot ('seat' / 'couch'): one word each from visit-store.js MEMORY_KINDS / MEMORY_LABELS, never
   coordinates, anchors, planes, meshes, sizes or a time. sanitizeMemory = visit-store.js sanitizeMemoryFields + the
   roster, on read AND write. Every storage function takes an optional trailing `gate` (default KITTEN_MEMORY_PERSIST):
   with the gate closed writeMemory keeps the memory in a module-level session map (gone on reload, storage never
   touched), readMemory reads that map, and writeMemoryRecord / readMemoryRecord refuse (Code Review L W4 SHOULD 1).
   Build rule: only `export function` / `export const`; private names carry the `rv` prefix. */
import { heartsFor } from './end-card.js';
import { VISIT_STORE_KEY, KITTEN_MEMORY_PERSIST, MEMORY_KINDS, MEMORY_LABELS, MEMORY_LIMITS, sanitizeMemoryFields, memoryLabel, readVisit, carriedFurniture } from './visit-store.js';
export { KITTEN_MEMORY_PERSIST, MEMORY_KINDS, MEMORY_LABELS };

export const RETURN_VISIT_VERSION = 1;
export const MEMORY_TUNING = Object.freeze({ maxBond: MEMORY_LIMITS.maxBond, maxCats: MEMORY_LIMITS.maxCats, maxMet: MEMORY_LIMITS.maxMet });
/** Trick unlocks by hearts (end-card.js heartsFor: one heart per 2 bond, max 5). Cumulative: 5 hearts = all three. */
export const TRICKS = Object.freeze([
  Object.freeze({ id: 'sit', hearts: 1, line: 'sits when you point at the floor' }),
  Object.freeze({ id: 'high_five', hearts: 3, line: 'high-fives your open palm' }),
  Object.freeze({ id: 'roll_over', hearts: 5, line: 'rolls over when you wave' }),
]);
const RV_KINDS = MEMORY_KINDS, RV_LABELS = MEMORY_LABELS;

function rvId(e) { return typeof e === 'string' ? e : e && e.id != null ? String(e.id) : ''; }
function rvClamp(n, lo, hi) { n = Math.floor(Number(n)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }

/** Empty memory. */
export function createMemory() { return { v: RETURN_VISIT_VERSION, cats: {} }; }

/** A valid, whitelisted copy of a memory-like object (roster = allowed ids; anything else is dropped): visit-store.js
 *  sanitizeMemoryFields with the roster REQUIRED (no roster = no ids pass). Never throws. */
export function sanitizeMemory(raw, roster, tuning) {
  const T = tuning || MEMORY_TUNING;
  return sanitizeMemoryFields(raw, Array.isArray(roster) ? roster : [], { maxBond: T.maxBond, maxCats: T.maxCats, maxMet: Number.isFinite(T.maxMet) ? T.maxMet : MEMORY_LIMITS.maxMet });
}

/**
 * Fold a finished session into the memory (NEW object): bond adds up across visits (capped), `met` keeps the first visit,
 * the nap spot of a cat that fell asleep this session becomes its favourite (kind + label of the surface it sleeps on).
 * state = roomcat state, room = createRoom() (room.byId), visit = this visit's number, roster = the allowed ids.
 * BOND INPUT (Code Review J W4 SHOULD 1): what is added is the bond GAINED this session = `c.bond - c.bondAtStart`
 * (bondAtStart missing = 0, i.e. roomcat started the cat at 0, the default today). A host that restores yesterday's bond
 * into roomcat so the hearts carry over MUST set `bondAtStart` on the cat (or pass the restored value as `c.bondAtStart`)
 * or the bond would be counted twice; negative gains never subtract.
 */
export function rememberSession(memory, state, room, visit, roster, tuning) {
  const T = tuning || MEMORY_TUNING;
  const m = sanitizeMemory(memory, roster, T);
  const v = rvClamp(visit, 1, 100000);
  const ok = new Set((Array.isArray(roster) ? roster : []).map(rvId).filter(Boolean));
  for (const c of (state && state.cats) || []) {
    const id = rvId(c); if (!id || !ok.has(id)) continue; // roster ids only (never a stray id into the record)
    const prev = m.cats[id] || { bond: 0, met: v, spot: null };
    const s = room && room.byId && c.surf ? room.byId[c.surf] : null;
    const spot = c.mode === 'nap' && s && RV_KINDS.indexOf(s.kind) >= 0 ? { kind: s.kind, label: memoryLabel(s.label, s.kind) } : prev.spot;
    const gained = Math.max(0, (Number(c.bond) || 0) - (Number.isFinite(c.bondAtStart) ? c.bondAtStart : 0));
    m.cats[id] = { bond: rvClamp(prev.bond + gained, 0, T.maxBond), met: Math.min(prev.met, v), spot };
  }
  return m;
}

/**
 * Where each remembered kitten heads first in THIS room (favourite spots matched by semantic label, plan 1.3): the legal
 * surface with the same label, else the same kind, else null (a new room: the kitten explores). Returns { [id]: surfaceId
 * | null } for the ids asked (today's roster), only for kittens with a remembered spot.
 */
export function spotsForRoom(memory, room, ids) {
  const out = {};
  const surfaces = (room && room.surfaces) || [];
  const cats = memory && memory.cats ? memory.cats : {};
  for (const id of Array.isArray(ids) ? ids.map(rvId) : Object.keys(cats)) {
    const c = cats[id]; if (!c || !c.spot) continue;
    let pick = surfaces.find((s) => s.legal && s.label === c.spot.label && s.kind === c.spot.kind) || surfaces.find((s) => s.legal && s.kind === c.spot.kind) || null;
    out[id] = pick ? pick.id : null;
  }
  return out;
}

/** The tricks a bond has unlocked (cumulative, in TRICKS order). */
export function tricksFor(bond) { const h = heartsFor(bond); return TRICKS.filter((t) => h >= t.hearts).map((t) => t.id); }

/** The newest trick unlocked by THIS session (for the end card): tricksFor(after) minus tricksFor(before), last one. */
export function newTrick(bondBefore, bondAfter) { const b = new Set(tricksFor(bondBefore)); const n = tricksFor(bondAfter).filter((t) => !b.has(t)); return n.length ? n[n.length - 1] : null; }

/**
 * The collection page data: every roster cat, met ones first in the order they were met, with hearts and tricks; unmet
 * ones as silhouettes (no name: a surprise for a later day). names = { [id]: name } (legal 12.4 roster names).
 */
export function collection(memory, roster, names) {
  const list = (Array.isArray(roster) ? roster : []).map(rvId).filter(Boolean);
  const cats = memory && memory.cats ? memory.cats : {};
  const nm = names || {};
  const met = [], unmet = [];
  for (const id of list) {
    const c = cats[id];
    if (c) met.push({ id, name: nm[id] || id, met: c.met, bond: c.bond, hearts: heartsFor(c.bond), tricks: tricksFor(c.bond), spot: c.spot ? c.spot.label : null, silhouette: false });
    else unmet.push({ id, name: null, met: null, bond: 0, hearts: 0, tricks: [], spot: null, silhouette: true });
  }
  met.sort((a, b) => a.met - b.met || list.indexOf(a.id) - list.indexOf(b.id));
  return { cats: met.concat(unmet), metCount: met.length, total: list.length, title: `${met.length} of ${list.length} kittens met` };
}

/** Session-only memory for a closed gate: key -> memory. Lost on reload by design. */
const rvSession = new Map();

/** Forget the session-scoped memory (tests; a host at session end). No storage access. */
export function clearMemorySession(key) { if (key) rvSession.delete(key); else rvSession.clear(); }

/** The memory from the visit record in storage (the PERSISTENT path). roster = allowed ids. gate (optional, default
 *  KITTEN_MEMORY_PERSIST): closed -> empty memory, storage NOT read. Never throws. */
export function readMemoryRecord(storage, roster, key, gate) {
  const k = key || VISIT_STORE_KEY;
  if (!(gate === undefined ? KITTEN_MEMORY_PERSIST : !!gate)) return createMemory();
  try {
    if (!storage || typeof storage.getItem !== 'function') return createMemory();
    const raw = storage.getItem(k);
    if (typeof raw !== 'string' || !raw) return createMemory();
    const rec = JSON.parse(raw);
    return sanitizeMemory(rec && rec.memory, roster);
  } catch (e) { return createMemory(); }
}

/** Save the memory INTO the visit record, keeping its day / visit (the PERSISTENT path; whitelisted on write). gate
 *  (optional, default KITTEN_MEMORY_PERSIST): closed -> returns false and storage is NOT touched (Code Review L W4 SHOULD 1).
 *  Returns true when the write went through and read back. */
export function writeMemoryRecord(storage, memory, roster, key, gate) {
  const k = key || VISIT_STORE_KEY;
  const open = gate === undefined ? KITTEN_MEMORY_PERSIST : !!gate;
  if (!open) return false;
  try {
    if (!storage || typeof storage.setItem !== 'function') return false;
    const visit = readVisit(storage, k);
    const clean = sanitizeMemory(memory, roster);
    const furniture = carriedFurniture(storage, k); //: the furniture field rides along (whitelisted) only while FURNITURE_PERSIST
    const rec = Object.assign({ v: 1 }, visit ? { day: visit.day, visit: visit.visit } : {}, { memory: clean }, furniture ? { furniture } : {});
    storage.setItem(k, JSON.stringify(rec));
    const back = readMemoryRecord(storage, roster, k, open);
    return JSON.stringify(back) === JSON.stringify(clean) && (!visit || JSON.stringify(readVisit(storage, k)) === JSON.stringify(visit));
  } catch (e) { return false; }
}

/** Load the memory: the visit record while the gate is open, else the session map (storage is NOT read).
 *  roster = allowed ids. Never throws. */
export function readMemory(storage, roster, key, gate) {
  const k = key || VISIT_STORE_KEY;
  const open = gate === undefined ? KITTEN_MEMORY_PERSIST : !!gate;
  if (!open) return sanitizeMemory(rvSession.get(k), roster);
  return readMemoryRecord(storage, roster, k, open);
}

/** Save the memory: into the visit record while the gate is open (writeMemoryRecord), else into the session map
 *  (storage is NOT touched; returns true = kept for this session). Never throws. */
export function writeMemory(storage, memory, roster, key, gate) {
  const k = key || VISIT_STORE_KEY;
  const open = gate === undefined ? KITTEN_MEMORY_PERSIST : !!gate;
  if (!open) { rvSession.set(k, sanitizeMemory(memory, roster)); return true; }
  return writeMemoryRecord(storage, memory, roster, k, open);
}
