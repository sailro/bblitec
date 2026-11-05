import ts from "typescript";
import { CompileError } from "./compile-error.js";
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
    isSuspensionPoint,
    isValueReference,
    writeSites,
} from "./syntax.js";
import {
    knownCondition,
    presenceCpp,
    undefinedValue,
} from "./values/model.js";

type CaseSplitContext = Pick<
    LoweringServices,
    | "allocateTemporaryCppName"
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

/**
 * Compiles a local function call whose arguments pick between values with a
 * runtime test (`f({...(c ? a : {})})`), or pass a value of a few outcomes (a
 * boolean, an optional object present or absent), once per outcome when the
 * single compilation refuses: a callee that specializes on its argument (a
 * shader composed from options) then sees each outcome as a constant. The
 * test is read once, before the call, which is where JavaScript reads it
 * unless an argument evaluated earlier could change it; so every test is
 * free of writes, no argument assigns or constructs, and an argument's calls
 * go to module-level functions that receive none of the bindings the tests
 * read (such a function reaches a local binding only through its
 * arguments). With more than two tests, the call splits only on those whose
 * staying a runtime test, with every other test fixed, still refuses.
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
        const candidates = runtimeSelectors(context, tests);
        if (candidates === undefined) throw error;
        const selectors = dependedSelectors(context, candidates, compile);
        if (selectors === undefined) throw error;
        const split = context.probeEmission(
            () => {
                try {
                    return splitCall(context, call, selectors, compile);
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

/** A refusal, or a storage or realm restart one outcome may not need. */
function refusesPerOutcome(error: unknown): boolean {
    return (
        error instanceof CompileError ||
        error instanceof StorageDemand ||
        error instanceof ApplicationRealmRequired
    );
}

/**
 * One runtime test: the node read once, and every node spelling it. A
 * `condition` is a selection's test; a `boolean` an argument value that is a
 * boolean; a `presence` an argument value that is an object or one absence
 * (`undefined` or `null`); an `optional-boolean` a boolean or one absence.
 * Outcome 0 is true (present), 1 false (absent), 2 an optional boolean's
 * absence.
 */
interface Selector {
    kind: "condition" | "boolean" | "presence" | "optional-boolean";
    test: ts.Expression;
    nodes: readonly ts.Expression[];
}

/** The outcome that stands for "false" in a dependency probe. */
const FALSE_OUTCOME = 1;

function outcomeCount(selector: Selector): number {
    return selector.kind === "optional-boolean" ? 3 : 2;
}

/** Compiles `compile` with each selector forced to its outcome (`undefined` leaves it runtime). */
function withOutcomes<T>(
    context: CaseSplitContext,
    selectors: readonly Selector[],
    outcomes: readonly (number | undefined)[],
    compile: () => T,
): T {
    selectors.forEach((selector, index) => {
        const outcome = outcomes[index];
        if (outcome === undefined) return;
        for (const node of selector.nodes) {
            if (selector.kind === "condition")
                context.conditionOverrides.set(node, outcome === 0);
            else
                context.valueOverrides.set(
                    node,
                    forcedValue(context, selector, node, outcome),
                );
        }
    });
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
 * The value an argument selector takes in one arm: the boolean, the
 * absence its type has, or the value itself, narrowed to present (the arm
 * runs only where its test found it).
 */
function forcedValue(
    context: CaseSplitContext,
    selector: Selector,
    node: ts.Expression,
    outcome: number,
): Value {
    const absent = (): Value =>
        nullability(context.checker.getTypeAtLocation(node)).null
            ? { kind: "json-null", cpp: "" }
            : undefinedValue();
    // A present object is truthy and present wherever the arm reads it.
    if (selector.kind === "presence")
        return outcome === 0
            ? {
                  ...context.dataLowerer.narrowOptional(
                      context.compileValue(node),
                      node,
                      true,
                  ),
                  truthinessCpp: "true",
                  optionalFoundCpp: "true",
              }
            : absent();
    if (outcome === 2) return absent();
    return {
        kind: "boolean",
        cpp: outcome === 0 ? "true" : "false",
        staticBoolean: outcome === 0,
    };
}

/**
 * Whether an argument value is one a split can force: a boolean, or an
 * object or a boolean with one of `undefined` and `null`.
 */
function argumentSelectorKind(
    checker: ts.TypeChecker,
    node: ts.Expression,
): Exclude<Selector["kind"], "condition"> | undefined {
    const type = checker.getTypeAtLocation(node);
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
    candidates: readonly Selector[],
    compile: () => Value | undefined,
): readonly Selector[] | undefined {
    if (candidates.length <= 2) return candidates;
    const refuses = (outcomes: readonly (number | undefined)[]): boolean => {
        try {
            context.probeEmission(
                () => withOutcomes(context, candidates, outcomes, compile),
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
            candidates.map((_, other) =>
                other === index ? undefined : FALSE_OUTCOME,
            ),
        ),
    );
    return depended.length > 0 && depended.length <= MAX_SELECTORS
        ? depended
        : undefined;
}

/** A function declared at a module's top level, directly or through an import. */
function moduleLevelCallee(
    checker: ts.TypeChecker,
    callee: ts.Expression,
): boolean {
    if (!ts.isIdentifier(callee)) return false;
    const declaration = resolvedSymbol(checker, callee)?.valueDeclaration;
    if (!declaration) return false;
    if (ts.isFunctionDeclaration(declaration))
        return ts.isSourceFile(declaration.parent);
    return (
        ts.isVariableDeclaration(declaration) &&
        functionOfDeclaration(declaration) !== undefined &&
        ts.isVariableStatement(declaration.parent.parent) &&
        ts.isSourceFile(declaration.parent.parent.parent)
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
    const groups: {
        kind: Selector["kind"];
        test: ts.Expression;
        nodes: ts.Expression[];
    }[] = [];
    const calls: ts.CallExpression[] = [];
    let effects = false;
    // An argument value of a few outcomes, unless a selection inside it
    // already splits it.
    const valuePosition = (node: ts.Expression): void => {
        const kind = argumentSelectorKind(context.checker, node);
        if (!kind || containsSelection(node)) return;
        const group = groups.find(
            (candidate) =>
                candidate.kind === kind &&
                sameExpression(context.checker, candidate.test, node),
        );
        if (group) group.nodes.push(node);
        else groups.push({ kind, test: node, nodes: [node] });
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
        if (ts.isConditionalExpression(node)) {
            const group = groups.find(
                ({ kind, test }) =>
                    kind === "condition" &&
                    sameExpression(context.checker, test, node.condition),
            );
            if (group) group.nodes.push(node.condition);
            else
                groups.push({
                    kind: "condition",
                    test: node.condition,
                    nodes: [node.condition],
                });
        }
        if (ts.isPropertyAssignment(node)) valuePosition(node.initializer);
        if (ts.isShorthandPropertyAssignment(node)) valuePosition(node.name);
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
    return (
        ts.isConditionalExpression(node) ||
        (!ts.isFunctionLike(node) &&
            (ts.forEachChild(node, containsSelection) ?? false))
    );
}

/** The tests that stay runtime ones, when few enough to split on. */
function runtimeSelectors(
    context: CaseSplitContext,
    groups: readonly Selector[],
): readonly Selector[] | undefined {
    const runtime = groups.filter(({ test }) => {
        const folded = context.probeEmission(
            () => context.conditions.compileCondition(test),
            () => false,
        );
        return knownCondition(folded) === undefined;
    });
    return runtime.length > 0 && runtime.length <= MAX_CANDIDATE_SELECTORS
        ? runtime
        : undefined;
}

function splitCall(
    context: CaseSplitContext,
    call: ts.CallExpression,
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
    const tests = selectors.map((selector) => {
        if (selector.kind !== "optional-boolean")
            return { truth: pin(context.conditions.compileCondition(selector.test)) };
        const value = context.compileValue(selector.test);
        const present = presenceCpp(value);
        const truth = context.dataLowerer.truthinessCondition(
            context.dataLowerer.narrowOptional(value, selector.test, true),
        );
        if (present === undefined || truth === undefined) return undefined;
        const presence = pin(present);
        return { presence, truth: pin(`${presence} && ${truth}`) };
    });
    if (tests.some((test) => test === undefined)) return undefined;
    const resultTsType = context.checker.getTypeAtLocation(call);
    const resultType = isVoid(resultTsType)
        ? undefined
        : context.dataTypes.fromTsType(resultTsType, call);
    if (resultType === undefined && !isVoid(resultTsType)) return undefined;
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
    const arm = (outcomes: readonly number[]): void => {
        const value = withOutcomes(context, selectors, outcomes, compile);
        if (!value) throw new CompileError("", 0, 0, "unanswered");
        if (result)
            context.emit({
                kind: "expression",
                code: `${result.name} = ${context.dataLowerer.compileKnownValueForSink(value, result.type, call)};`,
            });
        else context.emitDiscardedValue(value);
    };
    const branch = (depth: number, outcomes: number[]): void => {
        if (depth === selectors.length) {
            arm(outcomes);
            return;
        }
        const test = tests[depth]!;
        const guards = test.presence
            ? [test.truth, test.presence]
            : [test.truth];
        // `if (truth) {0} else if (presence) {1} else {2}`.
        for (let outcome = 0; outcome < outcomeCount(selectors[depth]!); outcome++) {
            const guard = guards[outcome];
            context.emit(
                outcome === 0
                    ? { kind: "open", code: `if (${guard}) {` }
                    : guard
                      ? { kind: "branch", code: `} else if (${guard}) {` }
                      : { kind: "branch", code: "} else {" },
            );
            context.increaseIndent();
            branch(depth + 1, [...outcomes, outcome]);
            context.decreaseIndent();
        }
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
