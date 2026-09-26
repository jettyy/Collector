// 단계별 동작 확인용 CLI
//   node src/cli.js collect [naverNews|googleTrends|signalbz|naverDatalab]  → 수집 결과만 출력
//   node src/cli.js run [--dry] [--only=naverNews,googleTrends]           → 전체 파이프라인 1회 실행
const db = require('./db/db');
const config = require('./config');

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = Object.fromEntries(
    rest.filter((a) => a.startsWith('--')).map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v === undefined ? true : v];
    }),
  );
  const args = rest.filter((a) => !a.startsWith('--'));

  if (cmd === 'collect') {
    const { collectAll } = require('./collectors');
    const names = args.length ? args : config.collectors;
    const { items, errors } = await collectAll(names);
    for (const it of items) {
      const meta = it.rawMeta || {};
      console.log(`${it.source.padEnd(13)} #${String(it.rank ?? '-').padEnd(3)} ${it.keyword}${meta.section ? `  [${meta.section}]` : ''}`);
    }
    console.log(`\n총 ${items.length}건${errors.length ? `, 오류 ${errors.length}: ${JSON.stringify(errors)}` : ''}`);
    return;
  }

  if (cmd === 'run') {
    db.init();
    const scheduler = require('./scheduler');
    const telegram = require('./notify/telegramBot');
    if (!flags.dry) telegram.start();
    const collectors = typeof flags.only === 'string' ? flags.only.split(',') : undefined;
    const r = await scheduler.runCycle({ dryRun: !!flags.dry, collectors });
    if (r) {
      console.log('\n=== 정보성 키워드 (점수순) ===');
      for (const g of r.groups.filter((x) => x.label === '정보성').slice(0, 40)) {
        console.log(`${String(g.score).padStart(5)}  ${g.keyword}  (${g.sources.join(', ')}; ${g.reason || ''})`);
      }
      console.log('\n=== 제외 ===');
      console.log(r.groups.filter((x) => x.label === '제외').map((g) => `${g.keyword}(${g.reason || ''})`).join(', ') || '-');
    }
    await telegram.stop();
    db.close();
    return;
  }

  console.log('사용법:\n  node src/cli.js collect [수집기이름...]\n  node src/cli.js run [--dry] [--only=naverNews,googleTrends]');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
