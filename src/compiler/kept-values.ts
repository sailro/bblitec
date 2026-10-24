import ts from "typescript";
import { isStoringDataCall, mutatingArrayMethods } from "./receiver-methods.js";
import {
    calledDeclaration,
    declarationInDefaultLibrary,
    libraryCallName,
    libraryGlobal,
    libraryName,
    namedMember,
} from "./symbols.js";
import { unwrapExpression, objectLiteralMembers } from "./syntax.js";
import {
    arrayShape,
    typeCanCarryReference,
    unionMembers,
} from "./type-facts.js";
import { TYPED_ARRAY_KINDS } from "./data-types/typed-arrays.js";

/**
 * The values a literal holds, at any depth: an object literal's property
 * values and an array literal's elements, through nested literals. A
 * member of another object held there is that same object.
 */
export function literalHeldValues(
    expression: ts.Expression,
): readonly ts.Expression[] {
    const literal = unwrapExpression(expression);
    const values = ts.isObjectLiteralExpression(literal)
        ? objectLiteralMembers(literal).flatMap((member) =>
              member.value === undefined ? [] : [member.value],
          )
        : ts.isArrayLiteralExpression(literal)
          ? literal.elements.filter(
                (element) =>
                    !ts.isSpreadElement(element) &&
                    !ts.isOmittedExpression(element),
            )
          : [];
    return values.flatMap((value) => [value, ...literalHeldValues(value)]);
}

/**
 * Whether `new` builds an object that may keep its arguments for its
 * methods (a parameter property, a field): anything but a library global,
 * whose storing ones (`new Map(entries)`) keep through isStoringDataCall.
 */
export function constructionKeepsArguments(
    checker: ts.TypeChecker,
    construction: ts.NewExpression,
): boolean {
    return libraryGlobal(checker, construction.expression) === undefined;
}

/**
 * The arguments a call or construction keeps past its return: a
 * construction for its methods, a storing data call (`push`, `splice`,
 * `fill`, `set`, `new Map(entries)`) in the container.
 */
export function keptArguments(
    checker: ts.TypeChecker,
    node: ts.Node,
): readonly ts.Expression[] {
    if (
        (ts.isNewExpression(node) &&
            constructionKeepsArguments(checker, node)) ||
        isStoringDataCall(node, checker)
    )
        return node.arguments ?? [];
    return [];
}

/**
 * Whether a call's result can share identity with its callee's receiver
 * (`receiver.method(...)`). A library array whose elements carry no
 * reference hands out only itself, which only its mutating methods return;
 * any other receiver may return itself or a member.
 */
export function callResultCanHoldReceiver(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
): boolean {
    const callee = namedMember(checker, unwrapExpression(call.expression));
    if (!callee) return true;
    const shape = arrayShape(
        checker,
        checker.getTypeAtLocation(callee.expression),
    );
    return (
        shape === undefined ||
        typeCanCarryReference(shape.element) ||
        mutatingArrayMethods.has(callee.name)
    );
}

/** Typed-array and view constructors: a view of a buffer, a copy of anything else. */
const BINARY_VIEWS: ReadonlySet<string> = new Set([
    ...TYPED_ARRAY_KINDS.keys(),
    "DataView",
]);

/**
 * Library methods whose result holds an argument: a new array or
 * collection holding it, or the receiver it was stored into.
 */
const ARGUMENT_HOLDING_METHODS: ReadonlySet<string> = new Set([
    "add",
    "concat",
    "fill",
    "set",
    "toSpliced",
    "with",
]);

/** Library statics and globals whose result is computed, holding no argument. */
const COMPUTING_LIBRARY_CALLS: ReadonlySet<string> = new Set([
    "Array.isArray",
    "Boolean",
    "Number",
    "String",
    "isFinite",
    "isNaN",
    "parseFloat",
    "parseInt",
    "JSON.parse",
    "JSON.stringify",
    "Object.getOwnPropertyNames",
    "Object.hasOwn",
    "Object.is",
    "Object.keys",
    "structuredClone",
]);

/**
 * Whether a default-library call's result may be, or hold, the object it is
 * handed at `index`: the one table every reader shares. A view holds the
 * buffer it is over and copies values; a library object's method holds an
 * argument only when it stores it (`set`, `concat`); a static or global
 * holds one unless it only computes (`Object.keys`, `JSON.stringify`,
 * `Math`), so one the table does not name may.
 */
export function libraryResultMayHold(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
    index: number,
): boolean {
    const name = libraryCallName(checker, call);
    if (name === undefined) return true;
    if (BINARY_VIEWS.has(name) || BINARY_VIEWS.has(name.split(".")[0]!)) {
        // A view over a buffer shares it; one over values copies them.
        const argument = call.arguments?.[index];
        const type =
            argument &&
            checker.getNonNullableType(checker.getTypeAtLocation(argument));
        return (
            type === undefined ||
            (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
            unionMembers(type).some((member) => {
                const name = libraryName(member);
                return name === "ArrayBuffer" || name === "SharedArrayBuffer";
            })
        );
    }
    const callee = namedMember(checker, unwrapExpression(call.expression));
    // A method of a library object: only the storing ones hand it back.
    if (callee && libraryGlobal(checker, callee.expression) === undefined)
        return ARGUMENT_HOLDING_METHODS.has(callee.name);
    return !(COMPUTING_LIBRARY_CALLS.has(name) || name.startsWith("Math."));
}

/**
 * Whether a default-library call's result can share identity with its
 * arguments or their members (`Object.values(record)[0]` is the record's
 * first value, `xs.concat(ys)` holds `ys`'s elements).
 */
export function callResultHoldsArguments(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
): boolean {
    const declaration = calledDeclaration(checker, call);
    return (
        declaration !== undefined &&
        declarationInDefaultLibrary(declaration) &&
        call.arguments.some((_, index) =>
            libraryResultMayHold(checker, call, index),
        )
    );
}
