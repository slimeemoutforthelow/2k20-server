'use strict';
/**
 * Persistent member store — writes to ./data/members.json
 * so members survive Render free-tier restarts.
 */

const { v4: uuidv4 } = require('uuid');
const crypto = require('node:crypto');
const fs     = require('node:fs');
const path   = require('node:path');

const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'members.json');

// ── Persistence ───────────────────────────────────────────────────────────────
function loadMembers() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) return new Map();
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return new Map(Object.entries(raw));
  } catch { return new Map(); }
}

function saveMembers() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = Object.fromEntries(members);
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) { console.error('[db] save failed:', e.message); }
}

// key: memberKey  value: { memberId, memberCode, nativeUserIdHex, joinedAt }
const members = loadMembers();

// key: memberKey  value: session object (rebuilt from members on demand)
const sessions = new Map();

const JOIN_KEY    = process.env.NOSTALGIA_JOIN_KEY || 'fuUEsQMS8nUbp2Y4KCzBUzqYQZFAGfWKcRYKNTF92Ck';
const MAX_MEMBERS = parseInt(process.env.MAX_MEMBERS || '50', 10);

function generateMemberCode(memberId) {
  return 'N' + memberId.replace(/-/g, '').slice(0, 12);
}

function generateNativeUserId() {
  // 4e53 prefix = non-Steam path
  return '4e53' + crypto.randomBytes(6).toString('hex');
}

// ── Enroll ────────────────────────────────────────────────────────────────────
function enroll(memberKey, joinKey) {
  if (joinKey !== JOIN_KEY)     return { ok: false, status: 403 };
  if (!members.has(memberKey) && members.size >= MAX_MEMBERS)
                                return { ok: false, status: 409 };
  if (!members.has(memberKey)) {
    const memberId        = uuidv4();
    const memberCode      = generateMemberCode(memberId);
    const nativeUserIdHex = generateNativeUserId();
    members.set(memberKey, { memberId, memberCode, nativeUserIdHex, joinedAt: Date.now() });
    saveMembers();
    console.log(`[enroll] new member ${memberCode}  total=${members.size}`);
  }
  return { ok: true, status: 200 };
}

// ── Session ───────────────────────────────────────────────────────────────────
function getSession(memberKey) {
  if (!members.has(memberKey)) return null;
  if (!sessions.has(memberKey)) {
    const m = members.get(memberKey);
    sessions.set(memberKey, {
      memberId:           m.memberId,
      memberCode:         m.memberCode,
      nativeUserIdHex:    m.nativeUserIdHex,
      displayName:        'Player [' + m.memberCode + ']',
      steamPersonaName:   null,
      steamNameState:     'not-linked',
      parkJoinState:      'not-started',
      nativeLoginState:   'not-started',
      nativeLoginError:   null,
      careerUpgradeState: 'not-started',
      careerUpgradeError: null,
    });
  }
  return sessions.get(memberKey);
}

// ── Steam link ────────────────────────────────────────────────────────────────
function linkSteam(memberKey, steamId, personaName) {
  const s = getSession(memberKey);
  if (!s) return false;
  const lower32         = (BigInt(steamId) & 0xffffffffn).toString(16).padStart(8, '0');
  s.nativeUserIdHex     = '53540000' + lower32;
  s.steamPersonaName    = personaName;
  s.steamNameState      = 'ready';
  s.displayName         = personaName + ' [' + s.memberCode + ']';
  const m = members.get(memberKey);
  if (m) { m.nativeUserIdHex = s.nativeUserIdHex; saveMembers(); }
  return true;
}

function unlinkSteam(memberKey) {
  const s = getSession(memberKey);
  if (!s) return false;
  const newId           = generateNativeUserId();
  s.nativeUserIdHex     = newId;
  s.steamPersonaName    = null;
  s.steamNameState      = 'not-linked';
  s.displayName         = 'Player [' + s.memberCode + ']';
  const m = members.get(memberKey);
  if (m) { m.nativeUserIdHex = newId; saveMembers(); }
  return true;
}

// ── Locker codes (add real codes here) ────────────────────────────────────────
// Example: lockerCodes.set('FREVC5000', { vc: 5000, claimed: new Set() });
const lockerCodes = new Map();

function redeemLockerCode(memberKey, code) {
  const entry = lockerCodes.get(String(code || '').toUpperCase());
  if (!entry)                       return { ok: false, error: 'code-not-found' };
  if (entry.claimed.has(memberKey)) return { ok: false, error: 'already-claimed' };
  entry.claimed.add(memberKey);
  return { ok: true, vc: entry.vc };
}

module.exports = { enroll, getSession, linkSteam, unlinkSteam, redeemLockerCode, JOIN_KEY };
