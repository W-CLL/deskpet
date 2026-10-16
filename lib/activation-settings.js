const DEFAULT_ACTIVATION_SETTINGS = Object.freeze({
  title: '还没有激活码',
  description: '加作者微信，备注「桌搭子」。一组码填两台，电脑和手机都能收；对象那边仍要自己买一次。一般当天回。',
  qrCodeDataUrl: ''
});

function normalizeActivationSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = {};
  for (const [field, maximum] of [['title', 60], ['description', 500]]) {
    const text = source[field] == null ? DEFAULT_ACTIVATION_SETTINGS[field] : source[field];
    if (typeof text !== 'string' || !text.trim() || text.length > maximum) {
      throw new Error(`激活页${field === 'title' ? '标题' : '文案'}不能为空，且不能超过 ${maximum} 个字符`);
    }
    result[field] = text.trim();
  }
  const image = source.qrCodeDataUrl ?? '';
  if (typeof image !== 'string') throw new Error('激活页二维码必须是 PNG 图片');
  if (image) {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match || image.length > 350_000) throw new Error('激活页二维码仅支持不超过 256 KB 的 PNG 图片');
    const bytes = Buffer.from(match[1], 'base64');
    if (bytes.length < 45 || bytes.length > 256 * 1024 || bytes.toString('base64') !== match[1]
      || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
      || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(16) > 2048
      || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(20) > 2048
      || !bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))) {
      throw new Error('激活页二维码 PNG 无效，图片边长不能超过 2048 像素');
    }
  }
  return { ...result, qrCodeDataUrl: image };
}

module.exports = { DEFAULT_ACTIVATION_SETTINGS, normalizeActivationSettings };
