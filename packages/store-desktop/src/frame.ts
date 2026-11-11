// The binary frame crates/cgw-store reads and writes: a u32 LE header length, the JSON header,
// a u32 LE blob count, then each blob as a u32 LE length and its bytes.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(header: unknown, blobs: Uint8Array[] = []): Uint8Array {
  const json = encoder.encode(JSON.stringify(header));
  const size = 8 + json.byteLength + blobs.reduce((n, b) => n + 4 + b.byteLength, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  view.setUint32(at, json.byteLength, true);
  out.set(json, (at += 4));
  at += json.byteLength;
  view.setUint32(at, blobs.length, true);
  at += 4;
  for (const blob of blobs) {
    view.setUint32(at, blob.byteLength, true);
    out.set(blob, (at += 4));
    at += blob.byteLength;
  }
  return out;
}

export function decodeFrame(bytes: Uint8Array): { header: unknown; blobs: Uint8Array[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = (at: number) => {
    if (at + 4 > bytes.byteLength) throw new Error('Frame: truncated');
    return view.getUint32(at, true);
  };
  let at = 0;
  const headerLength = read(at);
  at += 4;
  if (at + headerLength > bytes.byteLength) throw new Error('Frame: header too long');
  const header: unknown = JSON.parse(decoder.decode(bytes.subarray(at, at + headerLength)));
  at += headerLength;
  const count = read(at);
  at += 4;
  const blobs: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const length = read(at);
    at += 4;
    if (at + length > bytes.byteLength) throw new Error('Frame: blob too long');
    blobs.push(bytes.slice(at, at + length));
    at += length;
  }
  return { header, blobs };
}
