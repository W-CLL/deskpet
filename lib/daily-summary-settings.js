const { HttpError } = require('../src/errors/http-error');

const SUMMARY_PLACEHOLDERS = Object.freeze([
  'periodStart', 'periodEnd', 'interactionDays', 'totalInteractions',
  'quizzesAnswered', 'quizzesCorrect', 'moodRecords', 'moodDays',
  'moodSummary', 'happyCount', 'offWorkDays', 'overtimeDays'
]);
const placeholderSet = new Set(SUMMARY_PLACEHOLDERS);
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function freezeSettings(settings) {
  Object.freeze(settings.weekly);
  Object.freeze(settings.monthly);
  settings.templates.forEach(Object.freeze);
  Object.freeze(settings.templates);
  return Object.freeze(settings);
}

// Copy lives on the server so operators can vary it without shipping a new client.
const DEFAULT_DAILY_SUMMARY_SETTINGS = freezeSettings({
  schemaVersion: 1,
  enabled: true,
  weekly: { enabled: true, weekday: 5, time: '18:00' },
  // Monthly summaries are available on the first day of the following month.
  monthly: { enabled: true, time: '09:00' },
  templates: [
    {
      id: 'weekly-companion', kind: 'weekly', enabled: true,
      title: '这一周，和你一起走过',
      body: '{periodStart}—{periodEnd}，我们在 {interactionDays} 天里聊了 {totalInteractions} 次。\n你留下了 {moodRecords} 次心情：{moodSummary}。每一种心情都可以在这里停一停。\n这一周辛苦啦，下次见面时，我们再慢慢聊。'
    },
    {
      id: 'weekly-little-moments', kind: 'weekly', enabled: true,
      title: '收好这周的小片段',
      body: '{periodStart}—{periodEnd}，我们一起答了 {quizzesAnswered} 道题，答对了 {quizzesCorrect} 道。\n你在 {moodDays} 天里记下心情，其中有 {happyCount} 次开心。\n记录里还有 {offWorkDays} 天下班、{overtimeDays} 天加班的片段。谢谢你让我陪在身边，也给自己留一点休息的时间吧。'
    },
    {
      id: 'weekly-unhurried', kind: 'weekly', enabled: true,
      title: '给这一周留个纪念',
      body: '从 {periodStart} 到 {periodEnd}，我们留下了 {totalInteractions} 次互动。\n这周的心情记录是：{moodSummary}。有些日子没记下来也没关系。\n不用给这一周打分，愿接下来的日子里，有属于你的小小轻松。'
    },
    {
      id: 'monthly-companion', kind: 'monthly', enabled: true,
      title: '一个月的陪伴，收进回忆里',
      body: '{periodStart}—{periodEnd}，我们在 {interactionDays} 天里留下了 {totalInteractions} 次互动。\n你在 {moodDays} 天里记录了 {moodRecords} 次心情：{moodSummary}。\n翻过这一页，下一段日常我也陪你慢慢走。'
    },
    {
      id: 'monthly-small-collection', kind: 'monthly', enabled: true,
      title: '这是我们这个月的小收藏',
      body: '从 {periodStart} 到 {periodEnd}，一起答过的 {quizzesAnswered} 道题、记下的 {moodRecords} 次心情，都留在这里。\n其中有 {happyCount} 次开心，也有其他心情：{moodSummary}。\n谢谢你分享这些片段，每一种感受都值得被好好对待。'
    },
    {
      id: 'monthly-slow-letter', kind: 'monthly', enabled: true,
      title: '给刚过去的一个月，一封小短信',
      body: '{periodStart}—{periodEnd}，我们聊了 {totalInteractions} 次，答对了 {quizzesCorrect} 道题。\n记录里有 {offWorkDays} 天下班和 {overtimeDays} 天加班的片段，还有你的心情：{moodSummary}。\n忙碌的日子，平常的日子，都是你的生活。新的一月，愿你也有时间照顾自己。'
    }
  ]
});

function invalid(message) {
  throw new HttpError(400, `日常总结设置：${message}`, 'INVALID_DAILY_SUMMARIES');
}

function requireObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label}格式无效`);
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid(`${label}包含未知字段`);
  if (keys.some((key) => !Object.hasOwn(value, key))) invalid(`${label}缺少必要字段`);
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') invalid(`${label}必须是布尔值`);
  return value;
}

function requireTime(value, label) {
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) invalid(`${label}必须是 00:00 至 23:59`);
  return value;
}

function requireText(value, limit, label) {
  if (typeof value !== 'string') invalid(`${label}必须是文本`);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!normalized || normalized.length > limit) invalid(`${label}须为 1 至 ${limit} 个字符`);
  if (/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    invalid(`${label}只支持纯文本，不支持 HTML 或控制字符`);
  }
  const remaining = normalized.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (placeholder, key) => {
    if (!placeholderSet.has(key)) invalid(`${label}包含未知占位符 ${placeholder}`);
    return '';
  });
  if (/[{}]/.test(remaining)) invalid(`${label}包含无效占位符`);
  return normalized;
}

function normalizeDailySummarySettings(value) {
  if (value === undefined) return structuredClone(DEFAULT_DAILY_SUMMARY_SETTINGS);
  requireObject(value, ['schemaVersion', 'enabled', 'weekly', 'monthly', 'templates'], '配置');
  if (value.schemaVersion !== 1) invalid('不支持此 schemaVersion');
  requireObject(value.weekly, ['enabled', 'weekday', 'time'], '周总结');
  requireObject(value.monthly, ['enabled', 'time'], '月总结');
  if (!Number.isInteger(value.weekly.weekday) || value.weekly.weekday < 0 || value.weekly.weekday > 6) {
    invalid('周总结星期必须是 0（周日）至 6（周六）');
  }
  if (!Array.isArray(value.templates) || value.templates.length > 40) invalid('模板须为数组且最多 40 条');
  const ids = new Set();
  const result = {
    schemaVersion: 1,
    enabled: requireBoolean(value.enabled, '总开关'),
    weekly: {
      enabled: requireBoolean(value.weekly.enabled, '周总结开关'),
      weekday: value.weekly.weekday,
      time: requireTime(value.weekly.time, '周总结时间')
    },
    monthly: {
      enabled: requireBoolean(value.monthly.enabled, '月总结开关'),
      time: requireTime(value.monthly.time, '月总结时间')
    },
    templates: value.templates.map((template, index) => {
      const label = `模板 ${index + 1}`;
      requireObject(template, ['id', 'kind', 'enabled', 'title', 'body'], label);
      if (typeof template.id !== 'string' || !ID_PATTERN.test(template.id)) invalid(`${label} ID 格式无效`);
      if (ids.has(template.id)) invalid(`模板 ID ${template.id} 重复`);
      ids.add(template.id);
      if (!['weekly', 'monthly'].includes(template.kind)) invalid(`${label}类型无效`);
      return {
        id: template.id,
        kind: template.kind,
        enabled: requireBoolean(template.enabled, `${label}开关`),
        title: requireText(template.title, 80, `${label}标题`),
        body: requireText(template.body, 2000, `${label}正文`)
      };
    })
  };
  for (const kind of ['weekly', 'monthly']) {
    if (result[kind].enabled && !result.templates.some((template) => template.kind === kind && template.enabled)) {
      invalid(`${kind === 'weekly' ? '周' : '月'}总结启用时至少需要一条启用模板`);
    }
  }
  return result;
}

module.exports = { DEFAULT_DAILY_SUMMARY_SETTINGS, SUMMARY_PLACEHOLDERS, normalizeDailySummarySettings };
