// Minimal ZIP reader/writer for 3MF packages. Unchanged entries are copied with their original
// compressed bytes; changed ones are deflated with the browser's CompressionStream.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Update(crc, bytes) {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

export const crc32 = (bytes) => (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const MAX32 = 0xffffffff;

export class ZipError extends Error {}

export function readZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("O arquivo não é um ZIP/3MF válido.");

  let count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === MAX32 || count === 0xffff) {
    const locator = eocd - 20;
    if (locator < 0 || view.getUint32(locator, true) !== SIG_ZIP64_LOCATOR) throw new ZipError("ZIP64 sem localizador.");
    const record = Number(view.getBigUint64(locator + 8, true));
    if (view.getUint32(record, true) !== SIG_ZIP64_EOCD) throw new ZipError("ZIP64 corrompido.");
    count = Number(view.getBigUint64(record + 32, true));
    offset = Number(view.getBigUint64(record + 48, true));
  }

  const decoder = new TextDecoder();
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== SIG_CENTRAL) throw new ZipError("Diretório do ZIP corrompido.");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const time = view.getUint16(offset + 12, true);
    const date = view.getUint16(offset + 14, true);
    const crc = view.getUint32(offset + 16, true);
    let compressedSize = view.getUint32(offset + 20, true);
    let size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    let localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    // ZIP64 extended information: only the fields saturated in the header are present, in this order.
    let extra = offset + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = view.getUint16(extra, true);
      const length = view.getUint16(extra + 2, true);
      if (id === 0x0001) {
        let p = extra + 4;
        if (size === MAX32) { size = Number(view.getBigUint64(p, true)); p += 8; }
        if (compressedSize === MAX32) { compressedSize = Number(view.getBigUint64(p, true)); p += 8; }
        if (localOffset === MAX32) { localOffset = Number(view.getBigUint64(p, true)); }
      }
      extra += 4 + length;
    }

    if (view.getUint32(localOffset, true) !== SIG_LOCAL) throw new ZipError(`Cabeçalho inválido em "${name}".`);
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    entries.push({
      name, flags, method, time, date, crc, compressedSize, size, externalAttributes,
      raw: bytes.subarray(dataStart, dataStart + compressedSize),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function rawStream(entry) {
  const stream = new Blob([entry.raw]).stream();
  if (entry.method === 0) return stream;
  if (entry.method === 8) return stream.pipeThrough(new DecompressionStream("deflate-raw"));
  throw new ZipError(`Compressão não suportada em "${entry.name}".`);
}

export async function readBytes(entry) {
  if (entry.method === 0) return entry.raw;
  return new Uint8Array(await new Response(rawStream(entry)).arrayBuffer());
}

export async function readText(entry) {
  return new TextDecoder().decode(await readBytes(entry));
}

// Streams an entry as text chunks cut after the last '>' so no XML tag is split between chunks.
export async function forEachTagChunk(entry, onChunk) {
  const reader = rawStream(entry).pipeThrough(new TextDecoderStream()).getReader();
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = rest + value;
    const cut = text.lastIndexOf(">");
    if (cut < 0) {
      rest = text;
      continue;
    }
    onChunk(text.slice(0, cut + 1));
    rest = text.slice(cut + 1);
  }
  if (rest) onChunk(rest);
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Builds a replacement entry from text or bytes.
export async function makeEntry(content) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return { method: 8, crc: crc32(bytes), size: bytes.length, raw: await deflate(bytes) };
}

// Rewrites an entry's text chunk by chunk (see forEachTagChunk) without holding it whole in memory.
export async function transformEntry(entry, transformChunk) {
  const encoder = new TextEncoder();
  let crc = 0xffffffff;
  let size = 0;
  let rest = "";
  const emit = (text, controller) => {
    const bytes = encoder.encode(transformChunk(text));
    crc = crc32Update(crc, bytes);
    size += bytes.length;
    controller.enqueue(bytes);
  };
  const transformer = new TransformStream({
    transform(chunk, controller) {
      const text = rest + chunk;
      const cut = text.lastIndexOf(">");
      if (cut < 0) {
        rest = text;
        return;
      }
      rest = text.slice(cut + 1);
      emit(text.slice(0, cut + 1), controller);
    },
    flush(controller) {
      if (rest) emit(rest, controller);
    },
  });
  const compressed = rawStream(entry)
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(transformer)
    .pipeThrough(new CompressionStream("deflate-raw"));
  const raw = new Uint8Array(await new Response(compressed).arrayBuffer());
  return { method: 8, crc: (crc ^ 0xffffffff) >>> 0, size, raw };
}

// entries: original entries in order; replacements: name -> entry from makeEntry/transformEntry;
// removed: Set of names to drop. Returns a Blob.
export function writeZip(entries, replacements = {}, removed = new Set()) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    if (removed.has(entry.name)) continue;
    const data = replacements[entry.name] || entry;
    const name = encoder.encode(entry.name);
    const compressedSize = data.raw.length;
    if (compressedSize >= MAX32 || data.size >= MAX32 || offset >= MAX32) throw new ZipError("Arquivo grande demais (acima de 4 GB).");
    // Sizes are known up front, so the data-descriptor flag (bit 3) is cleared.
    const flags = (entry.flags & ~0x8) | 0x800;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, data.method, true);
    local.setUint16(10, entry.time, true);
    local.setUint16(12, entry.date, true);
    local.setUint32(14, data.crc, true);
    local.setUint32(18, compressedSize, true);
    local.setUint32(22, data.size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data.raw);

    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, SIG_CENTRAL, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, flags, true);
    header.setUint16(10, data.method, true);
    header.setUint16(12, entry.time, true);
    header.setUint16(14, entry.date, true);
    header.setUint32(16, data.crc, true);
    header.setUint32(20, compressedSize, true);
    header.setUint32(24, data.size, true);
    header.setUint16(28, name.length, true);
    header.setUint32(38, entry.externalAttributes || 0, true);
    header.setUint32(42, offset, true);
    central.push(new Uint8Array(header.buffer), name);

    offset += 30 + name.length + compressedSize;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const count = central.length / 2;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, SIG_EOCD, true);
  end.setUint16(8, count, true);
  end.setUint16(10, count, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "model/3mf" });
}
