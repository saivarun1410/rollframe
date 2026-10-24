const queue = ['-thread_queue_size', '1024'];
const cameraFilter = flip => `${flip ? 'hflip,' : ''}fps=24,scale=480:-2`;

export function planVideoJobs(sources) {
  const screens = sources.filter(source => source.type === 'screen' && (!source.inputFormat || source.inputFormat === 'avfoundation'));
  const others = sources.filter(source => !screens.includes(source));
  return [...(screens.length ? [{ id: 'screens', sources: screens }] : []), ...others.map(source => ({ id: source.label, sources: [source] }))];
}

export function videoCommand(job, options) {
  const command = ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1'];
  for (const source of job.sources) {
    if (source.inputFormat && source.inputFormat !== 'avfoundation') {
      command.push('-re', '-f', source.inputFormat, '-i', source.inputSpec);
      continue;
    }
    command.push('-f', 'avfoundation', ...queue, '-framerate', String(source.fps ?? options.fps));
    if (options.pixelFormat) command.push('-pixel_format', options.pixelFormat);
    if (options.captureCursor) command.push('-capture_cursor', '1');
    command.push('-i', String(source.videoIndex));
  }
  job.sources.forEach((source, input) => {
    command.push('-map', `${input}:v`);
    if (source.type === 'camera' && options.flipCamera) command.push('-vf', 'hflip');
    command.push('-c:v', options.codec, '-b:v', options.bitrate, '-y', source.outPath);
  });
  if (job.sources.length === 1 && job.sources[0].type === 'camera') {
    command.push('-map', '0:v', '-an', '-vf', cameraFilter(options.flipCamera), '-q:v', '14', '-f', 'mjpeg', 'pipe:3');
  }
  return command;
}

export function cameraPreviewCommand(index, flip) {
  return ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-f', 'avfoundation', '-framerate', '30', '-pixel_format', 'nv12', '-i', String(index), '-vf', cameraFilter(flip), '-q:v', '14', '-f', 'mjpeg', 'pipe:1'];
}

export function audioCommand({ index, path, gain = 1 }) {
  const command = ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', ...queue, '-i', `:${index}`];
  if (gain !== 1) command.push('-af', `volume=${gain}`);
  command.push('-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1', '-progress', 'pipe:1', '-y', path);
  return command;
}

export function meterCommand(index) {
  return ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', ...queue, '-i', `:${index}`, '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'];
}

export function mp4Command(input, output) {
  return ['-hide_banner', '-loglevel', 'error', '-i', input, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-y', output];
}

export function parseProgressLines(block) {
  const values = Object.fromEntries(block.split(/\r?\n/).filter(line => line.includes('=')).map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  const number = key => values[key] && Number.isFinite(Number(values[key])) ? Number(values[key]) : null;
  const microseconds = number('out_time_us') ?? number('out_time_ms');
  return { fps: number('fps'), drop: number('drop_frames'), seconds: microseconds == null ? null : microseconds / 1e6 };
}
