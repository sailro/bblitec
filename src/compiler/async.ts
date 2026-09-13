import type { LoweringServices } from "./lowering-services.js";
import ts from "typescript";
import { renderClosure, renderCoroutineInvocation, type CapturedClosure } from "./closure-captures.js";
import { browserGlobalNamed } from "./browser-erasure.js";
import { tryResolveFunctionDeclaration, type SupportedFunction } from "./user-functions.js";
import { unwrapExpression, argumentAt } from "./syntax.js";
import type { Value } from "./types.js";
import { someAnalysisNode } from "./analysis-walk.js";
import type { DataType } from "./data-types.js";
import { errorValue } from "./error-values.js";

interface AsyncContext
    extends Pick<LoweringServices,
        | "checker"
        | "cppString"
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
    private terminalThrow: {node: ts.Statement; type: string} | undefined;
    constructor(private readonly context: AsyncContext) {}

    withActivation<T>(work: () => T): T {
        this.depth++;
        try { return work(); } finally { this.depth--; }
    }

    terminalThrowType(node: ts.Node | undefined): string | undefined {
        return node !== undefined && node === this.terminalThrow?.node ? this.terminalThrow.type : undefined;
    }

    compileReturn(expression: ts.Expression, type: DataType | undefined): string {
        const context = this.context;
        const value = context.compileValue(expression);
        if (value.kind === "promise") {
            const expected = type ? context.dataTypes.cppType(type) : "bbl::js::PromiseVoid";
            if (value.promiseType === expected) return value.cpp;
            const name = context.allocateTemporaryCppName("adopted_result");
            const conversion = context.captureManagedClosureLines(() => {
                context.registerNativeBinding(name);
                const result = type ? context.dataLowerer.compileKnownValueForSink(this.resultAt(value.promiseResult!,name), type, expression)
                    : "bbl::js::PromiseVoid{}";
                context.emit(`return ${result};`);
            });
            return `bbl::js::adopt_promise(${value.cpp}, ${renderClosure(conversion, `[[maybe_unused]] const ${value.promiseType}& ${name}`, expected)})`;
        }
        if (!type) {
            context.emitDiscardedValue(value);
            return "bbl::js::PromiseVoid{}";
        }
        return context.dataLowerer.compileKnownValueForSink(value, type, expression);
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
            for (let parent: ts.Node | undefined = node.parent; parent && !ts.isFunctionLike(parent); parent = parent.parent) {
                if (ts.isCatchClause(parent)) return context.fail(node, "Await in catch requires suspended exception handling.");
            }
            const erasedVoid = context.isBrowserOnlyExpression(node.expression) &&
                ((context.checker.getAwaitedType(context.checker.getTypeAtLocation(node.expression))?.flags ?? 0) & ts.TypeFlags.Void) !== 0;
            const awaited = this.asPromise(erasedVoid ? { kind: "void", cpp: "" } : context.compileValue(node.expression), node);
            const temporary = context.allocateTemporaryCppName("await_result");
            context.emit({ kind: "declaration", type: "auto", name: temporary, initializer: `co_await ${awaited.cpp}`, attributes: "[[maybe_unused]] " });
            const binding = context.registerNativeBinding(temporary);
            return { ...this.resultAt(awaited.promiseResult!, temporary), nativeCaptures: [binding] };
        }
        if (ts.isNewExpression(node) && browserGlobalNamed(context, node.expression)?.text === "Promise") return this.compileConstructor(node);
        if (!ts.isCallExpression(node)) return undefined;
        const callee = context.unwrap(node.expression);
        if (ts.isPropertyAccessExpression(callee) && browserGlobalNamed(context, callee.expression)?.text === "Promise" && callee.name.text === "resolve") {
            if (node.arguments.length > 1) return context.fail(node, "Promise.resolve accepts at most one value.");
            return this.asPromise(node.arguments[0] ? context.compileValue(node.arguments[0]) : { kind: "void", cpp: "" }, node);
        }
        if (ts.isPropertyAccessExpression(callee) && browserGlobalNamed(context, callee.expression)?.text === "Promise" && callee.name.text === "all") {
            return this.compileAll(node);
        }
        if (ts.isPropertyAccessExpression(callee) && browserGlobalNamed(context, callee.expression)?.text === "Promise" && callee.name.text === "race") return this.compileRace(node);
        if (this.isPromiseMethod(callee)) {
            const rejection = callee.name.text === "catch";
            const cleanup = callee.name.text === "finally";
            if (cleanup && node.arguments.length > 1) return context.fail(node, "Promise.finally accepts at most one callback.");
            if (!cleanup && (node.arguments.length < 1 || node.arguments.length > (rejection ? 1 : 2))) {
                return context.fail(node, rejection ? "Promise.catch requires one callback." : "Promise.then requires one or two callbacks.");
            }
            const receiver = this.asPromise(context.compileValue(callee.expression), node);
            const name = context.allocateTemporaryCppName("promise_receiver");
            context.emit({kind:"declaration", type:"auto", name, initializer:receiver.cpp});
            const promise = {...receiver, cpp:name, nativeCaptures:[context.registerNativeBinding(name)]};
            if (cleanup) {
                const callback = node.arguments[0];
                if (!callback) {
                    return {...promise, cpp:`${promise.cpp}.finally()`};
                }
                let evaluated: Value | undefined;
                if (context.checker.getNonNullableType(context.checker.getTypeAtLocation(callback)).getCallSignatures().length === 0) {
                    evaluated = context.compileValue(callback);
                    if (evaluated.kind !== "callback" && evaluated.dataType?.kind !== "function") {
                        context.emitDiscardedValue(evaluated);
                        return {...promise, cpp:`${promise.cpp}.finally()`};
                    }
                }
                const reaction = this.compileReaction(callback, promise, "finally", node, evaluated);
                const cpp = `${promise.cpp}.finally(${reaction.cpp})`;
                return {...promise, cpp:reaction.present ? `(${reaction.present} ? ${cpp} : ${promise.cpp}.finally())` : cpp};
            }
            const first = this.compileReaction(argumentAt(node, 0), promise, rejection ? "catch" : "then", node);
            if (rejection && first.cppType !== promise.promiseType) {
                return context.fail(argumentAt(node, 0), "A value promise's recovery must preserve its admitted result type.");
            }
            let output = rejection ? promise.promiseResult! : first.output;
            const cppType = rejection ? promise.promiseType! : first.cppType;
            const reactions = [first.cpp];
            if (node.arguments.length === 2) {
                const second = this.compileReaction(argumentAt(node, 1), promise, "catch", node);
                if (second.cppType !== cppType) return context.fail(argumentAt(node, 1), "Promise.then callbacks must settle to the same admitted result type.");
                reactions.push(second.cpp);
                // Either branch can settle the result; neither branch's scalar
                // constant is a fact about the resulting promise.
                const {staticString, staticNumber, staticBoolean, ...runtimeOutput} = output;
                output = runtimeOutput;
            }
            if (rejection) output = this.withoutConstants(output);
            return { kind: "promise", cpp: `${promise.cpp}.${rejection ? "catch_error" : "then"}(${reactions.join(", ")})`, promiseResult: output, promiseType: cppType };
        }
        const declaration = ts.isIdentifier(callee) ? tryResolveFunctionDeclaration(context.checker, callee)
            : ts.isArrowFunction(callee) || ts.isFunctionExpression(callee) ? callee : undefined;
        if (!declaration || !ts.getModifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return undefined;
        if (context.isBrowserOnlyLocalCall(node)) return undefined;
        const values = node.arguments.map(argument => this.pinArgument(context.compileValue(argument)));
        return this.activate(ts.isIdentifier(callee) ? callee : declaration, declaration, values, node);
    }

    compileCall(declaration: SupportedFunction, arguments_: readonly Value[], node: ts.Node): Value | undefined {
        if (!ts.getModifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return undefined;
        const values = arguments_.map(value => this.pinArgument(value));
        return this.activate(declaration, declaration, values, node);
    }

    private pinArgument(value: Value): Value {
        const context = this.context;
        if (!value.cpp || value.kind === "engine") return value;
        const temporary = context.allocateTemporaryCppName("async_argument");
        context.emit({ kind: "declaration", type: "auto", name: temporary, initializer: value.cpp, attributes: "[[maybe_unused]] " });
        const binding = context.registerNativeBinding(temporary);
        return { ...this.resultAt(value, temporary), nativeCaptures: [binding] };
    }

    private activate(callback: ts.Identifier | SupportedFunction, declaration: SupportedFunction, values: readonly Value[], node: ts.Node): Value {
        const context = this.context;
        const result: { value: Value } = { value: { kind: "void", cpp: "" } };
        const body = declaration.body;
        const finalStatement = body && ts.isBlock(body) ? body.statements.at(-1) : undefined;
        const rejectsOnly = finalStatement && ts.isThrowStatement(finalStatement) &&
            !someAnalysisNode(body!, ts.isReturnStatement, {functions:"skip"});
        const declaredOutput = (): Value => {
            const signature = context.checker.getSignatureFromDeclaration(declaration);
            const type = signature ? context.dataTypes.fromTsType(context.checker.getReturnTypeOfSignature(signature), declaration) : undefined;
            return type?.kind === "promise" && type.result
                ? context.dataLowerer.leafValue("", type.result) : {kind:"void", cpp:""};
        };
        const rejectedOutput = rejectsOnly ? declaredOutput() : undefined;
        const previousThrow = this.terminalThrow;
        this.terminalThrow = rejectsOnly ? {node:finalStatement, type:this.cppType(rejectedOutput!, node)} : undefined;
        let compiled: CapturedClosure;
        try {
            compiled = this.withActivation(() =>
                context.withOwnedCallbackBody(() => context.captureManagedClosureLines(() => {
                    const callable = ts.isFunctionDeclaration(callback) ? callback.name ?? context.fail(callback, "Async function requires a name.") : callback;
                    result.value = context.compileCallbackWithValues(callable, values, node, false, {coroutine:true});
                    const signature = context.checker.getSignatureFromDeclaration(declaration);
                    if (signature) result.value = this.normalizeUndefined(result.value, context.checker.getReturnTypeOfSignature(signature));
                    if (result.value.kind === "void" && result.value.cpp) context.emit(`${result.value.cpp};`);
                    if (!rejectsOnly && !result.value.abruptCompletion) context.emit(`co_return ${result.value.kind === "void" ? "bbl::js::PromiseVoid{}" : this.resultCpp(result.value, node)};`);
                })));
        } finally {
            this.terminalThrow = previousThrow;
        }
        const output = rejectedOutput ?? (result.value.abruptCompletion ? declaredOutput()
            : result.value.kind === "promise" ? result.value.promiseResult! : result.value);
        const cppType = result.value.kind === "promise" ? result.value.promiseType! : this.cppType(output, node);
        if (result.value.abruptCompletion && !rejectsOnly) {
            // Specialization can leave only a throwing path, with no coroutine
            // keyword. Rethrow at coroutine completion without inventing a
            // successful value or introducing another suspension boundary.
            compiled.lines = ["try {", ...compiled.lines,
                `} catch (...) { co_return []() -> ${cppType} { throw; }(); }`];
        }
        // The coroutine takes its environment by value; a temporary closure's
        // this pointer or a borrowed environment must never enter its frame.
        // Terminal throws share the native coroutine completion path, including
        // when earlier statements suspend. No unreachable epilogue is emitted.
        const cpp = renderCoroutineInvocation(compiled, `bbl::js::Promise<${cppType}>`);
        return { kind: "promise", cpp, promiseResult: output, promiseType: cppType };
    }

    private compileConstructor(node: ts.NewExpression): Value {
        const context = this.context;
        if (node.arguments?.length !== 1) context.fail(node, "Promise construction requires one executor.");
        const callback = context.unwrap(argumentAt(node, 0));
        if (!ts.isIdentifier(callback) && !ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
            return context.fail(callback, "Promise executor requires a represented local function.");
        const declaration = ts.isIdentifier(callback) ? tryResolveFunctionDeclaration(context.checker, callback) : callback;
        const asynchronous = declaration && ts.getModifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
        const type = context.dataLowerer.dataTypeAt(node);
        if (type?.kind !== "promise") return context.fail(node, "Promise construction requires a concrete owned result type.");
        const output = type.result ? context.dataLowerer.leafValue("", context.dataTypes.markStoredObjectReferences(type.result)) : {kind:"void", cpp:""} satisfies Value;
        const cppType = this.cppType(output, node);
        const name = context.allocateTemporaryCppName("constructed_promise");
        context.emit({kind:"declaration", type:`bbl::js::Promise<${cppType}>`, name, initializer:"", initialization:"default"});
        const binding = context.registerNativeBinding(name);
        const resolver = (nativePromiseSettlement: "resolve" | "reject"): Value => ({kind:"callback", cpp:name,
            nativePromiseSettlement:{mode:nativePromiseSettlement, type:cppType, result:output}, nativeCaptures:[binding], truthinessCpp:"true", callbackEvaluationIdentity:{}});
        // The executor runs synchronously; only resolving functions and the
        // callbacks it registers escape. Its writes address the calling scope.
        const compiled = context.captureManagedClosureLines(() => {
            const values = [resolver("resolve"), resolver("reject")];
            context.emitDiscardedValue(asynchronous ? this.activate(callback, declaration!, values, node)
                : context.compileCallbackWithValues(callback, values, node));
        }, true);
        context.emit(`try { (${renderClosure(compiled, "")})(); }`);
        context.emit(`catch (const bbl::pal::WorkerTerminated&) { throw; }`);
        context.emit(`catch (...) { ${name}.reject(std::current_exception()); }`);
        return {kind:"promise", cpp:name, promiseResult:output, promiseType:cppType, nativeCaptures:[binding]};
    }

    private compileRace(call: ts.CallExpression): Value {
        const context = this.context;
        if (call.arguments.length !== 1) context.fail(call, "Promise.race requires one represented iterable.");
        const argument = unwrapExpression(argumentAt(call, 0));
        const pin = (value: Value, source: ts.Node = call): Value => {
            const promise = this.asPromise(value, source);
            const name = context.allocateTemporaryCppName("race_input");
            context.emit({kind:"declaration", type:"auto", name, initializer:promise.cpp});
            return {...promise, cpp:name, nativeCaptures:[context.registerNativeBinding(name)]};
        };
        let promises: Value[];
        if (ts.isArrayLiteralExpression(argument)) promises = argument.elements.map(element => {
            if (ts.isSpreadElement(element)) return context.fail(element, "Promise.race literal spreads require a represented array first.");
            return pin(ts.isOmittedExpression(element) ? {kind:"void", cpp:""} : context.compileValue(element), element);
        });
        else {
            const value = context.compileValue(argument);
            if (value.kind === "tuple") promises = (value.tupleElements ?? []).map(value => pin(value));
            else {
                if (value.dataType?.kind !== "vector") return context.fail(argument, "Promise.race requires an array or a represented tuple.");
                const element = value.dataType.element;
                return context.dataLowerer.leafValue(`bbl::js::promise_race(${value.cpp})`,
                    element.kind === "promise" ? element : {kind:"promise", result:element});
            }
        }
        const output = this.withoutConstants(promises[0]?.promiseResult ?? {kind:"void", cpp:""});
        const cppType = this.cppType(output, call);
        if (promises.some(promise => promise.promiseType !== cppType)) return context.fail(call, "Promise.race inputs require a common represented settlement type.");
        return {kind:"promise", cpp:`bbl::js::promise_race_tuple<${cppType}>(std::tuple{${promises.map(value => value.cpp).join(", ")}})`,
            promiseType:cppType, promiseResult:output, nativeCaptures:promises.flatMap(value => value.nativeCaptures ?? [])};
    }

    private compileAll(call: ts.CallExpression): Value {
        const context = this.context;
        if (call.arguments.length !== 1) context.fail(call, "Promise.all requires one represented iterable.");
        const argument = unwrapExpression(argumentAt(call, 0));
        const pin = (value: Value): Value => {
            const promise = this.asPromise(value, call);
            const name = context.allocateTemporaryCppName("all_input");
            context.emit({kind:"declaration", type:"auto", name, initializer:promise.cpp});
            return {...promise, cpp:name, nativeCaptures:[context.registerNativeBinding(name)]};
        };
        let promises: Value[];
        if (ts.isArrayLiteralExpression(argument)) {
            promises = argument.elements.map(element => {
                if (ts.isSpreadElement(element)) context.fail(element, "Promise.all literal spreads require a represented array first.");
                return pin(ts.isOmittedExpression(element) ? {kind:"void", cpp:""} : context.compileValue(element));
            });
        } else {
            const value = context.compileValue(argument);
            if (value.kind === "tuple") promises = (value.tupleElements ?? []).map(pin);
            else {
                const type = value.dataType;
                if (type?.kind !== "vector") return context.fail(argument, "Promise.all requires an array or a represented tuple.");
                if (type.element.kind !== "promise") return context.fail(argument, "Promise.all stored arrays currently require promise elements.");
                const element = type.element.result;
                if (!element) return context.fail(argument, "Promise.all stored void arrays need an undefined element representation.");
                return context.dataLowerer.leafValue(`bbl::js::promise_all(${value.cpp})`,
                    {kind:"promise", result:{kind:"vector", element}});
            }
        }
        const result: Value = {kind:"tuple", cpp:"", tupleElements:promises.map(value => value.promiseResult!)};
        return {kind:"promise", cpp:`bbl::js::promise_all_tuple(std::tuple{${promises.map(value => value.cpp).join(", ")}})`,
            promiseType:this.cppType(result, call), promiseResult:result,
            nativeCaptures:promises.flatMap(value => value.nativeCaptures ?? [])};
    }

    private compileReaction(callback: ts.Expression, promise: Value, reaction: "then" | "catch" | "finally", node: ts.CallExpression, evaluated?: Value):
        {cpp: string; output: Value; cppType: string; present?: string} {
        const context = this.context;
        const rejection = reaction === "catch";
        const cleanup = reaction === "finally";
        callback = context.unwrap(callback);
        const inline = ts.isArrowFunction(callback) || ts.isFunctionExpression(callback) || ts.isIdentifier(callback) ? callback : undefined;
        const declaration = inline && (ts.isIdentifier(inline) ? tryResolveFunctionDeclaration(context.checker, inline) : inline);
        const asynchronous = declaration && ts.getModifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
        const signature = context.checker.getTypeAtLocation(callback).getCallSignatures()[0];
        const neverReturns = rejection && signature && (context.checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Never) !== 0;
        let stored: Value | undefined;
        if (evaluated || !inline || (ts.isIdentifier(inline) && context.lookupOptional(inline)?.dataType?.kind === "function")) {
            const value = evaluated ?? context.compileValue(callback);
            const type = value.dataType ?? context.dataLowerer.dataTypeAt(callback);
            if (type?.kind !== "function") return context.fail(callback, "Promise reactions require a compiled function value.");
            const name = context.allocateTemporaryCppName("promise_callback");
            const cpp = context.dataLowerer.compileKnownValueForSink(value, type, callback);
            context.emit({kind:"declaration", type:"auto", name, initializer:cpp});
            stored = {...context.dataLowerer.leafValue(name,type), nativeCaptures:[context.registerNativeBinding(name)]};
        }
        const name = context.allocateTemporaryCppName("promise_argument");
        const parameterType = rejection ? "std::exception_ptr" : `const ${promise.promiseType}&`;
        const result: {value: Value} = {value:{kind:"void", cpp:""}};
        const compiled = context.withOwnedCallbackBody(() => context.captureManagedClosureLines(() => {
            const inputs: Value[] = [];
            if (!cleanup) {
                const binding = context.registerNativeBinding(name);
                inputs.push(rejection ? errorValue({kind:"data", dataType:{kind:"string"}, cpp:`bbl::js::promise_error_message(${name})`, nativeCaptures:[binding]}, "Error", text => context.cppString(text))
                    : {...this.resultAt(promise.promiseResult!, name), nativeCaptures:[binding]});
            }
            result.value = stored ? context.dataLowerer.compileFunctionValueCall(stored, inputs, node)
                : asynchronous ? this.activate(inline!, declaration!, inputs, node)
                : context.compileCallbackWithValues(inline!, inputs, node);
            if (signature) result.value = this.normalizeUndefined(result.value, context.checker.getReturnTypeOfSignature(signature));
            if (cleanup && result.value.kind !== "promise") {
                this.refuseThenable(result.value, callback);
                context.emitDiscardedValue(result.value);
                result.value = {kind:"void", cpp:""};
            }
            const expected = rejection ? promise.promiseResult?.dataType : undefined;
            if (result.value.kind === "tuple" && expected && ["vector", "tuple", "product"].includes(expected.kind)) {
                result.value = context.dataLowerer.leafValue(context.dataLowerer.compileKnownValueForSink(result.value, expected, callback), expected);
            }
            if (result.value.kind === "void") { if (result.value.cpp) context.emit(`${result.value.cpp};`); }
            else context.emit(`return ${this.resultCpp(result.value, node)};`);
        }));
        const output = neverReturns ? promise.promiseResult! : result.value.kind === "promise" ? result.value.promiseResult! : result.value;
        const cppType = neverReturns ? promise.promiseType! : result.value.kind === "promise" ? result.value.promiseType! : this.cppType(output, node);
        return {cpp:renderClosure(compiled, cleanup ? "" : `[[maybe_unused]] ${parameterType} ${name}`, neverReturns ? cppType : undefined), output, cppType,
            ...(cleanup && stored ? {present:`static_cast<bool>(${stored.cpp})`} : {})};
    }

    private isPromiseType(expression: ts.Expression): boolean {
        return this.context.checker.getTypeAtLocation(expression).getSymbol()?.name === "Promise";
    }
    private isPromiseMethod(expression: ts.Expression): expression is ts.PropertyAccessExpression {
        return ts.isPropertyAccessExpression(expression) && ["then", "catch", "finally"].includes(expression.name.text) &&
            this.isPromiseType(expression.expression);
    }
    private cppType(value: Value, node: ts.Node): string {
        if (value.kind === "void") return "bbl::js::PromiseVoid";
        if (value.kind === "tuple") return `std::tuple<${(value.tupleElements ?? []).map(element => this.cppType(element, node)).join(", ")}>`;
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
        if (value.kind === "tuple") return {...value, cpp, tupleElements:(value.tupleElements ?? []).map((element, index) =>
            this.resultAt(element, `std::get<${index}>(${cpp})`)), nativeCaptures:[]};
        if (value.kind === "engine") return { ...value, cpp: `(*${cpp})`, engineCpp: `(*${cpp})`, ownedEngineCpp: cpp,
            nativeCaptures: [], nativeCompanionCaptures: { engineCpp: [this.context.registerNativeBinding(cpp)] } };
        if (value.kind === "number" || value.kind === "boolean" || value.kind === "string") return {
            kind: value.kind, cpp, ...(value.dataType ? { dataType: value.dataType } : {}),
            ...(value.staticString !== undefined ? { staticString: value.staticString } : {}),
            ...(value.staticNumber !== undefined ? { staticNumber: value.staticNumber } : {}),
        };
        return { ...value, cpp, nativeCaptures: [] };
    }
    private withoutConstants(value: Value): Value {
        const {staticString, staticNumber, staticBoolean, staticElements, staticStrings, ...runtime} = value;
        return runtime.kind === "tuple" ? {...runtime, tupleElements:(runtime.tupleElements ?? []).map(element => this.withoutConstants(element))} : runtime;
    }
    private normalizeUndefined(value: Value, type: ts.Type): Value {
        const result = this.context.checker.getAwaitedType(type) ?? type;
        return value.kind === "json-null" && (result.flags & ts.TypeFlags.Undefined) !== 0
            ? {kind:"void", cpp:value.cpp === "std::nullopt" ? "" : value.cpp} : value;
    }
    private asPromise(value: Value, node: ts.Node): Value {
        if (value.kind === "promise") return value;
        value = this.normalizeUndefined(value, this.context.checker.getTypeAtLocation(node));
        this.refuseThenable(value, node);
        if (value.kind === "record") {
            const declared = this.context.dataLowerer.dataTypeAt(node);
            const result = declared?.kind === "promise" ? declared.result : declared;
            if (result?.kind === "struct") {
                const owned = this.context.dataTypes.markStoredObjectReferences(result);
                value = this.context.dataLowerer.leafValue(this.context.dataLowerer.compileKnownValueForSink(value, owned, node), owned);
            }
        }
        const type = this.cppType(value, node);
        const cpp = value.kind === "void"
            ? value.cpp ? `(${value.cpp}, bbl::js::PromiseVoid{})` : "bbl::js::PromiseVoid{}"
            : this.resultCpp(value, node);
        return { kind: "promise", cpp: `bbl::js::Promise<${type}>::resolved(${cpp})`, promiseResult: value, promiseType: type };
    }
    private refuseThenable(value: Value, node: ts.Node): void {
        const property = value.recordProperties?.then;
        const field = value.dataType?.kind === "struct"
            ? this.context.dataTypes.structFields(value.dataType.name, node).find(field => field.sourceName === "then") : undefined;
        if (value.recordMethods?.then || value.recordGetters?.then || property?.kind === "callback" ||
            property?.dataType?.kind === "function" || field?.type.kind === "function")
            this.context.fail(node, "Custom thenable assimilation requires an owned promise resolution protocol.");
    }
    private resultCpp(value: Value, node: ts.Node): string {
        if (value.kind === "string" && (!value.dataType || value.dataType.kind === "string")) return `std::string{${value.cpp}}`;
        return value.kind === "tuple" && !value.cpp
            ? `${this.cppType(value, node)}{${(value.tupleElements ?? []).map(element => this.resultCpp(element, node)).join(", ")}}`
            : value.ownedEngineCpp ?? value.cpp;
    }
}
