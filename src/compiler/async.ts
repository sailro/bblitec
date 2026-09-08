import ts from "typescript";
import { renderClosure, type CapturedClosure, type NativeCaptureBinding } from "./closure-captures.js";
import type { DataLowerer } from "./data-lowering.js";
import type { DataTypeRegistry } from "./data-types.js";
import { browserGlobalNamed } from "./browser-erasure.js";
import { tryResolveFunctionDeclaration } from "./user-functions.js";
import { unwrapExpression, argumentAt } from "./syntax.js";
import type { Value } from "./types.js";

interface AsyncContext {
    checker: ts.TypeChecker;
    dataLowerer: DataLowerer;
    dataTypes: DataTypeRegistry;
    compileValue(expression: ts.Expression): Value;
    compileCallbackWithValues(declaration: ts.Identifier | ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration,
        values: readonly Value[], node: ts.Node): Value;
    captureManagedClosureLines(body: () => void, byReference?: boolean): CapturedClosure;
    withOwnedCallbackBody<T>(body: () => T): T;
    allocateTemporaryCppName(label: string): string;
    registerNativeBinding(name: string): NativeCaptureBinding;
    emit(line: string): void;
    unwrap(expression: ts.Expression): ts.Expression;
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    isDefaultLibraryIdentifier(identifier: ts.Identifier): boolean;
    isBrowserOnlyLocalCall(call: ts.CallExpression): boolean;
    isBrowserOnlyExpression(expression: ts.Expression): boolean;
    fail(node: ts.Node, message: string): never;
}

/** Async activation and reaction lowering share the compiler's managed captures. */
export class AsyncLowerer {
    private depth = 0;
    constructor(private readonly context: AsyncContext) {}

    compile(expression: ts.Expression): Value | undefined {
        const context = this.context;
        // unwrap intentionally removes awaits for the existing immediate path;
        // this realm path must see the suspension before that happens.
        const node = unwrapExpression(expression);
        if (ts.isAwaitExpression(node)) {
            if (!this.depth) return context.fail(node, "This await needs an asynchronous realm activation.");
            const erasedVoid = context.isBrowserOnlyExpression(node.expression) &&
                ((context.checker.getAwaitedType(context.checker.getTypeAtLocation(node.expression))?.flags ?? 0) & ts.TypeFlags.Void) !== 0;
            const awaited = this.asPromise(erasedVoid ? { kind: "void", cpp: "" } : context.compileValue(node.expression), node);
            const temporary = context.allocateTemporaryCppName("await_result");
            context.emit(`[[maybe_unused]] auto ${temporary} = co_await ${awaited.cpp};`);
            const binding = context.registerNativeBinding(temporary);
            return { ...this.resultAt(awaited.promiseResult!, temporary), nativeCaptures: [binding] };
        }
        if (!ts.isCallExpression(node)) return undefined;
        const callee = context.unwrap(node.expression);
        if (ts.isPropertyAccessExpression(callee) && browserGlobalNamed(context, callee.expression)?.text === "Promise" && callee.name.text === "resolve") {
            if (node.arguments.length > 1) return context.fail(node, "Promise.resolve accepts at most one value.");
            return this.asPromise(node.arguments[0] ? context.compileValue(node.arguments[0]) : { kind: "void", cpp: "" }, node);
        }
        if (ts.isPropertyAccessExpression(callee) && ["then", "catch"].includes(callee.name.text) && this.isPromiseType(callee.expression)) {
            if (node.arguments.length !== 1) return context.fail(node, "This promise reaction requires one callback.");
            const promise = this.asPromise(context.compileValue(callee.expression), node);
            const callback = context.unwrap(argumentAt(node, 0));
            if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback) && !ts.isIdentifier(callback)) {
                return context.fail(callback, "Promise reactions require a compiled function value.");
            }
            const name = context.allocateTemporaryCppName("promise_argument");
            const rejection = callee.name.text === "catch";
            const parameterType = rejection ? "std::exception_ptr" : `const ${promise.promiseType}&`;
            let result: Value = { kind: "void", cpp: "" };
            const compiled = context.withOwnedCallbackBody(() => context.captureManagedClosureLines(() => {
                context.registerNativeBinding(name);
                const input: Value = rejection ? { kind: "string", cpp: `bbl::js::promise_error_string(${name})` }
                    : this.resultAt(promise.promiseResult!, name);
                result = context.compileCallbackWithValues(callback, [input], node);
                if (result.kind === "void") { if (result.cpp) context.emit(`${result.cpp};`); }
                else context.emit(`return ${result.cpp};`);
            }));
            if (rejection && promise.promiseResult!.kind !== "void" && result.kind === "void") {
                return context.fail(callback, "A value promise's recovery must preserve its admitted result type.");
            }
            const reaction = renderClosure(compiled, `[[maybe_unused]] ${parameterType} ${name}`);
            const output = rejection ? promise.promiseResult! : result.kind === "promise" ? result.promiseResult! : result;
            const cppType = rejection ? promise.promiseType! : result.kind === "promise" ? result.promiseType! : this.cppType(output, node);
            return { kind: "promise", cpp: `${promise.cpp}.${rejection ? "catch_error" : "then"}(${reaction})`, promiseResult: output, promiseType: cppType };
        }
        if (!ts.isIdentifier(callee)) return undefined;
        const declaration = tryResolveFunctionDeclaration(context.checker, callee);
        if (!declaration || !ts.getModifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return undefined;
        if (context.isBrowserOnlyLocalCall(node)) return undefined;
        const values = node.arguments.map(argument => {
            const value = context.compileValue(argument);
            if (!value.cpp || value.kind === "engine") return value;
            const temporary = context.allocateTemporaryCppName("async_argument");
            context.emit(`auto ${temporary} = ${value.cpp};`);
            const binding = context.registerNativeBinding(temporary);
            return { ...this.resultAt(value, temporary), nativeCaptures: [binding] };
        });
        let result: Value = { kind: "void", cpp: "" };
        this.depth++;
        let compiled: CapturedClosure;
        try {
            compiled = context.withOwnedCallbackBody(() => context.captureManagedClosureLines(() => {
                result = context.compileCallbackWithValues(callee, values, node);
                if (result.kind === "void" && result.cpp) context.emit(`${result.cpp};`);
                context.emit(`co_return ${result.kind === "void" ? "bbl::js::PromiseVoid{}" : result.ownedEngineCpp ?? result.cpp};`);
            }));
        } finally { this.depth--; }
        const output = result.kind === "promise" ? result.promiseResult! : result;
        const cppType = result.kind === "promise" ? result.promiseType! : this.cppType(output, node);
        // The coroutine takes its environment by value; a temporary closure's
        // this pointer or a borrowed environment must never enter its frame.
        const cpp = `([]([[maybe_unused]] auto ${compiled.environment}) -> bbl::js::Promise<${cppType}> {\n${compiled.lines.join("\n")}\n}(${compiled.initializer}))`;
        return { kind: "promise", cpp, promiseResult: output, promiseType: cppType };
    }

    private isPromiseType(expression: ts.Expression): boolean {
        return this.context.checker.getTypeAtLocation(expression).getSymbol()?.name === "Promise";
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
