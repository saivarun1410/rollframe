const $ = id => document.getElementById(id);
const api = window.rollframe;
const state = { devices: { video: [], audio: [] }, selected: new Set(), settings: null, recent: [], recording: null, finalizing: false, stats: {}, markers: 0, clockTimer: null, previewGeneration: 0 };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const duration = seconds => { const s = Math.max(0, Math.floor(seconds)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const size = bytes => bytes < 1000000 ? `${Math.round(bytes / 1000)} KB` : `${(bytes / 1000000).toFixed(1)} MB`;
const pendingPreviews = new Map();
let previewFrameRequest = 0;
let toastTimer;
function toast(message, error = false) { const el = $('toast'); el.textContent = message; el.classList.toggle('error', error); el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 4500); }
function selectView(view) { $('studioView').hidden = view !== 'studio'; $('libraryView').hidden = view !== 'library'; $('breadcrumbCurrent').textContent = view === 'studio' ? 'STUDIO' : 'LIBRARY'; document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view)); document.querySelector('.main-area').scrollTop = 0; if (view === 'library') { stopIdlePreviews(); renderLibrary(); } else if (!state.recording) loadPreviews(); }
function settingsFromUI() { return { outputDir: state.settings.outputDir, fps: Number($('fpsSelect').value), quality: $('qualitySelect').value, captureCursor: $('cursorToggle').checked, remuxToMp4: $('mp4Toggle').checked, flipCamera: $('flipToggle').checked }; }
async function saveSettings() { state.settings = await api.saveSettings(settingsFromUI()); }
function applySettings(settings) { state.settings = settings; $('fpsSelect').value = settings.fps; $('qualitySelect').value = settings.quality; $('cursorToggle').checked = settings.captureCursor; $('mp4Toggle').checked = settings.remuxToMp4; $('flipToggle').checked = settings.flipCamera !== false; $('folderText').textContent = settings.outputDir.replace(/^\/Users\/[^/]+/, '~'); $('folderButton').title = settings.outputDir; }
function renderDevices() {
  stopIdlePreviews();
  const grid = $('sourceGrid');
  if (!state.devices.video.length) grid.innerHTML = `<div class="empty-devices"><strong>No video sources found</strong>${esc(state.devices.error || 'Connect a camera or enable Screen Recording permission, then rescan devices.')}</div>`;
  else grid.innerHTML = state.devices.video.map(d => `<article class="source-card ${state.selected.has(d.index) ? 'selected' : ''}" data-index="${d.index}" tabindex="0" role="checkbox" aria-checked="${state.selected.has(d.index)}"><div class="source-preview ${d.kind === 'camera' ? 'camera' : ''}" id="preview-${d.index}"><span class="preview-fallback">NO PREVIEW</span><span class="source-kind">${d.kind === 'screen' ? 'SCREEN' : 'CAMERA'}</span><span class="source-check">${state.selected.has(d.index) ? 'SELECTED' : 'SELECT'}</span></div><div class="source-meta"><div><strong title="${esc(d.name)}">${esc(d.name)}</strong><span>${d.kind === 'screen' ? 'Display capture' : 'Camera input'} · Source ${d.index}</span></div></div></article>`).join('');
  grid.querySelectorAll('.source-card').forEach(card => { const toggle = () => { const index = Number(card.dataset.index); if (state.selected.has(index)) state.selected.delete(index); else state.selected.add(index); card.classList.toggle('selected', state.selected.has(index)); card.setAttribute('aria-checked', String(state.selected.has(index))); card.querySelector('.source-check').textContent = state.selected.has(index) ? 'SELECTED' : 'SELECT'; updateRecordUI(); if (!state.recording && state.devices.video.find(device => device.index === index)?.kind === 'camera') { stopIdlePreviews(); loadPreviews(); } }; card.addEventListener('click', toggle); card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }); });
  const previous = $('micSelect').value;
  $('micSelect').innerHTML = '<option value="">No microphone</option>' + state.devices.audio.map(d => `<option value="${d.index}">${esc(d.name)}</option>`).join('');
  if (state.devices.audio.some(d => String(d.index) === previous)) $('micSelect').value = previous;
  else if (state.devices.audio.length) $('micSelect').value = String(state.devices.audio[0].index);
  $('micSubtext').textContent = state.devices.audio.length ? 'Lossless WAV · 48 kHz' : 'No input detected';
  updateRecordUI(); if (!$('studioView').hidden) loadPreviews();
}
function stopIdlePreviews() {
  state.previewGeneration++;
  pendingPreviews.clear();
  if (previewFrameRequest) cancelAnimationFrame(previewFrameRequest);
  previewFrameRequest = 0;
  document.querySelectorAll('.source-preview.camera').forEach(target => {
    target.querySelector('img')?.remove();
    target.querySelector('.source-kind').textContent = 'CAMERA';
    target.querySelector('.preview-fallback').textContent = 'NO PREVIEW';
  });
  return api.stopCameraPreviews();
}
function placePreview(target, media, live = false) {
  target.querySelectorAll('video,img').forEach(element => element.remove());
  target.prepend(media);
  if (live) target.querySelector('.source-kind').textContent = 'CAMERA / LIVE';
}
function queuePreview(index, dataUrl, alt, streamKey) {
  const previous = pendingPreviews.get(index);
  if (previous) api.ackPreview(previous.streamKey);
  pendingPreviews.set(index, { dataUrl, alt, streamKey });
  if (previewFrameRequest) return;
  previewFrameRequest = requestAnimationFrame(() => {
    previewFrameRequest = 0;
    for (const [sourceIndex, frame] of pendingPreviews) {
      const target = $(`preview-${sourceIndex}`);
      if (!target) { api.ackPreview(frame.streamKey); continue; }
      let image = target.querySelector('img');
      if (!image) { image = document.createElement('img'); image.alt = frame.alt; placePreview(target, image, true); }
      image.onload = () => api.ackPreview(frame.streamKey);
      image.onerror = () => api.ackPreview(frame.streamKey);
      image.src = frame.dataUrl;
    }
    pendingPreviews.clear();
  });
}
async function loadPreviews() {
  if (state.recording || $('studioView').hidden) return;
  const generation = ++state.previewGeneration;
  const cameras = state.devices.video.filter(device => device.kind === 'camera').sort((a, b) => Number(state.selected.has(b.index)) - Number(state.selected.has(a.index)));
  cameras.forEach(camera => { const fallback = $(`preview-${camera.index}`)?.querySelector('.preview-fallback'); if (fallback) fallback.textContent = 'STARTING PREVIEW'; });
  const cameraTask = api.startCameraPreviews(cameras.map(camera => camera.index)).catch(() => {});
  for (const screen of state.devices.video.filter(device => device.kind === 'screen')) {
    if (generation !== state.previewGeneration || state.recording) return;
    const preview = await api.preview(screen.index);
    const target = $(`preview-${screen.index}`);
    if (generation !== state.previewGeneration) return;
    if (target && preview) { const img = document.createElement('img'); img.src = preview; img.alt = `${screen.name} preview`; placePreview(target, img); }
  }
  await cameraTask;
}
function updateRecordUI() {
  const active = !!state.recording;
  $('statusDot').classList.toggle('recording', active);
  $('statusTitle').textContent = state.finalizing ? 'FINALIZING' : active ? 'ROLLING' : 'STANDBY';
  $('statusDetail').textContent = state.finalizing ? 'Creating MP4 copies and session notes…' : active ? 'Capturing every angle to a separate track.' : state.selected.size ? `${state.selected.size} source${state.selected.size === 1 ? '' : 's'} armed for this take.` : 'Choose at least one source to begin.';
  $('recordButton').disabled = state.finalizing || (!active && !state.selected.size);
  $('recordButton').classList.toggle('is-recording', active);
  $('recordButtonText').textContent = state.finalizing ? 'FINALIZING' : active ? 'STOP RECORDING' : 'START RECORDING';
  $('markerButton').hidden = !active; $('recordingStats').hidden = !active;
  $('trackCount').textContent = state.recording ? state.recording.sources.length + (state.recording.mic ? 1 : 0) : 0;
  $('markerCount').textContent = state.markers;
  $('dataCount').textContent = size(Object.values(state.stats).reduce((sum, s) => sum + (s.bytes || 0), 0));
  document.querySelectorAll('.source-card').forEach(x => x.style.pointerEvents = active ? 'none' : '');
  $('micSelect').disabled = active; $('rescanButton').disabled = active; $('refreshButton').disabled = active;
}
async function refreshDevices() { if (state.recording) return; $('sourceGrid').innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div>'; const result = await api.refreshDevices(); state.devices = result; state.selected = new Set([...state.selected].filter(i => result.video.some(d => d.index === i))); renderDevices(); toast(result.video.length ? `${result.video.length} video sources found` : result.error || 'No video sources found', !result.video.length); }
async function startRecording() {
  try { await saveSettings(); await stopIdlePreviews(); const result = await api.start({ title: $('titleInput').value, sourceIndices: [...state.selected], micIndex: $('micSelect').value === '' ? null : Number($('micSelect').value), settings: state.settings }); state.recording = result; state.stats = {}; state.markers = 0; selectView('studio'); updateRecordUI(); state.clockTimer = setInterval(() => $('recordClock').textContent = duration((Date.now() - Date.parse(result.startedAt)) / 1000), 250); toast(`Recording started · ${result.sources.length} video track${result.sources.length === 1 ? '' : 's'}`); }
  catch (error) { toast(error.message || String(error), true); loadPreviews(); }
}
async function stopRecording() {
  if (!state.recording || state.finalizing) return; state.finalizing = true; updateRecordUI();
  try { const result = await api.stop(); state.recent.unshift({ title: result.manifest.title, dir: result.dir, startedAt: result.manifest.startedAt, durationSec: result.manifest.durationSec, sources: result.manifest.sources.length }); state.recent = state.recent.slice(0, 12); $('libraryCount').textContent = state.recent.length; toast(`Saved session to ${result.dir}`); selectView('library'); }
  catch (error) { toast(error.message || String(error), true); }
  finally { clearInterval(state.clockTimer); state.recording = null; state.finalizing = false; updateRecordUI(); }
}
function renderLibrary() {
  $('libraryCount').textContent = state.recent.length; $('librarySummary').textContent = `${state.recent.length} recent session${state.recent.length === 1 ? '' : 's'}`;
  $('libraryList').innerHTML = state.recent.length ? state.recent.map((s, i) => `<div class="session-row"><div class="session-icon">TAKE</div><div class="session-details"><strong>${esc(s.title)}</strong><span>${new Date(s.startedAt).toLocaleString()} &nbsp;·&nbsp; ${duration(s.durationSec || 0)} &nbsp;·&nbsp; ${s.sources} video track${s.sources === 1 ? '' : 's'}</span></div><button data-open-session="${i}">OPEN FOLDER</button></div>`).join('') : '<div class="empty-library"><div class="empty-library-copy"><span>THE STORY STARTS HERE / 001</span><strong>NO TAKES<br>YET.</strong><p>Set up your angles and roll the first session.</p><button id="emptyStudioButton">OPEN STUDIO</button></div></div>';
  $('libraryList').querySelectorAll('[data-open-session]').forEach(button => button.addEventListener('click', () => api.openPath(state.recent[Number(button.dataset.openSession)].dir)));
  $('emptyStudioButton')?.addEventListener('click', () => selectView('studio'));
}
async function addMarker() { if (!state.recording) return; const marker = await api.marker(`Moment ${state.markers + 1}`); if (marker) { state.markers++; updateRecordUI(); toast(`Marker added at ${duration(marker.elapsedMs / 1000)}`); } }
api.onEvent(event => {
  if (event.type === 'idle-preview' && !state.recording && !$('studioView').hidden) {
    queuePreview(event.index, event.dataUrl, 'Live camera preview', event.streamKey);
  }
  if (event.type === 'idle-preview-error' && !state.recording) {
    const target = $(`preview-${event.index}`);
    if (target) { target.querySelector('img')?.remove(); target.querySelector('.source-kind').textContent = 'CAMERA'; target.querySelector('.preview-fallback').textContent = 'CAMERA UNAVAILABLE'; target.title = event.message; }
  }
  if (event.type === 'preview' && state.recording) {
    const source = state.recording.sources.find(item => item.label === event.label);
    if (source) queuePreview(source.videoIndex, event.dataUrl, `${source.deviceName} live preview`, event.streamKey);
  }
  if (event.type === 'level') { const bars = $('meter').children; const count = Math.round((event.level || 0) * bars.length); Array.from(bars).forEach((bar, i) => { bar.classList.toggle('on', i < count); bar.style.height = `${5 + Math.max(0, count - Math.abs(i - count)) * 1.1}px`; }); }
  if (event.type === 'stats') { state.stats[event.label] = event.stats; updateRecordUI(); }
  if (event.type === 'error') toast(`${event.label}: ${event.message}`, true);
  if (event.type === 'finalizing') { state.finalizing = true; updateRecordUI(); }
});
async function init() {
  $('meter').innerHTML = Array.from({ length: 16 }, () => '<i></i>').join('');
  $('todayDate').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
  const boot = await api.bootstrap(); applySettings(boot.settings); state.devices = boot.devices; state.recent = boot.recent; renderDevices(); renderLibrary();
  requestAnimationFrame(() => { document.querySelector('.main-area').scrollTop = 0; });
  if (!boot.ffmpeg) toast('FFmpeg is missing. Install it with brew install ffmpeg.', true);
  document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => selectView(button.dataset.view)));
  $('refreshButton').addEventListener('click', refreshDevices); $('rescanButton').addEventListener('click', refreshDevices);
  $('folderButton').addEventListener('click', async () => { const folder = await api.chooseDirectory(); if (folder) { state.settings.outputDir = folder; applySettings(await api.saveSettings(settingsFromUI())); state.recent = (await api.bootstrap()).recent; renderLibrary(); } });
  for (const id of ['fpsSelect', 'qualitySelect', 'cursorToggle', 'mp4Toggle']) $(id).addEventListener('change', saveSettings);
  $('flipToggle').addEventListener('change', async () => { await saveSettings(); await stopIdlePreviews(); loadPreviews(); });
  $('recordButton').addEventListener('click', () => state.recording ? stopRecording() : startRecording()); $('markerButton').addEventListener('click', addMarker);
  $('openLibraryFolder').addEventListener('click', () => api.openPath(state.settings.outputDir));
  document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') { event.preventDefault(); state.recording ? stopRecording() : startRecording(); } if (!event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'm' && document.activeElement?.tagName !== 'INPUT') addMarker(); if ((event.metaKey || event.ctrlKey) && event.key === '1') { event.preventDefault(); selectView('studio'); } });
}
init().catch(error => toast(error.message || String(error), true));
