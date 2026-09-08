import ts from "typescript";
import { promiseExecutor } from "./promise-executor.js";

/** A closed Promise executor: local setup, one zero-argument RAF poll, and its initial call. */
export function framePollExecutor(expression: ts.Expression, checker: ts.TypeChecker, isGlobal: (identifier: ts.Identifier) => boolean): {
    setup: readonly ts.Statement[];
    condition: ts.Expression;
} | undefined {
    const head = promiseExecutor(expression, isGlobal);
    if (!head) return undefined;
    const { executor, resolve: resolveParameter } = head;
    if (!ts.isBlock(executor.body)) return undefined;
    const statements = executor.body.statements;
    const declaration = statements.at(-2);
    const initialCall = statements.at(-1);
    if (!declaration || !ts.isVariableStatement(declaration) || declaration.declarationList.declarations.length !== 1 ||
        !initialCall || !ts.isExpressionStatement(initialCall) || !ts.isCallExpression(initialCall.expression)) return undefined;
    const poll = declaration.declarationList.declarations[0]!;
    if (!(declaration.declarationList.flags & ts.NodeFlags.Const)) return undefined;
    if (!ts.isIdentifier(poll.name) || !poll.initializer || !ts.isArrowFunction(poll.initializer) ||
        poll.initializer.parameters.length !== 0 || !ts.isBlock(poll.initializer.body) || poll.initializer.body.statements.length !== 2) return undefined;
    const [guard, scheduled] = poll.initializer.body.statements;
    if (!guard || !ts.isIfStatement(guard) || guard.elseStatement || !ts.isBlock(guard.thenStatement) || guard.thenStatement.statements.length !== 2 ||
        !scheduled || !ts.isExpressionStatement(scheduled) || !ts.isCallExpression(scheduled.expression)) return undefined;
    const [resolve, done] = guard.thenStatement.statements;
    if (!resolve || !ts.isExpressionStatement(resolve) || !ts.isCallExpression(resolve.expression) ||
        !ts.isIdentifier(resolve.expression.expression) || resolve.expression.expression.text !== resolveParameter.text || resolve.expression.arguments.length !== 0 ||
        !done || !ts.isReturnStatement(done) || done.expression) return undefined;
    const raf = scheduled.expression;
    if (!ts.isIdentifier(raf.expression) || raf.expression.text !== "requestAnimationFrame" || !isGlobal(raf.expression) || raf.arguments.length !== 1 ||
        !ts.isIdentifier(raf.arguments[0]!) || raf.arguments[0]!.text !== poll.name.text ||
        !ts.isIdentifier(initialCall.expression.expression) || initialCall.expression.expression.text !== poll.name.text || initialCall.expression.arguments.length !== 0) return undefined;
    const sameSymbol = (left: ts.Node, right: ts.Node) => checker.getSymbolAtLocation(left) !== undefined && checker.getSymbolAtLocation(left) === checker.getSymbolAtLocation(right);
    if (!sameSymbol(resolve.expression.expression, resolveParameter) ||
        !sameSymbol(raf.arguments[0]!, poll.name) || !sameSymbol(initialCall.expression.expression, poll.name) ||
        executor.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
        poll.initializer.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return undefined;
    if (!statements.slice(0, -2).every(statement => ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0)) return undefined;
    return { setup: statements.slice(0, -2), condition: guard.expression };
}
