const path = require('path');
const express = require('express');
const config = require('../config');
const api = require('./routes/api');
const { log } = require('../utils');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  app.use(express.static(path.join(config.root, 'public')));
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });
  return app;
}

function start() {
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(config.port, config.host, () => {
      log('server', `대시보드: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
      resolve(server);
    });
  });
}

module.exports = { createApp, start };
