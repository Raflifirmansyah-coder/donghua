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

const crypto = require("crypto");

// ------------------------------------------------------------
// Sistem token admin: password admin TIDAK PERNAH dikirim balik
// ke client maupun disimpan di kode client. Setelah verifikasi
// berhasil di server, server membuatkan "tiket" (token) yang
// ditandatangani dengan kunci rahasia (ADMIN_SECRET) yang hanya
// diketahui server. Client hanya menyimpan token ini.
// ------------------------------------------------------------
function signToken(username, role) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    throw new Error("ADMIN_SECRET belum diatur di Environment Variables Vercel.");
  }
  const expiry = Date.now() + 1000 * 60 * 60 * 6; // token berlaku 6 jam
  const payloadStr = `${username}:${role}:${expiry}`;
  const payloadB64 = Buffer.from(payloadStr).toString("base64");
  const signature = crypto.createHmac("sha256", secret).update(payloadB64).digest("hex");
  return `${payloadB64}.${signature}`;
}

function verifyToken(token, requiredRole) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || !token || typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;

  const expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest("hex");
  if (signature !== expectedSig) return null;

  try {
    const payloadStr = Buffer.from(payloadB64, "base64").toString("utf-8");
    const [username, role, expiryStr] = payloadStr.split(":");
    const expiry = parseInt(expiryStr, 10);
    if (!username || !role) return null;
    if (Date.now() > expiry) return null;
    if (requiredRole && role !== requiredRole) return null;
    return { username, role };
  } catch (e) {
    return null;
  }
}
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
  `);
  await runQuery(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
  `);
  await runQuery(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
  `);
  await runQuery(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;
  `);
  await runQuery(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
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
  await runQuery(`
    CREATE TABLE IF NOT EXISTS otp_verifications (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

// ------------------------------------------------------------
// Verifikasi kredensial admin hardcoded (dobel proteksi di
// server, selain proteksi di sisi client)
// ------------------------------------------------------------
function isAdminRequest(payload) {
  return !!(payload && verifyToken(payload.adminToken, "admin"));
}

// Nama admin utama bisa diganti (disimpan di settings), tapi gerbang
// masuk "xiaoli"/"0507" tetap selalu berfungsi sebagai jaring pengaman.
async function getAdminUsername() {
  const rows = await runQuery("SELECT value FROM settings WHERE key = 'admin_username' LIMIT 1");
  return rows.length > 0 ? rows[0].value : "xiaoli";
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
      // ============= KIRIM KODE OTP KE EMAIL (SEBELUM REGISTER) =============
      case "sendOtp": {
        const { email } = payload;
        if (!email) {
          return res.status(400).json({ error: "Email wajib diisi." });
        }
        if (!/^[^\s@]+@gmail\.com$/i.test(email)) {
          return res.status(400).json({ error: "Email harus menggunakan format @gmail.com." });
        }

        const existingUser = await runQuery("SELECT id FROM users WHERE email = $1", [email]);
        if (existingUser.length > 0) {
          return res.status(400).json({ error: "Email ini sudah terdaftar. Silakan login." });
        }

        const serviceId = process.env.EMAILJS_SERVICE_ID;
        const templateId = process.env.EMAILJS_TEMPLATE_ID;
        const publicKey = process.env.EMAILJS_PUBLIC_KEY;
        const privateKey = process.env.EMAILJS_PRIVATE_KEY;

        if (!serviceId || !templateId || !publicKey || !privateKey) {
          return res.status(500).json({
            error: "Konfigurasi EmailJS belum lengkap di Environment Variables Vercel (EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY).",
          });
        }

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        await runQuery("DELETE FROM otp_verifications WHERE email = $1", [email]);
        await runQuery(
          "INSERT INTO otp_verifications (email, code, expires_at) VALUES ($1, $2, $3)",
          [email, code, expiresAt]
        );

        const emailRes = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            service_id: serviceId,
            template_id: templateId,
            user_id: publicKey,
            accessToken: privateKey,
            template_params: {
              to_email: email,
              otp_code: code,
            },
          }),
        });

        if (!emailRes.ok) {
          const errText = await emailRes.text();
          return res.status(500).json({ error: "Gagal mengirim email OTP: " + errText });
        }

        return res.status(200).json({ success: true });
      }

      // ============= REGISTER USER BARU (WAJIB OTP VALID) =============
      case "register": {
        const { username, password, email, otp } = payload;
        if (!username || !password || !email || !otp) {
          return res.status(400).json({ error: "Username, email, password, dan kode OTP wajib diisi." });
        }
        if (!/^[^\s@]+@gmail\.com$/i.test(email)) {
          return res.status(400).json({ error: "Email harus menggunakan format @gmail.com." });
        }
        if (username === "xiaoli") {
          return res.status(400).json({ error: "Username tersebut tidak dapat digunakan." });
        }

        const otpRows = await runQuery(
          "SELECT id FROM otp_verifications WHERE email = $1 AND code = $2 AND expires_at > NOW() LIMIT 1",
          [email, otp]
        );
        if (otpRows.length === 0) {
          return res.status(400).json({ error: "Kode OTP salah atau sudah kedaluwarsa. Silakan kirim ulang." });
        }

        const existing = await runQuery("SELECT id FROM users WHERE username = $1", [username]);
        if (existing.length > 0) {
          return res.status(400).json({ error: "Username sudah terdaftar. Silakan gunakan username lain." });
        }

        await runQuery("INSERT INTO users (username, password, email) VALUES ($1, $2, $3)", [username, password, email]);
        await runQuery("DELETE FROM otp_verifications WHERE email = $1", [email]);

        const userToken = signToken(username, "user");
        return res.status(200).json({ success: true, userToken });
      }

      // ============= LOGIN (ADMIN DIVERIFIKASI DI SERVER, USER BIASA DIVALIDASI KE NEON) =============
      case "login": {
        const { username, password, email } = payload;
        if (!username || !password) {
          return res.status(400).json({ error: "Username dan password wajib diisi." });
        }

        // Verifikasi admin sepenuhnya di server. Kredensial GERBANG
        // (xiaoli/0507) selalu berlaku permanen sebagai jaring pengaman,
        // tapi nama yang TAMPIL bisa diganti admin lewat updateAdminUsername.
        const currentAdminUsername = await getAdminUsername();
        if (password === "0507" && (username === "xiaoli" || username === currentAdminUsername)) {
          const avatarRows = await runQuery("SELECT value FROM settings WHERE key = 'admin_avatar' LIMIT 1");
          const avatar = avatarRows.length > 0 ? avatarRows[0].value : null;

          const bioRows = await runQuery("SELECT value FROM settings WHERE key = 'admin_bio' LIMIT 1");
          const bio = bioRows.length > 0 ? bioRows[0].value : "";

          let createdRows = await runQuery("SELECT value FROM settings WHERE key = 'admin_created_at' LIMIT 1");
          let createdAt;
          if (createdRows.length > 0) {
            createdAt = createdRows[0].value;
          } else {
            createdAt = new Date().toISOString();
            await runQuery(
              `INSERT INTO settings (key, value) VALUES ('admin_created_at', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
              [createdAt]
            );
          }

          // Profil admin OTOMATIS PRIVAT secara default. Kalau belum
          // pernah diatur sama sekali, dianggap privat (aman by default).
          const privateRows = await runQuery("SELECT value FROM settings WHERE key = 'admin_private' LIMIT 1");
          const isPrivate = privateRows.length === 0 || privateRows[0].value === "true";

          const adminToken = signToken(currentAdminUsername, "admin");
          const userToken = signToken(currentAdminUsername, "user");
          return res.status(200).json({
            user: {
              username: currentAdminUsername,
              avatar,
              bio,
              is_verified: true,
              is_admin: true,
              created_at: createdAt,
              is_private: isPrivate,
            },
            isAdmin: true,
            adminToken,
            userToken,
          });
        }

        if (!email) {
          return res.status(400).json({ error: "Email wajib diisi." });
        }
        if (!/^[^\s@]+@gmail\.com$/i.test(email)) {
          return res.status(400).json({ error: "Email harus menggunakan format @gmail.com." });
        }

        const rows = await runQuery(
          "SELECT id, username, email, avatar, is_admin, is_verified, bio, created_at FROM users WHERE username = $1 AND password = $2 AND email = $3 LIMIT 1",
          [username, password, email]
        );
        if (rows.length === 0) {
          return res.status(200).json({ user: null, isAdmin: false });
        }

        const userToken = signToken(rows[0].username, "user");

        if (rows[0].is_admin) {
          const adminToken = signToken(rows[0].username, "admin");
          return res.status(200).json({ user: rows[0], isAdmin: true, adminToken, userToken });
        }
        return res.status(200).json({ user: rows[0], isAdmin: false, userToken });
      }

      // ============= AMBIL SEMUA USER (ADMIN ONLY) =============
      case "getUsers": {
        if (!isAdminRequest(payload)) {
          return res.status(403).json({ error: "Akses ditolak. Hanya admin yang dapat melihat data ini." });
        }
        const rows = await runQuery(
          "SELECT id, username, email, password, is_admin, is_verified, avatar, created_at FROM users ORDER BY id DESC"
        );
        return res.status(200).json({ users: rows });
      }

      // ============= UBAH USERNAME (USER SENDIRI, VIA TOKEN) =============
      case "updateUsername": {
        const verified = verifyToken(payload.userToken, "user");
        if (!verified) {
          return res.status(403).json({ error: "Sesi tidak valid atau kedaluwarsa. Silakan login ulang." });
        }
        if (verified.username === "xiaoli") {
          return res.status(400).json({ error: "Username admin utama tidak dapat diubah." });
        }

        const newUsername = (payload.newUsername || "").trim();
        if (newUsername.length < 3) {
          return res.status(400).json({ error: "Username baru minimal 3 karakter." });
        }
        if (newUsername === "xiaoli") {
          return res.status(400).json({ error: "Username tersebut tidak dapat digunakan." });
        }

        const existing = await runQuery("SELECT id FROM users WHERE username = $1", [newUsername]);
        if (existing.length > 0) {
          return res.status(400).json({ error: "Username sudah dipakai. Silakan pilih username lain." });
        }

        await runQuery("UPDATE users SET username = $1 WHERE username = $2", [newUsername, verified.username]);
        await runQuery("UPDATE comments SET username = $1 WHERE username = $2", [newUsername, verified.username]);

        const rows = await runQuery("SELECT is_admin FROM users WHERE username = $1", [newUsername]);
        const newUserToken = signToken(newUsername, "user");
        const newAdminToken = rows.length > 0 && rows[0].is_admin ? signToken(newUsername, "admin") : null;

        return res.status(200).json({
          success: true,
          username: newUsername,
          userToken: newUserToken,
          adminToken: newAdminToken,
        });
      }

      // ============= UBAH USERNAME ADMIN UTAMA (KHUSUS ADMIN) =============
      case "updateAdminUsername": {
        const verified = verifyToken(payload.userToken, "user");
        if (!verified) {
          return res.status(403).json({ error: "Sesi tidak valid atau kedaluwarsa. Silakan login ulang." });
        }
        const currentAdminUsername = await getAdminUsername();
        if (verified.username !== currentAdminUsername && verified.username !== "xiaoli") {
          return res.status(403).json({ error: "Hanya admin utama yang dapat mengubah ini." });
        }

        const newAdminUsername = (payload.newUsername || "").trim();
        if (newAdminUsername.length < 3) {
          return res.status(400).json({ error: "Username baru minimal 3 karakter." });
        }

        const clashing = await runQuery("SELECT id FROM users WHERE username = $1", [newAdminUsername]);
        if (clashing.length > 0) {
          return res.status(400).json({ error: "Username sudah dipakai oleh user lain." });
        }

        await runQuery(
          `INSERT INTO settings (key, value) VALUES ('admin_username', $1)
           ON CONFLICT (key) DO UPDATE SET value = $1`,
          [newAdminUsername]
        );

        const newAdminToken = signToken(newAdminUsername, "admin");
        const newUserToken = signToken(newAdminUsername, "user");
        return res.status(200).json({
          success: true,
          username: newAdminUsername,
          adminToken: newAdminToken,
          userToken: newUserToken,
        });
      }

      // ============= TOGGLE PROFIL PRIVAT (KHUSUS ADMIN) =============
      case "setAdminPrivate": {
        if (!isAdminRequest(payload)) {
          return res.status(403).json({ error: "Akses ditolak. Hanya admin yang dapat mengubah pengaturan ini." });
        }
        const isPrivate = !!payload.isPrivate;
        await runQuery(
          `INSERT INTO settings (key, value) VALUES ('admin_private', $1)
           ON CONFLICT (key) DO UPDATE SET value = $1`,
          [isPrivate ? "true" : "false"]
        );
        return res.status(200).json({ success: true, is_private: isPrivate });
      }

      // ============= UPDATE BIO (USER SENDIRI, VIA TOKEN) =============
      case "updateBio": {
        const verified = verifyToken(payload.userToken, "user");
        if (!verified) {
          return res.status(403).json({ error: "Sesi tidak valid atau kedaluwarsa. Silakan login ulang." });
        }
        const bio = (payload.bio || "").slice(0, 300); // batasi panjang bio

        if (verified.username === "xiaoli" || verified.username === (await getAdminUsername())) {
          await runQuery(
            `INSERT INTO settings (key, value) VALUES ('admin_bio', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
            [bio]
          );
        } else {
          await runQuery("UPDATE users SET bio = $1 WHERE username = $2", [bio, verified.username]);
        }
        return res.status(200).json({ success: true, bio });
      }

      // ============= LIHAT PROFIL PUBLIK USER LAIN =============
      case "getPublicProfile": {
        const targetUsername = (req.method === "GET" ? req.query.username : payload.username) || "";
        if (!targetUsername) {
          return res.status(400).json({ error: "Username wajib disertakan." });
        }

        const currentAdminUsername = await getAdminUsername();
        const isTargetAdmin = targetUsername === "xiaoli" || targetUsername === currentAdminUsername;

        if (isTargetAdmin) {
          const privateRows = await runQuery("SELECT value FROM settings WHERE key = 'admin_private' LIMIT 1");
          const isPrivate = privateRows.length === 0 || privateRows[0].value === "true";

          const avatarRows = await runQuery("SELECT value FROM settings WHERE key = 'admin_avatar' LIMIT 1");
          const avatar = avatarRows.length > 0 ? avatarRows[0].value : null;

          if (isPrivate) {
            // Foto, nama, dan badge tetap ditampilkan. Hanya bio &
            // tanggal bergabung yang disembunyikan (null).
            return res.status(200).json({
              profile: {
                username: currentAdminUsername,
                avatar,
                bio: null,
                is_verified: true,
                is_admin: true,
                created_at: null,
              },
              isPrivate: true,
              isAdminProfile: true,
            });
          }

          const bioRows = await runQuery("SELECT value FROM settings WHERE key = 'admin_bio' LIMIT 1");
          const createdRows = await runQuery("SELECT value FROM settings WHERE key = 'admin_created_at' LIMIT 1");

          return res.status(200).json({
            profile: {
              username: currentAdminUsername,
              avatar,
              bio: bioRows.length > 0 ? bioRows[0].value : "",
              is_verified: true,
              is_admin: true,
              created_at: createdRows.length > 0 ? createdRows[0].value : null,
            },
            isPrivate: false,
            isAdminProfile: true,
          });
        }

        const rows = await runQuery(
          "SELECT username, avatar, bio, is_verified, is_admin, created_at FROM users WHERE username = $1 LIMIT 1",
          [targetUsername]
        );
        if (rows.length === 0) {
          return res.status(404).json({ error: "User tidak ditemukan." });
        }
        return res.status(200).json({ profile: rows[0], isPrivate: false, isAdminProfile: false });
      }

      // ============= UPDATE FOTO PROFIL (USER SENDIRI, VIA TOKEN) =============
      case "updateAvatar": {
        const verified = verifyToken(payload.userToken, "user");
        if (!verified) {
          return res.status(403).json({ error: "Sesi tidak valid atau kedaluwarsa. Silakan login ulang." });
        }
        const { avatar } = payload;
        if (!avatar) {
          return res.status(400).json({ error: "Foto profil wajib diisi." });
        }
        if (avatar.length > 700000) {
          return res.status(400).json({ error: "Ukuran foto terlalu besar. Gunakan foto yang lebih kecil." });
        }

        if (verified.username === "xiaoli") {
          await runQuery(
            `INSERT INTO settings (key, value) VALUES ('admin_avatar', $1)
             ON CONFLICT (key) DO UPDATE SET value = $1`,
            [avatar]
          );
        } else {
          await runQuery("UPDATE users SET avatar = $1 WHERE username = $2", [avatar, verified.username]);
        }
        return res.status(200).json({ success: true, avatar });
      }

      // ============= UBAH STATUS VERIFIKASI USER (ADMIN ONLY) =============
      case "setUserVerified": {
        if (!isAdminRequest(payload)) {
          return res.status(403).json({ error: "Akses ditolak. Hanya admin yang dapat mengubah status ini." });
        }
        const { userId, verify } = payload;
        if (!userId || typeof verify !== "boolean") {
          return res.status(400).json({ error: "Data tidak lengkap." });
        }
        await runQuery("UPDATE users SET is_verified = $1 WHERE id = $2", [verify, userId]);
        return res.status(200).json({ success: true });
      }

      // ============= HAPUS AKUN USER (ADMIN ONLY) =============
      case "deleteUser": {
        if (!isAdminRequest(payload)) {
          return res.status(403).json({ error: "Akses ditolak. Hanya admin yang dapat menghapus akun." });
        }
        const { userId } = payload;
        if (!userId) {
          return res.status(400).json({ error: "userId wajib disertakan." });
        }
        await runQuery("DELETE FROM users WHERE id = $1", [userId]);
        return res.status(200).json({ success: true });
      }

      // ============= UBAH STATUS ADMIN USER (ADMIN ONLY) =============
      case "setUserAdmin": {
        if (!isAdminRequest(payload)) {
          return res.status(403).json({ error: "Akses ditolak. Hanya admin yang dapat mengubah status ini." });
        }
        const { userId, makeAdmin } = payload;
        if (!userId || typeof makeAdmin !== "boolean") {
          return res.status(400).json({ error: "Data tidak lengkap." });
        }
        await runQuery("UPDATE users SET is_admin = $1 WHERE id = $2", [makeAdmin, userId]);
        return res.status(200).json({ success: true });
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
          `SELECT c.username, c.comment, c.created_at,
             CASE WHEN c.username = 'xiaoli' THEN (SELECT value FROM settings WHERE key = 'admin_avatar' LIMIT 1) ELSE u.avatar END AS avatar,
             CASE WHEN c.username = 'xiaoli' THEN TRUE ELSE COALESCE(u.is_verified, FALSE) END AS is_verified,
             CASE WHEN c.username = 'xiaoli' THEN TRUE ELSE COALESCE(u.is_admin, FALSE) END AS is_admin
           FROM comments c
           LEFT JOIN users u ON u.username = c.username
           WHERE c.video_id = $1
           ORDER BY c.created_at ASC`,
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
