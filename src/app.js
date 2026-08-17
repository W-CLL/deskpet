const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { ReleaseStore } = require('../lib/storage');
const { ActivationStore } = require('../lib/activation-store');
const { FeedbackStore } = require('../lib/feedback-store');
const { InteractionStore } = require('../lib/interaction-store');
const { AnalyticsStore } = require('../lib/analytics-store');
const { ContentStore } = require('../lib/content-store');
const { ResourcePackStore } = require('../lib/resource-pack-store');
const { CompanionStore } = require('../lib/companion-store');
const { loadConfig } = require('./config/app-config');
const { AdminController } = require('./controllers/admin-controller');
const { PublicController } = require('./controllers/public-controller');
const { accessPolicy, canonicalOrigin } = require('./middleware/access-policy');
const { errorHandler, notFound } = require('./middleware/error-handler');
const { createAdminRouter } = require('./routes/admin-routes');
const { createPublicRouter } = require('./routes/public-routes');
const { ActivationService } = require('./services/activation-service');
const { AdminAuthService } = require('./services/admin-auth-service');
const { AuditService } = require('./services/audit-service');
const { FeedbackService } = require('./services/feedback-service');
const { InteractionService } = require('./services/interaction-service');
const { ContentService } = require('./services/content-service');
const { ReleaseService } = require('./services/release-service');
const { AnalyticsService } = require('./services/analytics-service');
const { ResourcePackService } = require('./services/resource-pack-service');
const { CompanionService } = require('./services/companion-service');

function serveFile(filePath, cacheControl) {
  return function sendStaticFile(_req, res, next) {
    res.setHeader('Cache-Control', cacheControl);
    res.sendFile(filePath, (error) => {
      if (error) next(error);
    });
  };
}

async function createApplication(options = {}) {
  process.umask(0o077);
  const config = loadConfig(options);
  const releaseStore = new ReleaseStore(config.dataDirectory);
  const activationStore = new ActivationStore(config.dataDirectory);
  const feedbackStore = new FeedbackStore(config.dataDirectory);
  const interactionStore = new InteractionStore(config.dataDirectory);
  const analyticsStore = new AnalyticsStore(config.dataDirectory);
  const contentStore = new ContentStore(config.dataDirectory);
  const resourcePackStore = new ResourcePackStore(config.dataDirectory);
  const companionStore = new CompanionStore(config.dataDirectory, options.companionOptions);
  await Promise.all([
    releaseStore.initialize(),
    activationStore.initialize(),
    feedbackStore.initialize(),
    interactionStore.initialize(),
    analyticsStore.initialize(),
    contentStore.initialize(),
    resourcePackStore.initialize(),
    companionStore.initialize()
  ]);
  interactionStore.pruneRawEvents();

  const signingKeySource = options.signingPrivateKey
    || await fs.promises.readFile(config.signingPrivateKeyPath);
  const signingPrivateKey = signingKeySource?.type === 'private'
    ? signingKeySource
    : crypto.createPrivateKey(signingKeySource);
  if (signingPrivateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('更新签名私钥必须使用 Ed25519');
  }

  const auditService = new AuditService(releaseStore);
  const authService = new AdminAuthService({
    config,
    auditService,
    sessionOptions: options.sessionOptions,
    loginRateOptions: options.loginRateOptions
  });
  let activationService;
  const analyticsService = new AnalyticsService({
    analyticsStore,
    authenticateLicense: (req) => activationService.authenticate(req),
    config
  });
  activationService = new ActivationService({
    config,
    activationStore,
    auditService,
    analyticsService,
    activationIpRateOptions: options.activationIpRateOptions,
    activationDeviceRateOptions: options.activationDeviceRateOptions
  });
  const releaseService = new ReleaseService({
    config,
    releaseStore,
    activationService,
    auditService,
    signingPrivateKey
  });
  const feedbackService = new FeedbackService({
    config,
    feedbackStore,
    activationService,
    auditService
  });
  const interactionService = new InteractionService({
    interactionStore,
    activationService
  });
  const contentService = new ContentService({
    config,
    contentStore,
    interactionStore,
    activationService,
    auditService,
    signingPrivateKey
  });
  const resourcePackService = new ResourcePackService({
    config,
    resourcePackStore,
    auditService
  });
  const companionService = new CompanionService({ companionStore, activationService });
  const adminController = new AdminController({
    authService,
    activationService,
    releaseService,
    feedbackService,
    interactionService,
    contentService,
    analyticsService,
    resourcePackService,
    companionService
  });
  const publicController = new PublicController({
    authService,
    activationService,
    feedbackService,
    interactionService,
    contentService,
    releaseService,
    releaseStore,
    analyticsService,
    resourcePackService,
    companionService
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', false);
  app.use(accessPolicy());
  app.use(canonicalOrigin(config));
  app.use(createPublicRouter(publicController));
  app.use('/api/admin', createAdminRouter({
    controller: adminController,
    authService
  }));

  const publicDirectory = path.join(config.projectRoot, 'public');
  app.get('/', (_req, res) => res.redirect(308, '/admin'));
  app.get(
    '/admin',
    serveFile(path.join(publicDirectory, 'admin.html'), 'no-store')
  );
  app.get(
    '/assets/admin.css',
    serveFile(path.join(publicDirectory, 'admin.css'), 'no-cache')
  );
  app.get(
    '/assets/admin.js',
    serveFile(path.join(publicDirectory, 'admin.js'), 'no-cache')
  );
  app.get(
    '/assets/app-icon.png',
    serveFile(config.brandIconPath, 'public, max-age=3600')
  );

  app.use(notFound);
  app.use(errorHandler);

  const maintenanceTimer = setInterval(() => {
    authService.cleanup();
    releaseService.cleanup();
    resourcePackService.cleanup();
  }, 60_000);
  maintenanceTimer.unref();
  const interactionCleanupTimer = setInterval(() => {
    interactionService.cleanup();
    analyticsStore.pruneRawEvents();
  }, 6 * 60 * 60 * 1000);
  interactionCleanupTimer.unref();
  const companionCleanupTimer = setInterval(() => {
    companionService.cleanup().catch((error) => console.error('companion-cleanup-failed', error));
  }, 60 * 60 * 1000);
  companionCleanupTimer.unref();

  let closed = false;
  return {
    app,
    config,
    handler: app,
    store: releaseStore,
    activationStore,
    feedbackStore,
    interactionStore,
    analyticsStore,
    contentStore,
    resourcePackStore,
    companionStore,
    services: {
      activationService,
      authService,
      feedbackService,
      interactionService,
      contentService,
      releaseService,
      analyticsService,
      resourcePackService,
      companionService
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(maintenanceTimer);
      clearInterval(interactionCleanupTimer);
      clearInterval(companionCleanupTimer);
      companionStore.close();
      contentStore.close();
      analyticsStore.close();
      interactionStore.close();
      feedbackStore.close();
      activationStore.close();
    }
  };
}

module.exports = { createApplication };
