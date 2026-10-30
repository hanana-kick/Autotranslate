// Dependency-free ZIP writer/reader, so `npm run build` can ship a store-ready
// archive on every platform without pulling in a package.
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export type ZipEntry = {
  /** Archive path; forward slashes, no leading slash. */
  name: string;
  data: Uint8Array | string;
  /** Unix permission bits stored in the external attributes. */
  mode?: number;
};

export type ZipListing = {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
};

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 0x031e; // Unix, ZIP 3.0
const UTF8_FLAG = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ -1) >>> 0;
}

const normaliseName = (name: string): string => {
  const clean = name.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!clean || clean.split('/').includes('..')) throw new Error(`unsafe zip entry name: ${name}`);
  return clean;
};

function dosStamp(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

/** Builds a deterministic archive: entries sorted by name, one fixed timestamp. */
export function buildZip(entries: readonly ZipEntry[], when = new Date(1980, 0, 1, 0, 0, 0)): Buffer {
  const { time, date } = dosStamp(when);
  const sorted = [...entries].sort((a, b) => normaliseName(a.name).localeCompare(normaliseName(b.name)));
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const name = Buffer.from(normaliseName(entry.name), 'utf8');
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
    const deflated = deflateRawSync(data, { level: 9 });
    const method = deflated.length < data.length ? METHOD_DEFLATE : METHOD_STORE;
    const payload = method === METHOD_DEFLATE ? deflated : data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, payload);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    directory.writeUInt16LE(VERSION_MADE_BY, 4);
    directory.writeUInt16LE(VERSION_NEEDED, 6);
    directory.writeUInt16LE(UTF8_FLAG, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt16LE(time, 12);
    directory.writeUInt16LE(date, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(payload.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(((entry.mode ?? 0o644) & 0xfff) << 16, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);

    offset += local.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralDirectory, end]);
}

function indexOfSignature(buffer: Buffer, signature: number, from: number): number {
  for (let index = from; index + 4 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(index) === signature) return index;
  }
  return -1;
}

/** Reads the central directory; the archive is small, so the whole file is scanned. */
export function listZip(buffer: Buffer): ZipListing[] {
  let end = buffer.length - 22;
  for (; end >= 0; end -= 1) if (buffer.readUInt32LE(end) === END_SIGNATURE) break;
  if (end < 0 || buffer.readUInt32LE(end) !== END_SIGNATURE) throw new Error('not a zip archive');
  const count = buffer.readUInt16LE(end + 10);
  let pointer = buffer.readUInt32LE(end + 16);
  const listing: ZipListing[] = [];

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(pointer) !== CENTRAL_SIGNATURE) throw new Error('corrupt zip central directory');
    const method = buffer.readUInt16LE(pointer + 10);
    const crc = buffer.readUInt32LE(pointer + 16);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const size = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    listing.push({
      name: buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength),
      method,
      crc,
      compressedSize,
      size
    });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return listing;
}

/** Returns the decompressed bytes of one entry, or undefined when absent. */
export function readZipEntry(buffer: Buffer, wanted: string): Buffer | undefined {
  const name = normaliseName(wanted);
  const target = indexOfSignature(buffer, LOCAL_SIGNATURE, 0);
  let pointer = target;
  while (pointer >= 0) {
    const method = buffer.readUInt16LE(pointer + 8);
    const storedCrc = buffer.readUInt32LE(pointer + 14);
    const compressedSize = buffer.readUInt32LE(pointer + 18);
    const nameLength = buffer.readUInt16LE(pointer + 26);
    const extraLength = buffer.readUInt16LE(pointer + 28);
    const entryName = buffer.toString('utf8', pointer + 30, pointer + 30 + nameLength);
    const start = pointer + 30 + nameLength + extraLength;
    if (entryName === name) {
      const payload = buffer.subarray(start, start + compressedSize);
      let data: Buffer;
      try {
        data = method === METHOD_DEFLATE ? Buffer.from(inflateRawSync(payload)) : Buffer.from(payload);
      } catch (cause) {
        throw new Error(`corrupt zip entry ${name}`, { cause });
      }
      if (crc32(data) !== storedCrc) throw new Error(`crc mismatch for ${name}`);
      return data;
    }
    const next = indexOfSignature(buffer, LOCAL_SIGNATURE, start + compressedSize);
    pointer = next === pointer ? -1 : next;
  }
  return undefined;
}
