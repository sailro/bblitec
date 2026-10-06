import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import type { EvaluationOrder } from "./evaluation-order.js";
import { callOnlyReadsArgument } from "./parameter-effects.js";
import {
    programObservations,
    type ObservedWrite,
    type ProgramObservations,
} from "./program-observations.js";
import { declaredSymbol } from "./symbols.js";
import { unwrapExpression } from "./syntax.js";

/** What a record-observation question reads: the program and the code its calls run. */
export interface RecordObservationContext {
    readonly program: ts.Program;
    readonly checker: ts.TypeChecker;
    readonly evaluationOrder: EvaluationOrder;
}

/**
 * Where a program could tell a copied record from the object JavaScript
 * shares. Storing a record as another record type copies it natively; the
 * copy and the original agree for every read until one of them changes, is
 * compared or keyed by identity, or is enumerated beyond the copied fields
 * (`ProgramObservations` lists who touches objects of each static type).
 *
 * A copy is unobservable when no write of a field it keeps can reach the
 * original or the copy, no identity use can reach the copy, and no
 * enumeration can reach the copy while the original carries or gains
 * properties the copy drops. A copy handed to a callee that only reads it
 * needs only that nothing the call runs writes such a field. Holders are
 * judged by assignability, so a record reaching an operation through
 * another structural type, `any`, `unknown` or a type parameter counts as
 * reaching it; a type assertion to a subtype of the copy's type, or out of
 * `any` or `unknown`, extends where the copy may flow.
 */

/** @unjournaled Pure functions of the checked program, kept across replays. */
const answers = new WeakMap<
    ts.Type,
    WeakMap<ts.Type, Map<string, string | null>>
>();

/**
 * Why a native copy of a `source` record stored as `target` could be told
 * apart from the shared JavaScript object, or undefined when nothing in the
 * program can. `fields` are the properties the copy keeps; `carries` says
 * whether the source records have other properties the copy drops; an
 * `argument` handed to a callee that only reads it needs only the writes
 * of the code the call runs.
 */
export function recordCopyObservation(
    context: RecordObservationContext,
    source: ts.Type,
    target: ts.Type,
    fields: readonly string[],
    carries: boolean,
    argument?: ts.Node,
): string | undefined {
    const call = argument && readOnlyArgumentCall(context.checker, argument);
    const key = `${fields.join(",")}|${carries}`;
    let byTarget = answers.get(source);
    if (!byTarget) answers.set(source, (byTarget = new WeakMap()));
    let byKey = byTarget.get(target);
    if (!byKey)
        byTarget.set(target, (byKey = new Map<string, string | null>()));
    if (!call) {
        const known = byKey.get(key);
        if (known !== undefined) return known ?? undefined;
    }
    const observations = programObservations(context.program);
    const { checker } = context;
    const holds = holderTest(checker);
    // A write through either the original or the copy is missed by the
    // other. Only the copy can be told apart by identity or enumeration,
    // and it flows only where its target type flows.
    const either = [source, target];
    // An assertion can retype the copy as a subtype of its target, or as
    // anything once it went through `any` or `unknown`.
    const copyTypes = [
        target,
        ...observations.assertions
            .filter(
                ({ asserted, open }) =>
                    open || checker.isTypeAssignableTo(asserted, target),
            )
            .map(({ asserted }) => asserted),
    ];
    const keptWrite = (write: ObservedWrite): boolean =>
        write.property === undefined || fields.includes(write.property);
    if (call) {
        // A copy handed to a callee that only reads it lives for the call:
        // only a write while the call runs can make it stale.
        const reached = context.evaluationOrder.reachedCode(call);
        if (reached.opaque)
            return "the call runs code the program does not hold";
        const during = writesWhere(
            observations,
            (type) => holds(type, either),
            (write) =>
                keptWrite(write) &&
                ts.findAncestor(
                    write.node,
                    (node) => node === call || reached.units.has(node),
                ) !== undefined,
        );
        return during === undefined
            ? undefined
            : during.property === undefined
              ? "the call writes properties of such records"
              : `the call writes '${during.property}' of such records`;
    }
    const answer = observed(
        observations,
        (type) => holds(type, either),
        (type) => holds(type, copyTypes),
        keptWrite,
        carries,
    );
    byKey.set(key, answer ?? null);
    return answer;
}

function observed(
    observations: ProgramObservations,
    holdsEither: (type: ts.Type) => boolean,
    holdsCopy: (type: ts.Type) => boolean,
    keptWrite: (write: ObservedWrite) => boolean,
    carries: boolean,
): string | undefined {
    const written = writesWhere(observations, holdsEither, keptWrite);
    if (written)
        return written.property === undefined
            ? "the program writes properties of such records"
            : `the program writes '${written.property}' of such records`;
    if ([...observations.identities].some(holdsCopy))
        return "the program compares or keys such records by identity";
    const addsProperty =
        carries ||
        writesWhere(
            observations,
            holdsEither,
            (write) => write.property !== undefined && !keptWrite(write),
        ) !== undefined;
    if (addsProperty && [...observations.enumerations].some(holdsCopy))
        return "the program enumerates properties of such records";
    return undefined;
}

/**
 * The first write, in program order, of an object whose static type
 * `holds`, matching `matches`.
 */
function writesWhere(
    observations: ProgramObservations,
    holds: (type: ts.Type) => boolean,
    matches: (write: ObservedWrite) => boolean,
    index: ReadonlyMap<ts.Type, readonly ObservedWrite[]> = observations.writes,
): ObservedWrite | undefined {
    let first: ObservedWrite | undefined;
    for (const [type, writes] of index) {
        const write = writes.find(
            (candidate) =>
                (first === undefined || candidate.order < first.order) &&
                matches(candidate),
        );
        if (write && holds(type)) first = write;
    }
    return first;
}

/**
 * Whether a value of type `holder` can be a record of one of `records`, one
 * answer per holder and record list.
 */
function holderTest(
    checker: ts.TypeChecker,
): (holder: ts.Type, records: readonly ts.Type[]) => boolean {
    const known = new Map<readonly ts.Type[], Map<ts.Type, boolean>>();
    return (holder, records) => {
        let byHolder = known.get(records);
        if (!byHolder)
            known.set(records, (byHolder = new Map<ts.Type, boolean>()));
        let holds = byHolder.get(holder);
        if (holds === undefined) {
            holds = holdsRecord(checker, holder, records);
            byHolder.set(holder, holds);
        }
        return holds;
    };
}

function holdsRecord(
    checker: ts.TypeChecker,
    holder: ts.Type,
    records: readonly ts.Type[],
): boolean {
    // A type parameter holds whatever its constraint admits; an
    // unconstrained one holds anything.
    if ((holder.flags & ts.TypeFlags.TypeParameter) !== 0) {
        const constraint = checker.getBaseConstraintOfType(holder);
        return (
            constraint === undefined ||
            constraint === holder ||
            holdsRecord(checker, constraint, records)
        );
    }
    const open =
        ts.TypeFlags.Any |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.TypeParameter |
        ts.TypeFlags.Index |
        ts.TypeFlags.IndexedAccess |
        ts.TypeFlags.Conditional |
        ts.TypeFlags.Substitution |
        ts.TypeFlags.NonPrimitive;
    if ((holder.flags & open) !== 0) return true;
    if (holder.isUnion())
        return holder.types.some((member) =>
            holdsRecord(checker, member, records),
        );
    if (
        holder.isIntersection() &&
        holder.types.some((member) => (member.flags & open) !== 0)
    )
        return true;
    if (
        (holder.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) ===
        0
    )
        return false;
    return records.some((record) => checker.isTypeAssignableTo(record, holder));
}

/** A wrapper that keeps the value of the expression it encloses. */
function climb(node: ts.Expression): ts.Expression {
    let current = node;
    while (
        ts.isParenthesizedExpression(current.parent) ||
        ts.isNonNullExpression(current.parent) ||
        ts.isAsExpression(current.parent) ||
        ts.isTypeAssertionExpression(current.parent) ||
        ts.isSatisfiesExpression(current.parent)
    )
        current = current.parent;
    return current;
}

/**
 * The call a value is handed to as `argument`, when the callee only reads
 * that parameter (`callOnlyReadsArgument`): a copy passed there lives for
 * the call alone, and nothing but a write while it runs can tell it apart.
 */
function readOnlyArgumentCall(
    checker: ts.TypeChecker,
    argument: ts.Node,
): ts.CallExpression | undefined {
    if (!ts.isExpression(argument)) return undefined;
    const use = climb(argument);
    const call = use.parent;
    return ts.isCallExpression(call) &&
        call.expression !== use &&
        callOnlyReadsArgument(checker, call, call.arguments.indexOf(use))
        ? call
        : undefined;
}

/**
 * Whether the callee a value is handed to as `argument` only reads that
 * parameter: never writes, compares, enumerates, stores, returns or captures
 * it, so it can neither grow nor outlive the call through the callee.
 */
export function argumentOnlyRead(
    checker: ts.TypeChecker,
    argument: ts.Node,
): boolean {
    return readOnlyArgumentCall(checker, argument) !== undefined;
}

/**
 * Whether an array handed as `argument` to a callee that only reads it can
 * be lent as a copy for the call: the callee keeps neither the array nor an
 * element, and nothing the call runs changes the elements or length of an
 * array that may be the original. A write of an element's fields while the
 * call runs is the element copies' own question.
 */
export function arrayLentForCall(
    context: RecordObservationContext,
    argument: ts.Node,
): boolean {
    const call = readOnlyArgumentCall(context.checker, argument);
    if (!call) return false;
    const reached = context.evaluationOrder.reachedCode(call);
    if (reached.opaque) return false;
    const array = context.checker.getTypeAtLocation(argument);
    const observations = programObservations(context.program);
    const holds = (type: ts.Type): boolean =>
        holdsRecord(context.checker, type, [array]);
    const during = (write: ObservedWrite): boolean =>
        ts.findAncestor(
            write.node,
            (node) => node === call || reached.units.has(node),
        ) !== undefined;
    // An engine or ambient function may change any array it is handed.
    return (
        writesWhere(observations, holds, during, observations.arrayWrites) ===
            undefined &&
        writesWhere(
            observations,
            holds,
            (write) => write.property === undefined && during(write),
        ) === undefined
    );
}

/**
 * Whether a record returned as `returned` is the last reference to it: a
 * local of the returning function, initialized with a fresh object
 * (`fresh`), whose other uses only read or write its properties, outside
 * any nested function. A copy returned there replaces the only reference.
 */
export function returnedRecordLocal(
    checker: ts.TypeChecker,
    returned: ts.Node,
    fresh: (initializer: ts.Expression) => boolean,
): boolean {
    if (!ts.isExpression(returned)) return false;
    const unwrapped = unwrapExpression(returned);
    if (!ts.isIdentifier(unwrapped)) return false;
    const use = climb(unwrapped);
    const owner = ts.findAncestor(use.parent, ts.isFunctionLike);
    if (
        !owner ||
        !(
            ts.isReturnStatement(use.parent) ||
            (ts.isArrowFunction(use.parent) && use.parent.body === use)
        )
    )
        return false;
    const symbol = declaredSymbol(checker, unwrapped);
    const declaration = symbol?.valueDeclaration;
    if (
        !symbol ||
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        ts.findAncestor(declaration, ts.isFunctionLike) !== owner ||
        !fresh(declaration.initializer)
    )
        return false;
    let only = true;
    forEachAnalysisNode(owner, (node) => {
        if (!only) return "skip";
        if (
            !ts.isIdentifier(node) ||
            node === unwrapped ||
            node === declaration.name ||
            declaredSymbol(checker, node) !== symbol
        )
            return;
        const reference = climb(node);
        const parent = reference.parent;
        only =
            ts.findAncestor(node.parent, ts.isFunctionLike) === owner &&
            (ts.isPropertyAccessExpression(parent) ||
                ts.isElementAccessExpression(parent)) &&
            parent.expression === reference &&
            !(
                ts.isCallExpression(climb(parent).parent) &&
                (climb(parent).parent as ts.CallExpression).expression ===
                    climb(parent)
            );
    });
    return only;
}
