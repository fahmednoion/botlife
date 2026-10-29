/**
 * extract-schema.js — reads the FULL request bodies saved by intercept.js
 * (logs/session-*.jsonl) and prints the exact documents the web app writes
 * when it enters a room and sends a message, plus the exact message query.
 *
 *   node extract-schema.js "C:\path\to\miglife\logs\session-2026-10-28T10-52-51-360Z.jsonl"
 *   node extract-schema.js "C:\path\to\miglife\logs"      (all .jsonl files in a folder)
 *
 * Paste the whole output back. XP/level writes are skipped; tokens are redacted.
 */
const fs = require("fs");
const path = require("path");

const arg = process.argv[2];
if (!arg) { console.error('Usage: node extract-schema.js "<file.jsonl | logs folder>"'); process.exit(1); }

const files = fs.statSync(arg).isDirectory()
  ? fs.readdirSync(arg).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(arg, f))
  : [arg];

// ── helpers ─────────────────────────────────────────────────
const redact = (s) =>
  typeof s === "string" ? (/^eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(s) ? "<JWT redacted>" : s.length > 300 ? s.slice(0, 300) + "…" : s) : s;

function simplify(v) {
  if (v == null) return v;
  if ("stringValue" in v) return redact(v.stringValue);
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return { timestamp: v.timestampValue };
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(simplify);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, simplify(x)]));
  return v;
}
const simplifyFields = (f = {}) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, simplify(v)]));

const pattern = (name) =>
  name
    .replace(/^projects\/[^/]+\/databases\/\([^)]*\)\/documents\//, "")
    .replace(/(users|messages|xp_history|private_messages)\/[A-Za-z0-9_-]{20,}/g, "$1/<id>")
    .replace(/(room_presence|room_messages)\/[^/]+/g, "$1/<ROOM>");

function bodiesOf(postData) {
  if (!postData) return [];
  const out = [];
  if (postData.trim().startsWith("{")) {
    try { out.push(JSON.parse(postData)); } catch {}
    return out;
  }
  for (const m of postData.matchAll(/req\d+___data__=([^&]*)/g)) {
    try { out.push(JSON.parse(decodeURIComponent(m[1]))); } catch {}
  }
  return out;
}

// ── scan ────────────────────────────────────────────────────
const found = new Map(); // key -> {ts, data}
let reqCount = 0, truncated = 0;

for (const file of files) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.kind !== "request" || e.method !== "POST" || !e.postData) continue;
    reqCount++;
    for (const body of bodiesOf(e.postData)) {
      // writes (Write/channel + documents:commit)
      for (const w of body.writes || []) {
        if (!w.update || !w.update.name) continue;
        const p = pattern(w.update.name);
        if (/^users\//.test(p) || !/room_presence|room_messages|private_messages/.test(p)) continue;
        const hasFields = w.update.fields && Object.keys(w.update.fields).length > 0;
        const key = `WRITE ${p} ${hasFields ? "with-fields" : "transform-only"}${/has entered/.test(JSON.stringify(w)) ? " ENTER-MSG" : ""}`;
        if (!found.has(key))
          found.set(key, {
            time: e.t,
            docPath: w.update.name.replace(/^projects\/[^/]+\/databases\/\([^)]*\)\/documents\//, ""),
            fields: simplifyFields(w.update.fields),
            updateMask: w.updateMask,
            updateTransforms: w.updateTransforms,
            currentDocument: w.currentDocument,
          });
      }
      // listen queries on messages / presence
      const t = body.addTarget;
      if (t && t.query) {
        const sq = t.query.structuredQuery || {};
        const coll = (sq.from || []).map((f) => f.collectionId).join(",");
        const parent = (t.query.parent || "").replace(/^projects\/[^/]+\/databases\/\([^)]*\)\/documents\/?/, "");
        if (/private_messages/.test(coll) || (/messages|users/.test(coll) && /room_/.test(parent))) {
          const key = `QUERY ${parent.replace(/room_(presence|messages)\/[^/]+/, "room_$1/<ROOM>")} -> ${coll}`;
          if (!found.has(key)) found.set(key, { time: e.t, parent, structuredQuery: sq });
        }
      }
    }
  }
}

console.log(`Scanned ${files.length} file(s), ${reqCount} POST bodies.\n`);
if (!found.size) {
  console.log("Nothing matching found. Re-run intercept.js --reload, log in, ENTER a room, send one message, then try again.");
  process.exit(0);
}
for (const [key, val] of found) {
  console.log("═".repeat(70));
  console.log(key);
  console.log(JSON.stringify(val, null, 2));
}
console.log("\n(Values like uid/username are yours; nothing here contains your password.)");
