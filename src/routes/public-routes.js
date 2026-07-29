const express = require('express');
const { MAX_JSON_BODY } = require('../config/app-config');
const { jsonBody } = require('../middleware/json-body');

function createPublicRouter(controller) {
  const router = express.Router();
  router.get('/healthz', (req, res) => controller.health(req, res));
  router.post('/api/activate', ...jsonBody(4096), (req, res) => controller.activate(req, res));
  router.get('/api/feedback', (req, res) => controller.feedback(req, res));
  router.post(
    '/api/feedback',
    ...jsonBody(MAX_JSON_BODY),
    (req, res) => controller.submitFeedback(req, res)
  );
  router.get('/api/update/latest', (req, res) => controller.latest(req, res));
  router.get('/downloads/:fileName', (req, res, next) => controller.download(req, res, next));
  return router;
}

module.exports = { createPublicRouter };
