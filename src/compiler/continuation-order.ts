import ts from "typescript";
import { findAnalysisNode, forEachAnalysisNode } from "./analysis-walk.js";
import { engineBodies } from "./engine-bodies.js";
import { returnsOnly, yieldsFreshObject } from "./fresh-records.js";
import type { LoweringServices } from "./lowering-services.js";
import { forEachReturn } from "./loop-control.js";
import {
    callTarget,
    engineCallMutatesArgument,
    libraryWrittenArgument,
} from "./parameter-effects.js";
import { promiseReactionOf, promiseStatic } from "./promises.js";
import { receiverWritingMethods } from "./receiver-methods.js";
import { isRebound } from "./binding-rebinds.js";
import {
    calledDeclaration,
    calledFunction,
    declarationOrigin,
    declaredSymbol,
    libraryGlobal,
    libraryName,
    resolvedSymbol,
} from "./symbols.js";
import {
    containsSuspension,
    functionOfDeclaration,
    isAssignmentExpression,
    isAsyncFunction,
    isOperandSelection,
    isSupportedFunction,
    equalityOperator,
    isValueReference,
    mutatingCallTarget,
    operandYield,
    outermostWrapper,
    variableKind,
    unwrapExpression,
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
 * the library's.
 */

export type OrderContext = Pick<
    LoweringServices,
    "checker" | "libraryGlobal" | "sourceFile" | "sourceFiles"
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
    const first = new InterveningCode(context);
    const direct =
        start === declaration ||
        (ts.isCallExpression(start) &&
            calledFunction(context.checker, start) === declaration);
    // Each element's run starts before an earlier one resumes.
    if (!direct) first.code.push({ node: declaration });
    first.after(start);
    return deferralIsUnobservable(context, first, afterSuspension(declaration));
}

/**
 * Whether a reaction `call` registers may run its callbacks at once:
 * they and what JavaScript runs before them touch disjoint state.
 */
export function reactionOrderIsUnobservable(
    context: OrderContext,
    call: ts.CallExpression,
): boolean {
    const first = new InterveningCode(context);
    first.after(call);
    const callbacks = call.arguments.map((argument) =>
        functionValue(context.checker, argument),
    );
    return deferralIsUnobservable(
        context,
        first,
        callbacks.flatMap((node) => (node ? [{ node }] : [])),
        callbacks.includes(undefined),
    );
}

function deferralIsUnobservable(
    context: OrderContext,
    first: InterveningCode,
    deferred: readonly CodePart[],
    unseen = false,
): boolean {
    const runsFirst = footprint(context, first.code);
    if (!first.open && isEmpty(runsFirst)) return true;
    const later = footprint(context, deferred);
    later.unseen ||= unseen;
    if (isEmpty(later)) return true;
    return !first.open && !conflicts(later, runsFirst);
}

/**
 * An activation's code from its first suspension on: the statement that
 * first suspends, less the operand it first awaits when no loop runs that
 * again, and every statement after it. What runs before is the start's.
 */
function afterSuspension(declaration: SupportedFunction): CodePart[] {
    const body = declaration.body;
    if (!body) return [{ node: declaration }];
    const statements = ts.isBlock(body) ? body.statements : [body];
    const index = statements.findIndex((statement) =>
        containsSuspension(statement),
    );
    const first = statements[index];
    if (!first) return [{ node: declaration }];
    const awaited = findAnalysisNode(first, ts.isAwaitExpression, {
        functions: "skip",
        types: "skip",
    });
    const once =
        awaited !== undefined &&
        !someAncestorBelow(awaited, first, (node) =>
            ts.isIterationStatement(node, false),
        );
    return [
        {
            node: first,
            owner: declaration,
            without: once ? awaited.expression : undefined,
        },
        ...statements
            .slice(index + 1)
            .map((node) => ({ node, owner: declaration })),
    ];
}

function someAncestorBelow(
    node: ts.Node,
    top: ts.Node,
    test: (ancestor: ts.Node) => boolean,
): boolean {
    for (
        let current = node.parent;
        current && current !== top;
        current = current.parent
    )
        if (test(current)) return true;
    return test(top);
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

/** Everything `parts` and the functions they may run read and write. */
function footprint(
    context: OrderContext,
    parts: readonly CodePart[],
): Footprint {
    const total: Footprint = {
        reads: new Set(),
        writes: new Set(),
        unseen: false,
    };
    const reached = new Set<ts.Node>();
    const queue: ts.Node[] = [];
    const add = (summary: Summary): void => {
        for (const root of summary.reads) total.reads.add(root);
        for (const root of summary.writes) total.writes.add(root);
        total.unseen ||= summary.unseen;
        for (const node of summary.runs)
            if (!reached.has(node)) {
                reached.add(node);
                queue.push(node);
            }
    };
    for (const part of parts)
        add(
            !part.without && !part.owner && runsAsOwner(part.node)
                ? ownerSummary(context, part.node)
                : summarize(context, part.node, part.owner, part.without),
        );
    for (const node of queue) add(ownerSummary(context, node));
    return total;
}

/** A function or a class: what it declares belongs to one run of it. */
function runsAsOwner(node: ts.Node): boolean {
    return ts.isFunctionLike(node) || ts.isClassLike(node);
}

/** @unjournaled Pure functions of the checked source, kept across replays. */
const summaries = new WeakMap<ts.Node, Summary>();

function ownerSummary(context: OrderContext, owner: ts.Node): Summary {
    let summary = summaries.get(owner);
    if (!summary) {
        summary = summarize(context, owner, owner, undefined);
        summaries.set(owner, summary);
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
    const { checker } = context;
    const summary: Summary = {
        reads: new Set(),
        writes: new Set(),
        unseen: false,
        runs: new Set(),
    };
    const ownObjects = owner
        ? privateObjects(checker, owner)
        : new Set<ts.Symbol>();
    const isOwn = (declaration: ts.Node): boolean =>
        owner !== undefined && encloses(owner, declaration);
    const binding = (symbol: ts.Symbol | undefined): StateRoot | undefined => {
        const declarations = symbol?.declarations ?? [];
        if (
            !symbol ||
            declarations.length === 0 ||
            declarations.some(
                (declaration) =>
                    declaration.getSourceFile().isDeclarationFile ||
                    isOwn(declaration),
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
        return objectFamily(checker, expression);
    };
    /** A call changes the object `expression` evaluates to. */
    const change = (expression: ts.Expression): void => {
        const root = object(expression);
        if (root) summary.writes.add(root);
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
        } else if (
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)
        )
            root = object(node.expression);
        if (root) summary.writes.add(root);
    };
    const call = (node: ts.CallExpression | ts.NewExpression): void => {
        const target = callTarget(checker, node);
        if (target.kind === "bodies" && !target.engine) {
            for (const body of target.bodies) summary.runs.add(body);
            return;
        }
        if (target.kind === "bodies") {
            // The engine: the objects it is handed, never its own state,
            // and an operation it completes later only through its result.
            if (
                !ts.isCallExpression(node) ||
                libraryName(checker.getTypeAtLocation(node)) === "Promise"
            )
                return;
            node.arguments.forEach((argument, index) => {
                if (engineCallMutatesArgument(checker, node, index))
                    change(argument);
            });
            const callee = unwrapExpression(node.expression);
            if (ts.isPropertyAccessExpression(callee))
                change(callee.expression);
            return;
        }
        if (target.kind === "library") {
            libraryCall(node);
            return;
        }
        const declaration = calledDeclaration(checker, node);
        if (declaration && declarationOrigin(declaration) === "babylon") {
            // A function value the engine handed out: engine code too.
            for (const argument of node.arguments ?? []) change(argument);
            return;
        }
        if (ts.isNewExpression(node) && constructsProgramClass(node)) return;
        summary.unseen = true;
    };
    const constructsProgramClass = (node: ts.NewExpression): boolean => {
        const declarations =
            resolvedSymbol(checker, node.expression)?.declarations ?? [];
        const classes = declarations.filter(ts.isClassLike);
        if (
            classes.length === 0 ||
            classes.some(
                (declaration) => declaration.getSourceFile().isDeclarationFile,
            )
        )
            return false;
        for (const declaration of classes) summary.runs.add(declaration);
        return true;
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
            (method) => receiverWritingMethods.has(method),
            (candidate) => libraryWrittenArgument(checker, candidate),
        );
        if (written) change(written);
        const declaration = calledDeclaration(checker, node);
        if (!declaration || declarationOrigin(declaration) !== "dom") return;
        // The page: a global function (a timer, the console's) changes it;
        // a method changes its object and the objects it is handed, unless
        // it only reads the page or creates a node.
        const callee = unwrapExpression(node.expression);
        if (!ts.isPropertyAccessExpression(callee)) {
            summary.writes.add("page");
            return;
        }
        if (pageAccess(callee) !== undefined) return;
        change(callee.expression);
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
            } else if (
                ts.isPropertyAccessExpression(node) ||
                ts.isElementAccessExpression(node)
            ) {
                const root = object(node.expression);
                if (root) summary.reads.add(root);
                for (const accessor of accessorsOf(checker, node))
                    summary.runs.add(accessor);
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

/**
 * The family of the object an expression evaluates to, by its checked
 * type: an element an id finds, the page's other objects, the engine's, or
 * any. A program type may hold either of the first two, so it is any. A
 * primitive is no object: reading its members reads no state.
 */
function objectFamily(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): StateRoot | undefined {
    const id = elementId(checker, expression);
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

function encloses(outer: ts.Node, inner: ts.Node): boolean {
    for (let node: ts.Node | undefined = inner; node; node = node.parent)
        if (node === outer) return true;
    return false;
}

/** The user accessors a member access may run. */
function accessorsOf(
    checker: ts.TypeChecker,
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): ts.Node[] {
    const symbol = ts.isPropertyAccessExpression(access)
        ? resolvedSymbol(checker, access)
        : undefined;
    return (symbol?.declarations ?? []).filter(
        (declaration) =>
            (ts.isGetAccessorDeclaration(declaration) ||
                ts.isSetAccessorDeclaration(declaration)) &&
            !declaration.getSourceFile().isDeclarationFile,
    );
}

/** Library calls that read the clock or advance the random sequence. */
const SHARED_STATE_LIBRARY_CALLS: ReadonlyMap<
    string,
    { readonly reads?: string; readonly writes?: string }
> = new Map([
    ["Date", { reads: "clock" }],
    ["Date.now", { reads: "clock" }],
    ["performance.now", { reads: "clock" }],
    ["Math.random", { writes: "random" }],
]);

function sharedLibraryState(
    checker: ts.TypeChecker,
    node: ts.CallExpression | ts.NewExpression,
): { readonly reads?: string; readonly writes?: string } | undefined {
    const callee = unwrapExpression(node.expression);
    const owner = ts.isPropertyAccessExpression(callee)
        ? libraryGlobal(checker, callee.expression)
        : undefined;
    const name = ts.isIdentifier(callee)
        ? libraryGlobal(checker, callee)
        : ts.isPropertyAccessExpression(callee) && owner !== undefined
          ? `${owner}.${callee.name.text}`
          : undefined;
    return name === undefined
        ? undefined
        : SHARED_STATE_LIBRARY_CALLS.get(name);
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

function pageAccess(
    callee: ts.PropertyAccessExpression,
): "reads" | "creates" | undefined {
    return PAGE_ACCESSES.get(callee.name.text);
}

/** Elements no other element sits inside: an event on another never reaches them. */
const LEAF_ELEMENTS: ReadonlySet<string> = new Set([
    "HTMLAudioElement",
    "HTMLCanvasElement",
    "HTMLImageElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLVideoElement",
]);

/**
 * Whether no event dispatched to `target` reaches a listener of `other`:
 * `other` is an element no element sits inside, and the two are found by
 * different ids, so `other` is neither `target` nor one of its ancestors.
 */
function unreachedTarget(
    checker: ts.TypeChecker,
    target: ts.Expression,
    other: ts.Expression,
): boolean {
    const targetId = elementId(checker, target);
    const otherId = elementId(checker, other);
    return (
        targetId !== undefined &&
        otherId !== undefined &&
        targetId !== otherId &&
        LEAF_ELEMENTS.has(libraryName(checker.getTypeAtLocation(other)) ?? "")
    );
}

/** The id `document.getElementById` found an element by, through a `const`. */
function elementId(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): string | undefined {
    let node = unwrapExpression(expression);
    if (ts.isIdentifier(node)) {
        const declaration = resolvedSymbol(checker, node)?.valueDeclaration;
        if (
            !declaration ||
            !ts.isVariableDeclaration(declaration) ||
            !isImmutableBinding(declaration) ||
            !declaration.initializer
        )
            return undefined;
        node = unwrapExpression(declaration.initializer);
    }
    const argument = ts.isCallExpression(node) ? node.arguments[0] : undefined;
    return ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "getElementById" &&
        libraryGlobal(checker, node.expression.expression) === "document" &&
        argument !== undefined &&
        ts.isStringLiteralLike(argument)
        ? argument.text
        : undefined;
}

/** The language library's classes: an object of one is no page or engine object. */
const LIBRARY_DATA: ReadonlySet<string> = new Set([
    "ArrayBuffer",
    "DataView",
    "Date",
    "Error",
    "Promise",
    "RegExp",
    "WeakMap",
    "WeakSet",
    "Map",
    "ReadonlyMap",
    "Set",
    "ReadonlySet",
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
]);

/** Iteration protocols a program's own generator or class may implement. */
const ITERATION_PROTOCOLS: ReadonlySet<string> = new Set([
    "AsyncGenerator",
    "AsyncIterable",
    "AsyncIterableIterator",
    "AsyncIterator",
    "Generator",
    "Iterable",
    "IterableIterator",
    "Iterator",
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

/**
 * The bindings of `owner` that hold an object only it reaches: a binding
 * never reassigned, holding an object created here (a fresh object, a page
 * node) or one such an object owns (a canvas's context), and never handed
 * on: not passed, stored, captured, awaited or thrown, only returned.
 */
function privateObjects(
    checker: ts.TypeChecker,
    owner: ts.Node,
): ReadonlySet<ts.Symbol> {
    const candidates = new Set<ts.Symbol>();
    const ownedBy = new Map<ts.Symbol, ts.Symbol>();
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
            const callee =
                ts.isCallExpression(initializer) &&
                ts.isPropertyAccessExpression(initializer.expression)
                    ? initializer.expression
                    : undefined;
            const domCall =
                callee !== undefined &&
                ts.isCallExpression(initializer) &&
                calledDeclarationOrigin(checker, initializer) === "dom";
            if (
                freshValue(checker, initializer) ||
                (domCall && pageAccess(callee) === "creates")
            ) {
                candidates.add(symbol);
                return;
            }
            const base =
                domCall && ts.isIdentifier(unwrapExpression(callee.expression))
                    ? resolvedSymbol(
                          checker,
                          unwrapExpression(callee.expression),
                      )
                    : undefined;
            if (base && candidates.has(base)) {
                candidates.add(symbol);
                ownedBy.set(symbol, base);
            }
        },
        { types: "skip" },
    );
    if (candidates.size === 0) return candidates;
    forEachAnalysisNode(
        owner,
        (node) => {
            if (!ts.isIdentifier(node) || !isValueReference(node)) return;
            const symbol = resolvedSymbol(checker, node);
            if (
                symbol &&
                candidates.has(symbol) &&
                (enclosingOwner(node) !== owner || handsOn(node))
            )
                candidates.delete(symbol);
        },
        { types: "skip" },
    );
    // What an escaped object owns escapes with it.
    for (let changed = true; changed;) {
        changed = false;
        for (const [symbol, base] of ownedBy)
            if (candidates.has(symbol) && !candidates.has(base)) {
                candidates.delete(symbol);
                changed = true;
            }
    }
    return candidates;
}

function calledDeclarationOrigin(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
): string | undefined {
    const declaration = calledDeclaration(checker, call);
    return declaration && declarationOrigin(declaration);
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
    if (
        (ts.isPropertyAccessExpression(parent) ||
            ts.isElementAccessExpression(parent)) &&
        parent.expression === position
    )
        return false;
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

function enclosingOwner(node: ts.Node): ts.Node | undefined {
    for (let current = node.parent; current; current = current.parent)
        if (runsAsOwner(current)) return current;
    return undefined;
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
    public readonly code: CodePart[] = [];
    public open = false;
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
                    : enclosingFunction(parent);
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
                ts.isPropertyAccessExpression(parent) &&
                parent.expression === node &&
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
            promiseStatic(call, (expression) =>
                this.context.libraryGlobal(expression),
            ) !== undefined
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
            this.afterCallback(fn, parent);
            return;
        }
        const handler = handlerProperty(parent, position);
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
    ): void {
        const invoker = invokerOf(this.context, call);
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
            case "engine":
                for (const callback of programIndex(this.context)
                    .engineCallbacks)
                    if (callback !== fn) this.code.push({ node: callback });
                if (programIndex(this.context).engineCallbacksOpen)
                    this.open = true;
                return;
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
        const index = programIndex(this.context);
        let own = 0;
        for (const listener of index.listeners) {
            if (
                (type !== undefined &&
                    listener.type !== undefined &&
                    listener.type !== type) ||
                (target !== undefined &&
                    listener.target !== undefined &&
                    unreachedTarget(
                        this.context.checker,
                        target,
                        listener.target,
                    ))
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

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
    for (let current = node.parent; current; current = current.parent)
        if (ts.isFunctionLike(current)) return current;
    return undefined;
}

/** The event type and target an `on<type>` handler assignment registers for. */
function handlerProperty(
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
    return ts.isPropertyAccessExpression(property) &&
        property.name.text.startsWith("on")
        ? { type: property.name.text.slice(2), target: property.expression }
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

/** Array methods that run their callback once per element before returning. */
const ITERATING_METHODS: ReadonlySet<string> = new Set([
    "every",
    "filter",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "flatMap",
    "forEach",
    "map",
    "reduce",
    "reduceRight",
    "some",
    "sort",
    "toSorted",
]);

/** How a call runs the function it is handed. */
function invokerOf(
    context: OrderContext,
    call: ts.CallExpression | ts.NewExpression,
): Invoker {
    const { checker } = context;
    const declaration = calledDeclaration(checker, call);
    if (!declaration) return { kind: "unknown" };
    const origin = declarationOrigin(declaration);
    if (origin === "babylon") return { kind: "engine" };
    if (origin !== "default-lib" && origin !== "dom")
        return { kind: "unknown" };
    const callee = unwrapExpression(call.expression);
    const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined;
    if (name === "addEventListener" && ts.isCallExpression(call))
        return {
            kind: "listener",
            type: eventType(call.arguments[0]),
            target: ts.isPropertyAccessExpression(callee)
                ? callee.expression
                : undefined,
        };
    if (ts.isNewExpression(call))
        return context.libraryGlobal(call.expression) === "Promise"
            ? { kind: "construction" }
            : { kind: "unknown" };
    if (
        name !== undefined &&
        ITERATING_METHODS.has(name) &&
        ts.isPropertyAccessExpression(callee) &&
        checker.isArrayLikeType(checker.getTypeAtLocation(callee.expression))
    )
        return { kind: "iteration" };
    // A timer or frame callback runs as a task of its own; a microtask
    // runs among others the analysis does not follow.
    const scheduler = schedulerOf(checker, callee);
    if (scheduler !== undefined && scheduler !== "microtask")
        return { kind: "task" };
    return { kind: "unknown" };
}

/**
 * Where a function's value is used: each reference to the binding naming
 * it, or the function literal itself where it sits. Undefined for a
 * function no binding names that sits nowhere a call reads it.
 */
function functionUses(
    context: OrderContext,
    fn: ts.SignatureDeclaration,
): readonly ts.Expression[] | undefined {
    const index = programIndex(context);
    if (
        (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) &&
        fn.name
    ) {
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
    for (const file of context.sourceFiles())
        forEachAnalysisNode(
            file,
            (node) => {
                if (ts.isIdentifier(node) && isValueReference(node))
                    reference(resolvedSymbol(checker, node), node);
                else if (ts.isPropertyAccessExpression(node))
                    reference(resolvedSymbol(checker, node), node);
                if (ts.isCallExpression(node)) {
                    const declaration = calledDeclaration(checker, node);
                    const origin =
                        declaration && declarationOrigin(declaration);
                    const callee = unwrapExpression(node.expression);
                    if (
                        origin === "dom" &&
                        ts.isPropertyAccessExpression(callee) &&
                        callee.name.text === "addEventListener" &&
                        node.arguments[1]
                    ) {
                        listeners.push({
                            type: eventType(node.arguments[0]),
                            target: callee.expression,
                            fn: functionValue(checker, node.arguments[1]),
                        });
                    }
                    if (origin === "babylon")
                        for (const argument of handedFunctions(
                            checker,
                            node.arguments,
                        )) {
                            const fn = functionValue(checker, argument);
                            if (fn) engineCallbacks.push(fn);
                            else engineCallbacksOpen = true;
                        }
                }
                const handler = ts.isBinaryExpression(node)
                    ? handlerProperty(node, outermostWrapper(node.right))
                    : undefined;
                if (handler && ts.isBinaryExpression(node)) {
                    const declaration = resolvedSymbol(
                        checker,
                        unwrapExpression(node.left),
                    )?.declarations?.[0];
                    if (declaration && declarationOrigin(declaration) === "dom")
                        listeners.push({
                            type: handler.type,
                            target: handler.target,
                            fn: functionValue(checker, node.right),
                        });
                }
            },
            { types: "skip" },
        );
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

/** The function-valued arguments of a call, object literal members included. */
function handedFunctions(
    checker: ts.TypeChecker,
    arguments_: readonly ts.Expression[],
): ts.Node[] {
    const handed: ts.Node[] = [];
    const visit = (expression: ts.Expression): void => {
        const value = unwrapExpression(expression);
        if (ts.isObjectLiteralExpression(value)) {
            for (const property of value.properties)
                if (ts.isPropertyAssignment(property))
                    visit(property.initializer);
                else if (ts.isMethodDeclaration(property))
                    handed.push(property);
            return;
        }
        if (
            callSignatures(checker, checker.getTypeAtLocation(value), "present")
                .length > 0
        )
            handed.push(value);
    };
    for (const argument of arguments_) visit(argument);
    return handed;
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
