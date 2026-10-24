import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { audioCommand, meterCommand, mp4Command, parseProgressLines, planVideoJobs, videoCommand } from './commands.js';
import { createJpegParser } from './jpegStream.js';

function fileBytes(file) {
  try { return fs.statSync(file).size; } catch { return null; }
}

function runProcess(binary, args, collect = false) {
  return new Promise(resolve => {
    const child = spawn(binary, args, { stdio: ['ignore', collect ? 'pipe' : 'ignore', 'ignore'] });
    let output = '';
    if (collect) child.stdout.on('data', data => { output += data; });
    child.once('error', () => resolve({ ok: false, output }));
    child.once('close', code => resolve({ ok: code === 0, output }));
  });
}

export class Recorder extends EventEmitter {
  constructor(plan, { ffmpegPath = 'ffmpeg' } = {}) {
    super();
    this.plan = plan;
    this.ffmpegPath = ffmpegPath;
    this.tasks = [];
    this.progress = new Map();
    this.stopping = false;
    this.stopPromise = null;
    this.meter = null;
    this.statsTimer = null;
  }

  start() {
    this.startedAt = new Date().toISOString();
    const { audio, mic, sources, settings } = this.plan;
    if (audio) {
      this.launch('audio', [audio], audioCommand({ index: audio.index, path: audio.outPath, gain: audio.gain }), false);
      if (mic) this.startMeter(mic.index);
    }
    for (const job of planVideoJobs(sources)) {
      const camera = job.sources.length === 1 && job.sources[0].type === 'camera';
      this.launch(job.id, job.sources, videoCommand(job, settings), camera);
    }
    this.statsTimer = setInterval(() => this.reportStats(), 400);
    this.emit('start', { startedAt: this.startedAt });
    return this;
  }

  launch(id, sources, args, camera) {
    const child = spawn(this.ffmpegPath, args, { stdio: camera ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'] });
    const task = { id, sources, child, stderr: '', progressText: '' };
    task.finished = new Promise(resolve => { child.once('close', resolve); });
    child.stdout.on('data', chunk => {
      task.progressText += String(chunk);
      let boundary;
      while ((boundary = task.progressText.indexOf('progress=')) >= 0) {
        const end = task.progressText.indexOf('\n', boundary);
        if (end < 0) break;
        this.progress.set(id, parseProgressLines(task.progressText.slice(0, end)));
        task.progressText = task.progressText.slice(end + 1);
      }
    });
    child.stderr.on('data', chunk => { task.stderr = (task.stderr + chunk).slice(-3000); });
    if (camera) child.stdio[3].on('data', createJpegParser(jpeg => this.emit('preview', { label: sources[0].label, jpeg })));
    child.once('error', error => this.reportError(sources, error));
    child.once('close', (code, signal) => {
      for (const source of sources) this.emit('source-exit', { label: source.label || 'audio', code, signal, stderr: task.stderr });
      if (!this.stopping && code !== 0 && signal == null) this.reportError(sources, new Error(task.stderr.trim() || `FFmpeg exited with ${code}`));
    });
    this.tasks.push(task);
  }

  reportError(sources, error) {
    for (const source of sources) this.emit('source-error', { label: source.label || 'audio', error });
  }

  startMeter(index) {
    const child = spawn(this.ffmpegPath, meterCommand(index), { stdio: ['ignore', 'pipe', 'ignore'] });
    this.meter = child;
    child.on('error', () => {});
    let samples = Buffer.alloc(0);
    child.stdout.on('data', chunk => {
      samples = Buffer.concat([samples, chunk]);
      while (samples.length >= 512) {
        const frame = samples.subarray(0, 512);
        samples = samples.subarray(512);
        let sum = 0;
        let peak = 0;
        for (let offset = 0; offset < frame.length; offset += 2) {
          const amplitude = Math.abs(frame.readInt16LE(offset) / 32768);
          sum += amplitude * amplitude;
          peak = Math.max(peak, amplitude);
        }
        const rms = Math.sqrt(sum / 256);
        const db = rms ? 20 * Math.log10(rms) : -Infinity;
        this.emit('level', { unit: Math.max(0, Math.min(1, (db + 60) / 60)), rms, peak });
      }
    });
  }

  reportStats() {
    for (const source of [...this.plan.sources, ...(this.plan.audio ? [{ ...this.plan.audio, label: 'audio' }] : [])]) {
      const task = this.tasks.find(item => item.sources.includes(source) || (source.label === 'audio' && item.id === 'audio'));
      const progress = this.progress.get(task?.id) || {};
      const stats = { bytes: fileBytes(source.outPath), fps: progress.fps ?? null, drop: progress.drop ?? null, seconds: progress.seconds ?? null };
      this.emit('stats', { label: source.label, stats });
    }
  }

  stop({ graceMs = 4000 } = {}) {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    clearInterval(this.statsTimer);
    this.emit('stopping');
    this.stopPromise = this.finish(graceMs);
    return this.stopPromise;
  }

  async finish(graceMs) {
    await Promise.all(this.tasks.map(async ({ child, finished }) => {
      if (child.exitCode != null || child.signalCode != null) return finished;
      const interrupt = setTimeout(() => { if (child.exitCode == null) child.kill('SIGINT'); }, graceMs);
      const force = setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, graceMs + 1500);
      try { child.stdin.end('q'); } catch { child.kill('SIGINT'); }
      await finished;
      clearTimeout(interrupt);
      clearTimeout(force);
    }));
    this.meter?.kill('SIGKILL');

    const mp4 = new Map();
    if (this.plan.settings.remuxToMp4) {
      for (const source of this.plan.sources) {
        if (!fileBytes(source.outPath)) continue;
        const destination = source.outPath.replace(/\.[^.]+$/, '.mp4');
        if ((await runProcess(this.ffmpegPath, mp4Command(source.outPath, destination))).ok) mp4.set(source.label, destination);
      }
    }

    const duration = new Map();
    for (const source of this.plan.sources) duration.set(source.label, await this.probeDuration(source.outPath));
    if (this.plan.audio) duration.set('audio', await this.probeDuration(this.plan.audio.outPath));
    const maximum = Math.max(0, ...[...duration.values()].filter(value => value != null));
    const offset = label => duration.get(label) == null ? null : Math.round((maximum - duration.get(label)) * 1000);

    let paddedMs = 0;
    if (this.plan.audio && offset('audio') > 20) {
      const file = this.plan.audio.outPath;
      const aligned = path.join(path.dirname(file), 'audio.aligned.wav');
      const delay = offset('audio');
      if ((await runProcess(this.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', file, '-af', `adelay=${delay}:all=1`, '-y', aligned])).ok) {
        fs.renameSync(aligned, file);
        paddedMs = delay;
        duration.set('audio', maximum);
      } else fs.rmSync(aligned, { force: true });
    }

    const results = this.plan.sources.map(source => ({
      label: source.label, kind: 'video', file: source.outPath, mp4: mp4.get(source.label) || null,
      bytes: fileBytes(source.outPath), seconds: duration.get(source.label), drop: 0, startOffsetMs: offset(source.label)
    }));
    if (this.plan.audio) results.push({
      label: 'audio', kind: 'audio', file: this.plan.audio.outPath, mp4: null,
      bytes: fileBytes(this.plan.audio.outPath), seconds: duration.get('audio'), drop: 0,
      startOffsetMs: offset('audio'), paddedMs
    });
    this.endedAt = new Date().toISOString();
    this.emit('done', results);
    return results;
  }

  async probeDuration(file) {
    const binary = this.ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    const probe = await runProcess(binary === this.ffmpegPath ? 'ffprobe' : binary, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], true);
    const seconds = Number(probe.output.trim());
    return probe.ok && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }
}
