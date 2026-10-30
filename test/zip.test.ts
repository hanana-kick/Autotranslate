import test from 'node:test';
import assert from 'node:assert/strict';
import { buildZip, crc32, listZip, readZipEntry, type ZipEntry } from '../scripts/zip.ts';

const ENTRIES: ZipEntry[] = [
  { name: 'manifest.json', data: '{"manifest_version":3,"name":"autotranslate"}\n' },
  { name: 'lib/dom.js', data: 'console.log("translated");\n'.repeat(400) },
  { name: '_locales/ko/messages.json', data: JSON.stringify({ ext_name: { messages: { message: '자동 번역' } } }) },
  { name: 'empty.txt', data: '' },
  { name: 'icons/icon-16.png', data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }
];

test('every entry survives the round trip unchanged', () => {
  const archive = buildZip(ENTRIES);
  const listing = listZip(archive);

  assert.deepEqual(
    listing.map((entry) => entry.name),
    ['_locales/ko/messages.json', 'empty.txt', 'icons/icon-16.png', 'lib/dom.js', 'manifest.json'],
    'entries are stored sorted by name so the archive is reproducible'
  );
  for (const entry of ENTRIES) {
    const expected = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
    const found = readZipEntry(archive, entry.name);
    assert.ok(found, `${entry.name} is readable`);
    assert.deepEqual([...(found ?? [])], [...expected], `${entry.name} bytes`);
    assert.equal(listing.find((item) => item.name === entry.name)?.crc, crc32(expected), `${entry.name} crc`);
  }
});

test('compressible payloads are deflated and tiny ones stored', () => {
  const archive = buildZip(ENTRIES);
  const byName = new Map(listZip(archive).map((entry) => [entry.name, entry]));

  const text = byName.get('lib/dom.js');
  assert.equal(text?.method, 8, 'deflate');
  assert.ok(text && text.compressedSize < text.size, 'deflate actually shrank the payload');

  const signature = byName.get('icons/icon-16.png');
  assert.equal(signature?.method, 0, 'a payload that would grow is stored');
  assert.equal(signature?.compressedSize, 8);

  const empty = byName.get('empty.txt');
  assert.equal(empty?.method, 0, 'an empty file is stored');
  assert.equal(empty?.size, 0);
  assert.deepEqual([...(readZipEntry(archive, 'empty.txt') ?? Buffer.alloc(1))], []);
});

test('the same input produces the same bytes', () => {
  const when = new Date(2026, 0, 2, 3, 4, 5);
  assert.deepEqual([...buildZip(ENTRIES, when)], [...buildZip([...ENTRIES].reverse(), when)]);
});

function payloadStart(archive: Buffer, wanted: string): number {
  let offset = 0;
  for (;;) {
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const name = archive.toString('utf8', offset + 30, offset + 30 + nameLength);
    if (name === wanted) return offset + 30 + nameLength + extraLength;
    offset += 30 + nameLength + extraLength + compressedSize;
    if (archive.readUInt32LE(offset) !== 0x04034b50) throw new Error(`${wanted} not in archive`);
  }
}

test('a corrupted payload is refused instead of returned', () => {
  const stored = buildZip(ENTRIES);
  const storedAt = payloadStart(stored, 'manifest.json');
  stored[storedAt + 3] = (stored[storedAt + 3] ?? 0) ^ 0xff;
  assert.throws(() => readZipEntry(stored, 'manifest.json'), /crc mismatch/);

  const deflated = buildZip(ENTRIES);
  const deflatedAt = payloadStart(deflated, 'lib/dom.js');
  deflated.fill(0, deflatedAt, deflatedAt + 32);
  assert.throws(() => readZipEntry(deflated, 'lib/dom.js'), /corrupt zip entry/);
});

test('names that would escape the archive are rejected', () => {
  assert.throws(() => buildZip([{ name: '../evil.js', data: 'x' }]), /unsafe zip entry name/);
  assert.throws(() => buildZip([{ name: '', data: 'x' }]), /unsafe zip entry name/);

  const archive = buildZip([{ name: '/icons/icon-16.png/', data: 'x' }]);
  assert.deepEqual(listZip(archive).map((entry) => entry.name), ['icons/icon-16.png']);
});

test('an archive that is not a zip is reported, not misparsed', () => {
  assert.throws(() => listZip(Buffer.from('not a zip archive at all')), /not a zip archive/);
});
