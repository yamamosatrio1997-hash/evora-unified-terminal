# Quantbot HQ — 3D Live Office

Simulasi kantor 3D real-time (Three.js + TypeScript + Vite) untuk tim Quantbot:
desk trader eksekutor, 8 Lead Departemen, Odin (Fund Manager), dan Yama (owner) di lantai 2.
Langsung jalan dengan karakter & ruangan prosedural bawaan; aset `.glb` milikmu bisa dipasang lewat satu file manifest.

```bash
cd quantbot-office
npm install
npm run dev        # http://localhost:5173
npm test           # validasi layout, jalur jalan, dialog
npm run build      # output statis di dist/
```

Parameter URL: `?clock=demo` (1 jam kantor = 2 menit), `?speed=2`, `?ws=ws://host:port` (feed Quantbot).

## Apa yang terjadi di kantor

| Skenario | Siapa | Di mana |
|---|---|---|
| Kerja di meja (mengetik, berpikir, gumam singkat) | semua | meja masing-masing |
| Desk trader eksekutor — tidak pernah meninggalkan meja, sesekali ngobrol dengan tetangga | 12 trader | Trading Floor |
| Meeting: Odin di kepala meja, lead update per departemen, keputusan | Odin + 4–8 lead | Meeting Room |
| Instruksi trading: lead jalan ke meja trader, beri order, trader konfirmasi | 1 lead → 1–2 trader | Trading Floor |
| Briefing floor: Odin/lead di depan wall screen, para trader menjawab | Odin/lead + 3–5 trader | Trading Floor |
| Diskusi berdiri antar lead beda departemen | 2–3 lead | lounge, whiteboard, koridor, atau mampir ke meja |
| Ngopi + bahas isu kerja | 2–3 lead | Pantry |
| Report tiap jam: Odin naik tangga ke ruang Yama, lapor equity/PnL/posisi/DD, tanya-jawab | Odin ↔ Yama | Lantai 2 |
| Game break saat pasar sepi: biliar, ping-pong, PlayStation (bisa bersamaan) | 2 lead per game | Game Room, lantai 2 |

Setiap ucapan muncul sebagai pop-up chat di atas kepala dan masuk ke Office Feed. HUD punya preset kamera,
mode ikuti karakter (klik nama di daftar tim), tombol skenario manual, pause/1x/2x/4x, dan toggle lantai 2.

Report Odin mengikuti jam komputer (mode **Real-time**, default) — tepat setiap pergantian jam. Pakai mode **Demo**
atau tombol **Report ke Yama** untuk melihatnya tanpa menunggu. Jika Odin sedang meeting, dia naik setelah meeting selesai.

## Struktur

```
src/config/layout.ts     ruangan, dinding, furnitur, nav graph, spot (kursi/titik berdiri)
src/config/roster.ts     karakter: nama, departemen, warna, meja
src/config/dialogue.ts   semua kalimat (Bahasa Indonesia), template {sym} {pnl} dll.
src/config/assets.ts     loader manifest aset .glb
src/agents/              Agent (jalan/duduk/bicara), ProceduralAvatar, GltfAvatar
src/sim/Director.ts      penjadwal skenario + jam report
src/sim/scenarios.ts     skrip tiap adegan (async/await, mudah ditambah)
src/sim/FundState.ts     buku dana simulasi (atau data asli via bridge)
src/bridge/EventBridge.ts  API window.QuantbotOffice + WebSocket
src/scene/               kantor prosedural + layar animasi (chart, wall PnL, TV)
```

## Memasang aset 3D milikmu

Taruh file di `public/models/` dan isi `public/models/manifest.json`
(contoh lengkap: `manifest.example.json`):

```json
{
  "models": {
    "staff": { "url": "models/staff.glb", "scale": 1,
               "clips": { "idle": "Idle", "walk": "Walking", "sit": "Sitting Idle", "type": "Typing", "talk": "Talking" } },
    "odin":  { "url": "models/odin.glb", "clips": { "idle": "Idle", "walk": "Walking", "sit": "Sitting Idle" } }
  },
  "roles": { "trader": "staff", "lead": "staff" },
  "characters": { "odin": "odin" },
  "environment": { "url": "models/office.glb", "hideProcedural": true }
}
```

- Slot animasi yang diminta simulasi: `idle, walk, sit, type, talk, sitTalk, think, drink, billiard, pingpong, gamepad`.
  Slot yang tidak ada otomatis jatuh ke cadangan (mis. `sitTalk → talk → sit → idle`), jadi minimal cukup `idle`, `walk`, `sit`.
- Model harus menghadap +Z dengan origin di kaki (atau atur `rotationY` / `yOffset`). Rig Mixamo langsung cocok.
- Bila file gagal dimuat, karakter tetap memakai avatar prosedural — simulasi tidak berhenti.
- Jika memakai `office.glb` sendiri, samakan posisi meja/kursi dengan koordinat di `layout.ts`
  (satuan meter, lantai 2 di y = 4.2). Karakter hanya bergantung pada data layout, bukan pada mesh.

## Menghubungkan ke Quantbot asli

```js
QuantbotOffice.signal({ lead: 'vortex', symbol: 'BTCUSDT', side: 'LONG', size: 2.5 }) // lead jalan ke trading floor
QuantbotOffice.updateFund({ equity: 1250000, startOfDay: 1200000, winRate: 64 })     // angka yang dilaporkan Odin
QuantbotOffice.say('sentinel', 'VaR naik, hati-hati.')
QuantbotOffice.trigger('meeting')   // meeting | instruction | briefing | standing | pantry | game | report
```

Atau buka `?ws=ws://localhost:8787` dan kirim JSON: `{"type":"signal",...}`, `{"type":"fund","data":{...}}`,
`{"type":"say","agent":"odin","text":"..."}`, `{"type":"scenario","name":"pantry"}`, `{"type":"report"}`.
Begitu data `fund` pertama masuk, simulasi harga acak berhenti dan semua layar memakai data aslimu.

## Menambah skenario

Tulis fungsi async di `src/sim/scenarios.ts` lalu daftarkan di `Director.tryStart`:

```ts
export async function codeReview(sim: Sim, a: Agent, b: Agent) {
  await Promise.all([a.goTo('whiteboard-0'), b.goTo('whiteboard-1')]);
  await converse(sim, [a, b], [[0, 'Cek PR strategi baru?'], [1, 'Sudah, backtest lulus.']]);
  await returnHome(sim, [a, b]);
}
```

Spot baru (kursi, titik berdiri) ditambahkan di `layout.ts`; `npm test` memastikan semua spot terhubung ke jalur jalan.
