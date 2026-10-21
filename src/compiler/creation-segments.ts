import ts from "typescript";
import { returnsOnly } from "./fresh-records.js";
import {
    localSyncFunction,
    unwrapExpression,
    writeSites,
    isSuspensionPoint,
} from "./syntax.js";
import type { CompilerSymbols } from "./symbols.js";

interface CreationSegmentContext {
    readonly symbols: Pick<
        CompilerSymbols,
        "babylonImportName" | "valueSymbol"
    >;
}

/**
 * The fresh creation of `target` when `write` runs in the synchronous
 * segment that created it: an earlier statement of the write's own block binds or assigns `target`
 * from a fresh creation (a pinned factory, or a local function returning
 * one), nothing between the two awaits or yields, and nothing in between
 * assigns `target` again. No frame can draw the fresh object in between,
 * so it is never observed without what the write attaches.
 */
export function creationInSegment(
    context: CreationSegmentContext,
    target: ts.Expression,
    write: ts.Node,
): ts.Expression | undefined {
    const name = unwrapExpression(target);
    if (!ts.isIdentifier(name)) return undefined;
    const symbol = context.symbols.valueSymbol(name);
    if (!symbol) return undefined;
    const names = (node: ts.Node): boolean =>
        ts.isIdentifier(node) && context.symbols.valueSymbol(node) === symbol;
    // Outward through enclosing blocks and `if` arms of one function body;
    // a loop or a nested function between the two ends the search.
    let child: ts.Node = write;
    for (;;) {
        let node = child;
        while (node.parent && !ts.isBlock(node.parent)) {
            const parent = node.parent;
            if (
                ts.isFunctionLike(parent) ||
                ts.isIterationStatement(parent, false) ||
                ts.isSourceFile(parent)
            )
                return undefined;
            node = parent;
        }
        const block = node.parent;
        if (!block || !ts.isBlock(block)) return undefined;
        const statements = block.statements;
        const at = statements.indexOf(node as ts.Statement);
        if (at < 0 || suspendsOrAssigns(statements[at]!, undefined))
            return undefined;
        for (let index = at - 1; index >= 0; index--) {
            const statement = statements[index]!;
            const created = creation(statement, names);
            if (created !== undefined)
                return isFreshCreation(context, created) &&
                    !suspendsOrAssigns(statement, undefined)
                    ? unwrapExpression(created)
                    : undefined;
            if (suspendsOrAssigns(statement, names)) return undefined;
        }
        if (ts.isFunctionLike(block.parent)) return undefined;
        child = block;
    }
}

/** The initializer a statement binds or assigns the target from. */
function creation(
    statement: ts.Statement,
    names: (node: ts.Node) => boolean,
): ts.Expression | undefined {
    if (ts.isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations.find(
            (candidate) => names(candidate.name),
        );
        return declaration?.initializer;
    }
    if (ts.isExpressionStatement(statement)) {
        const expression = unwrapExpression(statement.expression);
        if (
            ts.isBinaryExpression(expression) &&
            expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            names(unwrapExpression(expression.left))
        )
            return expression.right;
    }
    return undefined;
}

/**
 * A pinned create/clone call, or a call of a local synchronous function
 * whose every return is a const it bound from such a call.
 */
function isFreshCreation(
    context: CreationSegmentContext,
    expression: ts.Expression,
    depth = 0,
): boolean {
    const call = unwrapExpression(expression);
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression))
        return false;
    const pinned = context.symbols.babylonImportName(call.expression);
    if (pinned !== undefined) return /^(create|clone)/.test(pinned);
    if (depth > 2) return false;
    const fn = localSyncFunction(
        context.symbols.valueSymbol(call.expression)?.valueDeclaration,
    );
    if (!fn) return false;
    return returnsOnly(fn, new Set(), (expression) => {
        const returned = unwrapExpression(expression);
        if (ts.isCallExpression(returned))
            return isFreshCreation(context, returned, depth + 1);
        if (!ts.isIdentifier(returned)) return false;
        const bound = context.symbols.valueSymbol(returned)?.valueDeclaration;
        return (
            bound !== undefined &&
            ts.isVariableDeclaration(bound) &&
            (ts.getCombinedNodeFlags(bound) & ts.NodeFlags.Const) !== 0 &&
            bound.initializer !== undefined &&
            ts.findAncestor(bound, ts.isFunctionLike) === fn &&
            isFreshCreation(context, bound.initializer, depth + 1)
        );
    });
}

function suspendsOrAssigns(
    node: ts.Node,
    names: ((node: ts.Node) => boolean) | undefined,
): boolean {
    if (ts.isFunctionLike(node)) return false;
    if (isSuspensionPoint(node, { yield: true })) return true;
    if (names && writeSites(node).some(({ target }) => names(target)))
        return true;
    return (
        ts.forEachChild(node, (child) =>
            suspendsOrAssigns(child, names) ? true : undefined,
        ) === true
    );
}
