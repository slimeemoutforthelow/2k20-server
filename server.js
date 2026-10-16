// 2K20 Private Server — Node.js backend
//
// Real domains/ports confirmed in NBA2K20.exe binary:
//   nba2k20-ws.2ksports.com:20217  /Session  — main WebSocket session + dynamic API map
//   www.2ksports.com:443            —          general HTTPS
//   SMTP-na.take2games.com:25/587   —          mail relay (intercepted by DLL, never reaches here)
//
// Ports this server listens on:
//   HTTP_PORT  (env PORT, default 1 locally / assigned by Render)
//              HTTP + HTTPS on one TCP socket — first-byte TLS sniff (0x16 = TLS)
//              DLL maps game ports 80, 443, 8000, 8080, 20217 → this port
//   8009       Raw TCP — Demonware binary backend stub
//
// The /Session WebSocket handshake is the critical path:
//   1. Game connects to nba2k20-ws.2ksports.com:20217  (DLL redirects here)
//   2. Sends HTTP Upgrade: websocket  to /Session
//   3. We complete the WS handshake and send an init frame with the API endpoint map
//   4. Game then hits those API paths over plain HTTPS
//
// Run locally (requires admin for port 1 on Windows):
//   node server.js
//
// On Render.com:
//   No admin needed — Render assigns PORT automatically.
//   DLL config: host=<your-render-service>.onrender.com  port=443
//   (Render terminates TLS at its edge; server sees plain HTTP on process.env.PORT)
//
// Self-signed cert (local only — not needed on Render):
//   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 9999 -nodes -subj "/CN=2k20-private"

"use strict";

const http   = require("http");
const https  = require("https");
const net    = require("net");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const HTTP_PORT  = parseInt(process.env.PORT || "1", 10);
const TCP_PORT   = 8009;
const LOG_FILE   = path.join(__dirname, "requests.log");
const PLAYER_CFG = path.join(__dirname, "player.cfg");

// On Render the service is behind a TLS-terminating proxy — no cert files needed.
const IS_RENDER  = !!process.env.RENDER;

// ---------------------------------------------------------------------------
// Player config  (written by the launcher when the user sets their username)
// ---------------------------------------------------------------------------
function getUsername() {
  try {
    if (fs.existsSync(PLAYER_CFG))
      return fs.readFileSync(PLAYER_CFG, "utf8").trim() || "Player1";
  } catch {}
  return "Player1";
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + "\n");
}

// ---------------------------------------------------------------------------
// Session state  (single-player private server — one active session at a time)
// ---------------------------------------------------------------------------
const SESSION = {
  userId:     1,
  username:   "Player1",
  sessionKey: crypto.randomBytes(16).toString("hex"),
  expiry:     9999999999,
};

// Refresh session username from player.cfg each time a /Session handshake fires
function refreshSession() {
  SESSION.username   = getUsername();
  SESSION.sessionKey = crypto.randomBytes(16).toString("hex");
  return SESSION;
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

// RFC 6455 handshake accept-key calculation
function wsAcceptKey(clientKey) {
  return crypto
    .createHash("sha1")
    .update(clientKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
}

// Encode a WebSocket text frame (no masking — server→client never masks)
function wsFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len     = payload.length;
  let header;
  if (len <= 125) {
    header = Buffer.alloc(2);
    header[0] = 0x81;   // FIN + text opcode
    header[1] = len;
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Decode one or more WebSocket frames from a buffer.
// Returns array of { opcode, payload } objects and the number of bytes consumed.
function wsDecodeFrames(buf) {
  const frames  = [];
  let   offset  = 0;

  while (offset + 2 <= buf.length) {
    const b0     = buf[offset];
    const b1     = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = !!(b1 & 0x80);
    let   plen   = b1 & 0x7f;
    let   hlen   = 2;

    if (plen === 126) {
      if (offset + 4 > buf.length) break;
      plen = buf.readUInt16BE(offset + 2);
      hlen = 4;
    } else if (plen === 127) {
      if (offset + 10 > buf.length) break;
      plen = Number(buf.readBigUInt64BE(offset + 2));
      hlen = 10;
    }

    if (masked) hlen += 4;
    if (offset + hlen + plen > buf.length) break;

    let payload;
    if (masked) {
      const mask = buf.slice(offset + hlen - 4, offset + hlen);
      payload    = Buffer.allocUnsafe(plen);
      for (let i = 0; i < plen; i++)
        payload[i] = buf[offset + hlen + i] ^ mask[i % 4];
    } else {
      payload = buf.slice(offset + hlen, offset + hlen + plen);
    }

    frames.push({ opcode, payload });
    offset += hlen + plen;
  }

  return { frames, consumed: offset };
}

// ---------------------------------------------------------------------------
// /Session WebSocket handler
//
// Called when the HTTP layer detects "Upgrade: websocket" on /Session.
// We complete the RFC 6455 handshake over the raw socket, then send an
// init JSON frame that gives the game its full endpoint map.
// ---------------------------------------------------------------------------
function handleSessionUpgrade(req, socket, head) {
  const s = refreshSession();
  log(`[WS /Session] upgrade from ${socket.remoteAddress}`);

  const clientKey = req.headers["sec-websocket-key"];
  if (!clientKey) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  // Complete the handshake
  const acceptKey = wsAcceptKey(clientKey);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    "\r\n"
  );

  // Send the session init frame — this is what the game reads to get its API map.
  // All subsequent API calls go to paths listed in "endpoints" below.
  const initMsg = JSON.stringify({
    type:       "SESSION_INIT",
    result:     "SUCCESS",
    userId:     s.userId,
    username:   s.username,
    sessionKey: s.sessionKey,
    expiry:     s.expiry,
    env:        "prod",
    // Dynamic endpoint map — game uses these for all subsequent HTTPS calls.
    // These are the real path patterns confirmed in the binary.
    endpoints: {
      auth:         "/api/v1/auth",
      profile:      "/api/v1/profile",
      inventory:    "/api/v1/inventory",
      store:        "/store/",
      featureFlags: "/featureflags",
      config:       "/api/v1/config",
      cleanProfile: "/CLEAN_PROFILE/",
      leaderboard:  "/api/v1/leaderboard",
      stats:        "/api/v1/stats",
    },
    features: {
      mycareer:     true,
      myteam:       true,
      park:         true,
      proam:        true,
      neighborhood: true,
      onlineplay:   true,
      myplayer:     true,
    },
    maintenance: false,
  });

  socket.write(wsFrame(initMsg));
  log(`[WS /Session] sent SESSION_INIT for user "${s.username}" (key ${s.sessionKey.slice(0, 8)}…)`);

  // Handle incoming frames (heartbeat pings, etc.)
  let wsBuf = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);

  socket.on("data", (chunk) => {
    wsBuf = Buffer.concat([wsBuf, chunk]);
    const { frames, consumed } = wsDecodeFrames(wsBuf);
    wsBuf = wsBuf.slice(consumed);

    for (const frame of frames) {
      if (frame.opcode === 0x9) {
        // Ping → send Pong
        const pong = Buffer.alloc(2);
        pong[0] = 0x8a;  pong[1] = 0;
        socket.write(pong);
      } else if (frame.opcode === 0x8) {
        // Close
        const close = Buffer.alloc(2);
        close[0] = 0x88;  close[1] = 0;
        socket.write(close);
        socket.end();
      } else if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        // Text/binary message from game
        const text = frame.payload.toString("utf8");
        log(`[WS /Session] recv: ${text.slice(0, 200)}`);
        // Echo back an OK
        socket.write(wsFrame(JSON.stringify({ type: "ACK", result: "OK" })));
      }
    }
  });

  socket.on("error", e => log(`[WS /Session] error: ${e.message}`));
  socket.on("end",   ()  => log(`[WS /Session] closed`));
}

// ---------------------------------------------------------------------------
// HTTP request handler — collects full body then routes
// ---------------------------------------------------------------------------
function handleRequest(req, res) {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const body   = Buffer.concat(chunks);
    const url    = req.url;
    const method = req.method.toUpperCase();
    const host   = req.headers.host || "";
    const proto  = req.socket.encrypted ? "https" : "http";

    log(`${method} ${proto}://${host}${url}`);
    if (body.length > 0) {
      const hex  = body.slice(0, 128).toString("hex").replace(/(.{32})/g, "$1 ").trimEnd();
      const text = body.toString("utf8").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ".").slice(0, 300);
      log(`  BODY ${body.length}b hex: ${hex}`);
      log(`  BODY utf8: ${text}`);
    }

    route(res, url, method, body);
  });
}

function route(res, url, method, body) {
  const json = (code, obj) => {
    const payload = JSON.stringify(obj);
    log(`  -> ${code} ${payload.slice(0, 300)}`);
    res.writeHead(code, {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "Access-Control-Allow-Origin": "*",
    });
    res.end(payload);
  };

  // CORS pre-flight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Auth-Token",
    });
    return res.end();
  }

  const u = url.toLowerCase().replace(/\?.*$/, "");  // path only, lower-case

  // -------------------------------------------------------------------------
  // /Session  — game may hit this over plain HTTP too if DLL redirects port 20217
  // The WS upgrade case is handled by the "upgrade" event; this handles any
  // non-upgrade GET to the same path (e.g. health checks from the game).
  // -------------------------------------------------------------------------
  if (u === "/session" || u.startsWith("/session/")) {
    const s = SESSION;
    return json(200, {
      type:       "SESSION_INIT",
      result:     "SUCCESS",
      userId:     s.userId,
      username:   s.username,
      sessionKey: s.sessionKey,
      expiry:     s.expiry,
      env:        "prod",
      endpoints: {
        auth:         "/api/v1/auth",
        profile:      "/api/v1/profile",
        inventory:    "/api/v1/inventory",
        store:        "/store/",
        featureFlags: "/featureflags",
        config:       "/api/v1/config",
        cleanProfile: "/CLEAN_PROFILE/",
        leaderboard:  "/api/v1/leaderboard",
        stats:        "/api/v1/stats",
      },
      features: {
        mycareer: true, myteam: true, park: true,
        proam: true, neighborhood: true, onlineplay: true, myplayer: true,
      },
      maintenance: false,
    });
  }

  // -------------------------------------------------------------------------
  // /CLEAN_PROFILE/  — confirmed path in binary; used for profile wipe/reset
  // -------------------------------------------------------------------------
  if (u === "/clean_profile" || u.startsWith("/clean_profile/")) {
    const name = getUsername();
    log(`  [CLEAN_PROFILE] returning clean profile for "${name}"`);
    return json(200, {
      result:   "SUCCESS",
      userId:   1,
      username: name,
      profile: {
        overall:      99,
        position:     "PG",
        height:       "6'3\"",
        weight:       190,
        badges:       [],
        attributes:   {},
        appearance:   {},
      },
    });
  }

  // -------------------------------------------------------------------------
  // /store/  — confirmed path in binary; return empty catalog (no real purchases)
  // -------------------------------------------------------------------------
  if (u === "/store" || u.startsWith("/store/")) {
    return json(200, {
      result:   "OK",
      catalog:  [],
      bundles:  [],
      featured: [],
      vc_price: {},
    });
  }

  // -------------------------------------------------------------------------
  // Exact / prefix routes (most specific first)
  // -------------------------------------------------------------------------

  // Steam ticket auth
  if (u.startsWith("/api/steam") || u.startsWith("/steam/auth") ||
      u.startsWith("/steam/login") || u.startsWith("/api/v1/steam")) {
    const name = getUsername();
    return json(200, {
      result:        "SUCCESS",
      userId:        1,
      username:      name,
      steamId:       "76561198000000001",
      sessionKey:    SESSION.sessionKey,
      ticket:        "dw_user_ticket_private",
      authenticated: true,
      banned:        false,
      expiry:        9999999999,
      env:           "prod",
    });
  }

  // Generic /steam/* catch-all
  if (u.startsWith("/steam/")) {
    const name = getUsername();
    return json(200, {
      result:   "OK",
      steamId:  "76561198000000001",
      username: name,
      data:     {},
    });
  }

  // POST /api/v1/auth
  if (u === "/api/v1/auth" || u.startsWith("/api/v1/auth/")) {
    const name = getUsername();
    return json(200, {
      result:     "SUCCESS",
      userId:     1,
      username:   name,
      sessionKey: SESSION.sessionKey,
      env:        "prod",
    });
  }

  // GET /api/v1/profile
  if (u === "/api/v1/profile" || u.startsWith("/api/v1/profile/")) {
    const name = getUsername();
    return json(200, {
      userId:   1,
      username: name,
      level:    99,
      vc:       999999,
      myPlayer: { overall: 99, position: "PG", name },
    });
  }

  // GET /api/v1/inventory
  if (u === "/api/v1/inventory" || u.startsWith("/api/v1/inventory/")) {
    return json(200, { vc: 999999, myteam_pts: 999999, items: [] });
  }

  // GET /api/v1/config
  if (u === "/api/v1/config" || u.startsWith("/api/v1/config/")) {
    return json(200, {
      features: {
        mycareer: true, myteam: true, park: true,
        proam: true, neighborhood: true, onlineplay: true,
      },
      env: "prod",
    });
  }

  // GET /api/v1/leaderboard
  if (u === "/api/v1/leaderboard" || u.startsWith("/api/v1/leaderboard/")) {
    return json(200, { entries: [], total: 0 });
  }

  // GET /api/v1/stats
  if (u === "/api/v1/stats" || u.startsWith("/api/v1/stats/")) {
    return json(200, { stats: {}, history: [] });
  }

  // Generic /api/* catch-all
  if (u.startsWith("/api/")) {
    const name = getUsername();
    return json(200, {
      result:     "SUCCESS",
      userId:     1,
      username:   name,
      sessionKey: SESSION.sessionKey,
      env:        "prod",
      data:       {},
    });
  }

  // POST /DHSession
  if (u === "/dhsession" || u.startsWith("/dhsession/")) {
    return json(200, { sessionKey: SESSION.sessionKey, userId: 1 });
  }

  // GET /title/*
  if (u.startsWith("/title/")) {
    return json(200, { result: "OK", data: {} });
  }

  // POST /featureflags
  if (u === "/featureflags" || u.startsWith("/featureflags/")) {
    return json(200, {
      features: {
        mycareer: true, myteam: true, park: true,
        proam: true, neighborhood: true,
      },
      env: "prod",
    });
  }

  // -------------------------------------------------------------------------
  // Keyword routes (broader)
  // -------------------------------------------------------------------------

  if (u.includes("/auth") || u.includes("/login") || u.includes("/session") ||
      u.includes("/ticket") || u.includes("/titleauth") || u.includes("/v0/auth")) {
    const name = getUsername();
    return json(200, {
      result:        "SUCCESS",
      userId:        1,
      username:      name,
      sessionKey:    SESSION.sessionKey,
      authenticated: true,
      banned:        false,
      expiry:        9999999999,
      env:           "prod",
    });
  }

  if (u.includes("/features") || u.includes("/flags") || u.includes("/config")) {
    return json(200, {
      features: {
        mycareer: true, myteam: true, park: true, proam: true,
        neighborhood: true, onlineplay: true, myplayer: true,
      },
      maintenance: false,
      env: "prod",
    });
  }

  if (u === "/" || u === "/health" || u.includes("/heartbeat") || u.includes("/ping")) {
    return json(200, { status: "ok", time: Math.floor(Date.now() / 1000) });
  }

  if (u.includes("/profile") || u.includes("/account") || u.includes("/user")) {
    const name = getUsername();
    return json(200, {
      userId:   1,
      username: name,
      level:    99,
      vc:       999999,
      myPlayer: { overall: 99, position: "PG", name },
    });
  }

  if (u.includes("/inventory") || u.includes("/currency") ||
      u.includes("/vc") || u.includes("/wallet")) {
    return json(200, { vc: 999999, myteam_pts: 999999, items: [] });
  }

  if (u.includes("/matchmaking") || u.includes("/lobby") || u.includes("/quickmatch")) {
    return json(200, { status: "ok", servers: [], queueTime: 0 });
  }

  if (u.includes("/leaderboard") || u.includes("/rank") || u.includes("/ladder")) {
    return json(200, { entries: [], total: 0 });
  }

  if (u.includes("/roster") || u.includes("/lineup") || u.includes("/squad")) {
    return json(200, { roster: [], lineup: [] });
  }

  if (u.includes("/news") || u.includes("/motd") || u.includes("/announcement")) {
    return json(200, { items: [], motd: "Private Server" });
  }

  if (u.includes("/challenge") || u.includes("/objective") ||
      u.includes("/quest") || u.includes("/daily")) {
    return json(200, { challenges: [], objectives: [] });
  }

  if (u.includes("/stats") || u.includes("/history") || u.includes("/record")) {
    return json(200, { stats: {}, history: [] });
  }

  // -------------------------------------------------------------------------
  // Catch-all
  // -------------------------------------------------------------------------
  log(`  [UNHANDLED] ${method} ${url}`);
  return json(200, { result: "OK" });
}

// ---------------------------------------------------------------------------
// Proxy Protocol v1 parser  (playit.gg prepends this)
// ---------------------------------------------------------------------------
function readProxyHeader(socket) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const crlf = buf.indexOf("\r\n");
      if (crlf === -1) {
        if (buf.length > 108) {
          socket.removeListener("data", onData);
          socket.pause();
          resolve({ socket, realIp: socket.remoteAddress, rest: buf });
        }
        return;
      }
      socket.removeListener("data", onData);
      socket.pause();

      const line = buf.slice(0, crlf).toString("ascii");
      const rest = buf.slice(crlf + 2);
      let realIp = socket.remoteAddress;

      if (line.startsWith("PROXY TCP")) {
        const parts = line.split(" ");
        if (parts.length >= 3) realIp = parts[2];
        log(`[PROXY] ${line}  (real client: ${realIp})`);
      }
      resolve({ socket, realIp, rest });
    };

    socket.on("data", onData);
    socket.resume();
  });
}

// ---------------------------------------------------------------------------
// HTTP + HTTPS server  (single TCP port, first-byte TLS sniff)
//
// On Render: IS_RENDER=true, no cert files, plain HTTP only (Render does TLS)
// Local:     cert.pem + key.pem required for HTTPS; DLL clears cert errors
// ---------------------------------------------------------------------------
const httpServer = http.createServer(handleRequest);
httpServer.on("error", e => log(`[HTTP] error: ${e.message}`));

// Register the WebSocket upgrade handler on the HTTP server.
// The game connects to nba2k20-ws.2ksports.com:20217 which the DLL redirects
// here. It then sends "GET /Session HTTP/1.1" with Upgrade: websocket.
httpServer.on("upgrade", (req, socket, head) => {
  const u = (req.url || "").toLowerCase().replace(/\?.*$/, "");
  if (u === "/session" || u.startsWith("/session/")) {
    handleSessionUpgrade(req, socket, head);
  } else {
    log(`[WS] unknown upgrade path: ${req.url} — closing`);
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
  }
});

let httpsServer = null;

if (!IS_RENDER) {
  const certPath = path.join(__dirname, "cert.pem");
  const keyPath  = path.join(__dirname, "key.pem");

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const tlsOptions = {
      cert: fs.readFileSync(certPath),
      key:  fs.readFileSync(keyPath),
      requestCert:        false,
      rejectUnauthorized: false,
    };
    httpsServer = https.createServer(tlsOptions, handleRequest);
    httpsServer.on("error", e => log(`[HTTPS] error: ${e.message}`));
    // WebSocket upgrades over TLS
    httpsServer.on("upgrade", (req, socket, head) => {
      const u = (req.url || "").toLowerCase().replace(/\?.*$/, "");
      if (u === "/session" || u.startsWith("/session/")) {
        handleSessionUpgrade(req, socket, head);
      } else {
        socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      }
    });
  } else {
    log(`[2K20] HTTPS DISABLED — cert.pem / key.pem not found in ${__dirname}`);
    log(`[2K20] Run gen_cert.bat to generate them, then restart.`);
  }
}

if (IS_RENDER) {
  // On Render: plain HTTP only, Render handles TLS at the edge.
  httpServer.listen(HTTP_PORT, "0.0.0.0", () =>
    log(`[2K20] HTTP :${HTTP_PORT}  (Render mode — TLS at edge)  log -> ${LOG_FILE}`));
} else {
  // Local: single raw TCP socket, first-byte sniff for TLS vs plain HTTP.
  // DLL maps 80/443/8000/8080/20217 → HTTP_PORT (default 1).
  const combinedRaw = net.createServer((socket) => {
    readProxyHeader(socket).then(({ socket: s, realIp, rest }) => {
      s._realIp = realIp;
      const isTls = rest && rest.length > 0 && rest[0] === 0x16;
      if (rest && rest.length > 0) s.unshift(rest);

      if (isTls && httpsServer) {
        httpsServer.emit("connection", s);
      } else {
        httpServer.emit("connection", s);
      }
      s.resume();
    });
  });
  combinedRaw.on("error", e => log(`[HTTP/S] error: ${e.message}`));
  combinedRaw.listen(HTTP_PORT, "0.0.0.0", () =>
    log(`[2K20] HTTP+HTTPS :${HTTP_PORT}  log -> ${LOG_FILE}`));
}

// ---------------------------------------------------------------------------
// TCP stub — :8009  (Demonware raw binary backend)
// ---------------------------------------------------------------------------
const tcpServer = net.createServer((socket) => {
  readProxyHeader(socket).then(({ socket: s, realIp, rest }) => {
    const remote = `${realIp}:${s.remotePort}`;
    log(`[TCP-8009] connect  ${remote}`);

    const handleData = (data) => {
      const hex   = data.slice(0, 256).toString("hex").replace(/(.{32})/g, "$1 ").trimEnd();
      const ascii = data.slice(0, 256).toString("ascii").replace(/[^\x20-\x7e]/g, ".");
      log(`[TCP-8009] recv ${data.length}b from ${remote}`);
      log(`  hex:   ${hex}`);
      log(`  ascii: ${ascii}`);
      s.write(Buffer.alloc(8));  // null ACK
    };

    if (rest && rest.length > 0) handleData(rest);

    s.on("data",  handleData);
    s.on("end",   () => log(`[TCP-8009] disconnect ${remote}`));
    s.on("error", e  => log(`[TCP-8009] error ${remote}: ${e.message}`));
    s.resume();
  });
});

tcpServer.on("error", e => log(`[TCP-8009] server error: ${e.message}`));
tcpServer.listen(TCP_PORT, "0.0.0.0", () =>
  log(`[2K20] TCP   :${TCP_PORT}`));
