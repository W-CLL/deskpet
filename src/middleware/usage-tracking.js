const crypto = require('node:crypto');

function trialDeviceKey(installationId) {
  return `trial:${crypto.createHash('sha256').update(String(installationId || '')).digest('hex')}`;
}

function identityFromLicense(license) {
  if (!license?.installationId) return null;
  return {
    deviceKey: license.trial ? trialDeviceKey(license.installationId) : license.id,
    licenseId: license.trial ? null : license.id,
    accountId: license.trial ? null : license.accountId,
    installationSuffix: String(license.installationId).slice(-8),
    authorizationType: license.trial ? 'trial' : 'license',
    platform: license.platform || 'unknown',
    architecture: license.architecture || 'unknown',
    appVersion: license.appVersion || ''
  };
}

function responseIdentity(req, res, initial) {
  if (initial) return initial;
  if (res.locals.activatedLicense) {
    return identityFromLicense({
      id: res.locals.activatedLicense.licenseId,
      accountId: res.locals.activatedLicense.accountId,
      installationId: req.body?.installationId,
      appVersion: req.body?.appVersion,
      platform: req.headers['x-deskpet-platform'],
      architecture: req.headers['x-deskpet-architecture']
    });
  }
  if (res.locals.trialStarted) {
    return identityFromLicense({
      id: `trial:${req.body?.installationId}`,
      installationId: req.body?.installationId,
      appVersion: req.body?.appVersion,
      platform: req.headers['x-deskpet-platform'],
      architecture: req.headers['x-deskpet-architecture'],
      trial: true
    });
  }
  return null;
}

function normalizedPath(req, status = 0) {
  const raw = String(req.originalUrl || req.url || '/').split('?', 1)[0];
  if (status === 404) {
    if (raw.startsWith('/downloads/')) return '/downloads/:unmatched';
    if (raw.startsWith('/api/')) return '/api/:unmatched';
  }
  let path = raw;
  if (path.startsWith('/downloads/')) path = '/downloads/:fileName';
  else {
    path = path
      .replace(/\/api\/companion\/hall\/deliveries\/[^/]+$/, '/api/companion/hall/deliveries/:recipientId')
      .replace(/\/api\/companion\/deliveries\/[^/]+\/(file|acknowledge)$/, '/api/companion/deliveries/:id/$1')
      .replace(/\/api\/trial\/visit-stickers\/[^/]+\/file$/, '/api/trial/visit-stickers/:id/file')
      .replace(/\/resource-packs\/[^/]+\/download$/, '/resource-packs/:id/download');
  }
  return path.slice(0, 160);
}

function detectedFeature(req, path) {
  if (req.method === 'POST' && path === '/api/trial/visit-stickers/play') {
    return { feature: 'trial_visit', category: String(req.body?.category || '') };
  }
  if (req.method === 'POST' && path === '/api/companion/pair') return { feature: 'companion_pair' };
  if (req.method === 'DELETE' && path === '/api/companion/pair') return { feature: 'companion_unpair' };
  if (req.method === 'POST' && path === '/api/companion/deliveries') return { feature: 'companion_send' };
  if (req.method === 'POST' && path === '/api/companion/hall/deliveries/:recipientId') {
    return { feature: 'companion_hall_send' };
  }
  if (req.method === 'PATCH' && path === '/api/companion/hall') {
    return { feature: req.body?.enabled === true ? 'companion_hall_open' : 'companion_hall_close' };
  }
  return null;
}

function createUsageTracking({ activationService, analyticsService }) {
  return function trackUsage(req, res, next) {
    const trackedPath = String(req.originalUrl || req.url || '/').split('?', 1)[0];
    if ((!trackedPath.startsWith('/api/') && !trackedPath.startsWith('/downloads/'))
      || trackedPath.startsWith('/api/admin/')
      || req.method === 'OPTIONS') {
      next();
      return;
    }
    let identity = null;
    try { identity = identityFromLicense(activationService.authenticate(req)); } catch { }
    res.once('finish', () => {
      try {
        const path = normalizedPath(req, res.statusCode);
        identity = responseIdentity(req, res, identity);
        const platform = String(
          req.headers['x-deskpet-platform'] || identity?.platform || res.locals.releaseDownload?.platform || 'unknown'
        ).slice(0, 20).toLowerCase();
        const architecture = String(
          req.headers['x-deskpet-architecture'] || identity?.architecture || res.locals.releaseDownload?.architecture || 'unknown'
        ).slice(0, 32).toLowerCase();
        const appVersion = String(req.headers['x-deskpet-version'] || identity?.appVersion || '').slice(0, 40);
        analyticsService.recordRequest({
          identity,
          method: req.method,
          path,
          platform,
          architecture,
          appVersion,
          status: res.statusCode
        });
        const range = String(req.headers.range || '');
        const startsDownload = !range || /^bytes=0-/i.test(range);
        if (req.method === 'GET' && res.statusCode >= 200 && res.statusCode < 300
          && res.locals.releaseDownload && startsDownload) {
          analyticsService.recordReleaseDownload(res.locals.releaseDownload);
        }
        const feature = res.statusCode >= 200 && res.statusCode < 300
          ? (res.locals.usageFeature || detectedFeature(req, path))
          : null;
        if (feature) {
          analyticsService.recordFeature({
            ...feature,
            identity,
            platform,
            appVersion,
            detail: String(feature.detail || '').slice(0, 160)
          });
        }
      } catch (error) {
        console.error('usage-tracking-failed', error);
      }
    });
    next();
  };
}

module.exports = { createUsageTracking, identityFromLicense, trialDeviceKey };
