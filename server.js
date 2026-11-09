// Vườn Bình Yên – server game nhiều người chơi (KHTN 7 Vật lí, bài 8–20)
// Không cần thư viện ngoài: chỉ dùng Node.js có sẵn (http + Server-Sent Events + db.js).
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createStore } = require("./db");

const PORT = process.env.PORT || 3000;
// Mã giáo viên: phải nhập đúng mới tạo được tài khoản quản trò (để học sinh không tự tạo).
const TEACHER_CODE = process.env.TEACHER_CODE || process.env.ADMIN_PASSWORD || "admin123";
const MAX_PLAYERS = 200;
const AV = ["🐢","🦦","🐨","🐼","🦥","🐳","🦔","🐝","🐸","🦊","🐰","🐧"];

if (!process.env.TEACHER_CODE && !process.env.ADMIN_PASSWORD) console.warn("⚠️  Chưa đặt ADMIN_PASSWORD – mã giáo viên để tạo tài khoản đang là 'admin123'.");
const store = createStore(process.env.DATABASE_URL);
if (store.kind === "memory") console.warn("⚠️  Chưa có DATABASE_URL – tài khoản giáo viên chỉ lưu tạm, sẽ mất khi server khởi động lại.");

let dbReady = false;
(async function initDb(attempt = 1) {
  try { await store.init(); dbReady = true; console.log(`🗄️  Database sẵn sàng (${store.kind}).`); }
  catch (e) { console.error(`❌ Không kết nối được database (lần ${attempt}): ${e.message}`); setTimeout(() => initDb(attempt + 1), Math.min(30000, attempt * 3000)); }
})();

const rooms = new Map();
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const rid = () => crypto.randomBytes(16).toString("base64url");
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, n);
const num = (v, max = 1e6) => Math.max(0, Math.min(max, Math.floor(+v || 0)));
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---------- Mật khẩu ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return "scrypt$" + salt.toString("hex") + "$" + crypto.scryptSync(pw, salt, 64).toString("hex");
}
function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored).split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  return safeEq(crypto.scryptSync(pw, Buffer.from(salt, "hex"), 64).toString("hex"), hash);
}
// Chặn đoán mật khẩu: tối đa 10 lần sai / 10 phút / địa chỉ IP
const fails = new Map();
const ipOf = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
function tooMany(ip) { const f = fails.get(ip); return f && f.n >= 10 && Date.now() - f.t < 600e3; }
function addFail(ip) { const f = fails.get(ip); if (!f || Date.now() - f.t > 600e3) fails.set(ip, { n: 1, t: Date.now() }); else f.n++; }

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((ok) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch { ok({}); } });
    req.on("error", () => ok({}));
  });
}
function newCode() { let c; do c = String(1000 + crypto.randomInt(9000)); while (rooms.has(c)); return c; }
const left = (r) => (r.phase === "play" ? Math.max(0, r.endAt - Date.now()) : 0);

function board(r) {
  return [...r.players.values()]
    .map((p) => ({ id: p.id, nick: p.nick, av: p.av, score: p.score, ok: p.ok, ans: p.ans, done: p.done, m0: p.m0, m1: p.m1, online: p.streams.size > 0 }))
    .sort((a, b) => b.score - a.score || b.ok - a.ok);
}
const publicState = (r) => ({ code: r.code, phase: r.phase, left: left(r), dur: r.dur, lessons: r.lessons, round: r.round, teacher: r.teacherName, board: board(r) });

function sseOpen(req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 2000\n\n");
}
const ssePush = (res, ev, data) => { try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };

function broadcast(r) {
  r.dirty = false; r.touched = Date.now();
  const s = publicState(r);
  for (const res of r.admins) ssePush(res, "state", s);
  for (const p of r.players.values()) for (const res of p.streams) ssePush(res, "state", { ...s, me: p.id });
}

// Lưu kết quả ván vào lịch sử của giáo viên (chờ vài giây để học sinh kịp chọn tâm trạng "sau khi chơi")
function scheduleSave(r) {
  const round = r.round;
  clearTimeout(r.saveTimer);
  r.saveTimer = setTimeout(() => saveRound(r, round), 45000);
}
function saveRound(r, round) {
  if (r.saved === round || r.round !== round) return;
  const players = board(r).filter((p) => p.ans > 0 || p.m1 != null);
  if (!players.length) return;
  r.saved = round;
  const data = { dur: r.dur, lessons: r.lessons, players: players.map(({ nick, av, score, ok, ans, m0, m1 }) => ({ nick, av, score, ok, ans, m0, m1 })) };
  store.saveResult(r.teacherId, r.code, round, data).catch((e) => console.error("Lưu lịch sử lỗi:", e.message));
}
function endRound(r) { if (r.phase !== "play") return; r.phase = "end"; r.dirty = true; scheduleSave(r); }
function resetRound(r) {
  if (r.phase === "end") { clearTimeout(r.saveTimer); saveRound(r, r.round); }
  r.round++; r.phase = "lobby"; r.endAt = 0;
  for (const p of r.players.values()) Object.assign(p, { score: 0, ok: 0, ans: 0, done: false, m1: null });
}

// Đồng hồ chung: kết thúc ván khi hết giờ, gửi cập nhật, dọn phòng cũ
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (r.phase === "play" && now >= r.endAt) endRound(r);
    if (r.dirty) broadcast(r);
    if (now - r.touched > 6 * 3600e3 && !r.admins.size) { if (r.phase === "end") saveRound(r, r.round); rooms.delete(r.code); }
  }
}, 1000);
// Giữ kết nối SSE sống (Render/proxy hay cắt kết nối im lặng)
setInterval(() => {
  for (const r of rooms.values()) {
    for (const res of r.admins) { try { res.write(": ping\n\n"); } catch {} }
    for (const p of r.players.values()) for (const res of p.streams) { try { res.write(": ping\n\n"); } catch {} }
  }
}, 15000);

function adminRoom(q) { const r = rooms.get(String(q.code || "")); return r && safeEq(q.token || "", r.token) ? r : null; }
function playerOf(q) {
  const r = rooms.get(String(q.code || "")); if (!r) return {};
  const p = r.players.get(String(q.pid || "")); if (!p || !safeEq(q.secret || "", p.secret)) return { r };
  return { r, p };
}
async function teacherOf(q) { const t = String(q.auth || ""); return t ? store.sessionTeacher(t) : null; }
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function api(req, res, url) {
  const q = req.method === "GET" || req.method === "HEAD" ? Object.fromEntries(url.searchParams) : await readBody(req);
  const route = url.pathname;

  // ----- Tài khoản giáo viên -----
  if (route.startsWith("/api/auth/") || route === "/api/admin/create" || route === "/api/admin/history" || route === "/api/admin/history/delete") {
    if (!dbReady) return json(res, 503, { error: "Database đang khởi động, thử lại sau vài giây nhé." });
  }
  if (route === "/api/auth/register" && req.method === "POST") {
    const ip = ipOf(req);
    if (tooMany(ip)) return json(res, 429, { error: "Bạn thử sai quá nhiều lần. Đợi 10 phút rồi thử lại." });
    const name = clean(q.name, 40), email = clean(q.email, 120).toLowerCase(), pw = String(q.password || "");
    if (!safeEq(q.code || "", TEACHER_CODE)) { addFail(ip); return json(res, 403, { error: "Mã giáo viên không đúng." }); }
    if (!name) return json(res, 400, { error: "Bạn cần nhập họ tên." });
    if (!emailOk(email)) return json(res, 400, { error: "Email không hợp lệ." });
    if (pw.length < 6) return json(res, 400, { error: "Mật khẩu cần ít nhất 6 kí tự." });
    const t = await store.createTeacher(email, name, hashPassword(pw));
    if (!t) return json(res, 409, { error: "Email này đã có tài khoản. Hãy đăng nhập." });
    const token = rid(); await store.createSession(token, t.id);
    return json(res, 200, { auth: token, name: t.name, email: t.email });
  }
  if (route === "/api/auth/login" && req.method === "POST") {
    const ip = ipOf(req);
    if (tooMany(ip)) return json(res, 429, { error: "Bạn thử sai quá nhiều lần. Đợi 10 phút rồi thử lại." });
    const t = await store.teacherByEmail(clean(q.email, 120).toLowerCase());
    if (!t || !checkPassword(String(q.password || ""), t.passHash)) { addFail(ip); return json(res, 401, { error: "Sai email hoặc mật khẩu." }); }
    const token = rid(); await store.createSession(token, t.id);
    return json(res, 200, { auth: token, name: t.name, email: t.email });
  }
  if (route === "/api/auth/me") {
    const t = await teacherOf(q); if (!t) return json(res, 401, { error: "Phiên đăng nhập đã hết hạn." });
    return json(res, 200, { name: t.name, email: t.email, rooms: [...rooms.values()].filter((r) => r.teacherId === t.id).map((r) => ({ code: r.code, token: r.token, phase: r.phase, players: r.players.size })) });
  }
  if (route === "/api/auth/logout" && req.method === "POST") {
    if (q.auth) await store.deleteSession(String(q.auth));
    return json(res, 200, { ok: true });
  }

  // ----- Quản lí phòng -----
  if (route === "/api/admin/create" && req.method === "POST") {
    const t = await teacherOf(q); if (!t) return json(res, 401, { error: "Bạn cần đăng nhập lại." });
    const code = newCode();
    const r = { code, token: rid(), teacherId: t.id, teacherName: t.name, phase: "lobby", endAt: 0, dur: 8 * 60000, lessons: [31, 32, 33, 34, 35], round: 1,
      players: new Map(), admins: new Set(), dirty: false, touched: Date.now() };
    rooms.set(code, r);
    return json(res, 200, { code, token: r.token });
  }
  if (route === "/api/admin/history") {
    const t = await teacherOf(q); if (!t) return json(res, 401, { error: "Bạn cần đăng nhập lại." });
    return json(res, 200, { results: await store.listResults(t.id, 30) });
  }
  if (route === "/api/admin/history/delete" && req.method === "POST") {
    const t = await teacherOf(q); if (!t) return json(res, 401, { error: "Bạn cần đăng nhập lại." });
    await store.deleteResult(t.id, num(q.id)); return json(res, 200, { ok: true });
  }
  if (route === "/api/admin/stream") {
    const r = adminRoom(q); if (!r) return json(res, 404, { error: "Phòng không tồn tại hoặc đã đóng." });
    if (req.method === "HEAD") return json(res, 200, {});
    sseOpen(req, res); r.admins.add(res); ssePush(res, "state", publicState(r));
    req.on("close", () => r.admins.delete(res));
    return;
  }
  if (route === "/api/admin/action" && req.method === "POST") {
    const r = adminRoom(q); if (!r) return json(res, 404, { error: "Phòng không tồn tại hoặc đã đóng." });
    switch (q.action) {
      case "settings":
        if (r.phase !== "play") {
          if (q.dur) r.dur = Math.max(60000, Math.min(60 * 60000, num(q.dur, 3600000)));
          if (Array.isArray(q.lessons)) r.lessons = q.lessons.map((x) => num(x, 99)).filter((x) => (x >= 8 && x <= 20) || (x >= 31 && x <= 35));
        }
        break;
      case "start":
        if (r.phase === "end") resetRound(r);
        r.phase = "play"; r.endAt = Date.now() + r.dur; break;
      case "end": endRound(r); break;
      case "reset": resetRound(r); break;
      case "kick": {
        const p = r.players.get(String(q.pid || ""));
        if (p) { for (const s of p.streams) { ssePush(s, "kicked", {}); try { s.end(); } catch {} } r.players.delete(p.id); }
        break;
      }
      case "close":
        if (r.phase === "end") { clearTimeout(r.saveTimer); saveRound(r, r.round); }
        for (const p of r.players.values()) for (const s of p.streams) { ssePush(s, "closed", {}); try { s.end(); } catch {} }
        for (const s of r.admins) { try { s.end(); } catch {} }
        rooms.delete(r.code); return json(res, 200, { ok: true });
      default: return json(res, 400, { error: "Lệnh không hợp lệ." });
    }
    broadcast(r);
    return json(res, 200, { ok: true });
  }

  // ----- Người chơi -----
  if (route === "/api/join" && req.method === "POST") {
    const r = rooms.get(String(q.code || "").trim());
    if (!r) return json(res, 404, { error: "Không tìm thấy phòng. Kiểm tra lại mã nhé!" });
    if (r.players.size >= MAX_PLAYERS) return json(res, 403, { error: "Phòng đã đầy." });
    const nick = clean(q.nick, 16); if (!nick) return json(res, 400, { error: "Bạn cần nhập tên." });
    const p = { id: rid(), secret: rid(), nick, av: AV.includes(q.av) ? q.av : AV[0], m0: q.m0 == null ? null : num(q.m0, 4), m1: null,
      score: 0, ok: 0, ans: 0, done: false, streams: new Set() };
    r.players.set(p.id, p); r.dirty = true;
    return json(res, 200, { pid: p.id, secret: p.secret, state: { ...publicState(r), me: p.id } });
  }
  if (route === "/api/stream") {
    const { r, p } = playerOf(q); if (!p) return json(res, 404, { error: "Không còn trong phòng." });
    if (req.method === "HEAD") return json(res, 200, {});
    sseOpen(req, res); p.streams.add(res); r.dirty = true;
    ssePush(res, "state", { ...publicState(r), me: p.id });
    req.on("close", () => { p.streams.delete(res); r.dirty = true; });
    return;
  }
  if (route === "/api/update" && req.method === "POST") {
    const { r, p } = playerOf(q); if (!p) return json(res, 404, { error: "Không còn trong phòng." });
    if (+q.round === r.round) {
      if (r.phase === "play") Object.assign(p, { score: num(q.score), ok: num(q.ok, 10000), ans: num(q.ans, 10000), done: !!q.done });
      if (q.m1 != null) p.m1 = num(q.m1, 4);
      r.dirty = true;
    }
    return json(res, 200, { ok: true });
  }
  if (route === "/api/leave" && req.method === "POST") {
    const { r, p } = playerOf(q); if (p) { r.players.delete(p.id); r.dirty = true; }
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: "Không có API này." });
}

// ---------- Trang web ----------
// Chỉ phục vụ đúng các file giao diện. Tìm cạnh server.js trước, rồi trong thư mục public/ (nếu có).
const FILES = ["index.html", "admin.html", "register.html"];
const ROUTES = { "": "index.html", admin: "admin.html", "quan-li": "admin.html", "dang-ki": "register.html", "dang-ky": "register.html", register: "register.html" };
function findFile(name) {
  for (const dir of [__dirname, path.join(__dirname, "public")]) { const fp = path.join(dir, name); if (fs.existsSync(fp)) return fp; }
  return null;
}
function serveStatic(req, res, url) {
  let f = url.pathname.replace(/^\/+|\/+$/g, "").replace(/^public\//, "");
  if (f in ROUTES) f = ROUTES[f];
  const fp = FILES.includes(f) ? findFile(f) : null;
  if (!fp) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(FILES.includes(f) ? `Không tìm thấy trang: thiếu file ${f}. Hãy tải file này lên GitHub (cùng chỗ với server.js).` : "Không tìm thấy trang.");
  }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Không tìm thấy trang."); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") return json(res, 200, { ok: true, rooms: rooms.size, db: store.kind, dbReady });
  if (url.pathname.startsWith("/api/")) return api(req, res, url).catch((e) => { console.error(e); json(res, 500, { error: "Lỗi máy chủ: " + e.message }); });
  serveStatic(req, res, url);
}).listen(PORT, () => console.log(`🌿 Vườn Bình Yên chạy tại http://localhost:${PORT}  (quản lí: /admin · tạo tài khoản: /dang-ki)`));
