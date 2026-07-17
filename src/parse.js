// 接近情報ページの表示テキストから、狙った便のカードを選び出して解釈する。
//
// 実際のカード表示(例):
//   内海線[17]
//   新地中華街ゆき [大波止経由]
//   定刻 06:48   約1分遅れ   06:49予測
//   あと約 18 分で到着
//   18個前のバス停から接近中
//
// この画面は「いま実際に接近中のバス」だけを、かなり手前(十数個前)から表示する。
// そこで各カードから 定刻 / 予測 / 遅れ / あと◯分 / ◯個前 を取り出し、
// 行き先(立神)かつ 定刻が狙いの時刻(06:39付近)のカードを選ぶ。

// ページの定型文。解析前に除外する(特に「1分ごとに自動更新」「HH:MM 現在」)。
const NOISE_RE = [
  /自動更新/,
  /\d{1,2}:\d{2}\s*現在/,
  /現在\s*$/,
  /表示順序/,
  /到着予測時刻順/,
  /定刻順/,
  /運行状況により/,
  /バス停変更/,
  /地図で確認/,
  /^地図$/,
  /^接近情報$/,
  /のりば\s*:/,
  /ページの先頭/,
  /免責/,
  /Copyright/i,
  /Powered by/i,
  /^時刻表$/,
  /^日本語$/,
  /^English$/,
  /^Language$/,
  /^Menu$/,
  /^戻る$/,
];

// 接近中のバスが無いことを示すメッセージ
const NO_BUS_RE = /接近情報はありません|該当する便はありません|運行情報なし/;

/** "HH:MM" を当日の分数(0-1439)に変換 */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 1枚のカード文字列から各フィールドを抽出 */
function parseCard(block) {
  const pick = (re) => {
    const m = re.exec(block);
    return m ? m[1] : null;
  };
  const scheduled = pick(/定刻\s*(\d{1,2}:\d{2})/);
  const predicted = pick(/(\d{1,2}:\d{2})\s*予測/);

  let delayText = null;
  const delayM = /約?\s*(\d+)\s*分遅れ/.exec(block);
  if (delayM) delayText = `約${delayM[1]}分遅れ`;
  else if (/定刻\s*(?:通り|どおり)/.test(block)) delayText = '定刻どおり';
  const earlyM = /約?\s*(\d+)\s*分\s*早/.exec(block);
  if (earlyM) delayText = `約${earlyM[1]}分早発`;

  const soon = /まもなく/.test(block);
  const minM = /あと\s*約?\s*(\d+)\s*分/.exec(block);
  const stopM = /(\d+)\s*個前/.exec(block);

  const minutesAway = soon && !minM ? 0 : minM ? Number(minM[1]) : null;
  const stopsAway = soon && !stopM ? 0 : stopM ? Number(stopM[1]) : null;

  return { scheduled, predicted, delayText, soon, minutesAway, stopsAway };
}

/**
 * @param {{jsonPayloads:any[], pageText:string}} raw
 * @param {object} cfg
 */
export function parseTarget(raw, cfg) {
  const target = toMinutes(cfg.targetDeparture);
  const windowMin = cfg.matchWindowMinutes ?? 8;
  const dest = cfg.destination || '';

  const text = raw.pageText || '';
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !NOISE_RE.some((re) => re.test(l)));

  // 各カードは「定刻」の行を中心に構成される。定刻行の周辺をまとめてカードとする。
  const cards = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('定刻')) continue;
    cards.push(lines.slice(Math.max(0, i - 3), i + 6).join(' '));
  }

  if (cards.length === 0) {
    if (NO_BUS_RE.test(text)) {
      return { found: false, note: '接近情報にまだ該当の便が出ていません(時間前 or 運行時間外)。' };
    }
    return {
      found: false,
      note: '接近中のバスのカードを検出できませんでした。--debug で画面テキストを確認してください。',
    };
  }

  // 行き先(立神)を含むカードのうち、定刻が狙いの時刻に最も近いものを選ぶ
  let chosen = null;
  let bestDiff = Infinity;
  for (const block of cards) {
    if (dest && !block.includes(dest)) continue;
    const card = parseCard(block);
    const diff =
      card.scheduled != null && target != null
        ? Math.abs(toMinutes(card.scheduled) - target)
        : Infinity;
    // 定刻が読めて狙いの時刻から離れすぎているカードは対象外(別便)
    if (card.scheduled != null && target != null && diff > windowMin) continue;
    if (diff < bestDiff) {
      bestDiff = diff;
      chosen = { ...card, rawBlock: block.slice(0, 300) };
    }
  }

  if (!chosen) {
    return {
      found: false,
      note: dest
        ? `接近中のバスに「${dest}」(${cfg.targetDeparture}付近)が見当たりません。`
        : '対象の便が見当たりません。',
    };
  }

  // 通知文用の状況ラベル
  let status;
  if (chosen.soon) status = 'まもなく到着';
  else if (chosen.minutesAway != null) status = `あと約${chosen.minutesAway}分で到着`;
  else if (chosen.stopsAway != null) status = `${chosen.stopsAway}個前のバス停から接近中`;
  else status = '接近中';

  return {
    found: true,
    departure: chosen.scheduled,
    predicted: chosen.predicted,
    delayText: chosen.delayText,
    status,
    minutesAway: chosen.minutesAway,
    stopsAway: chosen.stopsAway,
    rawBlock: chosen.rawBlock,
  };
}
