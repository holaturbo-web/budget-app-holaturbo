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

/* ---------- State ---------- */
function blankState() {
  return { version: 1, settings: clone(EXAMPLE_SETTINGS), tx: [], moves: [], rollovers: {}, leftoverDone: {}, paychecks: [], reviews: {}, onboarded: false };
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) { const s = JSON.parse(raw); return Object.assign(blankState(), s); }
  } catch (e) { /* storage blocked or corrupt: fall through */ }
  return blankState();
}
let S = load();
let storageOk = true;
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); storageOk = true; }
  catch (e) { storageOk = false; toast("Couldn't save on this device. Export a backup now."); }
}

/* ---------- Dates ---------- */
const pad = n => String(n).padStart(2, "0");
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function weekStart(d = new Date()) {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  s.setDate(s.getDate() - ((s.getDay() - S.settings.weekStartDay + 7) % 7));
  return s;
}
const monthStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmtDate = (d, o = { month: "short", day: "numeric" }) => d.toLocaleDateString("en-US", o);
function daysLeftInWeek() { const end = addDays(weekStart(), 7); return Math.max(1, Math.ceil((end - new Date()) / DAY)); }

/* ---------- Money ---------- */
const r2 = n => Math.round(n * 100) / 100;
const money = n => (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = n => (n < 0 ? "-" : "") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
const parseAmt = v => { const n = parseFloat(String(v || "").replace(/[^0-9.]/g, "")); return isFinite(n) && n > 0 ? r2(n) : 0; };

/* ---------- Budget math ---------- */
function allCats() { return [...S.settings.weekly.map(c => ({ ...c, period: "week" })), ...S.settings.monthly.map(c => ({ ...c, period: "month" }))]; }
function catById(id) { return allCats().find(c => c.id === id); }
function periodKey(c, d = new Date()) { return c.period === "week" ? isoDay(weekStart(d)) : isoDay(monthStart(d)); }
function periodStartTs(c, d = new Date()) { return (c.period === "week" ? weekStart(d) : monthStart(d)).getTime(); }
function periodEndTs(c, d = new Date()) {
  if (c.period === "week") return addDays(weekStart(d), 7).getTime();
  const m = monthStart(d); return new Date(m.getFullYear(), m.getMonth() + 1, 1).getTime();
}
function spent(c, d = new Date()) {
  const a = periodStartTs(c, d), b = periodEndTs(c, d);
  return r2(S.tx.filter(t => t.cat === c.id && t.ts >= a && t.ts < b).reduce((s, t) => s + t.amount, 0));
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
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2800); }
function openSheet(node) {
  const sh = $("#sheet"); sh.innerHTML = ""; sh.append(node); sh.hidden = false; $("#sheetBackdrop").hidden = false;
}
function closeSheet() { $("#sheet").hidden = true; $("#sheetBackdrop").hidden = true; }
$("#sheetBackdrop").addEventListener("click", closeSheet);
function bar(pct, state) { const i = el("i"); i.style.width = Math.max(0, Math.min(100, pct)) + "%"; if (state) i.className = state; return el("div", { class: "bar" }, i); }

/* ---------- Navigation ---------- */
let tab = "spend";
const TITLES = { spend: "Can I Buy It?", week: "This Week", money: "Bills & Paycheck", goals: "Goals", more: "More" };
document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => { tab = b.dataset.tab; render(); window.scrollTo(0, 0); }));

function render() {
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  $("#screenTitle").textContent = TITLES[tab];
  const ws = weekStart(), we = addDays(ws, 6);
  $("#weekLabel").textContent = `Paycheck week · ${fmtDate(ws)} – ${fmtDate(we)}`;
  const v = $("#view"); v.innerHTML = "";
  if (!S.onboarded) { v.append(onboarding()); return; }
  if (S.settings.isExample) v.append(el("div", { class: "banner" }, "You're using example numbers. Go to More → Import settings to load your own budget."));
  if (!storageOk) v.append(el("div", { class: "banner" }, "This device isn't saving data. Export a backup from More."));
  const lo = leftoverPrompt(); if (lo) v.append(lo);
  ({ spend: viewSpend, week: viewWeek, money: viewMoney, goals: viewGoals, more: viewMore })[tab](v);
}

/* ---------- Onboarding ---------- */
function onboarding() {
  const file = el("input", { type: "file", accept: "application/json,.json", hidden: true, onchange: e => importFile(e.target.files[0]) });
  return el("div", { class: "card stack" },
    el("h2", {}, "Welcome"),
    el("p", { class: "muted", style: "margin:0" }, "This app keeps your budget on this phone only. It works offline and never connects to your bank."),
    el("p", { class: "muted", style: "margin:0" }, "If you have a settings file, import it now. Otherwise start with example numbers and edit them in More → Settings."),
    file,
    el("button", { class: "btn", onclick: () => file.click() }, "Import my settings file"),
    el("button", { class: "btn ghost", onclick: () => { S.onboarded = true; save(); render(); } }, "Start with example numbers"),
  );
}

/* ---------- Friday leftover ---------- */
function leftoverPrompt() {
  const prev = addDays(weekStart(), -7), key = isoDay(prev);
  if (S.leftoverDone[key]) return null;
  const hasActivity = S.tx.some(t => t.ts >= prev.getTime() && t.ts < weekStart().getTime());
  if (!hasActivity) return null;
  const weekly = allCats().filter(c => c.period === "week");
  const per = {}; let total = 0;
  for (const c of weekly) { const l = left(c, prev); if (l > 0) { per[c.id] = l; total += l; } }
  total = r2(total);
  if (total <= 0) { S.leftoverDone[key] = "none"; save(); return null; }
  const goalSel = el("select", { class: "input", "aria-label": "Goal" }, S.settings.goals.map((g, i) => el("option", { value: i }, g.name)));
  return el("div", { class: "card stack" },
    el("h2", {}, `Last week you had ${money(total)} left`),
    el("p", { class: "muted small", style: "margin:0" }, "Keep it for this week, or move it to a goal."),
    el("button", { class: "btn ghost", onclick: () => {
      const k = isoDay(weekStart()); S.rollovers[k] = S.rollovers[k] || {};
      for (const [id, a] of Object.entries(per)) S.rollovers[k][id] = r2((S.rollovers[k][id] || 0) + a);
      S.leftoverDone[key] = "rolled"; save(); toast(`Added ${money(total)} to this week`); render();
    } }, "Roll it into this week"),
    goalSel,
    el("button", { class: "btn", onclick: () => {
      const g = S.settings.goals[+goalSel.value]; if (g) g.saved = r2((+g.saved || 0) + total);
      S.leftoverDone[key] = "goal"; save(); toast(`Sent ${money(total)} to ${g ? g.name : "goal"}. Move it in SoFi too.`); render();
    } }, "Send it to this goal"),
  );
}

/* ---------- Spend tab ---------- */
let sel = null;
function viewSpend(v) {
  const wt = weekTotals(), days = daysLeftInWeek(), perDay = r2(wt.left / days);
  v.append(el("section", { class: "card hero" },
    el("div", {}, el("div", { class: "k" }, "Left this week"), el("div", { class: "v" + (wt.left < 0 ? " bad" : "") }, money(wt.left))),
    el("div", {}, el("div", { class: "k" }, `Safe per day · ${days} day${days > 1 ? "s" : ""} left`), el("div", { class: "v" + (perDay < 0 ? " bad" : "") }, money(Math.max(perDay, 0)))),
  ));

  const amt = el("input", { class: "amt", inputmode: "decimal", autocomplete: "off", placeholder: "0.00", "aria-label": "Amount in dollars", id: "amt" });
  const note = el("input", { class: "input", placeholder: "What is it? (optional)", maxlength: "80", autocomplete: "off", id: "note" });
  const verdict = el("div", { class: "verdict v-idle" });
  const logBtn = el("button", { class: "btn", disabled: true }, "Log it as spent");
  const chips = el("div", { class: "chips", role: "group", "aria-label": "Category" });

  function drawChips() {
    chips.innerHTML = "";
    for (const c of allCats()) chips.append(el("button", { class: "chip", type: "button", "aria-pressed": sel === c.id ? "true" : "false", onclick: () => { sel = c.id; drawChips(); judge(); } }, c.name));
  }
  function judge() {
    const a = parseAmt(amt.value), c = sel && catById(sel);
    logBtn.disabled = !(a && c);
    if (!a || !c) { verdict.className = "verdict v-idle"; verdict.replaceChildren(el("span", { class: "dot" }), el("div", {}, el("b", {}, !a ? "Enter an amount" : "Pick a category"), el("p", {}, !a ? "Type what it costs." : "Tap where this money comes from."))); return; }
    const lf = left(c), after = r2(lf - a), lim = effLimit(c), used = lim > 0 ? (lim - after) / lim : 1;
    const per = c.period === "week" ? "this week" : "this month", nm = c.name.toLowerCase();
    let cls, head, msg;
    if (after < 0) { cls = "v-bad"; head = "No, it doesn't fit"; msg = `That's ${money(-after)} over. You have ${money(Math.max(lf, 0))} left for ${nm} ${per}.` + (c.period === "week" ? " It resets Friday, or cover it from another category on the Week tab." : ""); }
    else if (used > 0.8) { cls = "v-warn"; head = "Tight, but it fits"; msg = `You'd have ${money(after)} left for ${nm} ${per} (${Math.round(used * 100)}% used).`; }
    else { cls = "v-ok"; head = "Yes, go for it"; msg = `You'll still have ${money(after)} left for ${nm} ${per}.`; }
    verdict.className = "verdict " + cls;
    verdict.replaceChildren(el("span", { class: "dot" }), el("div", {}, el("b", {}, head), el("p", {}, msg)));
  }
  amt.addEventListener("input", judge);
  logBtn.addEventListener("click", () => {
    const a = parseAmt(amt.value); if (!a || !sel) return;
    S.tx.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), amount: a, cat: sel, note: note.value.trim() });
    save(); toast(`Logged ${money(a)} to ${catById(sel).name}`); sel = null; render();
  });

  const favs = S.settings.favorites || [];
  const favWrap = favs.length ? el("div", { class: "grid2" }, favs.map(f => el("button", { class: "fav", type: "button", onclick: () => {
    sel = f.cat; if (f.amount) amt.value = f.amount; note.value = f.label; drawChips(); judge(); if (!f.amount) amt.focus();
  } }, el("b", {}, f.label), el("span", { class: "muted" }, (catById(f.cat) || {}).name || "", f.amount ? ` · ${money0(f.amount)}` : "")))) : null;

  v.append(el("section", { class: "card stack", "aria-label": "Check a purchase" },
    el("label", { for: "amt", class: "eyebrow" }, "How much?"),
    el("div", { class: "amtrow" }, el("span", {}, "$"), amt),
    chips, favWrap ? el("div", { class: "eyebrow" }, "Favorites") : null, favWrap, note, verdict, logBtn));
  drawChips(); judge();

  const recent = S.tx.filter(t => t.ts >= weekStart().getTime()).sort((a, b) => b.ts - a.ts).slice(0, 5);
  v.append(el("section", { class: "card" }, el("h2", {}, "Latest this week"), txList(recent, "Nothing logged yet this week.")));
}

let armed = null;
function txList(rows, emptyMsg) {
  if (!rows.length) return el("p", { class: "empty" }, emptyMsg);
  return el("div", {}, rows.map(t => {
    const c = catById(t.cat) || { name: t.cat };
    const b = el("button", { class: "del" + (armed === t.id ? " arm" : ""), type: "button", onclick: () => {
      if (armed !== t.id) { armed = t.id; render(); setTimeout(() => { if (armed === t.id) { armed = null; render(); } }, 4000); return; }
      armed = null; S.tx = S.tx.filter(x => x.id !== t.id); save(); toast("Deleted"); render();
    } }, armed === t.id ? "Tap to confirm" : "Delete");
    return el("div", { class: "item" },
      el("div", { class: "what" }, el("div", {}, t.note || c.name), el("div", { class: "meta" }, `${c.name} · ${fmtDate(new Date(t.ts), { weekday: "short", month: "short", day: "numeric" })}`)),
      el("div", { class: "row" }, el("span", { class: "num" }, money(t.amount)), b));
  }));
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
  const sources = allCats().filter(x => x.period === c.period && x.id !== c.id && left(x) > 0);
  const node = el("div", { class: "stack" }, el("h2", {}, `Cover ${money(over)} on ${c.name}`),
    el("p", { class: "muted small", style: "margin:0" }, "Move money from a category that still has some left this " + c.period + "."));
  if (!sources.length) node.append(el("p", { class: "empty" }, "No other category has money left. It resets on Friday."));
  for (const s of sources) {
    const amt = r2(Math.min(over, left(s)));
    node.append(el("button", { class: "btn ghost", onclick: () => {
      S.moves.push({ period: periodKey(c), from: s.id, to: c.id, amount: amt, ts: Date.now() }); save(); closeSheet(); toast(`Moved ${money(amt)} from ${s.name}`); render();
    } }, `Take ${money(amt)} from ${s.name} (has ${money(left(s))})`));
  }
  node.append(el("button", { class: "btn ghost", onclick: closeSheet }, "Cancel"));
  openSheet(node);
}
function viewWeek(v) {
  const wt = weekTotals();
  v.append(el("section", { class: "card hero" },
    el("div", {}, el("div", { class: "k" }, "Spent this week"), el("div", { class: "v" }, money(wt.spent))),
    el("div", {}, el("div", { class: "k" }, "Weekly budget"), el("div", { class: "v" }, money(wt.limit)))));
  v.append(el("section", { class: "card" }, el("h2", {}, "Weekly (resets Friday)"), el("div", {}, allCats().filter(c => c.period === "week").map(catRow))));
  const mcats = allCats().filter(c => c.period === "month");
  const mSpent = r2(S.tx.filter(t => t.ts >= monthStart().getTime()).reduce((s, t) => s + t.amount, 0));
  v.append(el("section", { class: "card" }, el("h2", {}, "Monthly"), el("div", {}, mcats.map(catRow)),
    el("div", { class: "row small muted", style: "margin-top:10px" }, el("span", {}, "All spending this month"), el("span", { class: "num" }, money(mSpent)))));
  const rows = S.tx.filter(t => t.ts >= weekStart().getTime()).sort((a, b) => b.ts - a.ts);
  v.append(el("section", { class: "card" }, el("h2", {}, "Logged this week"), txList(rows, "Nothing logged yet this week.")));
}

/* ---------- Money tab: bills + paycheck splitter ---------- */
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
  v.append(el("section", { class: "card" }, el("h2", {}, "Upcoming bills"),
    bills.length ? el("div", {}, bills.map(b => {
      const d = Math.round((b.due - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / DAY);
      return el("div", { class: "item" },
        el("div", { class: "what" }, el("div", {}, b.name), el("div", { class: "meta" }, `${fmtDate(b.due, { weekday: "short", month: "short", day: "numeric" })}${b.note ? " · " + b.note : ""}`)),
        el("div", { class: "row" }, el("span", { class: "badge" + (d <= 3 ? " soon" : "") }, d === 0 ? "Today" : d === 1 ? "Tomorrow" : `${d} days`), el("span", { class: "num" }, b.amount ? money(b.amount) : "varies")));
    })) : el("p", { class: "empty" }, "No bills set up. Add them by importing your settings file.")));

  // Paycheck splitter
  const pay = el("input", { class: "input num", inputmode: "decimal", placeholder: "Net pay, e.g. 2266.11", "aria-label": "Net pay", id: "pay" });
  const out = el("div", { class: "stack" });
  const addChk = el("input", { type: "checkbox", id: "addgoals", checked: true });
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
  recBtn.addEventListener("click", () => {
    const p = parseAmt(pay.value); if (!p) return;
    const chk = Math.min(p, S.settings.checkingPerCheck), rest = r2(p - chk);
    if (addChk.checked) for (const s of S.settings.splits) { const g = S.settings.goals.find(g => g.name === s.goal); if (g) g.saved = r2((+g.saved || 0) + rest * s.pct / 100); }
    S.paychecks.push({ date: isoDay(new Date()), net: p, checking: chk, toGoals: rest, addedToGoals: addChk.checked });
    save(); toast(addChk.checked ? `Saved. Goals +${money(rest)}` : "Paycheck saved"); render();
  });
  v.append(el("section", { class: "card stack" }, el("h2", {}, "Split a paycheck"),
    el("p", { class: "muted small", style: "margin:0" }, `${money0(S.settings.checkingPerCheck)} stays in checking. The rest goes to savings, split by goal. Move it into your SoFi Vaults to match.`),
    pay, out, el("label", { class: "row small", for: "addgoals", style: "justify-content:flex-start" }, addChk, "Add the split to my goal balances"), recBtn));

  const pcs = S.paychecks.slice(-6).reverse();
  if (pcs.length) v.append(el("section", { class: "card" }, el("h2", {}, "Recent paychecks"), el("div", {}, pcs.map(p =>
    el("div", { class: "item" }, el("div", { class: "what" }, el("div", {}, money(p.net)), el("div", { class: "meta" }, `${p.date} · ${money(p.toGoals)} to goals`)))))));
}

/* ---------- Goals tab ---------- */
function viewGoals(v) {
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
    el("button", { class: "btn", onclick: () => { g.saved = parseFloat(saved.value) || 0; g.target = parseFloat(target.value) || g.target; save(); closeSheet(); render(); } }, "Save"),
    el("button", { class: "btn ghost", onclick: closeSheet }, "Cancel")));
}

/* ---------- More tab: review, backup, settings ---------- */
function viewMore(v) {
  // Sunday review
  const ws = weekStart(), key = isoDay(ws), wt = weekTotals();
  const rows = S.tx.filter(t => t.ts >= ws.getTime());
  const top = [...rows].sort((a, b) => b.amount - a.amount).slice(0, 3);
  const over = allCats().filter(c => c.period === "week" && left(c) < 0);
  const notes = el("textarea", { class: "input", rows: "2", placeholder: "One thing to do differently next week", id: "rnote" }, (S.reviews[key] || {}).note || "");
  v.append(el("section", { class: "card stack" }, el("h2", {}, "Weekly review (5 minutes)"),
    el("div", { class: "small" },
      el("div", {}, `• Spent ${money(wt.spent)} of ${money(wt.limit)} this week (${rows.length} purchases).`),
      el("div", {}, over.length ? `• Over in: ${over.map(c => c.name).join(", ")}.` : "• No category over budget. 👍"),
      top.length ? el("div", {}, `• Biggest: ${top.map(t => `${t.note || catById(t.cat)?.name} ${money0(t.amount)}`).join(", ")}.`) : null,
      el("div", {}, "• Did every card purchase get logged? Compare with your Chase and Apple Card apps.")),
    notes,
    el("button", { class: "btn ghost", onclick: () => { S.reviews[key] = { note: notes.value.trim(), at: Date.now() }; save(); toast("Review saved"); } }, (S.reviews[key] ? "Update review" : "Mark week reviewed"))));

  // Backup
  const file = el("input", { type: "file", accept: "application/json,.json", hidden: true, onchange: e => importFile(e.target.files[0]) });
  v.append(el("section", { class: "card stack" }, el("h2", {}, "Backup & share with Claude"),
    el("p", { class: "muted small", style: "margin:0" }, "Your data only lives on this phone. Export a backup every week and send it at your check-in."),
    el("button", { class: "btn", onclick: exportBackup }, "Export backup (.json)"),
    el("button", { class: "btn ghost", onclick: exportCSV }, "Export purchases (.csv)"),
    file, el("button", { class: "btn ghost", onclick: () => file.click() }, "Import settings or restore backup")));

  // Settings
  v.append(settingsCard());

  // Danger
  v.append(el("section", { class: "card stack" }, el("h2", {}, "Reset"),
    el("button", { class: "btn danger", onclick: () => {
      const b = $("#resetBtn"); if (b.dataset.arm) { localStorage.removeItem(STORE_KEY); S = blankState(); save(); render(); toast("All data erased"); }
      else { b.dataset.arm = "1"; b.textContent = "Tap again to erase everything"; setTimeout(() => { delete b.dataset.arm; b.textContent = "Erase all data on this phone"; }, 4000); }
    }, id: "resetBtn" }, "Erase all data on this phone")));
  v.append(el("p", { class: "muted small", style: "text-align:center" }, "Works offline · no account · no bank connection"));
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
    s.checkingPerCheck = parseFloat(chk.value) || s.checkingPerCheck;
    for (const [grp, i, inp] of limInputs) { const n = parseFloat(inp.value); if (isFinite(n) && n >= 0) s[grp][i].limit = n; }
    s.splits.forEach((x, i) => { const n = parseFloat(spl[i].value); if (isFinite(n) && n >= 0) x.pct = n; });
    s.isExample = false; save(); toast("Settings saved"); render();
  } }, "Save settings"));
  wrap.append(el("p", { class: "muted small", style: "margin:0" }, "To change categories, bills, goals, gifts or favorites, ask Claude for an updated settings file and import it. Your purchases stay."));
  return wrap;
}

/* ---------- Import / export ---------- */
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: name }).catch(() => {}); return; }
  const a = el("a", { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportBackup() { download(`budget-backup-${isoDay(new Date())}.json`, JSON.stringify({ type: "cibi-backup", version: 1, exported: new Date().toISOString(), state: S }, null, 1), "application/json"); }
function exportCSV() {
  const lines = [["date", "amount", "category", "note"].join(",")];
  for (const t of [...S.tx].sort((a, b) => a.ts - b.ts)) lines.push([isoDay(new Date(t.ts)), t.amount.toFixed(2), JSON.stringify((catById(t.cat) || { name: t.cat }).name), JSON.stringify(t.note || "")].join(","));
  download(`budget-purchases-${isoDay(new Date())}.csv`, lines.join("\n"), "text/csv");
}
function importFile(f) {
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const j = JSON.parse(rd.result);
      if (j.type === "cibi-backup" && j.state) { S = Object.assign(blankState(), j.state); S.onboarded = true; save(); toast("Backup restored"); }
      else if (j.type === "cibi-settings" && j.settings) {
        const keepGoals = S.onboarded && !S.settings.isExample ? S.settings.goals : null;
        S.settings = Object.assign(clone(EXAMPLE_SETTINGS), j.settings, { isExample: false });
        if (keepGoals && j.keepGoalBalances !== false) for (const g of S.settings.goals) { const old = keepGoals.find(o => o.name === g.name); if (old && (+old.saved || 0) > (+g.saved || 0)) g.saved = old.saved; }
        S.onboarded = true; save(); toast("Settings imported");
      } else throw new Error("unknown");
      tab = "spend"; render();
    } catch (e) { toast("That file isn't a settings or backup file from this app."); }
  };
  rd.readAsText(f);
}

/* ---------- Online/offline + boot ---------- */
function net() { $("#offlinePill").hidden = navigator.onLine; }
window.addEventListener("online", net); window.addEventListener("offline", net);
document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });
net(); render();
