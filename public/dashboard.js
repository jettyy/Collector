(() => {
  const $ = (sel) => document.querySelector(sel);
  const STORE_KEY = 'trend-dashboard-filters';

  const state = {
    hours: 24,
    label: '정보성',
    sources: [],
    notifiedOnly: false,
    search: '',
    meta: null,
    keywords: [],
  };
  let chart = null;

  // ---------- 필터 상태 저장 ----------
  function loadFilters() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      Object.assign(state, {
        hours: saved.hours ?? state.hours,
        label: saved.label ?? state.label,
        sources: Array.isArray(saved.sources) ? saved.sources : [],
        notifiedOnly: !!saved.notifiedOnly,
      });
    } catch {}
  }
  function saveFilters() {
    try {
      const { hours, label, sources, notifiedOnly } = state;
      localStorage.setItem(STORE_KEY, JSON.stringify({ hours, label, sources, notifiedOnly }));
    } catch {}
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtTime = (iso) =>
    new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const ago = (iso) => {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 1) return '방금';
    if (m < 60) return `${m}분 전`;
    if (m < 60 * 24) return `${Math.floor(m / 60)}시간 전`;
    return `${Math.floor(m / 1440)}일 전`;
  };
  const srcName = (s) => (state.meta && state.meta.sources[s]) || s;

  // ---------- 렌더링 ----------
  function renderFlags() {
    const m = state.meta;
    const ai = m.ai || {};
    const aiName = ai.provider === 'api' ? 'AI 분류(API)' : ai.provider === 'cli' ? 'AI 분류(구독)' : 'AI 분류';
    const aiTitle = !ai.enabled ? '꺼짐 - 휴리스틱 분류 중' : ai.ok === false ? `최근 호출 실패: ${ai.message}` : ai.ok ? '정상' : '아직 호출 전';
    const flags = [
      ['텔레그램', m.telegram, m.telegram ? '설정됨' : '.env 설정 필요'],
      [aiName, ai.enabled && ai.ok !== false, aiTitle],
      ['네이버 검색', m.naverSearch, m.naverSearch ? '설정됨' : '.env 설정 필요'],
    ];
    $('#flags').innerHTML = flags
      .map(([name, on, title]) => `<span class="flag ${on ? '' : 'off'}" title="${esc(title)}">${esc(name)}</span>`)
      .join('');
  }

  function renderSourceToggles() {
    const box = $('#sourceToggles');
    box.innerHTML = Object.keys(state.meta.sources)
      .map((s) => `<button type="button" class="chip" data-source="${s}" aria-pressed="${state.sources.includes(s)}">${esc(srcName(s))}</button>`)
      .join('');
    box.querySelectorAll('.chip').forEach((btn) =>
      btn.addEventListener('click', () => {
        const s = btn.dataset.source;
        state.sources = state.sources.includes(s) ? state.sources.filter((x) => x !== s) : [...state.sources, s];
        btn.setAttribute('aria-pressed', state.sources.includes(s));
        saveFilters();
        loadKeywords();
      }),
    );
  }

  function renderKeywords() {
    const q = state.search.trim().toLowerCase();
    const list = q ? state.keywords.filter((k) => k.keyword.toLowerCase().includes(q)) : state.keywords;
    $('#kwCount').textContent = `${list.length}개`;
    $('#empty').classList.toggle('hidden', list.length > 0);
    $('#keywordList').innerHTML = list
      .map((k) => {
        const statusTag =
          k.status === 'forwarded' ? '<span class="tag status-forwarded">블로그봇 전달</span>'
          : k.status === 'ignored' ? '<span class="tag status-ignored">무시</span>'
          : '';
        return `<li class="kw ${k.published ? 'published' : ''}" data-id="${k.id}">
          <div class="kw-main">
            <span class="kw-title">${esc(k.keyword)}</span>
            <div class="kw-meta">
              <span class="tag ${k.label === '정보성' ? 'info' : ''}">${esc(k.label || '-')}</span>
              ${k.category ? `<span class="tag">${esc(k.category)}</span>` : ''}
              ${k.sources.map((s) => `<span class="tag">${esc(srcName(s))}</span>`).join('')}
              ${k.notified ? '<span class="tag notified">🔔 알림</span>' : ''}
              ${statusTag}
              <span title="${esc(fmtTime(k.detected_at))} 최초 감지 · ${k.seen_count}회 연속 감지">${ago(k.detected_at)} · ${k.seen_count}회</span>
              ${k.reason ? `<span class="muted">${esc(k.reason)}</span>` : ''}
            </div>
            ${
              k.articles.length
                ? `<ul class="kw-articles">${k.articles
                    .slice(0, 3)
                    .map((a) => `<li><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a> <span class="kw-url">(${esc(a.url)})</span></li>`)
                    .join('')}</ul>`
                : ''
            }
          </div>
          <div class="kw-side">
            <span class="score" title="출처 교차 가중치 점수">${k.score ?? '-'}</span>
            <label class="pub"><input type="checkbox" class="pub-check" ${k.published ? 'checked' : ''}/> 발행 완료</label>
          </div>
        </li>`;
      })
      .join('');
  }

  function renderTiles(hourly, runs) {
    const sum = (key) => hourly.reduce((a, b) => a + b[key], 0);
    $('#tInfo').textContent = sum('info');
    $('#tNotified').textContent = sum('notified');
    $('#tPublished').textContent = state.keywords.filter((k) => k.published).length;
    const last = runs[0];
    $('#tErrors').textContent = last ? last.errors.length : '–';
    $('#tErrors').title = last ? last.errors.map((e) => `${e.source || e.stage}: ${e.message}`).join('\n') : '';
    $('#lastRun').textContent = last
      ? `최근 실행 ${ago(last.started_at)}${last.finished_at ? '' : ' (진행 중)'} · ${state.meta.cron}`
      : '아직 실행 기록 없음';
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function renderChart(hourly) {
    const labels = hourly.map((b) => {
      const d = new Date(b.hour);
      return state.hours > 24 ? `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}시` : `${d.getHours()}시`;
    });
    // 표 보기 (접근성용)
    $('#hourlyTable tbody').innerHTML = hourly
      .slice()
      .reverse()
      .map((b, i) => `<tr><td>${esc(labels[hourly.length - 1 - i])}</td><td>${b.info}</td><td>${b.excluded}</td><td>${b.notified}</td></tr>`)
      .join('');

    if (!window.Chart) return;
    const text2 = cssVar('--text-2');
    const grid = cssVar('--border');
    const surface = cssVar('--surface');
    const datasets = [
      { label: '정보성', data: hourly.map((b) => b.info), backgroundColor: cssVar('--series-info') },
      { label: '제외', data: hourly.map((b) => b.excluded), backgroundColor: cssVar('--series-excl') },
    ].map((d) => ({ ...d, borderColor: surface, borderWidth: { top: 2 }, borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 22 }));

    if (chart) chart.destroy();
    chart = new Chart($('#hourlyChart'), {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', align: 'end', labels: { color: text2, boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2 } },
          tooltip: {
            callbacks: {
              footer: (items) => `합계 ${items.reduce((a, it) => a + it.parsed.y, 0)}`,
            },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: text2, maxRotation: 0, autoSkipPadding: 12 } },
          y: { stacked: true, beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: text2, precision: 0 } },
        },
      },
    });
  }

  function renderRuns(runs) {
    $('#runs').innerHTML = runs
      .map((r) => {
        const ms = r.finished_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : null;
        const errs = r.errors.map((e) => `${e.source || e.stage}: ${e.message}`).join('\n');
        return `<tr><td>${r.id}</td><td>${esc(fmtTime(r.started_at))}</td><td>${ms === null ? '진행 중' : `${(ms / 1000).toFixed(1)}s`}</td>
          <td>${r.collected}</td><td>${r.candidates}</td><td>${r.passed}</td><td>${r.new_keywords}</td><td>${r.notified}</td>
          <td title="${esc(errs)}">${r.errors.length ? `⚠ ${r.errors.length}` : '-'}</td></tr>`;
      })
      .join('');
  }

  // ---------- 데이터 로드 ----------
  async function loadKeywords() {
    const params = new URLSearchParams({ hours: state.hours, limit: 500 });
    if (state.label) params.set('label', state.label);
    if (state.sources.length) params.set('sources', state.sources.join(','));
    if (state.notifiedOnly) params.set('notified', '1');
    state.keywords = await api(`/api/keywords?${params}`);
    renderKeywords();
  }

  async function refresh() {
    try {
      const [hourly, runs, meta] = await Promise.all([
        api(`/api/stats/hourly?hours=${state.hours}`),
        api('/api/runs?limit=30'),
        api('/api/meta'),
        loadKeywords(),
      ]);
      state.meta = meta;
      renderFlags();
      renderTiles(hourly, runs);
      renderChart(hourly);
      renderRuns(runs);
    } catch (e) {
      $('#lastRun').textContent = `불러오기 실패: ${e.message}`;
    }
  }

  // ---------- 이벤트 ----------
  function bind() {
    $('#hours').value = String(state.hours);
    $('#hours').addEventListener('change', (e) => {
      state.hours = Number(e.target.value);
      saveFilters();
      refresh();
    });
    document.querySelectorAll('.segmented button').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.label === state.label);
      btn.addEventListener('click', () => {
        state.label = btn.dataset.label;
        document.querySelectorAll('.segmented button').forEach((b) => b.classList.toggle('on', b === btn));
        saveFilters();
        loadKeywords();
      });
    });
    $('#notifiedOnly').checked = state.notifiedOnly;
    $('#notifiedOnly').addEventListener('change', (e) => {
      state.notifiedOnly = e.target.checked;
      saveFilters();
      loadKeywords();
    });
    $('#search').addEventListener('input', (e) => {
      state.search = e.target.value;
      renderKeywords();
    });
    $('#keywordList').addEventListener('change', async (e) => {
      if (!e.target.classList.contains('pub-check')) return;
      const li = e.target.closest('.kw');
      const id = Number(li.dataset.id);
      const published = e.target.checked;
      try {
        await api(`/api/keywords/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ published }),
        });
        const k = state.keywords.find((x) => x.id === id);
        if (k) k.published = published;
        li.classList.toggle('published', published);
        $('#tPublished').textContent = state.keywords.filter((x) => x.published).length;
      } catch (err) {
        e.target.checked = !published;
        alert(`저장 실패: ${err.message}`);
      }
    });
    $('#toggleTable').addEventListener('click', () => {
      const hidden = $('#hourlyTable').classList.toggle('hidden');
      $('.chart-wrap').classList.toggle('hidden', !hidden);
      $('#toggleTable').textContent = hidden ? '표로 보기' : '그래프 보기';
    });
    $('#runNow').addEventListener('click', async () => {
      const btn = $('#runNow');
      btn.disabled = true;
      btn.textContent = '수집 중…';
      try {
        await api('/api/run', { method: 'POST' });
      } catch {}
      // 한 주기는 보통 수십 초. 완료될 때까지 5초 간격으로 확인
      const poll = setInterval(async () => {
        const meta = await api('/api/meta').catch(() => null);
        if (meta && !meta.running) {
          clearInterval(poll);
          btn.disabled = false;
          btn.textContent = '지금 수집';
          refresh();
        }
      }, 5000);
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => refresh());
  }

  async function init() {
    loadFilters();
    state.meta = await api('/api/meta');
    state.sources = state.sources.filter((s) => state.meta.sources[s]);
    renderFlags();
    renderSourceToggles();
    bind();
    await refresh();
    setInterval(refresh, 60 * 1000);
  }

  init().catch((e) => {
    $('#lastRun').textContent = `초기화 실패: ${e.message}`;
  });
})();
