import ts from "typescript";
import {
    dataTypesEqual,
    type DataType,
    type DataTypeRegistry,
} from "./data-types.js";
import { declaredSymbol, libraryGlobal, resolvedSymbol } from "./symbols.js";
import { unwrapExpression, variableKind } from "./syntax.js";
import { constructsSyntheticEvent } from "./synthetic-event-classes.js";
import { returnsOnly } from "./fresh-records.js";

/** An escaped Promise reject callback accepts the runtime's represented Error reason. */
export function inferPromiseRejectStorage(
    declaration: ts.VariableDeclaration,
    checker: ts.TypeChecker,
): DataType | undefined {
    if (declaration.initializer || !ts.isIdentifier(declaration.name))
        return undefined;
    const symbol = declaredSymbol(checker, declaration.name);
    if (!symbol) return undefined;
    let found = false;
    let compatible = true;
    const visit = (node: ts.Node): void => {
        if (!compatible) return;
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.left) &&
            declaredSymbol(checker, node.left) === symbol
        ) {
            const rhs = ts.isIdentifier(node.right)
                ? resolvedSymbol(checker, node.right)
                : undefined;
            const parameter = rhs?.valueDeclaration;
            const executor =
                parameter && ts.isParameter(parameter)
                    ? parameter.parent
                    : undefined;
            const creation = executor?.parent;
            if (
                !executor ||
                !ts.isFunctionLike(executor) ||
                executor.parameters[1] !== parameter ||
                !creation ||
                !ts.isNewExpression(creation) ||
                creation.arguments?.[0] !== executor ||
                libraryGlobal(checker, creation.expression) !== "Promise"
            ) {
                compatible = false;
                return;
            }
            found = true;
        }
        ts.forEachChild(node, visit);
    };
    visit(
        ts.findAncestor(
            declaration,
            (node) => ts.isFunctionLike(node) || ts.isSourceFile(node),
        )!,
    );
    // Every value it holds is a Promise's reject resolver, which completes
    // with undefined.
    return found && compatible
        ? {
              kind: "function",
              parameters: [{ kind: "error" }],
              undefinedCompletion: true,
          }
        : undefined;
}

/**
 * TypeScript's evolving-any declarations (`let pose;`) acquire storage only
 * when every write and read of them TypeScript types as the same native
 * handle or the same record (`let pose; try { pose = format(world); } catch
 * { ... } use(pose.x)`), assigned where the source assigns it.
 */
/**
 * Whether every assignment to `let name: Event;` constructs the event it
 * stores (`new MouseEvent(...)`): the binding owns that synthetic event, not
 * one a platform callback lends.
 */
export function assignsOnlyConstructedEvents(
    declaration: ts.VariableDeclaration,
    checker: ts.TypeChecker,
    libraryGlobal: (expression: ts.Expression) => string | undefined,
): boolean {
    if (declaration.initializer || !ts.isIdentifier(declaration.name))
        return false;
    const symbol = declaredSymbol(checker, declaration.name);
    if (!symbol) return false;
    let writes = 0;
    let constructed = true;
    const visit = (node: ts.Node): void => {
        if (!constructed) return;
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.left) &&
            declaredSymbol(checker, node.left) === symbol
        ) {
            writes++;
            constructed = constructsSyntheticEvent(node.right, libraryGlobal);
        }
        ts.forEachChild(node, visit);
    };
    visit(
        ts.findAncestor(
            declaration,
            (node) => ts.isFunctionLike(node) || ts.isSourceFile(node),
        )!,
    );
    return constructed && writes > 0;
}

/**
 * Whether every value a function declared to return a DOM event returns is
 * an event it constructed: `new KeyboardEvent(...)` itself, a `const` such
 * a construction initializes, or a `let name: Event;` every assignment
 * gives one (`assignsOnlyConstructedEvents`). The function returns the
 * event it owns, not one a platform callback lends.
 */
export function returnsOnlyConstructedEvents(
    declaration: ts.SignatureDeclaration,
    checker: ts.TypeChecker,
    libraryGlobal: (expression: ts.Expression) => string | undefined,
): boolean {
    // A signature without a body returns nothing it constructed.
    return returnsOnly(
        declaration as ts.FunctionLikeDeclaration,
        new Set(),
        (returned) => {
            const value = unwrapExpression(returned);
            if (constructsSyntheticEvent(value, libraryGlobal)) return true;
            const held = ts.isIdentifier(value)
                ? declaredSymbol(checker, value)?.valueDeclaration
                : undefined;
            if (!held || !ts.isVariableDeclaration(held)) return false;
            return held.initializer
                ? variableKind(held) === "const" &&
                      constructsSyntheticEvent(
                          unwrapExpression(held.initializer),
                          libraryGlobal,
                      )
                : assignsOnlyConstructedEvents(held, checker, libraryGlobal);
        },
    );
}

export function inferUninitializedStorage(
    declaration: ts.VariableDeclaration,
    checker: ts.TypeChecker,
    dataTypes: DataTypeRegistry,
): DataType | undefined {
    if (
        declaration.type ||
        declaration.initializer ||
        !ts.isIdentifier(declaration.name)
    )
        return undefined;
    const symbol = declaredSymbol(checker, declaration.name);
    if (!symbol) return undefined;
    let inferred: DataType | undefined;
    let writes = 0;
    let reads = 0;
    let compatible = true;
    const visit = (node: ts.Node): void => {
        if (!compatible) return;
        if (
            ts.isIdentifier(node) &&
            node !== declaration.name &&
            declaredSymbol(checker, node) === symbol
        ) {
            const assignment =
                ts.isBinaryExpression(node.parent) &&
                node.parent.left === node &&
                node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
                    ? node.parent
                    : undefined;
            const expression = assignment?.right ?? node;
            const type = dataTypes.fromTsType(
                checker.getTypeAtLocation(expression),
                expression,
            );
            if (
                (type?.kind !== "handle" && type?.kind !== "struct") ||
                (inferred && !dataTypesEqual(inferred, type))
            ) {
                compatible = false;
                return;
            }
            inferred = type;
            if (assignment) writes++;
            else reads++;
        }
        ts.forEachChild(node, visit);
    };
    visit(
        ts.findAncestor(
            declaration,
            (node) => ts.isFunctionLike(node) || ts.isSourceFile(node),
        )!,
    );
    return compatible && writes > 0 && reads > 0 ? inferred : undefined;
}
