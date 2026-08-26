<!--
The three gates in .github/copilot-instructions.md are cheap and the
judgement that a change is too small for them is not trustworthy. State the
answers here rather than remembering them: the point of writing them down is
that skipping one becomes visible in the diff instead of invisible.

Delete nothing from the checklist. An honest "not run, because ..." is a
real answer; a silently missing line is not.
-->

## What this changes

<!-- What the renderer, the compiler or the docs now do. Facts, not a log. -->

## Gates

- [ ] **Docs read** — the canonical set, and this feature's own upstream page
      under `docs/lite/architecture/` at the pinned commit, before any code.
- [ ] **`/simplify` run over the complete body of work, before the sweep** —
      every branch, whatever its size. Findings applied, including the ones
      reaching outside the diff; anything filed instead says what unblocks it.
- [ ] **Both backends** — SDL_GPU and Dawn, or the scene is not integrated.

<!-- If /simplify was run, say what it found and what was applied. -->

## Validation

<!--
Paste the verdicts, not a claim that it passed. Every stage names its own
result and exits non-zero on failure; never read one through an unpiped
`tail` or `grep`.
-->

- `npm run simplify:verify` —
- `npm test` —
- `npm run scenes:process` —
- `npm run scenes:parity` —
- `npm run scene -- neutrality <baseline>` —
- `npm run status:verify` —
