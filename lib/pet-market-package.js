const crypto = require('node:crypto');
const path = require('node:path');
const zlib = require('node:zlib');

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD_HEADER = 0x06054b50;
const MANIFEST_NAME = 'pet-market.json';
const ALLOWED_FLAGS = 0x0800;

function fail(message) {
  const error = new Error(message);
  error.code = 'INVALID_PET_MARKET_PACKAGE';
  throw error;
}

function readUInt16(buffer, offset) {
  if (offset + 2 > buffer.length) fail('ZIP 文件不完整');
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset) {
  if (offset + 4 > buffer.length) fail('ZIP 文件不完整');
  return buffer.readUInt32LE(offset);
}

function validateExtraFields(buffer, offset, length) {
  const end = offset + length;
  if (end > buffer.length) fail('ZIP 扩展字段不完整');
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) fail('ZIP 扩展字段无效');
    const id = readUInt16(buffer, cursor);
    const size = readUInt16(buffer, cursor + 2);
    cursor += 4;
    if (cursor + size > end) fail('ZIP 扩展字段无效');
    if (id === 0x0001) fail('不支持 ZIP64');
    cursor += size;
  }
}

function findEocd(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) fail('ZIP 文件无效');
  const start = Math.max(0, buffer.length - 22 - 65535);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (readUInt32(buffer, offset) === EOCD_HEADER) return offset;
  }
  fail('找不到 ZIP 目录');
}

function safeName(rawName) {
  if (!rawName || rawName.includes('\0')) fail('ZIP 文件名无效');
  if (rawName.includes('\\')) fail('ZIP 路径必须使用正斜杠');
  const normalized = rawName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized)) {
    fail('ZIP 不允许绝对路径');
  }
  const isDirectory = normalized.endsWith('/');
  const parts = normalized.split('/').filter((part, index, values) => {
    return !(part === '' && index === values.length - 1 && isDirectory);
  });
  if (parts.length === 0 || parts.some((part) => !part || part === '.' || part === '..')) {
    fail('ZIP 包含不安全路径');
  }
  for (const part of parts) {
    const deviceBase = part.split('.', 1)[0].toUpperCase();
    if (part.startsWith('.') || /[ .]$/.test(part) || /[<>:"|?*\x00-\x1f]/.test(part)
        || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(deviceBase)) {
      fail('ZIP 包含 Windows 不支持的路径');
    }
  }
  const name = parts.join('/');
  if (name.length > 240 || path.posix.normalize(name) !== name) fail('ZIP 文件路径无效');
  return { name, isDirectory };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inflate(buffer, entry) {
  const localOffset = entry.localOffset;
  if (readUInt32(buffer, localOffset) !== LOCAL_HEADER) fail('ZIP 本地头无效');
  const flags = readUInt16(buffer, localOffset + 6);
  const method = readUInt16(buffer, localOffset + 8);
  const checksum = readUInt32(buffer, localOffset + 14);
  const compressedSize = readUInt32(buffer, localOffset + 18);
  const uncompressedSize = readUInt32(buffer, localOffset + 22);
  const nameLength = readUInt16(buffer, localOffset + 26);
  const extraLength = readUInt16(buffer, localOffset + 28);
  const rawName = buffer.subarray(localOffset + 30, localOffset + 30 + nameLength).toString('utf8');
  validateExtraFields(buffer, localOffset + 30 + nameLength, extraLength);
  if (flags !== entry.flags || method !== entry.method || checksum !== entry.checksum
    || compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize
    || rawName !== entry.rawName) {
    fail('ZIP 中央目录与本地头不一致');
  }
  const dataOffset = localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + compressedSize;
  if (dataEnd > buffer.length) fail('ZIP 压缩数据不完整');
  const payload = buffer.subarray(dataOffset, dataEnd);
  let data;
  if (method === 0) data = Buffer.from(payload);
  else if (method === 8) {
    try {
      data = zlib.inflateRawSync(payload, { maxOutputLength: uncompressedSize });
    } catch {
      fail('ZIP 压缩数据无效');
    }
  }
  else fail('ZIP 压缩方式不支持');
  if (data.length !== uncompressedSize || crc32(data) !== checksum) fail('ZIP 文件校验失败');
  return data;
}

function parseStrictZip(buffer, {
  maxFiles = 81,
  maxFileBytes = 8 * 1024 * 1024,
  maxUncompressedBytes = 64 * 1024 * 1024
} = {}) {
  const eocd = findEocd(buffer);
  const diskNumber = readUInt16(buffer, eocd + 4);
  const directoryDisk = readUInt16(buffer, eocd + 6);
  const diskEntries = readUInt16(buffer, eocd + 8);
  const totalEntries = readUInt16(buffer, eocd + 10);
  const directorySize = readUInt32(buffer, eocd + 12);
  const directoryOffset = readUInt32(buffer, eocd + 16);
  const commentLength = readUInt16(buffer, eocd + 20);
  if (diskNumber !== 0 || directoryDisk !== 0 || diskEntries !== totalEntries) fail('不支持分卷 ZIP');
  if (totalEntries === 0 || totalEntries > maxFiles) fail(`ZIP 文件数量必须为 1 至 ${maxFiles}`);
  if (directoryOffset === 0xffffffff || directorySize === 0xffffffff || totalEntries === 0xffff) {
    fail('不支持 ZIP64');
  }
  if (directoryOffset + directorySize !== eocd || eocd + 22 + commentLength !== buffer.length) {
    fail('ZIP 目录结构无效');
  }

  const names = new Set();
  const pathKeys = new Set();
  const files = [];
  let totalUncompressed = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (readUInt32(buffer, cursor) !== CENTRAL_HEADER) fail('ZIP 目录项无效');
    const madeBy = readUInt16(buffer, cursor + 4);
    const flags = readUInt16(buffer, cursor + 8);
    const method = readUInt16(buffer, cursor + 10);
    const checksum = readUInt32(buffer, cursor + 16);
    const compressedSize = readUInt32(buffer, cursor + 20);
    const uncompressedSize = readUInt32(buffer, cursor + 24);
    const nameLength = readUInt16(buffer, cursor + 28);
    const extraLength = readUInt16(buffer, cursor + 30);
    const entryCommentLength = readUInt16(buffer, cursor + 32);
    const diskStart = readUInt16(buffer, cursor + 34);
    const externalAttributes = readUInt32(buffer, cursor + 38);
    const localOffset = readUInt32(buffer, cursor + 42);
    const nameStart = cursor + 46;
    const rawName = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    validateExtraFields(buffer, nameStart + nameLength, extraLength);
    cursor = nameStart + nameLength + extraLength + entryCommentLength;
    if (diskStart !== 0) fail('不支持分卷 ZIP');
    if ((flags & ~ALLOWED_FLAGS) !== 0 || (flags & 1) !== 0 || (flags & 8) !== 0) {
      fail('ZIP 包含不支持的加密或数据描述符');
    }
    if (method !== 0 && method !== 8) fail('ZIP 压缩方式不支持');
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const { name, isDirectory } = safeName(rawName);
    if ((madeBy >>> 8) === 3) {
      const fileType = unixMode & 0xf000;
      if (fileType === 0xa000) fail('ZIP 不允许符号链接');
      if (fileType && fileType !== (isDirectory ? 0x4000 : 0x8000)) {
        fail('ZIP 只允许普通文件和目录');
      }
    }
    const pathKey = name.toLowerCase();
    if (names.has(name) || pathKeys.has(pathKey)) fail('ZIP 包含重复路径');
    names.add(name);
    pathKeys.add(pathKey);
    if (isDirectory) continue;
    if (uncompressedSize <= 0 || uncompressedSize > maxFileBytes) fail('ZIP 单个文件大小无效');
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > maxUncompressedBytes) fail('ZIP 解压后过大');
    const entry = {
      name,
      rawName,
      flags,
      method,
      checksum,
      compressedSize,
      uncompressedSize,
      localOffset
    };
    files.push({ name, data: inflate(buffer, entry) });
  }
  if (cursor !== directoryOffset + directorySize) fail('ZIP 目录长度不一致');
  return files;
}

function validatePetMarketPackage(buffer, expected) {
  const files = parseStrictZip(buffer);
  const manifestFile = files.find((file) => file.name === MANIFEST_NAME);
  if (!manifestFile) fail(`ZIP 根目录必须包含 ${MANIFEST_NAME}`);
  if (manifestFile.data.length > 256 * 1024) fail('桌宠清单不能超过 256 KB');
  let manifest;
  try {
    manifest = JSON.parse(manifestFile.data.toString('utf8'));
  } catch {
    fail('桌宠清单 JSON 无效');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.schemaVersion !== 1
    || manifest.productId !== expected.productId
    || manifest.version !== expected.version
    || manifest.title !== expected.title
    || !Array.isArray(manifest.files)
    || manifest.files.length < 1
    || manifest.files.length > 80) {
    fail('桌宠清单与商品或版本信息不一致');
  }
  const actualFiles = new Map(files.filter((file) => file.name !== MANIFEST_NAME)
    .map((file) => [file.name, file.data]));
  const manifestPaths = new Set();
  const normalizedFiles = manifest.files.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('桌宠清单文件项无效');
    const rawPath = String(item.path || '');
    if (rawPath.includes('\\')) fail('桌宠清单路径必须使用正斜杠');
    const filePath = rawPath;
    const safe = safeName(filePath);
    if (safe.isDirectory || safe.name !== filePath || !/\.gif$/i.test(filePath)
      || manifestPaths.has(filePath)) {
      fail('桌宠清单只允许唯一的相对 GIF 路径');
    }
    manifestPaths.add(filePath);
    const data = actualFiles.get(filePath);
    if (!data || data.length < 10
      || !/^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'))
      || data.readUInt16LE(6) < 1 || data.readUInt16LE(6) > 2048
      || data.readUInt16LE(8) < 1 || data.readUInt16LE(8) > 2048) {
      fail('桌宠清单引用了缺失或无效的 GIF');
    }
    const sizeBytes = Number(item.sizeBytes);
    const sha256 = String(item.sha256 || '').toLowerCase();
    const actualHash = crypto.createHash('sha256').update(data).digest('hex');
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes !== data.length || sha256 !== actualHash) {
      fail('桌宠清单文件大小或 SHA-256 不匹配');
    }
    return { path: filePath, sha256, sizeBytes };
  });
  if (actualFiles.size !== normalizedFiles.length
    || [...actualFiles.keys()].some((filePath) => !manifestPaths.has(filePath))) {
    fail('ZIP 包含清单之外的文件');
  }
  return {
    manifest: { ...manifest, files: normalizedFiles },
    manifestSha256: crypto.createHash('sha256').update(manifestFile.data).digest('hex'),
    packageSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    sizeBytes: buffer.length
  };
}

module.exports = { MANIFEST_NAME, safeName, parseStrictZip, validatePetMarketPackage };
