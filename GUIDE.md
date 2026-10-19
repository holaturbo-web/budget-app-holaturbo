# Can I Buy It?

A small personal budget app for my phone. It answers one question before I spend: does this fit this paycheck week?

- Works **offline** (installable web app, cached by a service worker)
- **No account, no bank connection, no ads.** Everything is stored on the phone in the browser.
- Weekly limits reset every **Friday** (payday)

## Features
- Quick check: type an amount, tap a category, get Yes / Tight / No, then log it
- Safe-to-spend per day until payday
- One-tap favorites for repeat purchases
- Cover an overspend by moving money from another category
- Friday leftover: roll it into the new week or send it to a goal
- Upcoming bills with due dates
- Paycheck splitter (fixed amount to checking, the rest split across goals)
- Goals and gift dates
- Weekly review, backup/restore (.json) and purchase export (.csv)

## Install on iPhone
1. Open the GitHub Pages link in **Safari**
2. Share → **Add to Home Screen**
3. Open it once while online; after that it works offline
4. More → **Import settings or restore backup** to load your settings file

Personal numbers are **not** in this repository. They come from a settings file imported on the phone.

## Settings file format
```json
{ "type": "cibi-settings", "version": 1, "settings": { "weekStartDay": 5, "checkingPerCheck": 1000,
  "weekly": [{ "id": "groceries", "name": "Groceries", "limit": 100 }],
  "monthly": [{ "id": "other", "name": "Other", "limit": 25 }],
  "bills": [{ "name": "Rent", "amount": 1500, "day": 1 }],
  "splits": [{ "goal": "Emergency fund", "pct": 100 }],
  "goals": [{ "name": "Emergency fund", "saved": 0, "target": 5000, "by": "2027-01-31" }],
  "gifts": [{ "who": "Mom", "occasion": "Birthday", "date": "2027-07-02", "budget": 75 }],
  "favorites": [{ "label": "Gas", "amount": 45, "cat": "gas" }] } }
```

## Updating the app
Push changes to `main`. Bump `CACHE` in `sw.js` so phones pick up the new version (they update on the next launch while online).
