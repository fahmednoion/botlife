/**
 * miglife.js — single-file miglife bot with full nowfel-style feature parity
 * + Cloud Functions routing + client-command rendering + /gift interception
 * + hang-protection timeouts + auto-fallback "everyone" for empty {arg}
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

try { require("dotenv").config({ quiet: true }); }
catch {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      const v = m[2].replace(/^(['"])(.*)\1$/, "$2");
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch {}
}

// ══════════════════════════════════════════════════════════════
//  CONFIGURATION
// ══════════════════════════════════════════════════════════════
const env = process.env;
const API_KEY = env.FIREBASE_API_KEY;
const PROJECT = env.FIREBASE_PROJECT || "migwith-mumbai";
const ORIGIN  = env.SITE_ORIGIN || "https://web.miglife.app";
const EMAIL_DOMAIN = env.LOGIN_EMAIL_DOMAIN || "login.migwith.local";
const USER = env.MIGLIFE_USERNAME;
const PASS = env.MIGLIFE_PASSWORD;
const ROOMS = (env.ROOMS || "").split(",").map((s) => s.trim()).filter(Boolean);
const PARENTS = (env.PARENT_USERNAMES || env.PARENT_USERNAME || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const PARENT_PREFIX = env.PARENT_PREFIX || "|";
const PREFIX = env.COMMAND_PREFIX || "!";

const POLL_MS = Number(env.POLL_MS || 2500);
const PM_POLL_MS = Number(env.PM_POLL_MS || 3000);
const PRESENCE_MS = Number(env.PRESENCE_MS || 20000);
const SEND_GAP_MS = Number(env.SEND_GAP_MS || 1500);
const MAX_ACCOUNTS = Number(env.MAX_ACCOUNTS || 10);
const PM_REPLY = env.PM_REPLY !== "false";
const ANNOUNCE_JOIN = env.ANNOUNCE_JOIN !== "false";
const DEBUG = env.DEBUG === "true";
const PORT = env.PORT ? Number(env.PORT) : null;

const HTTP_TIMEOUT_MS = Number(env.HTTP_TIMEOUT_MS || 20000);
const SEND_TIMEOUT_MS = Number(env.SEND_TIMEOUT_MS || 30000);
const CMD_TIMEOUT_MS  = Number(env.CMD_TIMEOUT_MS  || 45000);
const GIFT_TIMEOUT_MS = Number(env.GIFT_TIMEOUT_MS || 45000);
const HEARTBEAT_MS    = Number(env.HEARTBEAT_MS    || 300000);

const AUTO_PICK = env.AUTO_PICK === "true";
const AUTO_TEXT_ON = env.AUTO_TEXT_ON === "true";
const AUTO_TEXT_INTERVAL = Math.max(1, Number(env.AUTO_TEXT_INTERVAL || 5));
const AUTO_TEXT_ROOMS = (env.AUTO_TEXT_ROOMS || "").split(",").map((s) => s.trim()).filter(Boolean);
const AUTO_REPLY_ON = env.AUTO_REPLY_ON === "true";
const WELCOME_ON = env.WELCOME_ON === "true";
const WELCOME_TEXT = env.WELCOME_TEXT || "Welcome {username} 🎉";
const WELCOME_COOLDOWN_MS = 10 * 60 * 1000;
const AWGIFT_ON = env.AWGIFT_ON === "true";
const AWGIFT_ROOMS = (env.AWGIFT_ROOMS || "").split(",").map((s) => s.trim()).filter(Boolean);
const AWGIFT_NAME = env.AWGIFT_NAME || "miglife";
const AWGIFT_MESSAGE = env.AWGIFT_MESSAGE || "Welcome to the room!";
const AWGIFT_COOLDOWN_HOURS = Math.max(1, Number(env.AWGIFT_COOLDOWN_HOURS || 24));
const AWGIFT_POST_LINE = env.AWGIFT_POST_LINE !== "false";
const SLANG_ON = env.SLANG_ON === "true";
const FLOOD_INTERVAL_MS = Number(env.FLOOD_INTERVAL_MS || 500);
const TRIGGER_DEFAULT = env.TRIGGER_KEYWORD || (USER ? `@${USER.toLowerCase()}` : null);

const FUNCTIONS_REGION = env.FUNCTIONS_REGION || "asia-south1";
const FN_PICK = env.FN_PICK || "pickVoucher";
const FN_GIFT = env.FN_GIFT || "sendGift";
const FN_GIFT_SHOWER = env.FN_GIFT_SHOWER || "sendGiftShower";
const FN_SILENCE = env.FN_SILENCE || "silenceUser";
const FN_BUMP = env.FN_BUMP || "bumpUser";

const SLANG_FILE = path.join(__dirname, "slang.txt");
const SLANG_HISTORY_FILE = path.join(__dirname, "slang_history.json");
const SLANG_LOG_FILE = path.join(__dirname, "slang_actions.log");
const GIFTUSERS_FILE = path.join(__dirname, "giftusers.json");
const AT_FILE = path.join(__dirname, "at.txt");
const FLOOD_FILE = path.join(__dirname, "flood.txt");
const TRIGGER_FILE = path.join(__dirname, "bot_trigger.txt");
const CLIENT_COMMANDS_FILE = path.join(__dirname, "client_commands.json");
const ALL_COMMANDS_FILE = path.join(__dirname, "all_commands.txt");

const DB = `projects/${PROJECT}/databases/(default)`;
const DOCS = `https://firestore.googleapis.com/v1/${DB}/documents`;
const FUNCTIONS_BASE = `https://${FUNCTIONS_REGION}-${PROJECT}.cloudfunctions.net`;
const AI_UNAVAILABLE_MSG = "🤖 AI is not available right now";

const log = (...a) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════
//  HANG PREVENTION
// ══════════════════════════════════════════════════════════════
async function fetchT(url, opts = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const tErr = () => { const err = new Error(`Timeout ${timeoutMs}ms — ${url.split("?")[0]}`); err.status = 408; err.code = "TIMEOUT"; return err; };
  let res;
  try { res = await fetch(url, { ...opts, signal: ctrl.signal }); }
  catch (e) { clearTimeout(timer); throw (ctrl.signal.aborted || e.name === "AbortError") ? tErr() : e; }
  // FIX: the timer must keep running until the BODY has been read. Before, it was cleared as soon as
  // the headers arrived, so a stalled body could hang a polling loop for minutes (or forever).
  for (const m of ["text", "json", "arrayBuffer"]) {
    if (typeof res[m] !== "function") continue;
    const orig = res[m].bind(res);
    res[m] = async () => {
      try { return await orig(); }
      catch (e) { throw (ctrl.signal.aborted || e.name === "AbortError") ? tErr() : e; }
      finally { clearTimeout(timer); }
    };
  }
  return res;
}
function withTimeout(promise, ms, label = "op") {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => { const e = new Error(`${label} timeout ${ms}ms`); e.code = "TIMEOUT"; rej(e); }, ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// ── extra tuning knobs (all optional in .env) ──
const FAST_GAP_MS = Number(env.FAST_GAP_MS || 350);          // gap for the priority lane (|tr, slash commands)
const STALL_MS = Number(env.STALL_MS || 45000);              // listener silent this long => auto-restart
const LEARN_TIMEOUT_MS = Number(env.LEARN_TIMEOUT_MS || 120000); // |learn waits this long for you to type commands in the web
const SLASH_GENERIC = env.SLASH_GENERIC !== "false";         // unknown /cmd => generic action text instead of dead plain text

// ══════════════════════════════════════════════════════════════
//  CLIENT-SIDE COMMANDS  (confirmed + best-guess)
// ══════════════════════════════════════════════════════════════
const DEFAULT_CLIENT_COMMANDS = {
  // ── CONFIRMED ────────────────────────────────────────────
  "/roll":       "**{username} rolls {roll}**",
  "/thank":      "**{username} thanks everyone! 🙏**",
  "/thanks":     "**{username} thanks everyone! 🙏**",
  "/sing":       "**{username} is singing a happy song, \"Wake up, shake up, it's a brand new day!\" 🎵**",
  "/boo":        "**{username} jumps out and boos everyone! 👻**",

  // ── GREETINGS ────────────────────────────────────────────
  "/hi":         "**{username} says hi! 👋**",
  "/hello":      "**{username} says hello! 👋**",
  "/bye":        "**{username} waves goodbye! 👋**",
  "/gm":         "**{username} says good morning! ☀️**",
  "/goodmorning":"**{username} says good morning! ☀️**",
  "/gn":         "**{username} says good night! 🌙**",
  "/goodnight":  "**{username} says good night! 🌙**",
  "/goodafternoon": "**{username} says good afternoon! ☀️**",
  "/goodevening":"**{username} says good evening! 🌆**",
  "/welcome":    "**{username} welcomes {arg:everyone}! 🎉**",
  "/welcomeall": "**{username} welcomes everyone! 🎉**",
  "/greet":      "**{username} greets {arg:everyone}! 👋**",
  "/salam":      "**{username} says salam! ☪️**",
  "/wb":         "**{username} welcomes {arg:you} back! 👋**",
  "/back":       "**{username} is back! 🎉**",
  "/afk":        "**{username} is AFK**",
  "/away":       "**{username} is away**",
  "/online":     "**{username} is online! 🟢**",
  "/busy":       "**{username} is busy**",
  "/lag":        "**{username} is lagging!**",
  "/brb":        "**{username} will be right back!**",
  "/tc":         "**{username} says take care! 💖**",
  "/takecare":   "**{username} says take care! 💖**",
  "/ty":         "**{username} thanks {arg:you}! 🙏**",
  "/gl":         "**{username} says good luck! 🍀**",

  // ── AFFECTION ────────────────────────────────────────────
  "/hug":        "**{username} hugs {arg:everyone}! 🤗**",
  "/cuddle":     "**{username} cuddles {arg:everyone}! 🥰**",
  "/embrace":    "**{username} embraces {arg:everyone}! 🤗**",
  "/kiss":       "**{username} kisses {arg:everyone}! 😘**",
  "/slap":       "**{username} slaps {arg:everyone}! 👋**",
  "/poke":       "**{username} pokes {arg:everyone}! 👉**",
  "/punch":      "**{username} punches {arg:everyone}! 👊**",
  "/pat":        "**{username} pats {arg:everyone}! 🤚**",
  "/wave":       "**{username} waves at {arg:everyone}! 👋**",
  "/tickle":     "**{username} tickles {arg:everyone}! 🤣**",
  "/pinch":      "**{username} pinches {arg:everyone}! 🫰**",
  "/bite":       "**{username} bites {arg:everyone}! 😬**",
  "/flower":     "**{username} gives {arg:everyone} a flower! 🌸**",
  "/rose":       "**{username} gives {arg:everyone} a rose! 🌹**",
  "/heart":      "**{username} sends love to {arg:everyone}! ❤️**",
  "/love":       "**{username} loves {arg:everyone}! ❤️**",
  "/teddy":      "**{username} gives {arg:everyone} a teddy bear! 🧸**",
  "/bearhug":    "**{username} bearhugs {arg:everyone}! 🐻**",
  "/french":     "**{username} gives {arg:everyone} a French kiss! 💋**",
  "/propose":    "**{username} proposes to {arg:everyone}! 💍**",

  // ── EMOTIONS ─────────────────────────────────────────────
  "/agree":      "**{username} agrees with {arg:everyone}! 👍**",
  "/disagree":   "**{username} disagrees with {arg:everyone}! 👎**",
  "/dance":      "**{username} is dancing! 💃**",
  "/cry":        "**{username} is crying! 😭**",
  "/laugh":      "**{username} laughs out loud! 😂**",
  "/clap":       "**{username} claps! 👏**",
  "/bow":        "**{username} bows gracefully! 🙇**",
  "/wink":       "**{username} winks! 😉**",
  "/smile":      "**{username} smiles! 😊**",
  "/frown":      "**{username} frowns! ☹️**",
  "/angry":      "**{username} is angry! 😠**",
  "/sad":        "**{username} is sad! 😢**",
  "/happy":      "**{username} is happy! 😊**",
  "/sleep":      "**{username} is sleeping 😴**",
  "/yawn":       "**{username} yawns! 🥱**",
  "/sorry":      "**{username} says sorry! 🙇**",
  "/shy":        "**{username} is shy! 😊**",
  "/blush":      "**{username} blushes! 😊**",
  "/flirt":      "**{username} flirts with {arg:everyone}! 😘**",
  "/confuse":    "**{username} is confused! 😕**",
  "/bored":      "**{username} is bored! 😴**",
  "/sigh":       "**{username} sighs… 😮‍💨**",
  "/phew":       "**{username} says phew! 😅**",
  "/surprise":   "**{username} is surprised! 😲**",
  "/faint":      "**{username} faints! 😵**",
  "/hmm":        "**{username} hmm… 🤔**",
  "/nod":        "**{username} nods**",
  "/smirk":      "**{username} smirks 😏**",
  "/giggle":     "**{username} giggles! 🤭**",
  "/grin":       "**{username} grins! 😁**",
  "/scare":      "**{username} scares {arg:everyone}! 😱**",
  "/scream":     "**{username} screams! 😱**",
  "/salute":     "**{username} salutes {arg:everyone}! 🫡**",
  "/respect":    "**{username} respects {arg:everyone}! 🫡**",
  "/honor":      "**{username} honors {arg:everyone}! 🏅**",
  "/proud":      "**{username} is proud of {arg:everyone}! 🥹**",

  // ── FOOD/DRINK ───────────────────────────────────────────
  "/coffee":     "**{username} drinks some coffee ☕**",
  "/beer":       "**{username} drinks a beer! 🍺**",
  "/cheers":     "**{username} cheers! 🥂**",
  "/chocolate":  "**{username} shares chocolate! 🍫**",
  "/cake":       "**{username} shares cake! 🎂**",
  "/hungry":     "**{username} is hungry! 🍔**",

  // ── TITLES ───────────────────────────────────────────────
  "/crown":      "**{username} wears a crown! 👑**",
  "/diamond":    "**{username} shows off a diamond! 💎**",
  "/gold":       "**{username} has gold! 🥇**",
  "/winner":     "**{username} is the winner! 🏆**",
  "/lose":       "**{username} lost! 😢**",
  "/loser":      "**{username} is a loser! 😝**",
  "/champion":   "**{username} is the champion! 🏆**",
  "/power":      "**{username} is powerful! 💪**",
  "/worthy":     "**{username} is worthy! ⚔️**",

  // ── SPECIAL ──────────────────────────────────────────────
  "/hbd":        "**{username} wishes {arg:you} a happy birthday! 🎂**",
  "/birthday":   "**{username} wishes {arg:you} a happy birthday! 🎂**",
  "/eid":        "**{username} wishes {arg:everyone} Eid Mubarak! 🌙**",
  "/getmyluck":  "**{username} has {random:100}% luck today! 🍀**",
  "/fortune":    "**{username} shakes the fortune ball: {random:100}! 🔮**",
  "/8ball":      "**{username} shakes the 8-ball: {random:20}! 🎱**",
  "/ball":       "**{username} shakes the 8-ball: {random:20}! 🎱**",
  "/me":         "**{username} {arg:does something}**",
};

let clientCommands = { ...DEFAULT_CLIENT_COMMANDS };

const DEFAULT_ALL_COMMANDS = [
  "/8ball","/afk","/agree","/angry","/argh","/away","/back","/ball","/bark","/bearhug",
  "/beer","/beggar","/behave","/beibei","/bestie","/bid","/birthday","/bite","/bless","/blowk",
  "/blush","/boo","/bored","/bow","/brb","/bro","/busy","/bye","/caff","/cake",
  "/challenge","/champion","/checktag","/cheer","/cheers","/chicken","/chocolate","/choking","/clap","/coffee",
  "/comfort","/confuse","/crown","/cry","/cuddle","/dance","/dhivehi","/diamond","/disagree","/doh",
  "/don","/drool","/drunk","/duck","/eh","/eid","/embrace","/faint","/fart","/flirt",
  "/flower","/fly","/football","/fortune","/freekick","/french","/frenzy","/friend","/frown","/ga",
  "/gaan","/garba","/ge","/gee","/geet","/getmyluck","/giggle","/git","/gl","/gm",
  "/gn","/go","/goal","/gold","/goodafternoon","/goodevening","/goodmorning","/goodnight","/greet","/grin",
  "/gyanu","/handball","/happy","/harubas","/hbd","/headache","/heart","/hello","/hfive","/hi",
  "/highfive","/hmm","/hold","/honor","/hospital","/huanhuan","/hug","/hum","/hungry","/ice",
  "/jingjing","/jump","/jungle","/karate","/kiss","/koba","/lag","/laugh","/listen","/lose",
  "/loser","/love","/lovekill","/luck","/martian","/massage","/me","/medal","/miss","/mmm",
  "/moo","/mumble","/mvsong","/nini","/nod","/offside","/online","/paint","/park","/parkfees",
  "/pat","/penalty","/phew","/pinch","/poetrybangla","/poetryfilipino","/poetryfootball","/poetryhindi","/poetrymv","/poetrynepal",
  "/poke","/power","/present","/propose","/proud","/puke","/punch","/purr","/pushpa","/record",
  "/red","/relax","/respect","/ring","/roll","/rose","/ruffle","/run","/sad","/salam",
  "/salute","/scare","/scream","/seduce","/shiver","/shmoo","/shy","/sick","/sigh","/sing",
  "/sis","/slap","/sleep","/smile","/smirk","/smoke","/sneeze","/snore","/sorry","/spit",
  "/spock","/squirt","/stare","/surprise","/takecare","/tantrum","/taunt","/tc","/teddy","/thanks",
  "/tickle","/torch","/tpyo","/trimmer","/ty","/typo","/unpark","/wave","/wb","/weed",
  "/welcome","/welcomeall","/whackit","/whiskey","/whistle","/whois","/whop","/win","/wink","/winner",
  "/worthy","/ws","/yawn","/yeah","/yellow","/yingying"
];

function loadClientCommands() {
  try {
    if (!fs.existsSync(CLIENT_COMMANDS_FILE)) {
      fs.writeFileSync(CLIENT_COMMANDS_FILE, JSON.stringify(DEFAULT_CLIENT_COMMANDS, null, 2), "utf8");
      log(`📝 Created client_commands.json (${Object.keys(DEFAULT_CLIENT_COMMANDS).length} templates)`);
      return;
    }
    const data = JSON.parse(fs.readFileSync(CLIENT_COMMANDS_FILE, "utf8"));
    clientCommands = { ...DEFAULT_CLIENT_COMMANDS, ...data };
    log(`📝 Loaded ${Object.keys(clientCommands).length} client-side templates`);
  } catch (e) { log(`⚠ load client_commands failed: ${e.message}`); }
}

function saveClientCommands() {
  try { fs.writeFileSync(CLIENT_COMMANDS_FILE, JSON.stringify(clientCommands, null, 2), "utf8"); return true; }
  catch (e) { log(`⚠ save client_commands failed: ${e.message}`); return false; }
}

function loadAllCommands() {
  try {
    if (!fs.existsSync(ALL_COMMANDS_FILE)) {
      fs.writeFileSync(ALL_COMMANDS_FILE, DEFAULT_ALL_COMMANDS.join("\n"), "utf8");
      log(`📝 Created all_commands.txt (${DEFAULT_ALL_COMMANDS.length} names)`);
      return;
    }
    const lines = fs.readFileSync(ALL_COMMANDS_FILE, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    log(`📝 all_commands.txt: ${lines.length} commands`);
  } catch (e) { log(`⚠ load all_commands failed: ${e.message}`); }
}

/**
 * Render a client-side /command.
 *
 * Placeholders:
 *   {username}        bot's name (e.g. fan)
 *   {arg}             everything after the command; if empty → "everyone"
 *   {args}            same as {arg}
 *   {arg:fallback}    explicit fallback for {arg} (overrides "everyone")
 *   {roll} {roll:N}   random 1..100 / 1..N (or 1..argN if arg is numeric)
 *   {random} {random:N}  same as roll
 *
 * Returns null if the command isn't in the map (caller falls back to plain text).
 */
// A template is a string, or { bare: "...", with: "..." } when the web text differs with/without a username.
function fillTemplate(template, username, args) {
  let rendered = template
    .replace(/\{username\}/g, username)
    .replace(/\{arg:([^}]+)\}/g, (_, fb) => args || fb)   // explicit fallback wins
    .replace(/\{arg\}/g, args || "everyone")              // no username given -> "everyone"
    .replace(/\{args\}/g, args || "everyone");
  rendered = rendered.replace(/\{roll:(\d+)\}/g, (_, n) => String(1 + Math.floor(Math.random() * Math.max(1, parseInt(n, 10) || 100))));
  if (rendered.includes("{roll}")) {
    const fromArgs = parseInt(args, 10);
    const max = (Number.isFinite(fromArgs) && fromArgs > 1) ? Math.min(fromArgs, 10000) : 100;
    rendered = rendered.replace(/\{roll\}/g, () => String(1 + Math.floor(Math.random() * max)));
  }
  rendered = rendered.replace(/\{random:(\d+)\}/g, (_, n) => String(1 + Math.floor(Math.random() * Math.max(1, parseInt(n, 10) || 100))));
  rendered = rendered.replace(/\{random\}/g, () => String(1 + Math.floor(Math.random() * 100)));
  return rendered;
}
// info-style commands that make no sense as "fan <verb>s": never use the generic text for these
const GENERIC_SKIP = /^\/(whois|checktag|record|mvsong|poetry\w*|park\w*|unpark|trimmer|bid|challenge)$/;
function thirdPerson(v) {
  if (v === "go") return "goes";
  if (/(s|x|z|ch|sh)$/.test(v)) return v + "es";
  if (/[^aeiou]y$/.test(v)) return v.slice(0, -1) + "ies";
  return v + "s";
}
const normalizeArgs = (raw) => (raw || "").replace(/(^|\s)@(?=\S)/g, "$1").replace(/\s+/g, " ").trim();

/**
 * Render a client-side /command — works WITH and WITHOUT a username:
 *   /agree        -> **fan agrees with everyone! 👍**
 *   /agree vip    -> **fan agrees with vip! 👍**
 *   /jump         -> (no template) generic: **fan jumps!**      /jump vip -> **fan jumps vip!**
 * Returns { body, generic, cmd } or null when the text is not a /command (or generic is disabled/skipped).
 */
function renderSlash(username, text, { generic = SLASH_GENERIC } = {}) {
  if (!text) return null;
  const m = text.trim().match(/^(\/[A-Za-z0-9_]+)(?:\s+([\s\S]+))?$/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const args = normalizeArgs(m[2]);
  let tpl = clientCommands[cmd], isGeneric = false;
  if (tpl && typeof tpl === "object") tpl = args ? (tpl.with || tpl.bare) : (tpl.bare || tpl.with);
  if (!tpl) {
    if (!generic || GENERIC_SKIP.test(cmd)) return null;
    const v = thirdPerson(cmd.slice(1));
    tpl = args ? `**{username} ${v} {arg}!**` : `**{username} ${v}!**`;
    isGeneric = true;
  }
  return { body: fillTemplate(tpl, username, args), generic: isGeneric, cmd };
}
/** exact-template render only (kept for backward compatibility) */
function renderClientCommand(username, text) { const r = renderSlash(username, text, { generic: false }); return r ? r.body : null; }

/** Turn a message the web wrote ("**vip hugs onik! 🤗**") into a template using the sender / target names. */
function deriveTemplate(text, sender, arg) {
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let t = String(text).trim().replace(new RegExp(esc(sender), "gi"), "\u0001U\u0001");
  if (arg) t = t.replace(new RegExp(esc(arg), "gi"), "\u0001A\u0001");
  return t.replace(/\u0001U\u0001/g, "{username}").replace(/\u0001A\u0001/g, "{arg:everyone}");
}

// ══════════════════════════════════════════════════════════════
//  FILE STATE HELPERS
// ══════════════════════════════════════════════════════════════
function loadLines(file) {
  try {
    const p = path.isAbsolute(file) ? file : path.join(__dirname, file);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  } catch (e) { log(`[${file}] load error: ${e.message}`); return []; }
}

let slangWords = [];
function loadSlang() { slangWords = loadLines(SLANG_FILE).map((w) => w.toLowerCase()); log(`📋 Loaded ${slangWords.length} slang words`); }
function saveSlang() { try { fs.writeFileSync(SLANG_FILE, slangWords.join("\n"), "utf8"); } catch (e) { log(`slang save: ${e.message}`); } }

let slangGlobalOn = false;
const slangRoomOverrides = new Map();

function loadSlangHistory() { try { if (!fs.existsSync(SLANG_HISTORY_FILE)) return {}; return JSON.parse(fs.readFileSync(SLANG_HISTORY_FILE, "utf8")); } catch { return {}; } }
function saveSlangHistory(h) { try { fs.writeFileSync(SLANG_HISTORY_FILE, JSON.stringify(h, null, 2), "utf8"); } catch (e) { log(`slang history save: ${e.message}`); } }
function addSlangViolation(username, room) {
  const h = loadSlangHistory();
  const u = username.toLowerCase();
  if (!h[u]) h[u] = { count: 0, lastViolation: 0, warnings: 0 };
  h[u].count++; h[u].lastViolation = Date.now();
  const count = h[u].count; let action = null;
  if (count === 3) { action = "warning"; h[u].warnings++; }
  else if (count >= 4) { action = "bump"; h[u].count = 0; }
  saveSlangHistory(h);
  try { fs.appendFileSync(SLANG_LOG_FILE, `[${new Date().toISOString()}] Room ${room} | @${username} | Count: ${count} | Action: ${action || "none"}\n`, "utf8"); } catch {}
  return { action, count };
}

function loadGiftUsers() { try { if (!fs.existsSync(GIFTUSERS_FILE)) return {}; return JSON.parse(fs.readFileSync(GIFTUSERS_FILE, "utf8")); } catch { return {}; } }
function saveGiftUsers(u) { try { fs.writeFileSync(GIFTUSERS_FILE, JSON.stringify(u, null, 2), "utf8"); } catch (e) { log(`gift users save: ${e.message}`); } }
function loadTrigger() { try { return fs.readFileSync(TRIGGER_FILE, "utf8").trim() || TRIGGER_DEFAULT; } catch { return TRIGGER_DEFAULT; } }
function saveTrigger(t) { try { fs.writeFileSync(TRIGGER_FILE, t, "utf8"); } catch {} }

function applyAutoTextDefaults(acc, fallbackRooms = []) {
  if (!AUTO_TEXT_ON) return;
  if (!acc.autoTextMessages.length) acc.autoTextMessages = loadLines(AT_FILE);
  if (!acc.autoTextMessages.length) { log(`⚠ [${acc.username}] auto-text ON but at.txt is empty`); return; }
  acc.autoTextInterval = AUTO_TEXT_INTERVAL;
  const rooms = AUTO_TEXT_ROOMS.length ? AUTO_TEXT_ROOMS : (fallbackRooms || []);
  for (const r of rooms) acc.autoTextRooms.add(r);
  if (!acc.autoTextRooms.size) { log(`⚠ [${acc.username}] auto-text ON but no rooms`); return; }
  acc.autoTextOn = true;
  log(`📝 [${acc.username}] auto-text ON (${acc.autoTextMessages.length} msgs, ${acc.autoTextInterval}m, rooms: ${[...acc.autoTextRooms].join(",")})`);
}

function applyAwgiftDefaults(acc, fallbackRooms = []) {
  if (!AWGIFT_ON) return;
  const rooms = AWGIFT_ROOMS.length ? AWGIFT_ROOMS : (fallbackRooms || []);
  if (!rooms.length) { log(`⚠ [${acc.username}] AWGIFT_ON but no rooms`); return; }
  for (const r of rooms) acc.awgiftRooms.add(r);
  acc.awgiftOn = true;
  log(`🎁 [${acc.username}] auto-gift ON (gift:"${acc.awgiftName}", cd:${acc.awgiftCooldownHours}h)`);
}

function extractEntryUser(text, fallbackSender) {
  if (!text) return fallbackSender || null;
  let m = text.match(/:\s*(.+?)\s*\[\d+\]/); if (m) return m[1].trim();
  m = text.match(/:\s*(.+?)\s+has\s+entered/i); if (m) return m[1].trim();
  return fallbackSender || null;
}

let cachedIP = null;
async function getPublicIP() {
  if (cachedIP) return cachedIP;
  try { const r = await fetchT("https://api.ipify.org?format=json"); cachedIP = (await r.json()).ip; return cachedIP; } catch { return "unknown"; }
}

// ══════════════════════════════════════════════════════════════
//  HTTP + AUTH
// ══════════════════════════════════════════════════════════════
const HEADERS = {
  "Content-Type": "application/json", Origin: ORIGIN, Referer: ORIGIN + "/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

async function http_(url, { method = "POST", body, headers = {}, form = false, timeoutMs } = {}) {
  const h = { ...HEADERS, ...headers };
  if (form) h["Content-Type"] = "application/x-www-form-urlencoded";
  const res = await fetchT(url, { method, headers: h, body: body === undefined ? undefined : form ? body : JSON.stringify(body) }, timeoutMs || HTTP_TIMEOUT_MS);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const detail = typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data.error || data).slice(0, 300);
    const err = new Error(`HTTP ${res.status} ${url.split("?")[0]} — ${detail}`);
    err.status = res.status; err.body = data; throw err;
  }
  return data;
}

function getDeviceId() {
  const f = path.join(__dirname, ".deviceid");
  try { return fs.readFileSync(f, "utf8").trim(); } catch {}
  const id = "web_" + crypto.randomBytes(8).toString("hex");
  try { fs.writeFileSync(f, id); } catch {}
  return id;
}

class Session {
  constructor(username, password) {
    this.username = username; this.password = password;
    this.idToken = null; this.refreshToken = null; this.uid = null; this.exp = 0;
    this.deviceId = getDeviceId(); this.rooms = new Map();
  }
  // login()/refresh() are single-flight: if 10 requests notice an expired token at once, only ONE network call is made
  login() {
    if (this._loginP) return this._loginP;
    const email = `${this.username.toLowerCase()}@${EMAIL_DOMAIN}`;
    this._loginP = (async () => {
      const r = await http_(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
        body: { email, password: this.password, returnSecureToken: true, clientType: "CLIENT_TYPE_WEB" },
      });
      this.idToken = r.idToken; this.refreshToken = r.refreshToken; this.uid = r.localId;
      this.exp = Date.now() + Number(r.expiresIn || 3600) * 1000; return this;
    })().finally(() => { this._loginP = null; });
    return this._loginP;
  }
  refresh() {
    if (this._refP) return this._refP;
    this._refP = (async () => {
      try {
        const r = await http_(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, { form: true, body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.refreshToken)}` });
        this.idToken = r.id_token; this.refreshToken = r.refresh_token;
        this.exp = Date.now() + Number(r.expires_in || 3600) * 1000;
      } catch { await this.login(); }
    })().finally(() => { this._refP = null; });
    return this._refP;
  }
  async token() {
    if (!this.idToken) await this.login();
    else if (Date.now() > this.exp - 120_000) await this.refresh();
    return this.idToken;
  }
}

// ══════════════════════════════════════════════════════════════
//  FIRESTORE
// ══════════════════════════════════════════════════════════════
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

async function authed(session, url, opts = {}) {
  const attempt = async () => { const t = await session.token(); return http_(url, { ...opts, headers: { Authorization: `Bearer ${t}` }, timeoutMs: opts.timeoutMs || (opts.idempotent ? Math.min(HTTP_TIMEOUT_MS, 10000) : undefined) }); };
  try { return await attempt(); }
  catch (e) {
    if (e.status === 401) { await session.login(); return attempt(); } // ONE retry (used to loop without limit)
    // reads are safe to repeat once after a timeout / dropped connection
    if (opts.idempotent && (e.code === "TIMEOUT" || /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR|socket/i.test(e.message || ""))) return attempt();
    throw e;
  }
}
const commit = (session, writes) => authed(session, `${DOCS}:commit`, { body: { writes } });
const docName = (p) => `${DB}/documents/${p}`;
const REQ_TIME = (fieldPath) => ({ fieldPath, setToServerValue: "REQUEST_TIME" });

async function runRootQuery(session, structuredQuery) {
  const rows = await authed(session, `${DOCS}:runQuery`, { idempotent: true, body: { structuredQuery } });
  return rows.filter((r) => r.document).map((r) => r.document);
}
async function runRoomQuery(session, room, structuredQuery) {
  const rows = await authed(session, `${DOCS}/room_messages/${encodeURIComponent(room)}:runQuery`, { idempotent: true, body: { structuredQuery } });
  return rows.filter((r) => r.document).map((r) => r.document);
}
const latestMessages = (session, room, n = 30) => runRoomQuery(session, room, {
  from: [{ collectionId: "messages" }],
  orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }, { field: { fieldPath: "__name__" }, direction: "DESCENDING" }],
  limit: n,
});
const newMessages = (session, room, afterIso) => runRoomQuery(session, room, {
  from: [{ collectionId: "messages" }],
  where: { fieldFilter: { field: { fieldPath: "createdAt" }, op: "GREATER_THAN", value: { timestampValue: afterIso } } },
  orderBy: [{ field: { fieldPath: "createdAt" }, direction: "ASCENDING" }],
  limit: 50,
});
async function fetchRoomUsers(session, room, max = 100) {
  const rows = await authed(session, `${DOCS}/room_presence/${encodeURIComponent(room)}:runQuery`, { idempotent: true, body: { structuredQuery: { from: [{ collectionId: "users" }], limit: max } } });
  return rows.filter((r) => r.document).map((r) => decFields(r.document.fields))
    .filter((f) => f && typeof f.username === "string" && f.username).map((f) => f.username);
}
async function listRooms(session) {
  const docs = await runRootQuery(session, { from: [{ collectionId: "rooms" }], limit: 500 });
  return docs.map((d) => { let id = d.name.split("/").pop(); try { id = decodeURIComponent(id); } catch {} return id; });
}
async function findUserUid(session, username) {
  const docs = await runRootQuery(session, {
    from: [{ collectionId: "users" }],
    where: { fieldFilter: { field: { fieldPath: "usernameLower" }, op: "EQUAL", value: { stringValue: username.toLowerCase() } } }, limit: 1,
  });
  return docs[0] ? docs[0].name.split("/").pop() : null;
}
async function goOnline(session) {
  const name = docName(`users/${session.uid}`);
  await commit(session, [
    { update: { name, fields: encFields({ isInvisible: false, presenceStatus: "ONLINE" }) }, updateMask: { fieldPaths: ["isInvisible", "presenceStatus"] } },
    { update: { name }, updateMask: { fieldPaths: [] }, updateTransforms: [REQ_TIME("lastActiveAt")] },
  ]);
}
const touchActive = (session) => commit(session, [{ update: { name: docName(`users/${session.uid}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [REQ_TIME("lastActiveAt")] }]);

async function joinRoom(session, room, { announce = true } = {}) {
  const me = await authed(session, `${DOCS}/users/${session.uid}`, { method: "GET", idempotent: true });
  const u = decFields(me.fields); const level = u.level ?? 1;
  const visitId = crypto.randomBytes(6).toString("hex");
  const fields = { uid: session.uid, username: session.username, activity: "", level, levelBadgeIcon: u.levelBadgeIcon || "", shopBadges: Array.isArray(u.shopBadges) ? u.shopBadges : [], presenceStatus: "ONLINE", visitId, deviceId: session.deviceId };
  await commit(session, [{ update: { name: docName(`room_presence/${room}/users/${session.uid}`), fields: encFields(fields) }, updateMask: { fieldPaths: Object.keys(fields).sort() }, updateTransforms: [REQ_TIME("lastSeen"), REQ_TIME("entryMarker")] }]);
  session.rooms.set(room, { visitId, level });
  if (announce) await commit(session, [{ update: { name: docName(`room_messages/${room}/messages/${autoId()}`), fields: encFields({ text: `${room}: ${session.username} [${level}] has entered.`, sender: session.username, senderUid: session.uid, type: "room_entry" }) }, updateTransforms: [REQ_TIME("createdAt")], currentDocument: { exists: false } }]);
  return { level, visitId };
}
async function leaveRoom(session, room) {
  const info = session.rooms.get(room); if (!info) return;
  await commit(session, [{ update: { name: docName(`room_messages/${room}/messages/leave_${session.uid}_${info.visitId}`), fields: encFields({ text: `${room}: ${session.username} [${info.level}] has left.`, sender: session.username, senderUid: session.uid, type: "room_leave" }) }, updateTransforms: [REQ_TIME("createdAt")] }]);
  session.rooms.delete(room);
}
const presence = (session, room) => commit(session, [{ update: { name: docName(`room_presence/${room}/users/${session.uid}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [REQ_TIME("lastSeen")], currentDocument: { exists: true } }]);
const sendMessage = (session, room, text, { type = "chat" } = {}) => commit(session, [{ update: { name: docName(`room_messages/${room}/messages/${autoId()}`), fields: encFields({ text, sender: session.username, senderUid: session.uid, type, giftName: "", clientCreatedAt: Date.now() }) }, updateTransforms: [REQ_TIME("createdAt")], currentDocument: { exists: false } }]);

// ══════════════════════════════════════════════════════════════
//  CLOUD FUNCTIONS
// ══════════════════════════════════════════════════════════════
async function callFunction(session, name, data = null) {
  const attempt = async () => {
    const token = await session.token();
    const res = await fetchT(`${FUNCTIONS_BASE}/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: ORIGIN, Referer: ORIGIN + "/", "User-Agent": HEADERS["User-Agent"] },
      body: JSON.stringify({ data }),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok || (json && json.error)) {
      const msg = json?.error?.message || (typeof json === "string" ? json.slice(0, 200) : JSON.stringify(json).slice(0, 200));
      const err = new Error(msg); err.status = res.status; err.code = json?.error?.status; throw err;
    }
    return json.result;
  };
  try { return await attempt(); }
  catch (e) { if (e.status === 401) { await session.login(); return attempt(); } throw e; }
}
const isNotFound = (e) => e && (e.status === 404 || e.code === "NOT_FOUND" || /not found|does not exist|unknown function/i.test(e.message || ""));
const hasAI = () => !!(env.AI_API_KEY || env.MISTRAL_API_KEY);

// ══════════════════════════════════════════════════════════════
//  ACCOUNT CLASS
// ══════════════════════════════════════════════════════════════
class Account {
  constructor(username, password, { isMain = false, log: lg = log } = {}) {
    this.username = username; this.isMain = isMain; this.log = (m) => lg(`[${username}] ${m}`);
    this.session = new Session(username, password);
    this.rooms = new Set(); this.q = Promise.resolve(); this.qf = Promise.resolve(); this.hb = null;
    this.onJoin = null; this.onLeave = null;
    this.queueDepth = 0;
    this.warnedCmds = new Set();  // ← don't spam log for same unknown cmd

    this.voucherOn = true;
    this.autoReplyOn = AUTO_REPLY_ON;
    this.triggerKeyword = loadTrigger() || "";
    this.awOn = WELCOME_ON; this.awRooms = new Set();
    this.awTemplate = WELCOME_TEXT; this.awMessages = new Map();

    this.autoTextOn = false; this.autoTextRooms = new Set();
    this.autoTextMessages = []; this.autoTextIndex = new Map();
    this.autoTextInterval = 5; this.autoTextTimer = null;

    this.floodActive = false; this.floodRoomId = null; this.floodMessages = []; this.floodIndex = 0;
    this.floodInterval = null; this.floodMode = "custom"; this.floodCustomText = ""; this.floodMessageCount = 0;

    this.awgiftOn = false; this.awgiftRooms = new Set();
    this.awgiftName = AWGIFT_NAME; this.awgiftMessage = AWGIFT_MESSAGE; this.awgiftCooldownHours = AWGIFT_COOLDOWN_HOURS;

    this.giftOn = false; this.giftRooms = new Set();
    this.giftName = AWGIFT_NAME; this.giftInterval = 60; this.giftTimer = null;
  }

  async start() {
    await this.session.login(); await goOnline(this.session);
    this.hb = setInterval(() => this.beat(), PRESENCE_MS);
    this.log(`✔ logged in (uid ${this.session.uid})`);
  }
  beat() {
    withTimeout(touchActive(this.session), 10000, "heartbeat").catch(() => {});
    for (const r of this.rooms) withTimeout(presence(this.session, r), 10000, "presence").catch(() => joinRoom(this.session, r, { announce: false }).catch(() => {}));
  }
  async join(room) {
    if (this.rooms.has(room)) return { already: true };
    const r = await joinRoom(this.session, room, { announce: ANNOUNCE_JOIN });
    this.rooms.add(room); this.log(`+ joined ${room} (level ${r.level})`);
    if (this.onJoin) this.onJoin(room);
    if (this.autoTextOn && this.autoTextRooms.has(room)) this.startAutoText();
    return r;
  }
  async leave(room) {
    if (!this.rooms.has(room)) return false;
    this.rooms.delete(room); if (this.onLeave) this.onLeave(room);
    await leaveRoom(this.session, room).catch(() => {});
    this.log(`- left ${room}`); return true;
  }

  // ── send text; intercepts /gift, renders client cmds, warns unknown ──
  say(room, text, opts = {}) {
    if (!this.rooms.has(room)) return Promise.reject(new Error(`not in room ${room}`));

    if (!opts.raw) {
      const trimmed = text.trim();
      if (/^\/gift\b/i.test(trimmed)) {
        this._sendGiftCommand(room, trimmed.slice(5).trim())
          .catch((e) => this.log(`⚠ /gift failed: ${e.message.slice(0, 100)}`));
        return Promise.resolve();
      }
    }

    let body, rendered = false;
    if (opts.raw) body = text;
    else {
      const r = renderSlash(this.username, text);
      if (r) {
        body = r.body; rendered = true;
        if (r.generic && !this.warnedCmds.has(r.cmd)) {
          this.warnedCmds.add(r.cmd);
          this.log(`ℹ ${r.cmd}: no exact template yet — sent generic text. Teach the real one: |learn <Room> ${r.cmd} <user>`);
        }
      } else body = `${this.username}: ${text}`;
    }

    const send = () => sendMessage(this.session, room, body, { type: opts.type || "chat" });
    // two lanes: "q" = bulk (auto-text, welcome…)   "qf" = fast priority lane (|tr, slash commands)
    const lane = opts.fast ? "qf" : "q"; const gap = opts.fast ? FAST_GAP_MS : SEND_GAP_MS;
    const p = opts.now ? send() : this[lane].then(send);

    if (!opts.now) {
      this.queueDepth++;
      this[lane] = Promise.race([p.catch(() => {}), sleep(SEND_TIMEOUT_MS)]).catch(() => {}).then(() => {
        this.queueDepth--;
        return sleep(gap);
      });
    }

    const shown = rendered ? body : text;
    return withTimeout(p, SEND_TIMEOUT_MS, "sendMessage")
      .then(() => this.log(`→ [${room}] ${shown.slice(0, 80)}${rendered ? " (rendered)" : ""}`))
      .catch((e) => {
        if (e.code === "TIMEOUT") this.log(`⚠ send timeout: "${shown.slice(0, 40)}"`);
        throw e;
      });
  }

  async _sendGiftCommand(room, args) {
    const parts = (args || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) { this.log(`⚠ /gift missing args`); return; }
    const msgIdx = parts.indexOf("-m");
    const message = msgIdx >= 0 ? parts.slice(msgIdx + 1).join(" ").trim() : "";
    const head = msgIdx >= 0 ? parts.slice(0, msgIdx) : parts;

    if (head[0] && head[0].toLowerCase() === "all") {
      const giftName = head[1];
      if (!giftName) { this.log(`⚠ /gift all missing giftName`); return; }
      let users; try { users = await withTimeout(fetchRoomUsers(this.session, room), GIFT_TIMEOUT_MS, "fetchRoomUsers"); }
      catch (e) { this.log(`✖ fetch users: ${e.message.slice(0, 100)}`); return; }
      if (!users.length) { this.log(`⚠ no users in [${room}]`); return; }
      const payload = { roomId: room, targets: users, giftName, message, postRoomLine: AWGIFT_POST_LINE };
      try {
        const result = await withTimeout(callFunction(this.session, FN_GIFT_SHOWER, payload), GIFT_TIMEOUT_MS, "sendGiftShower");
        const r = result || {};
        this.log(`🎁 shower [${room}] "${giftName}" → ${r.recipientCount ?? users.length} rcpt, cost:${r.totalCost ?? "?"} ✓`);
      } catch (e) { this.log(`✖ shower [${room}]: ${e.message.slice(0, 120)}`); }
      return;
    }
    const [target, giftName] = head;
    if (!target || !giftName) { this.log(`⚠ /gift <user> <giftName>`); return; }
    const payload = { roomId: room, target, giftName, message, postRoomLine: AWGIFT_POST_LINE };
    try {
      const result = await withTimeout(callFunction(this.session, FN_GIFT, payload), GIFT_TIMEOUT_MS, "sendGift");
      const r = result || {};
      this.log(`🎁 gift [${room}] @${target} "${giftName}" ✓ cost:${r.totalCost ?? "?"} level:${r.recipientLevel ?? "?"}`);
    } catch (e) { this.log(`✖ gift [${room}]: ${e.message.slice(0, 120)}`); }
  }

  async cmd(room, fnName, payload, chatFallback) {
    try {
      const result = await withTimeout(callFunction(this.session, fnName, payload), CMD_TIMEOUT_MS, fnName);
      this.log(`⚙ [${room}] ${fnName}() ✅ ${JSON.stringify(result).slice(0, 100)}`);
      return { mode: "function", result };
    } catch (e) {
      if (isNotFound(e)) { this.log(`⚠ [${room}] "${fnName}" NOT FOUND — chat fallback`); this.say(room, chatFallback, { raw: false, now: true }).catch(() => {}); return { mode: "chat" }; }
      this.log(`✖ [${room}] ${fnName}: ${e.message.slice(0, 120)}`); throw e;
    }
  }

  async stop() {
    clearInterval(this.hb); this.stopAutoText(); this.stopFlood(); this.stopGift();
    for (const r of [...this.rooms]) await this.leave(r);
  }

  startAutoText() {
    if (this.autoTextTimer) return;
    if (!this.autoTextOn || !this.autoTextMessages.length || !this.autoTextRooms.size) return;
    const tick = () => {
      if (!this.autoTextOn) return;
      for (const rid of this.autoTextRooms) {
        if (!this.rooms.has(rid)) continue;
        let i = this.autoTextIndex.get(rid) || 0; if (i >= this.autoTextMessages.length) i = 0;
        this.say(rid, this.autoTextMessages[i]).catch(() => {});
        this.autoTextIndex.set(rid, i + 1);
      }
      this.autoTextTimer = setTimeout(tick, this.autoTextInterval * 60_000);
    };
    tick(); this.log(`📝 Auto-text started (${this.autoTextMessages.length} msgs, ${this.autoTextInterval}m)`);
  }
  stopAutoText() { if (this.autoTextTimer) { clearTimeout(this.autoTextTimer); this.autoTextTimer = null; } }
  setAutoTextInterval(min) { this.autoTextInterval = min; if (this.autoTextOn) { this.stopAutoText(); this.startAutoText(); } }

  startCustomFlood(room, text) {
    this.stopFlood(); this.floodActive = true; this.floodRoomId = room; this.floodMode = "custom";
    this.floodCustomText = text; this.floodMessageCount = 0;
    this.log(`🌊 FLOOD [${room}]`);
    const tick = () => {
      if (!this.floodActive || !this.rooms.has(room)) { this.stopFlood(); return; }
      this.say(room, this.floodCustomText, { now: true }).catch(() => {});
      this.floodMessageCount++;
      this.floodInterval = setTimeout(tick, FLOOD_INTERVAL_MS);
    };
    tick(); return true;
  }
  startAutoFlood(room) {
    this.stopFlood(); const msgs = loadLines(FLOOD_FILE);
    if (!msgs.length) { this.log("❌ flood.txt empty"); return false; }
    this.floodMessages = msgs; this.floodActive = true; this.floodRoomId = room;
    this.floodMode = "auto"; this.floodIndex = 0; this.floodMessageCount = 0;
    this.log(`🌊 AUTO FLOOD [${room}] ${msgs.length} msgs`);
    const tick = () => {
      if (!this.floodActive || !this.rooms.has(room)) { this.stopFlood(); return; }
      if (this.floodIndex >= this.floodMessages.length) this.floodIndex = 0;
      this.say(room, this.floodMessages[this.floodIndex++], { now: true }).catch(() => {});
      this.floodMessageCount++;
      this.floodInterval = setTimeout(tick, FLOOD_INTERVAL_MS);
    };
    tick(); return true;
  }
  stopFlood() {
    if (this.floodInterval) { clearTimeout(this.floodInterval); this.floodInterval = null; }
    if (this.floodActive) this.log(`🛑 FLOOD STOPPED [${this.floodRoomId}]`);
    this.floodActive = false; this.floodRoomId = null; this.floodMessages = []; this.floodIndex = 0;
    this.floodMode = "custom"; this.floodCustomText = ""; this.floodMessageCount = 0;
  }
  floodStatus() {
    if (!this.floodActive) return "🔴 OFF";
    return this.floodMode === "custom" ? `🌊 CUSTOM [${this.floodRoomId}] sent:${this.floodMessageCount}` : `🌊 AUTO [${this.floodRoomId}] sent:${this.floodMessageCount}`;
  }

  startGift() {
    if (this.giftTimer) return;
    if (!this.giftOn || !this.giftRooms.size) return;
    const tick = async () => {
      if (!this.giftOn) return;
      for (const rid of this.giftRooms) {
        if (!this.rooms.has(rid)) { this.join(rid).catch(() => {}); continue; }
        try {
          const users = await withTimeout(fetchRoomUsers(this.session, rid), GIFT_TIMEOUT_MS, "fetchRoomUsers");
          if (!users.length) { this.log(`⚠ no users in [${rid}]`); continue; }
          const payload = { roomId: rid, targets: users, giftName: this.giftName, message: "", postRoomLine: AWGIFT_POST_LINE };
          const result = await withTimeout(callFunction(this.session, FN_GIFT_SHOWER, payload), GIFT_TIMEOUT_MS, "sendGiftShower");
          const r = result || {};
          this.log(`🎁 shower [${rid}] "${this.giftName}" → ${r.recipientCount ?? users.length} rcpt, cost:${r.totalCost ?? "?"} ✓`);
        } catch (e) { this.log(`✖ shower [${rid}]: ${e.message.slice(0, 100)}`); }
      }
      this.giftTimer = setTimeout(tick, this.giftInterval * 1000);
    };
    tick(); this.log(`🎁 Gift broadcast started (${this.giftName}, ${this.giftInterval}s)`);
  }
  stopGift() { if (this.giftTimer) { clearTimeout(this.giftTimer); this.giftTimer = null; } this.giftOn = false; }
  setGiftInterval(sec) { this.giftInterval = Math.max(1, sec); if (this.giftOn) { if (this.giftTimer) clearTimeout(this.giftTimer); this.giftTimer = null; this.startGift(); } }

  reset() {
    this.q = Promise.resolve(); this.qf = Promise.resolve();
    this.queueDepth = 0;
    this.stopFlood(); this.stopGift(); this.stopAutoText();
    if (this.autoTextOn && this.autoTextMessages.length) this.startAutoText();
    if (this.giftOn) this.startGift();
  }
}

// ══════════════════════════════════════════════════════════════
//  MANAGER
// ══════════════════════════════════════════════════════════════
class Manager {
  constructor(main, { maxAccounts = MAX_ACCOUNTS, log: lg = log } = {}) {
    this.main = main; this.maxAccounts = maxAccounts; this.log = lg;
    this.accounts = new Map([[main.username.toLowerCase(), main]]);
    this.active = "main"; this.knownRooms = new Set();
    this.autoPick = { global: AUTO_PICK, rooms: new Map(), sent: 0 };
  }
  get(u) { return this.accounts.get((u || "").toLowerCase()); }
  list() { return [...this.accounts.values()]; }
  targets() {
    if (this.active === "main") return [this.main];
    if (this.active === "all") return this.list();
    return [...this.active].map((u) => this.accounts.get(u)).filter(Boolean);
  }
  async add(username, password) {
    if (this.get(username)) throw new Error("already logged in");
    if (this.accounts.size >= this.maxAccounts) throw new Error(`account limit (${this.maxAccounts})`);
    const acc = new Account(username, password, { log: this.log });
    await acc.start(); applyAutoTextDefaults(acc, this.allKnownRooms()); applyAwgiftDefaults(acc, this.allKnownRooms());
    this.accounts.set(username.toLowerCase(), acc); return acc;
  }
  async remove(username) {
    const acc = this.get(username); if (!acc) throw new Error("not logged in");
    if (acc === this.main) throw new Error("cannot log out the main bot account");
    await acc.stop(); this.accounts.delete(username.toLowerCase());
    if (this.active instanceof Set) { this.active.delete(username.toLowerCase()); if (!this.active.size) this.active = "main"; }
  }
  allKnownRooms() {
    const s = new Set(this.knownRooms);
    for (const a of this.list()) a.rooms.forEach((r) => s.add(r));
    return [...s];
  }
  async stopAll() { for (const a of this.list().reverse()) await a.stop().catch(() => {}); }
}

// ══════════════════════════════════════════════════════════════
//  COMMANDS
// ══════════════════════════════════════════════════════════════
function splitFirst(s) { const i = s.search(/\s/); return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i).trim()]; }
function matchRoom(input, known) {
  const li = input.toLowerCase();
  for (const k of [...known].sort((a, b) => b.length - a.length)) {
    const lk = k.toLowerCase();
    if (li === lk) return { room: k, rest: "" };
    if (li.startsWith(lk + " ")) return { room: k, rest: input.slice(k.length).trim() };
  }
  const [room, rest] = splitFirst(input); return { room, rest };
}
function friendlyError(e) {
  const m = String(e.message || e);
  if (/INVALID_LOGIN_CREDENTIALS|EMAIL_NOT_FOUND|INVALID_PASSWORD|INVALID_EMAIL/.test(m)) return "wrong username or password";
  if (/TOO_MANY_ATTEMPTS/.test(m)) return "too many attempts";
  if (/USER_DISABLED/.test(m)) return "account disabled";
  if (/PERMISSION_DENIED/.test(m)) return "permission denied";
  if (/TIMEOUT/.test(m)) return "operation timed out";
  return m.replace(/https?:\/\/\S+/g, "").slice(0, 140);
}
function extractTargets(arg, mgr) {
  const matches = [...arg.matchAll(/\$(\w+)/g)]; if (!matches.length) return null;
  const targets = []; let isAll = false;
  for (const m of matches) {
    const tok = m[1].toLowerCase();
    if (tok === "aa" || tok === "all") { isAll = true; break; }
    else if (tok === "main") targets.push(mgr.main);
    else { const acc = mgr.get(tok); if (acc) targets.push(acc); }
  }
  return { targets, isAll, cleaned: arg.replace(/\s*\$\w+/g, "").trim() };
}
async function onTargets(mgr, fn) {
  const targets = mgr.targets(); if (!targets.length) return "❌ no active accounts";
  // all accounts run IN PARALLEL (was one-after-another: 10 accounts = 10x slower)
  const lines = await Promise.all(targets.map(async (acc) => {
    try { return `✅ @${acc.username}: ${await withTimeout(fn(acc), CMD_TIMEOUT_MS, "cmd")}`; }
    catch (e) { return `❌ @${acc.username}: ${friendlyError(e)}`; }
  }));
  return lines.join("\n");
}
const canonical = (mgr, room) => mgr.allKnownRooms().find((k) => k.toLowerCase() === room.toLowerCase()) || room;

const COMMANDS = {
  async lnu(mgr, arg) {
    const i = arg.indexOf(":"); if (i < 1 || i === arg.length - 1) return "Usage: |lnu username:password";
    const username = arg.slice(0, i).trim(); const password = arg.slice(i + 1).trim();
    try { const acc = await mgr.add(username, password); return `✅ @${acc.username} logged in (${mgr.list().length})`; }
    catch (e) { return `❌ login failed @${username}: ${friendlyError(e)}`; }
  },
  async ltu(mgr, arg) {
    const u = arg.trim().replace(/^@/, ""); if (!u) return "Usage: |ltu username";
    try { await mgr.remove(u); return `✅ @${u} logged out`; } catch (e) { return `❌ ${friendlyError(e)}`; }
  },
  async jn(mgr, arg) {
    if (!arg) return "Usage: |jn <Room>"; const room = canonical(mgr, arg);
    return onTargets(mgr, async (acc) => ((await acc.join(room)).already ? `already in ${room}` : `joined ${room}`));
  },
  async lr(mgr, arg) {
    if (!arg) return "Usage: |lr <Room> | |lr all";
    if (arg.toLowerCase() === "all") return onTargets(mgr, async (acc) => { const n = acc.rooms.size; for (const r of [...acc.rooms]) await acc.leave(r); return `left ${n}`; });
    return onTargets(mgr, async (acc) => {
      const room = [...acc.rooms].find((r) => r.toLowerCase() === arg.toLowerCase()) || arg;
      return (await acc.leave(room)) ? `left ${room}` : `was not in ${room}`;
    });
  },
  async tr(mgr, arg) {
    if (!arg) return "Usage: |tr <Room> <text>";
    const { room: r0, rest: text } = matchRoom(arg, mgr.allKnownRooms()); if (!text) return "Usage: |tr <Room> <text>";
    const room = canonical(mgr, r0);
    return onTargets(mgr, async (acc) => { await acc.say(room, text, { fast: true }); return `sent`; });
  },
  async use(mgr, arg) {
    const a = arg.trim().toLowerCase();
    if (!a || a === "main") { mgr.active = "main"; return "✅ active: main"; }
    if (a === "all") { mgr.active = "all"; return `✅ active: all (${mgr.list().length})`; }
    const names = a.split(/[,\s]+/).filter(Boolean);
    const missing = names.filter((n) => !mgr.get(n)); if (missing.length) return `❌ not logged in: ${missing.join(", ")}`;
    mgr.active = new Set(names); return `✅ active: ${names.map((n) => "@" + n).join(", ")}`;
  },
  async who(mgr) {
    const act = new Set(mgr.targets().map((a) => a.username.toLowerCase()));
    return mgr.list().map((a) => `${act.has(a.username.toLowerCase()) ? "▶" : "•"} @${a.username}${a.isMain ? " (main)" : ""} — ${[...a.rooms].join(", ") || "no rooms"} q:${a.queueDepth}`).join("\n");
  },
  async ap(mgr, arg) {
    const ap = mgr.autoPick; const [w, ...rest] = arg.trim().split(/\s+/);
    const word = (w || "").toLowerCase(); const roomArg = rest.join(" ").trim();
    if (!word || word === "status") {
      const ov = [...ap.rooms].map(([r, v]) => `${r}=${v ? "ON" : "OFF"}`).join(", ");
      return `🎁 Auto-pick: ${ap.global ? "ON" : "OFF"}${ov ? ` | ov: ${ov}` : ""} | picks: ${ap.sent}`;
    }
    if (word !== "on" && word !== "off") return `Usage: |ap on|off [Room]`;
    const on = word === "on";
    if (!roomArg) { ap.global = on; ap.rooms.clear(); return `🎁 ${on ? "ON ✅" : "OFF ⛔"} (all)`; }
    ap.rooms.set(canonical(mgr, roomArg).toLowerCase(), on); return `🎁 ${on ? "ON ✅" : "OFF ⛔"} [${canonical(mgr, roomArg)}]`;
  },
  async vp(mgr, arg) { return COMMANDS.ap(mgr, arg); },
  async accounts(mgr) {
    return `👥 (${mgr.list().length}):\n` + mgr.list().map((a) => `  @${a.username}${a.isMain ? " 👑" : ""} ${a.rooms.size ? `[${[...a.rooms].join(",")}]` : "no rooms"} q:${a.queueDepth}`).join("\n");
  },
  async flood(mgr, arg) {
    if (/^stop$/i.test(arg.trim())) { const lines = mgr.targets().map((a) => { a.stopFlood(); return `🛑 @${a.username}`; }); return lines.join("\n") || "❌ no accounts"; }
    if (/^reload$/i.test(arg.trim())) return `✅ flood.txt reloaded (${loadLines(FLOOD_FILE).length} msgs)`;
    if (/^status$/i.test(arg.trim())) return mgr.targets().map((a) => `@${a.username}: ${a.floodStatus()}`).join("\n");
    const { room: r0, rest } = matchRoom(arg, mgr.allKnownRooms()); if (!r0 || !rest) return "Usage: |flood <Room> <text> | |flood stop";
    const room = canonical(mgr, r0);
    return onTargets(mgr, async (acc) => { if (!acc.rooms.has(room)) await acc.join(room); acc.startCustomFlood(room, rest); return `🌊 [${room}]`; });
  },
  async autoflood(mgr, arg) {
    const room = canonical(mgr, arg.trim()); if (!room) return "Usage: |autoflood <Room>";
    return onTargets(mgr, async (acc) => { if (!acc.rooms.has(room)) await acc.join(room); if (!acc.startAutoFlood(room)) throw new Error("flood.txt empty"); return `🌊 [${room}]`; });
  },
  async at(mgr, arg) {
    const parts = arg.trim().split(/\s+/); const action = (parts[0] || "").toLowerCase(); const roomArg = parts.slice(1).join(" ").trim();
    if (action === "on") {
      if (!roomArg) return "❌ Usage: |at on <Room>"; const room = canonical(mgr, roomArg);
      return onTargets(mgr, async (acc) => {
        if (!acc.autoTextMessages.length) acc.autoTextMessages = loadLines(AT_FILE);
        if (!acc.autoTextMessages.length) throw new Error("at.txt empty");
        if (!acc.rooms.has(room)) await acc.join(room);
        acc.autoTextRooms.add(room); acc.autoTextOn = true; acc.startAutoText();
        return `📝 AT ON [${room}] (${acc.autoTextMessages.length} msgs, ${acc.autoTextInterval}m)`;
      });
    }
    if (action === "off") {
      return onTargets(mgr, async (acc) => {
        if (roomArg) {
          const room = [...acc.autoTextRooms].find((r) => r.toLowerCase() === roomArg.toLowerCase()) || roomArg;
          acc.autoTextRooms.delete(room); if (!acc.autoTextRooms.size) { acc.autoTextOn = false; acc.stopAutoText(); }
          return `⛔ AT OFF [${room}]`;
        }
        acc.autoTextOn = false; acc.autoTextRooms.clear(); acc.stopAutoText(); return `⛔ AT OFF (all)`;
      });
    }
    if (action === "interval") { const m = parseInt(parts[1]); if (!m || m < 1) return "❌ Usage: |at interval <minutes>"; return onTargets(mgr, async (acc) => { acc.setAutoTextInterval(m); return `✅ ${m}m`; }); }
    if (action === "reload") return onTargets(mgr, async (acc) => { acc.autoTextMessages = loadLines(AT_FILE); acc.autoTextIndex.clear(); if (acc.autoTextOn) { acc.stopAutoText(); acc.startAutoText(); } return `✅ ${acc.autoTextMessages.length} msgs`; });
    if (action === "status") return onTargets(mgr, async (acc) => !acc.autoTextOn ? "📝 AT OFF" : `📝 AT ON (${acc.autoTextMessages.length} msgs, ${acc.autoTextInterval}m)`);
    return "Usage: |at on <Room> | |at off [Room] | |at interval <min> | |at reload | |at status";
  },
  async aw(mgr, arg) {
    const parts = arg.trim().split(/\s+/); const action = (parts[0] || "").toLowerCase(); const roomArg = parts.slice(1).join(" ").trim();
    if (action === "on") return onTargets(mgr, async (acc) => { if (roomArg) { acc.awRooms.add(canonical(mgr, roomArg)); acc.awOn = true; return `✅ AW ON [${canonical(mgr, roomArg)}]`; } acc.awOn = true; acc.awRooms.clear(); return `✅ AW ON (all)`; });
    if (action === "off") return onTargets(mgr, async (acc) => { if (roomArg) { const room = [...acc.awRooms].find((r) => r.toLowerCase() === roomArg.toLowerCase()) || roomArg; acc.awRooms.delete(room); if (!acc.awRooms.size) acc.awOn = false; return `⛔ AW OFF [${room}]`; } acc.awOn = false; acc.awRooms.clear(); return `⛔ AW OFF (all)`; });
    return "Usage: |aw on|off [Room]";
  },
  async aw_msg(mgr, arg) {
    const m = arg.match(/^#(\S+)\s+(.+)/);
    if (m) { const room = canonical(mgr, m[1]); const text = m[2]; return onTargets(mgr, async (acc) => { acc.awMessages.set(room, text); return `✅ AW msg [${room}]: "${text}"`; }); }
    if (!arg.trim()) return "Usage: |aw_msg <text> | |aw_msg #<Room> <text>";
    return onTargets(mgr, async (acc) => { acc.awTemplate = arg.trim(); return `✅ AW default: "${arg.trim()}"`; });
  },
  async awgift(mgr, arg) {
    const parts = arg.trim().split(/\s+/); const action = (parts[0] || "").toLowerCase();
    if (action === "on") {
      const roomArg = parts.slice(1).join(" ").trim(); if (!roomArg) return "❌ Usage: |awgift on <Room>";
      const room = canonical(mgr, roomArg);
      return onTargets(mgr, async (acc) => { if (!acc.rooms.has(room)) await acc.join(room); acc.awgiftRooms.add(room); acc.awgiftOn = true; return `✅ AWGIFT ON [${room}]`; });
    }
    if (action === "off") {
      const roomArg = parts.slice(1).join(" ").trim();
      return onTargets(mgr, async (acc) => {
        if (!roomArg || roomArg.toLowerCase() === "all") { acc.awgiftRooms.clear(); acc.awgiftOn = false; return `⛔ AWGIFT OFF (all)`; }
        const room = [...acc.awgiftRooms].find((r) => r.toLowerCase() === roomArg.toLowerCase()) || roomArg;
        acc.awgiftRooms.delete(room); if (!acc.awgiftRooms.size) acc.awgiftOn = false; return `⛔ AWGIFT OFF [${room}]`;
      });
    }
    if (action === "time") { const h = parseInt(parts[1]); if (!h || h < 1) return "❌ Usage: |awgift time <hours>"; return onTargets(mgr, async (acc) => { acc.awgiftCooldownHours = h; return `✅ cd ${h}h`; }); }
    if (action === "status") return onTargets(mgr, async (acc) => !acc.awgiftRooms.size ? `🎁 AWGIFT OFF` : `🎁 ON [${[...acc.awgiftRooms].join(",")}] (gift:"${acc.awgiftName}", cd:${acc.awgiftCooldownHours}h)`);
    return "Usage: |awgift on Room | |awgift off [Room|all] | |awgift time <h> | |awgift status";
  },
  async setawgift(mgr, arg) { if (!arg.trim()) return "Usage: |setawgift <gift_name>"; return onTargets(mgr, async (acc) => { acc.awgiftName = arg.trim(); return `✅ "${arg.trim()}"`; }); },
  async sawgm(mgr, arg) { if (!arg.trim()) return "Usage: |sawgm <message>"; return onTargets(mgr, async (acc) => { acc.awgiftMessage = arg.trim(); return `✅ "${arg.trim()}"`; }); },
  async gs(mgr, arg) {
    const parts = arg.trim().split(/\s+/); const action = (parts[0] || "").toLowerCase();
    if (action === "on") {
      const roomArg = parts.slice(1).join(" ").trim(); if (!roomArg) return "❌ Usage: |gs on <Room>";
      const room = canonical(mgr, roomArg);
      return onTargets(mgr, async (acc) => { if (!acc.rooms.has(room)) await acc.join(room); acc.giftRooms.add(room); acc.giftOn = true; acc.startGift(); return `✅ GS ON [${room}]`; });
    }
    if (action === "off") {
      const roomArg = parts.slice(1).join(" ").trim();
      return onTargets(mgr, async (acc) => { if (!roomArg) { acc.stopGift(); acc.giftRooms.clear(); return `⛔ GS OFF (all)`; } const room = [...acc.giftRooms].find((r) => r.toLowerCase() === roomArg.toLowerCase()) || roomArg; acc.giftRooms.delete(room); if (!acc.giftRooms.size) acc.stopGift(); return `⛔ GS OFF [${room}]`; });
    }
    if (action === "status") return onTargets(mgr, async (acc) => !acc.giftOn ? "🎁 GS OFF" : `🎁 GS ON [${[...acc.giftRooms].join(",")}] "${acc.giftName}" ${acc.giftInterval}s`);
    return "Usage: |gs on Room | |gs off [Room] | |gs status";
  },
  async setgift(mgr, arg) { if (!arg.trim()) return "Usage: |setgift <name>"; return onTargets(mgr, async (acc) => { acc.giftName = arg.trim(); return `✅ "${arg.trim()}"`; }); },
  async giftinterval(mgr, arg) { const s = parseInt(arg); if (!s || s < 1) return "❌ Usage: |giftinterval <sec>"; return onTargets(mgr, async (acc) => { acc.setGiftInterval(s); return `✅ ${s}s`; }); },
  async ar(mgr, arg) {
    const a = arg.trim().toLowerCase();
    if (a === "on") return onTargets(mgr, async (acc) => { acc.autoReplyOn = true; return `✅ AR ON`; });
    if (a === "off") return onTargets(mgr, async (acc) => { acc.autoReplyOn = false; return `⛔ AR OFF`; });
    return "Usage: |ar on | |ar off";
  },
  async settrigger(mgr, arg) { if (!arg.trim()) return "❌ Usage: |settrigger <keyword>"; const keyword = arg.trim().replace(/^@?/, "@"); saveTrigger(keyword); for (const acc of mgr.list()) acc.triggerKeyword = keyword; return `✅ trigger → "${keyword}"`; },
  async checktrigger(mgr) { return `🔔 trigger: "${mgr.main.triggerKeyword || "(none)"}"`; },
  async wip() { const ip = await getPublicIP(); return `🌐 Public IP: \`${ip}\``; },
  async reset(mgr) { for (const acc of mgr.list()) acc.reset(); return `✅ Reset queues + timers on ${mgr.list().length} account(s)`; },

  async sd(mgr, arg) {
    const parts = arg.trim().split(/\s+/); const action = (parts[0] || "").toLowerCase(); const roomArg = parts.slice(1).join(" ").trim();
    if (action === "on" || action === "off") { const value = action === "on"; if (roomArg) { slangRoomOverrides.set(canonical(mgr, roomArg).toLowerCase(), value); return `✅ Slang ${value ? "ON" : "OFF"} [${canonical(mgr, roomArg)}]`; } slangGlobalOn = value; return `✅ Slang ${value ? "ON" : "OFF"} (global)`; }
    if (action === "reset") { if (roomArg) { slangRoomOverrides.delete(canonical(mgr, roomArg).toLowerCase()); return `✅ reset [${canonical(mgr, roomArg)}]`; } slangRoomOverrides.clear(); return `✅ all cleared`; }
    if (action === "status") { let msg = `📊 Slang: global=${slangGlobalOn ? "ON" : "OFF"}`; if (slangRoomOverrides.size) msg += `\n  ov: ${[...slangRoomOverrides].map(([r, v]) => `${r}=${v ? "ON" : "OFF"}`).join(", ")}`; msg += `\n  words: ${slangWords.length}`; return msg; }
    return "Usage: |sd on|off [Room] | |sd reset [Room] | |sd status";
  },
  async addslang(mgr, arg) { if (!arg.trim()) return "❌ Usage: |addslang <w1,w2>"; const words = arg.split(/[,;]\s*/).map((w) => w.trim().toLowerCase()).filter(Boolean); let added = 0, skipped = 0; for (const w of words) { if (slangWords.includes(w)) skipped++; else { slangWords.push(w); added++; } } saveSlang(); return `✅ +${added} (skip ${skipped})`; },
  async removeslang(mgr, arg) { if (!arg.trim()) return "❌ Usage: |removeslang <w1,w2>"; const words = arg.split(/[,;]\s*/).map((w) => w.trim().toLowerCase()).filter(Boolean); let removed = 0, nf = 0; for (const w of words) { const i = slangWords.indexOf(w); if (i === -1) nf++; else { slangWords.splice(i, 1); removed++; } } saveSlang(); return `✅ -${removed} (nf ${nf})`; },
  async listslang() { return !slangWords.length ? "📋 no words" : `📋 (${slangWords.length}):\n${slangWords.join(", ")}`; },
  async viewsh() {
    const h = loadSlangHistory(); const entries = Object.entries(h).sort((a, b) => b[1].lastViolation - a[1].lastViolation);
    if (!entries.length) return "📭 no history"; const show = entries.slice(0, 20);
    let msg = `📋 (${entries.length}):\n`; for (const [u, d] of show) msg += `  @${u} | ${d.count} | warn:${d.warnings} | ${new Date(d.lastViolation).toLocaleString()}\n`;
    if (entries.length > show.length) msg += `  +${entries.length - show.length} more`; return msg;
  },
  async clearsh() { try { fs.writeFileSync(SLANG_HISTORY_FILE, "{}", "utf8"); fs.writeFileSync(SLANG_LOG_FILE, "", "utf8"); return "✅ cleared"; } catch (e) { return `❌ ${e.message}`; } },

  async addcmd(mgr, arg) {
    const m = arg.match(/^(\/[A-Za-z0-9_]+)\s+([\s\S]+)$/);
    if (!m) return "Usage: |addcmd /cmd <template>\nExample: |addcmd /spin **{username} spins and gets {roll:10}!**";
    const cmd = m[1].toLowerCase(); const template = m[2].trim();
    const wasKnown = clientCommands[cmd] !== undefined;
    clientCommands[cmd] = template;
    if (!saveClientCommands()) return "❌ save failed";
    return `${wasKnown ? "♻️ Updated" : "✅ Added"} ${cmd}\nVerify: |rendercheck ${cmd}`;
  },
  async delcmd(mgr, arg) {
    const cmd = arg.trim().toLowerCase();
    if (!cmd.startsWith("/")) return "Usage: |delcmd /cmd";
    if (!clientCommands[cmd]) return `❌ ${cmd} not in map`;
    delete clientCommands[cmd]; if (!saveClientCommands()) return "❌ save failed";
    return `✅ ${cmd} removed`;
  },
  async cmds(mgr, arg) {
    const filter = arg.trim().toLowerCase();
    const keys = Object.keys(clientCommands).sort().filter((k) => !filter || k.includes(filter));
    if (!keys.length) return `📭 no client cmds${filter ? ` matching "${filter}"` : ""}`;
    return `📋 ${keys.length} templates${filter ? ` (filter "${filter}")` : ""}:\n` + keys.map((k) => `  ${k}`).join("\n");
  },
  async missing() {
    const all = loadLines(ALL_COMMANDS_FILE).map((l) => l.toLowerCase()).filter(Boolean);
    if (!all.length) return `⚠ all_commands.txt empty or missing`;
    const missing = all.filter((c) => !clientCommands[c]);
    if (!missing.length) return `✅ All ${all.length} commands have templates!`;
    return `📋 ${missing.length}/${all.length} still need templates:\n` + missing.slice(0, 50).map((c) => `  ${c}`).join("\n") + (missing.length > 50 ? `\n  ...and ${missing.length - 50} more` : "") + `\n\nAdd: |addcmd /cmd **{username} ... {arg:everyone} ...**`;
  },
  async rendercheck(mgr, arg) {
    if (!arg.trim()) return "Usage: |rendercheck /roll [args]";
    const r = renderSlash(mgr.main.username, arg.trim());
    if (!r) return `❌ "${arg}" is not a /command (or is an info command that is sent as plain text).`;
    return `Would send → ${r.body}${r.generic ? `\n(generic text — teach the exact one: |learn <Room> ${r.cmd} <user>)` : ""}`;
  },
  /**
   * |learn <Room> [@user] /cmd [target] ; /cmd2 [target] ; ...
   * Teaches the EXACT text the web app produces for a /command, so it works with and without a username.
   * After you send this, type those commands in the web (as @user, in <Room>) in the same order — the bot reads
   * what the web wrote and saves it as a template.   |learn stop   |learn status
   */
  async learn(mgr, arg) {
    const a = (arg || "").trim();
    if (/^stop$/i.test(a)) { if (!mgr.learn) return "🎓 nothing to stop"; finishLearn(mgr, "🛑 learning cancelled"); return "🛑 cancelled"; }
    if (!a || /^status$/i.test(a)) {
      const L = mgr.learn; if (!L) return "🎓 idle. Usage: |learn <Room> [@user] /highfive onik ; /jump";
      return `🎓 waiting in [${L.room}] for @${L.user} to type: ${L.items.slice(L.i).map((x) => x.cmd + (x.arg ? " " + x.arg : "")).join("  →  ")}`;
    }
    const { room: r0, rest } = matchRoom(a, mgr.allKnownRooms());
    const usage = "Usage: |learn <Room> [@user] /highfive onik ; /jump ; /hug sabuj";
    if (!r0 || !rest) return usage;
    const room = canonical(mgr, r0);
    let who = (mgr.lastPM && mgr.lastPM.from) || PARENTS[0] || ""; let body = rest;
    const um = body.match(/^@(\S+)\s+/); if (um) { who = um[1]; body = body.slice(um[0].length); }
    const items = body.split(/\s*;\s*/).map((x) => x.trim()).filter(Boolean).map((x) => {
      const mm = x.match(/^(\/[A-Za-z0-9_]+)(?:\s+(.+))?$/);
      return mm ? { cmd: mm[1].toLowerCase(), arg: normalizeArgs(mm[2]) } : null;
    });
    if (!items.length || items.some((x) => !x) || !who) return usage;
    if (mgr.learn) finishLearn(mgr, "♻️ previous learning replaced");
    mgr.learn = { room, user: who.toLowerCase(), items, i: 0, pm: mgr.lastPM || null, got: [], timer: null };
    armLearnTimer(mgr);
    return `🎓 Learning in [${room}]. Now type these in the web as @${who}, in this order:\n` +
      items.map((x, n) => `  ${n + 1}) ${x.cmd}${x.arg ? " " + x.arg : ""}`).join("\n") + `\n(${Math.round(LEARN_TIMEOUT_MS / 1000)}s between commands; |learn stop to cancel)`;
  },
  async listcmds() { return COMMANDS.cmds({}, ""); },

  async help(_m, _a, p) {
    return [
      "📖 Commands",
      "",
      "👥 " + `${p}lnu user:pass  ${p}ltu user  ${p}accounts  ${p}use main|all|a,b`,
      "🏠 " + `${p}jn Room  ${p}lr Room|all  ${p}tr Room <text>`,
      "🌊 " + `${p}flood Room <text>  ${p}autoflood Room  ${p}flood stop  ${p}flood reload  ${p}flood status`,
      "📝 " + `${p}at on Room  ${p}at off [Room]  ${p}at interval <min>  ${p}at reload  ${p}at status`,
      "👋 " + `${p}aw on|off [Room]  ${p}aw_msg <text>`,
      "🎁 " + `${p}awgift on Room  ${p}awgift off Room|all  ${p}awgift time <h>  ${p}awgift status`,
      "🎁 " + `${p}gs on Room  ${p}gs off [Room]  ${p}gs status  ${p}setgift <name>  ${p}giftinterval <sec>`,
      "💬 " + `${p}ar on|off  ${p}settrigger <keyword>  ${p}checktrigger`,
      "🎁 " + `${p}vp on|off [Room]  (alias for ${p}ap)`,
      "♻️ " + `${p}reset` + "  — clear stuck queues/timers",
      "🌐 " + `${p}wip`,
      "🚫 " + `${p}sd on|off [Room]  ${p}sd reset [Room]  ${p}sd status  ${p}addslang w1,w2  ${p}removeslang w1,w2  ${p}listslang  ${p}viewsh  ${p}clearsh`,
      "",
      "🎭 CLIENT-SIDE /COMMANDS:",
      "  " + `${p}cmds [filter]` + "   — list templates",
      "  " + `${p}missing` + "         — show commands still needing templates",
      "  " + `${p}addcmd /cmd <template>` + "  — add/update",
      "  " + `${p}delcmd /cmd` + "        — remove",
      "  " + `${p}rendercheck /cmd args` + "  — preview output",
      "  " + `${p}learn Room [@user] /cmd target ; /cmd2` + "  — copy the web's exact text (then type them in the web)",
      "",
      "  Placeholders:",
      "    {username}            bot's name",
      "    {arg}                 arg or \"everyone\" if none",
      "    {arg:fallback}        explicit fallback",
      "    {roll} {roll:N}       random 1..100 / 1..N",
      "    {random} {random:N}   same",
      "",
      "  Examples:",
      "    " + `${p}tr Bangladesh /agree` + "       → **fan agrees with everyone! 👍**",
      "    " + `${p}tr Bangladesh /agree vip` + "   → **fan agrees with vip! 👍**",
      "    " + `${p}tr Bangladesh /roll` + "        → **fan rolls 42**",
      "    " + `${p}tr Bangladesh /roll 20` + "     → **fan rolls 14** (1-20)",
      "",
      "💡 Targets: $aa = all sub-accounts, $name = specific account",
    ].join("\n");
  },
};

// ── |learn engine: capture what the web writes when YOU type a /command ──
function armLearnTimer(mgr) {
  const L = mgr.learn; if (!L) return; clearTimeout(L.timer);
  L.timer = setTimeout(() => { if (mgr.learn === L) finishLearn(mgr, `⌛ learning timed out (learned ${L.got.length}/${L.items.length})`); }, LEARN_TIMEOUT_MS);
}
function finishLearn(mgr, msg) {
  const L = mgr.learn; if (!L) return; clearTimeout(L.timer); mgr.learn = null;
  const detail = L.got.length ? "\n" + L.got.map((g) => `  ${g.cmd}${g.arg ? " <user>" : ""} → ${g.tpl}`).join("\n") : "";
  log(`🎓 ${msg}${detail.replace(/\n/g, " | ")}`);
  if (L.pm && PM_REPLY && typeof sendPM === "function" && main) sendPM(main.session, L.pm, `🎓 ${msg}${detail}`).catch(() => {});
}
/** called for every room message while learning; returns true if the message was consumed */
function learnCapture(mgr, room, sender, f, text) {
  const L = mgr.learn;
  if (!L || room.toLowerCase() !== L.room.toLowerCase() || sender.toLowerCase() !== L.user) return false;
  if (["room_entry", "room_leave", "voucher_drop", "gift"].includes(f.type)) return false;
  const t = String(text || "").trim();
  if (!t.toLowerCase().includes(L.user)) return false;              // not an action line about the sender
  if (t.startsWith(sender + ": ")) return false;                    // plain chat text, not a rendered command
  const step = L.items[L.i];
  const tpl = deriveTemplate(t, sender, step.arg);
  const prev = clientCommands[step.cmd];
  let obj = (prev && typeof prev === "object") ? { ...prev } : (typeof prev === "string" && !step.arg ? { with: prev } : {});
  if (step.arg) obj.with = tpl; else obj.bare = tpl;
  clientCommands[step.cmd] = (obj.with && obj.bare) ? obj : (obj.with || obj.bare);
  saveClientCommands();
  L.got.push({ cmd: step.cmd, arg: step.arg, tpl }); L.i++;
  log(`🎓 learned ${step.cmd}${step.arg ? " <user>" : ""} → ${tpl}`);
  if (L.i >= L.items.length) finishLearn(mgr, `✅ learned ${L.got.length} command(s)`); else armLearnTimer(mgr);
  return true;
}

class Controller {
  constructor(manager, { prefix = PARENT_PREFIX } = {}) { this.mgr = manager; this.prefix = prefix; }
  async handle(text) {
    const t = (text || "").trim(); if (!t.startsWith(this.prefix)) return null;
    const [cmd, rawArg] = splitFirst(t.slice(this.prefix.length));
    const extracted = extractTargets(rawArg, this.mgr);
    const arg = extracted ? extracted.cleaned : rawArg;
    const fn = COMMANDS[cmd.toLowerCase()]; if (!fn) return `❌ unknown command "${cmd}". Try ${this.prefix}help`;
    const oldActive = this.mgr.active;
    if (extracted) {
      if (extracted.isAll) this.mgr.active = "all";
      else if (extracted.targets.length) this.mgr.active = new Set(extracted.targets.map((a) => a.username.toLowerCase()));
    }
    try { return await withTimeout(fn(this.mgr, arg, this.prefix), CMD_TIMEOUT_MS, "command"); }
    catch (e) { return `❌ ${friendlyError(e)}`; }
    finally { this.mgr.active = oldActive; }
  }
}

// ══════════════════════════════════════════════════════════════
//  PRIVATE MESSAGES
// ══════════════════════════════════════════════════════════════
const TEXT_KEYS = ["text", "content", "message", "body", "msg"];
const FROM_KEYS = ["fromUsername", "senderUsername", "sender", "from", "fromUser", "fromName"];
const FROM_UID_KEYS = ["fromUid", "senderUid", "fromUserId", "senderId", "fromId"];

function normalizePM(doc) {
  const f = decFields(doc.fields);
  const pick = (keys) => { for (const k of keys) if (typeof f[k] === "string" && f[k]) return f[k]; return null; };
  const textKey = TEXT_KEYS.find((k) => typeof f[k] === "string");
  return { id: doc.name.split("/").pop(), from: pick(FROM_KEYS), fromUid: pick(FROM_UID_KEYS), text: textKey ? f[textKey] : "", createdAt: typeof f.createdAt === "string" ? f.createdAt : null, fields: f, raw: doc };
}

class PMClient {
  constructor(session, lg = log) { this.session = session; this.log = lg; this.strategy = null; this.after = new Date().toISOString(); this.seen = new Set(); this.startedAt = Date.now(); }
  _query(strategy) {
    const eq = { fieldFilter: { field: { fieldPath: "toUsername" }, op: "EQUAL", value: { stringValue: this.session.username } } };
    if (strategy === "A") return { from: [{ collectionId: "private_messages" }], where: { compositeFilter: { op: "AND", filters: [eq, { fieldFilter: { field: { fieldPath: "createdAt" }, op: "GREATER_THAN", value: { timestampValue: new Date(Math.max(0, Date.parse(this.after) - 3000)).toISOString() } } }] } }, orderBy: [{ field: { fieldPath: "createdAt" }, direction: "ASCENDING" }], limit: 50 };
    return { from: [{ collectionId: "private_messages" }], where: eq, limit: 50 };
  }
  async prime() {
    const docs = await runRootQuery(this.session, this._query("B")).catch(() => []);
    for (const d of docs) { const m = normalizePM(d); this.seen.add(m.id); if (m.createdAt && Date.parse(m.createdAt) > Date.parse(this.after)) this.after = m.createdAt; }
  }
  async poll() {
    let docs;
    if (this.strategy !== "B") {
      try { docs = await runRootQuery(this.session, this._query("A")); if (!this.strategy) { this.strategy = "A"; this.log("✔ PM indexed OK"); } }
      catch (e) { if (this.strategy === "A") throw e; this.strategy = "B"; }
    }
    if (this.strategy === "B") docs = await runRootQuery(this.session, this._query("B"));
    const out = [];
    for (const d of docs) {
      const m = normalizePM(d); if (this.seen.has(m.id)) continue; this.seen.add(m.id); if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
      if (m.createdAt && Date.parse(m.createdAt) > Date.parse(this.after)) this.after = m.createdAt;
      if (this.strategy === "B" && m.createdAt && Date.parse(m.createdAt) < this.startedAt - 60_000) continue;
      out.push(m);
    }
    return out.sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
  }
}

function buildReplyFields(tpl, { me, meUid, other, otherUid, receivedText, text }) {
  const lMe = me.toLowerCase(), lOther = (other || "").toLowerCase(); const tsFields = [];
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
    if ("integerValue" in v) { const n = Number(v.integerValue); return Math.abs(Date.now() - n) < 864e5 ? { integerValue: String(Date.now()) } : v; }
    if ("arrayValue" in v) return { arrayValue: { values: (v.arrayValue.values || []).map((x) => swap(x, key, false)) } };
    if ("mapValue" in v) return { mapValue: { fields: Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, swap(x, k, false)])) } };
    return v;
  };
  const fields = {}; for (const [k, v] of Object.entries(tpl)) { const r = swap(v, k, true); if (r) fields[k] = r; }
  return { fields, tsFields };
}
async function sendPM(session, incoming, text) {
  const { fields, tsFields } = buildReplyFields(incoming.raw.fields || {}, { me: session.username, meUid: session.uid, other: incoming.from, otherUid: incoming.fromUid, receivedText: incoming.text, text });
  await commit(session, [{ update: { name: docName(`private_messages/${autoId()}`), fields }, updateTransforms: (tsFields.length ? tsFields : ["createdAt"]).map(REQ_TIME), currentDocument: { exists: false } }]);
}

// ══════════════════════════════════════════════════════════════
//  BOT LOOP
// ══════════════════════════════════════════════════════════════
let main, manager, controller;
const roomState = new Map(); const listeners = new Map(); const welcomed = new Map(); const parentUids = new Map();
let warnedSchema = false;
let lastPMAt = 0;
let lastRoomMsgAt = 0;

async function askAI(q) {
  const key = env.AI_API_KEY || env.MISTRAL_API_KEY; if (!key) return AI_UNAVAILABLE_MSG;
  try {
    const r = await fetchT(env.AI_API_URL || "https://api.mistral.ai/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: env.AI_MODEL || "mistral-small-latest", messages: [{ role: "system", content: "You are a friendly chat-room bot. Answer in under 200 characters." }, { role: "user", content: q }], max_tokens: 120 }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    return (d.choices?.[0]?.message?.content || AI_UNAVAILABLE_MSG).replace(/\s+/g, " ").slice(0, 300);
  } catch { return AI_UNAVAILABLE_MSG; }
}

const ROOM_COMMANDS = {
  help: () => `Commands: ${["help", "ping", "time", "roll", "ai <question>"].map((c) => PREFIX + c).join("  ")}`,
  ping: () => "pong 🏓", time: () => `Server: ${new Date().toUTCString()}`,
  roll: (a) => { const max = Math.min(Math.max(parseInt(a[0]) || 6, 2), 1000); return `🎲 rolled ${1 + Math.floor(Math.random() * max)} (1-${max})`; },
  ai: (a) => (a.length ? askAI(a.join(" ")) : `Usage: ${PREFIX}ai <question>`),
};
async function handleRoomMessage(room, sender, body) {
  const t = body.trim(); if (!t.startsWith(PREFIX)) return;
  const [cmd, ...args] = t.slice(PREFIX.length).split(/\s+/); const fn = ROOM_COMMANDS[(cmd || "").toLowerCase()]; if (!fn) return;
  const reply = await fn(args, sender, room); if (reply) main.say(room, `@${sender} ${reply}`).catch(() => {});
}
function roomSlangOn(room) { const key = room.toLowerCase(); return slangRoomOverrides.has(key) ? slangRoomOverrides.get(key) : slangGlobalOn; }
async function checkSlang(room, sender, text) {
  if (!slangWords.length || !roomSlangOn(room)) return false;
  const lower = text.toLowerCase();
  const hit = slangWords.find((word) => { const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); try { return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "iu").test(lower); } catch { return lower.includes(word); } });
  if (!hit) return false;
  main.log(`🚫 slang @${sender} [${room}]: "${text.slice(0, 60)}"`);
  const { action, count } = addSlangViolation(sender, room);
  if (action === "bump") { await main.cmd(room, FN_BUMP, { roomId: room, targetUsername: sender }, `/bump ${sender}`).catch(() => {}); main.say(room, `🚫 @${sender} bumped.`).catch(() => {}); }
  else {
    await main.cmd(room, FN_SILENCE, { roomId: room, targetUsername: sender }, `/silence ${sender}`).catch(() => {});
    if (action === "warning") main.say(room, `⚠️ @${sender} 3rd and FINAL warning.`).catch(() => {});
    else main.say(room, `@${sender} avoid bad words. (Warning ${count}/3)`).catch(() => {});
  }
  return true;
}
async function tryAutoReply(room, sender, text) {
  if (!main.autoReplyOn) return;
  const kw = (main.triggerKeyword || "").toLowerCase(); if (!kw || !text.toLowerCase().includes(kw)) return;
  if (!hasAI()) return;
  const q = text.replace(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").trim() || text;
  const reply = await askAI(q); main.say(room, `@${sender} ${reply}`).catch(() => {});
}
function handleJoin(room, who, uid = null) {
  if (!who || who.toLowerCase() === USER.toLowerCase()) return;
  if (main.awOn) {
    const roomAllowed = !main.awRooms.size || main.awRooms.has(room);
    if (roomAllowed) {
      const k = `${room}|${who.toLowerCase()}`;
      if (Date.now() - (welcomed.get(k) || 0) >= WELCOME_COOLDOWN_MS) {
        welcomed.set(k, Date.now()); const tpl = main.awMessages.get(room) || main.awTemplate;
        setTimeout(() => main.say(room, tpl.replace("{username}", who)).catch(() => {}), 800);
      }
    }
  }
  for (const acc of manager.list()) {
    if (!acc.awgiftOn || !acc.awgiftRooms.has(room)) continue;
    const users = loadGiftUsers(); const key = `${acc.username.toLowerCase()}|${room}|${who.toLowerCase()}`;
    const cd = acc.awgiftCooldownHours * 60 * 60 * 1000;
    if (users[key] && Date.now() - users[key] < cd) continue;
    const payload = { roomId: room, target: who, giftName: acc.awgiftName };
    if (acc.awgiftMessage) payload.message = acc.awgiftMessage;
    if (AWGIFT_POST_LINE) payload.postRoomLine = true;
    acc.cmd(room, FN_GIFT, payload, `/gift ${who} ${acc.awgiftName} -m ${acc.awgiftMessage}`)
      .then(({ mode, result }) => {
        users[key] = Date.now(); saveGiftUsers(users);
        if (mode === "function") { const r = result || {}; acc.log(`🎁 auto-gift @${who} [${room}] ✓ cost:${r.totalCost ?? "?"}`); }
      })
      .catch((e) => acc.log(`awgift @${who}: ${e.message.slice(0, 100)}`));
  }
}
function parseVoucher(f) {
  const text = String(f.text || ""); const fromSystem = f.type === "voucher_drop" || !f.senderUid;
  if (!fromSystem) return null;
  if (f.type !== "voucher_drop" && !/voucher|\/pick/i.test(text)) return null;
  const m = text.match(/\[code\][:\s]*(\d{4,10})/i) || text.match(/\bcode[:\s=]+(\d{4,10})/i) || text.match(/\bpick[\s:]+(?:code[\s:]+)?(\d{4,10})/i);
  if (!m) return null; const amount = text.match(/Amount\s+(\d+)/i);
  return { code: m[1], amount: amount ? Number(amount[1]) : null };
}
const apEnabled = (mgr, room) => { const o = mgr.autoPick.rooms.get(room.toLowerCase()); return o === undefined ? mgr.autoPick.global : o; };
const pickedCodes = new Set();
function autoPickVoucher(acc, mgr, room, f) {
  const v = parseVoucher(f); if (!v) return false;
  if (!apEnabled(mgr, room) || !acc.voucherOn) return true;
  const key = `${room}|${v.code}`; if (pickedCodes.has(key)) return true;
  pickedCodes.add(key); if (pickedCodes.size > 500) pickedCodes.delete(pickedCodes.values().next().value);
  mgr.autoPick.sent++; const t0 = Date.now();
  withTimeout(callFunction(acc.session, FN_PICK, { roomId: room, code: v.code }), CMD_TIMEOUT_MS, "pickVoucher")
    .then(() => log(`🎁 [${room}] ✅ voucher ${v.code} picked in ${Date.now() - t0}ms`))
    .catch((e) => log(`✖ [${room}] pick ${v.code}: ${e.message.slice(0, 100)}`));
  return true;
}
function processMsg(room, doc) {
  const st = roomState.get(room); if (!st) return;
  const id = doc.name.split("/").pop(); if (st.seen.has(id)) return;
  st.seen.add(id); if (st.seen.size > 2000) st.seen = new Set([...st.seen].slice(-1000));
  const f = decFields(doc.fields);
  if (f.createdAt && Date.parse(f.createdAt) >= Date.parse(st.after)) st.after = f.createdAt;
  const text = String(f.text || ""); const docSender = f.sender || "";
  let sender = docSender; if (!sender) { const m = text.match(/^([^:]+):/); if (m) sender = m[1]; }
  if (!sender) return;
  lastRoomMsgAt = Date.now();
  if (manager.learn && learnCapture(manager, room, sender, f, text)) return;
  const isManaged = (f.senderUid && f.senderUid === main.session.uid) || sender.toLowerCase() === USER.toLowerCase() || manager.get(sender) !== undefined;
  if (f.type === "voucher_drop" || parseVoucher(f)) { autoPickVoucher(main, manager, room, f); return; }
  if (f.type === "room_entry") { if (isManaged) return; const eu = extractEntryUser(text, docSender); if (eu) handleJoin(room, eu, f.senderUid || null); return; }
  if (f.type !== "chat" || isManaged) return;
  const body = text.startsWith(sender + ": ") ? text.slice(sender.length + 2) : text;
  (async () => {
    const hit = await checkSlang(room, sender, body).catch(() => false);
    if (hit) return;
    await Promise.allSettled([tryAutoReply(room, sender, body), handleRoomMessage(room, sender, body)]);
  })().catch((e) => log("msg handler:", e.message.slice(0, 100)));
}
async function initRoom(room) {
  const latest = await latestMessages(main.session, room, 30);
  const st = { after: new Date().toISOString(), seen: new Set() };
  for (const d of latest) st.seen.add(d.name.split("/").pop());
  if (latest[0]) { const c = decFields(latest[0].fields).createdAt; if (c) st.after = c; }
  roomState.set(room, st);
}
function startListening(room) {
  if (listeners.has(room)) return;
  const tok = { stop: false, lastOk: Date.now() }; listeners.set(room, tok);
  (async () => {
    // FIX: used to give up forever if the very first read failed — now it retries until it works
    while (!tok.stop && !roomState.has(room)) {
      try { await withTimeout(initRoom(room), 25000, "init"); log(`✔ [${room}] listening`); }
      catch (e) { log(`✖ [${room}] first read failed (${e.message.slice(0, 60)}) — retrying`); await sleep(3000); }
    }
    let errors = 0;
    while (!tok.stop) {
      try {
        const st = roomState.get(room); if (!st) break;
        // 3s overlap: a message committed slightly out of order is never missed (seen-set removes duplicates)
        const after = new Date(Math.max(0, Date.parse(st.after) - 3000)).toISOString();
        const docs = await withTimeout(newMessages(main.session, room, after), 25000, "poll");
        if (tok.stop) break;
        docs.forEach((d) => processMsg(room, d));
        errors = 0; tok.lastOk = Date.now(); await sleep(POLL_MS);
      } catch { errors++; await sleep(Math.min(3000, 500 * errors)); }
    }
  })();
}
function stopListening(room) { const t = listeners.get(room); if (t) { t.stop = true; listeners.delete(room); roomState.delete(room); } }

async function handlePM(m) {
  if (!m.from) { if (!warnedSchema) { warnedSchema = true; log("⚠ PM without sender"); } return; }
  const from = m.from.toLowerCase(); if (!PARENTS.includes(from)) return;
  const uid = parentUids.get(from); if (uid && m.fromUid && m.fromUid !== uid) return;
  lastPMAt = Date.now();
  manager.lastPM = m;
  const reply = await controller.handle(m.text);
  if (reply !== null) {
    const cmdName = (m.text || "").trim().split(/\s+/)[0];
    log(`⚙ ${cmdName} → ${reply.split("\n")[0].slice(0, 100)}`);
    if (PM_REPLY) await sendPM(main.session, m, reply).catch(() => {}); return;
  }
  if (!main.autoReplyOn) return;
  const text = (m.text || "").trim();
  if (text.toLowerCase().startsWith("/a ")) { const ai = await askAI(text.slice(3).trim()); if (PM_REPLY) await sendPM(main.session, m, ai).catch(() => {}); return; }
  const kw = (main.triggerKeyword || "").toLowerCase();
  if (kw && text.toLowerCase().includes(kw) && hasAI()) { const q = text.replace(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").trim() || text; const ai = await askAI(q); if (PM_REPLY) await sendPM(main.session, m, ai).catch(() => {}); }
}

// PM commands run ONE AT A TIME in order (they share state like "active accounts"); polling never waits for them
let pmClient = null, pmGen = 0, pmLastOkAt = Date.now(), pmBusy = false;
const pmQueue = [];
async function pmWorker() {
  if (pmBusy) return; pmBusy = true;
  try {
    while (pmQueue.length) {
      const m = pmQueue.shift();
      await withTimeout(handlePM(m), CMD_TIMEOUT_MS + 15000, "pm-command").catch((e) => log("PM handler:", e.message.slice(0, 100)));
    }
  } finally { pmBusy = false; }
}
async function pmLoop() {
  const gen = ++pmGen;
  if (!pmClient) { pmClient = new PMClient(main.session); await pmClient.prime(); log(`✔ PM control active — parents: ${PARENTS.join(", ")}`); }
  let errors = 0;
  while (gen === pmGen) {
    try {
      const msgs = await withTimeout(pmClient.poll(), 20000, "pm-poll");
      pmLastOkAt = Date.now();
      if (gen !== pmGen) break;
      for (const m of msgs) pmQueue.push(m);
      if (msgs.length) pmWorker();
      errors = 0; await sleep(PM_POLL_MS);
    } catch (e) {
      errors++;
      if (errors === 1 || errors % 10 === 0) log(`⚠ PM poll: ${e.message.slice(0, 160)}`);
      await sleep(Math.min(3000, 500 * errors));
    }
  }
}

// Watchdog: if a room listener or the PM loop goes silent (hung socket etc.) restart just that loop — state is kept
function startWatchdog() {
  setInterval(() => {
    const now = Date.now();
    for (const [room, tok] of [...listeners]) {
      if (now - tok.lastOk > STALL_MS) {
        log(`⚠ [${room}] listener silent ${Math.round((now - tok.lastOk) / 1000)}s — restarting it`);
        tok.stop = true; listeners.delete(room); startListening(room);
      }
    }
    if (PARENTS.length && pmClient && now - pmLastOkAt > STALL_MS) { log("⚠ PM poll silent — restarting it"); pmLastOkAt = now; pmLoop(); }
  }, 10000).unref?.();
}
process.on("unhandledRejection", (r) => log("⚠ unhandledRejection:", String((r && r.message) || r).slice(0, 160)));
process.on("uncaughtException", (e) => log("⚠ uncaughtException:", String((e && e.stack) || e).slice(0, 300)));

function startHealthServer() {
  if (!PORT && env.HEALTH_SERVER !== "true") return;
  const port = PORT || 3000;
  http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "online", bot: USER, uptime: Math.round(process.uptime()) })); }).listen(port, "0.0.0.0", () => log(`🌐 health on :${port}`));
}

function startHeartbeat() {
  setInterval(() => {
    const up = Math.round(process.uptime());
    const accounts = manager.list().map((a) => `@${a.username}${a.rooms.size ? `[${a.rooms.size}r]` : ""}${a.queueDepth ? ` q:${a.queueDepth}` : ""}`).join(" ");
    const lastPM = lastPMAt ? `${Math.round((Date.now() - lastPMAt) / 1000)}s ago` : "never";
    const lastMsg = lastRoomMsgAt ? `${Math.round((Date.now() - lastRoomMsgAt) / 1000)}s ago` : "never";
    const pollAge = [...listeners].map(([r, t]) => `${r}:${Math.round((Date.now() - t.lastOk) / 1000)}s`).join(" ");
    log(`❤️ alive uptime=${up}s rooms=${main?.rooms.size || 0} accounts=${accounts} lastPM=${lastPM} lastMsg=${lastMsg} poll[${pollAge}] pmQ=${pmQueue.length}`);
  }, HEARTBEAT_MS).unref?.();
}

async function startBot() {
  loadSlang(); loadClientCommands(); loadAllCommands();
  if (SLANG_ON) { slangGlobalOn = true; log(`🚫 Slang ON (${slangWords.length} words)`); }

  main = new Account(USER, PASS, { isMain: true });
  main.autoTextMessages = loadLines(AT_FILE);
  main.floodMessages = loadLines(FLOOD_FILE);
  applyAutoTextDefaults(main, ROOMS); applyAwgiftDefaults(main, ROOMS);

  manager = new Manager(main); controller = new Controller(manager);
  main.onJoin = startListening; main.onLeave = stopListening;

  startHealthServer(); startHeartbeat(); startWatchdog();
  log(`Logging in as ${USER}...`);
  await main.start();

  try { (await listRooms(main.session)).forEach((r) => manager.knownRooms.add(r)); log(`✔ ${manager.knownRooms.size} rooms known`); } catch {}
  ROOMS.forEach((r) => manager.knownRooms.add(r));
  for (const room of ROOMS) { try { await main.join(room); } catch (e) { log(`✖ join ${room}: ${e.message.slice(0, 140)}`); } }
  if (main.autoTextOn) main.startAutoText();
  for (const p of PARENTS) { try { const uid = await findUserUid(main.session, p); if (uid) parentUids.set(p, uid); } catch {} }
  if (PARENTS.length) pmLoop(); else log("⚠ PARENT_USERNAME empty — remote disabled");

  const known = Object.keys(clientCommands).length;
  const total = DEFAULT_ALL_COMMANDS.length;
  log(`Bot running. Auto-pick=${manager.autoPick.global ? "ON" : "OFF"} Auto-text=${main.autoTextOn ? "ON" : "OFF"} Auto-reply=${main.autoReplyOn ? "ON" : "OFF"} Awgift=${main.awgiftOn ? "ON" : "OFF"} ClientCmds=${known}/${total}.`);
  log(`Hang-protection: HTTP=${HTTP_TIMEOUT_MS}ms SEND=${SEND_TIMEOUT_MS}ms CMD=${CMD_TIMEOUT_MS}ms GIFT=${GIFT_TIMEOUT_MS}ms`);
  process.on("SIGINT", async () => { log("Shutting down..."); await manager.stopAll(); process.exit(0); });
}

if (require.main === module) {
  if (!USER || !PASS || !API_KEY) { console.error("Fill MIGLIFE_USERNAME, MIGLIFE_PASSWORD and FIREBASE_API_KEY in .env"); process.exit(1); }
  startBot().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
}

module.exports = {
  Session, Account, Manager, Controller, matchRoom, buildReplyFields, normalizePM,
  parseVoucher, autoPickVoucher, callFunction, applyAutoTextDefaults, applyAwgiftDefaults,
  extractEntryUser, renderClientCommand, renderSlash, deriveTemplate, learnCapture, finishLearn, fillTemplate,
  fetchRoomUsers, fetchT, withTimeout, enc, decFields,
};
