// プッシュ通知。ntfy / Discord / Slack の Incoming Webhook に対応。
// LINE Notify は 2025-03 で終了したため非対応。LINE に送りたい場合は
// LINE Messaging API を使うか、ntfy の公式アプリ(無料)を使うのが手軽。

/**
 * @param {object} cfg
 * @param {string} title
 * @param {string} message
 */
export async function sendNotification(cfg, title, message) {
  const n = cfg.notify || {};
  const type = n.type || 'none';

  if (type === 'none') {
    console.log(`[notify:none] ${title} / ${message}`);
    return;
  }

  if (type === 'ntfy') {
    if (!n.ntfyTopic) throw new Error('config.notify.ntfyTopic が未設定です');
    const res = await fetch(n.ntfyTopic, {
      method: 'POST',
      headers: { Title: encodeHeader(title), Priority: 'high', Tags: 'bus' },
      body: message,
    });
    if (!res.ok) throw new Error(`ntfy 送信失敗: ${res.status}`);
    return;
  }

  if (type === 'discord') {
    if (!n.webhookUrl) throw new Error('config.notify.webhookUrl が未設定です');
    const res = await fetch(n.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `**${title}**\n${message}` }),
    });
    if (!res.ok) throw new Error(`Discord 送信失敗: ${res.status}`);
    return;
  }

  if (type === 'slack') {
    if (!n.webhookUrl) throw new Error('config.notify.webhookUrl が未設定です');
    const res = await fetch(n.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `*${title}*\n${message}` }),
    });
    if (!res.ok) throw new Error(`Slack 送信失敗: ${res.status}`);
    return;
  }

  throw new Error(`未知の notify.type: ${type}`);
}

// ntfy のヘッダは ASCII 以外を素で送れないので RFC2047 風にエンコード
function encodeHeader(s) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf-8').toString('base64') + '?=';
}
