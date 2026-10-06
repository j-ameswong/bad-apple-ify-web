import type { Geometry, MediaInfo, Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  grid_size: 8, grid: null, cell_size: null, tile_fit: 'native', contrast: 0.8,
  metric: 'colour', candidates: 256, epsilon: 0.005, colour_bins: 32,
  stochastic: true, seed: 0, hold_tiles: true, stride: 10, start: 0,
  duration: null, segment: 5000, use_cache: true, gallery_budget: 256 * 1024 * 1024,
};

export const MAX_GEOMETRY_DIMENSION = 16_384;
export const MAX_GEOMETRY_PIXELS = 64 * 1024 * 1024;
export const MAX_GEOMETRY_CELLS = 1_048_576;

const keys = new Set(Object.keys(DEFAULT_SETTINGS));
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const positiveInt = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const nonnegativeInt = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const roundEven = (x: number): number => {
  const floor = Math.floor(x), fraction = x - floor;
  return fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : (floor % 2 === 0 ? floor : floor + 1);
};

export function validateSettings(input: unknown): Settings {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('settings must be an object');
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new TypeError(`unknown setting: ${key}`);
  const s = { ...DEFAULT_SETTINGS, ...value } as Settings;
  if (!positiveInt(s.grid_size)) throw new RangeError('grid_size must be a positive integer');
  if (s.grid !== null && (!Array.isArray(s.grid) || s.grid.length !== 2 || !s.grid.every(positiveInt))) throw new RangeError('grid must contain positive integer columns and rows');
  if (s.cell_size !== null && !positiveInt(s.cell_size)) throw new RangeError('cell_size must be a positive integer');
  if (!['native', 'crop', 'stretch'].includes(s.tile_fit)) throw new RangeError('tile_fit must be native, crop or stretch');
  if (!finite(s.contrast) || s.contrast <= 0 || s.contrast > 1) throw new RangeError('contrast must be greater than 0 and at most 1');
  if (!['brightness', 'colour'].includes(s.metric)) throw new RangeError('metric must be brightness or colour');
  if (!positiveInt(s.candidates)) throw new RangeError('candidates must be a positive integer');
  if (!finite(s.epsilon) || s.epsilon < 0) throw new RangeError('epsilon must be finite and non-negative');
  if (!positiveInt(s.colour_bins) || s.colour_bins < 2 || s.colour_bins > 64) throw new RangeError('colour_bins must be an integer from 2 to 64');
  if (!nonnegativeInt(s.seed)) throw new RangeError('seed must be a non-negative safe integer');
  if (typeof s.stochastic !== 'boolean' || typeof s.hold_tiles !== 'boolean' || typeof s.use_cache !== 'boolean') throw new TypeError('stochastic, hold_tiles and use_cache must be booleans');
  if (!positiveInt(s.stride) || !nonnegativeInt(s.segment) || !positiveInt(s.gallery_budget)) throw new RangeError('stride and gallery_budget must be positive integers; segment must be a non-negative integer');
  if (!finite(s.start) || s.start < 0) throw new RangeError('start must be finite and non-negative');
  if (s.duration !== null && (!finite(s.duration) || s.duration <= 0)) throw new RangeError('duration must be finite and positive');
  return { ...s, grid: s.grid === null ? null : [s.grid[0], s.grid[1]], candidates: s.stochastic ? s.candidates : 1 };
}

function evenSpan(count: number, cell: number, ideal: number): [number, number] {
  if (count * cell % 2 === 0) return [count, cell];
  const opts: [number, number][] = count === 1 ? [cell - 1, cell + 1].filter(x => x > 0).map(x => [count, x])
    : [[count - 1, cell], [count + 1, cell]];
  opts.sort((a, b) => Math.abs(a[0] * a[1] - ideal) - Math.abs(b[0] * b[1] - ideal) || a[0] * a[1] - b[0] * b[1]);
  return opts[0];
}

/** Shared limits for render allocations and untrusted checkpoint geometry. */
export function validateGeometryBounds(value: unknown): asserts value is Geometry {
  const g = value as Geometry;
  if (!g || typeof g !== 'object' || !positiveInt(g.cols) || !positiveInt(g.rows)
    || !positiveInt(g.cellWidth) || !positiveInt(g.cellHeight) || !positiveInt(g.width) || !positiveInt(g.height)
    || !finite(g.fps) || g.fps <= 0 || !nonnegativeInt(g.startFrame)
    || !(g.stopFrame === null || (positiveInt(g.stopFrame) && g.stopFrame > g.startFrame))
    || !(g.totalFrames === null || nonnegativeInt(g.totalFrames))) throw new RangeError('invalid geometry values');
  const cells = g.cols * g.rows;
  if (!Number.isSafeInteger(cells) || cells > MAX_GEOMETRY_CELLS
    || g.width !== g.cols * g.cellWidth || g.height !== g.rows * g.cellHeight
    || g.width > MAX_GEOMETRY_DIMENSION || g.height > MAX_GEOMETRY_DIMENSION
    || g.cellWidth > MAX_GEOMETRY_DIMENSION || g.cellHeight > MAX_GEOMETRY_DIMENSION
    || g.width * g.height > MAX_GEOMETRY_PIXELS || g.width % 2 || g.height % 2
    || (g.stopFrame !== null && g.totalFrames !== null && g.totalFrames > g.stopFrame - g.startFrame)) {
    throw new RangeError('geometry exceeds safe rendering bounds');
  }
}

export function deriveGeometry(settings: Settings, info: MediaInfo, tileAspect: [number, number] | null): Geometry {
  if (!positiveInt(info.width) || !positiveInt(info.height) || !finite(info.fps) || info.fps <= 0) throw new RangeError('source dimensions and frame rate must be positive');
  if (tileAspect && (!positiveInt(tileAspect[0]) || !positiveInt(tileAspect[1]))) throw new RangeError('tile aspect must be a positive integer pair');
  const startFrame = Math.ceil(settings.start * info.fps - Number.EPSILON * Math.abs(settings.start * info.fps));
  const stopFrame = settings.duration === null ? null : Math.ceil((settings.start + settings.duration) * info.fps - Number.EPSILON * Math.abs((settings.start + settings.duration) * info.fps));
  if (stopFrame !== null && stopFrame <= startFrame) throw new RangeError('the requested source range contains no frames');
  const aspect = info.width / info.height;
  // Fraction(...).limit_denominator(16), matching the Python grid aspect policy.
  let ratio: [number, number] = [1, 1], err = Infinity;
  for (let d = 1; d <= 16; d++) { const n = Math.max(1, roundEven(aspect * d)), e = Math.abs(n / d - aspect); if (e < err) { ratio = [n, d]; err = e; } }
  const nativeSingle = settings.grid_size === 1 && settings.grid === null && settings.tile_fit === 'native';
  let cols: number, rows: number, cellWidth: number, cellHeight: number;
  if (settings.cell_size !== null || settings.grid !== null) {
    [cols, rows] = settings.grid ?? (settings.grid_size === 1 ? [1, 1] : [ratio[0] * settings.grid_size, ratio[1] * settings.grid_size]);
    if (settings.cell_size !== null) {
      cellHeight = settings.cell_size;
      cellWidth = nativeSingle ? Math.max(roundEven(cellHeight * info.width / info.height), 1)
        : tileAspect && settings.tile_fit === 'native' ? Math.max(roundEven(cellHeight * tileAspect[0] / tileAspect[1]), 1) : cellHeight;
    } else {
      cellWidth = Math.max(roundEven(info.width / cols), 1);
      cellHeight = Math.max(roundEven(info.height / rows), 1);
      if (tileAspect && settings.tile_fit === 'native' && (cols !== 1 || rows !== 1)) cellWidth = Math.max(roundEven(cellHeight * tileAspect[0] / tileAspect[1]), 1);
    }
    if (cols * cellWidth % 2 || rows * cellHeight % 2) throw new RangeError('explicit grid and cell size must produce even output dimensions');
  } else {
    [cols, rows] = settings.grid_size === 1 ? [1, 1] : [ratio[0] * settings.grid_size, ratio[1] * settings.grid_size];
    cellWidth = Math.max(roundEven(info.width / cols), 1); cellHeight = Math.max(roundEven(info.height / rows), 1);
    if (tileAspect && settings.grid_size > 1) {
      const snappedWidth = cols * cellWidth;
      cellWidth = Math.max(roundEven(cellHeight * tileAspect[0] / tileAspect[1]), 1);
      cols = Math.max(roundEven(snappedWidth / cellWidth), 1);
    }
    [rows, cellHeight] = evenSpan(rows, cellHeight, info.height);
    const idealWidth = rows * cellHeight * info.width / info.height;
    if (rows !== (settings.grid_size === 1 ? 1 : ratio[1] * settings.grid_size)) cols = Math.max(roundEven(idealWidth / cellWidth), 1);
    [cols, cellWidth] = evenSpan(cols, cellWidth, idealWidth);
  }
  const width = cols * cellWidth, height = rows * cellHeight;
  const remaining = info.frameCount !== null && info.frameCount > 0 ? Math.max(info.frameCount - startFrame, 0) : null;
  const requested = stopFrame === null ? null : stopFrame - startFrame;
  const totalFrames = requested === null ? remaining : remaining === null ? requested : Math.min(requested, remaining);
  const geometry: Geometry = { cols, rows, cellWidth, cellHeight, width, height, fps: info.fps, startFrame, stopFrame, totalFrames };
  validateGeometryBounds(geometry);
  return geometry;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError('bytes must be finite and non-negative');
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB']; let value = bytes / 1024, i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}
