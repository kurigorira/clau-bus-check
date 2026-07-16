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
import { parseTarget } from './parse.js';
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

function formatMessage(hit, cfg) {
  const parts = [`${cfg.destination}行き ${hit.departure} 発`];
  if (hit.status) parts.push(hit.status);
  if (hit.minutesAway != null) parts.push(`(約${hit.minutesAway}分後)`);
  if (hit.stopsAway != null) parts.push(`(あと${hit.stopsAway}停留所)`);
  return parts.join(' / ');
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

  const hit = parseTarget(raw, cfg);
  return hit;
}

async function main() {
  const cfg = loadConfig();

  if (ONCE) {
    const hit = await checkOnce(cfg);
    if (hit.found) {
      const msg = formatMessage(hit, cfg);
      console.log('[hit]', msg);
      await sendNotification(cfg, '🚌 バス接近', msg);
    } else {
      console.log('[miss]', hit.note || '該当便なし');
    }
    return;
  }

  // poll モード: 発車が近い時間帯に数分おきに確認し、接近を検知したら通知して終了
  const intervalMs = (cfg.pollIntervalSeconds || 60) * 1000;
  const maxTries = cfg.pollMaxTries || 20;
  let notified = false;

  for (let i = 0; i < maxTries && !notified; i++) {
    try {
      const hit = await checkOnce(cfg);
      if (hit.found) {
        const near =
          (hit.minutesAway != null && hit.minutesAway <= (cfg.notifyWithinMinutes || 5)) ||
          (hit.stopsAway != null && hit.stopsAway <= (cfg.notifyWithinStops || 3)) ||
          /まもなく/.test(hit.status || '');
        console.log(`[try ${i + 1}] ${formatMessage(hit, cfg)}`);
        if (near) {
          await sendNotification(cfg, '🚌 バスがまもなく到着', formatMessage(hit, cfg));
          notified = true;
          break;
        }
      } else {
        console.log(`[try ${i + 1}] ${hit.note || '該当便なし'}`);
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
