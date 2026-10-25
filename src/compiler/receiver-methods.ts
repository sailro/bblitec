import ts from "typescript";
import { EmissionSet } from "./emission-transaction.js";
import {
    declarationInDefaultLibrary,
    declaredInDomLibrary,
    libraryGlobal,
    libraryName,
    calledDeclaration,
    namedMember,
} from "./symbols.js";
import {
    callSignatures,
    PRIMITIVE_KINDS,
    unionMembers,
    valueKindOf,
} from "./type-facts.js";
import { unwrapExpression } from "./syntax.js";
import {
    BIGINT_ARRAY_KINDS,
    TYPED_ARRAY_KINDS,
} from "./data-types/typed-arrays.js";

/**
 * The built-in methods that change the container they are called on, read
 * it only, or store their arguments: one table each analysis and lowering
 * reads. A leaf module, so the analyses that run before lowering
 * (evaluation order, module initialization, parameter effects) read it
 * without importing the lowering.
 */

/** Array methods that can change its length and invalidate element aliases. */
export const resizingArrayMethods: ReadonlySet<string> = new EmissionSet([
    "push",
    "pop",
    "shift",
    "unshift",
    "splice",
]);

/** Array methods that mutate the receiver even when its length is unchanged. */
export const mutatingArrayMethods: ReadonlySet<string> = new EmissionSet([
    ...resizingArrayMethods,
    "copyWithin",
    "fill",
    "reverse",
    "sort",
]);

/** Array methods that change the receiver in place and keep its length. */
export const lengthPreservingArrayMethods: ReadonlySet<string> =
    new EmissionSet(
        [...mutatingArrayMethods].filter(
            (method) => !resizingArrayMethods.has(method),
        ),
    );

/** Map, Set, WeakMap and WeakSet methods that change the collection. */
const collectionWritingMethods: ReadonlySet<string> = new EmissionSet([
    "add",
    "clear",
    "delete",
    "set",
]);

/** The keyed collections whose writers `collectionWritingMethods` names. */
const KEYED_COLLECTIONS: ReadonlySet<string> = new Set([
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
]);

/** Typed array methods that change the array in place. */
const typedArrayWritingMethods: ReadonlySet<string> = new EmissionSet([
    ...lengthPreservingArrayMethods,
    "set",
]);

/** `Object.prototype` methods, which read their receiver. */
const OBJECT_READING_METHODS: ReadonlySet<string> = new Set([
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
]);

/**
 * Default-library classes whose methods leave the receiver as it was, but
 * for the ones each names: setters, a RegExp's lastIndex readers.
 */
const LIBRARY_READING_METHODS: ReadonlyMap<
    string,
    (method: string) => boolean
> = new Map<string, (method: string) => boolean>([
    ["ArrayBuffer", (method) => method === "slice"],
    ["DataView", (method) => !method.startsWith("set")],
    ["Date", (method) => !method.startsWith("set")],
    ["Error", () => true],
    ["Object", (method) => OBJECT_READING_METHODS.has(method)],
    ["Promise", () => true],
    [
        "RegExp",
        (method) =>
            method !== "compile" && method !== "exec" && method !== "test",
    ],
    ["SharedArrayBuffer", (method) => method === "slice"],
    ["WeakRef", () => true],
]);

/**
 * Whether calling the library method `method` on `receiver` writes it, by
 * the receiver's checked type: an array's or typed array's mutating
 * methods, a collection's writers, none on a primitive, a library class's
 * own writers, none a DOM interface declares (host state, which the
 * platform effect tables own, not program data), and on any other receiver
 * every method not known to only read. A name every owner only reads is
 * answered without the checker.
 */
export function libraryMethodWritesReceiver(
    checker: ts.TypeChecker,
    receiver: ts.Expression,
    method: string,
): boolean {
    if (readOnlyDataMethods.has(method)) return false;
    return unionMembers(
        checker.getNonNullableType(checker.getTypeAtLocation(receiver)),
    ).some((member) => {
        if (PRIMITIVE_KINDS.includes(valueKindOf(member))) return false;
        if (checker.isArrayType(member) || checker.isTupleType(member))
            return mutatingArrayMethods.has(method);
        const name = libraryName(member) ?? "";
        if (TYPED_ARRAY_KINDS.has(name) || BIGINT_ARRAY_KINDS.has(name))
            return typedArrayWritingMethods.has(method);
        if (KEYED_COLLECTIONS.has(name))
            return collectionWritingMethods.has(method);
        const reads = LIBRARY_READING_METHODS.get(name);
        if (reads) return !reads(method);
        const declared = checker.getPropertyOfType(member, method);
        return (
            !declaredInDomLibrary(declared) && !readOnlyDataMethods.has(method)
        );
    });
}

/** Data-container methods whose receiver is not mutated. */
export const readOnlyDataMethods: ReadonlySet<string> = new EmissionSet([
    "at",
    "concat",
    "entries",
    "every",
    "filter",
    "flat",
    "flatMap",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "forEach",
    "get",
    "has",
    "includes",
    "indexOf",
    "join",
    "keys",
    "lastIndexOf",
    "map",
    "reduce",
    "reduceRight",
    "slice",
    "some",
    "toReversed",
    "toSorted",
    "values",
    "with",
]);

/**
 * Whether an array method's callback takes the receiver itself: the third
 * parameter of `(value, index, array)`, `reduce`'s fourth. A callback that
 * does reaches the receiver under a name of its own.
 */
export function callbackTakesReceiver(
    checker: ts.TypeChecker,
    method: string,
    callback: ts.Expression | undefined,
): callback is ts.Expression {
    const receiverParameter =
        method === "reduce" || method === "reduceRight" ? 3 : 2;
    return (
        callback !== undefined &&
        callSignatures(
            checker,
            checker.getTypeAtLocation(callback),
            "exact",
        ).some((signature) => signature.parameters.length > receiverParameter)
    );
}

/** Library methods that call the function they are handed before returning. */
const synchronousCallbackMethods: ReadonlySet<string> = new EmissionSet([
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
    "replace",
    "replaceAll",
    "some",
    "sort",
    "toSorted",
]);

/**
 * Whether `call` calls its function `argument` before it returns and keeps
 * nothing of it: a default-library iteration, search, sort or replace
 * method, `Array.from`'s mapper, or a `new Promise` executor.
 */
export function callsArgumentInPlace(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
    argument: ts.Node,
): boolean {
    const index =
        call.arguments?.findIndex((candidate) => candidate === argument) ?? -1;
    if (index < 0) return false;
    if (ts.isNewExpression(call))
        return (
            index === 0 && libraryGlobal(checker, call.expression) === "Promise"
        );
    const callee = namedMember(checker, unwrapExpression(call.expression));
    if (!callee) return false;
    if (
        callee.name === "from" &&
        libraryGlobal(checker, callee.expression) === "Array"
    )
        return index === 1;
    const declaration = calledDeclaration(checker, call);
    return (
        declaration !== undefined &&
        declarationInDefaultLibrary(declaration) &&
        synchronousCallbackMethods.has(callee.name)
    );
}

/** `target.addEventListener(type, listener)`: it keeps the listener. */
export function isListenerRegistration(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
): boolean {
    return (
        namedMember(checker, unwrapExpression(call.expression))?.name ===
            "addEventListener" && call.arguments.length >= 2
    );
}

/** Methods that retain argument identity without mutating the argument itself. */
export const storingDataMethods: ReadonlySet<string> = new EmissionSet([
    "add",
    "concat",
    "fill",
    "of",
    "push",
    "resolve",
    "set",
    "splice",
    "unshift",
]);

/** Syntactic retention proof used conservatively by the alias analyses. */
export function isStoringDataCall(
    node: ts.Node,
    checker: ts.TypeChecker,
): node is ts.CallExpression | ts.NewExpression {
    if (ts.isCallExpression(node)) {
        const signature = calledDeclaration(checker, node);
        // Resolver signatures originate in the default library constructor,
        // including when the source renames or forwards its executor parameter.
        const parameter = signature?.parent;
        const executor = parameter?.parent?.parent;
        const constructor = executor?.parent;
        if (
            signature &&
            declarationInDefaultLibrary(signature) &&
            parameter &&
            ts.isParameter(parameter) &&
            executor &&
            ts.isParameter(executor) &&
            constructor &&
            ts.isConstructSignatureDeclaration(constructor) &&
            ts.isInterfaceDeclaration(constructor.parent) &&
            constructor.parent.name.text === "PromiseConstructor"
        )
            return true;
    }
    return (
        (ts.isCallExpression(node) &&
            storingDataMethods.has(
                namedMember(checker, node.expression)?.name ?? "",
            )) ||
        (ts.isNewExpression(node) &&
            ["Map", "Set"].includes(
                libraryGlobal(checker, node.expression) ?? "",
            ))
    );
}
