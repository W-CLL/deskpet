const fs = require('node:fs');
const path = require('node:path');
const {
  LoginRateLimiter,
  SessionStore,
  equalText,
  parseCookies,
  verifyPassword
} = require('../../lib/security');
const { HttpError } = require('../errors/http-error');
const {
  SESSION_COOKIE,
  assertSafeOrigin,
  clientIp,
  sessionCookie
} = require('../http/request-context');

class AdminAuthService {
  constructor({ config, auditService, sessionOptions, loginRateOptions }) {
    this.config = config;
    this.auditService = auditService;
    this.authPath = path.join(config.dataDirectory, 'auth.json');
    this.sessions = new SessionStore(sessionOptions);
    this.loginLimiter = new LoginRateLimiter(loginRateOptions);
  }

  async loadAuthRecord() {
    try {
      return JSON.parse(await fs.promises.readFile(this.authPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async isConfigured() {
    return Boolean(await this.loadAuthRecord());
  }

  currentSession(req) {
    const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    const session = this.sessions.get(token);
    if (!session || session.ip !== clientIp(req, this.config)) return null;
    return session;
  }

  requireSession(req) {
    const session = this.currentSession(req);
    if (!session) throw new HttpError(401, '请先登录', 'AUTH_REQUIRED');
    return session;
  }

  requireWriteSession(req) {
    assertSafeOrigin(req, this.config);
    const session = this.requireSession(req);
    if (!equalText(req.headers['x-csrf-token'], session.csrfToken)) {
      throw new HttpError(403, '安全令牌无效，请重新登录', 'CSRF_REJECTED');
    }
    return session;
  }

  sessionPayload(session) {
    return {
      authenticated: true,
      username: 'admin',
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString()
    };
  }

  async login(req, body) {
    assertSafeOrigin(req, this.config);
    const ip = clientIp(req, this.config);
    const rateStatus = this.loginLimiter.status(ip);
    if (!rateStatus.allowed) {
      throw new HttpError(
        429,
        `登录尝试过多，请在 ${rateStatus.retryAfterSeconds} 秒后重试`,
        'LOGIN_RATE_LIMITED'
      );
    }

    const authRecord = await this.loadAuthRecord();
    if (!authRecord) {
      throw new HttpError(503, '管理员密码尚未配置', 'ADMIN_NOT_CONFIGURED');
    }
    const usernameValid = body?.username === 'admin';
    const passwordValid = await verifyPassword(body?.password, authRecord);
    if (!usernameValid || !passwordValid) {
      const nextStatus = this.loginLimiter.fail(ip);
      await this.auditService.write({ action: 'login', outcome: 'denied', ip });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const allowed = nextStatus.allowed;
      throw new HttpError(
        allowed ? 401 : 429,
        allowed ? '用户名或密码错误' : `登录尝试过多，请在 ${nextStatus.retryAfterSeconds} 秒后重试`,
        allowed ? 'LOGIN_FAILED' : 'LOGIN_RATE_LIMITED'
      );
    }

    this.loginLimiter.reset(ip);
    const session = this.sessions.create(ip);
    await this.auditService.write({ action: 'login', outcome: 'success', ip });
    return {
      payload: this.sessionPayload(session),
      cookie: sessionCookie(
        this.config,
        session.token,
        Math.floor((session.expiresAt - Date.now()) / 1000)
      )
    };
  }

  getSession(req) {
    const session = this.currentSession(req);
    return session ? this.sessionPayload(session) : { authenticated: false };
  }

  async logout(req) {
    const session = this.requireWriteSession(req);
    this.sessions.destroy(session.token);
    await this.auditService.write({
      action: 'logout',
      outcome: 'success',
      ip: clientIp(req, this.config)
    });
    return { payload: { ok: true }, cookie: sessionCookie(this.config, '', 0) };
  }

  cleanup() {
    this.sessions.cleanup();
  }
}

module.exports = { AdminAuthService };
