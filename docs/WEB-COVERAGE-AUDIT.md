# Audit cakupan Web UI terhadap agent leader

Tanggal: 2026-11-06. Bagian audit di bawah mencatat kondisi awal; tindak lanjut
implementasi tercatat di bagian terakhir.

## Hasil pemeriksaan

| Gate dari `web/` | Hasil |
| --- | --- |
| `npm run check` | Lulus, 0 error dan 0 warning |
| `npm run lint` | Lulus, Prettier dan ESLint |
| `npm test` | Lulus, 29 file / 457 tes |

Ini adalah cakupan **fitur**, bukan persentase line/branch coverage. Tes dijalankan
tanpa instrumentasi coverage. Penilaian integrasi di bawah berdasarkan penelusuran
handler Rust → transport → store → kontrol komponen; belum diverifikasi lewat
browser dengan leader hidup. Build produksi dan gate Cargo tidak dijalankan.

## Temuan yang perlu diperbaiki

1. **P1 — Plan approval belum bisa dijawab dari Web UI.**
   `exit_plan_mode` diterima dan disimpan, `answerPlan()` dan `respondPlan()` sudah
   ada, tetapi tidak ada pemanggil `answerPlan` dari komponen atau route.
   `plan-popover.svelte` hanya menampilkan Markdown. Route merender panel question
   dan permission, sedangkan plan hanya ikut menandai status blocked.
   Jika hanya browser yang digunakan, approval tetap menunggu tanpa kontrol untuk
   approve/cancel/abandon. Perlu panel jawaban dan pengujian interaksi sampai
   respons reverse request terkirim.
   Bukti: [store](../web/src/lib/harness/session-store.svelte.ts),
   [popover](../web/src/lib/components/chrome/plan-popover.svelte),
   [route](../web/src/routes/+page.svelte).

2. **P1 — Kegagalan extension dapat tampil sebagai operasi sukses.**
   Rust mengembalikan kegagalan operasi sebagai JSON-RPC result berisi
   `{ result: null, error: ... }` melalui `ExtMethodResult`. `request()` hanya
   menolak JSON-RPC error terluar; `ext()` meneruskan respons tanpa validasi.
   Mutasi seperti `fsWrite`, rename/delete session dan checkout mengabaikan
   envelope tersebut. Pada write yang gagal, editor dapat menghapus penanda
   unsaved walaupun isi belum tersimpan; rollback mutasi lain juga tidak terpanggil.
   Perlu membedakan failure envelope dari partial result yang membawa warning,
   dan menguji jalur kegagalan operasi sampai UI.
   Bukti: [envelope Rust](../crates/codegen/alnair-shell/src/session/result.rs),
   [handler write](../crates/codegen/alnair-shell/src/extensions/fs.rs),
   [transport](../web/src/lib/harness/ws-transport.ts),
   [editor save](../web/src/lib/components/inspector/editor-pane.svelte).

3. **P2 — Mengubah effort saja tidak mengubah effort runtime.**
   Route memanggil `store.setEffort`, tetapi method itu hanya mengisi state lokal.
   `send()` tidak membawa effort; effort baru terkirim bersama `setModel()`.
   Akibatnya label effort bisa berbeda dari effort yang dipakai agent sampai
   pengguna memilih model lagi. Perlu meneruskan perubahan melalui
   `session/set_model` dengan model aktif dan `_meta.reasoningEffort`.
   Bukti: [store, setEffort/send](../web/src/lib/harness/session-store.svelte.ts),
   [transport, setModel/send](../web/src/lib/harness/ws-transport.ts).

4. **P2 — Permission mode di Settings hanya mengubah state lokal.**
   `setSetting('permission_mode', ...)` mengubah `settings` dan `access`, lalu
   menyimpan localStorage, tanpa memanggil `transport.setAccess()`.
   Access picker composer memakai `setAccess()` yang mengirim notifikasi runtime,
   sehingga dua kontrol untuk mode yang sama memiliki efek berbeda. Sebaliknya,
   `setAccess()` juga tidak memperbarui nilai `settings.permission_mode`.
   Perlu satu jalur mutasi mode dan pengujian kedua kontrol.
   Bukti: [store, setSetting/setAccess](../web/src/lib/harness/session-store.svelte.ts),
   [wiring route](../web/src/routes/+page.svelte).

5. **P2 — Sebagian notifikasi runtime penting dibuang.**
   Reducer menangani `auto_compact_started/completed`, tetapi tidak
   `auto_compact_failed/cancelled`; kasus yang tidak dikenal kembali dengan
   accumulator lama. `goal_updated`, lifecycle scheduler, memory dan recovery
   juga belum punya proyeksi UI. Pengguna dapat melihat awal suatu operasi tanpa
   mengetahui hasil gagal/batalnya. Prioritaskan status akhir kompaksi dan
   recovery, lalu tentukan representasi goal/scheduler/memory.
   Bukti: [enum Rust](../crates/codegen/alnair-shell/src/extensions/notification.rs),
   [reducer](../web/src/lib/harness/reducer.ts).

## Matriks fitur

“Tersambung” berarti jalur implementasi ditemukan, bukan bukti E2E live.
“Belum ada kontrol” tidak berarti agent tidak dapat melakukan pekerjaan itu
melalui prompt atau tool; artinya browser belum menyediakan pengelola khusus.

| Fitur leader | Cakupan Web UI | Batas / bukti utama |
| --- | --- | --- |
| Handshake, shared leader, reconnect | Tersambung | `context.ts`, `ws-transport.ts`, Rust `bridge.rs`; satu client per WS |
| Session list, attach, replay, dedup | Tersambung | `openSession`, roster delta, `dedup.ts`; dites dengan fake socket/replay |
| Prompt streaming dan cancel | Tersambung | `send`, `cancelTurn`, reducer `turn_completed` |
| Image/file attachments dan @mentions | Tersambung | `attachments.ts`, fs list/search, composer |
| Permission request dan questionnaire | Tersambung | Reverse response, `question-panel`, permission banner |
| Plan artifact dan approval | Parsial | Artifact terlihat; kontrol jawaban belum ada (temuan 1); toggle plan mode juga belum terhubung |
| Model dan reasoning effort | Parsial | Model switch tersedia; effort mandiri belum terkirim (temuan 3); penolakan switch ditelan transport |
| Runtime permission mode | Parsial | Composer mengirim mode; Settings belum (temuan 4); wire existing session hanya membedakan bit yolo, bukan ask/auto |
| Session create/rename/delete | Parsial | Kontrol tersedia; envelope gagal belum diperiksa (temuan 2) |
| Session fork, rewind, repair, full-text search | Belum ada kontrol | Handler tersedia di `session_admin.rs`, `rewind.rs`, `repair.rs`, `session_search.rs`; filter sidebar bukan full-text transcript search |
| Workspace, branch checkout, worktree create/list | Parsial | Picker native dan kontrol tersedia; mutasi perlu validasi envelope; apply/remove/resume/GC worktree belum ada kontrol |
| Files, preview, Monaco save | Parsial | Read/write tersambung; failure save dapat dianggap sukses (temuan 2); delete file belum ada kontrol |
| Git status / source control | Parsial, sengaja terbatas | `git-pane.svelte` memilih read-only; checkout tersedia terpisah; stage/unstage/commit/discard/stash belum ada kontrol |
| PTY interaktif | Tersambung | Create/load/input/resize/kill di transport dan `terminal-pane.svelte` |
| Subagent progress dan transcript | Parsial | List running dan transcript tersedia; cancel child belum ada kontrol |
| Background tasks / monitors / scheduler | Parsial | Output dan completion terlihat; task list/kill dan scheduler management belum ada kontrol |
| Prompt queue dan interjection | Belum ada kontrol | `QueuedPrompt`/`QueueChanged` baru tipe; belum ada transport/store/UI pengelola; send ditolak saat busy |
| Context dan compaction | Parsial | Meter dan started/completed tersedia; failed/cancelled dibuang; manual compact belum ada kontrol khusus |
| Graph dan goal | Parsial | Graph badge menampilkan ringkasan; goal update/control belum diproyeksikan |
| MCP management dan OAuth server | Belum ada kontrol | `extensions/mcp.rs` menyediakan list/auth/toggle/upsert/delete; tool MCP tetap bisa muncul sebagai tool trace |
| Skills/plugins/hooks management | Belum ada kontrol khusus | Skill/server slash commands yang diiklankan dapat dipakai; tidak ada manager list/toggle/add/remove/trust di web |
| Provider login, credentials, billing | Belum ada kontrol khusus | Handler auth/billing tersedia; cookie web adalah auth browser lokal, bukan login provider |
| Search content, code navigation, review/feedback | Belum ada kontrol khusus | Handler tersedia; editor belum menghubungkan goto definition/references dan workflow review |
| UI preferences | Tersambung, lokal | Theme/density/tampilan tersimpan di localStorage; bukan editor konfigurasi runtime penuh |

Acuan inventaris leader:
[dispatcher](../crates/codegen/alnair-shell/src/agent/mvp_agent/acp_agent.rs),
[extensions](../crates/codegen/alnair-shell/src/extensions),
[leader routing](../crates/codegen/alnair-shell/src/leader/server.rs).
Acuan browser: [transport](../web/src/lib/harness/ws-transport.ts),
[store](../web/src/lib/harness/session-store.svelte.ts),
[command filter](../web/src/lib/harness/commands.ts).

## Batas pengujian dan langkah berikutnya

457 tes yang lulus meliputi reducer, wire mapping, store, replay/dedup, fake
WebSocket, settings/preferences, attachments, dan fungsi pembantu komponen.
Tidak ditemukan suite browser E2E pada `web/`; keberhasilan unit test belum
membuktikan klik komponen benar-benar mengirim operasi yang sesuai ke leader.
Temuan 1, 3 dan 4 menunjukkan celah tepat di sambungan tersebut.

Urutan kerja yang disarankan:

1. Perbaiki plan approval dan deteksi error envelope mutasi.
2. Satukan propagasi effort dan permission mode ke runtime.
3. Uji browser ↔ leader: plan approval; write ditolak; effort tanpa ganti model;
   perubahan permission dari kedua kontrol; TUI + browser pada session kedua;
   reconnect ketika turn berjalan; output PTY tetap menuju client pemiliknya.
4. Tambahkan status gagal/batal kompaksi, lalu queue/interject, lifecycle session,
   dan kontrol subagent/task sesuai prioritas produk.

Dokumentasi `web/README.md` masih menyebut fixture-only/no socket, belum ada
session replay/persistence/mobile drawer, serta mengarahkan socket berikutnya ke
`agent serve`. Kode dan `docs/WEB.md` sudah memakai leader bridge, replay,
localStorage, dan navigasi mobile. README perlu diperbarui agar tidak menjadi
acuan arsitektur yang salah.

## Tindak lanjut implementasi

Perbaikan terhadap temuan awal:

- Temuan 1: panel plan approval menyediakan approve, reject dan leave plan mode.
  Jawaban dikirim ke reverse request; konfirmasi client lain menutup panel yang
  cocok dengan tool call id.
- Temuan 2: transport menolak failure envelope sebelum store/editor menandai
  mutasi berhasil. Partial result non-null dengan warning tetap dapat dibaca.
- Temuan 3: perubahan effort langsung mengirim `session/set_model` dengan model
  aktif. Effort di luar daftar yang didukung tidak dikirim.
- Temuan 4: Settings dan composer berbagi jalur `setAccess`, termasuk sinkronisasi
  nilai kontrol. Mode hasil attach juga dicerminkan ke Settings.
- Temuan 5: kegagalan/pembatalan kompaksi dan awal/kegagalan recovery sekarang
  tampil di transcript. Tampilan goal, scheduler dan memory masih belum tersedia.
- README web diperbarui agar menjelaskan transport leader yang sudah tersedia.

Tes regresi menelusuri store sampai JSON-RPC melalui fake WebSocket, termasuk
ketiga hasil plan approval, jawaban client lain, effort mandiri, kedua kontrol
permission, failure envelope string/structured, partial success dan notifikasi
kompaksi/recovery. Pengujian browser dengan leader hidup masih belum dijalankan.

Verifikasi setelah implementasi:

| Pemeriksaan | Hasil |
| --- | --- |
| `npm run check` | Lulus, 0 error dan 0 warning |
| `npm run lint` | Lulus |
| `npm test` | Lulus, 29 file / 470 tes (13 regresi tambahan) |
| `npm run build` | Lulus; Vite masih memperingatkan chunk besar |
| `git diff --check` | Lulus |

Gate Cargo tidak dijalankan karena perubahan implementasi hanya menyentuh web.
Matriks awal tetap menjadi catatan audit; status perbaikan terbaru mengikuti
bagian tindak lanjut ini. Gap fitur lain di matriks belum diimplementasikan.

## Tindak lanjut graph

Graph sekarang memiliki workspace tersendiri di header, termasuk saat belum
ada graph. Panel mencakup diagram dependensi dengan zoom dan pemilihan node,
daftar node yang bisa difilter, spesifikasi/dependensi/dependen tiap node,
status dan alasan gagal, ronde/token yang tercatat, aktivitas worker/verifier
beserta transcript-nya, riwayat, penemuan baru, dan versi plan hasil replan.
Snapshot dan aktivitas diperbarui setiap dua detik selama panel terbuka.
Pemetaan worker memeriksa identitas spawn dan waktu pembuatan graph agar replay
aktivitas lama tidak ikut tampil pada graph baru dengan id node yang sama.

Kontrol mendukung start, membuat graph baru setelah selesai, pause di batas
eksekusi, stop turn, resume dengan tambahan budget, dan clear dengan konfirmasi.
API actor `alnair/graph/get` mengembalikan snapshot lengkap serta counter goal
untuk node serial yang id-nya cocok. `alnair/graph/control` memeriksa graph id;
snapshot project bersifat read-only dan clear ditolak selama turn berjalan.
Konfirmasi clear di browser tidak berlaku lagi ketika graph diganti.

Verifikasi graph mencakup tes layout/command/pemetaan worker, JSON-RPC untuk
session kedua dan error graph stale, tes Rust untuk snapshot/ownership/pause/
clear, serta smoke test browser desktop dan mobile. Smoke test memakai leader
tiruan, tanpa panggilan provider. Ini tidak memvalidasi inference model nyata.
Pemeriksaan browser juga menemukan dan memperbaiki crash pemilih model ketika
katalog kosong, agar inspeksi graph tetap dapat dibuka.

Verifikasi web terbaru setelah implementasi graph:

| Pemeriksaan | Hasil |
| --- | --- |
| `npm run check` | Lulus, 0 error dan 0 warning |
| `npm run lint` | Lulus |
| `npm test` | Lulus, 31 file / 503 tes; 1 tes replay dilewati karena fixture eksternal tidak tersedia |
| `npm run build` | Lulus; peringatan chunk besar masih ada |
| `npm run test:graph-ui` | Lulus, browser desktop dan mobile dengan leader tiruan |
| Tes Rust `graph_client` | Lulus, 2 tes actor; pengulangan menggunakan binary test terbaru karena antrean lock Cargo bersama |
| `cargo fmt --all --check` | Lulus |
| `git diff --check` pada file graph/web/dokumentasi | Lulus |

Gate advisory mendeteksi dependency yang sudah ada, `pin-utils` 0.1.0,
sebagai tidak terawat (`RUSTSEC-2026-0441`), tanpa safe upgrade yang ditawarkan.
Audit ini tidak menambahkan pengecualian advisory atau mengubah dependency itu.
