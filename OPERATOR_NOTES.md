# PHASOR — Operator Notes

Lives in the repo root next to DESIGN.md. Written for the human, but Claude Code
should read it too (see §3).

---

## 1. Tips, ranked by how much ignoring them costs

The baseline forecasts (MVP M0–M2 in one week of evenings ≈ 75–80 %; M0–M4 in two
weeks ≈ 85 %) **assume you follow these**. Point costs are rough and correlated.

1. **Gates before features; tolerances are law.** Tests for each milestone's gates
   get written first; the agent never loosens a tolerance or skips a test "for now."
   *Ignore: −20 to −25 points, and failures turn slow and demoralizing.*
2. **One milestone per session; end every evening at green tests**, committed and
   tagged. Never hand the next session a swamp. *Ignore: −10.*
3. **Roll back ruthlessly.** Two failed fixes on the same bug → `git reset --hard`
   to the last tag, fresh session, narrower prompt. Rollback hours are the cheapest
   hours in the project. *Ignore: −10.*
4. **Homework before you need it.** The ISO-13786 Python oracle exists, derived on
   paper, *before* M2 starts. *Ignore: −5 to −10, plus the phase-sign bug may slip
   through — the worst silent failure on the board.*
5. **Debug in physics, not in code.** Full error output + one sentence of physics
   ("amplitude grows inward — suspect conjugation in the Robin load"). *Ignore: −5.*
6. **Distrust beauty.** The conjugation bug produces gorgeous fields where the wall
   anticipates the weather. Only gates G2.2 / G2.4 can tell. *Cost: not completion
   probability — correctness probability.*
7. **Look before you solve.** Every geometry change: render materials, slice
   through, then compute. *Ignore: −5 in phantom bug hunts.*
8. **Hold the scope line, especially against good ideas.** Nothing from DESIGN.md
   §1 out-of-scope, nothing from M5, before M4 is tagged. *Ignore: −10 to −15;
   scope creep is the dominant failure mode for capable, curious operators.*
9. **Refuse tooling upgrades.** No TypeScript, bundlers, frameworks, or
   "refactoring for flexibility." Every layer of tooling is a layer you can't
   debug. *Ignore: −5, paid in environment hell.*
10. **Budget honestly.** ~10 sessions × 2–3 focused hours. Half-attention sessions
    count as zero. *Ignore: schedule slip, not probability loss.*

Violating 1 and 8 together puts two-week completion under ~40 %. Un-gated,
scope-creeping agent projects don't fail — they dissolve. There is never a moment
of failure to react to; there is just week five.

---

## 2. ⚠ Geometry warning: axis-aligned only — and what staircasing really does

PHASOR's geometry is axis-aligned boxes on a rectilinear grid. **This is the
load-bearing simplification that makes the project feasible**; it is not an
accident and must not be "fixed" casually. Consequences:

- A 45° (or any sloped/curved) surface can only be approximated as a staircase.
- **Internal sloped material interfaces** (e.g. an insulation wedge): staircasing
  is benign — temperatures and total heat flows converge with refinement (~first
  order). Refine and trust the bulk field.
- **Sloped exterior surfaces with a convective (Robin) BC**: staircasing has a
  systematic, non-vanishing error. The staircase has more surface area than the
  true slope (×√2 at 45°), so the surface exchanges ~40 % too much heat, and
  **refinement does not fix this** — smaller steps, same excess area. Workaround:
  scale h on those faces by (true area / staircase area); treat results as
  estimates and say so in any output you keep.
- Practical rule: orthogonal details (corners, slab junctions, basements, window
  installation) → full trust within the gates. Pitched-roof-family details
  (Dachschräge, Attika, Kehlbalken) → bulk temperatures usable with care, anything
  evaluated *on* the sloped surface itself is suspect.
- The clean upgrade path, if slopes turn out to matter: a **2D unstructured
  (triangle) mode with extrusion** as v0.2 — far more tractable than 3D tet
  meshing and covers most ψ-value work, which is 2D anyway. That is a deliberate
  future decision, not a mid-milestone detour.

---

## 3. Scope-watch convention (for Claude Code)

Copy this block into CLAUDE.md:

```markdown
## Scope watch
If the Operator requests work that (a) appears in DESIGN.md §1 "out of scope",
(b) belongs to a later milestone than the current one, or (c) involves sloped /
non-axis-aligned geometry, give exactly ONE gentle flag before proceeding, e.g.:

  "Heads up: this is outside the current milestone (see OPERATOR_NOTES §2 —
   sloped surfaces staircase, with a non-vanishing Robin-BC area error).
   Want me to proceed anyway, park it in BACKLOG.md, or stay on Mn?"

Rules: one sentence of flag plus the three options, once per topic per session —
never repeat the warning for the same topic, never refuse, never lecture. If the
Operator says proceed, proceed without further comment and add a one-line note
to VALIDATION.md that the work was off-script. Maintain BACKLOG.md as the
parking lot so good ideas are captured instead of argued with.
```

The design intent: the agent is a seatbelt chime, not a backseat driver. One
chime, then respect the human's call — and make "park it" the easiest option, so
saying "not now" to a good idea costs one click instead of willpower.
