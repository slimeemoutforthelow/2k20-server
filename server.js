'use strict';
/**
 * NBA 2K20 Private Server
 * Works with Covid20Redirect.dll — handles raw TCP on port 45323,
 * legacy login on 30217, virtual channel on 20055,
 * and HTTP/HTTPS spoof for 2K dead auth servers.
 */

const net     = require('net');
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const cors    = require('cors');

const CERT_PATH = path.join(__dirname, 'cert.pem');
const KEY_PATH  = path.join(__dirname, 'cert.key');

// ── TLS cert (for HTTPS spoof) ────────────────────────────────────────────────
let tlsOptions = null;
try {
  tlsOptions = { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) };
  console.log('  TLS cert loaded.');
} catch {
  console.log('  [!] No TLS cert found — run gen-cert.sh to generate one.');
}

// ── Connected players ─────────────────────────────────────────────────────────
const players = new Map(); // socketId -> { socket, addr, connectedAt }
let nextId = 1;

function log(msg) { console.log(`[${new Date().toTimeString().slice(0,8)}] ${msg}`); }

// ── 2K20 TCP game server (port 45323) ─────────────────────────────────────────
// Covid20Redirect.dll opens a raw TCP connection here.
// The DLL handles all the game-level framing — we just need to accept
// the connection and keep it alive. Respond with an OK handshake.
const HANDSHAKE = Buffer.from([
  0x01, 0x00, 0x00, 0x00,  // magic / version
  0x00, 0x00, 0x00, 0x00,  // result = 0 (OK)
  0x01, 0x00, 0x00, 0x00,  // online = 1
  0x00, 0x00, 0x00, 0x00,  // padding
]);

const gameServer = net.createServer(socket => {
  const id   = nextId++;
  const addr = `${socket.remoteAddress}:${socket.remotePort}`;
  players.set(id, { socket, addr, connectedAt: Date.now() });
  log(`[GAME] player ${id} connected from ${addr}  (${players.size} online)`);

  // Send handshake so the DLL knows the server accepted
  socket.write(HANDSHAKE);

  socket.on('data', data => {
    // Echo a minimal OK response — Covid20 DLL does the real framing
    // Just keep the pipe alive and ACK with zeros
    const ack = Buffer.alloc(data.length, 0);
    try { socket.write(ack); } catch {}
  });

  socket.on('close', () => {
    players.delete(id);
    log(`[GAME] player ${id} disconnected  (${players.size} online)`);
  });

  socket.on('error', () => {
    players.delete(id);
  });

  // Keepalive so the connection doesn't drop
  socket.setKeepAlive(true, 10000);
  socket.setTimeout(0);
});

gameServer.listen(45323, '0.0.0.0', () => {
  log('[GAME] TCP game server listening on 0.0.0.0:45323');
});
gameServer.on('error', e => log(`[GAME] error: ${e.message}`));

// ── Legacy login server (port 30217) ─────────────────────────────────────────
// Covid20 console shows: "legacy login 21217 -> 30217"
// The DLL redirects 2K's login port 21217 to our 30217.
const loginServer = net.createServer(socket => {
  const addr = `${socket.remoteAddress}:${socket.remotePort}`;
  log(`[LOGIN] connection from ${addr}`);
  socket.write(HANDSHAKE);
  socket.on('data', data => {
    try { socket.write(Buffer.alloc(data.length, 0)); } catch {}
  });
  socket.on('error', () => {});
  socket.setKeepAlive(true, 10000);
});

loginServer.listen(30217, '0.0.0.0', () => {
  log('[LOGIN] TCP login server listening on 0.0.0.0:30217');
});
loginServer.on('error', e => log(`[LOGIN] error: ${e.message}`));

// ── Virtual channel server (port 20055) ───────────────────────────────────────
const vcServer = net.createServer(socket => {
  const addr = `${socket.remoteAddress}:${socket.remotePort}`;
  log(`[VC] connection from ${addr}`);
  socket.write(HANDSHAKE);
  socket.on('data', data => {
    try { socket.write(Buffer.alloc(data.length, 0)); } catch {}
  });
  socket.on('error', () => {});
  socket.setKeepAlive(true, 10000);
});

vcServer.listen(20055, '0.0.0.0', () => {
  log('[VC] Virtual channel server listening on 0.0.0.0:20055');
});
vcServer.on('error', e => log(`[VC] error: ${e.message}`));

// ── HTTP/HTTPS spoof app (dead 2K auth servers) ───────────────────────────────
const OK = (extra = {}) => ({
  status: 'success', code: 200, online: true,
  authenticated: true, valid: true,
  token: 'PRIVATE_TOKEN', access_token: 'PRIVATE_TOKEN',
  session_id: 'PRIVATE_SESSION',
  user_id: 'private_user', display_name: 'Player',
  vc_balance: 999999999, balance: 999999999,
  allowed: true, validated: true,
  expires_in: 86400, maintenance: false,
  features: {}, config: {}, friends: [],
  ...extra,
});

const spoof = express();
spoof.use(cors());
spoof.use(express.json());
spoof.use(express.raw({ type: '*/*', limit: '10mb' }));

spoof.use((req, _res, next) => {
  log(`[SPOOF] ${req.method} ${req.hostname}${req.path}`);
  next();
});

// Steam ticket auth (fixes error 2fd7b735)
spoof.all('*steamticket*', (_req, res) => res.json(OK()));
spoof.all('*steam/auth*',  (_req, res) => res.json(OK()));

// Auth / login / session
spoof.all('*auth*',    (_req, res) => res.json(OK()));
spoof.all('*login*',   (_req, res) => res.json(OK()));
spoof.all('*session*', (_req, res) => res.json(OK()));

// Config / liveconfig
spoof.all('*config*',  (_req, res) => res.json(OK({ patches: [], version: '1.0' })));

// VC / store / entitlements
spoof.all('*VCReport*',    (_req, res) => res.json(OK({ transactions: [] })));
spoof.all('*vc*',          (_req, res) => res.json(OK({ items: [] })));
spoof.all('*store*',       (_req, res) => res.json(OK({ products: [] })));
spoof.all('*entitlement*', (_req, res) => res.json(OK({ entitlements: [] })));

// Telemetry / analytics (silent discard)
spoof.all('*telemetry*',  (_req, res) => res.json(OK()));
spoof.all('*analytics*',  (_req, res) => res.json(OK()));

// Matchmaking / presence / leaderboard
spoof.all('*matchmaking*',  (_req, res) => res.json(OK({ available: true })));
spoof.all('*presence*',     (_req, res) => res.json(OK()));
spoof.all('*leaderboard*',  (_req, res) => res.json(OK({ entries: [] })));

// Status / health
spoof.get('/status', (_req, res) => res.json({
  online: true, players: players.size, server: '2K20-private',
}));

// Catch-all
spoof.all('*', (_req, res) => res.json(OK()));

// ── Bind HTTP on port 80 ───────────────────────────────────────────────────────
http.createServer(spoof).listen(80, '0.0.0.0', () => {
  log('[HTTP] Spoof listening on 0.0.0.0:80');
}).on('error', e => log(`[HTTP:80] error: ${e.message}`));

// ── Bind HTTPS on port 443 ────────────────────────────────────────────────────
if (tlsOptions) {
  https.createServer(tlsOptions, spoof).listen(443, '0.0.0.0', () => {
    log('[HTTPS] Spoof listening on 0.0.0.0:443');
  }).on('error', e => log(`[HTTPS:443] error: ${e.message}`));
}

// ── API on port 3000 (launcher status check) ──────────────────────────────────
http.createServer(spoof).listen(3000, '0.0.0.0', () => {
  log('[API] Status API listening on 0.0.0.0:3000');
}).on('error', e => log(`[API:3000] error: ${e.message}`));

// ── VCReport on port 26135 (HTTPS) ────────────────────────────────────────────
if (tlsOptions) {
  https.createServer(tlsOptions, spoof).listen(26135, '0.0.0.0', () => {
    log('[VCREPORT] Listening on 0.0.0.0:26135');
  }).on('error', e => log(`[VCREPORT:26135] error: ${e.message}`));
}

log('');
log('  NBA 2K20 Private Server ready.');
log(`  Players online: ${players.size}`);
log('');

process.on('uncaughtException', e => {
  log(`[ERROR] ${e.message}`);
  console.error(e.stack);
});
