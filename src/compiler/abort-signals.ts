import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import {
    listenerAddition,
    listenerOptions,
    signalListener,
} from "./dom-listeners.js";
import { authoredErrorBase, errorValue } from "./error-values.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { libraryName } from "./symbols.js";
import { callSignatures } from "./type-facts.js";

/**
 * AbortController, AbortSignal and DOMException as realm-owned native
 * values (`bblite/js_abort.hpp`): construction, state reads, `abort`,
 * `throwIfAborted` and the signal's `abort` listeners.
 */

const ABORT_SIGNAL = { kind: "abort-signal" } as const;
const ABORT_CONTROLLER = { kind: "abort-controller" } as const;

/** `new AbortController()` and `new DOMException(message?, name?)`. */
export function compileAbortNew(
    lowerer: DataLowerer,
    node: ts.NewExpression,
): Value | undefined {
    const context = lowerer.context;
    const name = context.libraryGlobal(node.expression);
    const arguments_ = node.arguments ?? [];
    if (name === "AbortController") {
        if (arguments_.length !== 0)
            return context.fail(
                node,
                "new AbortController takes no arguments.",
            );
        context.reachJsData();
        return {
            ...lowerer.leafValue(
                "bbl::js::AbortController::create()",
                ABORT_CONTROLLER,
            ),
            impure: true,
        };
    }
    if (name === "AbortSignal")
        return context.fail(node, "AbortSignal has no public constructor.");
    if (name !== "DOMException") return undefined;
    if (arguments_.length > 2)
        return context.fail(
            node,
            "new DOMException takes a message and a name.",
        );
    context.reachJsData();
    // Each argument converts to a string in order, then the exception is built.
    const [message, errorName] = [0, 1].map((index) => {
        const argument = arguments_[index];
        const fallback = index === 0 ? "" : "Error";
        if (!argument)
            return {
                kind: "string" as const,
                cpp: context.cppString(fallback),
                staticString: fallback,
            };
        const value = context.compileValue(argument);
        if (value.kind === "json-null" && value.cpp === "std::nullopt") {
            context.emitDiscardedValue(value);
            return {
                kind: "string" as const,
                cpp: context.cppString(fallback),
                staticString: fallback,
            };
        }
        const cpp = context.allocateTemporaryCppName("dom_exception_text");
        context.emit({
            kind: "declaration",
            type: "const std::string",
            name: cpp,
            initializer: lowerer.compileKnownValueForSink(
                value,
                { kind: "string" },
                argument,
            ),
        });
        return { kind: "string" as const, cpp };
    }) as [Value, Value];
    const base = lowerer.leafValue(
        `bbl::js::Error(bbl::js::dom_exception_error(${message.cpp}, ${errorName.cpp}))`,
        { kind: "error" },
    );
    if (base.kind !== "data") return base;
    return {
        ...errorValue(
            message,
            errorName.staticString ?? "",
            context.cppString,
            {
                ...base,
            },
        ),
        impure: true,
    };
}

/**
 * `instanceof DOMException`: only the DOMException constructor and platform
 * operations create one, so an authored Error is never an instance.
 */
export function domExceptionInstanceOf(
    context: Pick<LoweringServices, "dataTypes" | "emitDiscardedValue">,
    value: Value,
): string | undefined {
    if (authoredErrorBase(context, value)) {
        context.emitDiscardedValue(value);
        return "false";
    }
    if (value.dataType?.kind === "error")
        return `bbl::js::error_is(${value.cpp}, "DOMException")`;
    if (value.nativeError) {
        context.emitDiscardedValue(value);
        return "false";
    }
    return undefined;
}

/** `controller.signal`, `signal.aborted` and `signal.reason`. */
export function abortProperty(
    lowerer: DataLowerer,
    owner: Value,
    property: string,
): Value | undefined {
    const kind = owner.dataType?.kind;
    if (kind === "abort-controller" && property === "signal")
        return lowerer.leafValue(`(${owner.cpp}).signal()`, ABORT_SIGNAL);
    if (kind !== "abort-signal") return undefined;
    if (property === "aborted")
        return lowerer.leafValue(`(${owner.cpp}).aborted()`, {
            kind: "boolean",
        });
    if (property === "reason")
        return lowerer.leafValue(`(${owner.cpp}).reason()`, {
            kind: "optional",
            undefinedOnly: true,
            inner: { kind: "error" },
        });
    return undefined;
}

/** `controller.abort(reason?)` and `signal.throwIfAborted()`. */
export function compileAbortMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value {
    const context = lowerer.context;
    const receiver = context.bindings.pinValueToTemporary(
        owner,
        "abort_receiver",
    );
    if (owner.dataType?.kind === "abort-controller") {
        if (method !== "abort")
            return context.fail(
                call,
                `AbortController.${method} is not lowered.`,
            );
        context.expectArgumentCount(call, 0, 1);
        const reason = call.arguments[0];
        if (!reason) return { kind: "void", cpp: `(${receiver.cpp}).abort()` };
        const value = context.compileValue(reason);
        if (
            (value.kind === "json-null" && value.cpp === "std::nullopt") ||
            value.dataType?.kind === "undefined"
        ) {
            context.emitDiscardedValue(value);
            return { kind: "void", cpp: `(${receiver.cpp}).abort()` };
        }
        if (
            !value.nativeError &&
            value.dataType?.kind !== "error" &&
            !authoredErrorBase(context, value)
        )
            return context.fail(
                reason,
                "AbortController.abort lowers an Error reason; other reason values are not represented.",
            );
        return {
            kind: "void",
            cpp: `(${receiver.cpp}).abort(${lowerer.compileKnownValueForSink(value, { kind: "error" }, reason)})`,
        };
    }
    if (method === "throwIfAborted") {
        context.expectArgumentCount(call, 0, 0);
        return { kind: "void", cpp: `(${receiver.cpp}).throw_if_aborted()` };
    }
    return context.fail(call, `AbortSignal.${method} is not lowered.`);
}

/** What the listener and global platform calls read from the lowering services. */
export type WebPlatformCallContext = Pick<
    LoweringServices,
    | "allocateTemporaryCppName"
    | "bindings"
    | "callbacks"
    | "checker"
    | "compileStringLiteral"
    | "compileValue"
    | "conditions"
    | "cppString"
    | "dataLowerer"
    | "dataTypes"
    | "emit"
    | "emitDiscardedValue"
    | "expectArgumentCount"
    | "fail"
    | "libraryGlobal"
    | "options"
    | "probeEmission"
    | "reachFeature"
    | "reachJsData"
    | "unwrap"
>;

/**
 * `signal.addEventListener("abort", listener, options)` and its removal. A
 * listener takes no event: one that declares a parameter refuses.
 */
export function compileAbortListenerCall(
    context: WebPlatformCallContext,
    call: ts.CallExpression,
): Value | undefined {
    const callee = context.unwrap(call.expression);
    if (
        !ts.isPropertyAccessExpression(callee) ||
        (callee.name.text !== "addEventListener" &&
            callee.name.text !== "removeEventListener")
    )
        return undefined;
    const receiverType = context.checker.getTypeAtLocation(callee.expression);
    if (libraryName(receiverType) !== "AbortSignal") return undefined;
    const owner = context.dataLowerer.narrowOptional(
        context.compileValue(callee.expression),
        callee.expression,
    );
    if (owner.dataType?.kind !== "abort-signal")
        return context.fail(
            callee.expression,
            "AbortSignal listeners require a represented AbortSignal.",
        );
    const receiver = context.bindings.pinValueToTemporary(
        owner,
        "abort_receiver",
    );
    context.expectArgumentCount(call, 2, 3);
    if (context.compileStringLiteral(call.arguments[0]!) !== "abort")
        return context.fail(
            call.arguments[0]!,
            "An AbortSignal dispatches only 'abort' events.",
        );
    const callback = call.arguments[1]!;
    const signature = callSignatures(
        context.checker,
        context.checker.getTypeAtLocation(callback),
        "exact",
    )[0];
    if (signature && signature.getParameters().length > 0)
        return context.fail(
            callback,
            "AbortSignal 'abort' listeners that take the event are not lowered.",
        );
    context.callbacks.hoistForwardCallbackBindings(callback);
    if (callee.name.text === "removeEventListener") {
        const identity = context.callbacks.platformEventCallbackIdentity(
            context.compileValue(callback),
            callback,
        );
        const options = listenerOptions(context, call.arguments[2], true);
        return {
            kind: "void",
            cpp: `(${receiver.cpp}).remove_abort_listener(${identity}, ${options.capture})`,
        };
    }
    const compiled = context.callbacks.compilePlatformCallback(
        callback,
        undefined,
        [],
    );
    const { listener, options } = signalListener(
        context,
        call.arguments[2],
        compiled.cpp,
    );
    return {
        kind: "void",
        cpp: listenerAddition(
            options.signal,
            (lease) =>
                `(${receiver.cpp}).add_abort_listener(${compiled.identity}, ${listener}, ${options.once}, ${options.capture}${lease})`,
        ),
    };
}
