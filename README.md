# PHASOR

A browser tool for periodic 3D heat conduction in building details
(corners, slab junctions, basement walls). Time-harmonic, no time stepping.
See [DESIGN.md](DESIGN.md) for the full spec and [VALIDATION.md](VALIDATION.md)
for the gate log.

---

## ⚠️ HOW TO START THE APP

**You cannot just double-click `index.html`.** PHASOR uses ES modules, an
import map, and a Web Worker — browsers block all three over `file://`. It
must be served over HTTP (any static server works).

**1. Open a terminal in this folder** (`C:\Users\Nutzer\02-wincode\PHASOR`).

**2. Start the bundled zero-dependency dev server:**

```powershell
node tools/devserver.mjs
```

It prints `PHASOR dev server: http://localhost:8123`.

**3. Open that URL in your browser:** **http://localhost:8123**

**4. To stop it:** press `Ctrl+C` in that terminal. Leave the terminal open
while you use the app.

### Notes
- Default port is 8123; pass another as `node tools/devserver.mjs 9000`.
- Python works too if you prefer (`python -m http.server` from a shell where
  Python is on PATH — e.g. your conda shell), then open the port it prints.
- If the view ever loads blank, nudge the window size once (this used to be a
  bug; it's fixed, but the nudge is a harmless fallback).

---

## Running the tests

```powershell
node --test
```

All numerics (`src/{grid,fem,solver,physics}.mjs`) are DOM-free and run under
Node. Each milestone's verification gates live in `test/*.test.mjs`.
