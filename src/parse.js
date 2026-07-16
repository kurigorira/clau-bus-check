// 画面テキスト(と拾えたJSON)から、狙った便を1つ選び出す。
//
// 接近情報ページの正確なDOM構造は非公開で変わりうるため、
// ここでは「行き先キーワード」「HH:MM の発車時刻」「接近を表す語」を
// テキストから拾うヒューリスティックにしている。
// 実環境で語句が違えば STATUS_PATTERNS / この関数を調整すればよい
// (--debug で実際の画面テキストを確認できる)。

const TIME_RE = /([0-2]?\d):([0-5]\d)/g;

// 「あと何個前」「まもなく」等、接近状況を表す表現の候補
const STATUS_PATTERNS = [
  { re: /まもなく|まもな?く到着|接近中/, label: 'まもなく到着' },
  { re: /通過(しました)?|出発しました/, label: '通過済み' },
  { re: /(\d+)\s*(つ|個|停留所|バス停)?\s*前/, label: null }, // ○つ前
  { re: /約?\s*(\d+)\s*分(後|ほど)?/, label: null }, // 約○分
  { re: /運行情報なし|接近情報はありません|該当する便はありません/, label: '該当便なし' },
];

/**
 * "HH:MM" を当日の分数(0-1439)に変換
 */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * @param {{jsonPayloads:any[], pageText:string}} raw
 * @param {object} cfg
 * @returns {{
 *   found: boolean,
 *   departure?: string,
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
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const block = lines.slice(Math.max(0, i - 2), i + 3).join(' ');
    if (dest && !block.includes(dest)) continue;

    // ブロック内の HH:MM を全部拾い、target に一番近いものを発車時刻とみなす
    const times = [...block.matchAll(TIME_RE)].map((m) => `${m[1]}:${m[2]}`);
    let best = null;
    let bestDiff = Infinity;
    for (const t of times) {
      const mm = toMinutes(t);
      if (mm == null || target == null) continue;
      const diff = Math.abs(mm - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = t;
      }
    }
    if (best && bestDiff <= windowMin) {
      candidates.push({ departure: best, diff: bestDiff, block });
    }
  }

  // 同じ発車時刻のブロックは結合する。
  // (行き先の行・時刻の行・「まもなく/◯つ前」の行が別行に分かれていても
  //  取りこぼさないように、周辺コンテキストをまとめて解釈する)
  const byDeparture = new Map();
  for (const c of candidates) {
    const cur = byDeparture.get(c.departure);
    if (cur) {
      cur.block += ' ' + c.block;
      cur.diff = Math.min(cur.diff, c.diff);
    } else {
      byDeparture.set(c.departure, { ...c });
    }
  }
  candidates.length = 0;
  candidates.push(...byDeparture.values());

  // 行き先に一致するブロックが見つからなかった場合
  if (candidates.length === 0) {
    // 「該当便なし」等の明示メッセージがあればそれを返す
    for (const p of STATUS_PATTERNS) {
      if (p.label === '該当便なし' && p.re.test(text)) {
        return { found: false, note: '接近情報にまだ該当の便が出ていません(時間前 or 運行時間外)。' };
      }
    }
    return {
      found: false,
      note: dest
        ? `画面テキストから「${dest}」+ ${cfg.targetDeparture} 付近の便を特定できませんでした。--debug で画面内容を確認してください。`
        : '対象の便を特定できませんでした。',
    };
  }

  // target に一番近い便を採用
  candidates.sort((a, b) => a.diff - b.diff);
  const hit = candidates[0];

  // 接近状況を解釈
  let status = '接近状況の表示なし';
  let minutesAway = null;
  let stopsAway = null;

  for (const p of STATUS_PATTERNS) {
    const m = p.re.exec(hit.block);
    if (!m) continue;
    if (p.label) {
      status = p.label;
    } else if (/前/.test(p.re.source)) {
      stopsAway = Number(m[1]);
      status = `あと ${stopsAway} 停留所`;
    } else if (/分/.test(p.re.source)) {
      minutesAway = Number(m[1]);
      status = `約 ${minutesAway} 分`;
    }
    if (p.label || minutesAway != null || stopsAway != null) break;
  }

  return {
    found: true,
    departure: hit.departure,
    status,
    minutesAway,
    stopsAway,
    rawBlock: hit.block,
  };
}
