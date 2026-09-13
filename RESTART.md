# Current work

## Objective and rules

Compile, build and run the unchanged external application; validate its intended scene.
Read [canonical documentation](README.md#documentation) before feature work.

- Documentation contains concise current facts/state only. Replace stale text; no session logs.
- Keep private project names, URLs and copied source out of tracked files and PR text.
- Add generic support with neutral fixtures; preserve application/corpus inputs and references.
- Audit and group requirements before implementation; avoid serial first-error fixes.
- Report one evidence-based global completion percentage; 100% requires complete integration.
- Match TODOs/issues; commit completed units regularly. Status questions do not stop authorized work.
- Full access, approval never. Do not request routine authorization or use sandbox_permissions.

## Workspace

| Item | Value |
| --- | --- |
| Checkout | C:/Dev/babylonlite |
| Branch | codex/external-project-support |
| Compiler baseline | Current branch; pagehide stabilization |
| Draft PR | [247](https://github.com/sailro/bblitec/pull/247) |
| Main integrated through | 9265afa7 |
| External source / assets | C:/Dev/_prototypes/external-native-app/src / public |
| Application revision | d7c477a6d5963680c55249dceb93cb6e4ab9ce56 |
| Active native/generation processes | None |

## Application state

The latest full generation attempt stopped at main.ts:440 (pagehide); that capability now passes its
native fixture. The full application has not been retried. Native build, launch and intended-scene
validation remain blocked by complete generation. Inventory: 1,343 modules, 22,709 bodies, 392,310 lines.
Function lowering observations: 558 bodies in 96 modules; 28 modules have observations for every body,
68 have partial observations. These are not whole-module native compilation results.

## Completed unit

Window pagehide uses shared listener dispatch before owner cleanup. Native event optionals preserve
absent/false values, and error-event targets compare through their represented DOM identities.
Interrupted-task microtasks are discarded before the closing turn. Native pagehide passes on both backends.
Validation: focused regressions and close/reload/host-shutdown runs. The broad test run was stopped at
the user's request; no scene sweep was run. Evidence: artifacts/external-integration/pagehide1101-focused.log
and pagehide1100-runtime.json / pagehide1100-lifecycle/results.json.

Other confirmed setup gaps: engine._renderFn wrapping and shared Window/worker device recovery.
Realm engines borrow the Window GPU device; recovery requires coordinated ownership.

## Audit state

All source hashes match the saved inventory. requirements1093.json contains 1,009 requirement groups,
81,788 calls, 57 unresolved call signatures and 689 unresolved property sites. No open GitHub issues.

| Evidence in artifacts/external-integration/ | Result |
| --- | --- |
| application-progress1087.json | Latest full compile observations |
| requirements1093.json | Whole import graph and source sites |
| audit1093-probes.json | 28 representative probes: 20 generation refusals, 8 passes; includes pagehide WIP |
| audit1093-probes.json, dispatch | 146 API names: 53 unrecognized, 87 need arguments/context, 6 empty-call passes |
| capabilities1093.json | 24 neutral generation probes pass |
| private-stylesheets1093.json | 11 literal sheets pass, 10 refuse; 36 templates need source bindings |
| issues1093.json | Open issue snapshot |

**Global progress: 10% verified acceptance (3/30 fixed groups).** Closed: startup configuration,
decoder configuration, primary engine/surface setup. Equal group credit measures delivery acceptance,
not effort or time remaining. Partial work earns no group credit. 100% requires all final integration gates.
All 1,009 requirement groups have one owner; new scope needs a documented denominator change.

Local ledger/report: artifacts/external-integration/application-acceptance.json and APPLICATION_PROGRESS.md.
APPLICATION_AUDIT.md gives gaps and implementation order; application-audit.json gives source sites.
Recalculate with `node tools/project-progress.mjs <ledger.json> [report.md]`; evidence hashes, requirement
coverage and dependencies must validate. Dispatch/literal/probe acceptance alone earns no native credit.

## Next actions

Stop after the stabilization commit and push, as requested. On a new instruction to resume:
follow APPLICATION_AUDIT.md, starting with core/data cohorts. Retry the full application at batch boundaries;
update acceptance evidence and recalculate the same metric when a group closes or reopens.

## Local commands

Set CMAKE_COMMAND to the Visual Studio 18 CMake path in [development](docs/development.md#setup).
Use native build concurrency 2. Build dist once; never rebuild it during a running command.
Use git -c safe.directory=C:/Dev/babylonlite. Do not touch unrelated worktrees.

Ignored helpers: compile-with-progress.mjs, render-application-progress.mjs, check-generated-native.mjs
(--pal/--workers/--asset-support/--large-stack), check-staged-types.mjs. Historical docs are archived
under artifacts/doc-rewrite1094/. Logs and private evidence remain local.
