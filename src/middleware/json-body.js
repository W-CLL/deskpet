const express = require('express');
const { HttpError } = require('../errors/http-error');

function jsonBody(limit) {
  return [
    function requireJsonContentType(req, _res, next) {
      if (!req.is('application/json')) {
        return next(new HttpError(415, '请求必须使用 application/json', 'CONTENT_TYPE_REQUIRED'));
      }
      return next();
    },
    express.json({ limit, strict: true })
  ];
}

module.exports = { jsonBody };
