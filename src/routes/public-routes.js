const express = require('express');
const { MAX_JSON_BODY } = require('../config/app-config');
const { jsonBody } = require('../middleware/json-body');
const { MAX_GIF_BYTES } = require('../services/companion-service');

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
  router.get('/api/companion', (req, res) => controller.companionProfile(req, res));
  router.get('/api/companion/hall', (req, res) => controller.companionHall(req, res));
  router.patch(
    '/api/companion/hall',
    ...jsonBody(4096),
    (req, res) => controller.updateCompanionHall(req, res)
  );
  router.patch(
    '/api/companion',
    ...jsonBody(4096),
    (req, res) => controller.updateCompanionProfile(req, res)
  );
  router.post(
    '/api/companion/pair',
    ...jsonBody(4096),
    (req, res) => controller.pairCompanion(req, res)
  );
  router.delete('/api/companion/pair', (req, res) => controller.unpairCompanion(req, res));
  router.get(
    '/api/companion/deliveries',
    (req, res) => controller.companionDeliveries(req, res)
  );
  router.post(
    '/api/companion/deliveries',
    express.raw({ type: 'image/gif', limit: MAX_GIF_BYTES }),
    (req, res) => controller.sendCompanionGif(req, res)
  );
  router.post(
    '/api/companion/hall/deliveries/:recipientId',
    express.raw({ type: 'image/gif', limit: MAX_GIF_BYTES }),
    (req, res) => controller.sendHallCompanionGif(req, res)
  );
  router.get(
    '/api/companion/deliveries/:id/file',
    (req, res) => controller.companionDeliveryFile(req, res)
  );
  router.post(
    '/api/companion/deliveries/:id/acknowledge',
    (req, res) => controller.acknowledgeCompanionDelivery(req, res)
  );
  router.get('/api/trial/visit-stickers', (req, res) => controller.trialVisitCatalog(req, res));
  router.post(
    '/api/trial/visit-stickers/play',
    ...jsonBody(4096),
    (req, res) => controller.playTrialVisit(req, res)
  );
  router.get(
    '/api/trial/visit-stickers/:id/file',
    (req, res) => controller.trialVisitFile(req, res)
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
  router.head('/downloads/:fileName', (req, res, next) => controller.download(req, res, next));
  router.get('/downloads/:fileName', (req, res, next) => controller.download(req, res, next));
  router.get(
    '/resource-packs/:id/download',
    (req, res, next) => controller.downloadResourcePack(req, res, next)
  );
  return router;
}

module.exports = { createPublicRouter };
