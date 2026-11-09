// Kết nối PostgreSQL không cần thư viện ngoài (giao thức Postgres v3, hỗ trợ SSL + SCRAM-SHA-256 + MD5).
// Nếu không có DATABASE_URL thì dùng bộ nhớ tạm (mất khi server khởi động lại).
const net = require("net");
const tls = require("tls");
const crypto = require("crypto");

const cstr = (s) => Buffer.from(String(s) + "\0", "utf8");
const i16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const hmac = (k, s) => crypto.createHmac("sha256", k).update(s).digest();
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

function pgError(body) {
  const f = {};
  let i = 0;
  while (i < body.length && body[i] !== 0) {
    const t = String.fromCharCode(body[i]);
    const end = body.indexOf(0, i + 1);
    f[t] = body.subarray(i + 1, end).toString("utf8");
    i = end + 1;
  }
  const e = new Error(f.M || "Lỗi database");
  e.code = f.C;
  return e;
}

class PG {
  constructor(url) {
    const u = new URL(url);
    this.cfg = {
      host: u.hostname, port: +u.port || 5432,
      user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.slice(1)) || decodeURIComponent(u.username),
      ssl: u.searchParams.get("sslmode") || "prefer",
    };
    this.queue = []; this.cur = null; this.sock = null; this.ready = null; this.auth = null;
  }

  _send(type, payload = Buffer.alloc(0)) {
    const h = Buffer.alloc(5); h.write(type, 0, "ascii"); h.writeInt32BE(payload.length + 4, 1);
    return Buffer.concat([h, payload]);
  }

  connect() {
    if (this.ready) return this.ready;
    const c = this.cfg;
    this.ready = new Promise((ok, no) => {
      let done = false;
      const fail = (e) => { if (done) return; done = true; this._dead(e); no(e); };
      const succeed = () => { if (done) return; done = true; ok(); };
      const raw = net.connect(c.port, c.host);
      raw.setKeepAlive(true, 30000);
      raw.once("error", fail);
      const start = (s) => {
        this.sock = s;
        let buf = Buffer.alloc(0);
        s.on("error", (e) => { fail(e); this._dead(e); });
        s.on("close", () => { const e = new Error("Mất kết nối database"); fail(e); this._dead(e); });
        s.on("data", (d) => {
          buf = buf.length ? Buffer.concat([buf, d]) : d;
          while (buf.length >= 5) {
            const len = buf.readInt32BE(1);
            if (buf.length < 1 + len) break;
            const type = String.fromCharCode(buf[0]), body = buf.subarray(5, 1 + len);
            buf = buf.subarray(1 + len);
            try { this._msg(type, body); } catch (e) { console.error("DB parse:", e); }
          }
        });
        this.auth = { ok: succeed, fail };
        const p = Buffer.concat([cstr("user"), cstr(c.user), cstr("database"), cstr(c.database), cstr("client_encoding"), cstr("UTF8"), Buffer.from([0])]);
        s.write(Buffer.concat([i32(p.length + 8), i32(196608), p]));
      };
      raw.once("connect", () => {
        if (c.ssl === "disable") return start(raw);
        raw.write(Buffer.concat([i32(8), i32(80877103)]));
        raw.once("data", (d) => {
          if (d[0] === 83) { // 'S' – server đồng ý SSL
            const t = tls.connect({ socket: raw, servername: net.isIP(c.host) ? undefined : c.host, rejectUnauthorized: false });
            t.once("secureConnect", () => start(t));
            t.once("error", fail);
          } else if (c.ssl === "require" || c.ssl === "verify-full") fail(new Error("Database không hỗ trợ SSL"));
          else start(raw);
        });
      });
    });
    this.ready.then(() => this._next(), () => {});
    return this.ready;
  }

  _dead(e) {
    if (this.sock) { try { this.sock.destroy(); } catch {} }
    this.sock = null; this.ready = null; this.auth = null;
    if (this.cur) { const j = this.cur; this.cur = null; j.no(e); }
  }

  _msg(t, b) {
    if (t === "N") return; // notice
    if (this.auth) return this._authMsg(t, b);
    if (this.cur) return this._queryMsg(t, b);
  }

  _authMsg(t, b) {
    const c = this.cfg, a = this.auth;
    if (t === "E") return a.fail(pgError(b));
    if (t === "Z") { this.auth = null; return a.ok(); }
    if (t !== "R") return; // ParameterStatus, BackendKeyData...
    const code = b.readInt32BE(0);
    if (code === 0 || code === 12) return;
    if (code === 3) return this.sock.write(this._send("p", cstr(c.password)));
    if (code === 5) {
      const salt = b.subarray(4, 8);
      const inner = md5(c.password + c.user);
      return this.sock.write(this._send("p", cstr("md5" + md5(Buffer.concat([Buffer.from(inner), salt])))));
    }
    if (code === 10) {
      const mechs = b.subarray(4).toString().split("\0");
      if (!mechs.includes("SCRAM-SHA-256")) return a.fail(new Error("Database yêu cầu kiểu xác thực không hỗ trợ: " + mechs.join(",")));
      this.nonce = crypto.randomBytes(18).toString("base64");
      this.cfb = "n=*,r=" + this.nonce;
      const first = Buffer.from("n,," + this.cfb);
      return this.sock.write(this._send("p", Buffer.concat([cstr("SCRAM-SHA-256"), i32(first.length), first])));
    }
    if (code === 11) {
      const sf = b.subarray(4).toString();
      const kv = Object.fromEntries(sf.split(",").map((x) => [x[0], x.slice(2)]));
      if (!kv.r || !kv.r.startsWith(this.nonce)) return a.fail(new Error("SCRAM nonce không khớp"));
      const salted = crypto.pbkdf2Sync(c.password, Buffer.from(kv.s, "base64"), +kv.i, 32, "sha256");
      const ck = hmac(salted, "Client Key");
      const sk = crypto.createHash("sha256").update(ck).digest();
      const noProof = "c=biws,r=" + kv.r;
      const am = this.cfb + "," + sf + "," + noProof;
      const sig = hmac(sk, am);
      const proof = Buffer.alloc(ck.length);
      for (let i = 0; i < ck.length; i++) proof[i] = ck[i] ^ sig[i];
      return this.sock.write(this._send("p", Buffer.from(noProof + ",p=" + proof.toString("base64"))));
    }
    a.fail(new Error("Kiểu xác thực database không hỗ trợ: " + code));
  }

  _queryMsg(t, b) {
    const j = this.cur;
    if (t === "T") {
      const n = b.readInt16BE(0); let i = 2; j.fields = [];
      for (let k = 0; k < n; k++) { const e = b.indexOf(0, i); j.fields.push(b.subarray(i, e).toString("utf8")); i = e + 1 + 18; }
    } else if (t === "D") {
      const n = b.readInt16BE(0); let i = 2; const row = {};
      for (let k = 0; k < n; k++) {
        const len = b.readInt32BE(i); i += 4;
        row[j.fields[k]] = len < 0 ? null : b.subarray(i, i + len).toString("utf8");
        if (len > 0) i += len;
      }
      j.rows.push(row);
    } else if (t === "C") {
      const tag = b.subarray(0, b.length - 1).toString(); const m = tag.match(/(\d+)$/); j.count = m ? +m[1] : 0;
    } else if (t === "E") j.err = pgError(b);
    else if (t === "Z") {
      this.cur = null;
      j.err ? j.no(j.err) : j.ok({ rows: j.rows, rowCount: j.count || 0 });
      this._next();
    }
  }

  query(sql, params = []) {
    return new Promise((ok, no) => { this.queue.push({ sql, params, ok, no, rows: [], fields: [] }); this._next(); });
  }

  _next() {
    if (this.cur || !this.queue.length) return;
    if (!this.sock || this.auth) {
      if (!this.ready) this.connect().catch((e) => { const q = this.queue; this.queue = []; q.forEach((j) => j.no(e)); });
      return;
    }
    const j = (this.cur = this.queue.shift());
    const vals = j.params.map((v) => {
      if (v === null || v === undefined) return i32(-1);
      const bb = Buffer.from(typeof v === "object" ? JSON.stringify(v) : String(v), "utf8");
      return Buffer.concat([i32(bb.length), bb]);
    });
    this.sock.write(Buffer.concat([
      this._send("P", Buffer.concat([cstr(""), cstr(j.sql), i16(0)])),
      this._send("B", Buffer.concat([cstr(""), cstr(""), i16(0), i16(vals.length), ...vals, i16(0)])),
      this._send("D", Buffer.concat([Buffer.from("P"), cstr("")])),
      this._send("E", Buffer.concat([cstr(""), i32(0)])),
      this._send("S"),
    ]));
  }
}

// ---------- Kho dữ liệu: giáo viên, phiên đăng nhập, lịch sử ván ----------
const SESSION_DAYS = 30;

function pgStore(url) {
  const db = new PG(url);
  const one = async (sql, p) => (await db.query(sql, p)).rows[0] || null;
  const toTeacher = (r) => r && { id: +r.id, email: r.email, name: r.name, passHash: r.pass_hash };
  return {
    kind: "postgres",
    async init() {
      await db.query(`CREATE TABLE IF NOT EXISTS teachers(
        id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pass_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await db.query(`CREATE TABLE IF NOT EXISTS sessions(
        token TEXT PRIMARY KEY, teacher_id INT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await db.query(`CREATE TABLE IF NOT EXISTS results(
        id SERIAL PRIMARY KEY, teacher_id INT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
        room_code TEXT, round INT, data JSONB NOT NULL, played_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await db.query(`DELETE FROM sessions WHERE created_at < now() - interval '${SESSION_DAYS} days'`);
    },
    async createTeacher(email, name, passHash) {
      try { return toTeacher(await one("INSERT INTO teachers(email,name,pass_hash) VALUES($1,$2,$3) RETURNING *", [email, name, passHash])); }
      catch (e) { if (e.code === "23505") return null; throw e; }
    },
    async teacherByEmail(email) { return toTeacher(await one("SELECT * FROM teachers WHERE email=$1", [email])); },
    async createSession(token, teacherId) { await db.query("INSERT INTO sessions(token,teacher_id) VALUES($1,$2)", [token, teacherId]); },
    async sessionTeacher(token) {
      return toTeacher(await one(`SELECT t.* FROM sessions s JOIN teachers t ON t.id=s.teacher_id
        WHERE s.token=$1 AND s.created_at > now() - interval '${SESSION_DAYS} days'`, [token]));
    },
    async deleteSession(token) { await db.query("DELETE FROM sessions WHERE token=$1", [token]); },
    async saveResult(teacherId, code, round, data) {
      await db.query("INSERT INTO results(teacher_id,room_code,round,data) VALUES($1,$2,$3,$4::jsonb)", [teacherId, code, round, data]);
    },
    async listResults(teacherId, limit = 30) {
      const r = await db.query(`SELECT id, room_code, round, data::text AS data, (extract(epoch from played_at)*1000)::bigint AS ms
        FROM results WHERE teacher_id=$1 ORDER BY played_at DESC LIMIT $2`, [teacherId, limit]);
      return r.rows.map((x) => ({ id: +x.id, code: x.room_code, round: +x.round, at: +x.ms, ...JSON.parse(x.data) }));
    },
    async deleteResult(teacherId, id) { await db.query("DELETE FROM results WHERE teacher_id=$1 AND id=$2", [teacherId, id]); },
  };
}

function memStore() {
  const teachers = new Map(), sessions = new Map(), results = [];
  let tid = 0, rid = 0;
  return {
    kind: "memory",
    async init() {},
    async createTeacher(email, name, passHash) {
      for (const t of teachers.values()) if (t.email === email) return null;
      const t = { id: ++tid, email, name, passHash }; teachers.set(t.id, t); return t;
    },
    async teacherByEmail(email) { for (const t of teachers.values()) if (t.email === email) return t; return null; },
    async createSession(token, teacherId) { sessions.set(token, { teacherId, at: Date.now() }); },
    async sessionTeacher(token) {
      const s = sessions.get(token);
      if (!s || Date.now() - s.at > SESSION_DAYS * 864e5) return null;
      return teachers.get(s.teacherId) || null;
    },
    async deleteSession(token) { sessions.delete(token); },
    async saveResult(teacherId, code, round, data) { results.unshift({ id: ++rid, teacherId, code, round, at: Date.now(), ...data }); },
    async listResults(teacherId, limit = 30) { return results.filter((r) => r.teacherId === teacherId).slice(0, limit).map(({ teacherId, ...r }) => r); },
    async deleteResult(teacherId, id) { const i = results.findIndex((r) => r.id === id && r.teacherId === teacherId); if (i >= 0) results.splice(i, 1); },
  };
}

module.exports = { createStore: (url) => (url ? pgStore(url) : memStore()), PG };
