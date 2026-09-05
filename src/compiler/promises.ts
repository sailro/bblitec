import ts from "typescript";
import type { Value } from "./types.js";

export interface PromiseLoweringContext {
    compileValue(expression: ts.Expression): Value;
    compileCallbackWithValues(
        declaration: ts.ArrowFunction | ts.FunctionExpression,
        arguments_: readonly Value[],
        callNode: ts.Node,
        discardReturn?: boolean,
    ): Value;
    emitStatement(statement: ts.Statement): void;
    emit(line: string): void;
    increaseIndent(): void;
    decreaseIndent(): void;
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
        call.expression.name.text === "resolve"
    ) {
        if (call.arguments.length !== 1) {
            context.fail(
                call,
                "Immediate Promise.resolve requires one value.",
            );
        }
        return context.compileValue(call.arguments[0]!);
    }
    if (
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "Promise" &&
        call.expression.name.text === "all"
    ) {
        if (call.arguments.length !== 1) {
            context.fail(
                call,
                "Promise.all requires one static iterable.",
            );
        }
        const argument = call.arguments[0]!;
        if (!ts.isArrayLiteralExpression(argument)) {
            const iterable = context.compileValue(argument);
            if (
                iterable.kind === "data" &&
                iterable.dataType?.kind === "vector"
            ) {
                // Native array callbacks execute eagerly. By the time the
                // vector reaches Promise.all every immediate promise in it
                // has settled and all callback side effects have run.
                return isPromiseResultUsed(call)
                    ? iterable
                    : { kind: "void", cpp: "" };
            }
            if (iterable.kind !== "tuple" || !iterable.tupleElements) {
                context.fail(
                    argument,
                    "Promise.all requires an array literal or compile-time tuple.",
                );
            }
            return {
                kind: "tuple",
                cpp: "",
                tupleElements: iterable.tupleElements,
            };
        }
        // Every element runs for its side effects whether or not the caller
        // keeps its result — one of the awaited calls in Scene 21 is
        // `loadEnvironment`, which the destructuring pattern skips with a
        // hole. So the elements are always compiled in order here; the only
        // question is whether their values have to outlive the call.
        if (!isPromiseResultUsed(call)) {
            for (const element of argument.elements) {
                emitValue(
                    context,
                    context.compileValue(element),
                );
            }
            return { kind: "void", cpp: "" };
        }
        const elements: Value[] = [];
        for (const element of argument.elements) {
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
    if (!ts.isPropertyAccessExpression(call.expression)) {
        return undefined;
    }
    const method = call.expression.name.text;
    if (method === "catch") {
        return compileImmediateCatch(context, call);
    }
    if (method !== "then") return undefined;
    if (call.arguments.length < 1 || call.arguments.length > 2) {
        context.fail(
            call,
            "Immediate promise then requires one fulfillment callback and an optional rejection callback.",
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
        callback.parameters.length > 1 ||
        (callback.parameters.length === 1 &&
            !ts.isIdentifier(callback.parameters[0]!.name))
    ) {
        context.fail(
            callback,
            "Immediate promise callback accepts zero parameters or one identifier parameter.",
        );
    }
    const rejection = call.arguments[1];
    if (
        rejection &&
        ((!ts.isArrowFunction(rejection) &&
            !ts.isFunctionExpression(rejection)) ||
            rejection.parameters.length > 1 ||
            (rejection.parameters.length === 1 &&
                !ts.isIdentifier(rejection.parameters[0]!.name)))
    ) {
        context.fail(
            rejection,
            "Immediate promise rejection callback must be inline and accept zero parameters or one identifier parameter.",
        );
    }
    const fulfilled = rejection
        ? context.allocateTemporaryCppName("promise_fulfilled")
        : undefined;
    if (fulfilled) {
        context.emit(`bool ${fulfilled} = false;`);
        context.emit("try {");
        context.increaseIndent();
    }
    let value = context.compileValue(call.expression.expression);
    if (
        value.kind !== "engine" &&
        value.kind !== "void" &&
        value.cpp.length > 0
    ) {
        const settled = context.allocateTemporaryCppName("promise_value");
        context.emit(`auto ${settled} = ${value.cpp};`);
        value = { ...value, cpp: settled };
    } else if (value.kind === "void") {
        emitValue(context, value);
    }
    if (fulfilled) {
        context.emit(`${fulfilled} = true;`);
    }
    context.compileCallbackWithValues(
        callback,
        [value],
        call,
        true,
    );
    if (rejection && fulfilled) {
        context.decreaseIndent();
        context.emit("} catch (...) {");
        context.increaseIndent();
        context.emit(`if (${fulfilled}) { throw; }`);
        context.compileCallbackWithValues(
            rejection as ts.ArrowFunction | ts.FunctionExpression,
            [{ kind: "browser", cpp: "" }],
            call,
            true,
        );
        context.decreaseIndent();
        context.emit("}");
    }
    return { kind: "void", cpp: "" };
}

/**
 * Native async work is immediate, but it may still throw. A value-less
 * promise catch therefore maps to a native try/catch and returns a boolean
 * settlement token when source code retains the promise for memoization.
 */
function compileImmediateCatch(
    context: PromiseLoweringContext,
    call: ts.CallExpression,
): Value {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) {
        context.fail(call, "Immediate promise catch requires a property call.");
    }
    if (call.arguments.length !== 1) {
        context.fail(call, "Immediate promise catch requires one callback.");
    }
    const callback = call.arguments[0]!;
    if (
        (!ts.isArrowFunction(callback) &&
            !ts.isFunctionExpression(callback)) ||
        callback.parameters.length !== 0
    ) {
        context.fail(
            callback,
            "Immediate promise catch requires a zero-parameter inline callback.",
        );
    }
    const settled = context.allocateTemporaryCppName(
        "promise_settled",
    );
    context.emit(`[[maybe_unused]] bool ${settled} = true;`);
    context.emit("try {");
    context.increaseIndent();
    const value = context.compileValue(
        callee.expression,
    );
    if (value.kind !== "void") {
        context.fail(
            callee.expression,
            "Immediate promise catch currently supports Promise<void> work.",
        );
    }
    emitValue(context, value);
    context.decreaseIndent();
    context.emit("} catch (...) {");
    context.increaseIndent();
    context.emit(`${settled} = false;`);
    context.pushScope(context.allocateBlockPrefix());
    try {
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
    context.decreaseIndent();
    context.emit("}");
    return {
        kind: "boolean",
        cpp: settled,
        dataType: { kind: "boolean" },
    };
}

/**
 * Whether the awaited call's result is consumed. A discarded `Promise.all`
 * keeps emitting its elements as bare statements; a declaration, assignment,
 * return, or argument keeps the eagerly settled tuple/vector value.
 */
function isPromiseResultUsed(call: ts.CallExpression): boolean {
    let node: ts.Node = call;
    while (
        ts.isAwaitExpression(node.parent) ||
        ts.isParenthesizedExpression(node.parent) ||
        ts.isAsExpression(node.parent) ||
        ts.isNonNullExpression(node.parent) ||
        ts.isSatisfiesExpression(node.parent)
    ) {
        node = node.parent;
    }
    return !(
        ts.isExpressionStatement(node.parent) ||
        ts.isVoidExpression(node.parent)
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
