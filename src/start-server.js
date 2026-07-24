const http = require('node:http');
const { createApplication } = require('./app');

function configureServer(server) {
  server.headersTimeout = 20_000;
  server.requestTimeout = 20 * 60 * 1000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
}

async function listen(server, port, host) {
  configureServer(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function start() {
  const application = await createApplication();
  const server = http.createServer(application.handler);
  await listen(server, application.config.httpPort, application.config.httpHost);
  console.log(
    `deskpet-update http listening on ${application.config.httpHost}:${application.config.httpPort}`
  );

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    application.close();
    await new Promise((resolve) => server.close(resolve));
  };
  process.once('SIGTERM', () => shutdown().finally(() => process.exit(0)));
  process.once('SIGINT', () => shutdown().finally(() => process.exit(0)));
  return { application, server, shutdown };
}

module.exports = { configureServer, listen, start };
