'use strict';
const dgram = require('dgram');
const os = require('os');
const GROUP = '224.0.0.251', PORT = 5353, HOST = 'remotepower.local';

function readName(msg, start) {
  const labels = [];
  const visited = new Set();
  let pos = start, end;
  for (let steps = 0; steps < 128; steps++) {
    if (pos >= msg.length || visited.has(pos)) throw new Error('Invalid DNS name');
    visited.add(pos);
    const n = msg[pos++];
    if ((n & 0xc0) === 0xc0) {
      if (pos >= msg.length) throw new Error('Truncated pointer');
      if (end === undefined) end = pos + 1;
      pos = ((n & 0x3f) << 8) | msg[pos];
      continue;
    }
    if (n & 0xc0) throw new Error('Unsupported label');
    if (n === 0) return { name: labels.join('.').toLowerCase(), end: end === undefined ? pos : end };
    if (pos + n > msg.length) throw new Error('Truncated label');
    labels.push(msg.toString('ascii', pos, pos + n));
    pos += n;
  }
  throw new Error('DNS name too long');
}
function encodeName(name) {
  return Buffer.concat([...name.split('.').map(s => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)])), Buffer.from([0])]);
}
function response(address, ttl = 30, id = 0, question = null) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(question ? 1 : 0, 4);
  header.writeUInt16BE(1, 6);
  const record = Buffer.alloc(14);
  record.writeUInt16BE(1, 0);
  record.writeUInt16BE(question ? 1 : 0x8001, 2);
  record.writeUInt32BE(ttl, 4);
  record.writeUInt16BE(4, 8);
  record.set(address.split('.').map(Number), 10);
  return Buffer.concat([header, ...(question ? [question] : []), encodeName(HOST), record]);
}
function addresses() {
  const result = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if ((item.family === 'IPv4' || item.family === 4) && !item.internal && !item.address.startsWith('169.254.')) result.add(item.address);
    }
  }
  return result;
}
function startMdns() {
  const sockets = new Map();
  let stopped = false;
  function close(entry) {
    try { entry.socket.close(); } catch {}
  }
  function send(entry, packet, port = PORT, target = GROUP) {
    if (!entry.ready) return;
    try { entry.socket.send(packet, port, target, err => {
      if (err) console.error('mDNS send:', err.message);
    }); } catch (err) { console.error('mDNS send:', err.message); }
  }
  function open(address) {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const entry = { socket, ready: false };
    sockets.set(address, entry);
    socket.on('error', err => {
      console.error(`mDNS ${address}: ${err.message}`);
      if (sockets.get(address) === entry) sockets.delete(address);
      close(entry);
    });
    socket.on('message', (msg, peer) => {
      try {
        if (msg.length < 12 || msg.length > 9000 || (msg.readUInt16BE(2) & 0xf800)) return;
        const count = msg.readUInt16BE(4);
        if (!count || count > 64) return;
        let pos = 12;
        for (let i = 0; i < count; i++) {
          const start = pos, q = readName(msg, pos);
          pos = q.end;
          if (pos + 4 > msg.length) return;
          const type = msg.readUInt16BE(pos), cls = msg.readUInt16BE(pos + 2);
          pos += 4;
          if (q.name !== HOST || (type !== 1 && type !== 255) || (cls & 0x7fff) !== 1) continue;
          if (peer.port !== PORT) {
            const tail = Buffer.alloc(4); tail.writeUInt16BE(type, 0); tail.writeUInt16BE(1, 2);
            const question = Buffer.concat([encodeName(HOST), tail]);
            send(entry, response(address, 10, msg.readUInt16BE(0), question), peer.port, peer.address);
          } else if (cls & 0x8000) {
            send(entry, response(address), PORT, peer.address);
          } else {
            send(entry, response(address));
          }
          break;
        }
      } catch { /* Ignore malformed or unsupported queries. */ }
    });
    socket.bind(PORT, () => {
      if (stopped || sockets.get(address) !== entry) return;
      try {
        socket.setMulticastInterface(address);
        socket.setMulticastTTL(255);
        socket.addMembership(GROUP, address);
        entry.ready = true;
        send(entry, response(address));
      } catch (err) {
        console.error(`mDNS membership ${address}: ${err.message}`);
        sockets.delete(address); close(entry);
      }
    });
  }
  function refresh() {
    if (stopped) return;
    const current = addresses();
    for (const [address, entry] of sockets) {
      if (!current.has(address)) { sockets.delete(address); close(entry); }
    }
    for (const address of current) if (!sockets.has(address)) open(address);
  }
  refresh();
  const watcher = setInterval(refresh, 5000); watcher.unref();
  // Renew memberships even when a reconnect retains the same DHCP address.
  const renewal = setInterval(() => {
    for (const entry of sockets.values()) close(entry);
    sockets.clear(); refresh();
  }, 30000); renewal.unref();
  return function stop() {
    stopped = true; clearInterval(watcher); clearInterval(renewal);
    for (const [address, entry] of sockets) { send(entry, response(address, 0)); close(entry); }
    sockets.clear();
  };
}
module.exports = { startMdns };
