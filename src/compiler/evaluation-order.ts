import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { mathMemberAccess, mathMemberIsImpure } from "./math-intrinsics.js";
import {
    classChain,
    localClassOfSymbol,
    type ClassHierarchy,
} from "./class-members.js";
import {
    engineBodies,
    isEngineDeclaration,
    type EngineBodies,
} from "./engine-bodies.js";
import { libraryMethodWritesReceiver } from "./receiver-methods.js";
import { propertyIsReadOnly } from "./data-types.js";
import {
    BIGINT_ARRAY_KINDS,
    BUFFER_VIEW_KINDS,
    TYPED_ARRAY_KINDS,
} from "./data-types/typed-arrays.js";
import { returnsOnly, yieldsFreshObject } from "./fresh-records.js";
import {
    callTarget,
    engineCallMutatesArgument,
    libraryWrittenArgument,
} from "./parameter-effects.js";
import { constInitializer, documentLookupCallId } from "./browser-erasure.js";
import {
    CompilerSymbols,
    declaredInDefaultLibrary,
    declaredInDomLibrary,
    declarationOrigin,
    declaredSymbol,
    libraryGlobal,
    libraryName,
    libraryStaticMember,
    pinnedConstantProperty,
    resolvedSymbol,
    calledDeclaration,
    calledOrigin,
    memberAccessors,
    namedMember,
    accessedPropertySymbol,
} from "./symbols.js";
import { doubleLiteral } from "../cpp-literals.js";
import type { LoweringServices } from "./lowering-services.js";
import { readsNativeStorage, snapshotReadCpp, type Value } from "./types.js";
import { isRebound } from "./binding-rebinds.js";
import {
    unwrapExpression,
    rootExpression,
    writeSites,
    isSuspensionPoint,
    equalityOperator,
    isMemberAccess,
    isOperandSelection,
    isValueReference,
    objectLiteralMembers,
    operandYield,
    outermostWrapper,
} from "./syntax.js";
import {
    holdsOnly,
    isTypeReference,
    PRIMITIVE_KINDS,
    typeCanCarryReference,
    valueKinds,
    valueKindOf,
    callSignatures,
    unionMembers,
} from "./type-facts.js";

/**
 * What evaluating code reads and writes, one model for two questions.
 *
 * JavaScript evaluates the operands of one expression left to right. The
 * lowering does not always keep that order: an operand whose call is
 * inlined or shared runs its work in statements emitted ahead of the
 * expression, and C++ leaves the order of operands inside one expression
 * unspecified. An operand is therefore read into a temporary before the
 * later operands lower whenever the two touch the same storage and one of
 * them writes it (`operandsToPin`). Outside the application realm, code
 * JavaScript defers runs where it starts; that keeps JavaScript's order only
 * where the deferred code and the code JavaScript runs first touch disjoint
 * state (`footprint`, read by `continuation-order.ts`).
 *
 * What code touches is answered from the source: the variables it reads and
 * writes (a binding no code reassigns is no state), the objects that existed
 * before it ran by family (`ObjectFamily`), the clock and `Math.random`'s
 * generator, and, through the functions it runs, everything they touch. An
 * object only one run of a function reaches is that run's own
 * (`privateObjects`). A call the analysis cannot follow -- a function value
 * it cannot name, an abstract method -- touches everything.
 *
 * A library is seen through what it is handed and returns: it reads its
 * receiver and the objects it is handed, writes its receiver through a
 * mutating method and the argument it fills (`Object.assign`), runs the
 * callbacks it is handed, and a page method changes the page unless it
 * only reads or creates nodes. Two things only the operand question sees:
 * the engine's own code, read from the pin's bodies behind its typing
 * (`engine-bodies.ts`), the engine's module state counting as object state,
 * and an `await`, which lets any other job run. The order question treats
 * both as JavaScript's later run does: a library operation's work shows in
 * its result, and what runs while a job waits is another start's.
 */

/**
 * The objects of one family, by the checked type of an expression: the
 * page's (one element when an id finds it, `page:<id>`), the engine's, the
 * language library's (`data`: arrays, maps, errors), or any object at all,
 * which may be any of them.
 */
export type ObjectFamily =
    "page" | `page:${string}` | "engine" | "data" | "objects";

/** Whether two families may hold one object. */
function familiesOverlap(a: ObjectFamily, b: ObjectFamily): boolean {
    if (a === b || a === "objects" || b === "objects") return true;
    return (
        (a === "page" && b.startsWith("page:")) ||
        (b === "page" && a.startsWith("page:"))
    );
}

/**
 * DOM platform methods with state behind their receiver: a streaming
 * decoder's pending bytes, a byte stream's queue and lock, an abort.
 */
type PlatformMethodEffect = "writes-receiver" | "runs-code";
const PLATFORM_METHOD_EFFECTS: ReadonlyMap<
    string,
    ReadonlyMap<string, PlatformMethodEffect>
> = new Map([
    [
        "TextDecoder",
        new Map<string, PlatformMethodEffect>([["decode", "writes-receiver"]]),
    ],
    [
        "ReadableStream",
        new Map<string, PlatformMethodEffect>([
            ["getReader", "writes-receiver"],
            ["cancel", "writes-receiver"],
        ]),
    ],
    [
        "ReadableStreamDefaultReader",
        new Map<string, PlatformMethodEffect>([
            ["read", "writes-receiver"],
            ["cancel", "writes-receiver"],
            ["releaseLock", "writes-receiver"],
        ]),
    ],
    [
        "AbortController",
        new Map<string, PlatformMethodEffect>([["abort", "runs-code"]]),
    ],
]);

function platformMethodEffect(
    receiver: ts.Type,
    method: string,
): PlatformMethodEffect | undefined {
    for (const member of unionMembers(receiver)) {
        const symbol = member.getSymbol();
        if (!symbol || !declaredInDomLibrary(symbol)) continue;
        const effect = PLATFORM_METHOD_EFFECTS.get(symbol.name)?.get(method);
        if (effect) return effect;
    }
    return undefined;
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

/** Library calls that read the clock (`Math.random` advances its sequence). */
const CLOCK_LIBRARY_CALLS: ReadonlySet<string> = new Set([
    "Date",
    "Date.now",
    "performance.now",
]);

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

/** The generator `Math.random` advances: each call reads and writes it. */
const randomState = Symbol("Math.random");
/** The clock `Date.now()` reads. */
const clockState = Symbol("clock");

/** Storage an evaluation reads or writes. */
interface Storage {
    /** Code the analysis cannot follow ran: anything may be touched. */
    any: boolean;
    /** Objects that existed before the evaluation, by family. */
    objects: Set<ObjectFamily>;
    /**
     * Part of `objects`: an object that may be an array or typed array --
     * its type admits one (`mayHoldArray`) -- through a property, an
     * element or a mutating method.
     */
    arrays: boolean;
    /** Variables by symbol, the clock and `Math.random`'s generator. */
    variables: Set<ts.Symbol | typeof randomState | typeof clockState>;
}

/** What evaluating some code reads and writes. */
export interface Access {
    readonly reads: Storage;
    readonly writes: Storage;
}

/** What one function body or region touches itself, and the functions it runs. */
interface DirectAccess extends Access {
    readonly callees: Set<Unit>;
    /**
     * It runs program code the analysis cannot follow (a function value it
     * cannot name, an overridable accessor), not only an engine body that
     * does.
     */
    opaque: boolean;
    /** It awaits: any other job may run before it resumes. */
    suspends: boolean;
    /**
     * What library code does that only its result shows: the engine's own
     * code from its pinned bodies, an asynchronous operation's work.
     */
    readonly library: Access;
}

/** The question an access answers: evaluating operands, or the order JavaScript defers code in. */
type View = "operands" | "order";

/** Record program code the analysis cannot follow. */
function cannotFollow(access: DirectAccess): void {
    touchEverything(access);
    access.opaque = true;
}

/** Code a call runs: a function body, or a class field's initializer. */
type Unit = ts.FunctionLikeDeclaration | ts.PropertyDeclaration;

function isUnit(node: ts.Node): node is ts.FunctionLikeDeclaration {
    return (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isAccessor(node)
    );
}

/**
 * Code that runs: a function, or a node without one of its subtrees,
 * inside `owner` when the node is part of one run of it.
 */
export interface CodePart {
    readonly node: ts.Node;
    readonly without?: ts.Node | undefined;
    readonly owner?: ts.Node;
}

/** Eager expressions in one callable or field initializer. */
function unitRoots(unit: Unit): readonly ts.Node[] {
    return ts.isPropertyDeclaration(unit)
        ? unit.initializer
            ? [unit.initializer]
            : []
        : [
              ...unit.parameters.flatMap((parameter) =>
                  parameter.initializer ? [parameter.initializer] : [],
              ),
              ...(unit.body ? [unit.body] : []),
          ];
}

/** The global library functions whose answer is a conversion of their arguments. */
const argumentAnsweringGlobals = new Set([
    "String",
    "Number",
    "Boolean",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
]);

function emptyStorage(): Storage {
    return {
        any: false,
        objects: new Set(),
        arrays: false,
        variables: new Set(),
    };
}

function emptyAccess(): Access {
    return { reads: emptyStorage(), writes: emptyStorage() };
}

function touchesAnything(storage: Storage): boolean {
    return (
        storage.any || storage.objects.size > 0 || storage.variables.size > 0
    );
}

/** The operand question: any two objects may be one, as the lowering's C++ sees them. */
function touches(left: Storage, right: Storage): boolean {
    if (left.any) return touchesAnything(right);
    if (right.any) return touchesAnything(left);
    if (left.objects.size > 0 && right.objects.size > 0) return true;
    return [...left.variables].some((variable) =>
        right.variables.has(variable),
    );
}

/** Record code the analysis cannot follow: it may read and write anything. */
function touchEverything(access: Access): void {
    access.reads.any = true;
    access.writes.any = true;
}

function merge(into: Storage, from: Storage): void {
    into.any ||= from.any;
    into.arrays ||= from.arrays;
    from.objects.forEach((family) => into.objects.add(family));
    from.variables.forEach((variable) => into.variables.add(variable));
}

function mergeAccess(into: Access, from: Access): void {
    merge(into.reads, from.reads);
    merge(into.writes, from.writes);
}

/** What one body's own work touches, as `view` sees it. */
function mergeDirect(into: Access, direct: DirectAccess, view: View): void {
    mergeAccess(into, direct);
    if (view === "order") return;
    mergeAccess(into, direct.library);
    if (direct.suspends) touchEverything(into);
}

/** Whether the later operand's evaluation must not overtake the earlier one's. */
function conflicts(earlier: Access, later: Access): boolean {
    return (
        touches(earlier.writes, later.reads) ||
        touches(earlier.reads, later.writes) ||
        touches(earlier.writes, later.writes)
    );
}

/** Whether running code with this footprint touches no state at all. */
export function touchesNoState(footprint: Access): boolean {
    return (
        !touchesAnything(footprint.reads) && !touchesAnything(footprint.writes)
    );
}

/**
 * Whether two runs of code observe their order: one writes state the other
 * reads or writes, an object of one family meeting its own or `objects`.
 */
export function footprintsConflict(a: Access, b: Access): boolean {
    const any = (footprint: Access): boolean =>
        footprint.reads.any || footprint.writes.any;
    if ((any(a) && !touchesNoState(b)) || (any(b) && !touchesNoState(a)))
        return true;
    const meets = (writes: Storage, other: Storage): boolean =>
        [...writes.variables].some((variable) =>
            other.variables.has(variable),
        ) ||
        [...writes.objects].some((written) =>
            [...other.objects].some((family) =>
                familiesOverlap(written, family),
            ),
        );
    return (
        meets(a.writes, b.reads) ||
        meets(a.writes, b.writes) ||
        meets(b.writes, a.reads)
    );
}

/** The function (or file) whose frame a declaration's variable lives in. */
function evaluationContainer(node: ts.Node): ts.Node {
    for (let current = node.parent; current; current = current.parent) {
        if (ts.isFunctionLike(current) || ts.isSourceFile(current))
            return current;
        if (ts.isClassStaticBlockDeclaration(current)) return current;
    }
    return node.getSourceFile();
}

/** Whether `outer` lexically contains `inner`. */
function encloses(outer: ts.Node, inner: ts.Node): boolean {
    for (let current = inner.parent; current; current = current.parent)
        if (current === outer) return true;
    return false;
}

/** A function or a class: what it declares belongs to one run of it. */
function runsAsOwner(node: ts.Node): boolean {
    return ts.isFunctionLike(node) || ts.isClassLike(node);
}

/**
 * The id a document lookup found one element by, through a `const`: the
 * key of the element's family (`page:<id>`).
 */
export function lookedUpElementId(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): string | undefined {
    const context = {
        checker,
        unwrap: unwrapExpression,
        symbols: new CompilerSymbols(checker),
    };
    const node = unwrapExpression(expression);
    const lookup = ts.isIdentifier(node)
        ? constInitializer(context, node)
        : node;
    return (
        lookup &&
        documentLookupCallId(context, lookup, (argument) => {
            const text = unwrapExpression(argument);
            return ts.isStringLiteralLike(text) ? text.text : undefined;
        })
    );
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
): ObjectFamily | undefined {
    const id = lookedUpElementId(checker, expression);
    if (id !== undefined) return `page:${id}`;
    const members = unionMembers(
        checker.getTypeAtLocation(expression).getNonNullableType(),
    );
    if (
        members.every((member) => PRIMITIVE_KINDS.includes(valueKindOf(member)))
    )
        return undefined;
    const families = new Set(
        members.map((member): ObjectFamily => {
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

/**
 * The shared state a library call reads or writes besides objects: the
 * clock, or `Math.random`'s generator.
 */
function sharedLibraryState(
    checker: ts.TypeChecker,
    node: ts.CallExpression | ts.NewExpression,
): typeof randomState | typeof clockState | undefined {
    const target = unwrapExpression(node.expression);
    const member = libraryStaticMember(checker, target);
    if (member?.owner === "Math")
        return mathMemberIsImpure(member.name) ? randomState : undefined;
    const name = member
        ? `${member.owner}.${member.name}`
        : libraryGlobal(checker, target);
    return name !== undefined && CLOCK_LIBRARY_CALLS.has(name)
        ? clockState
        : undefined;
}

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
 * Whether an expression yields an object nothing else reaches: a fresh
 * object ({@link yieldsFreshObject}), or an engine call whose pinned bodies
 * return only one.
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
                calledOrigin(checker, initializer) === "dom"
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

/** Types the checker leaves open: a value of one may be anything. */
const OPEN_TYPES =
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.NonPrimitive |
    ts.TypeFlags.TypeParameter;

/** Whether a value of `type` may be a function. */
function mayBeFunction(checker: ts.TypeChecker, type: ts.Type): boolean {
    return unionMembers(type).some(
        (member) =>
            (member.flags & OPEN_TYPES) !== 0 ||
            callSignatures(checker, member, "present").length > 0,
    );
}

/** A method a class or a library type declares lives on its prototype. */
function isPrototypeMethod(declaration: ts.Declaration): boolean {
    return (
        (ts.isMethodDeclaration(declaration) &&
            ts.isClassLike(declaration.parent)) ||
        (ts.isMethodSignature(declaration) &&
            declaration.getSourceFile().isDeclarationFile)
    );
}

/**
 * Whether spreading `source` hands on a function: an element it iterates,
 * or an own property it copies.
 */
function spreadsFunction(
    checker: ts.TypeChecker,
    source: ts.Expression,
    into: "elements" | "properties",
): boolean {
    return unionMembers(checker.getTypeAtLocation(source)).some((member) => {
        if ((member.flags & OPEN_TYPES) !== 0) return true;
        if (PRIMITIVE_KINDS.includes(valueKindOf(member))) return false;
        if (into === "elements")
            return isTypeReference(member)
                ? checker
                      .getTypeArguments(member)
                      .some((element) => mayBeFunction(checker, element))
                : true;
        return member
            .getProperties()
            .some(
                (property) =>
                    !(property.declarations ?? []).every(isPrototypeMethod) &&
                    mayBeFunction(checker, checker.getTypeOfSymbol(property)),
            );
    });
}

/**
 * The function-valued arguments of a call, the members of object literals
 * and the elements of array literals included; undefined when a spread
 * hands values the analysis does not list.
 */
export function handedFunctions(
    checker: ts.TypeChecker,
    arguments_: readonly ts.Expression[],
): ts.Node[] | undefined {
    const handed: ts.Node[] = [];
    let complete = true;
    const visit = (expression: ts.Expression): void => {
        const value = unwrapExpression(expression);
        if (ts.isObjectLiteralExpression(value)) {
            for (const member of objectLiteralMembers(value))
                if (member.kind === "spread")
                    complete &&= !spreadsFunction(
                        checker,
                        member.node.expression,
                        "properties",
                    );
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
                if (ts.isSpreadElement(element))
                    complete &&= !spreadsFunction(
                        checker,
                        element.expression,
                        "elements",
                    );
                else visit(element);
            return;
        }
        if (
            callSignatures(checker, checker.getTypeAtLocation(value), "present")
                .length > 0
        )
            handed.push(value);
    };
    for (const argument of arguments_)
        if (ts.isSpreadElement(argument))
            complete &&= !spreadsFunction(
                checker,
                argument.expression,
                "elements",
            );
        else visit(argument);
    return complete ? handed : undefined;
}

/** One analysis of the pinned program per resolver, shared by every scene. */
const pinnedOrders = new WeakMap<EngineBodies, EvaluationOrder>();

export class EvaluationOrder {
    /** @unjournaled A cache of one unit's own accesses, from its source alone. */
    private readonly direct = new Map<Unit, DirectAccess>();
    /** @unjournaled A cache of one unit's reachable accesses, from source alone. */
    private readonly summaries = new Map<Unit, Access>();
    /** @unjournaled `summaries` as the order question sees them, from source alone. */
    private readonly orderSummaries = new Map<Unit, Access>();
    /** @unjournaled A cache of one region's footprint, from source alone. */
    private readonly regions = new WeakMap<ts.Node, Access>();
    /** @unjournaled A cache of one node's reachable accesses, from source alone. */
    private readonly accesses = new WeakMap<ts.Node, Access>();
    /** @unjournaled A cache of whether one unit answers from its arguments alone. */
    private readonly deterministic = new Map<Unit, boolean>();
    /** @unjournaled Module effects depend only on checked source bodies. */
    private readonly moduleEffects = new WeakMap<ts.Node, boolean>();
    /** @unjournaled Different initializers share the effects of their checked callees. */
    private readonly moduleUnitEffects = new WeakMap<Unit, boolean>();
    /** @unjournaled The library's `any[]` (`mayHoldArray`), null without one. */
    private anyArray: ts.Type | null | undefined;

    public constructor(
        private readonly checker: ts.TypeChecker,
        private readonly hierarchy: ClassHierarchy,
        /** The engine's pinned bodies, for a scene program's calls into it. */
        private readonly engine?: () => EngineBodies,
    ) {}

    /**
     * For operands evaluated in order, the flag per operand that says it
     * must be read into a temporary before the rest lower: some later
     * operand touches what it touches, and one of the two writes it.
     */
    public operandsToPin(operands: readonly ts.Node[]): boolean[] {
        const accesses = operands.map((operand) => this.access(operand));
        return accesses.map((earlier, index) =>
            accesses
                .slice(index + 1)
                .some((later) => conflicts(earlier, later)),
        );
    }

    /**
     * Whether evaluating `node` again later could give another value or
     * repeat an effect: it reads storage some code writes, or writes
     * storage itself.
     */
    public touchesStorage(node: ts.Node): boolean {
        const access = this.access(node);
        return touchesAnything(access.reads) || touchesAnything(access.writes);
    }

    /** Whether evaluating `node` can write any variable or object state. */
    public writesStorage(node: ts.Node): boolean {
        return touchesAnything(this.access(node).writes);
    }

    /** Whether evaluation can change any array's elements or membership. */
    public mayWriteArray(node: ts.Node): boolean {
        const writes = this.access(node).writes;
        return writes.any || writes.arrays;
    }

    /**
     * Whether calling the function `callback` denotes can write an array or
     * `variable`: a function literal or a named function answers from its
     * body and everything it reaches, a function of the language's library
     * writes neither, and any other function value may write anything. A
     * write to an object no array can be (a record's field, a Map) is no
     * array's.
     */
    public callbackMayWrite(
        callback: ts.Expression,
        variable: ts.Symbol | undefined,
    ): boolean {
        const expression = unwrapExpression(callback);
        const unit =
            ts.isArrowFunction(expression) ||
            ts.isFunctionExpression(expression)
                ? expression
                : this.namedFunction(expression);
        if (!unit)
            return !declaredInDefaultLibrary(
                resolvedSymbol(this.checker, expression),
            );
        const writes = this.summary(unit).writes;
        return (
            writes.any ||
            writes.arrays ||
            (variable !== undefined && writes.variables.has(variable))
        );
    }

    /**
     * Whether running `unit` touches no storage outside its own frame, with
     * everything it calls, and asks nothing of the host: its result is a
     * function of its arguments alone.
     */
    public isPure(unit: ts.FunctionLikeDeclaration): boolean {
        const summary = this.summary(unit);
        return (
            !touchesAnything(summary.reads) &&
            !touchesAnything(summary.writes) &&
            this.answersFromArguments(unit)
        );
    }

    /**
     * `isPure`'s rule for an expression: evaluating `node` earlier or later
     * gives the same value and no effect. It touches no storage, and each
     * call it makes, with everything that call reaches, answers from its
     * arguments.
     */
    public isPureExpression(node: ts.Node): boolean {
        return (
            !this.touchesStorage(node) &&
            this.callsAnswer([node], (units) =>
                units.every((unit) => this.answersFromArguments(unit)),
            )
        );
    }

    /**
     * Work which cannot stay in a generation-only module: host observations,
     * unknown calls and abrupt completion. Writes to source-owned storage are
     * deliberately separate; the module planner tracks their observed owners.
     */
    public hasModuleEffects(node: ts.Node): boolean {
        const known = this.moduleEffects.get(node);
        if (known !== undefined) return known;
        const active = new Set<Unit>();
        const visitUnit = (unit: Unit): boolean => {
            const known = this.moduleUnitEffects.get(unit);
            if (known !== undefined) return known;
            // A reachable cycle remains conservative even without host effects.
            if (active.has(unit)) return true;
            active.add(unit);
            try {
                const result = visit(unitRoots(unit), unit);
                this.moduleUnitEffects.set(unit, result);
                return result;
            } finally {
                active.delete(unit);
            }
        };
        const visit = (roots: readonly ts.Node[], unit?: Unit): boolean => {
            let effects = false;
            for (const root of roots) {
                forEachAnalysisNode(
                    root,
                    (current) => {
                        if (effects) return "skip";
                        if (
                            ts.isThrowStatement(current) ||
                            isSuspensionPoint(current, { yield: true }) ||
                            ts.isTaggedTemplateExpression(current) ||
                            ts.isWhileStatement(current) ||
                            ts.isDoStatement(current) ||
                            ts.isForStatement(current)
                        ) {
                            effects = true;
                            return "skip";
                        }
                        if (
                            ts.isCallExpression(current) ||
                            ts.isNewExpression(current)
                        ) {
                            const callees = this.callUnits(current);
                            if (
                                !callees ||
                                (callees === "library" &&
                                    !this.moduleLocalLibraryCall(current))
                            )
                                effects = true;
                        } else if (
                            ts.isPropertyAccessExpression(current) ||
                            ts.isElementAccessExpression(current)
                        ) {
                            const symbol = resolvedSymbol(
                                this.checker,
                                current,
                            );
                            const root = libraryGlobal(
                                this.checker,
                                rootExpression(current),
                            );
                            effects =
                                declaredInDomLibrary(symbol) ||
                                declaredInDomLibrary(
                                    this.checker
                                        .getTypeAtLocation(current.expression)
                                        .getSymbol(),
                                ) ||
                                memberAccessors(this.checker, current, "get")
                                    .length > 0 ||
                                root === "globalThis" ||
                                root === "window" ||
                                root === "self";
                        }
                    },
                    { functions: "skip", types: "skip", names: "references" },
                );
                if (effects) return true;
            }
            // Fresh-local heap facts differ, but module admission reads only
            // unknown accesses and callees, which are independent of that frame.
            const direct = unit
                ? this.directAccess(unit)
                : this.walk(roots, undefined);
            const access = emptyAccess();
            mergeDirect(access, direct, "operands");
            if (access.reads.any || access.writes.any) return true;
            for (const callee of direct.callees)
                if (visitUnit(callee)) return true;
            return false;
        };
        const result = visit([node]);
        this.moduleEffects.set(node, result);
        return result;
    }

    /** Library container work stays local; its callbacks are visited by `walk`. */
    private moduleLocalLibraryCall(
        call: ts.CallExpression | ts.NewExpression,
    ): boolean {
        const declaration = calledDeclaration(this.checker, call);
        if (!declaration || declarationOrigin(declaration) !== "default-lib")
            return false;
        if (this.libraryAnswersFromArguments(call)) {
            const callee = namedMember(
                this.checker,
                unwrapExpression(call.expression),
            );
            // These conversions can throw for a source-provided precision or
            // radix even though their answer otherwise depends only on it.
            return !(
                (call.arguments?.length ?? 0) > 0 &&
                callee !== undefined &&
                [
                    "toFixed",
                    "toExponential",
                    "toPrecision",
                    "toString",
                ].includes(callee.name)
            );
        }
        const owner = declaration.parent;
        if (!ts.isInterfaceDeclaration(owner)) return false;
        const args = call.arguments ?? [];
        if (
            owner.name.text.endsWith("Constructor") &&
            TYPED_ARRAY_KINDS.has(
                owner.name.text.slice(0, -"Constructor".length),
            )
        ) {
            if (args.length === 0) return true;
            if (args.length !== 1) return false;
            const elements = unwrapExpression(args[0]!);
            return (
                ts.isArrayLiteralExpression(elements) &&
                elements.elements.every(
                    (element) =>
                        !ts.isSpreadElement(element) &&
                        valueKindOf(this.checker.getTypeAtLocation(element)) ===
                            "number",
                )
            );
        }
        if (
            owner.name.text === "ObjectConstructor" &&
            "name" in declaration &&
            declaration.name &&
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === "assign"
        ) {
            // Assign reads source getters as well as writing the target. Keep
            // accessor-bearing or unrepresented sources on the runtime path.
            return (
                args.length > 0 &&
                args.every((argument, index) => {
                    const type = this.checker.getTypeAtLocation(argument);
                    return (
                        !type.isUnion() &&
                        (type.flags & ts.TypeFlags.Object) !== 0 &&
                        type.getProperties().length > 0 &&
                        type
                            .getProperties()
                            .every(
                                (property) =>
                                    !property.declarations?.some(
                                        index === 0
                                            ? ts.isAccessor
                                            : ts.isGetAccessorDeclaration,
                                    ),
                            )
                    );
                })
            );
        }
        if (
            ![
                "Array",
                "ReadonlyArray",
                "ArrayConstructor",
                "Map",
                "ReadonlyMap",
                "MapConstructor",
                "Set",
                "ReadonlySet",
                "SetConstructor",
                "WeakMap",
                "WeakMapConstructor",
                "WeakSet",
                "WeakSetConstructor",
            ].includes(owner.name.text)
        )
            return false;
        if (owner.name.text.endsWith("Constructor")) {
            if (args.length === 0) return true;
            if (
                !["MapConstructor", "SetConstructor"].includes(
                    owner.name.text,
                ) ||
                args.length !== 1
            )
                return false;
            const entries = unwrapExpression(args[0]!);
            return (
                ts.isArrayLiteralExpression(entries) &&
                entries.elements.every(
                    (entry) =>
                        !ts.isSpreadElement(entry) &&
                        !ts.isOmittedExpression(entry) &&
                        (owner.name.text === "SetConstructor" ||
                            ts.isArrayLiteralExpression(
                                unwrapExpression(entry),
                            )),
                )
            );
        }
        if (owner.name.text.startsWith("Weak")) return false;
        const callee = namedMember(
            this.checker,
            unwrapExpression(call.expression),
        );
        if (!callee) return false;
        const receiver = this.checker.getTypeAtLocation(
            unwrapExpression(callee.expression),
        );
        const receiverKinds = valueKinds(receiver);
        if (
            receiverKinds.has("null") ||
            receiverKinds.has("undefined") ||
            receiverKinds.has("unknown")
        )
            return false;
        if (
            ![
                "push",
                "pop",
                "shift",
                "unshift",
                "splice",
                "slice",
                "concat",
                "map",
                "filter",
                "find",
                "findIndex",
                "findLast",
                "findLastIndex",
                "some",
                "every",
                "forEach",
                "includes",
                "indexOf",
                "lastIndexOf",
                "join",
                "reverse",
                "sort",
                "toReversed",
                "toSorted",
                "fill",
                "copyWithin",
                "at",
                "reduce",
                "reduceRight",
                "get",
                "set",
                "add",
                "has",
                "delete",
                "clear",
                "keys",
                "values",
                "entries",
            ].includes(callee.name)
        )
            return false;
        // Reducing an empty sequence without an initial value throws.
        if (
            "name" in declaration &&
            declaration.name &&
            ts.isIdentifier(declaration.name) &&
            ["reduce", "reduceRight"].includes(declaration.name.text) &&
            (call.arguments?.length ?? 0) < 2
        )
            return false;
        return true;
    }

    /**
     * Whether every call `unit` makes, with the functions and accessors it
     * reaches, answers from its arguments. The storage model above treats a
     * library call on a global (`Date.now()`, `performance.now()`,
     * `localStorage.getItem`) as touching no program state, which orders
     * operands correctly but says nothing of the clock, the page or the
     * network behind it. So only the library functions known to answer
     * from their arguments qualify: `Math`'s but `random`, the primitive
     * conversions, and a primitive receiver's own methods other than the
     * locale-dependent ones. An engine call, a construction of a library
     * class, a callback handed to the library, and a call the analysis
     * cannot follow do not. The units checked are the ones `summary`
     * reaches, getters and setters included.
     */
    private answersFromArguments(unit: Unit): boolean {
        const known = this.deterministic.get(unit);
        if (known !== undefined) return known;
        const reached = new Set<Unit>([unit]);
        const pending: Unit[] = [unit];
        let answers = true;
        for (let next = pending.pop(); next && answers; next = pending.pop()) {
            answers = this.callsAnswerFromArguments(next);
            this.directAccess(next).callees.forEach((callee) => {
                if (reached.has(callee)) return;
                reached.add(callee);
                pending.push(callee);
            });
        }
        this.deterministic.set(unit, answers);
        return answers;
    }

    /** Whether each call `unit` makes itself is to a reachable unit or answers from its arguments. */
    private callsAnswerFromArguments(unit: Unit): boolean {
        const roots = unitRoots(unit);
        // A unit's own calls are checked where `answersFromArguments`
        // reaches it.
        return this.callsAnswer(roots, () => true);
    }

    /**
     * Whether each call or construction under `roots` answers from its
     * arguments: a library call one `answersFromArguments` trusts, a call
     * into code the analysis follows as `units` judges its callees.
     */
    private callsAnswer(
        roots: readonly ts.Node[],
        units: (callees: readonly Unit[]) => boolean,
    ): boolean {
        let answers = true;
        const visit = (current: ts.Node): "skip" | void => {
            if (!answers) return "skip";
            if (!ts.isCallExpression(current) && !ts.isNewExpression(current))
                return;
            const callees = this.callUnits(current);
            answers =
                callees === "library"
                    ? this.libraryAnswersFromArguments(current)
                    : !!callees && units(callees);
        };
        roots.forEach((root) =>
            forEachAnalysisNode(root, visit, {
                functions: "skip",
                types: "skip",
                names: "references",
            }),
        );
        return answers;
    }

    /** Whether a library call is one `answersFromArguments` trusts. */
    private libraryAnswersFromArguments(
        call: ts.CallExpression | ts.NewExpression,
    ): boolean {
        if (ts.isNewExpression(call)) return false;
        if (
            call.arguments.some(
                (argument) =>
                    callSignatures(
                        this.checker,
                        this.checker.getTypeAtLocation(argument),
                        "exact",
                    ).length > 0,
            )
        )
            return false;
        const callee = unwrapExpression(call.expression);
        if (ts.isIdentifier(callee))
            return (
                libraryGlobal(this.checker, callee) !== undefined &&
                argumentAnsweringGlobals.has(callee.text)
            );
        const member = namedMember(this.checker, callee);
        if (!member) return false;
        if (libraryGlobal(this.checker, member.expression) === "Math")
            return !mathMemberIsImpure(member.name);
        return (
            this.isPrimitive(member.expression) &&
            !member.name.startsWith("toLocale") &&
            member.name !== "localeCompare"
        );
    }

    /** Everything evaluating `node` touches, the functions it calls included. */
    private access(node: ts.Node): Access {
        const known = this.accesses.get(node);
        if (known) return known;
        const direct = this.walk([node], undefined);
        const access = emptyAccess();
        mergeDirect(access, direct, "operands");
        direct.callees.forEach((callee) =>
            mergeAccess(access, this.summary(callee)),
        );
        this.accesses.set(node, access);
        return access;
    }

    /**
     * Everything `parts` and the functions they run read and write, as the
     * order JavaScript defers code in sees it: a library operation's work
     * shows only in its result, and what runs while a job waits is another
     * start's.
     */
    public footprint(parts: readonly CodePart[]): Access {
        const total = emptyAccess();
        for (const part of parts) mergeAccess(total, this.partFootprint(part));
        return total;
    }

    private partFootprint(part: CodePart): Access {
        const region = !part.owner && !part.without;
        if (region && isUnit(part.node))
            return this.summary(part.node, "order");
        const known = region ? this.regions.get(part.node) : undefined;
        if (known) return known;
        const owner = part.owner && isUnit(part.owner) ? part.owner : undefined;
        const direct = this.walk([part.node], owner, part.without);
        const footprint = emptyAccess();
        mergeDirect(footprint, direct, "order");
        for (const callee of direct.callees)
            mergeAccess(footprint, this.summary(callee, "order"));
        // The variables of the run `part` belongs to are that run's own.
        if (owner)
            for (const storage of [footprint.reads, footprint.writes])
                storage.variables.forEach((variable) => {
                    if (
                        typeof variable !== "symbol" &&
                        this.frameOf(variable) === owner
                    )
                        storage.variables.delete(variable);
                });
        if (region) this.regions.set(part.node, footprint);
        return footprint;
    }

    /**
     * The program code evaluating `node` runs, transitively: the function
     * bodies of its calls and constructions (every override a method
     * dispatches to, a class's field initializers), the accessors its
     * property reads and writes run, and the callbacks it hands library
     * functions. `opaque` when it runs program code the analysis cannot
     * follow (a function value it cannot name, an overridable accessor, an
     * `await`), which may write anything. An engine call is not followed:
     * what it writes of the program's objects is what it is handed.
     */
    public reachedCode(node: ts.Node): {
        readonly units: ReadonlySet<ts.Node>;
        readonly opaque: boolean;
    } {
        const direct = this.walk([node], undefined);
        let opaque = direct.opaque || direct.suspends;
        const units = new Set<ts.Node>();
        const pending = [...direct.callees];
        for (let next = pending.pop(); next; next = pending.pop()) {
            if (units.has(next)) continue;
            units.add(next);
            const access = this.directAccess(next);
            opaque ||= access.opaque || access.suspends;
            pending.push(...access.callees);
        }
        return { units, opaque };
    }

    /**
     * Whether a value built from `built` must be read before a call to
     * `callee` runs, rather than where the callee reads it: building it has
     * an effect, or the callee (with everything it reaches) writes storage
     * the value reads.
     */
    public calleeChanges(built: ts.Node, callee: ts.Node): boolean {
        const access = this.access(built);
        if (touchesAnything(access.writes)) return true;
        const units = this.declarationUnits(callee);
        return !units || touches(this.bodyAccess(units).writes, access.reads);
    }

    /**
     * The code calling a declaration runs: a constructor's whole chain, every
     * implementation an overridden method dispatches to, a function's body;
     * undefined for a declaration without one.
     */
    private declarationUnits(
        declaration: ts.Node,
    ): readonly Unit[] | undefined {
        if (ts.isConstructorDeclaration(declaration))
            return ts.isClassLike(declaration.parent)
                ? this.construction(declaration.parent)
                : undefined;
        if (ts.isMethodDeclaration(declaration))
            return this.hierarchy.dispatchBodies(declaration);
        if (ts.isAccessor(declaration))
            return declaration.body &&
                !(
                    ts.isClassLike(declaration.parent) &&
                    this.hierarchy.subclasses(declaration.parent).length > 0
                )
                ? [declaration]
                : undefined;
        return (ts.isFunctionDeclaration(declaration) ||
            ts.isFunctionExpression(declaration) ||
            ts.isArrowFunction(declaration)) &&
            declaration.body
            ? [declaration]
            : undefined;
    }

    /**
     * What running the units touches outside their own frames, merged: the
     * access a call reaching any of them may have.
     */
    public bodyAccess(units: readonly Unit[]): Access {
        const access = emptyAccess();
        units.forEach((unit) => mergeAccess(access, this.summary(unit)));
        return access;
    }

    /**
     * What running `unit` touches outside its own frame: its own body and
     * every function it can reach, less the variables those functions
     * declare -- each run has fresh ones no caller can see. A function that
     * encloses `unit` is the exception: its variables are the ones `unit`
     * closes over.
     */
    private summary(unit: Unit, view: View = "operands"): Access {
        const cache =
            view === "operands" ? this.summaries : this.orderSummaries;
        const known = cache.get(unit);
        if (known) return known;
        const summary = emptyAccess();
        const reached = new Set<Unit>([unit]);
        const pending: Unit[] = [unit];
        for (let next = pending.pop(); next; next = pending.pop()) {
            const direct = this.directAccess(next);
            mergeDirect(summary, direct, view);
            if (summary.reads.any && summary.writes.any) break;
            direct.callees.forEach((callee) => {
                if (reached.has(callee)) return;
                reached.add(callee);
                pending.push(callee);
            });
        }
        for (const storage of [summary.reads, summary.writes]) {
            storage.variables.forEach((variable) => {
                if (typeof variable === "symbol") return;
                const frame = this.frameOf(variable);
                if (
                    frame &&
                    reached.has(frame) &&
                    !(frame !== unit && encloses(frame, unit))
                )
                    storage.variables.delete(variable);
            });
        }
        cache.set(unit, summary);
        return summary;
    }

    private directAccess(unit: Unit): DirectAccess {
        const known = this.direct.get(unit);
        if (known) return known;
        const roots = unitRoots(unit);
        const direct = this.walk(roots, unit);
        this.direct.set(unit, direct);
        return direct;
    }

    /**
     * The storage `roots` touch themselves, and the functions they call;
     * `without` is a subtree that does not run.
     */
    private walk(
        roots: readonly ts.Node[],
        unit: Unit | undefined,
        without?: ts.Node,
    ): DirectAccess {
        const access: DirectAccess = {
            ...emptyAccess(),
            callees: new Set(),
            opaque: false,
            suspends: false,
            library: emptyAccess(),
        };
        const visit = (current: ts.Node): "skip" | void => {
            if (current === without) return "skip";
            for (const site of writeSites(current))
                this.write(access, site.target, unit);
            if (ts.isAwaitExpression(current)) {
                access.suspends = true;
            } else if (ts.isTaggedTemplateExpression(current)) {
                this.taggedTemplate(access, current);
            } else if (
                ts.isCallExpression(current) ||
                ts.isNewExpression(current)
            ) {
                this.call(access, current, unit);
            } else if (isMemberAccess(current)) {
                return this.read(access, current, unit);
            } else if (ts.isIdentifier(current)) {
                const symbol = resolvedSymbol(this.checker, current);
                if (symbol && this.isWrittenVariable(symbol))
                    access.reads.variables.add(symbol);
            } else if (
                ts.isSpreadElement(current) ||
                ts.isForOfStatement(current)
            ) {
                this.iterate(access, current.expression, unit);
            } else if (
                ts.isVariableDeclaration(current) &&
                ts.isArrayBindingPattern(current.name) &&
                current.initializer
            ) {
                this.iterate(access, current.initializer, unit);
            }
        };
        roots.forEach((root) =>
            forEachAnalysisNode(root, visit, {
                functions: "skip",
                types: "skip",
                names: "references",
            }),
        );
        return access;
    }

    /**
     * Iterating reads the elements it walks; a protocol a program's
     * generator or class may implement runs code the analysis cannot follow.
     */
    private iterate(
        access: DirectAccess,
        iterated: ts.Expression,
        unit: Unit | undefined,
    ): void {
        const family = this.objectOf(iterated, unit);
        if (family) access.reads.objects.add(family);
        if (!iteratesLibraryCollection(this.checker, iterated))
            cannotFollow(access);
    }

    private read(
        access: DirectAccess,
        node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
        unit: Unit | undefined,
    ): "skip" | void {
        if (this.isConstant(node)) return "skip";
        this.runs(access, this.accessorUnits(node, "get"));
        const family = this.objectOf(node.expression, unit);
        if (family) access.reads.objects.add(family);
    }

    /**
     * Whether a member read reads a value that never changes: an enum
     * member, a pinned constant, or a library global's own constant
     * (`Math.PI`) or function (`Math.sin`).
     */
    private isConstant(
        node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    ): boolean {
        const symbol = resolvedSymbol(this.checker, node);
        if (!symbol) return false;
        return (
            (symbol.flags & ts.SymbolFlags.EnumMember) !== 0 ||
            (ts.isPropertyAccessExpression(node) &&
                pinnedConstantProperty(this.checker, node) !== undefined) ||
            (declaredInDefaultLibrary(symbol) &&
                libraryGlobal(this.checker, node.expression) !== undefined &&
                ((symbol.flags & ts.SymbolFlags.Method) !== 0 ||
                    propertyIsReadOnly(symbol)))
        );
    }

    private write(
        access: DirectAccess,
        target: ts.Expression,
        unit: Unit | undefined,
    ): void {
        const node = unwrapExpression(target);
        if (ts.isIdentifier(node)) {
            const symbol = resolvedSymbol(this.checker, node);
            if (!symbol) access.writes.any = true;
            // A host global (`onresize = ...`) is a property of its object.
            else if (
                symbol.declarations?.some(
                    (declaration) =>
                        declaration.getSourceFile().isDeclarationFile,
                )
            )
                access.writes.objects.add("objects");
            else access.writes.variables.add(symbol);
            return;
        }
        const member = isMemberAccess(node) ? node : undefined;
        if (member) this.runs(access, this.accessorUnits(member, "set"));
        const family = member
            ? this.objectOf(member.expression, unit)
            : "objects";
        if (!family) return;
        access.writes.objects.add(family);
        if (
            !member ||
            this.mayHoldArray(this.checker.getTypeAtLocation(member.expression))
        )
            access.writes.arrays = true;
    }

    /**
     * Whether an object of `type` may be an array or a typed array: one of
     * those, `any`, `unknown`, `object`, a type parameter whose constraint
     * admits one, or another type an array can be assigned to
     * (`{ length: number }`, `Iterable<T>`).
     */
    private mayHoldArray(type: ts.Type): boolean {
        if (
            type.flags &
            (ts.TypeFlags.Any |
                ts.TypeFlags.Unknown |
                ts.TypeFlags.NonPrimitive)
        )
            return true;
        if (type.flags & ts.TypeFlags.InstantiableNonPrimitive) {
            // A class's `this` is a type parameter constrained by the class.
            const constraint = this.checker.getBaseConstraintOfType(type);
            return (
                !constraint ||
                constraint === type ||
                this.mayHoldArray(constraint)
            );
        }
        if (type.isUnionOrIntersection())
            return type.types.some((member) => this.mayHoldArray(member));
        if ((type.flags & ts.TypeFlags.Object) === 0) return false;
        const name = type.getSymbol()?.name;
        if (
            this.checker.isArrayLikeType(type) ||
            (name !== undefined && TYPED_ARRAY_KINDS.has(name))
        )
            return true;
        this.anyArray ??= this.libraryAnyArray() ?? null;
        return (
            this.anyArray === null ||
            this.checker.isTypeAssignableTo(this.anyArray, type)
        );
    }

    /** `any[]`, the type `Array.isArray` asserts, from the language's library. */
    private libraryAnyArray(): ts.Type | undefined {
        const array = this.checker.resolveName(
            "Array",
            undefined,
            ts.SymbolFlags.Value,
            false,
        );
        const isArray =
            array && this.checker.getTypeOfSymbol(array).getProperty("isArray");
        const signature =
            isArray &&
            callSignatures(
                this.checker,
                this.checker.getTypeOfSymbol(isArray),
                "exact",
            )[0];
        return (
            signature && this.checker.getTypePredicateOfSignature(signature)
        )?.type;
    }

    /**
     * The program accessors a member read (`get`) or write (`set`) runs, or
     * undefined when one has no body or an override may run instead.
     */
    public accessorUnits(
        access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
        half: "get" | "set",
    ): readonly ts.AccessorDeclaration[] | undefined {
        const accessors = memberAccessors(this.checker, access, half).filter(
            (accessor) => !accessor.getSourceFile().isDeclarationFile,
        );
        return accessors.every(
            (accessor) =>
                accessor.body !== undefined &&
                !(
                    ts.isClassLike(accessor.parent) &&
                    this.hierarchy.subclasses(accessor.parent).length > 0
                ),
        )
            ? accessors
            : undefined;
    }

    /** Record that `access` runs `accessors`, or anything when they cannot be followed. */
    private runs(
        access: DirectAccess,
        accessors: readonly ts.AccessorDeclaration[] | undefined,
    ): void {
        if (!accessors) cannotFollow(access);
        else for (const accessor of accessors) access.callees.add(accessor);
    }

    private call(
        access: DirectAccess,
        call: ts.CallExpression | ts.NewExpression,
        unit: Unit | undefined,
    ): void {
        const shared = sharedLibraryState(this.checker, call);
        if (shared) {
            access.reads.variables.add(shared);
            if (shared === randomState) access.writes.variables.add(shared);
            return;
        }
        const units = this.callUnits(call);
        if (units === "library") {
            this.libraryCall(access, call, unit);
            return;
        }
        if (!units) cannotFollow(access);
        else units.forEach((callee) => access.callees.add(callee));
    }

    /**
     * A tag runs as a call of its strings and values: the engine's tag
     * (`wgsl`) from its pinned body, a program function from its own. Any
     * other tag cannot be followed.
     */
    private taggedTemplate(
        access: DirectAccess,
        node: ts.TaggedTemplateExpression,
    ): void {
        const declaration = calledDeclaration(this.checker, node);
        if (declaration && isEngineDeclaration(declaration)) {
            mergeAccess(access.library, this.engineCode(node));
            return;
        }
        const tag = unwrapExpression(node.tag);
        const named =
            declaration &&
            !declaration.getSourceFile().isDeclarationFile &&
            (ts.isIdentifier(tag) || ts.isPropertyAccessExpression(tag))
                ? this.namedFunction(tag)
                : undefined;
        if (named) access.callees.add(named);
        else cannotFollow(access);
    }

    /**
     * What an engine call's own code touches, from the pinned bodies its
     * typing names: everything when it names none or runs code the pinned
     * bodies cannot follow, otherwise the objects and engine state they
     * read and write. Nothing for a construction, or without the pin.
     */
    private engineCode(
        call:
            ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression,
    ): Access {
        const access = emptyAccess();
        if (!this.engine || ts.isNewExpression(call)) return access;
        const declaration = calledDeclaration(this.checker, call);
        if (!declaration) return access;
        const engine = this.engine();
        const bodies = engine.bodies(declaration);
        if (!bodies) {
            touchEverything(access);
            return access;
        }
        let pinned = pinnedOrders.get(engine);
        if (!pinned) {
            pinned = new EvaluationOrder(engine.checker, engine.hierarchy);
            pinnedOrders.set(engine, pinned);
        }
        const summary = pinned.bodyAccess(bodies);
        // The engine's own variables are state only its calls reach: to the
        // scene they are one store with the objects it holds.
        const asScene = (from: Storage, into: Storage): void => {
            into.any = from.any;
            into.arrays = from.arrays;
            if (from.objects.size > 0 || from.variables.size > 0)
                into.objects.add("engine");
        };
        asScene(summary.reads, access.reads);
        asScene(summary.writes, access.writes);
        return access;
    }

    /**
     * A library call as its result and what it is handed show it: it reads
     * its receiver and the objects it is handed, writes its receiver through
     * a mutating method and the argument it fills, and runs the functions
     * it is handed. A page method changes its object and what it is handed
     * unless it only reads the page or creates a node, one that dispatches
     * an event runs its listeners, and a global page function changes the
     * page. What an asynchronous operation reads and changes of what it
     * is handed is its own work until it settles, and the engine's code is
     * its pinned bodies': both only the operand question reads.
     */
    private libraryCall(
        access: DirectAccess,
        call: ts.CallExpression | ts.NewExpression,
        unit: Unit | undefined,
    ): void {
        const checker = this.checker;
        const declaration = calledDeclaration(checker, call);
        const origin = declaration && declarationOrigin(declaration);
        if (origin === "babylon")
            mergeAccess(access.library, this.engineCode(call));
        const callee = ts.isCallExpression(call)
            ? namedMember(checker, unwrapExpression(call.expression))
            : undefined;
        // What an asynchronous operation does with what it is handed is its
        // own work until it settles.
        const work =
            ts.isCallExpression(call) &&
            libraryName(checker.getTypeAtLocation(call)) === "Promise"
                ? access.library
                : access;
        const change = (expression: ts.Expression): void => {
            const family = this.objectOf(expression, unit);
            if (!family) return;
            work.writes.objects.add(family);
            if (this.mayHoldArray(checker.getTypeAtLocation(expression)))
                work.writes.arrays = true;
        };
        const page =
            origin === "dom" && callee
                ? PAGE_ACCESSES.get(callee.name)
                : undefined;
        if (
            origin === "dom" &&
            callee &&
            LISTENER_RUNNING_METHODS.has(callee.name)
        )
            touchEverything(access);
        const receiver = callee?.expression;
        if (receiver && !this.isPrimitive(receiver)) {
            // A library global (`Math`, `document`) is no object a program
            // reads; the page's own are its state.
            const global = libraryGlobal(checker, receiver) !== undefined;
            if (!global) {
                const family = this.objectOf(receiver, unit);
                if (family) work.reads.objects.add(family);
                const platform = platformMethodEffect(
                    checker.getTypeAtLocation(receiver),
                    callee.name,
                );
                // Aborting runs the signal's listeners: any program code.
                if (platform === "runs-code") touchEverything(access);
                else if (platform === "writes-receiver") change(receiver);
            }
            if (
                origin === "dom"
                    ? page === undefined
                    : !global &&
                      libraryMethodWritesReceiver(
                          checker,
                          receiver,
                          callee.name,
                      )
            )
                change(receiver);
        }
        const handed = handedFunctions(checker, call.arguments ?? []);
        if (!handed) cannotFollow(access);
        for (const fn of handed ?? []) this.handed(access, fn);
        for (const argument of call.arguments ?? []) {
            const type = checker.getTypeAtLocation(argument);
            if (callSignatures(checker, type, "present").length > 0) continue;
            const family = this.objectOf(argument, unit);
            if (family) work.reads.objects.add(family);
        }
        if (!ts.isCallExpression(call)) return;
        if (origin === "babylon") {
            const target = callTarget(checker, call);
            call.arguments.forEach((argument, index) => {
                if (
                    target.kind !== "bodies" ||
                    engineCallMutatesArgument(checker, call, index, target)
                )
                    change(argument);
            });
            return;
        }
        const written = libraryWrittenArgument(checker, call);
        if (written) change(written);
        if (origin !== "dom" || page !== undefined) return;
        if (!callee) work.writes.objects.add("page");
        else
            for (const argument of call.arguments)
                if (typeCanCarryReference(checker.getTypeAtLocation(argument)))
                    change(argument);
    }

    /**
     * A function a library call is handed, which it may run: a function
     * literal or method, a named function, or a library function handed on
     * (`map(Number)`), which runs as a library call over the values it is
     * given. Any other function value cannot be followed.
     */
    private handed(access: DirectAccess, fn: ts.Node): void {
        if (isUnit(fn)) {
            access.callees.add(fn);
            return;
        }
        if (!ts.isExpression(fn)) {
            cannotFollow(access);
            return;
        }
        const expression = unwrapExpression(fn);
        if (
            ts.isArrowFunction(expression) ||
            ts.isFunctionExpression(expression)
        ) {
            access.callees.add(expression);
            return;
        }
        if (this.isRandom(expression)) {
            access.reads.variables.add(randomState);
            access.writes.variables.add(randomState);
            return;
        }
        const declarations =
            resolvedSymbol(this.checker, expression)?.declarations ?? [];
        if (
            declarations.length > 0 &&
            declarations.every(
                (declaration) => declaration.getSourceFile().isDeclarationFile,
            )
        )
            return;
        const declaration = this.namedFunction(expression);
        if (declaration) access.callees.add(declaration);
        else cannotFollow(access);
    }

    /**
     * The function bodies a call runs (`callees` without a construction's
     * field initializers), "library" for a declaration file's function, or
     * undefined when they cannot be named.
     */
    public callBodies(
        call: ts.CallExpression,
    ): readonly ts.FunctionLikeDeclaration[] | "library" | undefined {
        const units = this.callUnits(call);
        if (units === "library" || units === undefined) return units;
        return units.every(
            (unit): unit is ts.FunctionLikeDeclaration =>
                !ts.isPropertyDeclaration(unit),
        )
            ? units
            : undefined;
    }

    /**
     * The code a call or construction runs: the function bodies it can
     * reach -- every implementation an overridden method can dispatch to, a
     * class chain's constructors with its field initializers -- "library"
     * for a declaration file's function, or undefined when it cannot be
     * named.
     */
    public callUnits(
        call: ts.CallExpression | ts.NewExpression,
    ): readonly Unit[] | "library" | undefined {
        if (call.expression.kind === ts.SyntaxKind.SuperKeyword) {
            const owner = ts.findAncestor(call, ts.isClassLike);
            const base = owner && this.hierarchy.table(owner).base?.declaration;
            return base ? this.construction(base) : undefined;
        }
        if (ts.isNewExpression(call)) {
            const declaration = localClassOfSymbol(
                resolvedSymbol(this.checker, unwrapExpression(call.expression)),
            );
            if (declaration && !declaration.getSourceFile().isDeclarationFile)
                return this.construction(declaration);
            return calledDeclaration(this.checker, call)?.getSourceFile()
                .isDeclarationFile || declaration
                ? "library"
                : undefined;
        }
        const declaration = calledDeclaration(this.checker, call);
        if (!declaration) return undefined;
        if (declaration.getSourceFile().isDeclarationFile) return "library";
        const callee = unwrapExpression(call.expression);
        if (ts.isMethodDeclaration(declaration))
            return this.declarationUnits(declaration);
        // A function reached through a variable or a property is that
        // function only while nothing stores another one there.
        if (ts.isIdentifier(callee) || namedMember(this.checker, callee)) {
            const named = this.namedFunction(callee);
            return named ? [named] : undefined;
        }
        return ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)
            ? [callee]
            : undefined;
    }

    /** Whether an expression is the language's `Math.random`. */
    private isRandom(expression: ts.Expression): boolean {
        const access = mathMemberAccess(
            unwrapExpression(expression),
            (owner) => libraryGlobal(this.checker, owner),
            (node) => namedMember(this.checker, node),
        );
        return access !== undefined && mathMemberIsImpure(access.name);
    }

    /** Whether every value an expression can have is a primitive, which no code can change in place. */
    private isPrimitive(expression: ts.Expression): boolean {
        return holdsOnly(
            this.checker.getTypeAtLocation(expression),
            PRIMITIVE_KINDS,
        );
    }

    /** The function a name always holds: a function declaration, or a never-reassigned `const`. */
    private namedFunction(
        expression: ts.Expression,
    ): ts.FunctionLikeDeclaration | undefined {
        const unwrapped = unwrapExpression(expression);
        const member = namedMember(this.checker, unwrapped);
        const symbol = member
            ? accessedPropertySymbol(this.checker, member.access)
            : resolvedSymbol(this.checker, unwrapped);
        const declaration = symbol?.valueDeclaration;
        if (!symbol || !declaration) return undefined;
        if (ts.isFunctionDeclaration(declaration)) {
            return symbol.declarations?.find(
                (candidate): candidate is ts.FunctionDeclaration =>
                    ts.isFunctionDeclaration(candidate) &&
                    candidate.body !== undefined,
            );
        }
        if (
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer &&
            !this.isWrittenVariable(symbol)
        ) {
            const initializer = unwrapExpression(declaration.initializer);
            if (
                ts.isArrowFunction(initializer) ||
                ts.isFunctionExpression(initializer)
            )
                return initializer;
        }
        return undefined;
    }

    /** The constructors and field initializers `new` of a class runs, or undefined past a non-local base. */
    private construction(
        declaration: ts.ClassLikeDeclaration,
    ): readonly Unit[] | undefined {
        const units: Unit[] = [];
        for (const link of classChain(this.hierarchy.table(declaration))) {
            if (link.unsupportedHeritage) return undefined;
            const constructor = link.constructorDeclaration;
            if (constructor) {
                if (!constructor.body) return undefined;
                units.push(constructor);
            }
            link.fields.forEach((field) => units.push(field));
        }
        return units;
    }

    /**
     * The family of the object `expression` evaluates to, or undefined for
     * a primitive or an object only this run of `unit` reaches.
     */
    private objectOf(
        expression: ts.Expression,
        unit: Unit | undefined,
    ): ObjectFamily | undefined {
        return this.isPrivate(expression, unit)
            ? undefined
            : objectFamily(this.checker, expression);
    }

    /**
     * Whether `expression` evaluates to an object only one run of `unit`
     * reaches: a fresh object, the module's metadata, one a private binding
     * holds ({@link privateObjects}), or the object a constructor or field
     * initializer is building.
     */
    private isPrivate(
        expression: ts.Expression,
        unit: Unit | undefined,
    ): boolean {
        const base = unwrapExpression(expression);
        if (ts.isMetaProperty(base) || freshValue(this.checker, base))
            return true;
        if (!unit) return false;
        if (base.kind === ts.SyntaxKind.ThisKeyword)
            return (
                ts.isConstructorDeclaration(unit) ||
                ts.isPropertyDeclaration(unit)
            );
        if (!ts.isIdentifier(base)) return false;
        const symbol = resolvedSymbol(this.checker, base);
        return (
            symbol !== undefined &&
            privateObjects(this.checker, unit).has(symbol)
        );
    }

    /** The function whose frame a local variable or parameter lives in. */
    private frameOf(symbol: ts.Symbol): Unit | undefined {
        const declaration = symbol.valueDeclaration;
        if (
            !declaration ||
            !(
                ts.isVariableDeclaration(declaration) ||
                ts.isParameter(declaration) ||
                ts.isBindingElement(declaration)
            )
        )
            return undefined;
        const container = evaluationContainer(declaration);
        return ts.isFunctionLike(container) && "body" in container
            ? container
            : undefined;
    }
    /** Whether any code in its file assigns the variable after its declaration. */
    private isWrittenVariable(symbol: ts.Symbol): boolean {
        if ((symbol.flags & ts.SymbolFlags.Variable) === 0) return false;
        const file = symbol.valueDeclaration?.getSourceFile();
        return file !== undefined && isRebound(this.checker, [file], symbol);
    }
}

/** `cpp` evaluated here, in source order, into a temporary named after `label`. */
export function pinCpp(
    context: Pick<LoweringServices, "allocateTemporaryCppName" | "emit">,
    cpp: string,
    label: string,
    type = "const auto",
): string {
    const name = context.allocateTemporaryCppName(label);
    context.emit({ kind: "declaration", type, name, initializer: cpp });
    return name;
}

/**
 * An operand read where JavaScript reads it: a value the compiler already
 * knows is that value's literal, anything else a temporary.
 */
export function pinOperand(
    context: Pick<LoweringServices, "bindings"> & ScalarReadContext,
    value: Value,
    node: ts.Expression,
    label: string,
): Value {
    return (
        readScalarOperand(context, value, label) ??
        context.bindings.pinValueToTemporary(value, label, node)
    );
}

type ScalarReadContext = Pick<
    LoweringServices,
    | "cppString"
    | "dataTypes"
    | "allocateTemporaryCppName"
    | "emit"
    | "registerNativeConstBinding"
    | "registerNativeBindingType"
    | "reachJsData"
>;

/**
 * A scalar operand read where it stands: its literal when generation knows
 * it, otherwise a constant temporary. Undefined for any other value.
 */
export function readScalarOperand(
    context: ScalarReadContext,
    value: Value,
    label: string,
): Value | undefined {
    // A known payload does not replace its optional or union container:
    // later consumers still inspect that storage's presence or active arm.
    const representation = value.dataType?.kind ?? value.kind;
    if (representation === "number" && value.staticNumber !== undefined)
        return { ...value, cpp: doubleLiteral(value.staticNumber) };
    if (representation === "boolean" && value.staticBoolean !== undefined)
        return { ...value, cpp: value.staticBoolean ? "true" : "false" };
    if (representation === "string" && value.staticString !== undefined)
        return { ...value, cpp: context.cppString(value.staticString) };
    // A scalar is copied where it stands. Its variable may be written by
    // the later operand, so its binding's own stability cannot stand in
    // for the read.
    const type =
        value.kind === "number"
            ? "double"
            : value.kind === "boolean"
              ? "bool"
              : value.kind === "string"
                ? "std::string"
                : value.kind === "data" &&
                    value.dataType &&
                    [
                        "number",
                        "boolean",
                        "string",
                        "enum",
                        "bigint",
                        "symbol",
                    ].includes(value.dataType.kind)
                  ? context.dataTypes.cppType(value.dataType)
                  : undefined;
    if (!type) return undefined;
    const name = context.allocateTemporaryCppName(label);
    const snapshot = type === "std::string" && readsNativeStorage(value);
    if (snapshot) context.reachJsData();
    context.emit({
        kind: "declaration",
        type: `const ${type}`,
        name,
        initializer: snapshot ? snapshotReadCpp(value) : value.cpp,
        attributes: "[[maybe_unused]] ",
    });
    context.registerNativeBindingType(name, `const ${type}`);
    return {
        ...value,
        cpp: name,
        nativeCaptures: [context.registerNativeConstBinding(name)],
        nativeBinding: true,
    };
}
