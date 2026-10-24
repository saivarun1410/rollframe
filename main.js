import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerateDevices, probeVideoModes, pickFramerate } from './backend/devices.js';
import { Recorder } from './backend/recorder.js';
import { createJpegParser } from './backend/jpegStream.js';
import { cameraPreviewCommand } from './backend/commands.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(app.getPath('userData'), 'settings.json');
let window;
let recorder = null;
let active = null;
let devices = { video: [], audio: [] };
let previewBusy = false;
let previewChild = null;
let previewDone = null;
const idleCameraPreviews = new Map();
let cameraPreviewRun = 0;
let stopping = null;
const emit = (type, payload = {}) => window?.webContents.send('recording-event', { type, ...payload });
const frameDelivery = new Map();
function sendLatestFrame(key) {
  const state = frameDelivery.get(key);
  if (!state || state.waiting || !state.latest) return;
  const { type, payload, jpeg } = state.latest;
  state.latest = null;
  state.waiting = true;
  state.sent = (state.sent || 0) + 1;
  emit(type, { ...payload, streamKey: key, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` });
  state.timer = setTimeout(() => {
    state.waiting = false;
    sendLatestFrame(key);
  }, 500);
}
function queueFrame(key, type, payload, jpeg) {
  let state = frameDelivery.get(key);
  if (!state) { state = { waiting: false, latest: null, timer: null }; frameDelivery.set(key, state); if (process.env.ROLLFRAME_DEBUG_PREVIEW) process.stderr.write(`first frame ${key} ${jpeg.length} bytes\n`); }
  state.received = (state.received || 0) + 1;
  if (state.latest) state.dropped = (state.dropped || 0) + 1;
  state.latest = { type, payload, jpeg };
  sendLatestFrame(key);
}
function clearFrameDelivery(prefix) {
  for (const [key, state] of frameDelivery) {
    if (!key.startsWith(prefix)) continue;
    if (state.timer) clearTimeout(state.timer);
    frameDelivery.delete(key);
  }
}
ipcMain.on('preview-ack', (_event, key) => {
  if (typeof key !== 'string') return;
  const state = frameDelivery.get(key);
  if (!state) return;
  if (process.env.ROLLFRAME_DEBUG_PREVIEW && !state.ackLogged) { state.ackLogged = true; process.stderr.write(`first ack ${key}\n`); }
  state.acked = (state.acked || 0) + 1;
  if (state.timer) clearTimeout(state.timer);
  state.waiting = false;
  sendLatestFrame(key);
});
if (process.env.ROLLFRAME_DEBUG_PREVIEW) setInterval(() => {
  for (const [key, state] of frameDelivery) process.stderr.write(`${key} received=${state.received || 0} sent=${state.sent || 0} acked=${state.acked || 0} dropped=${state.dropped || 0}\n`);
}, 3000);

function defaults() {
  return { outputDir: path.join(os.homedir(), 'Movies', 'Rollframe'), fps: 30, quality: 'balanced', captureCursor: true, remuxToMp4: true, flipCamera: true };
}
function readSettings() {
  try { return { ...defaults(), ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }; }
  catch { return defaults(); }
}
function saveSettings(input) {
  const old = readSettings();
  const outputDir = typeof input?.outputDir === 'string' && input.outputDir.trim() ? path.resolve(input.outputDir) : old.outputDir;
  const settings = {
    outputDir,
    fps: [24, 30, 60].includes(Number(input?.fps)) ? Number(input.fps) : old.fps,
    quality: ['compact', 'balanced', 'maximum'].includes(input?.quality) ? input.quality : old.quality,
    captureCursor: input?.captureCursor !== false,
    remuxToMp4: input?.remuxToMp4 !== false,
    flipCamera: input?.flipCamera == null ? old.flipCamera : input.flipCamera !== false
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(settings, null, 2));
  return settings;
}
function ffmpegAvailable() {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 5000 });
  return !r.error && r.status === 0;
}
function listDevices() {
  if (!ffmpegAvailable()) return { video: [], audio: [], error: 'FFmpeg is missing. Install it with brew install ffmpeg, then refresh devices.' };
  try { devices = enumerateDevices(); return devices; }
  catch (error) { return { video: [], audio: [], error: error.message }; }
}
function slug(value) {
  return String(value || 'Untitled recording').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 60) || 'untitled-recording';
}
function sessionFolder(base, title) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let folder = path.join(base, `${stamp}_${slug(title)}`);
  let i = 2;
  while (fs.existsSync(folder)) folder = path.join(base, `${stamp}_${slug(title)}-${i++}`);
  return folder;
}
function recentSessions(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => {
      const folder = path.join(dir, x.name);
      try {
        const data = JSON.parse(fs.readFileSync(path.join(folder, 'session.json'), 'utf8'));
        return { title: data.title, dir: folder, startedAt: data.startedAt, durationSec: data.durationSec, sources: data.sources?.length || 0 };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 12);
  } catch { return []; }
}
function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1060, minHeight: 700,
    backgroundColor: '#0c1119', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(root, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  window.loadFile(path.join(root, 'renderer', 'index.html'));
}
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { stopIdleCameraPreviews(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  stopIdleCameraPreviews();
  if (recorder && !stopping) { event.preventDefault(); stopRecording().finally(() => app.quit()); }
});

async function stopIdleCameraPreviews() {
  cameraPreviewRun++;
  clearFrameDelivery('idle:');
  const waits = [...idleCameraPreviews.values()].map(child => new Promise(resolve => {
    if (child.exitCode != null || child.signalCode != null) return resolve();
    child.once('close', resolve);
    child.kill('SIGKILL');
    setTimeout(resolve, 1500);
  }));
  idleCameraPreviews.clear();
  await Promise.all(waits);
}

ipcMain.handle('stop-camera-previews', () => stopIdleCameraPreviews());
ipcMain.handle('start-camera-previews', async (_event, indices) => {
  await stopIdleCameraPreviews();
  if (recorder || !Array.isArray(indices)) return false;
  const run = cameraPreviewRun;
  for (const index of [...new Set(indices.map(Number))]) {
    const camera = devices.video.find(device => device.index === index && device.kind === 'camera');
    if (!camera) continue;
    const child = spawn('ffmpeg', cameraPreviewCommand(index, readSettings().flipCamera), { stdio: ['ignore', 'pipe', 'pipe'] });
    idleCameraPreviews.set(index, child);
    let frames = 0;
    let stderr = '';
    const timeout = setTimeout(() => { if (frames === 0) child.kill('SIGKILL'); }, 8000);
    child.stdout.on('data', createJpegParser(jpeg => {
      if (run !== cameraPreviewRun) return;
      frames++;
      queueFrame(`idle:${index}`, 'idle-preview', { index }, jpeg);
    }));
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1500); });
    child.on('error', error => { if (run === cameraPreviewRun) emit('idle-preview-error', { index, message: error.message }); });
    child.on('close', () => {
      clearTimeout(timeout);
      if (idleCameraPreviews.get(index) === child) idleCameraPreviews.delete(index);
      if (run === cameraPreviewRun && frames === 0) emit('idle-preview-error', { index, message: stderr.trim() || 'Camera did not produce frames.' });
    });
  }
  return true;
});

ipcMain.handle('bootstrap', () => ({ settings: readSettings(), devices: listDevices(), recent: recentSessions(readSettings().outputDir), ffmpeg: ffmpegAvailable(), platform: process.platform }));
ipcMain.handle('devices', () => listDevices());
ipcMain.handle('save-settings', (_event, input) => saveSettings(input));
ipcMain.handle('choose-directory', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'], defaultPath: readSettings().outputDir });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('open-path', async (_event, target) => {
  if (typeof target !== 'string' || !path.isAbsolute(target) || !fs.existsSync(target)) return false;
  return (await shell.openPath(target)) === '';
});
ipcMain.handle('preview', async (_event, index) => {
  const video = devices.video.find(x => x.index === Number(index));
  if (!video || previewBusy || recorder) return null;
  previewBusy = true;
  try {
    previewDone = new Promise(resolve => {
      const args = ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-framerate', '30', '-pixel_format', 'nv12', '-i', String(index), '-frames:v', '1', '-vf', 'scale=480:-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'];
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
      previewChild = child;
      const chunks = [];
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.stdout.on('data', d => chunks.push(d));
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', code => { clearTimeout(timer); previewChild = null; const bytes = Buffer.concat(chunks); resolve(code === 0 && bytes.length ? `data:image/jpeg;base64,${bytes.toString('base64')}` : null); });
    });
    return await previewDone;
  } finally { previewBusy = false; previewDone = null; }
});

ipcMain.handle('start', async (_event, options) => {
  await stopIdleCameraPreviews();
  if (previewChild) { previewChild.kill('SIGKILL'); if (previewDone) await previewDone; }
  if (recorder || stopping) throw new Error('A recording is already running.');
  if (!ffmpegAvailable()) throw new Error('FFmpeg is required. Install it with brew install ffmpeg.');
  devices = enumerateDevices();
  const selected = [...new Set((options?.sourceIndices || []).map(Number))].map(index => devices.video.find(x => x.index === index)).filter(Boolean);
  if (!selected.length) throw new Error('Select at least one screen or camera.');
  const mic = options?.micIndex == null ? null : devices.audio.find(x => x.index === Number(options.micIndex));
  if (options?.micIndex != null && !mic) throw new Error('The selected microphone is no longer available. Refresh devices.');
  const settings = saveSettings(options.settings || readSettings());
  const title = String(options?.title || 'Untitled recording').trim().slice(0, 120) || 'Untitled recording';
  const dir = sessionFolder(settings.outputDir, title);
  const rawDir = path.join(dir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const count = { screen: 0, camera: 0 };
  const sources = selected.map(device => {
    const type = device.kind === 'screen' ? 'screen' : 'camera';
    const label = `${type}-${++count[type]}`;
    const fps = type === 'camera' ? pickFramerate(probeVideoModes(device.index), settings.fps) : settings.fps;
    return { label, type, deviceName: device.name, videoIndex: device.index, fps, fileName: `${label}.mkv`, outPath: path.join(rawDir, `${label}.mkv`) };
  });
  const plan = {
    title, dir, rawDir, sources, mic,
    audio: mic ? { index: mic.index, fileName: 'audio.wav', outPath: path.join(rawDir, 'audio.wav'), gain: 1 } : null,
    settings: { fps: settings.fps, codec: 'h264_videotoolbox', bitrate: { compact: '4M', balanced: '8M', maximum: '16M' }[settings.quality], pixelFormat: 'nv12', captureCursor: settings.captureCursor, remuxToMp4: settings.remuxToMp4, flipCamera: settings.flipCamera, container: 'mkv' }
  };
  active = { plan, markers: [], errors: [], stats: {}, startedAt: new Date().toISOString() };
  recorder = new Recorder(plan);
  recorder.on('level', level => emit('level', { level: level.unit }));
  recorder.on('preview', ({ label, jpeg }) => queueFrame(`record:${label}`, 'preview', { label }, jpeg));
  recorder.on('stats', ({ label, stats }) => { active.stats[label] = stats; emit('stats', { label, stats }); });
  recorder.on('source-error', ({ label, error }) => { active.errors.push({ label, message: error.message }); emit('error', { label, message: error.message }); });
  recorder.on('source-exit', ({ label, code }) => emit('source-exit', { label, code }));
  recorder.start();
  emit('started', { title, dir, startedAt: active.startedAt, sources, mic });
  return { title, dir, startedAt: active.startedAt, sources, mic };
});

async function stopRecording() {
  if (!recorder || !active) return null;
  if (stopping) return stopping;
  emit('finalizing');
  const currentRecorder = recorder;
  const current = active;
  stopping = (async () => {
    try {
      const results = await currentRecorder.stop();
      const endedAt = new Date().toISOString();
      const durationSec = (Date.parse(endedAt) - Date.parse(current.startedAt)) / 1000;
      const manifest = {
        app: 'Rollframe', version: 1, title: current.plan.title, startedAt: current.startedAt, endedAt, durationSec,
        settings: current.plan.settings, microphone: current.plan.mic?.name || null,
        markers: current.markers, errors: current.errors,
        sources: current.plan.sources.map(s => ({ label: s.label, type: s.type, device: s.deviceName, file: `raw/${s.fileName}`, result: results.find(r => r.label === s.label) || null })),
        audio: current.plan.audio ? { file: 'raw/audio.wav', result: results.find(r => r.label === 'audio') || null } : null
      };
      fs.writeFileSync(path.join(current.plan.dir, 'session.json'), JSON.stringify(manifest, null, 2));
      const notes = [`# ${current.plan.title}`, '', `Recorded ${current.startedAt}`, '', '## Files', '', ...manifest.sources.map(s => `- ${s.label}: ${s.file}${s.result?.mp4 ? ` / raw/${path.basename(s.result.mp4)}` : ''}`), ...(manifest.audio ? ['- Microphone: raw/audio.wav'] : []), '', '## Markers', '', ...current.markers.map(m => `- ${new Date(m.elapsedMs).toISOString().slice(11, 19)} — ${m.label}`), '', 'Timing offsets for each source are stored in session.json.'];
      fs.writeFileSync(path.join(current.plan.dir, 'notes.md'), notes.join('\n'));
      const summary = { dir: current.plan.dir, manifest, results };
      emit('finished', summary);
      return summary;
    } catch (error) { emit('error', { label: 'finalize', message: error.message }); throw error; }
    finally { clearFrameDelivery('record:'); recorder = null; active = null; stopping = null; }
  })();
  return stopping;
}
ipcMain.handle('stop', () => stopRecording());
ipcMain.handle('marker', (_event, label) => {
  if (!active) return null;
  const marker = { label: String(label || 'Marker').trim().slice(0, 80) || 'Marker', elapsedMs: Date.now() - Date.parse(active.startedAt) };
  active.markers.push(marker);
  emit('marker', marker);
  return marker;
});
