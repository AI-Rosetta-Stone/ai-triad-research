import { describe, it, expect } from 'vitest';
import { parseNpy, extractNodeVectors, extractNodeVectorsAsync } from './npy.js';

function buildNpyBuffer(rows: number, cols: number, values: number[]): Buffer {
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${rows}, ${cols}), }`;
  const padded = header.padEnd(Math.ceil((header.length + 10) / 64) * 64 - 10, ' ') + '\n';
  const headerLen = padded.length;

  const buf = Buffer.alloc(10 + headerLen + rows * cols * 4);
  // Magic
  buf[0] = 0x93;
  buf.write('NUMPY', 1, 'ascii');
  // Version 1.0
  buf[6] = 1;
  buf[7] = 0;
  // Header length (uint16 LE)
  buf.writeUInt16LE(headerLen, 8);
  // Header
  buf.write(padded, 10, 'ascii');
  // Data (float32 LE)
  const dataOffset = 10 + headerLen;
  for (let i = 0; i < values.length; i++) {
    buf.writeFloatLE(values[i], dataOffset + i * 4);
  }
  return buf;
}

describe('parseNpy', () => {
  it('parses a 2x3 float32 array', () => {
    const values = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
    const buf = buildNpyBuffer(2, 3, values);
    const result = parseNpy(buf);

    expect(result.shape).toEqual([2, 3]);
    expect(result.data.length).toBe(6);
    expect(Array.from(result.data)).toEqual(values);
  });

  it('rejects non-npy buffers', () => {
    expect(() => parseNpy(Buffer.from('not a npy file'))).toThrow('Not a valid .npy file');
  });

  it('rejects truncated data', () => {
    const buf = buildNpyBuffer(2, 3, [1, 2, 3, 4, 5, 6]);
    const truncated = buf.subarray(0, buf.length - 8);
    expect(() => parseNpy(truncated)).toThrow('NPY data truncated');
  });
});

describe('extractNodeVectors', () => {
  it('extracts per-node vectors using an index', () => {
    // 4 rows, 2 cols: rows 0-1 for nodeA, rows 2-3 for nodeB
    const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const buf = buildNpyBuffer(4, 2, values);
    const parsed = parseNpy(buf);

    const index = {
      'acc-B-001': { start: 0, count: 2 },
      'acc-B-002': { start: 2, count: 2 },
    };

    const result = extractNodeVectors(parsed, index, 'acc');

    expect(Object.keys(result)).toEqual(['acc-B-001', 'acc-B-002']);
    expect(result['acc-B-001'].pov).toBe('acc');
    expect(result['acc-B-001'].vectors).toHaveLength(2);
    expect(result['acc-B-001'].vectors[0]).toEqual([expect.closeTo(0.1), expect.closeTo(0.2)]);
    expect(result['acc-B-001'].vectors[1]).toEqual([expect.closeTo(0.3), expect.closeTo(0.4)]);
    expect(result['acc-B-002'].vectors[0]).toEqual([expect.closeTo(0.5), expect.closeTo(0.6)]);
    expect(result['acc-B-002'].vectors[1]).toEqual([expect.closeTo(0.7), expect.closeTo(0.8)]);
  });
});

describe('extractNodeVectorsAsync', () => {
  const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const index = {
    'acc-B-001': { start: 0, count: 2 },
    'acc-B-002': { start: 2, count: 1 },
    'acc-B-003': { start: 3, count: 1 },
  };

  it('produces the same output as the sync extractor', async () => {
    const parsed = parseNpy(buildNpyBuffer(4, 2, values));
    const result = await extractNodeVectorsAsync(parsed, index, 'acc', 1);
    expect(result).toEqual(extractNodeVectors(parsed, index, 'acc'));
    expect(Array.isArray(result['acc-B-001'].vectors[0])).toBe(true);
  });

  it('yields to the event loop between node chunks (t/4286)', async () => {
    const parsed = parseNpy(buildNpyBuffer(4, 2, values));
    let ticks = 0;
    let stop = false;
    const spin = (): void => { if (!stop) { ticks++; setImmediate(spin); } };
    setImmediate(spin);
    await extractNodeVectorsAsync(parsed, index, 'acc', 1);
    stop = true;
    expect(ticks).toBeGreaterThanOrEqual(2);
  });
});
