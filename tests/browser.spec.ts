import { test, expect, type Page, type Download } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

let fixtureDir: string;

type Probe = {
  streams: Array<{
    codec_type: string;
    width?: number;
    height?: number;
    nb_read_frames?: string;
  }>;
  format?: { duration?: string };
};

function probe(path: string) {
  const result = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-count_frames', '-show_streams', '-show_format',
    '-of', 'json', path,
  ], { encoding: 'utf8' })) as Probe;
  const video = result.streams.find((stream) => stream.codec_type === 'video');
  if (!video) throw new Error(`No video stream in ${path}`);
  return {
    width: video.width,
    height: video.height,
    frames: Number(video.nb_read_frames),
    hasAudio: result.streams.some((stream) => stream.codec_type === 'audio'),
    duration: Number(result.format?.duration),
  };
}

function decodedPixels(path: string): Buffer {
  return execFileSync('ffmpeg', [
    '-v', 'error', '-i', path, '-map', '0:v:0',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { maxBuffer: 64 * 1024 * 1024 });
}

function filteredPixels(path: string, filter: string, frames?: number): Buffer {
  return execFileSync('ffmpeg', [
    '-v', 'error', '-i', path, '-map', '0:v:0', '-vf', filter,
    ...(frames ? ['-frames:v', String(frames)] : []),
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { maxBuffer: 64 * 1024 * 1024 });
}

function closestFrame(reference: Buffer, sequence: Buffer, frameBytes: number): number {
  let nearest = -1, lowest = Infinity;
  for (let frame = 0; frame * frameBytes < sequence.length; frame++) {
    let error = 0;
    for (let pixel = 0; pixel < frameBytes; pixel++) {
      error += Math.abs(reference[pixel] - sequence[frame * frameBytes + pixel]);
    }
    if (error < lowest) { lowest = error; nearest = frame; }
  }
  return nearest;
}

function firstAudioPts(path: string): number {
  const result = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_packets',
    '-show_entries', 'packet=pts_time', '-of', 'json', path,
  ], { encoding: 'utf8' })) as { packets?: Array<{ pts_time?: string }> };
  return Number(result.packets?.[0]?.pts_time);
}

async function setSetting(page: Page, name: string, value: string | boolean) {
  const control = page.locator(`#settings-form [name="${name}"]`);
  await expect(control).toHaveCount(1);
  const closedAncestors = control.locator('xpath=ancestor::details[not(@open)]');
  while (await closedAncestors.count()) {
    await closedAncestors.first().locator('summary').first().click();
  }
  if (typeof value === 'boolean') {
    if (value) await control.check();
    else await control.uncheck();
  } else if (await control.evaluate((element) => element.tagName === 'SELECT')) {
    await control.selectOption(value);
  } else {
    await control.fill(value);
  }
}

async function selectFiles(page: Page, source = 'source.webm') {
  await page.locator('#source').setInputFiles(join(fixtureDir, source));
  await page.locator('#gallery').setInputFiles(join(fixtureDir, 'gallery.webm'));
}

async function setSmallRun(page: Page, metric: 'colour' | 'brightness') {
  await setSetting(page, 'grid', '4x3');
  await setSetting(page, 'cell_size', '8');
  await setSetting(page, 'tile_fit', 'crop');
  await setSetting(page, 'metric', metric);
  await setSetting(page, 'contrast', '1');
  await setSetting(page, 'stride', '1');
  await setSetting(page, 'segment', '4');
}

async function estimateAndRun(page: Page) {
  await page.locator('#estimate').click();
  await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#run').click();
  await expect(page.locator('#mosaic-download')).toHaveAttribute('href', /^blob:/, {
    timeout: 180_000,
  });
  await expect(page.locator('#combined-download')).toHaveAttribute('href', /^blob:/);
}

async function saveDownload(page: Page, selector: string, basename: string) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator(selector).click(),
  ]);
  return saveAs(download, basename);
}

async function saveAs(download: Download, basename: string) {
  const extension = extname(download.suggestedFilename()) || '.webm';
  const path = join(fixtureDir, `${basename}${extension}`);
  await download.saveAs(path);
  return path;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'bad-apple-browser-fixtures-'));
  execFileSync('python3', [join(import.meta.dirname, 'generate-fixtures.py'), fixtureDir], {
    stdio: 'pipe',
  });
});

test.afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

test('colour slice estimates, previews, and downloads two correctly timed videos', async ({ page }) => {
  await page.goto('/');
  await selectFiles(page);
  await setSmallRun(page, 'colour');
  await setSetting(page, 'start', '0.5');
  await setSetting(page, 'duration', '1');
  await estimateAndRun(page);

  const mosaic = await saveDownload(page, '#mosaic-download', 'colour-mosaic');
  const combined = await saveDownload(page, '#combined-download', 'colour-combined');
  expect(probe(mosaic)).toMatchObject({ width: 32, height: 24, frames: 16, hasAudio: false });
  expect(probe(combined)).toMatchObject({ width: 64, height: 24, frames: 16, hasAudio: true });
  expect(probe(combined).duration).toBeGreaterThan(0.85);
  expect(probe(combined).duration).toBeLessThan(1.2);
  const sourceFrames = filteredPixels(join(fixtureDir, 'source.webm'), 'scale=32:24:flags=bilinear');
  const firstCombinedSourceFrame = filteredPixels(combined, 'crop=32:24:0:0', 1);
  expect(closestFrame(firstCombinedSourceFrame, sourceFrames, 32 * 24 * 3)).toBe(8);

  await expect.poll(() => page.locator('#result-video').evaluate(
    (element) => (element as HTMLVideoElement).videoWidth,
  )).toBeGreaterThan(0);
  const previewSize = await page.locator('#preview-canvas').evaluate(
    (element) => ({ width: (element as HTMLCanvasElement).width,
                    height: (element as HTMLCanvasElement).height }),
  );
  expect(previewSize.width).toBeGreaterThan(0);
  expect(previewSize.height).toBeGreaterThan(0);
  await page.locator('#source').setInputFiles(join(fixtureDir, 'long-source.webm'));
  await expect(page.locator('#downloads')).toBeHidden();
  await expect(page.locator('#mosaic-download')).not.toHaveAttribute('href');
  await expect(page.locator('#combined-download')).not.toHaveAttribute('href');
});

test('brightness matching produces an encoded mosaic', async ({ page }) => {
  await page.goto('/');
  await selectFiles(page);
  await setSmallRun(page, 'brightness');
  await setSetting(page, 'epsilon', '0.05');
  await setSetting(page, 'duration', '0.5');
  await estimateAndRun(page);

  const mosaic = await saveDownload(page, '#mosaic-download', 'brightness-mosaic');
  expect(probe(mosaic)).toMatchObject({ width: 32, height: 24, frames: 8 });
});

test('native gallery aspect resolves explicit grid before validating output size', async ({ page }) => {
  await page.goto('/');
  await page.locator('#source').setInputFiles(join(fixtureDir, 'source.webm'));
  await page.locator('#gallery').setInputFiles(join(fixtureDir, 'gallery-wide.png'));
  await setSetting(page, 'grid', '3x2');
  await setSetting(page, 'cell_size', '3');
  await setSetting(page, 'duration', '0.25');
  await estimateAndRun(page);
  const mosaic = await saveDownload(page, '#mosaic-download', 'native-grid-mosaic');
  expect(probe(mosaic)).toMatchObject({ width: 18, height: 6, frames: 4 });
});

test('side-by-side output preserves a deliberate source audio delay', async ({ page }) => {
  await page.goto('/');
  await selectFiles(page, 'delayed-audio.webm');
  await setSmallRun(page, 'colour');
  await setSetting(page, 'duration', '1');
  await estimateAndRun(page);
  const combined = await saveDownload(page, '#combined-download', 'delayed-audio-combined');
  expect(firstAudioPts(join(fixtureDir, 'delayed-audio.webm'))).toBeGreaterThan(0.2);
  expect(firstAudioPts(combined)).toBeGreaterThan(0.15);
  expect(firstAudioPts(combined)).toBeLessThan(0.35);
});

test('CIFAR pickle gallery renders opaque image tiles', async ({ page }) => {
  await page.goto('/');
  await page.locator('#source').setInputFiles(join(fixtureDir, 'source.webm'));
  await page.locator('#gallery').setInputFiles(join(import.meta.dirname, 'fixtures', 'cifar-p2.pkl'));
  await setSmallRun(page, 'colour');
  await setSetting(page, 'duration', '0.5');
  await estimateAndRun(page);

  const mosaic = await saveDownload(page, '#mosaic-download', 'cifar-mosaic');
  const pixels = decodedPixels(mosaic);
  expect(pixels.length).toBe(32 * 24 * 3 * 8);
  expect(pixels.some((value) => value > 8)).toBe(true);
});

test('cancelled run resumes from an exported checkpoint with identical decoded frames', async ({ page }) => {
  await page.goto('/');
  await selectFiles(page, 'long-source.webm');
  await setSmallRun(page, 'colour');
  await setSetting(page, 'grid', '12x9');
  await setSetting(page, 'segment', '8');
  await page.locator('#estimate').click();
  await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#run').click();
  await expect(page.locator('#checkpoint-save')).toBeEnabled({ timeout: 120_000 });
  await page.locator('#cancel').click();
  await expect(page.locator('#status')).toContainText(/cancel/i);
  const checkpoint = await saveDownload(page, '#checkpoint-save', 'resume-checkpoint');

  await page.reload();
  await selectFiles(page, 'long-source.webm');
  await setSmallRun(page, 'colour');
  await setSetting(page, 'grid', '12x9');
  await setSetting(page, 'segment', '8');
  await page.locator('#checkpoint-load').setInputFiles(checkpoint);
  await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#gallery').setInputFiles(join(import.meta.dirname, 'fixtures', 'cifar-p2.pkl'));
  await page.locator('#run').click();
  await expect(page.locator('#status')).toContainText(/checkpoint does not match/i);
  await page.locator('#gallery').setInputFiles(join(fixtureDir, 'gallery.webm'));
  await page.locator('#run').click();
  await expect(page.locator('#mosaic-download')).toHaveAttribute('href', /^blob:/, {
    timeout: 180_000,
  });
  const resumed = await saveDownload(page, '#mosaic-download', 'resumed-mosaic');
  expect(probe(resumed).frames).toBe(96);

  await page.reload();
  await selectFiles(page, 'long-source.webm');
  await setSmallRun(page, 'colour');
  await setSetting(page, 'grid', '12x9');
  await setSetting(page, 'segment', '8');
  await estimateAndRun(page);
  const uninterrupted = await saveDownload(page, '#mosaic-download', 'uninterrupted-mosaic');
  expect(probe(uninterrupted).frames).toBe(96);
  expect(decodedPixels(resumed).equals(decodedPixels(uninterrupted))).toBe(true);
});

test('settings export and import restore the edited controls', async ({ page }) => {
  await page.goto('/');
  await setSetting(page, 'grid', '4x3');
  await setSetting(page, 'cell_size', '8');
  await setSetting(page, 'metric', 'brightness');
  await setSetting(page, 'gallery_budget', '32M');
  const saved = await saveDownload(page, '#settings-save', 'settings-round-trip');
  await setSetting(page, 'grid', '6x4');
  await setSetting(page, 'metric', 'colour');
  await page.locator('#settings-load').setInputFiles(saved);
  await expect(page.locator('#status')).toContainText(/settings loaded/i);
  await expect(page.locator('[name="grid"]')).toHaveValue('4x3');
  await expect(page.locator('[name="metric"]')).toHaveValue('brightness');
  await expect(page.locator('[name="gallery_budget"]')).toHaveValue(String(32 * 1024 * 1024));
});

test('malformed settings and unreadable or unsupported source files explain failure', async ({ page }) => {
  await page.goto('/');
  await selectFiles(page);
  await setSetting(page, 'grid', '3x3');
  await setSetting(page, 'cell_size', '7');
  await page.locator('#estimate').click();
  await expect(page.locator('#status')).toContainText(/even|grid|size|invalid/i);

  await page.locator('#source').setInputFiles(join(fixtureDir, 'broken.webm'));
  await setSetting(page, 'grid', '4x3');
  await setSetting(page, 'cell_size', '8');
  await page.locator('#estimate').click();
  await expect(page.locator('#status')).toContainText(/invalid|unsupported|read|decode|format|video/i);

  await page.locator('#source').setInputFiles(join(fixtureDir, 'unsupported.mkv'));
  await page.locator('#estimate').click();
  await expect(page.locator('#status')).toContainText(/unsupported|codec|decode|format/i);
});

test('narrow viewport keeps files, settings, and estimate usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await selectFiles(page);
  await setSmallRun(page, 'colour');
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.locator('#estimate').click();
  await expect(page.locator('#run')).toBeEnabled();
  await expect(page.locator('#preview-canvas')).toBeVisible();
});
