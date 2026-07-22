# systemd (Linux / 東京リージョンのVPS等) で毎朝起動する例

`/etc/systemd/system/bus-check.service`:

```ini
[Unit]
Description=Nagasaki bus approaching check
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/clau-bus-check
ExecStart=/usr/bin/node /opt/clau-bus-check/src/main.js --once
```

`/etc/systemd/system/bus-check.timer`:

```ini
[Unit]
Description=Run bus-check every morning at 06:25 JST

[Timer]
OnCalendar=*-*-* 06:25:00
Persistent=true

[Install]
WantedBy=timers.target
```

有効化:

```bash
# サーバーのタイムゾーンを日本にしておく
sudo timedatectl set-timezone Asia/Tokyo

sudo systemctl daemon-reload
sudo systemctl enable --now bus-check.timer
systemctl list-timers bus-check.timer   # 次回発火を確認
```

> VPSを使う場合は必ず**日本リージョン**(例: さくらVPS、ConoHa、GCP `asia-northeast1`、AWS `ap-northeast-1`)にすること。海外リージョンだと接近情報サイトが 403 で開けません。
