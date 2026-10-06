import { estimateRun, runMosaic } from './engine';
import { clearGalleryCache } from './gallery';
import type { WorkerRequest, WorkerResponse } from './types';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};
let active: AbortController | null = null;

scope.onmessage = ({ data }) => {
  if (data.type === 'cancel') {
    active?.abort(new DOMException('Cancelled.', 'AbortError'));
    return;
  }
  if (data.type === 'clear-cache') {
    if (!active) clearGalleryCache();
    return;
  }
  if (active) {
    scope.postMessage({ type: 'error', message: 'A video operation is already running.' });
    return;
  }
  const controller = new AbortController();
  active = controller;
  void (async () => {
    try {
      if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined'
        || typeof OffscreenCanvas === 'undefined') {
        throw new Error('This browser does not support local video processing. Try a current desktop Chrome or Edge browser over HTTPS.');
      }
      if (data.type === 'estimate') {
        const value = await estimateRun(data.source, data.gallery, data.settings, controller.signal);
        if (!controller.signal.aborted) scope.postMessage({ type: 'estimate', value });
      } else if (data.type === 'run') {
        const result = await runMosaic(data.source, data.gallery, data.settings, data.checkpoint, {
          signal: controller.signal,
          progress: (stage, completed, total) => scope.postMessage({ type: 'progress', value: { stage, completed, total } }),
          checkpoint: (value) => {
            if (data.settings.segment > 0) scope.postMessage({ type: 'checkpoint', value });
          },
          preview: (bitmap) => scope.postMessage({ type: 'preview', bitmap }, [bitmap]),
        });
        if (!controller.signal.aborted) scope.postMessage({ type: 'done', mosaic: result.mosaic,
          combined: result.combined, format: result.format, frames: result.frames });
      }
      if (controller.signal.aborted) scope.postMessage({ type: 'cancelled' });
    } catch (error) {
      if (controller.signal.aborted) scope.postMessage({ type: 'cancelled' });
      else scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally { active = null; }
  })();
};
