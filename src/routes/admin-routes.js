const express = require('express');
const { MAX_JSON_BODY } = require('../config/app-config');
const { jsonBody } = require('../middleware/json-body');

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

  router.get('/releases', requireSession, (req, res) => controller.releases(req, res));
  router.post(
    '/releases',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.createUpload(req, res)
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
  router.put(
    '/uploads/:uploadId',
    requireWriteSession,
    (req, res) => controller.receiveUpload(req, res)
  );

  router.get(
    '/activation-codes',
    requireSession,
    (req, res) => controller.activationCodes(req, res)
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
  router.patch(
    '/feedback/:id',
    requireWriteSession,
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.updateFeedback(req, res)
  );

  return router;
}

module.exports = { createAdminRouter };
