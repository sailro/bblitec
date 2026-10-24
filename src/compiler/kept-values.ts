import ts from "typescript";
import { isStoringDataCall, mutatingArrayMethods } from "./receiver-methods.js";
import { libraryGlobal, namedMember } from "./symbols.js";
import { unwrapExpression, objectLiteralMembers } from "./syntax.js";
import { arrayShape, typeCanCarryReference } from "./type-facts.js";

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

/** Library calls whose result holds their arguments or the arguments' members. */
const HOLDING_LIBRARY_CALLS: ReadonlySet<string> = new Set([
    "Array.from",
    "Array.of",
    "Object.assign",
    "Object.entries",
    "Object.fromEntries",
    "Object.values",
    "Promise.all",
    "Promise.allSettled",
    "Promise.any",
    "Promise.race",
    "Promise.resolve",
]);

/**
 * Whether a library call's result can share identity with its arguments or
 * their members (`Object.values(record)[0]` is the record's first value).
 */
export function callResultHoldsArguments(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
): boolean {
    const callee = namedMember(checker, unwrapExpression(call.expression));
    if (!callee) return false;
    const owner = libraryGlobal(checker, callee.expression);
    return (
        owner !== undefined &&
        HOLDING_LIBRARY_CALLS.has(`${owner}.${callee.name}`)
    );
}
