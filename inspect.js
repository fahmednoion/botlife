/**
 * inspect.js — prints the REAL field layout of room messages.
 *   node inspect.js            -> uses ROOMS from .env
 *   node inspect.js Bangladesh -> one room
 * Send one message from the web UI as your bot account first, so we can see
 * exactly which fields a normal message carries. Output is also saved to
 * inspect_output.json (share it if sending fails).
 */
const fs = require("fs");
const { Session, latestMessages, decFields, joinRoom, goOnline } = require("./lib");

(async () => {
  const user = process.env.MIGLIFE_USERNAME, pass = process.env.MIGLIFE_PASSWORD;
  if (!user || !pass || !process.env.FIREBASE_API_KEY) {
    console.error("Fill MIGLIFE_USERNAME, MIGLIFE_PASSWORD and FIREBASE_API_KEY in .env first.");
    process.exit(1);
  }
  const s = await new Session(user, pass).login();
  console.log(`Logged in as ${user} (uid ${s.uid})\n`);
  await goOnline(s);

  const rooms = process.argv[2] ? [process.argv[2]] : (process.env.ROOMS || "Bangladesh").split(",").map((x) => x.trim());
  const out = {};
  for (const room of rooms) {
    try { await joinRoom(s, room, { announce: false }); } catch (e) { console.log(`(join failed: ${e.message})`); }
    const docs = await latestMessages(s, room, 8);
    console.log(`══ ${room}: ${docs.length} latest messages ══`);
    out[room] = docs.map((d) => ({
      id: d.name.split("/").pop(),
      types: Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, Object.keys(v)[0]])),
      data: decFields(d.fields),
    }));
    for (const m of out[room]) console.log(JSON.stringify(m, null, 2));
  }
  fs.writeFileSync("inspect_output.json", JSON.stringify(out, null, 2));
  console.log("\nSaved inspect_output.json");
})().catch((e) => { console.error("ERROR:", e.message); if (/403|PERMISSION/.test(e.message)) console.error("\nPermission denied -> run:  node diagnose.js  and send me the output."); process.exit(1); });
