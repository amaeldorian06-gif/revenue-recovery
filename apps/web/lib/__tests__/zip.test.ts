/**
 * Phase 08 — the export ZIP is a FORMAT contract: any unzip tool must open it.
 * The parser below is strict on purpose (signature, CRC32, sizes, offsets,
 * central directory, EOCD) — it is the "unzip strict" the flow could only
 * check leniently. It caught a real bug: a write of the entry offset at byte
 * 16 of the LOCAL header, silently clobbering the CRC field.
 */
import { describe, it, expect } from 'vitest';
import { buildZip } from '../gdpr.ts';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

describe('buildZip — strict structure', () => {
  const files = [
    { name: 'README.txt', content: 'Explication des fichiers.' },
    { name: 'data.json', content: JSON.stringify({ tables: [], big: 'x'.repeat(50_000) }) },
    { name: 'opportunities.csv', content: 'id,client_name\n1,Client Un\n' },
  ];
  const zip = buildZip(files);

  it('each local header: signature, store method, matching CRC and sizes', () => {
    let off = 0;
    for (const f of files) {
      const nameLen = Buffer.from(f.name, 'utf8').length;
      const header = zip.subarray(off, off + 30);
      expect(header.readUInt32LE(0)).toBe(0x04034b50);      // local signature
      expect(header.readUInt16LE(8)).toBe(0);               // store
      const content = zip.subarray(off + 30 + nameLen, off + 30 + nameLen + f.content.length);
      expect(content.toString('utf8')).toBe(f.content);      // payload intact
      expect(header.readUInt32LE(14)).toBe(crc32(content));  // CRC not clobbered
      expect(header.readUInt32LE(18)).toBe(f.content.length); // compressed
      expect(header.readUInt32LE(22)).toBe(f.content.length); // uncompressed
      off += 30 + nameLen + f.content.length;
    }
  });

  it('central directory entries point at the right local headers', () => {
    const eocdOff = zip.length - 22;
    expect(zip.readUInt32LE(eocdOff)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocdOff + 10)).toBe(files.length);
    const cdStart = zip.readUInt32LE(eocdOff + 16);
    const cdSize = zip.readUInt32LE(eocdOff + 12);
    let off = cdStart;
    for (const f of files) {
      expect(zip.readUInt32LE(off)).toBe(0x02014b50);
      expect(zip.readUInt32LE(off + 16)).toBe(crc32(Buffer.from(f.content, 'utf8')));
      const nameLen = zip.readUInt16LE(off + 28);
      const localOff = zip.readUInt32LE(off + 42);
      expect(zip.readUInt32LE(localOff)).toBe(0x04034b50);
      expect(zip.subarray(off + 46, off + 46 + nameLen).toString('utf8')).toBe(f.name);
      off += 46 + nameLen;
    }
    expect(off - cdStart).toBe(cdSize);
  });
});
