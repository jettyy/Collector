// 모든 수집기를 병렬 실행. 하나가 실패해도 나머지 결과는 살린다.
const config = require('../config');
const { log, warn } = require('../utils');

const ALL = {
  signalbz: require('./signalbz'),
  googleTrends: require('./googleTrends'),
  naverNews: require('./naverNews'),
  naverDatalab: require('./naverDatalab'),
};

async function collectAll(names = config.collectors) {
  const errors = [];
  const results = await Promise.all(
    names.map(async (name) => {
      const c = ALL[name];
      if (!c) {
        errors.push({ stage: 'collect', source: name, message: '알 수 없는 수집기' });
        return [];
      }
      const t0 = Date.now();
      try {
        const items = await c.collect();
        log('collect', `${name}: ${items.length}건 (${Date.now() - t0}ms)`);
        return items;
      } catch (e) {
        warn('collect', `${name} 실패: ${e.message}`);
        errors.push({ stage: 'collect', source: name, message: e.message });
        return [];
      }
    }),
  );
  return { items: results.flat(), errors };
}

module.exports = { collectAll, ALL };
