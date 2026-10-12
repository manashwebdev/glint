// Glint server: accounts and a saved-design library.
// Storage: MongoDB when MONGODB_URI is set, otherwise a local JSON file (development only).
// It also serves ../client when that folder exists, so `npm start` runs the whole app locally.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

try { // minimal .env loader, real environment variables win
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) {}

const PORT = process.env.PORT || 3000, ORIGIN = process.env.CLIENT_ORIGIN || '*';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data'), CLIENT = path.join(__dirname, '..', 'client');
let SECRET = process.env.JWT_SECRET;
if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); console.warn('JWT_SECRET is not set. Using a temporary secret, so everyone is signed out on each restart.'); }

// ---- passwords and tokens (Node crypto only)
const hmac = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
const sign = id => { const p = Buffer.from(JSON.stringify({ sub: id, exp: Date.now() + 7 * 864e5 })).toString('base64url'); return p + '.' + hmac(p); };
const verify = t => { try { const [p, s] = String(t).split('.'), e = hmac(p); if (!s || s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null; const d = JSON.parse(Buffer.from(p, 'base64url')); return d.exp > Date.now() ? d.sub : null; } catch (_) { return null; } };
const hash = pw => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const check = (pw, h) => { const [s, k] = h.split(':'), a = Buffer.from(k, 'hex'), b = crypto.scryptSync(pw, s, 64); return a.length === b.length && crypto.timingSafeEqual(a, b); };

// ---- storage
async function openStore() {
  if (process.env.MONGODB_URI) {
    let mongo; try { mongo = require('mongodb'); } catch (_) { throw new Error('MONGODB_URI is set but the "mongodb" package is missing. Run: npm install'); }
    const c = new mongo.MongoClient(process.env.MONGODB_URI); await c.connect();
    const db = c.db(process.env.MONGODB_DB || 'glint'), U = db.collection('users'), P = db.collection('projects');
    await U.createIndex({ email: 1 }, { unique: true }); await P.createIndex({ userId: 1, at: -1 });
    const oid = id => { try { return new mongo.ObjectId(String(id)); } catch (_) { return null; } };
    return { name: 'MongoDB',
      userByEmail: async e => { const u = await U.findOne({ email: e }); return u && { id: String(u._id), pw: u.pw }; },
      addUser: async (email, pw) => String((await U.insertOne({ email, pw, createdAt: new Date() })).insertedId),
      list: async u => (await P.find({ userId: u }, { projection: { name: 1, thumb: 1, at: 1 } }).sort({ at: -1 }).toArray()).map(d => ({ id: String(d._id), name: d.name, thumb: d.thumb, at: d.at })),
      count: u => P.countDocuments({ userId: u }),
      add: async (u, d) => String((await P.insertOne({ ...d, userId: u })).insertedId),
      get: async (u, id) => { const o = oid(id); const d = o && await P.findOne({ _id: o, userId: u }); if (!d) return null; const { _id, userId, ...r } = d; return { ...r, id: String(_id) }; },
      put: async (u, id, d) => { const o = oid(id); return !!o && (await P.updateOne({ _id: o, userId: u }, { $set: d })).matchedCount > 0; },
      del: async (u, id) => { const o = oid(id); return !!o && (await P.deleteOne({ _id: o, userId: u })).deletedCount > 0; } };
  }
  fs.mkdirSync(DATA, { recursive: true });
  const file = path.join(DATA, 'glint.json'); let db = { users: [], projects: [] };
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  const save = () => fs.writeFileSync(file, JSON.stringify(db)), nid = () => crypto.randomBytes(12).toString('hex');
  return { name: 'JSON file (development only)',
    userByEmail: async e => db.users.find(u => u.email === e) || null,
    addUser: async (email, pw) => { const id = nid(); db.users.push({ id, email, pw }); save(); return id; },
    list: async u => db.projects.filter(p => p.userId === u).sort((a, b) => b.at - a.at).map(p => ({ id: p.id, name: p.name, thumb: p.thumb, at: p.at })),
    count: async u => db.projects.filter(p => p.userId === u).length,
    add: async (u, d) => { const id = nid(); db.projects.push({ ...d, id, userId: u }); save(); return id; },
    get: async (u, id) => { const p = db.projects.find(x => x.id === id && x.userId === u); if (!p) return null; const { userId, ...r } = p; return r; },
    put: async (u, id, d) => { const i = db.projects.findIndex(x => x.id === id && x.userId === u); if (i < 0) return false; db.projects[i] = { ...db.projects[i], ...d }; save(); return true; },
    del: async (u, id) => { const n = db.projects.length; db.projects = db.projects.filter(x => !(x.id === id && x.userId === u)); save(); return db.projects.length < n; } };
}

// ---- helpers
const fail = (status, error) => Object.assign(new Error(error), { status });
const send = (res, code, b, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); res.end(typeof b === 'string' || Buffer.isBuffer(b) ? b : JSON.stringify(b)); };
const readBody = req => new Promise((ok, no) => { let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > 15e6) { no(fail(413, 'Design is too large')); req.destroy(); } else c.push(d); }); req.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch (_) { no(fail(400, 'Invalid JSON')); } }); req.on('error', no); });
const isImg = s => typeof s === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(s);
function clean(b) {
  if (!b || typeof b !== 'object' || !isImg(b.image) || !isImg(b.thumb) || b.image.length > 12e6 || b.thumb.length > 3e5 || !b.settings || typeof b.settings !== 'object' || !Array.isArray(b.ann) || b.ann.length > 300) throw fail(400, 'Invalid design');
  return { name: String(b.name || 'Untitled design').slice(0, 60), settings: b.settings, t: b.t, crop: b.crop, ann: b.ann, image: b.image, thumb: b.thumb, at: Date.now() };
}
const hits = new Map();
const limited = ip => { const n = Date.now(), h = hits.get(ip); if (!h || h.r < n) { hits.set(ip, { c: 1, r: n + 9e5 }); return false; } return ++h.c > 20; };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

openStore().then(store => {
  http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost'), p = url.pathname;
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (p === '/api/health') return send(res, 200, { ok: true, db: store.name });
      if (req.method === 'POST' && (p === '/api/auth/register' || p === '/api/auth/login')) {
        if (limited((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim())) throw fail(429, 'Too many attempts. Try again in a few minutes.');
        const b = await readBody(req), email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw fail(400, 'Enter a valid email address');
        if (pw.length < 8 || pw.length > 100) throw fail(400, 'Password must be 8 to 100 characters');
        const u = await store.userByEmail(email);
        if (p.endsWith('register')) {
          if (u) throw fail(409, 'An account with this email already exists');
          try { return send(res, 200, { token: sign(await store.addUser(email, hash(pw))) }); } catch (e) { throw e.code === 11000 ? fail(409, 'An account with this email already exists') : e; }
        }
        if (!u || !check(pw, u.pw)) throw fail(401, 'Wrong email or password');
        return send(res, 200, { token: sign(u.id) });
      }
      if (p.startsWith('/api/projects')) {
        const uid = verify((req.headers.authorization || '').replace(/^Bearer /, ''));
        if (!uid) throw fail(401, 'Invalid or expired token');
        const id = p.split('/')[3];
        if (id !== undefined && !/^[a-f0-9]{24}$/.test(id)) throw fail(404, 'Design not found');
        if (!id && req.method === 'GET') return send(res, 200, await store.list(uid));
        if (!id && req.method === 'POST') { if (await store.count(uid) >= 30) throw fail(400, 'Library is full (30 designs). Delete one first.'); return send(res, 200, { id: await store.add(uid, clean(await readBody(req))) }); }
        if (id && req.method === 'GET') { const d = await store.get(uid, id); if (!d) throw fail(404, 'Design not found'); return send(res, 200, d); }
        if (id && req.method === 'PUT') { if (!await store.put(uid, id, clean(await readBody(req)))) throw fail(404, 'Design not found'); return send(res, 200, { id }); }
        if (id && req.method === 'DELETE') { if (!await store.del(uid, id)) throw fail(404, 'Design not found'); return send(res, 200, { ok: true }); }
        throw fail(405, 'Method not allowed');
      }
      const f = p === '/' ? 'index.html' : p.slice(1);
      if ((f === 'index.html' || f === 'config.js') && fs.existsSync(path.join(CLIENT, f))) return send(res, 200, fs.readFileSync(path.join(CLIENT, f)), TYPES[path.extname(f)]);
      throw fail(404, 'Not found');
    } catch (e) {
      if (!e.status) console.error(e);
      send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    }
  }).listen(PORT, () => console.log('Glint running at http://localhost:' + PORT + ' (database: ' + store.name + ')'));
}).catch(e => { console.error('Could not start: ' + e.message); process.exit(1); });
