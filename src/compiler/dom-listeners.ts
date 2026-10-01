import ts from "typescript";
import { declaredInDefaultLibrary } from "./symbols.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { documentEngine } from "./window-events.js";
import { compileBooleanOptions } from "./option-helpers.js";

type Context = Pick<
    LoweringServices,
    | "options"
    | "defaultEngine"
    | "checker"
    | "unwrap"
    | "libraryGlobal"
    | "isCanvasElement"
    | "reachFeature"
    | "fail"
    | "requireDefaultEngine"
    | "requireEngine"
    | "allocateTemporaryCppName"
    | "compileValue"
    | "conditions"
    | "compileStringLiteral"
    | "dataLowerer"
    | "dataTypes"
    | "callbacks"
    | "bindings"
    | "cppString"
    | "emit"
    | "emitDiscardedValue"
>;

const pointerNames = new Set([
    "click",
    "dblclick",
    "mousedown",
    "mouseup",
    "mousemove",
    "mouseover",
    "mouseout",
    "mouseenter",
    "mouseleave",
    "pointerdown",
    "pointerup",
    "pointermove",
    "pointerover",
    "pointerout",
    "pointerenter",
    "pointerleave",
    "pointercancel",
    "gotpointercapture",
    "lostpointercapture",
    "wheel",
    "focus",
    "blur",
    "contextmenu",
    "resize",
]);

const serviceNames = new Set([
    "change",
    "input",
    "error",
    "unhandledrejection",
    "rejectionhandled",
    "visibilitychange",
    "pointerlockchange",
    "load",
    "DOMContentLoaded",
    "gamepadconnected",
    "gamepaddisconnected",
    "touchstart",
    "touchmove",
    "touchend",
    "touchcancel",
    "animationstart",
    "animationend",
    "animationiteration",
    "animationcancel",
]);

/** These names already carry a distinct native payload/service contract. */
export function isCustomDomEventName(type: string): boolean {
    return (
        !pointerNames.has(type) &&
        !serviceNames.has(type) &&
        type !== "keydown" &&
        type !== "keyup" &&
        type !== "pagehide"
    );
}

export function listenerOptions(
    context: Pick<
        Context,
        | "unwrap"
        | "checker"
        | "conditions"
        | "compileValue"
        | "allocateTemporaryCppName"
        | "emit"
        | "emitDiscardedValue"
        | "dataTypes"
        | "dataLowerer"
        | "fail"
    >,
    expression: ts.Expression | undefined,
    removing: boolean,
): { capture: string; once: string; passive: string } {
    const result = { capture: "false", once: "false", passive: "false" };
    if (!expression) return result;
    if (
        (context.checker.getTypeAtLocation(expression).flags &
            ts.TypeFlags.BooleanLike) !==
        0
    ) {
        result.capture = context.conditions.compileCondition(expression);
        return result;
    }
    return {
        ...result,
        ...compileBooleanOptions(
            context,
            context.dataLowerer,
            expression,
            removing
                ? (["capture"] as const)
                : (["capture", "once", "passive"] as const),
            {
                subject: "Event listener options",
                member: "event option",
                forms: "a boolean or a represented options record",
                temporary: "event_option",
                ...(removing
                    ? {}
                    : {
                          refused: {
                              signal: "AbortSignal listener lifetime is not represented yet.",
                          },
                      }),
            },
        ),
    };
}

function pinDetached(
    context: Pick<Context, "bindings">,
    value: Value,
    label: string,
    node: ts.Expression,
): Value {
    const snapshot = { ...value };
    delete snapshot.nativeBinding;
    return context.bindings.pinValueToTemporary(snapshot, label, node);
}

/** One listener path for native DOM identities; error/visibility/file services
 * retain their own payloads until they join this dispatch contract. */
export function emitDomEventListener(
    context: Context,
    call: ts.CallExpression,
    element: Value | undefined,
    callbackIdentity: (value: Value, node: ts.Node) => string,
): boolean {
    const callee = context.unwrap(call.expression);
    if (
        !ts.isPropertyAccessExpression(callee) ||
        call.arguments.length < 2 ||
        call.arguments.length > 3
    )
        return false;
    const type = context.compileStringLiteral(call.arguments[0]!);
    const pagehide = type === "pagehide";
    if (pagehide && !context.options.workers) {
        context.fail(
            call,
            "Page lifecycle listeners require an asynchronous Window application realm.",
        );
    }
    let target: string | undefined;
    let engine: string | undefined;
    if (element) {
        engine = context.requireEngine(element, call);
        const owner = pinDetached(
            context,
            element,
            "event_target",
            callee.expression,
        );
        target = `bbl::DomEventTarget::node(${owner.cpp}.value)`;
    } else {
        let global = context.libraryGlobal(callee.expression);
        if (!global) {
            const type = context.checker.getNonNullableType(
                context.checker.getTypeAtLocation(callee.expression),
            );
            const symbol = type.getSymbol();
            if (
                symbol &&
                declaredInDefaultLibrary(symbol) &&
                symbol.name === "Document"
            )
                global = "document";
        }
        if (global === "window" || global === "document") {
            target = `bbl::DomEventTarget::${global}()`;
            engine =
                documentEngine(context, call) ??
                context.requireDefaultEngine(call);
        } else if (context.isCanvasElement(callee.expression)) {
            target = "bbl::DomEventTarget::canvas()";
            engine = context.requireDefaultEngine(call);
        } else {
            const type = context.dataLowerer.dataTypeAt(callee.expression);
            if (type?.kind === "event-target") {
                const value = context.dataLowerer.narrowOptional(
                    context.compileValue(callee.expression),
                    callee.expression,
                );
                if (value.dataType?.kind !== "event-target")
                    context.fail(
                        callee.expression,
                        "Nullable event targets require a presence guard.",
                    );
                const snapshot = pinDetached(
                    context,
                    value,
                    "event_target",
                    callee.expression,
                );
                target = `${snapshot.cpp}.target`;
                engine = `bbl::dom_target_owner(${snapshot.cpp})`;
            }
        }
    }
    if (!target || !engine) return false;
    if (pagehide && target !== "bbl::DomEventTarget::window()") {
        context.fail(
            call,
            "Page lifecycle listeners require an asynchronous Window application realm.",
        );
    }
    if (
        (type === "resize" && target !== "bbl::DomEventTarget::window()") ||
        ((type === "focus" || type === "blur") &&
            (target === "bbl::DomEventTarget::document()" ||
                target === "bbl::DomEventTarget::canvas()"))
    )
        return false;
    const keyboard = type === "keydown" || type === "keyup";
    const custom = isCustomDomEventName(type);
    if (!keyboard && !pagehide && !pointerNames.has(type) && !custom)
        return false;
    if (
        custom &&
        target !== "bbl::DomEventTarget::window()" &&
        target !== "bbl::DomEventTarget::document()"
    )
        context.fail(
            call,
            "Custom event listeners require a Document or Window target.",
        );
    context.reachFeature("input:dom", call);
    if (custom) context.reachFeature("data:json", call);
    const callback = call.arguments[1]!;
    context.callbacks.hoistForwardCallbackBindings(callback, call.pos);
    const removing = callee.name.text === "removeEventListener";
    const family = custom ? "custom" : keyboard ? "keyboard" : "pointer";
    let identity: string;
    let listener: string | undefined;
    if (removing) {
        const value = context.compileValue(callback);
        const pinned =
            value.kind === "data"
                ? pinDetached(context, value, "event_callback", callback)
                : value;
        identity = callbackIdentity(pinned, callback);
    } else {
        const name = context.allocateTemporaryCppName("dom_event");
        const compiled = context.callbacks.compilePlatformCallback(
            callback,
            {
                cppType: custom
                    ? "const bbl::PlatformCustomEvent&"
                    : keyboard
                      ? "const bbl::PlatformKeyboardEvent&"
                      : "const bbl::PlatformMouseEvent&",
                name,
            },
            [
                {
                    kind: custom
                        ? "custom-event"
                        : keyboard
                          ? "platform-keyboard-event"
                          : "platform-mouse-event",
                    cpp: name,
                    readOnly: true,
                    engineCpp: engine,
                    ...(custom
                        ? {
                              dataType: {
                                  kind: "handle" as const,
                                  handle: "custom-event" as const,
                              },
                          }
                        : {}),
                },
            ],
        );
        identity = compiled.identity;
        listener = compiled.cpp;
    }
    const options = listenerOptions(context, call.arguments[2], removing);
    context.emit({
        kind: "expression",
        code:
            `bbl::${removing ? "off" : "on"}_dom_${family}(${engine}, ${target}, ${context.cppString(type)}, ${identity}, ` +
            `${removing ? options.capture : `${listener}, ${options.capture}, ${options.once}, ${options.passive}`});`,
    });
    return true;
}
