import ts from "typescript";
import { accessKey, bindingElementKey } from "./syntax.js";

const reflectiveObjectMethods = new Set([
    "assign",
    "entries",
    "getOwnPropertyDescriptors",
    "getOwnPropertyNames",
    "keys",
    "values",
]);

const cache = new WeakMap<ts.Program, Map<string, boolean>>();

/**
 * Whether no reached source can observe a property named `name`: nothing
 * reads it by name (a property or literal element access, a binding or an
 * assignment pattern), and no reflective operation -- a spread, an
 * `Object.*` enumeration, `JSON.stringify`, `for...in` -- takes a value
 * whose type carries it. Such a field can be left out of native storage,
 * since nothing would ever read it back.
 */
export function propertyNeverObserved(
    program: ts.Program,
    checker: ts.TypeChecker,
    name: string,
): boolean {
    let names = cache.get(program);
    if (!names) {
        names = new Map();
        cache.set(program, names);
    }
    const known = names.get(name);
    if (known !== undefined) return known;
    const carries = (expression: ts.Expression): boolean => {
        const type = checker.getTypeAtLocation(expression);
        const parts = type.isUnion() ? type.types : [type];
        return parts.some(
            (part) =>
                (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !==
                    0 || part.getProperty(name) !== undefined,
        );
    };
    const observes = (node: ts.Node): boolean => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === name)
            return true;
        if (ts.isElementAccessExpression(node)) {
            // A key only the run time knows may be this one.
            const key = accessKey(node);
            if ((key === undefined || key === name) && carries(node.expression))
                return true;
        }
        if (
            ts.isBindingElement(node) &&
            ts.isObjectBindingPattern(node.parent)
        ) {
            const key = bindingElementKey(node);
            if (
                node.dotDotDotToken !== undefined ||
                key === undefined ||
                key === name
            )
                return true;
        }
        if (
            (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) &&
            carries(node.expression)
        )
            return true;
        if (ts.isForInStatement(node) && carries(node.expression)) return true;
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const reflective =
                ts.isPropertyAccessExpression(callee) &&
                ts.isIdentifier(callee.expression) &&
                ((callee.expression.text === "Object" &&
                    reflectiveObjectMethods.has(callee.name.text)) ||
                    (callee.expression.text === "JSON" &&
                        callee.name.text === "stringify") ||
                    (callee.expression.text === "Reflect" &&
                        callee.name.text !== "apply"));
            if (reflective && node.arguments.some(carries)) return true;
        }
        return (
            ts.forEachChild(node, (child) =>
                observes(child) ? true : undefined,
            ) === true
        );
    };
    const unread = program
        .getSourceFiles()
        .filter((file) => !file.isDeclarationFile)
        .every((file) => !observes(file));
    names.set(name, unread);
    return unread;
}
