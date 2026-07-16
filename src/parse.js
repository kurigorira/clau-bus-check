// 画面テキスト(と拾えたJSON)から、狙った便を選び出す。
//
// 接近情報ページの正確なDOM構造は非公開で変わりうるため、テキストから
// 「行き先キーワード」「接近を表す語」「HH:MM」を拾うヒューリスティックにしている。
//
// 方針:
//   この接近情報画面は「いま実際に接近中のバス」しか表示しない
//   (バスが無い時は「接近情報はありません」)。したがって早朝の運用では
//   画面に行き先(立神)が出た時点で = 狙っている便、とみなすのが最も堅牢。
//   発車時刻(06:39)が画面に出ていればさらに便を特定するのに使うが、必須にはしない。
//
// 実環境で語句が違えば STATUS_PATTERNS を実際の文言に合わせて調整する
// (--debug で実際の画面テキストを確認できる)。

const TIME_RE = /([0-2]?\d):([0-5]\d)/g;

// 「接近中のバスは無い」ことを示すメッセージ(これが出ていれば通知しない)
const NO_BUS_RE = /接近情報はありません|該当する便はありません|運行情報なし/;

// 接近状況を表す表現の候補
const STATUS_PATTERNS = [
  { kind: 'label', re: /まもなく到着|まもなく|接近中/, label: 'まもなく到着' },
  { kind: 'label', re: /通過(しました)?|出発しました/, label: '通過済み' },
  { kind: 'stops', re: /(\d+)\s*(?:つ|個|停留所|バス停)\s*前/ }, // ○つ前
  { kind: 'minutes', re: /約?\s*(\d+)\s*分(?:後|ほど)?/ }, // 約○分
];

/** "HH:MM" を当日の分数(0-1439)に変換 */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** ブロック文字列から接近状況(status/minutesAway/stopsAway)を解釈 */
function interpretStatus(block) {
  for (const p of STATUS_PATTERNS) {
    const m = p.re.exec(block);
    if (!m) continue;
    if (p.kind === 'label') return { status: p.label, minutesAway: null, stopsAway: null };
    if (p.kind === 'stops') {
      const n = Number(m[1]);
      return { status: `あと ${n} 停留所`, minutesAway: null, stopsAway: n };
    }
    if (p.kind === 'minutes') {
      const n = Number(m[1]);
      return { status: `約 ${n} 分`, minutesAway: n, stopsAway: null };
    }
  }
  return { status: '接近中(状況表示なし)', minutesAway: null, stopsAway: null };
}

/**
 * @param {{jsonPayloads:any[], pageText:string}} raw
 * @param {object} cfg
 * @returns {{
 *   found: boolean,
 *   departure?: string|null,
 *   status?: string,
 *   minutesAway?: number|null,
 *   stopsAway?: number|null,
 *   rawBlock?: string,
 *   note?: string
 * }}
 */
export function parseTarget(raw, cfg) {
  const target = toMinutes(cfg.targetDeparture);
  const windowMin = cfg.matchWindowMinutes ?? 8;
  const dest = cfg.destination || '';

  const text = raw.pageText || '';
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // 行き先キーワードを含む行の周辺を「ブロック」として集める
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!dest || lines[i].includes(dest)) {
      blocks.push(lines.slice(Math.max(0, i - 2), i + 3).join(' '));
    }
  }

  if (blocks.length === 0) {
    if (NO_BUS_RE.test(text)) {
      return { found: false, note: '接近情報にまだ該当の便が出ていません(時間前 or 運行時間外)。' };
    }
    return {
      found: false,
      note: dest
        ? `画面テキストに「${dest}」が見当たりませんでした。--debug で画面内容を確認してください。`
        : '対象の便を特定できませんでした。',
    };
  }

  // 行き先を含む全ブロックを結合(行き先・時刻・状況が別行でも取りこぼさない)。
  // 発車時刻が targetDeparture の近くに出ていれば拾う(必須ではない)。
  const merged = blocks.join(' ');
  let departure = null;
  let bestDiff = Infinity;
  if (target != null) {
    for (const m of merged.matchAll(TIME_RE)) {
      const t = `${m[1]}:${m[2]}`;
      const diff = Math.abs(toMinutes(t) - target);
      if (diff <= windowMin && diff < bestDiff) {
        bestDiff = diff;
        departure = t;
      }
    }
  }

  const { status, minutesAway, stopsAway } = interpretStatus(merged);

  return {
    found: true,
    departure,
    status,
    minutesAway,
    stopsAway,
    rawBlock: merged.slice(0, 300),
  };
}
