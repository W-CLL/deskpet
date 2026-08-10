const express = require('express');
const { MAX_JSON_BODY } = require('../config/app-config');
const { jsonBody } = require('../middleware/json-body');

function setWebsiteCors(req, res) {
  const origin = String(req.headers.origin || '');
  if (origin === 'https://desktoppet.online' || /^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
}

function createPublicRouter(controller) {
  const router = express.Router();
  router.options('/api/analytics/events', (req, res) => {
    setWebsiteCors(req, res);
    res.setHeader('Access-Control-Max-Age', '600');
    res.status(204).end();
  });
  router.get('/healthz', (req, res) => controller.health(req, res));
  router.post('/api/activate', ...jsonBody(4096), (req, res) => controller.activate(req, res));
  router.post('/api/trial', ...jsonBody(4096), (req, res) => controller.trial(req, res));
  router.get('/api/feedback', (req, res) => controller.feedback(req, res));
  router.post(
    '/api/feedback',
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.submitFeedback(req, res)
  );
  router.get(
    '/api/interactions/profile',
    (req, res) => controller.interactionProfile(req, res)
  );
  router.patch(
    '/api/interactions/profile',
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.updateInteractionProfile(req, res)
  );
  router.get(
    '/api/interactions/stats',
    (req, res) => controller.interactionStats(req, res)
  );
  router.post(
    '/api/interactions/events',
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.recordInteractionEvents(req, res)
  );
  router.post(
    '/api/content/batch',
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.contentBatch(req, res)
  );
  router.get(
    '/api/content/offline-pack',
    (req, res) => controller.contentOfflinePack(req, res)
  );
  router.get('/api/update/latest', (req, res) => controller.latest(req, res));
  router.get('/api/public/downloads', (req, res) => {
    setWebsiteCors(req, res);
    return controller.publicDownloads(req, res);
  });
  router.get('/api/public/site-settings', (req, res) => {
    setWebsiteCors(req, res);
    return controller.publicSiteSettings(req, res);
  });
  router.get('/api/public/resource-packs', (req, res) => {
    setWebsiteCors(req, res);
    return controller.publicResourcePacks(req, res);
  });
  router.get(
    '/downloads/latest/:platform/:architecture',
    (req, res) => controller.latestDownload(req, res)
  );
  router.post(
    '/api/analytics/events',
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => {
      setWebsiteCors(req, res);
      return controller.analytics(req, res);
    }
  );
  router.get('/downloads/:fileName', (req, res, next) => controller.download(req, res, next));
  router.get(
    '/resource-packs/:id/download',
    (req, res, next) => controller.downloadResourcePack(req, res, next)
  );
  return router;
}

module.exports = { createPublicRouter };
