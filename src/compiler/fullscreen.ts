import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import { FULLSCREEN_METHODS } from "./dom-lowerings.js";
import { isDomReceiver } from "./dom-targets.js";
import type { LoweringServices } from "./lowering-services.js";
import { resolvedDomApi } from "./symbols.js";
import { presenceFlagCpp, type Value } from "./types.js";
import type { UiProjection } from "./ui-projection.js";
import { requireWindowHost } from "./window-events.js";

/**
 * The Fullscreen API of a Window application (`bbl::pal::window_*fullscreen*`):
 * `element.requestFullscreen()` on the document element or the primary
 * canvas, `document.exitFullscreen()`, `document.fullscreenElement` and the
 * document's `fullscreenchange` listeners.
 */

const DOCUMENT_ENGINE = "bbl::pal::window_document_engine()";

/** A DOM-declared fullscreen method, by its resolved signature. */
function fullscreenMethod(
    context: Pick<LoweringServices, "checker" | "unwrap">,
    call: ts.CallExpression,
): "requestFullscreen" | "exitFullscreen" | undefined {
    if (!ts.isPropertyAccessExpression(context.unwrap(call.expression)))
        return undefined;
    return FULLSCREEN_METHODS.get(resolvedDomApi(context.checker, call) ?? "");
}

export function compileFullscreenCall(
    lowerer: DataLowerer,
    ui: Pick<UiProjection, "compileUiElementReceiver" | "uiElementValue">,
    call: ts.CallExpression,
): Value | undefined {
    const context = lowerer.context;
    const method = fullscreenMethod(context, call);
    if (!method) return undefined;
    const callee = context.unwrap(
        call.expression,
    ) as ts.PropertyAccessExpression;
    requireWindowHost(context, call);
    if (method === "exitFullscreen") {
        if (context.libraryGlobal(callee.expression) !== "document")
            return context.fail(
                callee.expression,
                "exitFullscreen is admitted on the Window application's document.",
            );
        context.expectArgumentCount(call, 0, 0);
        return lowerer.leafValue("bbl::pal::window_exit_fullscreen()", {
            kind: "promise",
        });
    }
    context.expectArgumentCount(call, 0, 1);
    const element =
        ui.compileUiElementReceiver(callee.expression) ??
        ui.uiElementValue(callee.expression);
    if (element?.kind !== "ui-element" || presenceFlagCpp(element))
        return context.fail(
            callee.expression,
            "requestFullscreen requires a present retained element.",
        );
    const held = context.bindings.pinValueToTemporary(
        element,
        "fullscreen_element",
        callee.expression,
    );
    // navigationUI is a presentation hint; a native window has no navigation UI.
    const options = call.arguments[0];
    if (options) context.emitDiscardedValue(context.compileValue(options));
    return lowerer.leafValue(
        `bbl::pal::window_request_fullscreen(${held.cpp})`,
        { kind: "promise" },
    );
}

/** `document.fullscreenElement`: the element the document shows fullscreen, or null. */
export function fullscreenElementValue(
    lowerer: DataLowerer,
    expression: ts.PropertyAccessExpression,
): Value | undefined {
    const context = lowerer.context;
    if (
        expression.name.text !== "fullscreenElement" ||
        !isDomReceiver(context, expression.expression, "Document")
    )
        return undefined;
    if (context.libraryGlobal(expression.expression) !== "document")
        return context.fail(
            expression.expression,
            "fullscreenElement is admitted on the Window application's document.",
        );
    requireWindowHost(context, expression);
    return lowerer.narrowOptional(
        {
            kind: "data",
            cpp: "bbl::pal::window_fullscreen_element()",
            dataType: {
                kind: "optional",
                inner: { kind: "handle", handle: "ui-element" },
            },
            engineCpp: DOCUMENT_ENGINE,
            impure: true,
        },
        expression,
    );
}
