/**
 * ============================================================
 *  BAGIAN 1 & 4: KONFIGURASI DATABASE NEON (HTTP FETCH) + LOGIKA
 * ============================================================
 *  File ini adalah SATU-SATUNYA Vercel Serverless Function pada
 *  proyek ini. Ia WAJIB berada di dalam folder bernama "api"
 *  karena itu adalah konvensi platform Vercel untuk menjalankan
 *  kode Node.js (agar process.env bisa dibaca). Ini bukan
 *  struktur folder buatan kita, melainkan syarat wajib Vercel.
 *
 *  Cara kerja koneksi ke Neon:
 *  Kita TIDAK memakai library "pg" atau driver TCP apa pun.
 *  Kita memanggil endpoint HTTP resmi Neon (/sql) langsung
 *  menggunakan fetch() bawaan Node.js, mengirim query SQL dalam
 *  format JSON, dan menerima hasilnya sebagai JSON juga.
 *  Inilah yang dimaksud "REST API / HTTP Fetch langsung".
 *
 *  ENVIRONMENT VARIABLE YANG WAJIB DIISI DI VERCEL DASHBOARD:
 *  - DATABASE_URL  -> connection string Neon Anda, contoh:
 *    postgres://user:password@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
 *
 *  Tidak ada satu pun kredensial yang di-hardcode di sini.
 * ============================================================
 */

// ------------------------------------------------------------
// Helper: menjalankan query SQL ke Neon lewat HTTP endpoint /sql
// ------------------------------------------------------------
async function runQuery(query, params = []) {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL belum diatur di Environment Variables Vercel. Buka Project Settings > Environment Variables lalu tambahkan DATABASE_URL dari dashboard Neon Anda."
    );
  }

  let host;
  try {
    const normalized = connectionString.replace("postgres://", "postgresql://");
    const parsed = new URL(normalized);
    host = parsed.hostname;
  } catch (e) {
    throw new Error("Format DATABASE_URL tidak valid. Pastikan Anda menyalin connection string lengkap dari dashboard Neon.");
  }

  const endpoint = `https://${host}/sql`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Neon-Connection-String": connectionString,
    },
    body: JSON.stringify({ query, params }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gagal terhubung ke Neon Database (HTTP ${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.rows || [];
}

// ------------------------------------------------------------
// Pastikan semua tabel yang dibutuhkan sudah ada (idempotent)
// ------------------------------------------------------------
async function initTables() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await runQuery(`
    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      video_id TEXT NOT NULL,
      username TEXT NOT NULL,
      comment TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await runQuery(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// ------------------------------------------------------------
// Verifikasi kredensial admin hardcoded (dobel proteksi di
// server, selain proteksi di sisi client)
// ------------------------------------------------------------
function isAdminRequest(payload) {
  return payload && payload.adminUser === "xiaoli" && payload.adminPass === "0507";
}

// ------------------------------------------------------------
// HANDLER UTAMA
// ------------------------------------------------------------
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    await initTables();

    const action = req.method === "GET" ? req.query.action : req.body && req.body.action;
    const payload = req.method === "GET" ? req.query : (req.body && req.body.payload) || {};

    switch (action) {
      // ============= REGISTER USER BARU =============
      case "register": {
        const { username, password } = payload;
        if (!username || !password) {
          return res.status(400).json({ error: "Username dan password wajib diisi." });
        }
        if (username === "xiaoli") {
          return res.status(400).json({ error: "Username tersebut tidak dapat digunakan." });
        }
        const existing = await runQuery("SELECT id FROM users WHERE username = $1", [username]);
        if (existing.length > 0) {
          return res.status(400).json({ error: "Username sudah terdaftar. Silakan gunakan username lain." });
        }
        await runQuery("INSERT INTO users (username, password) VALUES ($1, $2)", [username, password]);
        return res.status(200).json({ success: true });
      }

      // ============= LOGIN USER BIASA =============
      case "login": {
        const { username, password } = payload;
        if (!username || !password) {
          return res.status(400).json({ error: "Username dan password wajib diisi." });
        }
        const rows = await runQuery(
          "SELECT id, username FROM users WHERE username = $1 AND password = $2 LIMIT 1",
          [username, password]
        );
        if (rows.length === 0) {
          return res.status(200).json({ user: null });
        }
        return res.status(200).json({ user: rows[0] });
      }

      // ============= AMBIL SEMUA USER (ADMIN ONLY) =============
      case "getUsers": {
        if (!isAdminRequest(payload)) {
          return res.status(403).json({ error: "Akses ditolak. Hanya admin yang dapat melihat data ini." });
        }
        const rows = await runQuery(
          "SELECT id, username, password, created_at FROM users ORDER BY id DESC"
        );
        return res.status(200).json({ users: rows });
      }

      // ============= SIMPAN ID CHANNEL DAILYMOTION (ADMIN ONLY) =============
      case "saveDailymotionId": {
        if (!isAdminRequest(payload)) {
          return res.status(403).json({ error: "Akses ditolak. Hanya admin yang dapat mengubah pengaturan ini." });
        }
        const { channelId } = payload;
        if (!channelId) {
          return res.status(400).json({ error: "ID channel tidak boleh kosong." });
        }
        await runQuery(
          `INSERT INTO settings (key, value) VALUES ('dailymotion_id', $1)
           ON CONFLICT (key) DO UPDATE SET value = $1`,
          [channelId]
        );
        return res.status(200).json({ success: true });
      }

      // ============= AMBIL ID CHANNEL DAILYMOTION (PUBLIK) =============
      case "getDailymotionId": {
        const rows = await runQuery("SELECT value FROM settings WHERE key = 'dailymotion_id' LIMIT 1");
        return res.status(200).json({ channelId: rows.length > 0 ? rows[0].value : null });
      }

      // ============= AMBIL KOMENTAR SUATU VIDEO (PUBLIK) =============
      case "getComments": {
        const { videoId } = payload;
        if (!videoId) {
          return res.status(400).json({ error: "videoId wajib disertakan." });
        }
        const rows = await runQuery(
          "SELECT username, comment, created_at FROM comments WHERE video_id = $1 ORDER BY created_at ASC",
          [videoId]
        );
        return res.status(200).json({ comments: rows });
      }

      // ============= KIRIM KOMENTAR BARU (PUBLIK) =============
      case "postComment": {
        const { videoId, username, comment } = payload;
        if (!videoId || !username || !comment) {
          return res.status(400).json({ error: "Data komentar tidak lengkap." });
        }
        await runQuery(
          "INSERT INTO comments (video_id, username, comment) VALUES ($1, $2, $3)",
          [videoId, username, comment]
        );
        return res.status(200).json({ success: true });
      }

      default:
        return res.status(400).json({ error: "Aksi tidak dikenali: " + action });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || "Terjadi kesalahan pada server." });
  }
};
