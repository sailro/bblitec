# AUDIT — 2026-08-24

Findings of the six-axis audit at main `e065f59`, covering the 113 commits
since the 2026-08-19 audit closed (PR #83). Same rules as [TODO](TODO.md):
entries are unfinished work; **fixing an entry deletes it**.

Four fix waves landed the same day and closed everything actionable: the
quick-win wave (docs facts and dev-log, drift guards, tooling dedups, lock
fixes, lazy packager imports, the min-SDL patch fix), wave 1 (the
pin-anchored material-defaults table, located refusals, the full activation
inventory, the monolith splits, the Tint and bake caches, the tsc skip,
`diagnose`/`clean`, capture provenance, the registry pose derivation, the
docs duplication debt, the BU-1/BU-13 proof builds), wave 2 (the
light-matrix double migration and walker consolidation, the
splat/effect/tone-map emit-once constants, the pipeline-traits/
billboard-plan/MRT/blend shares, the per-frame scene+lights hoist, the
backend symmetry batch, the runtime.hpp initializer trim, the build-stamp
TU), and wave 3 (render-capture writers for billboards/sprites/effects,
`geometry` brought to its siblings' conventions — whose provenance rule
immediately retired a stale cached reference that had been comparing at
MAD 104 — the lazy pinned-loader half with its registration-timing proof,
and full designated-initializer emission for the billboard options). Every
wave was proven by the full suite plus its matching proof; the corpus
matrix after the final wave is green on both backends with `status:verify`
clean, and neutrality against the pre-wave-2 snapshot moves only the
documented wobble and two deterministic improvements toward the golden
(the runtime-sweep gate byte-exact on both backends — the light-matrix
precision fix's signature).

The audit's "verified sound" conclusions (PAL isolation, pin-mirrored
activation, no formula transcriptions, coherent tooling, ~zero dead code)
are recorded in the audit memory and the wave commit messages; the
re-derivation doctrine held throughout.

## Remaining

- [ ] **TL-1 (remainder) — sprite-only and effect-only scenes still write no
  native capture.** The mixed-scene families are covered (billboards, node
  particles, effect wrappers/tasks all capture and pair in `diff`); the
  standalone frame loops (`pal_*_sprite.cpp`, `pal_*_effect.cpp`) never read
  `BBLITE_RENDER_CAPTURE`, so scenes 50, 92, 93, 96, 97, 301 (sprite-only)
  and 74, 76 (effect-only) refuse `capture --native` with a message naming
  exactly this. Fix: a small capture hook in the four driver TUs writing the
  sections `pal_render_capture.hpp` already carries writers for
  (`spriteRenderers`, `effects`). Effort S–M, native + one tooling line.
- [ ] **TR-8 — Handle-collection semantics exist as ~12 exact-shape arms.**
  **Blocked on feature work by design**: when scene 158's collection
  contract lands (TRACKED in TODO), introduce one handle-collection value
  kind (iterate/index/find/push) in the entry compiler and retire the arms
  in expressions.ts/statements.ts/compiler.ts rather than adding a
  thirteenth. Effort L.
