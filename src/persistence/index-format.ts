import type { ChunkRecord } from "../shared/worker-protocol";

// Versioned binary envelope for a persisted index. Layout (little-endian):
//
//   magic       4  bytes  'D' 'S' 'S' 'I'
//   version     u16       FORMAT_VERSION
//   dims        u16
//   count       u32       number of vectors / chunks
//   checksum    u32       FNV-1a over the three payload sections
//   modelIdLen  u16
//   revLen      u16
//   gzTextLen   u32       byte length of the gzipped chunk JSON
//   modelId     bytes     utf-8, embedding-space stamp (compat check)
//   revision    bytes     utf-8, pinned model revision
//   scales      f32[count]        per-vector quantization scale
//   codes       i8[count*dims]    symmetric int8-quantized components
//   gzText      bytes             gzip(JSON.stringify(chunks))
//
// Vectors are int8-quantized per vector (unit vectors → components in
// [-1,1]); chunk text/metadata is gzipped. The checksum makes a truncated
// or corrupted blob fail loudly on load rather than silently degrade search.

const MAGIC = [0x44, 0x53, 0x53, 0x49]; // "DSSI"
export const FORMAT_VERSION = 1;

export type IndexSnapshot = {
  modelId: string;
  revision: string;
  dims: number;
  /** Row-major [count × dims] unit vectors. */
  vectors: Float32Array;
  /** Aligned to `vectors`, length count. */
  chunks: ChunkRecord[];
};

export class IndexFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexFormatError";
  }
}

function fnv1a(...sections: Uint8Array[]): number {
  let hash = 0x811c9dc5;
  for (const section of sections) {
    for (let i = 0; i < section.length; i++) {
      hash ^= section[i]!;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return (async () => {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  })();
}

async function transform(bytes: Uint8Array, kind: "gzip" | "gunzip"): Promise<Uint8Array> {
  const stream =
    kind === "gzip" ? new CompressionStream("gzip") : new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  // Runtime value is always ArrayBuffer-backed; the cast satisfies TS 5.7+'s
  // BufferSource (which excludes SharedArrayBuffer-backed views).
  void writer.write(bytes as Uint8Array<ArrayBuffer>);
  void writer.close();
  return readAll(stream.readable);
}

/** Quantizes each unit vector to int8 with a per-vector scale. */
function quantize(vectors: Float32Array, count: number, dims: number) {
  const scales = new Float32Array(count);
  const codes = new Int8Array(count * dims);
  for (let r = 0; r < count; r++) {
    const base = r * dims;
    let maxAbs = 0;
    for (let d = 0; d < dims; d++) maxAbs = Math.max(maxAbs, Math.abs(vectors[base + d]!));
    const scale = maxAbs > 0 ? maxAbs : 1;
    scales[r] = scale;
    for (let d = 0; d < dims; d++) {
      const q = Math.round((vectors[base + d]! / scale) * 127);
      codes[base + d] = q < -127 ? -127 : q > 127 ? 127 : q;
    }
  }
  return { scales, codes };
}

/** Dequantizes and re-normalizes to unit length, restoring the invariant the
 *  vector index relies on (cosine == dot product on unit vectors). */
function dequantize(scales: Float32Array, codes: Int8Array, count: number, dims: number) {
  const vectors = new Float32Array(count * dims);
  for (let r = 0; r < count; r++) {
    const base = r * dims;
    const scale = scales[r]!;
    let sumSq = 0;
    for (let d = 0; d < dims; d++) {
      const v = (codes[base + d]! / 127) * scale;
      vectors[base + d] = v;
      sumSq += v * v;
    }
    const norm = Math.sqrt(sumSq) || 1;
    for (let d = 0; d < dims; d++) vectors[base + d]! /= norm;
  }
  return vectors;
}

export async function serializeIndex(snapshot: IndexSnapshot): Promise<ArrayBuffer> {
  const { modelId, revision, dims } = snapshot;
  const count = snapshot.chunks.length;
  if (snapshot.vectors.length !== count * dims) {
    throw new IndexFormatError(`vectors length ${snapshot.vectors.length} != ${count} × ${dims}`);
  }

  const enc = new TextEncoder();
  const modelIdBytes = enc.encode(modelId);
  const revisionBytes = enc.encode(revision);
  const gzText = await transform(enc.encode(JSON.stringify(snapshot.chunks)), "gzip");

  const { scales, codes } = quantize(snapshot.vectors, count, dims);
  const scaleBytes = new Uint8Array(scales.buffer, scales.byteOffset, scales.byteLength);
  const codeBytes = new Uint8Array(codes.buffer, codes.byteOffset, codes.byteLength);
  const checksum = fnv1a(scaleBytes, codeBytes, gzText);

  const HEADER = 24;
  const total =
    HEADER + modelIdBytes.length + revisionBytes.length + scaleBytes.length + codeBytes.length + gzText.length;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  MAGIC.forEach((b, i) => (out[i] = b));
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint16(6, dims, true);
  view.setUint32(8, count, true);
  view.setUint32(12, checksum, true);
  view.setUint16(16, modelIdBytes.length, true);
  view.setUint16(18, revisionBytes.length, true);
  view.setUint32(20, gzText.length, true);

  let offset = HEADER;
  out.set(modelIdBytes, offset);
  offset += modelIdBytes.length;
  out.set(revisionBytes, offset);
  offset += revisionBytes.length;
  out.set(scaleBytes, offset);
  offset += scaleBytes.length;
  out.set(codeBytes, offset);
  offset += codeBytes.length;
  out.set(gzText, offset);

  return buffer;
}

export async function deserializeIndex(buffer: ArrayBuffer): Promise<IndexSnapshot> {
  if (buffer.byteLength < 24) throw new IndexFormatError("blob too small to be an index");
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  if (!MAGIC.every((b, i) => bytes[i] === b)) throw new IndexFormatError("bad magic (not an index)");
  const version = view.getUint16(4, true);
  if (version !== FORMAT_VERSION) {
    throw new IndexFormatError(`unsupported format version ${version} (expected ${FORMAT_VERSION})`);
  }
  const dims = view.getUint16(6, true);
  const count = view.getUint32(8, true);
  const checksum = view.getUint32(12, true);
  const modelIdLen = view.getUint16(16, true);
  const revLen = view.getUint16(18, true);
  const gzTextLen = view.getUint32(20, true);

  let offset = 24;
  const dec = new TextDecoder();
  const modelId = dec.decode(bytes.subarray(offset, offset + modelIdLen));
  offset += modelIdLen;
  const revision = dec.decode(bytes.subarray(offset, offset + revLen));
  offset += revLen;

  const scaleBytes = bytes.subarray(offset, offset + count * 4);
  offset += count * 4;
  const codeBytes = bytes.subarray(offset, offset + count * dims);
  offset += count * dims;
  const gzText = bytes.subarray(offset, offset + gzTextLen);

  if (fnv1a(scaleBytes, codeBytes, gzText) !== checksum) {
    throw new IndexFormatError("checksum mismatch (index is corrupt or truncated)");
  }

  // Copy scales into an aligned buffer (subarray offset may not be 4-aligned).
  const scales = new Float32Array(count);
  new Uint8Array(scales.buffer).set(scaleBytes);
  const codes = new Int8Array(count * dims);
  codes.set(codeBytes);

  const vectors = dequantize(scales, codes, count, dims);
  const chunks = JSON.parse(dec.decode(await transform(gzText, "gunzip"))) as ChunkRecord[];

  return { modelId, revision, dims, vectors, chunks };
}
