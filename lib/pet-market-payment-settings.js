const zlib = require('node:zlib');

const DEFAULT_PET_MARKET_PAYMENT_SETTINGS = Object.freeze({
  enabled: false, method: 'personal_transfer', recipientName: '', recipientAccount: '',
  qrCodeDataUrl: '', instructions: ''
});
const MAX_QR_BYTES = 256 * 1024;

function fail(message) {
  const error = new Error(message);
  error.code = 'INVALID_PET_MARKET_PAYMENT_SETTINGS';
  throw error;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(bytes) {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) fail('收款码 PNG 无效');
  let offset = 8;
  let header;
  let ended = false;
  const data = [];
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > bytes.length) fail('收款码 PNG 数据不完整');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)
        || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail('收款码 PNG 校验失败');
    if (!header && type !== 'IHDR') fail('收款码 PNG 缺少图片信息');
    if (type === 'IHDR') {
      if (header || size !== 13) fail('收款码 PNG 图片信息无效');
      header = bytes.subarray(offset + 8, end - 4);
    }
    if (type === 'IDAT') data.push(bytes.subarray(offset + 8, end - 4));
    offset = end;
    if (type === 'IEND') {
      if (size !== 0 || offset !== bytes.length) fail('收款码 PNG 结束标记无效');
      ended = true;
      break;
    }
  }
  if (!ended || !header || !data.length) fail('收款码 PNG 数据不完整');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const depth = header[8];
  const color = header[9];
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const depths = color === 3 ? [1, 2, 4, 8] : color === 0 ? [1, 2, 4, 8, 16] : [8, 16];
  if (!width || !height || width > 2048 || height > 2048 || !channels || !depths.includes(depth)
      || header[10] !== 0 || header[11] !== 0 || header[12] > 1) fail('收款码 PNG 格式无效，宽高不能超过 2048');
  let raster;
  try { raster = zlib.inflateSync(Buffer.concat(data), { maxOutputLength: 34 * 1024 * 1024 }); }
  catch { fail('收款码 PNG 图像数据无效'); }
  const passes = header[12] ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
    [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  let rasterOffset = 0;
  for (const [x, y, dx, dy] of passes) {
    const columns = Math.max(0, Math.ceil((width - x) / dx));
    const rows = Math.max(0, Math.ceil((height - y) / dy));
    if (!columns || !rows) continue;
    const stride = 1 + Math.ceil(columns * channels * depth / 8);
    for (let row = 0; row < rows; row += 1) {
      if (rasterOffset >= raster.length || raster[rasterOffset] > 4) fail('收款码 PNG 像素数据无效');
      rasterOffset += stride;
    }
  }
  if (rasterOffset !== raster.length) fail('收款码 PNG 像素长度无效');
}

function validateJpeg(bytes) {
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('收款码 JPEG 无效');
  let offset = 2;
  let hasFrame = false;
  let hasScan = false;
  let entropyBytes = 0;
  let inScan = false;
  while (offset < bytes.length) {
    if (inScan && bytes[offset] !== 0xff) { entropyBytes += 1; offset += 1; continue; }
    if (bytes[offset++] !== 0xff) fail('收款码 JPEG 标记无效');
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) fail('收款码 JPEG 数据不完整');
    const marker = bytes[offset++];
    if (inScan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) { entropyBytes += 1; continue; }
    inScan = false;
    if (marker === 0xd9) {
      if (!hasFrame || !hasScan || !entropyBytes || offset !== bytes.length) fail('收款码 JPEG 图像数据不完整');
      return;
    }
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)
        || offset + 2 > bytes.length) fail('收款码 JPEG 结构无效');
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) fail('收款码 JPEG 数据不完整');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (size < 11 || hasFrame) fail('收款码 JPEG 图片信息无效');
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      const components = bytes[offset + 7];
      if (bytes[offset + 2] !== 8 || !width || !height || width > 2048 || height > 2048
          || ![1, 3, 4].includes(components) || size !== 8 + 3 * components) fail('收款码 JPEG 格式无效，宽高不能超过 2048');
      hasFrame = true;
    }
    if (marker === 0xda) {
      if (!hasFrame || size < 6 || size !== 6 + 2 * bytes[offset + 2]) fail('收款码 JPEG 扫描信息无效');
      hasScan = true;
      inScan = true;
    }
    offset += size;
  }
  fail('收款码 JPEG 缺少结束标记');
}

function normalizePetMarketPaymentSettings(value) {
  const fields = Object.keys(DEFAULT_PET_MARKET_PAYMENT_SETTINGS);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !fields.includes(key))) fail('收款设置必须是支持的 JSON 对象');
  const settings = { ...DEFAULT_PET_MARKET_PAYMENT_SETTINGS, ...value };
  if (typeof settings.enabled !== 'boolean' || !['personal_transfer', 'collection_qr'].includes(settings.method)) {
    fail('启用标记或收款方式无效');
  }
  for (const [field, max, label] of [['recipientName', 60, '收款人昵称'], ['recipientAccount', 32, '收款微信号'], ['instructions', 1000, '付款说明']]) {
    const text = settings[field];
    if (typeof text !== 'string' || [...text.trim()].length > max
        || (field === 'instructions' ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(text)) fail(`${label}格式无效或过长`);
    settings[field] = text.replace(/\r\n/g, '\n').trim();
  }
  if (settings.recipientAccount && !/^[A-Za-z][-_A-Za-z0-9]{5,19}$/.test(settings.recipientAccount)) fail('请输入有效的收款微信号');
  if (typeof settings.qrCodeDataUrl !== 'string') fail('收款码必须是 PNG 或 JPEG 图片');
  if (settings.qrCodeDataUrl) {
    if (settings.qrCodeDataUrl.length > Math.ceil(MAX_QR_BYTES / 3) * 4 + 32) fail('收款码图片不能超过 256 KB');
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(settings.qrCodeDataUrl);
    if (!match) fail('收款码仅支持 PNG 或 JPEG data URL');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > MAX_QR_BYTES || bytes.toString('base64') !== match[2]) fail('收款码大小或编码无效');
    if (match[1] === 'png') validatePng(bytes); else validateJpeg(bytes);
  }
  if (settings.enabled && (!settings.recipientName
      || (settings.method === 'personal_transfer' ? !settings.recipientAccount : !settings.qrCodeDataUrl))) {
    fail(settings.method === 'personal_transfer' ? '启用好友转账前请填写收款人昵称和微信号' : '启用收款码前请填写收款人昵称并上传二维码');
  }
  return settings;
}

module.exports = { DEFAULT_PET_MARKET_PAYMENT_SETTINGS, normalizePetMarketPaymentSettings };
