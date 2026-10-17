// Static configuration and research content for Pixel Quant.

export const START_EQUITY = 10_000;
export const MONTHLY_TARGET = 1_000;
export const RISK_PCT = 0.005; // 0.5% equity per 1R
export const LEVERAGE = 10;
export const FEE_SIDE = 0.00075; // 0.15% round trip (project rule)
export const FEE_STRESS_SIDE = 0.0015; // 0.30% round trip stress test
export const MAX_SL = 0.03; // stop loss max 3%
// Long only in bull years, Short only in bear years (project rule)
export const CYCLE_BY_YEAR = { 2025: 'LONG', 2026: 'SHORT', 2027: 'LONG' };
export const cycleFor = (t) => CYCLE_BY_YEAR[new Date(t).getUTCFullYear()] || 'LONG';
export const TARGETS = { winRate: 0.7, maxDD: 0.1, pf: 3, monthly: 1000 };

// vol = per-second log-return stdev (time is accelerated so the paper book stays lively)
export const PAIRS = [
  { sym: 'BTC/USDT', base: 'BTC', price: 67_842, vol: 0.00045, color: '#f7931a' },
  { sym: 'ETH/USDT', base: 'ETH', price: 3_245, vol: 0.00056, color: '#8b8cf8' },
  { sym: 'SOL/USDT', base: 'SOL', price: 162.4, vol: 0.0007, color: '#2dd4bf' },
  { sym: 'ARB/USDT', base: 'ARB', price: 0.842, vol: 0.0008, color: '#3b82f6' },
  { sym: 'XRP/USDT', base: 'XRP', price: 0.521, vol: 0.00066, color: '#cbd5e1' },
  { sym: 'BNB/USDT', base: 'BNB', price: 584.2, vol: 0.0005, color: '#facc15' },
  { sym: 'DOGE/USDT', base: 'DOGE', price: 0.1384, vol: 0.00078, color: '#d6b25e' },
  { sym: 'AVAX/USDT', base: 'AVAX', price: 27.91, vol: 0.00074, color: '#f43f5e' },
];

export const STRATEGIES = [
  'Donchian Breakout', 'EMA Momentum', 'Range Break', 'Trend Hunter', 'VWAP Reversion',
  'Bollinger Squeeze', 'RSI Divergence', 'Order Block Retest', 'Liquidity Sweep', 'Funding Fade',
  'Supertrend Ride', 'Ichimoku Cloud', 'MACD Cross', 'Volume Spike', 'Keltner Pullback',
];

export const TIMEFRAMES = ['1D', '4H', '1H', '15m', '5m'];
export const EXITS = ['2R tetap', 'Trailing ATR'];
export const DIRECTIONS = ['LONG', 'SHORT'];

// Forward-test bots running live on the paper book.
// style: 'trend' follows the short-term drift, 'revert' fades stretched moves.
export const BOTS = [
  { id: 'trend', rule: 'donchian', name: 'Trend Hunter', strategy: 'Trend Hunter', pairs: ['BTC/USDT', 'ETH/USDT'], style: 'trend', rr: 2.4, color: '#22e39b', tf: '4H' },
  { id: 'momentum', rule: 'emaCross', name: 'EMA Momentum', strategy: 'EMA Momentum', pairs: ['SOL/USDT', 'AVAX/USDT'], style: 'trend', rr: 2.0, color: '#3b82f6', tf: '1H' },
  { id: 'range', rule: 'rsiFade', name: 'Range Break', strategy: 'Range Break', pairs: ['ARB/USDT', 'DOGE/USDT'], style: 'revert', rr: 1.6, color: '#a78bfa', tf: '1H' },
  { id: 'sweep', rule: 'sweep', name: 'Liquidity Sweep', strategy: 'Liquidity Sweep', pairs: ['XRP/USDT', 'BNB/USDT'], style: 'revert', rr: 1.8, color: '#fbbf24', tf: '4H' },
];

// Active-cell rule v1.2c
export const RULE = {
  version: 'v1.2c',
  window: 300,
  minN: 200,
  minPF: 1.15,
  minAvgR: 0.08,
  minLcbR: 0.05,
  mainBookTFs: ['1D', '4H', '1H'],
};

export const RULE_EVOLUTION = [
  { v: 'v1.0', date: '2025-11-02', title: 'Semua sel dengan PF > 1', note: 'Overfit: 41 sel aktif, OOS PF turun ke 0,94.', pf: 0.94 },
  { v: 'v1.1', date: '2026-01-18', title: 'Tambah syarat n ≥ 100 & dua paruh positif', note: 'Sel aktif turun ke 17, OOS PF 1,06.', pf: 1.06 },
  { v: 'v1.2', date: '2026-04-07', title: 'Batas bawah keyakinan ≥ +0,03R', note: 'Membuang sel beruntung; OOS PF 1,12.', pf: 1.12 },
  { v: 'v1.2b', date: '2026-06-21', title: 'Hanya 1D/4H/1H untuk buku utama', note: '15m terlalu mahal biaya; OOS PF 1,17.', pf: 1.17 },
  { v: 'v1.2c', date: '2026-09-03', title: 'Searah siklus + LCB ≥ +0,05R + n ≥ 200', note: 'Aturan aktif sekarang. OOS PF 1,21.', pf: 1.21 },
];

export const NOTES = [
  'Sel 15m konsisten positif sebelum biaya, negatif setelah biaya taker 0,04% × 2.',
  'Kemenangan beruntun di paruh pertama sering tidak bertahan di paruh kedua — syarat dua paruh mencegah ini.',
  'Short di pasar siklus naik menyumbang 62% kerugian buku utama pada v1.1.',
  'Breakeven setelah TP1 menurunkan rata-rata R, tapi memotong drawdown maksimum hampir separuh.',
];

export const INSIGHTS = [
  { source: 'YouTube', title: 'Break of structure + FVG entry 15m', rule: 'Entry di 50% FVG setelah BOS searah 1H', n: 412, pf: 0.97, avgR: -0.02, status: 'gagal' },
  { source: 'TradingView', title: 'Supertrend 10/3 + filter EMA200', rule: 'Long bila close > EMA200 & supertrend hijau', n: 288, pf: 1.19, avgR: 0.09, status: 'lolos' },
  { source: 'YouTube', title: 'London session liquidity sweep', rule: 'Fade sweep high Asia saat 07–09 UTC', n: 236, pf: 1.08, avgR: 0.04, status: 'pantau' },
  { source: 'Riset publik', title: 'Funding rate ekstrem sebagai kontra sinyal', rule: 'Short bila funding > 0,05% & OI naik 3 bar', n: 171, pf: 1.24, avgR: 0.11, status: 'pantau' },
  { source: 'TradingView', title: 'RSI 2 mean reversion', rule: 'Long bila RSI(2) < 5 di atas SMA200', n: 503, pf: 1.02, avgR: 0.01, status: 'gagal' },
  { source: 'YouTube', title: 'Volume profile POC retest', rule: 'Entry retest POC sesi sebelumnya', n: 219, pf: 1.13, avgR: 0.06, status: 'pantau' },
];

// Illustrative research summary; replace with the lab's pred_report.json when connected.
// status: lolos | parsial | tidak | tidak diimplementasikan
export const MODELS = [
  { name: 'Baseline logistik', task: 'P(arah) close 4H berikutnya', auc: 0.524, brier: 0.2492, ece: 0.011, status: 'baseline', note: 'Pembanding wajib untuk semua model' },
  { name: 'LightGBM (fitur harga)', task: 'P(arah) close 4H berikutnya', auc: 0.531, brier: 0.2488, ece: 0.014, status: 'parsial', note: 'Δ log loss vs baseline: CI 95% memuat nol' },
  { name: 'XGBoost', task: 'P(arah) close 4H berikutnya', auc: 0.528, brier: 0.2490, ece: 0.017, status: 'tidak', note: 'Tidak lebih baik dari LightGBM' },
  { name: 'HMM 4-state (filtered)', task: 'Rezim BTC harian', auc: null, brier: null, ece: null, status: 'tidak', note: 'Fitur rezim tidak menambah daya prediksi OOS' },
  { name: 'GARCH(1,1)-t', task: 'Volatilitas (bukan arah)', auc: null, brier: null, ece: null, status: 'lolos', note: 'Dipakai untuk rentang harga dan SL/σ' },
  { name: 'Ensemble stacking', task: 'P(arah) gabungan', auc: 0.530, brier: 0.2489, ece: 0.012, status: 'tidak', note: 'Tidak mengalahkan model individual' },
  { name: 'Meta-model P(win)', task: 'P(trade untung) — terpisah dari P(arah)', auc: 0.556, brier: 0.2431, ece: 0.021, status: 'parsial', note: 'Filter menyimpan 61% trade; CI R/trade memuat nol' },
  { name: 'TFT / GNN', task: 'Sekuens / graf antar-pair', auc: null, brier: null, ece: null, status: 'tidak diimplementasikan', note: 'Tanpa GPU dan model pohon belum menunjukkan sinyal' },
];

export const GLOSSARY = [
  ['R', 'Satu unit risiko: jarak entry ke stop loss dikali ukuran posisi. +2R = untung dua kali risiko.'],
  ['PF', 'Profit factor: total untung ÷ total rugi. Di atas 1 berarti sistem menghasilkan.'],
  ['LCB', 'Lower confidence bound: batas bawah rata-rata R pada keyakinan 90%. Menyaring sel yang cuma beruntung.'],
  ['Sel', 'Kombinasi strategi × timeframe × exit × arah. Unit terkecil yang dinilai.'],
  ['P(arah) vs P(win)', 'P(arah) = peluang close berikutnya naik. P(win) = peluang trade ditutup untung. Dua besaran berbeda.'],
  ['OOS', 'Out-of-sample: data yang tidak dipakai saat memilih aturan atau melatih model.'],
  ['Buku utama', 'Portofolio paper yang hanya memakai sel aktif 1D/4H/1H searah siklus.'],
  ['TP1 / TP2', 'Target profit bertingkat. Di TP1 setengah posisi ditutup dan stop dipindah ke breakeven.'],
  ['Walk-forward', 'Optimasi di jendela in-sample lalu diuji di jendela out-of-sample berikutnya, digeser bertahap.'],
  ['Drawdown', 'Penurunan dari puncak ekuitas ke titik terendah setelahnya.'],
];

export const LIMITATIONS = [
  'Semua angka adalah paper trading dengan harga simulasi; bukan uang sungguhan dan bukan saran investasi.',
  'Slippage dimodelkan nol; biaya 0,15% pulang-pergi sudah dihitung, stress test 0,30% ditampilkan terpisah.',
  'Backtest 12 bulan memakai seleksi kausal, tapi rezim pasar bisa berubah di luar sampel.',
  'Edge arah 4H sangat tipis (AUC terbaik ≈ 0,53); P(arah) dan P(win) adalah dua besaran berbeda dan tidak dipakai langsung untuk sizing.',
  'Waktu simulasi dipercepat: trade live tertutup dalam hitungan menit, bukan jam.',
  'Aturan proyek: Long hanya di tahun bull, Short hanya di tahun bear (2026 = Short), SL maksimal 3%.',
];
