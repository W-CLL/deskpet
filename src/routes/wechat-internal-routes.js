const express = require('express');
const { MAX_JSON_BODY } = require('../config/app-config');
const { jsonBody } = require('../middleware/json-body');

function createWechatInternalRouter({ grantService, authenticate }) {
  const router = express.Router();
  const requireSignature = (req, res, next) => authenticate(req, res, next);

  router.post(
    '/grants',
    ...jsonBody(MAX_JSON_BODY),
    requireSignature,
    (req, res) => res.status(201).json(grantService.create(req.body))
  );
  router.get(
    '/grants/:grantId',
    requireSignature,
    (req, res) => res.status(200).json(grantService.get(req.params.grantId))
  );
  router.post(
    '/grants/:grantId/revoke',
    ...jsonBody(MAX_JSON_BODY),
    requireSignature,
    (req, res) => res.status(200).json(grantService.revoke(req.params.grantId, req.body?.reason))
  );

  return router;
}

module.exports = { createWechatInternalRouter };
