import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { AGENTS, Mascot } from "../../components/Mascot";
import { TradingFloor, type FloorAgent, type WallCandle } from "../../components/TradingFloor";
import { SiteFooter, SiteNav } from "./SiteChrome";

/*
 * The hero animation is a scripted ILLUSTRATION of one debate cycle. It is labelled
 * as such on screen and contains no market data, prices or performance figures.
 */
type Beat = { round: string; bubbles: Record<string, string>; badge?: string };
const SCRIPT: Beat[] = [
  { round: "R1 · Riset independen", bubbles: { macro: "Yield 10Y naik", fundamental: "Likuiditas cukup", onchain: "Stablecoin naik", flow: "Funding panas", technical: "Tren 4J naik" } },
  { round: "R2 · Tukar bukti", bubbles: { macro: "Sumber: FRED", flow: "Sumber: Binance", technical: "Bukti dibagikan" } },
  { round: "R3 · Tantangan", bubbles: { critic: "Long terlalu ramai?", flow: "Benar, risiko squeeze" } },
  { round: "R3 · Tantangan", bubbles: { critic: "Edge sudah teruji?", technical: "Tanya Alpha" } },
  { round: "R4 · Sintesis", bubbles: { fund_manager: "Ada perbedaan pendapat" } },
  { round: "R5 · Validasi kuant", bubbles: { quant: "Uji out-of-sample" } },
  { round: "R5 · Validasi kuant", bubbles: { quant: "Sampel belum cukup" } },
  { round: "R6 · Tinjauan risiko", bubbles: { risk: "Ukuran posisi dihitung" } },
  { round: "R7 · Keputusan", bubbles: { fund_manager: "TUNGGU KONFIRMASI" }, badge: "TUNGGU" },
  { round: "R8 · Audit tersimpan", bubbles: {} },
];

function useDemoFloor() {
  const reduce = useReducedMotion();
  const [beat, setBeat] = useState(0);
  const [candles, setCandles] = useState<WallCandle[]>(() => {
    let p = 100;
    return Array.from({ length: 48 }, (_, i) => {
      const o = p;
      p = p * (1 + Math.sin(i / 5) * 0.006 + (((i * 37) % 11) - 5) * 0.0018);
      return { o, c: p, h: Math.max(o, p) * 1.003, l: Math.min(o, p) * 0.997 };
    });
  });
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    if (reduce) return;
    const t = window.setInterval(() => {
      setBeat((b) => (b + 1) % SCRIPT.length);
      setNow(new Date());
      setCandles((cs) => {
        const last = cs[cs.length - 1].c;
        const c = last * (1 + (Math.random() - 0.47) * 0.012);
        return [...cs.slice(1), { o: last, c, h: Math.max(last, c) * 1.003, l: Math.min(last, c) * 0.997 }];
      });
    }, 2200);
    return () => window.clearInterval(t);
  }, [reduce]);
  const b = SCRIPT[beat];
  const agents: Record<string, FloorAgent> = useMemo(() => Object.fromEntries(AGENTS.map((a) => {
    const text = b.bubbles[a.role];
    return [a.role, { state: text ? "analyzing" : beat === SCRIPT.length - 1 ? "completed" : "idle", active: !!text, bubble: text ?? null }];
  })), [b, beat]);
  return { agents, candles, round: b.round, badge: b.badge, clock: now.toTimeString().slice(0, 5), beat };
}

const STEPS = [
  ["Data terverifikasi", "Harga, makro, DeFi, dan sentimen dari sumber publik, lengkap dengan stempel waktu dan cek kesegaran."],
  ["Riset independen", "Lima analis menganalisis snapshot data yang sama tanpa saling melihat jawaban."],
  ["Debat & tantangan", "Killjoy menantang klaim yang lemah. Setiap agen wajib menjawab argumen spesifik."],
  ["Validasi kuant", "Alpha menguji ide dengan data historis: out-of-sample, walk-forward, Monte Carlo."],
  ["Veto risiko", "Sentinel menghitung ukuran posisi. Lewat dari plafon 3%? Ditolak, tanpa pengecualian."],
  ["Keputusan", "Odin memutuskan lewat gerbang berurutan, bukan voting. Perbedaan pendapat dicatat."],
  ["Paper trading", "Keputusan dieksekusi sebagai simulasi. Tidak ada uang sungguhan, tidak ada order live."],
  ["Audit penuh", "Setiap bukti, bantahan, dan keputusan tersimpan permanen dan bisa ditelusuri."],
];

const FEATURES = [
  ["01", "Debat yang bisa diaudit", "Lihat siapa berkata apa, berdasarkan data apa, dan kapan. Tidak ada kotak hitam."],
  ["02", "Jujur soal hasil", "Tidak ada klaim profit. Win rate, profit factor, dan drawdown ditampilkan apa adanya, lengkap dengan ukuran sampel."],
  ["03", "Risiko lebih dulu", "Plafon risiko 3% per trade, batas kerugian harian, dan tombol darurat yang tidak bisa dilangkahi AI."],
  ["04", "Fund Manager di Telegram", "Tanya \"Bagaimana kondisi on-chain Bitcoin?\" dalam bahasa Indonesia dan dapat jawaban dari data tersimpan."],
  ["05", "Sumber data transparan", "Setiap angka menyebut sumber dan waktunya. Data basi diberi label, bukan disembunyikan."],
  ["06", "Belajar tanpa risiko", "Semua eksekusi berupa simulasi. Cocok untuk belajar cara analis profesional berpikir."],
];

const FAQ = [
  ["Apakah sistem ini menjamin profit?", "Tidak. Tidak ada sistem yang bisa menjamin profit. Kami menampilkan hasil riset apa adanya, termasuk ketika hasilnya buruk. Keputusan paling sering justru \"tidak trading\"."],
  ["Apakah uang saya dipakai untuk trading?", "Tidak. Platform berjalan dalam mode riset dan paper trading (simulasi). Eksekusi order live dinonaktifkan."],
  ["Apakah ini saran investasi?", "Bukan. Konten bersifat edukasi dan riset. Aset kripto berisiko tinggi; lakukan riset sendiri dan pertimbangkan penasihat berizin."],
  ["Dari mana datanya?", "Dari sumber publik seperti Binance (data pasar), CoinGecko, FRED (data makro Federal Reserve St. Louis), DefiLlama, dan Alternative.me. Ketersediaan tergantung layanan tersebut."],
  ["Berapa biayanya?", "Pendaftaran akun gratis dan memberi akses baca ke dashboard riset."],
  ["Bagaimana data pribadi saya dijaga?", "Kami hanya menyimpan nama pengguna, email, dan kata sandi yang di-hash (scrypt). Sesi memakai cookie HttpOnly. Kami tidak menjual data pengguna."],
];

export default function Landing({ loggedIn }: { loggedIn: boolean }) {
  const demo = useDemoFloor();
  const reduce = useReducedMotion();
  const activeStep = Math.min(STEPS.length - 1, Math.floor((demo.beat / SCRIPT.length) * STEPS.length));
  // Reveal is movement-only: content stays visible (opacity 1) even if the observer never fires
  // (full-page captures, crawlers, link previews).
  const fade = (d = 0) => (reduce ? {} : { initial: { y: 14 }, whileInView: { y: 0 }, viewport: { once: true, margin: "-60px" }, transition: { duration: 0.45, delay: d } });
  return (
    <div className="site">
      <SiteNav loggedIn={loggedIn} />
      <main>
        <section className="wrap hero">
          <motion.div {...fade()}>
            <span className="eyebrow">■ MODE RISET & PAPER TRADING</span>
            <h1 className="h-display"><span style={{ whiteSpace: "nowrap" }}>Sembilan agen AI.</span><br /><span style={{ whiteSpace: "nowrap" }}>Satu ruang riset.</span><br /><span className="hl">Nol tebakan.</span></h1>
            <p className="lede">
              Atlas membaca makro, Chronos membaca grafik, Killjoy mencari celah, dan Sentinel memegang hak veto.
              Saksikan mereka berdebat dengan data bersumber jelas sebelum satu keputusan pun diambil, tanpa uang sungguhan dipertaruhkan.
            </p>
            <div className="cta-row">
              <Link className="btn lg solid" to={loggedIn ? "/app" : "/signup"}>{loggedIn ? "Buka dashboard" : "Daftar gratis"}</Link>
              <a className="btn lg" href="#cara-kerja">Lihat cara kerja</a>
            </div>
            <div className="trust">
              <span>Plafon risiko 3% per trade</span><span>Tanpa order live</span><span>Sumber data tercatat</span><span>Bahasa Indonesia</span>
            </div>
          </motion.div>
          <motion.div {...fade(0.1)}>
            <TradingFloor agents={demo.agents} candles={demo.candles} wallLabel={demo.round} wallBadge={demo.badge ?? "ILUSTRASI"} clock={demo.clock}
              caption="Ilustrasi animasi satu siklus debat. Bukan data pasar dan bukan hasil trading." />
          </motion.div>
        </section>

        <section className="section" id="tim">
          <div className="wrap">
            <span className="eyebrow">■ TIM AGEN</span>
            <h2>Kenali sembilan spesialis Anda</h2>
            <p className="sub">Setiap agen punya satu tugas, wajib menyebut sumber, dan wajib membedakan fakta, inferensi, hipotesis, dan hal yang belum diketahui.</p>
            <div className="team">
              {AGENTS.map((a, i) => (
                <motion.article key={a.role} className="team-card" style={{ ["--agent" as string]: a.color }} {...fade(i * 0.04)}>
                  <Mascot role={a.role} size={52} />
                  <div>
                    <h3>{a.name}</h3>
                    <div className="role">{a.titleId}</div>
                    <p>{a.tagline}</p>
                  </div>
                </motion.article>
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="cara-kerja">
          <div className="wrap">
            <span className="eyebrow">■ CARA KERJA</span>
            <h2>Delapan ronde sebelum satu keputusan</h2>
            <p className="sub">Keputusan tidak diambil lewat suara terbanyak. Odin hanya boleh mengusulkan posisi jika semua gerbang wajib lolos, dan "tidak trading" adalah jawaban yang sah.</p>
            <div className="steps">
              {STEPS.map(([t, d], i) => (
                <div key={t} className={`step${i === activeStep ? " on" : ""}`}>
                  <div className="n">LANGKAH {String(i + 1).padStart(2, "0")}</div>
                  <h4>{t}</h4>
                  <p>{d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="fitur">
          <div className="wrap">
            <span className="eyebrow">■ FITUR</span>
            <h2>Dibuat untuk berpikir seperti meja riset profesional</h2>
            <div className="feature-grid">
              {FEATURES.map(([n, t, d], i) => (
                <motion.div key={t} className="feature" {...fade(i * 0.05)}>
                  <div className="ico">{n}</div>
                  <h4>{t}</h4>
                  <p>{d}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="keamanan">
          <div className="wrap split">
            <motion.div {...fade()} style={{ display: "grid", placeItems: "center" }}>
              <div style={{ position: "relative" }}>
                <Mascot role="risk" size={200} active />
                <div className="nameplate" style={{ position: "absolute", bottom: -36, left: "50%", transform: "translateX(-50%)", borderColor: "#34D399", color: "#34D399" }}>SENTINEL</div>
              </div>
            </motion.div>
            <motion.div {...fade(0.1)}>
              <span className="eyebrow">■ RISIKO LEBIH DULU</span>
              <h2>Sentinel punya hak veto. Tidak ada yang bisa membatalkannya.</h2>
              <ul className="sub" style={{ paddingLeft: 18, lineHeight: 1.8 }}>
                <li>Risiko terencana per trade maksimal 3% dari ekuitas. Plafon ini tidak bisa dinaikkan lewat pengaturan.</li>
                <li>Data basi, stop-loss tidak valid, atau spesifikasi kontrak tidak diketahui berarti trade ditolak.</li>
                <li>Batas kerugian harian, pengurangan risiko saat drawdown, dan tombol darurat.</li>
                <li>AI tidak pernah bisa mengirim order. Eksekusi live dinonaktifkan di level kode.</li>
              </ul>
              <p className="faint" style={{ fontSize: 12.5 }}>Risiko terencana adalah estimasi. Kerugian nyata bisa lebih besar karena gap harga, slippage, atau gangguan layanan.</p>
            </motion.div>
          </div>
        </section>

        <section className="section" id="telegram">
          <div className="wrap split">
            <motion.div {...fade()}>
              <span className="eyebrow">■ FUND MANAGER DI TELEGRAM</span>
              <h2>Tanya dalam bahasa sehari-hari</h2>
              <p className="sub">Odin menjawab dari data yang benar-benar tersimpan, menyebut waktu dan sumbernya, dan berkata jujur ketika datanya belum ada. Hanya akun terdaftar yang dilayani.</p>
            </motion.div>
            <motion.div className="chat" {...fade(0.1)} aria-label="Contoh percakapan Telegram (ilustrasi)">
              <div className="msg me">Kenapa Risk Manager menolak trade terakhir?</div>
              <div className="msg bot">Penolakan terakhir oleh Sentinel:{"\n"}• STALE_DATA: umur data harga melebihi batas{"\n"}Veto bersifat final dan tidak dapat dibatalkan oleh Fund Manager atau AI.</div>
              <div className="msg me">Analisis teknikal BTC timeframe 4 jam</div>
              <div className="msg bot">Saya akan menampilkan fakta indikator (EMA, RSI, ATR, support/resistance) beserta waktu candle terakhir. Ini fakta indikator, bukan sinyal trading.</div>
              <div className="faint" style={{ fontSize: 11, textAlign: "center" }}>Contoh percakapan (ilustrasi)</div>
            </motion.div>
          </div>
        </section>

        <section className="section" id="faq">
          <div className="wrap" style={{ maxWidth: 820 }}>
            <span className="eyebrow">■ FAQ</span>
            <h2>Pertanyaan yang sering diajukan</h2>
            <div className="faq">
              {FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
            </div>
          </div>
        </section>

        <section className="final-cta wrap">
          <div className="mascot-row">{AGENTS.map((a) => <Mascot key={a.role} role={a.role} size={36} />)}</div>
          <h2 className="h-display" style={{ fontSize: "clamp(30px,4vw,48px)" }}>Tim Anda sudah siap di meja masing-masing.</h2>
          <p className="lede" style={{ margin: "0 auto" }}>Daftar dalam satu menit. Gratis, tanpa kartu kredit, tanpa uang sungguhan.</p>
          <div className="cta-row" style={{ justifyContent: "center" }}>
            <Link className="btn lg solid" to={loggedIn ? "/app" : "/signup"}>{loggedIn ? "Buka dashboard" : "Buat akun gratis"}</Link>
            {!loggedIn && <Link className="btn lg" to="/login">Saya sudah punya akun</Link>}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
