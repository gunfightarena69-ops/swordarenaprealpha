// Sword Arena — сервер дедматча. Без зависимостей: node server.js
// Раздаёт sword-arena.html по http и принимает игроков по WebSocket (тот же порт).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 16, MAX_MSG = 4096, TICK_MS = 50, RESPAWN_MS = 3000;
// Оружие (параметры продублированы в клиенте): урон, интервал между выстрелами (мс), дробинок, разброс
const WEAPONS = [
    { dmg: 22, rate: 280, pellets: 1, spread: 0.012 },   // пистолет
    { dmg: 13, rate: 100, pellets: 1, spread: 0.035 },   // автомат
    { dmg: 9,  rate: 850, pellets: 8, spread: 0.09 },    // дробовик
    { dmg: 100, rate: 1400, pellets: 1, spread: 0.045, minMult: 0.04 }   // снайперка (minMult — разброс при прицеливании)
];
const HEAD_MULT = 2, MAX_RANGE = 80;
const PILLARS = [];   // колонны 3x3, высота 8
for (const x of [-18, 18]) for (const z of [-18, 18]) PILLARS.push([[x - 1.5, 0, z - 1.5], [x + 1.5, 8, z + 1.5]]);
const LIMIT = 33;
const SPAWNS = [[0, 15], [0, -15], [15, 0], [-15, 0], [25, 25], [-25, 25], [25, -25], [-25, -25], [8, 26], [-8, -26]];

/* ---------- HTTP: отдаём игру ---------- */
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html' || req.url === '/sword-arena.html') {
        fs.readFile(path.join(__dirname, 'sword-arena.html'), (err, data) => {
            if (err) { res.writeHead(500); return res.end('sword-arena.html не найден рядом с server.js'); }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
    } else if (req.url === '/health') {
        res.writeHead(200); res.end('ok');
    } else { res.writeHead(404); res.end('not found'); }
});

/* ---------- Минимальный WebSocket (RFC 6455) ---------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(op, payload) {
    const len = payload.length;
    let h;
    if (len < 126) h = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([h, payload]);
}
const send = (c, obj) => { if (c.open && !c.socket.destroyed) c.socket.write(frame(1, Buffer.from(JSON.stringify(obj)))); };
const broadcast = obj => { const f = frame(1, Buffer.from(JSON.stringify(obj))); for (const c of clients) if (c.open && c.joined && !c.socket.destroyed) c.socket.write(f); };

const clients = new Set();
let nextId = 1;

server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket' || clients.size >= MAX_PLAYERS) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.setNoDelay(true);

    const c = { socket, open: true, buf: Buffer.alloc(0), frag: null, joined: false, id: nextId++, msgs: 0, msgWindow: Date.now() };
    clients.add(c);
    socket.on('data', chunk => onData(c, chunk));
    socket.on('close', () => drop(c));
    socket.on('error', () => drop(c));
});

function onData(c, chunk) {
    c.buf = Buffer.concat([c.buf, chunk]);
    while (c.open) {
        const b = c.buf;
        if (b.length < 2) return;
        const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
        let len = b[1] & 0x7f, off = 2;
        if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(MAX_MSG)) return kill(c); len = Number(big); off = 10; }
        if (len > MAX_MSG || !masked) return kill(c);
        if (b.length < off + 4 + len) return;
        const mask = b.subarray(off, off + 4);
        const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
        c.buf = b.subarray(off + 4 + len);

        if (op === 8) { try { c.socket.write(frame(8, Buffer.alloc(0))); } catch (e) {} return kill(c); }
        if (op === 9) { c.socket.write(frame(10, data)); continue; }
        if (op === 10) continue;
        if (op === 1 || op === 0) {
            if (op === 1) c.frag = []; else if (!c.frag) return kill(c);
            c.frag.push(data);
            if (fin) { const text = Buffer.concat(c.frag).toString('utf8'); c.frag = null; onMessage(c, text); }
        }
    }
}

function kill(c) { c.open = false; try { c.socket.destroy(); } catch (e) {} drop(c); }
function drop(c) {
    if (!clients.has(c)) return;
    clients.delete(c);
    c.open = false;
    if (c.joined) { broadcast({ t: 'leave', id: c.id }); }
}

/* ---------- Игровая логика ---------- */
const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v)) ? Math.max(lo, Math.min(hi, v)) : null;

function pickSpawn(self) {
    let best = SPAWNS[0], bestD = -1;
    for (const s of SPAWNS) {
        let d = Infinity;
        for (const o of clients) if (o !== self && o.joined && o.alive) d = Math.min(d, Math.hypot(o.x - s[0], o.z - s[1]));
        d += Math.random() * 6;   // чуть случайности, чтобы не спавниться всегда в одном месте
        if (d > bestD) { bestD = d; best = s; }
    }
    return best;
}

function onMessage(c, text) {
    const now = Date.now();
    if (now - c.msgWindow > 1000) { c.msgWindow = now; c.msgs = 0; }
    if (++c.msgs > 80) return;   // защита от флуда
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join' && !c.joined) {
        c.name = String(m.name || 'Игрок').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 14) || 'Игрок';
        const s = pickSpawn(c);
        Object.assign(c, { joined: true, alive: true, hp: 100, kills: 0, deaths: 0, x: s[0], y: 1.7, z: s[1], yaw: 0, pitch: 0, block: 0, lastAtk: 0 });
        send(c, { t: 'welcome', id: c.id, x: c.x, z: c.z });
        console.log(`+ ${c.name} (#${c.id}) вошёл, игроков: ${[...clients].filter(o => o.joined).length}`);
        return;
    }
    if (!c.joined) return;

    if (m.t === 'state' && c.alive) {
        const x = num(m.x, -LIMIT, LIMIT), y = num(m.y, 0, 30), z = num(m.z, -LIMIT, LIMIT);
        const yaw = num(m.yaw, -1e4, 1e4), pitch = num(m.pitch, -2, 2);
        if (x === null || y === null || z === null || yaw === null || pitch === null) return;
        Object.assign(c, { x, y, z, yaw, pitch, block: m.b ? 1 : 0 });
    } else if (m.t === 'shoot' && c.alive) {
        const w = WEAPONS[m.w | 0];
        const dx = num(m.dx, -1, 1), dy = num(m.dy, -1, 1), dz = num(m.dz, -1, 1);
        if (!w || dx === null || dy === null || dz === null) return;
        if (now - c.lastAtk < w.rate * 0.85) return;   // скорострельность проверяет сервер
        c.lastAtk = now;
        const len = Math.hypot(dx, dy, dz);
        if (len < 0.5) return;
        broadcast({ t: 'shot', id: c.id });
        let mult = num(m.m, w.minMult || 1, 4);
        if (mult === null) mult = 1;
        if (c.y - 1.7 > surfaceH(c.x, c.z) + 0.2) mult = Math.max(mult, 3.2);   // в прыжке разброс нельзя «отключить»
        shoot(c, w, [dx / len, dy / len, dz / len], mult);
    }
}

// ---- геометрия лучей ----
function raySphere(o, d, cx, cy, cz, r) {
    const ox = o[0] - cx, oy = o[1] - cy, oz = o[2] - cz;
    const b = ox * d[0] + oy * d[1] + oz * d[2], c = ox * ox + oy * oy + oz * oz - r * r, h = b * b - c;
    if (h < 0) return null;
    const t = -b - Math.sqrt(h);
    return t >= 0 ? t : null;
}
function rayCyl(o, d, cx, cz, r, y0, y1) {   // вертикальный цилиндр с торцами
    const ox = o[0] - cx, oz = o[2] - cz, a = d[0] * d[0] + d[2] * d[2];
    let best = null;
    if (a > 1e-9) {
        const b = ox * d[0] + oz * d[2], c = ox * ox + oz * oz - r * r, h = b * b - a * c;
        if (h >= 0) {
            const sq = Math.sqrt(h);
            for (const t of [(-b - sq) / a, (-b + sq) / a]) {
                const y = o[1] + d[1] * t;
                if (t >= 0 && y >= y0 && y <= y1) { best = t; break; }
            }
        }
    }
    if (Math.abs(d[1]) > 1e-9) for (const y of [y0, y1]) {
        const t = (y - o[1]) / d[1];
        if (t >= 0 && (best === null || t < best)) { const x = ox + d[0] * t, z = oz + d[2] * t; if (x * x + z * z <= r * r) best = t; }
    }
    return best;
}
function rayBox(o, d, mn, mx) {
    let t0 = 0, t1 = Infinity;
    for (let i = 0; i < 3; i++) {
        if (Math.abs(d[i]) < 1e-9) { if (o[i] < mn[i] || o[i] > mx[i]) return null; }
        else {
            let a = (mn[i] - o[i]) / d[i], b = (mx[i] - o[i]) / d[i];
            if (a > b) { const tmp = a; a = b; b = tmp; }
            t0 = Math.max(t0, a); t1 = Math.min(t1, b);
            if (t0 > t1) return null;
        }
    }
    return t0;
}
function obstacleT(o, d) {   // ближайшее препятствие: пол, колонны, центральный столб
    let t = MAX_RANGE;
    if (d[1] < -1e-6) t = Math.min(t, -o[1] / d[1]);
    for (const bx of PILLARS) { const h = rayBox(o, d, bx[0], bx[1]); if (h !== null && h < t) t = h; }
    const c = rayCyl(o, d, 0, 0, 1.5, 1.5, 9.5);
    if (c !== null && c < t) t = c;
    return t;
}

function surfaceH(x, z) { const r = Math.hypot(x, z); return r <= 8 ? 1.5 : r >= 10 ? 0 : 1.5 * (10 - r) / 2; }

function shoot(a, w, dir, mult) {
    const o = [a.x, a.y, a.z];
    let hitAny = false;
    for (let i = 0; i < w.pellets; i++) {
        const s = w.spread * mult;
        let d = [dir[0] + (Math.random() - 0.5) * 2 * s, dir[1] + (Math.random() - 0.5) * 2 * s, dir[2] + (Math.random() - 0.5) * 2 * s];
        const l = Math.hypot(d[0], d[1], d[2]); d = [d[0] / l, d[1] / l, d[2] / l];
        const tObs = obstacleT(o, d);
        let best = null;
        for (const q of clients) {
            if (q === a || !q.joined || !q.alive) continue;
            const feet = q.y - 1.7;
            const tHead = raySphere(o, d, q.x, feet + 1.8, q.z, 0.35);
            const tBody = rayCyl(o, d, q.x, q.z, 0.5, feet + 0.1, feet + 1.65);
            if (tHead === null && tBody === null) continue;
            const head = tHead !== null && (tBody === null || tHead <= tBody + 0.2);
            const t = head ? tHead : tBody;
            if (t < tObs && (!best || t < best.t)) best = { q, t, head };
        }
        if (best) { hitAny = true; applyDamage(a, best.q, w.dmg * (best.head ? HEAD_MULT : 1), best.head); }
    }
    if (hitAny) send(a, { t: 'hitok' });
}

function applyDamage(a, q, dmg, head) {
    if (!q.alive) return;
    q.hp -= dmg;
    if (q.hp > 0) return;
    q.hp = 0; q.alive = false; q.deaths++; a.kills++;
    broadcast({ t: 'kill', k: a.name, v: q.name, h: head ? 1 : 0 });
    send(q, { t: 'died' });
    setTimeout(() => {
        if (!q.open) return;
        const s = pickSpawn(q);
        Object.assign(q, { alive: true, hp: 100, x: s[0], z: s[1], y: 1.7, block: 0 });
        send(q, { t: 'respawn', x: s[0], z: s[1] });
    }, RESPAWN_MS);
}

setInterval(() => {
    const p = [];
    for (const c of clients) if (c.joined) p.push({
        id: c.id, n: c.name, x: +c.x.toFixed(2), y: +c.y.toFixed(2), z: +c.z.toFixed(2),
        yaw: +c.yaw.toFixed(3), pitch: +c.pitch.toFixed(3), hp: c.hp, k: c.kills, d: c.deaths, b: c.block, al: c.alive ? 1 : 0
    });
    if (p.length) broadcast({ t: 'snap', p });
}, TICK_MS);

server.listen(PORT, () => console.log(`Sword Arena: http://localhost:${PORT}  (ws на том же порту)`));
