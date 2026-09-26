#!/usr/bin/env node
// 테스트용 가짜 claude CLI: 인자/환경을 기록하고 입력 항목마다 결과를 돌려준다
const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  if (process.env.FAKE_CLAUDE_LOG) {
    fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), hasApiKey: 'ANTHROPIC_API_KEY' in process.env, cwd: process.cwd() }));
  }
  if (process.env.FAKE_CLAUDE_MODE === 'error') {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your usage limit" }));
    return;
  }
  const items = JSON.parse(input.slice(input.indexOf('\n\n') + 2));
  const results = items.map((it) => ({
    id: it.id,
    topic: it.type === 'headline' ? '독감 백신' : it.text,
    label: /열애/.test(it.text) ? 'exclude' : 'info',
  }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { results } }));
});
