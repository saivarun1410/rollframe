import { spawnSync } from 'node:child_process';

export function parseDeviceList(output) {
  const result = { video: [], audio: [] };
  let section;
  for (const raw of String(output).split(/\r?\n/)) {
    if (raw.includes('AVFoundation video devices:')) section = 'video';
    else if (raw.includes('AVFoundation audio devices:')) section = 'audio';
    else {
      const entry = raw.match(/\[(\d+)\]\s+([^\]]+)\s*$/);
      if (!entry || !section) continue;
      const index = Number(entry[1]);
      const name = entry[2].trim();
      if (section === 'video') result.video.push({ index, name, kind: /capture screen/i.test(name) ? 'screen' : 'camera' });
      else result.audio.push({ index, name });
    }
  }
  return result;
}

export function enumerateDevices(binary = 'ffmpeg') {
  const listing = spawnSync(binary, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8', timeout: 5000 });
  if (listing.error) throw listing.error;
  return parseDeviceList(`${listing.stderr || ''}\n${listing.stdout || ''}`);
}

export function parseVideoModes(output) {
  return [...String(output).matchAll(/(\d+)x(\d+)@\[([\d.]+)\s+([\d.]+)\]fps/g)].map((match) => ({
    width: Number(match[1]), height: Number(match[2]), minFps: Number(match[3]), maxFps: Number(match[4])
  }));
}

export function probeVideoModes(index, binary = 'ffmpeg') {
  const probe = spawnSync(binary, ['-hide_banner', '-f', 'avfoundation', '-framerate', '1', '-i', String(index)], { encoding: 'utf8', timeout: 4000 });
  return parseVideoModes(`${probe.stderr || ''}\n${probe.stdout || ''}`);
}

export function pickFramerate(modes, requested) {
  if (!modes.length) return requested;
  if (modes.some(({ minFps, maxFps }) => requested >= Math.floor(minFps) && requested <= Math.ceil(maxFps))) return requested;
  return Math.round(Math.max(...modes.map(({ maxFps }) => maxFps)));
}
