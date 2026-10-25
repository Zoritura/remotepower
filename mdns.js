'use strict';

const dgram = require('dgram');
const os = require('os');

const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const HOSTNAME = 'remotepower.local';

function getLanIp() {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const iface of interfaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function encodeName(name) {
  const parts = name.split('.');
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from([part.length]));
    chunks.push(Buffer.from(part, 'ascii'));
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function readName(msg, offset) {
  const labels = [];
  let pos = offset;

  while (true) {
    const length = msg[pos++];

    if (length === 0) break;
    if ((length & 0xc0) === 0xc0) {
      pos += 1;
      break;
    }

    labels.push(msg.toString('ascii', pos, pos + length));
    pos += length;
  }

  return { name: labels.join('.').toLowerCase(), end: pos };
}

function buildResponse(ip) {
  const name = encodeName(HOSTNAME);
  const answer = Buffer.alloc(16);
  const ipParts = ip.split('.').map(Number);

  answer.writeUInt16BE(1, 0);
  answer.writeUInt16BE(1, 2);
  answer.writeUInt32BE(120, 4);
  answer.writeUInt16BE(4, 8);
  answer.set(ipParts, 10);

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(1, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  return Buffer.concat([header, name, answer]);
}

function startMdns() {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (err) => {
    console.error('mDNS error:', err.message);
  });

  socket.on('message', (msg, rinfo) => {
    try {
      if (msg.length < 12) return;

      const questionCount = msg.readUInt16BE(4);
      if (questionCount < 1) return;

      const question = readName(msg, 12);
      if (question.name !== HOSTNAME) return;

      const response = buildResponse(getLanIp());
      socket.send(response, MDNS_PORT, MDNS_GROUP);
    } catch {
      // Ignore malformed multicast packets.
    }
  });

  socket.bind(MDNS_PORT, () => {
    socket.addMembership(MDNS_GROUP);
    console.log(`mDNS advertising ${HOSTNAME} -> ${getLanIp()}`);
  });
}

module.exports = { startMdns };
