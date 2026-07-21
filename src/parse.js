// 接近情報ページの表示テキストから、狙った複数の便を検出して解釈する。
//
// 実際のカード表示は2レイアウトある:
//  (A) 定刻が先:
//      内海線
//      立神 (造船休日運休)ゆき [銭座町スタジアム経由]
//      定刻 06:38  約1分遅れ  06:40予測
//      あと約 4 分で到着
//      4個前のバス停から接近中
//  (B) あと約◯分/◯個前が先(到着停を指定した場合。定刻が2つ=発/着):
//      内海線[17]
//      新地中華街ゆき [大波止経由]
//      あと約 10 分で到着
//      8個前のバス停から接近中
//      定刻 07:18  約6分遅れ  07:24予測   ← 乗車バス停の発
//      定刻 07:54  約6分遅れ  08:00予測   ← 目的地の着
//
// カードは「○○ゆき」の行を境目に区切る。行き先の判定は「キーワード+ゆき」で行い、
// 「[大波止経由]」のような経由地を誤って行き先と判定しないようにする。

// 解析前に除外する定型文
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
  /発着時刻表/,
  /予測所要時間/,
  /車両情報/,
  /ノンステップ/,
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

const NO_BUS_RE = /接近情報はありません|該当する便はありません|運行情報なし/;
const DEST_LINE_RE = /(?:ゆき|行き)/; // 行き先の行を見分ける

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** cfg から狙う便のリストを得る(targets 優先、無ければ単一 destination/targetDeparture) */
function getTargets(cfg) {
  if (Array.isArray(cfg.targets) && cfg.targets.length) return cfg.targets;
  return [{ destination: cfg.destination, targetDeparture: cfg.targetDeparture }];
}

/** 行き先キーワードが「その便の行き先」として出ているか(経由地の誤検知を防ぐ) */
function destMatches(cardText, keyword) {
  if (!keyword) return false;
  const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // キーワードの直後(経由地の[まで]の範囲内)に「ゆき/行き」が来るものだけを行き先とみなす
  return new RegExp(`${esc}[^\\[]{0,15}(?:ゆき|行き)`).test(cardText);
}

/** カード(行配列)から時刻・接近状況を抽出。
 *  実画面は「定刻」「06:40」「遅れなし」…が各行に分かれるため、行を結合して解釈する。
 *  結合テキストで最初に現れる定刻=乗車バス停の発(着の定刻が続く場合も先頭が発)。 */
function parseCard(cardLines) {
  const text = cardLines.join(' ');

  const scheduled = (/定刻\s*(\d{1,2}:\d{2})/.exec(text) || [])[1] || null;
  const predicted = (/(\d{1,2}:\d{2})\s*予測/.exec(text) || [])[1] || null;

  let delayText = null;
  const delayM = /約?\s*(\d+)\s*分遅れ/.exec(text);
  const earlyM = /約?\s*(\d+)\s*分\s*早/.exec(text);
  if (delayM) delayText = `約${delayM[1]}分遅れ`;
  else if (earlyM) delayText = `約${earlyM[1]}分早発`;
  else if (/遅れなし/.test(text)) delayText = '遅れなし';
  else if (/定刻\s*(?:通り|どおり)/.test(text)) delayText = '定刻どおり';

  const soon = /まもなく/.test(text);
  const minM = /あと\s*約?\s*(\d+)\s*分/.exec(text);
  const stopM = /(\d+)\s*個前/.exec(text);
  const minutesAway = soon && !minM ? 0 : minM ? Number(minM[1]) : null;
  const stopsAway = soon && !stopM ? 0 : stopM ? Number(stopM[1]) : null;

  return { scheduled, predicted, delayText, soon, minutesAway, stopsAway, text };
}

/** テキストをカード(行き先行〜次の行き先行)に分割 */
function splitCards(lines) {
  const destIdx = [];
  lines.forEach((l, i) => {
    if (DEST_LINE_RE.test(l)) destIdx.push(i);
  });
  const cards = [];
  for (let k = 0; k < destIdx.length; k++) {
    const start = destIdx[k];
    const end = k + 1 < destIdx.length ? destIdx[k + 1] : lines.length;
    cards.push(lines.slice(start, end));
  }
  return cards;
}

/**
 * 狙った便すべてを検出して返す。
 * @returns {{ found: boolean, matches: object[], note?: string }}
 */
export function parseTargets(raw, cfg) {
  const targets = getTargets(cfg);
  const windowMin = cfg.matchWindowMinutes ?? 6;

  const text = raw.pageText || '';
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !NOISE_RE.some((re) => re.test(l)));

  const cards = splitCards(lines);

  if (cards.length === 0) {
    return {
      found: false,
      matches: [],
      note: NO_BUS_RE.test(text)
        ? '接近情報にまだ該当の便が出ていません(時間前 or 運行時間外)。'
        : '接近中のバスのカードを検出できませんでした。--debug で画面テキストを確認してください。',
    };
  }

  const matches = [];
  for (const cardLines of cards) {
    const cardText = cardLines.join(' ');
    for (const t of targets) {
      if (!destMatches(cardText, t.destination)) continue;
      const card = parseCard(cardLines);
      // 定刻が読めて狙いの時刻から離れすぎているものは別便として除外
      const target = toMinutes(t.targetDeparture);
      if (card.scheduled != null && target != null) {
        if (Math.abs(toMinutes(card.scheduled) - target) > windowMin) continue;
      }
      let status;
      if (card.soon) status = 'まもなく到着';
      else if (card.minutesAway != null) status = `あと約${card.minutesAway}分で到着`;
      else if (card.stopsAway != null) status = `${card.stopsAway}個前のバス停から接近中`;
      else status = '接近中';

      matches.push({
        destination: t.destination,
        departure: card.scheduled,
        predicted: card.predicted,
        delayText: card.delayText,
        status,
        minutesAway: card.minutesAway,
        stopsAway: card.stopsAway,
        rawBlock: cardText.slice(0, 300),
      });
      break; // 1カードにつき1便
    }
  }

  // 到着が近い順(あと約◯分の小さい順)に並べる
  matches.sort((a, b) => (a.minutesAway ?? 999) - (b.minutesAway ?? 999));

  return matches.length
    ? { found: true, matches }
    : {
        found: false,
        matches: [],
        note: `接近中のバスに対象便(${targets.map((t) => t.destination).join('/')})が見当たりません。`,
      };
}
