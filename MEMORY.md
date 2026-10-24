# Rollframe memory note

Date: 2026-10-24

## Current status

Rollframe is a macOS recorder prototype. The user reports that it is **not working as expected**. In particular, the camera views still feel too enlarged, the live video is choppy, and there is a noticeable delay between the user's movements and the preview. Treat these as open defects. Do not describe them as fixed based only on automated tests or frame-rate logs.

## Product direction

- Build a polished macOS recorder with separate tracks and a visual desktop interface.
- Use only black, grey, and white throughout the interface, with black dominant. Keep type and controls consistent.
- Make camera views large enough to be useful while preserving the full image and natural proportions. The user has asked for left/right camera orientation control.
- Prioritize a smooth, low-latency live camera view that matches what is recorded.

## What exists

- Electron interface for selecting screens, cameras, and a microphone; recording controls; and a session library.
- FFmpeg capture with separate files per video source, a separate microphone WAV, MKV output, and optional MP4 copies.
- Camera flip setting for previews and new recordings.
- FFmpeg MJPEG camera previews sent through the Electron main process to the renderer. The latest change limits frames in flight using renderer acknowledgements and drops stale frames. Camera tiles currently use a two-column layout.
- Capture engine modules were independently replaced on 2026-10-24. The camera preview issues below remain unresolved and need real-device validation.

## Verification and limits

- `npm run check` has passed seven automated tests and JavaScript syntax checks in prior development.
- A synthetic recording pipeline produced valid video. A debug preview run showed about 24 delivered and acknowledged frames per second for each of two cameras, without queued drops.
- These checks do **not** establish acceptable motion-to-display latency, smoothness on the user's hardware, satisfactory camera sizing, or full real-camera recording behavior. The user's latest feedback says the experience remains unacceptable.

## If work resumes

1. Measure actual capture-to-display latency, ideally with a visible clock or timestamp in the camera image. Check whether delay originates in camera capture, FFmpeg encoding, IPC transport, image decoding, or rendering.
2. Consider a direct `getUserMedia` preview or another lower-latency transport instead of FFmpeg MJPEG → base64 → IPC → image replacement. Check camera sharing behavior during recording before adopting it.
3. Validate with the user's real camera setup, during both idle preview and recording. Compare the displayed orientation, framing, and motion with the saved file.
4. Revisit camera tile sizing with the user after latency is addressed. Do not infer acceptance from code or screenshots alone.

## Project entry points

- `main.js`: Electron window, device and session orchestration, preview delivery.
- `renderer/app.js` and `renderer/styles.css`: interface and preview rendering.
- `backend/recorder.js` and `backend/commands.js`: recording lifecycle and FFmpeg commands.
- `tests/engine.test.js`: engine tests.

Run locally on macOS with Node.js 20+ and FFmpeg: `npm install`, `npm start`. Run checks with `npm run check`.
