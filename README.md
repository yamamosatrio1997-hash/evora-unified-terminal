# Evora Unified Terminal · Yama Futures Lab

Terminal paper trading bot dengan dashboard live: ekuitas, KPI, posisi, jurnal, heatmap strategi, pelajaran dari kekalahan, kalibrasi, walk-forward, dan lab prediktif (Monte Carlo, GARCH, P(arah) vs P(win)).

Tanpa dependensi: backend Node.js murni (`http`), frontend vanilla JS + canvas.

## Menjalankan

```bash
npm start          # http://localhost:3000
npm test           # unit test engine
```

Variabel lingkungan opsional:

| Variabel | Fungsi |
| --- | --- |
| `PORT` | port server (default 3000) |
| `DATA_DIR` | lokasi `state.json` (default `./data`) |
| `CONTROL_TOKEN` | bila diisi, `POST /api/engine` wajib header `x-control-token` |
| `FRESH=1` | abaikan state tersimpan dan seed ulang |

## Arsitektur

- `server/engine.js`: simulasi pasar (random walk dengan rezim drift), 4 bot forward test, eksekusi TP1 → breakeven → TP2 / SL / time stop, biaya 0,15% pulang-pergi, statistik (KPI, vonis 4 target, pelajaran, kalibrasi, walk-forward, Monte Carlo, GARCH).
- `server/index.js`: REST + Server-Sent Events (`/api/stream`, snapshot tiap detik), file statis, simpan state tiap 30 detik dan saat shutdown.
- `server/data.js`: konfigurasi pair, bot, aturan v1.2c, target, dan konten riset.
- `public/`: SPA dengan router hash. `charts.js` (line chart yang morph halus, donut, sparkline), `pixel.js` (scene pixel-art prosedural), `views/*` per halaman.

### API

`GET /api/snapshot`, `/api/stream`, `/api/equity?range=1D|1W|1M|3M|1Y|ALL`, `/api/trades`, `/api/strategies`, `/api/lessons`, `/api/learning`, `/api/insights`, `/api/predictive`, `/api/methodology`, `POST /api/engine {"running": bool}`.

## Batasan

- Harga disimulasikan dan waktu dipercepat; bukan koneksi bursa dan bukan saran investasi.
- Riwayat 12 bulan di-seed secara deterministik; tabel model prediktif adalah contoh ilustrasi sampai disambungkan ke `pred_report.json` dari engine Python Yama Futures Lab.
- Aturan proyek yang diterapkan: SL maks 3%, biaya 0,15% (stress 0,30%), buku utama searah siklus tahun (2026 = Short).
