const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_PET_MARKET_PAYMENT_SETTINGS, normalizePetMarketPaymentSettings: normalize } = require('../lib/pet-market-payment-settings');
const { pngDataUrl, JPEG_DATA_URL } = require('./helpers/payment-image-fixtures');

test('payment settings default disabled and validate fields and mode-specific requirements', () => {
  assert.deepEqual(normalize({}), DEFAULT_PET_MARKET_PAYMENT_SETTINGS);
  assert.deepEqual(normalize({ enabled: true, recipientName: ' 测试 ', recipientAccount: 'test_pay01', instructions: ' 一\r\n二 ' }), {
    ...DEFAULT_PET_MARKET_PAYMENT_SETTINGS, enabled: true, recipientName: '测试', recipientAccount: 'test_pay01', instructions: '一\n二'
  });
  for (const value of [null, [], 'text', { token: 'secret' }, { enabled: 'true' }, { method: 'card' },
    { recipientName: null }, { recipientName: 'a'.repeat(61) }, { recipientName: 'a\nb' },
    { recipientAccount: 'short' }, { recipientAccount: '123456' }, { recipientAccount: 'bad account' },
    { instructions: 'a'.repeat(1001) }, { instructions: '\u0000' }, { qrCodeDataUrl: null },
    { enabled: true }, { enabled: true, recipientName: '测试' },
    { enabled: true, method: 'collection_qr', recipientName: '测试', recipientAccount: 'test_pay01' }]) {
    assert.throws(() => normalize(value), { code: 'INVALID_PET_MARKET_PAYMENT_SETTINGS' });
  }
});

test('payment QR accepts complete PNG and JPEG and rejects spoofed, damaged, oversized or invalid URLs', () => {
  for (const qrCodeDataUrl of [pngDataUrl(), JPEG_DATA_URL]) {
    const result = normalize({ enabled: true, method: 'collection_qr', recipientName: '测试', qrCodeDataUrl });
    assert.equal(result.qrCodeDataUrl, qrCodeDataUrl);
  }
  const pngBytes = Buffer.from(pngDataUrl().split(',')[1], 'base64');
  const damaged = Buffer.from(pngBytes);
  damaged[damaged.length - 5] ^= 1;
  for (const qrCodeDataUrl of ['https://example.com/qr.png', 'data:image/svg+xml;base64,PHN2Zz4=',
    pngDataUrl().replace('image/png', 'image/jpeg'), JPEG_DATA_URL.replace('image/jpeg', 'image/png'),
    'data:image/png;base64,' + damaged.toString('base64'),
    'data:image/png;base64,' + pngBytes.subarray(0, -12).toString('base64'),
    'data:image/jpeg;base64,' + Buffer.from(JPEG_DATA_URL.split(',')[1], 'base64').subarray(0, -2).toString('base64'),
    'data:image/png;base64,' + Buffer.alloc(256 * 1024 + 1).toString('base64'), pngDataUrl(2049, 1),
    pngDataUrl() + ' ', 'data:image/png;base64,AAAA=']) {
    assert.throws(() => normalize({ qrCodeDataUrl }), { code: 'INVALID_PET_MARKET_PAYMENT_SETTINGS' });
  }
});
