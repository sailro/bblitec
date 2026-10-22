import ts from "typescript";
import { isStoringDataCall } from "./receiver-methods.js";
import { libraryGlobal } from "./symbols.js";
import { unwrapExpression } from "./syntax.js";

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
        ? literal.properties.flatMap((property) =>
              ts.isPropertyAssignment(property)
                  ? [property.initializer]
                  : ts.isShorthandPropertyAssignment(property)
                    ? [property.name]
                    : [],
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
