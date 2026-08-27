/**
 * A pinned mesh builder's own option defaults, read from the factory that
 * states them.
 *
 * Every builder in `src/mesh/create-*.ts` resolves its options the same way
 * — one `const x = options.x ?? <default>` per option — and this port's
 * intrinsics resolve them at GENERATION, because a builder's emitted body
 * binds each option to the present arm of that `??`. So the default has to
 * reach the call site, and reading it here is what keeps it the pin's
 * rather than a second copy typed beside the intrinsic.
 *
 * The shadow family answers the same question through emitted
 * `*_default_*` constants, because its factories are lowered into a header
 * the scene already includes. The mesh factories emit no header, so the
 * value is folded into the call instead — the same fact, at the only place
 * a mesh scene can carry it.
 */
import ts from "typescript";
import { sharedUpstreamStore } from "./upstream-source.js";

/** One `const <local> = <options>.<local> ?? <default>` fallback. */
export function pinnedMeshOptionDefault(
    modulePath: string,
    factory: string,
    local: string,
): number {
    const file = sharedUpstreamStore().getSourceFile(modulePath);
    const declaration = findFactory(file, factory, modulePath);
    const initializer = findLocalInitializer(declaration, local);
    if (initializer === undefined) {
        throw new Error(
            `${modulePath}#${factory} declares no local '${local}'.`,
        );
    }
    const value = nullishDefault(initializer, local);
    if (value === undefined) {
        throw new Error(
            `${modulePath}#${factory} resolves '${local}' through a shape ` +
                "this port does not read as a '??' default.",
        );
    }
    return value;
}

function findFactory(
    file: ts.SourceFile,
    factory: string,
    modulePath: string,
): ts.FunctionDeclaration {
    for (const statement of file.statements) {
        if (
            ts.isFunctionDeclaration(statement) &&
            statement.name?.text === factory &&
            statement.body
        ) {
            return statement;
        }
    }
    throw new Error(`${modulePath} declares no function '${factory}'.`);
}

function findLocalInitializer(
    declaration: ts.FunctionDeclaration,
    local: string,
): ts.Expression | undefined {
    let found: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
        if (found) return;
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === local &&
            node.initializer
        ) {
            found = node.initializer;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(declaration);
    return found;
}

/**
 * The numeric right side of the `??` that resolves one option.
 *
 * A builder wraps that operator in whatever its own contract needs — `| 0`
 * for an integer, `Math.max(3, ...)` for a floor, a guard ternary that
 * rejects an out-of-range value — and none of those wrappers is the
 * DEFAULT. The default is what the read falls back to when the option is
 * absent, so the search is for the `??` itself wherever the builder put it,
 * and every wrapper stays in the builder's own body where the pin wrote it.
 */
function nullishDefault(
    expression: ts.Expression,
    local: string,
): number | undefined {
    let found: number | undefined;
    const visit = (node: ts.Node): void => {
        if (found !== undefined) return;
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken &&
            namesOption(node.left, local)
        ) {
            // `options.diameterTop ?? options.diameter ?? 1` — the chain
            // continues until something is not another optional read.
            const right = unwrap(node.right);
            found = ts.isNumericLiteral(right)
                ? Number(right.text)
                : nullishDefault(node.right, local);
            if (found !== undefined) return;
        }
        ts.forEachChild(node, visit);
    };
    visit(expression);
    if (found !== undefined) return found;
    // The tail of a chain reads a DIFFERENT option than the local it
    // resolves (`diameterTop` falls back to `diameter`), so a second pass
    // takes the first `??` over any optional read.
    const visitAny = (node: ts.Node): void => {
        if (found !== undefined) return;
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
            const right = unwrap(node.right);
            if (ts.isNumericLiteral(right)) {
                found = Number(right.text);
                return;
            }
        }
        ts.forEachChild(node, visitAny);
    };
    visitAny(expression);
    return found;
}

/** Whether an expression reads `<something>.<local>`. */
function namesOption(expression: ts.Expression, local: string): boolean {
    const node = unwrap(expression);
    return (
        ts.isPropertyAccessExpression(node) && node.name.text === local
    );
}

function unwrap(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
        ts.isParenthesizedExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isAsExpression(current)
    ) {
        current = current.expression;
    }
    return current;
}
