import ts from "typescript";
import type { Value } from "./types.js";

export interface PromiseLoweringContext {
    compileValue(expression: ts.Expression): Value;
    emitStatement(statement: ts.Statement): void;
    emit(line: string): void;
    bindLocalValue(
        identifier: ts.Identifier,
        value: Value,
    ): void;
    pushScope(cppPrefix: string): void;
    popScope(): void;
    allocateBlockPrefix(): string;
    allocateTemporaryCppName(label: string): string;
    fail(node: ts.Node, message: string): never;
}

export function compileImmediatePromise(
    context: PromiseLoweringContext,
    call: ts.CallExpression,
): Value | undefined {
    if (
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "Promise" &&
        call.expression.name.text === "all"
    ) {
        if (
            call.arguments.length !== 1 ||
            !ts.isArrayLiteralExpression(
                call.arguments[0]!,
            )
        ) {
            context.fail(
                call,
                "Promise.all requires one static array literal.",
            );
        }
        // Every element runs for its side effects whether or not the caller
        // keeps its result — one of the awaited calls in Scene 21 is
        // `loadEnvironment`, which the destructuring pattern skips with a
        // hole. So the elements are always compiled in order here; the only
        // question is whether their values have to outlive the call.
        if (!isDestructured(call)) {
            for (const element of call.arguments[0].elements) {
                emitValue(
                    context,
                    context.compileValue(element),
                );
            }
            return { kind: "void", cpp: "" };
        }
        const elements: Value[] = [];
        for (const element of call.arguments[0].elements) {
            const value = context.compileValue(element);
            if (value.cpp.length === 0 || value.kind === "engine") {
                elements.push(value);
                continue;
            }
            if (value.kind === "void") {
                context.emit(`${value.cpp};`);
                elements.push(value);
                continue;
            }
            const temporary =
                context.allocateTemporaryCppName("awaited");
            context.emit(`auto ${temporary} = ${value.cpp};`);
            elements.push({ ...value, cpp: temporary });
        }
        return { kind: "tuple", cpp: "", tupleElements: elements };
    }
    if (
        !ts.isPropertyAccessExpression(call.expression) ||
        call.expression.name.text !== "then"
    ) {
        return undefined;
    }
    if (call.arguments.length !== 1) {
        context.fail(
            call,
            "Immediate promise then requires one callback.",
        );
    }
    const callback = call.arguments[0]!;
    if (
        !ts.isArrowFunction(callback) &&
        !ts.isFunctionExpression(callback)
    ) {
        context.fail(
            callback,
            "Immediate promise then requires an inline callback.",
        );
    }
    if (
        callback.parameters.length !== 1 ||
        !ts.isIdentifier(callback.parameters[0]!.name)
    ) {
        context.fail(
            callback,
            "Immediate promise callback requires one identifier parameter.",
        );
    }
    const value = context.compileValue(
        call.expression.expression,
    );
    context.pushScope(context.allocateBlockPrefix());
    try {
        context.bindLocalValue(
            callback.parameters[0]!.name,
            value,
        );
        if (ts.isBlock(callback.body)) {
            for (const statement of callback.body.statements) {
                context.emitStatement(statement);
            }
        } else {
            emitValue(
                context,
                context.compileValue(callback.body),
            );
        }
    } finally {
        context.popScope();
    }
    return { kind: "void", cpp: "" };
}

/**
 * Whether the awaited call's result is bound by an array pattern. A
 * `Promise.all` whose result is discarded keeps emitting its elements as bare
 * statements, which is what every scene reaching it before Scene 21 does.
 */
function isDestructured(call: ts.CallExpression): boolean {
    let node: ts.Node = call;
    while (
        ts.isAwaitExpression(node.parent) ||
        ts.isParenthesizedExpression(node.parent) ||
        ts.isAsExpression(node.parent) ||
        ts.isNonNullExpression(node.parent)
    ) {
        node = node.parent;
    }
    return (
        ts.isVariableDeclaration(node.parent) &&
        node.parent.initializer === node &&
        ts.isArrayBindingPattern(node.parent.name)
    );
}

function emitValue(
    context: PromiseLoweringContext,
    value: Value,
): void {
    if (
        value.kind !== "engine" &&
        value.cpp.length > 0
    ) {
        context.emit(`${value.cpp};`);
    }
}
