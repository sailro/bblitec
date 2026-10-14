import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
import { IDLE_FUNCTIONS } from "./dom-lowerings.js";
import { pinDetached } from "./dom-listeners.js";
import type { LoweringServices } from "./lowering-services.js";
import { nativeFunctionValue } from "./native-function-values.js";
import {
    compileBooleanOptions,
    optionalOptionMember,
    optionalOptionValue,
} from "./option-helpers.js";
import { declaredInDomLibrary, resolvedSymbol } from "./symbols.js";
import { optionalPresentCpp, type Value } from "./types.js";
import { compileWindowMemberCall, isWindowReceiver } from "./window-members.js";
import { requireWindowHost } from "./window-events.js";
import { nativeWindowMember } from "./window-properties.js";
import { timerCancellation } from "./workers.js";

/**
 * `requestIdleCallback`, `cancelIdleCallback` and the IdleDeadline
 * (`bblite/pal_idle_callbacks.hpp` over the realm event loop): direct calls,
 * Window function values and their stored aliases, `timeRemaining()` and
 * `didTimeout`.
 */

type IdleFunction = (typeof IDLE_FUNCTIONS)[number];

const IDLE_CALLBACK: DataType = {
    kind: "function",
    parameters: [{ kind: "idle-deadline" }],
};

function isIdleFunction(name: string | undefined): name is IdleFunction {
    return IDLE_FUNCTIONS.some((candidate) => candidate === name);
}

/** Idle callbacks are a Window's: they need its Window host. */
function requireIdleRealm(
    context: Pick<LoweringServices, "options" | "reachFeature" | "fail">,
    node: ts.Node,
): void {
    requireWindowHost(context, node);
    context.reachFeature("platform:idle-callbacks", node);
}

/** The Window's own idle function a read names, through an authored view of Window too. */
export function idleWindowFunctionSymbol(
    checker: ts.TypeChecker,
    node: ts.Expression,
): ts.Symbol | undefined {
    const symbol = ts.isPropertyAccessExpression(node)
        ? nativeWindowMember(checker, node)
        : resolvedSymbol(checker, node);
    if (
        !symbol ||
        !isIdleFunction(symbol.name) ||
        !declaredInDomLibrary(symbol)
    )
        return undefined;
    const window = checker.resolveName(
        "Window",
        undefined,
        ts.SymbolFlags.Type,
        false,
    );
    return window
        ? checker.getPropertyOfType(
              checker.getDeclaredTypeOfSymbol(window),
              symbol.name,
          )
        : undefined;
}

/** The `timeout` member of IdleRequestOptions, as `double` milliseconds (0 when absent). */
function compileTimeout(
    lowerer: DataLowerer,
    options: ts.Expression | undefined,
): string {
    let timeout = "0.0";
    if (!options) return timeout;
    compileBooleanOptions(lowerer.context, lowerer, options, [], {
        subject: "Idle request options",
        member: "idle request option",
        forms: "a represented options record",
        temporary: "idle_option",
        consume: {
            timeout: (value, present) => {
                timeout = optionalOptionValue(
                    optionalOptionMember(
                        lowerer,
                        value,
                        present,
                        { kind: "number" },
                        "idle_timeout",
                        options,
                    ),
                    "0.0",
                );
            },
        },
    });
    return timeout;
}

/** `requestIdleCallback(callback, options)` and `cancelIdleCallback(handle)` calls. */
export function compileIdleCallbackCall(
    lowerer: DataLowerer,
    call: ts.CallExpression,
): Value | undefined {
    const context = lowerer.context;
    return compileWindowMemberCall(lowerer, call, IDLE_FUNCTIONS, (name) => {
        requireIdleRealm(context, call);
        if (name === "cancelIdleCallback") {
            context.expectArgumentCount(call, 1, 1);
            return {
                kind: "void",
                cpp: timerCancellation(
                    context,
                    call.arguments[0]!,
                    (handle) => `bbl::pal::cancel_idle_callback(${handle})`,
                ),
            };
        }
        context.expectArgumentCount(call, 1, 2);
        const callback = context.allocateTemporaryCppName("idle_callback");
        context.emit({
            kind: "declaration",
            type: "auto",
            name: callback,
            initializer: lowerer.compileForSink(
                call.arguments[0]!,
                IDLE_CALLBACK,
            ),
        });
        const timeout = compileTimeout(lowerer, call.arguments[1]);
        return {
            kind: "number",
            cpp: `bbl::pal::request_idle_callback(std::move(${callback}), ${timeout})`,
            impure: true,
        };
    });
}

type FunctionValueContext = Pick<
    LoweringServices,
    | "checker"
    | "options"
    | "compileValue"
    | "dataTypes"
    | "dataLowerer"
    | "emitDiscardedValue"
    | "fail"
    | "unwrap"
    | "libraryGlobal"
    | "bindings"
    | "probeEmission"
    | "callbackIdentity"
    | "reachJsData"
    | "reachFeature"
>;

/** Milliseconds a stored options parameter `cpp` carries in `timeout`. */
function storedTimeout(
    context: FunctionValueContext,
    node: ts.Node,
    type: DataType | undefined,
    cpp: string,
): string {
    if (!type || type.kind === "undefined") return "0.0";
    const optional = type.kind === "optional";
    const record = optional ? type.inner : type;
    if (record.kind !== "struct")
        return context.fail(
            node,
            "Idle request options require a represented options record.",
        );
    const reference = context.dataTypes.isReferenceStruct(record.name);
    const field = context.dataTypes
        .structFields(record.name, node)
        .find((candidate) => candidate.sourceName === "timeout");
    if (!field) return "0.0";
    const read = `${optional ? `(*${cpp})` : cpp}${reference ? "->" : "."}${field.name}`;
    const value =
        field.type.kind === "number"
            ? read
            : field.type.kind === "optional" &&
                field.type.inner.kind === "number"
              ? `(${optionalPresentCpp(read)} ? *${read} : 0.0)`
              : context.fail(node, "An idle request timeout must be a number.");
    const present = optional
        ? optionalPresentCpp(cpp)
        : reference
          ? `static_cast<bool>(${cpp})`
          : undefined;
    return present ? `(${present} ? ${value} : 0.0)` : value;
}

/** The native body of a stored idle function, over its declared signature. */
function storedFunctionBody(
    context: FunctionValueContext,
    node: ts.Expression,
    name: IdleFunction,
    type: DataType<"function">,
): string {
    const result = type.result;
    if (name === "cancelIdleCallback") {
        const [handle, ...rest] = type.parameters;
        const cancel = (cpp: string): string =>
            `bbl::pal::cancel_idle_callback(${cpp});`;
        if (rest.length > 0 || (result && result.kind !== "undefined"))
            return context.fail(
                node,
                "cancelIdleCallback values take one handle and return nothing.",
            );
        if (handle?.kind === "number") return cancel("argument_0");
        if (handle?.kind === "optional" && handle.inner.kind === "number")
            return `if (${optionalPresentCpp("argument_0")}) ${cancel("*argument_0")}`;
        return context.fail(
            node,
            "A cancelIdleCallback value requires a numeric handle.",
        );
    }
    const [callback, options, ...rest] = type.parameters;
    if (
        rest.length > 0 ||
        callback?.kind !== "function" ||
        callback.parameters.length > 1 ||
        (callback.parameters[0] &&
            callback.parameters[0].kind !== "idle-deadline")
    )
        return context.fail(
            node,
            "A requestIdleCallback value takes a callback of an IdleDeadline or of nothing, and options.",
        );
    const request = `bbl::pal::request_idle_callback(std::move(argument_0), ${storedTimeout(context, node, options, "argument_1")})`;
    if (result?.kind === "number") return `return ${request};`;
    if (!result || result.kind === "undefined")
        return `static_cast<void>(${request});`;
    return context.fail(
        node,
        "A requestIdleCallback value returns its numeric handle.",
    );
}

/** Window idle functions as values (`typeof`, aliases, `window.requestIdleCallback`). */
export function idleFunctionValue(
    context: FunctionValueContext,
    node: ts.Expression,
): Value | undefined {
    const property = ts.isPropertyAccessExpression(node) ? node : undefined;
    const name = property?.name.text ?? context.libraryGlobal(node);
    if (!isIdleFunction(name)) return undefined;
    const symbol = idleWindowFunctionSymbol(context.checker, node);
    if (!symbol) return undefined;
    if (property) {
        const owner = context.probeEmission(() => {
            const value = context.compileValue(property.expression);
            return value.domEventTargetCpp ===
                "bbl::DomEventTarget::window()" ||
                value.dataType?.kind === "event-target"
                ? value
                : undefined;
        });
        if (!owner) return undefined;
        if (!isWindowReceiver(context, owner, property.expression))
            return context.fail(
                property.expression,
                `Window member '${name}' requires a proven Window receiver.`,
            );
        context.emitDiscardedValue(
            pinDetached(context, owner, "idle_owner", property.expression),
        );
    }
    requireIdleRealm(context, node);
    let sourceType = context.checker.getNonNullableType(
        context.checker.getTypeAtLocation(node),
    );
    const signatures = sourceType.getCallSignatures();
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    // An overloaded library intersection of one signature reads as that signature.
    if (
        sourceType.isIntersection() &&
        signatures.length > 0 &&
        declaration &&
        signatures.every(
            (signature) =>
                context.checker.signatureToString(signature) ===
                context.checker.signatureToString(signatures[0]!),
        )
    )
        sourceType = context.checker.getTypeAtLocation(declaration);
    const type = context.dataTypes.fromStoredTsType(sourceType, node);
    if (type?.kind !== "function")
        return context.fail(
            node,
            "Idle callback functions require an owned callable signature.",
        );
    return nativeFunctionValue(
        context,
        node,
        { ...type, identity: true },
        storedFunctionBody(context, node, name, type),
        declaration,
    );
}

/** `deadline.didTimeout`. */
export function idleDeadlineProperty(
    lowerer: DataLowerer,
    owner: Value,
    property: string,
): Value | undefined {
    return owner.dataType?.kind === "idle-deadline" && property === "didTimeout"
        ? lowerer.leafValue(`(${owner.cpp})->did_timeout`, {
              kind: "boolean",
          })
        : undefined;
}

/** `deadline.timeRemaining()`: milliseconds left in the idle period, read now. */
export function compileIdleDeadlineMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value | undefined {
    if (method !== "timeRemaining") return undefined;
    lowerer.context.expectArgumentCount(call, 0, 0);
    return {
        ...lowerer.leafValue(`(${owner.cpp})->time_remaining()`, {
            kind: "number",
        }),
        impure: true,
    };
}
