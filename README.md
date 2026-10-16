# Horaire — team scheduling app

A small scheduling app for a 24-hour restaurant team. Works on a phone or tablet, in French or English,
offline, with no account and no server. Data stays on the device it is used on.

## What it does
- **Team**: name, stations (kitchen / front), weekly availability, max and min hours, under-16 flag,
  regular shifts, time off. Alphabetical list with type-ahead search (accents ignored: "mael" finds "Maëlle").
- **Needs** (staffing template): how many people each station needs per time range, per day.
  Defaults: 6h–22h = 3 kitchen + 5 front; 22h–6h = 2 kitchen + 3 front; Monday and Friday 17h–22h = 5 kitchen (stock orders arrive at 17h or later).
- **Generate the week**: places regular shifts first, then fills the needs with whoever is available,
  spreading hours fairly. Lists any hours it could not fill and why.
- **Hard rules** (blocked unless the manager taps "Assign anyway" a second time): time off, availability,
  max hours, station training, double-booking, Québec under-16 rules.
- **Replace**: tap a shift → Replace → only people who can legally take it, fewest hours first.
- **Day view** (bars on a timeline, with staffed/needed per hour) and **week view** (grid).
- Copy last week, undo, export as image (to share in a group chat), print / PDF, backup and restore.

## Files
| File | What it is |
|---|---|
| `index.html` | The page |
| `logic.js` | All the rules and the auto-scheduler (no screen code) |
| `app.js` | Screens and buttons |
| `i18n.js` | Every word, in French and English |
| `styles.css` | Look (light and dark mode) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Lets it install on a home screen and work offline |
| `tests/` | Automatic checks: `node --test tests/logic.test.js tests/i18n.test.js` |
| `tools/serve.js` | Runs it on this computer: `node tools/serve.js` then open http://localhost:8080 |

## Putting it online (GitHub Pages, free)
1. Create a free account at github.com (if not already).
2. New repository → name it e.g. `horaire` → Public → Create.
3. "uploading an existing file" → drag in everything in this folder → Commit.
4. Settings → Pages → Source: "Deploy from a branch" → Branch `main`, folder `/ (root)` → Save.
5. After about a minute the app is at `https://<your-username>.github.io/horaire/`.

The repository only holds the empty app. Names and schedules never go there; they stay in the
browser of whoever uses the app.

## Important for the person using it
- **Add it to the home screen** (iPhone: Safari → Share → "Add to Home Screen"). On iPhone, Safari can
  erase a website's saved data after 7 days without a visit; installed home-screen apps are kept.
- **Back up weekly** (Settings → Backup). The file can be emailed or saved to Drive/iCloud and restored on another device.
- The Québec rules built in should be double-checked at cnesst.gouv.qc.ca.
