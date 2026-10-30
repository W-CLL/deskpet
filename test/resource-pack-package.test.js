const assert = require('node:assert/strict');
const test = require('node:test');
const { createStoredZip } = require('../lib/local-market-store');
const { validateResourcePackPackage } = require('../lib/resource-pack-package');

const scenes = [{ main: '你好', companion: '你好呀' }, { main: '今天如何', companion: '挺不错' },
  { main: '继续加油', companion: '一起努力' }];
const zip = (value, name = 'content.json') => createStoredZip(name, JSON.stringify(value));

test('free resource packages accept existing theater and interaction word JSON formats', () => {
  for (const value of [{ reactions: { idle: ['你好'] } }, { words: { happy: ['开心'] } }, { 待机: '来陪你了' }]) {
    assert.equal(validateResourcePackPackage(zip(value), 'interaction-words').fileCount, 1);
  }
  for (const value of [{ name: '日常小剧场', scenes }, { scenes: scenes.map(item => ({ actorA: item.main, actorB: item.companion })) }]) {
    assert.deepEqual(validateResourcePackPackage(zip(value, 'theater/daily.json'), 'theater-scripts'), {
      fileCount: 1, validationVersion: 1, installable: true
    });
  }
});

test('free resource packages reject invalid documents, wrong categories, dangerous paths and oversized files', () => {
  for (const [archive, category] of [
    [zip({ scenes }), 'interaction-words'], [zip({ reactions: { idle: ['你好'] } }), 'theater-scripts'],
    [zip({ reactions: { unknown: ['not an action'] } }), 'interaction-words'],
    [zip({ reactions: { idle: [{ code: 'not text' }] } }), 'interaction-words'],
    [zip({ scenes: scenes.slice(0, 2) }), 'theater-scripts'],
    [zip({ scenes: [...scenes, ...scenes] }), 'theater-scripts'],
    [zip({ scenes: [{ main: '', companion: 'a' }, ...scenes] }), 'theater-scripts'],
    [zip({ reactions: { idle: ['a'] } }, '../unsafe.json'), 'interaction-words'],
    [zip({ reactions: { idle: ['a'] } }, 'run.exe'), 'interaction-words'],
    [createStoredZip('only-readme.md', 'nothing installable'), 'interaction-words'],
    [createStoredZip('invalid.json', '{broken json'), 'interaction-words'],
    [createStoredZip('large.json', 'a'.repeat(256 * 1024 + 1)), 'interaction-words'],
    [Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]), 'interaction-words']
  ]) {
    assert.throws(() => validateResourcePackPackage(archive, category), { code: 'INVALID_RESOURCE_PACK_PACKAGE' });
  }
});
