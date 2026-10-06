export type Fit = 'native' | 'crop' | 'stretch';
export type MetricName = 'brightness' | 'colour';

export interface Settings {
  grid_size: number;
  grid: [number, number] | null;
  cell_size: number | null;
  tile_fit: Fit;
  contrast: number;
  metric: MetricName;
  candidates: number;
  epsilon: number;
  colour_bins: number;
  stochastic: boolean;
  seed: number;
  hold_tiles: boolean;
  stride: number;
  start: number;
  duration: number | null;
  segment: number;
  use_cache: boolean;
  gallery_budget: number;
}

export interface MediaInfo {
  width: number;
  height: number;
  fps: number;
  duration: number;
  frameCount: number | null;
  hasAudio: boolean;
}

export interface Geometry {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  width: number;
  height: number;
  fps: number;
  startFrame: number;
  stopFrame: number | null;
  totalFrames: number | null;
}

export interface TileSet {
  pixels: Uint8ClampedArray;
  count: number;
  width: number;
  height: number;
}

export interface MatcherState {
  version: 1;
  rng: number;
  keys: number[] | null;
  picks: number[] | null;
}

export interface FileIdentity {
  name: string;
  size: number;
  lastModified: number;
  digest: string;
}

export interface Segment {
  frames: number;
  mosaic: Blob;
  combined: Blob;
}

export interface Checkpoint {
  version: 1;
  settings: Settings;
  geometry: Geometry;
  source: FileIdentity;
  gallery: FileIdentity[];
  format: 'mp4' | 'webm';
  completedFrames: number;
  nextSourceTimestamp: number;
  matcher: MatcherState;
  segments: Segment[];
}

export interface Estimate {
  source: MediaInfo;
  geometry: Geometry;
  galleryCount: number | null;
  galleryBytes: number | null;
  format: 'mp4' | 'webm';
  warnings: string[];
}

export type Progress = {
  stage: string;
  completed: number;
  total: number | null;
};

export type WorkerRequest =
  | { type: 'estimate' | 'run'; source: File; gallery: File[]; settings: Settings; checkpoint?: Checkpoint }
  | { type: 'cancel' | 'clear-cache' };

export type WorkerResponse =
  | { type: 'estimate'; value: Estimate }
  | { type: 'progress'; value: Progress }
  | { type: 'preview'; bitmap: ImageBitmap }
  | { type: 'checkpoint'; value: Checkpoint }
  | { type: 'done'; mosaic: Blob; combined: Blob; format: 'mp4' | 'webm'; frames: number }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };
