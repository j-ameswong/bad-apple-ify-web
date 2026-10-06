import { Unzip, Zip, ZipPassThrough } from 'fflate';
import { validateGeometryBounds, validateSettings } from './config';
import type { Checkpoint, FileIdentity, Geometry, MatcherState } from './types';

const BLOCK = 4 * 1024 * 1024;
const MAX_ENTRIES = 100_003;
const MAX_MANIFEST = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MATCHER_STATE_BYTES = 8 * 1024 * 1024;
const MAX_MATCHER_CELLS = MAX_MATCHER_STATE_BYTES / 8;
const encoder = new TextEncoder();

/** A versioned block digest keeps hashing large local files off the JS heap. */
export async function hashBlob(blob: Blob, signal?: AbortSignal): Promise<string> {
  const digests = new Uint8Array(Math.max(1, Math.ceil(blob.size / BLOCK)) * 32);
  for (let offset = 0, index = 0; offset < blob.size || index === 0; offset += BLOCK, index++) {
    signal?.throwIfAborted();
    const bytes = await blob.slice(offset, offset + BLOCK).arrayBuffer();
    signal?.throwIfAborted();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    signal?.throwIfAborted();
    digests.set(digest, index * 32);
  }
  signal?.throwIfAborted();
  const result = new Uint8Array(await crypto.subtle.digest('SHA-256', digests));
  signal?.throwIfAborted();
  return `sha256-block4m:${Array.from(result, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

export async function identifyFile(file: File, signal?: AbortSignal): Promise<FileIdentity> {
  return { name: file.name, size: file.size, lastModified: file.lastModified, digest: await hashBlob(file, signal) };
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function identityValid(value: FileIdentity): boolean {
  return !!value && typeof value.name === 'string' && integer(value.size, 1)
    && typeof value.lastModified === 'number' && Number.isFinite(value.lastModified)
    && typeof value.digest === 'string' && /^sha256-block4m:[a-f0-9]{64}$/.test(value.digest);
}

function checkedSettingsAndGeometry(settingsValue: unknown, geometryValue: unknown): { settings: ReturnType<typeof validateSettings>; geometry: Geometry; cells: number } {
  const settings = validateSettings(settingsValue);
  let g: Geometry;
  try { validateGeometryBounds(geometryValue); g = geometryValue; }
  catch (cause) { throw new Error('Invalid checkpoint geometry bounds.', { cause }); }
  const cells = g.cols * g.rows;
  if (!Number.isSafeInteger(cells) || cells < 1 || cells > MAX_MATCHER_CELLS) {
    throw new Error('Invalid checkpoint geometry bounds.');
  }
  const stateBytes = cells * 8;
  if (stateBytes > MAX_MATCHER_STATE_BYTES) throw new Error('Checkpoint matcher state exceeds its allowed size.');
  return { settings, geometry: g, cells };
}

function validateMatcherDescriptor(state: unknown, cells: number): asserts state is MatcherState {
  const matcher = state as MatcherState;
  if (!matcher || matcher.version !== 1 || !integer(matcher.rng) || matcher.rng > 0xffffffff
    || (matcher.keys === null) !== (matcher.picks === null)
    || (matcher.keys !== null && (!Array.isArray(matcher.keys) || !Array.isArray(matcher.picks)
      || matcher.keys.length !== cells || matcher.picks.length !== cells
      || !matcher.keys.every((x) => integer(x) && x <= 0xffffffff)
      || !matcher.picks.every((x) => integer(x) && x <= 0xffffffff)))) throw new Error('Invalid checkpoint matcher state.');
}

export function validateCheckpoint(value: Checkpoint): void {
  if (!value || value.version !== 1) throw new Error('Unsupported checkpoint version.');
  const { settings, geometry: g, cells } = checkedSettingsAndGeometry(value.settings, value.geometry);
  if (!identityValid(value.source) || !Array.isArray(value.gallery) || !value.gallery.length
    || !value.gallery.every(identityValid)) throw new Error('Invalid checkpoint file identities.');
  if (!['mp4', 'webm'].includes(value.format) || !integer(value.completedFrames, 1)
    || !Number.isFinite(value.nextSourceTimestamp) || value.nextSourceTimestamp < 0
    || !Array.isArray(value.segments) || !value.segments.length || value.segments.length > 50_000) {
    throw new Error('Invalid checkpoint progress.');
  }
  const segmentSize = settings.segment;
  let frames = 0, segmentBytes = 0;
  for (const [index, part] of value.segments.entries()) {
    if (!integer(part.frames, 1) || !(part.mosaic instanceof Blob) || !(part.combined instanceof Blob)
      || part.mosaic.size === 0 || part.combined.size === 0
      || (segmentSize > 0 && (part.frames > segmentSize
        || (index < value.segments.length - 1 && part.frames !== segmentSize)))) {
      throw new Error('Invalid checkpoint segment.');
    }
    frames += part.frames;
    if (!Number.isSafeInteger(frames)) throw new Error('Checkpoint frame totals exceed their allowed size.');
    segmentBytes += part.mosaic.size + part.combined.size;
    if (!Number.isSafeInteger(segmentBytes) || segmentBytes > MAX_ARCHIVE_BYTES) throw new Error('Checkpoint segment data exceeds its allowed total size.');
  }
  if (frames !== value.completedFrames || (g.stopFrame !== null && frames > g.stopFrame - g.startFrame)) {
    throw new Error('Checkpoint frame totals do not agree.');
  }
  validateMatcherDescriptor(value.matcher, cells);
}

function encodeState(state: MatcherState): Uint8Array {
  const count = state.keys?.length ?? 0;
  const bytes = new Uint8Array(count * 8);
  const data = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    data.setUint32(i * 8, state.keys![i], true);
    data.setUint32(i * 8 + 4, state.picks![i], true);
  }
  return bytes;
}

/** Stored ZIP entries stream into browser-managed Blobs without one giant buffer. */
export async function exportCheckpoint(checkpoint: Checkpoint): Promise<Blob> {
  validateCheckpoint(checkpoint);
  const files: [string, Blob][] = [];
  const records = [];
  for (const [index, part] of checkpoint.segments.entries()) {
    const mosaic = `mosaic-${index}.${checkpoint.format}`;
    const combined = `combined-${index}.${checkpoint.format}`;
    files.push([mosaic, part.mosaic], [combined, part.combined]);
    records.push({ frames: part.frames, mosaic, combined,
      mosaicSize: part.mosaic.size, combinedSize: part.combined.size,
      mosaicHash: await hashBlob(part.mosaic), combinedHash: await hashBlob(part.combined) });
  }
  const state = new Blob([encodeState(checkpoint.matcher) as Uint8Array<ArrayBuffer>]);
  files.push(['matcher.bin', state]);
  const manifest = { ...checkpoint, matcher: { version: 1, rng: checkpoint.matcher.rng,
    hasPrevious: checkpoint.matcher.keys !== null }, stateHash: await hashBlob(state), segments: records };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  if (manifestBytes.length > MAX_MANIFEST) throw new Error('Checkpoint has too many segments to export.');
  files.unshift(['manifest.json', new Blob([manifestBytes])]);
  const parts: Blob[] = [];
  let error: Error | null = null;
  const zip = new Zip((problem, chunk) => {
    if (problem) error = problem;
    else parts.push(new Blob([new Uint8Array(chunk)]));
  });
  for (const [name, blob] of files) {
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    const reader = blob.stream().getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        entry.push(next.value);
        if (error) throw error;
      }
      entry.push(new Uint8Array(), true);
    } finally { reader.releaseLock(); }
  }
  zip.end();
  if (error) throw error;
  return new Blob(parts, { type: 'application/zip' });
}

export async function importCheckpoint(archive: Blob): Promise<Checkpoint> {
  if (!archive.size) throw new Error('Checkpoint file is empty.');
  if (archive.size > MAX_ARCHIVE_BYTES) throw new Error('Checkpoint archive exceeds its allowed total size.');
  const entries = new Map<string, Blob>();
  const seen = new Set<string>();
  let error: Error | null = null;
  let totalBytes = 0;
  const zip = new Unzip((file) => {
    if (!/^(manifest\.json|matcher\.bin|(?:mosaic|combined)-\d+\.(mp4|webm))$/.test(file.name)
      || seen.has(file.name) || seen.size >= MAX_ENTRIES || file.compression !== 0) {
      error = new Error('Checkpoint contains an unexpected, duplicate or compressed entry.');
      return;
    }
    seen.add(file.name);
    const chunks: Blob[] = [];
    let bytes = 0;
    file.ondata = (problem, data, final) => {
      if (problem) { error = problem; return; }
      bytes += data.length;
      totalBytes += data.length;
      if (totalBytes > archive.size || (file.name === 'manifest.json' && bytes > MAX_MANIFEST)) {
        error = new Error('Checkpoint entry exceeds its allowed size.');
        file.terminate();
        return;
      }
      chunks.push(new Blob([new Uint8Array(data)]));
      if (final) entries.set(file.name, new Blob(chunks));
    };
    file.start();
  });
  const reader = archive.stream().getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      zip.push(next.value);
      if (error) throw error;
    }
    zip.push(new Uint8Array(), true);
    if (error) throw error;
  } finally { reader.releaseLock(); }
  const manifestBlob = entries.get('manifest.json');
  if (!manifestBlob || entries.size !== seen.size) throw new Error('Checkpoint archive is incomplete.');
  // Treat every field as untrusted until sizes, hashes and structure agree.
  const raw = JSON.parse(await manifestBlob.text());
  if (!raw || raw.version !== 1 || !Array.isArray(raw.segments) || raw.segments.length > 50_000
    || !['mp4', 'webm'].includes(raw.format) || !raw.matcher || !raw.geometry
    || typeof raw.matcher.hasPrevious !== 'boolean') throw new Error('Invalid checkpoint manifest.');
  const { settings, geometry, cells } = checkedSettingsAndGeometry(raw.settings, raw.geometry);
  if (!integer(raw.matcher.rng) || raw.matcher.rng > 0xffffffff) throw new Error('Invalid checkpoint matcher state.');
  const state = entries.get('matcher.bin');
  if (entries.size !== raw.segments.length * 2 + 2) throw new Error('Unexpected checkpoint entries.');
  if (!state || state.size > settings.gallery_budget || state.size > MAX_MATCHER_STATE_BYTES
    || state.size !== (raw.matcher.hasPrevious ? cells * 8 : 0)
    || await hashBlob(state) !== raw.stateHash) throw new Error('Checkpoint matcher state is corrupt.');
  const stateData = new DataView(await state.arrayBuffer());
  const matcher: MatcherState = { version: 1, rng: raw.matcher.rng, keys: null, picks: null };
  if (raw.matcher.hasPrevious) {
    matcher.keys = new Array(cells);
    matcher.picks = new Array(cells);
    for (let i = 0; i < cells; i++) {
      matcher.keys[i] = stateData.getUint32(i * 8, true);
      matcher.picks[i] = stateData.getUint32(i * 8 + 4, true);
    }
  }
  const segments = [];
  for (const [index, record] of raw.segments.entries()) {
    if (!record || record.mosaic !== `mosaic-${index}.${raw.format}`
      || record.combined !== `combined-${index}.${raw.format}`) throw new Error('Invalid checkpoint segment order.');
    const mosaic = entries.get(record.mosaic);
    const combined = entries.get(record.combined);
    if (!mosaic || !combined || mosaic.size !== record.mosaicSize || combined.size !== record.combinedSize
      || await hashBlob(mosaic) !== record.mosaicHash || await hashBlob(combined) !== record.combinedHash) {
      throw new Error(`Checkpoint segment ${index + 1} is missing or corrupt.`);
    }
    segments.push({ frames: record.frames, mosaic, combined });
  }
  const checkpoint: Checkpoint = { ...raw, settings, geometry, matcher, segments };
  validateCheckpoint(checkpoint);
  return checkpoint;
}
