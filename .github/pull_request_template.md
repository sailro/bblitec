## Change

<!-- Describe the resulting behavior and any material limitation. -->

## Review

- [ ] Read the canonical documentation and relevant pinned upstream source.
- [ ] Run /simplify over the complete change before the final sweep.
- [ ] Apply review findings or record a concrete blocker and destination.
- [ ] Validate affected scene behavior on SDL_GPU and Dawn.

## Validation

<!-- Record command verdicts and any check not run, with its reason. -->

- `npm run simplify:verify` —
- `npm test` —
- `npm run scenes:process` —
- `npm run scenes:parity` —
- `npm run scene -- neutrality <baseline>` —
- `npm run status:verify` —
