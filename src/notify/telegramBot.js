// 텔레그램 알림 발송 + 인라인 버튼 콜백 처리 (node-telegram-bot-api v2)
//  [📝 블로그봇에 전달] → BLOG_BOT_CHATS 방에 "주제: OOO" 메시지 발송
//  [🙈 무시]            → 대시보드에 무시 상태로 표시
const { Bot } = require('node-telegram-bot-api');
const config = require('../config');
const db = require('../db/db');
const { SOURCE_LABELS } = require('../scoring/scorer');
const { escapeHtml, log, warn } = require('../utils');

const FORWARD_TEMPLATE = process.env.FORWARD_TEMPLATE || '주제: {keyword}';

let bot = null;
let pollingPromise = null;

function enabled() {
  return !!(config.telegram.token && config.telegram.chatId);
}

function sourceText(sources) {
  const names = sources.map((s) => SOURCE_LABELS[s] || s);
  return sources.length > 1 ? `${names.join(', ')} (교차 ${sources.length}건)` : names.join(', ');
}

function formatMessage(g) {
  const lines = [
    `🔥 <b>신규 트렌드: ${escapeHtml(g.keyword)}</b>`,
    `출처: ${escapeHtml(sourceText(g.sources || []))}`,
    `점수: ${g.score}${g.category ? ` · 분류: ${escapeHtml(g.category)}` : ''}${g.isNew === false ? ' · 교차 확인으로 승격' : ''}`,
  ];
  const arts = (g.articles || []).slice(0, config.naver.articlesPerKeyword);
  if (arts.length) {
    lines.push('', '관련기사:');
    for (const a of arts) lines.push(`• <a href="${escapeHtml(a.url)}">${escapeHtml(a.title)}</a>`);
  }
  return lines.join('\n');
}

function buildKeyboard(id) {
  const chats = config.telegram.blogChats;
  const rows = [];
  if (chats.length === 1) {
    rows.push([{ text: '📝 블로그봇에 전달', callback_data: `fwd:${id}:0` }]);
  } else if (chats.length > 1) {
    rows.push(chats.map((c, i) => ({ text: `📝 ${c.name}`, callback_data: `fwd:${id}:${i}` })));
    rows.push([{ text: '📝 전체 전달', callback_data: `fwd:${id}:all` }]);
  }
  rows.push([{ text: '🙈 무시', callback_data: `ign:${id}` }]);
  return { inline_keyboard: rows };
}

function statusKeyboard(text) {
  return { inline_keyboard: [[{ text, callback_data: 'noop' }]] };
}

async function sendAlert(g) {
  if (!bot) throw new Error('텔레그램 봇이 초기화되지 않음');
  await bot.api.sendMessage({
    chat_id: config.telegram.chatId,
    text: formatMessage(g),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: buildKeyboard(g.id),
  });
}

// 알림 큐 발송. 성공한 항목은 DB 에 notified 로 기록
async function sendAlerts(queue) {
  const errors = [];
  let sent = 0;
  for (const g of queue) {
    try {
      await sendAlert(g);
      db.markNotified(g.id);
      sent++;
    } catch (e) {
      warn('telegram', `발송 실패 (${g.keyword}): ${e.message}`);
      errors.push({ stage: 'telegram', keyword: g.keyword, message: e.message });
    }
  }
  return { sent, errors };
}

async function forwardTopic(keyword, targets) {
  const text = FORWARD_TEMPLATE.replace('{keyword}', keyword);
  for (const t of targets) await bot.api.sendMessage({ chat_id: t.chatId, text });
}

async function handleCallback(ctx) {
  const q = ctx.callbackQuery;
  const data = (q && q.data) || '';
  const msg = q && q.message;
  if (!msg || String(msg.chat.id) !== String(config.telegram.chatId)) {
    await ctx.answerCallbackQuery({ text: '권한 없음' });
    return;
  }
  if (data === 'noop') {
    await ctx.answerCallbackQuery();
    return;
  }

  const [action, idStr, target] = data.split(':');
  const kw = db.getKeyword(Number(idStr));
  if (!kw) {
    await ctx.answerCallbackQuery({ text: '키워드를 찾을 수 없음 (DB 정리됨?)' });
    return;
  }

  let status;
  if (action === 'fwd') {
    const chats = config.telegram.blogChats;
    const targets = target === 'all' ? chats : [chats[Number(target)]].filter(Boolean);
    if (!targets.length) {
      await ctx.answerCallbackQuery({ text: '전달할 방이 설정되지 않음 (BLOG_BOT_CHATS)' });
      return;
    }
    try {
      await forwardTopic(kw.keyword, targets);
    } catch (e) {
      await ctx.answerCallbackQuery({ text: `전달 실패: ${e.message}`.slice(0, 190), show_alert: true });
      return;
    }
    db.setStatus(kw.id, 'forwarded');
    status = `✅ ${targets.map((t) => t.name).join(', ')} 전달됨`;
  } else if (action === 'ign') {
    db.setStatus(kw.id, 'ignored');
    status = '🙈 무시함';
  } else {
    await ctx.answerCallbackQuery();
    return;
  }

  await ctx.answerCallbackQuery({ text: status });
  try {
    await bot.api.editMessageReplyMarkup({ chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: statusKeyboard(status) });
  } catch (e) {
    warn('telegram', `버튼 갱신 실패: ${e.message}`);
  }
}

// statusProvider: () => 문자열 (최근 실행 요약). /status 명령에 사용
function start({ statusProvider } = {}) {
  if (!config.telegram.token) {
    warn('telegram', 'TELEGRAM_BOT_TOKEN 이 없어 알림을 끕니다 (대시보드/수집은 계속 동작)');
    return null;
  }
  // chat id 가 없어도 봇은 띄운다: 알림 받을 방에서 /chatid 를 보내 번호를 확인하게 하기 위함
  if (!config.telegram.chatId) {
    warn('telegram', 'TELEGRAM_CHAT_ID 가 없어 알림은 꺼져 있습니다. 알림 받을 방에서 봇에게 /chatid 를 보내 번호를 확인하세요');
  }
  bot = new Bot(config.telegram.token, config.telegram.apiRoot ? { apiRoot: config.telegram.apiRoot } : undefined);
  bot.on('callback_query', handleCallback);
  bot.command('status', async (ctx) => {
    if (String(ctx.chatId) !== String(config.telegram.chatId)) return;
    await ctx.reply(statusProvider ? statusProvider() : '실행 중');
  });
  bot.command('chatid', (ctx) => ctx.reply(`이 방의 chat id: ${ctx.chatId}`));
  bot.catch((err) => warn('telegram', `핸들러 오류: ${err && err.message}`));

  if (config.telegram.polling) {
    pollingPromise = bot
      .startPolling(undefined, {
        allowedUpdates: ['message', 'callback_query'],
        onError: (err) => warn('telegram', `폴링 오류(재시도): ${err && err.message}`),
      })
      .catch((err) => warn('telegram', `폴링 중단: ${err && err.message}`));
    log('telegram', '봇 폴링 시작 (버튼 콜백 수신)');
  }
  return bot;
}

async function stop() {
  if (bot && bot.isRunning()) bot.stop();
  if (pollingPromise) await pollingPromise;
  bot = null;
}

module.exports = { start, stop, enabled, sendAlerts, formatMessage, buildKeyboard, handleCallback, sourceText };
