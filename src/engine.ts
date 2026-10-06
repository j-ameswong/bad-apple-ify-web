import {
  AudioSampleSink, AudioSampleSource, CanvasSource, EncodedPacketSink,
  EncodedVideoPacketSource, Input, BlobSource, ALL_FORMATS, Mp4OutputFormat,
  Output, StreamTarget, WebMOutputFormat,
} from 'mediabunny';
import { deriveGeometry, formatBytes, validateSettings } from './config';
import { identifyFile, validateCheckpoint } from './checkpoint';
import { estimateGallery, inspectGallery, loadGalleryTiles } from './gallery';
import { chooseOutputFormat, decodeFrames, openVideo, throwIfAborted } from './media';
import { Matcher } from './matching';
import type { Checkpoint, Estimate, Geometry, Segment, Settings } from './types';

export interface RunHooks {
  signal?: AbortSignal;
  progress?: (stage: string, completed: number, total: number | null) => void;
  checkpoint?: (value: Checkpoint) => void;
  preview?: (bitmap: ImageBitmap) => void;
}

export interface RunResult { checkpoint: Checkpoint; mosaic: Blob; combined: Blob; format: 'mp4' | 'webm'; frames: number }
type VideoConfigLike = NonNullable<NonNullable<Parameters<Output['addVideoTrack']>[1]>['decoderConfig']>;

export async function estimateRun(source: File, gallery: File[], rawSettings: Settings, signal?: AbortSignal): Promise<Estimate> {
  const settings = validateSettings(rawSettings);
  const opened = await openVideo(source, signal);
  try {
    const galleryInfo = await inspectGallery(gallery, settings, signal);
    const geometry = deriveGeometry(settings, opened.info, galleryInfo.nativeAspect);
    const tiles = await estimateGallery(gallery, settings, geometry, signal);
    const format = await chooseOutputFormat(geometry.width, geometry.height, opened.info.hasAudio);
    const frames = geometry.totalFrames;
    const predictedBytes = frames === null ? Infinity : Math.ceil(frames * (geometry.width * geometry.height * 2) * 0.12);
    const warnings = predictedBytes > 512 * 1024 * 1024
      ? [`Estimated encoded output may exceed ${frames === null ? '512 MiB' : formatBytes(predictedBytes)}; these files remain in memory until downloaded.`]
      : [];
    return { source: opened.info, geometry, galleryCount: tiles.count, galleryBytes: tiles.bytes, format, warnings };
  } finally { opened.input.dispose(); }
}

export async function runMosaic(source: File, gallery: File[], rawSettings: Settings, resume: Checkpoint | undefined, hooks: RunHooks = {}): Promise<RunResult> {
  const { signal } = hooks;
  const settings = validateSettings(rawSettings);
  const estimate = await estimateRun(source, gallery, settings, signal);
  throwIfAborted(signal);
  const sourceIdentity = await identifyFile(source, signal);
  const galleryIdentities = [];
  for (const file of gallery) {
    throwIfAborted(signal);
    galleryIdentities.push(await identifyFile(file, signal));
  }
  let checkpoint: Checkpoint;
  if (resume) {
    validateCheckpoint(resume);
    if (resume.source.digest !== sourceIdentity.digest
      || JSON.stringify(resume.gallery.map((x) => x.digest)) !== JSON.stringify(galleryIdentities.map((x) => x.digest))
      || JSON.stringify(resume.settings) !== JSON.stringify(settings)
      || JSON.stringify(resume.geometry) !== JSON.stringify(estimate.geometry)
      || resume.format !== estimate.format) throw new Error('Checkpoint does not match the selected source, gallery or settings.');
    checkpoint = structuredClone(resume);
  } else {
    checkpoint = {
      version: 1, settings, geometry: estimate.geometry, source: sourceIdentity,
      gallery: galleryIdentities, format: estimate.format, completedFrames: 0,
      nextSourceTimestamp: 0, matcher: { version: 1, rng: 0, keys: null, picks: null }, segments: [],
    };
  }

  hooks.progress?.('Loading gallery', 0, estimate.galleryCount);
  const tiles = await loadGalleryTiles(gallery, settings, estimate.geometry, signal,
    (completed, total) => hooks.progress?.('Loading gallery', completed, total));
  const matcher = new Matcher(tiles, settings, estimate.geometry);
  if (checkpoint.completedFrames) matcher.restore(checkpoint.matcher);
  else if (estimate.geometry.startFrame) {
    hooks.progress?.('Preparing source slice', 0, estimate.geometry.startFrame);
    const prefix = await openVideo(source, signal);
    try {
      for await (const frame of decodeFrames(prefix, estimate.geometry, 0, estimate.geometry.startFrame, signal)) {
        matcher.render(frame.rgba);
        if (frame.index % 120 === 0) hooks.progress?.('Preparing source slice', frame.index + 1, estimate.geometry.startFrame);
      }
    } finally { prefix.input.dispose(); }
  }

  const opened = await openVideo(source, signal);
  const geometry = estimate.geometry;
  const requestedEnd = geometry.totalFrames === null ? null : geometry.startFrame + geometry.totalFrames;
  const doneEnd = requestedEnd === null ? null : Math.min(requestedEnd, geometry.stopFrame ?? requestedEnd);
  let currentFrames = checkpoint.completedFrames;
  let segmentMosaic: CanvasEncoder | null = null;
  let segmentCombined: CanvasEncoder | null = null;
  let segmentStart = currentFrames;
  const completedSegments = checkpoint.segments.slice();
  const mosaicCanvas = new OffscreenCanvas(geometry.width, geometry.height);
  const mosaicCtx = mosaicCanvas.getContext('2d');
  const combinedCanvas = new OffscreenCanvas(geometry.width * 2, geometry.height);
  const combinedCtx = combinedCanvas.getContext('2d');
  if (!mosaicCtx || !combinedCtx) { opened.input.dispose(); throw new Error('This browser could not create encoder canvases.'); }
  const mosaicPixels = mosaicCtx.createImageData(geometry.width, geometry.height);
  const sourcePixels = combinedCtx.createImageData(geometry.width, geometry.height);
  const outputPixels = combinedCtx.createImageData(geometry.width, geometry.height);

  const beginSegment = async (): Promise<void> => {
    segmentStart = currentFrames;
    segmentMosaic = await createCanvasEncoder(mosaicCanvas, checkpoint.format, geometry.fps);
    segmentCombined = await createCanvasEncoder(combinedCanvas, checkpoint.format, geometry.fps);
  };
  const commitSegment = async (nextTimestamp?: number): Promise<void> => {
    const mosaicEncoder = segmentMosaic;
    const combinedEncoder = segmentCombined;
    if (!mosaicEncoder || !combinedEncoder || currentFrames === segmentStart) return;
    try {
      const [mosaic, combined] = await Promise.all([mosaicEncoder.finish(), combinedEncoder.finish()]);
      const completedSegment = { frames: currentFrames - segmentStart, mosaic, combined };
      completedSegments.push(completedSegment);
      checkpoint = { ...checkpoint, completedFrames: currentFrames,
        nextSourceTimestamp: nextTimestamp ?? opened.firstTimestamp + (geometry.startFrame + currentFrames) / geometry.fps,
        matcher: matcher.snapshot(), segments: completedSegments.slice() };
      hooks.checkpoint?.(structuredClone(checkpoint));
      segmentMosaic = null;
      segmentCombined = null;
    } catch (error) { await Promise.allSettled([mosaicEncoder.abort(), combinedEncoder.abort()]); throw error; }
  };

  try {
    hooks.progress?.('Encoding frames', currentFrames, geometry.totalFrames);
    let previewed = false;
    if (currentFrames === 0 || (settings.segment > 0 && currentFrames % settings.segment !== 0)) await beginSegment();
    const wantedIndex = geometry.startFrame + currentFrames;
    const seek = currentFrames > 0 ? checkpoint.nextSourceTimestamp : undefined;
    const frames = decodeFrames(opened, geometry, wantedIndex, doneEnd, signal, seek)[Symbol.asyncIterator]();
    let next = await frames.next();
    while (!next.done) {
      const frame = next.value;
      throwIfAborted(signal);
      if (!segmentMosaic || !segmentCombined) await beginSegment();
      const mosaic = matcher.render(frame.rgba);
      mosaicPixels.data.set(mosaic);
      mosaicCtx.putImageData(mosaicPixels, 0, 0);
      sourcePixels.data.set(frame.rgba);
      outputPixels.data.set(mosaic);
      combinedCtx.putImageData(sourcePixels, 0, 0);
      combinedCtx.putImageData(outputPixels, geometry.width, 0);
      const localIndex = currentFrames - segmentStart;
      const timestamp = localIndex / geometry.fps;
      const duration = 1 / geometry.fps;
      const mosaicEncoder = segmentMosaic!;
      const combinedEncoder = segmentCombined!;
      await Promise.all([
        mosaicEncoder.add(timestamp, duration, localIndex === 0),
        combinedEncoder.add(timestamp, duration, localIndex === 0),
      ]);
      currentFrames++;
      if (currentFrames % 10 === 0) hooks.progress?.('Encoding frames', currentFrames, geometry.totalFrames);
      if (hooks.preview && (!previewed || currentFrames % 30 === 0)) {
        const bitmap = await createImageBitmap(combinedCanvas);
        hooks.preview(bitmap);
        previewed = true;
      }
      const segmentLimit = settings.segment || Number.MAX_SAFE_INTEGER;
      if (currentFrames - segmentStart >= segmentLimit) {
        const pending = await frames.next();
        await commitSegment(pending.done ? undefined : pending.value.timestamp);
        if (!pending.done && (geometry.totalFrames === null || currentFrames < geometry.totalFrames)) await beginSegment();
        next = pending;
      } else {
        next = await frames.next();
      }
    }
    await commitSegment();
  } catch (error) {
    await Promise.allSettled([(segmentMosaic as CanvasEncoder | null)?.abort(), (segmentCombined as CanvasEncoder | null)?.abort()]);
    throw error;
  } finally { opened.input.dispose(); }

  if (!currentFrames) throw new Error('The selected source range contains no decodable frames.');
  hooks.progress?.('Finalizing videos', 0, completedSegments.length);
  const mosaic = await remuxVideoSegments(completedSegments, 'mosaic', geometry.width, geometry.height, checkpoint.format, geometry.fps, signal);
  const combined = await remuxVideoSegments(completedSegments, 'combined', geometry.width * 2, geometry.height, checkpoint.format, geometry.fps, signal,
    source, estimate.source.hasAudio ? opened.firstTimestamp + geometry.startFrame / geometry.fps : undefined,
    estimate.source.hasAudio ? opened.firstTimestamp + (geometry.startFrame + currentFrames) / geometry.fps : undefined);
  hooks.progress?.('Finalizing videos', completedSegments.length, completedSegments.length);
  return { checkpoint, mosaic, combined, format: checkpoint.format, frames: currentFrames };
}

class BlobRangeStore {
  private ranges: { start: number; end: number; blob: Blob }[] = [];
  write(data: Uint8Array, position: number): void {
    if (!Number.isSafeInteger(position) || position < 0) throw new RangeError('Encoder wrote an invalid file position.');
    const start = position, end = position + data.byteLength;
    const next: typeof this.ranges = [];
    for (const range of this.ranges) {
      if (range.end <= start || range.start >= end) next.push(range);
      else {
        if (range.start < start) next.push({ start: range.start, end: start, blob: range.blob.slice(0, start - range.start) });
        if (range.end > end) next.push({ start: end, end: range.end, blob: range.blob.slice(end - range.start) });
      }
    }
    next.push({ start, end, blob: new Blob([new Uint8Array(data)]) });
    next.sort((a, b) => a.start - b.start);
    this.ranges = next;
  }
  blob(type: string): Blob {
    let position = 0;
    for (const range of this.ranges) {
      if (range.start !== position) throw new Error('Encoder output contains a gap and cannot be published.');
      position = range.end;
    }
    if (!position) throw new Error('Encoder produced an empty video.');
    return new Blob(this.ranges.map((range) => range.blob), { type });
  }
}

class CanvasEncoder {
  private output: Output;
  private source: CanvasSource;
  private store: BlobRangeStore;
  private type: string;
  private closed = false;
  private constructor(output: Output, source: CanvasSource, store: BlobRangeStore, type: string) {
    this.output = output; this.source = source; this.store = store; this.type = type;
  }
  static async create(canvas: OffscreenCanvas, format: 'mp4' | 'webm', fps: number): Promise<CanvasEncoder> {
    const store = new BlobRangeStore();
    const writable = new WritableStream({ write: (chunk) => store.write(chunk.data, chunk.position) });
    const target = new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 });
    const outputFormat = format === 'mp4' ? new Mp4OutputFormat() : new WebMOutputFormat();
    const output = new Output({ format: outputFormat, target });
    const bitrate = Math.ceil(Math.max(400_000, canvas.width * canvas.height * fps * 0.12));
    const source = new CanvasSource(canvas, { codec: format === 'mp4' ? 'avc' : 'vp9', bitrate, keyFrameInterval: 1 });
    output.addVideoTrack(source, { frameRate: fps });
    try { await output.start(); }
    catch (error) { await output.cancel().catch(() => undefined); throw error; }
    return new CanvasEncoder(output, source, store, outputFormat.mimeType);
  }
  add(timestamp: number, duration: number, keyFrame: boolean): Promise<void> {
    // CanvasSource snapshots synchronously when add is called.
    return this.source.add(timestamp, duration, { keyFrame });
  }
  async finish(): Promise<Blob> {
    if (!this.closed) {
      try { await this.output.finalize(); this.closed = true; }
      catch (error) { await this.output.cancel().catch(() => undefined); this.closed = true; throw error; }
    }
    return this.store.blob(this.type);
  }
  async abort(): Promise<void> { if (!this.closed) { this.closed = true; await this.output.cancel(); } }
}

function createCanvasEncoder(canvas: OffscreenCanvas, format: 'mp4' | 'webm', fps: number): Promise<CanvasEncoder> {
  return CanvasEncoder.create(canvas, format, fps);
}

async function remuxVideoSegments(parts: Segment[], which: 'mosaic' | 'combined', width: number, height: number, format: 'mp4' | 'webm', fps: number,
  signal?: AbortSignal, audioSourceFile?: File, audioStart?: number, audioEnd?: number): Promise<Blob> {
  const openedParts: { input: Input; track: Awaited<ReturnType<Input['getPrimaryVideoTrack']>> }[] = [];
  let audioInput: Input | undefined;
  let output: Output | undefined;
  let audioIterator: AsyncGenerator<import('mediabunny').AudioSample, void, unknown> | undefined;
  let audioPending: IteratorResult<import('mediabunny').AudioSample, void> | undefined;
  let finalized = false;
  const onAbort = (): void => {
    for (const entry of openedParts) entry.input.dispose();
    audioInput?.dispose();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (const entry of parts) {
      throwIfAborted(signal);
      const part = entry[which];
      const input = new Input({ source: new BlobSource(part), formats: ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('An encoded video segment has no video track.');
      openedParts.push({ input, track });
    }
    const configs = await Promise.all(openedParts.map(({ track }) => track!.getDecoderConfig()));
    const firstConfig = configs[0];
    if (!firstConfig || configs.some((config) => !compatibleDecoderConfig(firstConfig, config))) {
      throw new Error('Encoded segments have incompatible decoder configurations and cannot be joined safely.');
    }
    const store = new BlobRangeStore();
    const target = new StreamTarget(new WritableStream({ write: (chunk) => store.write(chunk.data, chunk.position) }), { chunked: true, chunkSize: 4 * 1024 * 1024 });
    const outputFormat = format === 'mp4' ? new Mp4OutputFormat() : new WebMOutputFormat();
    output = new Output({ format: outputFormat, target });
    const remuxOutput = output;
    const codec = format === 'mp4' ? 'avc' : 'vp9';
    const videoSource = new EncodedVideoPacketSource(codec);
    remuxOutput.addVideoTrack(videoSource, { frameRate: fps, decoderConfig: firstConfig as VideoConfigLike });
    let audioSource: AudioSampleSource | undefined;
    let audioSink: AudioSampleSink | undefined;
    if (audioSourceFile && audioStart !== undefined && audioEnd !== undefined && audioEnd > audioStart) {
      audioInput = new Input({ source: new BlobSource(audioSourceFile), formats: ALL_FORMATS });
      const audioTrack = await audioInput.getPrimaryAudioTrack();
      if (audioTrack) {
        audioSink = new AudioSampleSink(audioTrack);
        audioSource = new AudioSampleSource({ codec: format === 'mp4' ? 'aac' : 'opus', bitrate: 128_000, transform: { numberOfChannels: 2, sampleRate: 48_000 } });
        remuxOutput.addAudioTrack(audioSource);
        audioIterator = audioSink.samples(audioStart!, audioEnd!);
      }
    }
    await remuxOutput.start();
    let packetCount = 0;
    let cumulativeFrames = 0;
    const addAudioThrough = async (time: number): Promise<void> => {
      if (!audioSource || !audioIterator || audioStart === undefined || audioEnd === undefined) return;
      audioPending ??= await audioIterator.next();
      while (audioPending && !audioPending.done
        && audioPending.value.timestamp - audioStart <= time) {
        const sample = audioPending.value;
        const sampleStart = sample.timestamp;
        const sampleEnd = sampleStart + sample.duration;
        const clipStart = Math.max(sampleStart, audioStart);
        const clipEnd = Math.min(sampleEnd, audioEnd);
        if (clipEnd > clipStart) {
          const beginFrame = Math.max(0, Math.floor((clipStart - sampleStart) * sample.sampleRate));
          const endFrame = Math.min(sample.numberOfFrames, Math.ceil((clipEnd - sampleStart) * sample.sampleRate));
          const trimmed = sample.trim(beginFrame, endFrame);
          trimmed.setTimestamp(clipStart - audioStart);
          try { await audioSource.add(trimmed); } finally { trimmed.close(); }
        }
        sample.close();
        audioPending = await audioIterator.next();
      }
    };
    for (let partIndex = 0; partIndex < openedParts.length; partIndex++) {
      const { track } = openedParts[partIndex];
      throwIfAborted(signal);
      const sink = new EncodedPacketSink(track!);
      let first = true;
      for await (const packet of sink.packets()) {
        throwIfAborted(signal);
        if (first && packet.type !== 'key') throw new Error('An encoded segment does not begin with a keyframe.');
        const shifted = packet.clone({ timestamp: cumulativeFrames / fps + packet.timestamp, sequenceNumber: packetCount++ });
        await addAudioThrough(shifted.timestamp);
        const metadata = first ? { decoderConfig: firstConfig as VideoConfigLike } : undefined;
        await videoSource.add(shifted, metadata);
        first = false;
      }
      cumulativeFrames += parts[partIndex].frames;
    }
    await addAudioThrough(Infinity);
    await remuxOutput.finalize();
    finalized = true;
    return store.blob(outputFormat.mimeType);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (audioPending && !audioPending.done) audioPending.value.close();
    if (audioIterator) await audioIterator.return().catch(() => undefined);
    if (output && !finalized && output.state !== 'canceled' && output.state !== 'finalized') {
      await output.cancel().catch(() => undefined);
    }
    for (const { input } of openedParts) input.dispose();
    audioInput?.dispose();
  }
}

function compatibleDecoderConfig(a: VideoConfigLike, b: VideoConfigLike | null): boolean {
  if (!b || a.codec !== b.codec || a.codedWidth !== b.codedWidth || a.codedHeight !== b.codedHeight) return false;
  const description = (config: VideoConfigLike) => {
    if (!config.description) return [];
    const value = config.description;
    const bytes = ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value as ArrayBuffer);
    return Array.from(bytes);
  };
  return JSON.stringify(description(a)) === JSON.stringify(description(b));
}
