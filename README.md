# clau-bus-check 🚌

長崎バスの**接近情報**(NAVITIME 乗換時刻表クラウド)を毎朝チェックし、
狙った便が近づいたら**プッシュ通知**するツール。

用途の想定: 「毎朝6:39発の**立神行き**に**新開北**バス停から乗る。そのバスが今どこにいるかを朝、自動で知りたい」。

---

## ⚠️ 最初に読む重要な前提

この接近情報サイトは **日本国内のIPからしかアクセスできません**(海外IPは CloudFront が `403 Request blocked` を返す = 地域制限)。

- **確認済み**: 海外(米国)からアクセスすると 403。日本のスマホからは正常に見える。
- したがって、このツールは **必ず日本のネットワーク上で実行**してください:
  - 自宅のPC / Mac / Raspberry Pi(日本にある)
  - 日本リージョンのVPS/クラウド(さくら、ConoHa、GCP `asia-northeast1`、AWS `ap-northeast-1` など)
- 海外リージョンのサーバーやCI上では動きません。

> サーバーを用意したくない場合は、スマホだけで完結する [iOSショートカットの方法](docs/ios-shortcut.md) が手軽です。

また、NAVITIME に公開・無料のバス位置APIは無いため、本ツールは**画面を実ブラウザで開いて表示内容を読み取る**方式です。サイト側の作りが変わると調整が要る場合があります(その際は `--debug` で中身を確認 → `src/parse.js` を調整)。

---

## セットアップ

```bash
git clone <this-repo>
cd clau-bus-check
npm install                      # playwright-core を入れる

# 実ブラウザ(Chromium)が必要。未導入なら:
npx playwright install chromium
# もしくは既存のChromeを使う場合は環境変数で指定:
#   export CHROMIUM_PATH=/path/to/chrome

cp config.example.json config.json
# config.json を自分の値に編集(下記)
```

### config.json の主な項目

| キー | 意味 |
|---|---|
| `url` | スマホで見ている接近情報ページのURLをそのまま貼る |
| `destination` | 行き先で絞るキーワード(例: `立神`) |
| `targetDeparture` | 狙う発車時刻 `HH:MM`(例: `06:39`) |
| `matchWindowMinutes` | 発車時刻の前後この分数以内の便だけ対象にする |
| `notify.type` | `ntfy` / `discord` / `slack` / `none` |
| `notify.ntfyTopic` | ntfy を使う場合の購読URL(例 `https://ntfy.sh/自分だけのランダム文字列`) |

> **通知の一番簡単な入口は [ntfy](https://ntfy.sh)**。スマホに ntfy アプリを入れて適当なトピック名(推測されにくい文字列)を購読するだけ。LINE Notify は 2025年3月で終了したため非対応です。

---

## 使い方

```bash
# 1回だけチェックして通知(cron/systemd 向き)
node src/main.js --once

# poll モード: 発車が近い時間帯に数分おきに確認し「まもなく」で通知して終了
node src/main.js

# デバッグ: 画面テキスト/拾ったJSON/スクショを出力(語句調整・初期確認用)
node src/main.js --debug --once
```

### 毎朝自動で動かす

- cron: [`deploy/crontab.example`](deploy/crontab.example)
- systemd (Linux/VPS): [`deploy/systemd.example.md`](deploy/systemd.example.md)
- launchd (Mac): [`deploy/launchd.example.plist`](deploy/launchd.example.plist)

いずれも **サーバーのタイムゾーンを日本(JST)** にしてから設定してください。

---

## 初回の確認手順(おすすめ)

1. 日本の実行環境で `node src/main.js --debug --once` を、**バスが近づく時間帯(6:20〜6:39頃)**に実行
2. 出力された「画面テキスト」に、立神行き・発車時刻・「◯つ前 / まもなく / 約◯分」等がどう表示されているか確認
3. 表現がツールの想定(`src/parse.js` の `STATUS_PATTERNS`)と違えば、そこを実際の語句に合わせて調整
4. `notify` を設定して、通知が届くか確認
5. cron/systemd/launchd で毎朝起動を仕込む

---

## 構成

```
src/
  main.js     エントリポイント(--once / poll / --debug)
  scrape.js   Playwright で接近情報ページを開き、JSONと画面テキストを取得
  parse.js    狙った便を1つ選び「あと◯分/◯停留所」を解釈
  notify.js   ntfy / Discord / Slack へプッシュ
deploy/       cron / systemd / launchd の例
docs/         iOSショートカットで済ませる代替案
config.example.json
```

## 注意 / 免責

- 個人利用の範囲を想定しています。短時間に何度も叩くとサイトに負荷をかけるので、ポーリング間隔は常識的に(既定は60秒間隔・回数上限あり)。
- サイト構造・地域制限・提供状況は運営側の都合で変わり得ます。
