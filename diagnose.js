/**
 * diagnose.js — finds out WHICH Firestore read/write the security rules allow.
 *   node diagnose.js            (uses first room in ROOMS)
 *   node diagnose.js Bangladesh
 * Paste the whole output back.
 */
const { Session, authed, runQuery, joinRoom, goOnline, DOCS } = require("./lib");

const user = process.env.MIGLIFE_USERNAME, pass = process.env.MIGLIFE_PASSWORD;
const room = process.argv[2] || (process.env.ROOMS || "Bangladesh").split(",")[0].trim();

const results = [];
async function test(name, fn) {
  try {
    const r = await fn();
    results.push([name, "PASS", r === undefined ? "" : String(r)]);
  } catch (e) {
    results.push([name, "FAIL", (e.message.match(/"status":"(\w+)"/) || [, e.message.slice(0, 80)])[1]]);
  }
}
const q = (limit, withOrder) => ({
  from: [{ collectionId: "messages" }],
  ...(withOrder
    ? { orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }, { field: { fieldPath: "__name__" }, direction: "DESCENDING" }] }
    : {}),
  limit,
});

(async () => {
  const s = await new Session(user, pass).login();
  console.log(`Logged in as ${user} uid=${s.uid}  room="${room}"\n`);
  const enc = encodeURIComponent;

  await test("read own users/<uid> doc", async () => {
    const d = await authed(s, `${DOCS}/users/${s.uid}`, { method: "GET" });
    return "fields: " + Object.keys(d.fields || {}).slice(0, 12).join(",");
  });
  await test("read rooms/<room> doc", async () => {
    const d = await authed(s, `${DOCS}/rooms/${enc(room)}`, { method: "GET" });
    return "fields: " + Object.keys(d.fields || {}).join(",");
  });
  await test("read room_presence/<room>/users/<uid>", () =>
    authed(s, `${DOCS}/room_presence/${enc(room)}/users/${s.uid}`, { method: "GET" }).then(() => "ok"));

  const reads = async (tag) => {
    await test(`${tag} messages: limit 1, no order`, async () => (await runQuery(s, room, q(1, false))).length + " docs");
    await test(`${tag} messages: createdAt desc, limit 20`, async () => (await runQuery(s, room, q(20, true))).length + " docs");
    await test(`${tag} messages: createdAt desc, limit 50`, async () => (await runQuery(s, room, q(50, true))).length + " docs");
    await test(`${tag} messages: createdAt desc, limit 100`, async () => (await runQuery(s, room, q(100, true))).length + " docs");
  };

  await reads("BEFORE presence:");
  await test("WRITE go-online (users/<uid> presenceStatus=ONLINE)", async () => { await goOnline(s); return "written"; });
  await test("WRITE join room (full presence doc, no announce)", async () => { const r = await joinRoom(s, room, { announce: false }); return `level ${r.level}`; });
  await reads("AFTER  presence:");

  const w = Math.max(...results.map((r) => r[0].length));
  console.log("RESULTS");
  for (const [n, st, info] of results) console.log(`${st === "PASS" ? "✅" : "❌"} ${n.padEnd(w)}  ${st}  ${info}`);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
