import ts from "typescript";
import { isStoringDataCall } from "./receiver-methods.js";
import { resolvedSymbol } from "./symbols.js";
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

/** Whether `new` builds an instance of a class the program declares. */
export function constructsProgramClass(
    checker: ts.TypeChecker,
    construction: ts.NewExpression,
): boolean {
    const declaration = resolvedSymbol(
        checker,
        unwrapExpression(construction.expression),
    )?.declarations?.find(ts.isClassLike);
    return (
        declaration !== undefined &&
        !declaration.getSourceFile().isDeclarationFile
    );
}

/**
 * The arguments a call or construction keeps past its return: a class of
 * the program keeps them for its methods (a parameter property, a field),
 * a storing data call (`push`, `set`, `new Map(entries)`) in the container.
 */
export function keptArguments(
    checker: ts.TypeChecker,
    node: ts.Node,
): readonly ts.Expression[] {
    if (
        (ts.isNewExpression(node) && constructsProgramClass(checker, node)) ||
        isStoringDataCall(node, checker)
    )
        return node.arguments ?? [];
    return [];
}
