import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeviceList, pickFramerate } from '../backend/devices.js';
import { planVideoJobs, videoCommand, cameraPreviewCommand } from '../backend/commands.js';

test('discovers displays, cameras and microphones from FFmpeg output', () => {
  const list = parseDeviceList('[AVFoundation indev @ 0x1] AVFoundation video devices:\n[AVFoundation indev @ 0x1] [0] Camera\n[AVFoundation indev @ 0x1] [1] Capture screen 0\n[AVFoundation indev @ 0x1] AVFoundation audio devices:\n[AVFoundation indev @ 0x1] [0] Microphone');
  assert.deepEqual(list.video.map(x => x.kind), ['camera', 'screen']);
  assert.equal(list.audio[0].name, 'Microphone');
});

test('groups screens into a single capture job', () => {
  const jobs = planVideoJobs([{ label: 'screen-1', type: 'screen' }, { label: 'screen-2', type: 'screen' }, { label: 'camera-1', type: 'camera' }]);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0].sources.map(x => x.label), ['screen-1', 'screen-2']);
});

test('maps each screen into its own file', () => {
  const args = videoCommand({ sources: [{ videoIndex: 4, outPath: '/tmp/a.mkv' }, { videoIndex: 5, outPath: '/tmp/b.mkv' }] }, { fps: 30, pixelFormat: 'nv12', captureCursor: true, codec: 'h264_videotoolbox', bitrate: '8M' });
  assert.equal(args.filter(x => x === '-map').length, 2);
  assert.ok(args.includes('0:v'));
  assert.ok(args.includes('1:v'));
  assert.ok(args.includes('/tmp/a.mkv'));
  assert.ok(args.includes('/tmp/b.mkv'));
});

test('camera falls back to a supported frame rate', () => {
  assert.equal(pickFramerate([{ width: 1920, height: 1080, minFps: 60, maxFps: 60 }], 30), 60);
});

import { createJpegParser } from '../backend/jpegStream.js';

test('reassembles camera preview frames split across pipe chunks', () => {
  const frames = [];
  const parse = createJpegParser(frame => frames.push(frame));
  parse(Buffer.from([0, 255, 216, 10]));
  parse(Buffer.from([20, 255]));
  parse(Buffer.from([217, 255, 216, 30, 255, 217]));
  assert.equal(frames.length, 2);
  assert.deepEqual([...frames[0]], [255, 216, 10, 20, 255, 217]);
});

test('camera job streams a 24 fps preview alongside the recording', () => {
  const args = videoCommand({ sources: [{ type: 'camera', videoIndex: 0, outPath: '/tmp/camera.mkv' }] }, { fps: 30, pixelFormat: 'nv12', codec: 'h264_videotoolbox', bitrate: '8M' });
  assert.ok(args.includes('/tmp/camera.mkv'));
  assert.ok(args.includes('pipe:3'));
  assert.ok(args.includes('fps=24,scale=480:-2'));
});

test('camera flip applies to both recording and preview outputs', () => {
  const args = videoCommand({ sources: [{ type: 'camera', videoIndex: 0, outPath: '/tmp/camera.mkv' }] }, { fps: 30, pixelFormat: 'nv12', codec: 'h264_videotoolbox', bitrate: '8M', flipCamera: true });
  assert.equal(args.filter(value => value === 'hflip').length, 1);
  assert.ok(args.includes('hflip,fps=24,scale=480:-2'));
  const idle = cameraPreviewCommand(0, true);
  assert.ok(idle.includes('hflip,fps=24,scale=480:-2'));
});
