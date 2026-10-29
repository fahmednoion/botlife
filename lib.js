/**
 * lib.js — miglife (Firebase) helpers: Auth + Firestore over plain REST.
 * Document shapes below are copied from the web app's own traffic.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API_KEY = process.env.FIREBASE_API_KEY;
const PROJECT = process.env.FIREBASE_PROJECT || "migwith-mumbai";
const ORIGIN = process.env.SITE_ORIGIN || "https://web.miglife.app";
const EMAIL_DOMAIN = process.env.LOGIN_EMAIL_DOMAIN || "login.migwith.local";
const DB = `projects/${PROJECT}/databases/(default)`;
const DOCS = `https://firestore.googleapis.com/v1/${DB}/documents`;

const HEADERS = {
  "Content-Type": "application/json",
  Origin: ORIGIN,
  Referer: ORIGIN + "/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

async function http(url, { method = "POST", body, headers = {}, form = false } = {}) {
  const h = { ...HEADERS, ...headers };
  if (form) h["Content-Type"] = "application/x-www-form-urlencoded";
  const res = await fetch(url, {
    method,
    headers: h,
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${url.split("?")[0]} — ${typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data.error || data).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// stable fake "device" id, like the web app's localStorage value (web_<16 hex>)
function getDeviceId() {
  const f = path.join(__dirname, ".deviceid");
  try { return fs.readFileSync(f, "utf8").trim(); } catch {}
  const id = "web_" + crypto.randomBytes(8).toString("hex");
  try { fs.writeFileSync(f, id); } catch {}
  return id;
}

// ── Auth ────────────────────────────────────────────────────
class Session {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.idToken = null;
    this.refreshToken = null;
    this.uid = null;
    this.exp = 0;
    this.deviceId = getDeviceId();
    this.rooms = new Map(); // room -> { visitId, level }
  }

  async login() {
    const email = `${this.username.toLowerCase()}@${EMAIL_DOMAIN}`;
    const r = await http(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
      { body: { email, password: this.password, returnSecureToken: true, clientType: "CLIENT_TYPE_WEB" } }
    );
    this.idToken = r.idToken;
    this.refreshToken = r.refreshToken;
    this.uid = r.localId;
    this.exp = Date.now() + Number(r.expiresIn || 3600) * 1000;
    return this;
  }

  async refresh() {
    try {
      const r = await http(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
        form: true,
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.refreshToken)}`,
      });
      this.idToken = r.id_token;
      this.refreshToken = r.refresh_token;
      this.exp = Date.now() + Number(r.expires_in || 3600) * 1000;
    } catch {
      await this.login();
    }
  }

  async token() {
    if (!this.idToken) await this.login();
    else if (Date.now() > this.exp - 120_000) await this.refresh();
    return this.idToken;
  }
}

// ── Firestore value codec ───────────────────────────────────
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: encFields(v) } };
}
const encFields = (o) => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, enc(x)]));
function dec(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(dec);
  if ("mapValue" in v) return decFields(v.mapValue.fields || {});
  if ("referenceValue" in v) return v.referenceValue;
  if ("geoPointValue" in v) return v.geoPointValue;
  return v;
}
const decFields = (f = {}) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, dec(v)]));

const autoId = () => {
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 20 }, () => c[crypto.randomInt(c.length)]).join("");
};

// ── Firestore calls ─────────────────────────────────────────
async function authed(session, url, opts = {}) {
  const t = await session.token();
  try {
    return await http(url, { ...opts, headers: { Authorization: `Bearer ${t}` } });
  } catch (e) {
    if (e.status === 401) { await session.login(); return authed(session, url, opts); }
    throw e;
  }
}
const commit = (session, writes) => authed(session, `${DOCS}:commit`, { body: { writes } });
const docName = (p) => `${DB}/documents/${p}`;
const REQ_TIME = (fieldPath) => ({ fieldPath, setToServerValue: "REQUEST_TIME" });

async function runQuery(session, room, structuredQuery) {
  const url = `${DOCS}/room_messages/${encodeURIComponent(room)}:runQuery`;
  const rows = await authed(session, url, { body: { structuredQuery } });
  return rows.filter((r) => r.document).map((r) => r.document);
}

/** newest N messages — same query shape as the web app (createdAt desc, __name__ desc) */
function latestMessages(session, room, n = 30) {
  return runQuery(session, room, {
    from: [{ collectionId: "messages" }],
    orderBy: [
      { field: { fieldPath: "createdAt" }, direction: "DESCENDING" },
      { field: { fieldPath: "__name__" }, direction: "DESCENDING" },
    ],
    limit: n,
  });
}

/** messages created after a timestamp (ascending) — near-zero reads when idle */
function newMessages(session, room, afterIso) {
  return runQuery(session, room, {
    from: [{ collectionId: "messages" }],
    where: {
      fieldFilter: {
        field: { fieldPath: "createdAt" },
        op: "GREATER_THAN",
        value: { timestampValue: afterIso },
      },
    },
    orderBy: [{ field: { fieldPath: "createdAt" }, direction: "ASCENDING" }],
    limit: 50,
  });
}

/** Mark OUR OWN account ONLINE (first thing the web app does after login) */
async function goOnline(session) {
  const name = docName(`users/${session.uid}`);
  await commit(session, [
    {
      update: { name, fields: encFields({ isInvisible: false, presenceStatus: "ONLINE" }) },
      updateMask: { fieldPaths: ["isInvisible", "presenceStatus"] },
    },
    { update: { name }, updateMask: { fieldPaths: [] }, updateTransforms: [REQ_TIME("lastActiveAt")] },
  ]);
}

async function touchActive(session) {
  await commit(session, [
    {
      update: { name: docName(`users/${session.uid}`) },
      updateMask: { fieldPaths: [] },
      updateTransforms: [REQ_TIME("lastActiveAt")],
    },
  ]);
}

/**
 * Enter a room exactly like the browser:
 *   1) create room_presence/<room>/users/<uid> with the full field set
 *   2) post the "<room>: <user> [<level>] has entered." room_entry message
 */
async function joinRoom(session, room, { announce = true } = {}) {
  const me = await authed(session, `${DOCS}/users/${session.uid}`, { method: "GET" });
  const u = decFields(me.fields);
  const level = u.level ?? 1;
  const visitId = crypto.randomBytes(6).toString("hex");

  const fields = {
    uid: session.uid,
    username: session.username,
    activity: "",
    level,
    levelBadgeIcon: u.levelBadgeIcon || "",
    shopBadges: Array.isArray(u.shopBadges) ? u.shopBadges : [],
    presenceStatus: "ONLINE",
    visitId,
    deviceId: session.deviceId,
  };
  await commit(session, [
    {
      update: { name: docName(`room_presence/${room}/users/${session.uid}`), fields: encFields(fields) },
      updateMask: { fieldPaths: Object.keys(fields).sort() },
      updateTransforms: [REQ_TIME("lastSeen"), REQ_TIME("entryMarker")],
    },
  ]);
  session.rooms.set(room, { visitId, level });

  if (announce) {
    await commit(session, [
      {
        update: {
          name: docName(`room_messages/${room}/messages/${autoId()}`),
          fields: encFields({
            text: `${room}: ${session.username} [${level}] has entered.`,
            sender: session.username,
            senderUid: session.uid,
            type: "room_entry",
          }),
        },
        updateTransforms: [REQ_TIME("createdAt")],
        currentDocument: { exists: false },
      },
    ]);
  }
  return { level, visitId };
}

/** Leave message, like the browser's "has left." (doc id leave_<uid>_<visitId>) */
async function leaveRoom(session, room) {
  const info = session.rooms.get(room);
  if (!info) return;
  await commit(session, [
    {
      update: {
        name: docName(`room_messages/${room}/messages/leave_${session.uid}_${info.visitId}`),
        fields: encFields({
          text: `${room}: ${session.username} [${info.level}] has left.`,
          sender: session.username,
          senderUid: session.uid,
          type: "room_leave",
        }),
      },
      updateTransforms: [REQ_TIME("createdAt")],
    },
  ]);
  session.rooms.delete(room);
}

/** Presence heartbeat for an existing presence doc (browser sends this every ~20s) */
async function presence(session, room) {
  await commit(session, [
    {
      update: { name: docName(`room_presence/${room}/users/${session.uid}`) },
      updateMask: { fieldPaths: [] },
      updateTransforms: [REQ_TIME("lastSeen")],
      currentDocument: { exists: true },
    },
  ]);
}

/** Send a normal chat message — field-for-field what the web app writes */
async function sendMessage(session, room, text) {
  await commit(session, [
    {
      update: {
        name: docName(`room_messages/${room}/messages/${autoId()}`),
        fields: encFields({
          text,
          sender: session.username,
          senderUid: session.uid,
          type: "chat",
          giftName: "",
          clientCreatedAt: Date.now(),
        }),
      },
      updateTransforms: [REQ_TIME("createdAt")],
      currentDocument: { exists: false },
    },
  ]);
}

async function runRootQuery(session, structuredQuery) {
  const rows = await authed(session, `${DOCS}:runQuery`, { body: { structuredQuery } });
  return rows.filter((r) => r.document).map((r) => r.document);
}

/** all room names (document ids of the `rooms` collection) */
async function listRooms(session) {
  const docs = await runRootQuery(session, { from: [{ collectionId: "rooms" }], limit: 500 });
  return docs.map((d) => {
    let id = d.name.split("/").pop();
    try { id = decodeURIComponent(id); } catch {}
    return id;
  });
}

/** uid of a username (users.usernameLower == name) or null */
async function findUserUid(session, username) {
  const docs = await runRootQuery(session, {
    from: [{ collectionId: "users" }],
    where: { fieldFilter: { field: { fieldPath: "usernameLower" }, op: "EQUAL", value: { stringValue: username.toLowerCase() } } },
    limit: 1,
  });
  return docs[0] ? docs[0].name.split("/").pop() : null;
}

module.exports = {
  Session, enc, dec, decFields, latestMessages, newMessages, sendMessage,
  presence, goOnline, touchActive, joinRoom, leaveRoom, authed, runQuery, DOCS, DB,
  runRootQuery, listRooms, findUserUid, commit, docName, REQ_TIME, autoId,
};
