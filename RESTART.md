# Restart handoff

Session handoff requested by the user on 2026-09-11. This document records the
state and reasoning needed by a replacement agent; canonical support contracts
remain in the documentation linked below. Local artifact paths are relative to
the repository unless an absolute path is given. Ignored artifacts and installed
dependencies will not be present in a fresh clone.

## Read this first

**Work resumed on 2026-09-12.** The user explicitly asked to continue. The earlier
stop-after-green checkpoint is historical; continue the generic integration work
and save completed units as regular commits.

On resuming again, the user explicitly reiterated: status answers, green unit
tests and commits are not stopping points. Continue implementation and validation
until the complete external application compiles and runs. Only the user decides
to pause. Do not end an active work turn after a status answer or savepoint.

**Workflow steering on 2026-09-12:** the user asked for measurable progress and
faster iteration after several days of first-error repairs. Use independent
capability probes and a static requirements inventory to expose groups of gaps
before implementing them. Do not resume a full-suite/full-application retry after
each small edit. Keep focused checks during a batch; use the unchanged entry and
broader regression checks at useful batch boundaries. Unknown requirements stay
visible; do not invent an overall completion percentage from static counts.

**The external application does not fully compile yet.** Native graphics availability now opens the intended startup branch; generation
stops on a stylesheet helper argument without a static string. Its native build and intended
application runtime have never been reached. A green sweep validates the registered corpus;
it does not establish that this external application compiles or runs.

| Item | Saved state |
| --- | --- |
| Compiler checkout | `C:/Dev/babylonlite` |
| Branch | `codex/external-project-support` |
| Remote | `https://github.com/sailro/bblitec.git` |
| Branch base used in this session | `3474e835` on `main` |
| Latest executable-code/test unit | Control appearance/logical spacing/input types (`ac616c41`); prior savepoints `a25c5eea` (implicit grids/unmarked lists), 1fe43c54 (CSS presentation/visibility), `a81992d4` (owned async methods and promise selection), `0bdfc5b1` (native graphics availability), `613d52b6` (image/promise startup readiness), `8af15082` (asynchronous startup), `f699ad6b` (promise cleanup), `059bfbca` (generic/nested/defaulted destructuring), `bdce7a97` (captured lexical initialization), `bc21486a` (scheduled audio events), `95b04043` (async control flow), `e5ea2607` (async collections), `24281f2c` (promise caches/reactions), `53ba4164` (recursive async and hardened validation) and `f5cd2061` (AudioBuffer surface) |
| Draft PR | [#247 — Extend generic application compilation and retained UI support](https://github.com/sailro/bblitec/pull/247) |
| External checkout | `C:/Dev/_prototypes/external-native-app` |
| External source revision | `d7c477a6d5963680c55249dceb93cb6e4ab9ce56` |
| External checkout changes | Clean when this handoff was prepared |
| External generated output | `generated/external-app` (ignored; not a successful complete generation) |
| Session diagnostics | `artifacts/external-integration` (ignored) |

Latest complete-entry attempt: `compile741` passes all eight captured stylesheets
and stops at the stylesheet helper's css argument, bound as data without a static
string (213.4 seconds). Next trace the argument's caller/origin and assess helper
specialization, rather than guessing another CSS property. Full intended application
generation, native build and runtime remain incomplete.

The control/spacing unit is committed and pushed as ac616c41; draft PR #247 was
updated with pr744.json. Staged TypeScript/privacy/whitespace checks pass, along
with the final spacing743 focused and two-backend Window checks.

static-argument744 traces the same application failure in 204.4 seconds to a
stylesheet mixing closed string helpers with numeric constant arithmetic. The
eight basic Window helper forms in style-arguments746 all pass; 745 was an invalid
non-Window probe and is not a capability baseline. numeric-templates749 establishes
a separate eight-case arithmetic template baseline: two accepted, six refused.
752 accepts all eight. Numeric facts now use the existing static number evaluator
at the template sink, without folding arbitrary ordinary numeric expressions.
Substitutions are evaluated and pinned in source order. Writable parameter initial
metadata must not masquerade as a current value, and writable string parameters
need native string storage. An explicit unknown formatter precision cannot fold
as an omitted argument. templates750 exposed stale mutable parameter text and an
overly strict whitespace assertion; 752 exposed a writable string bound to its
literal instead of native storage. 753 passes all eleven string/specialization
checks including native effect order and mutable number/string/boolean parameters.

The new ignored assess-module-stylesheets.mjs evaluates module-level stylesheet
constants with their original dependencies using an in-memory Window probe. It
does not edit private files. module-stylesheets747 refines the 36 previously dynamic
templates: seven accepted, twenty-one refused, eight local templates unassessed.
Four refusals are missing static strings; the rest reach concrete CSS requirements.
This includes unused code and remains separate from application/native completion.
Full captured CSS lives beside each module report in its -sheets directory.
module-stylesheets754 keeps the same seven/twenty-one/eight outcome counts, but all
four missing-static-string cases now reach and capture CSS. Their next refusals
are background sizing/repeat, explicit grids, and decoration on generated content.
templates754-regressions passes 953/953 without skips. templates-window755 passes
numeric stylesheet geometry, mutation/order checks and the original DPWCDWMK
replay on SDL_GPU and Dawn. population755 has generated all 288 entries; its
native bootstrap passes. The unchanged complete-entry compile756 still stops at
the stylesheet argument after eight sheets (202.3 seconds). Do not claim the
application boundary is cleared from the isolated-module result. imported-styles757
reproduces it by importing only the stylesheet installer, avoiding another complete
entry retry; the two neutral imported arithmetic-template controls pass. Trace the
remaining difference in that reduced import path before the next CSS unit.

The template unit is committed/pushed as d025ccf9; PR #247 is updated with pr759.json.
imported-strings758 proves that the materialized module's computed numeric constant
has native storage but no numeric fact. Its closed string helpers all succeed.
The smaller module-constants759 cohort has three pure constant cases (one passes)
and a separate mutable-input snapshot (refuses an unbound scalar). 760 passes all
three pure cases by preserving proven const numeric results on the stored binding;
it does not fold live canvas dimensions or re-run effectful initializers. The
mutable-input case remains refused and is now an explicit module-planner TODO.
imported-styles760 gets past the real imported installer to generated-content
inset-outline decoration; this reduced import takes seconds instead of a full entry.
module761 passes eight string/module checks including a permanent multi-module
stylesheet fixture. The shared native Window template fixture now imports a computed
constant from a module with mutable state and checks both numeric layout and calls.
module762-regressions passes 851/851; templates-window762 passes both backends.
population762 generates 287/288 but exposes excessive local-loop specialization
in antigravity-racer after numeric facts were attached to all const declarations.
The fix now applies to module-level immutable bindings only. Local loop facts stay
with the existing specialization analysis. module763 passes all eight focused
checks, and antigravity-racer generates successfully with its unchanged expansion
budget. The preceding d025ccf9 population755 generated all 288 and passed bootstrap.

Control/spacing support uses native property/shorthand registration without another
RmlUi patch (still sixteen). appearance:auto/none and the prefixed alias share one
property. The initial native implementation suppressed the whole range theme;
appearance733-browser.png proves the browser preserves its independently themed
thumb. The corrected decorator suppresses only the track and includes appearance
in its texture key. spacing734 passes three checks including pixel alpha, retained
thumb/focus/keyboard input, logical/physical cascade, auto margins and live removal.
The original ten control-spacing727 declaration probes refuse 10/10; 731/735 admit
10/10. Logical margin/padding pairs and start/end edges use the existing physical
properties for the supported horizontal LTR layout, including media overrides.
Their names participate in the fixed-grid geometry proof so padding cannot bypass it.

population735 generates all 288 entries and passes the native bootstrap.
spacing735-regressions passes 785/785. compile735 gets past appearance but refuses
gap in the same stylesheet's max-width rule (253.7 seconds); the earlier body-only
inventory had lost that media context. Gap/row-gap/column-gap media overrides now
lower. assess-full-stylesheets.mjs preserves whole captured stylesheets: 739/740
admit all eight. The broader assess-private-stylesheets.mjs reports a NEW baseline
of 57 candidate complete literals: 11 accepted, 10 refused, 36 dynamic/unassessed
(private-stylesheets742); it includes unused code and is separate from body counts.
css-bodies740 is 998 accepted / 126 refused / 77 unassessed, not native coverage.

The Window harness exposed the old file-only input type gate in 736. 737 also
confirmed that input is outside the source innerHTML subset, unlike host companions.
The constructed-control gap is now fixed for static text/password/range types:
the shared attribute path emits normalized types without file dependencies. Other
types and changing an active file input into another type remain explicit refusals.
The native file transition guard protects aliases too. Do not claim checkbox/radio,
number/date semantics or broader innerHTML forms from this extension.

spacing738 ran 13/14: an old source assertion in browser-file.test.ts still expected
short pre-DOM-dispatch source and an untrusted click signature. Its function-scoped
ordering assertion now includes the shared DOM dispatch and trusted projected clicks;
the listener-before-default-action contract stays asserted. spacing740 passes 14/14,
including file transition refusals; spacing741-regressions passes 796/796 without skips.
spacing-window738 passes actual range construction, media/inline spacing and unchanged
DPWCDWMK replay on SDL_GPU and Dawn. Final alias normalization preserves reads after
prefixed cssText; spacing743 passes six focused style/control checks, and
spacing-window743 passes both backends including both appearance alias getters.

The earlier `compile721` passes the list/implicit-grid stylesheet
and reaches another stylesheet, stopping on appearance:none after 252.7 seconds
while broader checks ran concurrently. The whole new stylesheet also needs
padding-inline in a max-width rule. Handle those together in the next control/logical
spacing batch; the application has still never completed intended generation/build/run.

The previous `compile706` passes the newly admitted presentation
styles and stops on list-style:none after 160.8 seconds. Auditing the ENTIRE newly
reached stylesheet also identifies implicit display:grid with place-items:center.
Those list/grid forms are now handled together as described below. The prior
`compile704` stopped on -webkit-user-drag:none (196.3 seconds); that hint is now
admitted. The earlier `compile677` generated only the no-GPU fallback (132.5 seconds,
no scene renderer); it was never full application success.

The list/grid unit adds a sixteenth patch on the unchanged RmlUi revision:
rmlui-zero-track-grid.patch. The build applies patches alphabetically, so this patch
comes after the existing visibility/textured-border changes. The initial 711 build
used a name that sorted too early and failed patch application; 712/717/724 build
successfully, with the last including explicit runtime refusal of percentage-dependent
grid item dimensions and baseline alignment. Other installed static artifacts still
need rebuilding if used. Regenerate only this incremental patch with
artifacts/external-integration/save-grid-patch.py and the saved original nine-file
implicit-grid-rml-before tree; do not rerun the initial mutation scripts.

Native grid formatting reuses intrinsic item sizing and line alignment with one
auto column and a separate auto row per child. It ignores child flex factors/basis,
distributes fractional extra row space independently of gaps, respects min-height,
supports item/content alignment and grows the column for overflowing fixed items.
No element containers are inserted; text uses the existing anonymous item path.
Native place-items is a real shorthand, preserving inline writes/removal/cascade.
Lists have block defaults; list-style:none/list-style-type:none preserve the native
absence of markers. Other markers, general tracks/placement and broader replaced
item sizing remain TODOs. The stored variadic Math TODO remains open; GitHub's open
issue list was empty again during this unit.

The fixed implicit-grid710 baseline refuses all eight declarations; 718 accepts
8/8. The static CSS body inventory improves from 954/170/77 to 994/130/77; this still
includes unused code and is not runtime coverage or an application percentage.
Browser measurements are saved in grid716-browser.json/html. They confirm baseline,
resize, hidden/self-aligned/live rows, auto margins and overflow geometry. Permanent
native checks cover text, rendering/input, authored parents/selectors, shorthand
updates/removal, row stretch, content alignment, minimum height and refusal boundaries.
The 714 native fixture used a Windows near macro as a variable; renamed. 719's sole
failure was an incorrect shorthand-removal expectation: removing the shorthand
clears its inline longhands, which is now asserted. grid725 passes all six focused
implicit/fractional/fixed-grid checks.

presentation709 completed 780/780. population721 generates all 288 entries and the
native bootstrap passes. grid721-regressions completes 781/782; its old refusal test
still expected display:grid to fail and now tests unsupported inline-grid instead.
grid-window722 used unsupported DOMRect x/y aliases; the fixture now uses the existing
left/top fields. 723 exposed the old structural grid proof running on native implicit
grids; uiStaticEffectiveGrid now exits early when no explicit projection can apply,
preserving all existing explicit-grid proofs. A permanent generation check covers
inline construction and placeItems mutation. grid-window725 passes both SDL_GPU and
Dawn, with numeric geometry checks and unchanged DPWCDWMK replay/completion markers.
grid726-regressions passes 782/782 without skips. A final review also found that
static grid containers needed block stacking order, and their items needed atomic
stacking like flex items. grid727 rebuilds that incremental correction; grid728
passes three checks including overlapping static boxes and visibility. The mistakenly
named flex path did not select the actual fixture; grid729-flex runs ui-flex.test.js.
The next fixed control-spacing727 cohort refuses 10/10 declarations at baseline.

Native GPU availability uses the optional HostServices graphics identity. Window
services expose their existing device; child workers inherit those services.
Compute-only realms have no graphics identity. Browser adapter creation and raw
GPU prototypes remain unsupported. Presence, aliases, identity, null comparisons,
and typeof through helpers preserve runtime presence rather than TS non-nullness.

The fixed graphics availability assessment improves from `679-native` 3/8 to
`681-native` 8/8. `graphics-availability684` passes three permanent checks, including
scene-generation retention and capability inheritance in workers with/without a
host device. `graphics-window683` passes actual Window service checks on SDL_GPU
and Dawn with the unchanged DOM replay/completion checks. `regressions685` passes
921/921 without skips; `population685` generates all 288 registered entries and
completes scene41's native bootstrap. An independently found dynamic typeof to
inferred string-literal enum field conversion gap remains visible in TODO.md;
explicitly string-typed message fields work.

Async method composition now routes object/class methods, callback fields and
literal-key invocations through the existing owned async activation. The body
entry bypasses the activation gate to avoid wrapping itself recursively. Async
receivers allocate mutable record fields before invocation; arguments retain
call-order snapshots. Promise conditionals use the shared conditional data sink
so argument effects and coroutine activation stay within the selected branch.

The fixed `async-methods688-native` baseline passes 4/12; `async-methods693-native`
passes all twelve. These fixed conditional probes specialize literal loop values;
the stronger permanent `async-methods.test.ts` uses runtime condition reads and
compares native execution with JavaScript. That oracle exposed untaken-branch
argument effects in `691`; the shared sink fix passes `692`, including argument
order, independent receiver mutations, rejection, void callbacks, class methods
and managed-node cleanup. Three existing async-control/recursion/constructor
checks pass in `691`. `regressions693` passes 922/922 without skips; `population693` generates all
288 entries and completes the native bootstrap. `compile693` reaches the next CSS
boundary described above. Open GitHub issues are empty; the remaining variadic
core-library and broader Promise TODOs do not become closed by this batch.

The next CSS batch admits physical border sides/width/color longhands, visibility,
font-style, text-transform, text-overflow and literal transform origins. The fixed
`css-declarations695` baseline is 0/12 accepted; `697` accepts 7/12. The five remaining
families are aspect ratio, general grid tracks/placement, independent background
placement and animation/transition longhands. `css-bodies695` inventories 1,201
candidate literal rule bodies (including unused code): 861 lower, 263 refuse,
77 dynamic/unassessed. `697` improves this to 951/173/77. This is a static diagnostic
inventory, not native coverage or an overall completion percentage.

RmlUi keeps the SAME upstream commit but now has a fifteenth maintained patch,
`rmlui-visibility.patch`, applied after the previous fourteen. The development
artifact was rebuilt successfully in `visibility698-build`. Other installed
static variants still need rebuilding if a final sweep/shipping check uses them.
The patch makes visibility inherit, keeps hidden ancestors in stacking contexts
while suppressing their own paint, admits visible descendants in hit testing and
focus, and handles delayed zero-duration transitions. The initial 697 build found
a const GetDisplay call; the corrected patch uses computed display. Patch baseline
copies are ignored in `visibility-rml-before`; regenerate the incremental patch
with `save-visibility-patch.py`, not a whole checkout diff that includes older patches.

`visibility696-baseline` fails inheritance with the old library. `698` passes
inheritance/paint but the test omitted pointer-events:auto (the retained div default
is inert); corrected in 699. The inline fade in 699/700 revealed an existing RmlUi
limitation: inline style changes do not initiate transitions. That failure is kept
as `visibility700-inline-check.cpp` and is explicitly recorded in TODO/docs. The
permanent fixture tests stylesheet/class transitions used by the reached styles;
`visibility701` passes layout, overrides, native focus/hit testing and delayed hiding.

`presentation702` passes generation and visibility but its border-removal expectation
was wrong: clearing border-width removes the longhands from the same inline style,
so the expected width is zero. Corrected, `presentation703` passes both presentation
checks. `presentation704-regressions`, `population704`, `compile704`
and `visibility-window704` runs have completed; see corrections below. The Window
fixture preserves DPWCDWMK and adds an invisible pointer-enabled cover over the input
button plus a visible descendant away from the clicks; both SDL_GPU and Dawn have
reported completion in the log. No private CSS/source is copied into tracked fixtures.

`presentation704-regressions` completed 778/780; both failures were older fixture
contracts, fixed and committed/pushed as `c9e36592`. Decoder-enabled RmlUi fixtures
now link pal_image.cpp; the image fixture supplies actual file reads and performs
source changes on an EventLoop. The optional-call fixture retains all six authored
node/relationship assertions while accounting for the three permanent document
roots. `presentation705` passes four focused checks. `population704` completed all
288 entries and scene41's bootstrap; `visibility-window704` passed both backends.

`compile704` stopped on -webkit-user-drag:none in the same newly reached stylesheet
(196.3 seconds). The native projection already has no default image drag initiation;
none is now accepted as an inert hint, while other values refuse. Inert hints are
removed from projected CSS while authored stylesheet text remains available.
The final `css-bodies706` inventory is 954 lowered / 170 refused / 77 unassessed;
the twelve-family assessment still accepts 7/12. `presentation706-regressions` finished 779/780; `compile706` finished at the
list/grid boundary above. The regression run found one new test false-positive:
its no-drag-hint assertion accidentally inspected authored stylesheet text too.
The assertion now inspects projected ui_add_* declarations only; `presentation707`
passes all three presentation/visibility checks after rebuilding. Every failure
from the broad UI run is resolved; no implementation fix was needed for that
assertion. The seven admitted fixed declaration families and all twelve original
CSS family refusals remain visible in the assessment artifacts.

`emitEntryBody` detects entry-level awaits in realm-backed entries, skips nested
function bodies, and emits one owned coroutine with a native return frame. It
uses the existing capture renderer and async activation without treating the
one-time startup body as a deferred callback: construction metadata must remain
available. A local scope prevents callback captures from borrowing coroutine
locals as lifetime-long entry-stack variables. Post-entry native UI/deferred
physics emission remains inside the startup frame. Realm engines already use
`start_realm_engine`; the synchronous frame conductor split is separate.

`startup-awaits655-native` passes 2/8 at baseline; `startup-awaits656-native`
passes all eight. The permanent `startup657` fixture passes three native checks:
main, module and worker startup; callbacks observe changes made after awaits and
outlive initialization, and the main realm returns to its starting managed-node
count. `regressions658` passes 912/912 without skips. `population660` generates all
288 registered entries and completes scene41's native bootstrap.

The initial `startup-window658` build succeeded but its unchanged input sequence
saw only the keyboard event: the Window host published an empty document before
the initialization microtask checkpoint. The first `tick_document` now uses
`EventLoop::after_microtasks`. `startup-window659` passes both SDL_GPU and Dawn
with the original DPWCDWMK input/layout assertions. `queries-window660` also
passes the existing query/selector fixture on both backends. The ignored
`run-dom-window.mjs --startup` harness wraps the ordinary DOM input fixture in
an async main with Promise.resolve awaits before/after its body; it reuses the
same build configuration, replay and completion marker rather than delaying input.

Startup readiness gates are implemented as a coordinated generic batch. The fixed
`startup-gates661` baseline is 0/12 generation accepted. `startup-gates677` accepts
12/12; `startup-gates677-native` passes all nine core promise probes. The three
image forms are included in `image-window677`, which passes SDL_GPU and Dawn
with valid/broken/empty/replaced image checks, repeated decoding, natural sizes,
nested RAF/timer racing and the unchanged DOM input replay/completion assertions.

Promise constructors use a synchronous borrowed executor closure, while resolver
values retain owned promise state through the shared callback capture/sink paths.
The old frame-handshake latch is bypassed in realm builds. Async executors share
the owned activation lowerer; their return promise is discarded as in JavaScript.
First settlement locks immediately; adoption observes its input in a queued job.
The JavaScript oracle caught early adoption and resolver record rematerialization;
both are fixed. Default-library resolver signatures participate in shared alias
retention, after checking whether an argument actually contains an alias. Direct
resolver calls explicitly refuse extra arguments. Homogeneous value/promise races
observe every competitor, including losers, and empty races stay pending.

Image requests stay on the source realm and are stripped from document snapshots.
Source mutation invalidates pending requests. Packaged decoding runs in a realm
microtask and retains dimensions/pixels; empty/broken requests reject. The existing
image decoder moved unchanged from pal_sdl.cpp to pal_image.cpp, selected by both
scene and UI feature projections, so Window startup needs no scene engine. Static
image attributes use the logical-path asset registrar. Distinct DOMException,
network/responsive sources and load/error events remain TODOs.

`regressions675` passes 910/916: the six failures were the centralized-library
identity architecture rule, four source-list expectations and the moved decoder's
old fixture include. All fixed; `regressions677` passes 916/916 without skips.
`startup-gates678` passes six native constructor/cleanup/startup checks after adding
async executor coverage. `population675` generates all 288 entries and completes
scene41's native bootstrap. Image build670 caught missing decoder linkage; run671
caught a bad fixture PNG CRC. Shared decoder linkage and a pngjs-generated fixture
fixed both; runs673 and677 pass both backends. All these checks have finished.

IMPORTANT INTEGRATION CHECK: after this startup gate, the unchanged entry tests
`navigator.gpu` before engine creation. `browser-erasure.ts` currently represents
that property as absent (also documented in UI), despite a Window GPU device.
Simply compiling a no-GPU fallback and returning is NOT application integration.
Model the generic native graphics capability appropriately and validate that the
intended scene is reached, rendered and interactive before declaring success.
This concrete gap is now tracked in TODO alongside image and promise readiness.

Promise cleanup now shares `compileReaction` capture/invocation and native
`Promise::then` observation/adoption. Native cleanup invokes the callback with no
arguments, normalizes its result to a promise, then restores the original value
or rethrows the original exception. Thrown/rejected cleanup replaces that
settlement. Missing/noncallable handlers pass through to a fresh promise; stored
optional callbacks are snapshotted and their presence is tested at registration.
Ordinary cleanup results are evaluated/discarded; promise results are adopted.
The shared retention analysis treats `resolve` as storing its arguments, keeping
record identity, and resolving fresh record literals uses the existing owned
struct sink. Custom thenables explicitly refuse. Record getters now allow local
statements before a final return, using a local scope and ordinary statement
emission. Early returns still refuse. All changes are generic.

`promise-finally647` is the fixed twelve-probe baseline, 0/12 generation accepted.
`promise-finally648-native` passes 10/12, exposing record resolution and getter
statements; `promise-finally649-native` passes all twelve. `promise-cleanup650`
passes the JavaScript-oracle/native fixture; `promise-cleanup651` passes all five
cleanup/reaction/cache/recursion checks. The stronger `promise-cleanup652` checks
microtask order, callback arguments, value/error identity, asynchronous cleanup,
getter locals, optional callbacks and pending cleanup cycles. The generated
program returns to its starting managed-node count. Stdout/stderr must be empty.
`regressions653` passes 908/909: the sole failure is the obsolete test asserting
getters must contain only one statement. Its updated acceptance and early-return
refusal pass `regressions654` (653 compiler/cleanup tests, no skips).
`population654` generates all 288 entries and completes scene41's native bootstrap.
Staged type/privacy/whitespace checks pass. All these checks have finished.

The previous startup refusal came from selecting main.body.statements and
emitting them at depth zero under a synchronous initialization callback. The
startup unit above fixes that boundary while preserving construction metadata.

Destructuring now takes concrete generic RHS types from evaluated bound values;
each RHS expression runs once before target references. Nested arrays, rest,
defaults and represented setters share the existing data sinks and setter body
lowerer. Array/key snapshots delay slot lookup until the store, so a default can
grow or replace an array without invalidating a retained native reference.
Reference-backed property owners also remain alive through defaults. Inferred
native arrays retain their original object entries instead of rematerializing
compile-time records: the fixed record probe checks both identity and mutation.
Literal missing/undefined/null sources retain their distinction; native nullable
storage still combines null and undefined, so defaults over combined or unknown
nullable element types explicitly refuse. This narrowed gap remains in TODO.

The fixed `assess-destructuring.mjs` baseline `destructuring639-native` passes
5/12; `destructuring640-native` passes 8/12 (record identity failed despite a
successful native build). `destructuring641-native` and the final
`destructuring646-native` pass all twelve. The permanent fixture adds lazy and
missing defaults, null preservation, literal holes, tuple defaults, array growth
and setter evaluation order. `regressions645` passes all 907 tests without skips;
after the final literal/owner extensions, `destructuring646` passes seven focused
native/array-loading/table checks. `population646` generates all 288 registered
entries and completes scene41's native bootstrap. Open GitHub issues remain empty.

The previous `compile645` diagnostic was `Promise.prototype.finally`; the cleanup
batch above now passes it. Its protocol follows the ECMAScript finally algorithm,
linked from Features, and reuses the existing managed scheduler and callbacks.

Lexical bindings captured inside their own initializer now receive a traced
`LexicalBinding<T>` cell before lowering the initializer. Ordinary typed sinks
initialize it once; early reads and reads after failed initialization throw.
The static-constant entry is removed before callback lowering, preventing module
timer reads from recursively re-evaluating the registration. Named retained
callbacks use the existing function resolver and callback-retention analysis.
The frame-only emitter is unchanged. Self-referencing record initializers still
refuse when the recursive record/function type has no owned representation.

`timer-bindings629` accepts 1/8 generation probes at baseline; both
`timer-bindings632-native` and `timer-bindings636-native` build/run all eight.
`timers635` passes the permanent native fixture plus control-flow and recursion.
It verifies early reads, an escaped binding whose initializer throws, initialized
null, per-iteration captures, nested timers and interval/mutable-handle behavior;
stdout and stderr must both be empty. `regressions636` passes all 901 checks
without skips; `population636` generates all 288 entries and completes scene41's
native bootstrap. The later named-callback extension passes `timers637` (3/3),
`initializer-captures637-native` (both named cases and awaited initialization),
and `regressions638` (715 compiler/audio/timer checks, no skips). The separate
record-initializer probe remains refused. Do not combine the four additional
initializer probes with the fixed eight-probe timer baseline.

The previous entry diagnostic `compile636` stopped at generic destructuring;
the batch above now passes that form and narrows the matching TODO.

Scheduled audio events use shared listener identity/options and the native
PlatformEventListeners registry. Started sources with listeners retain a realm
completion handler; LabSound posts only a native completion ID, and an eight-ms
realm timer pumps its event queue without requiring rendering. Automatic pulling
advances disconnected sources. Delivery occurs outside graph locks and iterators;
context close cancels delivery, and listeners can close contexts or disconnect.
Node/parameter handles and the registry's aliasing Owner now expose GC edges.
The fixture proves unstarted cycles disappear and the realm returns to its managed
allocation baseline. Direct module audio sessions remain owned until realm teardown.
The stronger native fixture also exposed/fixed mono playback selecting an in-place
bus before the queued buffer installed its channel count. Buffers can be reused
across contexts through their existing owned storage.

`audio-events622` is the fixed twelve-probe generation baseline: 0/12 accepted.
`audio-events628-native` generates/builds/runs 9/12 with stdout/stderr checked.
Remaining refusals are event payloads, onended properties and nullable buffer
assignment in the original escape probe. Independently, the permanent fixture
checks escaped listeners, nested removal, async callbacks and disconnected sources.
`audio628` passes all five focused audio checks without skips. The broad
`regressions629` run passes 895/900: five frame-only emitter regressions came from
binding nonrecursive function literals eagerly. The owner snapshot is now limited
to asynchronous realms; frame-only declaration specialization is unchanged.
`population629` generated 286/288; the same regression affected racer and
regression-timer-callback-cells. Follow-up compiler/audio and full generation
results: `regressions630` passes all 714 compiler/audio checks without skips after
that correction. `population630` generates all 288 entries and completes its
scene41 native physics bootstrap successfully.

The prior timer assessment covered callbacks in their own initializer.
`assess-timer-bindings.mjs` saves eight independent probes. `timer-bindings629`
accepts only the already-declared mutable binding (1/8 generation, native not yet
assessed); self-timeouts/intervals, helper callbacks, nested timers, returned cleanup
and microtask ordering refuse. Some module-scope forms recurse to a stack overflow;
helper forms diagnose an unknown timer variable. Reuse declaration/closure storage
and the existing timer scheduler rather than adding a special private helper path.

Direct async bodies now pass a coroutine-body mode through the shared callback
lowerer. Multiple runtime returns use the caller's native coroutine return frame,
preserving specialized arguments and return-promise/return-await catch boundaries.
The common flow-completion analysis recognizes terminating if/try branches.
Timer/microtask callbacks returning promises reuse retained function preparation.
The fixed twelve-probe control-flow baseline (`async-control615`) builds and runs
3/12; `async-control617-native` passes 11/12. Await in finally remains explicitly
refused; await in catch also receives a direct diagnostic, rather than producing
a co_await inside a native exception handler. Neither is established as reached
by the application's latest attempt.
`control618` passes four focused async fixtures. `regressions619` passes all 835
compiler/control-flow/language/callback/async/fetch/worker checks without skips.
`population620` generated all 288 registered corpus entries. `control621` passes
all four focused fixtures after the final diagnostic guards, without skips.

Async collections now reuse one callback preparation helper and typed stored
coroutines across vector/tuple mapping, predicates, forEach, reduce and Array.from.
The callback is evaluated before iteration; promise predicates remain truthy,
and tuple mapper invocations start before the following statement. Promise result
types mark object references before constructor emission, retaining settlement
identity and avoiding later aggregate uses changing an already-emitted layout.
`async-collections608` is the strong twelve-probe baseline: six generation accepts,
but only the stored mapper builds and runs correctly. `async-collections610-native`
passes all twelve. The permanent combined fixture adds getter snapshots, escaped
captures, promise result identity/mutation, allocation-form Array.from and errors.
`regressions613` passes all 817 compiler/language/callback/async/fetch/worker checks
with no skips. `collections612` passed all four focused async fixtures before
the final settlement identity assertions, which also pass in the broad run.
`population614` generated all 288 registered corpus entries for this unit.

The promise-cache baseline (`promise-caches593`) accepted 2/10 generation probes
and built/ran 1/10; `promise-caches604-native.json` builds and runs all ten.
Promises share reference identity and mutable binding cells; async reactions
own their arguments, callback expressions are snapshotted at registration, and
returns adopt wider/void results without turning adoption into an awaited return.
The permanent cache fixture tests eviction/retry, reaction getters, error captures,
rejection before suspension, and rebinding while an activation is suspended.
Specialized throwing inline paths carry explicit abrupt-completion metadata so
their async activation retains its declared result instead of becoming void.
`regressions604` passed 815/816 checks with no skips; its sole failure exposed
local Promise.all storage using the checker's tuple representation instead of
the generated tuple. After repairing storage selection, `promises606` passes all
five aggregate/cache/reaction/optional/native-promise checks. Rebinding across
different tuple representations still refuses explicitly.
`population607` generated all 288 registered corpus entries after that repair.

`assess-async-collections.mjs` retains the fixed sources. The earlier 607 draft
tuple probe checked values without concurrent-start assertions; use 608 as its
baseline. The next batch assesses direct/reaction async control flow and should
reuse the existing stored-function coroutine implementation.

The recursive-async baseline (`deferred583`) accepted 3/10 generation probes,
but only 1/10 built and ran. `deferred588-native.json` builds and runs all ten:
local/named/mutual recursion, deferred timers, void sinks, concise bodies,
record results, rejections and invocations outliving their declaration scope.
They reuse stored-function coroutine bodies with traced recursive cells.
`regressions592` passes all 665 compiler/callback/worker/loading/fetch checks;
the dedicated recursive fixture also passes. `population594` generated all 288
registered entries at that savepoint.

Validation correction: earlier async/audio fixtures closed the realm from an
error callback whose console output was erased, allowing failures to pass.
Those callbacks are removed, and default unhandled rejections now reach the
realm's error handler. The stronger audio fixture exposed a source-buffer setter
intercepted by its getter and buffer data incorrectly requiring an open context.
Both are repaired: fresh getter-path probes roll back before setter evaluation,
and owned buffer records retain their own handle identity after context close.
`audio593` passes all three context/capability/playback checks without skips,
including effectful setter receivers and channel reads after close. Earlier
audio success claims must be interpreted with this correction.

The packaged-fetch batch has 681 passing compiler/async/audio/HTTP checks without
skips (`regressions568`). Native fixtures cover response aliases, consumption,
UTF-8/JSON/binary reads, closed dynamic selection, missing-file rejection, awaited
typed-array constructors and concurrent fetch-to-audio PCM. `platform:packaged-fetch`
shares owned response bodies with HTTP without selecting its transport dependency.
`population560` generated all 288 corpus entries before this batch.

The callback-value baseline advances from 1/13 accepted generation probes
(`callbacks570.json`) to 12/13 (`callbacks572.json`); stored variadic Math functions
remain explicitly refused. The first forwarded-array-predicate TODO is closed.
Native checks cover defaults, explicit overrides, function identity through arrays
and Sets, captured/named/returned callbacks, callback replacement during iteration,
truthiness and short-circuit effects. `regressions576` passes 679/680 checks; the
sole failure was a generated-text assertion expecting a single-line tuple `some`.
After updating it, `callbacks577` passes all 654 compiler and focused checks without
skips.

`population578` generated all 288 corpus entries. The AudioBuffer assessment
(`assess-audio-buffers.mjs`) advances from 1/8 accepted to 8/8 (`audio-buffers579.json`),
covering metadata, channel copies, source ranges and buffer readback. Native fixtures
verify bounded/overlapping copies, ArrayBuffer views, channel failures, decoded
metadata, source-buffer identity and metadata after context close. All 670 selected
compiler/audio checks passed without skips (`regressions582`), subject to the
validation correction above. Deferred async activation is now implemented.

Current assessment artifacts: `requirements356.json` inventories the unchanged
entry's static local import graph (1,343 files, 1,002 unassessed API/syntax groups;
these include potentially unused code). `capabilities356.json` records 24 neutral
generation probes: two accepted, 22 refused, no native execution attempted by
that diagnostic runner. `assess-capabilities.mjs` and `capability-probes/` retain
the independent sources for reruns. They expose the five core-library clauses
and Window/retained-element event ownership, options and field gaps together.
The generic inventory tool is `tools/project-requirements.mjs`; it reuses the
compiler frontend and does not implement a second support classifier.

First batch progress: the stored Set iterator clause is implemented and removed
from TODO; its other four clauses remain open. `core365` passed all 136 selected
language/callback checks without skips. The generated native iterator fixture
checks aliasing, next/done, live deletion/clear/insertion, deferred first pull,
sticky exhaustion, fresh pair lanes, object identity, spread, mapped Array.from,
early-break resumption and lifetimes through helper returns/stored callbacks.
`capabilities358.json` records the initial probe improvement from 2/24 accepted
to 4/24 accepted; those are generation counts, not application completion.
No application retry or full corpus sweep was needed within this unit.

The iterator implementation adds a shared typed `iterator` data kind and native
cursor, reusing collection storage, callback ownership and tuple representation.
Stored iterator for-of pulls in the loop condition, preserving early break and
avoiding an unreachable native increment. The next core batch still needs
RegExp callbacks and mixed-tuple mutation/rest/resizing. The untracked
`native/include/bblite/pal_dom_events.hpp` remains an unused event design draft;
do not stage it with the core-library work or claim it is integrated.

The next completed unit adds strict scalar-union comparisons and a shared fresh
rest-array emitter for tuple declarations, parameters, loops and collection
entries. `core378` passed 140 language/callback checks with no failures or skips.
Native assertions cover scalar types, NaN, missing values, operand evaluation
order, shallow rest copies, empty tails and retained loop callbacks.
`capabilities378.json` advances the fixed baseline to 5 accepted / 19 refused.
The original stored-iterator and rest-binding TODO clauses are closed; RegExp
callbacks, dynamic mixed-tuple writes and resizing remain open. A separately
probed mixed-tuple destructuring-assignment refusal is now named in TODO.
Direct missing-property access on an unmaterialized static union dictionary is
another recorded diagnostic gap; it is not established as a reached app blocker.
The full application has not been retried during these focused core units.

RegExp replacement callbacks are also implemented through the shared inline/
stored callback path. Native RegExp aliases share state, matching uses UTF-16
code units, captures preserve missing values, and global matches are collected
before callbacks. Runtime-created/selected patterns use typed positional
arguments. `charCodeAt` now uses the existing UTF-16 decoder. `core387` passed
161 checks with no skips; `regex388` passed five focused checks including native
capture lifetimes and compiler RegExp regressions. `capabilities385.json` records
6/24 accepted generation probes. Three original core TODO clauses are closed;
dynamic mixed-tuple writes and resizing remain, along with the newly identified
destructuring-assignment gap. The next batch needs shared mutable tuple storage;
do not implement each length-changing method as a separate special case.

The mutable tuple candidate uses shared native arrays with nullable union elements,
including dynamic writes, push/pop/shift/unshift/splice, missing reads and typed
rest conversions. Length writes keep the dense-array truncation-only contract;
sparse growth is refused. `tuple406` passes all six mixed-tuple fixtures in native
execution (12 checks, no skips), including destructuring assignments, empty rests,
source evaluation order and object identity. Receiver/argument snapshots also fix
ordinary array push/unshift, spread ordering and self-spread. Simple arguments
avoid extra temporaries through the shared syntax effect query.

`core403` ran 822 checks: all native execution checks passed; 18 compiler-text
assertions failed. After limiting unnecessary temporaries and updating assertions
to verify their selected receiver, `compiler405` passes all 651 compiler checks.
`tuple-storage-candidate402.json` generated every one of 64 neutral language
fixtures before the final ordering/empty-tail checks. `capabilities401.json`
accepts all 13 core probes; 11 event probes refuse. These are probe counts, not
overall application completion. The five originally inventoried core clauses now
have implementations and native fixtures. Stored-array destructuring with nested,
defaulted or member targets remains a separate explicit TODO.

At the batch boundary `population407` generated 286/288 entries; Quake and Doom
exposed the same `Iterable` protocol incorrectly classified as a concrete record.
The registry now leaves that abstract protocol to actual-collection specialization.
`tuple408` passes 14 focused checks, including class/helper Iterable parameters
over arrays, Sets and stored entry cursors. Both `quake409` and `doom409` generate
successfully after the correction. A complete population rerun has not followed
that final correction. `compile407` still stops at the event capture-option error;
the private checkout remains unchanged. Keep the unused event draft out of the
tuple commit and continue to events. Full application generation, build and runtime
remain unpassed.

The shared input bridge now connects compiler listeners to SDL/RmlUi hit paths and
the Window application mailbox. `DomEventBatch` owns native packets; its release/acquire
completion lets the display defer defaults while continuing layout snapshots. Script
callbacks remain on the application thread. Synchronous scene/replay paths reuse the
same dispatch. Keyboard and cross-realm cancellation clauses have been removed from
the matching Window TODO; ResizeObserver entries and draw-call transport remain open.

`events430` passes 671 focused compiler/callback/UI checks without skips. The generated
RmlUi fixture covers options, removal, phase order, pointer fields, cancellation,
programmatic clicks and disabled controls. `window427` builds and runs a neutral Window
application on SDL_GPU and Dawn, checks callback order through durable storage, and
requests layout inside the callback; `window431` repeats that check successfully for the
final unit on both backends. `capabilities416` accepts 23/24 fixed generation probes; event-target
projection remains refused. This ratio is not application completion. `compile407` is
still the latest unchanged-application attempt; complete generation/build/runtime remain
unpassed. Do not run another full application after each small event-field edit.

The next unit adds document-owned target/currentTarget/relatedTarget values, nullable
storage and identity comparisons, typed Event helpers, retained-element assertions and
listener registration through guarded EventTarget aliases. Dispatch ownership is local
to the invoking realm and cleared before completed native packets return to the display.
`events441` passes 676 focused checks without skips; `window441` builds and runs the
Window fixture on both renderers. `capabilities437` accepts all 24 original generation
probes. This closes the target-projection TODO clause, not all event support.

`compile438` passed the former listener-options blocker and now refuses stylesheet
selector `button img`; the unchanged application still has not completed generation,
build or runtime. `selectors442.json` inventories literal selector candidates across the
private source; it contains shader false positives and dynamic forms, so clean the
assessment before reporting coverage. Batch selector grammar and native/static consumers
instead of adding one form followed by another full-application retry.

Next event work: AbortSignal, explicit pointer
capture (existing set/release are no-ops and hasCapture is true), coalesced events, and
shared focus/form input propagation. Focus/form callbacks still take their old path.
Compound retained text writes were found to erase silently and now refuse explicitly;
the corresponding getter/lowering is recorded in TODO. The event-batch working notes
predate the connected bridge; prefer these current notes and actual source.

Selector sequence unit: `ui-selector.ts` parses shared typed compounds and descendant,
child and sibling chains, attributes and input states. RmlUi renders the selector while
`ui_selector.hpp` matches compiled terms on its live tree for private cascade metadata,
without reparsing CSS per element. A second projection pass after tree synchronization
observes final reparenting/attributes. Static grid proofs treat conditional matches as
uncertain; unsupported chains across inserted grid containers refuse. Legacy descendant
rules no longer require a currently known matching element. `selectors449` passes 661
focused compiler/native UI checks without skips; final grid-refusal checks follow.
`selectors446.json` narrows the literal inventory to CSS-like strings: 1,122 recognized
selector spellings, 87 unrecognized and 33 dynamic/unassessed. These are syntax counts,
include unused strings and some dynamic shader fragments, and do not prove complete
lowering/native semantics. The next selector families are generated content and
functional/structural pseudo-classes. Do not retry the application between their small
edits. `compile438` remains the latest application attempt.

`selectors450` passed 653/654 checks; its only failure was adaptation wording, corrected
and passed in `selector-assertion451`. The Window selector probe then exposed a real
stale-layout read: retained getBoundingClientRect used the cached rectangle. The shared
Engine measurement hook now lets the Window owner publish edits and wait for layout,
and compiler calls capture one rectangle rather than rereading fields lazily.
`selectors454` passes all four focused checks. `selector-window454` builds and runs on
SDL_GPU and Dawn, changes an attribute-selected width inside the input callback and
checks the fresh 100px result before allowing defaults. This is stronger evidence than
the earlier positive-width check. The retained native fixture also checks snapshot
values and exactly one host measurement per source call.
`css452.json` starts a separate fixed 13-case CSS-family baseline: four chain cases
generate, nine state/structural/functional/generated-content cases refuse. Continue those
families together; do not treat this new baseline as the original 24-case probe set.

Structural selector unit: compiled terms now include nested negation lists and An+B
position tests. Negation uses the maximum alternative specificity. A reached
focus-within rule derives state from the current RmlUi focus path; that traversal is
cached by focus target and document revision. Positional/negated rules participate in
the same native cascade, and static grid refusals inspect nested terms too. A bare
descendant state such as `.panel :hover` must stay a separate compound; do not peel it
into `.panel:hover` when reusing the legacy trailing-state optimization.

`selectors459` passed 661/662 checks, including all compiler tests. The fixture's manual
focus-clear assertion incorrectly assumed RmlUi Blur leaves its parent unfocused;
the corrected test moves focus to an actual outside control. `selectors460` and the
final `selectors461` both pass all four focused tests without skips. `selector-window459`
builds/runs on both renderers and transports nested negation terms while validating
fresh layout during callbacks. `css458` accepts 10/13 generation probes; generated
content is the remaining family. No further full-application attempt has run.

Generated before/after content is implemented with a thirteenth maintained RmlUi patch
at the unchanged pin. Typed content lists contain literal strings and current attribute
reads; the PAL resolves their cascade independently from public box styles. Boxes retain
normal layout participation while selectors, queries and serialization exclude them.
Anonymous generated flex text uses the same text construction helpers, with internal
selector identity. Authored-node-only decoration/grid substitutions refuse explicitly.
CSS block/comment walks now preserve quoted braces, escapes and keyframe-looking text.

`css467` accepts all 13 fixed CSS family generation probes. `content472` passes 662
compiler/UI checks without skips, including native content/state/media/removal semantics.
`window473` builds and runs on both renderers and verifies a generated box's height change
through a layout request inside a pointer callback. The earlier Window probe failure was
an ignored-runner replacement targeting injected CSS instead of the button's inline
style; the runner now replaces the exact statement. No complete-entry retry since
`compile438` has followed this CSS batch yet.

The candidate library is `artifacts/tools/rmlui-generated-content`, built in
`.cache/rmlui-generated-content`; its 13-patch build is validated. `rmlui474` rebuilds
the standard development artifact with the same patches. Static and specialized artifact
variants still need reconciliation before their consumers run. The other task's worktree
has a separate ordinary RmlUi directory; do not modify that task's libraries or processes.
The ignored `generated-content-plan.md` is historical design context. Further patch edits
can use `save-rml-content-patch.mjs` and its saved base index; ordinary build scripts reset
candidate Git indexes while applying the maintained patches.

The next selector batch implements `:is`, `:where`, relative `:has` and color/opacity
on `::placeholder`. TS/native terms share selector alternatives; relative matching
walks forward from the owner. RmlUi caches whether a stylesheet reaches `:has` and
invalidates document definitions after relevant element-definition changes only for
such sheets. The existing text widget owns placeholder text; its pseudo identity
switches back to ordinary text when a value is present. Font/layout changes on the
placeholder refuse because widget metrics come from the control.

`selectors482` passes seven focused checks. `window483` builds/runs on both renderers,
including live `:has`/`:is` layout inside callbacks and placeholder rendering.
`selectors484` passes 661/662 checks; the only failure expected the newly supported
`:has(.icon)` to refuse. The assertion now tests invalid nested `:has` instead.
The current Rml candidate has fourteen patches (`rmlui481`); `rmlui485` reconciles
the development artifact. Static/specialized variants still require reconciliation.
Use `save-rml-selectors-patch.mjs` with its separate `selector-base-index` to edit
the fourteenth patch; do not regenerate it with the earlier content patch saver.

`selectors484.json` recognizes all 1,209 static selector spellings in the literal
candidate inventory, with 33 dynamic/unassessed entries. The separate
`css-bodies476.json` reports 861 lowered literal rule bodies, 263 with declaration
refusals and 77 dynamic/unassessed bodies. Both include unused code; the latter
removes refused declarations only in diagnostic memory to expose further groups.
These are syntax/lowering assessments, not full-rule native fidelity or application
completion percentages. Declaration groups include grid geometry, text styles,
visibility, borders and transform origins. Keep full application retries at batch
boundaries, and continue through native build/runtime and final validation.

The ambient-global unit erases `declare` statements and lets bare `typeof` observe
an unprovided ambient/unbound identifier as undefined. Symbol checks exclude imports,
actual local declarations and default-library globals. Direct reads and property
receivers retain their explicit refusal. `ambient491` passes five neutral checks,
including JavaScript/native parity and an imported fallback module. `language492`
passes all 791 language/compiler checks without skips. These checks also cover the
shared native language-fixture helper extracted for the imported-module test.

`rmlui485`, `rmlui-static493` and `rmlui-static-svg495` successfully reconciled the
development, static and static SVG artifacts with fourteen patches, using existing
explicit FreeType roots without vcpkg installation. Historical offscreen/text
artifacts should be inspected before use rather than mistaken for these artifacts.

`compile495.cpuprofile` measured 99.4 seconds of sampled generation, with about 46%
inside repeated initializer-mutation queries. The planner now collects mutation
origins once per module and reuses the result as observed storage grows. The isolated
unchanged-entry planner benchmark dropped from 50.3 to 6.6 seconds and selected the
same 164 modules in the same order (`initializer-before497` / `initializer-after497`).
`planner497` passed all 673 existing compiler/worker/transaction/analysis checks;
`planner498` passes the new alias/recursive-call/dormant-body fixture after correcting
its assumption about the separate conservative container-mutation scan.
`compile499` reaches the same refusal with 49.0 seconds sampled, down from 99.4;
the full generation checkpoint is about twice as fast. `eb79fdb1` is pushed.

The following query unit shares native selector traversal between RmlUi and retained
authored records (`ui_selector_match.hpp`). It adds runtime querySelector/querySelectorAll,
matches and closest, including Window document lookup routing, tree-order snapshots,
missing matches, helper values, detached/reparented nodes and optional/chained receivers.
Query setup materializes logical html/head/body through the existing document path.
The new native fixture rethrows application errors instead of leaving its test EventLoop
waiting after a failed assertion. Interaction snapshots, :scope/computed selectors and
dynamic innerHTML traversal remain explicit gaps. Static proven markup queries retain
their existing path; do not claim arbitrary markup query support.

`query-batch507` passes 667/669 checks, including every native fixture. Its two failures
are old expectations of class-only lowering and refusal of empty results; both assertions
now describe runtime queries while preserving the independent grid refusal. `window508`
builds and runs the input/selector/query fixture on both SDL_GPU and Dawn, checking queried
identities and snapshots inside pointer callbacks alongside fresh layout. The application
has not yet been retried after this query unit.

`declaration-batch-notes.md` records the
next CSS assessment: do not simply allow registered names. Pinned text-transform
is ASCII-only and has no capitalize implementation; italic needs actual platform
font discovery/loading. No declaration-family implementation followed those findings.
All twelve new declaration probes currently refuse (`css-declarations487.json`);
they are a separate baseline from the original thirteen CSS family probes.

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
  treated as completion. The explicit 2026-09-12 resume supersedes the earlier
  pause after a green sweep.
- Give concise progress updates, distinguish assessed/implemented/integrated
  work, and state the exact stage reached. Do not repeatedly seek permission for
  routine fixes already authorized. PR creation and pushing this branch were
  authorized; merging was not.
- Do not infer ongoing automation or credit-reset authorization. No follow-up
  automation is needed to resume this work.

## Resume on 2026-09-12

- `d30af200` restores document ownership when typed DOM handles come out of
  records, arrays, nullable fields and helper parameters. `documentEngine` in
  `compiler/window-events.ts` is shared by creation and data-handle recovery.
  Window DOM belongs to the Window document even with a rendering engine in
  scope. The 13 focused tests passed with no skips (`focused232.log`). Window
  and scene ownership run natively; the combined Window/rendering-engine case
  checks generated ownership expressions.
- `58bccd0b` supports boolean `hidden` reads/writes through retained attribute
  presence and the native default stylesheet. Author display overrides remain
  effective. The `until-found` state refuses. The two new tests and five nearby
  regressions passed without skips (`hidden233.log`, `focused233.log`). Both
  completed units are pushed to the existing draft PR.
- Attempt `compile232` moved past the saved ownership error and stopped on a
  mixed string/element `append()` call. Generic mixed append support adds retained
  text runs, shared flex text wrappers, root append handling and replacement of
  old children by content setters. Its generated C++ fixture checks argument
  evaluation, including later arguments reassigning the receiver and earlier
  element bindings; ten focused tests passed before that final review fix.
- `full237` passed all 2,562 tests with zero failures/skips. This predates the
  final argument snapshot fix. `focused238` ran 652 checks afterward: the native
  regression passed; one existing assertion expected the original variable name
  instead of the captured handle. That assertion now follows the captured value.
  `focused239` checks the corrected assertion and the native append fixture.
- `compile237` (exit 1) advanced to a two-callback `Promise.then` at
  `src/ui/crash-reporter.ts:612:10`: "This promise reaction requires one callback."
  Neither C++ generation nor the full application's native build has completed.
  The reached code also writes a button's `disabled` property, which still needs
  retained boolean-attribute support; the `hidden` unit supplies a reusable PAL.
- `cb92759f` saves the mixed append unit and is pushed. `focused239` passed all
  three selected checks. The promise unit adds shared native settlement reactions
  for two-callback `then`, explicitly refusing different result types. It also
  routes terminal throws in directly lowered async functions through native
  coroutine completion; this avoids both unreachable epilogues and missing-return
  warnings when a function awaits before throwing. The owned-body analysis skips
  nested function returns. `focused243` passed 11 tests; `promise244` additionally
  passed a generated native record-valued recovery check.
- `compile241` (exit 1) progressed to `src/ui/crash-reporter.ts:616:7`:
  "This intrinsic requires createEngine to run first." The reached expression is
  `window.setTimeout`. The timer unit now uses the existing symbol-aware
  `browserGlobalNamed` mechanism for callee selection. Qualified timers,
  cancellation, intervals and microtasks passed native execution without a scene
  engine (`focused245`, three tests); shadowed globals stay ordinary local
  functions and the Window global is refused in worker realms.
- `7fdf4ab9` saves the promise unit and is pushed. The generated promise fixture
  also compiled and ran under Clang with warnings as errors. `compile245` was
  started after the timer fix; inspect its log/exit file for the next blocker.
- Open GitHub issues were checked on 2026-09-12: none. Neither completed DOM
  unit closes a listed TODO item. The broader UI and worker gaps remain open.
- A separate neutral probe found that creating a realm rendering engine without
  starting it can omit `pal_async_engine.hpp` from generated includes. Creation
  needs a native canvas argument and an async function in a Window realm. This
  include gap was not changed or established as the external app's next blocker.
- `e30a522a` saves qualified realm timers. The disabled-control unit shares
  boolean-attribute storage and RmlUi's form-control base for HTML buttons;
  pointer activation, explicit click, focus and live attribute state are covered.
  `focused247` passed seven tests with no skips, including hidden and hover.
- `compile245` (exit 1) reached a callback returning `Promise<void> | void` at
  `src/ui/crash-reporter.ts:625:22`. Storing its result fails because its native
  signature currently discards the promise through synchronous return-type
  unwrapping. Preserve both promise and absent outcomes, including their effects;
  do not force every callback to return a promise. Full generation is pending.
- `931cd415` saves disabled controls and is pushed, including the timer commit.
  The final disabled fixture also checks focus and input/textarea state (`disabled248`).
- The optional-promise unit retains asynchronous callback return unions, models
  synchronous void as absence and evaluates optional sink producers once. Existing
  picked-mesh conversion is now available through the shared known-value sink.
  `focused252` passed 664 of 665 tests; the picked-mesh conversion fixed its one
  failure. Both that case and the new native callback fixture passed `focused253`.
  `full253` was launched afterward; inspect its exit and final totals.
- `compile251` (exit 1) progressed to `src/ui/crash-reporter.ts:543:3`, a direct
  `document.getElementById(...)? .remove()` call (without the space in source).
  DOM optional-call dispatch is the next unit. Full generation remains incomplete.
- `a6a9d124` saves optional promise results and is pushed. `full253` completed
  with 2,565 passes, one failure and zero skips. The failed nullable-string enum
  assertion needed its original asserted expression at the known-value sink;
  `focused254` passed that native case and the optional-promise fixture after
  the fix. The same run's new DOM fixture failed and was fixed separately.
- Optional DOM calls reuse `DataLowerer.optionalAccess` for absent guards,
  returned optionals and lazy argument preparation. Calls copy nullable receiver
  storage so argument effects cannot clear the receiver. The classification
  predicate recognizes ID lookups without lowering their effectful ID arguments.
  `optional-dom255` passed natively, checking these effects and repeated removal.
  Its fixture closes and rethrows application failures instead of leaving the
  test's event loop waiting after an assertion fails. Inspect `compile256` next.
- `1cee2be7` saves optional DOM calls and is pushed. `full256` passed 2,567 of
  2,568 tests with no skips; its only failure expected the old conditional
  expression spelling for class-field removal. The updated test checks the guard
  and captured handle. Optional calls now also snapshot class-field handles
  inside the present branch; `focused257` passed both the class assertion and
  native DOM fixture, including arguments that clear a nullable class field.
- `compile256` (exit 1) reached `src/core/companions.ts:218:9`: optional `setItem`
  on a nullable injected method record. This is a general stored-record method
  dispatch gap, not missing native localStorage support. The record includes an
  optional removal callback, so retain both receiver and callback absence checks.
- `a17d0872` saves the nullable class-handle fix and is pushed. PR #247 now
  describes resumed work and the latest verified limits rather than the old pause.
- The nullable record-method unit extends the shared stored-call path to optional
  records. Receiver storage and callbacks are captured before argument effects;
  missing receivers and missing optional callbacks skip arguments independently.
  `focused258` passed 17 tests, including existing storage and callback tests;
  `focused259` additionally proves a helper receiver is evaluated once.
  This unit is saved and pushed as `9594ebb8`.
- The user stopped work to restart the harness after unnecessary approval
  prompts. `compile259` and `full259` were canceled; neither is completed
  validation. After the explicit resume, `compile260` and `full260` were started
  from the clean saved tree. `full260` completed with 2,568 passes, one failure
  and zero skips. The sole failure was a stale assertion expecting a direct
  method call before the callback snapshot; the corrected assertion passes.
- `compile260` stopped on a generic nullable string inside a returned callback.
  A neutral native fixture reproduced the missing lexical type arguments.
  Returned callbacks and method records now capture the generic substitutions
  alongside their existing variable scopes. `focused264` passed the new fixture
  and both stored-call regressions (three tests, no skips), including independent
  string-enum and number/string instantiations. No listed TODO is closed by this
  unit. `compile264` is the next external attempt; inspect its exit before making
  claims about progression. Complete external generation remains pending.
- `c6482350` saves lexical generic capture and is pushed. `full265` is green:
  2,570 tests passed, zero failed or skipped. This includes the corrected stored
  call assertion and generic capture, but precedes readonly-table changes.
- `compile264` advanced to a runtime `find` on a readonly record tuple. The
  tuple unit materializes its checker-provided element type and preserves shared
  record fields that differ between null and strings. `readonly266` passed the
  native reproduction, and `focused266` passed 129 array/union/worker checks.
- `compile266` progressed to passing a guarded nullable table field into a
  string callback. The unit now preserves the stored string-tag representation
  while honoring that narrowing. Comparing a tag against an unknown string
  returns false instead of trying a throwing string-to-enum conversion.
  `readonly267` passed with native no-match, nullable-tag comparison and callback
  checks. `focused267` passed 679 compiler checks with no skips. `compile267`
  is the next attempt; inspect its exit file before reporting the outcome.
  No TODO item is fully closed by this unit.
- `0c3556fd` saves readonly-table search and string-tag comparison/narrowing;
  it is pushed. `readonly268` passed the final native fixture after a small
  comparison helper cleanup. `compile267` reached CSS `object-fit`.
- The user clarified that TODO's first "Remaining core-library forms" item came
  from this application audit and should be fully solved during the integration.
  Track its individual clauses and keep it open until all are implemented and
  tested; it is part of the task scope, not an unrelated audit.
- The object-fit unit extends pinned RmlUi's image geometry for all five modes,
  keeping layout unchanged and clipping UVs at the centered content box. The
  native fixture checks live modes, source changes, resize, display scale,
  invalid keyword validation and the explicit Canvas2D non-fill refusal.
  `fit271` passed both tests; `focused272` passed all twelve nearby UI checks.
  `compile272` failed at a root-child CSS selector of the general form `html > .class`.
  Full external generation, native build and runtime remain pending.
  Native source and image fixtures remain neutral.
- RmlUi now has ten maintained patches, with `rmlui-object-fit.patch` added to
  the pin's patch list. Development rebuilt successfully (`rml-fit270`). Static
  variants need explicit absolute FreeType roots: `artifacts/vcpkg-installed/
  shipping-demo-png/x64-windows-static` without SVG, and `shipping-demo-jpeg-png/
  x64-windows-static` with SVG, both under the compiler checkout. Runs
  `rml-fit-static273` and `rml-fit-static-svg273` both completed successfully
  using those installed roots.
  Earlier 271/272 attempts used the wrong/default root and are superseded by
  the successful 273 runs. No dependency installation was needed.
- `4d9bfcca` saves raster object fitting and is pushed. String-pattern replacement
  callbacks now share the native UTF-16 match walk with string replacements.
  Direct synchronous callbacks lower inline to retain outer-binding writes;
  stored callbacks use the existing typed invocation path. `replace277` passed
  the JavaScript/native fixture, including callback arguments, evaluation order,
  empty patterns across surrogate pairs, skipped callbacks and literal dollar
  results. `strings278` passed all 127 core-library and language-construct checks
  without skips. RegExp callback support remains open in the first TODO item.
- `20349d32` saves string-pattern callbacks and is pushed. The entry unit adds
  direct `Set.entries()` consumption through shared Map/Set pair iteration,
  spreads and `Array.from`. Pairs and destructured variables are independent;
  object references survive, and mutation of the collection stays observable.
  `entries285` passed 665 compiler/core-library checks. `set287` passed the final
  generated native checks after adding pair writes, Map locals and mapper
  receiver/value snapshots. Stored Set entry iterators are still unrepresented.
  Separate probes found existing refusals for immediate `[...set].join()` and
  rebinding a plain Set local; neither was changed by this unit.
- `99d565b4` saves direct entry iteration and is pushed. Locale comparison now
  accepts string arrays and all seven standard collation options through ICU.
  Locale matching validates every tag, preserves priority and admits only the
  relevant Unicode keys. Explicit options override extensions; invalid options
  throw and unsupported valid collations use the locale default. `locale290`
  passed native differential checks against JavaScript, including locale lists,
  optional lists, record options, punctuation/symbol distinction, option effects
  and malformed values. The first TODO no longer lists locale lists/options.
- `ec4f3fa9` saves locale lists/options and is pushed. `full291` completed with
  2,576 passes, one failure and zero skips. The failed Map erase assertion
  expected a key field instead of the new destructured local snapshot; it is
  corrected and passed `tuple299`.
- Dynamic mixed-tuple reads now select a typed lane union and preserve absence,
  including fractional, negative and out-of-range indices. The native fixture
  checks local copies, typeof narrowing, receiver/index effects and writes
  through selected object references. Typed array escapes now materialize their
  input object identity, and ownership checks use the selected union member.
  `tuple298` passed 673 of 674 nearby checks; the remaining assertion expected
  direct dereference instead of the shared optional-number conversion. Both
  corrected assertions and the final native tuple fixture passed `tuple299`.
  Dynamic tuple writes and resizing remain open; fixed-lane storage cannot
  implement those operations by pretending its layout is mutable.

- `ca1d1cdc` saves dynamic tuple reads and is pushed. `language300` passed all
  117 language checks without skips. Direct-child selectors now support
  `tag > .class` and `tag > .class.other`, with the existing interaction states.
  Their native fixture exposed a stale rendered parent after retained reparenting;
  moved nodes now detach before old ancestors are pruned and retain their identity.
  `child306` passed five focused checks and `ui307` passed all 48 UI tests with
  no skips. No whole TODO item is closed by this unit.
- `compile306` advanced beyond the child selectors to nullish coalescing over a
  reduced-motion `matchMedia` result. Full external generation remains pending.
  The existing virtual document root combines head/body, and `documentElement`
  needs a real root identity before HTML-child rules can work at runtime. Do not
  silently map HTML-child selectors to body or claim root modeling is complete.

- `c51d2405` saves child selectors and reparenting and is pushed. The media-query
  unit adds typed retained results, nullable access, live `matches`, normalized
  `media` and reduced-motion matching through the shared system preference.
  Existing zero-argument change listeners run on result transitions; richer
  events, removal and other query features remain unsupported.
- The media fixture exposed two general issues: explicitly typed mutable records
  in application realms needed the same reference storage as scene records, and
  nullish coalescing needed raw nullable field storage plus lazy fallback
  preparation. `media315` passes the native effect/lifetime checks. `focused315`
  passed 688 of 689 checks; its one failure exposed checked indexing replacing
  an absent-array default. The corrected path and nearby nullable regressions
  passed all four checks in `focused316`. No listed TODO is fully closed.
- `compile315` (exit 1) advanced to `cancelAnimationFrame` in an application
  realm. The native event loop already owns one-shot repaint callbacks and
  cancellation, but the compiler still routes RAF through the synchronous scene
  conductor. Window/worker repaint subscription also needs checking before
  exposing those APIs. Complete external generation remains pending.

- `1ef18ea1` saves typed media queries and nullable application state and is
  pushed. The RAF unit now lowers application and dedicated-worker calls through
  `EventLoop`'s existing one-shot queue and cancellation. HostServices supplies
  the owner Window's shared repaint source; each realm subscribes on its first
  request, independently of scene engine startup. Stored callback lowering keeps
  self-rearming functions and captured bindings alive instead of recursively
  inlining them. `raf319` passed the generated native scheduling/cancellation
  fixture and the existing realm event-loop tests (two checks, no skips).
  `full319` passed all 2,583 tests without failures or skips. `compile319` failed
  at a nullable string-union fallback of the form `id ?? ""`: the fallback was
  incorrectly forced into the narrower source enum. Complete generation remains
  pending. The known document-root erasure gap also remains in scope.

- `90e85ddf` saves realm RAF and is pushed. Nullable scalar `??` now joins wider
  string/scalar alternatives through shared sinks, preserving optional fallback
  absence and lazy effects. String results retain live tags changed by helpers
  after TypeScript narrowing. Sink conversion no longer recompiles the operator;
  UI string assignments and attributes share the stored-enum string bridge.
  `focused320` passed 666 compiler/core/media tests. `coalesce322` passed all 119
  language checks; its separate UI check exposed the attribute string bridge,
  subsequently fixed. `coalesce323` passed the native scalar and UI regressions
  (three checks, no skips). `compile322` (exit 1) advanced to `removeAttribute`
  on a retained image. Complete generation remains pending. Open GitHub issues
  were rechecked and remain empty; this unit closes no remaining TODO clause.

- `b5b805af` saves nullable scalar joins and UI string conversion and is pushed.
  Retained `removeAttribute` now removes image sources, classes, booleans and
  all inline style storage, with shared native boolean removal and HTML ASCII
  attribute casing. File-action metadata is cleared with its attributes;
  removing the type of an active native file input explicitly refuses.
  Optional DOM dispatch reads retained nullable storage even when the checker
  has narrowed it to null. `attributes327` passed two generated native tests,
  covering missing receivers and live image/style updates. `attributes324`
  passed the four existing hidden/disabled checks, and `file324` passed all ten
  browser-file checks. `full327` passed all 2,586 tests with zero failures or
  skips; this unit is saved and pushed as `bd9d8ddf`.
  `compile324` (exit 1) advanced to `image.style.setProperty(...)`, including a
  custom CSS property. CSS declaration methods and distinct document roots
  remain unimplemented. There is no verified file-by-file compilation matrix;
  the user requested not to spend time computing one. No TODO clause closed.

- The CSS declaration unit shares `setProperty` with field writes and exposes
  inline `getPropertyValue`/`removeProperty`. Property names are static; ASCII
  custom names retain case, with `--bbl-` reserved. Nonempty priority explicitly
  refuses. Receivers are captured before value effects. Native getters select
  the last inline declaration, preserve custom-name casing, and share a quoted/
  nested declaration walk with private style extraction. `styles329` passed the
  generated native custom-property/effect fixture and refusal check; `ui330`
  passed 702 compiler/UI checks without skips. `ui331` through `styles334`
  exposed quoted and nested declaration boundaries in pinned RmlUi. The new
  `rmlui-css-declarations.patch` preserves both quote delimiters, escaped tokens,
  comment markers in strings and nested blocks. Compiler and native declaration
  walks share the same boundaries; custom tokens bypass ordinary property
  rewrites. `styles336` passed the expanded generated native fixture and refusal
  check. `full337` passed 2,587 of 2,588 tests with zero skips; the only failure
  named the old comparison helper in a source-structure assertion. That assertion
  now follows the shared case-aware helper. `focused338` passed all 22 checks,
  including that assertion and the native CSS fixture, with zero skips. All three
  RmlUi variants rebuilt successfully with eleven maintained patches
  (`rml-css336`, `rml-css-static336`, `rml-css-static-svg337`). The earlier failed
  `rml-css335` captured a pre-existing flex patch in the new diff; the corrected
  patch excludes it and all three builds apply the complete list successfully.
  `compile329` (exit 1) advanced to boolean capture options on platform event
  listeners; the reached block also uses pointerout and Window blur listeners.
  Distinct document roots remain a known silent erasure gap and are unimplemented.
  No remaining core-library TODO clause is closed by these DOM/CSS units.

- `095eda03` saves CSS declaration methods and is pushed. The draft PR was
  updated with `pr338.json`. The following root unit makes HTML/head/body
  real retained roots with a shared `ui_document_root` API, stable identities,
  language reflection, inherited styles and nested stylesheet order. Persistent
  Rml HTML/head/body elements preserve existing raw nodes during late activation;
  Window document snapshots carry root metadata. Window realms initialize roots
  on construction. Direct body append retains its old lowering but routes to the
  real body once active; stored/helper body values are ordinary handles.
  `roots341` passed the first generated native fixture. `ui342` passed 718/723:
  three old emitted-code assertions, a missed dynamic stylesheet-order refusal,
  and Rml fragment parsing with a custom document tag. These are corrected;
  `roots344` passed 653 compiler/root/markup checks without skips.
- `rmlui-fragment-root.patch` lets Rml parse an inline fragment through its body
  XML handler when the configured document tag has no XML handler. Development
  and static Rml builds succeeded with twelve patches (`rml-roots344`,
  `rml-roots-static344`); SVG static also passed (`rml-roots-static-svg346`).
  Attached append now reparents while preserving handles, and a shared projected
  child-order helper covers same-parent moves. `roots346` passed both fixtures,
  including stylesheet reattachment and existing markup behavior.
  Root removal/reparenting and replacement of HTML's root children refuse.
  `ui347` passed all 703 compiler/UI checks, without skips. `offscreen347`
  generated, compiled shaders and built the registered `offscreen` demo with
  both renderers, exercising the actual Window document translation unit.
  Fresh full-corpus validation remains pending. No core-library TODO clause is
  closed by this unit; open GitHub issues were checked again and remain empty.
- `compile342` (exit 1) still reports platform event capture options. The reached
  callbacks additionally read `pointerType` and test `relatedTarget` against null.
  Model capture ordering and pointer boundary events, not just the option syntax.
  Native UI callbacks currently stop Rml propagation; Window UI events cross a
  mailbox independently. Window/document mouse registration also currently uses
  the scene engine callback channels. These ownership/order constraints must be
  addressed when implementing the event unit.

- `1aac258b` saves the document-root unit and is pushed. `population347` generated
  286 of 287 registered entries; `sandblox` stopped on an optional DOM query
  followed by `forEach`. The following regression unit uses `optionalAccess`
  for container-method continuations, including calls without another `?.` in
  the same chain. It replaces the separate optional array-search and Set-delete
  guards. Call receivers are owned mutable snapshots, preserving Set mutations
  when argument effects clear or replace the original map entry.
- `chain351` passed the new JavaScript/native assertions for container chains
  and Set deletion, without skips. The original extended UI fixture also
  exposed a silently erased write to a nullable DOM field through a named
  class instance; that write now uses `emitOptionalResourceAssignment` before
  browser erasure, as assignments inside class methods already did.
- After the query fix, `sandblox348` reached dynamic removal of a known style
  sheet. Fixed-grid validation now checks the cascades with each such sheet
  present and absent, keeping rules from one sheet together. It continues to
  refuse unknown sheet ordering/contents and fractional-grid removal. Neutral
  fixtures prove native grid-wrapper removal preserves child identities and
  refuse removal of a geometry override that exposes an invalid grid.
- `sandblox351` generated successfully. Its first native build exposed an old
  attribute-removal typo: object-URL presence must test `slot`, not `value`.
  Both the retained attribute code and Window snapshot guard are corrected.
  `sandblox-build354` built the registered demo with both renderers.
  `regression352` passed 665/666 checks; its sole fixture-member typo and a
  subsequently exposed named-instance write were corrected. `regression354`
  passed all 15 selected checks with no skips. `file354` passed 10/11: the
  remaining source assertion searched only 300 characters into UI removal,
  before the new root checks. It now inspects the complete function with the
  existing shared fixture helper. `regression355` passed all 52 selected checks
  with no skips, including the corrected file assertion and root-aware native
  style-revision fixture. `population354` generated 287/288 entries: `quake`
  exposed a nullable string predicate requiring JavaScript truthiness even when
  the checker reports boolean. Shared array predicates now inspect the lowered
  result kind. `chain355` passed the expanded JavaScript/native checks and
  `quake355` generated successfully. `full354` exited without complete totals
  while competing with population generation; it is not completed validation.
  Run the next full suite separately with `--test-concurrency=4`. The sweep
  remains pending. No first-TODO clause closed.
- Event support is still pending: no event implementation edits were made in
  this resume. The inspected pin's Rml `Context::UpdateHoverChain` emits
  mouseover/out on changed ancestor sets, without DOM relatedTarget data; it
  cannot be forwarded naively as one browser pointer boundary event. A proposed
  next unit is a document-owned pointer dispatcher with target paths and
  capture/type-aware listener identity, transporting one complete event packet
  to the Window application thread. Preserve the existing event-loop callback
  cleanup checkpoints and callback ownership. Window mouse listeners must not
  require a scene engine. Separate source pointer and mouse event types, and
  use actual hit transitions for pointerout with null when leaving the window.
  `pointerType`, `relatedTarget` and Window blur remain required by reached code.
  Existing retained pointer-capture calls are no-ops and need care if this new
  dispatcher changes their current Rml routing. Do not claim the event unit
  implemented or complete based on this design note.

The refreshed harness explicitly reports `danger-full-access`, networking
enabled and approval policy `never`. Do not pass `sandbox_permissions` or ask
for confirmation for the already authorized implementation, tests, unit commits
and pushes. Git index refresh and remote access were verified directly after
the restart. The prior workspace-write restriction is historical and must not
be carried forward as current policy. Always use the actual session permissions.

The earlier restricted account needed `git -c safe.directory=C:/Dev/babylonlite`
and could not use the user-installed npm launcher. Direct
`node tools/build-if-stale.mjs` and `dist` entry points remain reliable. Git helper
scripts can use process-local `GIT_CONFIG_COUNT=1`,
`GIT_CONFIG_KEY_0=safe.directory`, `GIT_CONFIG_VALUE_0=C:/Dev/babylonlite`;
do not change global trust settings. Keep the CMake fallback below.

## Verified result at the earlier pause

The definitive results at the earlier pause are the `227` logs. They precede the
resumed code changes and do not validate the current working tree.

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

## Earlier external-app blocker and the first investigation

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
includes RegExp replacement callbacks,
stored `Set.entries()` iterators, dynamic mixed-tuple writes, rest bindings and length-changing
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

## Current regression and audio batch

`population511` generated 286/288 entries. Freeciv reached a constant-null hover
guard after pointerleave became supported; synchronous boolean values now retain
the same literal facts as asynchronous values. Antigravity Racer passed a fresh
callback into a helper; argument lowering now keeps closure ownership and stores
repeated callbacks with runtime identity using the helper's formal signature.
`freeciv516` and `antigravity517` are diagnostic generation successes.

The native callback factory fixture also exposed concise cleanup callbacks whose
removeEventListener call took an old no-op expression path. Listener expressions
now use the existing statement implementation; unrepresented removal families
refuse. `callbacks521` passes 26 focused checks without skips, including repeated
creation, duplicate registration and removal. `regressions522` passes 795 checks.
`population522` generated 286/288: Freeciv and Antigravity Racer pass, while Doom
exposed arrow properties materialized with the record as their receiver and Racer
exposed capture-listener removal. Arrow properties now keep their lexical owner;
got/lostpointercapture listeners share DOM registration/removal (actual pointer
capture remains the separate TODO). `callbacks526` passes 667 checks and
`lexical526` passes all six JavaScript/native checks. `doom526` and `racer526`
complete real CLI generation. A full population rerun after these corrections
still needs to complete.

The next fixed audio baseline is `audio519.json`: 12 neutral probes, two generation
successes and ten refusals. It separates direct context construction/ownership,
lifecycle promises, output capability detection, ended listeners and stream
graphs. Existing parameter scheduling and context properties already generate.
The inventory includes unused audio code; a refused probe alone does not establish
application reach. Preserve the original probe set and track asynchronous-realm
probes separately. Full application generation, native build and runtime remain
unpassed. Open GitHub issues were empty at this batch boundary.

Audio lifecycle unit: direct no-options construction uses the existing AudioSession
factory. The synthetic session binding is registered before nested emission, so
first creation inside a coroutine captures its entry owner. Context handles retain
small shared state after device teardown; close freezes the clock and keeps sample
rate/state readable through aliases. Resume/suspend/close return realm promises,
settled by a task after device transitions; repeated closed transitions reject.
Native starts running and has no autoplay permission gate. Constructor options,
statechange, DOMException identity and post-close node operations remain outside
this unit. Optional setSinkId detection reports absence on instances/prototype;
unguarded calls refuse.

`audio531` passes all 24 audio/promise checks without skips. The new native fixture
checks ownership through helpers/arrays/awaits, deferred reactions, suspended and
closed clocks, rejected closed transitions and session/device cleanup. The original
fixed probes improve from 2/12 to 6/12 (`audio528.json`); lifecycle requires an async
realm. Separate direct-context realm probes accept 9/12 (`audio-realm533.json`),
leaving ended listeners and stream graphs. Early realm diagnostics 530/531 used
an invalid top-level await and then exposed the AudioEngine promise result gap;
do not present them as native AudioContext failures. `population527` is green for
all 288 scenes (286 regenerated, two current); it validates the callback savepoint
before the audio unit. The application still has never completed generation/build/runtime.

Recording capability guards: optional stream factories and media-element audio
sources now report absence on native contexts/prototype aliases, with the same
table preserving named refusals for unguarded calls. MediaRecorder reports absence
through bare/window/globalThis typeof; the default-library check preserves lexical
shadows. This selects authored unavailable-recording fallbacks, not recording
support. `audio534` passes the native receiver-evaluation guard check. The new
static `typeof535.json` inventory records 217 groups/456 checks in external source,
including scalar checks and unused bodies; it is not a support denominator.

The async-loading candidate covers direct async IIFEs, owned Promise.all tuples and
stored promise arrays, and awaited assignments into nullable locals, stored fields,
dictionaries and indexed arrays. Shared assignment-target analysis now recognizes
destructuring writes when selecting module, array and closure storage. Direct async
activations and both Promise.then callbacks share mutable outer bindings. A function
that only throws keeps its declared promise result type. Different recovery result
representations refuse instead of producing invalid C++.

Native fixtures cover start/effect order, ordered/mixed/empty results, rejection and
recovery, outer reads after completion, dictionary rebinding during key evaluation,
typed-array conversion and AudioBuffer ownership. `regressions556` ran 825 checks:
824 passed and one legacy promised-asset assignment regressed. That pre-render path
carries composition metadata and has been restored; `regressions557` passes all 657
compiler and focused async/audio/promise checks without skips.
`async559` passes all five focused checks after explicit tuple/string result ownership.
`compile556` reaches packaged fetch response ownership next. The original ten
async probes are generation-only; one recovery probe previously accepted invalid
C++ and now explicitly refuses. Do not report acceptance as native proof.
The full application has never completed generation, native build or execution.

## Artifact guide and pitfalls

| Local artifact | Purpose / caution |
| --- | --- |
| `compile222.log` | Historical external-app blocker before the resume |
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
3. Retry the unchanged external source and reproduce the current generation
   blocker with a small neutral fixture. Keep generic handling and explicit
   refusals; do not simply erase the reached operation.
4. Implement and validate one coherent unit, inspect overlapping TODOs/issues,
   and commit it. Reuse existing native UI and typed compiler mechanisms.
5. Continue through generation, native build, rendering and actual application
   behavior. Do not call the application compiled at a generation-only milestone.
6. Before claiming the broader integration complete, finish the required whole
   diff review, current tests/sweep, saved-baseline comparison and relevant
   interaction checks on both backends. Keep PR claims proportional to evidence.

After the explicit resume, steps 3–6 are active work. The earlier green sweep
does not validate changes made since that checkpoint.
