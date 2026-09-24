import ts from "typescript";
import type { DataType, DataTypeRegistry } from "./data-types.js";
import { libraryGlobal } from "./symbols.js";

/** An escaped Promise reject callback accepts the runtime's represented Error reason. */
export function inferPromiseRejectStorage(
    declaration: ts.VariableDeclaration,
    checker: ts.TypeChecker,
): DataType | undefined {
    if (declaration.initializer || !ts.isIdentifier(declaration.name))
        return undefined;
    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (!symbol) return undefined;
    let found = false;
    let compatible = true;
    const visit = (node: ts.Node): void => {
        if (!compatible) return;
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.left) &&
            checker.getSymbolAtLocation(node.left) === symbol
        ) {
            const rhs = ts.isIdentifier(node.right)
                ? checker.getSymbolAtLocation(node.right)
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
    return found && compatible
        ? { kind: "function", parameters: [{ kind: "error" }] }
        : undefined;
}

/** TypeScript's evolving-any declarations acquire storage only when all uses agree. */
export function inferUninitializedHandle(
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
    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (!symbol) return undefined;
    let inferred: (DataType & { kind: "handle" }) | undefined;
    let writes = 0;
    let reads = 0;
    let compatible = true;
    const visit = (node: ts.Node): void => {
        if (!compatible) return;
        if (
            ts.isIdentifier(node) &&
            node !== declaration.name &&
            checker.getSymbolAtLocation(node) === symbol
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
                type?.kind !== "handle" ||
                (inferred && inferred.handle !== type.handle)
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
