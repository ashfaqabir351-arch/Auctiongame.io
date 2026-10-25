// AUCTION TYCOON - LAN auction game with host/join rooms. No npm install. Run: node server.js
// Tip: SPEED=2 node server.js  -> faster rounds
const http = require('http'), fs = require('fs'), path = require('path');
const crypto = require('crypto'), os = require('os');
const PORT = process.env.PORT || 3002, SPEED = +process.env.SPEED || 1, DT = 0.25 * SPEED, MAXP = 6;
const ITEMS = [['Vintage Guitar','🎸',400],['Antique Clock','🕰️',300],['Oil Painting','🖼️',700],['Royal Crown','👑',2000],
  ['Raw Diamond','💎',1500],['Samurai Sword','🗡️',900],['Old Bicycle','🚲',120],['Retro Radio','📻',150],['Ming Vase','🏺',1200],
  ['Rare Console','🎮',350],['Classic Camera','📷',250],['Stone Idol','🗿',800],['Teddy Bear','🧸',80],['Gold Coins','🪙',600],
  ['Luxury Watch','⌚',1000],['Violin','🎻',650],['Telescope','🔭',280],['T-Rex Fossil','🦖',1100],['Skateboard','🛹',90],
  ['Ancient Scroll','📜',500],['Disco Ball','🪩',110],['Sea Compass','🧭',200],['Pirate Map','🗺️',450],['Magic Lamp','🪔',1600]];
const BOTN = ['Ava','Max','Zed','Luna','Rex','Kiki'], AV = ['🦊','🐼','🐯','🐸','🦄','🐙','🐵','🦁','🐧','🐨'];
const clients = new Map(), rooms = new Map(); let nid = 0, bid0 = 1000, uid = 0;

const server = http.createServer((q, r) => {
  fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
    if (e) { r.writeHead(500); return r.end('index.html missing'); }
    r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(d);
  });
});
// ---- minimal WebSocket ----
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key']; if (!key) return sock.destroy();
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.buf = Buffer.alloc(0); sock.setNoDelay(true); sock.id = ++nid; sock.room = null; clients.set(sock.id, sock);
  sock.on('data', c => parse(sock, c)); sock.on('close', () => drop(sock)); sock.on('error', () => drop(sock));
  send(sock, { t: 'w', id: sock.id });
});
function frame(str) {
  const p = Buffer.from(str), n = p.length; let h;
  if (n < 126) h = Buffer.from([0x81, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}
function send(s, o) { if (s && !s.destroyed) s.write(frame(JSON.stringify(o))); }
function parse(sock, chunk) {
  sock.buf = Buffer.concat([sock.buf, chunk]);
  for (;;) {
    const b = sock.buf; if (b.length < 2) return;
    const op = b[0] & 15; let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const masked = b[1] & 128, ml = masked ? 4 : 0;
    if (b.length < off + ml + len) return;
    let pl = b.slice(off + ml, off + ml + len);
    if (masked) { const k = b.slice(off, off + 4); pl = Buffer.from(pl.map((v, i) => v ^ k[i & 3])); }
    sock.buf = b.slice(off + ml + len);
    if (op === 8) return sock.end();
    if (op === 1) { try { handle(sock, JSON.parse(pl.toString())); } catch (e) { console.error(e); } }
  }
}

// ---- rooms ----
const humans = R => [...R.players.values()].filter(p => !p.bot);
const credit = R => Math.round(R.cash * 0.3);
const mv = (R, it) => Math.round(it.val * R.m);
const worth = (R, p) => p.bankrupt ? 0 : p.cash + p.inv.reduce((a, i) => a + mv(R, i), 0);
const rar = b => b < 250 ? 'common' : b < 700 ? 'rare' : b < 1300 ? 'epic' : 'legendary';
const r10 = n => Math.max(10, Math.round(n / 10) * 10);
function bc(R, o, f) { const fr = frame(JSON.stringify(o)); for (const p of R.players.values()) { if (p.bot || (f && !f(p.id))) continue; const s = clients.get(p.id); if (s && !s.destroyed) s.write(fr); } }
const log = (R, text, k, only) => bc(R, { t: 'l', text, k }, only ? id => id === only : null);
function newCode() { const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let c; do { c = Array.from({ length: 4 }, () => L[Math.random() * L.length | 0]).join(''); } while (rooms.has(c)); return c; }
function mkRoom(s, name) {
  const R = { code: newCode(), hostId: s.id, hostName: name, players: new Map(), phase: 'lobby', round: 0, rounds: 10, cash: 1000, m: 1, item: null, cur: 0, hb: 0, tl: 0, rt: 0, res: null, sale: '' };
  rooms.set(R.code, R); return R;
}
function enter(s, R, name) {
  const used = new Set([...R.players.values()].map(p => p.av)), av = AV.find(a => !used.has(a)) || AV[s.id % AV.length];
  R.players.set(s.id, { id: s.id, name, av, cash: R.cash, inv: [], bankrupt: false, bot: false });
  s.room = R; send(s, { t: 'j', code: R.code }); log(R, name + ' joined', 'sys'); sendState(R);
}
function leave(s, why) {
  const R = s.room; if (!R) return; s.room = null; R.players.delete(s.id);
  if (why !== undefined) send(s, { t: 'left', text: why });
  const hs = humans(R);
  if (!hs.length) { rooms.delete(R.code); return; }
  if (R.hostId === s.id) { R.hostId = hs[0].id; R.hostName = hs[0].name; log(R, hs[0].name + ' is now the host', 'sys'); }
  if (R.phase === 'lobby') sendState(R);
}
function drop(s) { clients.delete(s.id); leave(s); }

// ---- game ----
function sendState(R) {
  const pl = [...R.players.values()].map(p => [p.id, p.name, p.av, p.cash, worth(R, p), p.inv.length, p.bankrupt ? 1 : 0, p.bot ? 1 : 0]);
  const show = R.phase === 'sold' || R.phase === 'over', I = R.item;
  const it = I && { n: I.n, e: I.e, r: I.r, lo: I.lo, hi: I.hi, start: I.start, val: show ? I.val : undefined, mv: show ? mv(R, I) : undefined };
  const w = R.hb && R.players.get(R.hb);
  for (const p of R.players.values()) {
    if (p.bot) continue;
    send(clients.get(p.id), { t: 's', ph: R.phase, round: R.round, rounds: R.rounds, m: Math.round(R.m * 100) / 100, tl: Math.max(0, Math.round(R.tl * 10) / 10),
      rt: Math.ceil(R.rt), item: it, cur: R.cur, hb: R.hb, hbn: w ? w.name : '', pl, credit: credit(R), sale: R.sale, res: R.res, me: p.id,
      code: R.code, host: R.hostId, cfg: { rounds: R.rounds, cash: R.cash },
      you: { cash: p.cash, bankrupt: p.bankrupt, inv: p.inv.map(i => ({ u: i.u, n: i.n, e: i.e, r: i.r, cost: i.cost, mv: mv(R, i) })) } });
  }
}
function addBot(R) {
  if (R.players.size >= MAXP) return; const id = ++bid0, used = [...R.players.values()].map(p => p.name);
  R.players.set(id, { id, name: 'Bot ' + (BOTN.find(n => !used.includes('Bot ' + n)) || id), av: ['🤖','👾','🦾','🧠','🎩','🕶️'][id % 6], cash: R.cash, inv: [], bankrupt: false, bot: true, aggr: 0.7 + Math.random() * 0.45 });
}
function resetPlayers(R) { for (const p of R.players.values()) { p.cash = R.cash; p.inv = []; p.bankrupt = false; } }
function startGame(R) {
  if (R.phase !== 'lobby' || R.players.size < 2) return;
  resetPlayers(R); R.round = 0; R.m = 1; R.res = null;
  log(R, 'Auction house is open! ' + R.rounds + ' rounds. Highest net worth wins.', 'sys'); nextRound(R); sendState(R);
}
function nextRound(R) {
  R.round++; const b = ITEMS[Math.random() * ITEMS.length | 0];
  const val = r10(b[2] * (0.5 + Math.random() * 1.1)), est = val * (0.85 + Math.random() * 0.3);
  R.item = { n: b[0], e: b[1], r: rar(b[2]), val, lo: r10(est * 0.75), hi: r10(est * 1.25), start: r10(b[2] * 0.2) };
  R.cur = 0; R.hb = 0; R.tl = 15; R.phase = 'auction'; R.sale = '';
  for (const p of R.players.values()) if (p.bot && !p.bankrupt) {
    p.max = r10(val * (0.75 + Math.random() * 0.5) * p.aggr);
    for (const it of [...p.inv]) if (mv(R, it) >= it.cost * 1.2 || (p.cash < 100 && Math.random() < 0.5)) sellItem(R, p, it);
  }
  log(R, 'Round ' + R.round + ': ' + R.item.e + ' ' + R.item.n + ' — opens at $' + R.item.start, 'sys'); bc(R, { t: 'fx', k: 'new' });
}
function sellItem(R, p, it) {
  const price = mv(R, it), d = price - it.cost; p.inv = p.inv.filter(x => x !== it); p.cash += price;
  log(R, p.av + ' ' + p.name + ' sold ' + it.e + ' ' + it.n + ' for $' + price + ' (' + (d >= 0 ? '+' : '') + d + ')', d >= 0 ? 'good' : 'bad');
  if (!p.bot) bc(R, { t: 'fx', k: 'cash' }, id => id === p.id);
}
function placeBid(R, p, a) { R.cur = a; R.hb = p.id; R.tl = Math.max(R.tl, 5); }
function resolve(R) {
  R.phase = 'sold'; R.rt = 4; const w = R.hb && R.players.get(R.hb), I = R.item;
  if (w && !w.bankrupt) {
    w.cash -= R.cur; w.inv.push({ ...I, u: ++uid, cost: R.cur });
    R.sale = w.name + ' won it for $' + R.cur + ' — worth $' + mv(R, I) + ' today';
    log(R, w.av + ' ' + w.name + ' won ' + I.e + ' ' + I.n + ' for $' + R.cur + ' (true value $' + I.val + ')', mv(R, I) >= R.cur ? 'good' : 'bad');
    bc(R, { t: 'fx', k: 'sold' });
  } else { R.sale = 'No bids — item withdrawn'; log(R, 'No bids. ' + I.n + ' withdrawn.', 'sys'); }
}
function endRound(R) {
  const act = [...R.players.values()].filter(p => !p.bankrupt);
  for (const p of act) {
    const fee = p.inv.reduce((a, i) => a + Math.round(i.cost * 0.04), 0), int = p.cash < 0 ? Math.ceil(-p.cash * 0.1) : 0;
    if (fee + int > 0) { p.cash -= fee + int; log(R, 'Fees paid: $' + fee + ' storage' + (int ? ' + $' + int + ' interest on debt' : ''), 'sys', p.id); }
  }
  const old = R.m; R.m = Math.min(1.4, Math.max(0.7, R.m * (0.85 + Math.random() * 0.3)));
  log(R, 'Market ' + (R.m >= old ? '📈' : '📉') + ' now ' + R.m.toFixed(2) + '×', 'sys');
  for (const p of act) {
    p.inv.sort((a, b) => mv(R, b) - mv(R, a));
    while (p.cash < 0 && p.inv.length) { const it = p.inv.shift(), pr = Math.round(mv(R, it) * 0.8); p.cash += pr; log(R, p.name + ' was forced to sell ' + it.e + ' ' + it.n + ' at 80% for $' + pr, 'bad'); }
    if (p.cash < 0) { p.bankrupt = true; p.inv = []; p.cash = 0; log(R, '💀 ' + p.name + ' went BANKRUPT!', 'bad'); bc(R, { t: 'fx', k: 'bust' }); }
  }
  const left = [...R.players.values()].filter(p => !p.bankrupt);
  if (R.round >= R.rounds || left.length <= 1 || !left.some(p => !p.bot)) finish(R); else nextRound(R);
}
function finish(R) {
  R.phase = 'over'; R.rt = 14;
  const rank = [...R.players.values()].sort((a, b) => (b.bankrupt ? -1e9 : worth(R, b)) - (a.bankrupt ? -1e9 : worth(R, a)));
  R.res = rank.map(p => [p.name, p.av, worth(R, p), p.bankrupt ? 1 : 0]);
  const w = rank.find(p => !p.bankrupt); log(R, w ? '🏆 ' + w.name + ' wins with $' + worth(R, w) + '!' : 'Everyone went bankrupt!', 'good'); bc(R, { t: 'fx', k: 'win' });
}

function handle(s, d) {
  const name = String(d.name || 'Player').replace(/[<>]/g, '').slice(0, 12) || 'Player';
  if (d.t === 'list') return send(s, { t: 'rooms', list: [...rooms.values()].filter(R => R.phase === 'lobby' && R.players.size < MAXP).map(R => ({ code: R.code, host: R.hostName, n: R.players.size, rounds: R.rounds })) });
  if (d.t === 'host' && !s.room) return enter(s, mkRoom(s, name), name);
  if (d.t === 'solo' && !s.room) { const R = mkRoom(s, name); enter(s, R, name); while (R.players.size < 4) addBot(R); return startGame(R); }
  if (d.t === 'join' && !s.room) {
    const R = rooms.get(String(d.code || '').toUpperCase());
    if (!R) return send(s, { t: 'err', text: 'No game found with that code.' });
    if (R.phase !== 'lobby') return send(s, { t: 'err', text: 'That game has already started.' });
    if (R.players.size >= MAXP) return send(s, { t: 'err', text: 'That room is full.' });
    return enter(s, R, name);
  }
  const R = s.room; if (!R) return; const p = R.players.get(s.id); if (!p) return;
  if (d.t === 'leave') return leave(s, '');
  if (R.phase === 'lobby') {
    if (s.id !== R.hostId) return; // host-only controls
    if (d.t === 'addbot') addBot(R);
    else if (d.t === 'rembot') { const b = [...R.players.values()].reverse().find(x => x.bot); if (b) R.players.delete(b.id); }
    else if (d.t === 'cfg') { if ([5, 10, 15].includes(d.rounds)) R.rounds = d.rounds; if ([500, 1000, 2000].includes(d.cash)) { R.cash = d.cash; resetPlayers(R); } }
    else if (d.t === 'kick') { const k = clients.get(d.id); if (k && k.room === R && k.id !== s.id) { leave(k, 'You were removed by the host.'); } return sendState(R); }
    else if (d.t === 'start') return startGame(R);
    return sendState(R);
  }
  if (d.t === 'bid' && R.phase === 'auction' && !p.bankrupt && R.hb !== p.id) {
    const a = Math.floor(+d.amt);
    if (a > R.cur && a >= R.item.start && a <= p.cash + credit(R)) { placeBid(R, p, a); sendState(R); }
  } else if (d.t === 'sell' && (R.phase === 'auction' || R.phase === 'sold') && !p.bankrupt) {
    const it = p.inv.find(i => i.u === d.u); if (it) { sellItem(R, p, it); sendState(R); }
  }
}
function step(R) {
  if (R.phase === 'auction') {
    R.tl -= DT;
    for (const p of R.players.values()) {
      if (!p.bot || p.bankrupt || R.hb === p.id || Math.random() > (R.tl < 3 ? 0.5 : 0.22)) continue;
      const nx = R.cur > 0 ? R.cur + r10(R.cur * 0.06) * (Math.random() < 0.3 ? 2 : 1) : R.item.start;
      if (nx <= p.max && nx <= p.cash + credit(R)) placeBid(R, p, nx);
    }
    if (R.tl <= 0) resolve(R);
  } else if (R.phase === 'sold') { R.rt -= DT; if (R.rt <= 0) endRound(R); }
  else if (R.phase === 'over') { R.rt -= DT; if (R.rt <= 0) { R.phase = 'lobby'; R.res = null; R.item = null; resetPlayers(R); } }
  else return;
  sendState(R);
}
setInterval(() => { for (const R of rooms.values()) step(R); }, 250);

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  AUCTION TYCOON is running!\n  HOST: open one of these, then click "HOST A GAME".\n  JOIN: friends on your Wi-Fi open the same address and pick your game from the list (or type the room code).\n');
  for (const l of Object.values(os.networkInterfaces()))
    for (const i of l) if (i.family === 'IPv4' && !i.internal) console.log('    http://' + i.address + ':' + PORT);
  console.log('    http://localhost:' + PORT + '  (this computer)\n');
});
