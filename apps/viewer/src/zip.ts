export interface ZipEntry {
  name: string;
  contents: string | Uint8Array;
}

const DEFAULT_ARCHIVE_NAME = "opencnc-bulk-conversion";

export function zipFilename(value: string): string {
  const withoutExtension = value.trim().replace(/\.zip$/i, "");
  const safe = withoutExtension
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 120)
    .trim();
  return `${safe || DEFAULT_ARCHIVE_NAME}.zip`;
}

const encoder = new TextEncoder();

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const write16 = (view: DataView, offset: number, value: number): void => view.setUint16(offset, value, true);
const write32 = (view: DataView, offset: number, value: number): void => view.setUint32(offset, value, true);

export function createZip(entries: ZipEntry[]): ArrayBuffer {
  const encoded = entries.map(entry => {
    const name = encoder.encode(entry.name.replace(/\\/g, "/"));
    const contents = typeof entry.contents === "string" ? encoder.encode(entry.contents) : entry.contents;
    return { name, contents, crc: crc32(contents), offset: 0 };
  });
  const localSize = encoded.reduce((total, entry) => total + 30 + entry.name.length + entry.contents.length, 0);
  const centralSize = encoded.reduce((total, entry) => total + 46 + entry.name.length, 0);
  const bytes = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(bytes.buffer);
  let cursor = 0;

  for (const entry of encoded) {
    entry.offset = cursor;
    write32(view, cursor, 0x04034b50);
    write16(view, cursor + 4, 20);
    write16(view, cursor + 6, 0x0800);
    write16(view, cursor + 8, 0);
    write16(view, cursor + 10, 0);
    write16(view, cursor + 12, 0);
    write32(view, cursor + 14, entry.crc);
    write32(view, cursor + 18, entry.contents.length);
    write32(view, cursor + 22, entry.contents.length);
    write16(view, cursor + 26, entry.name.length);
    write16(view, cursor + 28, 0);
    bytes.set(entry.name, cursor + 30);
    bytes.set(entry.contents, cursor + 30 + entry.name.length);
    cursor += 30 + entry.name.length + entry.contents.length;
  }

  const centralOffset = cursor;
  for (const entry of encoded) {
    write32(view, cursor, 0x02014b50);
    write16(view, cursor + 4, 20);
    write16(view, cursor + 6, 20);
    write16(view, cursor + 8, 0x0800);
    write16(view, cursor + 10, 0);
    write16(view, cursor + 12, 0);
    write16(view, cursor + 14, 0);
    write32(view, cursor + 16, entry.crc);
    write32(view, cursor + 20, entry.contents.length);
    write32(view, cursor + 24, entry.contents.length);
    write16(view, cursor + 28, entry.name.length);
    write16(view, cursor + 30, 0);
    write16(view, cursor + 32, 0);
    write16(view, cursor + 34, 0);
    write16(view, cursor + 36, 0);
    write32(view, cursor + 38, 0);
    write32(view, cursor + 42, entry.offset);
    bytes.set(entry.name, cursor + 46);
    cursor += 46 + entry.name.length;
  }

  write32(view, cursor, 0x06054b50);
  write16(view, cursor + 4, 0);
  write16(view, cursor + 6, 0);
  write16(view, cursor + 8, encoded.length);
  write16(view, cursor + 10, encoded.length);
  write32(view, cursor + 12, centralSize);
  write32(view, cursor + 16, centralOffset);
  write16(view, cursor + 20, 0);
  return bytes.buffer as ArrayBuffer;
}
