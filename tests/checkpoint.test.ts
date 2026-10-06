import { Zip, ZipPassThrough, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { exportCheckpoint, hashBlob, identifyFile, importCheckpoint, validateCheckpoint } from '../src/checkpoint';
import { DEFAULT_SETTINGS, validateSettings } from '../src/config';
import type { Checkpoint, FileIdentity } from '../src/types';

const digest = `sha256-block4m:${'a'.repeat(64)}`;
const identity = (name: string): FileIdentity => ({ name, size: 10, lastModified: 123, digest });
function sample(): Checkpoint {
  return {
    version: 1,
    settings: validateSettings({ ...DEFAULT_SETTINGS, grid: [2, 1], cell_size: 2, tile_fit: 'stretch', segment: 2, gallery_budget: 1024 }),
    geometry: { cols: 2, rows: 1, cellWidth: 2, cellHeight: 2, width: 4, height: 2, fps: 24, startFrame: 12, stopFrame: 20, totalFrames: 8 },
    source: identity('clip.mp4'), gallery: [identity('tile.png')], format: 'mp4', completedFrames: 2,
    nextSourceTimestamp: 14 / 24, matcher: { version: 1, rng: 123456, keys: [4, 9], picks: [0, 2] },
    segments: [{ frames: 2, mosaic: new Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'video/mp4' }), combined: new Blob([Uint8Array.from([8, 7, 6])], { type: 'video/mp4' }) }],
  };
}

async function zipEntries(archive: Blob): Promise<Array<[string, Uint8Array]>> {
  const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  return Object.entries(files);
}
async function archiveOf(entries: Array<[string, Uint8Array]>): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  let error: Error | null = null;
  const zip = new Zip((problem, chunk) => { if (problem) error = problem; else chunks.push(new Uint8Array(chunk)); });
  for (const [name, bytes] of entries) {
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    entry.push(bytes, true);
  }
  zip.end();
  if (error) throw error;
  return new Blob(chunks, { type: 'application/zip' });
}

describe('checkpoint archives', () => {
  it('identifies file bytes with the exported block digest', async () => {
    const file = new File([Uint8Array.from([1, 2, 3])], 'source.bin', { lastModified: 99 });
    const identity = await identifyFile(file);
    expect(identity).toMatchObject({ name: 'source.bin', size: 3, lastModified: 99 });
    expect(identity.digest).toBe(await hashBlob(new Blob([Uint8Array.from([1, 2, 3])])));
    expect(await hashBlob(new Blob([Uint8Array.from([1, 2, 4])]))).not.toBe(identity.digest);
  });

  it('stops block hashing when its signal is aborted', async () => {
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(hashBlob(new Blob([Uint8Array.from([1, 2, 3])]), controller.signal)).rejects.toThrow('cancelled');
  });

  it('round trips binary segments, identities, and held matcher state', async () => {
    const original = sample();
    const imported = await importCheckpoint(await exportCheckpoint(original));
    expect(imported).toMatchObject({
      settings: original.settings, geometry: original.geometry, source: original.source, gallery: original.gallery,
      completedFrames: 2, nextSourceTimestamp: original.nextSourceTimestamp, matcher: original.matcher,
    });
    expect(new Uint8Array(await imported.segments[0].mosaic.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(new Uint8Array(await imported.segments[0].combined.arrayBuffer())).toEqual(new Uint8Array([8, 7, 6]));
    expect(await hashBlob(imported.segments[0].mosaic)).toBe(await hashBlob(original.segments[0].mosaic));
  });

  it('rejects invalid geometry, frame totals and matcher state without coupling state to gallery budget', () => {
    const badGeometry = sample(); badGeometry.geometry.width = 6;
    expect(() => validateCheckpoint(badGeometry)).toThrow(/geometry/);
    const huge = sample(); huge.geometry.cols = 1_000_001;
    expect(() => validateCheckpoint(huge)).toThrow(/geometry/);
    const badFrames = sample(); badFrames.segments[0].frames = 1;
    expect(() => validateCheckpoint(badFrames)).toThrow(/frame totals/);
    const badMatcher = sample(); badMatcher.matcher.picks = [0];
    expect(() => validateCheckpoint(badMatcher)).toThrow(/matcher state/);
    const smallGalleryBudget = sample(); smallGalleryBudget.settings = validateSettings({ ...smallGalleryBudget.settings, gallery_budget: 8 });
    expect(() => validateCheckpoint(smallGalleryBudget)).not.toThrow();
  });

  it('rejects missing, duplicated, unexpected, and corrupt archive entries', async () => {
    const entries = await zipEntries(await exportCheckpoint(sample()));
    const missing = entries.filter(([name]) => name !== 'mosaic-0.mp4');
    await expect(importCheckpoint(await archiveOf(missing))).rejects.toThrow();
    await expect(importCheckpoint(await archiveOf([...entries, entries[0]]))).rejects.toThrow(/duplicate/);
    await expect(importCheckpoint(await archiveOf([...entries, ['evil.bin', new Uint8Array([1])]]))).rejects.toThrow(/unexpected/);
    const corrupt = entries.map(([name, data]) => [name, data.slice()] as [string, Uint8Array]);
    const segment = corrupt.find(([name]) => name === 'mosaic-0.mp4')![1]; segment[0] ^= 0xff;
    await expect(importCheckpoint(await archiveOf(corrupt))).rejects.toThrow(/corrupt/);
  });

  it('rejects malicious geometry before materializing matcher arrays', async () => {
    const entries = await zipEntries(await exportCheckpoint(sample()));
    const manifest = entries.find(([name]) => name === 'manifest.json')![1];
    const raw = JSON.parse(new TextDecoder().decode(manifest));
    raw.geometry.cols = 1_000_001;
    raw.geometry.width = raw.geometry.cols * raw.geometry.cellWidth;
    const rewritten = new TextEncoder().encode(JSON.stringify(raw));
    const malicious = entries.map(([name, data]) => name === 'manifest.json' ? [name, rewritten] as [string, Uint8Array] : [name, data]);
    await expect(importCheckpoint(await archiveOf(malicious))).rejects.toThrow(/geometry/);
  });

  it('requires stored (uncompressed) ZIP records and rejects empty files', async () => {
    await expect(importCheckpoint(new Blob())).rejects.toThrow(/empty/);
    const compressed = zipSync({ 'manifest.json': new TextEncoder().encode('{}') }, { level: 6 });
    await expect(importCheckpoint(new Blob([compressed]))).rejects.toThrow();
  });
});
