const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateGifUploadFiles, createPetMarketPackageFromFiles } = require('../lib/pet-market-upload');
const { parseStrictZip, validatePetMarketPackage } = require('../lib/pet-market-package');
const { PetMarketStore } = require('../lib/pet-market-store');

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const expected = { productId: 'warm-cat', version: '1.0.0', title: '暖心猫咪' };
const file = (name = 'gifs/陪伴.gif', sizeBytes = GIF.length) => ({ path: name, sizeBytes });

test('direct GIF upload builds a compatible manifest package without reading source paths', () => {
  const { archive, packageInfo } = createPetMarketPackageFromFiles(
    Buffer.concat([GIF, GIF]), [file(), file('gifs/招手.gif')], expected
  );
  assert.equal(packageInfo.manifest.files.length, 2);
  assert.equal(packageInfo.manifest.title, expected.title);
  assert.deepEqual(validatePetMarketPackage(archive, expected), packageInfo);
  assert.deepEqual(parseStrictZip(archive).find(entry => entry.name === 'gifs/陪伴.gif').data, GIF);
});

test('direct GIF metadata rejects unsafe paths, duplicates, invalid sizes and empty selections', () => {
  for (const name of ['../a.gif', '/a.gif', 'C:/a.gif', 'dir\\a.gif', 'CON.gif', '.hidden.gif',
    'dir//a.gif', 'dir/../a.gif', 'a.gif:payload', 'dir /a.gif', 'a.png']) {
    assert.throws(() => validateGifUploadFiles([file(name)]), { code: 'INVALID_PET_MARKET_PACKAGE' });
  }
  for (const metadata of [[], null, 'gif', [null], [file('a.gif', 0)], [file('a.gif', -1)],
    [file('a.gif', '32')], [file('a.gif', 8 * 1024 * 1024 + 1)],
    [file('a.gif'), file('A.GIF')], [{ ...file(), localPath: 'C:/secret.gif' }],
    Array.from({ length: 81 }, (_, index) => file(`${index}.gif`)),
    Array.from({ length: 9 }, (_, index) => file(`${index}.gif`, 8 * 1024 * 1024))]) {
    assert.throws(() => validateGifUploadFiles(metadata), { code: 'INVALID_PET_MARKET_PACKAGE' });
  }
});

test('direct GIF content rejects mismatched sizes, false headers, truncation and invalid dimensions', () => {
  const tooWide = Buffer.from(GIF);
  tooWide.writeUInt16LE(2049, 6);
  const invalidMarker = Buffer.from(GIF);
  invalidMarker[19] = 0x00;
  const badImages = [Buffer.from('not an image'), GIF.subarray(0, 13), GIF.subarray(0, -1),
    Buffer.concat([GIF, Buffer.from('extra')]), tooWide, invalidMarker];
  for (const bytes of badImages) {
    assert.throws(() => createPetMarketPackageFromFiles(bytes, [file('a.gif', bytes.length)], expected),
      { code: 'INVALID_PET_MARKET_PACKAGE' });
  }
  assert.throws(() => createPetMarketPackageFromFiles(GIF, [file('a.gif', GIF.length + 1)], expected),
    /大小与登记信息不一致/);
});

test('pet shop tags and featured migration preserves legacy products and defaults on reopen', async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpet-pet-tags-'));
  let store = new PetMarketStore(directory);
  context.after(async () => {
    store.close();
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  await store.initialize();
  store.createProduct({
    id: 'legacy-cat', title: '已有猫咪', description: '保留原设置', chargingMode: 'paid', priceFen: 280,
    status: 'draft', isDefault: false, sortOrder: 7, previewMode: 'first5', previewPaths: []
  });
  store.database.exec('ALTER TABLE pet_market_products DROP COLUMN tags_json');
  store.database.exec('ALTER TABLE pet_market_products DROP COLUMN is_featured');
  store.close();
  store = new PetMarketStore(directory);
  await store.initialize();
  const migrated = store.findProduct('legacy-cat');
  assert.deepEqual(migrated.tags, []);
  assert.equal(migrated.isFeatured, false);
  assert.equal(migrated.title, '已有猫咪');
  assert.equal(migrated.priceFen, 280);
  assert.equal(migrated.sortOrder, 7);
  store.updateProduct('legacy-cat', { ...migrated, tags: ['治愈'], isFeatured: true });
  store.close();
  store = new PetMarketStore(directory);
  await store.initialize();
  assert.deepEqual(store.findProduct('legacy-cat').tags, ['治愈']);
  assert.equal(store.findProduct('legacy-cat').isFeatured, true);
});
