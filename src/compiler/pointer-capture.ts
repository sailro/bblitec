import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import { pinDetached } from "./dom-listeners.js";
import { POINTER_CAPTURE_OPERATIONS } from "./dom-lowerings.js";
import { resolvedDomApi, namedMember } from "./symbols.js";
import { argumentAt } from "./syntax.js";
import type { Value } from "./types.js";
import type { UiProjection } from "./ui-projection.js";

type Context = Pick<
    LoweringServices,
    | "bindings"
    | "checker"
    | "compileNumber"
    | "compileValue"
    | "dataLowerer"
    | "expectArgumentCount"
    | "fail"
    | "isCanvasElement"
    | "probeEmission"
    | "reachFeature"
    | "requireDefaultEngine"
    | "requireEngine"
    | "unwrap"
>;

/**
 * The `bbl::DomEventTargetValue` an element receiver names: a retained
 * element, an event target the program stored, or the engine canvas. The
 * receiver is pinned, so it evaluates before the pointer id.
 */
function captureTarget(
    context: Context,
    ui: UiProjection,
    receiver: ts.Expression,
    call: ts.CallExpression,
    prepared?: Value,
): string | undefined {
    // A stored event target keeps its identity (the engine canvas is no
    // retained element) rather than taking the element view of a narrowing.
    const compiled = (
        accept: (candidate: Value) => boolean,
    ): Value | undefined =>
        context.isCanvasElement(receiver)
            ? undefined
            : context.probeEmission(() => {
                  const candidate = context.dataLowerer.narrowOptional(
                      context.compileValue(receiver),
                      receiver,
                  );
                  return accept(candidate) ? candidate : undefined;
              });
    const value =
        prepared ??
        compiled((candidate) => candidate.dataType?.kind === "event-target") ??
        ui.compileUiElementReceiver(receiver) ??
        compiled((candidate) => candidate.kind === "ui-element");
    if (!value) {
        if (!context.isCanvasElement(receiver) || !ts.isIdentifier(receiver))
            return undefined;
        return `bbl::dom_target_value(${context.requireDefaultEngine(call)}, bbl::DomEventTarget::canvas())`;
    }
    if (value.dataType?.kind === "event-target")
        return pinDetached(context, value, "capture_target", receiver).cpp;
    if (value.kind !== "ui-element")
        return context.fail(
            receiver,
            "Pointer capture requires a retained element, a stored event target or the engine canvas.",
        );
    const engine = context.requireEngine(value, call);
    const element = pinDetached(context, value, "capture_target", receiver);
    return `bbl::dom_target_value(${engine}, bbl::DomEventTarget::node(${element.cpp}.value))`;
}

/**
 * `element.setPointerCapture(id)`, `releasePointerCapture(id)` and
 * `hasPointerCapture(id)` on the document's capture state
 * (`pal_dom_events.hpp`), which targets the pointer's later input.
 */
export function compilePointerCapture(
    context: Context,
    ui: UiProjection,
    call: ts.CallExpression,
): Value | undefined {
    const callee = namedMember(
        context.checker,
        context.unwrap(call.expression),
    );
    if (!callee) return undefined;
    const operation = POINTER_CAPTURE_OPERATIONS.get(
        resolvedDomApi(context.checker, call) ?? "",
    );
    if (!operation) return undefined;
    context.expectArgumentCount(call, 1, 1);
    context.reachFeature("input:dom", call);
    const lower = (prepared?: Value): Value => {
        const target = captureTarget(
            context,
            ui,
            callee.expression,
            call,
            prepared,
        );
        if (!target)
            return context.fail(
                callee.expression,
                `'${callee.name}' requires a retained element, a stored event target or the engine canvas.`,
            );
        const pointerId = context.compileNumber(argumentAt(call, 0), "double");
        const cpp = `${operation}(${target}, ${pointerId})`;
        return callee.name === "hasPointerCapture"
            ? { kind: "boolean", cpp, impure: true }
            : { kind: "void", cpp };
    };
    if (!callee.access.questionDotToken) return lower();
    return context.dataLowerer.optionalAccess(
        context.compileValue(callee.expression),
        call,
        lower,
    );
}
