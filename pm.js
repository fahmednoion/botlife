/**
 * pm.js — private messages (collection `private_messages`).
 * The exact schema is learned from the PMs the parent sends us:
 *  - receiving: tries the web app's style query (toUsername == me AND createdAt > x),
 *    falls back to toUsername == me only.
 *  - replying: clones the incoming PM's field layout and swaps sender<->recipient.
 */
const { authed, runRootQuery, decFields, commit, docName, REQ_TIME, autoId, DOCS } = require("./lib");

const TEXT_KEYS = ["text", "content", "message", "body", "msg"];
const FROM_KEYS = ["fromUsername", "senderUsername", "sender", "from", "fromUser", "fromName"];
const FROM_UID_KEYS = ["fromUid", "senderUid", "fromUserId", "senderId", "fromId"];

function normalize(doc) {
  const f = decFields(doc.fields);
  const pick = (keys) => { for (const k of keys) if (typeof f[k] === "string" && f[k]) return f[k]; return null; };
  const textKey = TEXT_KEYS.find((k) => typeof f[k] === "string");
  return {
    id: doc.name.split("/").pop(),
    from: pick(FROM_KEYS),
    fromUid: pick(FROM_UID_KEYS),
    text: textKey ? f[textKey] : "",
    createdAt: typeof f.createdAt === "string" ? f.createdAt : null,
    fields: f,
    raw: doc,
  };
}

class PMClient {
  constructor(session, log = console.log) {
    this.session = session;
    this.log = log;
    this.strategy = null; // "A" | "B"
    this.after = new Date().toISOString();
    this.seen = new Set();
    this.startedAt = Date.now();
  }

  _query(strategy) {
    const eq = { fieldFilter: { field: { fieldPath: "toUsername" }, op: "EQUAL", value: { stringValue: this.session.username } } };
    if (strategy === "A") {
      return {
        from: [{ collectionId: "private_messages" }],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [eq, { fieldFilter: { field: { fieldPath: "createdAt" }, op: "GREATER_THAN", value: { timestampValue: this.after } } }],
          },
        },
        orderBy: [{ field: { fieldPath: "createdAt" }, direction: "ASCENDING" }],
        limit: 50,
      };
    }
    return { from: [{ collectionId: "private_messages" }], where: eq, limit: 50 };
  }

  /** prime "seen" with existing PMs so old commands are never replayed */
  async prime() {
    const docs = await runRootQuery(this.session, this._query("B")).catch(() => []);
    for (const d of docs) {
      const m = normalize(d);
      this.seen.add(m.id);
      if (m.createdAt && Date.parse(m.createdAt) > Date.parse(this.after)) this.after = m.createdAt;
    }
  }

  /** returns NEW incoming PMs (normalized) */
  async poll() {
    let docs;
    if (this.strategy !== "B") {
      try {
        docs = await runRootQuery(this.session, this._query("A"));
        if (!this.strategy) { this.strategy = "A"; this.log("✔ PM listener: indexed query OK"); }
      } catch (e) {
        if (this.strategy === "A") throw e;
        this.log(`PM query A failed (${e.message.slice(0, 120)}) — falling back to simple query`);
        this.strategy = "B";
      }
    }
    if (this.strategy === "B") docs = await runRootQuery(this.session, this._query("B"));

    const out = [];
    for (const d of docs) {
      const m = normalize(d);
      if (this.seen.has(m.id)) continue;
      this.seen.add(m.id);
      if (m.createdAt && Date.parse(m.createdAt) > Date.parse(this.after)) this.after = m.createdAt;
      // fallback query has no time filter: never act on messages older than our start
      if (this.strategy === "B" && m.createdAt && Date.parse(m.createdAt) < this.startedAt - 60_000) continue;
      out.push(m);
    }
    return out.sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
  }
}

/** Build reply fields by cloning the incoming PM and swapping the two parties. */
function buildReplyFields(tpl, { me, meUid, other, otherUid, receivedText, text }) {
  const lMe = me.toLowerCase(), lOther = (other || "").toLowerCase();
  const tsFields = [];
  const swap = (v, key, top) => {
    if ("stringValue" in v) {
      const s = v.stringValue;
      if (TEXT_KEYS.includes(key) || (receivedText && s === receivedText)) return { stringValue: text };
      if (lOther && s.toLowerCase() === lOther) return { stringValue: me };
      if (s.toLowerCase() === lMe) return { stringValue: other };
      if (otherUid && s === otherUid) return { stringValue: meUid };
      if (s === meUid && otherUid) return { stringValue: otherUid };
      return v;
    }
    if ("timestampValue" in v) { if (top) tsFields.push(key); return top ? null : v; }
    if ("integerValue" in v) {
      const n = Number(v.integerValue);
      return Math.abs(Date.now() - n) < 864e5 ? { integerValue: String(Date.now()) } : v;
    }
    if ("arrayValue" in v) return { arrayValue: { values: (v.arrayValue.values || []).map((x) => swap(x, key, false)) } };
    if ("mapValue" in v)
      return { mapValue: { fields: Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, swap(x, k, false)])) } };
    return v;
  };
  const fields = {};
  for (const [k, v] of Object.entries(tpl)) {
    const r = swap(v, k, true);
    if (r) fields[k] = r;
  }
  return { fields, tsFields };
}

async function sendPM(session, incoming, text) {
  const { fields, tsFields } = buildReplyFields(incoming.raw.fields || {}, {
    me: session.username, meUid: session.uid,
    other: incoming.from, otherUid: incoming.fromUid,
    receivedText: incoming.text, text,
  });
  await commit(session, [
    {
      update: { name: docName(`private_messages/${autoId()}`), fields },
      updateTransforms: (tsFields.length ? tsFields : ["createdAt"]).map(REQ_TIME),
      currentDocument: { exists: false },
    },
  ]);
}

module.exports = { PMClient, normalize, buildReplyFields, sendPM };
