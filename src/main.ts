import './style.css';
import { parse, stringify } from 'smol-toml';
import { DEFAULT_SETTINGS, formatBytes, validateSettings } from './config';
import { exportCheckpoint, importCheckpoint } from './checkpoint';
import { renderUI } from './ui';
import type { Checkpoint, Estimate, Settings, WorkerRequest, WorkerResponse } from './types';

renderUI();
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const form = $<HTMLFormElement>('#settings-form');
const sourceInput = $<HTMLInputElement>('#source'), galleryInput = $<HTMLInputElement>('#gallery');
const run = $<HTMLButtonElement>('#run'), estimateButton = $<HTMLButtonElement>('#estimate');
const cancel = $<HTMLButtonElement>('#cancel'), checkpointButton = $<HTMLButtonElement>('#checkpoint-save');
const progress = $<HTMLProgressElement>('#progress'), result = $<HTMLVideoElement>('#result-video');
const canvas = $<HTMLCanvasElement>('#preview-canvas');
let checkpoint: Checkpoint | undefined, estimate: Estimate | undefined;
let busy = false, checkpointBusy = false;
let outputUrls: string[] = [];
let estimateWaiter: { resolve(value: Estimate): void; reject(error: Error): void } | undefined;
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

function status(message: string, error = false) { $('#status').textContent = message; $('#status').classList.toggle('error', error); }
function setBusy(value: boolean) {
  busy = value;
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('#settings-form input, #settings-form select, #source, #gallery, #settings-load, #checkpoint-load, #clear-cache, #checkpoint-clear')) control.disabled = value;
  estimateButton.disabled = value;
  run.disabled = value || !sourceInput.files?.length || !galleryInput.files?.length;
  run.textContent = checkpoint ? 'Resume mosaic' : 'Make mosaic';
  cancel.hidden = !value; cancel.disabled = false;
  checkpointButton.disabled = !checkpoint || checkpointBusy;
}
function parseBudget(text: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)\s*$/i.exec(text);
  if (!match) throw new Error('Gallery memory limit must be bytes or a size such as 256M.');
  return Math.floor(Number(match[1]) * 1024 ** ['', 'K', 'M', 'G', 'T'].indexOf(match[2].toUpperCase()));
}
function readSettings(overrides: Record<string, unknown> = {}): Settings {
  const values: Record<string, unknown> = { ...overrides };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (Object.hasOwn(overrides, key)) continue;
    const control = form.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement;
    if (control instanceof HTMLInputElement && control.type === 'checkbox') values[key] = control.checked;
    else if (key === 'grid') {
      const text = control.value.trim(), match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(text);
      if (text && !match) throw new Error('Fixed grid must be columns × rows, for example 32x24.');
      values[key] = match ? [Number(match[1]), Number(match[2])] : null;
    } else if (key === 'gallery_budget') values[key] = parseBudget(control.value);
    else if (key === 'metric' || key === 'tile_fit') values[key] = control.value;
    else if ((key === 'cell_size' || key === 'duration') && !control.value.trim()) values[key] = null;
    else { if (!control.value.trim()) throw new Error(`${key.replaceAll('_', ' ')} needs a value.`); values[key] = Number(control.value); }
  }
  return validateSettings(values);
}
function writeSettings(settings: Settings) {
  for (const [key, value] of Object.entries(settings)) {
    const control = form.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement;
    if (!control) continue;
    if (typeof value === 'boolean') (control as HTMLInputElement).checked = value;
    else control.value = value === null ? '' : Array.isArray(value) ? value.join('x') : String(value);
  }
}
function releaseResults() {
  result.pause(); result.removeAttribute('src'); result.load(); result.hidden = true; canvas.hidden = false;
  $('#downloads').hidden = true;
  for (const url of outputUrls) URL.revokeObjectURL(url);
  outputUrls = [];
  for (const id of ['mosaic', 'combined']) $(`#${id}-download`).removeAttribute('href');
}
function showCheckpoint() {
  checkpointButton.disabled = !checkpoint || checkpointBusy;
  $('#checkpoint-clear').hidden = !checkpoint;
  $('#checkpoint-description').textContent = checkpoint
    ? `${checkpoint.completedFrames.toLocaleString()} frames in ${checkpoint.segments.length} completed segments. Resume with “${checkpoint.source.name}” and the same gallery.`
    : 'Save completed segments as a checkpoint. Reload it with the same source and gallery to resume.';
  run.textContent = checkpoint ? 'Resume mosaic' : 'Make mosaic';
}
function invalidate(fromSettings = false) {
  estimate = undefined; $('#estimate-result').hidden = true; $('#warnings').hidden = true;
  if (fromSettings) { checkpoint = undefined; showCheckpoint(); }
  releaseResults(); progress.hidden = true;
  status(sourceInput.files?.length && galleryInput.files?.length ? 'Ready to estimate or make your mosaic.' : 'Choose a source video and tile gallery.');
  setBusy(false);
}
function dispatch(type: 'estimate' | 'run') {
  if (busy) throw new Error('Wait for the current operation or cancel it first.');
  const source = sourceInput.files?.[0], gallery = Array.from(galleryInput.files ?? []);
  if (!source || !gallery.length) throw new Error('Choose a source video and at least one gallery file.');
  const settings = readSettings();
  if (type === 'run') releaseResults();
  status(type === 'estimate' ? 'Reading your video and gallery…' : checkpoint ? 'Checking checkpoint and local files…' : 'Preparing your mosaic…');
  progress.hidden = false; progress.removeAttribute('value'); setBusy(true);
  worker.postMessage({ type, source, gallery: gallery.sort((a, b) => a.name.localeCompare(b.name)), settings, checkpoint: type === 'run' ? checkpoint : undefined } satisfies WorkerRequest);
}
function displayEstimate(value: Estimate) {
  estimate = value; const element = $('#estimate-result'); element.replaceChildren();
  for (const [label, text] of [['Mosaic size', `${value.geometry.width} × ${value.geometry.height}`], ['Grid', `${value.geometry.cols} × ${value.geometry.rows}`], ['Gallery estimate', value.galleryBytes === null ? 'Unknown until decoded' : formatBytes(value.galleryBytes)], ['Export', `${value.format.toUpperCase()} · ${value.geometry.fps.toFixed(2)} fps`]]) {
    const metric = document.createElement('div'), name = document.createElement('span'), content = document.createElement('strong');
    name.textContent = label; content.textContent = text; metric.append(name, content); element.append(metric);
  }
  element.hidden = false; $('#warnings').textContent = value.warnings.join(' '); $('#warnings').hidden = !value.warnings.length;
}
worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
  switch (data.type) {
    case 'estimate': displayEstimate(data.value); setBusy(false); progress.hidden = true; status('Estimate ready. Your files will be processed locally.'); estimateWaiter?.resolve(data.value); estimateWaiter = undefined; break;
    case 'progress': {
      const p = data.value; status(`${p.stage}${p.total ? ` · ${p.completed.toLocaleString()} / ${p.total.toLocaleString()}` : p.completed ? ` · ${p.completed.toLocaleString()}` : ''}`);
      if (p.total) { progress.max = p.total; progress.value = p.completed; } else progress.removeAttribute('value'); break;
    }
    case 'preview': canvas.width = data.bitmap.width; canvas.height = data.bitmap.height; canvas.getContext('2d')!.drawImage(data.bitmap, 0, 0); data.bitmap.close(); $('#empty-preview').hidden = true; canvas.hidden = false; break;
    case 'checkpoint': checkpoint = data.value; showCheckpoint(); break;
    case 'done': {
      const mosaicUrl = URL.createObjectURL(data.mosaic), combinedUrl = URL.createObjectURL(data.combined); outputUrls.push(mosaicUrl, combinedUrl);
      const mosaicLink = $<HTMLAnchorElement>('#mosaic-download'), combinedLink = $<HTMLAnchorElement>('#combined-download');
      mosaicLink.href = mosaicUrl; mosaicLink.download = `mosaic.${data.format}`; combinedLink.href = combinedUrl; combinedLink.download = `source-and-mosaic.${data.format}`;
      result.src = combinedUrl; result.hidden = false; canvas.hidden = true; $('#empty-preview').hidden = true; $('#downloads').hidden = false;
      $('#preview-caption').textContent = `${data.frames.toLocaleString()} frames · ${data.format.toUpperCase()}`;
      progress.max = 1; progress.value = 1; setBusy(false); status(`Finished. ${data.frames.toLocaleString()} frames ready to preview and download.`); break;
    }
    case 'cancelled': setBusy(false); progress.hidden = true; status(checkpoint ? `Cancelled. ${checkpoint.completedFrames.toLocaleString()} completed frames are saved in this tab.` : 'Cancelled. No segment was completed.'); estimateWaiter?.reject(new Error('Cancelled.')); estimateWaiter = undefined; break;
    case 'error': setBusy(false); progress.hidden = true; status(data.message, true); estimateWaiter?.reject(new Error(data.message)); estimateWaiter = undefined; break;
  }
};
worker.onerror = (event) => { setBusy(false); progress.hidden = true; const message = event.message || 'The video worker stopped. Reload and import your saved checkpoint.'; status(message, true); estimateWaiter?.reject(new Error(message)); estimateWaiter = undefined; };
function attempt(action: () => void | Promise<void>) { void Promise.resolve().then(action).catch((error: unknown) => status(error instanceof Error ? error.message : String(error), true)); }
sourceInput.onchange = () => { $('#source-name').textContent = sourceInput.files?.[0]?.name ?? 'The picture to recreate'; invalidate(); };
galleryInput.onchange = () => { $('#gallery-name').textContent = galleryInput.files?.length ? `${galleryInput.files.length} selected · ${Array.from(galleryInput.files).map(x => x.name).join(', ')}` : 'Video clips, images or a CIFAR batch'; invalidate(); };
form.oninput = () => invalidate(true); form.onsubmit = event => event.preventDefault();
estimateButton.onclick = () => attempt(() => dispatch('estimate')); run.onclick = () => attempt(() => dispatch('run'));
cancel.onclick = () => { worker.postMessage({ type: 'cancel' } satisfies WorkerRequest); cancel.disabled = true; status('Cancelling the unfinished segment…'); };
$('#clear-cache').onclick = () => { worker.postMessage({ type: 'clear-cache' } satisfies WorkerRequest); status('Gallery cache cleared.'); };
$('#checkpoint-clear').onclick = () => { checkpoint = undefined; showCheckpoint(); status('Checkpoint discarded from this tab. The next run starts fresh.'); };
function download(blob: Blob, name: string) { const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
checkpointButton.onclick = () => attempt(async () => {
  if (!checkpoint || checkpointBusy) return; const snapshot = checkpoint; checkpointBusy = true; showCheckpoint(); checkpointButton.textContent = 'Preparing checkpoint…';
  try { download(await exportCheckpoint(snapshot), 'bad-apple-checkpoint.zip'); } finally { checkpointBusy = false; checkpointButton.textContent = 'Save checkpoint'; showCheckpoint(); }
});
$<HTMLInputElement>('#checkpoint-load').onchange = event => attempt(async () => {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; if (!file) return; setBusy(true); status('Checking checkpoint archive…');
  try { const restored = await importCheckpoint(file); checkpoint = restored; writeSettings(restored.settings); releaseResults(); showCheckpoint(); status(`Checkpoint loaded: ${restored.completedFrames.toLocaleString()} completed frames. Select the matching source and gallery to resume.`); }
  finally { input.value = ''; setBusy(false); }
});
function importedSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Settings must be an object or flat TOML table.'); const values = { ...raw } as Record<string, unknown>;
  for (const key of ['source', 'gallery', 'output_dir', 'gallery_type', 'dry_run']) delete values[key];
  if (typeof values.grid === 'string') { const match = /^(\d+)[x×](\d+)$/i.exec(values.grid.trim()); if (!match) throw new Error('Settings grid must use COLSxROWS.'); values.grid = [Number(match[1]), Number(match[2])]; }
  if (typeof values.gallery_budget === 'string') values.gallery_budget = parseBudget(values.gallery_budget);
  return validateSettings(values);
}
$<HTMLInputElement>('#settings-load').onchange = event => attempt(async () => {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; if (!file) return;
  try { const text = await file.text(); writeSettings(importedSettings(file.name.toLowerCase().endsWith('.json') ? JSON.parse(text) : parse(text))); invalidate(true); status('Settings loaded. Choose local files to estimate or process.'); } finally { input.value = ''; }
});
$('#settings-save').onclick = () => attempt(() => {
  const settings = readSettings(); const values: Record<string, string | number | boolean | number[]> = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== null));
  if (settings.grid) values.grid = settings.grid.join('x');
  download(new Blob(['# Select source and gallery files in the browser editor.\n' + stringify(values)], { type: 'application/toml' }), 'bad-apple-settings.toml');
});

type ModelContext = { registerTool(tool: { name: string; description: string; inputSchema: object; annotations: { readOnlyHint: boolean }; execute(input: unknown): unknown }, options: { signal: AbortSignal }): void | Promise<void> };
const context = (document as Document & { modelContext?: ModelContext }).modelContext;
if (context?.registerTool) {
  const lifecycle = new AbortController();
  const tools = [
    { name: 'get_mosaic_status', description: 'Read editor settings, processing status and completed checkpoint frames.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute: () => {
      let settings: Settings | null = null, settingsError: string | null = null;
      try { settings = readSettings(); } catch (error) { settingsError = error instanceof Error ? error.message : String(error); }
      return { busy, message: $('#status').textContent, settings, settingsError, completedFrames: checkpoint?.completedFrames ?? 0, estimate: estimate ?? null };
    } },
    { name: 'configure_mosaic', description: 'Update editor settings and discard the in-tab checkpoint.', inputSchema: { type: 'object', properties: { settings: { type: 'object' } }, required: ['settings'], additionalProperties: false }, annotations: { readOnlyHint: false }, execute: (input: unknown) => {
      if (busy) throw new Error('The editor is processing a video.'); if (!input || typeof input !== 'object' || !('settings' in input) || !input.settings || typeof input.settings !== 'object') throw new Error('Provide a settings object.');
      const settings = readSettings(input.settings as Record<string, unknown>); writeSettings(settings); invalidate(true); return { settings };
    } },
    { name: 'estimate_mosaic', description: 'Estimate using source and gallery files already selected by the user.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false }, execute: () => new Promise<Estimate>((resolve, reject) => { if (busy) { reject(new Error('The editor is busy.')); return; } estimateWaiter = { resolve, reject }; try { dispatch('estimate'); } catch (error) { estimateWaiter = undefined; reject(error); } }) },
    { name: 'start_mosaic', description: 'Start or resume processing selected local files; query status for completion.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false }, execute: () => { dispatch('run'); return { status: 'processing' }; } },
  ];
  for (const tool of tools) { try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch { /* Optional browser API. */ } }
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
setBusy(false);
