import { Link } from "react-router-dom";
import { Mascot } from "../../components/Mascot";

export function SiteNav({ loggedIn, minimal = false }: { loggedIn: boolean; minimal?: boolean }) {
  return (
    <header className="site-nav">
      <Link to="/" className="logo"><Mascot role="fund_manager" size={30} /><span>Evora Terminal</span></Link>
      {!minimal && (
        <nav className="links" aria-label="Halaman">
          <a href="/#tim">Tim Agen</a>
          <a href="/#cara-kerja">Cara Kerja</a>
          <a href="/#fitur">Fitur</a>
          <a href="/#keamanan">Keamanan</a>
          <a href="/#faq">FAQ</a>
        </nav>
      )}
      <div className="spacer" />
      {loggedIn ? (
        <Link className="btn solid" to="/app">Dashboard</Link>
      ) : (
        <>
          <Link className="btn" to="/login">Masuk</Link>
          <Link className="btn solid" to="/signup">Daftar gratis</Link>
        </>
      )}
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 14 }}>
          <span>© {new Date().getFullYear()} Evora Terminal</span>
          <span className="row" style={{ gap: 16 }}>
            <Link to="/terms">Syarat, Risiko & Privasi</Link>
            <Link to="/login">Masuk</Link>
            <Link to="/signup">Daftar</Link>
          </span>
        </div>
        <p className="disclaimer">
          Peringatan risiko: Evora Terminal adalah alat riset dan edukasi yang berjalan dalam mode paper trading (simulasi).
          Konten bukan saran investasi, bukan ajakan membeli atau menjual aset, dan tidak menjamin hasil apa pun.
          Perdagangan aset kripto memiliki risiko tinggi dan dapat mengakibatkan kehilangan seluruh dana. Hasil historis atau simulasi tidak menjamin hasil di masa depan.
          Agen AI dapat keliru; selalu lakukan riset sendiri.
        </p>
      </div>
    </footer>
  );
}
