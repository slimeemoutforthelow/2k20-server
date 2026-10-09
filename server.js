'use strict';
/**
 * Nostalgia 2K19 Community Server
 *
 * Endpoints the connection-bridge.js client expects:
 *
 *  POST /_nostalgia/community/join
 *  GET  /health
 *  WS   /nba/2k19/park/connect
 *  POST /nba/2k19/community/locker-code/redeem
 *  GET  /nba/2k19/community/steam/link/status
 *  POST /nba/2k19/community/steam/link/start
 *  POST /nba/2k19/community/steam/link/confirm
 *  POST /nba/2k19/community/steam/link/unlink
 *  GET  /nba/2k19/community/steam/friends/snapshot
 *
 * Run:  node src/server.js
 * Env:  PORT               (default 3000)
 *       NOSTALGIA_JOIN_KEY (43-char base64url — must match community-invite.json joinKey)
 */

const http    = require('node:http');
const { WebSocketServer } = require('ws');
const express = require('express');
const db      = require('./db');

const PORT  = parseInt(process.env.PORT || '3000', 10);
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

// ── Helpers ───────────────────────────────────────────────────────────────────
function getMemberKey(req) {
  const k = req.headers['x-nostalgia-member-key'];
  return typeof k === 'string' && KEY_RE.test(k) ? k : null;
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));

// ── 1. Enroll / join ──────────────────────────────────────────────────────────
// Called by connection-bridge.js --community-enroll
//   POST /_nostalgia/community/join
//   Header: x-nostalgia-community-join: <joinKey>
//   Body:   { memberKey }
app.post('/_nostalgia/community/join', (req, res) => {
  const joinKey = req.headers['x-nostalgia-community-join'];
  const { memberKey: mk } = req.body || {};
  if (typeof joinKey !== 'string' || !KEY_RE.test(mk)) {
    return res.status(400).json({ error: 'request-invalid' });
  }
  const result = db.enroll(mk, joinKey);
  if (!result.ok) {
    if (result.status === 403) return res.status(403).json({ error: 'join-rejected' });
    if (result.status === 409) return res.status(409).json({ error: 'community-full' });
    return res.status(500).json({ error: 'server-error' });
  }
  res.status(200).json({ enrollmentVersion: 1, enrolled: true });
});

// ── 2. Health ─────────────────────────────────────────────────────────────────
// The bridge polls this every 10 s. Returns identity + server capability flags.
app.get('/health', (req, res) => {
  const mk = getMemberKey(req);
  if (!mk) return res.status(403).json({ error: 'credentials-missing' });

  const session = db.getSession(mk);
  if (!session) return res.status(403).json({ error: 'invite-rejected' });

  res.status(200).json({
    service:                     'nostalgia-2k19-protocol-gateway',
    protocolRevision:            '2k19-community-private-v10',
    // Identity
    memberIdentityVersion:       1,
    nativeDisplayNameVersion:    1,
    memberId:                    session.memberId,
    memberCode:                  session.memberCode,
    displayName:                 session.displayName,
    steamPersonaName:            session.steamPersonaName,
    steamNameState:              session.steamNameState,
    nativeUserIdHex:             session.nativeUserIdHex,
    // Native identity
    nativeIdentityVersion:       2,
    // Version gates the bridge checks
    careerUpgradeVersion:        4,
    nativeMatchTransportVersion: 2,
    nativeReplayVersion:         1,
    nativeUserdataSizeVersion:   1,
    // Steam feature gate
    steamLinkVersion:            1,
    // Park / login state
    parkJoinState:               session.parkJoinState,
    parkJoinError:               null,
    nativeLoginState:            session.nativeLoginState,
    nativeLoginError:            session.nativeLoginError,
    careerUpgradeState:          session.careerUpgradeState,
    careerUpgradeError:          session.careerUpgradeError,
    // Relay flags
    gameplayRelayReady:          true,
    protocolReady:               true,
  });
});

// ── 3. Locker code redeem ─────────────────────────────────────────────────────
app.post('/nba/2k19/community/locker-code/redeem', (req, res) => {
  const mk = getMemberKey(req);
  if (!mk) return res.status(403).json({ error: 'not-authenticated' });
  const { code } = req.body || {};
  const result = db.redeemLockerCode(mk, code);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.status(200).json({ ok: true, vc: result.vc });
});

// ── 4. Steam link status ──────────────────────────────────────────────────────
app.get('/nba/2k19/community/steam/link/status', (req, res) => {
  const mk = getMemberKey(req);
  if (!mk) return res.status(403).json({ error: 'not-authenticated' });
  const session = db.getSession(mk);
  if (!session) return res.status(403).json({ error: 'invite-rejected' });
  res.status(200).json({
    steamLinkVersion: 1,
    steamNameState:   session.steamNameState,
    steamPersonaName: session.steamPersonaName,
  });
});

// ── 5. Steam link start ───────────────────────────────────────────────────────
app.post('/nba/2k19/community/steam/link/start', (req, res) => {
  const mk = getMemberKey(req);
  if (!mk) return res.status(403).json({ error: 'not-authenticated' });
  // Stub — return unavailable so the client shows "not linked" cleanly
  res.status(200).json({ steamLinkVersion: 1, loginUrl: null, status: 'unavailable' });
});

// ── 6. Steam link confirm ─────────────────────────────────────────────────────
app.post('/nba/2k19/community/steam/link/confirm', (req, res) => {
  const mk = getMemberKey(req);
  if (!mk) return res.status(403).json({ error: 'not-authenticated' });
  const { steamId, personaName } = req.body || {};
  if (!steamId || !personaName) return res.status(400).json({ error: 'request-invalid' });
  db.linkSteam(mk, steamId, personaName);
  res.status(200).json({ ok: true });
});

// ── 7. Steam link unlink ──────────────────────────────────────────────────────
app.post('/nba/2k19/community/steam/link/unlink', (req, res) => {
  const mk = getMemberKey(req);
  if (!mk) return res.status(403).json({ error: 'not-authenticated' });
  db.unlinkSteam(mk);
  res.status(200).json({ ok: true });
});

// ── 8. Steam friends snapshot ─────────────────────────────────────────────────
app.get('/nba/2k19/community/steam/friends/snapshot', (req, res) => {
  const mk = getMemberKey(req);
  if (!mk) return res.status(403).json({ error: 'not-authenticated' });
  res.status(200).json({
    snapshotVersion: 1,
    status:          'ready',
    complete:        true,
    selfSteamId:     '0',
    friends:         [],
    communityFriends: [],
  });
});

// ── 9. Catch-all for /nba/2k19/ ──────────────────────────────────────────────
app.all('/nba/2k19/*', (_req, res) => {
  res.status(404).json({ error: 'route-not-supported' });
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(app);

// WebSocket: /nba/2k19/park/connect — Park multiplayer relay
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.toLowerCase() !== '/nba/2k19/park/connect') {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const mk = req.headers['x-nostalgia-member-key'] || '';
  if (!KEY_RE.test(mk) || !db.getSession(mk)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

// Simple broadcast relay — every Park client hears everyone else
const parkClients = new Set();
wss.on('connection', (ws, req) => {
  const mk = req.headers['x-nostalgia-member-key'];
  parkClients.add(ws);
  console.log(`[park] +connected  ...${mk.slice(-6)}  total=${parkClients.size}`);
  ws.on('message', data => {
    for (const c of parkClients) if (c !== ws && c.readyState === 1) c.send(data);
  });
  const leave = () => {
    parkClients.delete(ws);
    console.log(`[park] -disconnected ...${mk.slice(-6)}  total=${parkClients.size}`);
  };
  ws.on('close', leave);
  ws.on('error', leave);
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('  Nostalgia 2K19 Community Server');
  console.log('  ────────────────────────────────────────');
  console.log(`  Port          : ${PORT}`);
  console.log(`  Health check  : http://localhost:${PORT}/health`);
  console.log(`  Join key      : ${db.JOIN_KEY}`);
  console.log('');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`[!] Port ${PORT} already in use.`);
  else console.error('[!] Server error:', err.message);
  process.exit(1);
});
