import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { engineBodies } from "./engine-bodies.js";
import { declarationOrigin, libraryGlobal } from "./symbols.js";
import {
    assignmentTargets,
    isAssignmentExpression,
    isUpdateExpression,
    unwrapExpression,
} from "./syntax.js";

/** A write's location and the static type of the object it writes. */
interface Write {
    readonly node: ts.Node;
    readonly type: ts.Type;
    /** The property written; absent when any property may be. */
    readonly property?: string;
}

/**
 * Where a program could tell a copied record from the object JavaScript
 * shares. Storing a record as another record type copies it natively; the
 * copy and the original agree for every read until one of them changes, is
 * compared or keyed by identity, or is enumerated beyond the copied fields.
 * The index lists, for the whole checked program, the static types of the
 * objects each such operation may touch:
 *
 * - writes: property assignments, updates, deletions, the reflective
 *   writers (`Object.assign` targets, `Object.defineProperty`, `Reflect`)
 *   and the arguments of engine or ambient functions, whose bodies may write
 *   them; numeric element writes reach array lanes, not record fields;
 * - identities: operands of `===`/`!==`/`==`/`!=` other than nullish
 *   literals, `Object.is`, `switch` subjects, `includes`/`indexOf`/
 *   `lastIndexOf` arguments, and the key or target types of constructed
 *   Map, Set, WeakMap, WeakSet, WeakRef and FinalizationRegistry values;
 * - enumerations: `Object.keys`/`values`/`entries`/`getOwnPropertyNames`/
 *   `getOwnPropertyDescriptors`/`hasOwn`, `Object.assign` sources, object
 *   spreads and rests, `for...in`, `in`, `hasOwnProperty`, `JSON.stringify`
 *   and `structuredClone`.
 *
 * A copy is unobservable when no write of a field it keeps can reach the
 * original or the copy, no identity use can reach the copy, and no
 * enumeration can reach the copy while the original carries or gains
 * properties the copy drops. A copy handed to a callee that only reads it
 * needs only that no such write runs during the call. Holders are judged by
 * assignability, so a record reaching an operation through another
 * structural type, `any`, `unknown` or a type parameter counts as reaching
 * it; a type assertion to a subtype of the copy's type, or out of `any` or
 * `unknown`, extends where the copy may flow.
 */
interface Observations {
    readonly writes: readonly Write[];
    readonly identities: readonly ts.Type[];
    readonly enumerations: readonly ts.Type[];
    /** Type assertions: what they assert, and whether the operand was untyped. */
    readonly assertions: readonly { asserted: ts.Type; open: boolean }[];
}

const indexes = new WeakMap<ts.TypeChecker, Observations>();

const IDENTITY_SEARCHES = new Set(["includes", "indexOf", "lastIndexOf"]);
const ENUMERATING_STATICS = new Set([
    "keys",
    "values",
    "entries",
    "getOwnPropertyNames",
    "getOwnPropertyDescriptors",
    "getOwnPropertyDescriptor",
    "hasOwn",
]);
const KEYED_COLLECTIONS = new Set([
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "WeakRef",
]);

/**
 * Why a native copy of a `source` record stored as `target` could be told
 * apart from the shared JavaScript object, or undefined when nothing in the
 * program can. `fields` are the properties the copy keeps; `carries` says
 * whether the source records have other properties the copy drops; an
 * `argument` handed to a callee that only reads it needs only the call's
 * writes.
 */
export function recordCopyObservation(
    checker: ts.TypeChecker,
    sources: readonly ts.SourceFile[],
    source: ts.Type,
    target: ts.Type,
    fields: readonly string[],
    carries: boolean,
    argument?: ts.Node,
): string | undefined {
    const observations = index(checker, sources);
    // A write through either the original or the copy is missed by the
    // other. Only the copy can be told apart by identity or enumeration,
    // and it flows only where its target type flows.
    const holdsEither = (holder: ts.Type): boolean =>
        holdsRecord(checker, holder, [source, target]);
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
    const holdsCopy = (holder: ts.Type): boolean =>
        holdsRecord(checker, holder, copyTypes);
    const writesRecord = ({ type, property }: Write): boolean =>
        (property === undefined || fields.includes(property)) &&
        holdsEither(type);
    const addsProperty = ({ type, property }: Write): boolean =>
        property !== undefined &&
        !fields.includes(property) &&
        holdsEither(type);
    // A copy handed to a callee that only reads it lives for the call:
    // only a write while the call runs can make it stale.
    const call = argument && readOnlyArgumentCall(checker, argument);
    if (call) {
        const bodies = callBodies(checker, call);
        if (!bodies) return "the call runs code the program does not hold";
        const during = observations.writes.find(
            (write) =>
                writesRecord(write) &&
                ts.findAncestor(write.node, (node) => bodies.has(node)) !==
                    undefined,
        );
        return during?.property === undefined && during
            ? "the call writes properties of such records"
            : during
              ? `the call writes '${during.property}' of such records`
              : undefined;
    }
    const written = observations.writes.find(writesRecord);
    if (written)
        return written.property === undefined
            ? "the program writes properties of such records"
            : `the program writes '${written.property}' of such records`;
    if (observations.identities.some(holdsCopy))
        return "the program compares or keys such records by identity";
    if (
        (carries || observations.writes.some(addsProperty)) &&
        observations.enumerations.some(holdsCopy)
    )
        return "the program enumerates properties of such records";
    return undefined;
}

/** Whether a value of type `holder` can be a record of one of `records`. */
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

const engineReads = new WeakMap<ts.Declaration, Map<number, boolean>>();

/** Whether every pinned body behind an engine declaration only reads parameter `position`. */
function engineReadsOnly(
    declaration: ts.Declaration,
    position: number,
): boolean {
    let byPosition = engineReads.get(declaration);
    if (!byPosition) {
        byPosition = new Map();
        engineReads.set(declaration, byPosition);
    }
    const known = byPosition.get(position);
    if (known !== undefined) return known;
    const bodies = engineBodies().bodies(declaration);
    const reads =
        bodies !== undefined &&
        bodies.length > 0 &&
        bodies.every(
            (body) =>
                (ts.isFunctionDeclaration(body) ||
                    ts.isMethodDeclaration(body) ||
                    ts.isArrowFunction(body) ||
                    ts.isFunctionExpression(body) ||
                    ts.isConstructorDeclaration(body)) &&
                body.body !== undefined &&
                readsParameterOnly(
                    engineBodies().checkerFor(body),
                    body,
                    position,
                    new Set(),
                ),
        );
    byPosition.set(position, reads);
    return reads;
}

function index(
    checker: ts.TypeChecker,
    sources: readonly ts.SourceFile[],
): Observations {
    const cached = indexes.get(checker);
    if (cached) return cached;
    const writes: Write[] = [];
    const identities: ts.Type[] = [];
    const enumerations: ts.Type[] = [];
    const assertions: { asserted: ts.Type; open: boolean }[] = [];
    const typeOf = (node: ts.Node): ts.Type => checker.getTypeAtLocation(node);
    const objectLike = (type: ts.Type): boolean =>
        (type.flags &
            (ts.TypeFlags.Object |
                ts.TypeFlags.NonPrimitive |
                ts.TypeFlags.Union |
                ts.TypeFlags.Intersection |
                ts.TypeFlags.Any |
                ts.TypeFlags.Unknown |
                ts.TypeFlags.TypeParameter |
                ts.TypeFlags.Index |
                ts.TypeFlags.IndexedAccess |
                ts.TypeFlags.Conditional |
                ts.TypeFlags.Substitution)) !==
        0;
    const identity = (node: ts.Node): void => {
        const type = typeOf(node);
        if (objectLike(type)) identities.push(type);
    };
    const enumerated = (node: ts.Node): void => {
        const type = typeOf(node);
        if (objectLike(type)) enumerations.push(type);
    };
    const written = (target: ts.Expression): void => {
        const unwrapped = unwrapExpression(target);
        // A private class field is never a plain record's property.
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            ts.isPrivateIdentifier(unwrapped.name)
        )
            return;
        if (ts.isPropertyAccessExpression(unwrapped))
            writes.push({
                node: unwrapped,
                type: typeOf(unwrapped.expression),
                property: unwrapped.name.text,
            });
        else if (ts.isElementAccessExpression(unwrapped)) {
            const key = unwrapExpression(unwrapped.argumentExpression);
            if (
                !ts.isStringLiteralLike(key) &&
                (typeOf(key).flags & ts.TypeFlags.NumberLike) !== 0
            )
                return;
            writes.push({
                node: unwrapped,
                type: typeOf(unwrapped.expression),
                ...(ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)
                    ? { property: key.text }
                    : {}),
            });
        }
    };
    const nullish = (node: ts.Expression): boolean => {
        const unwrapped = unwrapExpression(node);
        return (
            unwrapped.kind === ts.SyntaxKind.NullKeyword ||
            (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined") ||
            ts.isVoidExpression(unwrapped)
        );
    };
    for (const source of sources) {
        if (source.isDeclarationFile) continue;
        forEachAnalysisNode(source, (node) => {
            if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
                assertions.push({
                    asserted: typeOf(node),
                    open:
                        (typeOf(node.expression).flags &
                            (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !==
                        0,
                });
            // A function whose body the program does not hold may write any
            // object it is handed: an ambient declaration's, or the engine's
            // unless its pinned bodies only read that parameter.
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                const declaration =
                    checker.getResolvedSignature(node)?.declaration;
                const origin = declaration && declarationOrigin(declaration);
                if (
                    declaration &&
                    (origin === "babylon" ||
                        (origin === "program" &&
                            declaration.getSourceFile().isDeclarationFile))
                )
                    (node.arguments ?? []).forEach((argument, position) => {
                        const type = typeOf(argument);
                        if (
                            objectLike(type) &&
                            !(
                                origin === "babylon" &&
                                engineReadsOnly(declaration, position)
                            )
                        )
                            writes.push({ node, type });
                    });
            }
            if (isAssignmentExpression(node)) {
                for (const target of assignmentTargets(node.left))
                    written(target);
            } else if (isUpdateExpression(node)) written(node.operand);
            else if (ts.isDeleteExpression(node)) written(node.expression);
            else if (ts.isBinaryExpression(node)) {
                const operator = node.operatorToken.kind;
                if (
                    (operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
                        operator ===
                            ts.SyntaxKind.ExclamationEqualsEqualsToken ||
                        operator === ts.SyntaxKind.EqualsEqualsToken ||
                        operator === ts.SyntaxKind.ExclamationEqualsToken) &&
                    !nullish(node.left) &&
                    !nullish(node.right)
                ) {
                    identity(node.left);
                    identity(node.right);
                } else if (operator === ts.SyntaxKind.InKeyword)
                    enumerated(node.right);
            } else if (ts.isSwitchStatement(node)) identity(node.expression);
            else if (ts.isForInStatement(node)) enumerated(node.expression);
            else if (ts.isSpreadAssignment(node)) enumerated(node.expression);
            else if (
                ts.isObjectBindingPattern(node) &&
                node.elements.some((element) => element.dotDotDotToken)
            )
                enumerated(node);
            else if (ts.isNewExpression(node)) {
                const name = libraryGlobal(checker, node.expression);
                if (name && KEYED_COLLECTIONS.has(name)) {
                    const keys = typeOf(node);
                    const key =
                        (keys.flags & ts.TypeFlags.Object) !== 0
                            ? checker.getTypeArguments(
                                  keys as ts.TypeReference,
                              )[0]
                            : undefined;
                    identities.push(key ?? checker.getAnyType());
                }
            } else if (ts.isCallExpression(node)) {
                const callee = unwrapExpression(node.expression);
                const first = node.arguments[0];
                if (!ts.isPropertyAccessExpression(callee)) return;
                const method = callee.name.text;
                const owner = libraryGlobal(checker, callee.expression);
                if (owner === "Object") {
                    if (method === "assign" && first) {
                        writes.push({ node, type: typeOf(first) });
                        node.arguments.slice(1).forEach(enumerated);
                    } else if (
                        (method === "defineProperty" ||
                            method === "defineProperties") &&
                        first
                    ) {
                        const key =
                            method === "defineProperty" && node.arguments[1]
                                ? unwrapExpression(node.arguments[1])
                                : undefined;
                        writes.push({
                            node,
                            type: typeOf(first),
                            ...(key && ts.isStringLiteralLike(key)
                                ? { property: key.text }
                                : {}),
                        });
                    } else if (method === "is")
                        node.arguments.forEach(identity);
                    else if (ENUMERATING_STATICS.has(method) && first)
                        enumerated(first);
                } else if (owner === "Reflect") {
                    if (first) writes.push({ node, type: typeOf(first) });
                } else if (owner === "JSON") {
                    if (method === "stringify" && first) enumerated(first);
                } else if (
                    IDENTITY_SEARCHES.has(method) &&
                    first &&
                    checker.isArrayLikeType(typeOf(callee.expression))
                )
                    identity(first);
                else if (
                    method === "hasOwnProperty" ||
                    method === "propertyIsEnumerable"
                )
                    enumerated(callee.expression);
                else if (
                    method === "register" &&
                    first &&
                    typeOf(callee.expression).getSymbol()?.name ===
                        "FinalizationRegistry"
                )
                    identity(first);
            }
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "structuredClone" &&
                node.arguments[0]
            )
                enumerated(node.arguments[0]);
        });
    }
    const result = { writes, identities, enumerations, assertions };
    indexes.set(checker, result);
    return result;
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

type Callee =
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ArrowFunction
    | ts.FunctionExpression
    | ts.ConstructorDeclaration;

function calleeOf(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
): Callee | undefined {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    return declaration &&
        (ts.isFunctionDeclaration(declaration) ||
            ts.isMethodDeclaration(declaration) ||
            ts.isArrowFunction(declaration) ||
            ts.isFunctionExpression(declaration)) &&
        declaration.body
        ? declaration
        : undefined;
}

/**
 * Whether code in `scope` runs only while `callee` does: `scope` is the
 * callee itself, or a local function of it named by a declaration that is
 * only ever called, directly in the callee's own body.
 */
function calledInPlace(
    checker: ts.TypeChecker,
    callee: Callee,
    scope: ts.Node | undefined,
): boolean {
    if (scope === callee) return true;
    if (!scope || ts.findAncestor(scope.parent, ts.isFunctionLike) !== callee)
        return false;
    const name =
        ts.isFunctionDeclaration(scope) && scope.name
            ? scope.name
            : (ts.isArrowFunction(scope) || ts.isFunctionExpression(scope)) &&
                ts.isVariableDeclaration(scope.parent) &&
                scope.parent.initializer === scope &&
                ts.isIdentifier(scope.parent.name) &&
                (ts.getCombinedNodeFlags(scope.parent) & ts.NodeFlags.Const) !==
                    0
              ? scope.parent.name
              : undefined;
    const symbol = name && checker.getSymbolAtLocation(name);
    if (!symbol) return false;
    let called = true;
    forEachAnalysisNode(callee.body!, (node) => {
        if (!called) return "skip";
        if (
            ts.isIdentifier(node) &&
            node !== name &&
            checker.getSymbolAtLocation(node) === symbol
        )
            called =
                ts.isCallExpression(node.parent) &&
                node.parent.expression === node &&
                ts.findAncestor(node.parent, ts.isFunctionLike) === callee;
    });
    return called;
}

/**
 * Whether a callee only reads the properties of its parameter `index`: the
 * parameter is never written, compared, enumerated, stored, returned,
 * captured or called through, and is handed only to callees that read it the
 * same way.
 */
function readsParameterOnly(
    checker: ts.TypeChecker,
    callee: Callee,
    index: number,
    active: Set<ts.Node>,
): boolean {
    const parameter = callee.parameters[index];
    if (
        !parameter ||
        parameter.dotDotDotToken ||
        !ts.isIdentifier(parameter.name) ||
        active.has(parameter)
    )
        return false;
    const symbol = checker.getSymbolAtLocation(parameter.name);
    if (!symbol) return false;
    active.add(parameter);
    const writeTargets = new Set<ts.Node>();
    forEachAnalysisNode(callee.body!, (node) => {
        if (isAssignmentExpression(node))
            for (const target of assignmentTargets(node.left))
                writeTargets.add(climb(target));
        else if (isUpdateExpression(node))
            writeTargets.add(climb(node.operand));
        else if (ts.isDeleteExpression(node))
            writeTargets.add(climb(node.expression));
    });
    let only = true;
    forEachAnalysisNode(callee.body!, (node) => {
        if (!only) return "skip";
        if (
            !ts.isIdentifier(node) ||
            checker.getSymbolAtLocation(node) !== symbol
        )
            return;
        if (
            !calledInPlace(
                checker,
                callee,
                ts.findAncestor(
                    node.parent,
                    (ancestor) =>
                        ts.isFunctionLike(ancestor) || ancestor === callee,
                ),
            )
        ) {
            only = false;
            return;
        }
        // Where narrowing leaves only primitives, the reference is not the object.
        const narrowed = checker.getTypeAtLocation(node);
        if (
            (narrowed.isUnion() ? narrowed.types : [narrowed]).every(
                (member) =>
                    (member.flags &
                        (ts.TypeFlags.NumberLike |
                            ts.TypeFlags.StringLike |
                            ts.TypeFlags.BooleanLike |
                            ts.TypeFlags.BigIntLike |
                            ts.TypeFlags.Null |
                            ts.TypeFlags.Undefined |
                            ts.TypeFlags.Void)) !==
                    0,
            )
        )
            return;
        const use = climb(node);
        const parent = use.parent;
        if (
            (ts.isPropertyAccessExpression(parent) ||
                ts.isElementAccessExpression(parent)) &&
            parent.expression === use
        ) {
            const read = climb(parent);
            only =
                !writeTargets.has(read) &&
                !(
                    ts.isCallExpression(read.parent) &&
                    read.parent.expression === read
                );
            return;
        }
        if (ts.isCallExpression(parent) && parent.expression !== use) {
            const position = parent.arguments.indexOf(use);
            const next = calleeOf(checker, parent);
            const declaration = next
                ? undefined
                : checker.getResolvedSignature(parent)?.declaration;
            only = next
                ? readsParameterOnly(checker, next, position, active)
                : declaration !== undefined &&
                  declarationOrigin(declaration) === "babylon" &&
                  engineReadsOnly(declaration, position);
            return;
        }
        // Testing its type and iterating its elements read it too.
        only =
            ts.isTypeOfExpression(parent) ||
            (ts.isForOfStatement(parent) && parent.expression === use);
    });
    active.delete(parameter);
    return only;
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
 * The call a record is handed to as `argument`, when the callee only reads
 * that parameter (`readsParameterOnly`): a copy passed there lives for the
 * call alone, and nothing but a write while it runs can tell it apart.
 */
function readOnlyArgumentCall(
    checker: ts.TypeChecker,
    argument: ts.Node,
): Callee | undefined {
    if (!ts.isExpression(argument)) return undefined;
    const use = climb(argument);
    const call = use.parent;
    if (!ts.isCallExpression(call) || call.expression === use) return undefined;
    const callee = calleeOf(checker, call);
    return callee &&
        readsParameterOnly(
            checker,
            callee,
            call.arguments.indexOf(use),
            new Set(),
        )
        ? callee
        : undefined;
}

/**
 * The bodies a call to `callee` can run: its own and those of every
 * function it calls, transitively. Undefined when it calls code the program
 * does not hold beyond the language's library (a function value, an
 * interface method); an engine call's argument writes are in the index.
 */
function callBodies(
    checker: ts.TypeChecker,
    callee: Callee,
): ReadonlySet<ts.Node> | undefined {
    const bodies = new Set<ts.Node>();
    const pending: Callee[] = [callee];
    let unknown = false;
    for (
        let next = pending.pop();
        next !== undefined && !unknown;
        next = pending.pop()
    ) {
        if (bodies.has(next)) continue;
        bodies.add(next);
        forEachAnalysisNode(next.body!, (node) => {
            if (unknown) return "skip";
            if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
            const declaration = checker.getResolvedSignature(node)?.declaration;
            if (!declaration) {
                unknown = true;
                return;
            }
            const origin = declarationOrigin(declaration);
            if (origin !== "program") return;
            if (
                (ts.isFunctionDeclaration(declaration) ||
                    ts.isMethodDeclaration(declaration) ||
                    ts.isArrowFunction(declaration) ||
                    ts.isFunctionExpression(declaration) ||
                    ts.isConstructorDeclaration(declaration)) &&
                declaration.body
            )
                pending.push(declaration);
            else unknown = true;
        });
    }
    return unknown ? undefined : bodies;
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
    const symbol = checker.getSymbolAtLocation(unwrapped);
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
            checker.getSymbolAtLocation(node) !== symbol
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
