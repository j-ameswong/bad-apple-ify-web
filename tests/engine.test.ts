import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, deriveGeometry, validateSettings } from '../src/config';
import { parseCifarBatch } from '../src/cifar';
import { Matcher } from '../src/matching';
import type { Geometry, Settings, TileSet } from '../src/types';

describe('settings and geometry', () => {
  it('validates strict settings and uses browser defaults', () => {
    expect(DEFAULT_SETTINGS.gallery_budget).toBe(256 * 1024 * 1024);
    expect(validateSettings({ grid_size: 3 }).grid_size).toBe(3);
    expect(validateSettings({ segment: 0 }).segment).toBe(0);
    expect(() => validateSettings({ seed: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/seed/);
    expect(() => validateSettings({ extra: true })).toThrow(/unknown setting/);
  });
  it('rounds fractional-fps slices up and creates even native geometry', () => {
    const settings = validateSettings({ grid_size: 4, start: 1.01, duration: 2.01 });
    const geometry = deriveGeometry(settings, { width: 320, height: 240, fps: 30000 / 1001, duration: 10, frameCount: 300, hasAudio: false }, [1, 1]);
    expect(geometry.startFrame).toBe(31);
    expect(geometry.stopFrame).toBe(91);
    expect(geometry.width % 2).toBe(0);
    expect(geometry.height % 2).toBe(0);
  });
  it('rejects explicit odd output dimensions', () => {
    const settings = validateSettings({ grid: [1, 1], cell_size: 3, tile_fit: 'stretch' });
    expect(() => deriveGeometry(settings, { width: 4, height: 4, fps: 24, duration: 1, frameCount: 24, hasAudio: false }, null)).toThrow(/even output/);
  });
  it('rejects unsafe output pixels, excessive cell counts, and unsafe frame indices', () => {
    const source = { width: 320, height: 240, fps: 24, duration: 60, frameCount: 1440, hasAudio: false };
    expect(() => deriveGeometry(validateSettings({ grid: [2, 2], cell_size: 8192, tile_fit: 'stretch' }), source, null)).toThrow(/geometry/);
    expect(() => deriveGeometry(validateSettings({ grid: [1025, 1024], cell_size: 2, tile_fit: 'stretch' }), source, null)).toThrow(/geometry/);
    expect(() => deriveGeometry(validateSettings({ start: Number.MAX_VALUE }), source, null)).toThrow(/geometry/);
  });
});

describe('matcher', () => {
  const settings = validateSettings({ grid: [2, 1], cell_size: 2, contrast: 1, metric: 'brightness', candidates: 4, epsilon: 1, seed: 123, hold_tiles: true });
  const geometry: Geometry = { cols: 2, rows: 1, cellWidth: 2, cellHeight: 2, width: 4, height: 2, fps: 24, startFrame: 0, stopFrame: null, totalFrames: null };
  const source: TileSet = { width: 2, height: 2, count: 3, pixels: new Uint8ClampedArray([
    ...Array(4).fill([0, 0, 0, 255]).flat(), ...Array(4).fill([127, 127, 127, 255]).flat(), ...Array(4).fill([255, 255, 255, 255]).flat(),
  ]) };
  const frame = new Uint8ClampedArray(4 * 2 * 4);
  const nextFrame = new Uint8ClampedArray(4 * 2 * 4).fill(255);
  it('renders full mosaic RGBA and restores held state exactly', () => {
    const first = new Matcher(source, settings, geometry);
    const rendered = first.render(frame);
    expect(rendered).toHaveLength(32);
    const state = first.snapshot();
    const continuation = first.render(nextFrame);
    const restored = new Matcher(source, settings, geometry);
    restored.restore(state);
    expect(restored.render(nextFrame)).toEqual(continuation);
  });
  it('rejects malformed matcher snapshots and wrong frame shapes', () => {
    const matcher = new Matcher(source, settings, geometry);
    expect(() => matcher.restore({ version: 1, rng: 0, keys: [0], picks: [0] })).toThrow(/dimensions/);
    expect(() => matcher.render(new Uint8ClampedArray(1))).toThrow(/RGBA/);
  });
  it('matches RGB cell means through the colour lattice', () => {
    const colourSettings = validateSettings({ ...settings, metric: 'colour', colour_bins: 2, candidates: 1, hold_tiles: false });
    const redBlue: TileSet = { width: 2, height: 2, count: 2, pixels: new Uint8ClampedArray([
      ...Array(4).fill([255, 0, 0, 255]).flat(), ...Array(4).fill([0, 0, 255, 255]).flat(),
    ]) };
    const red = [255, 0, 0, 255], blue = [0, 0, 255, 255];
    const frame = new Uint8ClampedArray([...red, ...red, ...blue, ...blue, ...red, ...red, ...blue, ...blue]);
    const output = new Matcher(redBlue, colourSettings, geometry).render(frame);
    expect(output).toEqual(frame);
  });
});

describe('safe CIFAR pickle adapter', () => {
  for (const protocol of [2, 4, 5]) it(`decodes NumPy protocol ${protocol}`, () => {
    const buffer = new Uint8Array(readFileSync(new URL(`./fixtures/cifar-p${protocol}.pkl`, import.meta.url)));
    const parsed = parseCifarBatch(buffer);
    expect(parsed.count).toBe(2);
    expect(parsed.planarRgb).toHaveLength(6144);
    expect(parsed.planarRgb[0]).toBe(0);
    expect(parsed.planarRgb[3071]).toBe(255);
    expect(parsed.planarRgb[3072]).toBe(0);
  });
  it('decodes Python 2 byte-string dictionary keys', () => {
    const buffer = new Uint8Array(readFileSync(new URL('./fixtures/cifar-p2-byte-key.pkl', import.meta.url)));
    expect(parseCifarBatch(buffer).count).toBe(2);
  });
  const realFixture = process.env.BAD_APPLE_CIFAR_FIXTURE;
  it.skipIf(!realFixture)('decodes the full CIFAR train gallery when BAD_APPLE_CIFAR_FIXTURE is set', () => {
    const parsed = parseCifarBatch(new Uint8Array(readFileSync(realFixture!)));
    expect(parsed.count).toBe(50_000);
    expect(parsed.planarRgb).toHaveLength(153_600_000);
  });
  it('rejects unknown executable globals and truncated pickles', () => {
    const global = Uint8Array.from([0x80, 0x02, 0x63, ...new TextEncoder().encode('sys\nexit\n.')]);
    expect(() => parseCifarBatch(global)).toThrow(/unsupported pickle global/);
    expect(() => parseCifarBatch(new Uint8Array([0x80, 0x05]))).toThrow(/invalid or unsupported/);
  });
});
