import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Recorder } from '../backend/recorder.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('records a synthetic camera, emits previews, and creates an MP4 copy', { skip: !hasFfmpeg }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rollframe-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = { label: 'camera-1', type: 'camera', inputFormat: 'lavfi', inputSpec: 'testsrc=size=160x120:rate=30', outPath: path.join(directory, 'camera.mkv') };
  const recorder = new Recorder({ sources: [source], mic: null, audio: null, settings: { fps: 30, codec: 'mpeg4', bitrate: '1M', flipCamera: true, remuxToMp4: true } });
  const errors = [];
  let previewCount = 0;
  recorder.on('source-error', ({ error }) => errors.push(error.message));
  recorder.on('preview', () => previewCount++);
  recorder.start();
  await delay(900);
  const [result] = await recorder.stop();
  assert.deepEqual(errors, []);
  assert.ok(previewCount > 0);
  assert.ok(fs.statSync(result.file).size > 1000);
  assert.ok(fs.statSync(result.mp4).size > 1000);
  assert.ok(result.seconds > 0);
});
