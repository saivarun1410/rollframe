const START = Buffer.from([0xff, 0xd8]);
const FINISH = Buffer.from([0xff, 0xd9]);
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export function createJpegParser(onFrame) {
  let bytes = Buffer.alloc(0);
  return chunk => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length) {
      const head = bytes.indexOf(START);
      if (head < 0) {
        bytes = bytes.subarray(Math.max(0, bytes.length - 1));
        return;
      }
      if (head) bytes = bytes.subarray(head);
      const tail = bytes.indexOf(FINISH, START.length);
      if (tail < 0) {
        if (bytes.length > MAX_FRAME_BYTES) bytes = Buffer.alloc(0);
        return;
      }
      onFrame(bytes.subarray(0, tail + FINISH.length));
      bytes = bytes.subarray(tail + FINISH.length);
    }
  };
}
