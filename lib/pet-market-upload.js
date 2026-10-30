const crypto = require('node:crypto');
const { MANIFEST_NAME, safeName, validatePetMarketPackage } = require('./pet-market-package');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

function fail(message) {
  const error = new Error(message);
  error.code = 'INVALID_PET_MARKET_PACKAGE';
  throw error;
}

function validateGifUploadFiles(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 80) {
    fail('请选择 1 到 80 个 GIF 文件');
  }
  const names = new Set();
  let total = 0;
  const files = value.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)
        || Object.keys(file).some((key) => !['path', 'sizeBytes'].includes(key))
        || typeof file.path !== 'string' || !Number.isSafeInteger(file.sizeBytes)) {
      fail('GIF 文件登记信息无效');
    }
    const safe = safeName(file.path);
    if (safe.isDirectory || safe.name !== file.path || !/\.gif$/i.test(safe.name)) {
      fail('只允许安全的 GIF 相对路径');
    }
    const key = safe.name.toLowerCase();
    if (names.has(key)) fail('GIF 文件包含重复路径');
    names.add(key);
    if (file.sizeBytes < 1 || file.sizeBytes > MAX_FILE_BYTES) fail('每个 GIF 必须大于 0 且不超过 8 MB');
    total += file.sizeBytes;
    if (total > MAX_PACKAGE_BYTES) fail('GIF 文件总量不能超过 64 MB');
    return { path: safe.name, sizeBytes: file.sizeBytes };
  });
  return { files, totalBytes: total };
}

function validateGif(data) {
  if (data.length < 14 || !/^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'))) {
    fail('文件不是完整的 GIF 图片');
  }
  const width = data.readUInt16LE(6);
  const height = data.readUInt16LE(8);
  if (width < 1 || height < 1 || width > 2048 || height > 2048) fail('GIF 宽高必须在 1 到 2048 像素之间');
  let offset = 13;
  let frames = 0;
  function advance(size) {
    offset += size;
    if (offset > data.length) fail('GIF 图片数据不完整');
  }
  function skipBlocks() {
    while (true) {
      if (offset >= data.length) fail('GIF 图片数据不完整');
      const size = data[offset++];
      if (size === 0) return;
      advance(size);
    }
  }
  if (data[10] & 0x80) advance(3 * (2 << (data[10] & 7)));
  while (offset < data.length) {
    const marker = data[offset++];
    if (marker === 0x3b) {
      if (frames < 1 || offset !== data.length) fail('GIF 图片缺少画面或包含尾随数据');
      return;
    }
    if (marker === 0x21) {
      advance(1);
      skipBlocks();
      continue;
    }
    if (marker !== 0x2c || offset + 9 > data.length) fail('GIF 图片结构无效');
    const left = data.readUInt16LE(offset);
    const top = data.readUInt16LE(offset + 2);
    const frameWidth = data.readUInt16LE(offset + 4);
    const frameHeight = data.readUInt16LE(offset + 6);
    const packed = data[offset + 8];
    if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height) {
      fail('GIF 画面超出图片尺寸');
    }
    advance(9);
    if (packed & 0x80) advance(3 * (2 << (packed & 7)));
    if (offset >= data.length || data[offset] < 2 || data[offset] > 8) fail('GIF 图像编码无效');
    offset += 1;
    skipBlocks();
    frames += 1;
  }
  fail('GIF 图片缺少结束标记');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, entry.data);
    directory.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

function createPetMarketPackageFromFiles(buffer, metadata, expected) {
  const { files, totalBytes } = validateGifUploadFiles(metadata);
  if (!Buffer.isBuffer(buffer) || buffer.length !== totalBytes) fail('GIF 上传大小与登记信息不一致');
  let offset = 0;
  const entries = files.map((file) => {
    const data = buffer.subarray(offset, offset + file.sizeBytes);
    offset += file.sizeBytes;
    validateGif(data);
    return { path: file.path, data };
  });
  const manifest = {
    schemaVersion: 1,
    productId: expected.productId,
    version: expected.version,
    title: expected.title,
    files: entries.map((entry) => ({
      path: entry.path, sizeBytes: entry.data.length,
      sha256: crypto.createHash('sha256').update(entry.data).digest('hex')
    }))
  };
  const archive = storedZip([
    { path: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest), 'utf8') }, ...entries
  ]);
  if (archive.length > MAX_PACKAGE_BYTES) fail('组包后的桌宠 ZIP 不能超过 64 MB');
  const packageInfo = validatePetMarketPackage(archive, expected);
  return { archive, packageInfo };
}

module.exports = { validateGifUploadFiles, createPetMarketPackageFromFiles };
