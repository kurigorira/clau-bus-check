// 接近情報ページを実ブラウザで開き、表示された便の情報を取り出す。
//
// このサイトは日本国内IP限定(海外からは CloudFront が 403)なので、
// 必ず日本のネットワーク上で実行すること。
//
// 内部APIのJSONは非公開で仕様が変わりうるため、ここでは
//   1) ページが裏で取得したJSONレスポンスを拾う(取れれば一番正確)
//   2) 取れなければ、画面に描画されたテキストから読み取る
// の2段構えにしている。--debug で両方を丸ごとダンプできる。

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

// 環境変数で Chromium のパスを差し替え可能(未指定なら playwright が同梱ブラウザを探す)
const EXECUTABLE_PATH = process.env.CHROMIUM_PATH || undefined;

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

/**
 * @param {object} cfg  config.json の内容
 * @param {boolean} debug
 * @returns {Promise<{jsonPayloads: any[], pageText: string, screenshotPath: string|null}>}
 */
export async function fetchApproaching(cfg, debug = false, waitMsOverride = null) {
  const launchOpts = {
    headless: cfg.headless !== false,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  };
  if (EXECUTABLE_PATH) launchOpts.executablePath = EXECUTABLE_PATH;

  const browser = await chromium.launch(launchOpts);
  const jsonPayloads = [];
  const apiUrls = [];
  let pageText = '';
  let screenshotPath = null;

  try {
    const context = await browser.newContext({
      userAgent: MOBILE_UA,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    // 叩いたAPIのURLを記録(接近APIのエンドポイント特定用)
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('/apiv1/')) apiUrls.push(`${req.method()} ${u}`);
    });

    // 裏で流れるJSONを拾う
    page.on('response', async (res) => {
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      try {
        const data = await res.json();
        jsonPayloads.push({ url: res.url(), data });
      } catch {
        /* JSONとして読めないものは無視 */
      }
    });

    await page.goto(cfg.url, {
      waitUntil: 'networkidle',
      timeout: cfg.timeoutMs || 45000,
    });
    // 動的描画の追い込み(接近APIの初回ポーリングも拾えるよう少し長めに待つ)。
    // --wait=SECONDS 指定時はその秒数だけ待ち、1分周期の自動更新も捕捉する。
    await page.waitForTimeout(waitMsOverride || 4000);

    pageText = await page.evaluate(() => document.body.innerText).catch(() => '');

    if (debug) {
      screenshotPath = fileURLToPath(new URL('../debug-screenshot.png', import.meta.url));
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {
        screenshotPath = null;
      });
    }
  } finally {
    await browser.close();
  }

  return { jsonPayloads, apiUrls, pageText, screenshotPath };
}
