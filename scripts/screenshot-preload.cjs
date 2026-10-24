const { contextBridge } = require('electron');

let eventHandler = () => {};
const svg = (label, camera = false) => {
  const artwork = camera
    ? '<circle cx="400" cy="220" r="125" fill="#242424" stroke="#777" stroke-width="2"/><circle cx="400" cy="205" r="52" fill="#a0a0a0"/><path d="M260 365c18-95 262-95 280 0" fill="#8a8a8a"/>'
    : '<rect x="150" y="85" width="500" height="290" rx="5" fill="#343434" stroke="#999" stroke-width="3"/><rect x="172" y="110" width="456" height="230" fill="#555"/><path d="M150 360h500" stroke="#aaa" stroke-width="8"/>';
  const image = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"><rect width="800" height="450" fill="#161616"/><path d="M0 390h800M0 60h800" stroke="#383838"/>${artwork}<text x="400" y="420" text-anchor="middle" fill="#ddd" font-family="Arial" font-size="18" letter-spacing="3">SIMULATED ${label}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(image).toString('base64')}`;
};

const cameraPreview = svg('CAMERA 01', true);
const screenPreview = svg('DISPLAY 01');
const sampleSessions = [
  { title: 'Product walkthrough', dir: '/demo/rollframe/take-001', startedAt: '2026-10-20T10:00:00Z', durationSec: 282, sources: 2 },
  { title: 'Interview setup', dir: '/demo/rollframe/take-002', startedAt: '2026-10-18T10:00:00Z', durationSec: 451, sources: 1 },
  { title: 'Screen tutorial', dir: '/demo/rollframe/take-003', startedAt: '2026-10-16T10:00:00Z', durationSec: 198, sources: 2 }
];
const settings = { outputDir: '/Users/demo/Movies/Rollframe', fps: 30, quality: 'balanced', captureCursor: true, remuxToMp4: true, flipCamera: true };

contextBridge.exposeInMainWorld('rollframe', {
  onEvent: handler => { eventHandler = handler; },
  bootstrap: async () => ({
    ffmpeg: true,
    settings,
    devices: { video: [{ index: 0, kind: 'camera', name: 'Demo Camera' }, { index: 1, kind: 'screen', name: 'Demo Display' }], audio: [{ index: 2, name: 'Demo Microphone' }] },
    recent: sampleSessions
  }),
  saveSettings: async next => ({ ...settings, ...next }),
  stopCameraPreviews: async () => {},
  startCameraPreviews: async indices => { if (indices.includes(0)) setTimeout(() => eventHandler({ type: 'idle-preview', index: 0, dataUrl: cameraPreview, streamKey: 'demo:0' }), 50); },
  ackPreview: () => {},
  preview: async () => screenPreview,
  refreshDevices: async () => ({ video: [{ index: 0, kind: 'camera', name: 'Demo Camera' }, { index: 1, kind: 'screen', name: 'Demo Display' }], audio: [{ index: 2, name: 'Demo Microphone' }] }),
  chooseDirectory: async () => null,
  openPath: async () => {},
  start: async () => { throw new Error('Screenshot demo does not record'); },
  stop: async () => {},
  marker: async () => null
});
