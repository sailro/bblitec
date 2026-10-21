import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { engineArgumentWritten } from "./parameter-effects.js";
import { yieldsNewArray } from "./fresh-records.js";
import {
    declarationOrigin,
    declaredSymbol,
    libraryGlobal,
    nullishComparison,
} from "./symbols.js";
import {
    isAssignmentExpression,
    unwrapExpression,
    wrappedParent,
    isTypeAssertion,
    writeSites,
    writeSiteOf,
    accessKey,
    patternSlots,
    equalityOperator,
} from "./syntax.js";
import { valueKindOf, arrayShape } from "./type-facts.js";

/** A write's location, and the property it writes (absent: any may be). */
export interface ObservedWrite {
    readonly node: ts.Node;
    readonly property?: string;
    /** Its place in program order. */
    readonly order: number;
}

/** One read of a property's value. */
export interface NamedRead {
    readonly node: ts.Node;
    /**
     * What holds the object it reads from: the accessed expression or the
     * destructured binding pattern. A destructuring assignment target names
     * no source, so its reads reach every object.
     */
    readonly object: ts.Node | undefined;
}

/**
 * Who touches objects of a static type, over the whole checked program,
 * from one walk of its sources (type nodes skipped), built once per
 * program. Every list is indexed by the static type of the object touched.
 *
 * - writes: property assignments, updates, deletions, the reflective
 *   writers (`Object.assign` targets, `Object.defineProperty`, `Reflect`)
 *   and the arguments of engine or ambient functions, whose bodies may
 *   write them; numeric element writes reach array lanes, not record
 *   fields;
 * - array writes: changes of an array's elements or length (element and
 *   `length` writes, deletions, the mutating methods);
 * - identities: operands of `===`/`!==` and `Object.is` when both can be
 *   objects; operands of `==`/`!=` other than nullish literals, `switch`
 *   subjects, `includes`/`indexOf`/
 *   `lastIndexOf` arguments, and the key or target types of constructed
 *   Map, Set, WeakMap, WeakSet, WeakRef and FinalizationRegistry values;
 * - enumerations: `Object.keys`/`values`/`entries`/`getOwnPropertyNames`/
 *   `getOwnPropertyDescriptors`/`hasOwn`, `Object.assign` sources, object
 *   spreads and rests, `for...in`, `in`, `hasOwnProperty`, `JSON.stringify`
 *   and `structuredClone`;
 * - widened arrays: the element types of mutable arrays read where a
 *   mutable array of another element type is expected, and that type;
 * - assertions: the types `as`/`<T>` retype a value to, and whether the
 *   operand was untyped (an assertion to `any` or `unknown` retypes nothing
 *   the open holders of the index do not already count);
 * - property reads: each property name read as a value rather than called
 *   through, and the objects read wholesale or by a computed key (the
 *   reads that could take an object literal method's function value).
 */
export interface ProgramObservations {
    readonly writes: ReadonlyMap<ts.Type, readonly ObservedWrite[]>;
    readonly arrayWrites: ReadonlyMap<ts.Type, readonly ObservedWrite[]>;
    readonly identities: ReadonlySet<ts.Type>;
    /** Operand/key types at identity or typeof uses, consulted only when reached. */
    readonly identityConsumers: ReadonlyMap<ts.Node, ReadonlySet<ts.Type>>;
    readonly enumerations: ReadonlySet<ts.Type>;
    readonly assertions: readonly {
        readonly asserted: ts.Type;
        readonly open: boolean;
    }[];
    /**
     * Mutable arrays the program hands to a mutable array of another element
     * type (`const wide: string[] = tags`), which array covariance permits:
     * one object then has both element types, `own` and `wide`.
     */
    readonly widenedArrays: readonly {
        readonly own: ts.Type;
        readonly wide: ts.Type;
        /** A local array the checker reads as still empty (`never[]`) there. */
        readonly evolving?: ts.Symbol;
    }[];
    /** The element types each array local is read with, over the program. */
    readonly arrayLocalElements: ReadonlyMap<ts.Symbol, readonly ts.Type[]>;
    readonly namedReads: ReadonlyMap<string, readonly NamedRead[]>;
    readonly wholesaleReads: readonly ts.Node[];
}

/** @unjournaled A pure function of the checked program, kept across replays. */
const observations = new WeakMap<ts.Program, ProgramObservations>();

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
const MUTATING_ARRAY_METHODS = new Set([
    "push",
    "pop",
    "shift",
    "unshift",
    "splice",
    "sort",
    "reverse",
    "fill",
    "copyWithin",
]);
/** Library functions that read every own property of an argument. */
const WHOLESALE_READERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    [
        "Object",
        new Set([
            "assign",
            "entries",
            "values",
            "getOwnPropertyDescriptor",
            "getOwnPropertyDescriptors",
        ]),
    ],
    ["Reflect", new Set(["get", "getOwnPropertyDescriptor", "apply"])],
]);

/** Whether a member read is a call's callee, a write target or a `typeof`/`delete` operand. */
function readsOnlyAsMember(access: ts.Expression): boolean {
    const parent = wrappedParent(access);
    return (
        (ts.isCallExpression(parent) &&
            unwrapExpression(parent.expression) === access) ||
        (ts.isTaggedTemplateExpression(parent) &&
            unwrapExpression(parent.tag) === access) ||
        ["assign", "delete", "loop"].includes(
            writeSiteOf(access)?.kind ?? "",
        ) ||
        ts.isTypeOfExpression(parent)
    );
}

/**
 * What a destructuring assignment target reads of its source: each member
 * an object pattern names, and the whole object where a rest or a run-time
 * key reads members the syntax does not name.
 */
function assignmentPatternReads(
    pattern: ts.Expression,
    named: (name: string, node: ts.Node) => void,
    wholesale: (object: ts.Expression) => void,
): void {
    const target = unwrapExpression(pattern);
    if (
        !ts.isArrayLiteralExpression(target) &&
        !ts.isObjectLiteralExpression(target)
    )
        return;
    for (const slot of patternSlots(target)) {
        if (ts.isObjectLiteralExpression(target)) {
            if (slot.read.kind === "member" && slot.read.key !== undefined)
                named(slot.read.key, slot.element);
            else wholesale(target);
        }
        assignmentPatternReads(slot.target, named, wholesale);
    }
}

/** The program's observations, walked on first read. */
export function programObservations(program: ts.Program): ProgramObservations {
    let known = observations.get(program);
    if (!known) {
        known = observe(program);
        observations.set(program, known);
    }
    return known;
}

function observe(program: ts.Program): ProgramObservations {
    const checker = program.getTypeChecker();
    const writes = new Map<ts.Type, ObservedWrite[]>();
    const arrayWrites = new Map<ts.Type, ObservedWrite[]>();
    const identities = new Set<ts.Type>();
    const identityConsumers = new Map<ts.Node, Set<ts.Type>>();
    const enumerations = new Set<ts.Type>();
    const assertions: { asserted: ts.Type; open: boolean }[] = [];
    const widenedArrays: {
        own: ts.Type;
        wide: ts.Type;
        evolving?: ts.Symbol;
    }[] = [];
    const arrayLocalElements = new Map<ts.Symbol, ts.Type[]>();
    const mutableElement = (type: ts.Type): ts.Type | undefined => {
        const shape = arrayShape(checker, type);
        return shape?.mutable && !shape.tuple ? shape.element : undefined;
    };
    const namedReads = new Map<string, NamedRead[]>();
    const wholesaleReads: ts.Node[] = [];
    const typeOf = (node: ts.Node): ts.Type => checker.getTypeAtLocation(node);
    let order = 0;
    const add = (
        index: Map<ts.Type, ObservedWrite[]>,
        type: ts.Type,
        write: Omit<ObservedWrite, "order">,
    ): void => {
        const placed = { ...write, order: order++ };
        const list = index.get(type);
        if (list) list.push(placed);
        else index.set(type, [placed]);
    };
    const arrayLike = (node: ts.Node): boolean =>
        checker.isArrayLikeType(typeOf(node));
    const objectLike = (type: ts.Type): boolean =>
        type.isUnion()
            ? type.types.some(objectLike)
            : (type.flags &
                  (ts.TypeFlags.Object |
                      ts.TypeFlags.NonPrimitive |
                      ts.TypeFlags.Intersection |
                      ts.TypeFlags.Any |
                      ts.TypeFlags.Unknown |
                      ts.TypeFlags.TypeParameter |
                      ts.TypeFlags.Index |
                      ts.TypeFlags.IndexedAccess |
                      ts.TypeFlags.Conditional |
                      ts.TypeFlags.Substitution)) !==
              0;
    const addConsumer = (type: ts.Type, consumer: ts.Node): void => {
        if (ts.isExpression(consumer)) consumer = unwrapExpression(consumer);
        const types = identityConsumers.get(consumer);
        if (types) types.add(type);
        else identityConsumers.set(consumer, new Set([type]));
    };
    const addIdentity = (type: ts.Type, consumer: ts.Node): void => {
        identities.add(type);
        addConsumer(type, consumer);
    };
    const observesObject = (
        node: ts.Expression,
        consumer = node.parent,
    ): void => {
        const type = typeOf(node);
        if (objectLike(type)) {
            addConsumer(type, node);
            addConsumer(type, consumer);
        }
    };
    const identity = (node: ts.Node): void => {
        const type = typeOf(node);
        if (objectLike(type)) {
            addIdentity(type, node);
            addIdentity(type, node.parent);
        }
    };
    const identityComparison = (left: ts.Node, right: ts.Node): void => {
        const leftType = typeOf(left),
            rightType = typeOf(right);
        if (!objectLike(leftType) || !objectLike(rightType)) {
            if (objectLike(leftType)) {
                addConsumer(leftType, left);
                addConsumer(leftType, left.parent);
            }
            if (objectLike(rightType)) {
                addConsumer(rightType, right);
                addConsumer(rightType, right.parent);
            }
            return;
        }
        addIdentity(leftType, left.parent);
        addIdentity(rightType, right.parent);
        addIdentity(leftType, left);
        addIdentity(rightType, right);
    };
    const enumerated = (node: ts.Node): void => {
        const type = typeOf(node);
        if (objectLike(type)) enumerations.add(type);
    };
    const read = (name: string, node: ts.Node, object?: ts.Node): void => {
        const reads = namedReads.get(name);
        if (reads) reads.push({ node, object });
        else namedReads.set(name, [{ node, object }]);
    };
    const written = (target: ts.Expression): void => {
        const unwrapped = unwrapExpression(target);
        // A private class field is never a plain record's property.
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            ts.isPrivateIdentifier(unwrapped.name)
        )
            return;
        if (
            (ts.isPropertyAccessExpression(unwrapped) ||
                ts.isElementAccessExpression(unwrapped)) &&
            arrayLike(unwrapped.expression)
        )
            add(arrayWrites, typeOf(unwrapped.expression), { node: unwrapped });
        if (ts.isPropertyAccessExpression(unwrapped))
            add(writes, typeOf(unwrapped.expression), {
                node: unwrapped,
                property: unwrapped.name.text,
            });
        else if (ts.isElementAccessExpression(unwrapped)) {
            // A number-typed key indexes; it names no record property.
            const argument = unwrapExpression(unwrapped.argumentExpression);
            if (
                !ts.isStringLiteralLike(argument) &&
                valueKindOf(typeOf(argument)) === "number"
            )
                return;
            const property = accessKey(unwrapped);
            add(writes, typeOf(unwrapped.expression), {
                node: unwrapped,
                ...(property === undefined ? {} : { property }),
            });
        }
    };
    // A new array, or an assignment of one (`bucket = []`), is that array.
    const newArrayValue = (node: ts.Expression): boolean => {
        const unwrapped = unwrapExpression(node);
        return ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ? newArrayValue(unwrapped.right)
            : yieldsNewArray(checker, unwrapped);
    };
    const visit = (node: ts.Node): void => {
        // A new array is created with the type it is read as.
        if (ts.isExpression(node) && !newArrayValue(node)) {
            const own = mutableElement(typeOf(node));
            const contextual = own && checker.getContextualType(node);
            const symbol = ts.isIdentifier(node)
                ? declaredSymbol(checker, node)
                : undefined;
            if (own && symbol) {
                const elements = arrayLocalElements.get(symbol);
                if (elements) elements.push(own);
                else arrayLocalElements.set(symbol, [own]);
            }
            if (own && contextual)
                for (const member of contextual.isUnion()
                    ? contextual.types
                    : [contextual]) {
                    const wide = mutableElement(member);
                    if (wide !== undefined && wide !== own)
                        widenedArrays.push({
                            own,
                            wide,
                            ...((own.flags & ts.TypeFlags.Never) !== 0 && symbol
                                ? { evolving: symbol }
                                : {}),
                        });
                }
        }
        if (isTypeAssertion(node)) {
            const asserted = typeOf(node);
            if (
                (asserted.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) ===
                0
            )
                assertions.push({
                    asserted,
                    open:
                        (typeOf(node.expression).flags &
                            (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !==
                        0,
                });
        }
        // A function whose body the program does not hold may write any
        // object it is handed: an ambient declaration's, or the engine's
        // unless its pinned bodies only read that parameter.
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const declaration = checker.getResolvedSignature(node)?.declaration;
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
                        (origin !== "babylon" ||
                            engineArgumentWritten(checker, node, position))
                    )
                        add(writes, type, { node });
                });
        }
        if (
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)
        ) {
            const key = accessKey(node);
            if (readsOnlyAsMember(node)) {
                // Read as a member of the access around it.
            } else if (key !== undefined) read(key, node, node.expression);
            else wholesaleReads.push(node.expression);
        } else if (ts.isObjectBindingPattern(node)) {
            for (const { element, read: slot } of patternSlots(node))
                if (slot.kind === "member" && slot.key !== undefined)
                    read(slot.key, element, node);
                else wholesaleReads.push(node);
        }
        for (const { target } of writeSites(node)) written(target);
        if (isAssignmentExpression(node)) {
            if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
                assignmentPatternReads(node.left, read, (object) =>
                    wholesaleReads.push(object),
                );
        } else if (ts.isBinaryExpression(node)) {
            const equality = equalityOperator(node.operatorToken.kind);
            if (equality && !nullishComparison(checker, node)) {
                if (!equality.loose) identityComparison(node.left, node.right);
                else {
                    identity(node.left);
                    identity(node.right);
                }
            } else if (node.operatorToken.kind === ts.SyntaxKind.InKeyword)
                enumerated(node.right);
        } else if (ts.isTypeOfExpression(node)) {
            observesObject(node.expression, node);
        } else if (ts.isSwitchStatement(node)) identity(node.expression);
        else if (ts.isForInStatement(node)) enumerated(node.expression);
        else if (ts.isSpreadAssignment(node)) {
            enumerated(node.expression);
            wholesaleReads.push(node.expression);
        } else if (
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
                        ? checker.getTypeArguments(keys as ts.TypeReference)[0]
                        : undefined;
                addIdentity(key ?? checker.getAnyType(), node);
            }
        } else if (ts.isCallExpression(node)) call(node);
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "structuredClone" &&
            node.arguments[0]
        )
            enumerated(node.arguments[0]);
    };
    const call = (node: ts.CallExpression): void => {
        const callee = unwrapExpression(node.expression);
        const first = node.arguments[0];
        if (!ts.isPropertyAccessExpression(callee)) return;
        const method = callee.name.text;
        const owner = libraryGlobal(checker, callee.expression);
        if (owner !== undefined && WHOLESALE_READERS.get(owner)?.has(method))
            wholesaleReads.push(
                ...node.arguments.filter(
                    (argument) => !ts.isSpreadElement(argument),
                ),
            );
        if (owner === "Object") {
            if (method === "assign" && first) {
                add(writes, typeOf(first), { node });
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
                add(writes, typeOf(first), {
                    node,
                    ...(key && ts.isStringLiteralLike(key)
                        ? { property: key.text }
                        : {}),
                });
            } else if (method === "is" && first && node.arguments[1])
                identityComparison(first, node.arguments[1]);
            else if (ENUMERATING_STATICS.has(method) && first)
                enumerated(first);
        } else if (owner === "Reflect") {
            if (first) add(writes, typeOf(first), { node });
        } else if (owner === "JSON") {
            if (method === "stringify" && first) enumerated(first);
        } else if (
            IDENTITY_SEARCHES.has(method) &&
            first &&
            arrayLike(callee.expression)
        )
            identity(first);
        else if (
            MUTATING_ARRAY_METHODS.has(method) &&
            arrayLike(callee.expression)
        )
            add(arrayWrites, typeOf(callee.expression), { node });
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
    };
    for (const source of program.getSourceFiles())
        if (!source.isDeclarationFile)
            forEachAnalysisNode(source, (node) => visit(node), {
                types: "skip",
            });
    return {
        writes,
        arrayWrites,
        identities,
        identityConsumers,
        enumerations,
        assertions,
        widenedArrays,
        arrayLocalElements,
        namedReads,
        wholesaleReads,
    };
}
