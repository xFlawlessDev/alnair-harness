import type { SiteCopy } from './types';

/**
 * Indonesian copy.
 *
 * Written as Indonesian rather than a word-for-word overlay: command names,
 * file paths, environment variables and provider ids stay verbatim because
 * they are what the reader will type.
 */
export const id = {
	meta: {
		title: 'Alnair — graph engineering untuk terminal',
		description:
			'Coding agent independen yang tidak terikat pada satu penyedia. /graph mengubah satu tujuan menjadi dependency graph berisi loop agent yang memverifikasi dirinya sendiri — direncanakan, diparalelkan, diuji secara adversarial, lalu di-merge. Apache-2.0, tanpa telemetri, satu binary.'
	},

	nav: {
		features: 'Fitur',
		graph: 'Graph',
		lessons: 'Lessons',
		providers: 'Provider',
		install: 'Instal',
		docs: 'Dokumentasi',
		source: 'Sumber',
		theme: 'Ganti tema',
		language: 'Bahasa',
		menu: 'Menu'
	},

	hero: {
		badge: 'Apache-2.0 · tanpa telemetri · satu binary',
		title: [
			{ text: 'Coding agent yang menjalankan ' },
			{ text: 'graph', accent: true },
			{ text: ', bukan loop.' }
		],
		lede: 'Alnair membaca repo, menulis patch, menjalankan test, dan terus bekerja sementara Anda mengerjakan hal lain. /graph mengubah satu tujuan menjadi dependency graph berisi loop agent otonom yang memverifikasi dirinya sendiri — direncanakan, diparalelkan, diuji secara adversarial, lalu di-merge.',
		primary: 'Instal Alnair',
		secondary: 'Lihat cara kerja /graph',
		note: 'Satu file, tanpa runtime. macOS dan Linux arm64/x86_64, Windows x86_64, diverifikasi terhadap SHA256SUMS rilis.',
		demoCaption: 'TUI apa adanya.',
		play: 'Putar demo'
	},

	stats: [
		{ value: '29', label: 'provider terpasang', detail: '5 sign-in, 24 API key' },
		{ value: '3', label: 'node graph sekaligus', detail: 'default; 1–8 bisa diatur' },
		{ value: '0', label: 'telemetri', detail: 'tanpa analytics, selamanya' },
		{ value: '1', label: 'binary statis', detail: 'tanpa runtime tambahan' }
	],

	graph: {
		eyebrow: 'Graph engineering',
		title: [{ text: 'Satu tujuan masuk.' }, { text: ' Perubahan terverifikasi keluar.' }],
		lede: 'Agent lain menjalankan loop: pikir, lakukan, ulangi — satu thread, satu hal sekaligus. /graph menjalankan dependency graph. Pekerjaan yang tidak memblokir pekerjaan lain berjalan bersamaan, di git worktree terpisah, dan tidak ada yang di-merge sebelum ada pihak lain yang mencoba merobohkannya.',
		steps: [
			{
				title: 'Rencanakan, lalu validasi',
				body: 'Planner memecah tujuan menjadi dependency DAG. Sebuah gate statis memvalidasinya — tanpa siklus, dengan node verifikasi terminal yang bergantung pada semua node lain — sebelum satu worker pun berjalan.'
			},
			{
				title: 'Sebar paralel',
				body: 'Setiap node yang siap berjalan sebagai worker paralel di git worktree-nya sendiri, masing-masing loop agent biasa. Sisi antar-node tetap ditentukan Rust.'
			},
			{
				title: 'Coba dirobohkan',
				body: 'Verifikator adversarial harus gagal merobohkan sebuah node sebelum hasilnya di-merge. Vonisnya kontrak terminal yang dibaca fail-closed: tidak ada vonis, tidak ada merge.'
			},
			{
				title: 'Replan, append-only',
				body: 'Worker yang menemukan pekerjaan di luar cakupan menulis DISCOVERED: dan graph merencanakan ulang di sekitarnya — append-only, jadi keputusan yang sudah disepakati tidak ditulis ulang, dan gate akhir tidak bisa dimasuki berulang.'
			},
			{
				title: 'Merge satu per satu',
				body: 'Merge-back berjalan berurutan. Konflik menggagalkan node itu dan hanya memblokir dependennya; rantai lain tetap berjalan.'
			},
			{
				title: 'Verifikasi keseluruhan',
				body: 'Node akhir memeriksa ulang seluruh tujuan memakai mesin agent penuh sebelum graph boleh menyatakan dirinya selesai. Budget yang habis menjeda; /graph resume --budget melanjutkannya.'
			}
		],
		commandTitle: 'alnair — graph',
		commandLines: [
			[
				{ text: '❯ ', tone: 'accent' },
				{ text: '/graph', tone: 'accent' },
				{ text: ' ship the billing refactor --budget 500000' }
			],
			[{ text: '  planning · 7 nodes · 4 ready', tone: 'dim' }],
			[
				{ text: '  ✓ gn-plan          ', tone: 'ok' },
				{ text: 'verified  decompose the objective', tone: 'dim' }
			],
			[
				{ text: '  ◉ gn-billing-api   ', tone: 'info' },
				{ text: 'running   worker round 2/3', tone: 'dim' }
			],
			[
				{ text: '  ◉ gn-billing-ui    ', tone: 'info' },
				{ text: 'running   worker round 1/3', tone: 'dim' }
			],
			[
				{ text: '  ◌ gn-billing-tests ', tone: 'dim' },
				{ text: 'waiting   needs gn-billing-api', tone: 'dim' }
			],
			[
				{ text: '  ◇ gn-final         ', tone: 'dim' },
				{ text: 'blocked   verifies the objective', tone: 'dim' }
			]
		],
		state:
			'Status tersimpan di .alnair/graph.jsonl, di samping kode Anda. Tutup laptop, besok buka lagi, /graph resume. Rekan setim bisa melanjutkannya dari file yang sama.',
		config:
			'Aktif secara default. ALNAIR_GRAPH=0 mematikannya; ALNAIR_GRAPH_CONCURRENCY mengatur berapa node berjalan bersamaan.',
		diagramCaption:
			'Graph yang sama seperti yang digambar /graph show: box drawing di terminal, tanpa perlu dashboard.',
		nodes: [
			{ id: 'gn-plan', label: 'gn-plan', note: 'uraikan tujuan', state: 'verified' },
			{ id: 'gn-api', label: 'gn-api', note: 'rute + skema', state: 'running' },
			{ id: 'gn-ui', label: 'gn-ui', note: 'layar', state: 'running' },
			{ id: 'gn-tests', label: 'gn-tests', note: 'unit + integrasi', state: 'ready' },
			{ id: 'gn-final', label: 'gn-final', note: 'verifikasi tujuan', state: 'blocked' }
		],
		states: {
			verified: 'terverifikasi',
			running: 'berjalan',
			ready: 'siap',
			blocked: 'terblokir'
		}
	},

	lessons: {
		eyebrow: 'Lessons',
		title: [{ text: 'Ia mencatat' }, { text: ' kesalahannya sendiri.', accent: true }],
		lede: 'Saat sebuah goal terus gagal dengan cara yang sama, Alnair sudah berhenti dan mencari penyebabnya — lalu dulu membuang jawaban itu begitu goal selesai. Lessons menyimpannya. Satu lesson mencatat apa yang salah pada harness di repo ini dan apa yang memperbaikinya; sesi berikutnya dimulai dengan tiga catatan terbaru.',
		points: [
			{
				title: 'Tidak ada catatan, tidak ada suntikan.',
				body: 'Store kosong mengubah prompt Anda sebesar nol byte — itulah yang membuat fitur ini aman dibiarkan aktif.'
			},
			{
				title: 'Tidak pernah di dalam repo.',
				body: 'Lessons tinggal di ~/.alnair/lessons/, di luar version control. File yang otomatis dibaca ke dalam konteks adalah file yang bisa dipakai checkout berbahaya untuk mengarahkan setiap sesi berikutnya.'
			},
			{
				title: 'Markdown yang bisa Anda ubah.',
				body: 'Tidak setuju dengan satu entri? Hapus. Jalan keluarnya editor teks — tanpa skema, tanpa migrasi.'
			}
		],
		snippetTitle: '~/.alnair/lessons/LESSONS.md',
		snippetLines: [
			[{ text: '<harness-lessons>', tone: 'dim' }],
			[{ text: '## Lessons from earlier sessions', tone: 'plain' }],
			[{ text: 'These are notes about how the harness', tone: 'dim' }],
			[{ text: 'worked here, not facts about the code.', tone: 'dim' }],
			[{ text: 'Apply one only when the situation matches.', tone: 'dim' }],
			[{ text: '' }],
			[{ text: '### Verification gaps keep reopening', tone: 'accent' }],
			[{ text: 'Restructure the unit under test rather', tone: 'plain' }],
			[{ text: 'than patching the symptom; split the', tone: 'plain' }],
			[{ text: 'tangled module first. (workflow)', tone: 'plain' }],
			[{ text: '</harness-lessons>', tone: 'dim' }]
		],
		footnote:
			'Aktif secara default. ALNAIR_LESSONS=0 mematikannya, dan [lessons] di config.toml mengatur batasnya.'
	},

	features: {
		eyebrow: 'Selebihnya',
		title: [{ text: 'Sebuah harness,' }, { text: ' bukan jendela chat.', accent: true }],
		lede: 'Bagian-bagian yang baru terasa ketika tidak ada.',
		docsLink: 'Baca panduan pengguna',
		items: [
			{
				sample: 'dashboard',
				wide: true,
				title: 'Satu dashboard untuk semua agent',
				body: 'Setiap sesi yang sedang berjalan, diurutkan berdasarkan status: siapa yang menunggu jawaban Anda, siapa yang bekerja, dan apa yang sedang dikerjakan. Jawab permintaan izin langsung dari panel peek tanpa membuka percakapannya.'
			},
			{
				sample: 'tabs',
				wide: true,
				title: 'Tab lintas repositori',
				body: 'Setiap tab membawa direktori sesinya sendiri, jadi satu strip bisa memuat tiga repo sekaligus. F2 membukanya; strip menjadi jendela yang bisa digeser alih-alih memotong chip di tepi layar.'
			},
			{
				sample: 'subagents',
				title: 'Subagent',
				body: 'Sesi anak dengan context window sendiri, jadi riset dan implementasi tidak memakan anggaran sesi induk.'
			},
			{
				sample: 'mcp',
				title: 'Server MCP',
				body: 'stdio, SSE, dan streamable HTTP, dikelola dari CLI atau config.toml. Server yang gagal start akan melapor, bukan diam-diam menghilangkan tool-nya.'
			},
			{
				sample: 'skills',
				title: 'Skills',
				body: 'Prosedur yang bisa dipakai ulang sebagai file markdown. Model membaca deskripsinya untuk memutuskan kapan memuatnya.'
			},
			{
				sample: 'permission',
				title: 'Izin',
				body: 'Setiap pemanggilan tool yang bisa mengubah sesuatu berhenti di sini dulu. Izinkan sekali, satu perintah, satu sesi, atau tidak sama sekali.'
			},
			{
				sample: 'hooks',
				title: 'Hooks',
				body: 'Perintah shell dan callback HTTP di sekitar pemakaian tool dan siklus sesi. Hook PreToolUse bisa membatalkan pemanggilan itu.'
			},
			{
				sample: 'sandbox',
				title: 'Profil sandbox',
				body: 'Isolasi filesystem dan jaringan yang ditegakkan OS, dipilih per sesi dan berlapis di bawah aturan izin.'
			},
			{
				sample: 'headless',
				title: 'Mode headless',
				body: 'alnair -p menjawab satu prompt lalu keluar dengan status, sehingga job CI bisa bergantung padanya dan skrip bisa memipanya.'
			},
			{
				sample: 'web',
				title: 'Tampilan browser',
				body: 'alnair web menyajikan klien dari proses leader yang sama, jadi turn yang mengalir di terminal juga mengalir di browser.'
			},
			{
				sample: 'theme',
				title: 'Tema milik Anda',
				body: 'Setiap tema, palet sintaks, dan glyph adalah pengaturan, lengkap dengan mode plain untuk terminal yang tidak pernah mendapatkannya.'
			}
		]
	},

	providers: {
		eyebrow: 'Provider',
		title: [{ text: 'Bawa langganan' }, { text: ' yang sudah Anda bayar.', accent: true }],
		lede: 'Masuk sekali dan Alnair memakai paket yang sudah Anda bayar. Tanpa API key untuk disalin, tanpa tagihan kedua. Token tiap provider disimpan di kuncinya sendiri, dan kredensial satu provider tidak pernah dikirim ke provider lain.',
		signIn: 'Masuk dengan langganan',
		signInNote: 'Lima provider, masing-masing dengan alur OAuth dan scope tersendiri.',
		rows: [
			{ name: 'Kimi Code', id: 'kimi-code', method: 'Device code' },
			{ name: 'Claude Pro/Max', id: 'claude-pro-max', method: 'Browser · PKCE' },
			{ name: 'ChatGPT Plus/Pro', id: 'openai-codex', method: 'Browser · PKCE' },
			{ name: 'GitHub Copilot', id: 'github-copilot', method: 'Device code' },
			{ name: 'xAI Grok', id: 'xai-grok', method: 'Device code' }
		],
		apiKeys: 'Atau bawa API key',
		apiKeysNote:
			'Dua puluh empat platform lain sudah terpasang. Ekspor environment variable-nya, atau simpan key di config.toml — key tidak pernah dicatat ke log.',
		keys: [
			'Moonshot',
			'OpenAI',
			'Anthropic',
			'DeepSeek',
			'Google Gemini',
			'Groq',
			'Mistral',
			'OpenRouter',
			'Together',
			'Cerebras',
			'Fireworks',
			'NVIDIA NIM',
			'Vercel AI Gateway',
			'xAI',
			'MiniMax',
			'Z.AI',
			'Qwen',
			'Xiaomi MiMo',
			'Kimi for Coding',
			'…dan lainnya'
		],
		customTitle: 'Atau arahkan ke endpoint Anda sendiri',
		customBody:
			'Apa pun yang berbicara OpenAI Chat Completions atau Anthropic Messages API bisa dipakai: gateway, proxy, Ollama, LM Studio, vLLM. Deklarasikan lewat base URL, dan /model akan mendaftar apa pun yang disajikan.',
		customCode: `[platforms.my-gateway]
base_url = "https://gateway.example.com/v1"
api = "openai"        # atau "anthropic"
api_key = "..."       # atau simpan di ~/.alnair/auth.json`,
		customFile: 'config.toml',
		copied: 'Tersalin'
	},

	install: {
		eyebrow: 'Instalasi',
		title: [{ text: 'Dua perintah' }, { text: ' menuju agent yang siap.', accent: true }],
		lede: 'Satu baris memasangnya. Satu lagi membuat Anda masuk. Setelah itu cukup alnair.',
		steps: [
			{ label: 'Instal', detail: 'Satu binary mendarat di ~/.alnair/bin.' },
			{ label: 'Masuk', detail: 'Pilih provider dan otorisasi.' },
			{ label: 'Jalankan', detail: 'Arahkan ke sebuah repositori.' }
		],
		unix: 'macOS / Linux',
		windows: 'Windows',
		commands: {
			unix: 'curl -fsSL https://raw.githubusercontent.com/xFlawlessDev/alnair-harness/master/install.sh | bash',
			windows:
				'irm https://raw.githubusercontent.com/xFlawlessDev/alnair-harness/master/install.ps1 | iex'
		},
		copy: 'Salin perintah instalasi',
		copied: 'Tersalin',
		connect: 'alnair connect',
		go: 'alnair',
		notes: [
			'Satu file, tanpa runtime, tidak menambah apa pun ke shell selain PATH.',
			'macOS arm64/x86_64 · Linux arm64/x86_64 · Windows x86_64.',
			'Diverifikasi terhadap SHA256SUMS rilis; alnair update menjaganya tetap terbaru.'
		],
		buildNote: 'Lebih suka membangunnya sendiri?',
		buildLink: 'Baca langkah build'
	},

	faq: {
		eyebrow: 'Pertanyaan',
		title: [{ text: 'Yang paling sering' }, { text: ' ditanyakan.', accent: true }],
		items: [
			{
				q: 'Apakah ini rebrand dari CLI lain?',
				a: 'Bukan. Alnair adalah coding agent independen dan fork keras dari Kigi-CLI, yang juga merupakan fork dari Grok Build Open Source milik xAI. Lisensi Apache-2.0 dan kedua atribusi upstream dipertahankan, dan Alnair punya binary sendiri, ~/.alnair sendiri, entri keyring sendiri, dan variabel ALNAIR_* sendiri. Alnair tidak pernah membaca atau menulis direktori home CLI lain — satu-satunya pengecualian adalah impor ~/.kimi yang opsional dan read-only.'
			},
			{
				q: 'Apa saja yang dikirim ke jaringan?',
				a: 'Hanya API yang Anda konfigurasi, server rilis Alnair untuk pembaruan, server MCP Anda sendiri, dan pencarian metadata provider bila daftar model tidak memuat yang dibutuhkan. Tanpa telemetri, tanpa analytics, selamanya.'
			},
			{
				q: 'Apakah berjalan di Windows?',
				a: 'Ya. Installer-nya PowerShell, binary-nya satu .exe statis, dan TUI-nya memperhitungkan keanehan keyboard konsol Windows — di ConHost polos ia menawarkan Alt+Enter untuk baris baru, bukan chord yang tidak akan pernah sampai.'
			},
			{
				q: 'Bisa dijalankan di CI?',
				a: 'alnair -p menjalankan satu prompt secara headless lalu keluar dengan hasilnya, sehingga job bisa menggantungkan status padanya. Sesi interaktif, dashboard, dan kendali graph tetap ada di TUI atau browser.'
			},
			{
				q: 'Bisakah editor saya mengendalikannya?',
				a: 'Bisa, lewat Agent Client Protocol. alnair web melangkah lebih jauh: ia menyajikan klien browser untuk proses leader yang sama, jadi turn yang mengalir di terminal juga mengalir di browser.'
			},
			{
				q: 'Lisensinya apa?',
				a: 'Apache-2.0. NOTICE memuat kedua atribusi upstream, dan baris --version menyebutkan proyek apa yang menjadi dasarnya.'
			}
		]
	},

	footer: {
		tagline: 'Coding agent untuk terminal, tidak terikat satu penyedia sejak awal.',
		product: 'Produk',
		project: 'Proyek',
		language: 'Bahasa',
		attribution:
			'Coding agent independen. Fork keras dari Kigi-CLI, yang juga merupakan fork dari Grok Build Open Source. Berbasis Grok Build Open Source, Copyright 2025–2026 X.AI Corp. Tidak berafiliasi dengan Moonshot AI maupun xAI.',
		license: 'Apache-2.0'
	}
} satisfies SiteCopy;
