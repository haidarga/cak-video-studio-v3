# CAK Video Studio v3 — Dokumentasi Lengkap

> Platform produksi konten video AI end-to-end: dari ide/naskah → generate visual konsisten → edit otomatis → QC → posting multi-channel. Internal tool, bukan SaaS publik.

Dokumen ini ngejelasin SEMUA: apa yang platform bisa, gimana sistemnya kerja, alur kerja (workflow/SOP), pipeline teknis, AI tools yang dipakai, dan proses end-to-end. Dibikin biar bisa dipelajari dari nol.

---

## DAFTAR ISI

1. [Gambaran Besar — Platform Ini Apa](#1-gambaran-besar)
2. [Arsitektur Sistem](#2-arsitektur-sistem)
3. [AI Models & External Services](#3-ai-models--external-services)
4. [Tab/Fitur Utama (16 halaman)](#4-tabfitur-utama)
5. [3 Cara Bikin Konten (Generate / God Mode / F Creator)](#5-tiga-cara-bikin-konten)
6. [God Mode — 19 AI Tools](#6-god-mode--19-ai-tools)
7. [Pipeline Teknis — Cara Generate Jalan](#7-pipeline-teknis)
8. [Konsistensi & Anti-Drift (5 Lapis Pertahanan)](#8-konsistensi--anti-drift)
9. [Editor & Auto-Edit](#9-editor--auto-edit)
10. [Voice Cloning](#10-voice-cloning)
11. [QC → Posting (Hilir Pipeline)](#11-qc--posting)
12. [SOP — Cara Pakai yang Bener](#12-sop-standard-operating-procedure)
13. [Governance: Budget, Usage, Error](#13-governance)
14. [Database (23 Tabel)](#14-database)
15. [Glosarium Istilah](#15-glosarium)

---

## 1. GAMBARAN BESAR

CAK Video Studio adalah **pabrik konten video AI**. Bedanya dengan tool generator biasa (Higgsfield, Leonardo, dll): mereka berhenti di "download file", platform ini lanjut sampai "konten ter-posting di TikTok sesuai jadwal".

**Yang platform ini bisa:**
- Generate **gambar** AI (produk, persona/karakter) yang konsisten
- Generate **video** AI dari gambar, dari teks, atau dari referensi (16 model video)
- Jaga **konsistensi** karakter + produk antar shot (anti-drift, anti-morph)
- **Continue shot** — nyambungin shot jadi sekuens yang nyambung mulus
- **Edit video** otomatis (potong, transisi, subtitle, hook text) — by prompt atau full auto
- **Clone suara** persona (ElevenLabs) + ganti suara di video tanpa rusak lip-sync
- **QC** kanban (review, approve, revise)
- **Schedule + posting** ke TikTok/IG/YouTube via Postiz
- **Autopilot** — paste 10 naskah, mesin kerjain semua, lu tinggal QC (F Creator)
- **God Mode** — ngobrol bahasa biasa, AI agent yang milih tool & model sendiri

**Konsep inti:** multi-tenant (workspace) → multi-brand → persona (karakter/talent) → produk → konten.

---

## 2. ARSITEKTUR SISTEM

Platform ini 3 lapis yang terpisah jelas:

```
┌─────────────────────────────────────────────────────────────┐
│  FRONTEND + API  — Next.js 14 di Vercel                      │
│  (repo: cak-video-studio-v3)                                 │
│  • Semua UI (16 tab dashboard)                               │
│  • 41 API route (serverless functions)                       │
│  • Render video JALAN DI BROWSER (ffmpeg.wasm)               │
└───────────────┬─────────────────────────────────────────────┘
                │
    ┌───────────┼───────────────┬──────────────┬──────────────┐
    ▼           ▼               ▼              ▼              ▼
┌────────┐ ┌─────────┐  ┌──────────────┐ ┌─────────┐  ┌──────────┐
│Supabase│ │ R2      │  │  fal.ai      │ │ Gemini  │  │ElevenLabs│
│Postgres│ │Cloudflare│ │ (gen video/  │ │ (LLM)   │  │ (voice)  │
│+Auth   │ │ storage │  │  image)      │ │         │  │          │
│+Realtime│└─────────┘  └──────────────┘ └─────────┘  └──────────┘
└────────┘                                              ┌──────────┐
                                                        │ Postiz   │
   ┌──────────────────────────────────────┐            │(posting) │
   │  RENDER BACKEND — HF Space (v2)       │            └──────────┘
   │  (repo: cak-video-studio-v2)          │
   │  • Express + Remotion + ffmpeg        │
   │  • /api/render, /api/stitch,          │
   │    /api/extract-audio, /api/clip-cut  │
   │  • Worker poll Supabase jobs          │
   └──────────────────────────────────────┘
```

**Kenapa render di browser?** Vercel gak punya ffmpeg. Jadi assembly final (gabung clip, transisi, subtitle) jalan pakai **ffmpeg.wasm** di browser user. Konsekuensi: tab harus kebuka selama proses render.

**Kenapa data aman walau hosting pindah?** Vercel cuma "baju" — gak nyimpen data. Semua state ada di Supabase (database), R2 + fal.media (media), GitHub (kode). Akun Vercel mati → import ulang repo → semua nyambung lagi.

---

## 3. AI MODELS & EXTERNAL SERVICES

### Service yang dipakai (7)

| Service | Fungsi |
|---|---|
| **fal.ai** | Generate video & image (16+ model). Bayar at-cost (harga grosir, bukan markup kredit). |
| **Google Gemini** | LLM: parse naskah, agent God Mode, caption, analisis video, transcribe. |
| **ElevenLabs** | Voice cloning + Speech-to-Speech (ganti suara, lip-sync aman). |
| **Postiz** | Scheduling + posting ke TikTok/IG/YouTube multi-channel. |
| **Cloudflare R2** | Storage media (egress gratis — alasan pindah dari Supabase Storage). |
| **Supabase** | Database (Postgres) + Auth + Realtime. |
| **OpenAI** | GPT Image 2 (via fal.ai) + fallback LLM. |

### Model VIDEO — yang PALING PENTING dipahami: 3 jenis input

Tiap keluarga model (Grok, Seedance, Happy Horse, Kling) punya **varian** dengan akhiran beda. Akhiran ini menentukan APA yang dia terima sebagai input — ini yang bikin fungsinya beda, bukan nama keluarganya:

| Akhiran | Singkatan | Terima apa | Kapan dipakai |
|---|---|---|---|
| `image-to-video` | **i2v** | **1 gambar** sumber → dianimasiin | Mode Per-Shot: udah punya 1 image yang di-approve, tinggal gerakin. |
| `reference-to-video` | **r2v** | **banyak gambar referensi** (orang + produk) → bikin video BARU yang ngikutin identitas/style refs | Kalau mau **produk/wajah tetep konsisten** di video TAPI komposisinya baru. Ini senjata anti-drift. |
| `text-to-video` | **t2v** | **teks doang**, gak ada gambar | Direct Video / b-roll generik, gak perlu wajah/produk spesifik. |

> **Salah kaprah yang gua tulis di versi lama dokumen ini:** "cuma Kling yang bawa refs ke video". **SALAH.** Grok, Seedance, dan Happy Horse SEMUA punya varian **r2v (reference-to-video)** yang bawa refs produk/orang ke video. Lu **gak butuh Kling** buat konsistensi produk — tinggal pakai varian r2v dari model yang lu udah suka.
>
> Bedanya cuma: **i2v** keluarga Grok/Seedance/Happy Horse cuma terima 1 gambar (refs ke-2 dst di-drop). Kalau pake i2v dan butuh produk konsisten → **pindah ke varian r2v-nya**, bukan pindah ke Kling.

### Model VIDEO — per keluarga (diurut sesuai yang lu pakai)

**🟢 GROK IMAGINE (xAI) — workhorse murah lu, ~$0.07/dtk, ada audio, 720p**
| Varian | Harga/dtk | Max durasi | Catatan |
|---|---|---|---|
| Grok i2v | ~$0.07 | 15 dtk | Animasiin 1 gambar. Termurah yang ada audio. Default draft. |
| Grok **r2v** | ~$0.07 | 10 dtk | Multi-ref (max 6), **gak morph dari grid** — ini buat jaga produk/wajah. |
| Grok t2v | ~$0.07 | 10 dtk | Teks murni → video + audio. |
| Grok **1.5** i2v | ~$0.14 | 15 dtk | Versi kualitas lebih tinggi, masih ada audio. Naik kelas tanpa pindah keluarga. |

**🟢 SEEDANCE (ByteDance) — kualitas gerak/fidelity terbaik di rotasi lu**
| Varian | Harga/dtk | Max durasi | Catatan |
|---|---|---|---|
| Seedance Lite **r2v** | ~$0.16 | 15 dtk | Multi-ref murah (max 9 refs). Pintu masuk fidelity tinggi. |
| Seedance 2 Fast i2v | ~$0.24 | 15 dtk | Gerak paling natural, identity kuat. |
| Seedance 2 Fast **r2v** | ~$0.24 | 15 dtk | Multi-ref (max 9) + fidelity Seedance. **Pilihan kuat buat produk.** |
| Seedance 2 t2v | ~$0.30 | 15 dtk | Premium photoreal dari teks, native audio. Termahal. |

**🟢 HAPPY HORSE (Alibaba) — serbaguna, native audio, bisa 1080p**
| Varian | Harga/dtk | Max durasi | Catatan |
|---|---|---|---|
| Happy Horse i2v | ~$0.14 | 15 dtk | Animasiin 1 gambar, native audio. |
| Happy Horse **r2v** | ~$0.14 | 15 dtk | Multi-ref (max 9). Audio + konsistensi sekaligus. |
| Happy Horse t2v | ~$0.14 | 15 dtk | Teks → video, native audio (1080p ~$0.28/dtk). |

**⚪ KLING (alternatif — JARANG lu pakai, di sini buat kelengkapan aja)**
| Varian | Harga/dtk | Catatan |
|---|---|---|
| Kling v3 i2v | ~$0.08 | Uniknya: i2v-nya bisa terima refs tambahan (max 4) sekaligus. |
| Kling O3 i2v | ~$0.11 | Ada audio. |
| Kling 2.5 Pro r2v | ~$0.12 | Multi-ref, no morph. |
| Kling v3 t2v | ~$0.13 | Multi-shot dari teks. |
| Kling v3 Pro i2v | ~$0.28 | Kualitas paling tinggi di keluarga Kling. |

**Aturan pendek milih model video:**
- Cuma punya **1 gambar**, gak ada produk kritis → **i2v** (Grok i2v paling murah).
- Ada **produk/wajah** yang HARUS persis → **r2v** dari keluarga manapun (Grok r2v termurah, Seedance r2v paling fidelity).
- **Gak ada gambar** sama sekali, b-roll generik → **t2v**.
- Butuh **lebih cakep** tanpa ribet → naik ke Grok 1.5, atau Seedance 2 Fast.

### Model VIDEO EDIT (3) — ngubah video yang UDAH ADA (bukan generate baru)

Ini bukan buat bikin video dari nol — buat nransform footage yang udah jadi. Dipakai God Mode (`edit_video` / `extend_video`).

| Model | Harga/dtk | Fungsi |
|---|---|---|
| Grok edit-video | ~$0.08 | Edit global murah: colorize, ganti mood/style seluruh klip. |
| Grok extend-video | ~$0.08 | Nyambungin/manjangin footage asli (dipakai continue-shot video). |
| Happy Horse video-edit | ~$0.28 | Edit ber-anchor referensi — ubah sesuatu tapi identitas dijaga (max 5 ref), bisa 1080p. |

### Model IMAGE (4) — bedanya: seberapa "ngunci" referensi

Sumbu utamanya: apakah model **mengunci pixel referensi** (hasil mirip persis foto sumber) atau cuma **menjadikan referensi sebagai petunjuk** (bebas ngikutin teks prompt buat outfit/komposisi).

| Model | Harga | Sifat ref | Kapan dipakai |
|---|---|---|---|
| **Nano Banana 2** edit | ~$0.04 | Multi-ref (max 12), outfit **adaptif** — refs jadi panduan, outfit ngikut prompt | Default draft. Cepet, murah, fleksibel ganti baju/scene. |
| **GPT Image 2** (generation) | ~$0.06 | Refs sebagai **hint**, gak pixel-lock | Mau wajah/style mirip tapi komposisi/outfit bebas ikut prompt. |
| **GPT Image 2 edit** | ~$0.06 | **Pixel-lock** refs + **render teks terbaik** | Produk berlabel (charger, kemasan) — teks/logo harus tajam & bener. |
| **Grok Imagine edit** | ~$0.05 (1k) / $0.07 (2k) + $0.01/input | Multi-ref (max 8) edit | Edit cepat ber-referensi, sejalur sama keluarga Grok. |

**Aturan pendek milih model image:**
- Draft cepat / ganti outfit-scene bebas → **Nano Banana 2**.
- Ada **teks/label produk** yang harus legible → **GPT Image 2 edit** (pixel-lock).
- Mau identitas mirip tapi komposisi bebas → **GPT Image 2** (generation).

---

## 4. TAB/FITUR UTAMA

16 halaman dashboard:

| Tab | Fungsi |
|---|---|
| **Dashboard** | Overview: stats, cost hari ini/bulan, forecast, activity, errors. |
| **Generate** | Generate manual presisi — kontrol per-shot penuh. |
| **God Mode** | AI agent chat — ngobrol bahasa biasa, AI pilih tool & model. |
| **F Creator** | Autopilot factory — paste N naskah, mesin kerjain semua → QC. |
| **Editor** | Editor multi-track (timeline, transisi, text, subtitle, export MP4). |
| **Studio** | Mode lama (single-mode, camera preset, storyboard). Legacy. |
| **QC** | Kanban review: pending → approved/revise/rejected. Voice swap, AI Edit, 1080p re-encode di sini. |
| **Scheduled** | Lihat post yang dijadwalin. |
| **Posting** | Posting dashboard ke Postiz channel. |
| **Personas** | Manage karakter/talent: refs, voice, Soul LoRA, channel. |
| **Brands** | Library brand (notes, config) — "folder" konten. |
| **References** | Bank gambar referensi (produk 📦 / karakter 👤 / style 🎨) + knowledge. |
| **Results** | Galeri semua hasil gen. |
| **Team** | Member workspace + role. |
| **Settings** | API keys, budget, LLM config. |
| **Errors** | Log error sistem. |

---

## 5. TIGA CARA BIKIN KONTEN

Platform punya **tangga otomasi 3 lapis** di atas pipeline yang sama. Pilih sesuai kebutuhan:

### A. GENERATE — Manual Presisi
Kontrol penuh per shot. Cocok kalau lu mau ngutak-atik tiap detail.
```
Pilih persona → paste naskah → Parse → gen image (re-img sampai oke) →
approve → gen video → Send to QC
```
Filosofi: **image murah, video mahal — saring di level image dulu.**

#### Setup bar Generate — tiap kontrol ngapain

Ini semua tombol di panel atas tab Generate (yang ada di screenshot), dijelasin satu-satu:

**📷 Camera Preset (paling atas — "L1 tokens, highest priority")**
Ini yang **paling ngedikte tampilan**. Dia nyuntik ~6 token style di prioritas tertinggi (di atas prompt naskah) — device, lighting, look. Makanya disebut L1. Grup preset:
- **Phone** — Samsung A13 candid (UGC TikTok handheld) / iPhone 15 clean (UGC poles, talking-head).
- **Cinema** — Studio TVC (locked-off, lighting terkontrol) / Anamorphic (hero film) / Product macro (e-commerce key visual) / Documentary handheld.
- **Animation** — 2D explainer / Pixar-style 3D.
- **Custom** — preset bikinan sendiri (contoh: "AceKid chibi 2D storybook").

Token preset **override** quality-line generik, jadi gak ada kontradiksi "shot on Samsung A13" + "professional high-detail photography" barengan. **Pilih preset = kunci style** biar konsisten antar shot/konten. Bisa Clone / Bikin Preset baru.

**🎬 Mode (Per-Shot / Storyboard / Direct)** — ini nentuin ALUR gen:
| Mode | Cara kerja | Kapan |
|---|---|---|
| **Per-Shot** (image→video) | Gen 1 image per shot dulu (murah) → approve yang oke → baru animasiin ke video | Default. Kontrol + saring maksimal, hemat (buang yang jelek di level image). |
| **Storyboard 3×3** (~15s) | Gen **1 gambar grid 3×3** berisi 9 still berurutan → dianimasiin | Cepet & murah, dapet 9 keyframe sekaligus. Anti-morph antar panel dijaga prompt grid. |
| **Direct Video** (skip image, refs only) | Langsung ke video dari refs, **gak lewat image** | Paling cepat tapi paling mahal per percobaan & kontrol paling sedikit. Buat b-roll cepat. |

**Shot Count** — Auto (LLM yang nentuin jumlah shot dari naskah) atau angka fix.

**Aspect Ratio** — 9:16 vertikal (TikTok/Reels), 16:9 (YouTube landscape), 1:1.

**Bahasa Dialog** — bahasa dialog yang diucapin di video (Indonesian / dst).

**Image Model & Video Model** — dua dropdown pilih model (lihat tabel di Bagian 3). Image murah dipakai di tahap saring, video mahal cuma buat yang udah di-approve.

**⚙️ Constraints (4 toggle bawah)** — batasan keras yang dikirim ke prompt:
| Toggle | Efek |
|---|---|
| **No cuts** | Satu take kontinu, gak ada potongan cut-to-cut di dalam klip. Bunuh artefak "patah cut". |
| **No dialog** | Gak ada omongan / gerak bibir. Buat b-roll diam. |
| **No text** | Gak ada caption/teks ke-bake di dalam video gen. |
| **No product** | Lifestyle only, gak ada kemasan/produk di frame. |

Alur lengkap Per-Shot: `Camera Preset → pilih persona → paste naskah → Parse → gen Images (re-img sampai oke) → approve → gen Videos dari yang approved → Send to QC`.

### B. GOD MODE — Conversational
Ngobrol bahasa biasa. AI agent (Gemini) milih tool & model yang cocok sendiri.
```
"bikin video review charger UGREEN, pake Seedance r2v, 10 detik, ada dialog"
→ AI parse maksud → pilih tool gen_video → pilih model → eksekusi
```
Punya 19 tools (lihat bagian 6). Bisa edit/extend video, analisis referensi, scoring viral, dll — semua lewat chat.

### C. F CREATOR — Autopilot Factory 🏭
Paste banyak naskah sekaligus, mesin kerjain semua tanpa ditungguin.
```
Setup (persona, mode, model, preset, toggle) sekali →
paste 10 naskah → RUN FACTORY →
[per naskah: parse → gen image → gen video (KONTI chain) →
 auto-assemble + transisi + subtitle → optional voice swap → QC]
→ lu tinggal QC
```
- **Worker pool 4 paralel** — 4 naskah jalan barengan.
- **Resume-safe** — refresh/crash lanjut dari stage terakhir, gen gak dibayar ulang.
- **Mode bisa dipilih:** Per-Shot / Storyboard / Direct. Model image+video bisa diatur. Camera preset bisa dipilih (kunci style).
- **Tab harus kebuka** selama jalan (render di browser).

---

## 6. GOD MODE — 19 AI TOOLS

Agent Gemini milih tool ini otomatis dari maksud chat lu:

**Generate:**
| Tool | Fungsi |
|---|---|
| `gen_image` | Generate 1 gambar dari prompt; auto-attach refs persona/produk. |
| `gen_video` | Generate 1-5 video paralel; motion prompt, durasi 3-15s, refs auto. |
| `continue_shot` | Shot berikutnya dalam sekuens — karakter/setting sama, action maju. |
| `edit_video` | Ubah video yang udah ada via teks (Happy Horse / Grok). |
| `extend_video` | Perpanjang footage asli (Grok extend). |

**Dari URL produk:**
| Tool | Fungsi |
|---|---|
| `scrape_url_for_marketing` | Preview naskah dari URL produk (gak gen). |
| `gen_image_from_url` | Gambar marketing dari URL produk. |
| `gen_marketing_video_from_url` | Scrape URL → gen N video sesuai durasi/tema/model. |

**Analisis & strategi:**
| Tool | Fungsi |
|---|---|
| `analyze_reference_video` | Analisis video (YouTube/upload): style, kamera, mood, pacing. |
| `predict_virality` | Skor viral (hook/retention/visual 0-100). |
| `brand_builder` | Bikin brand dari ide niche: nama, tagline, deskripsi, prompt foto/video. |

**Bulk & campaign:**
| Tool | Fungsi |
|---|---|
| `mass_image_variants` | 5-30 variasi gambar di scene/konsep berbeda. |
| `viral_ad_campaign` | Workflow agency: gen N konsep → skor → ranking → paket produksi final. |
| `viral_clip_cut` | Potong video panjang jadi klip platform (TikTok 60s, dll). |

**Library & persona:**
| Tool | Fungsi |
|---|---|
| `list_personas` | List persona di workspace + brand aktif. |
| `list_product_refs` | List produk (gambar + knowledge sheet). |
| `suggest_cinematic_preset` | Cocokin vocab kamera/motion ke preset, kasih top 3. |
| `list_cinematic_presets` | List semua preset per kategori. |
| `train_persona_soul` | Mulai training LoRA persona (min 4 ref image). |

**Smart Model Router:** Agent punya logika milih model berdasarkan (1) tipe input — text → t2v, 1 gambar → i2v, multi-ref/produk → r2v, video existing → edit/extend; lalu (2) kebutuhan — "murah/draft" → Grok, "paling bagus/final" → Seedance, "ada dialog/audio" → Happy Horse / Seedance / Grok (semua ber-audio).

---

## 7. PIPELINE TEKNIS

### Alur generate video (webhook-driven, anti-polling)

```
1. User klik gen → POST /api/fal/submit
2. Server: budget gate (cek limit) → kalau lolos, submit ke fal.ai queue
   + kasih webhookUrl + insert baris ke tabel `gen_jobs` (status pending)
3. fal.ai kerjain gen (1-15 menit) → pas selesai POST ke /api/fal/webhook
4. Webhook update baris gen_jobs → status done + URL hasil
5. Supabase Realtime push ke browser → UI update otomatis (zero polling)
```

**Lapisan pengaman (kalau webhook drop):**
- Fallback poll tiap 20 detik (cek Supabase + fal direct status)
- Probe instan pas tab balik fokus (visibilitychange)
- Auto-refresh session kalau token expire mid-gen (401)
- Hard timeout 15-20 menit
- Tombol retry (cap 3x, re-gate budget biar gak double-charge)
- Mirror input ke fal storage kalau "file_download_error" (R2 dev domain kadang di-rate-limit)

### Path penting di kode
| File | Peran |
|---|---|
| `src/lib/fal-client.js` | Runner fal.ai sisi browser (submit + tunggu webhook/realtime). |
| `src/lib/fal-server.js` | SDK fal.ai sisi server. |
| `src/lib/fal-paths.js` | Resolusi path model canonical (alias → canonical). |
| `src/lib/god-mode-builders.js` | Builder input per-model (tiap model beda field). |
| `src/lib/budget-gate.js` | Hard limit spending sebelum panggil fal. |
| `src/app/api/fal/submit/route.js` | Endpoint submit gen. |
| `src/app/api/fal/webhook/route.js` | Penerima callback fal. |

---

## 8. KONSISTENSI & ANTI-DRIFT

Masalah inti AI video: karakter & produk **berubah bentuk (drift/morph)** antar frame/shot. Platform lawan ini di **5 lapis**:

1. **Knowledge directive** — field "knowledge" di ref produk (label, dimensi, jumlah port) ditempel ke tiap prompt sebagai jangkar teks. Tanpa ini model cuma lihat gambar buram.
2. **IMAGE ROLES** — tiap gambar referensi dikasih peran eksplisit di prompt video:
   - Produk → "MUST appear, label akurat, multi-angle sheet = SATU produk"
   - Karakter → "IDENTITY only, ABAIKAN background/pose foto ref"
3. **Rigid-product directive** — "produk = benda kaku, bentuk/label identik tiap frame, gerakan dari kamera+orang bukan produk meleyot".
4. **KONTI chain / extend** — shot berikutnya mulai dari **frame terakhir** shot sebelumnya (bukan dari nol). Continue-shot 3 lapis: extend-video native > last-frame anchor > carry refs.
5. **Image-first checkpoint** — saring di level image yang murah ($0.04) sebelum bayar video yang mahal.

**Aturan praktis produk:** Image pakai GPT Image 2 Edit (pixel-lock label) → approve → Video pakai **varian r2v** (reference-to-video) dari model manapun — **Grok r2v** (~$0.07, termurah), **Seedance r2v** (~$0.16–0.24, fidelity tertinggi), atau **Happy Horse r2v** (~$0.14, ada audio). Kuncinya **r2v, bukan i2v** — i2v cuma terima 1 gambar jadi produk gampang ilang. Lanjut: produk statis kamera gerak → durasi 5 detik → sambung pakai Continue.

---

## 9. EDITOR & AUTO-EDIT

### Editor (tab Editor)
Multi-track timeline ala CapCut: base track + overlay (B-roll/PiP), trim, split, speed ramp, zoom/pan, transisi (11 jenis), text overlay, filter, karaoke subtitle word-level, voice swap. Export MP4 via ffmpeg.wasm.

### Auto Edit (di Editor) ⚡
Satu klik: clip disusun + crossfade + punch-in zoom bergantian + BGM duck + karaoke subtitle. Sekali Ctrl+Z undo semua.

### AI Edit (di QC) 🪄
Pilih video → tulis prompt edit ("gabungin 30 detik, ambil bagian menarik, crossfade, hook text, subtitle") → Gemini nyusun timeline → kebuka di Editor buat preview → export → balik ke QC.

### Transisi (11 jenis)
cut, crossfade, blur (hblur), lightleak (fadewhite), dissolve, zoomin, slide, circle open, pixelize, fadeblack. AI milih sesuai mood, gak ngulang.

### Text style (6 template)
tiktok (putih kotak hitam), clean (minimal), yellow (peringatan), neon (techy), pink (playful), bigpop (CTA teriak).

### Catatan teknis penting
- **Render = ffmpeg.wasm di browser** (single-thread). Tab harus kebuka.
- Audio chain MIRROR video chain (cut→concat, transisi→acrossfade) biar gak desync.
- ffmpeg.wasm itu **singleton dengan MEMFS terbatas** — dibersihkan tiap operasi biar gak "FS error".
- Audio extract buat transcribe: ekstrak mp3 dulu (20MB video → <1MB) sebelum kirim Gemini (limit inline ~18MB).

---

## 10. VOICE CLONING

Pendekatan: **ElevenLabs Speech-to-Speech (S2S)**, bukan TTS.

**Kenapa S2S:** dia GAK bikin audio baru — dia ngubah WARNA suara dari audio yang udah ada, timing & fonem dipertahankan 1:1. Jadi **lip-sync kejaga** tanpa model lip-sync terpisah.

**3 cara bikin voice (di Personas):**
- `clone` — Instant Voice Clone dari upload audio (≥10 detik)
- `design` — text-to-voice dari deskripsi
- `library` — pilih dari voice yang udah ada

**Ganti suara di video (tombol 🎙 Voice di QC):**
```
1. Extract audio dari video (v2 HF Space ffmpeg)
2. ElevenLabs S2S dengan voice_id persona → mp3 baru
3. Mux balik ke video (audio asli di-drop, suara clone masuk)
4. Hasil = result BARU di QC (non-destruktif, bisa A/B)
```

---

## 11. QC → POSTING

### QC (kanban)
Hasil gen auto-group per persona. Status: pending → approved / revise / rejected. Bisa multi-select buat batch.
Tools di QC: 🎙 Voice swap, 🪄 AI Edit, 🔁 1080p re-encode, 🔇 Mute (buat TikTok auto-music), upload video eksternal.

### Posting
Approved → Scheduled → Postiz multi-channel (TikTok/IG/YouTube). Persona bind ke channel via `personas.postiz_channel_id`.

---

## 12. SOP (STANDARD OPERATING PROCEDURE)

### SOP Produk (charger, gadget berlabel)
```
1. Ref: 1 foto produk tajam single-angle + isi field KNOWLEDGE (label, port, dimensi)
2. Mode: Per-Shot. Image model: GPT Image 2 Edit
3. Gen image → rewel di sini → re-img sampai label kebaca + proporsi bener → OK
4. Video model: pakai varian **r2v** (reference-to-video) biar produk kebawa —
   Grok r2v (draft murah) / Seedance r2v (final, fidelity tinggi).
   JANGAN varian i2v keluarga manapun kalau butuh produk persis (i2v cuma 1 gambar).
5. Motion: produk statis, kamera gerak. Durasi 5 detik. No cuts ON
6. Multi-shot: pakai Continue (bukan gen baru) buat nyambung
```

### SOP UGC (talent ngomong + pegang produk)
```
1. Image: GPT Image 2 Edit — prompt posisi tangan eksplisit (pegang label depan, jari di pinggir)
2. Video model: varian r2v ber-audio — **Happy Horse r2v** (~$0.14, native audio + multi-ref) atau **Seedance r2v**. Keduanya bawa produk + bisa dialog.
3. Motion: satu tangan pegang produk DIAM, tangan lain gesture. Durasi 5 detik
4. QC → 🎙 Voice swap ke cloned voice persona (konsistensi suara antar konten)
5. Multi-shot UGC: Continue (hook → demo → CTA)
```

### SOP Batch (F Creator)
```
1. Setup: persona, mode, model, camera preset, target duration, toggle
2. Paste semua naskah
3. Lihat estimasi biaya → RUN FACTORY
4. Biarin tab kebuka (jaringan stabil — tethering kalau wifi drama)
5. Pulang → QC semua di tab QC
```

### Prinsip ekonomi
- Image $0.04-0.06 (murah) → judi di sini, re-img bebas
- Video $0.35-1.4 (mahal) → sekali jadi
- Target: 1-2x video per hasil, bukan 5x gen gambling

---

## 13. GOVERNANCE

### Budget Gate (2 lapis, fail-closed)
- Cek di `/api/fal/submit` DAN di God Mode agent
- Refuse gen kalau limit harian/bulanan kelewat
- Estimasi biaya ditampilkan sebelum klik (terutama F Creator: total batch)
- Fail-closed: kalau baca DB error, BLOCK (bukan allow)

### Usage Log
Per-call cost + model dicatat ke `usage_log`. Dashboard nampilin: hari ini, bulan ini, forecast end-of-month, breakdown per kind.

### Error Log
Mini-Sentry sendiri: `error_log` table + tab Errors + dashboard. Capture source, level, message, stack.

---

## 14. DATABASE

23 tabel utama (Supabase Postgres, RLS aktif per workspace):

**Tenant & auth:** `profiles`, `workspaces`, `workspace_members`, `workspace_invites`
**Konten library:** `refs`, `personas`, `persona_refs`, `persona_channels`, `brands`, `templates`, `camera_presets`
**Hasil & job:** `results`, `gen_jobs` (webhook tracking), `jobs` (render/stitch), `factory_runs` (F Creator state), `editor_projects`
**Voice:** kolom di `personas` (voice_id, voice_name, voice_source) + `workspaces.elevenlabs_key`
**Posting:** `scheduled_posts`, `postiz_accounts`
**Governance:** `usage_log`, `budget_settings`, `activity_log`, `error_log`
**God Mode:** `god_mode_conversations`

Semua RLS-scoped: user cuma bisa akses data workspace-nya (verified via `workspace_members`).

---

## 15. GLOSARIUM

| Istilah | Arti |
|---|---|
| **Persona** | Karakter/talent (wajah + suara + LoRA + channel posting). |
| **Ref / Reference** | Gambar acuan: produk 📦, karakter 👤, atau style 🎨. |
| **Knowledge** | Teks deskripsi produk (label, dimensi) — jangkar anti-drift. |
| **Soul / LoRA** | Model terlatih dari foto persona buat konsistensi wajah maksimal. |
| **Naskah** | Script/teks konten yang di-parse jadi shots. |
| **Shot** | Satu segmen video (image + video motion). |
| **KONTI** | Continuity — shot nyambung pakai frame terakhir shot sebelumnya. |
| **Drift / Morph** | Karakter/produk berubah bentuk antar frame (musuh utama). |
| **i2v / r2v / t2v** | image / reference / text → to-video. |
| **S2S** | Speech-to-Speech (ganti suara, lip-sync aman). |
| **Budget Gate** | Pengaman spending sebelum panggil fal. |
| **MEMFS** | Filesystem virtual ffmpeg.wasm di browser. |
| **QC** | Quality Check (review sebelum posting). |

---

*Dokumen ini dibikin per 12 Juni 2026. Platform aktif & terus berkembang — kalau ada fitur baru, update dokumen ini.*
