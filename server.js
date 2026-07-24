const { createApplication } = require('./src/app');
const { loadConfig } = require('./src/config/app-config');
const { HttpError } = require('./src/errors/http-error');
const { signedManifestPayload } = require('./src/services/release-service');
const { start } = require('./src/start-server');

if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  HttpError,
  createApplication,
  loadConfig,
  signedManifestPayload,
  start
};
