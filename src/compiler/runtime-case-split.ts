import ts from "typescript";
import { someAnalysisNode } from "./analysis-walk.js";
import { CompileError } from "./compile-error.js";
import { writable } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import { declaredSymbol, resolvedSymbol, sameExpression } from "./symbols.js";
import { StorageDemand } from "./storage-demand.js";
import {
    typeCanCarryReference,
    isVoid,
    nullability,
    holdsOnly,
    objectLikeType,
    presentMembers,
} from "./type-facts.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import type { Value } from "./types.js";
import {
    functionOfDeclaration,
    isModuleScopeFunction,
    isSuspensionPoint,
    isValueReference,
    valueUse,
    writeSites,
} from "./syntax.js";
import {
    isAbsentValue,
    knownCondition,
    nullValue,
    presenceCpp,
    undefinedValue,
} from "./values/model.js";

type CaseSplitContext = Pick<
    LoweringServices,
    | "allocateTemporaryCppName"
    | "bindings"
    | "checker"
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
    | "leaveRuntimeControlFlow"
    | "probeEmission"
>;

/** At most this many distinct runtime tests split one call (2^n arms). */
const MAX_SELECTORS = 4;
/** More tests than this are not probed for the ones the call depends on. */
const MAX_CANDIDATE_SELECTORS = 8;
/** A member this deep below a record an argument names still selects. */
const MAX_MEMBER_DEPTH = 2;

/**
 * Compiles a local function call whose arguments pick between values with a
 * runtime test (`f({...(c ? a : {})})`), or pass a value of a few outcomes (a
 * boolean, an optional object present or absent), itself or as a member of a
 * record an argument names (`f(options)`), once per outcome when the single
 * compilation refuses: a callee that specializes on its argument (a shader
 * composed from options) then sees each outcome as a constant. The
 * test is read once, before the call, which is where JavaScript reads it
 * unless an argument evaluated earlier could change it; so every test is
 * free of writes, no argument assigns or constructs, and an argument's calls
 * go to module-level functions that receive none of the bindings the tests
 * read (such a function reaches a local binding only through its
 * arguments). With more than two tests, the call splits only on those whose
 * staying a runtime test, with every other test fixed, still refuses; a call
 * that depends on more than `MAX_SELECTORS`, or reads more than
 * `MAX_CANDIDATE_SELECTORS`, keeps its refusal, which then says so.
 */
export function compileWithRuntimeCaseSplit(
    context: CaseSplitContext,
    call: ts.CallExpression,
    compile: () => Value | undefined,
): Value | undefined {
    const tests = selectorTests(context, call);
    if (tests === undefined) return compile();
    try {
        return context.probeEmission(compile, () => true);
    } catch (error) {
        // A storage demand is the unsplit call asking for dynamic storage
        // the runtime test forced; per outcome it may not be needed, so it
        // stands only when the split fails too.
        if (!refusesPerOutcome(error)) throw error;
        // Which tests stay runtime ones is asked only of a call that refused.
        const runtime = runtimeSelectors(context, tests);
        if (runtime === undefined) throw error;
        if (runtime.variable.length > MAX_CANDIDATE_SELECTORS)
            throw beyondSplit(error, runtime.variable, MAX_CANDIDATE_SELECTORS);
        const selectors = dependedSelectors(context, runtime, compile);
        if (selectors === undefined) throw error;
        if (selectors.length > MAX_SELECTORS)
            throw beyondSplit(error, selectors, MAX_SELECTORS);
        const split = context.probeEmission(
            () => {
                try {
                    return splitCall(
                        context,
                        call,
                        runtime.fixed,
                        selectors,
                        compile,
                    );
                } catch (inner) {
                    // An arm's own storage demand restarts generation with
                    // it satisfied, after which the split can succeed.
                    if (inner instanceof CompileError) return undefined;
                    throw inner;
                }
            },
            (result) => result !== undefined,
        );
        if (split) return split;
        throw error;
    }
}

/**
 * The refusal of a call a split could not reach: its own text, then the
 * run-time tests that exceeded `limit`. A restart stands as it is.
 */
function beyondSplit(
    error: unknown,
    tests: readonly Selector[],
    limit: number,
): unknown {
    if (!(error instanceof CompileError)) return error;
    const names = tests.map((test) =>
        [test.test.getText(), ...(test.member ?? [])].join("."),
    );
    return new CompileError(
        error.fileName,
        error.line,
        error.column,
        `${error.detail} The call compiles once per outcome of at most ${limit} run-time tests; it reads ${tests.length}: ${names.join(", ")}.`,
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

/** What a test reads as in one arm: true (a present object), false, or absent. */
type Outcome = "truthy" | "falsy" | "absent";

/**
 * One runtime test: the node read once, and every node spelling it. A
 * `condition` is a selection's test; a `boolean` an argument value that is a
 * boolean; a `presence` an argument value that is an object or one absence
 * (`undefined` or `null`); an `optional-boolean` a boolean or one absence.
 * `outcomes` are the ones the value can take. With `member`, the value is
 * the member at that key path of the record `test` names, of `memberType`.
 */
interface Selector {
    kind: "condition" | "boolean" | "presence" | "optional-boolean";
    test: ts.Expression;
    nodes: readonly ts.Expression[];
    outcomes: readonly Outcome[];
    member?: readonly string[];
    memberType?: ts.Type;
}

/** Every outcome a test of `kind` can take. */
const KIND_OUTCOMES: Readonly<Record<Selector["kind"], readonly Outcome[]>> = {
    condition: ["truthy", "falsy"],
    boolean: ["truthy", "falsy"],
    presence: ["truthy", "absent"],
    "optional-boolean": ["truthy", "falsy", "absent"],
};

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
            if (selector.kind === "condition")
                context.conditionOverrides.set(node, outcome === "truthy");
            else if (selector.member)
                records.set(
                    node,
                    withForcedMember(
                        context,
                        selector,
                        node,
                        records.get(node) ?? context.compileValue(node),
                        selector.member,
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
    // A present object is truthy and present wherever the arm reads it.
    if (selector.kind === "presence")
        return outcome === "truthy"
            ? {
                  ...context.dataLowerer.narrowOptional(
                      read(),
                      node,
                      true,
                      selector.member &&
                          context.dataTypes.fromTsType(
                              context.checker.getNonNullableType(type),
                              node,
                          ),
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

/**
 * `record` with the member at `path` forced to a selector's outcome in one
 * arm. A key a conditional spread wrote is own only where the arm found it.
 */
function withForcedMember(
    context: CaseSplitContext,
    selector: Selector,
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
                  selector.memberType!,
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
    let value: Value | undefined = context.compileValue(selector.test);
    for (const key of selector.member ?? [])
        value =
            value && context.bindings.recordPropertiesAreCurrent(value)
                ? value.recordProperties?.[key]
                : undefined;
    return value;
}

/**
 * Whether a value of `type` is one a split can force: a boolean, or an
 * object or a boolean with one of `undefined` and `null`.
 */
function selectorKind(
    type: ts.Type,
): Exclude<Selector["kind"], "condition"> | undefined {
    if (holdsOnly(type, ["boolean"])) return "boolean";
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
    { fixed, variable: candidates }: RuntimeSelectors,
    compile: () => Value | undefined,
): readonly Selector[] | undefined {
    if (candidates.length <= 2) return candidates;
    const refuses = (outcomes: readonly (Outcome | undefined)[]): boolean => {
        try {
            context.probeEmission(
                () =>
                    withOutcomes(context, fixed, candidates, outcomes, compile),
                () => false,
            );
            return false;
        } catch (error) {
            // A storage or realm demand restarts generation with it held,
            // as an arm's does; the probe then answers on the next attempt.
            if (error instanceof CompileError) return true;
            throw error;
        }
    };
    const depended = candidates.filter((_, index) =>
        refuses(
            candidates.map((candidate, other) =>
                other === index ? undefined : falseOutcome(candidate),
            ),
        ),
    );
    return depended.length > 0 ? depended : undefined;
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
 * spelling it, when the call can be split on them: no argument assigns,
 * constructs or suspends, its calls go to module-level functions handed
 * none of the bindings the tests read, and no test writes.
 */
function selectorTests(
    context: CaseSplitContext,
    call: ts.CallExpression,
): Selector[] | undefined {
    // Each distinct test with every place it appears.
    const groups: (Selector & { nodes: ts.Expression[] })[] = [];
    const addGroup = (
        kind: Selector["kind"],
        test: ts.Expression,
        member?: { path: readonly string[]; type: ts.Type },
    ): void => {
        const group = groups.find(
            (candidate) =>
                candidate.kind === kind &&
                candidate.member?.join(".") === member?.path.join(".") &&
                sameExpression(context.checker, candidate.test, test),
        );
        if (group) group.nodes.push(test);
        else
            groups.push({
                kind,
                test,
                nodes: [test],
                outcomes: KIND_OUTCOMES[kind],
                ...(member
                    ? { member: member.path, memberType: member.type }
                    : {}),
            });
    };
    const calls: ts.CallExpression[] = [];
    let effects = false;
    // The members of a few outcomes of a record a name holds, and of the
    // records nested in it.
    const recordMembers = (
        node: ts.Identifier,
        record: Value,
        type: ts.Type,
        path: readonly string[],
    ): void => {
        if (
            record.kind !== "record" ||
            !record.recordProperties ||
            !context.bindings.recordPropertiesAreCurrent(record)
        )
            return;
        for (const [key, member] of Object.entries(record.recordProperties)) {
            const property = context.checker.getPropertyOfType(type, key);
            if (!property) continue;
            const memberType = context.checker.getTypeOfSymbolAtLocation(
                property,
                node,
            );
            const kind = selectorKind(memberType);
            if (kind)
                addGroup(kind, node, {
                    path: [...path, key],
                    type: memberType,
                });
            else if (path.length + 1 < MAX_MEMBER_DEPTH)
                recordMembers(node, member, memberType, [...path, key]);
        }
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
        } else if (ts.isIdentifier(node)) {
            const record = context.bindings.lookupOptional(node);
            if (record) recordMembers(node, record, type, []);
        }
    };
    const visit = (node: ts.Node): void => {
        if (effects || ts.isFunctionLike(node)) return;
        if (ts.isCallExpression(node)) {
            if (!moduleLevelCallee(context.checker, node.expression)) {
                effects = true;
                return;
            }
            calls.push(node);
        } else if (
            ts.isNewExpression(node) ||
            ts.isTaggedTemplateExpression(node) ||
            isSuspensionPoint(node, { yield: true }) ||
            writeSites(node).length > 0
        ) {
            effects = true;
            return;
        }
        if (ts.isConditionalExpression(node))
            addGroup("condition", node.condition);
        if (ts.isPropertyAssignment(node)) valuePosition(node.initializer);
        if (ts.isShorthandPropertyAssignment(node)) valuePosition(node.name);
        if (ts.isSpreadAssignment(node)) valuePosition(node.expression);
        ts.forEachChild(node, visit);
    };
    call.arguments.forEach((argument) => {
        valuePosition(argument);
        visit(argument);
    });
    if (effects || groups.length === 0) return undefined;
    // The bindings the tests read; no call in the arguments may receive one.
    const roots = new Set<ts.Symbol>();
    const binding = (node: ts.Node): node is ts.Identifier =>
        ts.isIdentifier(node) && isValueReference(node);
    const collect = (node: ts.Node): void => {
        if (binding(node)) {
            const symbol = declaredSymbol(context.checker, node);
            if (symbol) roots.add(symbol);
        }
        ts.forEachChild(node, collect);
    };
    for (const { test: condition } of groups) {
        if (context.evaluationOrder.writesStorage(condition)) return undefined;
        collect(condition);
    }
    const receivesRoot = (node: ts.Node): boolean =>
        (binding(node) &&
            roots.has(declaredSymbol(context.checker, node)!) &&
            // A member read hands over its value, not the binding.
            !(
                ts.isPropertyAccessExpression(node.parent) &&
                node.parent.expression === node &&
                !typeCanCarryReference(
                    context.checker.getTypeAtLocation(node.parent),
                )
            )) ||
        (ts.forEachChild(node, receivesRoot) ?? false);
    if (calls.some((inner) => inner.arguments.some(receivesRoot)))
        return undefined;
    return groups;
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
    for (const group of groups) {
        const value =
            group.kind === "condition"
                ? undefined
                : context.probeEmission(
                      () => selectorValue(context, group),
                      () => false,
                  );
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

/** Whether an argument value already reads as a constant: a known boolean, an absence, a record. */
function staticArgument(value: Value): boolean {
    return (
        value.staticBoolean !== undefined ||
        isAbsentValue(value) ||
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
        (selector): { truth?: string; presence?: string } | undefined => {
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
        if (result)
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
        // Truth is the truth test; an optional boolean's falsy one its
        // presence (after truth, false); the last outcome is the rest.
        const guard = (outcome: Outcome): string =>
            outcome === "truthy" ? test.truth! : test.presence!;
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
