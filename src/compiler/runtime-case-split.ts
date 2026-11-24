import ts from "typescript";
import { someAnalysisNode } from "./analysis-walk.js";
import { CompileError, unlessRefused } from "./compile-error.js";
import { writable } from "./emission-transaction.js";
import type { DataType } from "./data-types/model.js";
import type { LoweringServices } from "./lowering-services.js";
import { selectedModuleConstants, type HeldRow } from "./held-constants.js";
import {
    calledFunction,
    declaredSymbol,
    resolvedSymbol,
    sameExpression,
} from "./symbols.js";
import { StorageDemand } from "./storage-demand.js";
import { activeSurvey } from "./survey.js";
import {
    typeCanCarryReference,
    isVoid,
    nullability,
    holdsOnly,
    objectLikeType,
    presentMembers,
    recordObjectType,
    finiteScalarValues,
    stringLiteralValues,
} from "./type-facts.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import { booleanValue, isStringValue, type Value } from "./types.js";
import { isShaderMaterialType } from "./shader-derivations.js";
import { runtimeShaderVariants } from "./shader-material-views.js";
import {
    functionOfDeclaration,
    isModuleScopeFunction,
    isSuspensionPoint,
    isValueReference,
    unwrapExpression,
    valueUse,
    writeSites,
} from "./syntax.js";
import {
    isAbsentValue,
    knownAbsent,
    holdsMaterial,
    knownCondition,
    knownPlainData,
    nullValue,
    presenceCpp,
    undefinedValue,
    withShaderVariants,
} from "./values/model.js";

export type CaseSplitContext = Pick<
    LoweringServices,
    | "allocateTemporaryCppName"
    | "bindings"
    | "checker"
    | "cppString"
    | "conditionOverrides"
    | "valueOverrides"
    | "compileValue"
    | "conditions"
    | "dataLowerer"
    | "dataTypes"
    | "decreaseIndent"
    | "emit"
    | "emitDiscardedValue"
    | "enterRuntimeControlFlow"
    | "evaluationOrder"
    | "increaseIndent"
    | "keptEmission"
    | "leaveRuntimeControlFlow"
    | "probeEmission"
    | "program"
    | "reachShaderCreations"
    | "requireEngine"
    | "sceneManifest"
    | "settledCallInitializer"
    | "userFunctions"
>;

/** More tests than this are not probed for the ones the call depends on. */
const MAX_CANDIDATE_SELECTORS = 8;
/** A member this deep below a record an argument names still selects. */
const MAX_MEMBER_DEPTH = 2;
/** A value typed as a union of at most this many string literals selects. */
const MAX_LITERAL_OUTCOMES = 16;
/** At most this many arms, the product of the tests' outcomes, split one call. */
const MAX_ARMS = 81;

/**
 * Whether an argument of `call` reads a value or a condition the run-time
 * case split being compiled fixed in its arm: the call specializes on that
 * outcome inline rather than sharing a body.
 */
export function fixedByCaseSplit(
    context: Pick<LoweringServices, "valueOverrides" | "conditionOverrides">,
    call: ts.CallExpression | ts.NewExpression,
): boolean {
    return (
        (context.valueOverrides.size > 0 ||
            context.conditionOverrides.size > 0) &&
        (call.arguments ?? []).some((argument) =>
            someAnalysisNode(
                argument,
                (node) =>
                    context.valueOverrides.has(node) ||
                    context.conditionOverrides.has(node),
                { functions: "skip" },
            ),
        )
    );
}

/**
 * Whether a call compiled in an arm of a run-time case split specializes
 * inline: one whose arguments are plain data generation knows, building a
 * record of plain data (`returned`), keeps what the arm fixed in what it
 * returns.
 */
export function armSpecializesCall(
    context: Pick<
        LoweringServices,
        "valueOverrides" | "conditionOverrides" | "dataTypes"
    >,
    returned: DataType | undefined,
    node: ts.Node,
    argumentValues: readonly Value[],
): boolean {
    return (
        (context.valueOverrides.size > 0 ||
            context.conditionOverrides.size > 0) &&
        returned?.kind === "struct" &&
        argumentValues.length > 0 &&
        argumentValues.every((value) => knownPlainData(value)) &&
        context.dataTypes.holdsPlainData(returned, node)
    );
}

/**
 * Compiles a local function call whose arguments pick between values with a
 * runtime test (`f({...(c ? a : {})})`), or pass a value of a few outcomes (a
 * boolean, an optional object present or absent), itself or as a member of a
 * record an argument names (`f(options)`), or an object that is one of a few
 * module constants (`f(entry.lane ?? DEFAULT_LANE)`), or a ShaderMaterial
 * whose shader variant only the run time knows (one outcome per variant the
 * program creates, `runtimeShaderVariants`, the arm read from a generated
 * variant table), once per outcome when
 * the single compilation refuses: a callee that specializes on its argument
 * (a shader composed from options) then sees each outcome as a constant. The
 * test is read once, before the call, which is where JavaScript reads it
 * unless an argument evaluated earlier could change it; so every test is
 * free of writes, no argument assigns or constructs, and an argument's calls
 * go to module-level functions that receive none of the bindings the tests
 * read (such a function reaches a local binding only through its
 * arguments). A name whose declaration deferred its selection
 * (`deferredSelection`) is tested by that selection's condition, which
 * nothing an argument does changes: it alone splits a call whose arguments
 * do more. With more than two tests, the call splits only on those whose
 * staying a runtime test, with every other test fixed, still refuses, and
 * an arm that refuses adds those that still refuse so within that arm,
 * the others fixed to it (`armDependedSelectors`); a call whose tests'
 * outcomes make more than `MAX_ARMS` arms, or that reads more than
 * `MAX_CANDIDATE_SELECTORS`, keeps its refusal, which then says so.
 * Intrinsics use `held-text`: only the finite inputs of replayable string
 * initializers select, not otherwise unsupported run-time options.
 */
export function compileWithRuntimeCaseSplit(
    context: CaseSplitContext,
    call: ts.CallExpression,
    compile: () => Value | undefined,
    selectors: "arguments" | "held-text" = "arguments",
): Value | undefined {
    const tests = selectorTests(context, call, selectors === "held-text");
    if (tests === undefined) return compile();
    try {
        // A survey lowers the unsplit call where the statements of its
        // callee recover, as a shared body outside a probe: a refusal or
        // storage demand one of them meets is that statement's, so one pass
        // meets them all and the census names each. Only what the call
        // itself raises tries the split.
        return activeSurvey()
            ? context.keptEmission(compile, () => true)
            : context.probeEmission(compile, () => true);
    } catch (error) {
        // A storage demand is the unsplit call asking for dynamic storage
        // the runtime test forced; per outcome it may not be needed, so it
        // stands only when the split fails too.
        if (!refusesPerOutcome(error)) throw error;
        // Which members of the records its arguments name select, and
        // which tests stay runtime ones, is asked only of a call that
        // refused. The tests keep the order the arguments spell them in.
        const runtime = runtimeSelectors(
            context,
            [
                ...tests.groups(),
                ...tests.records.flatMap((record) =>
                    recordMemberSelectors(context, record),
                ),
            ].sort((left, right) => left.nodes[0]!.pos - right.nodes[0]!.pos),
        );
        if (runtime === undefined) throw error;
        if (runtime.variable.length > MAX_CANDIDATE_SELECTORS)
            throw beyondSplit(
                error,
                runtime.variable,
                `at most ${MAX_CANDIDATE_SELECTORS} run-time tests; it reads ${runtime.variable.length}`,
            );
        const depended = dependedSelectors(context, runtime, compile);
        if (depended === undefined) throw error;
        let selectors = depended;
        for (;;) {
            const arms = selectors.reduce(
                (product, selector) => product * selector.outcomes.length,
                1,
            );
            if (arms === 0) {
                const chosen = selectors;
                context.sceneManifest.shaderDerivations.refuseWithoutCreations(
                    () => {
                        throw beyondSplit(
                            error,
                            chosen,
                            "the shader variants the program creates, and it creates none",
                        );
                    },
                );
            }
            if (arms > MAX_ARMS)
                throw beyondSplit(
                    error,
                    selectors,
                    `run-time tests in at most ${MAX_ARMS} arms; its tests make ${arms}`,
                );
            let armRefusal: CompileError | undefined;
            const chosen = selectors;
            const split = context.probeEmission(
                () => {
                    try {
                        return splitCall(
                            context,
                            call,
                            runtime.fixed,
                            chosen,
                            compile,
                        );
                    } catch (inner) {
                        // An arm's own storage demand restarts generation
                        // with it satisfied, after which the split can
                        // succeed.
                        if (inner instanceof CompileError) {
                            armRefusal = inner;
                            return undefined;
                        }
                        throw inner;
                    }
                },
                (result) => result !== undefined,
            );
            if (split) return split;
            // A test that matters only inside an arm joins the split.
            const joined = armDependedSelectors(
                context,
                runtime,
                chosen,
                compile,
            );
            if (joined.length === 0)
                throw armRefused(error, armRefusal, chosen);
            selectors = runtime.variable.filter(
                (candidate) =>
                    chosen.includes(candidate) || joined.includes(candidate),
            );
        }
    }
}

/** A selector's test as a refusal names it: the expression, then a member's key path. */
function testNames(tests: readonly Selector[]): string {
    return tests
        .map((test) =>
            [test.test.getText(), ...(test.member?.path ?? [])].join("."),
        )
        .join(", ");
}

/**
 * The refusal of a call whose arms refused too: the arm's own, where the
 * compile stopped, then the tests and the call's refusal compiled once.
 * The reason and subject stay the call's, which is what its callers act
 * on. A restart, an arm refusing as the call did, and an arm that left no
 * located refusal stand as they are.
 */
function armRefused(
    error: unknown,
    arm: CompileError | undefined,
    tests: readonly Selector[],
): unknown {
    if (
        !(error instanceof CompileError) ||
        !arm?.fileName ||
        arm.message === error.message
    )
        return error;
    return new CompileError(
        arm.fileName,
        arm.line,
        arm.column,
        `${arm.detail} (An arm of a call compiled once per outcome of ${testNames(tests)} refuses so; compiled once, the call refuses at ${error.message})`,
        error.reason,
        error.subject,
    );
}

/**
 * The refusal of a call a split could not reach: its own text, then what
 * its run-time tests compile once per (`reach`: past a limit, or no shader
 * variant at all) and the tests. A restart stands as it is.
 */
function beyondSplit(
    error: unknown,
    tests: readonly Selector[],
    reach: string,
): unknown {
    if (!(error instanceof CompileError)) return error;
    return new CompileError(
        error.fileName,
        error.line,
        error.column,
        `${error.detail} The call compiles once per outcome of ${reach}: ${testNames(tests)}.`,
        error.reason,
        error.subject,
    );
}

/** A refusal, or a storage or realm restart one outcome may not need. */
function refusesPerOutcome(error: unknown): boolean {
    return (
        error instanceof CompileError ||
        error instanceof StorageDemand ||
        error instanceof ApplicationRealmRequired
    );
}

/**
 * What a test reads as in one arm: true (a present object), false, absent,
 * one string of a literal union, or one module constant.
 */
type Outcome =
    | "truthy"
    | "falsy"
    | "absent"
    | { readonly literal: string }
    | ConstantOutcome
    | VariantOutcome;

/** One shader variant a run-time ShaderMaterial may be, by its program's name. */
interface VariantOutcome {
    readonly variant: string;
}

/**
 * The module constant or constant row an object is in one arm
 * (`selectedModuleConstants`), and, once the call refused, its value as
 * the row reads where the call compiles, whose members the arm reads.
 */
interface ConstantOutcome {
    readonly row: HeldRow;
    readonly record?: Value;
}

/**
 * One runtime test: the node read once, and every node spelling it. A
 * `condition` is a selection's test; a `boolean` an argument value that is a
 * boolean; a `presence` an argument value that is an object or one absence
 * (`undefined` or `null`); an `optional-boolean` a boolean or one absence;
 * a `literal` a value typed as a union of string literals (a key of a
 * constant table); a `constant` an argument value that is one of a few
 * module constants or constant rows (`selectedModuleConstants`), its
 * distinct rows its joint outcomes. `outcomes` are the ones the
 * value can take. With `member`, the value is
 * the member at that key path of the record `test` names, of that type;
 * `present` is the storage of an object member where an arm found it.
 * A constant test's `discriminants` are the members, strings or booleans
 * in every one of its constants, whose values tell them apart.
 */
interface Selector {
    kind:
        | "condition"
        | "boolean"
        | "presence"
        | "optional-boolean"
        | "literal"
        | "constant"
        | "variant";
    test: ts.Expression;
    nodes: readonly ts.Expression[];
    outcomes: readonly Outcome[];
    discriminants?: readonly string[];
    member?: {
        readonly path: readonly string[];
        readonly type: ts.Type;
        readonly present?: DataType | undefined;
    };
}

/** A selector on a record's member. */
type MemberSelector = Selector & Required<Pick<Selector, "member">>;

function isMemberSelector(selector: Selector): selector is MemberSelector {
    return selector.member !== undefined;
}

/** A record an argument names: every position naming it, and its type there. */
interface RecordArgument {
    nodes: ts.Identifier[];
    type: ts.Type;
}

/**
 * What a call's arguments select with: the tests they spell, and the
 * records they name, whose members of a few outcomes are tests too
 * (`recordMemberSelectors`).
 */
interface SelectorTests {
    /** The tests, a value's of a few module constants among them, asked once. */
    groups: () => readonly Selector[];
    records: readonly RecordArgument[];
}

/** Every outcome a test of `kind` can take. */
const KIND_OUTCOMES: Readonly<
    Record<
        Exclude<Selector["kind"], "literal" | "constant" | "variant">,
        readonly Outcome[]
    >
> = {
    condition: ["truthy", "falsy"],
    boolean: ["truthy", "falsy"],
    presence: ["truthy", "absent"],
    "optional-boolean": ["truthy", "falsy", "absent"],
};

/**
 * Every outcome a value of `type`, a selector of `kind`, can take: none its
 * type gives for a constant test, whose outcomes are the constants found.
 */
function kindOutcomes(
    kind: Selector["kind"],
    type: ts.Type,
): readonly Outcome[] {
    return kind === "literal"
        ? [...(stringLiteralValues(type) ?? [])].map((literal) => ({
              literal,
          }))
        : kind === "constant" || kind === "variant"
          ? []
          : KIND_OUTCOMES[kind];
}

/**
 * The selectors a split forces: `fixed` take their one outcome in every
 * arm (a value whose truth generation knows but whose storage the callee
 * would read at run time), `variable` ones branch.
 */
interface RuntimeSelectors {
    fixed: readonly Selector[];
    variable: readonly Selector[];
}

/** The outcome that stands for "false" in a dependency probe: the first one past truth. */
function falseOutcome(selector: Selector): Outcome {
    return (
        selector.outcomes.find((outcome) => outcome !== "truthy") ??
        selector.outcomes[0]!
    );
}

/**
 * Compiles `compile` with each `fixed` selector forced to its one outcome
 * and each other selector to its outcome (`undefined` leaves it runtime).
 */
function withOutcomes<T>(
    context: CaseSplitContext,
    fixed: readonly Selector[],
    variable: readonly Selector[],
    variableOutcomes: readonly (Outcome | undefined)[],
    compile: () => T,
): T {
    const selectors = [...fixed, ...variable];
    const outcomes = [
        ...fixed.map((selector) => selector.outcomes[0]),
        ...variableOutcomes,
    ];
    // A record takes every member forced in it before it stands for its name.
    const records = new Map<ts.Expression, Value>();
    selectors.forEach((selector, index) => {
        const outcome = outcomes[index];
        if (outcome === undefined) return;
        for (const node of selector.nodes) {
            // A boolean's nodes may be a selection's tests too (`addGroup`).
            if (
                selector.kind === "condition" ||
                (selector.kind === "boolean" && !isMemberSelector(selector))
            )
                context.conditionOverrides.set(node, outcome === "truthy");
            if (selector.kind === "condition") continue;
            if (isMemberSelector(selector))
                records.set(
                    node,
                    withForcedMember(
                        context,
                        selector,
                        node,
                        records.get(node) ?? context.compileValue(node),
                        selector.member.path,
                        outcome,
                    ),
                );
            else
                context.valueOverrides.set(
                    node,
                    forcedValue(
                        context,
                        selector,
                        node,
                        context.checker.getTypeAtLocation(node),
                        () => context.compileValue(node),
                        outcome,
                    ),
                );
        }
    });
    for (const [node, record] of records)
        context.valueOverrides.set(node, record);
    try {
        return compile();
    } finally {
        for (const selector of selectors)
            for (const node of selector.nodes) {
                context.conditionOverrides.delete(node);
                context.valueOverrides.delete(node);
            }
    }
}

/**
 * The value a selector's value, of `type`, takes in one arm: the boolean,
 * the absence its type has, or the value `read` gives, narrowed to present
 * (the arm runs only where its test found it).
 */
function forcedValue(
    context: CaseSplitContext,
    selector: Selector,
    node: ts.Expression,
    type: ts.Type,
    read: () => Value,
    outcome: Outcome,
): Value {
    const absent = (): Value =>
        nullability(type).null ? nullValue() : undefinedValue();
    if (typeof outcome === "object")
        return "literal" in outcome
            ? {
                  kind: "string",
                  cpp: context.cppString(outcome.literal),
                  staticString: outcome.literal,
              }
            : "variant" in outcome
              ? withShaderVariants(read(), [outcome.variant])
              : constantValue(read(), outcome);
    // A present object is truthy and present wherever the arm reads it.
    if (selector.kind === "presence")
        return outcome === "truthy"
            ? {
                  ...context.dataLowerer.narrowOptional(
                      read(),
                      node,
                      true,
                      selector.member?.present,
                  ),
                  truthinessCpp: "true",
                  optionalFoundCpp: "true",
              }
            : absent();
    if (outcome === "absent") return absent();
    return {
        kind: "boolean",
        cpp: outcome === "truthy" ? "true" : "false",
        staticBoolean: outcome === "truthy",
    };
}

/** The run-time object `value`, whose members are the constant's. */
function constantValue(value: Value, outcome: ConstantOutcome): Value {
    const forced: Value = { ...value };
    writable(forced).recordProperties = outcome.record!.recordProperties!;
    return forced;
}

/**
 * `record` with the member at `path` forced to a selector's outcome in one
 * arm. A key a conditional spread wrote is own only where the arm found it.
 */
function withForcedMember(
    context: CaseSplitContext,
    selector: MemberSelector,
    node: ts.Expression,
    record: Value,
    path: readonly string[],
    outcome: Outcome,
): Value {
    const [key, ...below] = path;
    const member =
        key === undefined ? undefined : record.recordProperties?.[key];
    if (key === undefined || !member) return record;
    const properties = { ...record.recordProperties };
    const forced: Value = { ...record };
    writable(forced).recordProperties = properties;
    if (
        below.length === 0 &&
        member.conditionalOwnKey &&
        outcome === "absent"
    ) {
        delete properties[key];
        if (record.recordOwnKeys)
            writable(forced).recordOwnKeys = record.recordOwnKeys.filter(
                (own) => own !== key,
            );
        return forced;
    }
    const value: Value = {
        ...(below.length > 0
            ? withForcedMember(context, selector, node, member, below, outcome)
            : forcedValue(
                  context,
                  selector,
                  node,
                  selector.member.type,
                  () => member,
                  outcome,
              )),
    };
    delete writable(value).conditionalOwnKey;
    properties[key] = value;
    return forced;
}

/** The value a selector's test reads: its expression's, or the record member's. */
function selectorValue(
    context: CaseSplitContext,
    selector: Selector,
): Value | undefined {
    return context.bindings.currentRecordMember(
        context.compileValue(selector.test),
        selector.member?.path ?? [],
    );
}

/**
 * Whether a value of `type` is one a split can force: a boolean, a union
 * of a few string literals, or an object or a boolean with one of
 * `undefined` and `null`.
 */
function selectorKind(
    type: ts.Type,
): Exclude<Selector["kind"], "condition" | "constant"> | undefined {
    if (holdsOnly(type, ["boolean"])) return "boolean";
    const literals = stringLiteralValues(type);
    if (literals)
        return literals.size > 1 && literals.size <= MAX_LITERAL_OUTCOMES
            ? "literal"
            : undefined;
    const absent = nullability(type);
    if (absent.null === absent.undefined || absent.void) return undefined;
    const present = presentMembers(type);
    if (present.length === 0) return undefined;
    if (holdsOnly(type, ["boolean", "undefined", "null"]))
        return "optional-boolean";
    return present.every((member) => objectLikeType(member))
        ? "presence"
        : undefined;
}

/**
 * The selectors the call depends on: all of them when few, else each one
 * that, left a runtime test while every other is false, still refuses.
 */
function dependedSelectors(
    context: CaseSplitContext,
    runtime: RuntimeSelectors,
    compile: () => Value | undefined,
): readonly Selector[] | undefined {
    const candidates = runtime.variable;
    if (candidates.length <= 2) return candidates;
    const depended = candidates.filter((_, index) =>
        refusesWith(
            context,
            runtime,
            candidates.map((candidate, other) =>
                other === index ? undefined : falseOutcome(candidate),
            ),
            compile,
        ),
    );
    return depended.length > 0 ? depended : undefined;
}

/**
 * The tests a split on `chosen` missed: each other candidate that, left a
 * runtime test in some arm of `chosen` while every other candidate is
 * false, still refuses (`dependedSelectors`' rule within that arm).
 */
function armDependedSelectors(
    context: CaseSplitContext,
    runtime: RuntimeSelectors,
    chosen: readonly Selector[],
    compile: () => Value | undefined,
): readonly Selector[] {
    const candidates = runtime.variable;
    const arms = armOutcomes(chosen);
    return candidates.filter(
        (candidate, index) =>
            !chosen.includes(candidate) &&
            arms.some((arm) =>
                refusesWith(
                    context,
                    runtime,
                    candidates.map((other, position) => {
                        const at = chosen.indexOf(other);
                        return position === index
                            ? undefined
                            : at >= 0
                              ? arm[at]
                              : falseOutcome(other);
                    }),
                    compile,
                ),
            ),
    );
}

/** Every combination of the selectors' outcomes: one per arm, in selector order. */
function armOutcomes(selectors: readonly Selector[]): readonly Outcome[][] {
    return selectors.reduce<Outcome[][]>(
        (arms, selector) =>
            arms.flatMap((arm) =>
                selector.outcomes.map((outcome) => [...arm, outcome]),
            ),
        [[]],
    );
}

/**
 * Whether the call refuses with the candidates at `outcomes` (`undefined`
 * leaves one runtime), compiled in a probe that keeps nothing.
 */
function refusesWith(
    context: CaseSplitContext,
    { fixed, variable }: RuntimeSelectors,
    outcomes: readonly (Outcome | undefined)[],
    compile: () => Value | undefined,
): boolean {
    try {
        context.probeEmission(
            () => withOutcomes(context, fixed, variable, outcomes, compile),
            () => false,
        );
        return false;
    } catch (error) {
        // A storage or realm demand restarts generation with it held, as
        // an arm's does; the probe then answers on the next attempt.
        if (error instanceof CompileError) return true;
        throw error;
    }
}

/** A name calling a module's own function (`isModuleScopeFunction`), directly or through an import. */
export function moduleLevelCallee(
    checker: ts.TypeChecker,
    callee: ts.Expression,
): boolean {
    if (!ts.isIdentifier(callee)) return false;
    const declaration = resolvedSymbol(checker, callee)?.valueDeclaration;
    return (
        declaration !== undefined &&
        isModuleScopeFunction(
            ts.isVariableDeclaration(declaration)
                ? (functionOfDeclaration(declaration) ?? declaration)
                : declaration,
        )
    );
}

/**
 * The distinct tests a call's arguments select with, each with every node
 * spelling it, and the records they name, when the call can be split on
 * them: no argument assigns, constructs or suspends, its calls go to
 * module-level functions handed none of the bindings the tests read, and
 * no test writes. A deferred selection's condition splits it whatever its
 * arguments do. A boolean a selection tests and a call is handed is one
 * test, and a pure function's call on tests already counted, a selection's
 * test or an object of a few constants, none of its own.
 */
function selectorTests(
    context: CaseSplitContext,
    call: ts.CallExpression,
    onlyHeldText: boolean,
): SelectorTests | undefined {
    const calls: ts.CallExpression[] = [];
    const effects = (node: ts.Node): boolean => {
        if (ts.isFunctionLike(node)) return false;
        if (ts.isCallExpression(node)) {
            if (!moduleLevelCallee(context.checker, node.expression))
                return true;
            calls.push(node);
        } else if (
            ts.isNewExpression(node) ||
            ts.isTaggedTemplateExpression(node) ||
            isSuspensionPoint(node, { yield: true }) ||
            writeSites(node).length > 0
        )
            return true;
        return ts.forEachChild(node, effects) ?? false;
    };
    // What an argument does may change what a test reads, but not a
    // deferred selection's condition, which reads only bindings nothing
    // rebinds (`deferrableSelection`): only such tests split a call whose
    // arguments do more than read.
    const effectful = call.arguments.some(effects);
    const unchanging = new Set<ts.Expression>();
    // Each distinct test with every place it appears.
    const groups: (Selector & { nodes: ts.Expression[] })[] = [];
    // A boolean a selection tests and a call is handed is one test.
    const truthTest = (kind: Selector["kind"]): boolean =>
        kind === "condition" || kind === "boolean";
    const addGroup = (
        kind: Selector["kind"],
        test: ts.Expression,
        outcomes?: readonly Outcome[],
    ): void => {
        const group = groups.find(
            (candidate) =>
                (candidate.kind === kind ||
                    (truthTest(candidate.kind) &&
                        truthTest(kind) &&
                        holdsOnly(context.checker.getTypeAtLocation(test), [
                            "boolean",
                        ]))) &&
                sameExpression(context.checker, candidate.test, test),
        );
        if (group) {
            group.nodes.push(test);
            if (kind === "boolean") group.kind = kind;
        } else
            groups.push({
                kind,
                test,
                nodes: [test],
                outcomes:
                    outcomes ??
                    kindOutcomes(kind, context.checker.getTypeAtLocation(test)),
            });
    };
    const records: RecordArgument[] = [];
    // A record argument value that may be one of a few module constants,
    // with the place its test takes among the groups: which constants it
    // can be (`selectedModuleConstants`) is asked only where an answer
    // depends on it.
    const candidates: { node: ts.Expression; index: number }[] = [];
    const heldCalls = new Set<ts.CallExpression>();
    const known = new Map<ts.Expression, readonly HeldRow[] | undefined>();
    const constantsOf = (
        node: ts.Expression,
    ): readonly HeldRow[] | undefined => {
        if (!known.has(node))
            known.set(
                node,
                selectedModuleConstants(context, node, MAX_ARMS) ??
                    typeRows(context, node),
            );
        return known.get(node);
    };
    // An argument value of a few outcomes, unless it is a literal (already
    // a constant) or a selection inside it already splits it; else the
    // record it names.
    const valuePosition = (node: ts.Expression): void => {
        if (
            node.kind === ts.SyntaxKind.TrueKeyword ||
            node.kind === ts.SyntaxKind.FalseKeyword
        )
            return;
        const type = context.checker.getTypeAtLocation(node);
        const kind = selectorKind(type);
        if (kind) {
            if (!containsSelection(node)) addGroup(kind, node);
        } else if (isShaderMaterialType(type) && !containsSelection(node)) {
            // A ShaderMaterial's variant, when the run time decides it.
            addGroup("variant", node);
        } else if (ts.isIdentifier(node) && heldRecord(context, node)) {
            const record = records.find((candidate) =>
                sameExpression(context.checker, candidate.nodes[0]!, node),
            );
            if (record) record.nodes.push(node);
            else records.push({ nodes: [node], type });
        } else if (
            recordObjectType(context.checker, type) &&
            !containsSelection(node)
        ) {
            const absent = nullability(type);
            if (!absent.null && !absent.undefined)
                candidates.push({ node, index: groups.length });
        }
    };
    const visit = (node: ts.Node, held = false): void => {
        if (ts.isFunctionLike(node)) return;
        // A name whose declaration deferred its selection reads it here.
        const deferred =
            ts.isIdentifier(node) && context.bindings.deferredSelection(node);
        if (deferred && (!onlyHeldText || held)) {
            unchanging.add(deferred.condition);
            addGroup("condition", deferred.condition);
        }
        if (!effectful) {
            // Required text can be held in a const's closed-helper result.
            // The same replay proof the static evaluator uses admits its
            // finite arguments here; the arm then folds that initializer.
            if (
                ts.isIdentifier(node) &&
                isValueReference(node) &&
                context.bindings.lookupOptional(node)?.staticString ===
                    undefined &&
                holdsOnly(context.checker.getTypeAtLocation(node), ["string"])
            ) {
                const initializer = context.settledCallInitializer(node);
                if (initializer && !heldCalls.has(initializer)) {
                    heldCalls.add(initializer);
                    calls.push(initializer);
                    visit(initializer, true);
                }
            }
        }
        if (!effectful && (!onlyHeldText || held)) {
            if (ts.isConditionalExpression(node))
                addGroup("condition", node.condition);
            // A value of a few outcomes a module's function is handed
            // (`build(optionsFor(kind))`) selects the call it builds for.
            if (ts.isCallExpression(node) && calls.includes(node))
                for (const argument of node.arguments) {
                    const kind = selectorKind(
                        context.checker.getTypeAtLocation(argument),
                    );
                    if (
                        (kind === "literal" || kind === "boolean") &&
                        !containsSelection(argument)
                    )
                        addGroup(kind, argument);
                }
            if (ts.isPropertyAssignment(node)) valuePosition(node.initializer);
            if (ts.isShorthandPropertyAssignment(node))
                valuePosition(node.name);
            if (ts.isSpreadAssignment(node)) valuePosition(node.expression);
        }
        ts.forEachChild(node, (child) => visit(child, held));
    };
    call.arguments.forEach((argument) => {
        if (!effectful && !onlyHeldText) valuePosition(argument);
        visit(argument);
    });
    // A pure function's call on tests already counted is decided by them:
    // an arm forces its arguments, so the call reads as a constant there.
    const decided = (node: ts.Expression, own?: Selector): boolean => {
        const test = unwrapExpression(node);
        const callee =
            ts.isCallExpression(test) && calledFunction(context.checker, test);
        return (
            ts.isCallExpression(test) &&
            !!callee &&
            test.arguments.length > 0 &&
            context.evaluationOrder.isPure(callee) &&
            test.arguments.every((argument) =>
                groups.some(
                    (other) => other !== own && other.nodes.includes(argument),
                ),
            )
        );
    };
    for (let index = groups.length - 1; index >= 0; index--) {
        const group = groups[index]!;
        if (group.kind === "condition" && decided(group.test, group))
            groups.splice(index, 1);
    }
    if (
        groups.length === 0 &&
        records.length === 0 &&
        !candidates.some(({ node }) => constantsOf(node))
    )
        return undefined;
    // The bindings the tests read; no call in the arguments may receive one.
    const binding = (node: ts.Node): node is ts.Identifier =>
        ts.isIdentifier(node) && isValueReference(node);
    const collect = (node: ts.Node, roots: Set<ts.Symbol>): void => {
        if (binding(node)) {
            const symbol = declaredSymbol(context.checker, node);
            if (symbol) roots.add(symbol);
        }
        ts.forEachChild(node, (child) => collect(child, roots));
    };
    const roots = new Set<ts.Symbol>();
    for (const test of [
        ...groups
            .map((group) => group.test)
            .filter((test) => !unchanging.has(test)),
        ...records.map((record) => record.nodes[0]!),
    ]) {
        if (context.evaluationOrder.writesStorage(test)) return undefined;
        collect(test, roots);
    }
    // A binding handed by value (a string, a boolean) is no way to change
    // what it holds.
    const receivesRoot = (node: ts.Node, roots: Set<ts.Symbol>): boolean =>
        (binding(node) &&
            roots.has(declaredSymbol(context.checker, node)!) &&
            typeCanCarryReference(context.checker.getTypeAtLocation(node)) &&
            // A member read hands over its value, not the binding.
            !(
                ts.isPropertyAccessExpression(node.parent) &&
                node.parent.expression === node &&
                !typeCanCarryReference(
                    context.checker.getTypeAtLocation(node.parent),
                )
            )) ||
        (ts.forEachChild(node, (child) => receivesRoot(child, roots)) ?? false);
    const handsRoot = (roots: Set<ts.Symbol>): boolean =>
        calls.some((inner) =>
            inner.arguments.some((argument) => receivesRoot(argument, roots)),
        );
    if (handsRoot(roots)) return undefined;
    // A constant test rules the split out as any test does: where it
    // writes, or an argument's call receives a binding it reads.
    for (const { node } of candidates) {
        const read = new Set<ts.Symbol>();
        collect(node, read);
        if (
            (context.evaluationOrder.writesStorage(node) || handsRoot(read)) &&
            constantsOf(node)
        )
            return undefined;
    }
    return {
        groups: () => {
            let inserted = 0;
            for (const { node, index } of candidates.splice(0)) {
                const constants = constantsOf(node);
                if (!constants || decided(node)) continue;
                const group = groups.find(
                    (candidate) =>
                        candidate.kind === "constant" &&
                        sameExpression(context.checker, candidate.test, node),
                );
                if (group) group.nodes.push(node);
                else
                    groups.splice(index + inserted++, 0, {
                        kind: "constant",
                        test: node,
                        nodes: [node],
                        outcomes: constants.map((row) => ({ row })),
                    });
            }
            return groups;
        },
        records,
    };
}

/**
 * The records a run-time object of a type of few-valued members can be where
 * no constant bounds it (`selectedModuleConstants`): every combination of
 * its members' values (`finiteScalarValues`), read from the object itself.
 * Undefined for a member of another type, or past `MAX_ARMS` combinations.
 */
function typeRows(
    context: CaseSplitContext,
    node: ts.Expression,
): readonly HeldRow[] | undefined {
    const { checker } = context;
    const properties = checker.getPropertiesOfType(
        checker.getNonNullableType(checker.getTypeAtLocation(node)),
    );
    if (properties.length === 0) return undefined;
    let rows: HeldRow[] = [{ base: node, overrides: new Map() }];
    for (const property of properties) {
        const values = finiteScalarValues(
            checker.getTypeOfSymbolAtLocation(property, node),
        );
        if (!values) return undefined;
        rows = rows.flatMap((row) =>
            values.map((value) => ({
                base: node,
                overrides: new Map([...row.overrides, [property.name, value]]),
            })),
        );
        if (rows.length > MAX_ARMS) return undefined;
    }
    return rows;
}

/** The compile-time record a name holds, while its facts are current. */
function heldRecord(
    context: CaseSplitContext,
    name: ts.Identifier,
): Value | undefined {
    const held = context.bindings.lookupOptional(name);
    return held?.kind === "record" &&
        held.recordProperties &&
        context.bindings.recordPropertiesAreCurrent(held)
        ? held
        : undefined;
}

/**
 * The members of a few outcomes of the record an argument names, and of
 * the records nested in it, as selectors.
 */
function recordMemberSelectors(
    context: CaseSplitContext,
    { nodes, type }: RecordArgument,
): Selector[] {
    const node = nodes[0]!;
    const selectors: Selector[] = [];
    const members = (
        record: Value | undefined,
        recordType: ts.Type,
        path: readonly string[],
    ): void => {
        for (const [key, member] of Object.entries(
            record?.recordProperties ?? {},
        )) {
            const property = context.checker.getPropertyOfType(recordType, key);
            if (!property) continue;
            const memberType = context.checker.getTypeOfSymbolAtLocation(
                property,
                node,
            );
            const kind = selectorKind(memberType);
            const below = [...path, key];
            if (kind)
                selectors.push({
                    kind,
                    test: node,
                    nodes,
                    outcomes: kindOutcomes(kind, memberType),
                    member: {
                        path: below,
                        type: memberType,
                        present:
                            kind === "presence"
                                ? unlessRefused(() =>
                                      context.dataTypes.fromTsType(
                                          context.checker.getNonNullableType(
                                              memberType,
                                          ),
                                          node,
                                      ),
                                  )
                                : undefined,
                    },
                });
            else if (
                below.length < MAX_MEMBER_DEPTH &&
                member.kind === "record" &&
                context.bindings.recordPropertiesAreCurrent(member)
            )
                members(member, memberType, below);
        }
    };
    members(heldRecord(context, node), type, []);
    return selectors;
}

/** Whether an expression holds a selection a split reads as its own test. */
function containsSelection(node: ts.Node): boolean {
    return someAnalysisNode(node, ts.isConditionalExpression, {
        functions: "skip",
    });
}

/**
 * The tests that stay runtime ones. A value
 * the callee would read from run-time storage is forced even where
 * generation knows its truth: then only the outcomes that truth allows
 * remain (a falsy optional boolean is `false` or absent).
 */
function runtimeSelectors(
    context: CaseSplitContext,
    groups: readonly Selector[],
): RuntimeSelectors | undefined {
    const fixed: Selector[] = [];
    const variable: Selector[] = [];
    // A record is read once for all of its members.
    const read = new Map<ts.Expression, Value | undefined>();
    const valueOf = (group: Selector): Value | undefined => {
        if (!read.has(group.test))
            read.set(
                group.test,
                // The discarded probe undoes what lowering wrote on the
                // value; a copy keeps what generation knew of it.
                context.probeEmission(
                    () => ({ ...context.compileValue(group.test) }),
                    () => false,
                ),
            );
        return context.bindings.currentRecordMember(
            read.get(group.test),
            group.member?.path ?? [],
        );
    };
    for (const group of groups) {
        const value = group.kind === "condition" ? undefined : valueOf(group);
        if (group.kind === "literal") {
            if (value && !staticArgument(value) && literalStorage(value))
                variable.push(group);
            continue;
        }
        if (group.kind === "variant") {
            if (
                !value ||
                !holdsMaterial(value) ||
                value.sceneShaderVariant !== undefined
            )
                continue;
            // With no variant created yet the call takes no arm: a later
            // creation restarts lowering with it (`ShaderCreationsRequired`),
            // and with none the call's refusal stands (`refuseUncreated`).
            const variants =
                value.possibleSceneShaderVariants ??
                runtimeShaderVariants(context);
            variable.push({
                ...group,
                outcomes: variants.map((variant) => ({ variant })),
            });
            continue;
        }
        if (group.kind === "constant") {
            const resolved =
                value && !staticArgument(value)
                    ? constantSelector(context, group, value)
                    : undefined;
            if (resolved)
                (resolved.outcomes.length === 1 ? fixed : variable).push(
                    resolved,
                );
            continue;
        }
        const truth = knownCondition(
            group.member
                ? value && context.dataLowerer.truthinessCondition(value)
                : context.probeEmission(
                      () => context.conditions.compileCondition(group.test),
                      () => false,
                  ),
        );
        if (group.kind !== "condition") {
            if (!value || staticArgument(value)) continue;
        } else if (truth !== undefined) continue;
        const outcomes =
            truth === undefined
                ? group.outcomes
                : group.outcomes.filter(
                      (outcome) => (outcome === "truthy") === truth,
                  );
        (outcomes.length === 1 ? fixed : variable).push({
            ...group,
            outcomes,
        });
    }
    return fixed.length > 0 || variable.length > 0
        ? { fixed, variable }
        : undefined;
}

/**
 * A constant test as its arms read it: each row's value with the members
 * generation knows (its overrides applied), rows that read the same as one,
 * and the string and boolean members of the run-time object `value`'s
 * storage that, read in member order while they tell more apart, tell every
 * two rows apart. Undefined when generation knows no row's members, or two
 * left read the same.
 */
function constantSelector(
    context: CaseSplitContext,
    selector: Selector,
    value: Value,
): Selector | undefined {
    const outcomes: ConstantOutcome[] = [];
    for (const outcome of selector.outcomes) {
        if (typeof outcome !== "object" || !("row" in outcome))
            return undefined;
        // The discarded probe undoes what reading the reference wrote; a
        // copy keeps what generation knows of the constant there.
        const read = unlessRefused(() =>
            context.probeEmission(
                () => ({ ...context.compileValue(outcome.row.base) }),
                () => false,
            ),
        );
        if (!read) return undefined;
        // A row of the run-time object itself (`typeRows`) gives every
        // member; another reads its constant's members as generation knows
        // them.
        const known =
            read.recordProperties &&
            context.bindings.recordPropertiesAreCurrent(read)
                ? read.recordProperties
                : undefined;
        if (!known && outcome.row.base !== selector.test) return undefined;
        const properties = { ...known };
        for (const [key, member] of outcome.row.overrides)
            properties[key] =
                typeof member === "boolean"
                    ? booleanValue(member ? "true" : "false")
                    : {
                          kind: "string",
                          cpp: context.cppString(member),
                          staticString: member,
                      };
        // A member a known row does not own (its data keys are its own,
        // \`recordPropertyKeys\`) reads undefined, as in JavaScript.
        if (known)
            for (const property of context.checker.getPropertiesOfType(
                context.checker.getNonNullableType(
                    context.checker.getTypeAtLocation(selector.test),
                ),
            ))
                if (
                    properties[property.name] === undefined &&
                    !read.recordMethods?.[property.name] &&
                    !read.recordGetters?.[property.name]
                )
                    properties[property.name] = undefinedValue();
        const record: Value = { ...read };
        writable(record).recordProperties = properties;
        // Rows that read the same are one outcome.
        if (!outcomes.some((other) => sameScalars(other.record!, record)))
            outcomes.push({ row: outcome.row, record });
    }
    const text = (
        outcome: ConstantOutcome,
        key: string,
    ): string | boolean | undefined => scalar(outcome.record!, key);
    // The pairs no discriminant tells apart yet; each member, in order,
    // joins the discriminants when it tells one of them apart.
    let pairs = outcomes.flatMap((left, index) =>
        outcomes.slice(index + 1).map((right) => [left, right] as const),
    );
    const discriminants: string[] = [];
    for (const key of Object.keys(outcomes[0]!.record!.recordProperties!)) {
        const stored = context.dataLowerer.storedFieldRead(
            value,
            key,
            selector.test,
        );
        if (
            !stored ||
            !(literalStorage(stored) || booleanStorage(stored)) ||
            outcomes.some((outcome) => text(outcome, key) === undefined)
        )
            continue;
        const rest = pairs.filter(
            ([left, right]) => text(left, key) === text(right, key),
        );
        if (rest.length === pairs.length) continue;
        discriminants.push(key);
        pairs = rest;
    }
    const told = pairs.length === 0;
    return told ? { ...selector, outcomes, discriminants } : undefined;
}

/** A record member generation knows as a string or a boolean. */
function scalar(record: Value, key: string): string | boolean | undefined {
    const member = record.recordProperties?.[key];
    return member?.staticString ?? member?.staticBoolean;
}

/** Whether two records' members read the same strings and booleans, member for member. */
function sameScalars(left: Value, right: Value): boolean {
    const keys = Object.keys(left.recordProperties ?? {});
    return (
        keys.length === Object.keys(right.recordProperties ?? {}).length &&
        keys.every(
            (key) =>
                scalar(left, key) !== undefined &&
                scalar(left, key) === scalar(right, key),
        )
    );
}

/** A boolean member's storage, which a constant test reads as it is. */
function booleanStorage(value: Value): boolean {
    return value.kind === "boolean" || value.dataType?.kind === "boolean";
}

/** A literal test's storage, which its arms compare: a string or a native enum. */
function literalStorage(value: Value): boolean {
    return (
        isStringValue(value) ||
        value.dataType?.kind === "string" ||
        value.dataType?.kind === "enum"
    );
}

/** Whether an argument value already reads as a constant: a known boolean or string, an absence, a record. */
function staticArgument(value: Value): boolean {
    return (
        value.staticBoolean !== undefined ||
        value.staticString !== undefined ||
        isAbsentValue(value) ||
        knownAbsent(value) ||
        (value.kind === "record" && presenceCpp(value) === undefined)
    );
}

function splitCall(
    context: CaseSplitContext,
    call: ts.CallExpression,
    fixed: readonly Selector[],
    selectors: readonly Selector[],
    compile: () => Value | undefined,
): Value | undefined {
    // With no run-time test left there is one arm: the call itself, every
    // fixed outcome forced, its value as it compiles.
    if (selectors.length === 0)
        return withOutcomes(context, fixed, [], [], compile);
    // Each selector's tests, read once before the call: its truth, and an
    // optional boolean's presence.
    const pin = (initializer: string): string => {
        const name = context.allocateTemporaryCppName("case_test");
        context.emit({
            kind: "declaration",
            type: "const bool",
            name,
            initializer,
        });
        return name;
    };
    const tests = selectors.map(
        (
            selector,
        ):
            | {
                  truth?: string;
                  presence?: string;
                  literal?: (text: string) => string;
                  constant?: (outcome: ConstantOutcome) => string;
                  variant?: (outcome: VariantOutcome) => string;
              }
            | undefined => {
            if (selector.kind === "variant") {
                // The arm a variant takes, from the generated table of
                // the variants the split compiled (`derived_shader_variant_<site>`).
                const value = selectorValue(context, selector);
                if (!value) return undefined;
                const arms = selector.outcomes.map((outcome) =>
                    typeof outcome === "object" && "variant" in outcome
                        ? outcome.variant
                        : "",
                );
                const name = context.allocateTemporaryCppName("case_arm");
                context.emit({
                    kind: "declaration",
                    type: "const std::uint32_t",
                    name,
                    initializer:
                        context.sceneManifest.shaderDerivations.derivedVariantCpp(
                            undefined,
                            new Map(
                                arms.map((variant, arm) => [
                                    context.sceneManifest.reachedShaderPrograms.findIndex(
                                        (program) => program.name === variant,
                                    ),
                                    arm,
                                ]),
                            ),
                            `bbl::shader_material_variant(${context.requireEngine(value, selector.test)}, ${value.cpp})`,
                        ),
                });
                return {
                    variant: (outcome) =>
                        `${name} == ${arms.indexOf(outcome.variant)}u`,
                };
            }
            if (selector.kind === "literal") {
                const value = selectorValue(context, selector);
                if (!value || !literalStorage(value)) return undefined;
                const name = context.allocateTemporaryCppName("case_value");
                context.emit({
                    kind: "declaration",
                    type: "const auto",
                    name,
                    initializer: value.cpp,
                });
                return {
                    literal: (text) =>
                        context.dataLowerer.literalEquality(
                            name,
                            value.dataType,
                            text,
                            selector.test,
                        ),
                };
            }
            if (selector.kind === "constant") {
                // The object is the constant whose discriminants it holds.
                const value = selectorValue(context, selector);
                if (!value) return undefined;
                const name = context.allocateTemporaryCppName("case_value");
                context.emit({
                    kind: "declaration",
                    type: "const auto&",
                    name,
                    initializer: value.cpp,
                });
                const reads = (selector.discriminants ?? []).map((key) => ({
                    key,
                    read: context.dataLowerer.storedFieldRead(
                        { ...value, cpp: name },
                        key,
                        selector.test,
                    ),
                }));
                if (
                    reads.some(
                        ({ read }) =>
                            !read ||
                            !(literalStorage(read) || booleanStorage(read)),
                    )
                )
                    return undefined;
                return {
                    constant: (outcome) =>
                        reads
                            .map(({ key, read }) => {
                                const expected = scalar(outcome.record!, key)!;
                                return typeof expected === "boolean"
                                    ? `${expected ? "" : "!"}(${read!.cpp})`
                                    : context.dataLowerer.literalEquality(
                                          read!.cpp,
                                          read!.dataType,
                                          expected,
                                          selector.test,
                                      );
                            })
                            .join(" && "),
                };
            }
            if (selector.kind !== "optional-boolean" && !selector.member)
                return {
                    truth: pin(
                        context.conditions.compileCondition(selector.test),
                    ),
                };
            const value = selectorValue(context, selector);
            if (!value) return undefined;
            if (selector.kind !== "optional-boolean") {
                // A member's truth; an object's is its presence.
                const read =
                    (selector.kind === "presence"
                        ? presenceCpp(value)
                        : undefined) ??
                    context.dataLowerer.truthinessCondition(value);
                return read === undefined ? undefined : { truth: pin(read) };
            }
            const present = presenceCpp(value);
            const truth = context.dataLowerer.truthinessCondition(
                context.dataLowerer.narrowOptional(value, selector.test, true),
            );
            if (present === undefined || truth === undefined) return undefined;
            const presence = pin(present);
            // A falsy optional boolean's arms tell false from absent by
            // presence alone.
            return {
                presence,
                ...(selector.outcomes.includes("truthy")
                    ? { truth: pin(`${presence} && ${truth}`) }
                    : {}),
            };
        },
    );
    if (tests.some((test) => test === undefined)) return undefined;
    const resultTsType = context.checker.getTypeAtLocation(call);
    // A call whose value goes nowhere merges none from its arms.
    const valueless =
        isVoid(resultTsType) || valueUse(call).kind === "discarded";
    const resultType = valueless
        ? undefined
        : context.dataTypes.fromTsType(resultTsType, call);
    if (resultType === undefined && !valueless) return undefined;
    const result = resultType && {
        name: context.allocateTemporaryCppName("case_result"),
        type: resultType,
    };
    if (result)
        context.emit({
            kind: "declaration",
            type: context.dataTypes.cppType(result.type),
            name: result.name,
            initializer: "",
            initialization: "default",
        });
    const arm = (outcomes: readonly Outcome[]): void => {
        const value = withOutcomes(
            context,
            fixed,
            selectors,
            outcomes,
            compile,
        );
        if (!value) throw new CompileError("", 0, 0, "unanswered");
        // An arm whose call never completes normally (its body throws for
        // that outcome) stores no result.
        if (value.kind === "void" && value.abruptCompletion)
            context.emitDiscardedValue(value);
        else if (result)
            context.emit({
                kind: "expression",
                code: `${result.name} = ${context.dataLowerer.compileKnownValueForSink(value, result.type, call)};`,
            });
        else context.emitDiscardedValue(value);
    };
    const branch = (depth: number, outcomes: Outcome[]): void => {
        if (depth === selectors.length) {
            arm(outcomes);
            return;
        }
        const test = tests[depth]!;
        const selector = selectors[depth]!;
        // No variant created yet: the variant table, read above, throws
        // before any arm (`refuseWithoutCreations`).
        if (selector.outcomes.length === 0) return;
        // Truth is the truth test; an optional boolean's falsy one its
        // presence (after truth, false); the last outcome is the rest.
        const guard = (outcome: Outcome): string =>
            typeof outcome === "object"
                ? "literal" in outcome
                    ? test.literal!(outcome.literal)
                    : "variant" in outcome
                      ? test.variant!(outcome)
                      : test.constant!(outcome)
                : outcome === "truthy"
                  ? test.truth!
                  : test.presence!;
        selector.outcomes.forEach((outcome, index) => {
            const last = index === selector.outcomes.length - 1;
            context.emit(
                index === 0
                    ? { kind: "open", code: `if (${guard(outcome)}) {` }
                    : last
                      ? { kind: "branch", code: "} else {" }
                      : {
                            kind: "branch",
                            code: `} else if (${guard(outcome)}) {`,
                        },
            );
            context.increaseIndent();
            branch(depth + 1, [...outcomes, outcome]);
            context.decreaseIndent();
        });
        context.emit({ kind: "close", code: "}" });
    };
    context.enterRuntimeControlFlow();
    try {
        branch(0, []);
    } finally {
        context.leaveRuntimeControlFlow();
    }
    return result
        ? context.dataLowerer.leafValue(result.name, result.type)
        : { kind: "void", cpp: "" };
}
