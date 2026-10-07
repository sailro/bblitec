import { journaled } from "./emission-transaction.js";
import { staticScalarValue } from "./number-intrinsics.js";
import type {
    LoweringServices,
    NativeReturnValueCompiler,
} from "./lowering-services.js";
import ts from "typescript";
import { provenUndefinedValue } from "./undefined-values.js";
import {
    renderClosure,
    type CapturedClosure,
    type NativeCaptureBinding,
} from "./closure-captures.js";
import {
    tryResolveFunctionDeclaration,
    type SupportedFunction,
} from "./user-functions.js";
import { unwrapExpression, argumentAt } from "./syntax.js";
import { declaredSymbol } from "./symbols.js";
import {
    optionalPresentCpp,
    presenceFlagCpp,
    valueForKind,
    type Value,
} from "./types.js";
import { findAnalysisNode, someAnalysisNode } from "./analysis-walk.js";
import {
    dataTypesEqual,
    propertyIsReadOnly,
    type DataType,
    type DataStructField,
} from "./data-types.js";
import { errorValue } from "./error-values.js";
import { isCustomThenable, isPromiseResultUsed } from "./promises.js";
import { isHandleKind } from "./data-types/handles.js";
import { ApplicationRealmRequired } from "./worker-modules.js";

interface AsyncContext extends Pick<
    LoweringServices,
    | "checker"
    | "cppString"
    | "dataLowerer"
    | "dataTypes"
    | "compileValue"
    | "compileCallbackWithValues"
    | "captureManagedClosureLines"
    | "withOwnedCallbackBody"
    | "asyncActivations"
    | "allocateTemporaryCppName"
    | "registerNativeBinding"
    | "registerNativeBindingType"
    | "registerNativeTemporary"
    | "nativeEmission"
    | "emit"
    | "emitDiscardedValue"
    | "unwrap"
    | "bindings"
    | "libraryGlobal"
    | "browserErasure"
    | "options"
    | "sharedClosures"
    | "useNativeValue"
    | "fail"
> {}

/**
 * A reached constructed promise can leave a synchronous activation pending.
 * Every catch and finally the program lowers must then pass that unwinding
 * on, including ones lowered before the promise was reached, so the program
 * replays with `pendingActivations`.
 */
export class PendingActivationsRequired extends Error {
    constructor() {
        super("A constructed promise requires pending-activation unwinding.");
    }
}

/** Library schedulers whose callbacks never run before the call returns. */
const DEFERRED_SCHEDULERS: ReadonlySet<string> = new Set([
    "queueMicrotask",
    "requestAnimationFrame",
    "setInterval",
    "setTimeout",
]);

/** Async activation and reaction lowering share the compiler's managed captures. */
export class AsyncLowerer {
    @journaled private accessor depth = 0;
    @journaled private accessor terminalThrow:
        { node: ts.Statement; type: string } | undefined;
    constructor(private readonly context: AsyncContext) {}

    withActivation<T>(work: () => T): T {
        this.depth++;
        try {
            return work();
        } finally {
            this.depth--;
        }
    }

    terminalThrowType(node: ts.Node | undefined): string | undefined {
        return node !== undefined && node === this.terminalThrow?.node
            ? this.terminalThrow.type
            : undefined;
    }

    compileReturn(
        expression: ts.Expression,
        type: DataType | undefined,
        compileResult?: NativeReturnValueCompiler,
    ): string {
        const context = this.context;
        const convert =
            compileResult ??
            ((value, target, node) =>
                context.dataLowerer.compileKnownValueForSink(
                    value,
                    target,
                    node,
                ));
        const raw = context.compileValue(expression);
        const value = this.adoptPromiseUnion(raw, expression) ?? raw;
        if (value.kind === "promise") {
            const expected = type
                ? context.dataTypes.cppType(type)
                : "bbl::js::PromiseVoid";
            if (value.promiseType === expected) return value.cpp;
            const name = context.allocateTemporaryCppName("adopted_result");
            const conversion = context.captureManagedClosureLines(() => {
                const binding = context.registerNativeBinding(name);
                const result = type
                    ? convert(
                          this.resultAt(value.promiseResult!, name, binding),
                          type,
                          expression,
                      )
                    : "bbl::js::PromiseVoid{}";
                context.emit({
                    kind: "control",
                    code: `return ${result};`,
                    transfer: "return",
                });
            });
            return `bbl::js::adopt_promise(${value.cpp}, ${renderClosure(conversion, `[[maybe_unused]] const ${value.promiseType}& ${name}`, expected)})`;
        }
        if (!type) {
            context.emitDiscardedValue(value);
            return "bbl::js::PromiseVoid{}";
        }
        return convert(value, type, expression);
    }

    compile(expression: ts.Expression): Value | undefined {
        const context = this.context;
        // unwrap intentionally removes awaits for the existing immediate path;
        // this realm path must see the suspension before that happens.
        const node = unwrapExpression(expression);
        if (ts.isTypeOfExpression(node)) {
            const property = context.unwrap(node.expression);
            if (this.isPromiseMethod(property)) {
                const receiver = context.dataLowerer.narrowOptional(
                    context.compileValue(property.expression),
                    property.expression,
                );
                if (receiver.kind !== "promise")
                    return context.fail(
                        property,
                        "Promise method inspection requires a present native promise.",
                    );
                context.emitDiscardedValue(receiver);
                return {
                    kind: "string",
                    cpp: '"function"',
                    staticString: "function",
                };
            }
        }
        if (ts.isAwaitExpression(node)) {
            if (!this.depth)
                return context.fail(
                    node,
                    "This await needs an asynchronous realm activation.",
                );
            const erasedVoid =
                context.browserErasure.isBrowserOnlyExpression(
                    node.expression,
                ) &&
                ((context.checker.getAwaitedType(
                    context.checker.getTypeAtLocation(node.expression),
                )?.flags ?? 0) &
                    ts.TypeFlags.Void) !==
                    0;
            const awaited = this.asPromise(
                erasedVoid
                    ? { kind: "void", cpp: "" }
                    : context.compileValue(node.expression),
                node,
            );
            const temporary = context.allocateTemporaryCppName("await_result");
            context.emit({
                kind: "declaration",
                type: "auto",
                name: temporary,
                initializer: `co_await ${awaited.cpp}`,
                attributes: "[[maybe_unused]] ",
            });
            const binding = context.registerNativeBinding(
                temporary,
                false,
                false,
                awaited.promiseType,
            );
            const settled = awaited.promiseResult!;
            if (settled.kind === "void")
                return {
                    kind: "json-null",
                    cpp: "std::nullopt",
                    ...(!provenUndefinedValue(context, node)
                        ? { erasedVoidCompletion: true as const }
                        : {}),
                };
            // The settled data belongs to the expression awaiting it, so a
            // declaration it initializes takes it rather than copying it.
            if (settled.dataType !== undefined || settled.kind === "string")
                context.registerNativeTemporary(
                    temporary,
                    settled.dataType ?? { kind: "string" },
                );
            return this.resultAt(settled, temporary, binding);
        }
        if (
            ts.isNewExpression(node) &&
            context.libraryGlobal(node.expression) === "Promise"
        )
            return this.compileConstructor(node);
        if (!ts.isCallExpression(node)) return undefined;
        const callee = context.unwrap(node.expression);
        if (
            ts.isPropertyAccessExpression(callee) &&
            context.libraryGlobal(callee.expression) === "Promise" &&
            callee.name.text === "resolve"
        ) {
            if (node.arguments.length > 1)
                return context.fail(
                    node,
                    "Promise.resolve accepts at most one value.",
                );
            return this.asPromise(this.resolvedValue(node), node);
        }
        if (
            ts.isPropertyAccessExpression(callee) &&
            context.libraryGlobal(callee.expression) === "Promise" &&
            callee.name.text === "reject"
        ) {
            if (node.arguments.length !== 1)
                return context.fail(
                    node,
                    "Promise.reject requires a represented rejection reason.",
                );
            const reason = context.compileValue(argumentAt(node, 0));
            if (reason.dataType?.kind !== "error")
                return context.fail(
                    node,
                    "Promise.reject requires an owned Error reason.",
                );
            const type = context.dataLowerer.dataTypeAt(node);
            if (type?.kind !== "promise")
                return context.fail(
                    node,
                    "Promise.reject requires a concrete owned result type.",
                );
            return {
                ...context.dataLowerer.leafValue(
                    `${context.dataTypes.cppType(type)}::rejected(${reason.cpp})`,
                    type,
                ),
                ...(reason.nativeCaptures
                    ? { nativeCaptures: reason.nativeCaptures }
                    : {}),
            };
        }
        if (
            ts.isPropertyAccessExpression(callee) &&
            context.libraryGlobal(callee.expression) === "Promise" &&
            ["all", "allSettled"].includes(callee.name.text)
        ) {
            return this.compileAll(node, callee.name.text === "allSettled");
        }
        if (
            ts.isPropertyAccessExpression(callee) &&
            context.libraryGlobal(callee.expression) === "Promise" &&
            (callee.name.text === "race" || callee.name.text === "any")
        )
            return this.compileRace(node, callee.name.text);
        if (this.isPromiseMethod(callee)) {
            const rejection = callee.name.text === "catch";
            const cleanup = callee.name.text === "finally";
            if (cleanup && node.arguments.length > 1)
                return context.fail(
                    node,
                    "Promise.finally accepts at most one callback.",
                );
            if (
                !cleanup &&
                (node.arguments.length < 1 ||
                    node.arguments.length > (rejection ? 1 : 2))
            ) {
                return context.fail(
                    node,
                    rejection
                        ? "Promise.catch requires one callback."
                        : "Promise.then requires one or two callbacks.",
                );
            }
            const receiver = this.asPromise(
                context.compileValue(callee.expression),
                node,
            );
            const name = context.allocateTemporaryCppName("promise_receiver");
            context.emit({
                kind: "declaration",
                type: "auto",
                name,
                initializer: receiver.cpp,
            });
            const promise = {
                ...receiver,
                cpp: name,
                nativeCaptures: [context.registerNativeBinding(name)],
            };
            if (cleanup) {
                const callback = node.arguments[0];
                if (!callback) {
                    return { ...promise, cpp: `${promise.cpp}.finally()` };
                }
                let evaluated: Value | undefined;
                if (
                    context.checker
                        .getNonNullableType(
                            context.checker.getTypeAtLocation(callback),
                        )
                        .getCallSignatures().length === 0
                ) {
                    evaluated = context.compileValue(callback);
                    if (
                        evaluated.kind !== "callback" &&
                        evaluated.dataType?.kind !== "function"
                    ) {
                        context.emitDiscardedValue(evaluated);
                        return { ...promise, cpp: `${promise.cpp}.finally()` };
                    }
                }
                const reaction = this.compileReaction(
                    callback,
                    promise,
                    "finally",
                    node,
                    evaluated,
                );
                const cpp = `${promise.cpp}.finally(${reaction.cpp})`;
                return {
                    ...promise,
                    cpp: reaction.present
                        ? `(${reaction.present} ? ${cpp} : ${promise.cpp}.finally())`
                        : cpp,
                };
            }
            const first = this.compileReaction(
                argumentAt(node, 0),
                promise,
                rejection ? "catch" : "then",
                node,
            );
            if (rejection && first.cppType !== promise.promiseType) {
                if (
                    first.output.kind === "void" &&
                    !isPromiseResultUsed(node)
                ) {
                    // Only the reaction is observable when the complete chain is discarded.
                    // Keep its scheduling/adoption while dropping the unused fulfillment value.
                    return {
                        kind: "promise",
                        cpp: `${promise.cpp}.then([](const ${promise.promiseType}&){return bbl::js::PromiseVoid{};}, ${first.cpp})`,
                        promiseResult: { kind: "void", cpp: "" },
                        promiseType: "bbl::js::PromiseVoid",
                    };
                }
                return context.fail(
                    argumentAt(node, 0),
                    "A value promise's recovery must preserve its admitted result type.",
                );
            }
            let output = rejection ? promise.promiseResult! : first.output;
            const cppType = rejection ? promise.promiseType! : first.cppType;
            const reactions = [first.cpp];
            if (node.arguments.length === 2) {
                const second = this.compileReaction(
                    argumentAt(node, 1),
                    promise,
                    "catch",
                    node,
                );
                if (second.cppType !== cppType)
                    return context.fail(
                        argumentAt(node, 1),
                        "Promise.then callbacks must settle to the same admitted result type.",
                    );
                reactions.push(second.cpp);
                // Either branch can settle the result; neither branch's scalar
                // constant is a fact about the resulting promise.
                const {
                    staticString,
                    staticNumber,
                    staticBoolean,
                    ...runtimeOutput
                } = output;
                output = runtimeOutput;
            }
            if (rejection) output = this.withoutConstants(output);
            return {
                kind: "promise",
                cpp: `${promise.cpp}.${rejection ? "catch_error" : "then"}(${reactions.join(", ")})`,
                promiseResult: output,
                promiseType: cppType,
            };
        }
        const declaration = ts.isIdentifier(callee)
            ? tryResolveFunctionDeclaration(context.checker, callee)
            : ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)
              ? callee
              : undefined;
        if (
            !declaration ||
            ("asteriskToken" in declaration && declaration.asteriskToken) ||
            !ts
                .getModifiers(declaration)
                ?.some(
                    (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
                )
        )
            return undefined;
        if (context.browserErasure.isBrowserOnlyLocalCall(node))
            return undefined;
        const values = node.arguments.map((argument, index) =>
            this.pinArgument(
                context.compileValue(argument),
                "async_argument",
                argument,
                declaration.parameters[index],
            ),
        );
        return this.activate(
            ts.isIdentifier(callee) ? callee : declaration,
            declaration,
            values,
            node,
        );
    }

    compileCall(
        declaration: SupportedFunction,
        arguments_: readonly Value[],
        node: ts.Node,
    ): Value | undefined {
        if (
            ("asteriskToken" in declaration && declaration.asteriskToken) ||
            !ts
                .getModifiers(declaration)
                ?.some(
                    (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
                )
        )
            return undefined;
        const values = arguments_.map((value, index) =>
            this.pinArgument(
                value,
                "async_argument",
                node,
                declaration.parameters[index],
            ),
        );
        return this.activate(declaration, declaration, values, node);
    }

    private pinArgument(
        value: Value,
        label: string,
        node: ts.Node,
        parameter?: ts.ParameterDeclaration,
    ): Value {
        const context = this.context;
        // An activation snapshots an argument before the caller can rebind it.
        // Nullable resources must copy their presence along with the handle.
        if (
            isHandleKind(value.kind) ||
            value.kind === "tuple" ||
            value.kind === "json-null" ||
            (value.dataType?.kind === "optional" &&
                value.dataType.inner.kind === "handle")
        )
            value = this.ownResult(
                value,
                node,
                context.checker.getTypeAtLocation(parameter ?? node),
            );
        if (!value.cpp && value.kind !== "tuple") return value;
        if (value.kind === "engine")
            return context.bindings.pinValueToTemporary(value, label);
        // A scalar folded at generation is its constant at the call: the
        // activation takes it as a literal argument unless the callee
        // rebinds that parameter. A shared call's result is scalar data.
        const scalarKind = value.dataType?.kind ?? value.kind;
        const constant =
            parameter &&
            !parameter.dotDotDotToken &&
            ts.isIdentifier(parameter.name) &&
            ["number", "boolean", "string"].includes(scalarKind) &&
            (value.kind === scalarKind || value.kind === "data") &&
            !context.sharedClosures.identifierIsRebound(parameter.name)
                ? staticScalarValue(value, (text) => context.cppString(text))
                : undefined;
        if (constant) return constant;
        const temporary = context.allocateTemporaryCppName(label);
        const type =
            value.kind === "tuple"
                ? this.cppType(value, node)
                : value.dataType
                  ? context.dataTypes.cppType(value.dataType)
                  : value.kind === "number"
                    ? "double"
                    : value.kind === "boolean"
                      ? "bool"
                      : value.kind === "string"
                        ? "std::string"
                        : "auto";
        context.emit({
            kind: "declaration",
            type,
            name: temporary,
            initializer: this.resultCpp(value, node),
            attributes: "[[maybe_unused]] ",
        });
        const binding = context.registerNativeBinding(temporary);
        return this.resultAt(value, temporary, binding);
    }

    private activate(
        callback: ts.Identifier | SupportedFunction,
        declaration: SupportedFunction,
        values: readonly Value[],
        node: ts.Node,
    ): Value {
        const context = this.context;
        const result: { value: Value } = { value: { kind: "void", cpp: "" } };
        const body = declaration.body;
        const finalStatement =
            body && ts.isBlock(body) ? body.statements.at(-1) : undefined;
        const rejectsOnly =
            finalStatement &&
            ts.isThrowStatement(finalStatement) &&
            !someAnalysisNode(body!, ts.isReturnStatement, {
                functions: "skip",
            });
        const declaredOutput: Value = (() => {
            const signature =
                context.checker.getSignatureFromDeclaration(declaration);
            const type = signature
                ? context.dataTypes.fromTsType(
                      context.checker.getReturnTypeOfSignature(signature),
                      declaration,
                  )
                : undefined;
            return type?.kind === "promise" && type.result
                ? context.dataLowerer.leafValue("", type.result)
                : { kind: "void", cpp: "" };
        })();
        const rejectedOutput = rejectsOnly ? declaredOutput : undefined;
        const previousThrow = this.terminalThrow;
        this.terminalThrow = rejectsOnly
            ? {
                  node: finalStatement,
                  type: this.cppType(rejectedOutput!, node),
              }
            : undefined;
        let compiled: CapturedClosure;
        try {
            compiled = context.asyncActivations.withEngineBootstrap(
                declaration,
                () =>
                    this.withActivation(() =>
                        context.asyncActivations.withAsyncInvocation(node, () =>
                            context.captureManagedClosureLines(() => {
                                const callable = ts.isFunctionDeclaration(
                                    callback,
                                )
                                    ? (callback.name ??
                                      context.fail(
                                          callback,
                                          "Async function requires a name.",
                                      ))
                                    : callback;
                                result.value =
                                    context.compileCallbackWithValues(
                                        callable,
                                        values,
                                        node,
                                        false,
                                        { coroutine: true },
                                    );
                                const signature =
                                    context.checker.getSignatureFromDeclaration(
                                        declaration,
                                    );
                                if (signature)
                                    result.value = this.normalizeUndefined(
                                        result.value,
                                        context.checker.getReturnTypeOfSignature(
                                            signature,
                                        ),
                                    );
                                result.value = this.ownResult(
                                    result.value,
                                    node,
                                    context.checker.getTypeAtLocation(node),
                                );
                                if (
                                    result.value.kind === "void" &&
                                    result.value.cpp
                                )
                                    context.emit({
                                        kind: "expression",
                                        code: `${result.value.cpp};`,
                                    });
                                if (
                                    !rejectsOnly &&
                                    !result.value.abruptCompletion
                                )
                                    context.emit({
                                        kind: "control",
                                        code: `co_return ${result.value.kind === "void" ? "bbl::js::PromiseVoid{}" : this.resultCpp(result.value, node)};`,
                                        transfer: "suspend",
                                    });
                            }),
                        ),
                    ),
            );
        } finally {
            this.terminalThrow = previousThrow;
        }
        const output =
            rejectedOutput ??
            (result.value.abruptCompletion
                ? (result.value.coroutineResult ?? declaredOutput)
                : result.value.kind === "promise"
                  ? result.value.promiseResult!
                  : result.value);
        const cppType =
            result.value.kind === "promise"
                ? result.value.promiseType!
                : this.cppType(output, node);
        if (result.value.abruptCompletion && !rejectsOnly) {
            // Specialization can leave only a throwing path, with no coroutine
            // keyword. Rethrow at coroutine completion without inventing a
            // successful value or introducing another suspension boundary.
            compiled.lines = [
                "try {",
                ...compiled.lines,
                `} catch (...) { co_return []() -> ${cppType} { throw; }(); }`,
            ];
        }
        // The coroutine takes its environment by value; a temporary closure's
        // this pointer or a borrowed environment must never enter its frame.
        // Terminal throws share the native coroutine completion path, including
        // when earlier statements suspend. No unreachable epilogue is emitted.
        const cpp = context.nativeEmission.renderSharedCoroutine(
            compiled,
            `bbl::js::Promise<${cppType}>`,
            declaration,
        );
        return {
            kind: "promise",
            cpp,
            promiseResult: output,
            promiseType: cppType,
        };
    }

    /**
     * `new Promise(executor)` outside an application realm. The executor
     * runs as the realm's does; the promise is consumed where it is created,
     * awaited or returned, so the settlement is read at that await (see
     * `js_synchronous_promise.hpp`). A stored promise, or one a timer or
     * frame callback settles after its executor returns, needs a pending
     * state the synchronous lowering does not have: the program compiles in
     * the application realm, whose promises keep it.
     */
    compileSynchronousConstructor(node: ts.NewExpression): Value {
        let consumer: ts.Node = node.parent;
        while (
            ts.isParenthesizedExpression(consumer) ||
            ts.isAsExpression(consumer) ||
            ts.isSatisfiesExpression(consumer) ||
            ts.isNonNullExpression(consumer)
        )
            consumer = consumer.parent;
        if (
            (!ts.isAwaitExpression(consumer) &&
                !ts.isReturnStatement(consumer) &&
                !ts.isArrowFunction(consumer)) ||
            this.deferredSettlement(node)
        )
            throw new ApplicationRealmRequired();
        if (!this.context.options.pendingActivations)
            throw new PendingActivationsRequired();
        this.context.asyncActivations.pendingActivations();
        return this.compileConstructor(node, true);
    }

    /**
     * A scheduler call in the executor whose callback names a resolving
     * function: a timer or frame callback always runs after the executor
     * returns, so the await would find the promise pending and end an
     * activation JavaScript resumes.
     */
    private deferredSettlement(
        node: ts.NewExpression,
    ): ts.CallExpression | undefined {
        const context = this.context;
        const executor = node.arguments?.[0]
            ? context.unwrap(node.arguments[0])
            : undefined;
        if (
            !executor ||
            (!ts.isArrowFunction(executor) &&
                !ts.isFunctionExpression(executor))
        )
            return undefined;
        const resolving = new Set(
            executor.parameters.flatMap((parameter) => {
                const symbol = declaredSymbol(context.checker, parameter.name);
                return symbol ? [symbol] : [];
            }),
        );
        // A callback names a resolving function directly or through a local
        // function the executor declares (`const poll = () => ...`).
        const visited = new Set<ts.Node>();
        const namesResolving = (root: ts.Node): boolean =>
            someAnalysisNode(root, (candidate) => {
                if (!ts.isIdentifier(candidate)) return false;
                const symbol = declaredSymbol(context.checker, candidate);
                if (symbol === undefined) return false;
                if (resolving.has(symbol)) return true;
                const declaration = symbol.valueDeclaration;
                const local =
                    declaration &&
                    declaration.pos >= executor.pos &&
                    declaration.end <= executor.end &&
                    declaration.getSourceFile() === executor.getSourceFile()
                        ? ts.isVariableDeclaration(declaration)
                            ? declaration.initializer
                            : ts.isFunctionDeclaration(declaration)
                              ? declaration
                              : undefined
                        : undefined;
                if (!local || visited.has(local)) return false;
                visited.add(local);
                return namesResolving(local);
            });
        return findAnalysisNode(
            executor.body,
            (candidate): candidate is ts.CallExpression =>
                ts.isCallExpression(candidate) &&
                DEFERRED_SCHEDULERS.has(
                    context.libraryGlobal(candidate.expression) ?? "",
                ) &&
                candidate.arguments.some(namesResolving),
        );
    }

    private synchronousPromiseType(
        node: ts.NewExpression,
    ): DataType | undefined {
        const checker = this.context.checker;
        const awaited = checker.getAwaitedType(checker.getTypeAtLocation(node));
        if (!awaited) return undefined;
        if (
            (awaited.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !==
            0
        )
            return { kind: "promise" };
        const result = this.context.dataTypes.fromTsType(awaited, node);
        return result ? { kind: "promise", result } : undefined;
    }

    private compileConstructor(
        node: ts.NewExpression,
        synchronous = false,
    ): Value {
        const context = this.context;
        if (node.arguments?.length !== 1)
            context.fail(node, "Promise construction requires one executor.");
        const callback = context.unwrap(argumentAt(node, 0));
        if (
            !ts.isIdentifier(callback) &&
            !ts.isArrowFunction(callback) &&
            !ts.isFunctionExpression(callback)
        )
            return context.fail(
                callback,
                "Promise executor requires a represented local function.",
            );
        const declaration = ts.isIdentifier(callback)
            ? tryResolveFunctionDeclaration(context.checker, callback)
            : callback;
        const asynchronous =
            declaration &&
            ts
                .getModifiers(declaration)
                ?.some(
                    (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
                );
        // An async executor suspends inside construction.
        if (synchronous && asynchronous) throw new ApplicationRealmRequired();
        // Outside a realm a Promise<T> is represented by T itself.
        const type = synchronous
            ? this.synchronousPromiseType(node)
            : context.dataLowerer.dataTypeAt(node);
        if (type?.kind !== "promise")
            return context.fail(
                node,
                "Promise construction requires a concrete owned result type.",
            );
        const output = type.result
            ? context.dataLowerer.leafValue(
                  "",
                  context.dataTypes.markStoredObjectReferences(type.result),
              )
            : ({ kind: "void", cpp: "" } satisfies Value);
        const cppType = this.cppType(output, node);
        const name = context.allocateTemporaryCppName("constructed_promise");
        context.emit({
            kind: "declaration",
            type: synchronous
                ? `bbl::js::SynchronousPromise<${cppType}>`
                : `bbl::js::Promise<${cppType}>`,
            name,
            initializer: "",
            initialization: "default",
        });
        const binding = context.registerNativeBinding(name);
        const resolver = (
            nativePromiseSettlement: "resolve" | "reject",
        ): Value => ({
            kind: "callback",
            cpp: name,
            nativePromiseSettlement: {
                mode: nativePromiseSettlement,
                type: cppType,
                result: output,
            },
            nativeCaptures: [binding],
            truthinessCpp: "true",
            callbackEvaluationIdentity: {},
        });
        // The executor runs synchronously; only resolving functions and the
        // callbacks it registers escape. Its writes address the calling scope.
        const compiled = context.captureManagedClosureLines(() => {
            const values = [resolver("resolve"), resolver("reject")];
            context.emitDiscardedValue(
                asynchronous
                    ? this.activate(callback, declaration, values, node)
                    : context.compileCallbackWithValues(callback, values, node),
            );
        }, true);
        context.emit(`try { (${renderClosure(compiled, "")})(); }`);
        context.emit(
            synchronous
                ? "catch (const bbl::js::PendingActivation&) { throw; }"
                : "catch (const bbl::pal::WorkerTerminated&) { throw; }",
        );
        context.emit(
            `catch (...) { ${name}.reject(std::current_exception()); }`,
        );
        if (synchronous) {
            // The executor ran in place: what it captured is this statement's.
            context.useNativeValue({
                kind: "void",
                cpp: "",
                nativeCaptures: compiled.nativeCaptures,
            });
            const settled = `${name}.await_result()`;
            return output.kind === "void"
                ? { kind: "void", cpp: settled, nativeCaptures: [binding] }
                : {
                      ...this.resultAt(output, settled, binding),
                      impure: true,
                  };
        }
        return {
            kind: "promise",
            cpp: name,
            promiseResult: output,
            promiseType: cppType,
            nativeCaptures: [binding],
        };
    }

    /**
     * `Promise.race`, and `Promise.any`, which settles with the first
     * fulfillment instead and rejects with an AggregateError of every
     * reason, in input order, once all inputs reject.
     */
    private compileRace(
        call: ts.CallExpression,
        operation: "race" | "any",
    ): Value {
        const context = this.context;
        if (call.arguments.length !== 1)
            context.fail(
                call,
                `Promise.${operation} requires one represented iterable.`,
            );
        const argument = unwrapExpression(argumentAt(call, 0));
        const pin = (value: Value, source: ts.Node = call): Value =>
            this.pinArgument(
                this.asPromise(value, source),
                "race_input",
                source,
            );
        let promises: Value[];
        // An input typed Promise<never> only rejects, so it joins any
        // settlement type: the others name the result.
        const argumentType = context.checker.getTypeAtLocation(argument);
        const onlyRejects = (index: number): boolean => {
            const type = this.elementType(argumentType, index);
            const awaited = type && context.checker.getAwaitedType(type);
            return ((awaited?.flags ?? 0) & ts.TypeFlags.Never) !== 0;
        };
        const spread = this.spreadLiteralInput(argument, operation);
        if (ts.isArrayLiteralExpression(argument) && !spread)
            promises = argument.elements.map((element) =>
                pin(
                    ts.isOmittedExpression(element)
                        ? { kind: "void", cpp: "" }
                        : context.compileValue(element),
                    element,
                ),
            );
        else {
            const value = spread ?? context.compileValue(argument);
            if (value.kind === "tuple")
                promises = (value.tupleElements ?? []).map((value) =>
                    pin(value),
                );
            else {
                if (value.dataType?.kind !== "vector")
                    return context.fail(
                        argument,
                        `Promise.${operation} requires an array or a represented tuple.`,
                    );
                const element = value.dataType.element;
                return context.dataLowerer.leafValue(
                    `bbl::js::promise_${operation}(${value.cpp})`,
                    element.kind === "promise"
                        ? element
                        : { kind: "promise", result: element },
                );
            }
        }
        const output = this.withoutConstants(
            promises.find((_, index) => !onlyRejects(index))?.promiseResult ??
                promises[0]?.promiseResult ?? { kind: "void", cpp: "" },
        );
        const cppType = this.cppType(output, call);
        const inputs = promises.map((promise, index) => {
            if (promise.promiseType === cppType) return promise.cpp;
            if (!onlyRejects(index))
                return context.fail(
                    call,
                    `Promise.${operation} inputs require a common represented settlement type.`,
                );
            return `bbl::js::Promise<${cppType}>::view(${promise.cpp}, [](const auto&) -> ${cppType} { throw std::logic_error("A Promise<never> fulfilled."); })`;
        });
        return {
            kind: "promise",
            cpp: `bbl::js::promise_${operation}_tuple<${cppType}>(std::tuple{${inputs.join(", ")}})`,
            promiseType: cppType,
            promiseResult: output,
            nativeCaptures: promises.flatMap(
                (value) => value.nativeCaptures ?? [],
            ),
        };
    }

    /**
     * An array literal with spreads (`[p, ...ps]`) holds a count known only
     * at run time: it is the fresh array JavaScript builds first, element by
     * element in source order, which the combinator then reads as a stored
     * array. Its elements must be promises of one settlement type.
     */
    private spreadLiteralInput(
        argument: ts.Expression,
        operation: string,
    ): Value | undefined {
        if (
            !ts.isArrayLiteralExpression(argument) ||
            !argument.elements.some(ts.isSpreadElement)
        )
            return undefined;
        const lowerer = this.context.dataLowerer;
        let element: DataType | undefined;
        for (const item of argument.elements) {
            const declared = lowerer.dataTypeAt(
                ts.isSpreadElement(item) ? item.expression : item,
            );
            const type = !ts.isSpreadElement(item)
                ? declared
                : declared?.kind === "vector" || declared?.kind === "span"
                  ? declared.element
                  : undefined;
            if (
                type?.kind !== "promise" ||
                (element !== undefined && !dataTypesEqual(element, type))
            )
                return this.context.fail(
                    item,
                    `Promise.${operation} literal spreads require promises and arrays of promises of one settlement type.`,
                );
            element = type;
        }
        const array: DataType = { kind: "vector", element: element! };
        return {
            ...lowerer.leafValue(
                lowerer.compileForSink(argument, array),
                array,
            ),
            freshData: true,
        };
    }

    private settledHandlers(
        result: DataType | undefined,
        site: ts.Node,
    ): {
        type: DataType;
        fulfilled: string;
        rejected: string;
    } {
        const context = this.context;
        // A void fulfillment owns an undefined `value` property. Its nullable
        // carrier is always absent, so no numeric payload is ever exposed.
        const valueType: DataType = result ?? {
            kind: "optional",
            inner: { kind: "number" },
            undefinedOnly: true,
        };
        const type = context.dataTypes.ownedRecordType([
            { sourceName: "status", type: { kind: "string" } },
            {
                sourceName: "value",
                type: valueType,
                defaultWhenMissing: true,
                presentForTags: [
                    [
                        {
                            discriminant: "status",
                            value: "fulfilled",
                        },
                    ],
                ],
            },
            {
                sourceName: "reason",
                type: { kind: "error" },
                defaultWhenMissing: true,
                presentForTags: [
                    [
                        {
                            discriminant: "status",
                            value: "rejected",
                        },
                    ],
                ],
            },
        ]);
        const input = result
            ? context.dataTypes.cppType(result)
            : "bbl::js::PromiseVoid";
        const converted = result
            ? context.dataLowerer.compileKnownValueForSink(
                  context.dataLowerer.leafValue("value", result),
                  valueType,
                  site,
              )
            : "";
        const create = `auto result = bbl::js::make_ref<bblscene::${type.name}Data>();`;
        return {
            type,
            fulfilled: `[]([[maybe_unused]] const ${input}& value) { ${create} result->status = "fulfilled"; ${result ? `result->value = ${converted};` : ""} return result; }`,
            rejected: `[](std::exception_ptr error) { ${create} result->status = "rejected"; result->reason = bbl::js::Error(error); return result; }`,
        };
    }

    private compileAll(call: ts.CallExpression, settled = false): Value {
        const context = this.context;
        const operation = settled ? "allSettled" : "all";
        if (call.arguments.length !== 1)
            context.fail(
                call,
                `Promise.${operation} requires one represented iterable.`,
            );
        const argument = unwrapExpression(argumentAt(call, 0));
        const compileInput = (input: ts.Expression): Value =>
            settled
                ? context.compileValue(input)
                : context.asyncActivations.withOrderedAggregateInput(
                      call,
                      input,
                      () => context.compileValue(input),
                  );
        const pin = (
            value: Value,
            source: ts.Node,
            expected?: ts.Type,
        ): Value => {
            const promise = this.pinArgument(
                this.asPromise(value, source, expected),
                "all_input",
                source,
            );
            if (!settled) return promise;
            const output = promise.promiseResult!;
            const type =
                output.dataType ??
                (output.kind === "number" ||
                output.kind === "boolean" ||
                output.kind === "string"
                    ? { kind: output.kind }
                    : undefined);
            if (!type && output.kind !== "void")
                return context.fail(
                    call,
                    "Promise.allSettled requires an owned settlement value.",
                );
            const handlers = this.settledHandlers(type, call);
            return context.dataLowerer.leafValue(
                `(${promise.cpp}).then(${handlers.fulfilled}, ${handlers.rejected})`,
                { kind: "promise", result: handlers.type },
            );
        };
        let promises: Value[];
        const spread = settled
            ? this.spreadLiteralInput(argument, operation)
            : context.asyncActivations.withOrderedAggregateInput(
                  call,
                  argument,
                  () => this.spreadLiteralInput(argument, operation),
              );
        if (ts.isArrayLiteralExpression(argument) && !spread) {
            promises = argument.elements.map((element) =>
                pin(
                    ts.isOmittedExpression(element)
                        ? { kind: "void", cpp: "" }
                        : compileInput(element),
                    element,
                ),
            );
        } else {
            const value = spread ?? compileInput(argument);
            if (value.kind === "tuple") {
                const type = context.checker.getTypeAtLocation(argument);
                promises = (value.tupleElements ?? []).map((element, index) =>
                    pin(element, argument, this.elementType(type, index)),
                );
            } else {
                const type = value.dataType;
                if (type?.kind !== "vector")
                    return context.fail(
                        argument,
                        `Promise.${operation} requires an array or a represented tuple.`,
                    );
                if (type.element.kind !== "promise")
                    return context.fail(
                        argument,
                        `Promise.${operation} stored arrays currently require promise elements.`,
                    );
                const element = type.element.result;
                if (settled) {
                    const handlers = this.settledHandlers(element, call);
                    return context.dataLowerer.leafValue(
                        `bbl::js::promise_all_settled(${value.cpp}, ${handlers.fulfilled}, ${handlers.rejected})`,
                        {
                            kind: "promise",
                            result: { kind: "vector", element: handlers.type },
                        },
                    );
                }
                // A void fulfillment is undefined in the aggregate array.
                return context.dataLowerer.leafValue(
                    `bbl::js::promise_all(${value.cpp})`,
                    {
                        kind: "promise",
                        result: {
                            kind: "vector",
                            element: element ?? { kind: "undefined" },
                        },
                    },
                );
            }
        }
        const result: Value = {
            kind: "tuple",
            cpp: "",
            tupleElements: promises.map((value) => value.promiseResult!),
        };
        return {
            kind: "promise",
            cpp: `bbl::js::promise_all_tuple(std::tuple{${promises.map((value) => value.cpp).join(", ")}})`,
            promiseType: this.cppType(result, call),
            promiseResult: result,
            nativeCaptures: promises.flatMap(
                (value) => value.nativeCaptures ?? [],
            ),
        };
    }

    private compileReaction(
        callback: ts.Expression,
        promise: Value,
        reaction: "then" | "catch" | "finally",
        node: ts.CallExpression,
        evaluated?: Value,
    ): { cpp: string; output: Value; cppType: string; present?: string } {
        const context = this.context;
        const rejection = reaction === "catch";
        const cleanup = reaction === "finally";
        callback = context.unwrap(callback);
        const inline =
            ts.isArrowFunction(callback) ||
            ts.isFunctionExpression(callback) ||
            ts.isIdentifier(callback)
                ? callback
                : undefined;
        const declaration =
            inline &&
            (ts.isIdentifier(inline)
                ? tryResolveFunctionDeclaration(context.checker, inline)
                : inline);
        const asynchronous =
            declaration &&
            ts
                .getModifiers(declaration)
                ?.some(
                    (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
                );
        const signature = context.checker
            .getTypeAtLocation(callback)
            .getCallSignatures()[0];
        const returnType =
            signature && context.checker.getReturnTypeOfSignature(signature);
        // A reporting function value still installs a reaction: only its
        // browser instrumentation is erased, not rejection handling or timing.
        const reportingOnly =
            !evaluated &&
            !inline &&
            returnType !== undefined &&
            (returnType.flags &
                (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !==
                0 &&
            context.browserErasure.isBrowserOnlyHandler(callback, rejection);
        const neverReturns =
            rejection &&
            signature &&
            (context.checker.getReturnTypeOfSignature(signature).flags &
                ts.TypeFlags.Never) !==
                0;
        let stored: Value | undefined;
        if (
            !reportingOnly &&
            (evaluated ||
                !inline ||
                (ts.isIdentifier(inline) &&
                    context.bindings.lookupOptional(inline)?.dataType?.kind ===
                        "function"))
        ) {
            const value = evaluated ?? context.compileValue(callback);
            const type =
                value.dataType ?? context.dataLowerer.dataTypeAt(callback);
            if (type?.kind !== "function")
                return context.fail(
                    callback,
                    "Promise reactions require a compiled function value.",
                );
            const name = context.allocateTemporaryCppName("promise_callback");
            const cpp = context.dataLowerer.compileKnownValueForSink(
                value,
                type,
                callback,
            );
            context.emit({
                kind: "declaration",
                type: "auto",
                name,
                initializer: cpp,
            });
            stored = {
                ...context.dataLowerer.leafValue(name, type),
                nativeCaptures: [context.registerNativeBinding(name)],
            };
        }
        const name = context.allocateTemporaryCppName("promise_argument");
        // A settled value is passed by const reference, an exception by value.
        const parameterStorage = rejection
            ? "std::exception_ptr"
            : `const ${promise.promiseType}`;
        const parameterType = rejection
            ? parameterStorage
            : `${parameterStorage}&`;
        const result: { value: Value } = { value: { kind: "void", cpp: "" } };
        const compiled = context.withOwnedCallbackBody(() =>
            context.captureManagedClosureLines(() => {
                const inputs: Value[] = [];
                if (!cleanup) {
                    // A capture of the parameter takes its declared constness.
                    context.registerNativeBindingType(name, parameterStorage);
                    const binding = context.registerNativeBinding(name);
                    inputs.push(
                        rejection
                            ? errorValue(
                                  {
                                      kind: "data",
                                      dataType: { kind: "string" },
                                      cpp: `bbl::js::promise_error_message(${name})`,
                                      nativeCaptures: [binding],
                                  },
                                  "Error",
                                  (text) => context.cppString(text),
                                  {
                                      kind: "data",
                                      cpp: `bbl::js::Error(${name})`,
                                      dataType: { kind: "error" },
                                      nativeCaptures: [binding],
                                  },
                              )
                            : this.resultAt(
                                  promise.promiseResult!,
                                  name,
                                  binding,
                              ),
                    );
                }
                result.value = reportingOnly
                    ? { kind: "void", cpp: "" }
                    : stored
                      ? context.dataLowerer.compileFunctionValueCall(
                            stored,
                            inputs,
                            node,
                        )
                      : asynchronous
                        ? this.activate(inline, declaration, inputs, node)
                        : context.compileCallbackWithValues(
                              inline!,
                              inputs,
                              node,
                          );
                if (signature)
                    result.value = this.normalizeUndefined(
                        result.value,
                        context.checker.getReturnTypeOfSignature(signature),
                    );
                if (cleanup && result.value.kind !== "promise") {
                    this.refuseThenable(result.value, callback);
                    context.emitDiscardedValue(result.value);
                    result.value = { kind: "void", cpp: "" };
                }
                const expected = rejection
                    ? promise.promiseResult?.dataType
                    : undefined;
                if (
                    result.value.kind === "tuple" &&
                    expected &&
                    ["vector", "tuple", "product"].includes(expected.kind)
                ) {
                    result.value = context.dataLowerer.leafValue(
                        context.dataLowerer.compileKnownValueForSink(
                            result.value,
                            expected,
                            callback,
                        ),
                        expected,
                    );
                }
                if (!cleanup)
                    result.value = this.ownResult(
                        result.value,
                        node,
                        context.checker.getTypeAtLocation(node),
                    );
                if (result.value.kind === "void") {
                    if (result.value.cpp)
                        context.emit({
                            kind: "expression",
                            code: `${result.value.cpp};`,
                        });
                } else
                    context.emit({
                        kind: "control",
                        code: `return ${this.resultCpp(result.value, node)};`,
                        transfer: "return",
                    });
            }),
        );
        const output = neverReturns
            ? promise.promiseResult!
            : result.value.kind === "promise"
              ? result.value.promiseResult!
              : result.value;
        const cppType = neverReturns
            ? promise.promiseType!
            : result.value.kind === "promise"
              ? result.value.promiseType!
              : this.cppType(output, node);
        return {
            cpp: renderClosure(
                compiled,
                cleanup ? "" : `[[maybe_unused]] ${parameterType} ${name}`,
                neverReturns ? cppType : undefined,
            ),
            output,
            cppType,
            ...(cleanup && stored
                ? { present: `static_cast<bool>(${stored.cpp})` }
                : {}),
        };
    }

    private isPromiseType(expression: ts.Expression): boolean {
        return (
            this.context.checker.getTypeAtLocation(expression).getSymbol()
                ?.name === "Promise"
        );
    }
    private isPromiseMethod(
        expression: ts.Expression,
    ): expression is ts.PropertyAccessExpression {
        return (
            ts.isPropertyAccessExpression(expression) &&
            ["then", "catch", "finally"].includes(expression.name.text) &&
            this.isPromiseType(expression.expression)
        );
    }
    private cppType(value: Value, node: ts.Node): string {
        if (value.kind === "void" || value.kind === "physics-engine-module")
            return "bbl::js::PromiseVoid";
        if (value.kind === "tuple")
            return `std::tuple<${(value.tupleElements ?? []).map((element) => this.cppType(element, node)).join(", ")}>`;
        if (value.dataType)
            return this.context.dataTypes.cppType(value.dataType);
        if (value.kind === "number") return "double";
        if (value.kind === "boolean") return "bool";
        if (value.kind === "string") return "std::string";
        if (value.kind === "engine" && value.ownedEngineCpp)
            return "std::shared_ptr<bbl::Engine>";
        if (value.kind === "asset") return "bbl::AssetHandle";
        if (value.kind === "scene") return "bbl::Scene";
        if (value.kind === "environment-textures")
            return "std::shared_ptr<const bbl::EnvironmentState>";
        return this.context.fail(
            node,
            `Promise result '${value.kind}' has no owned asynchronous representation.`,
        );
    }
    private resultAt(
        source: Value,
        cpp: string,
        binding: NativeCaptureBinding,
    ): Value {
        const { ownedCpp, ...value } = source;
        if (value.kind === "engine" && value.dataType?.kind === "handle")
            return valueForKind("engine", {
                ...this.context.dataLowerer.leafValue(cpp, value.dataType),
                ...(value.engineIdentity
                    ? { engineIdentity: value.engineIdentity }
                    : {}),
                nativeCaptures: [binding],
                nativeCompanionCaptures: {
                    engineCpp: [binding],
                    ownedEngineCpp: [binding],
                    storedEngineCpp: [binding],
                },
            });
        if (value.kind === "tuple")
            return {
                ...value,
                cpp,
                tupleElements: (value.tupleElements ?? []).map(
                    (element, index) =>
                        this.resultAt(
                            element,
                            `std::get<${index}>(${cpp})`,
                            binding,
                        ),
                ),
                nativeCaptures: [binding],
            };
        if (value.kind === "engine")
            return {
                ...value,
                cpp: `(*${cpp})`,
                engineCpp: `(*${cpp})`,
                ownedEngineCpp: cpp,
                nativeCaptures: [binding],
                nativeCompanionCaptures: {
                    engineCpp: [binding],
                },
            };
        if (value.kind === "data" && value.dataType) {
            const leaf = this.context.dataLowerer.leafValue(
                cpp,
                value.dataType,
            );
            return valueForKind(leaf.kind, {
                ...this.withoutProducerStorage(value),
                ...leaf,
                nativeCaptures: [binding],
            });
        }
        if (
            value.kind === "number" ||
            value.kind === "boolean" ||
            value.kind === "string"
        )
            return {
                kind: value.kind,
                cpp,
                nativeCaptures: [binding],
                ...(value.dataType ? { dataType: value.dataType } : {}),
                ...(value.staticString !== undefined
                    ? { staticString: value.staticString }
                    : {}),
                ...(value.staticNumber !== undefined
                    ? { staticNumber: value.staticNumber }
                    : {}),
                ...(value.staticBoolean !== undefined
                    ? { staticBoolean: value.staticBoolean }
                    : {}),
                ...(value.packagedBodySource
                    ? { packagedBodySource: value.packagedBodySource }
                    : {}),
            };
        return { ...value, cpp, nativeCaptures: [binding] };
    }
    private withoutConstants(value: Value): Value {
        const {
            staticString,
            staticNumber,
            staticBoolean,
            staticElements,
            staticStrings,
            ...runtime
        } = value;
        return runtime.kind === "tuple"
            ? {
                  ...runtime,
                  tupleElements: (runtime.tupleElements ?? []).map((element) =>
                      this.withoutConstants(element),
                  ),
              }
            : runtime;
    }
    private normalizeUndefined(value: Value, type: ts.Type): Value {
        const result = this.context.checker.getAwaitedType(type) ?? type;
        if (
            value.kind === "browser" &&
            (result.flags & ts.TypeFlags.Void) !== 0
        )
            return { kind: "void", cpp: "" };
        return value.kind === "json-null" &&
            (value.cpp === "std::nullopt" ||
                (result.flags & ts.TypeFlags.Undefined) !== 0)
            ? {
                  kind: "void",
                  cpp: value.cpp === "std::nullopt" ? "" : value.cpp,
              }
            : value;
    }
    /**
     * The value `Promise.resolve(value)` adopts, in the representation of
     * the promise its context expects when that differs from the value's
     * own: `Promise.resolve("a")` returned as a `Promise<"a" | "b">`
     * resolves the literal union's enum, not a string.
     */
    private resolvedValue(node: ts.CallExpression): Value {
        const context = this.context;
        const argument = node.arguments[0];
        if (!argument) return { kind: "void", cpp: "" };
        const value = context.compileValue(argument);
        // Existing promises keep their identity and settlement; only a raw
        // payload needs conversion to its contextual result representation.
        if (value.kind === "promise") return value;
        const own =
            value.dataType ??
            (value.kind === "string" ||
            value.kind === "number" ||
            value.kind === "boolean"
                ? { kind: value.kind }
                : undefined);
        const contextual = context.checker.getContextualType(node);
        const awaited =
            contextual &&
            context.checker.getAwaitedType(
                // Absence of the promise itself is not absence of its payload.
                context.checker.getNonNullableType(contextual),
            );
        const expected =
            own &&
            awaited &&
            (awaited.flags &
                (ts.TypeFlags.Any |
                    ts.TypeFlags.Unknown |
                    ts.TypeFlags.Void |
                    ts.TypeFlags.Undefined)) ===
                0
                ? context.dataTypes.fromTsType(awaited, node)
                : undefined;
        if (
            !own ||
            !expected ||
            context.dataTypes.cppType(expected) ===
                context.dataTypes.cppType(own)
        )
            return value;
        return context.dataLowerer.leafValue(
            context.dataLowerer.compileKnownValueForSink(
                value,
                expected,
                argument,
            ),
            expected,
        );
    }
    /**
     * A union holding a promise, as resolution adopts it: an absent promise
     * settles to absence and a present one adopts its payload; a
     * value-or-promise union (`T | Promise<T>`) is its promise arm itself,
     * or its value arm resolved.
     */
    private adoptPromiseUnion(
        value: Value,
        node: ts.Node,
        source = this.context.checker.getTypeAtLocation(node),
    ): Value | undefined {
        const type = value.dataType;
        if (type?.kind !== "optional" || type.inner.kind !== "promise")
            return this.adoptValueOrPromise(value);
        const context = this.context;
        const awaited = context.checker.getAwaitedType(source);
        const mapped = awaited && context.dataTypes.fromTsType(awaited, node);
        const result = mapped
            ? context.dataTypes.markStoredObjectReferences(mapped)
            : type.inner.result
              ? context.dataTypes.nullableType(
                    type.inner.result,
                    type.undefinedOnly,
                )
              : undefined;
        const cppType = result
            ? context.dataTypes.cppType(result)
            : "bbl::js::PromiseVoid";
        const owner = this.pinArgument(value, "optional_promise", node);
        const promise = context.dataLowerer.leafValue(
            `(*${owner.cpp})`,
            type.inner,
        );
        const present = context.dataLowerer.compileKnownValueForSink(
            promise,
            { kind: "promise", ...(result ? { result } : {}) },
            node,
        );
        const absent = result
            ? context.dataTypes.absentValue(result)
            : "bbl::js::PromiseVoid{}";
        return {
            kind: "promise",
            cpp: `(${optionalPresentCpp(owner.cpp)} ? ${present} : bbl::js::Promise<${cppType}>::resolved(${absent}))`,
            promiseType: cppType,
            promiseResult: result
                ? context.dataLowerer.leafValue("", result)
                : { kind: "void", cpp: "" },
        };
    }

    private asPromise(
        value: Value,
        node: ts.Node,
        source = this.context.checker.getTypeAtLocation(node),
    ): Value {
        if (value.kind === "promise") return value;
        const adopted = this.adoptPromiseUnion(value, node, source);
        if (adopted) return adopted;
        value = this.normalizeUndefined(
            value,
            this.context.checker.getTypeAtLocation(node),
        );
        this.refuseThenable(value, node);
        value = this.ownResult(value, node, source);
        const type = this.cppType(value, node);
        if (value.kind === "void") {
            this.context.emitDiscardedValue(value);
            value = { ...value, cpp: "" };
        }
        const cpp =
            value.kind === "void"
                ? "bbl::js::PromiseVoid{}"
                : this.resultCpp(value, node);
        return {
            kind: "promise",
            cpp: `bbl::js::Promise<${type}>::resolved(${cpp})`,
            promiseResult: value,
            promiseType: type,
        };
    }
    private elementType(
        type: ts.Type | undefined,
        index: number,
    ): ts.Type | undefined {
        if (!type) return undefined;
        const checker = this.context.checker;
        return checker.isTupleType(type)
            ? checker.getTypeArguments(type as ts.TypeReference)[index]
            : checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    }

    private withoutProducerStorage(value: Value): Value {
        const {
            optionalFoundCpp,
            optionalStorageCpp,
            slotFoundCpp,
            truthinessCpp,
            optionalChainShortCircuited,
            sharedStorageCpp,
            ownedCpp,
            nativeLvalue,
            nativeOwnedRvalue,
            builtFrom,
            objectIdentityCpp,
            nativeCompanionCaptures,
            ...owned
        } = value;
        const {
            optionalFoundCpp: _found,
            optionalStorageCpp: _storage,
            slotFoundCpp: _slot,
            truthinessCpp: _truthiness,
            ...companions
        } = nativeCompanionCaptures ?? {};
        return { ...owned, nativeCompanionCaptures: companions };
    }

    private ownOptionalResource(
        value: Value,
        type: DataType<"optional">,
        cpp: string,
    ): Value {
        return valueForKind("data", {
            ...this.withoutProducerStorage(value),
            ...this.context.dataLowerer.leafValue(cpp, type),
            ...(type.inner.kind === "handle" && type.inner.handle === "texture"
                ? { textureStorage: "stored" as const }
                : {}),
        });
    }

    private ownResult(
        value: Value,
        node: ts.Node,
        source: ts.Type | undefined,
    ): Value {
        const adopted = this.adoptPromiseUnion(value, node, source);
        if (adopted) return adopted;
        const awaited =
            source && (this.context.checker.getAwaitedType(source) ?? source);
        if (value.kind === "tuple")
            return {
                ...value,
                cpp: "",
                tupleElements: (value.tupleElements ?? []).map(
                    (element, index) =>
                        this.ownResult(
                            element,
                            node,
                            this.elementType(awaited, index),
                        ),
                ),
            };
        if (
            value.dataType?.kind === "optional" &&
            value.dataType.inner.kind === "handle"
        )
            return this.ownOptionalResource(
                value,
                value.dataType,
                value.ownedCpp ?? `bbl::js::snapshot_value(${value.cpp})`,
            );
        let result =
            awaited && this.context.dataTypes.fromTsType(awaited, node);
        if (
            result?.kind === "optional" &&
            result.inner.kind === "handle" &&
            (value.kind === result.inner.handle ||
                value.kind === "json-null" ||
                value.kind === "void")
        )
            return this.ownOptionalResource(
                value,
                result,
                this.context.dataLowerer.compileKnownValueForSink(
                    value,
                    result,
                    node,
                ),
            );
        if (isHandleKind(value.kind) && value.kind !== "engine") {
            if (
                presenceFlagCpp(value) !== undefined &&
                presenceFlagCpp(value) !== "true" &&
                !(result?.kind === "handle" && result.handle === value.kind)
            )
                return this.context.fail(
                    node,
                    "Nullable asynchronous resources require a represented payload type.",
                );
            const type = { kind: "handle", handle: value.kind } as const;
            // A settled owned handle has left its producer's local slot.
            // Nullable results carry their presence in the payload instead.
            return valueForKind(value.kind, {
                ...this.withoutProducerStorage(value),
                cpp: this.context.dataLowerer.compileKnownValueForSink(
                    value,
                    type,
                    node,
                ),
                dataType: type,
                ...(value.kind === "texture"
                    ? { textureStorage: "stored" as const }
                    : {}),
            });
        }
        if (value.kind !== "record") return value;
        this.refuseThenable(value, node);
        if (!result) {
            const fields: Omit<DataStructField, "name">[] = [];
            for (const property of this.context.checker.getPropertiesOfType(
                awaited ?? this.context.checker.getTypeAtLocation(node),
            )) {
                const fieldType =
                    this.context.checker.getTypeOfSymbolAtLocation(
                        property,
                        node,
                    );
                const mapped = this.context.dataTypes.fromSharedReturnType(
                    fieldType,
                    node,
                );
                if (!mapped || (property.flags & ts.SymbolFlags.Optional) !== 0)
                    return this.context.fail(
                        node,
                        `Asynchronous result property '${property.name}' has no owned representation.`,
                    );
                fields.push({
                    sourceName: property.name,
                    type: mapped,
                    ...(propertyIsReadOnly(property) ? { readOnly: true } : {}),
                });
            }
            if (fields.length)
                result = this.context.dataTypes.ownedRecordType(fields);
        }
        if (
            result?.kind !== "struct" &&
            !(result?.kind === "map" && result.dictionary)
        )
            return value;
        const owned = this.context.dataTypes.markStoredObjectReferences(
            this.context.dataLowerer.retainedResultType(value, result, node),
        );
        return this.context.dataLowerer.leafValue(
            this.context.dataLowerer.compileKnownValueForSink(
                value,
                owned,
                node,
            ),
            owned,
        );
    }
    private adoptValueOrPromise(value: Value): Value | undefined {
        const type = value.dataType;
        if (value.kind !== "data" || type?.kind !== "union") return undefined;
        const promiseIndex = type.members.findIndex(
            (member) => member.kind === "promise",
        );
        const promise = type.members[promiseIndex];
        const settled = type.members[1 - promiseIndex];
        if (
            type.members.length !== 2 ||
            promise?.kind !== "promise" ||
            !promise.result ||
            !settled ||
            !dataTypesEqual(promise.result, settled)
        )
            return undefined;
        this.context.useNativeValue(value);
        const cppType = this.context.dataTypes.cppType(promise);
        return this.context.dataLowerer.leafValue(
            `([](const auto& settled) -> ${cppType} { return settled.index() == ${promiseIndex} ? std::get<${promiseIndex}>(settled) : ${cppType}::resolved(std::get<${1 - promiseIndex}>(settled)); }(${value.cpp}))`,
            promise,
        );
    }

    private refuseThenable(value: Value, node: ts.Node): void {
        if (isCustomThenable(this.context.dataTypes, value, node))
            this.context.fail(
                node,
                "Custom thenable assimilation requires an owned promise resolution protocol.",
            );
    }
    private resultCpp(value: Value, node: ts.Node): string {
        if (value.kind === "physics-engine-module")
            return "bbl::js::PromiseVoid{}";
        if (
            value.kind === "string" &&
            (!value.dataType || value.dataType.kind === "string")
        )
            return `std::string{${value.cpp}}`;
        return value.kind === "tuple" && !value.cpp
            ? `${this.cppType(value, node)}{${(value.tupleElements ?? []).map((element) => this.resultCpp(element, node)).join(", ")}}`
            : (value.storedEngineCpp ??
                  value.ownedEngineCpp ??
                  value.ownedCpp ??
                  value.cpp);
    }
}
