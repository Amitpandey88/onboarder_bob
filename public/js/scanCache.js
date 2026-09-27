// Scan caching & trend analysis. Pure logic so it is unit-tested without a browser.

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

export function repoCacheKey(scan) {
  if (!scan) return '';
  const id = scan.gitUrl || scan.root || scan.name || '';
  const summary = (scan.files || [])
    .slice(0, 100)
    .map((f) => `${f.path}:${f.size}:${f.loc}`)
    .join('|');
  return `onboarder.cache.${hashString(id)}.${hashString(summary)}`;
}

export function compareScans(prev, curr) {
  if (!prev || !curr) return null;
  const prevScore = prev.health?.score ?? prev.score ?? 100;
  const currScore = curr.health?.score ?? curr.score ?? 100;
  const scoreDiff = currScore - prevScore;
  const prevFiles = prev.scan?.files?.length ?? prev.files?.length ?? 0;
  const currFiles = curr.scan?.files?.length ?? curr.files?.length ?? 0;
  const filesDiff = currFiles - prevFiles;

  return {
    scoreDiff,
    filesDiff,
    trend: scoreDiff > 0 ? 'improving' : scoreDiff < 0 ? 'degrading' : 'stable',
    summary: scoreDiff > 0
      ? `Health improved by +${scoreDiff} pts since last scan.`
      : scoreDiff < 0
        ? `Health decreased by ${scoreDiff} pts since last scan.`
        : 'Health score matches previous scan.',
  };
}

export class ScanCache {
  constructor(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
    this.storage = storage;
    this.memory = new Map();
  }

  get(key) {
    if (this.memory.has(key)) return this.memory.get(key);
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      this.memory.set(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  set(key, val) {
    this.memory.set(key, val);
    if (!this.storage) return;
    try {
      this.storage.setItem(key, JSON.stringify(val));
    } catch {
      // Quota exceeded or disabled
    }
  }

  clear() {
    this.memory.clear();
  }
}
