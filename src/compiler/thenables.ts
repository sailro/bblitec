import ts from "typescript";
import { someAnalysisNode } from "./analysis-walk.js";
import { propertyKey } from "./syntax.js";

const declared = new WeakMap<ts.Program, boolean>();

/**
 * Whether a source file of the program names a `then` member: an object
 * literal's or a class's property, method or accessor, or a property a
 * string key reads or writes. Without one, every thenable the program holds
 * is a native promise.
 */
export function declaresThenMember(program: ts.Program): boolean {
    let found = declared.get(program);
    if (found === undefined) {
        found = program
            .getSourceFiles()
            .some(
                (file) =>
                    !file.isDeclarationFile &&
                    someAnalysisNode(file, namesThen),
            );
        declared.set(program, found);
    }
    return found;
}

function namesThen(node: ts.Node): boolean {
    if (
        ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
    )
        return propertyKey(node.name) === "then";
    return (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "then"
    );
}
