// Sword Arena — сервер дедматча. Без зависимостей: node server.js
// Раздаёт sword-arena.html по http и принимает игроков по WebSocket (тот же порт).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 16, MAX_MSG = 4096, TICK_MS = 50, RESPAWN_MS = 3000;
const HIT_RANGE = 2.8, SWING_DELAY = 120, ATTACK_COOLDOWN = 450, DAMAGE = 45, BLOCK_DAMAGE = 9;
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
    } else if (m.t === 'attack' && c.alive && now - c.lastAtk >= ATTACK_COOLDOWN && !c.block) {
        c.lastAtk = now;
        broadcast({ t: 'swing', id: c.id });
        setTimeout(() => { if (c.open && c.alive) resolveHit(c); }, SWING_DELAY);
    }
}

function resolveHit(a) {
    const lx = -Math.sin(a.yaw), lz = -Math.cos(a.yaw);
    let hit = false;
    for (const q of clients) {
        if (q === a || !q.joined || !q.alive) continue;
        const dx = q.x - a.x, dz = q.z - a.z, dist = Math.hypot(dx, dz);
        if (dist > HIT_RANGE || Math.abs(q.y - a.y) > 2) continue;
        if (dist > 0.5 && (dx / dist) * lx + (dz / dist) * lz < 0.2) continue;   // цель должна быть перед атакующим
        hit = true;
        q.hp -= q.block ? BLOCK_DAMAGE : DAMAGE;
        if (q.hp <= 0) {
            q.hp = 0; q.alive = false; q.deaths++; a.kills++;
            broadcast({ t: 'kill', k: a.name, v: q.name });
            send(q, { t: 'died' });
            setTimeout(() => {
                if (!q.open) return;
                const s = pickSpawn(q);
                Object.assign(q, { alive: true, hp: 100, x: s[0], z: s[1], y: 1.7, block: 0 });
                send(q, { t: 'respawn', x: s[0], z: s[1] });
            }, RESPAWN_MS);
        }
    }
    if (hit) send(a, { t: 'hitok' });
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
