# Restart handoff

Session handoff requested by the user on 2026-09-11. This document records the
state and reasoning needed by a replacement agent; canonical support contracts
remain in the documentation linked below. Local artifact paths are relative to
the repository unless an absolute path is given. Ignored artifacts and installed
dependencies will not be present in a fresh clone.

## Read this first

**Work is paused after a green sweep.** The user's latest implementation
instruction was to stop once the sweep was green. That condition is satisfied.
Creating this handoff does not authorize automatically restarting implementation.
Resume the integration when the user asks to continue.

**The external application does not fully compile yet.** Its latest attempt
stopped during TypeScript-to-C++ generation. Its native build and application
runtime have never been reached. A green sweep validates the registered corpus;
it does not establish that this external application compiles or runs.

| Item | Saved state |
| --- | --- |
| Compiler checkout | `C:/Dev/babylonlite` |
| Branch | `codex/external-project-support` |
| Remote | `https://github.com/sailro/bblitec.git` |
| Branch base used in this session | `3474e835` on `main` |
| Last executable-code/test commit | `b00cafdc` |
| Draft PR | [#247 — Extend generic application compilation and retained UI support](https://github.com/sailro/bblitec/pull/247) |
| External checkout | `C:/Dev/_prototypes/external-native-app` |
| External source revision | `d7c477a6d5963680c55249dceb93cb6e4ab9ce56` |
| External checkout changes | Clean when this handoff was prepared |
| External generated output | `generated/external-app` (ignored; not a successful complete generation) |
| Session diagnostics | `artifacts/external-integration` (ignored) |

The branch was clean and synchronized with its remote before adding this
document. All 14 implementation/test commits listed below were pushed. The PR
remains a draft because integration and other explicitly pending work are
incomplete. Do not merge or mark it ready merely because the sweep passes.

## User requirements and collaboration

- Read documentation extensively before feature work. Start at
  [README.md](README.md), then read all canonical pages it lists:
  [repository instructions](.github/copilot-instructions.md),
  [architecture](docs/architecture.md), [features](docs/features.md),
  [development](docs/development.md), [debugging](docs/debugging.md),
  [fidelity](docs/fidelity.md), [backends](docs/backends.md),
  [UI](docs/ui.md), [status](docs/status.md), [TODO](TODO.md), and
  [audit](audit.md). These were read during this session; a new agent should
  establish its own understanding rather than treating this handoff as the
  complete product specification.
- The original objective is to compile and run an unchanged real external
  application, adding generic support reusable by future scenes and demos.
- The application is private. Keep its name, repository URL and copied source
  out of tracked source, tests, documentation, PR text and public artifacts.
  Use the neutral paths above. The local checkout's Git configuration identifies
  its remote if needed; do not publish that identity. If the checkout is absent,
  obtain access/location from the user rather than inventing a repository.
- Reproduce missing capabilities with independently authored, neutral fixtures.
  Do not adapt the external application or modify corpus inputs to make it pass.
- Check whether each unit overlaps existing TODOs or issues. Narrow or close an
  item only to the extent proven. Regular commits for completed units are
  explicitly requested and authorized. Avoid one giant end-of-task commit.
- During authorized implementation, status questions are steering, not requests
  to stop. The user previously objected when an intermediate checkpoint was
  treated as completion. The later explicit stop-after-green instruction now
  controls: pause until asked to resume.
- Give concise progress updates, distinguish assessed/implemented/integrated
  work, and state the exact stage reached. Do not repeatedly seek permission for
  routine fixes already authorized. PR creation and pushing this branch were
  authorized; merging was not.
- Do not infer ongoing automation or credit-reset authorization. No follow-up
  automation is needed to resume this work.

## Verified result at the pause

The definitive current results are the `227` logs, not earlier failed runs.

| Check | Result | Local evidence |
| --- | --- | --- |
| Full tests, `npm test` | **2,556 passed; 0 failed; 0 skipped** | `artifacts/external-integration/full227.log`, `full227.exit` = `0` |
| Full sweep, `npm run sweep` | **All five stages passed** | `artifacts/external-integration/sweep227.log`, `sweep227.exit` = `0` |
| Generation | Entire 288-entry registry accepted; Doom was already current, so the log says 287 compiled | Same sweep log |
| Shaders | Passed | Same sweep log |
| Native builds | **288/288 passed** | Same sweep log |
| Differential parity | **287/287 scenes with parity definitions passed on SDL_GPU and Dawn** | Same sweep log; `artifacts/parity/<id>/report-differential.json` |
| Published status | Passed without changing published values or thresholds | Same sweep log |
| Doom after its fix | Native build and both parity gates passed; backend captures pixel-identical | `doom226.log`; current Doom differential report |
| Staged source checks | Exact staged TypeScript snapshot and private-name checks passed | `staged226.log`, `staged227.log` |

The successful test run took about 229 seconds. The final sweep took about
115 seconds for generation, 1.4 seconds for shaders, 71 seconds for native
builds, and 235 seconds for parity. These are observations on this machine,
not performance guarantees. A prior sweep that rebuilt more native objects
needed about 573 seconds for its build stage.

Still pending, and **not implied by the green sweep**:

- The external application's complete generation, native build, execution and
  behavior checks.
- The separate saved-baseline neutrality comparison. Its baseline is preserved
  at `artifacts/external-integration/baseline`; it was not run after the green
  sweep because the user asked to stop there. Passing parity gates and published
  rounding checks is not a proof that every numeric cell is unchanged.
- A final simplify review/record covering the complete branch diff. Individual
  units received scoped reviews, but those do not establish a whole-branch
  record. `docs/reviews/c1241ad563254d73cf73c34a1e505479.json` is an older record;
  do not claim it validates this branch. Follow the current development workflow
  when replacing it and recording the actual reviewed diff.
- New behavior-specific interaction checks for future integration changes.
  The sweep does not run every declared interaction check.

## Current external-app blocker and the first investigation

Latest external generation: `artifacts/external-integration/compile222.log`.
It reports, at external `src/ui/crash-reporter.ts:657:5`:

```text
A ui-element value is not associated with an engine.
```

The reached operation writes properties on a DOM element stored in a record
passed into a helper. The surrounding flow retrieves a record from a Map,
increments a count, and calls the helper to update the retained UI. No private
source needs to be copied to reproduce this shape.

Start with these source anchors; line numbers drift, so search the symbols:

- [DataLowerer.leafValue](src/compiler/data-lowering.ts) recreates resource values
  read from typed records/collections. Its handle branch usually obtains
  `engineCpp` from `context.defaultEngine()`; text/node-input and picking have
  separate handling. It already recognizes `ui-element` as a handle type.
- [UiProjection.uiElementValue](src/compiler/ui-projection.ts) resolves retained
  element values. `emitUiPropertyAssignment` then calls `requireEngine` on the
  resolved element before dispatching setters.
- [Compiler.requireEngine](src/compiler.ts) fails when `engineCpp` is absent.
  `engineFor` can use the default engine, but replacing calls with it blindly
  would hide the ownership question rather than explain it.
- [Stored engine-context tests](test/stored-engine-context.test.ts),
  [user-function lowering](src/compiler/user-functions.ts),
  [native-function lowering](src/compiler/native-functions.ts),
  [platform calls](src/compiler/platform-calls.ts), and
  [Window events](src/compiler/window-events.ts) are adjacent mechanisms worth
  inspecting for retained context and standalone Window UI ownership.

**Hypothesis, not a completed diagnosis:** the helper's data-handle reconstruction
occurs where the default engine is unavailable or was not propagated. Determine
which compilation context owns the element and preserve that association through
the existing typed metadata/capture path. Do not add an application-specific
exception or silently select an unrelated engine.

On resumption, reproduce the latest failure once with the current compiler,
then make a neutral record/Map/helper/DOM fixture that fails for the same reason.
Implement at the shared ownership/lowering boundary, verify the fixture, and
retry the unchanged application. The first reported blocker is not the last gap.

No external generation was attempted after the `222` result during the later
sweep-fix work. The last two fixes affect constant emission and test fixtures;
the ownership issue itself is still untouched.

## Commit map

Use the commits as reviewable units instead of reconstructing all intermediate
diagnostics. They are listed oldest first.

| Commit | Unit |
| --- | --- |
| `9581efdd` | Extend application language and native platform support |
| `505858cb` | Support retained scrollbar styles and solid background clipping |
| `bdeb4e48` | Preserve static strings through helper specialization |
| `cdfe8b01` | Support retained raster border images |
| `0e0678f5` | Support retained CSS filter layers on both GPU backends |
| `ec3fb27c` | Support inherited overflow and word wrapping in retained UI |
| `bea5fff7` | Support retained flex layout and physical box longhands |
| `98802f6c` | Preserve live UI declaration order and property removal |
| `50432a7c` | Reuse retained hover states for all supported stylesheet selectors |
| `a083a174` | Refine retained UI updates and selector coverage |
| `ff5f0294` | Share retained interaction states across stylesheet and host rules |
| `d602b6e4` | Support retained reduced-motion media rules |
| `188405a3` | Emit literal values in namespace constant arrays |
| `b00cafdc` | Align UI regression checks with shared media and interaction APIs |

Before this handoff, the aggregate diff from the saved base touched 175 files
with approximately 10,195 insertions and 2,116 deletions. The foundation commit
is much larger than the later units; read its tests and canonical contracts
before changing those mechanisms.

## Implementation knowledge

### Language, inputs and platform foundation

The foundation covers external module roots and public assets, JavaScript module
definitions/JSDoc, import/re-export initialization order, namespace/constant API
aliases, deployment values and explicit `import.meta.env` inputs. It also adds or
extends mixed tuples/unions, nullable/partial records, contextual array/Map
conversions, collection entries, stored callbacks and instance receivers,
asynchronous captures, Date/locale support, numeric views/output aliases,
thin-instance colors, native HTTP and application platform services.

Useful ownership boundaries:

- Type representation: `src/compiler/data-types.ts` and `data-types/`.
- Conversion/storage: `data-lowering.ts`, `data-sinks/`, `data-methods.ts`,
  `collection-methods.ts`, `object-statics.ts`.
- Call specialization and captures: `user-functions.ts`, `native-functions.ts`,
  `closure-captures.ts`, `types.ts`, `values/metadata.ts`.
- External inputs: `src/cli.ts`, `module-imports.ts`, `compiler/program.ts`,
  `module-initializers.ts`, `deployment.ts`, `assets.ts`.
- Runtime services: compiler `http.ts`, `locale.ts`, `dates.ts`,
  `window-events.ts`, `web-storage.ts`; native `pal_http.cpp`, `pal_locale.cpp`,
  `pal_window_realm.cpp`, and corresponding headers.

The detailed admitted subsets are in `docs/features.md` and `docs/ui.md`; do not
interpret the preceding inventory as support for entire browser APIs. Windows
platform smoke probes built and ran on both backends earlier in the session.

One documentation inconsistency noticed while preparing this handoff remains:
the feature table admits bounded `normalize`/`localeCompare`, while the later
strings paragraph still says collation and normalization are unsupported.
Reconcile that prose with the implemented/tested bounds on resumption rather
than using the stale sentence as a new implementation requirement.

### Static strings and constant arrays

Closed helpers over literal scalars and option records can assemble stylesheet
text; argument effects execute once. Runtime-generated CSS text remains refused.
See `test/static-string-helpers.test.ts` and user-function specialization.

The first full native sweep found Doom's constant table emitted at namespace
scope while numeric identifiers it referenced were local to the entry function.
The neutral `constant-tables-use-literals-outside-local-scopes` test reproduced
this for numeric and boolean entries in mixed tuples.

`DataLowerer.constantInitializerValue` now converts proven static scalar leaves
to literal Values, recursively through tuple/record templates. Both constant
array materialization paths use it. The literal-expression path probes emission
and rejects effectful/nonconstant initialization; ordinary local/runtime storage
continues through the existing sink machinery. Do not restore a native local's
`cpp` spelling into a namespace initializer. See `regression225.log` for the
reproduction and `regression226.log`/`doom226.log` for the successful fix.

### Retained stylesheet model and selectors

The shared model is `src/ui-style-rule.ts`, consumed by host JSON validation
(`src/native-host-ui.ts`), source CSS parsing (`src/compiler/ui-projection.ts`),
and the native `UiStyleRule` representation/runtime.

**Antigravity already had native hover support.** Its host UI configuration
(`ui/antigravity-racer-host.json`) used class hover flags. The missing capability
was accepting corresponding selectors from application CSS text. The fix reused
those native states; it did not introduce a separate hover implementation.

Source CSS now accepts supported class/id/compound/proven-ancestor selector
shapes with `:hover`, `:active`, `:focus-visible` and their combinations.
Duplicate state suffixes refuse because the boolean representation cannot retain
their repeated specificity. Host tag-attribute rules remain a separate admitted
shape; bare tag selectors are still unsupported. Scrollbar states retain their
own bounded parser. Specificity and dynamic grid checks share the interaction
state counter. Generated native calls spell all trailing defaults explicitly.

`sync_focus` refreshes focus-visible even when the same node remains focused.
Native button-event tests must use the PAL SDL event dispatcher so input modality
is updated; direct RmlUi mouse-button calls alone do not do that.

### Live styles, layout and wrapping

- `UiElementRecord` has a lookup map and a bounded order vector, with one latest
  entry per property. Rewriting a property moves it to the end when needed.
  Empty values act as removals; replacing `cssText` clears overrides and restores
  the authored declarations. Native replay preserves shorthand/longhand order.
- A narrowly guarded fast path applies only the final changed ordinary property
  when order and earlier values are unchanged. Shorthands, reordering and resets
  retain the full ordered replay. Removing stale properties precedes restoring
  new `cssText`, so a newly authored width is not removed accidentally.
- `src/ui-layout.ts` validates bounded flex/alignment, gap and physical spacing
  literals. It separates property recognition from supported-value validation.
  CSS math/variables and intrinsic basis keywords are not generally supported.
- The flex RmlUi patch provides unordered `flex-flow` parsing, flex shorthand
  defaults and physical `start`/`end` behavior under reversed axes/wrapping.
- The wrapping patch keeps inherited overflow-wrap separate from word-break and
  respects nowrap. It does not claim complete browser min-content or Unicode
  grapheme behavior.
- Native checks live in `test/fixtures/ui-style-writes-check.cpp`,
  `ui-flex-check.cpp`, `ui-wrap-check.cpp`, and the other `ui-*-check.cpp` files.
  `runRmlUiFixture` in `test/native-fixture.ts` is the shared runner.

### Scrollbars, backgrounds, borders and filters

- Standard scrollbar width/color and bounded vendor scrollbar pseudo-elements
  share native state. Standard non-auto properties take precedence. See the
  precise exclusions in `docs/ui.md` and `pal_ui_scrollbars.hpp`.
- Solid background clipping supports border/padding/content boxes; do not infer
  support for image/gradient clipping from that unit.
- Raster border-image supports packaged static URLs, stretch slicing, an
  unpainted center and bounded slice/width units. Responsive overlap reduction
  shares one scale factor. Border shorthand resets the image. Nonzero outset,
  fill, repeated tiles, SVG, separate border-image longhands and runtime-created
  declarations remain unsupported.
- Filters use strict literal parsing (`src/ui-filters.ts`) and shared shader
  definitions (`src/shader-builtins-ui.ts`). CSS variables/math/important in
  filter expressions remain refused.
- `pal_ui_filter.hpp`, `pal_ui_filter_sdl.hpp`, `pal_ui_filter_dawn.hpp` and
  `UiRenderFrame` share ordered reset/backdrop/composite operations. Layer IDs
  are reused by depth, offscreen targets are FP16, and backend resources such as
  bind groups/buffers persist appropriately. Both scene and standalone Window
  consumers use the mechanism. Window capture readiness also handles canvasless
  retained UI.
- Independent scene and Window filter probes checked interior colors, blur,
  shadows and nested backdrops on both backends. `filter-pixels203.log` reports
  backend MAD 0 and maximum difference 0 for both probes. These focused probes
  supplement, but do not replace, corpus parity or full application behavior.

### Reduced-motion media rules

- `NativeHostUiStyleRule.reducedMotion?: boolean` maps to native
  `UiMotionPreference::{Any, Reduce, NoPreference}`. The media-presence helper is
  used by static cascade and structural-grid proofs as well as code generation.
- Source CSS accepts standalone `prefers-reduced-motion: reduce|no-preference`.
  Nested/combined source media queries are not generally admitted. Existing
  max-width source rules retain their property whitelist. Structural fixed and
  fractional grid substitutions inside media queries refuse.
- Native RmlUi media uses two themes, `bbl-motion-reduce` and
  `bbl-motion-no-preference`, through existing `Context::ActivateTheme` support.
  Host rules can combine their width and motion conditions. No new dependency
  patch was needed for motion.
- `native/src/pal_system_preferences.hpp` reads Windows
  `SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, ...)`, caching per thread
  for about one second. Other platforms explicitly refuse when this preference
  is reached. No UI consumer means no preference polling.
- Runtime updates synchronize motion and the tree once when both change, and
  include motion in layout/gradient/outline invalidation. Even rules containing
  only private projected declarations must activate preference observation;
  do not put that bookkeeping after an empty-public-style early return.
- `ui-media-motion-check.cpp` injects a preference reader to test false/true/false
  transitions, geometry/colors and private inset outlines without modifying the
  user's Windows setting. It also exercises the real read API.
- Scoped simplify findings applied: explicit complete native argument lists,
  one tree synchronization for coincident changes, and one layout-change
  predicate. A batched RmlUi theme notification was deferred: it would require
  dependency API/patch work outside that unit, and the two notifications occur
  only on initialization or an actual preference change. Reuse review was clean.
- This unit covers **CSS media rules, not general JavaScript `matchMedia`**.

## Likely subsequent gaps, not a completed backlog

Ignored CSS inventories (`private-css-inventory.json`,
`private-css-refusals.json`) were diagnostic snapshots, not an alternate parser
or justification to bypass refusals. Read current source and retry the compiler
after each real fix. Inventory entries may already have been addressed later.

Remaining forms observed during investigation include additional side-border
properties, grid forms, logical spacing, CSS variables/math, masks/clips,
pseudo-content, text forms, images, height/min-width media conditions and
combined media queries. Filter declarations using variables/math or important
were still refused. Implement only well-defined generic behavior, with explicit
limits, rather than a list of application-specific accepted strings.

The application also reaches JavaScript width and reduced-motion media queries
and reads their `matches` result. The inspected Window `MediaQueryList` in
`native/src/pal_window_realm.cpp` currently parses an exact resolution/dppx form;
its delivery compares DPR. The compiler arm in `src/compiler/canvas.ts` yields a
worker-media-query value and admits change listeners. General width/motion
queries and a `matches` lowering were not implemented during this session.
Inspect the current header and property dispatch before extending this area.
RmlUi itself supports width/height/resolution/orientation/theme conditions, but
that does not make the source compiler or JS API support automatic.

## TODO and review bookkeeping

The foundation narrowed the first compiler TODO: normalization, bounded locale
comparison and mixed Map entry tuples are supported. Remaining work still
includes replacement callbacks, locale lists/options beyond numeric/sensitivity,
`Set.entries()`, dynamic mixed-tuple indexing, rest bindings and length-changing
methods. Later UI units and the sweep fixes did not fully close another listed
TODO. Open GitHub issues were queried earlier and returned an empty list; that
was a session observation, not a permanently current claim.

Keep new verified residuals in the appropriate canonical owner. Do not remove a
whole TODO just because one reached case now passes. The full-branch simplify
record is content-hashed; even this requested handoff changes the eventual diff
to review. Do not fabricate completion of the missing review.

## Local build environment and commands

This is Windows/PowerShell. CMake is not on PATH in this environment. Set the
documented fallback immediately before native scene commands:

```powershell
$env:CMAKE_COMMAND = 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
```

Critical concurrency rules:

- Never rebuild/delete `dist` while a CLI, scene command or test run uses it.
  Build once, then invoke `node dist/...` directly for a sequence.
- Finish generation before native builds. Never edit native sources/headers
  while native builds/tests are running. Wait for all jobs and check their exits.
- Serialize vcpkg manifest reconciliation and dependency install variants. Once
  development dependencies are reconciled, builds can use
  `VCPKG_MANIFEST_INSTALL=OFF` as documented.
- Keep logs in ignored artifacts. Redirected output is not a success indication:
  preserve/check `$LASTEXITCODE`. Do not reuse old process/session IDs from a
  previous agent; inspect live processes and locks.
- Use `rg` on directories with `-g` filters. PowerShell wildcard path arguments
  such as `rg ... test/ui-*.test.ts` caused avoidable path errors.

Pinned inputs:

- `@babylonjs/lite` 1.27.0, source
  `64710b56f9dfe175d919c635812f84c8872d467c`, owned by
  [upstream/babylon-lite.json](upstream/babylon-lite.json).
- RmlUi `b7b4a0688262832eacf3b9abb41f8bbe73868af8`, owned by
  [upstream/rmlui.json](upstream/rmlui.json). All nine maintained patches were
  installed in the development, static and static-SVG variants by run `209`:
  css-box-model, flex-layout, fractional-letter-spacing, line-leading,
  overflow-wrap, premultiplied-rounding, solid-background-clip,
  textured-borders, transform-key-ownership.
- Preserve source/Tint pins, corpus inputs, references and thresholds. Fix
  compiler/lowerer/PAL source; never generated C++ as the implementation.

Installed dependency locations:

```text
artifacts/tools/rmlui
artifacts/tools/rmlui-static
artifacts/tools/rmlui-static-svg
artifacts/vcpkg-installed/development-full/x64-windows
artifacts/vcpkg-installed/shipping-demo-png/x64-windows-static
artifacts/vcpkg-installed/shipping-demo-jpeg-png/x64-windows-static
```

If patches change, rebuild the relevant variants sequentially. The commands
used successfully in this session were:

```powershell
& ./tools/build-rmlui.ps1 -Jobs 8
& ./tools/build-rmlui.ps1 -StaticRuntime -FreetypeRoot C:/Dev/babylonlite/artifacts/vcpkg-installed/shipping-demo-png/x64-windows-static -Jobs 8
& ./tools/build-rmlui.ps1 -StaticRuntime -EnableSvg -FreetypeRoot C:/Dev/babylonlite/artifacts/vcpkg-installed/shipping-demo-jpeg-png/x64-windows-static -Jobs 8
```

Native fixtures use C++20 and warning-as-error compilation. Development scene
builds use clang-cl when available; MSVC fixture/shipping checks matter because
they can expose include/narrowing issues missed elsewhere. Common Rml fixture
dependencies include FreeType, LunaSVG, SDL3, DirectWrite and user32.

To reproduce external generation after the user resumes implementation:

```powershell
Set-Location C:\Dev\babylonlite
# First ensure no process is executing the current dist tree.
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Compiler build failed.' }

node dist/src/cli.js C:/Dev/_prototypes/external-native-app/src/main.ts --out generated/external-app --title 'External Application' --public-dir C:/Dev/_prototypes/external-native-app/public *> artifacts/external-integration/compile-next.log
$externalCompileExit = $LASTEXITCODE
Get-Content artifacts/external-integration/compile-next.log -Tail 30
if ($externalCompileExit -ne 0) { Write-Output "Generation stopped with exit $externalCompileExit" }
```

A direct external attempt took roughly two to three minutes in earlier runs.
Keep its diagnostics private. Do not register the private project in the corpus
or create tracked project-specific adapters to get to the next error.

The standard validation commands, when appropriate after future changes, are:

```powershell
npm run simplify:verify
npm test
npm run sweep
node dist/src/scene-command.js neutrality artifacts/external-integration/baseline
```

Run them sequentially and check each exit. `npm run sweep` is `validate all`:
generation, shaders, native builds, differential parity, published status.
It is separate from `npm test`. A failed build stops subsequent measurement
stages so stale binaries are not treated as current evidence. The population
build still drains the whole set and reports every failure.

## Artifact guide and pitfalls

| Local artifact | Purpose / caution |
| --- | --- |
| `compile222.log` | Latest actual external-app blocker |
| `full227.log`, `sweep227.log`, corresponding `.exit` files | Definitive green validation at this pause |
| `sweep224.log` | Initial full sweep: only Doom failed native compilation; later stages skipped |
| `regression225.log` | Neutral test reproducing namespace/local constant mismatch |
| `regression226.log`, `doom226.log` | Fix validation |
| `full226.log` | 2,554 passes, two stale UI test assumptions; superseded by green full227 |
| `focused227.log` | Both stale UI test fixes pass |
| `baseline/` | Preserved earlier differential reports; never overwrite with current results before comparing |
| `private-css-inventory.json`, `private-css-refusals.json`, `api-inventory.json` | Private diagnostic inventory; do not stage or publish |
| `inventory-private-css.mjs`, `audit-private-css.mjs` | Diagnostic scripts; the latter invokes the existing CSS declaration audit rather than admitting unsupported declarations |
| `check-staged-types.mjs` | Checks an exact index snapshot and staged content for a private-name leak; uses `staged-types/` with a node_modules junction |
| `ui-filter-scene.ts`, `ui-filter-window.ts`, four corresponding PNGs | Independently authored filter probes and backend captures |
| `build-filter-probe.mjs`, `check-filter-pixels.mjs` | Build/render neutral probes and assert expected pixels; inspect first because build settings are derived from the offscreen CMake cache |
| `build-platform-smoke.mjs`, `platform-smoke/`, `platform-smoke-storage/` | Earlier neutral platform integration proof, including reload/storage behavior |
| `rml-flex209.log`, `rml-flex-static209.log`, `rml-flex-static-svg209.log` | Successful installed Rml variants with the current nine patches |
| `savepoint.md`, `pr-savepoint.md` | Older local handoff and current PR-body text; this tracked handoff is the portable entry point |

The remaining many numbered logs record intermediate failures and fixes. Later
success supersedes earlier failure, but use older logs to recover an investigation
when needed. Never present the maximum numbered generation attempt as a count
of supported features or as evidence of end-to-end success.

Several ignored `.mjs` files are one-off editing/patch-generation scripts, not
supported reusable tools. Do not rerun them blindly. In particular,
`create-flex-patch.mjs` depends on the saved eight-patch base at
`artifacts/external-integration/flex-patch/a`; regenerating against today's
already-nine-patched cache produces the wrong patch. The fixture-sharing and
border/filter editing scripts have similar assumptions. Use maintained source
and `tools/build-rmlui.ps1` as the authoritative build path.

`gh pr edit` failed on this machine because its GraphQL query included deprecated
Projects (classic) fields. Pushing succeeded independently. The working fallback
was `gh api --method PATCH repos/sailro/bblitec/pulls/247 --input <JSON file>`
with a `body` string, then checking the exit and returned PR URL. Read the current
PR body before updating it, preserve actual newlines, and keep private data out.

## Resume checklist

When the user asks to continue the integration:

1. Read this handoff and canonical docs. Verify branch, Git status, upstream
   state, external checkout revision and installed tool/dependency availability.
   Do not assume ignored artifacts survived a clone or that previous jobs remain
   active.
2. Confirm the working tree is safe to build, set the CMake fallback, and build
   `dist` only after existing consumers finish.
3. Retry the unchanged external source and reproduce the current ownership
   blocker with a small neutral fixture. Keep generic handling and explicit
   refusals; do not simply erase the reached operation.
4. Implement and validate one coherent unit, inspect overlapping TODOs/issues,
   and commit it. Reuse existing native UI and typed compiler mechanisms.
5. Continue through generation, native build, rendering and actual application
   behavior. Do not call the application compiled at a generation-only milestone.
6. Before claiming the broader integration complete, finish the required whole
   diff review, current tests/sweep, saved-baseline comparison and relevant
   interaction checks on both backends. Keep PR claims proportional to evidence.

At this saved checkpoint, steps 3–6 remain future work. The user's requested
green-sweep stopping point has already been reached.
