const express = require('express');
const { MAX_JSON_BODY } = require('../config/app-config');
const { jsonBody } = require('../middleware/json-body');
const { MAX_GIF_BYTES } = require('../services/companion-service');

const MAX_CONTENT_IMPORT_BODY = 2 * 1024 * 1024;

function createAuthMiddleware(authService, write = false) {
  return function authenticateAdmin(req, res, next) {
    try {
      res.locals.adminSession = write
        ? authService.requireWriteSession(req)
        : authService.requireSession(req);
      next();
    } catch (error) {
      next(error);
    }
  };
}

function createAdminRouter({ controller, authService }) {
  const router = express.Router();
  const requireSession = createAuthMiddleware(authService);
  const requireWriteSession = createAuthMiddleware(authService, true);

  router.post('/login', ...jsonBody(MAX_JSON_BODY), (req, res) => controller.login(req, res));
  router.get('/session', (req, res) => controller.session(req, res));
  router.post('/logout', requireWriteSession, (req, res) => controller.logout(req, res));

  router.get('/overview', requireSession, (req, res, next) => {
    Promise.resolve(controller.overview(req, res)).catch(next);
  });
  router.get('/releases', requireSession, (req, res) => controller.releases(req, res));
  router.get('/site-settings', requireSession, (req, res) => controller.siteSettings(req, res));
  router.put(
    '/site-settings',
    requireWriteSession,
    ...jsonBody(512 * 1024),
    (req, res) => controller.updateSiteSettings(req, res)
  );
  router.post(
    '/releases',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.createUpload(req, res)
  );
  router.post(
    '/releases/:platform/:architecture/:version/oss-sync',
    requireWriteSession,
    (req, res) => controller.syncOss(req, res)
  );
  router.post(
    '/releases/:platform/:architecture/:version/publish',
    requireWriteSession,
    (req, res) => controller.publish(req, res)
  );
  router.delete(
    '/releases/:platform/:architecture/:version',
    requireWriteSession,
    (req, res) => controller.delete(req, res)
  );
  router.patch(
    '/releases/:platform/:architecture/:version/notes',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.updateReleaseNotes(req, res)
  );
  router.put(
    '/uploads/:uploadId',
    requireWriteSession,
    (req, res) => controller.receiveUpload(req, res)
  );
  router.get('/resource-packs', requireSession, (req, res) => controller.resourcePacks(req, res));
  router.post(
    '/resource-packs',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.createResourcePackUpload(req, res)
  );
  router.put(
    '/resource-pack-uploads/:uploadId',
    requireWriteSession,
    (req, res) => controller.receiveResourcePackUpload(req, res)
  );
  router.delete(
    '/resource-packs/:id',
    requireWriteSession,
    (req, res) => controller.deleteResourcePack(req, res)
  );
  router.patch(
    '/resource-packs/:id', requireWriteSession, ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.updateResourcePack(req, res)
  );
  router.get('/visit-stickers', requireSession, (req, res) => controller.visitStickers(req, res));
  router.post(
    '/visit-stickers',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.createVisitStickerUpload(req, res)
  );
  router.put(
    '/visit-sticker-uploads/:uploadId',
    requireWriteSession,
    (req, res) => controller.receiveVisitStickerUpload(req, res)
  );
  router.delete(
    '/visit-stickers/packs/:id',
    requireWriteSession,
    (req, res) => controller.deleteVisitStickerPack(req, res)
  );
  router.delete(
    '/visit-stickers/:id',
    requireWriteSession,
    (req, res) => controller.deleteVisitSticker(req, res)
  );

  router.get(
    '/pet-market/payment-settings',
    requireSession,
    (req, res) => controller.petMarketPaymentSettings(req, res)
  );
  router.put(
    '/pet-market/payment-settings',
    requireWriteSession,
    ...jsonBody(512 * 1024),
    (req, res) => controller.savePetMarketPaymentSettings(req, res)
  );
  router.get(
    '/pet-market/orders',
    requireSession,
    (req, res) => controller.petMarketOrders(req, res)
  );
  router.post(
    '/pet-market/orders/:id/confirm-payment',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.petMarketConfirmOrderPayment(req, res)
  );
  router.get(
    '/pet-market/products',
    requireSession,
    (req, res) => controller.petMarketProducts(req, res)
  );
  router.post(
    '/pet-market/products',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.createPetMarketProduct(req, res)
  );
  router.patch(
    '/pet-market/products/:id',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.updatePetMarketProduct(req, res)
  );
  router.post(
    '/pet-market/products/:id/versions',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.createPetMarketVersionUpload(req, res)
  );
  router.put(
    '/pet-market/product-uploads/:uploadId',
    requireWriteSession,
    (req, res) => controller.receivePetMarketVersionUpload(req, res)
  );
  router.get(
    '/pet-market/payment-events',
    requireSession,
    (req, res) => controller.petMarketPaymentEvents(req, res)
  );
  router.post(
    '/pet-market/payment-events/:id/reparse',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.petMarketReparsePaymentEvent(req, res)
  );
  router.post(
    '/pet-market/payment-events/:id/confirm',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.petMarketConfirmPaymentEvent(req, res)
  );

  router.get(
    '/activation-codes',
    requireSession,
    (req, res) => controller.activationCodes(req, res)
  );
  router.post(
    '/devices/activate',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.activateDevice(req, res)
  );
  router.post(
    '/activation-codes',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.createActivationCodes(req, res)
  );
  router.post(
    '/activation-codes/:id/reveal',
    requireWriteSession,
    (req, res) => controller.revealActivationCode(req, res)
  );
  router.post(
    '/licenses/:id/revoke',
    requireWriteSession,
    (req, res) => controller.revokeLicense(req, res)
  );
  router.post(
    '/accounts/:id/rebind-code',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.createRebindCode(req, res)
  );

  router.get('/feedback', requireSession, (req, res) => controller.feedback(req, res));
  router.get('/uninstalls', requireSession, (req, res) => controller.uninstalls(req, res));
  router.get(
    '/uninstalls/:installationId',
    requireSession,
    (req, res) => controller.uninstallDetails(req, res)
  );
  router.get('/interactions', requireSession, (req, res) => controller.interactions(req, res));
  router.get('/companions', requireSession, (req, res) => controller.companions(req, res));
  router.post(
    '/companions/deliveries',
    requireWriteSession,
    express.raw({ type: 'image/gif', limit: MAX_GIF_BYTES }),
    (req, res) => controller.sendCompanionDelivery(req, res)
  );
  router.get('/analytics', requireSession, (req, res) => controller.analytics(req, res));
  router.get('/content', requireSession, (req, res) => controller.content(req, res));
  router.post(
    '/content',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.createContent(req, res)
  );
  router.post(
    '/content/import',
    requireWriteSession,
    ...jsonBody(MAX_CONTENT_IMPORT_BODY),
    (req, res) => controller.importContent(req, res)
  );
  router.patch(
    '/content/bulk-disable',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.bulkDisableContent(req, res)
  );
  router.patch(
    '/content/:id',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.updateContent(req, res)
  );
  router.delete(
    '/content/:id',
    requireWriteSession,
    (req, res) => controller.disableContent(req, res)
  );
  router.patch(
    '/feedback/:id',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.updateFeedback(req, res)
  );

  return router;
}

module.exports = { createAdminRouter };
