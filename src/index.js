// 진입점: DB 초기화 → 대시보드 서버 + 텔레그램 봇 + 스케줄러 동시 기동
const db = require('./db/db');
const server = require('./server/app');
const scheduler = require('./scheduler');
const telegram = require('./notify/telegramBot');
const { log } = require('./utils');

async function main() {
  db.init();
  const http = await server.start();
  telegram.start({ statusProvider: scheduler.statusText });
  scheduler.start();

  const shutdown = async (sig) => {
    log('main', `${sig} 수신, 종료 중...`);
    scheduler.stop();
    http.close();
    await telegram.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
