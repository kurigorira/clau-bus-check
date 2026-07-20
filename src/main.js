#!/usr/bin/env node
// エントリポイント。
//
// 使い方:
//   node src/main.js --once            1回だけチェックして終了(cron 向き)
//   node src/main.js                    発車まで数分おきにポーリング(既定 poll モード)
//   node src/main.js --debug --once     画面テキスト/JSON/スクショをダンプ(調整用)
//
// 前提: このサイトは日本国内IP限定。必ず日本のネットワークで実行すること。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchApproaching } from './scrape.js';
import { parseTargets } from './parse.js';
import { sendNotification } from './notify.js';

const argv = process.argv.slice(2);
const args = new Set(argv);
const DEBUG = args.has('--debug');
const ONCE = args.has('--once');
// --wait=SECONDS : ページ読み込み後の待機秒数を上書き(接近APIの自動更新ポーリングを
// 捕捉したい朝の調査用。例: --wait=90 で1分周期の更新を1回は拾える)
const WAIT_ARG = argv.find((a) => a.startsWith('--wait='));
const WAIT_MS = WAIT_ARG ? Number(WAIT_ARG.split('=')[1]) * 1000 : null;

function loadConfig() {
  const path = process.env.BUS_CONFIG || fileURLToPath(new URL('../config.json', import.meta.url));
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    console.error(`設定ファイルを読めません: ${path}`);
    console.error('config.example.json を config.json にコピーして編集してください。');
    process.exit(1);
  }
}

// 1便を「行き先 定刻(予測/遅れ) — 状況」の複数行にする
function formatMatch(m) {
  let head = `${m.destination}ゆき`;
  if (m.departure) head += ` 定刻${m.departure}`;
  const sub = [];
  if (m.predicted) sub.push(`${m.predicted}予測`);
  if (m.delayText) sub.push(m.delayText);
  if (sub.length) head += `(${sub.join(' / ')})`;

  const where = [m.status];
  if (m.status && m.stopsAway != null && !/個前/.test(m.status)) {
    where.push(`${m.stopsAway}個前`);
  }
  return `${head}\n${where.filter(Boolean).join(' ・ ')}`;
}

// 複数便をまとめた通知本文
function formatMatches(matches) {
  return matches.map(formatMatch).join('\n\n');
}

// 通知すべき「近さ」か判定。しきい値未設定なら常に通知(=出た時点で知らせる)。
function isNear(m, cfg) {
  const minTh = cfg.notifyWithinMinutes;
  const stopTh = cfg.notifyWithinStops;
  if (minTh == null && stopTh == null) return true;
  if (m.minutesAway != null && minTh != null && m.minutesAway <= minTh) return true;
  if (m.stopsAway != null && stopTh != null && m.stopsAway <= stopTh) return true;
  if (/まもなく/.test(m.status || '')) return true;
  // 数値がまったく読めない場合は取りこぼしを避けて通知
  if (m.minutesAway == null && m.stopsAway == null) return true;
  return false;
}

async function checkOnce(cfg) {
  const raw = await fetchApproaching(cfg, DEBUG, WAIT_MS);

  if (DEBUG) {
    console.log('\n===== DEBUG: 叩いたAPI URL一覧 =====');
    console.log([...new Set(raw.apiUrls || [])].join('\n') || '(なし)');

    console.log('\n===== DEBUG: 拾ったJSONレスポンス =====');
    for (const p of raw.jsonPayloads) {
      console.log('URL:', p.url);
      console.log(JSON.stringify(p.data, null, 2).slice(0, 4000));
      console.log('---');
    }
    console.log('\n===== DEBUG: 画面テキスト =====');
    console.log(raw.pageText);
    if (raw.screenshotPath) console.log('\nスクショ:', raw.screenshotPath);
    console.log('===== DEBUG END =====\n');
  }

  return parseTargets(raw, cfg);
}

// 通知タイトル(近い便の行き先を並べる)
function notifyTitle(nearMatches) {
  const dests = [...new Set(nearMatches.map((m) => `${m.destination}ゆき`))];
  return `🚌 ${dests.join('・')}が接近`;
}

async function main() {
  const cfg = loadConfig();

  if (ONCE) {
    const res = await checkOnce(cfg);
    if (res.found) {
      const near = res.matches.filter((m) => isNear(m, cfg));
      if (near.length) {
        console.log('[hit]\n' + formatMatches(near));
        await sendNotification(cfg, notifyTitle(near), formatMatches(near));
      } else {
        console.log('[まだ遠い/通知しきい値未達]\n' + formatMatches(res.matches));
      }
    } else {
      console.log('[miss]', res.note || '該当便なし');
    }
    return;
  }

  // poll モード: 発車が近い時間帯に数分おきに確認し、接近を検知したら通知して終了
  const intervalMs = (cfg.pollIntervalSeconds || 60) * 1000;
  const maxTries = cfg.pollMaxTries || 25;
  let notified = false;

  for (let i = 0; i < maxTries && !notified; i++) {
    try {
      const res = await checkOnce(cfg);
      if (res.found) {
        console.log(`[try ${i + 1}] ` + res.matches.map((m) => formatMatch(m).replace(/\n/g, ' ')).join(' | '));
        // 接近画面は十数個前からバスを表示するので、しきい値(あと◯分/◯個前)に
        // 達した便だけを通知して終了する。
        const near = res.matches.filter((m) => isNear(m, cfg));
        if (near.length) {
          await sendNotification(cfg, notifyTitle(near), formatMatches(near));
          notified = true;
          break;
        }
      } else {
        console.log(`[try ${i + 1}] ${res.note || '該当便なし'}`);
      }
    } catch (e) {
      console.error(`[try ${i + 1}] エラー:`, e.message);
    }
    if (!notified && i < maxTries - 1) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  if (!notified) console.log('接近を検知できないまま終了しました。');
}

main().catch((e) => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
