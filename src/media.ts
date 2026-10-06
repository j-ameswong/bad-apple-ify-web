import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  Input,
  canEncodeAudio,
  canEncodeVideo,
  type InputVideoTrack,
} from 'mediabunny';
import type { Geometry, MediaInfo } from './types';

export interface OpenVideo {
  input: Input;
  track: InputVideoTrack;
  info: MediaInfo;
  firstTimestamp: number;
}

export interface DecodedFrame {
  index: number;
  timestamp: number;
  rgba: Uint8ClampedArray;
}

export async function openVideo(file: Blob, signal?: AbortSignal, checkAudio = true): Promise<OpenVideo> {
  throwIfAborted(signal);
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  signal?.addEventListener('abort', () => input.dispose(), { once: true });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`${file instanceof File ? file.name : 'File'} has no video track.`);
    if (!await track.canDecode()) throw new Error('This browser cannot decode the selected source video codec.');
    const [width, height, rate, metadataDuration, firstTimestamp, audioTrack, packetStats] = await Promise.all([
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      track.computeFrameRateMetrics({ targetPacketCount: 256 }),
      track.getDurationFromMetadata(),
      track.getFirstTimestamp(),
      input.getPrimaryAudioTrack(),
      track.computePacketStats(),
    ]);
    const duration = metadataDuration ?? await track.computeDuration();
    if (checkAudio && audioTrack && !await audioTrack.canDecode()) throw new Error('This browser cannot decode the selected source audio codec.');
    const fps = rate.bestGuessFrameRate;
    if (!Number.isFinite(fps) || fps <= 0 || width <= 0 || height <= 0 || duration <= 0) {
      throw new Error('The selected video has invalid dimensions, frame rate or duration.');
    }
    return {
      input,
      track,
      firstTimestamp,
      info: {
        width: Math.round(width),
        height: Math.round(height),
        fps,
        duration,
        frameCount: packetStats.packetCount,
        hasAudio: audioTrack !== null,
      },
    };
  } catch (error) {
    input.dispose();
    throw error;
  }
}

export async function chooseOutputFormat(
  width: number,
  height: number,
  hasAudio: boolean,
): Promise<'mp4' | 'webm'> {
  const mp4Video = (await Promise.all([width, width * 2].map((candidateWidth) =>
    canEncodeVideo('avc', { width: candidateWidth, height })))).every(Boolean);
  const mp4Audio = !hasAudio || await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000 });
  if (mp4Video && mp4Audio) return 'mp4';

  const webmVideo = (await Promise.all([width, width * 2].map((candidateWidth) =>
    canEncodeVideo('vp9', { width: candidateWidth, height })))).every(Boolean);
  const webmAudio = !hasAudio || await canEncodeAudio('opus', { numberOfChannels: 2, sampleRate: 48000 });
  if (webmVideo && webmAudio) return 'webm';
  throw new Error(`This browser can't encode the required ${hasAudio ? 'video and audio' : 'video'} codecs at ${width}×${height}.`);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Operation cancelled.', 'AbortError');
}

export async function* decodeFrames(
  opened: OpenVideo,
  geometry: Geometry,
  startIndex: number,
  endIndex: number | null,
  signal?: AbortSignal,
  seekTimestamp?: number,
): AsyncGenerator<DecodedFrame> {
  throwIfAborted(signal);
  const sink = new CanvasSink(opened.track);
  const canvas = new OffscreenCanvas(geometry.width, geometry.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser could not create a 2D canvas in its worker.');

  try {
    // Count decoded frames in presentation order. PTS-derived indices drift on VFR
    // sources and can duplicate or omit frames around slice and resume boundaries.
    let index = seekTimestamp === undefined ? 0 : startIndex;
    for await (const frame of sink.canvases(seekTimestamp)) {
      throwIfAborted(signal);
      if (seekTimestamp !== undefined && frame.timestamp < seekTimestamp) continue;
      const current = index++;
      if (current < startIndex) continue;
      if (endIndex !== null && current >= endIndex) break;
      context.drawImage(frame.canvas, 0, 0, geometry.width, geometry.height);
      const pixels = context.getImageData(0, 0, geometry.width, geometry.height).data;
      yield { index: current, timestamp: frame.timestamp, rgba: new Uint8ClampedArray(pixels) };
    }
  } finally {
    // CanvasSink owns decoder resources through its input; the caller disposes it.
  }
}

export function canvasFromRgba(pixels: Uint8ClampedArray, width: number, height: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not create a 2D canvas in its worker.');
  const data = new Uint8ClampedArray(pixels.length);
  data.set(pixels);
  context.putImageData(new ImageData(data, width, height), 0, 0);
  return canvas;
}
