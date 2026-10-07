import ts from "typescript";
import { EmissionSet } from "./emission-transaction.js";
import { declarationInDefaultLibrary, libraryGlobal } from "./symbols.js";

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

/**
 * The methods that change the container they are called on: every
 * mutating array method plus the Map/Set writers. A name outside this set
 * writes nothing through its receiver, so a container only ever read
 * through `get`, `has`, `map` or `find` stays folded.
 */
export const receiverWritingMethods: ReadonlySet<string> = new EmissionSet([
    ...mutatingArrayMethods,
    "set",
    "add",
    "clear",
    "delete",
]);

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
        checker
            .getTypeAtLocation(callback)
            .getCallSignatures()
            .some(
                (signature) => signature.parameters.length > receiverParameter,
            )
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
        const signature = checker.getResolvedSignature(node)?.declaration;
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
            ts.isPropertyAccessExpression(node.expression) &&
            storingDataMethods.has(node.expression.name.text)) ||
        (ts.isNewExpression(node) &&
            ["Map", "Set"].includes(
                libraryGlobal(checker, node.expression) ?? "",
            ))
    );
}
