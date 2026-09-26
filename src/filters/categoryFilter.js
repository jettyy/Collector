// 1차 필터: 네이버 뉴스 섹션 메타데이터로 판정
//   exclude → 연예/스포츠/정치(옵션) 위주 그룹
//   include → 경제/생활문화/IT 위주 그룹 (AI 라벨 없이 정보성 확정)
//   review  → 사회/세계 또는 섹션 정보 없음 → aiClassifier 가 판정
const config = require('../config');

const INCLUDE = new Set(['경제', '생활문화', 'IT']);

function excludedSections() {
  const s = new Set(['연예', '스포츠']);
  if (config.filter.excludePolitics) s.add('정치');
  if (config.filter.excludeWorld) s.add('세계');
  return s;
}

function sectionsOf(group) {
  return group.items.map((it) => it.rawMeta && it.rawMeta.section).filter(Boolean);
}

function evaluate(group) {
  const sections = sectionsOf(group);
  if (!sections.length) return { decision: 'review', reason: null };

  const EXCLUDE = excludedSections();
  const count = (set) => sections.filter((s) => set.has(s)).length;
  const excl = count(EXCLUDE);
  const incl = count(INCLUDE);
  const other = sections.length - excl - incl;
  const top = mostCommon(sections);

  // 구글/시그널 등 다른 출처가 있는 그룹은 우연히 매칭된 기사 1건으로 제외하지 않는다
  const hasNonHeadline = group.items.some((it) => it.rawMeta.kind !== 'headline');
  const minExcl = hasNonHeadline ? 2 : 1;

  if (excl >= minExcl && excl > incl + other) return { decision: 'exclude', reason: `category:${mostCommon(sections.filter((s) => EXCLUDE.has(s)))}`, category: top };
  if (incl > 0 && incl >= excl) return { decision: 'include', reason: `category:${mostCommon(sections.filter((s) => INCLUDE.has(s)))}`, category: top };
  return { decision: 'review', reason: null, category: top };
}

function mostCommon(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// groups 에 categoryDecision/label/reason/category 를 채운다
function apply(groups) {
  for (const g of groups) {
    const r = evaluate(g);
    g.categoryDecision = r.decision;
    g.category = r.category || null;
    if (r.decision === 'exclude') {
      g.label = '제외';
      g.reason = r.reason;
    } else if (r.decision === 'include') {
      g.label = '정보성';
      g.reason = r.reason;
    }
  }
  return groups;
}

module.exports = { apply, evaluate, INCLUDE, excludedSections };
