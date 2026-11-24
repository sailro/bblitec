import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { engineArgumentWritten } from "./parameter-effects.js";
import { constObjectLiteral, yieldsNewArray } from "./fresh-records.js";
import { heldTypes, openHolder, writtenHolders } from "./written-holders.js";
import {
    KEYED_COLLECTIONS,
    keyedCollectionKeyMethods,
} from "./receiver-methods.js";
import {
    declarationOrigin,
    declarationInDefaultLibrary,
    declaredSymbol,
    libraryGlobal,
    nullishComparison,
    libraryName,
    calledDeclaration,
    namedMember,
} from "./symbols.js";
import {
    isAssignmentExpression,
    unwrapExpression,
    wrappedParent,
    isTypeAssertion,
    unwrapTypePreserving,
    writeSites,
    writeSiteOf,
    accessKey,
    directCallOf,
    isProtoSetter,
    patternSlots,
    equalityOperator,
    operandYield,
    testsTruthinessOnly,
    isDestructuringPattern,
    literalKey,
    objectLiteralMembers,
    propertyKey,
    yieldedOperands,
    type MemberAccess,
    type WriteKind,
} from "./syntax.js";
import { valueKindOf, arrayShape, unionMembers } from "./type-facts.js";

/** The library calls that define members of their first argument. */
type ReflectiveDefinition =
    "assign" | "defineProperty" | "defineProperties" | "set";

/** Each {@link ReflectiveDefinition}, by its owner and name. */
const REFLECTIVE_DEFINITIONS: ReadonlyMap<string, ReflectiveDefinition> =
    new Map([
        ["Object.assign", "assign"],
        ["Object.defineProperty", "defineProperty"],
        ["Object.defineProperties", "defineProperties"],
        ["Reflect.set", "set"],
        ["Reflect.defineProperty", "defineProperty"],
    ]);

/**
 * A site giving objects a member. `key` is the expression a keyed site's
 * key is only known from at run time.
 */
export type MemberDefinition =
    /** An object literal's property, shorthand, method or accessor; `stored` a property's or shorthand's value. */
    | {
          readonly via: "literal";
          readonly node: ts.ObjectLiteralElementLike;
          readonly stored?: ts.Expression;
          readonly key?: ts.Expression;
      }
    /** A class member, or a parameter property of its constructor. */
    | {
          readonly via: "class";
          readonly node: ts.ClassElement | ts.ParameterDeclaration;
          readonly key?: ts.Expression;
      }
    /** A write of a member access (`writeSites`); `stored` the whole value `=` or a logical assignment gives it. */
    | {
          readonly via: "write";
          readonly node: MemberAccess;
          readonly kind: WriteKind;
          readonly stored?: ts.Expression;
          readonly key?: ts.Expression;
      }
    /** A library call defining members of its first argument. */
    | {
          readonly via: "reflect";
          readonly node: ts.CallExpression;
          readonly method: ReflectiveDefinition;
      };

/** A write's location, and the property it writes (absent: any may be). */
export interface ObservedWrite {
    readonly node: ts.Node;
    readonly property?: string;
    /** Its place in program order. */
    readonly order: number;
    /** The literal creating every object a write through a `const` reaches (`constObjectLiteral`). */
    readonly freshObject?: ts.Node;
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
 * - identities: the objects reaching operands of `===`/`!==` and
 *   `Object.is` when both can be objects, of `==`/`!=` other than nullish
 *   literals, `switch` subjects and `includes`/`indexOf`/`lastIndexOf`
 *   arguments, read as `heldTypes` reads them; the keys given
 *   to keyed collections (`add`/`delete`/`get`/`has`/`set` arguments,
 *   WeakRef and FinalizationRegistry targets): the record type a closed
 *   key type stores them as, and the objects that reach them (`heldTypes`);
 *   and the whole key type of a collection constructed with
 *   entries, or whose keys the program does not see given: one handed
 *   where no keyed collection type is declared or to code the program does
 *   not hold, or whose key method is read other than as a direct callee;
 * - enumerations: `Object.keys`/`values`/`entries`/`getOwnPropertyNames`/
 *   `getOwnPropertyDescriptors`/`hasOwn`, `Object.assign` sources, object
 *   spreads and rests, `for...in`, `in`, `hasOwnProperty`, `JSON.stringify`
 *   and `structuredClone`;
 * - widened arrays: the element types of mutable arrays read where a
 *   mutable array of another element type is expected, and that type;
 * - assertions: the types `as`/`<T>` retype a value to, the types of the
 *   values reaching the assertion (the operand's own, through `x as
 *   unknown as T`; an untyped parameter of a function the program only
 *   calls directly holds what its calls pass, `heldTypes`), whether one of
 *   those is untyped (an assertion to `any` or `unknown` retypes nothing
 *   the open holders of the index do not already count), and whether it
 *   named no shape (untyped, or the `object` a `typeof` test leaves of it);
 * - property reads: each property name read as a value rather than called
 *   through, and the objects read wholesale or by a computed key (the
 *   reads that could take an object literal method's function value);
 * - copies: each object copied field by field into a new one -- a spread
 *   into an object literal, the rest of an object pattern;
 * - handed values: each value given where a type is declared for it -- an
 *   argument, a returned value (an arrow's expression body too), the
 *   initializer of a typed declaration, parameter or class field, a
 *   property's value (a shorthand's name too), an array literal's element,
 *   an assigned value;
 * - definitions: each site giving objects a member, by the key its syntax
 *   names: an object literal's member (a destructuring pattern's are its
 *   leaves' writes), a class member or parameter property, a write of a
 *   member access, and `Object.defineProperty`, `Reflect.defineProperty`,
 *   `Reflect.set` (a literal key) and `Object.defineProperties` (each key
 *   of its descriptors literal, through selections and spreads of such
 *   literals); keyed
 *   definitions are those whose key only the run time knows, and every
 *   `Object.assign`;
 * - type assertions and guards: every `as`/`<T>` assertion, and the type
 *   each type predicate narrows to.
 */
export interface ProgramObservations {
    readonly writes: ReadonlyMap<ts.Type, readonly ObservedWrite[]>;
    readonly arrayWrites: ReadonlyMap<ts.Type, readonly ObservedWrite[]>;
    readonly identities: ReadonlySet<ts.Type>;
    /** Operand/key types at identity, typeof or truthiness uses, consulted only when reached. */
    readonly identityConsumers: ReadonlyMap<ts.Node, ReadonlySet<ts.Type>>;
    readonly enumerations: ReadonlySet<ts.Type>;
    readonly assertions: readonly {
        readonly asserted: ts.Type;
        /** The types of the values that reach the assertion. */
        readonly from: readonly ts.Type[];
        readonly open: boolean;
        readonly shapeless: boolean;
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
    /** The members called by name (`object.name(...)`), as named reads are kept. */
    readonly memberCalls: ReadonlyMap<string, readonly NamedRead[]>;
    readonly wholesaleReads: readonly ts.Node[];
    /** Where `from`'s own fields are copied into the new object `into` names. */
    readonly copies: readonly {
        readonly from: ts.Node;
        readonly into: ts.Node;
    }[];
    /** Values given where their contextual type declares another type for them. */
    readonly handed: readonly ts.Expression[];
    readonly definitions: ReadonlyMap<string, readonly MemberDefinition[]>;
    readonly keyedDefinitions: readonly MemberDefinition[];
    readonly typeAssertions: readonly (ts.AsExpression | ts.TypeAssertion)[];
    readonly guardedTypes: readonly ts.TypeNode[];
    /**
     * The first site that gives an object a prototype no literal or
     * constructor gives it: `Object.create`, `Object.setPrototypeOf`,
     * `Reflect.setPrototypeOf`, a `__proto__` member or key, and the
     * null-prototype results of `Object.groupBy` and a match's `groups`.
     */
    readonly foreignPrototype: ts.Node | undefined;
    /**
     * Every `Object.setPrototypeOf` and `Reflect.setPrototypeOf` call: each
     * gives its first argument other inherited members.
     */
    readonly prototypeSetters: readonly ts.CallExpression[];
}

/** @unjournaled A pure function of the checked program, kept across replays. */
const observations = new WeakMap<ts.Program, ProgramObservations>();

/** The `Object` statics whose result or target has a prototype of the caller's choosing, or none. */
const FOREIGN_PROTOTYPE_STATICS = new Set([
    "create",
    "setPrototypeOf",
    "groupBy",
]);
/** The library types whose `groups` object has no prototype. */
const MATCH_RESULTS = new Set(["RegExpMatchArray", "RegExpExecArray"]);

/** The array methods that compare their argument with elements by identity. */
export const IDENTITY_SEARCHES = new Set([
    "includes",
    "indexOf",
    "lastIndexOf",
]);
const ENUMERATING_STATICS = new Set([
    "keys",
    "values",
    "entries",
    "getOwnPropertyNames",
    "getOwnPropertyDescriptors",
    "getOwnPropertyDescriptor",
    "hasOwn",
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
/**
 * Library functions that read every own property of their arguments, or of
 * the one argument named: a receiver is the `this` a getter runs with, read
 * where that getter reads it.
 */
const WHOLESALE_READERS: ReadonlyMap<
    string,
    ReadonlyMap<string, "all" | number>
> = new Map([
    [
        "Object",
        new Map<string, "all" | number>([
            ["assign", "all"],
            ["entries", "all"],
            ["values", "all"],
            ["getOwnPropertyDescriptor", "all"],
            ["getOwnPropertyDescriptors", "all"],
        ]),
    ],
    [
        "Reflect",
        new Map<string, "all" | number>([
            ["get", 0],
            ["getOwnPropertyDescriptor", 0],
            ["apply", "all"],
        ]),
    ],
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

/**
 * The keys of the descriptors object an expression builds: a literal's,
 * through selections and spreads of such literals; undefined where a key
 * is known only at run time.
 */
function descriptorKeys(
    expression: ts.Expression,
    keys = new Set<string>(),
): ReadonlySet<string> | undefined {
    for (const { operand } of yieldedOperands(expression)) {
        if (!ts.isObjectLiteralExpression(operand)) return undefined;
        for (const member of objectLiteralMembers(operand)) {
            if (member.kind === "spread") {
                if (!descriptorKeys(member.node.expression, keys))
                    return undefined;
            } else if (member.kind === "proto" || member.key === undefined)
                return undefined;
            else keys.add(member.key);
        }
    }
    return keys;
}

/**
 * The keys a reflective definition names: its key argument's literal, its
 * descriptors' keys; undefined where only the run time knows them.
 */
function reflectedKeys(
    call: ts.CallExpression,
    method: ReflectiveDefinition,
): readonly string[] | undefined {
    const key = call.arguments[1];
    if (method === "assign" || !key) return undefined;
    if (method === "defineProperties") {
        const keys = descriptorKeys(key);
        return keys && [...keys];
    }
    const literal = literalKey(key);
    return literal === undefined ? undefined : [literal];
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
    const assertions: {
        asserted: ts.Type;
        from: readonly ts.Type[];
        open: boolean;
        shapeless: boolean;
    }[] = [];
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
    const memberCalls = new Map<string, NamedRead[]>();
    const wholesaleReads: ts.Node[] = [];
    const copies: { from: ts.Node; into: ts.Node }[] = [];
    const handed: ts.Expression[] = [];
    // A literal or a function is created where it is given: it has no
    // other type to bring.
    const hand = (value: ts.Expression | undefined): void => {
        if (
            value &&
            !ts.isLiteralExpression(value) &&
            !ts.isFunctionLike(value) &&
            !ts.isObjectLiteralExpression(value) &&
            !ts.isArrayLiteralExpression(value)
        )
            handed.push(value);
    };
    const definitions = new Map<string, MemberDefinition[]>();
    const keyedDefinitions: MemberDefinition[] = [];
    const define = (
        key: string | undefined,
        definition: MemberDefinition,
    ): void => {
        if (key === undefined) keyedDefinitions.push(definition);
        else {
            const list = definitions.get(key);
            if (list) list.push(definition);
            else definitions.set(key, [definition]);
        }
    };
    const typeAssertions: (ts.AsExpression | ts.TypeAssertion)[] = [];
    const guardedTypes: ts.TypeNode[] = [];
    let foreignPrototype: ts.Node | undefined;
    const prototypeSetters: ts.CallExpression[] = [];
    const typeOf = (node: ts.Node): ts.Type => checker.getTypeAtLocation(node);
    let order = 0;
    const place = (
        index: Map<ts.Type, ObservedWrite[]>,
        type: ts.Type,
        placed: ObservedWrite,
    ): void => {
        const list = index.get(type);
        if (list) list.push(placed);
        else index.set(type, [placed]);
    };
    const add = (
        index: Map<ts.Type, ObservedWrite[]>,
        type: ts.Type,
        write: Omit<ObservedWrite, "order">,
    ): void => place(index, type, { ...write, order: order++ });
    // A write through an open holder lands where the parameters and type
    // parameters it is read through narrow it (`writtenHolders`), one write
    // in program order under each type it can reach.
    const addWrite = (
        object: ts.Expression,
        write: Omit<ObservedWrite, "order">,
        key?: ts.Expression,
    ): void => {
        const holders = writtenHolders(
            program,
            checker,
            object,
            write.property === undefined ? key : undefined,
        );
        if (!holders) return add(writes, typeOf(object), write);
        const placed = order++;
        for (const { type, property } of holders)
            place(writes, type, {
                ...write,
                ...(property === undefined ? {} : { property }),
                order: placed,
            });
    };
    const arrayLike = (node: ts.Node): boolean =>
        checker.isArrayLikeType(typeOf(node));
    const objectLike = (type: ts.Type): boolean =>
        unionMembers(type).some(
            (member) =>
                (member.flags &
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
                0,
        );
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
    // An operand compares the objects that reach it, read through
    // parameters and `const` bindings as written objects are (`heldTypes`).
    const compared = (node: ts.Expression): void => {
        for (const type of heldTypes(program, checker, node))
            if (objectLike(type)) identities.add(type);
    };
    const identity = (node: ts.Expression): void => {
        const type = typeOf(node);
        if (objectLike(type)) {
            addConsumer(type, node);
            addConsumer(type, node.parent);
            compared(node);
        }
    };
    // A key is compared by identity with the objects that reach it, read
    // through parameters as written objects are (`heldTypes`), and with
    // the record it is stored as where the collection declares one; a
    // spread key may be any object.
    const keyed = (key: ts.Expression): void => {
        if (ts.isSpreadElement(key))
            return addIdentity(checker.getAnyType(), key);
        observesObject(key);
        const declared = checker.getContextualType(key);
        if (declared && objectLike(declared) && !openHolder(declared))
            identities.add(declared);
        for (const type of heldTypes(program, checker, key))
            if (objectLike(type)) identities.add(type);
    };
    const keyedCollections = (type: ts.Type): readonly ts.Type[] =>
        unionMembers(checker.getNonNullableType(type)).filter((member) =>
            KEYED_COLLECTIONS.has(libraryName(member) ?? ""),
        );
    // A collection whose keys the program does not see given may hold any
    // object of its key type (`any` where it names none).
    const unseenKeys = (collection: ts.Expression): void => {
        for (const member of keyedCollections(typeOf(collection))) {
            const key =
                (member.flags & ts.TypeFlags.Object) !== 0
                    ? checker.getTypeArguments(member as ts.TypeReference)[0]
                    : undefined;
            addIdentity(
                key && (key.flags & ts.TypeFlags.Any) === 0
                    ? key
                    : checker.getAnyType(),
                collection,
            );
        }
    };
    const identityComparison = (
        left: ts.Expression,
        right: ts.Expression,
    ): void => {
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
        addConsumer(leftType, left.parent);
        addConsumer(rightType, right.parent);
        addConsumer(leftType, left);
        addConsumer(rightType, right);
        compared(left);
        compared(right);
    };
    const enumerated = (node: ts.Node): void => {
        const type = typeOf(node);
        if (objectLike(type)) enumerations.add(type);
    };
    const read = (
        name: string,
        node: ts.Node,
        object?: ts.Node,
        index = namedReads,
    ): void => {
        const reads = index.get(name);
        if (reads) reads.push({ node, object });
        else index.set(name, [{ node, object }]);
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
            !ts.isPropertyAccessExpression(unwrapped) &&
            !ts.isElementAccessExpression(unwrapped)
        )
            return;
        const literal = constObjectLiteral(
            checker,
            unwrapped.expression,
        )?.literal;
        const freshObject = literal ? { freshObject: literal } : {};
        if (arrayLike(unwrapped.expression))
            add(arrayWrites, typeOf(unwrapped.expression), {
                node: unwrapped,
                ...freshObject,
            });
        if (ts.isPropertyAccessExpression(unwrapped))
            addWrite(unwrapped.expression, {
                node: unwrapped,
                property: unwrapped.name.text,
                ...freshObject,
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
            addWrite(
                unwrapped.expression,
                {
                    node: unwrapped,
                    ...(property === undefined ? {} : { property }),
                    ...freshObject,
                },
                unwrapped.argumentExpression,
            );
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
        if (ts.isCallExpression(node) || ts.isNewExpression(node))
            node.arguments?.forEach(hand);
        else if (ts.isReturnStatement(node)) hand(node.expression);
        else if (ts.isArrowFunction(node) && !ts.isBlock(node.body))
            hand(node.body);
        else if (
            (ts.isVariableDeclaration(node) ||
                ts.isParameter(node) ||
                ts.isPropertyDeclaration(node)) &&
            node.type
        )
            hand(node.initializer);
        else if (ts.isPropertyAssignment(node)) hand(node.initializer);
        else if (ts.isShorthandPropertyAssignment(node)) hand(node.name);
        else if (ts.isArrayLiteralExpression(node)) {
            for (const element of node.elements)
                if (!ts.isSpreadElement(element)) hand(element);
        } else if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        )
            hand(node.right);
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
                for (const member of unionMembers(contextual)) {
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
        if (ts.isObjectLiteralExpression(node) && !isDestructuringPattern(node))
            for (const member of objectLiteralMembers(node)) {
                if (member.kind === "spread" || member.kind === "proto")
                    continue;
                const name = member.node.name;
                define(member.key, {
                    via: "literal",
                    node: member.node,
                    ...(member.value ? { stored: member.value } : {}),
                    ...(member.key === undefined &&
                    ts.isComputedPropertyName(name)
                        ? { key: name.expression }
                        : {}),
                });
            }
        else if (ts.isClassLike(node))
            for (const member of node.members) {
                const name = member.name;
                if (name && !ts.isPrivateIdentifier(name)) {
                    const key = propertyKey(name);
                    define(key, {
                        via: "class",
                        node: member,
                        ...(key === undefined && ts.isComputedPropertyName(name)
                            ? { key: name.expression }
                            : {}),
                    });
                }
                if (ts.isConstructorDeclaration(member))
                    for (const parameter of member.parameters)
                        if (
                            ts.isIdentifier(parameter.name) &&
                            ts.isParameterPropertyDeclaration(parameter, member)
                        )
                            define(parameter.name.text, {
                                via: "class",
                                node: parameter,
                            });
            }
        else if (
            ts.isFunctionLike(node) &&
            node.type &&
            ts.isTypePredicateNode(node.type) &&
            node.type.type
        )
            guardedTypes.push(node.type.type);
        if (isTypeAssertion(node)) {
            typeAssertions.push(node);
            const untyped = (type: ts.Type): boolean =>
                (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
            const asserted = typeOf(node);
            // `x as unknown as T` retypes the value `x` holds: it is open
            // only where that operand itself is untyped.
            let operand = unwrapTypePreserving(node.expression);
            while (isTypeAssertion(operand) && untyped(typeOf(operand)))
                operand = unwrapTypePreserving(operand.expression);
            // No value has type `never` (an exhaustiveness check's
            // `x satisfies never`): such an assertion retypes nothing.
            if (
                !untyped(asserted) &&
                (asserted.flags & ts.TypeFlags.Never) === 0
            ) {
                const from = typeOf(operand);
                // An untyped parameter of a function the program only calls
                // directly holds what its calls pass (`heldTypes`): the
                // assertion retypes those, open only where one is untyped.
                const reaching = untyped(from)
                    ? heldTypes(program, checker, operand)
                    : [from];
                // A message event's data is decoded as the type its read
                // names (a structured clone): it has that shape.
                const message =
                    ts.isPropertyAccessExpression(operand) &&
                    operand.name.text === "data" &&
                    libraryName(
                        checker.getNonNullableType(typeOf(operand.expression)),
                    ) === "MessageEvent";
                assertions.push({
                    asserted,
                    from: reaching,
                    open: reaching.some(untyped),
                    shapeless:
                        !message &&
                        reaching.some(
                            (type) =>
                                untyped(type) ||
                                (type.flags & ts.TypeFlags.NonPrimitive) !== 0,
                        ),
                });
            }
        }
        // A function whose body the program does not hold may write any
        // object it is handed: an ambient declaration's, or the engine's
        // unless its pinned bodies only read that parameter.
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const declaration = calledDeclaration(checker, node);
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
                    ) {
                        if (ts.isSpreadElement(argument))
                            add(writes, type, { node });
                        else {
                            addWrite(argument, { node });
                            unseenKeys(argument);
                        }
                    }
                });
        }
        // A collection handed where no keyed collection type is declared
        // can be given keys the program does not show.
        if (ts.isExpression(node) && keyedCollections(typeOf(node)).length) {
            const contextual = checker.getContextualType(node);
            if (
                contextual &&
                keyedCollections(contextual).length !==
                    unionMembers(checker.getNonNullableType(contextual)).length
            )
                unseenKeys(node);
        }
        if (
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)
        ) {
            const key = accessKey(node);
            // A key method read other than as a direct callee, or a member
            // only the run time names, can take keys the program does not
            // show.
            if (
                key === undefined ||
                (keyedCollectionKeyMethods.has(key) && !directCallOf(node))
            )
                unseenKeys(node.expression);
            if (
                key === "__proto__" ||
                (key === "groups" &&
                    unionMembers(typeOf(node.expression)).some((member) =>
                        MATCH_RESULTS.has(libraryName(member) ?? ""),
                    ))
            )
                foreignPrototype ??= node;
            if (readsOnlyAsMember(node)) {
                // Read as a member of the access around it; a callee is
                // a member call.
                const call = wrappedParent(node);
                if (
                    key !== undefined &&
                    ts.isCallExpression(call) &&
                    unwrapExpression(call.expression) === node
                )
                    read(key, node, node.expression, memberCalls);
            } else if (key !== undefined) read(key, node, node.expression);
            else wholesaleReads.push(node.expression);
        } else if (ts.isPropertyAssignment(node) && isProtoSetter(node)) {
            foreignPrototype ??= node;
        } else if (ts.isObjectBindingPattern(node)) {
            for (const { element, read: slot } of patternSlots(node))
                if (slot.kind === "member" && slot.key !== undefined)
                    read(slot.key, element, node);
                else wholesaleReads.push(node);
        }
        // A truthiness test reads the object itself, never what it holds or
        // settles to: `!x`, a condition, an operand yielded only when truthy
        // (`||`) or only when falsy (`&&`).
        if (ts.isExpression(node)) {
            const yielded = operandYield(node.parent, node);
            if (
                testsTruthinessOnly(node) ||
                (yielded !== undefined &&
                    yielded.has("truthy") !== yielded.has("falsy"))
            )
                observesObject(node, node);
        }
        for (const { target, kind, stored } of writeSites(node)) {
            written(target);
            if (
                ts.isPropertyAccessExpression(target) ||
                ts.isElementAccessExpression(target)
            ) {
                const key = accessKey(target);
                define(key, {
                    via: "write",
                    node: target,
                    kind,
                    ...(stored ? { stored } : {}),
                    ...(key === undefined &&
                    ts.isElementAccessExpression(target)
                        ? { key: target.argumentExpression }
                        : {}),
                });
            }
        }
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
            copies.push({ from: node.expression, into: node.parent });
        } else if (
            ts.isObjectBindingPattern(node) &&
            node.elements.some((element) => element.dotDotDotToken)
        ) {
            enumerated(node);
            copies.push({
                from: node,
                into: node.elements.find((element) => element.dotDotDotToken)!
                    .name,
            });
        } else if (ts.isNewExpression(node)) {
            const name = libraryGlobal(checker, node.expression);
            const first = node.arguments?.[0];
            if (first && name === "WeakRef") keyed(first);
            // A collection constructed with entries may hold any key of its
            // key type.
            else if (first) unseenKeys(node);
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
        const callee = namedMember(checker, unwrapExpression(node.expression));
        const first = node.arguments[0];
        if (!callee) return;
        const method = callee.name;
        const owner = libraryGlobal(checker, callee.expression);
        const read =
            owner !== undefined
                ? WHOLESALE_READERS.get(owner)?.get(method)
                : undefined;
        if (read !== undefined)
            wholesaleReads.push(
                ...node.arguments.filter(
                    (argument, index) =>
                        !ts.isSpreadElement(argument) &&
                        (read === "all" || index === read),
                ),
            );
        if (
            (owner === "Object" && FOREIGN_PROTOTYPE_STATICS.has(method)) ||
            (owner === "Reflect" && method === "setPrototypeOf")
        )
            foreignPrototype ??= node;
        if (
            method === "setPrototypeOf" &&
            (owner === "Object" || owner === "Reflect")
        )
            prototypeSetters.push(node);
        const reflective = REFLECTIVE_DEFINITIONS.get(`${owner}.${method}`);
        if (reflective && first && !ts.isSpreadElement(first)) {
            const definition: MemberDefinition = {
                via: "reflect",
                node,
                method: reflective,
            };
            const keys = reflectedKeys(node, reflective);
            if (keys) for (const key of keys) define(key, definition);
            else define(undefined, definition);
        }
        if (owner === "Object") {
            if (method === "assign" && first) {
                addWrite(first, { node });
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
                addWrite(
                    first,
                    {
                        node,
                        ...(key && ts.isStringLiteralLike(key)
                            ? { property: key.text }
                            : {}),
                    },
                    key,
                );
            } else if (method === "is" && first && node.arguments[1])
                identityComparison(first, node.arguments[1]);
            else if (ENUMERATING_STATICS.has(method) && first)
                enumerated(first);
        } else if (owner === "Reflect") {
            if (first) addWrite(first, { node });
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
        else if (keyedCollectionKeyMethods.has(method) && first) {
            const declaration = calledDeclaration(checker, node);
            if (
                declaration &&
                declarationInDefaultLibrary(declaration) &&
                ts.isInterfaceDeclaration(declaration.parent) &&
                KEYED_COLLECTIONS.has(declaration.parent.name.text)
            )
                keyed(first);
        } else if (
            method === "register" &&
            first &&
            libraryName(typeOf(callee.expression)) === "FinalizationRegistry"
        )
            keyed(first);
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
        memberCalls,
        wholesaleReads,
        copies,
        handed,
        definitions,
        keyedDefinitions,
        typeAssertions,
        guardedTypes,
        foreignPrototype,
        prototypeSetters,
    };
}
