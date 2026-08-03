const {
  INTERACTION_EVENT_TYPES,
  INTERACTION_MODES,
  MOOD_VALUES
} = require('../../lib/interaction-store');
const { HttpError } = require('../errors/http-error');

const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_EVENTS_PER_BATCH = 50;
const MAX_EVENT_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

function cleanSingleLine(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function invalidEvent(index, message) {
  return new HttpError(400, `第 ${index + 1} 条互动事件${message}`, 'INVALID_INTERACTION_EVENT');
}

function normalizeEvent(source, index, now = Date.now()) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw invalidEvent(index, '格式无效');
  }
  const eventId = cleanSingleLine(source.eventId, 64).toLowerCase();
  if (!EVENT_ID_PATTERN.test(eventId)) throw invalidEvent(index, '缺少有效 eventId');
  const type = cleanSingleLine(source.type, 40).toLowerCase();
  if (!INTERACTION_EVENT_TYPES.includes(type)) throw invalidEvent(index, '类型无效');

  const occurredTimestamp = Date.parse(source.occurredAt);
  if (!Number.isFinite(occurredTimestamp)) throw invalidEvent(index, '发生时间无效');
  if (occurredTimestamp < now - MAX_EVENT_AGE_MS) throw invalidEvent(index, '发生时间超过一年');
  if (occurredTimestamp > now + MAX_FUTURE_SKEW_MS) throw invalidEvent(index, '发生时间晚于服务器时间');

  const event = {
    eventId,
    type,
    occurredAt: new Date(occurredTimestamp).toISOString()
  };
  if (type === 'mood_response') {
    const mood = cleanSingleLine(source.mood, 20).toLowerCase();
    if (!MOOD_VALUES.includes(mood)) throw invalidEvent(index, '心情选项无效');
    event.mood = mood;
  } else {
    const contentId = cleanSingleLine(source.contentId, 128);
    if (!CONTENT_ID_PATTERN.test(contentId)) throw invalidEvent(index, '缺少有效 contentId');
    event.contentId = contentId;
    if (type === 'quiz_answered') {
      if (typeof source.correct !== 'boolean') throw invalidEvent(index, '缺少答题结果');
      event.correct = source.correct;
    }
  }
  return event;
}

class InteractionService {
  constructor({ interactionStore, activationService }) {
    this.interactionStore = interactionStore;
    this.activationService = activationService;
  }

  profile(req) {
    const license = this.activationService.requireLicense(req);
    return this.interactionStore.getAccount(license.accountId);
  }

  updateProfile(req, body) {
    const license = this.activationService.requireLicense(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, '互动设置格式无效', 'INVALID_INTERACTION_PROFILE');
    }
    const updates = {};
    if (Object.hasOwn(body, 'mode')) {
      const mode = cleanSingleLine(body.mode, 20).toLowerCase();
      if (!INTERACTION_MODES.includes(mode)) {
        throw new HttpError(400, '互动频率模式无效', 'INVALID_INTERACTION_MODE');
      }
      updates.mode = mode;
    }
    if (Object.hasOwn(body, 'promptsEnabled')) {
      if (typeof body.promptsEnabled !== 'boolean') {
        throw new HttpError(400, '互动开关必须是布尔值', 'INVALID_INTERACTION_PROFILE');
      }
      updates.promptsEnabled = body.promptsEnabled;
    }
    if (Object.keys(updates).length === 0) {
      throw new HttpError(400, '没有可更新的互动设置', 'INVALID_INTERACTION_PROFILE');
    }
    return this.interactionStore.updateProfile(license.accountId, updates);
  }

  recordEvents(req, body) {
    const license = this.activationService.requireLicense(req);
    if (!Array.isArray(body?.events) || body.events.length < 1
      || body.events.length > MAX_EVENTS_PER_BATCH) {
      throw new HttpError(
        400,
        `每批必须包含 1 至 ${MAX_EVENTS_PER_BATCH} 条互动事件`,
        'INVALID_INTERACTION_BATCH'
      );
    }
    const now = Date.now();
    const events = body.events.map((event, index) => normalizeEvent(event, index, now));
    return this.interactionStore.recordEvents(license.accountId, events, {
      appVersion: cleanSingleLine(req.headers['x-deskpet-version'], 40),
      platform: cleanSingleLine(req.headers['x-deskpet-platform'] || 'windows', 20)
    });
  }

  stats(req) {
    const license = this.activationService.requireLicense(req);
    return { summary: this.interactionStore.getAccount(license.accountId).summary };
  }

  listAll() {
    return this.interactionStore.listAll();
  }

  cleanup() {
    return this.interactionStore.pruneRawEvents();
  }
}

module.exports = {
  EVENT_ID_PATTERN,
  MAX_EVENTS_PER_BATCH,
  InteractionService,
  normalizeEvent
};
