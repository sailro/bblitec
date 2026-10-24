import ts from "typescript";
import { absenceOf } from "./values/model.js";
import type { LoweringServices } from "./lowering-services.js";
import { valueForKind, type Value } from "./types.js";
import { domTargetIdentity, elementInterfaceTag } from "./dom-targets.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import { documentEngine } from "./window-events.js";
import {
    compileBooleanOptions,
    optionalOptionMember,
    optionalOptionValue,
} from "./option-helpers.js";
import { pinCpp } from "./evaluation-order.js";
import { valueKindOf, unionMembers } from "./type-facts.js";

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
    | "probeEmission"
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
    "beforeinput",
    "input",
    "change",
    "cancel",
    // A details element's disclosure change, a non-bubbling task-queued event.
    "toggle",
]);

const serviceNames = new Set([
    "change",
    "input",
    "error",
    "unhandledrejection",
    "rejectionhandled",
    "visibilitychange",
    "pointerlockchange",
    "fullscreenchange",
    "fullscreenerror",
    "load",
    "DOMContentLoaded",
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

/** The Window's gamepad task source fires these (`pal_dom_gamepads.hpp`). */
const gamepadNames = new Set(["gamepadconnected", "gamepaddisconnected"]);

/** CSS transition events the UI projection sources. */
const transitionNames = new Set(["transitionend"]);

/** Page lifecycle events the Window dispatches as its document unloads. */
const pageLifecycleNames = new Set(["beforeunload", "pagehide"]);

/** These names already carry a distinct native payload/service contract. */
export function isCustomDomEventName(type: string): boolean {
    return (
        !pointerNames.has(type) &&
        !serviceNames.has(type) &&
        !keyboardNames.has(type) &&
        !gamepadNames.has(type) &&
        !transitionNames.has(type) &&
        !dragNames.has(type) &&
        type !== "storage" &&
        !pageLifecycleNames.has(type)
    );
}

type DomListenerFamily =
    | "custom"
    | "keyboard"
    | "pointer"
    | "transition"
    | "drag"
    | "storage"
    | "gamepad";

/** The shared dispatch family a DOM event name joins, if any. */
function domListenerFamily(type: string): DomListenerFamily | undefined {
    if (type === "storage") return "storage";
    if (keyboardNames.has(type)) return "keyboard";
    if (gamepadNames.has(type)) return "gamepad";
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
    return family === "custom" ||
        family === "transition" ||
        family === "storage" ||
        family === "gamepad" ||
        type === "resize"
        ? undefined
        : family;
}

/**
 * Whether `type` is the load or error a script or img element fires: a
 * task-queued, non-bubbling event of the application realm's resource loads.
 */
export function resourceLoadEvent(
    context: Pick<Context, "checker" | "options">,
    element: Value,
    receiver: ts.Expression,
    type: string,
): boolean {
    if ((type !== "error" && type !== "load") || element.kind !== "ui-element")
        return false;
    const tag =
        element.uiTag ??
        elementInterfaceTag(
            context.checker
                .getNonNullableType(context.checker.getTypeAtLocation(receiver))
                .getSymbol()?.name ?? "",
        );
    if (tag !== "script" && tag !== "img") return false;
    if (!context.options.workers) throw new ApplicationRealmRequired();
    return true;
}

/** Each family's borrowed event view. */
const DOM_CALLBACK_EVENTS = {
    storage: {
        cppType: "const bbl::PlatformStorageEvent&",
        kind: "platform-mouse-event",
    },
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
    // Read through the base Event view; GamepadEvent adds gamepad.
    gamepad: {
        cppType: "const bbl::PlatformGamepadEvent&",
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

type ListenerOptionsContext = Pick<
    Context,
    | "unwrap"
    | "checker"
    | "conditions"
    | "compileValue"
    | "cppString"
    | "allocateTemporaryCppName"
    | "emit"
    | "emitDiscardedValue"
    | "dataTypes"
    | "dataLowerer"
    | "fail"
>;

/** Flattened listener options: flag conditions and, when present, `signal`. */
export interface ListenerOptions {
    capture: string;
    once: string;
    passive: string;
    /** A `bbl::js::AbortSignal`, empty when the member is absent at run time. */
    signal?: string;
}

/** Whether a listener options operand's type declares a `signal` member. */
export function declaresListenerSignal(
    checker: ts.TypeChecker,
    expression: ts.Expression | undefined,
): boolean {
    const declares = (type: ts.Type): boolean =>
        unionMembers(type).some(
            (member) => member.getProperty("signal") !== undefined,
        );
    return (
        expression !== undefined &&
        declares(
            checker.getNonNullableType(checker.getTypeAtLocation(expression)),
        )
    );
}

/**
 * `addEventListener` options as the DOM flattens them: `capture` alone for a
 * removal; `capture`, `once`, `passive` and `signal` for an addition.
 */
export function listenerOptions(
    context: ListenerOptionsContext,
    expression: ts.Expression | undefined,
    removing: boolean,
): ListenerOptions {
    const result = { capture: "false", once: "false", passive: "false" };
    if (!expression) return result;
    if (
        valueKindOf(context.checker.getTypeAtLocation(expression)) === "boolean"
    ) {
        result.capture = context.conditions.compileCondition(expression);
        return result;
    }
    let signal: string | undefined;
    const flags = compileBooleanOptions(
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
                      consume: {
                          signal: (value: Value, present?: string) => {
                              signal = listenerSignal(
                                  context,
                                  value,
                                  expression,
                                  present,
                              );
                          },
                      },
                  }),
        },
    );
    return { ...result, ...flags, ...(signal ? { signal } : {}) };
}

/**
 * The `signal` member read once, in dictionary order, into a
 * `bbl::js::AbortSignal` that is empty while the options or the member are
 * absent; undefined when the member can only be undefined.
 */
function listenerSignal(
    context: Pick<
        Context,
        | "dataLowerer"
        | "dataTypes"
        | "fail"
        | "allocateTemporaryCppName"
        | "emit"
        | "emitDiscardedValue"
    >,
    value: Value,
    site: ts.Expression,
    present?: string,
): string | undefined {
    const stored = value.dataType;
    const optional = stored?.kind === "optional";
    const type = optional ? stored.inner : stored;
    if (value.kind === "json-null" || type?.kind === "undefined") {
        if (absenceOf(value) === "null")
            return context.fail(
                site,
                "Event listener signal accepts undefined or a DOM AbortSignal, not null.",
            );
        if (present)
            context.emit({
                kind: "expression",
                code: `if (${present}) { static_cast<void>(${value.cpp}); }`,
            });
        else context.emitDiscardedValue(value);
        return undefined;
    }
    if (!stored || type?.kind !== "abort-signal")
        return context.fail(
            site,
            "Event listener signal requires the DOM AbortSignal identity.",
        );
    const signalType = context.dataTypes.cppType(type);
    const read = optional
        ? optionalOptionValue(
              optionalOptionMember(
                  context.dataLowerer,
                  value,
                  present,
                  type,
                  "listener_signals",
                  site,
              ),
              `${signalType}{}`,
          )
        : present
          ? `(${present} ? ${value.cpp} : ${signalType}{})`
          : value.cpp;
    return pinCpp(context, read, "listener_signal", `const ${signalType}`);
}

/**
 * Adds a listener through `add(lease)`: plainly, or under `signal`'s lifetime
 * when the options may carry one (`bbl::js::add_event_listener`). `lease` is
 * the trailing lease argument, `", <lease>"`, or empty.
 */
export function listenerAddition(
    signal: string | undefined,
    add: (lease: string) => string,
): string {
    return signal
        ? `bbl::js::add_event_listener(${signal}, [&](bbl::ListenerLeasePtr listener_lease) { return ${add(", std::move(listener_lease)")}; })`
        : add("");
}

/**
 * An addition's listener and options in evaluation order: options that may
 * carry a `signal`, which evaluates after the listener, pin it first.
 */
export function signalListener(
    context: ListenerOptionsContext,
    options: ts.Expression | undefined,
    listener: string,
): { listener: string; options: ListenerOptions } {
    return {
        listener: declaresListenerSignal(context.checker, options)
            ? pinCpp(context, listener, "event_listener")
            : listener,
        options: listenerOptions(context, options, false),
    };
}

export function pinDetached(
    context: Pick<Context, "bindings">,
    value: Value,
    label: string,
    node?: ts.Expression,
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
            family === "transition" ||
            family === "drag" ||
            family === "storage" ||
            family === "gamepad"
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
    const pageLifecycle = pageLifecycleNames.has(type);
    if (pageLifecycle && context.options.workers?.namespace !== undefined)
        context.fail(
            call,
            "Page lifecycle events dispatch at the Window, which a worker realm does not have.",
        );
    let target: string | undefined;
    let engine: string | undefined;
    let storedTarget: Value | undefined;
    if (element?.kind === "data" && element.dataType?.kind === "event-target") {
        storedTarget = element;
    } else if (element?.domEventTargetCpp) {
        ({ target, engine } = domTargetIdentity(
            context,
            element,
            callee.expression,
        ));
    } else if (element) {
        engine = context.requireEngine(element, call);
        const owner = pinDetached(
            context,
            element,
            "event_target",
            callee.expression,
        );
        target = `bbl::DomEventTarget::node(${owner.cpp}.value)`;
    } else {
        const global = context.libraryGlobal(callee.expression);
        if (global === "window" || global === "document") {
            target = `bbl::DomEventTarget::${global}()`;
            engine =
                documentEngine(context, call) ??
                context.requireDefaultEngine(call);
        } else if (context.isCanvasElement(callee.expression)) {
            target = "bbl::DomEventTarget::canvas()";
            engine = context.requireDefaultEngine(call);
        } else {
            const value = context.probeEmission(() => {
                const candidate = context.dataLowerer.narrowOptional(
                    context.compileValue(callee.expression),
                    callee.expression,
                );
                return candidate.domEventTargetCpp ||
                    candidate.kind === "ui-element" ||
                    candidate.dataType?.kind === "event-target"
                    ? candidate
                    : undefined;
            });
            if (value?.domEventTargetCpp || value?.kind === "ui-element") {
                // An element, Window, Document or canvas bound to a name
                // typed `EventTarget` is the target it names.
                ({ target, engine } = domTargetIdentity(
                    context,
                    value,
                    callee.expression,
                ));
            } else if (value?.dataType?.kind === "event-target") {
                storedTarget = value;
            }
        }
    }
    if (storedTarget) {
        if (storedTarget.dataType?.kind !== "event-target")
            context.fail(
                callee.expression,
                "Nullable event targets require a presence guard.",
            );
        const snapshot = pinDetached(
            context,
            storedTarget,
            "event_target",
            callee.expression,
        );
        target = `${snapshot.cpp}.target`;
        engine = `bbl::dom_target_owner(${snapshot.cpp})`;
    }
    if (!target || !engine) return false;
    if (
        pageLifecycle &&
        !storedTarget &&
        target !== "bbl::DomEventTarget::window()"
    ) {
        context.fail(
            call,
            "Page lifecycle events dispatch at the Window; a listener on another target never runs.",
        );
    }
    if (
        (type === "resize" &&
            !storedTarget &&
            target !== "bbl::DomEventTarget::window()") ||
        ((type === "focus" || type === "blur") &&
            (target === "bbl::DomEventTarget::document()" ||
                target === "bbl::DomEventTarget::canvas()"))
    )
        return false;
    // Page transitions dispatch through the pointer family's Window path.
    const resourceLoad = element
        ? resourceLoadEvent(context, element, callee.expression, type)
        : false;
    const family =
        pageLifecycle || resourceLoad ? "pointer" : domListenerFamily(type);
    if (!family) return false;
    if (family === "gamepad") {
        if (!context.options.workers) throw new ApplicationRealmRequired();
        context.reachFeature("input:gamepad", call);
    }
    const custom = family === "custom";
    if (
        custom &&
        !storedTarget &&
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
    context.callbacks.hoistForwardCallbackBindings(callback);
    const removing = callee.name.text === "removeEventListener";
    const prefix = `${engine}, ${target}, ${context.cppString(type)}`;
    if (removing) {
        const value = context.compileValue(callback);
        const pinned =
            value.kind === "data"
                ? pinDetached(context, value, "event_callback", callback)
                : value;
        const identity = callbackIdentity(pinned, callback);
        const options = listenerOptions(context, call.arguments[2], true);
        context.emit({
            kind: "expression",
            code: `bbl::off_dom_${family}(${prefix}, ${identity}, ${options.capture});`,
        });
        return true;
    }
    // Connections are those of the gamepads `navigator.getGamepads()` reads.
    if (family === "gamepad")
        context.emit({
            kind: "expression",
            code: `bbl::watch_dom_gamepads(${engine}, ${context.requireDefaultEngine(call)});`,
        });
    const compiled = compileDomCallback(context, callback, family, engine);
    const { listener, options } = signalListener(
        context,
        call.arguments[2],
        compiled.cpp,
    );
    context.emit({
        kind: "expression",
        code: `${listenerAddition(
            options.signal,
            (lease) =>
                `bbl::on_dom_${family}(${prefix}, ${compiled.identity}, ${listener}, ` +
                `${options.capture}, ${options.once}, ${options.passive}${lease})`,
        )};`,
    });
    return true;
}
