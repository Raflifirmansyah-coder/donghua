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
const ADMIN_USER = "xiaoli";
const ADMIN_PASS = "0507";
const POLL_INTERVAL_MS = 15000; // sinkronisasi otomatis tiap 15 detik

const state = {
  currentUser: null,
  isAdmin: false,
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
async function handleRegister() {
  const username = document.getElementById("registerUsername").value.trim();
  const password = document.getElementById("registerPassword").value;
  const errEl = document.getElementById("registerError");
  errEl.textContent = "";

  if (!username || !password) {
    errEl.textContent = "Username dan password wajib diisi.";
    return;
  }

  try {
    await api("register", { username, password });
    state.currentUser = username;
    state.isAdmin = false;
    sessionStorage.setItem("donghua_session", JSON.stringify({ username, isAdmin: false }));
    enterApp();
  } catch (e) {
    errEl.textContent = e.message;
  }
}

// ------------------------------------------------------------
// LOGIN — proteksi hardcoded admin 'xiaoli' / '0507', selain itu
// divalidasi ke database Neon
// ------------------------------------------------------------
async function handleLogin() {
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  errEl.textContent = "";

  if (!username || !password) {
    errEl.textContent = "Username dan password wajib diisi.";
    return;
  }

  // ===== ATURAN VALIDASI KETAT UNTUK ADMIN (HARDCODED) =====
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    state.currentUser = username;
    state.isAdmin = true;
    sessionStorage.setItem("donghua_session", JSON.stringify({ username, isAdmin: true }));
    enterApp();
    openAdmin();
    return;
  }

  // ===== USER BIASA: DIVALIDASI KE DATABASE NEON =====
  try {
    const data = await api("login", { username, password });
    if (!data.user) {
      errEl.textContent = "Username atau password salah.";
      return;
    }
    state.currentUser = data.user.username;
    state.isAdmin = false;
    sessionStorage.setItem("donghua_session", JSON.stringify({ username: data.user.username, isAdmin: false }));
    enterApp();
  } catch (e) {
    errEl.textContent = e.message;
  }
}

function handleLogout() {
  state.currentUser = null;
  state.isAdmin = false;
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
  openHome();
}

function openHome() {
  showSection("mainSection");
  loadMain();
}

// ===== PROTEKSI: DASHBOARD ADMIN TIDAK BISA DIAKSES TANPA LOGIN ADMIN =====
function openAdmin() {
  if (!state.isAdmin) {
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
          <strong>${escapeHtml(c.username)}</strong>
          <p>${escapeHtml(c.comment)}</p>
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
    loadComments(state.currentVideoId);
  } catch (e) {
    alert("Gagal mengirim komentar: " + e.message);
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

  tbody.innerHTML = '<tr><td colspan="4" class="text-dim">Memuat data...</td></tr>';

  try {
    const data = await api("getUsers", { adminUser: ADMIN_USER, adminPass: ADMIN_PASS }, "GET");
    const users = data.users || [];

    if (users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-dim">Belum ada user yang terdaftar.</td></tr>';
      return;
    }

    tbody.innerHTML = users
      .map(
        (u) => `
        <tr>
          <td>${u.id}</td>
          <td>${escapeHtml(u.username)}</td>
          <td>${escapeHtml(u.password)}</td>
          <td>${new Date(u.created_at).toLocaleString("id-ID")}</td>
        </tr>
      `
      )
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-dim">Gagal memuat data: ${escapeHtml(e.message)}</td></tr>`;
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
    await api("saveDailymotionId", { channelId: val, adminUser: ADMIN_USER, adminPass: ADMIN_PASS });
    state.dailymotionId = val;
    msg.textContent = "✓ Berhasil disimpan & disinkronkan.";
    if (document.getElementById("mainSection")) {
      refreshVideos();
    }
    setTimeout(() => (msg.textContent = ""), 3000);
  } catch (e) {
    msg.textContent = "Gagal: " + e.message;
  }
}

// ------------------------------------------------------------
// INISIALISASI — pulihkan sesi jika ada, atau tampilkan login
// ------------------------------------------------------------
window.addEventListener("DOMContentLoaded", () => {
  const saved = sessionStorage.getItem("donghua_session");

  if (saved) {
    try {
      const s = JSON.parse(saved);
      state.currentUser = s.username;
      state.isAdmin = !!s.isAdmin;
      enterApp();
      if (state.isAdmin) openAdmin();
    } catch (e) {
      showSection("authSection");
    }
  } else {
    showSection("authSection");
  }
});
