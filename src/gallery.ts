import { CanvasSink } from 'mediabunny';
import { parseCifarBatch } from './cifar';
import { identifyFile } from './checkpoint';
import { openVideo, throwIfAborted } from './media';
import type { Geometry, Settings, TileSet } from './types';

export interface GalleryEstimate {
  count: number;
  bytes: number;
  nativeAspect: [number, number] | null;
}

type FileKind = 'cifar' | 'image' | 'video';
interface FileDescription {
  file: File;
  kind: FileKind;
  count: number;
  width: number;
  height: number;
  digest: string;
}
interface CacheEntry { tiles: TileSet; bytes: number; lastUsed: number }

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.ogv']);
const CACHE_LIMIT = 64 * 1024 * 1024;
const MAX_CIFAR_FILE_BYTES = 512 * 1024 * 1024;
const galleryCache = new Map<string, CacheEntry>();
let descriptions = new WeakMap<File, Promise<FileDescription>>();
let cacheBytes = 0;
let cacheClock = 0;

function extension(file: File): string {
  const dot = file.name.lastIndexOf('.');
  return dot < 0 ? '' : file.name.slice(dot).toLowerCase();
}

function isCifarCandidate(file: File): boolean {
  const ext = extension(file);
  return ['.pkl', '.pickle', '.bin'].includes(ext)
    || /^(?:data_batch_\d+|train|test)$/.test(file.name.toLowerCase())
    || (!IMAGE_EXTENSIONS.has(ext) && !VIDEO_EXTENSIONS.has(ext) && file.size > 1024 * 1024);
}

async function describeFile(file: File, signal?: AbortSignal): Promise<FileDescription> {
  throwIfAborted(signal);
  const cached = descriptions.get(file);
  if (cached) return cached;
  const pending = describeUncached(file, signal);
  descriptions.set(file, pending);
  try { return await pending; }
  catch (error) { descriptions.delete(file); throw error; }
}

async function describeUncached(file: File, signal?: AbortSignal): Promise<FileDescription> {
  const cifar = isCifarCandidate(file);
  if (cifar) assertCifarSize(file);
  const digest = (await identifyFile(file, signal)).digest;
  if (cifar) {
    const parsed = parseCifarBatch(new Uint8Array(await file.arrayBuffer()));
    return { file, kind: 'cifar', count: parsed.count, width: 32, height: 32, digest };
  }
  if (file.type.startsWith('video/') || VIDEO_EXTENSIONS.has(extension(file))) {
    const opened = await openVideo(file, signal, false);
    try {
      if (!opened.info.frameCount) throw new Error(`${file.name} contains no video frames.`);
      return {
        file, kind: 'video', count: opened.info.frameCount, width: opened.info.width,
        height: opened.info.height, digest,
      };
    } finally {
      opened.input.dispose();
    }
  }
  try {
    const bitmap = await createImageBitmap(file);
    const result = { file, kind: 'image' as const, count: 1, width: bitmap.width, height: bitmap.height, digest };
    bitmap.close();
    return result;
  } catch (error) {
    throw new Error(`${file.name} isn't a readable image, video or CIFAR batch.`, { cause: error });
  }
}

export async function estimateGallery(
  files: File[],
  settings: Settings,
  geometry: Geometry,
  signal?: AbortSignal,
  enforceBudget = true,
): Promise<GalleryEstimate> {
  const inspection = await inspectGallery(files, settings, signal);
  const bytes = inspection.count * geometry.cellWidth * geometry.cellHeight * 4;
  if (enforceBudget && (!Number.isSafeInteger(bytes) || bytes > settings.gallery_budget)) {
    throw new RangeError(`Gallery needs about ${formatSize(bytes)} of tiles, above the ${formatSize(settings.gallery_budget)} budget.`);
  }
  return { ...inspection, bytes };
}

export interface GalleryInspection { count: number; nativeAspect: [number, number] | null }

export async function inspectGallery(files: File[], settings: Settings, signal?: AbortSignal): Promise<GalleryInspection> {
  if (!files.length) throw new Error('Choose at least one readable gallery file.');
  let count = 0;
  let nativeAspect: [number, number] | null = null;
  for (const file of files) {
    const item = await describeFile(file, signal);
    count += item.kind === 'video' ? Math.ceil(item.count / settings.stride) : item.count;
    if (settings.tile_fit === 'native' && nativeAspect === null) nativeAspect = reduceRatio(item.width, item.height);
  }
  return { count, nativeAspect };
}

export async function loadGalleryTiles(
  files: File[],
  settings: Settings,
  geometry: Geometry,
  signal?: AbortSignal,
  onProgress?: (completed: number, total: number | null) => void,
): Promise<TileSet> {
  if (!files.length) throw new Error('Choose at least one readable gallery file.');
  const descriptions: FileDescription[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    descriptions.push(await describeFile(file, signal));
  }
  const identity = descriptions.map((item) => `${item.digest}:${item.file.size}`).join('|');
  const key = `${identity}:${geometry.cellWidth}x${geometry.cellHeight}:${settings.tile_fit}:${settings.stride}`;
  if (settings.use_cache) {
    const hit = galleryCache.get(key);
    if (hit) {
      if (hit.tiles.pixels.byteLength > settings.gallery_budget) throw new RangeError(`Cached gallery exceeds the ${formatSize(settings.gallery_budget)} tile budget.`);
      hit.lastUsed = ++cacheClock;
      return hit.tiles;
    }
  }

  const estimatedCount = descriptions.reduce((total, item) => total
    + (item.kind === 'video' ? Math.ceil(item.count / settings.stride) : item.count), 0);
  const tileBytes = geometry.cellWidth * geometry.cellHeight * 4;
  const estimatedBytes = estimatedCount * tileBytes;
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > settings.gallery_budget) {
    throw new RangeError(`Gallery needs about ${formatSize(estimatedBytes)} of tiles, above the ${formatSize(settings.gallery_budget)} budget.`);
  }
  const builder = new TileBuilder(estimatedCount, geometry.cellWidth, geometry.cellHeight, settings.gallery_budget);
  let loaded = 0;
  for (const item of descriptions) {
    throwIfAborted(signal);
    if (item.kind === 'cifar') {
      assertCifarSize(item.file);
      const parsed = parseCifarBatch(new Uint8Array(await item.file.arrayBuffer()));
      const source = new OffscreenCanvas(32, 32);
      const context = source.getContext('2d');
      if (!context) throw new Error('Could not create a canvas to resize CIFAR images.');
      const rgba = new Uint8ClampedArray(32 * 32 * 4);
      const plane = 32 * 32;
      for (let index = 0; index < parsed.count; index++) {
        throwIfAborted(signal);
        // CIFAR is planar by channel; rebuild one tile at a time to cap transient RAM.
        const base = index * plane * 3;
        for (let p = 0; p < plane; p++) {
          rgba[p * 4] = parsed.planarRgb[base + p];
          rgba[p * 4 + 1] = parsed.planarRgb[base + plane + p];
          rgba[p * 4 + 2] = parsed.planarRgb[base + plane * 2 + p];
          rgba[p * 4 + 3] = 255;
        }
        context.putImageData(new ImageData(rgba, 32, 32), 0, 0);
        builder.addSource(source, settings.tile_fit, false);
        loaded++;
        if (loaded % 256 === 0) {
          onProgress?.(loaded, estimatedCount);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      continue;
    }
    if (item.kind === 'image') {
      const bitmap = await createImageBitmap(item.file);
      try {
        builder.addSource(bitmap, settings.tile_fit, false);
        loaded++;
      } finally { bitmap.close(); }
      onProgress?.(loaded, estimatedCount);
      continue;
    }

    const opened = await openVideo(item.file, signal, false);
    try {
      const sink = new CanvasSink(opened.track);
      let frameIndex = 0;
      for await (const frame of sink.canvases()) {
        throwIfAborted(signal);
        if (frameIndex % settings.stride === 0) {
          builder.addSource(frame.canvas, settings.tile_fit, true);
          loaded++;
          onProgress?.(loaded, estimatedCount);
        }
        frameIndex++;
      }
    } finally { opened.input.dispose(); }
  }
  const tiles = builder.finish();
  const actualBytes = tiles.pixels.byteLength;
  if (actualBytes > settings.gallery_budget) {
    throw new RangeError(`Decoded gallery needs ${formatSize(actualBytes)} of tiles, above the ${formatSize(settings.gallery_budget)} budget.`);
  }
  if (settings.use_cache && actualBytes <= CACHE_LIMIT) cacheTiles(key, tiles, actualBytes);
  return tiles;
}

export function clearGalleryCache(): void {
  galleryCache.clear();
  descriptions = new WeakMap<File, Promise<FileDescription>>();
  cacheBytes = 0;
}

function cacheTiles(key: string, tiles: TileSet, bytes: number): void {
  while (cacheBytes + bytes > CACHE_LIMIT && galleryCache.size) {
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const [candidate, entry] of galleryCache) {
      if (entry.lastUsed < oldest) { oldest = entry.lastUsed; oldestKey = candidate; }
    }
    if (oldestKey === undefined) break;
    const removed = galleryCache.get(oldestKey)!;
    galleryCache.delete(oldestKey);
    cacheBytes -= removed.bytes;
  }
  galleryCache.set(key, { tiles, bytes, lastUsed: ++cacheClock });
  cacheBytes += bytes;
}

class TileBuilder {
  private pixels: Uint8ClampedArray;
  private readonly hashBuckets = new Map<number, number[]>();
  private readonly scratch: OffscreenCanvas;
  private readonly context: OffscreenCanvasRenderingContext2D;
  private count = 0;
  private readonly tileBytes: number;

  constructor(capacity: number, private readonly width: number, private readonly height: number, private readonly budget: number) {
    this.tileBytes = width * height * 4;
    this.pixels = new Uint8ClampedArray(Math.min(capacity, Math.floor(budget / this.tileBytes)) * this.tileBytes);
    this.scratch = new OffscreenCanvas(width, height);
    const context = this.scratch.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create a canvas to resize gallery tiles.');
    this.context = context;
  }

  addSource(source: CanvasImageSource, fit: Settings['tile_fit'], deduplicate: boolean): void {
    this.context.clearRect(0, 0, this.width, this.height);
    const dimensions = sourceDimensions(source);
    let sx = 0, sy = 0, sw = dimensions.width, sh = dimensions.height;
    if (fit !== 'stretch') {
      const sourceAspect = sw / sh, targetAspect = this.width / this.height;
      if (sourceAspect > targetAspect) { sw = sh * targetAspect; sx = (dimensions.width - sw) / 2; }
      else { sh = sw / targetAspect; sy = (dimensions.height - sh) / 2; }
    }
    this.context.drawImage(source, sx, sy, sw, sh, 0, 0, this.width, this.height);
    const tile = this.context.getImageData(0, 0, this.width, this.height).data;
    const hash = deduplicate ? hashPixels(tile) : 0;
    const bucket = deduplicate ? this.hashBuckets.get(hash) : undefined;
    if (bucket && bucket.some((index) => this.equals(index, tile))) return;
    if (this.count >= this.pixels.length / this.tileBytes) this.grow();
    this.pixels.set(tile, this.count * this.tileBytes);
    if (deduplicate) {
      const positions = bucket ?? [];
      positions.push(this.count);
      this.hashBuckets.set(hash, positions);
    }
    this.count++;
  }

  finish(): TileSet {
    if (!this.count) throw new Error('The gallery contains no unique readable tiles.');
    return { pixels: this.pixels.slice(0, this.count * this.tileBytes), count: this.count, width: this.width, height: this.height };
  }

  private grow(): void {
    const capacity = Math.floor(this.budget / this.tileBytes);
    if (this.count >= capacity) throw new RangeError(`Decoded gallery exceeds the ${formatSize(this.budget)} tile budget.`);
    const current = this.pixels.length / this.tileBytes;
    const next = Math.min(capacity, Math.max(current + 1, current * 2));
    const grown = new Uint8ClampedArray(next * this.tileBytes);
    grown.set(this.pixels);
    this.pixels = grown;
  }

  private equals(index: number, pixels: Uint8ClampedArray): boolean {
    const base = index * this.tileBytes;
    for (let p = 0; p < this.tileBytes; p++) if (this.pixels[base + p] !== pixels[p]) return false;
    return true;
  }
}

function sourceDimensions(source: CanvasImageSource): { width: number; height: number } {
  if ('width' in source && 'height' in source) return { width: Number(source.width), height: Number(source.height) };
  throw new TypeError('Gallery image has no readable dimensions.');
}

function hashPixels(pixels: Uint8ClampedArray): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < pixels.length; i++) { hash ^= pixels[i]; hash = Math.imul(hash, 0x01000193); }
  return hash >>> 0;
}

function reduceRatio(width: number, height: number): [number, number] {
  let a = width, b = height;
  while (b) [a, b] = [b, a % b];
  return [width / a, height / a];
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'an unbounded amount';
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function assertCifarSize(file: File): void {
  if (file.size > MAX_CIFAR_FILE_BYTES) {
    throw new RangeError(`${file.name} exceeds the ${formatSize(MAX_CIFAR_FILE_BYTES)} CIFAR input limit.`);
  }
}
