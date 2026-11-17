import ts from "typescript";
import { someAnalysisNode } from "./analysis-walk.js";
import { CompileError, unlessRefused } from "./compile-error.js";
import { writable } from "./emission-transaction.js";
import type { DataType } from "./data-types/model.js";
import type { LoweringServices } from "./lowering-services.js";
import { selectedModuleConstants } from "./held-constants.js";
import { declaredSymbol, resolvedSymbol, sameExpression } from "./symbols.js";
import { StorageDemand } from "./storage-demand.js";
import {
    typeCanCarryReference,
    isVoid,
    nullability,
    holdsOnly,
    objectLikeType,
    presentMembers,
    recordObjectType,
    stringLiteralValues,
} from "./type-facts.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import { isStringValue, type Value } from "./types.js";
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
    knownAbsent,
    knownCondition,
    knownPlainData,
    nullValue,
    presenceCpp,
    undefinedValue,
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
    | "leaveRuntimeControlFlow"
    | "probeEmission"
    | "program"
    | "userFunctions"
>;

/** At most this many distinct runtime tests split one call (2^n arms). */
const MAX_SELECTORS = 4;
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
 * module constants (`f(entry.lane ?? DEFAULT_LANE)`), once per outcome when
 * the single compilation refuses: a callee that specializes on its argument
 * (a shader composed from options) then sees each outcome as a constant. The
 * test is read once, before the call, which is where JavaScript reads it
 * unless an argument evaluated earlier could change it; so every test is
 * free of writes, no argument assigns or constructs, and an argument's calls
 * go to module-level functions that receive none of the bindings the tests
 * read (such a function reaches a local binding only through its
 * arguments). With more than two tests, the call splits only on those whose
 * staying a runtime test, with every other test fixed, still refuses; a call
 * that depends on more than `MAX_SELECTORS`, whose tests' outcomes make
 * more than `MAX_ARMS` arms, or that reads more than
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
        // Which members of the records its arguments name select, and
        // which tests stay runtime ones, is asked only of a call that
        // refused. The tests keep the order the arguments spell them in.
        const runtime = runtimeSelectors(
            context,
            [
                ...tests.groups,
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
        const selectors = dependedSelectors(context, runtime, compile);
        if (selectors === undefined) throw error;
        if (selectors.length > MAX_SELECTORS)
            throw beyondSplit(
                error,
                selectors,
                `at most ${MAX_SELECTORS} run-time tests; it reads ${selectors.length}`,
            );
        const arms = selectors.reduce(
            (product, selector) => product * selector.outcomes.length,
            1,
        );
        if (arms > MAX_ARMS)
            throw beyondSplit(
                error,
                selectors,
                `run-time tests in at most ${MAX_ARMS} arms; its tests make ${arms}`,
            );
        let armRefusal: CompileError | undefined;
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
        throw armRefused(error, armRefusal, selectors);
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
 * The refusal of a call a split could not reach: its own text, then the
 * limit the run-time tests exceeded (`reach`) and the tests. A restart
 * stands as it is.
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
    | ConstantOutcome;

/**
 * The module constant an object is in one arm: a reference to it, and,
 * once the call refused, its value as the reference reads where the call
 * compiles, whose members the arm reads.
 */
interface ConstantOutcome {
    readonly constant: ts.Identifier;
    readonly record?: Value;
}

/**
 * One runtime test: the node read once, and every node spelling it. A
 * `condition` is a selection's test; a `boolean` an argument value that is a
 * boolean; a `presence` an argument value that is an object or one absence
 * (`undefined` or `null`); an `optional-boolean` a boolean or one absence;
 * a `literal` a value typed as a union of string literals (a key of a
 * constant table); a `constant` an argument value that is one of a few
 * module constants (`selectedModuleConstants`). `outcomes` are the ones the
 * value can take. With `member`, the value is
 * the member at that key path of the record `test` names, of that type;
 * `present` is the storage of an object member where an arm found it.
 * A constant test's `discriminants` are the members, strings in every one
 * of its constants, whose values tell them apart.
 */
interface Selector {
    kind:
        | "condition"
        | "boolean"
        | "presence"
        | "optional-boolean"
        | "literal"
        | "constant";
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
    groups: readonly Selector[];
    records: readonly RecordArgument[];
}

/** Every outcome a test of `kind` can take. */
const KIND_OUTCOMES: Readonly<
    Record<
        Exclude<Selector["kind"], "literal" | "constant">,
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
        : kind === "constant"
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
            if (selector.kind === "condition")
                context.conditionOverrides.set(node, outcome === "truthy");
            else if (isMemberSelector(selector))
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
 * spelling it, and the records they name, when the call can be split on
 * them: no argument assigns, constructs or suspends, its calls go to
 * module-level functions handed none of the bindings the tests read, and
 * no test writes.
 */
function selectorTests(
    context: CaseSplitContext,
    call: ts.CallExpression,
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
    if (call.arguments.some(effects)) return undefined;
    // Each distinct test with every place it appears.
    const groups: (Selector & { nodes: ts.Expression[] })[] = [];
    const addGroup = (
        kind: Selector["kind"],
        test: ts.Expression,
        outcomes?: readonly Outcome[],
    ): void => {
        const group = groups.find(
            (candidate) =>
                candidate.kind === kind &&
                sameExpression(context.checker, candidate.test, test),
        );
        if (group) group.nodes.push(test);
        else
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
            const constants =
                absent.null || absent.undefined
                    ? undefined
                    : selectedModuleConstants(context, node);
            if (constants)
                addGroup(
                    "constant",
                    node,
                    constants.map((constant) => ({ constant })),
                );
        }
    };
    const visit = (node: ts.Node): void => {
        if (ts.isFunctionLike(node)) return;
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
        if (ts.isShorthandPropertyAssignment(node)) valuePosition(node.name);
        if (ts.isSpreadAssignment(node)) valuePosition(node.expression);
        ts.forEachChild(node, visit);
    };
    call.arguments.forEach((argument) => {
        valuePosition(argument);
        visit(argument);
    });
    if (groups.length === 0 && records.length === 0) return undefined;
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
    for (const test of [
        ...groups.map((group) => group.test),
        ...records.map((record) => record.nodes[0]!),
    ]) {
        if (context.evaluationOrder.writesStorage(test)) return undefined;
        collect(test);
    }
    // A binding handed by value (a string, a boolean) is no way to change
    // what it holds.
    const receivesRoot = (node: ts.Node): boolean =>
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
        (ts.forEachChild(node, receivesRoot) ?? false);
    if (calls.some((inner) => inner.arguments.some(receivesRoot)))
        return undefined;
    return { groups, records };
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
 * A constant test as its arms read it: each constant's value with the
 * members generation knows, and the string members of the run-time object
 * `value`'s storage that, read in member order while they tell more apart,
 * tell every two constants apart. Undefined when generation knows no
 * constant's members, or two read the same.
 */
function constantSelector(
    context: CaseSplitContext,
    selector: Selector,
    value: Value,
): Selector | undefined {
    if (selector.outcomes.length > MAX_LITERAL_OUTCOMES) return undefined;
    const outcomes: ConstantOutcome[] = [];
    for (const outcome of selector.outcomes) {
        if (typeof outcome !== "object" || !("constant" in outcome))
            return undefined;
        // The discarded probe undoes what reading the reference wrote; a
        // copy keeps what generation knows of the constant there.
        const record = unlessRefused(() =>
            context.probeEmission(
                () => {
                    const read = context.compileValue(outcome.constant);
                    return read.recordProperties &&
                        context.bindings.recordPropertiesAreCurrent(read)
                        ? { ...read }
                        : undefined;
                },
                () => false,
            ),
        );
        if (!record) return undefined;
        outcomes.push({ constant: outcome.constant, record });
    }
    const text = (outcome: ConstantOutcome, key: string): string | undefined =>
        outcome.record!.recordProperties![key]?.staticString;
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
            !literalStorage(stored) ||
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

/** A run-time string or native enum, spelled `cpp`, compared with one literal. */
function literalTest(
    context: CaseSplitContext,
    cpp: string,
    storage: DataType | undefined,
    text: string,
    node: ts.Expression,
): string {
    return `${cpp} == ${
        storage?.kind === "enum"
            ? context.dataTypes.enumMemberCpp(storage, text, node)
            : context.cppString(text)
    }`;
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
              }
            | undefined => {
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
                        literalTest(
                            context,
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
                if (reads.some(({ read }) => !read || !literalStorage(read)))
                    return undefined;
                return {
                    constant: (outcome) =>
                        reads
                            .map(({ key, read }) =>
                                literalTest(
                                    context,
                                    read!.cpp,
                                    read!.dataType,
                                    outcome.record!.recordProperties![key]!
                                        .staticString!,
                                    selector.test,
                                ),
                            )
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
        // Truth is the truth test; an optional boolean's falsy one its
        // presence (after truth, false); the last outcome is the rest.
        const guard = (outcome: Outcome): string =>
            typeof outcome === "object"
                ? "literal" in outcome
                    ? test.literal!(outcome.literal)
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
