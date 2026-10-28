/**
 * create-app.js — common Express setup shared by all services so each
 * service file only contains its own routes and business logic.
 */
const express = require('express');
const { requestContext, notFound, errorHandler } = require('./middleware');
const log = require('./logger');

function createApp(registerRoutes) {
  const app = express();
  app.get('/health', (req, res) => res.json({ status: 'ok' })); // not traced (see tracing.js)
  app.use(express.json());
  app.use(requestContext);
  registerRoutes(app);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

function start(app, defaultPort) {
  const port = Number(process.env.PORT || defaultPort);
  app.listen(port, () => log.info(`${process.env.OTEL_SERVICE_NAME} listening on :${port}`));
}

module.exports = { createApp, start };
