import { journaled } from "./emission-transaction.js";
import { staticScalarValue } from "./number-intrinsics.js";
import type {
    LoweringServices,
    NativeReturnValueCompiler,
} from "./lowering-services.js";
import ts from "typescript";
import {
    hasUndefinedCompletion,
    hasNonThenableCompletion,
    hasUndefinedCallbackCompletion,
    provenUndefinedValue,
} from "./undefined-values.js";
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
import {
    declarationInDefaultLibrary,
    declaredInDefaultLibrary,
    declaredSymbol,
} from "./symbols.js";
import {
    optionalPresentCpp,
    presenceFlagCpp,
    valueForKind,
    withKindValueFacts,
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
import {
    isPromiseResultUsed,
    rejectionOnlyPromiseCpp,
    settlesNever,
} from "./promises.js";
import { convertsToSceneNode, isHandleKind } from "./data-types/handles.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import { hasNoValueCompletion } from "./native-return-type.js";
import { representedResultType } from "./represented-result.js";
import { isNullable, isTypeReference } from "./type-facts.js";

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
    | "registerNativeConstBinding"
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
            if (
                settlesNever(
                    context.checker,
                    context.checker.getTypeAtLocation(expression),
                )
            )
                return rejectionOnlyPromiseCpp(value.cpp, expected);
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
        this.refuseThenable(value, expression);
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
            const settled = awaited.promiseResult!;
            // An owned engine pair is never taken or rebound, so a
            // declaration it initializes aliases it.
            const binding =
                settled.dataType?.kind === "handle" &&
                settled.dataType.ownedEngine
                    ? context.registerNativeConstBinding(
                          temporary,
                          false,
                          awaited.promiseType,
                      )
                    : context.registerNativeBinding(
                          temporary,
                          false,
                          false,
                          awaited.promiseType,
                      );
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
            let settlement =
                rejection || node.arguments.length === 2
                    ? this.settlementType(node)
                    : undefined;
            if (rejection && settlement)
                settlement = this.retainedSettlement(promise, settlement, node);
            const first = this.compileReaction(
                argumentAt(node, 0),
                promise,
                rejection ? "catch" : "then",
                node,
                undefined,
                settlement,
            );
            if (settlement)
                settlement = this.retainedSettlement(
                    first.output,
                    settlement,
                    node,
                );
            if (rejection && first.cppType !== promise.promiseType) {
                if (settlement) {
                    const forwarded = this.forwardReaction(
                        promise,
                        settlement,
                        node,
                    );
                    return {
                        kind: "promise",
                        cpp: `${promise.cpp}.then(${forwarded}, ${first.cpp})`,
                        promiseResult: this.withoutConstants(first.output),
                        promiseType: first.cppType,
                    };
                }
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
                    undefined,
                    settlement,
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
        // An input that only rejects joins any settlement type: the others
        // name the result.
        const argumentType = context.checker.getTypeAtLocation(argument);
        const onlyRejects = (index: number): boolean =>
            settlesNever(
                context.checker,
                this.elementType(argumentType, index),
            );
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
                const input = this.iterablePromiseInput(
                    value,
                    argument,
                    operation,
                );
                return context.dataLowerer.leafValue(
                    `bbl::js::promise_${operation}(${input.range.cpp}, ${input.resolve})`,
                    input.type,
                );
            }
        }
        const first = promises.find((_, index) => !onlyRejects(index));
        const joined = promises.some(
            (promise, index) =>
                !onlyRejects(index) &&
                promise.promiseType !== first?.promiseType,
        )
            ? this.iterableSettlement(
                  context.checker.getIndexTypeOfType(
                      argumentType,
                      ts.IndexKind.Number,
                  ),
                  argument,
                  operation,
              )
            : undefined;
        const output = this.withoutConstants(
            (joined
                ? joined.result
                    ? context.dataLowerer.leafValue("", joined.result)
                    : { kind: "void" as const, cpp: "" }
                : first?.promiseResult) ??
                promises[0]?.promiseResult ?? { kind: "void", cpp: "" },
        );
        const cppType = this.cppType(output, call);
        const inputs = promises.map((promise, index) => {
            if (promise.promiseType === cppType) return promise.cpp;
            if (onlyRejects(index))
                return rejectionOnlyPromiseCpp(promise.cpp, cppType);
            if (joined)
                return context.dataLowerer.compileKnownValueForSink(
                    promise,
                    joined,
                    argument,
                );
            return context.fail(
                call,
                `Promise.${operation} inputs require a common represented settlement type.`,
            );
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
     * array. Promise result views join its represented settlement types
     * without adding reactions; one that only rejects joins any result.
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
        const context = this.context;
        const lowerer = context.dataLowerer;
        const source = context.checker.getIndexTypeOfType(
            context.checker.getTypeAtLocation(argument),
            ts.IndexKind.Number,
        );
        let type = this.mappedIterableSettlement(source, argument);
        let array: DataType<"vector"> | undefined;
        const output = context.allocateTemporaryCppName("promise_inputs");
        const initialize = (
            candidate: DataType<"promise">,
        ): DataType<"promise"> => {
            type ??= candidate;
            if (!array) {
                array = { kind: "vector", element: type };
                context.emit({
                    kind: "declaration",
                    type: context.dataTypes.cppType(array),
                    name: output,
                    initializer: "{}",
                });
                context.registerNativeTemporary(output, array);
            }
            return type;
        };
        const append = (
            value: Value,
            node: ts.Node,
            source = context.checker.getTypeAtLocation(node),
        ): void => {
            if (!type) {
                value = this.asPromise(value, node, source);
                const result = value.promiseResult;
                const owned =
                    result && representedResultType(context.dataTypes, result);
                if (result?.kind !== "void" && !owned)
                    context.fail(
                        node,
                        `Promise.${operation} inputs require an owned common settlement representation.`,
                    );
                initialize({
                    kind: "promise",
                    ...(owned ? { result: owned } : {}),
                });
            }
            const promise = this.promiseInput(
                value,
                initialize(type!),
                node,
                source,
            );
            context.emit({
                kind: "expression",
                code: `${output}.push_back(${promise});`,
            });
        };
        for (const item of argument.elements) {
            if (ts.isOmittedExpression(item))
                context.fail(
                    item,
                    `Promise.${operation} sparse spread literals require represented holes.`,
                );
            if (!ts.isSpreadElement(item)) {
                append(context.compileValue(item), item);
                continue;
            }
            const value = context.compileValue(item.expression);
            const iterated = lowerer.iteratedElements(value);
            if (iterated && "lanes" in iterated) {
                for (const [index, lane] of iterated.lanes.entries()) {
                    append(
                        lane,
                        item,
                        this.elementType(
                            context.checker.getTypeAtLocation(item.expression),
                            index,
                        ),
                    );
                }
            } else {
                const input = this.iterablePromiseInput(
                    value,
                    item.expression,
                    operation,
                    type,
                );
                initialize(input.type);
                const resolve = context.allocateTemporaryCppName(
                    "spread_promise_resolve",
                );
                const element = context.allocateTemporaryCppName(
                    "spread_promise_element",
                );
                context.emit({
                    kind: "declaration",
                    type: "auto",
                    name: resolve,
                    initializer: input.resolve,
                });
                context.emit({
                    kind: "expression",
                    code: `for (const auto& ${element} : ${input.range.cpp}) ${output}.push_back(${resolve}(${element}));`,
                });
            }
        }
        if (!array)
            initialize(
                type ?? this.iterableSettlement(source, argument, operation),
            );
        return { ...lowerer.leafValue(output, array!), freshData: true };
    }

    private iterableSourceType(node: ts.Node): ts.Type | undefined {
        const checker = this.context.checker;
        const source = checker.getTypeAtLocation(node);
        const indexed = checker.getIndexTypeOfType(source, ts.IndexKind.Number);
        if (indexed) return indexed;
        if (isTypeReference(source)) return checker.getTypeArguments(source)[0];
        return undefined;
    }

    private iterableSettlement(
        source: ts.Type | undefined,
        node: ts.Node,
        operation: string,
    ): DataType<"promise"> {
        return (
            this.mappedIterableSettlement(source, node) ??
            this.context.fail(
                node,
                `Promise.${operation} inputs require an owned common settlement representation.`,
            )
        );
    }

    private mappedIterableSettlement(
        source: ts.Type | undefined,
        node: ts.Node,
    ): DataType<"promise"> | undefined {
        const context = this.context;
        const awaited = source && context.checker.getAwaitedType(source);
        if (
            awaited &&
            (awaited.flags &
                (ts.TypeFlags.Void |
                    ts.TypeFlags.Undefined |
                    ts.TypeFlags.Never)) !==
                0
        )
            return { kind: "promise" };
        const result =
            awaited && context.dataTypes.fromPromiseResultType(awaited, node);
        if (!result) return undefined;
        return {
            kind: "promise",
            result: context.dataTypes.markStoredObjectReferences(result),
        };
    }

    private promiseInput(
        value: Value,
        target: DataType<"promise">,
        node: ts.Node,
        source = this.context.checker.getTypeAtLocation(node),
    ): string {
        return this.context.dataLowerer.compileKnownValueForSink(
            this.asPromise(value, node, source, target),
            target,
            node,
        );
    }

    /** Resolve one yielded value inside the combinator, before advancing its iterator. */
    private iterablePromiseInput(
        value: Value,
        node: ts.Node,
        operation: string,
        target?: DataType<"promise">,
    ): { range: Value; type: DataType<"promise">; resolve: string } {
        const context = this.context;
        const iterated = context.dataLowerer.iteratedElements(value);
        if (
            !iterated ||
            !("range" in iterated) ||
            (value.dataType?.kind === "iterator" && value.dataType.asynchronous)
        )
            return context.fail(
                node,
                `Promise.${operation} requires a represented synchronous iterable.`,
            );
        const source = this.iterableSourceType(node);
        const type =
            target ??
            (iterated.element.kind === "promise"
                ? iterated.element
                : this.iterableSettlement(source, node, operation));
        const name = context.allocateTemporaryCppName("promise_element");
        const body = context.captureManagedClosureLines(() => {
            context.registerNativeBinding(name);
            const converted = this.promiseInput(
                context.dataLowerer.leafValue(name, iterated.element),
                type,
                node,
                source,
            );
            context.emit({
                kind: "control",
                code: `return ${converted};`,
                transfer: "return",
            });
        });
        return {
            range: iterated.range,
            type,
            resolve: renderClosure(
                body,
                `const ${context.dataTypes.cppType(iterated.element)}& ${name}`,
                context.dataTypes.cppType(type),
            ),
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
        const settlements: ReturnType<AsyncLowerer["settledHandlers"]>[] = [];
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
            settlements.push(handlers);
            return promise;
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
                const input = this.iterablePromiseInput(
                    value,
                    argument,
                    operation,
                );
                const element = input.type.result;
                if (settled) {
                    const handlers = this.settledHandlers(element, call);
                    return context.dataLowerer.leafValue(
                        `bbl::js::promise_all_settled(${input.range.cpp}, ${handlers.fulfilled}, ${handlers.rejected}, ${input.resolve})`,
                        {
                            kind: "promise",
                            result: { kind: "vector", element: handlers.type },
                        },
                    );
                }
                // A void fulfillment is undefined in the aggregate array.
                return context.dataLowerer.leafValue(
                    `bbl::js::promise_all(${input.range.cpp}, ${input.resolve})`,
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
            tupleElements: promises.map((value, index) =>
                settled
                    ? context.dataLowerer.leafValue(
                          "",
                          settlements[index]!.type,
                      )
                    : value.promiseResult!,
            ),
        };
        const inputs = `std::tuple{${promises.map((value) => value.cpp).join(", ")}}`;
        return {
            kind: "promise",
            cpp: settled
                ? `bbl::js::promise_all_settled_tuple(${inputs}, std::tuple{${settlements.map((value) => value.fulfilled).join(", ")}}, std::tuple{${settlements.map((value) => value.rejected).join(", ")}})`
                : `bbl::js::promise_all_tuple(${inputs})`,
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
        settlement?: DataType<"promise">,
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
        const undefinedCompletion =
            hasUndefinedCompletion(context.checker, declaration) ||
            (declaration &&
                ts.isArrowFunction(declaration) &&
                !ts.isBlock(declaration.body) &&
                provenUndefinedValue(context, declaration.body)) ||
            hasUndefinedCallbackCompletion(
                context.checker,
                evaluated ??
                    (inline && ts.isIdentifier(inline)
                        ? context.bindings.lookupOptional(inline)
                        : undefined),
            );
        const nonThenableCompletion =
            cleanup && hasNonThenableCompletion(context.checker, declaration);
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
        // A single fulfillment callback determines its own settlement. The
        // call's context may widen its generic result to a constructor input
        // union that the callback never produces.
        if (!cleanup && !rejection && !settlement && returnType) {
            settlement = this.settlementType(node, returnType);
            // A null-only callback still needs the result's contextual carrier.
            if (!settlement) settlement = this.settlementType(node);
        }
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
            (rejection || settlement !== undefined) &&
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
                // Stored callbacks use the checked storage contract, never an earlier initializer.
                const completionProven =
                    reportingOnly ||
                    (stored
                        ? stored.dataType?.kind === "function" &&
                          (stored.dataType.undefinedCompletion ||
                              (cleanup &&
                                  stored.dataType.nonThenableCompletion))
                        : undefinedCompletion || nonThenableCompletion);
                if (
                    !neverReturns &&
                    result.value.kind === "void" &&
                    (result.value.erasedVoidCompletion || !completionProven)
                ) {
                    // A generic family's result is known only after its concrete call is selected.
                    if (stored?.dataType?.kind === "function")
                        context.dataTypes.requireFunctionCompletion(
                            stored.dataType,
                            cleanup ? "nonthenable" : "undefined",
                        );
                    context.fail(
                        callback,
                        "Promise reaction with a void result requires a proven undefined completion.",
                    );
                }
                if (cleanup && result.value.kind !== "promise") {
                    this.refuseThenable(result.value, callback);
                    context.emitDiscardedValue(result.value);
                    result.value = { kind: "void", cpp: "" };
                }
                if (neverReturns) {
                    context.emitDiscardedValue(result.value);
                    return;
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
                if (!cleanup && settlement) {
                    settlement = this.retainedSettlement(
                        result.value,
                        settlement,
                        node,
                    );
                    result.value = this.convertResult(
                        result.value,
                        settlement,
                        node,
                    );
                }
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
            ? settlement
                ? settlement.result
                    ? context.dataLowerer.leafValue("", settlement.result)
                    : { kind: "void" as const, cpp: "" }
                : promise.promiseResult!
            : result.value.kind === "promise"
              ? result.value.promiseResult!
              : result.value;
        const cppType = neverReturns
            ? this.cppType(output, node)
            : result.value.kind === "promise"
              ? result.value.promiseType!
              : this.cppType(output, node);
        return {
            cpp: renderClosure(
                compiled,
                cleanup ? "" : `[[maybe_unused]] ${parameterType} ${name}`,
                neverReturns
                    ? cppType
                    : settlement
                      ? result.value.kind === "promise"
                          ? context.dataTypes.cppType(settlement)
                          : settlement.result
                            ? cppType
                            : "void"
                      : undefined,
            ),
            output,
            cppType,
            ...(cleanup && stored
                ? { present: `static_cast<bool>(${stored.cpp})` }
                : {}),
        };
    }

    /** Owned settlement storage, shared by both outcomes when a reaction can recover. */
    private settlementType(
        node: ts.Expression,
        source = this.context.checker.getTypeAtLocation(node),
    ): DataType<"promise"> | undefined {
        const context = this.context;
        const awaited = context.checker.getAwaitedType(source);
        if (!awaited) return undefined;
        if (hasNoValueCompletion(awaited)) return { kind: "promise" };
        const result = context.dataTypes.fromPromiseResultType(awaited, node);
        return result
            ? {
                  kind: "promise",
                  result: context.dataTypes.markStoredObjectReferences(result),
              }
            : undefined;
    }

    /** Contextual result types keep the payload's concrete owner storage. */
    private retainedSettlement(
        value: Value,
        expected: DataType<"promise">,
        node: ts.Node,
    ): DataType<"promise"> {
        return expected.result
            ? {
                  ...expected,
                  result: this.context.dataLowerer.retainedResultType(
                      value.kind === "promise" ? value.promiseResult! : value,
                      expected.result,
                      node,
                  ),
              }
            : expected;
    }

    /** Storage conversion observes a settlement directly; it does not install a Promise reaction. */
    private convertResult(
        value: Value,
        expected: DataType<"promise">,
        node: ts.Node,
    ): Value {
        const context = this.context;
        if (value.kind === "promise")
            return context.dataLowerer.leafValue(
                context.dataLowerer.compileKnownValueForSink(
                    value,
                    expected,
                    node,
                ),
                expected,
            );
        if (!expected.result) {
            context.emitDiscardedValue(value);
            return { kind: "void", cpp: "" };
        }
        if (value.kind === "void") {
            context.emitDiscardedValue(value);
            value = { kind: "json-null", cpp: "std::nullopt" };
        }
        return context.dataLowerer.leafValue(
            context.dataLowerer.compileKnownValueForSink(
                value,
                expected.result,
                node,
            ),
            expected.result,
        );
    }

    private forwardReaction(
        promise: Value,
        expected: DataType<"promise">,
        node: ts.Node,
    ): string {
        const context = this.context;
        const name = context.allocateTemporaryCppName("promise_fulfillment");
        const compiled = context.withOwnedCallbackBody(() =>
            context.captureManagedClosureLines(() => {
                context.registerNativeBindingType(
                    name,
                    `const ${promise.promiseType}`,
                );
                const binding = context.registerNativeBinding(name);
                const value = this.convertResult(
                    this.resultAt(promise.promiseResult!, name, binding),
                    expected,
                    node,
                );
                if (value.kind !== "void")
                    context.emit({
                        kind: "control",
                        code: `return ${this.resultCpp(value, node)};`,
                        transfer: "return",
                    });
            }),
        );
        return renderClosure(
            compiled,
            `[[maybe_unused]] const ${promise.promiseType}& ${name}`,
            expected.result
                ? context.dataTypes.cppType(expected.result)
                : "void",
        );
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
        if (value.dataType?.kind === "handle" && value.dataType.ownedEngine) {
            const owned = {
                ...this.context.dataLowerer.leafValue(cpp, value.dataType),
                nativeCaptures: [binding],
                nativeCompanionCaptures: {
                    engineCpp: [binding],
                    resourceStorageCpp: [binding],
                },
            };
            // The owned storage keeps the handle's plain generation facts.
            return withKindValueFacts(owned, value);
        }
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
                  ...(value.erasedVoidCompletion
                      ? { erasedVoidCompletion: true as const }
                      : {}),
              }
            : value;
    }
    /**
     * The value `Promise.resolve(value)` adopts, in the representation of
     * the promise its context or checked call expects when that differs from the value's
     * own: `Promise.resolve("a")` returned as a `Promise<"a" | "b">`
     * resolves the literal union's enum, not a string.
     */
    private resolvedValue(node: ts.CallExpression): Value {
        const context = this.context;
        const argument = node.arguments[0];
        let value = argument
            ? context.compileValue(argument)
            : { kind: "void" as const, cpp: "" };
        value = this.adoptPromiseUnion(value, argument ?? node) ?? value;
        // Existing promises keep their identity and settlement; only a raw
        // payload needs conversion to its contextual result representation.
        if (value.kind === "promise") return value;
        this.refuseThenable(value, argument ?? node);
        value = this.ownResult(
            value,
            argument ?? node,
            context.checker.getTypeAtLocation(argument ?? node),
        );
        const own =
            value.dataType ??
            (value.kind === "string" ||
            value.kind === "number" ||
            value.kind === "boolean"
                ? { kind: value.kind }
                : undefined);
        const settlement = (
            type: ts.Type | undefined,
        ): DataType | undefined => {
            const awaited =
                type &&
                context.checker.getAwaitedType(
                    // Absence of the promise itself is not absence of its payload.
                    context.checker.getNonNullableType(type),
                );
            return awaited &&
                (awaited.flags &
                    (ts.TypeFlags.Any |
                        ts.TypeFlags.Unknown |
                        ts.TypeFlags.Void |
                        ts.TypeFlags.Undefined)) ===
                    0
                ? context.dataTypes.fromPromiseResultType(awaited, node)
                : undefined;
        };
        const expected =
            settlement(context.checker.getContextualType(node)) ??
            settlement(context.checker.getTypeAtLocation(node));
        if (
            !expected ||
            (own &&
                context.dataTypes.cppType(expected) ===
                    context.dataTypes.cppType(own))
        )
            return value;
        return this.convertResult(
            value,
            this.retainedSettlement(
                value,
                {
                    kind: "promise",
                    result: context.dataTypes.markStoredObjectReferences(
                        expected,
                    ),
                },
                argument ?? node,
            ),
            argument ?? node,
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
        target?: DataType<"promise">,
    ): Value | undefined {
        const type = value.dataType;
        if (
            value.kind !== "data" ||
            (type?.kind !== "optional" && type?.kind !== "union")
        )
            return undefined;
        const presentType = type.kind === "optional" ? type.inner : type;
        const members =
            presentType.kind === "union" ? presentType.members : [presentType];
        const promise = members.find((member) => member.kind === "promise");
        if (!promise) return undefined;
        const context = this.context;
        if (!target) {
            if (type.kind === "optional" && presentType.kind === "promise") {
                const awaited = context.checker.getAwaitedType(source);
                const mapped =
                    awaited && context.dataTypes.fromTsType(awaited, node);
                const result = mapped
                    ? context.dataTypes.markStoredObjectReferences(mapped)
                    : promise.result
                      ? context.dataTypes.nullableType(
                            promise.result,
                            type.undefinedOnly,
                        )
                      : undefined;
                target = { kind: "promise", ...(result ? { result } : {}) };
            } else {
                const settled = members.find((member) => member !== promise);
                if (
                    type.kind !== "union" ||
                    members.length !== 2 ||
                    !promise.result ||
                    !settled ||
                    !dataTypesEqual(promise.result, settled)
                )
                    return undefined;
                target = promise;
            }
        }
        const settlement = target;
        context.useNativeValue(value);
        const cppType = context.dataTypes.cppType(settlement);
        const name = context.allocateTemporaryCppName("promise_input");
        const body = context.captureManagedClosureLines(() => {
            context.registerNativeBinding(name);
            const resolve = (cpp: string, member: DataType): string =>
                this.promiseInput(
                    context.dataLowerer.leafValue(cpp, member),
                    settlement,
                    node,
                    source,
                );
            const emitReturn = (cpp: string): void =>
                context.emit({
                    kind: "control",
                    code: `return ${cpp};`,
                    transfer: "return",
                });
            if (type.kind === "optional") {
                context.emit({
                    kind: "open",
                    code: `if (${optionalPresentCpp(name)}) {`,
                });
                emitReturn(resolve(`(*${name})`, type.inner));
                context.emit({ kind: "close", code: "}" });
                const absent = settlement.result
                    ? context.dataTypes.absentValue(settlement.result)
                    : "bbl::js::PromiseVoid{}";
                emitReturn(`${cppType}::resolved(${absent})`);
                return;
            }
            for (const [index, member] of members.entries()) {
                const guarded = index + 1 < members.length;
                if (guarded)
                    context.emit({
                        kind: "open",
                        code: `if (${name}.index() == ${index}) {`,
                    });
                emitReturn(resolve(`std::get<${index}>(${name})`, member));
                if (guarded) context.emit({ kind: "close", code: "}" });
            }
        });
        return context.dataLowerer.leafValue(
            `(${renderClosure(body, `const ${context.dataTypes.cppType(type)}& ${name}`, cppType)})(${value.cpp})`,
            settlement,
        );
    }

    private asPromise(
        value: Value,
        node: ts.Node,
        source = this.context.checker.getTypeAtLocation(node),
        target?: DataType<"promise">,
    ): Value {
        if (value.kind === "promise") return value;
        const adopted = this.adoptPromiseUnion(value, node, source, target);
        if (adopted) return adopted;
        value = this.normalizeUndefined(value, source);
        this.refuseThenable(value, node, source);
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
            resourceStorageCpp,
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
            resourceStorageCpp: _resource,
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
        ancestors: readonly Value[] = [],
    ): Value {
        if (!value.dataType && ancestors.includes(value))
            return this.context.fail(
                node,
                "Cyclic asynchronous result shapes require represented storage.",
            );
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
                            [...ancestors, value],
                        ),
                ),
            };
        if (
            value.dataType?.kind === "optional" &&
            value.dataType.inner.kind === "handle"
        ) {
            const type: DataType<"optional"> = value.engineCpp
                ? {
                      ...value.dataType,
                      inner: { ...value.dataType.inner, ownedEngine: true },
                  }
                : value.dataType;
            return this.ownOptionalResource(
                value,
                type,
                dataTypesEqual(type, value.dataType)
                    ? (value.ownedCpp ??
                          `bbl::js::snapshot_value(${value.cpp})`)
                    : this.context.dataLowerer.compileKnownValueForSink(
                          value,
                          type,
                          node,
                      ),
            );
        }
        let result =
            (awaited && this.context.dataTypes.fromTsType(awaited, node)) ??
            (value.kind === "record" ? value.dataType : undefined);
        if (
            result?.kind === "optional" &&
            result.inner.kind === "handle" &&
            (value.kind === result.inner.handle ||
                // A scene node slot holds the node kinds its sink converts.
                (result.inner.handle === "scene-node" &&
                    convertsToSceneNode(value.kind)) ||
                value.kind === "json-null" ||
                value.kind === "void")
        ) {
            const type: DataType<"optional"> = value.engineCpp
                ? {
                      ...result,
                      inner: { ...result.inner, ownedEngine: true },
                  }
                : result;
            return this.ownOptionalResource(
                value,
                type,
                this.context.dataLowerer.compileKnownValueForSink(
                    value,
                    type,
                    node,
                ),
            );
        }
        if (isHandleKind(value.kind) && value.kind !== "engine") {
            const checked = ts.isExpression(node)
                ? this.context.checker.getTypeAtLocation(unwrapExpression(node))
                : undefined;
            if (
                presenceFlagCpp(value) !== undefined &&
                presenceFlagCpp(value) !== "true" &&
                !(result?.kind === "handle" && result.handle === value.kind) &&
                !(
                    result?.kind === "struct" &&
                    checked &&
                    !isNullable(checked) &&
                    (checked.flags &
                        (ts.TypeFlags.Any |
                            ts.TypeFlags.Unknown |
                            ts.TypeFlags.TypeParameter)) ===
                        0 &&
                    this.context.dataTypes.nativeRecordViewDemand(
                        result.name,
                        value.dataType ?? {
                            kind: "handle",
                            handle: value.kind,
                        },
                        node,
                    )
                )
            )
                return this.context.fail(
                    node,
                    "Nullable asynchronous resources require a represented payload type.",
                );
            const type: DataType<"handle"> = {
                kind: "handle",
                handle: value.kind,
                ...(value.engineCpp ? { ownedEngine: true } : {}),
            };
            const cpp = this.context.dataLowerer.compileKnownValueForSink(
                value,
                type,
                node,
            );
            // The owned storage keeps the handle's plain generation facts.
            if (type.ownedEngine)
                return withKindValueFacts(
                    this.context.dataLowerer.leafValue(cpp, type),
                    value,
                );
            // A settled owned handle has left its producer's local slot.
            // Nullable results carry their presence in the payload instead.
            return valueForKind(value.kind, {
                ...this.withoutProducerStorage(value),
                cpp,
                dataType: type,
                ...(value.kind === "texture"
                    ? { textureStorage: "stored" as const }
                    : {}),
            });
        }
        if (value.kind === "callback" && !result && value.callbackDeclaration)
            result = this.context.dataLowerer.dataTypeAt(
                value.callbackDeclaration,
            );
        if (value.kind === "callback" && result?.kind === "function") {
            const owned =
                this.context.dataTypes.markStoredObjectReferences(result);
            return this.context.dataLowerer.leafValue(
                this.context.dataLowerer.compileKnownValueForSink(
                    value,
                    owned,
                    node,
                ),
                owned,
            );
        }
        if (value.kind !== "record") return value;
        this.refuseThenable(value, node);
        const properties = awaited
            ? this.context.checker.getPropertiesOfType(awaited)
            : [];
        const declared = new Map(
            properties.map((property) => [property.name, property]),
        );
        const fieldType = (name: string): ts.Type | undefined => {
            const property = declared.get(name);
            return (
                property &&
                this.context.checker.getTypeOfSymbolAtLocation(property, node)
            );
        };
        const recordProperties = { ...value.recordProperties };
        for (const [name, field] of Object.entries(recordProperties)) {
            if (
                field.conditionalOwnKey ||
                value.recordGetters?.[name] ||
                value.recordSetters?.[name]
            )
                continue;
            recordProperties[name] = this.ownResult(
                field,
                node,
                fieldType(name),
                [...ancestors, value],
            );
        }
        value = { ...value, recordProperties };
        if (!result) {
            const names = properties.length
                ? properties.map((property) => property.name)
                : Object.keys(value.recordProperties ?? {});
            const fields: Omit<DataStructField, "name">[] = [];
            for (const name of names) {
                const property = declared.get(name);
                const sourceType = fieldType(name);
                let mapped =
                    sourceType &&
                    this.context.dataTypes.fromSharedReturnType(
                        sourceType,
                        node,
                    );
                const field = recordProperties[name];
                if (!mapped && field && !field.conditionalOwnKey) {
                    mapped = representedResultType(
                        this.context.dataTypes,
                        field,
                    );
                }
                if (
                    !mapped ||
                    field?.conditionalOwnKey ||
                    (property &&
                        (property.flags & ts.SymbolFlags.Optional) !== 0 &&
                        !field)
                )
                    return this.context.fail(
                        node,
                        `Asynchronous result property '${name}' has no owned representation.`,
                    );
                fields.push({
                    sourceName: name,
                    type: mapped,
                    ...(property && propertyIsReadOnly(property)
                        ? { readOnly: true }
                        : {}),
                });
            }
            // A class instance's methods belong to its class; a plain
            // record's own methods and accessors have no owned field.
            if (
                fields.length &&
                (value.classDeclaration ||
                    (Object.keys(value.recordMethods ?? {}).length === 0 &&
                        Object.keys(value.recordGetters ?? {}).length === 0 &&
                        Object.keys(value.recordSetters ?? {}).length === 0))
            ) {
                result = this.context.dataTypes.ownedRecordType(fields);
                value = { ...value, recordProperties };
            }
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
    /**
     * The one resolution entry point every settled value passes before its
     * conversion: resolution reads a custom thenable's `then` (a method,
     * getter, callable property or accessor field) and calls it when
     * callable. A data `then` that is not a function is read unobservably.
     */
    refuseThenable(
        value: Value | undefined,
        node: ts.Node,
        source?: ts.Type,
    ): void {
        const property = value?.recordProperties?.then;
        const somePresentStorage = (
            type: DataType | undefined,
            matches: (member: DataType) => boolean,
        ): boolean => {
            if (!type) return false;
            if (type.kind === "optional" || type.kind === "tagged")
                return somePresentStorage(type.inner, matches);
            if (type.kind === "union")
                return type.members.some((member) =>
                    somePresentStorage(member, matches),
                );
            return matches(type);
        };
        const storedCallable = (type: DataType | undefined): boolean =>
            somePresentStorage(
                type,
                (member) =>
                    member.kind === "function" ||
                    (member.kind === "struct" &&
                        this.context.dataTypes.structCall(member.name) !==
                            undefined),
            );
        const storedThenable = somePresentStorage(value?.dataType, (member) => {
            if (member.kind !== "struct") return false;
            const field = this.context.dataTypes.findStructField(
                member.name,
                "then",
                node,
            );
            return !!field?.accessor || storedCallable(field?.type);
        });
        const customThen = (type: ts.Type): boolean => {
            const resolved = this.context.dataTypes.resolveTypeParameter(type);
            if (resolved.isUnion()) return resolved.types.some(customThen);
            const then = resolved.getProperty("then");
            if (!then) return false;
            const parts = resolved.isIntersection()
                ? resolved.types
                : [resolved];
            if (
                parts.some(
                    (part) =>
                        part.symbol?.name === "Promise" &&
                        declaredInDefaultLibrary(part.symbol),
                ) &&
                then.declarations?.every(declarationInDefaultLibrary)
            )
                return false;
            const propertyType = this.context.checker.getNonNullableType(
                this.context.checker.getTypeOfSymbolAtLocation(then, node),
            );
            return (
                then.declarations?.some((declaration) =>
                    ts.isGetAccessorDeclaration(declaration),
                ) === true ||
                (propertyType.isUnion()
                    ? propertyType.types
                    : [propertyType]
                ).some((member) => member.getCallSignatures().length > 0)
            );
        };
        const customResult = (source: ts.Node): boolean => {
            if (!ts.isExpression(source))
                return customThen(
                    this.context.checker.getTypeAtLocation(source),
                );
            const expression = unwrapExpression(source);
            if (ts.isConditionalExpression(expression))
                return (
                    customResult(expression.whenTrue) ||
                    customResult(expression.whenFalse)
                );
            if (ts.isBinaryExpression(expression)) {
                switch (expression.operatorToken.kind) {
                    case ts.SyntaxKind.CommaToken:
                    case ts.SyntaxKind.AmpersandAmpersandToken:
                        return customResult(expression.right);
                    case ts.SyntaxKind.BarBarToken:
                    case ts.SyntaxKind.QuestionQuestionToken:
                        return (
                            customResult(expression.left) ||
                            customResult(expression.right)
                        );
                }
            }
            return customThen(
                this.context.checker.getTypeAtLocation(expression),
            );
        };
        if (
            value?.recordMethods?.then ||
            value?.recordGetters?.then ||
            property?.kind === "callback" ||
            storedCallable(property?.dataType) ||
            storedThenable ||
            (source ? customThen(source) : customResult(node))
        )
            this.context.fail(
                node,
                "Custom thenable assimilation requires an owned promise resolution protocol.",
            );
    }
    private resultCpp(value: Value, node: ts.Node): string {
        this.context.dataLowerer.markEscaped(value);
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
