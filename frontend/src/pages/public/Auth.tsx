import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { api, ApiError } from "../../lib/api";
import { AGENTS, Mascot } from "../../components/Mascot";
import { SiteNav } from "./SiteChrome";
import type { Me } from "../../App";

function strength(pw: string): { score: number; label: string; color: string } {
  let s = 0;
  if (pw.length >= 12) s++;
  if (pw.length >= 16) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  const levels = [["Terlalu lemah", "#F87171"], ["Lemah", "#F87171"], ["Cukup", "#FACC15"], ["Baik", "#A3E635"], ["Kuat", "#34D399"], ["Sangat kuat", "#34D399"]];
  return { score: s, label: levels[s][0], color: levels[s][1] };
}

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="site">
      <SiteNav loggedIn={false} minimal />
      <div className="auth-wrap">
        <motion.div className="card auth-card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="mascot-row">{AGENTS.map((a) => <Mascot key={a.role} role={a.role} size={26} />)}</div>
          <h1 style={{ textAlign: "center" }}>{title}</h1>
          <p className="muted" style={{ textAlign: "center", marginTop: 0, fontSize: 13.5 }}>{subtitle}</p>
          {children}
        </motion.div>
      </div>
    </div>
  );
}

export function LoginPage({ onAuth }: { onAuth: (m: Me) => void }) {
  const nav = useNavigate();
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onAuth(await api.post<Me>("/auth/login", { username: u.trim(), password: p }));
      nav("/app");
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 429 ? "Terlalu banyak percobaan. Tunggu beberapa menit." : "Nama pengguna atau kata sandi salah.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Masuk" subtitle="Selamat datang kembali. Tim agen sudah menunggu.">
      <form onSubmit={submit} className="grid" style={{ gap: 12 }}>
        <label className="field">Nama pengguna<input autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} required /></label>
        <label className="field">Kata sandi<input type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required /></label>
        {err && <div className="notice bad" role="alert">{err}</div>}
        <button className="btn lg solid" style={{ justifyContent: "center" }} disabled={busy}>{busy ? "Memproses…" : "Masuk"}</button>
        <p className="muted" style={{ fontSize: 13, textAlign: "center", margin: 0 }}>Belum punya akun? <Link to="/signup">Daftar gratis</Link></p>
      </form>
    </AuthShell>
  );
}

export function SignupPage({ onAuth }: { onAuth: (m: Me) => void }) {
  const nav = useNavigate();
  const [f, setF] = useState({ username: "", email: "", password: "", confirm: "", accept: false });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const st = strength(f.password);
  const problems = [
    f.username && !/^[a-zA-Z0-9_.-]{3,32}$/.test(f.username) ? "Nama pengguna 3–32 karakter: huruf, angka, titik, garis bawah, atau strip." : null,
    f.password && f.password.length < 12 ? "Kata sandi minimal 12 karakter." : null,
    f.confirm && f.confirm !== f.password ? "Konfirmasi kata sandi tidak sama." : null,
  ].filter(Boolean) as string[];
  const valid = f.username && f.email && f.password.length >= 12 && f.confirm === f.password && f.accept && problems.length === 0;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setErr(null);
    try {
      onAuth(await api.post<Me>("/auth/register", { username: f.username.trim(), email: f.email.trim(), password: f.password, accept_terms: f.accept }));
      nav("/app");
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setErr(status === 409 ? "Nama pengguna atau email tidak tersedia."
        : status === 429 ? "Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti."
          : status === 403 ? "Pendaftaran sedang ditutup."
            : status === 422 ? "Periksa kembali format nama pengguna, email, dan kata sandi."
              : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Buat akun gratis" subtitle="Akses dashboard riset dan saksikan sembilan agen bekerja.">
      <form onSubmit={submit} className="grid" style={{ gap: 12 }} noValidate>
        <label className="field">Nama pengguna<input autoComplete="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} required /></label>
        <label className="field">Email<input type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
        <label className="field">Kata sandi
          <input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={12} />
          {f.password && <><div className="pw-meter"><span style={{ width: `${(st.score / 5) * 100}%`, background: st.color }} /></div><span style={{ fontSize: 11, color: st.color }}>{st.label}</span></>}
        </label>
        <label className="field">Ulangi kata sandi<input type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required /></label>
        <label className="check"><input type="checkbox" checked={f.accept} onChange={(e) => setF({ ...f, accept: e.target.checked })} />
          <span>Saya memahami bahwa ini alat riset & simulasi, bukan saran investasi, dan menyetujui <Link to="/terms" target="_blank">Syarat, Risiko & Privasi</Link>.</span></label>
        {problems.map((p) => <div key={p} className="faint" style={{ fontSize: 12 }}>• {p}</div>)}
        {err && <div className="notice bad" role="alert">{err}</div>}
        <button className="btn lg solid" style={{ justifyContent: "center" }} disabled={!valid || busy}>{busy ? "Membuat akun…" : "Daftar"}</button>
        <p className="muted" style={{ fontSize: 13, textAlign: "center", margin: 0 }}>Sudah punya akun? <Link to="/login">Masuk</Link></p>
      </form>
    </AuthShell>
  );
}

export function TermsPage({ loggedIn }: { loggedIn: boolean }) {
  return (
    <div className="site">
      <SiteNav loggedIn={loggedIn} minimal />
      <main className="wrap" style={{ maxWidth: 820, padding: "40px 20px 80px" }}>
        <h1 className="h-display" style={{ fontSize: 40 }}>Syarat, Risiko & Privasi</h1>
        <h2>1. Sifat layanan</h2>
        <p className="muted">Evora Terminal adalah alat riset dan edukasi. Semua eksekusi berupa simulasi (paper trading). Eksekusi order live tidak tersedia.</p>
        <h2>2. Bukan saran investasi</h2>
        <p className="muted">Analisis agen AI, hasil backtest, dan keputusan simulasi bukan rekomendasi untuk membeli atau menjual aset apa pun. Agen AI dapat keliru. Hasil historis atau simulasi tidak menjamin hasil di masa depan.</p>
        <h2>3. Risiko aset kripto</h2>
        <p className="muted">Aset kripto sangat fluktuatif. Anda dapat kehilangan seluruh dana jika berdagang secara nyata. Patuhi peraturan yang berlaku di yurisdiksi Anda.</p>
        <h2>4. Akun</h2>
        <p className="muted">Akun baru memiliki akses baca. Jaga kerahasiaan kata sandi Anda. Kami dapat menangguhkan akun yang menyalahgunakan layanan.</p>
        <h2>5. Privasi</h2>
        <p className="muted">Kami menyimpan nama pengguna, email, kata sandi yang di-hash (scrypt), serta catatan audit aktivitas akun untuk keamanan. Kami tidak menjual data pribadi. Untuk penghapusan akun, hubungi administrator layanan.</p>
      </main>
    </div>
  );
}
