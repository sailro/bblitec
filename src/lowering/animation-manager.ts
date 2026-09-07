import ts from "typescript";
import { LoweringContext } from "./context.js";
import { cppPrecedence, renderCppExpression } from "./gltf/animation-interpolation.js";
import type { CppExpressionScope } from "./gltf/shared.js";

/** The clock arithmetic and state writes come from the manager, while RAF
 * registration belongs to the PAL's existing ordered frame conductor. */
export function lowerAnimationManagerClock(context: LoweringContext): {
    step: string;
    stepGuard: string;
    delta: string;
    autonomousStep: string;
    startGuard: string;
    tickGuard: string;
    stopGuard: string;
    startWrites: string;
    tickWrites: string;
    stopWrites: string;
} {
    const module = "src/animation/animation-manager.ts";
    const { file, declaration: update } = context.functionDeclaration(module, "updateAnimationManager");
    const { declaration: start } = context.functionDeclaration(module, "startAnimationManager");
    const { declaration: stop } = context.functionDeclaration(module, "stopAnimationManager");
    const tick = context.variableInitializer(start, "tick");
    if (!ts.isArrowFunction(tick) || !ts.isBlock(tick.body)) {
        context.contractError(tick, "Expected the manager's autonomous tick callback.");
    }
    const { declaration: create } = context.functionDeclaration(module, "createAnimationManager");
    const created = create.body?.statements[0];
    if (!created || !ts.isReturnStatement(created) || !created.expression) {
        context.contractError(create, "Expected the manager's initial state record.");
    }
    context.assertExpressionShape(created.expression,
        "({ animations: [], fixedDeltaMs: options?.fixedDeltaMs ?? 0, running: false, engine: options?.engine, onUpdate: options?.onUpdate, _rafId: 0, _lastTime: 0 })",
        "Animation manager initial state");
    context.assertStatementInventory(start, start.body!.statements,
        "startAnimationManager", "the host replaces RAF availability and registration only",
        ["if statement", "if statement", "expression statement", "expression statement", "variable statement", "expression statement"]);
    context.assertStatementInventory(tick, tick.body.statements,
        "AnimationManager tick", "clock arithmetic, update, notification and requeue retain source order",
        ["if statement", "variable statement", "expression statement", "variable statement", "expression statement", "expression statement", "expression statement"]);
    context.assertStatementInventory(stop, stop.body!.statements,
        "stopAnimationManager", "cancellation precedes resetting the clock and running state",
        ["if statement", "expression statement", "expression statement", "expression statement", "expression statement"]);
    const tickExpressions = tick.body.statements.filter(ts.isExpressionStatement);
    for (const [index, shape] of ["manager._lastTime = now", "updateAnimationManager(manager, deltaMs)", "manager.onUpdate?.(step)", "manager._rafId = requestAnimationFrame(tick)"].entries()) {
        context.assertExpressionShape(tickExpressions[index]!.expression, shape, "Manager tick operation order");
    }
    const fields = new Map([
        ["fixedDeltaMs", "fixed_delta_ms"],
        ["running", "started"],
        ["_lastTime", "last_time_ms"],
    ]);
    const scope: CppExpressionScope = {
        symbol: "AnimationManager clock",
        file,
        names: new Map([["deltaMs", "delta_ms"], ["now", "now_ms"], ["step", "step"]]),
        numeric: (literal) => context.doubleLiteral(Number(literal.text)),
        propertyRead: (expression) => {
            const field = fields.get(expression.name.text);
            if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "manager" || !field) {
                context.contractError(expression, "Animation manager clock reads an unmapped field.");
            }
            return { text: `owner.${field}`, precedence: cppPrecedence.primary };
        },
        callRead: (expression) => {
            if (expression.expression.getText(file) !== "Number.isFinite" || expression.arguments.length !== 1) {
                context.contractError(expression, "Animation manager clock calls an unmapped operation.");
            }
            return {
                text: `std::isfinite(${renderCppExpression(scope, expression.arguments[0]!).text})`,
                precedence: cppPrecedence.primary,
            };
        },
    };
    const render = (expression: ts.Expression): string => renderCppExpression(scope, expression).text;
    const body = (function_: ts.FunctionDeclaration | ts.ArrowFunction): ts.Block => {
        if (!function_.body || !ts.isBlock(function_.body)) {
            context.contractError(function_, "Animation manager operation needs a block body.");
        }
        return function_.body;
    };
    const firstGuard = (function_: ts.FunctionDeclaration | ts.ArrowFunction): string => {
        const guard = body(function_).statements.find(ts.isIfStatement);
        if (!guard || !ts.isBlock(guard.thenStatement) || guard.thenStatement.statements.length !== 1 ||
            !ts.isReturnStatement(guard.thenStatement.statements[0]!)) {
            context.contractError(function_, "Expected the animation manager's early-return guard.");
        }
        return render(guard.expression);
    };
    const writes = (function_: ts.FunctionDeclaration | ts.ArrowFunction): string => {
        const output: string[] = [];
        for (const statement of body(function_).statements) {
            if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression) ||
                statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
            const { left, right } = statement.expression;
            if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.expression) || left.expression.text !== "manager") {
                context.contractError(left, "Animation manager lifecycle writes an unmapped target.");
            }
            if (left.name.text === "_rafId") {
                // A PAL callback identity replaces the browser RAF integer.
                if (ts.isNumericLiteral(right) && right.text === "0") continue;
                context.assertExpressionShape(right, "requestAnimationFrame(tick)", "Animation manager RAF registration");
                continue;
            }
            output.push(`    ${render(left)} = ${render(right)};`);
        }
        return output.join("\n");
    };
    context.expectShapeCount(start, "updateAnimationManager(manager, deltaMs)", "Autonomous manager update");
    context.expectShapeCount(start, "manager.onUpdate?.(step)", "Autonomous manager notification");
    context.expectShapeCount(stop, "cancelAnimationFrame(manager._rafId)", "Manager cancellation");
    return {
        step: render(context.variableInitializer(update, "step")),
        stepGuard: firstGuard(update),
        delta: render(context.variableInitializer(tick, "deltaMs")),
        autonomousStep: render(context.variableInitializer(tick, "step")),
        startGuard: firstGuard(start),
        tickGuard: firstGuard(tick),
        stopGuard: firstGuard(stop),
        startWrites: writes(start),
        tickWrites: writes(tick),
        stopWrites: writes(stop),
    };
}
