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
  return new Promise((resolve, reject) => {
    // Express 5 는 listen 실패(포트 사용 중 등)를 콜백의 err 로 넘긴다
    const server = app.listen(config.port, config.host, (err) => {
      if (err) {
        const msg =
          err.code === 'EADDRINUSE'
            ? `포트 ${config.port} 이 이미 사용 중입니다. 봇이 이미 실행 중인지 확인하세요 (pm2 list). 다른 포트를 쓰려면 .env 의 PORT 변경`
            : err.message;
        return reject(new Error(msg));
      }
      log('server', `대시보드: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
      resolve(server);
    });
  });
}

module.exports = { createApp, start };
