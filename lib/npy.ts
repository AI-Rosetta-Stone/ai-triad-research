// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Minimal NumPy .npy parser for 2D float32 arrays.
 * Supports format v1 and v2. Returns a flat Float32Array and shape metadata.
 */
export function parseNpy(buffer: Buffer): { shape: [number, number]; data: Float32Array } {
  if (buffer.length < 10 || buffer[0] !== 0x93 || buffer[1] !== 0x4E) {
    throw new Error('Not a valid .npy file');
  }

  const major = buffer[6];
  let headerLen: number;
  let headerStart: number;

  if (major <= 1) {
    headerLen = buffer.readUInt16LE(8);
    headerStart = 10;
  } else {
    headerLen = buffer.readUInt32LE(8);
    headerStart = 12;
  }

  const dataOffset = headerStart + headerLen;
  const header = buffer.subarray(headerStart, dataOffset).toString('ascii');

  const shapeMatch = header.match(/'shape':\s*\((\d+),\s*(\d+)\)/);
  if (!shapeMatch) throw new Error('Cannot parse shape from .npy header: ' + header);

  const rows = parseInt(shapeMatch[1]);
  const cols = parseInt(shapeMatch[2]);

  const descrMatch = header.match(/'descr':\s*'([^']+)'/);
  const descr = descrMatch?.[1] ?? '<f4';
  if (descr !== '<f4') throw new Error(`Unsupported dtype: ${descr} (expected float32 / <f4)`);

  const expected = rows * cols * 4;
  if (buffer.length - dataOffset < expected) {
    throw new Error(`NPY data truncated: expected ${expected} bytes, got ${buffer.length - dataOffset}`);
  }

  const aligned = Buffer.alloc(expected);
  buffer.copy(aligned, 0, dataOffset, dataOffset + expected);
  const data = new Float32Array(aligned.buffer, aligned.byteOffset, rows * cols);

  return { shape: [rows, cols], data };
}

type ParsedNpy = { shape: [number, number]; data: Float32Array };
type NpyIndex = Record<string, { start: number; count: number }>;
type NodeVectors = Record<string, { pov: string; vectors: number[][] }>;

/**
 * Copy one node's rows into plain number[][]. A preallocated index loop is
 * ~5x faster than Array.from(subarray), which goes through the iterator
 * protocol per float (t/4286: ~400ms vs ~70ms at corpus scale).
 */
function copyNodeRows(data: Float32Array, start: number, count: number, cols: number): number[][] {
  const vectors: number[][] = new Array(count);
  for (let i = 0; i < count; i++) {
    const offset = (start + i) * cols;
    const row: number[] = new Array(cols);
    for (let j = 0; j < cols; j++) row[j] = data[offset + j];
    vectors[i] = row;
  }
  return vectors;
}

/**
 * Extract per-node vectors from a parsed NPY file using an index map.
 * Index format: { [nodeId]: { start: number, count: number } }
 *
 * Synchronous — on a server request path prefer extractNodeVectorsAsync,
 * which yields to the event loop (t/4286).
 */
export function extractNodeVectors(parsed: ParsedNpy, index: NpyIndex, pov: string): NodeVectors {
  const [, cols] = parsed.shape;
  const result: NodeVectors = {};

  for (const [nodeId, { start, count }] of Object.entries(index)) {
    result[nodeId] = { pov, vectors: copyNodeRows(parsed.data, start, count, cols) };
  }

  return result;
}

/**
 * Same output as extractNodeVectors, but yields to the event loop (setImmediate)
 * every `yieldEvery` nodes so a cold corpus load does not block the server's
 * event loop (t/4286; same chunk-yield pattern as httpKit's jsonStringifyChunked).
 */
export async function extractNodeVectorsAsync(
  parsed: ParsedNpy,
  index: NpyIndex,
  pov: string,
  yieldEvery = 256,
): Promise<NodeVectors> {
  const yieldToLoop = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
  const [, cols] = parsed.shape;
  const result: NodeVectors = {};
  const step = Math.max(1, Math.floor(yieldEvery));

  let n = 0;
  for (const [nodeId, { start, count }] of Object.entries(index)) {
    result[nodeId] = { pov, vectors: copyNodeRows(parsed.data, start, count, cols) };
    if (++n % step === 0) await yieldToLoop();
  }

  return result;
}
