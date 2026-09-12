import type { LoweringServices } from "./lowering-services.js";
import ts from "typescript";
import { renderClosure, renderCoroutineInvocation, type CapturedClosure } from "./closure-captures.js";
import { browserGlobalNamed } from "./browser-erasure.js";
import { tryResolveFunctionDeclaration } from "./user-functions.js";
import { unwrapExpression, argumentAt } from "./syntax.js";
import type { Value } from "./types.js";
import { someAnalysisNode } from "./analysis-walk.js";

interface AsyncContext
    extends Pick<LoweringServices,
        | "checker"
        | "dataLowerer"
        | "dataTypes"
        | "compileValue"
        | "compileCallbackWithValues"
        | "captureManagedClosureLines"
        | "withOwnedCallbackBody"
        | "allocateTemporaryCppName"
        | "registerNativeBinding"
        | "emit"
        | "emitDiscardedValue"
        | "unwrap"
        | "lookupOptional"
        | "isDefaultLibraryIdentifier"
        | "isBrowserOnlyLocalCall"
        | "isBrowserOnlyExpression"
        | "fail"
    > {}

/** Async activation and reaction lowering share the compiler's managed captures. */
export class AsyncLowerer {
    private depth = 0;
    private terminalThrow: ts.Statement | undefined;
    constructor(private readonly context: AsyncContext) {}

    withActivation<T>(work: () => T): T {
        this.depth++;
        try { return work(); } finally { this.depth--; }
    }

    isTerminalThrow(node: ts.Node | undefined): boolean {
        return node !== undefined && node === this.terminalThrow;
    }

    compile(expression: ts.Expression): Value | undefined {
        const context = this.context;
        // unwrap intentionally removes awaits for the existing immediate path;
        // this realm path must see the suspension before that happens.
        const node = unwrapExpression(expression);
        if (ts.isTypeOfExpression(node)) {
            const property = context.unwrap(node.expression);
            if (this.isPromiseMethod(property)) {
                const receiver = context.dataLowerer.narrowOptional(context.compileValue(property.expression), property.expression);
                if (receiver.kind !== "promise") return context.fail(property, "Promise method inspection requires a present native promise.");
                context.emitDiscardedValue(receiver);
                return {kind:"string", cpp:'"function"', staticString:"function"};
            }
        }
        if (ts.isAwaitExpression(node)) {
            if (!this.depth) return context.fail(node, "This await needs an asynchronous realm activation.");
            const erasedVoid = context.isBrowserOnlyExpression(node.expression) &&
                ((context.checker.getAwaitedType(context.checker.getTypeAtLocation(node.expression))?.flags ?? 0) & ts.TypeFlags.Void) !== 0;
            const awaited = this.asPromise(erasedVoid ? { kind: "void", cpp: "" } : context.compileValue(node.expression), node);
            const temporary = context.allocateTemporaryCppName("await_result");
            context.emit({ kind: "declaration", type: "auto", name: temporary, initializer: `co_await ${awaited.cpp}`, attributes: "[[maybe_unused]] " });
            const binding = context.registerNativeBinding(temporary);
            return { ...this.resultAt(awaited.promiseResult!, temporary), nativeCaptures: [binding] };
        }
        if (!ts.isCallExpression(node)) return undefined;
        const callee = context.unwrap(node.expression);
        if (ts.isPropertyAccessExpression(callee) && browserGlobalNamed(context, callee.expression)?.text === "Promise" && callee.name.text === "resolve") {
            if (node.arguments.length > 1) return context.fail(node, "Promise.resolve accepts at most one value.");
            return this.asPromise(node.arguments[0] ? context.compileValue(node.arguments[0]) : { kind: "void", cpp: "" }, node);
        }
        if (this.isPromiseMethod(callee)) {
            const rejection = callee.name.text === "catch";
            if (node.arguments.length < 1 || node.arguments.length > (rejection ? 1 : 2)) {
                return context.fail(node, rejection ? "Promise.catch requires one callback." : "Promise.then requires one or two callbacks.");
            }
            const promise = this.asPromise(context.compileValue(callee.expression), node);
            const first = this.compileReaction(argumentAt(node, 0), promise, rejection, node);
            if (rejection && promise.promiseResult!.kind !== "void" && first.result.kind === "void") {
                return context.fail(argumentAt(node, 0), "A value promise's recovery must preserve its admitted result type.");
            }
            let output = rejection ? promise.promiseResult! : first.output;
            const cppType = rejection ? promise.promiseType! : first.cppType;
            const reactions = [first.cpp];
            if (node.arguments.length === 2) {
                const second = this.compileReaction(argumentAt(node, 1), promise, true, node);
                if (second.cppType !== cppType) return context.fail(argumentAt(node, 1), "Promise.then callbacks must settle to the same admitted result type.");
                reactions.push(second.cpp);
                // Either branch can settle the result; neither branch's scalar
                // constant is a fact about the resulting promise.
                const {staticString, staticNumber, staticBoolean, ...runtimeOutput} = output;
                output = runtimeOutput;
            }
            return { kind: "promise", cpp: `${promise.cpp}.${rejection ? "catch_error" : "then"}(${reactions.join(", ")})`, promiseResult: output, promiseType: cppType };
        }
        if (!ts.isIdentifier(callee)) return undefined;
        const declaration = tryResolveFunctionDeclaration(context.checker, callee);
        if (!declaration || !ts.getModifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return undefined;
        if (context.isBrowserOnlyLocalCall(node)) return undefined;
        const values = node.arguments.map(argument => {
            const value = context.compileValue(argument);
            if (!value.cpp || value.kind === "engine") return value;
            const temporary = context.allocateTemporaryCppName("async_argument");
            context.emit({ kind: "declaration", type: "auto", name: temporary, initializer: value.cpp });
            const binding = context.registerNativeBinding(temporary);
            return { ...this.resultAt(value, temporary), nativeCaptures: [binding] };
        });
        const result: { value: Value } = { value: { kind: "void", cpp: "" } };
        const body = declaration.body;
        const finalStatement = body && ts.isBlock(body) ? body.statements.at(-1) : undefined;
        const rejectsOnly = finalStatement && ts.isThrowStatement(finalStatement) &&
            !someAnalysisNode(body!, ts.isReturnStatement, {functions:"skip"});
        const previousThrow = this.terminalThrow;
        this.terminalThrow = rejectsOnly ? finalStatement : undefined;
        let compiled: CapturedClosure;
        try {
            compiled = this.withActivation(() =>
                context.withOwnedCallbackBody(() => context.captureManagedClosureLines(() => {
                    result.value = context.compileCallbackWithValues(callee, values, node);
                    if (result.value.kind === "void" && result.value.cpp) context.emit(`${result.value.cpp};`);
                    if (!rejectsOnly) context.emit(`co_return ${result.value.kind === "void" ? "bbl::js::PromiseVoid{}" : result.value.ownedEngineCpp ?? result.value.cpp};`);
                })));
        } finally {
            this.terminalThrow = previousThrow;
        }
        const output = result.value.kind === "promise" ? result.value.promiseResult! : result.value;
        const cppType = result.value.kind === "promise" ? result.value.promiseType! : this.cppType(output, node);
        // The coroutine takes its environment by value; a temporary closure's
        // this pointer or a borrowed environment must never enter its frame.
        // Terminal throws share the native coroutine completion path, including
        // when earlier statements suspend. No unreachable epilogue is emitted.
        const cpp = renderCoroutineInvocation(compiled, `bbl::js::Promise<${cppType}>`);
        return { kind: "promise", cpp, promiseResult: output, promiseType: cppType };
    }

    private compileReaction(callback: ts.Expression, promise: Value, rejection: boolean, node: ts.CallExpression):
        {cpp: string; result: Value; output: Value; cppType: string} {
        const context = this.context;
        callback = context.unwrap(callback);
        if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback) && !ts.isIdentifier(callback)) {
            return context.fail(callback, "Promise reactions require a compiled function value.");
        }
        const name = context.allocateTemporaryCppName("promise_argument");
        const parameterType = rejection ? "std::exception_ptr" : `const ${promise.promiseType}&`;
        const result: {value: Value} = {value:{kind:"void", cpp:""}};
        const compiled = context.withOwnedCallbackBody(() => context.captureManagedClosureLines(() => {
            context.registerNativeBinding(name);
            const input: Value = rejection ? {kind:"string", cpp:`bbl::js::promise_error_string(${name})`}
                : this.resultAt(promise.promiseResult!, name);
            result.value = context.compileCallbackWithValues(callback, [input], node);
            if (result.value.kind === "void") { if (result.value.cpp) context.emit(`${result.value.cpp};`); }
            else context.emit(`return ${result.value.cpp};`);
        }));
        const output = result.value.kind === "promise" ? result.value.promiseResult! : result.value;
        const cppType = result.value.kind === "promise" ? result.value.promiseType! : this.cppType(output, node);
        return {cpp:renderClosure(compiled, `[[maybe_unused]] ${parameterType} ${name}`), result:result.value, output, cppType};
    }

    private isPromiseType(expression: ts.Expression): boolean {
        return this.context.checker.getTypeAtLocation(expression).getSymbol()?.name === "Promise";
    }
    private isPromiseMethod(expression: ts.Expression): expression is ts.PropertyAccessExpression {
        return ts.isPropertyAccessExpression(expression) && ["then", "catch"].includes(expression.name.text) &&
            this.isPromiseType(expression.expression);
    }
    private cppType(value: Value, node: ts.Node): string {
        if (value.kind === "void") return "bbl::js::PromiseVoid";
        if (value.dataType) return this.context.dataTypes.cppType(value.dataType);
        if (value.kind === "number") return "double";
        if (value.kind === "boolean") return "bool";
        if (value.kind === "string") return "std::string";
        if (value.kind === "engine" && value.ownedEngineCpp) return "std::shared_ptr<bbl::Engine>";
        if (value.kind === "asset") return "bbl::AssetHandle";
        if (value.kind === "scene") return "bbl::Scene";
        if (value.kind === "environment-textures") return "std::shared_ptr<const bbl::EnvironmentState>";
        return this.context.fail(node, `Promise result '${value.kind}' has no owned asynchronous representation.`);
    }
    private resultAt(value: Value, cpp: string): Value {
        if (value.kind === "engine") return { ...value, cpp: `(*${cpp})`, engineCpp: `(*${cpp})`, ownedEngineCpp: cpp,
            nativeCaptures: [], nativeCompanionCaptures: { engineCpp: [this.context.registerNativeBinding(cpp)] } };
        if (value.kind === "number" || value.kind === "boolean" || value.kind === "string") return {
            kind: value.kind, cpp, ...(value.dataType ? { dataType: value.dataType } : {}),
            ...(value.staticString !== undefined ? { staticString: value.staticString } : {}),
            ...(value.staticNumber !== undefined ? { staticNumber: value.staticNumber } : {}),
        };
        return { ...value, cpp, nativeCaptures: [] };
    }
    private asPromise(value: Value, node: ts.Node): Value {
        if (value.kind === "promise") return value;
        const type = this.cppType(value, node);
        const cpp = value.kind === "void"
            ? value.cpp ? `(${value.cpp}, bbl::js::PromiseVoid{})` : "bbl::js::PromiseVoid{}"
            : value.ownedEngineCpp ?? value.cpp;
        return { kind: "promise", cpp: `bbl::js::Promise<${type}>::resolved(${cpp})`, promiseResult: value, promiseType: type };
    }
}
