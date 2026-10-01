import ts from "typescript";
import { declaredInDefaultLibrary } from "./symbols.js";
import type { LoweringServices } from "./lowering-services.js";
import { valueForKind, type Value } from "./types.js";
import { domTargetIdentity } from "./dom-targets.js";
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
    "dragstart",
    "drag",
    "dragend",
]);

const dragNames = new Set(["dragenter", "dragover", "dragleave", "drop"]);

const keyboardNames = new Set(["keydown", "keyup"]);

/** CSS transition events the UI projection sources. */
const transitionNames = new Set(["transitionend"]);

/** These names already carry a distinct native payload/service contract. */
export function isCustomDomEventName(type: string): boolean {
    return (
        !pointerNames.has(type) &&
        !serviceNames.has(type) &&
        !keyboardNames.has(type) &&
        !transitionNames.has(type) &&
        !dragNames.has(type) &&
        type !== "pagehide"
    );
}

type DomListenerFamily =
    "custom" | "keyboard" | "pointer" | "transition" | "drag";

/** The shared dispatch family a DOM event name joins, if any. */
function domListenerFamily(type: string): DomListenerFamily | undefined {
    if (keyboardNames.has(type)) return "keyboard";
    if (pointerNames.has(type)) return "pointer";
    if (transitionNames.has(type)) return "transition";
    if (dragNames.has(type)) return "drag";
    return isCustomDomEventName(type) ? "custom" : undefined;
}

/** The DOM listener family an element `on<type>` handler joins, if any. */
export function elementDomHandlerFamily(
    type: string,
): "keyboard" | "pointer" | "drag" | undefined {
    const family = domListenerFamily(type);
    return family === "custom" || family === "transition" || type === "resize"
        ? undefined
        : family;
}

/** Each family's borrowed event view. */
const DOM_CALLBACK_EVENTS = {
    custom: {
        cppType: "const bbl::PlatformCustomEvent&",
        kind: "custom-event",
    },
    keyboard: {
        cppType: "const bbl::PlatformKeyboardEvent&",
        kind: "platform-keyboard-event",
    },
    pointer: {
        cppType: "const bbl::PlatformMouseEvent&",
        kind: "platform-mouse-event",
    },
    drag: {
        cppType: "const bbl::PlatformDragEvent&",
        kind: "platform-mouse-event",
    },
    // Read through the base Event view; TransitionEvent adds propertyName.
    transition: {
        cppType: "const bbl::PlatformTransitionEvent&",
        kind: "platform-mouse-event",
    },
} as const;

/**
 * HTML's event handler processing: a handler that returns false cancels
 * its event. Other results are discarded; a result that may be false
 * without a boolean representation refuses.
 */
export function eventHandlerResult(
    context: Pick<Context, "emit" | "emitDiscardedValue" | "fail">,
    eventCpp: string,
    site: ts.Node,
): (result: Value) => void {
    return (result) => {
        const type = result.dataType;
        const inner = type?.kind === "optional" ? type.inner : type;
        if (result.kind === "boolean" || inner?.kind === "boolean") {
            context.emit({
                kind: "open",
                code: `if ((${result.cpp}) == false) {`,
            });
            context.emit({
                kind: "expression",
                code: `${eventCpp}.prevent_default();`,
            });
            context.emit({ kind: "close", code: "}" });
            return;
        }
        if (inner?.kind === "json")
            context.fail(
                site,
                "An event handler result that may be false requires a boolean representation.",
            );
        context.emitDiscardedValue(result);
    };
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

function compileDomCallback(
    context: Pick<
        Context,
        | "allocateTemporaryCppName"
        | "callbacks"
        | "emit"
        | "emitDiscardedValue"
        | "fail"
    >,
    callback: ts.Expression,
    family: DomListenerFamily,
    engine: string,
    handler = false,
): { cpp: string; identity: string } {
    const name = context.allocateTemporaryCppName("dom_event");
    const event = DOM_CALLBACK_EVENTS[family];
    return context.callbacks.compilePlatformCallback(
        callback,
        { cppType: event.cppType, name },
        [
            family === "transition" || family === "drag"
                ? valueForKind("platform-mouse-event", {
                      cpp: `bbl::js::BorrowedEvent(${name})`,
                      readOnly: true,
                      engineCpp: engine,
                      platformEventBase: true,
                  })
                : {
                      kind: event.kind,
                      cpp: name,
                      readOnly: true,
                      engineCpp: engine,
                      ...(family === "custom"
                          ? {
                                dataType: {
                                    kind: "handle" as const,
                                    handle: "custom-event" as const,
                                },
                            }
                          : {}),
                  },
        ],
        undefined,
        true,
        true,
        handler ? eventHandlerResult(context, name, callback) : undefined,
    );
}

/**
 * `element.on<type> = handler` for the shared dispatch families: the HTML
 * event handler, one non-capture listener per target and type whose
 * callback a later assignment replaces in place and `null` removes.
 */
export function emitDomEventHandler(
    context: Pick<
        Context,
        | "requireEngine"
        | "bindings"
        | "reachFeature"
        | "allocateTemporaryCppName"
        | "callbacks"
        | "emit"
        | "emitDiscardedValue"
        | "fail"
        | "cppString"
    >,
    element: Value,
    family: "keyboard" | "pointer" | "drag",
    type: string,
    handler: ts.Expression | undefined,
    site: ts.Expression,
): void {
    const engine = context.requireEngine(element, site);
    const owner = pinDetached(context, element, "event_target", site);
    context.reachFeature("input:dom", site);
    const listener = handler
        ? compileDomCallback(context, handler, family, engine, true).cpp
        : "{}";
    context.emit({
        kind: "expression",
        code:
            `bbl::set_dom_${family}_handler(${engine}, ` +
            `bbl::DomEventTarget::node(${owner.cpp}.value), ${context.cppString(type)}, ${listener});`,
    });
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
            const value =
                type?.kind === "event-target"
                    ? context.dataLowerer.narrowOptional(
                          context.compileValue(callee.expression),
                          callee.expression,
                      )
                    : undefined;
            if (value && value.kind !== "data") {
                // An element, Window, Document or canvas bound to a name
                // typed `EventTarget` is the target it names.
                ({ target, engine } = domTargetIdentity(
                    context,
                    value,
                    callee.expression,
                ));
            } else if (value) {
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
    // Page transitions dispatch through the pointer family's Window path.
    const family = pagehide ? "pointer" : domListenerFamily(type);
    if (!family) return false;
    const custom = family === "custom";
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
        const compiled = compileDomCallback(context, callback, family, engine);
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
