import ts from "typescript";
import { findAnalysisNode, forEachAnalysisNode } from "./analysis-walk.js";
import { sourceFileNodes } from "./analysis-walk.js";
import { engineBodies } from "./engine-bodies.js";
import { returnsOnly, yieldsFreshObject } from "./fresh-records.js";
import type { LoweringServices } from "./lowering-services.js";
import { forEachReturn } from "./loop-control.js";
import { mathMemberIsImpure } from "./math-intrinsics.js";
import {
    callTarget,
    engineCallMutatesArgument,
    libraryWrittenArgument,
} from "./parameter-effects.js";
import { promiseReactionOf, promiseStatic } from "./promises.js";
import {
    callsArgumentInPlace,
    isListenerRegistration,
    libraryMethodWritesReceiver,
} from "./receiver-methods.js";
import { isRebound } from "./binding-rebinds.js";
import { constInitializer, documentLookupCallId } from "./browser-erasure.js";
import {
    BIGINT_ARRAY_KINDS,
    BUFFER_VIEW_KINDS,
    TYPED_ARRAY_KINDS,
} from "./data-types/typed-arrays.js";
import {
    accessedPropertySymbol,
    calledDeclaration,
    calledFunction,
    declarationOrigin,
    declaredSymbol,
    libraryGlobal,
    libraryName,
    libraryStaticMember,
    namedMember,
    resolvedSymbol,
} from "./symbols.js";
import {
    containsSuspension,
    equalityOperator,
    functionOfDeclaration,
    isAssignmentExpression,
    isAsyncFunction,
    isDeclaredInside,
    isMemberAccess,
    isOperandSelection,
    isSupportedFunction,
    isValueReference,
    mutatingCallTarget,
    objectLiteralMembers,
    operandYield,
    outermostWrapper,
    unwrapExpression,
    variableKind,
    writeSites,
    type SupportedFunction,
} from "./syntax.js";
import {
    callSignatures,
    PRIMITIVE_KINDS,
    typeCanCarryReference,
    unionMembers,
    valueKindOf,
} from "./type-facts.js";
import { schedulerOf } from "./schedulers.js";

/*
 * The order code JavaScript defers runs in. An activation's code after it
 * first suspends, and a reaction's callbacks, run in JavaScript once the
 * code after their start has run; outside the application realm they run
 * at their start. Both orders agree when nothing of the program runs
 * between, or when the deferred code and the code that runs first touch
 * disjoint state.
 *
 * Model: a library asynchronous operation is seen only through its result,
 * and the library's own state (an engine's caches, its input handling) is
 * the library's. What a call or an accessor runs is EvaluationOrder's
 * answer (overrides and constructor chains included).
 */

type OrderContext = Pick<
    LoweringServices,
    | "checker"
    | "evaluationOrder"
    | "libraryGlobal"
    | "sourceFile"
    | "sourceFiles"
    | "symbols"
    | "unwrap"
>;

/** @unjournaled Pure functions of the checked source, kept across replays. */
const suspendingActivations = new WeakMap<ts.Node, boolean>();

/**
 * Whether calling `declaration` starts an activation JavaScript can
 * suspend: its body awaits (a settled value included), or it returns an
 * activation that can (`return load()`).
 */
export function activationMaySuspend(
    checker: ts.TypeChecker,
    declaration: SupportedFunction,
    active = new Set<ts.Node>(),
): boolean {
    const body = declaration.body;
    if (!isAsyncFunction(declaration) || !body) return false;
    const known = suspendingActivations.get(declaration);
    if (known !== undefined) return known;
    if (active.has(declaration)) return false;
    active.add(declaration);
    const returned: ts.Expression[] = [];
    if (ts.isBlock(body))
        forEachReturn([body], (statement) => {
            if (statement.expression) returned.push(statement.expression);
        });
    else returned.push(body);
    const suspends =
        containsSuspension(body) ||
        returned.some((expression) => {
            const call = unwrapExpression(expression);
            if (!ts.isCallExpression(call)) return false;
            const called = calledFunction(checker, call);
            return (
                called !== undefined &&
                activationMaySuspend(checker, called, active)
            );
        });
    active.delete(declaration);
    if (active.size === 0) suspendingActivations.set(declaration, suspends);
    return suspends;
}

/** @unjournaled Pure functions of the checked source, by entry file and start. */
const answers = new WeakMap<
    ts.SourceFile,
    WeakMap<ts.Node, WeakMap<ts.Node, boolean>>
>();

/** One answer per entry file, start and deferred code. */
function remembered(
    context: OrderContext,
    start: ts.Node,
    deferred: ts.Node,
    answer: () => boolean,
): boolean {
    let byStart = answers.get(context.sourceFile);
    if (!byStart) answers.set(context.sourceFile, (byStart = new WeakMap()));
    let byDeferred = byStart.get(start);
    if (!byDeferred) byStart.set(start, (byDeferred = new WeakMap()));
    let known = byDeferred.get(deferred);
    if (known === undefined) byDeferred.set(deferred, (known = answer()));
    return known;
}

/**
 * Whether the activation of `declaration` that `start` begins may run to
 * its end where it starts: what it runs after first suspending and what
 * JavaScript runs before that touch disjoint state. `start` is the call,
 * a call that runs `declaration` once per element (`items.map(load)`),
 * or `declaration` itself when the platform runs it (a listener).
 */
export function activationOrderIsUnobservable(
    context: OrderContext,
    start: ts.Node,
    declaration: SupportedFunction,
): boolean {
    return remembered(context, start, declaration, () => {
        const later = afterSuspension(context, declaration);
        if (isEmpty(later)) return true;
        const first = new InterveningCode(context);
        const direct =
            start === declaration ||
            (ts.isCallExpression(start) &&
                calledFunction(context.checker, start) === declaration);
        // Each element's run starts before an earlier one resumes.
        if (!direct) first.code.push({ node: declaration });
        first.after(start);
        return (
            !first.open &&
            !conflicts(later, footprint(context, first.code, later))
        );
    });
}

/**
 * Whether a reaction `call` registers may run its callbacks at once:
 * they and what JavaScript runs before them touch disjoint state.
 */
export function reactionOrderIsUnobservable(
    context: OrderContext,
    call: ts.CallExpression,
): boolean {
    return remembered(context, call, call, () => {
        const callbacks = call.arguments.map((argument) =>
            functionValue(context.checker, argument),
        );
        if (callbacks.includes(undefined)) return false;
        const later = footprint(
            context,
            callbacks.flatMap((node) => (node ? [{ node }] : [])),
        );
        if (isEmpty(later)) return true;
        const first = new InterveningCode(context);
        first.after(call);
        return (
            !first.open &&
            !conflicts(later, footprint(context, first.code, later))
        );
    });
}

/** @unjournaled Pure functions of the checked source, kept across replays. */
const deferredFootprints = new WeakMap<ts.Node, Footprint>();

/**
 * What an activation runs from its first suspension on: the statement
 * that first suspends, less the operand it first awaits when no loop runs
 * that again, and every statement after it. What runs before is the
 * start's.
 */
function afterSuspension(
    context: OrderContext,
    declaration: SupportedFunction,
): Footprint {
    const known = deferredFootprints.get(declaration);
    if (known) return known;
    const body = declaration.body;
    const statements = body
        ? ts.isBlock(body)
            ? body.statements
            : [body]
        : [];
    const index = statements.findIndex((statement) =>
        containsSuspension(statement),
    );
    const first = statements[index];
    let parts: CodePart[] = [{ node: declaration }];
    if (first) {
        const awaited = findAnalysisNode(first, ts.isAwaitExpression, {
            functions: "skip",
            types: "skip",
        });
        const repeated =
            awaited !== undefined &&
            ts.findAncestor(awaited, (node) =>
                node === first.parent
                    ? "quit"
                    : ts.isIterationStatement(node, false),
            ) !== undefined;
        parts = [
            {
                node: first,
                owner: declaration,
                without: awaited && !repeated ? awaited.expression : undefined,
            },
            ...statements
                .slice(index + 1)
                .map((node) => ({ node, owner: declaration })),
        ];
    }
    const result = footprint(context, parts);
    deferredFootprints.set(declaration, result);
    return result;
}

/**
 * A binding by its symbol; the objects of one family: the page's (one
 * element when an id finds it, `page:<id>`), the engine's, the language
 * library's (`data`: arrays, maps, errors), or any object at all, which
 * may be any of them; or the clock or the random sequence.
 */
type StateRoot = ts.Symbol | string;

/** Whether two roots may name the same state. */
function overlaps(a: StateRoot, b: StateRoot): boolean {
    if (typeof a !== "string" || typeof b !== "string") return a === b;
    if (a === b) return true;
    const objects = (root: string): boolean =>
        root === "objects" ||
        root === "engine" ||
        root === "data" ||
        root.startsWith("page");
    return (
        ((a === "objects" || b === "objects") && objects(a) && objects(b)) ||
        (a === "page" && b.startsWith("page:")) ||
        (b === "page" && a.startsWith("page:"))
    );
}

/** What running some code may read and write. */
interface Footprint {
    readonly reads: Set<StateRoot>;
    readonly writes: Set<StateRoot>;
    /** It runs code this analysis cannot follow. */
    unseen: boolean;
}

/** A function's or a region's own footprint and the functions it may run. */
interface Summary extends Footprint {
    readonly runs: Set<ts.Node>;
}

/**
 * Code that runs: a function or class, or a node without one of its
 * subtrees, inside `owner` when the node is part of one run of it.
 */
interface CodePart {
    readonly node: ts.Node;
    readonly without?: ts.Node | undefined;
    readonly owner?: ts.Node;
}

function isEmpty(footprint: Footprint): boolean {
    return (
        !footprint.unseen &&
        footprint.reads.size === 0 &&
        footprint.writes.size === 0
    );
}

function conflicts(a: Footprint, b: Footprint): boolean {
    if ((a.unseen && !isEmpty(b)) || (b.unseen && !isEmpty(a))) return true;
    const meets = (
        writes: ReadonlySet<StateRoot>,
        roots: Iterable<StateRoot>,
    ): boolean => {
        for (const root of roots)
            for (const written of writes)
                if (overlaps(written, root)) return true;
        return false;
    };
    return (
        meets(a.writes, b.reads) ||
        meets(a.writes, b.writes) ||
        meets(b.writes, a.reads)
    );
}

/**
 * Everything `parts` and the functions they may run read and write; it
 * stops early once it conflicts with `against`.
 */
function footprint(
    context: OrderContext,
    parts: readonly CodePart[],
    against?: Footprint,
): Footprint {
    const total: Footprint = {
        reads: new Set(),
        writes: new Set(),
        unseen: false,
    };
    const reached = new Set<ts.Node>();
    const queue: ts.Node[] = [];
    const add = (summary: Summary): boolean => {
        for (const root of summary.reads) total.reads.add(root);
        for (const root of summary.writes) total.writes.add(root);
        total.unseen ||= summary.unseen;
        for (const node of summary.runs)
            if (!reached.has(node)) {
                reached.add(node);
                queue.push(node);
            }
        return against !== undefined && conflicts(total, against);
    };
    for (const part of parts) if (add(partSummary(context, part))) return total;
    for (const node of queue)
        if (add(ownerSummary(context, node))) return total;
    return total;
}

/** A function or a class: what it declares belongs to one run of it. */
function runsAsOwner(node: ts.Node): boolean {
    return ts.isFunctionLike(node) || ts.isClassLike(node);
}

/** @unjournaled Pure functions of the checked source, kept across replays. */
const summaries = new WeakMap<ts.Node, Summary>();
/** @unjournaled Pure functions of the checked source, kept across replays. */
const regionSummaries = new WeakMap<ts.Node, Summary>();

function ownerSummary(context: OrderContext, owner: ts.Node): Summary {
    let summary = summaries.get(owner);
    if (!summary) {
        summary = summarize(context, owner, owner, undefined);
        summaries.set(owner, summary);
    }
    return summary;
}

function partSummary(context: OrderContext, part: CodePart): Summary {
    if (part.without || part.owner)
        return summarize(context, part.node, part.owner, part.without);
    if (runsAsOwner(part.node)) return ownerSummary(context, part.node);
    let summary = regionSummaries.get(part.node);
    if (!summary) {
        summary = summarize(context, part.node, undefined, undefined);
        regionSummaries.set(part.node, summary);
    }
    return summary;
}

/**
 * The state `root` reads and writes itself. A binding `owner` declares is
 * one run's own, and so is an object only such a binding holds; a binding
 * nothing reassigns is no state; a nested function or class is code it may
 * run, summarized on its own.
 */
function summarize(
    context: OrderContext,
    root: ts.Node,
    owner: ts.Node | undefined,
    without: ts.Node | undefined,
): Summary {
    const { checker, evaluationOrder } = context;
    const summary: Summary = {
        reads: new Set(),
        writes: new Set(),
        unseen: false,
        runs: new Set(),
    };
    const ownObjects = owner
        ? privateObjects(checker, owner)
        : new Set<ts.Symbol>();
    const binding = (symbol: ts.Symbol | undefined): StateRoot | undefined => {
        const declarations = symbol?.declarations ?? [];
        if (
            !symbol ||
            declarations.length === 0 ||
            declarations.some(
                (declaration) =>
                    declaration.getSourceFile().isDeclarationFile ||
                    isDeclaredInside(declaration, owner),
            ) ||
            declarations.every(isImmutableBinding) ||
            !isRebound(checker, context.sourceFiles(), symbol)
        )
            return undefined;
        return symbol;
    };
    /**
     * The object `expression` evaluates to: one run's own (a fresh object,
     * the module's metadata included), or its family's.
     */
    const object = (expression: ts.Expression): StateRoot | undefined => {
        const base = unwrapExpression(expression);
        if (ts.isMetaProperty(base) || freshValue(checker, base))
            return undefined;
        if (ts.isIdentifier(base)) {
            const symbol = resolvedSymbol(checker, base);
            if (symbol && ownObjects.has(symbol)) return undefined;
        }
        return objectFamily(context, expression);
    };
    /** A call changes the object `expression` evaluates to. */
    const change = (expression: ts.Expression): void => {
        const root = object(expression);
        if (root) summary.writes.add(root);
    };
    /** The program accessors a member access runs. */
    const accessors = (
        access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
        half: "get" | "set",
    ): void => {
        const units = evaluationOrder.accessorUnits(access, half);
        if (!units) summary.unseen = true;
        else for (const unit of units) summary.runs.add(unit);
    };
    /** An assignment, update or `delete` writes `target`. */
    const write = (target: ts.Expression): void => {
        const node = unwrapExpression(target);
        let root: StateRoot | undefined = "objects";
        if (ts.isIdentifier(node)) {
            const symbol = resolvedSymbol(checker, node);
            root = symbol?.declarations?.some(
                (declaration) => declaration.getSourceFile().isDeclarationFile,
            )
                ? "objects"
                : binding(symbol);
        } else if (isMemberAccess(node)) {
            root = object(node.expression);
            accessors(node, "set");
        }
        if (root) summary.writes.add(root);
    };
    const call = (node: ts.CallExpression | ts.NewExpression): void => {
        const units = evaluationOrder.callUnits(node);
        if (units !== undefined && units !== "library") {
            for (const unit of units) summary.runs.add(unit);
            return;
        }
        if (units === undefined) {
            summary.unseen = true;
            return;
        }
        const target = callTarget(checker, node);
        if (target.kind === "bodies") {
            // The engine: the objects it is handed, never its own state,
            // and an operation it completes later only through its result.
            if (
                !ts.isCallExpression(node) ||
                libraryName(checker.getTypeAtLocation(node)) === "Promise"
            )
                return;
            node.arguments.forEach((argument, index) => {
                if (engineCallMutatesArgument(checker, node, index, target))
                    change(argument);
            });
            const method = namedMember(
                checker,
                unwrapExpression(node.expression),
            );
            if (method) change(method.expression);
            return;
        }
        if (target.kind === "library") {
            libraryCall(node);
            return;
        }
        if (callOrigin(checker, node) === "babylon") {
            // A function value the engine handed out: engine code too.
            for (const argument of node.arguments ?? []) change(argument);
            return;
        }
        summary.unseen = true;
    };
    const libraryCall = (node: ts.CallExpression | ts.NewExpression): void => {
        // The clock and the random sequence are state the program shares.
        const shared = sharedLibraryState(checker, node);
        if (shared?.reads) summary.reads.add(shared.reads);
        if (shared?.writes) summary.writes.add(shared.writes);
        if (shared) return;
        // An asynchronous operation is seen through its result; a
        // construction changes nothing it is handed.
        if (
            ts.isNewExpression(node) ||
            libraryName(checker.getTypeAtLocation(node)) === "Promise"
        )
            return;
        const written = mutatingCallTarget(
            node,
            (expression) => namedMember(checker, expression),
            (method, receiver) =>
                libraryMethodWritesReceiver(checker, receiver, method),
            (candidate) => libraryWrittenArgument(checker, candidate),
        );
        if (written) change(written);
        if (callOrigin(checker, node) !== "dom") return;
        // The page: a global function (a timer, the console's) changes it;
        // a method changes its object and the objects it is handed, unless
        // it only reads the page or creates a node, and one that dispatches
        // an event runs its listeners.
        const method = namedMember(checker, unwrapExpression(node.expression));
        if (!method) {
            summary.writes.add("page");
            return;
        }
        if (LISTENER_RUNNING_METHODS.has(method.name)) {
            summary.unseen = true;
            return;
        }
        if (PAGE_ACCESSES.has(method.name)) return;
        change(method.expression);
        for (const argument of node.arguments)
            if (typeCanCarryReference(checker.getTypeAtLocation(argument)))
                change(argument);
    };
    const iterate = (expression: ts.Expression): void => {
        if (!iteratesLibraryCollection(checker, expression))
            summary.unseen = true;
    };
    forEachAnalysisNode(
        root,
        (node) => {
            if (node === without) return "skip";
            if (node !== root && runsAsOwner(node)) {
                summary.runs.add(node);
                return "skip";
            }
            for (const site of writeSites(node)) write(site.target);
            if (ts.isIdentifier(node)) {
                if (!isValueReference(node)) return;
                const root = binding(resolvedSymbol(checker, node));
                if (root) summary.reads.add(root);
            } else if (isMemberAccess(node)) {
                const root = object(node.expression);
                if (root) summary.reads.add(root);
                accessors(node, "get");
            } else if (ts.isCallExpression(node) || ts.isNewExpression(node))
                call(node);
            else if (ts.isTaggedTemplateExpression(node)) summary.unseen = true;
            else if (ts.isForOfStatement(node) || ts.isSpreadElement(node))
                iterate(node.expression);
            else if (
                ts.isVariableDeclaration(node) &&
                ts.isArrayBindingPattern(node.name) &&
                node.initializer
            )
                iterate(node.initializer);
        },
        { types: "skip" },
    );
    return summary;
}

function callOrigin(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
): string | undefined {
    const declaration = calledDeclaration(checker, call);
    return declaration && declarationOrigin(declaration);
}

/**
 * The family of the object an expression evaluates to, by its checked
 * type: an element an id finds, the page's other objects, the engine's, or
 * any. A program type may hold either of the first two, so it is any. A
 * primitive is no object: reading its members reads no state.
 */
function objectFamily(
    context: OrderContext,
    expression: ts.Expression,
): StateRoot | undefined {
    const { checker } = context;
    const id = elementId(context, expression);
    if (id !== undefined) return `page:${id}`;
    const members = unionMembers(
        checker.getTypeAtLocation(expression).getNonNullableType(),
    );
    if (
        members.every((member) => PRIMITIVE_KINDS.includes(valueKindOf(member)))
    )
        return undefined;
    const families = new Set(
        members.map((member) => {
            if (checker.isArrayLikeType(member)) return "data";
            const symbol = member.getSymbol() ?? member.aliasSymbol;
            const declaration = symbol?.declarations?.[0];
            const origin = declaration && declarationOrigin(declaration);
            return origin === "dom"
                ? "page"
                : origin === "babylon"
                  ? "engine"
                  : origin === "default-lib" &&
                      LIBRARY_DATA.has(symbol?.name ?? "")
                    ? "data"
                    : "objects";
        }),
    );
    const [family] = families;
    return families.size === 1 && family !== undefined ? family : "objects";
}

/** A binding no code can assign: a `const`, a function, class, enum or import. */
function isImmutableBinding(declaration: ts.Declaration): boolean {
    if (ts.isVariableDeclaration(declaration))
        return variableKind(declaration) === "const";
    return (
        ts.isFunctionDeclaration(declaration) ||
        ts.isClassDeclaration(declaration) ||
        ts.isEnumDeclaration(declaration) ||
        ts.isModuleDeclaration(declaration) ||
        ts.isImportSpecifier(declaration) ||
        ts.isImportClause(declaration) ||
        ts.isNamespaceImport(declaration) ||
        ts.isImportEqualsDeclaration(declaration)
    );
}

/** Library calls that read the clock (`Math.random` advances its sequence). */
const CLOCK_LIBRARY_CALLS: ReadonlySet<string> = new Set([
    "Date",
    "Date.now",
    "performance.now",
]);

function sharedLibraryState(
    checker: ts.TypeChecker,
    node: ts.CallExpression | ts.NewExpression,
): { readonly reads?: string; readonly writes?: string } | undefined {
    const target = unwrapExpression(node.expression);
    const member = libraryStaticMember(checker, target);
    if (member?.owner === "Math")
        return mathMemberIsImpure(member.name)
            ? { writes: "random" }
            : undefined;
    const name = member
        ? `${member.owner}.${member.name}`
        : libraryGlobal(checker, target);
    return name !== undefined && CLOCK_LIBRARY_CALLS.has(name)
        ? { reads: "clock" }
        : undefined;
}

/** DOM methods that only read the page, or create a node outside it. */
const PAGE_ACCESSES: ReadonlyMap<string, "reads" | "creates"> = new Map([
    ["getElementById", "reads"],
    ["getElementsByClassName", "reads"],
    ["getElementsByTagName", "reads"],
    ["querySelector", "reads"],
    ["querySelectorAll", "reads"],
    ["createComment", "creates"],
    ["createDocumentFragment", "creates"],
    ["createElement", "creates"],
    ["createElementNS", "creates"],
    ["createTextNode", "creates"],
]);

/** DOM methods that dispatch an event, running its listeners before they return. */
const LISTENER_RUNNING_METHODS: ReadonlySet<string> = new Set([
    "abort",
    "blur",
    "click",
    "dispatchEvent",
    "focus",
    "requestSubmit",
    "reset",
]);

/** Elements that contain no other element: an event on another never reaches them. */
const LEAF_ELEMENTS: ReadonlySet<string> = new Set([
    "HTMLImageElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
]);

/**
 * Whether no event dispatched to the element `targetId` finds reaches a
 * listener of `other`: `other` is an element no element sits inside, found
 * by another id, so it is neither the target nor one of its ancestors.
 */
function unreachedTarget(
    context: OrderContext,
    targetId: string | undefined,
    other: ts.Expression,
): boolean {
    const otherId = elementId(context, other);
    return (
        targetId !== undefined &&
        otherId !== undefined &&
        targetId !== otherId &&
        LEAF_ELEMENTS.has(
            libraryName(context.checker.getTypeAtLocation(other)) ?? "",
        )
    );
}

/** The id a document lookup found one element by, through a `const`. */
function elementId(
    context: OrderContext,
    expression: ts.Expression,
): string | undefined {
    const node = context.unwrap(expression);
    const lookup = ts.isIdentifier(node)
        ? constInitializer(context, node)
        : node;
    return (
        lookup &&
        documentLookupCallId(context, lookup, (argument) => {
            const text = context.unwrap(argument);
            return ts.isStringLiteralLike(text) ? text.text : undefined;
        })
    );
}

/** The language library's classes: an object of one is no page or engine object. */
const LIBRARY_DATA: ReadonlySet<string> = new Set([
    "Date",
    "Error",
    "Map",
    "Promise",
    "ReadonlyMap",
    "ReadonlySet",
    "RegExp",
    "Set",
    "WeakMap",
    "WeakSet",
    ...TYPED_ARRAY_KINDS.keys(),
    ...BIGINT_ARRAY_KINDS.keys(),
    ...BUFFER_VIEW_KINDS.keys(),
]);

/** Iteration protocols a program's own generator or class may implement. */
const ITERATION_PROTOCOLS: ReadonlySet<string> = new Set([
    "AsyncGenerator",
    "AsyncIterable",
    "AsyncIterableIterator",
    "AsyncIterator",
    "AsyncIteratorObject",
    "Generator",
    "Iterable",
    "IterableIterator",
    "Iterator",
    "IteratorObject",
]);

/**
 * Whether iterating `expression` runs only library code: an array, a
 * string, or a library object (a map, a `matchAll` iterator, a node list),
 * not a protocol a program's generator may stand behind.
 */
function iteratesLibraryCollection(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): boolean {
    return unionMembers(checker.getTypeAtLocation(expression)).every(
        (member) => {
            const name = libraryName(member);
            return (
                checker.isArrayLikeType(member) ||
                valueKindOf(member) === "string" ||
                (name !== undefined && !ITERATION_PROTOCOLS.has(name))
            );
        },
    );
}

/** @unjournaled Pure functions of the checked source, kept across replays. */
const ownedObjects = new WeakMap<ts.Node, ReadonlySet<ts.Symbol>>();

/**
 * The bindings of `owner` that hold an object only one run of it reaches
 * until it returns: a binding never reassigned, holding an object created
 * here (a fresh object or closure, a page node) or one such an object owns
 * (a canvas's context). Its object may be read through, called, returned,
 * captured by a closure or kept in a literal or binding that stays private
 * itself; passing, storing, awaiting or throwing it hands it on.
 */
function privateObjects(
    checker: ts.TypeChecker,
    owner: ts.Node,
): ReadonlySet<ts.Symbol> {
    const known = ownedObjects.get(owner);
    if (known) return known;
    const candidates = new Set<ts.Symbol>();
    // A candidate stays private only while each binding it is kept in does.
    const keptIn = new Map<ts.Symbol, ts.Symbol[]>();
    const keep = (symbol: ts.Symbol, holder: ts.Symbol): void => {
        const holders = keptIn.get(symbol);
        if (holders) holders.push(holder);
        else keptIn.set(symbol, [holder]);
    };
    forEachAnalysisNode(
        owner,
        (node) => {
            if (node !== owner && runsAsOwner(node)) return "skip";
            if (
                !ts.isVariableDeclaration(node) ||
                !ts.isIdentifier(node.name) ||
                !node.initializer
            )
                return;
            const symbol = declaredSymbol(checker, node.name);
            if (!symbol) return;
            const initializer = unwrapExpression(node.initializer);
            const method =
                ts.isCallExpression(initializer) &&
                callOrigin(checker, initializer) === "dom"
                    ? namedMember(
                          checker,
                          unwrapExpression(initializer.expression),
                      )
                    : undefined;
            if (
                freshValue(checker, initializer) ||
                ts.isArrowFunction(initializer) ||
                ts.isFunctionExpression(initializer) ||
                (method && PAGE_ACCESSES.get(method.name) === "creates")
            ) {
                candidates.add(symbol);
                return;
            }
            const receiver = method && unwrapExpression(method.expression);
            const base =
                receiver && ts.isIdentifier(receiver)
                    ? resolvedSymbol(checker, receiver)
                    : undefined;
            if (base && candidates.has(base)) {
                candidates.add(symbol);
                keep(symbol, base);
            }
        },
        { types: "skip" },
    );
    if (candidates.size > 0) {
        // Values read out of a candidate, which may be what it keeps.
        const readOut = new Map<ts.Symbol, ts.Expression[]>();
        forEachAnalysisNode(
            owner,
            (node) => {
                if (!ts.isIdentifier(node) || !isValueReference(node)) return;
                const symbol = resolvedSymbol(checker, node);
                if (!symbol || !candidates.has(symbol)) return;
                const holder = useHolder(owner, node);
                if (holder === "escapes") candidates.delete(symbol);
                else if (holder !== "kept") {
                    const held = declaredSymbol(checker, holder);
                    if (held && candidates.has(held)) keep(symbol, held);
                    else candidates.delete(symbol);
                }
                const position = outermostWrapper(node);
                const access = position.parent;
                if (isMemberAccess(access) && access.expression === position) {
                    const call = access.parent;
                    const read =
                        ts.isCallExpression(call) && call.expression === access
                            ? call
                            : access;
                    const list = readOut.get(symbol);
                    if (list) list.push(read);
                    else readOut.set(symbol, [read]);
                }
            },
            { types: "skip" },
        );
        // A candidate keeping others hands them on through what it gives out.
        for (const holders of keptIn.values())
            for (const holder of holders)
                if (
                    readOut
                        .get(holder)
                        ?.some(
                            (read) =>
                                typeCanCarryReference(
                                    checker.getTypeAtLocation(read),
                                ) && useHolder(owner, read) !== "kept",
                        )
                )
                    candidates.delete(holder);
        // What an escaped object keeps escapes with it.
        for (let changed = true; changed;) {
            changed = false;
            for (const [symbol, holders] of keptIn)
                if (
                    candidates.has(symbol) &&
                    holders.some((holder) => !candidates.has(holder))
                ) {
                    candidates.delete(symbol);
                    changed = true;
                }
        }
    }
    ownedObjects.set(owner, candidates);
    return candidates;
}

/**
 * Where a value `owner` evaluates can be reached from: only this run of
 * `owner` ("kept": read through, called, tested, returned by `owner`), the
 * binding a declaration of `owner` initializes, or anywhere ("escapes"). A
 * use inside a closure of `owner` keeps it when the closure keeps it and is
 * itself kept; what a closure returns escapes.
 */
function useHolder(
    owner: ts.Node,
    value: ts.Expression,
): "kept" | "escapes" | ts.Identifier {
    const closure = ts.findAncestor(value.parent, runsAsOwner);
    if (closure === owner) return heldAt(owner, value, true);
    if (
        !closure ||
        (!ts.isArrowFunction(closure) && !ts.isFunctionExpression(closure)) ||
        ts.findAncestor(closure.parent, runsAsOwner) !== owner ||
        heldAt(closure, value, false) !== "kept"
    )
        return "escapes";
    return useHolder(owner, closure);
}

/** {@link useHolder} for a value `owner` evaluates itself. */
function heldAt(
    owner: ts.Node,
    value: ts.Expression,
    returnsKeep: boolean,
): "kept" | "escapes" | ts.Identifier {
    const position = outermostWrapper(value);
    const parent = position.parent;
    // A literal's member or element goes where the literal goes.
    if (
        (ts.isShorthandPropertyAssignment(parent) ||
            (ts.isPropertyAssignment(parent) &&
                parent.initializer === position)) &&
        ts.isObjectLiteralExpression(parent.parent)
    )
        return heldAt(owner, parent.parent, returnsKeep);
    if (ts.isArrayLiteralExpression(parent))
        return heldAt(owner, parent, returnsKeep);
    if (
        ts.isReturnStatement(parent) ||
        (ts.isArrowFunction(parent) && parent.body === position)
    )
        return returnsKeep ? "kept" : "escapes";
    if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === position &&
        ts.isIdentifier(parent.name)
    )
        return returnsKeep ? parent.name : "escapes";
    if (ts.isCallExpression(parent) && parent.expression === position)
        return "kept";
    return handsOn(value) ? "escapes" : "kept";
}

/**
 * Whether a use of a reference can keep it somewhere else: an argument, a
 * stored or bound value, an awaited, yielded or thrown value, a
 * reassignment, an element of a literal handed on itself. Reading through
 * it, testing it and returning it cannot.
 */
function handsOn(value: ts.Expression): boolean {
    const position = outermostWrapper(value);
    const parent = position.parent;
    if (
        (ts.isShorthandPropertyAssignment(parent) ||
            (ts.isPropertyAssignment(parent) &&
                parent.initializer === position)) &&
        ts.isObjectLiteralExpression(parent.parent)
    )
        return handsOn(parent.parent);
    if (ts.isArrayLiteralExpression(parent)) return handsOn(parent);
    if (isMemberAccess(parent) && parent.expression === position) return false;
    if (writeSites(parent).length > 0) return true;
    if (
        ts.isReturnStatement(parent) ||
        (ts.isArrowFunction(parent) && parent.body === position) ||
        ts.isIfStatement(parent) ||
        ts.isPrefixUnaryExpression(parent) ||
        ts.isTypeOfExpression(parent)
    )
        return false;
    // A selected operand is the selection's value; a tested one is not.
    if (isOperandSelection(parent))
        return (
            operandYield(parent, position) !== undefined &&
            ts.isExpression(parent) &&
            handsOn(parent)
        );
    return !(
        ts.isBinaryExpression(parent) &&
        (equalityOperator(parent.operatorToken.kind) !== undefined ||
            parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)
    );
}

/**
 * Whether an expression yields an object nothing else reaches: a fresh
 * object ({@link yieldsFreshObject}), or an engine call whose pinned
 * bodies return only one.
 */
function freshValue(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): boolean {
    if (yieldsFreshObject(checker, expression)) return true;
    const call = unwrapExpression(expression);
    if (!ts.isCallExpression(call)) return false;
    const target = callTarget(checker, call);
    return (
        target.kind === "bodies" &&
        target.engine &&
        target.bodies.every((body) =>
            returnsOnly(body, new Set(), (returned) =>
                yieldsFreshObject(engineBodies().checkerFor(body), returned),
            ),
        )
    );
}

/**
 * The code JavaScript runs after a start and before what the start
 * defers: the rest of the expression and statements around it, and once
 * the function holding it returns, its callers' code after each call, up
 * to where the job ends. An `await` ends it there: the activation holding
 * it is a start of its own.
 */
class InterveningCode {
    /** @unjournaled One query's walk over checked source, discarded with it. */
    public readonly code: CodePart[] = [];
    /** @unjournaled One query's walk over checked source, discarded with it. */
    public open = false;
    /** @unjournaled One query's walk over checked source, discarded with it. */
    private readonly returned = new Set<ts.Node>();

    public constructor(private readonly context: OrderContext) {}

    /**
     * After `start`: an expression, or a function whoever holds it runs
     * (a listener the platform calls), which returns where it is used.
     */
    public after(start: ts.Node): void {
        if (ts.isFunctionLike(start)) this.afterUses(start);
        else if (ts.isExpression(start)) this.afterExpression(start);
        else this.open = true;
    }

    private afterExpression(start: ts.Expression): void {
        const { checker } = this.context;
        let node: ts.Expression = outermostWrapper(start);
        for (;;) {
            const parent = node.parent;
            if (ts.isAwaitExpression(parent)) return;
            if (
                ts.isReturnStatement(parent) ||
                (ts.isArrowFunction(parent) && parent.body === node)
            ) {
                const owner = ts.isArrowFunction(parent)
                    ? parent
                    : ts.findAncestor(parent.parent, ts.isFunctionLike);
                // An activation that returns it is a start of its own.
                if (
                    owner &&
                    isSupportedFunction(owner) &&
                    activationMaySuspend(checker, owner)
                )
                    return;
                if (owner) this.afterReturn(owner);
                else this.open = true;
                return;
            }
            if (ts.isVoidExpression(parent)) {
                node = outermostWrapper(parent);
                continue;
            }
            if (
                namedMember(checker, parent)?.expression === node &&
                ts.isCallExpression(parent.parent) &&
                parent.parent.expression === parent &&
                promiseReactionOf(parent, checker) !== undefined
            ) {
                node = outermostWrapper(parent.parent);
                continue;
            }
            if (!ts.isArrayLiteralExpression(parent)) break;
            const aggregate = this.aggregateOf(parent);
            if (!aggregate) break;
            const index = parent.elements.indexOf(node);
            for (const element of parent.elements.slice(index + 1))
                this.code.push({ node: element });
            node = outermostWrapper(aggregate);
        }
        this.continueAfter(node);
    }

    /** The `Promise.all` (or sibling) call an array literal is the argument of. */
    private aggregateOf(
        elements: ts.ArrayLiteralExpression,
    ): ts.CallExpression | undefined {
        const position = outermostWrapper(elements);
        const call = position.parent;
        return ts.isCallExpression(call) &&
            call.arguments[0] !== undefined &&
            outermostWrapper(call.arguments[0]) === position &&
            promiseStatic(this.context.checker, call) !== undefined
            ? call
            : undefined;
    }

    /** Everything that runs once `node` is done, up to where the job ends. */
    private continueAfter(node: ts.Node): void {
        let child = node;
        for (;;) {
            const parent = child.parent;
            if (ts.isSourceFile(parent)) {
                this.following(parent.statements, child);
                // An imported module's code runs on into its importer's.
                if (parent !== this.context.sourceFile) this.open = true;
                return;
            }
            if (ts.isFunctionLike(parent)) {
                this.afterReturn(parent);
                return;
            }
            if (ts.isClassLike(parent)) {
                this.open = true;
                return;
            }
            if (
                ts.isBlock(parent) ||
                ts.isModuleBlock(parent) ||
                ts.isCaseClause(parent) ||
                ts.isDefaultClause(parent)
            )
                this.following(parent.statements, child);
            else if (ts.isCaseBlock(parent))
                this.following(parent.clauses, child);
            else if (ts.isIterationStatement(parent, false))
                this.code.push({ node: parent });
            else if (runsLastIn(parent, child)) {
                // Nothing more of `parent` runs.
            } else if (ts.isTryStatement(parent)) {
                if (child === parent.tryBlock && parent.catchClause)
                    this.code.push({ node: parent.catchClause });
                if (child !== parent.finallyBlock && parent.finallyBlock)
                    this.code.push({ node: parent.finallyBlock });
            } else this.code.push({ node: parent, without: child });
            child = parent;
        }
    }

    /** The statements after `child` that run: a declared function does not. */
    private following(statements: readonly ts.Node[], child: ts.Node): void {
        for (const statement of statements.slice(statements.indexOf(child) + 1))
            if (
                !ts.isFunctionDeclaration(statement) &&
                !ts.isInterfaceDeclaration(statement) &&
                !ts.isTypeAliasDeclaration(statement) &&
                !ts.isImportDeclaration(statement) &&
                !ts.isEmptyStatement(statement)
            )
                this.code.push({ node: statement });
    }

    /** What runs once `fn` returns: after each of its calls, or its event. */
    private afterReturn(fn: ts.SignatureDeclaration): void {
        if (this.returned.has(fn)) return;
        this.returned.add(fn);
        // An activation that suspends is a start of its own.
        if (
            isSupportedFunction(fn) &&
            activationMaySuspend(this.context.checker, fn)
        )
            return;
        this.afterUses(fn);
    }

    private afterUses(fn: ts.SignatureDeclaration): void {
        const uses = functionUses(this.context, fn);
        if (!uses) {
            this.open = true;
            return;
        }
        for (const use of uses) this.afterUse(fn, use);
    }

    private afterUse(fn: ts.SignatureDeclaration, use: ts.Expression): void {
        const position = outermostWrapper(use);
        const parent = position.parent;
        if (ts.isCallExpression(parent) && parent.expression === position) {
            this.afterExpression(parent);
            return;
        }
        if (
            (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
            parent.arguments?.some(
                (argument) => outermostWrapper(argument) === position,
            )
        ) {
            this.afterCallback(fn, parent, position);
            return;
        }
        const handler = handlerRegistration(
            this.context.checker,
            parent,
            position,
        );
        if (handler !== undefined) {
            this.dispatchRest(fn, handler.type, handler.target);
            return;
        }
        if (ts.isExportSpecifier(parent) || ts.isExportAssignment(parent))
            return;
        this.open = true;
    }

    /** `fn` handed to a call: the call runs it, or the platform does later. */
    private afterCallback(
        fn: ts.SignatureDeclaration,
        call: ts.CallExpression | ts.NewExpression,
        position: ts.Expression,
    ): void {
        const invoker = invokerOf(this.context, call, position);
        switch (invoker.kind) {
            case "listener":
                this.dispatchRest(fn, invoker.type, invoker.target);
                return;
            case "iteration":
                this.code.push({ node: fn });
                this.afterExpression(call);
                return;
            case "construction":
                this.afterExpression(call);
                return;
            case "task":
                return;
            case "engine": {
                const index = programIndex(this.context);
                for (const callback of index.engineCallbacks)
                    if (callback !== fn) this.code.push({ node: callback });
                if (index.engineCallbacksOpen) this.open = true;
                return;
            }
            case "unknown":
                this.open = true;
        }
    }

    /**
     * The rest of an event's dispatch: every other listener of its type on
     * its target or on an element the target may sit inside.
     */
    private dispatchRest(
        fn: ts.Node,
        type: string | undefined,
        target: ts.Expression | undefined,
    ): void {
        const targetId = target && elementId(this.context, target);
        let own = 0;
        for (const listener of programIndex(this.context).listeners) {
            if (
                (type !== undefined &&
                    listener.type !== undefined &&
                    listener.type !== type) ||
                (listener.target !== undefined &&
                    unreachedTarget(this.context, targetId, listener.target))
            )
                continue;
            if (!listener.fn) {
                this.open = true;
                return;
            }
            if (listener.fn === fn && own++ === 0) continue;
            this.code.push({ node: listener.fn });
        }
    }
}

/**
 * Whether nothing of `parent` runs after `child`: a branch of a test, or
 * an operator's right operand (an assignment still writes after it).
 */
function runsLastIn(parent: ts.Node, child: ts.Node): boolean {
    if (ts.isIfStatement(parent)) return child !== parent.expression;
    if (isOperandSelection(parent)) {
        // A branch, or a right operand: the selection is whatever it yields.
        const passed = operandYield(parent, child);
        return (
            passed !== undefined &&
            passed.has("truthy") &&
            passed.has("falsy") &&
            passed.has("nullish")
        );
    }
    return (
        ts.isBinaryExpression(parent) &&
        child === parent.right &&
        !isAssignmentExpression(parent)
    );
}

/**
 * The event type and target an `element.on<type> = handler` assignment
 * registers `position` for: a property of a page object, nothing else.
 */
function handlerRegistration(
    checker: ts.TypeChecker,
    parent: ts.Node,
    position: ts.Expression,
): { readonly type: string; readonly target: ts.Expression } | undefined {
    if (
        !ts.isBinaryExpression(parent) ||
        parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        outermostWrapper(parent.right) !== position
    )
        return undefined;
    const property = unwrapExpression(parent.left);
    const member = namedMember(checker, property);
    const declaration =
        isMemberAccess(property) &&
        accessedPropertySymbol(checker, property)?.declarations?.[0];
    return member?.name.startsWith("on") &&
        declaration &&
        declarationOrigin(declaration) === "dom"
        ? { type: member.name.slice(2), target: member.expression }
        : undefined;
}

type Invoker =
    | {
          readonly kind: "listener";
          readonly type: string | undefined;
          readonly target: ts.Expression | undefined;
      }
    | { readonly kind: "iteration" }
    | { readonly kind: "construction" }
    | { readonly kind: "task" }
    | { readonly kind: "engine" }
    | { readonly kind: "unknown" };

/** How a call runs the function it is handed at `position`. */
function invokerOf(
    context: OrderContext,
    call: ts.CallExpression | ts.NewExpression,
    position: ts.Expression,
): Invoker {
    const { checker } = context;
    const origin = callOrigin(checker, call);
    if (origin === "babylon") return { kind: "engine" };
    if (origin !== "default-lib" && origin !== "dom")
        return { kind: "unknown" };
    const target = unwrapExpression(call.expression);
    if (ts.isCallExpression(call) && isListenerRegistration(checker, call))
        return {
            kind: "listener",
            type: eventType(call.arguments[0]),
            target: namedMember(checker, target)?.expression,
        };
    // A promise executor runs once; an iteration once per element.
    if (callsArgumentInPlace(checker, call, position))
        return ts.isNewExpression(call)
            ? { kind: "construction" }
            : { kind: "iteration" };
    // A timer or frame callback runs as a task of its own; a microtask
    // runs among others the analysis does not follow.
    const scheduler = schedulerOf(checker, target);
    if (scheduler !== undefined && scheduler !== "microtask")
        return { kind: "task" };
    return { kind: "unknown" };
}

/**
 * Where a function's value is used: each reference to the binding naming
 * it, or the function literal itself where it sits. Undefined for a method
 * or accessor, which a base class or an interface may call under another
 * symbol.
 */
function functionUses(
    context: OrderContext,
    fn: ts.SignatureDeclaration,
): readonly ts.Expression[] | undefined {
    const index = programIndex(context);
    if (ts.isFunctionDeclaration(fn) && fn.name) {
        const symbol = declaredSymbol(context.checker, fn.name);
        return symbol ? (index.references.get(symbol) ?? []) : undefined;
    }
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))
        return undefined;
    const position = outermostWrapper(fn);
    const parent = position.parent;
    if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === position &&
        ts.isIdentifier(parent.name) &&
        isImmutableBinding(parent)
    ) {
        const symbol = declaredSymbol(context.checker, parent.name);
        return symbol ? (index.references.get(symbol) ?? []) : undefined;
    }
    return [position];
}

/** A listener registration: its event type and target, and the function it runs. */
interface ListenerRegistration {
    readonly type: string | undefined;
    readonly target: ts.Expression | undefined;
    readonly fn: ts.Node | undefined;
}

/** What the order analysis reads of the whole program, built once. */
interface ProgramIndex {
    /** Value references to each binding and member. */
    readonly references: Map<ts.Symbol, ts.Expression[]>;
    readonly listeners: readonly ListenerRegistration[];
    /** The functions the program hands the engine. */
    readonly engineCallbacks: readonly ts.Node[];
    /** A function value handed to the engine is not followed. */
    readonly engineCallbacksOpen: boolean;
}

/** @unjournaled A whole-program analysis of compiler inputs, built on first use. */
const programIndexes = new WeakMap<ts.TypeChecker, ProgramIndex>();

function programIndex(context: OrderContext): ProgramIndex {
    const { checker } = context;
    const known = programIndexes.get(checker);
    if (known) return known;
    const references = new Map<ts.Symbol, ts.Expression[]>();
    const listeners: ListenerRegistration[] = [];
    const engineCallbacks: ts.Node[] = [];
    let engineCallbacksOpen = false;
    const reference = (
        symbol: ts.Symbol | undefined,
        node: ts.Expression,
    ): void => {
        if (!symbol) return;
        const list = references.get(symbol);
        if (list) list.push(node);
        else references.set(symbol, [node]);
    };
    for (const file of context.sourceFiles()) {
        if (file.isDeclarationFile) continue;
        for (const node of sourceFileNodes(file)) {
            if (ts.isIdentifier(node) && isValueReference(node))
                reference(resolvedSymbol(checker, node), node);
            else if (isMemberAccess(node))
                reference(accessedPropertySymbol(checker, node), node);
            if (ts.isCallExpression(node)) {
                const origin = callOrigin(checker, node);
                if (origin === "dom" && isListenerRegistration(checker, node))
                    listeners.push({
                        type: eventType(node.arguments[0]),
                        target: namedMember(
                            checker,
                            unwrapExpression(node.expression),
                        )?.expression,
                        fn: functionValue(checker, node.arguments[1]!),
                    });
                if (origin === "babylon") {
                    const handed = handedFunctions(checker, node.arguments);
                    if (!handed) engineCallbacksOpen = true;
                    for (const argument of handed ?? []) {
                        const fn = functionValue(checker, argument);
                        if (fn) engineCallbacks.push(fn);
                        else engineCallbacksOpen = true;
                    }
                }
            }
            if (ts.isBinaryExpression(node)) {
                const handler = handlerRegistration(
                    checker,
                    node,
                    outermostWrapper(node.right),
                );
                if (handler)
                    listeners.push({
                        type: handler.type,
                        target: handler.target,
                        fn: functionValue(checker, node.right),
                    });
            }
        }
    }
    const index: ProgramIndex = {
        references,
        listeners,
        engineCallbacks,
        engineCallbacksOpen,
    };
    programIndexes.set(checker, index);
    return index;
}

/** A listener's event type, when a string literal names it. */
function eventType(argument: ts.Expression | undefined): string | undefined {
    const type = argument && unwrapExpression(argument);
    return type && ts.isStringLiteralLike(type) ? type.text : undefined;
}

/**
 * The function-valued arguments of a call, the members of object literals
 * and the elements of array literals included; undefined when a spread
 * hands values the analysis does not list.
 */
function handedFunctions(
    checker: ts.TypeChecker,
    arguments_: readonly ts.Expression[],
): ts.Node[] | undefined {
    const handed: ts.Node[] = [];
    let complete = true;
    const visit = (expression: ts.Expression): void => {
        const value = unwrapExpression(expression);
        if (ts.isObjectLiteralExpression(value)) {
            for (const member of objectLiteralMembers(value))
                if (member.kind === "spread") complete = false;
                else if (
                    member.kind === "property" ||
                    member.kind === "shorthand"
                )
                    visit(member.value);
                else handed.push(member.node);
            return;
        }
        if (ts.isArrayLiteralExpression(value)) {
            for (const element of value.elements)
                if (ts.isSpreadElement(element)) complete = false;
                else visit(element);
            return;
        }
        if (
            callSignatures(checker, checker.getTypeAtLocation(value), "present")
                .length > 0
        )
            handed.push(value);
    };
    for (const argument of arguments_) visit(argument);
    return complete ? handed : undefined;
}

/** The function a value names: a literal or method, or a binding of one. */
function functionValue(
    checker: ts.TypeChecker,
    expression: ts.Node,
): ts.Node | undefined {
    if (!ts.isExpression(expression))
        return ts.isFunctionLike(expression) ? expression : undefined;
    const value = unwrapExpression(expression);
    if (ts.isFunctionLike(value)) return value;
    if (!ts.isIdentifier(value)) return undefined;
    const declaration = resolvedSymbol(checker, value)?.valueDeclaration;
    return declaration && isImmutableBinding(declaration)
        ? functionOfDeclaration(declaration)
        : undefined;
}
