import type ts from "typescript";
import type { Value } from "./types.js";
import type { GizmoIntrinsicContext } from "./intrinsics/gizmo.js";

// Structural canvas aliases share their property table. The generated state
// belongs to that runtime object, not to a source spelling or to the engine's
// real canvas. Weak keys cannot retain one compilation's scopes in the next.
const proxyDispatchers = new WeakMap<object, string>();

export function pointerDispatcherCpp(
    context: GizmoIntrinsicContext,
    canvas: Value,
    site: ts.Node,
): string {
    if (canvas.kind === "record" && canvas.recordProperties) {
        return proxyDispatchers.get(canvas.recordProperties) ?? "nullptr";
    }
    if (canvas.kind !== "browser") {
        context.fail(site, "Pointer drag requires a canvas or a structural canvas event proxy.");
    }
    return `${context.requireDefaultEngine(site)}.canvas_pointer_dispatcher.lock()`;
}

export function compilePointerDragRegistration(
    context: GizmoIntrinsicContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 3, 3);
    const layer = context.compileValue(call.arguments[0]!);
    const canvas = context.compileValue(call.arguments[1]!);
    const drag = context.compileValue(call.arguments[2]!);
    context.expectKind(layer, "utility-layer", call.arguments[0]!);
    context.expectKind(drag, "pointer-drag", call.arguments[2]!);
    context.expectSameEngine(layer, drag, call);
    context.reachFeature("gizmo:pointer-drag", call);
    context.reachFeature("picking:gpu", call);
    const engine = context.requireEngine(layer, call);
    let dispatcher: string;
    if (canvas.kind === "record" && canvas.recordProperties) {
        const known = proxyDispatchers.get(canvas.recordProperties);
        if (known) {
            dispatcher = known;
        } else {
            const add = canvas.recordMethods?.addEventListener ?? canvas.recordProperties.addEventListener?.callbackDeclaration;
            const remove = canvas.recordMethods?.removeEventListener ?? canvas.recordProperties.removeEventListener?.callbackDeclaration;
            if (!add || !remove) {
                context.fail(call.arguments[1]!, "A pointer canvas proxy must expose source-defined add/removeEventListener methods.");
            }
            dispatcher = context.allocateTemporaryCppName("pointer_dispatcher");
            context.emit(`auto ${dispatcher} = bbl::create_pointer_drag_dispatcher(${engine}, ${layer.cpp}, false);`);
            proxyDispatchers.set(canvas.recordProperties, dispatcher);
            const listeners = ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave"].map((event, index) => {
                const cpp = context.allocateTemporaryCppName("pointer_listener");
                context.emit(`auto ${cpp} = bbl::pointer_drag_listener(${dispatcher}, ${index}u);`);
                const arguments_: Value[] = [
                    { kind: "string", cpp: JSON.stringify(event), staticString: event },
                    { kind: "data", cpp, dataType: {
                        kind: "function", identity: true, parameters: [{ kind: "borrowed-platform-event", event: "event" }],
                    } },
                ];
                const result = context.withRecordScopes(canvas, () =>
                    context.compileCallbackWithValues(add, arguments_, call, true));
                context.emitDiscardedValue(result);
                return arguments_;
            });
            const cleanup = context.captureStoredDataFunctionLines(() => {
                for (const arguments_ of listeners) {
                    const result = context.withRecordScopes(canvas, () =>
                        context.compileCallbackWithValues(remove, arguments_, call, true));
                    context.emitDiscardedValue(result);
                }
            });
            context.emit(`bbl::set_pointer_drag_cleanup(${dispatcher}, ${cleanup.capture}() mutable {\n${cleanup.lines.join("\n")}\n});`);
        }
    } else if (canvas.kind === "browser") {
        dispatcher = `bbl::create_pointer_drag_dispatcher(${engine}, ${layer.cpp}, true)`;
    } else {
        return context.fail(call.arguments[1]!, "Pointer drag requires a canvas or a structural canvas event proxy.");
    }
    return {
        kind: "data",
        cpp: `bbl::register_pointer_drag(${dispatcher}, ${drag.cpp})`,
        dataType: { kind: "function", parameters: [] },
    };
}
