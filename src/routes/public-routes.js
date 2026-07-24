const express = require('express');
const { jsonBody } = require('../middleware/json-body');

function createPublicRouter(controller) {
  const router = express.Router();
  router.get('/healthz', (req, res) => controller.health(req, res));
  router.post('/api/activate', ...jsonBody(4096), (req, res) => controller.activate(req, res));
  router.get('/api/update/latest', (req, res) => controller.latest(req, res));
  router.get('/downloads/:fileName', (req, res, next) => controller.download(req, res, next));
  return router;
}

module.exports = { createPublicRouter };
