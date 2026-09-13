# Restart handoff

Session handoff requested by the user on 2026-09-11. This document records the
state and reasoning needed by a replacement agent; canonical support contracts
remain in the documentation linked below. Local artifact paths are relative to
the repository unless an absolute path is given. Ignored artifacts and installed
dependencies will not be present in a fresh clone.

## Read this first

**Current unit: dynamic module record assignment.** Native query support is
implemented and validated. quality1008-build uses the real Clang Window/UI PAL;
quality1008-native passes all six URL/preference branches against JavaScript and
the actual no-bridge desktop callback. query1008-regressions passes 698/698 with
no skips. Public search-params tests compare all UTF-16 units for 88 query/key
combinations, including malformed percent/UTF-8, duplicate keys, absent/empty
values and surrogate replacement. They retain alias identity and single argument
evaluation; fixed-query has now respects its optional value filter as well.

Native SearchParams is an opaque retained data type, with ordered parsed entries
and get/has reads; unsupported dynamic methods explicitly refuse. The browser
evaluator no longer treats an unknown constructor input as an empty query. A
separate embedded-NUL literal truncation surfaced when encoding the test oracle;
TODO.md records it, and the query comparison validates complete code units without
depending on that broken literal boundary. Clang binding fix is `b682d985`.

probe-setting1009.mjs reproduces the next application failure in about five
seconds, preserving workers, the unchanged configuration loader, public assets
and the unchanged sound-settings setter. It fails in emitLocalDataAssignment:
represented JSON assigned to a previously declared typed module record. Use this
probe and neutral alias/rebinding fixtures before another full-entry retry.
The application has not fully generated, built or run. Continue without asking.

**Completed unit: runtime query parameters.** Promise unit `3d1d126a` is committed
and pushed. Full compile998 advanced to the sound-effects configuration setter:
JSON-backed data assigned to a previously typed module record (78.25 seconds).
That is the next full-entry blocker and overlaps the first dynamic-value TODO.
The immediate private helper probe builds after applying maybe_unused to typed
declarations (quality1000-build, Clang and real Window/UI PAL). All 666 checks in
unused1001-regressions pass. Its native execution exposes a separate behavioral
bug: URLSearchParams silently treats a non-static constructor argument as empty.
quality1000-native reports the wrong recommendation for an explicit URL choice;
it does not pass. Implement native runtime query parsing and preserve generation
folding only for genuinely known strings. The six-case JavaScript comparison
in check-quality996.mjs must pass before declaring this helper validated.

**Completed unit: generic optional promise results.** Coroutine unit `8dba6d4b`
is committed/pushed. The branch already includes main's Linux and macOS PRs.
The application is still incomplete; continue without asking to continue.
The current uncommitted change preserves T substitutions through nullable unions,
widens promise result storage with identity-preserving native views, and keeps
promise metadata on annotated variables. Direct awaited conditions/data reads
retain the await; specialized undefined async results remain undefined.
Promise views register observations directly on the original state, retaining
identity, rejection handling and microtask order without an adoption job. Tests
also cover suspended observation, live roots and unreachable view cycles.

promise994-focused passes 5 native checks. promise995-regressions passes 969/969
without skips in 171.3 seconds. quality994 generates the unchanged startup helper
with its real desktop callback in 0.45 seconds. check-quality996.mjs compares six
URL/stored-preference branches to JavaScript plus the real no-bridge desktop
callback. Generation succeeds in 0.57 seconds. Its bare MSVC runner omitted UI
feature flags and therefore cannot build this Window-realm probe: use the real
scene build, not substitute Window services. quality997-build is currently
processing artifacts/external-integration/quality996/quality-probe.ts through
the ordinary scene CLI, with CMAKE_COMMAND set to the documented VS fallback.
This rebuilt the SDL overlay affected by the platform rebase, then used the
full Window/UI/storage PAL. Clang compilation exposes an unrelated generated
unused module-record local (-Werror,-Wunused-variable) that needs the ordinary
maybe_unused declaration policy. Generated output is generated/quality-probe;
native/build-quality-probe-release is the native build directory.
Full compile998 is in progress after the green compiler/worker regressions.
Promise TODOs about constructor adoption, race unions and aggregation are still
open; optional storage does not complete those broader requirements.

**Completed unit: coroutine dynamic returns.** Precision unit `652d3fc0` is
committed/pushed. Full compile970 still stopped at the same loader return after
67.27 seconds: the application contains workers, so usesWorkers selects native
coroutines; prior isolated loader probes used immediate async lowering. Always
match the real realm mode in follow-up probes. probe-async971.mjs adds a neutral
worker and reproduces the exact AsyncLowerer.compileReturn failure in 3 seconds.

The working change shares represented-return detection with coroutine bodies,
transactionally retries their result storage, and carries coroutineResult on the
void generation payload so AsyncLowerer uses the actual result representation.
Promise adoption shares the same result conversion callback. async973 generates
the unchanged worker-enabled loader. async975-focused passes 6 native/metadata
checks; async976-regressions passes 63 coroutine/promise/closure/dynamic checks.
The neutral native test covers suspension, promise adoption, default identity,
shared writes and single evaluation. This unit is committed as `8dba6d4b`.

check-async977.mjs compares COMPLETE loader output/defaults against JavaScript
with native coroutines and actual packaged configuration (generation 3.76s).
It copies manifest assets to async977/ and emits check.cpp. Native build/run is
GREEN: check-generated-native.mjs async977/check.cpp --pal --workers
--asset-support --large-stack. The runner extracts the actual asset_path helper
from engine-lowerer.ts, links real PAL file reads/SDL, and uses isolated storage.
async977-native passes the complete output/defaults comparison in coroutine mode.
Broad async978 regressions are GREEN: 954/954 without skips in 164.9 seconds.
Full compile979 advanced past the loader and stopped after 76.25 seconds at the
next startup call: generic quality-recommendation helper with an unrepresented
early-return type. requestAutomaticQualityRecommendation<T> is in core/quality.ts
around line 251 in the ignored external checkout. Isolate it next with the real
worker realm and callback return shape. The full application is still incomplete.
PR #247 metadata was last refreshed through pr970.json and remains draft/main.

**Current unit: numeric precision at dynamic storage.** Receiver unit `80431171`
is committed/pushed. async966 captures the complete failing native loader output;
diagnose-async966.mjs finds 114 differences, ALL exactly Math.fround(expected).
Fetched numbers carry the original static double but their initial C++ spelling
uses float literals. Dynamic tuple views sent that spelling directly into JSON
storage. valueJson now uses the existing castNumber(value, "double") sink rule;
ordinary float-target policies remain unchanged. numbers967-before reproduces
the issue with fractional/large fetched numbers; numbers968 checks dynamic JSON,
storage and packaged-fetch regressions. check-async969.mjs regenerates the actual
loader/full-JavaScript comparison; native verification is in progress with
check-generated-native.mjs --large-stack. This runner option only sets an 8 MiB
reserve for the large unoptimized fixture and reports exit status on failure.
numbers968-regressions is GREEN: 32/32 without skips. async969-native is GREEN:
the unchanged async loader's complete output matches JavaScript on its actual
public configuration, and original defaults remain unchanged (generation 4.18s).
Next full entry retry follows this precision commit.

**Latest unit: temporary array receivers.** Return-storage unit `ff68a671`
is committed/pushed. Native pop/shift now accept temporary retained-array wrappers
and delegate to the ordinary lvalue operations. pop962-before reproduces both
MSVC receiver failures; pop963-regressions passes 39/39 native/core/dynamic checks.
The actual async loader builds, but its unoptimized isolated fixture exceeded
Windows' default 1 MiB stack (async964 exit 0xc00000fd). Setting the generated EXE
reserve to 8 MiB with editbin allowed execution and exposed a COMPLETE-output
mismatch against JavaScript. This is the next diagnostic; do not claim the loader
is validated. Native product MINSIZE builds already use an 8 MiB reserve; the
isolated runner needs an explicit option for this large debug fixture.

**Current unit: native dynamic return storage.** Interpolation unit `42269d47`
is committed/pushed. Full `compile948` stopped after 69.21 seconds at the
asynchronous configuration loader returning an open JSON dictionary into its
declared fixed record. The application still has not completed generation/build/run.
The actual path is the immediate native value lambda, not a realm coroutine.
probe-async952.mjs isolates the unchanged loader with its actual public directory
and http://localhost deployment base; async952 reproduces in 2.81 seconds.
The working change transactionally emits record-returning value lambdas and
retries with JSON storage when a returned value is already JSON or a JSON
dictionary. It preserves the original dynamic graph rather than projecting it
into copied record fields. `async953` generates in 4.29 seconds. The neutral
dynamic-returns test checks success/default/catch returns, aliases and effects.
`returns958-focused` passes the native regression. `returns959-regressions`
passes 945/945 checks without skips in 170.6 seconds. A follow-up stops emitting
unreachable statements after specialized returns in try/catch, matching the
existing finally-body rule; returns961 covers this and literal-null fallbacks.
Reference-record promotion now happens INSIDE the emission transaction so a
declined typed return does not change prior record declarations. Pre-existing
unowned typed record boxing remains refused and belongs to the first TODO.

Actual-loader CPP async949.cpp generates but async954-native exposed an rvalue
Array.pop receiver from string.split. Next unit handles pop/shift receivers.
check-async960.mjs now runs the unchanged async loader against the actual public
configuration in JavaScript and generates a COMPLETE native output/defaults
comparison in async960.cpp (4.35 seconds). Native verification waits for that
receiver fix. `returns961-regressions` passes all 33 async/recursive/transaction
checks without skips, including literal-null fallback and catch return flow.
This return unit is ready to commit.

**Latest unit: dynamic string interpolation.** Find unit `ceb4a1b4` is committed
and pushed. `input943-native` now builds/runs all six unchanged input-normalization
cases with actual locale/storage PAL services and isolated preferences.
Full `compile944` advanced to the music-manifest parser's diagnostic interpolation
and refused a JSON value in stringConcatPart after 50.63 seconds. The working fix
uses JsonValue.to_string() at template/concatenation conversion, preserving scalar,
array and ordinary object forms. `concat945-focused` passes its native regression;
`concat947-regressions` passes all 36 core-library/dynamic-value checks without skips.

The unchanged parser is isolated by probe-manifest945.mjs (generation 0.47 seconds).
check-manifest946.mjs executes the unchanged JavaScript module as the reference,
creates ten neutral valid/invalid manifests, and generates a native comparison.
`manifest946-native` passes all ten COMPLETE serialized-output/error-message cases.
Build it through check-generated-native.mjs artifacts/external-integration/manifest946/check.cpp.
No private sources or fixtures are tracked. Next full retry follows this commit.
PR #247 metadata was refreshed with pr944.json; it is still a draft against main.
The full application has not yet completed generation/build/run, and final sweep
and full branch review are still pending. Broad string933 remains 940/940 green;
subsequent string937 passed 666 and find940/concat947 passed 35/36 focused checks.

**Current unit: Array.find result storage.** String unit `22193c6a` is committed
and pushed. compileArrayFind now passes the selected source element through the
normal known-value sink for its result type. This converts a widened string-table
element to the declared nullable enum and retains reference-record aliases.
`find938-before` reproduces the C++ assignment failure in a neutral readonly tuple
test. `find939-focused` passes both JavaScript and native assertions after the fix,
including retained record identity/writes. `find940-regressions` passes 35/35
core-library and recursive JSON checks without skips.

The unchanged input-module probe now compiles as C++; its remaining standalone
link dependencies are real locale/storage PAL services. check-generated-native.mjs
accepts --pal to link pal.cpp, pal_storage.cpp and pal_build_stamp.cpp with SDL3,
using a generated probe digest header and isolated BBLITE_LOCAL_STORAGE_ROOT.
input941 lacked the build stamp function; input942 lacked its generated include;
input943-native is the current attempt with the complete fixture link setup.
Do not change CPP/PAL inputs while it runs. This is a real-service probe, not a
substitute implementation of the application module. Next rerun the full entry.

**Current follow-up: guarded string methods and constant captures.** Optional unit
`24b2c67f` is committed/pushed. Full `compile931` stopped in 12.63 seconds at a
guarded toLowerCase on a JSON parameter (input-binding normalization), earlier than
the previous config blocker. Removing scalar coercion from narrowOptional was
correct for assertions but methods need their own checked string receiver.
compileKnownDataMethod now adapts a represented JSON receiver when its checked TS
type is string/enum using the existing throwing string_value(), then shares ordinary
string-method lowering. The public test verifies guarded values and wrong-type
assertions; string932-focused passes. string933-regressions is GREEN: 940/940,
no skips, 170 seconds (it includes all optional corrections).

The isolated input module generates but its native build exposed a separate shared
predicate referencing a main-local string constant. comparableOperand now emits a
known static string literal (excluding parameter bindings) so a shared namespace
function does not refer to caller storage. Native public tests cover constant and
mutable captures; string936-focused passes both string cases. string937-regressions
passes all 666 compiler/module/shared-function/dynamic-value checks without skips.

Next native blocker: input936-native reports assignment of a stored string array
element into Nullable<Enum> inside Array.find. compileArrayFind chooses a narrowed
checker result type but copies source[index] without the shared sink conversion.
Reproduce with a readonly literal tuple searched by a runtime predicate and use the
normal retained value sink for the selected result. The isolated unchanged-module
probe is probe-input933.mjs. It compares nullable string results by serialization
because null-only native optional-to-JSON boxing is not yet supported; the source
module itself is unchanged. check-generated-native.mjs accepts any generated CPP
path and builds/runs it with /bigobj and the local native fixture tools.
Do not claim this input module runs yet. No full retry after compile931 yet.
PR #247 metadata was refreshed successfully using pr931.json (before this string fix).

**Loader milestone: unchanged configuration loader builds and runs.** Copy unit
`d9b1f389` is committed/pushed. The working optional unit preserves undefined-only
metadata for checker unions, allows optional comparisons/sinks to reuse matching
inner storage without dereferencing absent values, and serializes the actual
represented value. Native dynamic object/dictionary serialization omits undefined
properties while Object.hasOwn retains their presence.
`optional925-focused` passed three native/refusal checks. Broad optional926 ran
933 checks (925 pass, eight failures including parent/subtest counts): six generation
failures shared the optional-comparison metadata mismatch; string-indexing's native
failure came from dereferencing a missing optional while adapting its metadata.
`optional928-focused` passed the first six after the comparison correction, and
`optional929-focused` passes all four final native/refusal checks after the sink fix.
The two remaining typed-value cohort forms still refuse (`typed-values930`, 6/8):
optional records need owned/presence storage and class arrays need earlier demand.
Do not mark those TODO items complete.

`merge924-native` built and ran the unchanged loader with actual defaults.
`reference-loader926.mjs` uses Node's registerHooks and TypeScript transpilation
to execute the unchanged JS modules. Seven cases cover defaults, valid/invalid
pixel budgets, invalid boolean settings and companion-distance corrections.
`check-loader926.mjs` compares COMPLETE serialized native output with those JS
results and checks the live defaults remain unchanged after EVERY call.
`loader927-native` passes all seven. The defaults view uses the generic retained
unknown-value boundary because direct native enum-map serialization is not supported;
it observes the original defaults and does not serialize/reparse them into inputs.
Actual JSON and private source stay in ignored artifacts. Do not track them.
Next retry the full entry (last previous compile900), then isolate its next blocker.
Final whole-branch validation and scene sweep remain pending.

**Latest unit: typed branches copied from dynamic values.** `72a1fe73` is committed
and pushed. hasDynamicObjectSpread is shared between expression and declaration
lowering: runtime JSON-rooted sources and unknown/any spreads choose fresh dynamic
dictionary storage even when the inferred result has a static record type.
Inferred mutable declarations bypass the typed struct-spread initializer only for
that fresh dynamic spread. Dictionary assignment discovery also consults represented
locals, so writes use Map.set rather than assigning a temporary JSON lookup.
Dictionary `size` reads/writes are ordinary properties (the Map/Set collection size
branch now excludes source dictionaries). Native regression checks a typed branch
copy and direct JSON.parse spread. spread922-focused and spread923-regressions pass
(48 focused checks, no skips).

The unchanged loader now reaches its sanitizer's `number | undefined` result,
which cannot be boxed because native optional storage lacks undefined-only metadata
(`merge921-loader`, line 2834). Existing DataType.optional.undefinedOnly supports
safe boxing but is currently assigned only by tuple storage. Next preserve known
undefined-only absence from checker unions, without treating null/undefined unions
as distinguishable storage. Do not weaken the existing ambiguous-absence refusal.
No full-entry retry since compile900; use probe-merge900.mjs.

**Latest unit: erased generic return values.** Spread unit `8530ab83` is committed
and pushed. Generic return analysis now detects unknown/dictionary return sources
under assertions and conditional arms when the declared result is T. That return
and matching T parameters use JsonValue; ordinary generic identity signatures
remain typed. Removed scalar coercion from narrowOptional's JSON arm: an assertion
or inferred annotation must not change runtime kind before a real scalar operation.
Strict dynamic/native object comparisons retain the other object's existing view.
Native merge coverage now checks typed input, fresh changed branches, shared untouched
branches, later mutations and a scalar whose runtime kind differs from asserted T.
`merge917-focused` passes. `merge918-regressions` passed 937/938; the sole failure
caught changed reference-dictionary property fallback evaluation in the preceding
spread unit. Preserve the property's optional lookup representation in mapPropertyValue
(the indexed path has its existing nullableType policy). `merge919-focused` passes
all five affected checks after that correction. `typed-validator919-native` confirms
the actual-default validator still builds and executes after removing JSON coercion.

`merge918-loader` now passes the generic merge and refuses the next unchanged source
operation: a fresh copy of a statically typed branch whose represented owner is JSON.
The mutable object declaration chooses emitSpreadStructDeclaration from its inferred
TypeScript shape. Next route fresh literals with runtime JSON-rooted spreads to the
dynamic dictionary path, including inferred mutable declarations. Do not implicitly
convert/copy a JSON value into native typed record storage. Probe unchanged loader
with probe-merge900.mjs; no full-entry retry since compile900 yet.

**Latest unit: shallow dynamic object spread.** Generic-signature unit `1bbd416f`
is committed and pushed. The working spread unit adds explicit JSON spread into
fresh Map<string,JsonValue> storage, with retained children, numeric-key ordering,
nullish omission and overwrite semantics. Expression lowering chooses this storage
only for a fresh literal with a dynamic spread; it does not globally turn unknown
parameters into dictionaries or implicitly copy JSON into typed records.
Native JsonValue numeric/property reads now handle object numeric keys and
array/string own properties. Dictionary JSON reads collapse missing lookup storage
into JsonValue undefined, and the comparison dispatcher recognizes those reads.
`spread911-focused` passes the native merge/spread/alias/effects regression;
`spread912-regressions` passes all 48 focused checks without skips.
`probe-dynamic-merge905.mjs` now admits erased input. Typed input still refuses
unowned-record return storage; scalar input cannot sink the dictionary return into
number. Next assess an explicitly dynamic representation for generic T returns
whose source expressions erase to unknown/dictionaries, with matching T parameters.
Keep ordinary generic identity helpers typed, and preserve original record aliases.
The unchanged loader remains unproven; last full-entry attempt is compile900.

**Current uncommitted unit: synchronous generic recursive returns.** Performance
unit `df203a23` is committed/pushed. NativeReturnTsType now unwraps only actual
promise layers with the checker's getPromisedTypeOfPromise; it leaves T available
for the active call substitution. Recursive specialization keys now include that
generic environment (otherwise a later array call reused an earlier number
signature). `generic903-focused` passes scalar/string, shared array and already
owned record returns, plus an explicit refusal for unowned record aliases.
The first neutral record test exposed a copy that lost source identity; do NOT
claim unowned record promotion is solved. It is now refused rather than silently
copied and is recorded in TODO.md along with the remaining dynamic-value gaps.
`generic904-regressions` finished 936/937 (including async/promise checks).
`generic905-focused` passes all 7 focused checks after the object-search correction,
including generic unknown-return identity. Dynamic JSON type mapping now resolves
the active type parameter just like the regular mapper. No commit yet for this unit.

The broad run's sole failure: array object-member lookup changed from
the normal retained sink to a checked indexed read when enum queries reused
compileValue for every element type. That would throw for an out-of-bounds search
needle. The working source now limits enum query conversion to enum elements and
keeps compileForSink for the others; a native regression checks present/missing
record needles. Those edits are now built and validated by generic905-focused.

`probe-dynamic-merge905.mjs` separates three neutral merge forms. The explicitly
unknown version now reaches an object-spread refusal: openRecordLiteral tries to
sink a JsonValue into a native dictionary. Typed input refuses the unowned record
alias boundary; scalar input also reaches the structurally unreachable spread.
Next implement explicit shallow JSON object spread into a dynamic-value dictionary
in openRecordLiteral (never add implicit JSON-to-map copying). Preserve fresh root
identity, shared nested values, enumeration order, nullish spread behavior and
overwrite ordering. Then rerun the erased merge before addressing typed returns.

Next design to assess: the generic merge explicitly returns unknown/unknown-valued
dictionary expressions asserted as T. A native JSON representation for such an
erased generic return, and its T-valued recursive parameters, could preserve its
object graph. Ordinary typed returns still use their native representation.
This is a proposal, not implemented. Map/object spreads and downstream typed
storage must preserve identity and shallow-copy semantics. Do not bypass the
failure by copying fields or changing the private module. The runtime supports
observing typed array views, not general mutable erased typed storage.

The isolated unchanged loader now passes generic return-type resolution and
refuses a JSON value returning into its typed configuration-record sink:
`merge901.log` at the generic merge's early return. This is a dynamic-to-typed
record boundary, not another Awaited<T> problem. Preserve aliases of untouched
default branches and fresh identity of copied merge branches; neither serializing
the defaults nor blindly copying typed fields is sufficient. The full entry has
not been retried after `compile900`; keep using `probe-merge900.mjs` while resolving
the typed boundary. Native actual-default validator passes at `typed-validator896`.

**Registry lookup performance:** query unit `bce4f7a6` is committed/pushed and
PR #247 metadata is updated (verified body includes `32cab018`). `compile898`
passed the typed validator and refused a generic recursive return in the
configuration loader after 220.4 seconds. Its profile attributed 69.5 seconds of
snapshot self time to `structFields`, which scanned every registered type.
Direct transactional name indexes for structs/enums remove those scans while
retaining the existing definition objects and ordered emission. The actual typed
validator's C++ SHA-256 is unchanged (`typed-validator899-before-hash`), and
`registry899-focused` passes 17/17 transaction/native checks. `compile900` reaches
the SAME refusal in 68.5 seconds (3.2x faster); both profiles are saved locally.
Full population neutrality still belongs to the final branch validation.

`probe-merge900.mjs` isolates the new unchanged loader refusal in about two
seconds. `diagnose-merge900.mjs` shows its declared generic return `T` reaches
mapping as `Awaited<T>`: nativeReturnTsType applies getAwaitedType even to a
synchronous unconstrained type parameter. Fix the shared return-type unwrapping
and cover generic recursive scalar/record/array returns before retrying the
isolated loader. The application still has not completed full generation/build/run.

**Typed validator runtime now passes.** Array/tuple unit `bf246cae` is committed
and pushed after staged type/privacy checks. The generic enum-query follow-up
shares a nonthrowing enum lookup with the strict storage parser. Set.has/delete,
Map.has/get/delete and array includes/indexOf/lastIndexOf now pass missing literal
domains through existing Nullable-key mechanisms. The neutral core-library test
also checks argument effects. `queries896-focused` passes; `typed-validator896`
generates in 2.21 seconds and `typed-validator896-native` builds and executes with
the ACTUAL typed defaults. `queries897-focused` is the follow-up regression run.
`compile898` is the current full-entry retry with an ignored CPU profile. Do not
rebuild dist or change compiler inputs during it. Full-application completion is
still unproven. PR metadata payload `pr898.json` includes both platform rebases
and current measurements; publish after committing the query follow-up.

**Typed arrays and actual validator generation:** the working unit adds retained
native array/numeric tuple views and fixed compiler-tuple getters. Typed cohort
`typed-values886` admits 6/8 (up from 3/8): scalar arrays, object arrays and mixed
tuples now generate. Optional records and class-held arrays still refuse in that
cohort. `arrays890-focused` executes the new alias/iteration/flatten native check;
`arrays891-focused` passes 41/41; `arrays892-regressions` passes 922/922 without
skips in 162.7 seconds. Later review fixes and exhaustive-switch checks need their
focused rerun: `arrays894-focused` now passes 29/29, and `validator894-native`
confirms all eight parsed-default validator cases still match JavaScript.
The simplify review covered reuse, simplification, altitude and
efficiency (three reviewer tasks plus root): remove redundant sequence forwarding
and identity fallback, use the mutating-method classification, and centralize
dictionary boxing through retained source metadata. Native object key snapshots
must be fresh rather than exposing a fixed getter's key table.

`typed-validator890` generates the unchanged validator with its ACTUAL typed
defaults in 2.25 seconds. Native build exposed unused empty-record getter
parameters, missing value-function fallthrough guards and the COFF section limit.
The current fixes mark those parameters, share the existing method guard with
namespace functions, and enable `/bigobj` on MSVC builds. `typed-validator893`
generates and builds, then executes into a REAL runtime error: Set.has converts a
wider string enum into its narrower enum before lookup and throws for a key that
should simply return false. Next reproduce and fix generic collection lookup
conversion. `check-typed-validator891.mjs` builds/runs the generated probe; its
latest log is `typed-validator893-native.log`. The full application still has not
generated, built or run; do not retry it until this fast typed validator executes.
All previous full-entry/cohort counts remain as recorded below. Arrays with mixed
null/undefined and mutations through erased typed storage remain bounded gaps.

**macOS rebase:** rebased all 94 commits onto `32cab018` (PR #249).
Backup branch `codex/external-project-support-before-macos` retains `fd343d90`.
Conflicts preserve both the macOS number-formatting adapter and dynamic-value
helpers, and keep exception-safe `std::thread` joining within the reload loop.
The range comparison is `macos884-range-diff.log`; other differences are TODO
context. Platform/compiler checks passed 56/57 in `macos884-checks`; the sole
failure asserted the removed structural-grid justification adapter. That obsolete
assertion is removed; native grid behavior already has dedicated coverage.
Continue the array/tuple boundary unit below after the focused rerun and push.
This Windows host cannot establish native macOS build or rendering results.

**Latest follow-up: typed dictionaries and fixed record views.**
Savepoint `ebca2403` is committed and pushed; PR #247's description is now updated
successfully (`pr873.json`, verified GET contains 914/914). The old GitHub server
failure has cleared. Fixed `typed-values873` probes initially admitted 2/8; typed
dictionaries bring admission to 3/8 in `typed-values874`. These are generation-only
counts. Public tests exercise native scalar/enum/record dictionary aliases and the
existing recursive cases (`typed880-focused`:5/5; `typed882-focused`:1/1 adds typed
captured-record return identity). `typed883-regressions` passes 915/915 without
skips. Fixed views reject platform-owned records with pre-existing identity.

The new `json-record-views.ts` keeps compiler record aliases keyed by their shared
property table and uses `materializeEscapingValue` without a source expression to
retain existing cells rather than creating a second record. Native JsonRecordView
traces a minimal getter environment and fixed own keys. Nested views are created
before capturing the outer getter. JSON-valued recursive parameters no longer
erase record arguments into compile-time captures. A captured typed record that
can return dynamically is prepared in the caller through a transactional probe;
otherwise cells created only inside the callee would leave the caller with invalid
references. Unsupported records can still provide scalar returns after rollback.
Enum boxing emits its ADL native converter; JSON sinks demand the JSON header even
when the source has no JSON.parse call.

`typed-validator881` now passes the outer record boundary and refuses a compile-time
tuple field inside the actual typed defaults. Next: retained array/tuple views,
including native typed arrays of scalar/record elements, with live length/index
reads, iteration, flattening and identity. Do not serialize or shallow-copy these
objects to bypass aliasing. The eight-case typed cohort includes scalar arrays,
object arrays, mixed tuples, optional fields and a class holding an array. The
current five native tests are not proof of those still-refused cases. Full-entry
generation remains `compile842`; use the three-second typed validator probe until
the whole typed boundary works, then resume full application generation/build/run.

**Latest batch: retained dynamic values and recursive native invokers.**
The isolated unchanged validator now generates, compiles with MSVC and passes
eight cases against its JavaScript implementation (`check-validator854.mjs`,
`validator863.log`). This exercises mixed object/array/scalar schemas, nested array
flattening, missing keys, null fields and numeric key ordering. Clang also passed
the same generated program. Public `recursive-json-values` tests pass 4/4 in
`dynamic867-focused`, covering recursive unknown parameters/returns, live dictionary
and class views, shared array identity, builtin callback identity, flattening,
conditional Set laziness, UTF-16 sorting and stable comparator ties.

MSVC first rejected nested generic closure capture types and then hit an internal
compiler error with lifted generic lambdas. Resolving environment types through
aliases and changing lambda deduction did not fix it. Named namespace invoker
structs, used through the existing traced closure/group mechanism, compile on
both compilers. The ignored reduction script is `reduce-msvc862.mjs`; do not
change toolchain flags to hide this issue. A JSON-to-JSON sink must not narrow
using an array operation's result node; that previously cast filter elements to
arrays. Conditional Set/Map/JSON values now use the existing lazy sink path.

**Next actual application blocker:** `typed-validator864.mjs` imports both the
unchanged validator and its real typed defaults. It reproduces a refusal in about
three seconds: a compile-time configuration record cannot enter a JSON-valued
recursive callback parameter. The earlier eight-case test uses parsed defaults,
so it is not proof of this typed boundary. Preserve original object identity and
live field storage; do not serialize/copy the defaults to bypass this refusal.
Extend existing retained-record mechanisms and test independently. Full generation,
build and application execution remain unachieved; the latest full attempt is
still `compile842`. Do not retry the full entry until this isolated typed probe
passes. `dynamic868-regressions` passed 912/914; its two failures were obsolete
output/refusal assertions, now corrected. After the four simplify review angles
(three child reviewers and the root reviewing efficiency), boxing and default-sort
conversions share existing helpers; JSON serialization visits entries without a
full copy. `dynamic870-focused` passes 7/7, including a string-literal overload
regression caught during that cleanup. The complete `dynamic871-regressions`
run passes 914/914 without skips. The full branch review/sweep is still pending
completion of the application integration; this review covered the current batch.

**Current batch: recursive unknown values.** String savepoint `12d08e2e` is
committed and pushed. `compile842` passed typeof string sinks and stops at a local
recursive callback's readonly unknown-array parameter in 271.1 seconds. An ignored
isolated import probe (`probe-validator843.mjs`) reproduces the exact validator
failure in about two seconds; use it before another full-entry retry. Independent
`recursive-values843` has four refused cases: recursive arrow/named unknown
parameters, readonly unknown arrays and unknown returns. Its fifth case, mixed
JSON/class values, admits only because the indexed value is statically known;
it does not establish a runtime unknown representation. The validator also builds
heterogeneous schemas with a local class, instanceof, unknown arrays/dictionaries
and recursive unknown returns. Do not pretend these are all plain parsed JSON or
erase class identity by serializing it. Inspect the existing JsonValue/data-type
and recursive-call mechanisms before choosing the shared representation.

The generic rest follow-up fixes an independently reproduced native bug in direct
helpers: a lone spread previously aliased the source array. Direct rest now copies
the array, preserves element identity and snapshots fixed arguments before later
effects. `rest843-focused` passes 150/150 without skips, including source-array
length and shared object-element mutation. The initial failing native probe is
`probe-rest-ownership843.mjs`. The original capability probes and the fixed callback
cohort both remain fully admitted (`capabilities842`:24/24, `callbacks842`:13/13).

GitHub PR body updates also fail through a direct GraphQL mutation with a server
error (`pr843-response.log`); this confirms a service failure, not permission.
The pending expanded payload is `pr843-graphql.json`. Source pushes still work.

**Current unit: typeof in string sinks.** Variadic Math savepoint `c7eb51e0` is
committed and pushed. String sinks now admit the existing typeof lowering, so
conditional String/template expressions and helper parameters preserve its runtime
result. The four-case `string-sinks842` probe is fully admitted (previously 1/4).
`string-sinks842-focused` passes 24/24 without skips, including native JSON values,
lazy conditional branches and operand evaluation counts. `compile842` is the
current full-entry retry. The separate TODO for inferred string-literal enum
fields is not closed by this string-typed sink fix.

**Latest unit: variadic Math and stored rest arguments.** Callback savepoint
`3c55515a` is committed and pushed. The first TODO (stored min/max/hypot) is now
implemented with a function-type rest index and a fresh owned array at each call.
Fixed arguments are snapshotted before packing rest arguments; stored callbacks,
array entries and compatible fixed-signature adapters retain identity. Native
adapters expose their source callback to GC. Direct and stored extrema now share
NaN/signed-zero handling; hypot keeps the documented approximation and accepts
zero/singleton arguments and spreads. Generic stored array-rest functions and
rest declarations in fixed signatures have native execution coverage. Tuple rest
signatures and fixed-to-rest conversions still refuse, as documented.

`variadic840-regressions` passed 890/891 checks without skips. Its sole failure was
an old source assertion requiring std::max for collision heights; it now checks
the shared numeric helper. `variadic841-focused` passes the corrected assertion
and both new native rest/Math tests, including effects after a spread read.
The unchanged full-entry `compile836` passed the callback failure and reached a
string sink in 265.3 seconds. The neutral `probe-string-sinks840.mjs` reproduces
three refusals among four cases: typeof through a string parameter or a conditional
String/template expression. Direct String(typeof value) already compiles. The
string sink's syntax dispatch omits typeof; fix and validate that next, then
retry the full application at this batch boundary. Full generation/build/runtime
is still unachieved. The text getter/compound-assignment TODO remains open.

**Current unit: stored void callbacks and forwarded capture ownership.**
Container savepoint `e47e41f6` is committed and pushed. Concise stored callbacks
whose signature returns void now emit their body as a statement, matching inline
callbacks and avoiding an unnecessary getter read after a DOM text assignment.
The native regression also exposed an ownership gap: callback parameters used
as values (for example, stored in an array) must retain their caller's mutable
environment, including variables accessed through a helper called by that callback.
The shared-closure analysis now recognizes forwarded parameter values.
`callback836-focused` passes 23/23 without skips; `compile836` is the current
full-entry retry. The general value-used assignment/getter TODO remains open.

PR metadata updates currently fail with GitHub HTTP 500 and an empty response,
confirmed in `pr833-response.log`; this is not an authorization refusal. Source
pushes and PR GET requests work. The pending body is saved in ignored
`pr833.json` and `pr833-body.md`; the published body still predates grid/container
completion. Retry after useful work, and verify the returned/current body.

**Latest integration batch: container queries.** Grid savepoint `f6402459` is
committed and pushed. Native inline-size containment and unnamed maximum-width
queries now pass source/host admission and focused layout tests. The same native
pin has a twentieth patch, `rmlui-zz-container-queries.patch`, applied after grid
support. Its working copies are `containers820-rml-{before,after}` under the
ignored session directory; `regenerate-container-patch.py` emits its LF bytes.
The latest installed library is `rml827`. Property changes dirty descendant
definitions before those descendants update; Context::Update settles threshold
results after layout and exposes a query revision to retained presentation and
generated content. Empty conditional stylesheet nodes observe thresholds needed
by private-only adaptations. Native tests cover nearest ancestors, type/display
resets, CSS specificity, padding, flex/grid intrinsic widths, generated parts,
native size changes without DOM writes, cached synchronous measurements and DPR.

`containers-window830` passes SDL_GPU and Dawn with the original DPWCDWMK tape.
The earlier DPWCK failures were caused by the new probe doing several synchronous
layout reads before creating the original input fixture: tracing showed the
first click targeting the empty root. The probe now runs after the input fixture
is constructed. The tape, callbacks and runtime input semantics are unchanged;
temporary hit tracing was removed. `grid-window828` also passes both backends.
`containers830-focused` passes 6/6; `containers831-regressions` passes 944/945,
with the sole failure an old source-regex assertion requiring `if (hover_changed)`
instead of the expanded hover/container condition. That assertion is corrected;
`containers832-focused` passes 3/3, including the corrected assertion, host capture
condition serialization and native container behavior. Population831 generates all 288
entries and passes scene41 bootstrap. Scene180 differential parity831 remains
0.020/0.455 on both backends, canvas-only 0/0 and native backend difference 0.

The fixed stylesheet cohort now has **167 admitted, zero refused, two keyframe
blocks unassessed** (`style-contexts824`). The reduced stylesheet installer also
compiles (`imported-styles824`). Full-entry `compile825` moves past those styles
and refuses `code.textContent` in 252.3 seconds. **Inspection shows this is the
result of an assignment expression in a concise arrow callback, not an authored
getter read:** the source has the ordinary shape `localize(() =>
(element.textContent = label()))`. Expressions.compileValue currently handles
plain assignment expressions by emitting the store and reading the left side
back (expressions.ts around line1130), which requires a getter and can also
misrepresent setters/evaluation order. Investigate a reusable assigned-value
representation or the callback's discarded-return path; do not add a text getter
just to paper over this case. No successful full application generation/build/
runtime has been reached. The stored variadic Math TODO and the text getter/
compound-assignment TODO remain open. Continue after the container savepoint.

**Latest savepoint, 2026-09-13: native grid tracks.** The Linux rebase onto
`a7b1504d` and compatibility fix are pushed. Grid now uses native row-major
fixed/auto/fractional tracks, bounded repeat/minmax, inline-grid and live
cascades, retaining authored DOM parents. The compiler's structural grid
substitutions and geometry proofs are removed. The same pinned RmlUi revision
and 19 maintained patches remain; the existing grid patch owns this work.
`grid818-regressions` passes 933/933 without skips. `grid-tracks-window818`
passes both backends with the original DPWCDWMK replay. Browser measurements
match the neutral fixture's track geometry and inline baseline; the browser
screenshot is JPEG data despite its .png name, so `grid818-pixels.json` is a
lossy-capture comparison, not an exact browser parity gate.

The final scene180 comparison caught percentage-sized replaced grid items
retaining their intrinsic minimum. Cyclic percentage widths/maximums now
compress the minimum contribution while retaining explicit minimums and
max-content sizing. `rml819` rebuilds all patches; `grid819-focused` passes 9/9.
Scene180 differential parity passes unchanged gates on both backends at
0.020/0.455 MAD, canvas-only 0/0, backend difference 0. Scene41 native bootstrap
also rebuilds (`grid819-bootstrap`). Population generation passed all 288
entries plus bootstrap in `population813` before the final native-only fixes.
Range intrinsic size now belongs to UiInputElement (129x16 CSS pixels), with
auto dimensions in the user-agent sheet. Grid first-line baseline and cyclic
percentage box sizing are implemented in the maintained native patch.

The full external application still has not generated or run. Its unchanged
169-rule stylesheet cohort is now 164 admitted / three refused / two keyframes
unassessed (`style-contexts812`). The three refusals are container queries:
two `container-type:inline-size` declarations and one maximum-width query.
The reduced installer (`imported-styles812`) passes grid rules and stops there.
**Continue container queries next; this savepoint is not a stopping point.**
The full-entry retry is still `compile777`; retry at a useful capability batch
boundary. Stored variadic Math callbacks remain the first open TODO and need
completion when reached. No open GitHub issues matched at the last check.

To extend/rebuild the current grid patch, the ignored working sources are
`artifacts/external-integration/grid801-rml-{before,after}`;
`regenerate-grid-patch.py` emits LF patch bytes. Modify the after tree, regenerate,
then run tools/build-rmlui.ps1 with the documented CMake and Git safe-directory
environment. Do not edit/reinstall native inputs while builds/tests consume
them. Commit d38bfdd8 makes patch application stage files in the cached
dependency checkout, so reset removes files introduced by earlier patch
versions. No manual cache cleanup is needed on subsequent rebuilds.

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

**The external application does not fully compile yet.** Native graphics availability now opens the intended startup branch. The last full-entry attempt
stopped on range selectors; reduced installer probes now pass range, scroll and media declarations and reach grid tracks. Its native build and intended
application runtime have never been reached. A green sweep validates the registered corpus;
it does not establish that this external application compiles or runs.

| Item | Saved state |
| --- | --- |
| Compiler checkout | `C:/Dev/babylonlite` |
| Branch | `codex/external-project-support` |
| Remote | `https://github.com/sailro/bblitec.git` |
| Branch base used in this session | `a7b1504d` on `main` (Linux PR #248); 82 commits rebased, with pre-rebase history preserved at `codex/external-project-support-before-linux` |
| Latest executable-code/test unit | Immutable module numeric facts (`df7967fd`), numeric templates/parameter snapshots (`d025ccf9`), control appearance/logical spacing/input types (`ac616c41`); prior savepoints `a25c5eea` (implicit grids/unmarked lists), 1fe43c54 (CSS presentation/visibility), `a81992d4` (owned async methods and promise selection), `0bdfc5b1` (native graphics availability), `613d52b6` (image/promise startup readiness), `8af15082` (asynchronous startup), `f699ad6b` (promise cleanup), `059bfbca` (generic/nested/defaulted destructuring), `bdce7a97` (captured lexical initialization), `bc21486a` (scheduled audio events), `95b04043` (async control flow), `e5ea2607` (async collections), `24281f2c` (promise caches/reactions), `53ba4164` (recursive async and hardened validation) and `f5cd2061` (AudioBuffer surface) |
| Draft PR | [#247 — Extend generic application compilation and retained UI support](https://github.com/sailro/bblitec/pull/247) |
| External checkout | `C:/Dev/_prototypes/external-native-app` |
| External source revision | `d7c477a6d5963680c55249dceb93cb6e4ab9ce56` |
| External checkout changes | Clean when this handoff was prepared |
| External generated output | `generated/external-app` (ignored; not a successful complete generation) |
| Session diagnostics | `artifacts/external-integration` (ignored) |

Latest complete-entry attempt: `compile777` reaches vendor range-thumb selectors
in 229.6 seconds. Shadow support is committed as b8ea4486 after the Linux rebase.
The pre-rebase shadow commit is 68c77baf; older hashes below refer to the preserved
history. Range and scroll/media/gutter support are saved; grid/container requirements remain the next batch.
linux777-regressions passes 1,081/1,081 checks without skips. Rebase review found
that SDL's readable presentation target must also cover general filter composites
reading layer zero; both scene and Window presenters now share that predicate.
Rebuilding the unchanged pinned RmlUi dependency with build-rmlui.ps1 refreshes
two patch receipts whose bytes changed from CRLF to LF on checkout. No patch,
pin or receipt verification was bypassed. shadows-window778 passes both backends
and unchanged DPWCDWMK input replay. population778 generates all 288 entries and
passes native bootstrap. Rebased history and compatibility fix 849ca174 are pushed;
the explicit lease against the old remote tip succeeded. PR #247 remains draft.

The range unit now passes 924/924 checks without skips (range785-regressions).
range-window785 passes both backends and unchanged DPWCDWMK replay. Captures are
identical between backends; the fixed 145x50 browser comparison has RGB MAE
1.48/255, not exact parity. Chromium discards Gecko-only range selector lists;
those rules now follow that behavior rather than styling the same native control.
WebKit thumb/track selectors target typed anonymous native parts and preserve
owner/part state, dimensions, gradients, shadows and appearance. The seventeenth
patch, rmlui-range-layout.patch, retains the same RmlUi commit. It centers tracks,
derives auto height from the thumb margin box and uses InputTypeRange::OnLayout
to reformat part changes even when the input size does not change. Initial tests
caught that missing invalidation; range784 passes after the correction.
range785 includes native hover, keyboard, value endpoints, resizing, disabled
state, theme suppression and sheet-removal checks. imported-styles783 passes the
reduced options installer range rules and stops on overscroll-behavior-y. The
same 169-rule cohort is now 155 admitted / 12 refused / two keyframes unassessed;
three of the admitted rules are Gecko-only and intentionally absent from the
Chromium cascade. This is not a full application generation result. Continue
scroll behavior and media declarations together, then general grid/container work.
GitHub's open issue list is empty; remaining core-library/TODO gaps stay open.

The scroll/media/gutter unit passes 929/929 checks without skips
(scroll801-regressions). scroll-window801 passes SDL_GPU and Dawn with the original
DPWCDWMK input replay, responsive geometry and stable gutter assertions. All 288
entries generate (population797); scene41 rebuilds against the corrected native
dependency (bootstrap801). The same 169-rule cohort is now 159 admitted / eight
refused / two keyframes unassessed (style-contexts797). All eight refusals concern
grid tracks, inline-grid or container queries; these counts do not establish full
application compilation. imported-styles793 reaches explicit grid tracks.

The nineteenth maintained patch retains the same RmlUi pin. Scroll containment
keeps independent axes across wheel, middle-button autoscroll and native touch
including inertia. Stable gutters reserve layout space separately from scrollbar
painting. Media declarations share ordinary validation; structural grid
substitutions still refuse. The broad run caught an overscroll shorthand ID
collision with place-items; explicit built-in registration fixes it. rml800
rebuilds all 19 patches, scroll800 passes nine focused checks, and the corrected
broad run is scroll801. Browser gutter measurements confirm stable geometry;
native thin scrollbars remain eight pixels versus Chromium's ten-pixel reference.

Continue general native grid tracks and container queries. Eight neutral grid
probes currently refuse (grid-tracks798-baseline); preserve this cohort. Isolated
native working files are in grid801-rml-after; grid801-rml-before is the current
RmlUi state with the last zero-track patch reversed, ready to regenerate that
patch without changing its order or losing the preceding 18 patches. Those
directories are ignored artifacts, not installed dependencies.

Historical complete-entry attempt: `compile764` passes the imported stylesheet constant
and reaches generated-content inset-outline decoration (225.2 seconds). The
module-constant unit is committed and pushed as df7967fd. population764 generates
all 288 registered entries and passes native bootstrap with the module-only guard.
Full intended application generation, native build and runtime remain incomplete.
The isolated style-contexts765 audit of the newly captured sheet records 150
accepted rules, 17 refused rules and two keyframes not assessed. Refusals expose
generated decoration, vendor range parts, media overrides, explicit grids and
container queries. Counts include independent rules and do not prove whole-sheet
or native support. Continue with grouped capability work and reduced import probes.

Historical shadow-unit development notes: imported-styles771 passes the reduced
application installer's complete shadow declarations and reaches vendor range-thumb
selectors. This is not a fresh full-entry result. The recorder now supports inverse
masks on geometry/composites and saved layer textures, replaying only the captured
subgraph with the shared filter plan. Captured commands and unused layer counts are
removed before GPU submission; RmlUi owns texture caching. Four coverage samples
preserve rounded edges. CSS shadow lists and color variables now reach the native
shadow implementation; the former inset-border substitution is removed.
shadows772-regressions passes 956/956 without skips. After adding coverage samples,
shadows773 passes all thirteen focused shadow/generated/filter/backdrop/media checks.
The motion test continues testing a private property using the existing crosshair
marker after inset metadata was retired. New fixtures check capture ownership,
cropped origins, blending, blur, live colors/sizes and generated hover/removal.
shadows-window773 passes SDL_GPU and Dawn with unchanged DPWCDWMK replay;
population773 generates all 288 entries and passes native bootstrap. The Window
pixel comparison exposed thin numerical fragments on adjacent mask-triangle edges.
A distance-based degeneracy check removes them; the permanent rounded-box fixture
now checks the entire central area. shadows775 passes all thirteen checks;
shadows-window775 passes both backends. Their images are identical, with zero
nonwhite interior pixels; browser RGB mean absolute error over the fixed region is
4.07/255 (raster/color differences remain, not exact parity). style-contexts773 is
151 accepted / 16 refused / two keyframes unassessed, the same cohort as 765.
Final shadow validation also preserves case-sensitive custom-property color names. A neutral browser reference is shadows772-browser.html/.png. The user has now authorized rebasing onto the newly landed Linux support.
origin/main is a7b1504d (PR #248, commits 4dd147e4/c993ab62/b554c7cd).
That unit is now committed and rebased; changed support docs and overlapping
compiler/native changes have been reviewed. Continue range/control and
media/grid/container requirements after the post-rebase checks above.
Do not stop at the savepoint.

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
