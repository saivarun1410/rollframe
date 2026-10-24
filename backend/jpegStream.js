// FFmpeg's mjpeg muxer writes consecutive JPEG images without length prefixes.
// A frame may be split across any number of pipe chunks.
export function createJpegParser(onFrame) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const start = pending.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        pending = pending.subarray(Math.max(0, pending.length - 1));
        return;
      }
      if (start > 0) pending = pending.subarray(start);
      const end = pending.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (end < 0) {
        if (pending.length > 2_000_000) pending = Buffer.alloc(0);
        return;
      }
      onFrame(pending.subarray(0, end + 2));
      pending = pending.subarray(end + 2);
    }
  };
}
