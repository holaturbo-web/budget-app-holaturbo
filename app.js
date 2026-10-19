/* Can I Buy It? — personal offline budget app.
   All data lives in this browser's localStorage on this device. No accounts, no network calls. */
"use strict";

const STORE_KEY = "cibi.v1";
const DAY = 86400000;

/* ---------- Example settings (generic). Import your own settings file on first run. ---------- */
const EXAMPLE_SETTINGS = {
  weekStartDay: 5, // 0=Sun … 5=Fri
  checkingPerCheck: 1000,
  weekly: [
    { id: "groceries", name: "Groceries", limit: 100 },
    { id: "gas", name: "Gas", limit: 60 },
    { id: "dining", name: "Dining & delivery", limit: 50 },
    { id: "shopping", name: "Shopping", limit: 40 },
    { id: "fun", name: "Fun", limit: 25 },
  ],
  monthly: [
    { id: "personal", name: "Personal & pet", limit: 50 },
    { id: "car", name: "Car upkeep", limit: 50 },
    { id: "other", name: "Other", limit: 25 },
  ],
  bills: [
    { name: "Rent", amount: 1500, day: 1 },
    { name: "Phone", amount: 80, day: 10 },
  ],
  splits: [
    { goal: "Emergency fund", pct: 50 },
    { goal: "Vacation", pct: 50 },
  ],
  goals: [
    { name: "Emergency fund", saved: 0, target: 5000, by: "" },
    { name: "Vacation", saved: 0, target: 2000, by: "" },
  ],
  gifts: [],
  favorites: [
    { label: "Gas fill-up", amount: 45, cat: "gas" },
    { label: "Groceries", amount: 0, cat: "groceries" },
  ],
  isExample: true,
};
const KINDS = { budget: "Budget", work: "Work (paid back)", planned: "Planned / savings" };

/* ---------- State ---------- */
function blankState() {
  return { version: 2, settings: clone(EXAMPLE_SETTINGS), tx: [], moves: [], rollovers: {}, leftoverDone: {}, paychecks: [], pending: [], reviews: {}, done: {}, lastExport: 0, onboarded: false };
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function migrate(s) {
  const st = Object.assign(blankState(), s && typeof s === "object" ? s : {});
  for (const k of ["tx", "moves", "paychecks", "pending"]) if (!Array.isArray(st[k])) st[k] = [];
  for (const k of ["rollovers", "leftoverDone", "reviews", "done"]) if (!st[k] || typeof st[k] !== "object" || Array.isArray(st[k])) st[k] = {};
  for (const t of st.tx) if (!t.kind) t.kind = "budget";
  st.version = 2;
  return st;
}
/* Bad data from a hand-edited or damaged file: keep only purchases with a real number, date and category. */
function cleanTx(list) {
  const out = []; let dropped = 0;
  for (const t of Array.isArray(list) ? list : []) {
    const amount = Number(t && t.amount), ts = Number(t && t.ts);
    if (!t || !isFinite(amount) || !isFinite(ts) || ts <= 0 || typeof t.cat !== "string") { dropped++; continue; }
    out.push({ ...t, id: String(t.id || uid()), amount: r2(amount), ts, note: typeof t.note === "string" ? t.note.slice(0, 200) : "", kind: KINDS[t.kind] ? t.kind : "budget" });
  }
  return { tx: out, dropped };
}
const PREV_KEY = STORE_KEY + ".prev", DAMAGED_KEY = STORE_KEY + ".damaged", UNDO_KEY = STORE_KEY + ".undo";
let loadNote = "", lastRaw = null;
function load() {
  let raw = null;
  try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return blankState(); }
  if (!raw) return blankState();
  lastRaw = raw;
  try { return migrate(JSON.parse(raw)); } catch (e) { /* damaged save */ }
  try { localStorage.setItem(DAMAGED_KEY, raw); } catch (e) {}
  try {
    const prev = localStorage.getItem(PREV_KEY);
    if (prev) { const st = migrate(JSON.parse(prev)); loadNote = "Your last save was damaged, so the app recovered the save before it. Your most recent change may be missing."; return st; }
  } catch (e) {}
  loadNote = "Your saved data was damaged and couldn't be read. A copy was kept on this phone. Restore your latest backup from More.";
  return blankState();
}
let S = load();
let storageOk = true;
/* If another copy of the app (another tab) saved since we loaded, fold its changes in instead of overwriting them. */
function mergeFrom(raw) {
  let o; try { o = migrate(JSON.parse(raw)); } catch (e) { return; }
  const done = Object.assign({}, o.done, S.done);
  const mine = new Map(S.tx.map(t => [t.id, t]));
  for (const t of o.tx) if (!mine.has(t.id) && !done[t.id]) { S.tx.push(t); goalEffect(t, 1); delete t.late; lateApplyTo(t); }
  for (const t of [...S.tx]) if (o.done[t.id] && !S.done[t.id]) { goalEffect(t, -1); S.tx = S.tx.filter(x => x.id !== t.id); }
  const myP = new Set(S.pending.map(p => p.id));
  for (const p of o.pending) if (!myP.has(p.id) && !done[p.id]) S.pending.push(p);
  for (const p of [...S.pending]) if (o.done[p.id] && !S.done[p.id]) {
    if (o.done[p.id] === "confirmed") { const g = S.settings.goals.find(g => g.name === p.goal); if (g) g.saved = r2((+g.saved || 0) + p.amount); }
    S.pending = S.pending.filter(x => x.id !== p.id);
  }
  const mk = m => `${m.ts}|${m.from}|${m.to}|${m.amount}`, myM = new Set(S.moves.map(mk));
  for (const m of o.moves) if (!myM.has(mk(m))) S.moves.push(m);
  const pk = p => JSON.stringify(p), myPc = new Set(S.paychecks.map(pk));
  for (const p of o.paychecks) if (!myPc.has(pk(p))) S.paychecks.push(p);
  for (const k of ["rollovers", "leftoverDone", "reviews"]) for (const key of Object.keys(o[k])) if (!(key in S[k])) S[k][key] = o[k][key];
  S.lastExport = Math.max(S.lastExport || 0, o.lastExport || 0);
  S.done = done;
}
function save() {
  try {
    let cur = null; try { cur = localStorage.getItem(STORE_KEY); } catch (e) {}
    if (cur && lastRaw !== null && cur !== lastRaw) mergeFrom(cur);
    const raw = JSON.stringify(S);
    if (cur && cur !== raw) { try { localStorage.setItem(PREV_KEY, cur); } catch (e) { /* no room for the safety copy; the main save still matters more */ } }
    localStorage.setItem(STORE_KEY, raw); lastRaw = raw; storageOk = true;
  } catch (e) { storageOk = false; toast("Couldn't save on this device. Export a backup now."); }
}
/* Pick up changes another copy of the app saved (called when the app comes back to the front). */
function reloadIfChanged() {
  let cur = null; try { cur = localStorage.getItem(STORE_KEY); } catch (e) { return false; }
  if (!cur || cur === lastRaw) return false;
  try { S = migrate(JSON.parse(cur)); lastRaw = cur; return true; } catch (e) { return false; }
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- Dates ---------- */
const pad = n => String(n).padStart(2, "0");
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
function weekStart(d = new Date()) {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  s.setDate(s.getDate() - ((s.getDay() - S.settings.weekStartDay + 7) % 7));
  return s;
}
const monthStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmtDate = (d, o = { month: "short", day: "numeric" }) => d.toLocaleDateString("en-US", o);
function daysLeftInWeek() { const end = addDays(weekStart(), 7); return Math.max(1, Math.ceil((end - new Date()) / DAY)); }
/* Timestamp for a chosen day: now if it's today, otherwise noon of that day. */
function tsFor(dayIso) { const today = isoDay(new Date()); return !dayIso || dayIso >= today || !/^\d{4}-\d\d-\d\d$/.test(dayIso) ? Date.now() : fromIso(dayIso).getTime() + 12 * 3600000; }

/* ---------- Money ---------- */
const r2 = n => Math.round(n * 100) / 100;
const money = n => (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = n => (n < 0 ? "-" : "") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
const MAX_AMT = 100000;
/* Strict: "12", "12.5", "1,234.56", "$40" are fine. "1.2.3", "12..5", "1e5", "-50", letters are rejected (returns NaN). */
function parseNum(v) {
  const s = String(v ?? "").trim().replace(/^\$/, "").replace(/,(?=\d{3}(\D|$))/g, "").replace(/\s/g, "");
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) return NaN;
  return parseFloat(s);
}
/* A purchase or paycheck amount: more than $0, at most 2 decimals, at most $100,000. Returns 0 if not valid. */
const parseAmt = v => { const s = String(v ?? "").trim(); const n = parseNum(s); return isFinite(n) && n > 0 && n <= MAX_AMT && !/\.\d{3,}/.test(s) ? r2(n) : 0; };

/* ---------- Budget math ---------- */
function allCats() { return [...S.settings.weekly.map(c => ({ ...c, period: "week" })), ...S.settings.monthly.map(c => ({ ...c, period: "month" }))]; }
function catById(id) { return allCats().find(c => c.id === id); }
function periodKey(c, d = new Date()) { return c.period === "week" ? isoDay(weekStart(d)) : isoDay(monthStart(d)); }
function periodStartTs(c, d = new Date()) { return (c.period === "week" ? weekStart(d) : monthStart(d)).getTime(); }
function periodEndTs(c, d = new Date()) {
  if (c.period === "week") return addDays(weekStart(d), 7).getTime();
  const m = monthStart(d); return new Date(m.getFullYear(), m.getMonth() + 1, 1).getTime();
}
/* Only "budget" purchases count. Refunds are stored as negative amounts. */
function spent(c, d = new Date()) {
  const a = periodStartTs(c, d), b = periodEndTs(c, d);
  return r2(S.tx.filter(t => t.kind === "budget" && t.cat === c.id && t.ts >= a && t.ts < b).reduce((s, t) => s + t.amount, 0));
}
function effLimit(c, d = new Date()) {
  const key = periodKey(c, d);
  const roll = (S.rollovers[key] || {})[c.id] || 0;
  let adj = 0;
  for (const m of S.moves) if (m.period === key) { if (m.to === c.id) adj += m.amount; if (m.from === c.id) adj -= m.amount; }
  return r2(c.limit + roll + adj);
}
function left(c, d) { return r2(effLimit(c, d) - spent(c, d)); }
function weekTotals(d = new Date()) {
  let lim = 0, sp = 0;
  for (const c of allCats().filter(c => c.period === "week")) { lim += effLimit(c, d); sp += spent(c, d); }
  return { limit: r2(lim), spent: r2(sp), left: r2(lim - sp) };
}

/* ---------- Actions (used by the UI; plain functions so they can be tested) ---------- */
/* Planned purchases paid from a goal take money out of that goal's balance (refunds put it back). */
function goalEffect(t, sign) {
  if (!t || t.kind !== "planned" || !t.goal) return;
  const g = S.settings.goals.find(g => g.name === t.goal); if (g) g.saved = r2((+g.saved || 0) - sign * t.amount);
}
/* A purchase dated into a past week whose leftover was already rolled over or sent to a goal:
   take it back out of that rollover (or the waiting goal move) so the money isn't counted twice. */
let adjNote = "";
function lateApplyTo(t) {
  if (!t || t.kind !== "budget" || !(t.amount > 0)) return;
  const c = catById(t.cat); if (!c || c.period !== "week") return;
  const ws = weekStart(new Date(t.ts)); if (ws.getTime() >= weekStart().getTime()) return;
  const key = isoDay(ws), how = S.leftoverDone[key];
  if (how === "roll") {
    const nk = isoDay(addDays(ws, 7)), ro = S.rollovers[nk] || {};
    let need = t.amount;
    for (const id of [t.cat, ...Object.keys(ro).filter(i => i !== t.cat)]) {
      const have = ro[id] || 0; if (have <= 0 || need <= 0) continue;
      const take = r2(Math.min(have, need)); ro[id] = r2(have - take); need = r2(need - take);
      (t.late = t.late || { how: "roll", week: nk, from: {} }).from[id] = r2((t.late.from[id] || 0) + take);
    }
    const took = r2(t.amount - need);
    if (took > 0) adjNote = `Last week's leftover was already rolled over, so ${money(took)} came back out of this week.`;
  } else if (how === "goal") {
    const p = S.pending.find(x => x.week === key);
    if (p) { const take = r2(Math.min(p.amount, t.amount)); p.amount = r2(p.amount - take); t.late = { how: "goal", pending: p.id, amount: take };
      adjNote = `Last week's leftover move to ${p.goal} went down by ${money(take)}.`;
      if (p.amount <= 0) { S.pending = S.pending.filter(x => x !== p); S.done[p.id] = "dismissed"; } }
    else adjNote = `Heads up: last week's leftover was already moved to a goal. This purchase means ${money(t.amount)} less was really left.`;
  }
}
function lateRevert(t) {
  if (!t || !t.late) return;
  if (t.late.how === "roll") { const ro = S.rollovers[t.late.week] = S.rollovers[t.late.week] || {}; for (const [id, a] of Object.entries(t.late.from)) ro[id] = r2((ro[id] || 0) + a); }
  else { const p = S.pending.find(x => x.id === t.late.pending); if (p) p.amount = r2(p.amount + t.late.amount); }
  delete t.late;
}
function addTx({ amount, cat, note = "", day, kind = "budget", refund = false, goal = "" }) {
  adjNote = "";
  const t = { id: uid(), ts: tsFor(day), amount: refund ? -Math.abs(amount) : Math.abs(amount), cat, note, kind };
  if (kind === "work") t.reimbursed = false;
  if (kind === "planned" && goal) t.goal = goal;
  S.tx.push(t); goalEffect(t, 1); lateApplyTo(t); save(); return t;
}
function updateTx(id, fields) {
  adjNote = "";
  const t = S.tx.find(x => x.id === id); if (!t) return;
  goalEffect(t, -1); lateRevert(t); Object.assign(t, fields);
  if (t.kind !== "planned") delete t.goal;
  if (t.kind === "work" && t.reimbursed == null) t.reimbursed = false;
  goalEffect(t, 1); lateApplyTo(t); save();
}
function deleteTx(id) { const t = S.tx.find(x => x.id === id); goalEffect(t, -1); lateRevert(t); S.tx = S.tx.filter(x => x.id !== id); S.done[id] = "deleted"; save(); }
/* Everything logged with a date in the current week, all types, refunds subtracted. */
function loggedThisWeek() { const a = weekStart().getTime(), b = addDays(weekStart(), 7).getTime(); return r2(S.tx.filter(t => t.ts >= a && t.ts < b).reduce((s, t) => s + t.amount, 0)); }
const giftGoal = () => (S.settings.goals.find(g => /gift/i.test(g.name)) || {}).name || "";
function coverMove(fromId, toId, amount, d = new Date()) {
  const c = catById(toId), f = catById(fromId); if (!c || !f || fromId === toId) return 0;
  amount = r2(Math.min(amount, left(f, d))); if (!(amount > 0)) return 0;
  S.moves.push({ period: periodKey(c, d), from: fromId, to: toId, amount, ts: Date.now() }); save(); return amount;
}
/* Money that could cover `need` in category c, from categories in the same period with money left. */
function coverOptions(c, need, d = new Date()) {
  return allCats().filter(x => x.period === c.period && x.id !== c.id).map(x => ({ cat: x, avail: left(x, d) }))
    .filter(o => o.avail > 0).sort((a, b) => b.avail - a.avail).map(o => ({ ...o, take: r2(Math.min(need, o.avail)) }));
}
/* Last week's net result across weekly categories (overspending counts). */
function prevWeekResult() {
  const prev = addDays(weekStart(), -7), key = isoDay(prev);
  const weekly = allCats().filter(c => c.period === "week");
  const per = {}; let net = 0, pos = 0;
  for (const c of weekly) { const l = left(c, prev); per[c.id] = l; net += l; if (l > 0) pos += l; }
  const active = S.tx.some(t => t.ts >= prev.getTime() && t.ts < weekStart().getTime());
  return { key, prev, per, net: r2(net), pos: r2(pos), active, done: !!S.leftoverDone[key] };
}
function resolveLeftover(choice, goalName) {
  const r = prevWeekResult(); if (r.done) return;
  if (choice === "roll" && r.net > 0) {
    const k = isoDay(weekStart()); S.rollovers[k] = S.rollovers[k] || {};
    const f = r.net / r.pos;
    for (const [id, l] of Object.entries(r.per)) if (l > 0) S.rollovers[k][id] = r2((S.rollovers[k][id] || 0) + l * f);
  } else if (choice === "goal" && r.net > 0) {
    S.pending.push({ id: uid(), goal: goalName, amount: r.net, note: `Leftover from week of ${fmtDate(r.prev)}`, created: Date.now(), week: r.key });
  }
  S.leftoverDone[r.key] = r.net > 0 ? choice : "over"; save();
}
function recordPaycheck(net) {
  const chk = Math.min(net, S.settings.checkingPerCheck), rest = r2(net - chk);
  S.paychecks.push({ date: isoDay(new Date()), net, checking: chk, toGoals: rest });
  if (rest > 0) for (const s of S.settings.splits) { const amt = r2(rest * s.pct / 100); if (amt > 0) S.pending.push({ id: uid(), goal: s.goal, amount: amt, note: `Paycheck ${fmtDate(new Date())}`, created: Date.now() }); }
  save(); return rest;
}
function confirmPending(id) {
  const p = S.pending.find(x => x.id === id); if (!p) return;
  const g = S.settings.goals.find(g => g.name === p.goal); if (g) g.saved = r2((+g.saved || 0) + p.amount);
  S.pending = S.pending.filter(x => x.id !== id); S.done[id] = "confirmed"; save();
}
function dismissPending(id) { S.pending = S.pending.filter(x => x.id !== id); S.done[id] = "dismissed"; save(); }
function markReimbursed(id) { updateTx(id, { reimbursed: true }); }
function pastWeeks(n = 8) {
  const out = []; let ws = addDays(weekStart(), -7);
  for (let i = 0; i < n; i++) { const t = weekTotals(ws); const any = S.tx.some(x => x.ts >= ws.getTime() && x.ts < addDays(ws, 7).getTime()); if (any) out.push({ start: ws, ...t }); ws = addDays(ws, -7); }
  return out;
}

/* ---------- UI helpers ---------- */
const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
let toastT;
function toast(msg) { const t = $("#toast"); if (!t) return; t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), Math.max(2800, msg.length * 55)); }
function openSheet(node) { const tt = $("#toast"); if (tt) tt.classList.remove("show"); const sh = $("#sheet"); sh.innerHTML = ""; sh.append(node); sh.hidden = false; $("#sheetBackdrop").hidden = false; }
function closeSheet() { $("#sheet").hidden = true; $("#sheetBackdrop").hidden = true; }
function bar(pct, state) { const i = el("i"); i.style.width = Math.max(0, Math.min(100, pct)) + "%"; if (state) i.className = state; return el("div", { class: "bar" }, i); }
function segmented(options, value, onChange, label) {
  const wrap = el("div", { class: "chips", role: "group", "aria-label": label });
  const draw = v => { wrap.innerHTML = ""; for (const [k, txt] of options) wrap.append(el("button", { class: "chip sm", type: "button", "aria-pressed": k === v ? "true" : "false", onclick: () => { draw(k); onChange(k); } }, txt)); };
  draw(value); return wrap;
}

/* ---------- Navigation ---------- */
let tab = "spend";
const TITLES = { spend: "Can I Buy It?", week: "This Week", money: "Bills & Paycheck", goals: "Goals", more: "More" };
function render() {
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  $("#screenTitle").textContent = TITLES[tab];
  const ws = weekStart(), we = addDays(ws, 6);
  $("#weekLabel").textContent = `Paycheck week · ${fmtDate(ws)} – ${fmtDate(we)}`;
  const v = $("#view"); v.innerHTML = "";
  if (loadNote) v.append(el("div", { class: "banner row" }, el("span", {}, loadNote), el("button", { class: "btn sm", onclick: () => { loadNote = ""; render(); } }, "OK")));
  if (!S.onboarded) { v.append(onboarding()); return; }
  if (S.settings.isExample) v.append(el("div", { class: "banner" }, "You're using example numbers. Go to More → Import settings to load your own budget."));
  if (!storageOk) v.append(el("div", { class: "banner" }, "This device isn't saving data. Export a backup from More."));
  const lo = leftoverPrompt(); if (lo) v.append(lo);
  const bk = backupNudge(); if (bk && tab === "spend") v.append(bk);
  ({ spend: viewSpend, week: viewWeek, money: viewMoney, goals: viewGoals, more: viewMore })[tab](v);
}

/* ---------- Onboarding ---------- */
function onboarding() {
  const file = el("input", { type: "file", accept: "application/json,.json", hidden: true, onchange: e => { importFile(e.target.files[0]); e.target.value = ""; } });
  return el("div", { class: "card stack" },
    el("h2", {}, "Welcome"),
    el("p", { class: "muted", style: "margin:0" }, "This app keeps your budget on this phone only. It works offline and never connects to your bank."),
    el("p", { class: "muted", style: "margin:0" }, "If you have a settings file, import it now. Otherwise start with example numbers and edit them in More → Settings."),
    file,
    el("button", { class: "btn", onclick: () => file.click() }, "Import my settings file"),
    el("button", { class: "btn ghost", onclick: () => { S.onboarded = true; save(); render(); } }, "Start with example numbers"));
}

/* ---------- Friday leftover ---------- */
function leftoverPrompt() {
  const r = prevWeekResult();
  if (r.done || !r.active) return null;
  if (r.net <= 0) {
    return el("div", { class: "card stack" },
      el("h2", {}, r.net < 0 ? `Last week you went over by ${money(-r.net)}` : "Last week came out exactly even"),
      el("p", { class: "muted small", style: "margin:0" }, r.net < 0 ? "Nothing to roll over. A fresh week starts now." : "Nothing left over. A fresh week starts now."),
      el("button", { class: "btn ghost", onclick: () => { resolveLeftover("none"); render(); } }, "Got it"));
  }
  const goalSel = el("select", { class: "input", "aria-label": "Goal" }, S.settings.goals.map(g => el("option", { value: g.name }, g.name)));
  const overNote = r.pos > r.net ? ` (after ${money(r.pos - r.net)} of overspending)` : "";
  return el("div", { class: "card stack" },
    el("h2", {}, `Last week you had ${money(r.net)} left${overNote}`),
    el("p", { class: "muted small", style: "margin:0" }, "Keep it for this week, or set it aside for a goal."),
    el("button", { class: "btn ghost", onclick: () => { resolveLeftover("roll"); toast(`Added ${money(r.net)} to this week`); render(); } }, "Roll it into this week"),
    goalSel,
    el("button", { class: "btn", onclick: () => { resolveLeftover("goal", goalSel.value); toast("Added to your to-move list on Goals"); render(); } }, "Send it to this goal"));
}

/* ---------- Backup nudge ---------- */
function backupNudge() {
  if (!S.tx.length) return null;
  const since = Date.now() - (S.lastExport || 0);
  if (S.lastExport && since < 7 * DAY) return null;
  const firstTx = Math.min(...S.tx.map(t => t.ts));
  if (!S.lastExport && Date.now() - firstTx < 7 * DAY) return null;
  return el("div", { class: "banner row" }, el("span", {}, S.lastExport ? `Last backup was ${Math.floor(since / DAY)} days ago.` : "You haven't backed up yet."),
    el("button", { class: "btn sm", onclick: exportBackup }, "Back up now"));
}

/* ---------- Spend tab ---------- */
let draft = { cat: null, day: null, kind: "budget", refund: false, goal: "" };
function viewSpend(v) {
  const wt = weekTotals(), days = daysLeftInWeek(), perDay = r2(wt.left / days);
  v.append(el("section", { class: "card hero" },
    el("div", {}, el("div", { class: "k" }, "Left this week"), el("div", { class: "v" + (wt.left < 0 ? " bad" : "") }, money(wt.left))),
    el("div", {}, el("div", { class: "k" }, `Safe per day · ${days} day${days > 1 ? "s" : ""} left`), el("div", { class: "v" + (perDay < 0 ? " bad" : "") }, money(Math.max(perDay, 0))))));

  const today = isoDay(new Date()), yest = isoDay(addDays(new Date(), -1));
  // A date you picked is kept for 15 minutes; otherwise it's always today (so leaving the app open overnight can't log to yesterday).
  if (!draft.day || (draft.day !== today && !(draft.dayAt && Date.now() - draft.dayAt < 15 * 60000))) { draft.day = today; draft.dayAt = 0; }
  const amt = el("input", { class: "amt", inputmode: "decimal", autocomplete: "off", placeholder: "0.00", "aria-label": "Amount in dollars", id: "amt" });
  const note = el("input", { class: "input", placeholder: "What is it? (optional)", maxlength: "80", autocomplete: "off", id: "note" });
  const verdict = el("div", { class: "verdict v-idle" });
  const amtErr = el("p", { class: "small bad-text", style: "margin:0", role: "alert" });
  const coverBox = el("div", { class: "stack" });
  const logBtn = el("button", { class: "btn", disabled: true, id: "logBtn" }, "Log it as spent");
  const chips = el("div", { class: "chips", role: "group", "aria-label": "Category" });
  const dateIn = el("input", { type: "date", class: "input sm", value: draft.day, max: today, id: "day", "aria-label": "Date" });
  const dayChips = el("div", { class: "chips" });
  const drawDays = () => { dayChips.innerHTML = ""; for (const [k, txt] of [[today, "Today"], [yest, "Yesterday"]]) dayChips.append(el("button", { class: "chip sm", type: "button", "aria-pressed": draft.day === k ? "true" : "false", onclick: () => { draft.day = k; draft.dayAt = Date.now(); dateIn.value = k; drawDays(); judge(); } }, txt)); dayChips.append(dateIn); };
  dateIn.addEventListener("change", () => {
    if (dateIn.value > today) { toast("You can't log a purchase in the future. Using today."); dateIn.value = today; }
    draft.day = dateIn.value || today; draft.dayAt = Date.now(); drawDays(); judge(); });
  const refundChk = el("input", { type: "checkbox", id: "refund", checked: draft.refund });
  refundChk.addEventListener("change", () => { draft.refund = refundChk.checked; judge(); });
  const goalSel = el("select", { class: "input", id: "pgoal", "aria-label": "Paid from goal" },
    el("option", { value: "" }, "Not from a goal"), S.settings.goals.map(g => el("option", { value: g.name, selected: g.name === draft.goal }, `From ${g.name} (${money0(+g.saved || 0)})`)));
  goalSel.addEventListener("change", () => { draft.goal = goalSel.value; judge(); });
  const goalRow = el("div", {}, goalSel); goalRow.hidden = draft.kind !== "planned";
  const kindOpts = [...Object.entries(KINDS), ["gift", "Gift"]];
  const kindSeg = segmented(kindOpts, draft.kind === "planned" && draft.goal && draft.goal === giftGoal() ? "gift" : draft.kind, k => {
    if (k === "gift") { draft.kind = "planned"; draft.goal = giftGoal(); goalSel.value = draft.goal; if (!draft.cat) { const o = catById("other"); if (o) { draft.cat = "other"; drawChips(); } } }
    else { draft.kind = k; if (k !== "planned") draft.goal = ""; }
    goalRow.hidden = draft.kind !== "planned"; judge();
  }, "Type");
  const lateHint = el("p", { class: "muted small", style: "margin:0" });

  function drawChips() {
    chips.innerHTML = "";
    for (const c of allCats()) chips.append(el("button", { class: "chip", type: "button", "aria-pressed": draft.cat === c.id ? "true" : "false", onclick: () => { draft.cat = c.id; drawChips(); judge(); } }, c.name));
  }
  function judge() {
    const a = parseAmt(amt.value), c = draft.cat && catById(draft.cat), d = fromIso(draft.day || today);
    logBtn.disabled = !(a && c); coverBox.innerHTML = ""; delete logBtn.dataset.sure;
    const now = new Date(), isWeekStartDay = now.getDay() === S.settings.weekStartDay, isNextMorning = now.getDay() === (S.settings.weekStartDay + 1) % 7 && now.getHours() < 12;
    lateHint.textContent = draft.day === today && (isWeekStartDay || isNextMorning) ? "A new week started Friday. If you bought this before then, open Date and pick the day so it counts in last week." : "";
    logBtn.textContent = draft.refund ? "Log refund" : "Log it as spent";
    const set = (cls, head, msg) => { verdict.className = "verdict " + cls; verdict.replaceChildren(el("span", { class: "dot" }), el("div", {}, el("b", {}, head), el("p", {}, msg))); };
    amtErr.textContent = !a && amt.value.trim() ? `Not a valid amount. Use numbers like 12.50 or 1,250 (up to ${money0(MAX_AMT)}).` : "";
    if (!a && amt.value.trim()) return set("v-bad", "That doesn't look like an amount", `Use numbers like 12.50 or 1,250 (up to ${money0(MAX_AMT)}).`);
    if (!a || !c) return set("v-idle", !a ? "Enter an amount" : "Pick a category", !a ? "Type what it costs." : "Tap where this money comes from.");
    const per = c.period === "week" ? (isoDay(weekStart(d)) === isoDay(weekStart()) ? "this week" : "that week") : "this month", nm = c.name.toLowerCase();
    if (draft.kind === "work") return set("v-ok", "Doesn't count against your week", "Logged as a work purchase. It goes on your Owed to me list until you're paid back.");
    if (draft.kind === "planned") {
      const g = S.settings.goals.find(x => x.name === draft.goal);
      if (!g) return set("v-ok", "Doesn't count against your week", "Logged as planned spending paid from savings.");
      const after = r2((+g.saved || 0) - (draft.refund ? -a : a));
      return set(after < 0 ? "v-warn" : "v-ok", draft.refund ? `Refund back to ${g.name}` : `Paid from ${g.name}`, after < 0 ? `That's ${money(-after)} more than ${g.name} has. It will show as negative.` : `${g.name} goes from ${money(+g.saved || 0)} to ${money(after)}. Doesn't count against your week.`);
    }
    if (draft.refund) { const sp = spent(c, d);
      return a > sp ? set("v-warn", "That's more than you spent here", `You've only spent ${money(Math.max(sp, 0))} on ${nm} ${per}. A refund should only give back what you paid. Check the category or the date.`)
        : set("v-ok", "Refund", `Adds ${money(a)} back to ${nm} ${per}.`); }
    const lf = left(c, d), after = r2(lf - a), lim = effLimit(c, d), used = lim > 0 ? (lim - after) / lim : 1;
    if (after < 0) {
      set("v-bad", "No, it doesn't fit", `That's ${money(-after)} over. You have ${money(Math.max(lf, 0))} left for ${nm} ${per}.`);
      const opts = coverOptions(c, -after, d).slice(0, 2);
      if (opts.length) {
        coverBox.append(el("div", { class: "eyebrow" }, "Or cover it from"));
        for (const o of opts) coverBox.append(el("button", { class: "btn ghost sm full", type: "button", onclick: () => { coverMove(o.cat.id, c.id, o.take, d); toast(`Moved ${money(o.take)} from ${o.cat.name}`); judge(); } },
          o.take >= -after ? `Cover ${money(o.take)} from ${o.cat.name}` : `Take ${money(o.take)} from ${o.cat.name} (all it has)`));
      } else coverBox.append(el("p", { class: "muted small", style: "margin:0" }, c.period === "week" ? "No other category has money left. The week resets Friday." : "No other monthly category has money left."));
    } else if (used > 0.8) set("v-warn", "Tight, but it fits", `You'd have ${money(after)} left for ${nm} ${per} (${Math.round(used * 100)}% used).`);
    else set("v-ok", "Yes, go for it", `You'll still have ${money(after)} left for ${nm} ${per}.`);
  }
  amt.addEventListener("input", judge);
  logBtn.addEventListener("click", () => {
    const a = parseAmt(amt.value); if (!a || !draft.cat) return;
    if (a >= 1000 && !logBtn.dataset.sure) { logBtn.dataset.sure = "1"; logBtn.textContent = `Tap again to log ${money(a)}`; return; }
    addTx({ amount: a, cat: draft.cat, note: note.value.trim(), day: draft.day, kind: draft.kind, refund: draft.refund, goal: draft.kind === "planned" ? draft.goal : "" });
    toast(`${draft.refund ? "Refund" : "Logged"} ${money(a)} · ${catById(draft.cat).name}${draft.kind === "planned" && draft.goal ? " · from " + draft.goal : ""}${adjNote ? ". " + adjNote : ""}`);
    draft = { cat: null, day: null, kind: "budget", refund: false, goal: "" }; render();
  });

  const favs = S.settings.favorites || [];
  const favWrap = favs.length ? el("div", { class: "grid2" }, favs.map(f => el("button", { class: "fav", type: "button", onclick: () => {
    draft.cat = f.cat; if (f.amount) amt.value = f.amount; note.value = f.label; drawChips(); judge(); if (!f.amount) amt.focus();
  } }, el("b", {}, f.label), el("span", { class: "muted" }, (catById(f.cat) || {}).name || "", f.amount ? ` · ${money0(f.amount)}` : "")))) : null;

  const more = el("details", { class: "more" }, el("summary", {}, "Date, gift, work purchase, refund"),
    el("div", { class: "stack", style: "margin-top:10px" },
      el("div", { class: "eyebrow" }, "When"), dayChips,
      el("div", { class: "eyebrow" }, "Type"), kindSeg, goalRow,
      el("label", { class: "row small", for: "refund", style: "justify-content:flex-start" }, refundChk, "This is a refund or return")));
  if (draft.day !== today || draft.kind !== "budget" || draft.refund) more.open = true;

  v.append(el("section", { class: "card stack", "aria-label": "Check a purchase" },
    el("label", { for: "amt", class: "eyebrow" }, "How much?"),
    el("div", { class: "amtrow" }, el("span", {}, "$"), amt), amtErr,
    chips, favWrap ? el("div", { class: "eyebrow" }, "Favorites") : null, favWrap, note, more, lateHint, verdict, coverBox, logBtn));
  drawChips(); drawDays(); judge();

  const recent = S.tx.filter(t => t.ts >= weekStart().getTime()).sort((a, b) => b.ts - a.ts).slice(0, 5);
  v.append(el("section", { class: "card" }, el("h2", {}, "Latest this week"), txList(recent, "Nothing logged yet this week.")));
}

function txList(rows, emptyMsg) {
  if (!rows.length) return el("p", { class: "empty" }, emptyMsg);
  return el("div", {}, rows.map(t => {
    const c = catById(t.cat) || { name: t.cat };
    const tags = [];
    if (t.kind === "work") tags.push(el("span", { class: "badge" }, t.reimbursed ? "Work · paid back" : "Work"));
    if (t.kind === "planned") tags.push(el("span", { class: "badge" }, t.goal ? `From ${t.goal}` : "Planned"));
    if (t.amount < 0) tags.push(el("span", { class: "badge ok" }, "Refund"));
    return el("button", { class: "item tap", type: "button", onclick: () => editTx(t.id), "aria-label": `Edit ${t.note || c.name}` },
      el("div", { class: "what" }, el("div", {}, t.note || c.name, " ", tags), el("div", { class: "meta" }, `${c.name} · ${fmtDate(new Date(t.ts), { weekday: "short", month: "short", day: "numeric" })}`)),
      el("span", { class: "num" }, money(t.amount)));
  }));
}
function editTx(id) {
  const t = S.tx.find(x => x.id === id); if (!t) return;
  let kind = t.kind;
  const amt = el("input", { class: "input num", inputmode: "decimal", value: Math.abs(t.amount), id: "eamt" });
  const cat = el("select", { class: "input", id: "ecat" }, allCats().map(c => el("option", { value: c.id, selected: c.id === t.cat }, c.name)));
  const day = el("input", { type: "date", class: "input", value: isoDay(new Date(t.ts)), max: isoDay(new Date()), id: "eday" });
  const note = el("input", { class: "input", value: t.note || "", maxlength: "80", id: "enote" });
  const refund = el("input", { type: "checkbox", id: "erefund", checked: t.amount < 0 });
  const egoal = el("select", { class: "input", id: "egoal" }, el("option", { value: "" }, "Not from a goal"), S.settings.goals.map(g => el("option", { value: g.name, selected: g.name === t.goal }, g.name)));
  let armed = false;
  const del = el("button", { class: "btn danger", onclick: () => { if (!armed) { armed = true; del.textContent = "Tap again to delete"; return; } deleteTx(id); closeSheet(); toast("Deleted"); render(); } }, "Delete");
  openSheet(el("div", { class: "stack" }, el("h2", {}, "Edit purchase"),
    el("div", { class: "grid2" }, el("div", { class: "field" }, el("label", { for: "eamt" }, "Amount"), amt), el("div", { class: "field" }, el("label", { for: "eday" }, "Date"), day)),
    el("div", { class: "field" }, el("label", { for: "ecat" }, "Category"), cat),
    el("div", { class: "field" }, el("label", { for: "enote" }, "Note"), note),
    segmented(Object.entries(KINDS), kind, k => { kind = k; }, "Type"),
    el("div", { class: "field" }, el("label", { for: "egoal" }, "Paid from goal (Planned type only)"), egoal),
    el("label", { class: "row small", for: "erefund", style: "justify-content:flex-start" }, refund, "Refund or return"),
    el("button", { class: "btn", onclick: () => {
      const a = parseAmt(amt.value); if (!a) { toast("Enter a valid amount, like 12.50"); return; }
      if (day.value > isoDay(new Date())) { toast("You can't move a purchase into the future."); return; }
      const sameDay = day.value === isoDay(new Date(t.ts));
      updateTx(id, { amount: refund.checked ? -a : a, cat: cat.value, note: note.value.trim(), kind, goal: kind === "planned" ? egoal.value : undefined, ts: sameDay ? t.ts : tsFor(day.value) });
      closeSheet(); toast("Saved" + (adjNote ? ". " + adjNote : "")); render();
    } }, "Save"),
    del, el("button", { class: "btn ghost", onclick: closeSheet }, "Cancel")));
}

/* ---------- Week tab ---------- */
function catRow(c) {
  const lim = effLimit(c), sp = spent(c), lf = r2(lim - sp), pct = lim > 0 ? sp / lim * 100 : (sp > 0 ? 100 : 0);
  const state = lf < 0 ? "bad" : pct > 80 ? "warn" : "";
  const sub = el("div", { class: "sub" }, el("span", {}, `${money(sp)} of ${money(lim)}` + (lim !== c.limit ? ` (base ${money0(c.limit)})` : "")));
  if (lf < 0) sub.append(el("button", { class: "linkbtn", type: "button", onclick: () => coverSheet(c, -lf) }, "Cover it"));
  return el("div", { class: "cat" },
    el("span", { class: "name" }, c.name),
    el("span", { class: "left" + (lf < 0 ? " bad" : "") }, lf < 0 ? `${money(-lf)} over` : `${money(lf)} left`),
    bar(pct, state), sub);
}
function coverSheet(c, over) {
  const opts = coverOptions(c, over);
  const node = el("div", { class: "stack" }, el("h2", {}, `Cover ${money(over)} on ${c.name}`),
    el("p", { class: "muted small", style: "margin:0" }, `Move money from a category that still has some left this ${c.period}.`));
  if (!opts.length) node.append(el("p", { class: "empty" }, "No other category has money left. It resets on Friday."));
  for (const o of opts) node.append(el("button", { class: "btn ghost", onclick: () => { coverMove(o.cat.id, c.id, o.take); closeSheet(); toast(`Moved ${money(o.take)} from ${o.cat.name}`); render(); } },
    `Take ${money(o.take)} from ${o.cat.name} (has ${money(o.avail)})`));
  node.append(el("button", { class: "btn ghost", onclick: closeSheet }, "Cancel"));
  openSheet(node);
}
function viewWeek(v) {
  const wt = weekTotals();
  const coversThisWeek = S.moves.filter(m => m.period === isoDay(weekStart())).length;
  v.append(el("section", { class: "card hero" },
    el("div", {}, el("div", { class: "k" }, "Spent this week"), el("div", { class: "v" }, money(wt.spent))),
    el("div", {}, el("div", { class: "k" }, "Weekly budget"), el("div", { class: "v" }, money(wt.limit)))));
  if (coversThisWeek >= 3) v.append(el("div", { class: "banner" }, `You've moved money between categories ${coversThisWeek} times this week. Covering shifts money around but doesn't add any: the week's total is still ${money(wt.left)}.`));
  v.append(el("section", { class: "card" }, el("h2", {}, "Weekly (resets Friday)"), el("div", {}, allCats().filter(c => c.period === "week").map(catRow))));
  const mcats = allCats().filter(c => c.period === "month");
  const mSpent = r2(S.tx.filter(t => t.kind === "budget" && t.ts >= monthStart().getTime()).reduce((s, t) => s + t.amount, 0));
  v.append(el("section", { class: "card" }, el("h2", {}, "Monthly"), el("div", {}, mcats.map(catRow)),
    el("div", { class: "row small muted", style: "margin-top:10px" }, el("span", {}, "All budget spending this month"), el("span", { class: "num" }, money(mSpent)))));
  const rows = S.tx.filter(t => t.ts >= weekStart().getTime()).sort((a, b) => b.ts - a.ts);
  v.append(el("section", { class: "card" }, el("h2", {}, "Logged this week"), el("p", { class: "muted small", style: "margin:0 0 6px" }, "Tap a purchase to edit it."), txList(rows, "Nothing logged yet this week.")));
  const pw = pastWeeks(8);
  v.append(el("section", { class: "card" }, el("h2", {}, "Past weeks"),
    pw.length ? el("div", {}, pw.map((w, i) => {
      const prevW = pw[i + 1]; const diff = prevW ? r2(w.spent - prevW.spent) : null;
      return el("div", { class: "item" },
        el("div", { class: "what" }, el("div", {}, `Week of ${fmtDate(w.start)}`), el("div", { class: "meta" }, `${money0(w.spent)} of ${money0(w.limit)}` + (diff == null ? "" : diff <= 0 ? ` · ${money0(-diff)} less than the week before` : ` · ${money0(diff)} more than the week before`))),
        el("span", { class: "badge " + (w.left >= 0 ? "ok" : "soon") }, w.left >= 0 ? `${money0(w.left)} under` : `${money0(-w.left)} over`));
    })) : el("p", { class: "empty" }, "Your past weeks will show here.")));
}

/* ---------- Money tab ---------- */
function nextDue(day, from = new Date()) {
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const mk = (y, m) => { const last = new Date(y, m + 1, 0).getDate(); return new Date(y, m, Math.min(day, last)); };
  let d = mk(today.getFullYear(), today.getMonth());
  if (d < today) d = mk(today.getFullYear(), today.getMonth() + 1);
  return d;
}
function viewMoney(v) {
  const today = new Date(), nextPay = addDays(weekStart(), 7);
  const bills = (S.settings.bills || []).map(b => ({ ...b, due: nextDue(b.day) })).sort((a, b) => a.due - b.due);
  const beforePay = r2(bills.filter(b => b.due < nextPay).reduce((s, b) => s + (+b.amount || 0), 0));
  v.append(el("section", { class: "card hero" },
    el("div", {}, el("div", { class: "k" }, "Bills before next payday"), el("div", { class: "v" }, money(beforePay))),
    el("div", {}, el("div", { class: "k" }, "Next payday"), el("div", { class: "v", style: "font-size:20px" }, fmtDate(nextPay, { weekday: "short", month: "short", day: "numeric" })))));

  const owed = S.tx.filter(t => t.kind === "work" && !t.reimbursed);
  if (owed.length) v.append(el("section", { class: "card" }, el("h2", {}, `Owed to me · ${money(owed.reduce((s, t) => s + t.amount, 0))}`),
    el("div", {}, owed.map(t => el("div", { class: "item" },
      el("div", { class: "what" }, el("div", {}, t.note || "Work purchase"), el("div", { class: "meta" }, fmtDate(new Date(t.ts), { month: "short", day: "numeric" }))),
      el("div", { class: "row" }, el("span", { class: "num" }, money(t.amount)), el("button", { class: "del", type: "button", onclick: () => { markReimbursed(t.id); toast("Marked as paid back. Put it toward the card it was charged to."); render(); } }, "Paid back")))))));

  v.append(el("section", { class: "card" }, el("h2", {}, "Upcoming bills"),
    bills.length ? el("div", {}, bills.map(b => {
      const d = Math.round((b.due - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / DAY);
      return el("div", { class: "item" },
        el("div", { class: "what" }, el("div", {}, b.name), el("div", { class: "meta" }, `${fmtDate(b.due, { weekday: "short", month: "short", day: "numeric" })}${b.note ? " · " + b.note : ""}`)),
        el("div", { class: "row" }, el("span", { class: "badge" + (d <= 3 ? " soon" : "") }, d === 0 ? "Today" : d === 1 ? "Tomorrow" : `${d} days`), el("span", { class: "num" }, b.amount ? money(b.amount) : "varies")));
    })) : el("p", { class: "empty" }, "No bills set up. Add them by importing your settings file.")));

  const pay = el("input", { class: "input num", inputmode: "decimal", placeholder: "Net pay, e.g. 2266.11", "aria-label": "Net pay", id: "pay" });
  const out = el("div", { class: "stack" });
  const recBtn = el("button", { class: "btn", disabled: true }, "Save this paycheck");
  function calc() {
    const p = parseAmt(pay.value); out.innerHTML = ""; recBtn.disabled = !p; if (!p) return;
    const chk = Math.min(p, S.settings.checkingPerCheck), rest = r2(p - chk);
    out.append(el("div", { class: "item" }, el("div", {}, el("b", {}, "Checking"), el("div", { class: "meta" }, "Bills + spending")), el("span", { class: "num" }, money(chk))));
    out.append(el("div", { class: "item" }, el("div", {}, el("b", {}, "To savings"), el("div", { class: "meta" }, "Overtime")), el("span", { class: "num" }, money(rest))));
    for (const s of S.settings.splits) out.append(el("div", { class: "item" }, el("div", { class: "what" }, `↳ ${s.goal} (${s.pct}%)`), el("span", { class: "num" }, money(r2(rest * s.pct / 100)))));
    const tot = S.settings.splits.reduce((a, s) => a + (+s.pct || 0), 0);
    if (tot !== 100) out.append(el("div", { class: "banner" }, `Your splits add up to ${tot}%, not 100%. Fix them in More → Settings.`));
  }
  pay.addEventListener("input", calc);
  recBtn.addEventListener("click", () => { const p = parseAmt(pay.value); if (!p) return; const rest = recordPaycheck(p); toast(rest > 0 ? "Saved. Check off each move on the Goals tab." : "Paycheck saved"); render(); });
  v.append(el("section", { class: "card stack" }, el("h2", {}, "Split a paycheck"),
    el("p", { class: "muted small", style: "margin:0" }, `${money0(S.settings.checkingPerCheck)} stays in checking. The rest is split by goal and added to your to-move list. Goal balances only change after you check them off.`),
    pay, out, recBtn));
  const pcs = S.paychecks.slice(-6).reverse();
  if (pcs.length) v.append(el("section", { class: "card" }, el("h2", {}, "Recent paychecks"), el("div", {}, pcs.map(p =>
    el("div", { class: "item" }, el("div", { class: "what" }, el("div", {}, money(p.net)), el("div", { class: "meta" }, `${p.date} · ${money(p.toGoals)} to goals`)))))));
}

/* ---------- Goals tab ---------- */
function viewGoals(v) {
  if (S.pending.length) v.append(el("section", { class: "card" }, el("h2", {}, `To move in SoFi · ${money(S.pending.reduce((s, p) => s + p.amount, 0))}`),
    el("p", { class: "muted small", style: "margin:0 0 6px" }, "Check one off after you move it. That's when the goal balance goes up."),
    el("div", {}, S.pending.map(p => el("div", { class: "item" },
      el("div", { class: "what" }, el("div", {}, `${money(p.amount)} → ${p.goal}`), el("div", { class: "meta" }, p.note)),
      el("div", { class: "row" }, el("button", { class: "btn sm", type: "button", onclick: () => { confirmPending(p.id); toast(`${p.goal} +${money(p.amount)}`); render(); } }, "Moved ✓"),
        el("button", { class: "del", type: "button", "aria-label": "Skip", onclick: () => { dismissPending(p.id); render(); } }, "Skip")))))));
  const goals = S.settings.goals || [];
  v.append(el("section", { class: "card" }, el("h2", {}, "Savings goals"),
    goals.length ? el("div", {}, goals.map((g, i) => {
      const pct = g.target ? (+g.saved || 0) / g.target * 100 : 0;
      return el("div", { class: "goal" },
        el("div", { class: "row" }, el("b", {}, g.name), el("span", { class: "num small" }, `${money0(+g.saved || 0)} / ${money0(g.target)}`)),
        bar(pct, ""),
        el("div", { class: "row small muted", style: "margin-top:4px" },
          el("span", {}, (pct >= 100 ? "Done! " : `${Math.round(pct)}%`) + (g.by ? ` · by ${fmtDate(new Date(g.by + "T12:00"), { month: "short", year: "numeric" })}` : "")),
          el("button", { class: "linkbtn", type: "button", onclick: () => editGoal(i) }, "Update")));
    })) : el("p", { class: "empty" }, "No goals yet.")));
  const today = new Date(new Date().toDateString());
  const gifts = (S.settings.gifts || []).filter(g => g.date).map(g => ({ ...g, d: new Date(g.date + "T12:00") })).filter(g => g.d >= today).sort((a, b) => a.d - b.d);
  const undated = (S.settings.gifts || []).filter(g => !g.date);
  v.append(el("section", { class: "card" }, el("h2", {}, "Gifts coming up"),
    gifts.length || undated.length ? el("div", {}, [...gifts, ...undated].map(g => el("div", { class: "item" },
      el("div", { class: "what" }, el("div", {}, `${g.who} · ${g.occasion}`), el("div", { class: "meta" }, g.d ? fmtDate(g.d, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "Date to add")),
      el("span", { class: "num" }, money0(g.budget))))) : el("p", { class: "empty" }, "No gifts listed.")));
}
function editGoal(i) {
  const g = S.settings.goals[i];
  const saved = el("input", { class: "input num", inputmode: "decimal", value: g.saved, id: "gsaved" });
  const target = el("input", { class: "input num", inputmode: "decimal", value: g.target, id: "gtarget" });
  openSheet(el("div", { class: "stack" }, el("h2", {}, g.name),
    el("div", { class: "grid2" }, el("div", { class: "field" }, el("label", { for: "gsaved" }, "Saved so far"), saved), el("div", { class: "field" }, el("label", { for: "gtarget" }, "Target"), target)),
    el("p", { class: "muted small", style: "margin:0" }, "Tip: match this to your SoFi Vault balance."),
    el("button", { class: "btn", onclick: () => {
      const sv = parseNum(saved.value), tg = parseNum(target.value);
      if (!isFinite(sv)) { toast("Saved so far needs a number, like 9,348.75"); return; }
      if (!isFinite(tg) || tg <= 0) { toast("Target needs a number above 0, like 11,000"); return; }
      g.saved = r2(sv); g.target = r2(tg); save(); closeSheet(); render(); } }, "Save"),
    el("button", { class: "btn ghost", onclick: closeSheet }, "Cancel")));
}

/* ---------- More tab ---------- */
function viewMore(v) {
  const ws = weekStart(), key = isoDay(ws), wt = weekTotals();
  const rows = S.tx.filter(t => t.ts >= ws.getTime() && t.kind === "budget");
  const top = [...rows].sort((a, b) => b.amount - a.amount).slice(0, 3);
  const over = allCats().filter(c => c.period === "week" && left(c) < 0);
  const lastWk = pastWeeks(1)[0];
  const notes = el("textarea", { class: "input", rows: "2", placeholder: "One thing to do differently next week", id: "rnote" }, (S.reviews[key] || {}).note || "");
  v.append(el("section", { class: "card stack" }, el("h2", {}, "Weekly review (5 minutes)"),
    el("div", { class: "small" },
      el("div", {}, `• Spent ${money(wt.spent)} of ${money(wt.limit)} this week (${rows.length} purchases).`),
      lastWk ? el("div", {}, `• Last week: ${money0(lastWk.spent)} of ${money0(lastWk.limit)}.`) : null,
      el("div", {}, over.length ? `• Over in: ${over.map(c => c.name).join(", ")}.` : "• No category over budget. 👍"),
      top.length ? el("div", {}, `• Biggest: ${top.map(t => `${t.note || catById(t.cat)?.name} ${money0(t.amount)}`).join(", ")}.`) : null,
      S.pending.length ? el("div", {}, `• ${S.pending.length} goal move${S.pending.length > 1 ? "s" : ""} waiting on the Goals tab.`) : null,
      el("div", {}, "• Did every card purchase get logged? Compare with your Chase and Apple Card apps.")),
    forgotCheck(),
    notes,
    el("button", { class: "btn ghost", onclick: () => { S.reviews[key] = { note: notes.value.trim(), at: Date.now() }; save(); toast("Review saved"); } }, S.reviews[key] ? "Update review" : "Mark week reviewed")));

  const file = el("input", { type: "file", accept: "application/json,.json", hidden: true, onchange: e => { importFile(e.target.files[0]); e.target.value = ""; } });
  v.append(el("section", { class: "card stack" }, el("h2", {}, "Backup & share with Claude"),
    el("p", { class: "muted small", style: "margin:0" }, (S.lastExport ? `Last backup: ${fmtDate(new Date(S.lastExport), { month: "short", day: "numeric" })}. ` : "") + "Your data only lives on this phone. Export a backup every week and send it at your check-in."),
    el("button", { class: "btn", onclick: exportBackup }, "Export backup (.json)"),
    el("button", { class: "btn ghost", onclick: exportCSV }, "Export purchases (.csv)"),
    file, el("button", { class: "btn ghost", onclick: () => file.click() }, "Import settings or restore backup"),
    undoInfo() ? el("button", { class: "btn ghost", onclick: undoImport }, `Undo last ${undoInfo()}`) : null));

  v.append(settingsCard());

  let armed = false;
  const reset = el("button", { class: "btn danger", onclick: () => {
    if (armed) { try { localStorage.removeItem(STORE_KEY); } catch (e) {} S = blankState(); save(); render(); toast("All data erased"); return; }
    armed = true; reset.textContent = "Tap again to erase everything"; setTimeout(() => { armed = false; reset.textContent = "Erase all data on this phone"; }, 4000);
  } }, "Erase all data on this phone");
  v.append(el("section", { class: "card stack" }, el("h2", {}, "Reset"), reset));
  v.append(el("p", { class: "muted small", style: "text-align:center" }, "Works offline · no account · no bank connection · v4"));
}

function undoInfo() { try { const u = JSON.parse(localStorage.getItem(UNDO_KEY) || "null"); return u && Date.now() - u.at < 14 * DAY ? `${u.label} (${fmtDate(new Date(u.at))})` : ""; } catch (e) { return ""; } }
/* "Forgot anything?" — compare what the card apps show with what was logged. */
function forgotCheck() {
  const inp = el("input", { class: "input num", inputmode: "decimal", placeholder: "Card charges since Friday, e.g. 312.40", id: "cardtot" });
  const out = el("div", {});
  const run = () => {
    const card = parseAmt(inp.value), logged = loggedThisWeek(); out.innerHTML = "";
    if (!card) return;
    const gap = r2(card - logged);
    if (Math.abs(gap) < 1) out.append(el("div", { class: "banner ok" }, `Everything's logged. Card ${money(card)}, app ${money(logged)}.`));
    else if (gap > 0) out.append(el("div", { class: "banner stack" }, el("span", {}, `About ${money(gap)} isn't logged (card ${money(card)}, app ${money(logged)}). Look through your card app for what's missing.`),
      el("button", { class: "btn sm", onclick: () => { tab = "spend"; draft.day = null; render(); setTimeout(() => { const d = document.querySelector("details.more"); if (d) d.open = true; const a = $("#amt"); if (a) a.focus(); }, 50); } }, "Log a missed purchase")));
    else out.append(el("div", { class: "banner" }, `The app shows ${money(-gap)} more than your card (card ${money(card)}, app ${money(logged)}). Check for a duplicate or a cash purchase.`));
  };
  inp.addEventListener("input", run);
  return el("div", { class: "stack" }, el("div", { class: "eyebrow" }, "Forgot anything?"),
    el("p", { class: "muted small", style: "margin:0" }, "Add up this week's charges in your Chase and Apple Card apps and type the total."), inp, out);
}

function settingsCard() {
  const s = S.settings;
  const wrap = el("section", { class: "card stack" }, el("h2", {}, "Settings"));
  const chk = el("input", { class: "input num", inputmode: "decimal", value: s.checkingPerCheck, id: "chk" });
  wrap.append(el("div", { class: "field" }, el("label", { for: "chk" }, "Keep in checking per paycheck"), chk));
  const limInputs = [];
  for (const [grp, label] of [["weekly", "Weekly limits"], ["monthly", "Monthly limits"]]) {
    wrap.append(el("div", { class: "eyebrow" }, label));
    const g = el("div", { class: "grid2" });
    s[grp].forEach((c, i) => { const inp = el("input", { class: "input num", inputmode: "decimal", value: c.limit, id: `lim-${grp}-${i}` }); limInputs.push([grp, i, inp]);
      g.append(el("div", { class: "field" }, el("label", { for: `lim-${grp}-${i}` }, c.name), inp)); });
    wrap.append(g);
  }
  wrap.append(el("div", { class: "eyebrow" }, "Paycheck split (%)"));
  const sg = el("div", { class: "grid2" }); const spl = [];
  s.splits.forEach((x, i) => { const inp = el("input", { class: "input num", inputmode: "numeric", value: x.pct, id: `spl-${i}` }); spl.push(inp);
    sg.append(el("div", { class: "field" }, el("label", { for: `spl-${i}` }, x.goal), inp)); });
  wrap.append(sg);
  wrap.append(el("button", { class: "btn", onclick: () => {
    const ck = parseNum(chk.value); if (!isFinite(ck)) { toast("Checking per paycheck needs a number (0 is OK)."); return; }
    const lims = []; for (const [grp, i, inp] of limInputs) { const n = parseNum(inp.value); if (!isFinite(n)) { toast(`${s[grp][i].name} limit needs a number (0 is OK).`); return; } lims.push([grp, i, r2(n)]); }
    const pcts = s.splits.map((x, i) => parseNum(spl[i].value));
    if (pcts.some(n => !isFinite(n))) { toast("Each paycheck split needs a number."); return; }
    const tot = r2(pcts.reduce((a, n) => a + n, 0));
    if (Math.abs(tot - 100) > 0.01) { toast(`Your splits add up to ${tot}%. They need to add up to exactly 100%. Nothing was saved.`); return; }
    s.checkingPerCheck = r2(ck); for (const [grp, i, n] of lims) s[grp][i].limit = n; s.splits.forEach((x, i) => { x.pct = pcts[i]; });
    s.isExample = false; save(); toast("Settings saved"); render();
  } }, "Save settings"));
  wrap.append(el("p", { class: "muted small", style: "margin:0" }, "To change categories, bills, goals, gifts or favorites, ask Claude for an updated settings file and import it. Your purchases stay."));
  return wrap;
}

/* ---------- Import / export ---------- */
function download(name, text, type) {
  const blob = new Blob([text], { type });
  try { const file = new File([blob], name, { type }); if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: name }).catch(() => {}); return; } } catch (e) {}
  const a = el("a", { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportBackup() { S.lastExport = Date.now(); save(); download(`budget-backup-${isoDay(new Date())}.json`, JSON.stringify({ type: "cibi-backup", version: 2, exported: new Date().toISOString(), state: S }, null, 1), "application/json"); render(); }
function exportCSV() {
  const lines = [["date", "amount", "category", "type", "note"].join(",")];
  for (const t of [...S.tx].sort((a, b) => a.ts - b.ts)) lines.push([isoDay(new Date(t.ts)), (Number(t.amount) || 0).toFixed(2), JSON.stringify((catById(t.cat) || { name: t.cat }).name), t.kind, JSON.stringify(t.note || "")].join(","));
  download(`budget-purchases-${isoDay(new Date())}.csv`, lines.join("\n"), "text/csv");
}
/* Returns a list of problems; empty means the settings are safe to use. */
function checkSettings(st) {
  const errs = [], num = x => typeof x === "number" && isFinite(x);
  if (!st || typeof st !== "object") return ["There are no settings in this file."];
  const ids = new Set();
  for (const [grp, label] of [["weekly", "Weekly"], ["monthly", "Monthly"]]) {
    if (!Array.isArray(st[grp]) || !st[grp].length) { errs.push(`${label} categories are missing.`); continue; }
    for (const c of st[grp]) {
      if (!c || typeof c.id !== "string" || !c.id || typeof c.name !== "string") { errs.push(`A ${label.toLowerCase()} category is missing its id or name.`); continue; }
      if (!num(c.limit) || c.limit < 0 || c.limit > MAX_AMT) errs.push(`${c.name} has a bad limit (${c.limit}).`);
      if (ids.has(c.id)) errs.push(`Two categories use the same id "${c.id}".`); ids.add(c.id);
    }
  }
  for (const k of ["bills", "goals", "gifts", "favorites", "splits"]) if (!Array.isArray(st[k])) errs.push(`"${k}" should be a list.`);
  if (errs.length) return errs;
  const names = new Set();
  for (const g of st.goals) {
    if (!g || typeof g.name !== "string" || !g.name) { errs.push("A goal is missing its name."); continue; }
    if (names.has(g.name)) errs.push(`Two goals are both named "${g.name}".`); names.add(g.name);
    if (!num(+g.saved) || !num(+g.target) || +g.target <= 0) errs.push(`Goal "${g.name}" has a bad saved or target amount.`);
  }
  let tot = 0;
  for (const x of st.splits) {
    if (!x || !num(x.pct) || x.pct < 0) { errs.push("A paycheck split has a bad percent."); continue; }
    if (!names.has(x.goal)) errs.push(`The split for "${x.goal}" doesn't match any goal.`);
    tot += x.pct;
  }
  if (st.splits.length && Math.abs(tot - 100) > 0.01) errs.push(`Paycheck splits add up to ${r2(tot)}%, not 100%.`);
  for (const b of st.bills) if (!b || !num(+b.amount) || !(+b.day >= 1 && +b.day <= 31)) errs.push(`Bill "${(b && b.name) || "?"}" has a bad amount or day.`);
  if (!(Number.isInteger(st.weekStartDay) && st.weekStartDay >= 0 && st.weekStartDay <= 6)) errs.push("The week start day must be 0–6.");
  if (!num(st.checkingPerCheck) || st.checkingPerCheck < 0) errs.push("The checking amount per paycheck is bad.");
  return errs;
}
function rejectFile(errs) {
  openSheet(el("div", { class: "stack" }, el("h2", {}, "This file wasn't imported"),
    el("p", { class: "muted small", style: "margin:0" }, "Nothing on this phone was changed. Problems found:"),
    el("div", { class: "small" }, errs.slice(0, 8).map(e => el("div", {}, "• " + e))),
    el("button", { class: "btn", onclick: closeSheet }, "OK")));
}
const latestDay = list => list.length ? fmtDate(new Date(Math.max(...list.map(t => t.ts))), { month: "short", day: "numeric", year: "numeric" }) : "none";
function keepUndo(label) { try { localStorage.setItem(UNDO_KEY, JSON.stringify({ at: Date.now(), label, state: S })); } catch (e) {} }
function undoImport() {
  try { const u = JSON.parse(localStorage.getItem(UNDO_KEY)); S = migrate(u.state); localStorage.removeItem(UNDO_KEY); save(); toast("Undone. Your data is back the way it was."); }
  catch (e) { toast("Nothing to undo."); }
  tab = "spend"; render();
}
function applyBackup(st) {
  if (S.onboarded && (S.tx.length || !S.settings.isExample)) keepUndo("backup restore");
  S = st; S.onboarded = true; save(); toast("Backup restored. You can undo this in More."); tab = "spend"; render();
}
function restoreBackup(j) {
  const st = migrate(j.state);
  const errs = checkSettings(Object.assign(clone(EXAMPLE_SETTINGS), st.settings));
  if (errs.length) return rejectFile(errs);
  st.settings = Object.assign(clone(EXAMPLE_SETTINGS), st.settings, { isExample: st.settings && st.settings.isExample === true });
  const { tx, dropped } = cleanTx(st.tx); st.tx = tx;
  if (!S.onboarded || (!S.tx.length && S.settings.isExample)) return applyBackup(st);
  const mineNewer = S.tx.length && (!tx.length || Math.max(...S.tx.map(t => t.ts)) > Math.max(...tx.map(t => t.ts)));
  const lost = S.tx.filter(t => !tx.some(b => b.id === t.id)).length;
  openSheet(el("div", { class: "stack" }, el("h2", {}, "Replace everything with this backup?"),
    el("div", { class: "small" },
      el("div", {}, `• Backup: ${tx.length} purchases, latest ${latestDay(tx)}`),
      el("div", {}, `• This phone now: ${S.tx.length} purchases, latest ${latestDay(S.tx)}`),
      dropped ? el("div", {}, `• ${dropped} broken purchase${dropped > 1 ? "s" : ""} in the backup will be skipped`) : null),
    mineNewer || lost ? el("div", { class: "banner" }, `This phone has newer data. ${lost} purchase${lost === 1 ? "" : "s"} on this phone aren't in the backup and would be removed.`) : null,
    el("button", { class: "btn danger", onclick: () => { closeSheet(); applyBackup(st); } }, "Replace with backup"),
    el("button", { class: "btn ghost", onclick: closeSheet }, "Cancel, keep this phone's data")));
}
function applySettings(next, moveMap) {
  if (S.onboarded && !S.settings.isExample) keepUndo("settings import");
  const old = S.onboarded && !S.settings.isExample ? S.settings.goals : null;
  if (old) for (const g of next.goals) { const o = old.find(o => o.name === g.name); if (o && (+o.saved || 0) > (+g.saved || 0)) g.saved = o.saved; }
  for (const [from, to] of Object.entries(moveMap || {})) {
    const o = old.find(x => x.name === from), g = next.goals.find(x => x.name === to); if (!o || !g) continue;
    g.saved = r2((+g.saved || 0) + (+o.saved || 0));
    for (const t of S.tx) if (t.goal === from) t.goal = to;
    for (const p of S.pending) if (p.goal === from) p.goal = to;
  }
  S.settings = next; S.onboarded = true; save(); toast("Settings imported. Your purchases stayed."); tab = "spend"; render();
}
function importSettings(j) {
  const next = Object.assign(clone(EXAMPLE_SETTINGS), j.settings, { isExample: false });
  const errs = checkSettings(next); if (errs.length) return rejectFile(errs);
  const old = S.onboarded && !S.settings.isExample ? S.settings.goals : [];
  const lost = old.filter(o => (+o.saved || 0) !== 0 && !next.goals.some(g => g.name === o.name));
  if (!lost.length || j.keepGoalBalances === false) return applySettings(next, {});
  const fresh = next.goals.filter(g => !old.some(o => o.name === g.name));
  const sels = lost.map(o => {
    const guess = fresh.find(g => g.name.toLowerCase().includes(o.name.toLowerCase()) || o.name.toLowerCase().includes(g.name.toLowerCase()));
    return [o, el("select", { class: "input", "aria-label": `Where ${o.name} goes` },
      fresh.map(g => el("option", { value: g.name, selected: guess === g }, `Move it to ${g.name}`)), el("option", { value: "", selected: !guess }, "Drop this balance"))];
  });
  openSheet(el("div", { class: "stack" }, el("h2", {}, "Some goals aren't in the new file"),
    el("p", { class: "muted small", style: "margin:0" }, "Their balances would be lost. Pick where each one goes (for example, a goal that was renamed)."),
    sels.map(([o, sel]) => el("div", { class: "field" }, el("label", {}, `${o.name} · ${money(+o.saved || 0)}`), sel)),
    el("button", { class: "btn", onclick: () => { const map = {}; for (const [o, sel] of sels) if (sel.value) map[o.name] = sel.value; closeSheet(); applySettings(next, map); } }, "Import settings"),
    el("button", { class: "btn ghost", onclick: closeSheet }, "Cancel")));
}
function importFile(f) {
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    let j; try { j = JSON.parse(rd.result); } catch (e) { return toast("That file isn't a settings or backup file from this app."); }
    try {
      if (j && j.type === "cibi-backup" && j.state && typeof j.state === "object") restoreBackup(j);
      else if (j && j.type === "cibi-settings" && j.settings && typeof j.settings === "object") importSettings(j);
      else toast("That file isn't a settings or backup file from this app.");
    } catch (e) { toast("Couldn't read that file. Nothing was changed."); }
  };
  rd.readAsText(f);
}

/* ---------- Boot ---------- */
if (typeof document !== "undefined" && document.getElementById("view")) {
  document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => { tab = b.dataset.tab; render(); window.scrollTo(0, 0); }));
  $("#sheetBackdrop").addEventListener("click", closeSheet);
  const net = () => { $("#offlinePill").hidden = navigator.onLine; };
  window.addEventListener("online", net); window.addEventListener("offline", net);
  const refresh = () => { if (document.hidden || !$("#sheet").hidden) return; reloadIfChanged(); render(); };
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("focus", refresh);
  window.addEventListener("pageshow", refresh);
  window.addEventListener("storage", e => { if (e.key === STORE_KEY) refresh(); });
  net(); render();
}
