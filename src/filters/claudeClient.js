// Claude 호출 계층
//   cli (기본): 이 PC 에 로그인된 Claude Code CLI(`claude -p`)를 실행해 구독 계정(Pro/Max) 사용량으로 처리
//   api       : ANTHROPIC_API_KEY 로 Messages API 호출 (종량 과금)
// 두 방식 모두 JSON 스키마로 구조화된 결과를 받는다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');

const status = { provider: config.ai.provider, ok: null, at: null, message: null };

function record(ok, message = null) {
  Object.assign(status, { provider: config.ai.provider, ok, at: new Date().toISOString(), message });
}

function getStatus() {
  return { ...status };
}

function enabled() {
  const p = config.ai.provider;
  if (p === 'cli') return true;
  if (p === 'api') return !!config.ai.api.key;
  return false;
}

// ---------- CLI (구독) ----------

// 시스템 프롬프트는 파일로 넘긴다 (명령줄 인코딩/따옴표 문제 회피)
function systemPromptFile(system) {
  const file = path.join(os.tmpdir(), 'trend-alert-bot-system-prompt.txt');
  try {
    if (fs.readFileSync(file, 'utf8') === system) return file;
  } catch {}
  fs.writeFileSync(file, system, 'utf8');
  return file;
}

// Windows 에서 npm 으로 설치한 claude.cmd 는 셸을 거쳐야 실행된다 → 인자를 직접 따옴표 처리
function winQuote(arg) {
  return `"${String(arg).replace(/"/g, '\\"')}"`;
}

function buildCliArgs({ systemFile, schema }) {
  const { model, effort } = config.ai.cli;
  const args = [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--system-prompt-file', systemFile,
    '--tools', '',
    '--no-session-persistence',
    '--strict-mcp-config',
  ];
  if (model) args.push('--model', model);
  if (effort && effort !== 'none' && !/haiku/i.test(model)) args.push('--effort', effort);
  return args;
}

function childEnv() {
  const env = { ...process.env };
  // API 키가 환경에 있으면 CLI 가 구독 대신 API 과금으로 동작하므로 제거
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function runCli(args, input) {
  const { path: cmd, timeoutMs } = config.ai.cli;
  const useShell = process.platform === 'win32' && !/\.exe$/i.test(cmd);
  return new Promise((resolve, reject) => {
    const child = useShell
      ? spawn([winQuote(cmd), ...args.map(winQuote)].join(' '), { shell: true, cwd: os.tmpdir(), env: childEnv(), windowsHide: true })
      : spawn(cmd, args, { cwd: os.tmpdir(), env: childEnv(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude CLI 응답 시간 초과 (${timeoutMs}ms)`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`claude CLI 를 찾을 수 없음 (${cmd}). Claude Code 설치 후 로그인 필요`) : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input, 'utf8');
  });
}

async function callCli({ system, user, schema }) {
  const args = buildCliArgs({ systemFile: systemPromptFile(system), schema });
  const { code, stdout, stderr } = await runCli(args, user);
  let out;
  try {
    out = JSON.parse(stdout);
  } catch {
    throw new Error(`claude CLI 출력 해석 실패 (exit ${code}): ${(stderr || stdout).trim().slice(0, 300)}`);
  }
  if (out.is_error || out.subtype !== 'success') {
    // 로그인 만료, 사용량 한도 초과 등은 result 에 사유가 담겨 온다
    throw new Error(`claude CLI 오류: ${String(out.result || out.subtype || stderr).slice(0, 300)}`);
  }
  if (out.structured_output) return out.structured_output;
  return JSON.parse(out.result);
}

// ---------- API (종량 과금) ----------

let apiClient = null;
async function callApi({ system, user, schema }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const { key, model, effort } = config.ai.api;
  if (!apiClient) apiClient = new Anthropic({ apiKey: key, timeout: 120000, maxRetries: 2 });
  let response;
  try {
    response = await apiClient.beta.messages.create({
      model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: {
        // Haiku 는 effort 파라미터를 지원하지 않음
        ...(effort && effort !== 'none' && !/haiku/.test(model) ? { effort } : {}),
        format: { type: 'json_schema', schema },
      },
      // 안전 분류기 거절 시 서버에서 권장 모델로 자동 재시도
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (e) {
    throw e instanceof Anthropic.APIError ? new Error(`API ${e.status}: ${e.message}`) : e;
  }
  if (response.stop_reason === 'refusal') throw new Error('Claude 가 판정을 거절함 (refusal)');
  if (response.stop_reason === 'max_tokens') throw new Error('응답이 max_tokens 에서 잘림');
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return JSON.parse(text);
}

// { system, user, schema } → 스키마에 맞는 객체
async function complete(req) {
  const p = config.ai.provider;
  try {
    const out = p === 'api' ? await callApi(req) : await callCli(req);
    record(true);
    return out;
  } catch (e) {
    record(false, e.message);
    throw e;
  }
}

module.exports = { complete, enabled, getStatus, buildCliArgs, childEnv, winQuote };
