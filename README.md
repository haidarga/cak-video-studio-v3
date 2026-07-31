# CAK Video Studio v3

Multi-user, real-time AI video production platform for creator teams.
Ini adalah bagian "Studio" dari ekosistem CAK AI, yang berfungsi sebagai tempat eksekusi visual (Image & Video Generation) dari naskah-naskah yang sudah dibuat oleh Caketing (AI Copywriter).

## 🚀 Overview & End-to-End Pipeline

1. **Caketing (The Brain & Copywriter)**: 
   - Caketing bikin Brief, Persona, dan Naskah (berupa script teks dan shot breakdown).
   - Setelah naskah di-approve di Caketing, tim klik **Push to Studio**.
   - Naskah ini akan dikirim via API `/api/external/ingest` ke CAK Video Studio dan masuk ke **Studio Inbox**.

2. **Studio Inbox (The Queue)**:
   - Di Inbox, naskah dikelompokkan ke dalam **Batch** berdasarkan topik/brief dari Caketing (sesuai `push_batch_id`).
   - Tim QC bisa klik **🚀 Eksekusi All Batch** untuk memproses satu topik sekaligus.

3. **Auto-Generation Pipeline (The Magic)**:
   - Begitu klik Eksekusi All Batch, halaman `/generate` akan terbuka.
   - Sistem **secara otomatis** akan menarik prompt gambar dari setiap shot naskah.
   - Sistem akan langsung menjalankan **Auto-Generate Image** menggunakan model default (**GPT Image 2 Edit**) untuk SEMUA shot di batch tersebut.
   - Tim tinggal menunggu loading (staggered delay) dan gambar-gambar akan muncul satu persatu.
   - Tim bisa mereview gambar, dan kalau ada yang kurang pas, bisa klik *Regenerate* manual.

4. **Video Generation & QC (Final Polish)**:
   - Setelah semua image oke, tim bisa meng-generate Video (menggunakan model video seperti Luma, Kling, atau Seedance).
   - Video yang sudah jadi bisa langsung di-publish via Postiz, atau masuk ke tahap Editor (timeline rendering).

---

## 🏗️ Architecture & Logic

Aplikasi ini menggunakan **Next.js 14 App Router** dan **Supabase**.

- **`/app/(dash)/inbox/InboxClient.jsx`**:
  - Mengambil data job naskah yang belum diproses.
  - Melakukan *Grouping Batch* berdasarkan `push_batch_id` yang dikirim Caketing (tidak lagi di-split per hari).
  
- **`/app/(dash)/generate/_components/GenerateClient.jsx`**:
  - State manager utama untuk editor shot per shot.
  - Membaca `incomingStudioJobs` dan menyebarkan prop `autoStartImages` ke komponen-komponen anaknya.
  
- **`PersonaSection` (di dalam `GenerateClient.jsx`)**:
  - Komponen per-persona yang menampung shots.
  - Punya `useEffect` yang jika `autoStartImages = true`, akan melooping semua `idle` shots dan menjalankan `setTimeout(() => genImageForShot(idx), delay)` untuk menghindari rate limit API saat batch besar.
  
- **`fal-client.js`**:
  - Client side proxy yang membungkus pemanggilan ke model AI via layanan FAL.
  - Mendukung metode synchronous (untuk model cepat) dan asynchronous webhook + realtime Supabase (untuk model video atau GPT Image 2 yang butuh waktu lama).

---

## 🤖 Agents & AI Models

Di CAK Video Studio, agennya adalah kumpulan model AI yang digunakan untuk rendering:

1. **Image Models (Default: `gpt-image-2/edit`)**:
   - `openai/gpt-image-2/edit`: Model utama untuk generasi gambar yang ngunci (pixel-lock) reference wajah/produk, sangat bagus untuk menjaga konsistensi identitas.
   - `fal-ai/nano-banana-2/edit`: Model alternatif untuk multi-reference.
   - `xai/grok-imagine-image/edit`: Model Grok untuk variasi estetik.

2. **Video Models**:
   - Berbagai model untuk animate image to video seperti Kling v3, Seedance, Gemini Omni Flash, Luma, dll.
   - *Video Edit Models* (seperti Grok Edit Video) untuk modifikasi pasca render.

---

## Setup & Deployment

### 1. Database Schema
1. Open Supabase project → SQL Editor.
2. Paste `supabase/migrations/0001_init.sql` & Run.

### 2. Local Dev
```bash
cp .env.example .env.local
# Fill in NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY
npm install
npm run dev
```

### 3. Vercel Environment Variables
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` *(server-only)*
- `POSTIZ_API_URL`, `POSTIZ_API_KEY`
- `FAL_KEY`, `GEMINI_KEY`
