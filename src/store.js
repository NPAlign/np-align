// Local storage for jobs (IndexedDB, files included), preferences and
// profile (localStorage). Nothing leaves this computer.

const DB_NAME = 'np-align';
const STORE = 'jobs';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const out = fn(s);
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}

export const jobs = {
  async all() {
    const list = await tx('readonly', (s) => s.getAll());
    return list.sort((a, b) => b.updated - a.updated);
  },
  get: (id) => tx('readonly', (s) => s.get(id)),
  async put(job) {
    job.updated = Date.now();
    await tx('readwrite', (s) => s.put(job));
    return job;
  },
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
  /** Save exactly as given (restoring a backup keeps each job's own date). */
  putRaw: (job) => tx('readwrite', (s) => s.put(job)),
  newId: () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)),
};

// ---------------------------------------------------------------- prefs
export const DEFAULT_PREFS = {
  outline: true,
  orient: 'match', // 'match' | 'drawn'
  logo: null, // data URL
  logoWidth: 16, // stitches
  stitchWidth: 0.6, // 0 threads only … 1 whole square
  placements: { key: null, logo: null }, // { corner: 'tl'|'tr'|'bl'|'br', dir?: 'down'|'across' }
};

function read(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const prefs = {
  get() {
    const p = read('ia.prefs', {});
    return { ...DEFAULT_PREFS, ...p, placements: { ...DEFAULT_PREFS.placements, ...(p.placements || {}) } };
  },
  set(p) { return write('ia.prefs', p); },
};

export const profile = {
  get() { return { name: '', shop: '', ...read('ia.profile', {}) }; },
  set(p) { return write('ia.profile', p); },
};

export function relativeDay(ts) {
  const d = new Date(ts), now = new Date();
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const STATUS = {
  draft: { label: 'Draft', cls: '' },
  ready: { label: 'Ready to print', cls: 'info' },
  'lined-up': { label: 'Printed, lined up', cls: 'ok' },
  'off': { label: 'Printed, off', cls: 'bad' },
};
