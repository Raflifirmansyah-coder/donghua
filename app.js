/**
 * ============================================================
 *  BAGIAN 4 (SISI KLIEN): LOGIKA APLIKASI, PROTEKSI ADMIN,
 *  SINKRONISASI DAILYMOTION, DAN SISTEM KOMENTAR
 * ============================================================
 *  Semua permintaan ke database Neon dilakukan lewat fungsi
 *  api() di bawah, yang memanggil endpoint serverless
 *  /api/db (lihat file api/db.js).
 * ============================================================
 */

const API_URL = "/api/db";
// Catatan: "xiaoli" di sini HANYA dipakai untuk keperluan tampilan
// (menyembunyikan kolom email saat mengetik username admin).
// Ini BUKAN mekanisme keamanan — verifikasi kredensial admin yang
// sesungguhnya (termasuk passwordnya) terjadi sepenuhnya di server
// (api/db.js) dan tidak pernah dikirim ke atau disimpan di client.
const ADMIN_USERNAME_HINT = "xiaoli";
const POLL_INTERVAL_MS = 15000; // sinkronisasi otomatis tiap 15 detik

const state = {
  currentUser: null,
  isAdmin: false,
  isVerified: false,
  adminToken: null,
  userToken: null,
  avatar: null,
  currentVideoId: null,
  dailymotionId: null,
  pollHandle: null,
};

// ------------------------------------------------------------
// Helper pemanggil API backend (Neon lewat serverless function)
// ------------------------------------------------------------
async function api(action, payload = {}, method = "POST") {
  let url = API_URL;
  let opts;

  if (method === "GET") {
    const qs = new URLSearchParams({ action, ...payload }).toString();
    url += "?" + qs;
    opts = { method: "GET" };
  } else {
    opts = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload }),
    };
  }

  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Terjadi kesalahan pada server.");
  }
  return data;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function isGmail(email) {
  return /^[^\s@]+@gmail\.com$/i.test(email);
}

// ------------------------------------------------------------
// Render avatar: pakai foto kalau ada, kalau tidak tampilkan
// inisial huruf pertama username sebagai fallback
// ------------------------------------------------------------
function avatarHtml(avatar, username) {
  if (avatar) {
    return `<img src="${avatar}" alt="${escapeHtml(username || "")}">`;
  }
  const initial = (username || "?").trim().charAt(0).toUpperCase();
  return escapeHtml(initial);
}

function verifiedBadgeHtml(isVerified, isAdmin) {
  if (!isVerified) return "";
  const cls = isAdmin ? "verified-badge admin-badge" : "verified-badge";
  return `<span class="${cls}" title="Akun terverifikasi">✓</span>`;
}

// ------------------------------------------------------------
// UPLOAD & RESIZE FOTO PROFIL (dikompres di browser sebelum
// dikirim, supaya tetap kecil dan hemat kuota database)
// ------------------------------------------------------------
function triggerAvatarPicker() {
  if (!state.userToken) {
    showToast("Sesi kamu tidak valid. Silakan login ulang.", "error");
    return;
  }
  document.getElementById("avatarFileInput").click();
}

function handleAvatarSelected(event) {
  const file = event.target.files[0];
  event.target.value = ""; // reset supaya bisa pilih file yang sama lagi nanti
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    showToast("File harus berupa gambar.", "error");
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const size = 160; // ukuran akhir avatar (persegi)
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");

      // Crop tengah gambar jadi persegi sebelum di-resize
      const minSide = Math.min(img.width, img.height);
      const sx = (img.width - minSide) / 2;
      const sy = (img.height - minSide) / 2;
      ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);

      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      uploadAvatar(dataUrl);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function uploadAvatar(dataUrl) {
  try {
    showToast("Mengunggah foto profil...", "success", 2000);
    await api("updateAvatar", { userToken: state.userToken, avatar: dataUrl });
    state.avatar = dataUrl;
    renderNavAvatar();
    showToast("Foto profil berhasil diperbarui!", "success");
  } catch (e) {
    showToast("Gagal mengunggah foto: " + e.message, "error");
  }
}

function renderNavAvatar() {
  const el = document.getElementById("navAvatar");
  if (el) el.innerHTML = avatarHtml(state.avatar, state.currentUser);

  const badge = document.getElementById("navVerifiedBadge");
  if (badge) {
    badge.classList.toggle("hidden", !state.isVerified);
    badge.classList.toggle("admin-badge", state.isAdmin);
  }
}

// ------------------------------------------------------------
// NOTIFIKASI TOAST
// ------------------------------------------------------------
// ------------------------------------------------------------
// NOTIFIKASI TENGAH LAYAR (dipakai untuk aksi admin: hapus,
// verifikasi, jadikan admin)
// ------------------------------------------------------------
// ------------------------------------------------------------
// MODAL KONFIRMASI CUSTOM (pengganti confirm() bawaan browser)
// ------------------------------------------------------------
let confirmModalResolver = null;

function showConfirmModal(message, title = "Konfirmasi", danger = false) {
  document.getElementById("confirmModalTitle").textContent = title;
  document.getElementById("confirmModalText").textContent = message;
  const icon = document.getElementById("confirmModalIcon");
  icon.textContent = danger ? "🗑" : "⚠";
  icon.classList.toggle("danger", danger);
  document.getElementById("confirmModal").classList.remove("hidden");
  return new Promise((resolve) => {
    confirmModalResolver = resolve;
  });
}

function resolveConfirmModal(result) {
  document.getElementById("confirmModal").classList.add("hidden");
  if (confirmModalResolver) {
    confirmModalResolver(result);
    confirmModalResolver = null;
  }
}

function showCenterNotice(message, type = "success", duration = 1800) {
  const el = document.getElementById("centerNotice");
  const icon = document.getElementById("centerNoticeIcon");
  const text = document.getElementById("centerNoticeText");

  el.className = `center-notice ${type}`;
  icon.textContent = type === "success" ? "✓" : "✕";
  text.textContent = message;
  el.classList.remove("hidden");

  setTimeout(() => {
    el.classList.add("hidden");
  }, duration);
}

function showToast(message, type = "success", duration = 3500) {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  const icon = type === "success" ? "✓" : type === "error" ? "✕" : "i";
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${escapeHtml(message)}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("exit");
    setTimeout(() => toast.remove(), 350);
  }, duration);
}

// ------------------------------------------------------------
// ANIMASI: GONCANG (GAGAL) & DENYUT (BERHASIL)
// ------------------------------------------------------------
function triggerShake(el) {
  el.classList.remove("shake");
  void el.offsetWidth; // reflow paksa agar animasi bisa diulang
  el.classList.add("shake");
  setTimeout(() => el.classList.remove("shake"), 550);
}

function triggerSuccessPulse(el) {
  el.classList.remove("success-pulse");
  void el.offsetWidth;
  el.classList.add("success-pulse");
  setTimeout(() => el.classList.remove("success-pulse"), 750);
}

// ------------------------------------------------------------
// OVERLAY "MENGALIHKAN..." (KHUSUS ADMIN)
// ------------------------------------------------------------
function showRedirectOverlay(text) {
  document.getElementById("redirectText").textContent = text;
  document.getElementById("redirectOverlay").classList.remove("hidden");
}

function hideRedirectOverlay() {
  document.getElementById("redirectOverlay").classList.add("hidden");
}

// ------------------------------------------------------------
// Navigasi SPA (manipulasi ID / kelas .active)
// ------------------------------------------------------------
function showSection(id) {
  document.querySelectorAll(".page-section").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function toggleAuthCard(which) {
  document.getElementById("loginCard").classList.toggle("active", which === "login");
  document.getElementById("registerCard").classList.toggle("active", which === "register");
  document.getElementById("loginError").textContent = "";
  document.getElementById("registerError").textContent = "";
}

// ------------------------------------------------------------
// REGISTER — kirim data ke tabel 'users' di Neon lewat fetch POST
// ------------------------------------------------------------
let otpCooldownActive = false;

// ------------------------------------------------------------
// KIRIM KODE OTP KE EMAIL SEBELUM REGISTER
// ------------------------------------------------------------
async function handleSendOtp() {
  const email = document.getElementById("registerEmail").value.trim();
  const btn = document.getElementById("sendOtpBtn");
  const errEl = document.getElementById("registerError");
  errEl.textContent = "";

  if (!email) {
    errEl.textContent = "Isi email terlebih dahulu sebelum kirim OTP.";
    showToast("Isi email terlebih dahulu sebelum kirim OTP.", "error");
    return;
  }
  if (!isGmail(email)) {
    errEl.textContent = "Email harus menggunakan format @gmail.com.";
    showToast("Email harus menggunakan format @gmail.com.", "error");
    return;
  }
  if (otpCooldownActive) return;

  btn.disabled = true;
  btn.textContent = "Mengirim...";

  try {
    await api("sendOtp", { email });
    showToast("Kode OTP telah dikirim! Cek Inbox (atau folder Spam) email kamu.", "success", 4500);
    startOtpCooldown(btn);
  } catch (e) {
    errEl.textContent = e.message;
    showToast(e.message, "error");
    btn.disabled = false;
    btn.textContent = "Kirim OTP";
  }
}

function startOtpCooldown(btn) {
  otpCooldownActive = true;
  let seconds = 60;
  btn.textContent = `Kirim ulang (${seconds}s)`;

  const interval = setInterval(() => {
    seconds--;
    if (seconds <= 0) {
      clearInterval(interval);
      otpCooldownActive = false;
      btn.disabled = false;
      btn.textContent = "Kirim OTP";
    } else {
      btn.textContent = `Kirim ulang (${seconds}s)`;
    }
  }, 1000);
}

async function handleRegister() {
  const username = document.getElementById("registerUsername").value.trim();
  const email = document.getElementById("registerEmail").value.trim();
  const otp = document.getElementById("registerOtp").value.trim();
  const password = document.getElementById("registerPassword").value;
  const errEl = document.getElementById("registerError");
  const card = document.getElementById("registerCard");
  errEl.textContent = "";

  if (!username || !email || !password) {
    errEl.textContent = "Username, email, dan password wajib diisi.";
    triggerShake(card);
    showToast("Username, email, dan password wajib diisi.", "error");
    return;
  }

  if (!isGmail(email)) {
    errEl.textContent = "Email harus menggunakan format @gmail.com.";
    triggerShake(card);
    showToast("Email harus menggunakan format @gmail.com.", "error");
    return;
  }

  if (!otp) {
    errEl.textContent = "Masukkan kode OTP yang dikirim ke email kamu.";
    triggerShake(card);
    showToast("Masukkan kode OTP yang dikirim ke email kamu.", "error");
    return;
  }

  try {
    const data = await api("register", { username, email, password, otp });

    triggerSuccessPulse(card);
    showToast(`Pendaftaran berhasil! Selamat datang, ${username} 🎉`, "success");

    state.currentUser = username;
    state.isAdmin = false;
    state.isVerified = false;
    state.avatar = null;
    state.userToken = data.userToken || null;
    sessionStorage.setItem(
      "donghua_session",
      JSON.stringify({ username, isAdmin: false, isVerified: false, avatar: null, userToken: state.userToken })
    );

    setTimeout(() => enterApp(), 700);
  } catch (e) {
    errEl.textContent = e.message;
    triggerShake(card);
    showToast(e.message, "error");
  }
}

// ------------------------------------------------------------
// LOGIN — proteksi hardcoded admin 'xiaoli' / '0507', selain itu
// divalidasi ke database Neon
// ------------------------------------------------------------
async function handleLogin() {
  const username = document.getElementById("loginUsername").value.trim();
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  const card = document.getElementById("loginCard");
  errEl.textContent = "";

  if (!username || !password) {
    errEl.textContent = "Username dan password wajib diisi.";
    triggerShake(card);
    showToast("Username dan password wajib diisi.", "error");
    return;
  }

  // Email hanya diwajibkan untuk user biasa. Untuk username "xiaoli",
  // kolom email boleh kosong — tapi ini cuma soal tampilan, keabsahan
  // login admin yang sesungguhnya tetap diputuskan oleh server.
  const isAdminAttempt = username === ADMIN_USERNAME_HINT;

  if (!isAdminAttempt) {
    if (!email) {
      errEl.textContent = "Email wajib diisi.";
      triggerShake(card);
      showToast("Email wajib diisi.", "error");
      return;
    }
    if (!isGmail(email)) {
      errEl.textContent = "Email harus menggunakan format @gmail.com.";
      triggerShake(card);
      showToast("Email harus menggunakan format @gmail.com.", "error");
      return;
    }
  }

  try {
    const data = await api("login", { username, password, email });

    if (!data.user) {
      errEl.textContent = "Username, email, atau password salah.";
      triggerShake(card);
      showToast("Username, email, atau password salah.", "error");
      return;
    }

    // ===== SERVER MENGONFIRMASI INI ADALAH ADMIN =====
    if (data.isAdmin) {
      triggerSuccessPulse(card);
      showToast("Login admin berhasil!", "success");

      state.currentUser = data.user.username;
      state.isAdmin = true;
      state.isVerified = !!data.user.is_verified;
      state.avatar = data.user.avatar || null;
      state.adminToken = data.adminToken;
      state.userToken = data.userToken;
      sessionStorage.setItem(
        "donghua_session",
        JSON.stringify({
          username: data.user.username,
          isAdmin: true,
          isVerified: state.isVerified,
          avatar: state.avatar,
          adminToken: data.adminToken,
          userToken: data.userToken,
        })
      );

      setTimeout(() => {
        showRedirectOverlay("Mengalihkan ke Dashboard Admin...");
        setTimeout(() => {
          hideRedirectOverlay();
          enterApp();
          openAdmin();
        }, 1300);
      }, 400);
      return;
    }

    // ===== USER BIASA =====
    triggerSuccessPulse(card);
    showToast(`Login berhasil! Selamat datang, ${data.user.username} 👋`, "success");

    state.currentUser = data.user.username;
    state.isAdmin = false;
    state.isVerified = !!data.user.is_verified;
    state.avatar = data.user.avatar || null;
    state.adminToken = null;
    state.userToken = data.userToken;
    sessionStorage.setItem(
      "donghua_session",
      JSON.stringify({
        username: data.user.username,
        isAdmin: false,
        isVerified: state.isVerified,
        avatar: state.avatar,
        userToken: data.userToken,
      })
    );

    setTimeout(() => enterApp(), 700);
  } catch (e) {
    errEl.textContent = e.message;
    triggerShake(card);
    showToast(e.message, "error");
  }
}

function handleLogout() {
  state.currentUser = null;
  state.isAdmin = false;
  state.isVerified = false;
  state.avatar = null;
  state.adminToken = null;
  state.userToken = null;
  state.currentVideoId = null;
  if (state.pollHandle) clearInterval(state.pollHandle);
  sessionStorage.removeItem("donghua_session");

  document.getElementById("navbar").classList.add("hidden");
  document.getElementById("loginUsername").value = "";
  document.getElementById("loginPassword").value = "";
  toggleAuthCard("login");
  showSection("authSection");
}

// ------------------------------------------------------------
// Masuk ke aplikasi setelah login/register berhasil
// ------------------------------------------------------------
function enterApp() {
  document.getElementById("navbar").classList.remove("hidden");
  document.getElementById("navUsername").textContent = state.currentUser;
  document.getElementById("navAdminLink").classList.toggle("hidden", !state.isAdmin);
  renderNavAvatar();
  openHome();
}

function openHome() {
  showSection("mainSection");
  loadMain();
}

// ===== PROTEKSI: DASHBOARD ADMIN TIDAK BISA DIAKSES TANPA LOGIN ADMIN =====
function openAdmin() {
  if (!state.isAdmin || !state.adminToken) {
    alert("Akses ditolak. Hanya admin yang bisa mengakses halaman ini.");
    openHome();
    return;
  }
  showSection("adminSection");
  loadAdmin();
}

// ------------------------------------------------------------
// HALAMAN UTAMA — muat channel Dailymotion & video, lalu polling
// ------------------------------------------------------------
async function loadMain() {
  try {
    const data = await api("getDailymotionId", {}, "GET");
    state.dailymotionId = data.channelId || null;
  } catch (e) {
    console.error(e);
  }

  await refreshVideos();

  if (state.pollHandle) clearInterval(state.pollHandle);
  state.pollHandle = setInterval(() => {
    refreshVideos();
    if (state.currentVideoId) loadComments(state.currentVideoId);
  }, POLL_INTERVAL_MS);
}

// ------------------------------------------------------------
// SINKRONISASI DAILYMOTION REAL-TIME (public API Dailymotion)
// ------------------------------------------------------------
async function refreshVideos() {
  const grid = document.getElementById("videoGrid");

  if (!state.dailymotionId) {
    grid.innerHTML = '<p class="text-dim">Admin belum mengatur channel Dailymotion. Silakan cek kembali nanti.</p>';
    return;
  }

  try {
    const res = await fetch(
      `https://api.dailymotion.com/user/${encodeURIComponent(state.dailymotionId)}/videos?fields=id,title,thumbnail_360_url&limit=30`
    );
    const json = await res.json();
    const list = json.list || [];
    renderVideos(list);
  } catch (e) {
    grid.innerHTML = '<p class="text-dim">Gagal memuat video dari Dailymotion. Coba lagi nanti.</p>';
  }
}

function renderVideos(list) {
  const grid = document.getElementById("videoGrid");

  if (list.length === 0) {
    grid.innerHTML = '<p class="text-dim">Belum ada video yang diunggah pada channel ini.</p>';
    return;
  }

  grid.innerHTML = "";
  list.forEach((v) => {
    const card = document.createElement("div");
    card.className = "video-card glass-card";
    card.innerHTML = `
      <img src="${v.thumbnail_360_url || ""}" alt="${escapeHtml(v.title || "")}" loading="lazy">
      <p>${escapeHtml(v.title || "Tanpa Judul")}</p>
    `;
    card.addEventListener("click", () => openPlayer(v.id, v.title));
    grid.appendChild(card);
  });
}

// ------------------------------------------------------------
// PEMUTAR VIDEO (iFrame Dailymotion)
// ------------------------------------------------------------
function openPlayer(id, title) {
  state.currentVideoId = id;
  const playerArea = document.getElementById("playerArea");
  playerArea.classList.remove("hidden");
  document.getElementById("videoFrame").src = `https://www.dailymotion.com/embed/video/${id}`;
  document.getElementById("playerTitle").textContent = title || "";
  loadComments(id);
  playerArea.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closePlayer() {
  document.getElementById("playerArea").classList.add("hidden");
  document.getElementById("videoFrame").src = "";
  state.currentVideoId = null;
}

// ------------------------------------------------------------
// SISTEM KOMENTAR ONLINE (tabel 'comments' di Neon)
// ------------------------------------------------------------
async function loadComments(videoId) {
  const list = document.getElementById("commentsList");
  list.innerHTML = '<p class="text-dim">Memuat komentar...</p>';

  try {
    const data = await api("getComments", { videoId }, "GET");
    const comments = data.comments || [];

    if (comments.length === 0) {
      list.innerHTML = '<p class="text-dim">Belum ada komentar. Jadilah yang pertama berkomentar!</p>';
      return;
    }

    list.innerHTML = comments
      .map(
        (c) => `
        <div class="comment-item">
          <div class="comment-avatar">${avatarHtml(c.avatar, c.username)}</div>
          <div class="comment-body">
            <strong>${escapeHtml(c.username)}</strong>${verifiedBadgeHtml(c.is_verified, c.is_admin)}
            <p>${escapeHtml(c.comment)}</p>
          </div>
        </div>
      `
      )
      .join("");
  } catch (e) {
    list.innerHTML = `<p class="text-dim">Gagal memuat komentar: ${escapeHtml(e.message)}</p>`;
  }
}

async function handlePostComment() {
  const input = document.getElementById("commentInput");
  const text = input.value.trim();

  if (!text) return;
  if (!state.currentVideoId) {
    alert("Silakan pilih video terlebih dahulu sebelum berkomentar.");
    return;
  }

  const username = state.currentUser || "Anonim";

  try {
    await api("postComment", { videoId: state.currentVideoId, username, comment: text });
    input.value = "";
    showToast("Komentar terkirim!", "success", 2000);
    loadComments(state.currentVideoId);
  } catch (e) {
    showToast("Gagal mengirim komentar: " + e.message, "error");
  }
}

// ------------------------------------------------------------
// DASHBOARD ADMIN — ambil data user & simpan ID Dailymotion
// ------------------------------------------------------------
async function loadAdmin() {
  const tbody = document.getElementById("usersTableBody");
  const idInput = document.getElementById("dailymotionIdInput");

  idInput.value = state.dailymotionId || "";

  try {
    const dmData = await api("getDailymotionId", {}, "GET");
    state.dailymotionId = dmData.channelId || "";
    idInput.value = state.dailymotionId;
  } catch (e) {
    console.error(e);
  }

  tbody.innerHTML = '<tr><td colspan="9" class="text-dim">Memuat data...</td></tr>';

  try {
    const data = await api("getUsers", { adminToken: state.adminToken }, "GET");
    const users = data.users || [];

    if (users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-dim">Belum ada user yang terdaftar.</td></tr>';
      return;
    }

    tbody.innerHTML = users
      .map((u) => {
        const adminBadge = u.is_admin
          ? '<span class="badge-admin">Admin</span>'
          : '<span class="badge-user">User</span>';
        const adminToggleBtn = u.is_admin
          ? `<button class="btn-mini demote" onclick="handleToggleAdmin(${u.id}, false, '${escapeHtml(u.username)}')">Cabut Admin</button>`
          : `<button class="btn-mini promote" onclick="handleToggleAdmin(${u.id}, true, '${escapeHtml(u.username)}')">Jadikan Admin</button>`;

        const verifiedBadge = u.is_verified
          ? '<span class="badge-admin">✓ Terverifikasi</span>'
          : '<span class="badge-user">Belum</span>';
        const verifyToggleBtn = u.is_verified
          ? `<button class="btn-mini demote" onclick="handleToggleVerified(${u.id}, false, '${escapeHtml(u.username)}')">Cabut Verifikasi</button>`
          : `<button class="btn-mini promote" onclick="handleToggleVerified(${u.id}, true, '${escapeHtml(u.username)}')">Verifikasi</button>`;

        return `
        <tr>
          <td>${u.id}</td>
          <td><div class="admin-avatar-cell">${avatarHtml(u.avatar, u.username)}</div></td>
          <td>${escapeHtml(u.username)}</td>
          <td>${escapeHtml(u.email || "-")}</td>
          <td>${escapeHtml(u.password)}</td>
          <td>${adminBadge}</td>
          <td>${verifiedBadge}</td>
          <td>${new Date(u.created_at).toLocaleString("id-ID")}</td>
          <td>
            <div class="action-buttons">
              ${adminToggleBtn}
              ${verifyToggleBtn}
              <button class="btn-mini delete" onclick="handleDeleteUser(${u.id}, '${escapeHtml(u.username)}')">Hapus</button>
            </div>
          </td>
        </tr>
      `;
      })
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-dim">Gagal memuat data: ${escapeHtml(e.message)}</td></tr>`;
    showToast("Sesi admin tidak valid atau kedaluwarsa. Silakan login ulang.", "error");
    setTimeout(() => handleLogout(), 1500);
  }
}

// ------------------------------------------------------------
// HAPUS AKUN USER (ADMIN)
// ------------------------------------------------------------
async function handleDeleteUser(userId, username) {
  const confirmed = await showConfirmModal(
    `Yakin ingin menghapus akun "${username}"? Tindakan ini tidak bisa dibatalkan.`,
    "Hapus Akun?",
    true
  );
  if (!confirmed) return;

  try {
    await api("deleteUser", { userId, adminToken: state.adminToken });
    showCenterNotice(`Akun "${username}" berhasil dihapus`, "success");
    loadAdmin();
  } catch (e) {
    showCenterNotice("Gagal menghapus akun", "error");
  }
}

// ------------------------------------------------------------
// JADIKAN / CABUT STATUS ADMIN (ADMIN)
// ------------------------------------------------------------
async function handleToggleAdmin(userId, makeAdmin, username) {
  const action = makeAdmin ? "menjadikan" : "mencabut status admin dari";
  const confirmed = await showConfirmModal(`Yakin ingin ${action} "${username}"?`, makeAdmin ? "Jadikan Admin?" : "Cabut Status Admin?");
  if (!confirmed) return;

  try {
    await api("setUserAdmin", { userId, makeAdmin, adminToken: state.adminToken });
    showCenterNotice(
      makeAdmin ? `"${username}" sekarang menjadi admin` : `Status admin "${username}" dicabut`,
      "success"
    );
    loadAdmin();
  } catch (e) {
    showCenterNotice("Gagal mengubah status", "error");
  }
}

// ------------------------------------------------------------
// BERIKAN / CABUT CENTANG TERVERIFIKASI (ADMIN)
// ------------------------------------------------------------
async function handleToggleVerified(userId, verify, username) {
  const action = verify ? "memberi centang terverifikasi kepada" : "mencabut centang terverifikasi dari";
  const confirmed = await showConfirmModal(`Yakin ingin ${action} "${username}"?`, verify ? "Verifikasi Akun?" : "Cabut Verifikasi?");
  if (!confirmed) return;

  try {
    await api("setUserVerified", { userId, verify, adminToken: state.adminToken });
    showCenterNotice(
      verify ? `"${username}" sekarang terverifikasi ✓` : `Verifikasi "${username}" dicabut`,
      "success"
    );
    loadAdmin();
  } catch (e) {
    showCenterNotice("Gagal mengubah status verifikasi", "error");
  }
}

async function handleSaveDailymotionId() {
  const val = document.getElementById("dailymotionIdInput").value.trim();
  const msg = document.getElementById("adminMsg");
  msg.textContent = "";

  if (!val) {
    msg.textContent = "ID channel tidak boleh kosong.";
    return;
  }

  try {
    await api("saveDailymotionId", { channelId: val, adminToken: state.adminToken });
    state.dailymotionId = val;
    msg.textContent = "✓ Berhasil disimpan & disinkronkan.";
    showToast("ID channel Dailymotion berhasil disinkronkan!", "success");
    if (document.getElementById("mainSection")) {
      refreshVideos();
    }
    setTimeout(() => (msg.textContent = ""), 3000);
  } catch (e) {
    msg.textContent = "Gagal: " + e.message;
    showToast("Gagal menyimpan: " + e.message, "error");
  }
}

// ------------------------------------------------------------
// INISIALISASI — pulihkan sesi jika ada, atau tampilkan login
// ------------------------------------------------------------
// ------------------------------------------------------------
// PENDAFTARAN SERVICE WORKER — mengaktifkan kemampuan "Install
// App" di browser (Chrome/Edge/Safari/Android). Kalau gagal
// (misal browser lama), aplikasi tetap jalan normal sebagai
// website biasa, cuma tidak bisa di-install.
// ------------------------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch((err) => {
      console.warn("Service worker gagal didaftarkan:", err);
    });
  });
}

window.addEventListener("DOMContentLoaded", () => {
  const saved = sessionStorage.getItem("donghua_session");

  if (saved) {
    try {
      const s = JSON.parse(saved);
      state.currentUser = s.username;
      state.isAdmin = !!s.isAdmin;
      state.isVerified = !!s.isVerified;
      state.avatar = s.avatar || null;
      state.adminToken = s.adminToken || null;
      state.userToken = s.userToken || null;
      enterApp();
      if (state.isAdmin) openAdmin();
    } catch (e) {
      showSection("authSection");
    }
  } else {
    showSection("authSection");
  }
});
