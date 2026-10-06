import type { Geometry, MatcherState, Settings, TileSet } from './types';

const roundEven = (x: number): number => { const n = Math.floor(x), f = x - n; return f < .5 ? n : f > .5 ? n + 1 : n % 2 ? n + 1 : n; };
const percentile = (sorted: number[], p: number): number => {
  const at = (sorted.length - 1) * p / 100, lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
};

/** Deterministic seeded browser matcher. Its sequence is stable within this implementation. */
export class Matcher {
  private readonly settings: Settings;
  private readonly geometry: Geometry;
  private readonly tileBytes: number;
  private readonly tiles: Uint8ClampedArray;
  private readonly rng: { value: number };
  private readonly bucketStarts: Int32Array;
  private readonly bucketCounts: Int32Array;
  private previousKeys: number[] | null = null;
  private previousPicks: number[] | null = null;

  constructor(source: TileSet, settings: Settings, geometry: Geometry) {
    if (!Number.isSafeInteger(source.count) || source.count < 1 || source.width < 1 || source.height < 1 || source.pixels.length !== source.count * source.width * source.height * 4) throw new RangeError('invalid tile set dimensions or pixels');
    if (source.width !== geometry.cellWidth || source.height !== geometry.cellHeight) throw new RangeError('tile dimensions must equal output cell dimensions');
    this.settings = settings; this.geometry = geometry;
    this.rng = { value: seed32(settings.seed) };
    this.tileBytes = source.width * source.height * 4;

    const luminance = new Float64Array(source.count);
    for (let i = 0; i < source.count; i++) {
      let sum = 0;
      const base = i * this.tileBytes;
      for (let p = base; p < base + this.tileBytes; p += 4) sum += source.pixels[p] * .299 + source.pixels[p + 1] * .587 + source.pixels[p + 2] * .114;
      luminance[i] = sum / (this.tileBytes / 4) / 255;
    }
    const sortedLuma = [...luminance].sort((a, b) => a - b);
    const low = percentile(sortedLuma, 50 - 50 * settings.contrast), high = percentile(sortedLuma, 50 + 50 * settings.contrast);
    const retained: number[] = [];
    for (let i = 0; i < source.count; i++) if (luminance[i] >= low && luminance[i] <= high) retained.push(i);
    if (!retained.length) throw new RangeError('contrast removed every gallery tile');

    const keyCount = settings.metric === 'brightness' ? 256 : settings.colour_bins ** 3;
    this.bucketStarts = new Int32Array(keyCount); this.bucketCounts = new Int32Array(keyCount);
    let sortedIds: number[];
    if (settings.metric === 'brightness') {
      const order = retained.slice().sort((a, b) => luminance[a] - luminance[b] || a - b);
      const values = order.map(i => luminance[i]);
      const k = Math.min(settings.candidates, order.length);
      for (let level = 0; level < 256; level++) {
        const target = level / 255; let insert = lowerBound(values, target);
        let start = Math.min(Math.max(insert - Math.floor(k / 2), 0), order.length - k);
        while (start > 0 && target - values[start - 1] < values[start + k - 1] - target) start--;
        while (start + k < order.length && values[start + k] - target < target - values[start]) start++;
        let lo = lowerBound(values, target - settings.epsilon), hi = upperBound(values, target + settings.epsilon);
        let begin = Math.max(start, lo), end = Math.min(start + k, hi);
        if (end <= begin) { const left = Math.max(insert - 1, 0), right = Math.min(insert, order.length - 1); begin = Math.abs(target - values[left]) <= Math.abs(values[right] - target) ? left : right; end = begin + 1; }
        this.bucketStarts[level] = begin; this.bucketCounts[level] = end - begin;
      }
      sortedIds = order;
    } else {
      const bins = settings.colour_bins, raw: { id: number; key: number }[] = [];
      for (const id of retained) {
        const base = id * this.tileBytes; let r = 0, g = 0, b = 0;
        for (let p = base; p < base + this.tileBytes; p += 4) { r += source.pixels[p]; g += source.pixels[p + 1]; b += source.pixels[p + 2]; }
        const den = this.tileBytes / 4;
        const qr = Math.min(bins - 1, Math.floor(r / den * bins / 256));
        const qg = Math.min(bins - 1, Math.floor(g / den * bins / 256));
        const qb = Math.min(bins - 1, Math.floor(b / den * bins / 256));
        raw.push({ id, key: (qr * bins + qg) * bins + qb });
      }
      raw.sort((a, b) => a.key - b.key || a.id - b.id);
      sortedIds = raw.map(x => x.id);
      const occupied: number[] = [];
      let pos = 0;
      while (pos < raw.length) {
        const key = raw[pos].key, first = pos; while (pos < raw.length && raw[pos].key === key) pos++;
        const count = Math.min(pos - first, settings.candidates);
        this.bucketStarts[key] = first; this.bucketCounts[key] = count; occupied.push(key);
      }
      const donors = nearestDonors(bins, occupied);
      for (let i = 0; i < keyCount; i++) if (!this.bucketCounts[i]) { const d = donors[i]; this.bucketStarts[i] = this.bucketStarts[d]; this.bucketCounts[i] = this.bucketCounts[d]; }
    }

    // Keep only tile positions reached by one of the lookup buckets.
    // Difference coverage avoids walking every tile candidate once per bucket.
    const coverage = new Int32Array(sortedIds.length + 1);
    for (let i = 0; i < keyCount; i++) {
      coverage[this.bucketStarts[i]]++;
      coverage[this.bucketStarts[i] + this.bucketCounts[i]]--;
    }
    const reachable = new Uint8Array(sortedIds.length), remap = new Int32Array(sortedIds.length);
    let count = 0, active = 0;
    for (let i = 0; i < reachable.length; i++) { active += coverage[i]; reachable[i] = active > 0 ? 1 : 0; remap[i] = reachable[i] ? count++ : -1; }
    const compact = new Uint8ClampedArray(count * this.tileBytes);
    let out = 0;
    for (let i = 0; i < sortedIds.length; i++) if (reachable[i]) { const id = sortedIds[i]; compact.set(source.pixels.subarray(id * this.tileBytes, (id + 1) * this.tileBytes), out * this.tileBytes); out++; }
    for (let i = 0; i < keyCount; i++) this.bucketStarts[i] = remap[this.bucketStarts[i]];
    this.tiles = compact;
  }

  render(rgba: Uint8ClampedArray): Uint8ClampedArray {
    const { width, height } = this.geometry;
    if (rgba.length !== width * height * 4) throw new RangeError(`expected ${width * height * 4} RGBA bytes`);
    const cellArea = this.geometry.cellWidth * this.geometry.cellHeight, keys: number[] = [];
    for (let cy = 0; cy < this.geometry.rows; cy++) for (let cx = 0; cx < this.geometry.cols; cx++) {
      let r = 0, g = 0, b = 0;
      for (let y = 0; y < this.geometry.cellHeight; y++) {
        let p = ((cy * this.geometry.cellHeight + y) * width + cx * this.geometry.cellWidth) * 4;
        for (let x = 0; x < this.geometry.cellWidth; x++, p += 4) { r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2]; }
      }
      if (this.settings.metric === 'brightness') {
        const gray = roundEven((r * .299 + g * .587 + b * .114) / cellArea);
        keys.push(gray);
      } else {
        const bins = this.settings.colour_bins;
        const qr = Math.min(bins - 1, Math.floor(r / cellArea * bins / 256));
        const qg = Math.min(bins - 1, Math.floor(g / cellArea * bins / 256));
        const qb = Math.min(bins - 1, Math.floor(b / cellArea * bins / 256));
        keys.push((qr * bins + qg) * bins + qb);
      }
    }
    const picks: number[] = new Array(keys.length);
    const held = this.settings.hold_tiles && this.previousKeys?.length === keys.length && this.previousPicks?.length === keys.length;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i], n = this.bucketCounts[key], start = this.bucketStarts[key];
      // Consume draws on held cells too, matching Python's steady wrapper semantics.
      const selected = start + Math.floor(random(this.rng) * n);
      picks[i] = held && this.previousKeys![i] === key ? this.previousPicks![i] : selected;
    }
    if (this.settings.hold_tiles) { this.previousKeys = keys; this.previousPicks = picks; }
    const output = new Uint8ClampedArray(width * height * 4); let cell = 0;
    for (let cy = 0; cy < this.geometry.rows; cy++) for (let cx = 0; cx < this.geometry.cols; cx++, cell++) {
      const sourceAt = picks[cell] * this.tileBytes;
      for (let y = 0; y < this.geometry.cellHeight; y++) {
        const src = sourceAt + y * this.geometry.cellWidth * 4;
        const dst = ((cy * this.geometry.cellHeight + y) * width + cx * this.geometry.cellWidth) * 4;
        output.set(this.tiles.subarray(src, src + this.geometry.cellWidth * 4), dst);
      }
    }
    return output;
  }

  snapshot(): MatcherState { return { version: 1, rng: this.rng.value >>> 0, keys: this.previousKeys ? [...this.previousKeys] : null, picks: this.previousPicks ? [...this.previousPicks] : null }; }
  restore(state: MatcherState): void {
    if (!state || state.version !== 1 || !Number.isInteger(state.rng) || state.rng < 0 || state.rng > 0xffffffff) throw new TypeError('invalid matcher state');
    if ((state.keys === null) !== (state.picks === null)) throw new TypeError('matcher keys and picks must both be null or arrays');
    if (state.keys !== null) {
      const n = this.geometry.cols * this.geometry.rows;
      if (!this.settings.hold_tiles || !Array.isArray(state.keys) || !Array.isArray(state.picks) || state.keys.length !== n || state.picks.length !== n) throw new TypeError('matcher state dimensions do not match');
      const maxKey = this.bucketCounts.length;
      for (let i = 0; i < n; i++) if (!Number.isInteger(state.keys[i]) || state.keys[i] < 0 || state.keys[i] >= maxKey || !Number.isInteger(state.picks[i]) || state.picks[i] < 0 || state.picks[i] * this.tileBytes >= this.tiles.length) throw new TypeError('matcher state contains an invalid key or tile index');
    }
    this.rng.value = state.rng >>> 0;
    this.previousKeys = state.keys === null ? null : [...state.keys]; this.previousPicks = state.picks === null ? null : [...state.picks];
  }
}

function lowerBound(a: number[], x: number): number { let l = 0, h = a.length; while (l < h) { const m = (l + h) >>> 1; if (a[m] < x) l = m + 1; else h = m; } return l; }
function upperBound(a: number[], x: number): number { let l = 0, h = a.length; while (l < h) { const m = (l + h) >>> 1; if (a[m] <= x) l = m + 1; else h = m; } return l; }
function seed32(seed: number): number { let x = (seed ^ Math.floor(seed / 0x100000000)) >>> 0; x = Math.imul(x ^ x >>> 16, 0x21f0aaad); x = Math.imul(x ^ x >>> 15, 0x735a2d97); return (x ^ x >>> 15) >>> 0; }
function random(rng: { value: number }): number { let x = rng.value = (rng.value + 0x6d2b79f5) >>> 0; x = Math.imul(x ^ x >>> 15, x | 1); x ^= x + Math.imul(x ^ x >>> 7, x | 61); return ((x ^ x >>> 14) >>> 0) / 0x100000000; }
function nearestDonors(bins: number, occupied: number[]): Int32Array {
  const size = bins ** 3, donor = new Int32Array(size).fill(-1), queue = new Int32Array(size);
  let tail = 0;
  for (const k of occupied) { donor[k] = k; queue[tail++] = k; }
  let head = 0;
  while (head < tail) {
    const key = queue[head++], b = key % bins, g = Math.floor(key / bins) % bins, r = Math.floor(key / (bins * bins));
    const neighbors = [r + 1 < bins ? key + bins * bins : -1, r > 0 ? key - bins * bins : -1, g + 1 < bins ? key + bins : -1, g > 0 ? key - bins : -1, b + 1 < bins ? key + 1 : -1, b > 0 ? key - 1 : -1];
    for (const n of neighbors) if (n >= 0 && donor[n] < 0) { donor[n] = donor[key]; queue[tail++] = n; }
  }
  return donor;
}
