// Run: ./node_modules/.bin/electron scripts/capture-screenshots.cjs
// Uses simulated sources so published screenshots contain no private camera or device data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'screenshots');
  await fs.mkdir(output, { recursive: true });
  const window = new BrowserWindow({
    width: 1440, height: 900, useContentSize: true, show: false,
    backgroundColor: '#0a0a0a',
    webPreferences: { preload: path.join(__dirname, 'screenshot-preload.cjs'), contextIsolation: true }
  });
  try {
    await window.loadFile(path.join(root, 'renderer', 'index.html'));
    await window.webContents.executeJavaScript('new Promise(resolve => { const poll = () => document.querySelectorAll(".source-preview img").length === 2 ? resolve() : setTimeout(poll, 50); poll(); })');
    await window.webContents.executeJavaScript('document.querySelector(".source-card:nth-child(2)").click()');
    await fs.writeFile(path.join(output, 'studio.png'), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript('document.querySelector("[data-view=library]").click()');
    await fs.writeFile(path.join(output, 'library.png'), (await window.webContents.capturePage()).toPNG());
    process.stdout.write(`Saved studio.png and library.png to ${output}\n`);
  } finally {
    window.destroy();
    app.quit();
  }
}).catch(error => { process.stderr.write(`${error.stack || error}\n`); app.exit(1); });
