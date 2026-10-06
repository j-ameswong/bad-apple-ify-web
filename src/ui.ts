import type { Settings } from './types';

const field = (name: keyof Settings, label: string, value: string | number, hint = '', attrs = '') => `<label class="field"><span>${label}</span><input name="${name}" value="${value}" ${attrs}/><small>${hint}</small></label>`;
const numeric = (name: keyof Settings, label: string, value: number | string, hint = '') => field(name, label, value, hint, 'type="number" step="any"');
const select = (name: keyof Settings, label: string, values: [string, string][]) => `<label class="field"><span>${label}</span><select name="${name}">${values.map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select></label>`;
const check = (name: keyof Settings, label: string, hint: string) => `<label class="check"><input type="checkbox" name="${name}" checked/><span>${label}<small>${hint}</small></span></label>`;

export function renderUI() {
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">▦</span> BAD APPLE <span class="subtitle">Mosaic studio</span></a><span class="privacy">Your files stay on this device</span></header>
  <main class="workspace"><aside class="controls">
    <h1>Make every frame<br>out of something else.</h1><p class="intro">Choose a video and the images that will become its tiles.</p>
    <label class="file-card"><span class="step">01</span><strong>Source video</strong><span id="source-name">The picture to recreate</span><input id="source" type="file" accept="video/*,.mkv,.avi,.mov"/></label>
    <label class="file-card"><span class="step">02</span><strong>Tile gallery</strong><span id="gallery-name">Video clips, images or a CIFAR batch</span><input id="gallery" type="file" multiple/></label>
    <p class="micro">Select multiple clips together. For CIFAR, select an extracted Python batch file.</p>
    <form id="settings-form" novalidate>
    <details open><summary>Geometry<span>How the tiles fit</span></summary><div class="fields">
      ${numeric('grid_size', 'Grid density', 8, 'Use 1 for one gallery image per frame.')}
      ${field('grid', 'Fixed grid', '', 'Optional columns × rows.', 'placeholder="Auto · e.g. 32x24"')}
      ${numeric('cell_size', 'Cell height (px)', '', 'Leave blank to use the source size.')}
      ${select('tile_fit', 'Tile fit', [['native', 'Native ratio'], ['crop', 'Crop to fill'], ['stretch', 'Stretch to fill']])}
    </div></details>
    <details open><summary>Matching<span>Colour, contrast and variety</span></summary><div class="fields">
      ${select('metric', 'Match by', [['colour', 'Colour'], ['brightness', 'Brightness']])}
      ${numeric('contrast', 'Gallery contrast', .8, 'Central brightness band, from 0 to 1.')}
      ${numeric('candidates', 'Candidate tiles', 256, 'More choices add variety.')}
      ${numeric('seed', 'Random seed', 0, 'Reuse a seed for repeatable choices.')}
    </div>${check('stochastic', 'Vary tile choices', 'Sample from matching candidates.')}${check('hold_tiles', 'Hold unchanged tiles', 'Keep static regions from flickering.')}</details>
    <details open><summary>Source slice<span>Try a short section first</span></summary><div class="fields">
      ${numeric('start', 'Start (seconds)', 0)}${numeric('duration', 'Duration (seconds)', '', 'Leave blank to process to the end.')}
    </div></details>
    <details><summary>Advanced<span>Sampling, accuracy and memory</span></summary><div class="fields">
      ${numeric('stride', 'Gallery frame stride', 10, 'Keep every Nth video frame.')}
      ${numeric('colour_bins', 'Colour bins', 32, '2–64; higher keeps closer colours.')}
      ${numeric('epsilon', 'Brightness tolerance', .005, 'Used for brightness matching.')}
      ${numeric('segment', 'Checkpoint interval', 5000, 'Frames per segment. 0 turns checkpoints off.')}
      ${field('gallery_budget', 'Gallery memory limit', '256M', 'Tile bytes, e.g. 256M or 1G. Working memory is extra.')}
    </div>${check('use_cache', 'Reuse gallery in this tab', 'Cleared when the tab closes.')}<button id="clear-cache" class="small-button" type="button">Clear gallery cache</button></details>
    </form>
    <div class="config-actions"><label class="file-button">Load settings<input id="settings-load" type="file" accept=".toml,.json"/></label><button id="settings-save" class="text-button" type="button">Save settings</button></div>
  </aside><section class="viewer"><div class="viewer-sticky">
    <div class="viewer-heading"><h2>Preview</h2><span id="preview-caption">Source + mosaic</span></div>
    <div class="preview-surface"><canvas id="preview-canvas" width="640" height="360" aria-label="Live mosaic preview"></canvas><video id="result-video" controls playsinline hidden aria-label="Completed side-by-side video"></video><div class="empty-preview" id="empty-preview"><span class="empty-grid" aria-hidden="true">▦</span><p>Your next mosaic starts here.</p><span>Select your source and gallery to begin.</span></div></div>
    <div class="estimate-grid" id="estimate-result" hidden></div>
    <div class="action-bar"><button id="estimate" type="button">Estimate size</button><button id="run" class="primary" type="button" disabled>Make mosaic</button><button id="cancel" type="button" hidden>Cancel</button></div>
    <progress id="progress" max="1" value="0" hidden aria-label="Processing progress"></progress>
    <p class="status" id="status" role="status" aria-live="polite">Ready for your files</p>
    <div id="warnings" class="warnings" hidden></div>
    <div id="downloads" class="downloads" hidden><a id="mosaic-download" class="download" download>Download mosaic</a><a id="combined-download" class="download" download>Download with source + audio</a></div>
    <div class="resume-panel"><h2>Pick up where you left off</h2><p id="checkpoint-description">Save completed segments as a checkpoint. Reload it with the same source and gallery to resume.</p><div class="resume-actions"><button id="checkpoint-save" type="button" disabled>Save checkpoint</button><label class="file-button">Load checkpoint<input id="checkpoint-load" type="file" accept=".zip"/></label><button id="checkpoint-clear" class="text-button" type="button" hidden>Discard checkpoint</button></div></div>
    <p class="footnote">Files are processed in this tab and never uploaded. Large galleries and long exports need available memory. Keep this tab open while processing; save a checkpoint before closing it.</p>
  </div></section></main>`;
}
