const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rollframe', {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  refreshDevices: () => ipcRenderer.invoke('devices'),
  preview: (index) => ipcRenderer.invoke('preview', index),
  startCameraPreviews: (indices) => ipcRenderer.invoke('start-camera-previews', indices),
  stopCameraPreviews: () => ipcRenderer.invoke('stop-camera-previews'),
  ackPreview: (key) => ipcRenderer.send('preview-ack', key),
  chooseDirectory: () => ipcRenderer.invoke('choose-directory'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  start: (options) => ipcRenderer.invoke('start', options),
  stop: () => ipcRenderer.invoke('stop'),
  marker: (label) => ipcRenderer.invoke('marker', label),
  openPath: (path) => ipcRenderer.invoke('open-path', path),
  onEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('recording-event', listener);
    return () => ipcRenderer.removeListener('recording-event', listener);
  }
});
