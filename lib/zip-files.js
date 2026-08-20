const zlib = require('node:zlib');
const path = require('node:path');

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD_HEADER = 0x06054b50;

function readUInt16(buffer, offset) {
  if (offset + 2 > buffer.length) throw new Error('ZIP 文件不完整');
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset) {
  if (offset + 4 > buffer.length) throw new Error('ZIP 文件不完整');
  return buffer.readUInt32LE(offset);
}

function findEocd(buffer) {
  const minimum = 22;
  if (buffer.length < minimum) throw new Error('ZIP 文件过小');
  const searchStart = Math.max(0, buffer.length - minimum - 65535);
  for (let offset = buffer.length - minimum; offset >= searchStart; offset -= 1) {
    if (readUInt32(buffer, offset) === EOCD_HEADER) return offset;
  }
  throw new Error('找不到 ZIP 目录');
}

function sanitizeEntryName(rawName) {
  const normalized = String(rawName || '').replace(/\\/g, '/');
  if (!normalized || normalized.endsWith('/')) return '';
  const parts = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return '';
    parts.push(part);
  }
  return parts.join('/');
}

function inflateEntry(buffer, localOffset, compressedSize, uncompressedSize, method) {
  if (readUInt32(buffer, localOffset) !== LOCAL_HEADER) {
    throw new Error('ZIP 本地头无效');
  }
  const nameLength = readUInt16(buffer, localOffset + 26);
  const extraLength = readUInt16(buffer, localOffset + 28);
  const dataOffset = localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + compressedSize;
  if (dataEnd > buffer.length) throw new Error('ZIP 压缩数据不完整');
  const payload = buffer.subarray(dataOffset, dataEnd);
  if (method === 0) {
    if (payload.length !== uncompressedSize) throw new Error('ZIP 未压缩大小不匹配');
    return Buffer.from(payload);
  }
  if (method !== 8) throw new Error('ZIP 压缩方式不支持');
  const inflated = zlib.inflateRawSync(payload, { maxOutputLength: uncompressedSize });
  if (inflated.length !== uncompressedSize) throw new Error('ZIP 解压大小不匹配');
  return inflated;
}

function listZipEntries(buffer, {
  maxFiles = 80,
  maxUncompressedBytes = 64 * 1024 * 1024,
  maxFileBytes = 8 * 1024 * 1024
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('ZIP 文件无效');
  const eocd = findEocd(buffer);
  const diskEntries = readUInt16(buffer, eocd + 8);
  const totalEntries = readUInt16(buffer, eocd + 10);
  const directorySize = readUInt32(buffer, eocd + 12);
  const directoryOffset = readUInt32(buffer, eocd + 16);
  if (diskEntries !== totalEntries) throw new Error('不支持分卷 ZIP');
  if (totalEntries > maxFiles) throw new Error(`压缩包最多包含 ${maxFiles} 个文件`);
  if (directoryOffset + directorySize > buffer.length) throw new Error('ZIP 目录不完整');

  const entries = [];
  let cursor = directoryOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (readUInt32(buffer, cursor) !== CENTRAL_HEADER) throw new Error('ZIP 目录项无效');
    const method = readUInt16(buffer, cursor + 10);
    const compressedSize = readUInt32(buffer, cursor + 20);
    const uncompressedSize = readUInt32(buffer, cursor + 24);
    const nameLength = readUInt16(buffer, cursor + 28);
    const extraLength = readUInt16(buffer, cursor + 30);
    const commentLength = readUInt16(buffer, cursor + 32);
    const localOffset = readUInt32(buffer, cursor + 42);
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;

    const name = sanitizeEntryName(rawName);
    if (!name) continue;
    const base = path.posix.basename(name).toLowerCase();
    if (base === '.ds_store' || name.startsWith('__macosx/')) continue;
    if (uncompressedSize <= 0 || uncompressedSize > maxFileBytes) continue;
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > maxUncompressedBytes) throw new Error('压缩包解压后过大');
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localOffset
    });
  }
  return entries;
}

function extractZipFiles(buffer, options) {
  return listZipEntries(buffer, options).map((entry) => ({
    name: entry.name,
    data: inflateEntry(
      buffer,
      entry.localOffset,
      entry.compressedSize,
      entry.uncompressedSize,
      entry.method
    )
  }));
}

module.exports = { extractZipFiles, listZipEntries };
