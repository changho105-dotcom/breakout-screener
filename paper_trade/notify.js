// ============================================================
// 매수/매도 발생 시 텔레그램으로 알림 전송.
// TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 환경변수가 없으면 조용히 스킵
// (알림은 부가기능이라 없어도 daily_update.js 본 로직에 영향 없음).
// ============================================================

const fetch = require('node-fetch');

async function notifyTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('[notify] TELEGRAM_BOT_TOKEN/CHAT_ID 없음 - 알림 스킵');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn('[notify] 텔레그램 전송 실패:', res.status, body.slice(0, 200));
    }
  } catch (err) {
    console.warn('[notify] 텔레그램 전송 중 오류:', err.message);
  }
}

module.exports = { notifyTelegram };
