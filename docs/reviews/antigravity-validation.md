# Antigravity Racer integration validation

Validated locally on Windows, 2026-09-05, against `origin/main` at
`1a62f19f08ff9086d3d08d8f066f844ea1b9ccaf`. SDL_GPU and Dawn use the same optimized
Release executable (`/O2 /Ob2 /DNDEBUG`), without ASAN. No hosted CI result is
claimed. Validation uses hidden native windows and queued input, not desktop
mouse movement or foreground-window automation.

## Final gates

- `npm test`: 1,560 passed, zero failures and zero skips.
- `/simplify`: all four angles completed over the full branch, including
  follow-up reviews of sweep repairs; 46 findings, 43 applied, three filed with
  explicit missing-contract/measurement blockers.
- `npm run sweep`: all five stages passed. Compilation and all 256 native
  builds passed; unchanged shader inputs/products were verified and resumed;
  all 255 differential parity cases passed their existing gates.
- `npm run status:verify`: the published table matches every measured report.
- Corpus verification: 948 digest rows match their pinned sources, plus one
  generated row verified by provenance. All 22 Antigravity TypeScript files are
  byte-identical to upstream. The separate Racer source and host are unchanged.
- Staged whitespace checks pass. The existing patch/diff attributes also allow
  the required unified-diff context prefix before upstream tab indentation;
  ordinary source-file whitespace checks remain unchanged.
- Hidden final-executable input checks pass on both backends: one ordinary
  click activates an unselected option exactly once; release outside cancels;
  split-screen captures show two distinct views; editor drags update track
  buffer versions 2 through 7 without changing the editor camera. Before/after
  captures visibly confirm track deformation. Hover styling is also visible.
- Both backends pass 2P → main → 1P → main → Attract (600 fixed-time frames)
  → Escape to main → close. Each trace has five button activations, one native
  window created/destroyed, six renderer reuses, and an unchanged native window
  identity throughout. Attract's Escape returns directly to the main menu.

The local detailed logs are `artifacts/overnight-full-tests-20.log`,
`artifacts/overnight-sweep-7.log`, and `artifacts/overnight-final-status.log`.
Input logs use `artifacts/overnight-final-*`; screenshots and detailed camera,
buffer, event, and window traces are beside the final Release executable under
`native/build-antigravity-racer-release/`. Gamepad virtual-device, keyboard/menu,
callback lifetime, and window-lifetime regressions are included in the full
test suite; no claim is made of a new physical-gamepad test overnight.

## Measured fidelity

Antigravity full/foreground MAD is **3.520 / 3.585 on both backends**. The
independently enforced canvas-only measurement is **0.028 / 0.029**. The direct
SDL_GPU/Dawn full-image difference is approximately 0.000049 MAD, maximum five.
Links, gradient text, blurred panels, emoji presentation, and authored selector
states now use shared retained-UI paths. Font sizing/rasterization and outer
shadows remain visible browser/native differences; this is not pixel-perfect UI.

The integration's new browser reference was corrected before adoption to include
authored descendant/focus rules. The early 8.992 score used the incomplete
reference and must not be presented as a same-reference improvement comparison.
No previously committed golden, enforcement threshold, or neutrality exclusion
was changed.

## Existing-scene baseline comparison

`neutrality` deliberately returns **exit 1**, because this fidelity work changes
UI pixels. Of the 254 previously registered measured scenes, 239 have every
report cell identical, ten show the pre-existing multisampling variation, and
five change through the shared UI work. The nine other captures in the saved
baseline are unregistered historical probes, not omitted registered scenes.
The new Antigravity scene has no `main` baseline.

The five intentional moves were checked against the original `main` PNGs,
whose report hashes match the immutable saved baseline, and against the browser
goldens. Numbers below are full-image SDL_GPU MAD (Dawn follows the same changes).

| Scene | Before | After | Attribution |
| --- | ---: | ---: | --- |
| Platformer | 0.983692 | 0.779926 | Gradient word spacing/color and text/control rendering; canvas lane remains 0.013 (Dawn 0.010). |
| Racer | 0.654382 | 0.643975 | Shared font/backdrop HUD rendering; canvas lane remains 0.003 on both. |
| Tetris | 1.207580 | 1.204192 | Shared text spacing/weight rendering; canvas lane remains 0.093 / 0.101. |
| Bath Day | 0.120268 | 0.120369 | 329 changed pixels, all in bottom chrome at y=680..709; no 3D pixels changed. |
| Littlest Tokyo | 0.145105 | 0.145307 | 536 changed pixels, all in bottom chrome at y=680..709; no 3D pixels changed. |

The tiny Bath Day/Tokyo increases are retained-UI residuals, not hidden as
improvements or 3D-neutrality passes. Detailed cell differences and changed-pixel
bounds remain in `artifacts/overnight-neutrality-final.log` and
`artifacts/overnight-ui-deltas-final.jsonl`. No new wobble allowance was added.
