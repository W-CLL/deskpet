const { parseStrictZip } = require('./pet-market-package');

const ACTIONS = new Set(['idle', 'grab', 'switch', 'happy', 'angry', 'confused', 'shy', 'sleepy',
  'surprised', 'cheer', 'sad', 'calm', 'chase', 'dodge', 'bounce', 'theater_open', 'theater_reply',
  'theater_middle', 'theater_middle_reply', 'theater_challenge', 'theater_challenge_reply',
  'theater_twist', 'theater_twist_reply', 'theater_finish', '待机', '抓我', '抓取', '切换', '开心',
  '生气', '疑惑', '害羞', '困倦', '困', '惊讶', '加油', '难过', '伤心', '安静', '追逐', '躲避',
  '反弹', '小剧场开场', '小剧场回应', '小剧场中场', '小剧场中场回应', '小剧场动作',
  '小剧场动作回应', '小剧场反转', '小剧场反转回应', '小剧场收尾']);

function fail(message) {
  const error = new Error(message);
  error.code = 'INVALID_RESOURCE_PACK_PACKAGE';
  throw error;
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && value.trim().length > 0; }

function validateDocument(value, category) {
  if (!object(value)) fail('资源 JSON 必须是对象');
  if (category === 'theater-scripts') {
    if (!Array.isArray(value.scenes) || value.scenes.length < 3 || value.scenes.length > 5
        || value.scenes.some(scene => !object(scene)
          || !text(scene.main ?? scene.actorA) || !text(scene.companion ?? scene.actorB))) {
      fail('小剧场需要 3–5 组有效的 main/companion 对白（兼容 actorA/actorB）');
    }
    if (value.name !== undefined && !text(value.name)) fail('小剧场名称必须是非空文字');
    return;
  }
  if (category !== 'interaction-words') fail('资源包分类无效');
  const reactions = value.reactions ?? value.words ?? value;
  if (!object(reactions)) fail('互动词库需要 reactions 或 words 动作对象');
  let count = 0;
  for (const [action, lines] of Object.entries(reactions)) {
    if (!ACTIONS.has(action.trim().toLowerCase())) continue;
    const values = Array.isArray(lines) ? lines : [lines];
    if (values.some(line => typeof line !== 'string')) fail('互动台词必须为文字或文字数组');
    count += values.filter(text).length;
  }
  if (!count) fail('互动词库中没有可用动作台词');
}

function validateResourcePackPackage(bytes, category) {
  let files;
  try {
    files = parseStrictZip(bytes, { maxFiles: 162, maxFileBytes: 256 * 1024, maxUncompressedBytes: 20 * 1024 * 1024 });
  } catch (error) { fail(error.message); }
  const jsonFiles = files.filter(file => /\.json$/i.test(file.name));
  if (jsonFiles.length < 1 || jsonFiles.length > 80) fail('资源包必须包含 1–80 个 JSON 文件');
  if (files.some(file => !/\.json$/i.test(file.name) && !/(^|\/)readme\.(txt|md)$/i.test(file.name))) {
    fail('资源包只允许 JSON 和可选的 README.txt / README.md');
  }
  for (const file of jsonFiles) {
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.data).replace(/^\uFEFF/, '')); }
    catch { fail(`资源 JSON 无效：${file.name}`); }
    validateDocument(value, category);
  }
  return { fileCount: jsonFiles.length, validationVersion: 1, installable: true };
}

module.exports = { validateResourcePackPackage };
