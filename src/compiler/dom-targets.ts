import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { documentEngine } from "./window-events.js";

type Context = Pick<
    LoweringServices,
    | "options"
    | "defaultEngine"
    | "requireDefaultEngine"
    | "unwrap"
    | "libraryGlobal"
    | "reachFeature"
    | "fail"
>;

export function eventTargetCpp(
    context: Context,
    value: Value,
    node: ts.Node,
): string {
    context.reachFeature("input:dom", node);
    if (value.kind === "data" && value.dataType?.kind === "event-target")
        return value.cpp;
    const { target, engine } = domTargetIdentity(context, value, node);
    return `bbl::dom_target_value(${engine}, ${target})`;
}

/**
 * The native DOM target a value without event-target storage names (an
 * element, the Window, the Document or the primary canvas), and the engine
 * whose document owns it.
 */
export function domTargetIdentity(
    context: Context,
    value: Value,
    node: ts.Node,
): { target: string; engine: string } {
    const engine =
        value.engineCpp ??
        documentEngine(context, node) ??
        context.defaultEngine();
    if (!engine)
        context.fail(
            node,
            "A native event target requires its owning document.",
        );
    if (value.kind === "ui-element")
        return {
            target: `bbl::DomEventTarget::node(${value.cpp}.value)`,
            engine,
        };
    let target = value.domEventTargetCpp;
    if (!target && ts.isExpression(node)) {
        const global = context.libraryGlobal(node);
        if (global === "window" || global === "globalThis")
            target = "bbl::DomEventTarget::window()";
        if (global === "document") target = "bbl::DomEventTarget::document()";
    }
    if (
        value.browserValue?.kind === "object" &&
        value.browserValue.primaryCanvas
    )
        target = "bbl::DomEventTarget::canvas()";
    if (!target)
        context.fail(
            node,
            "This value has no represented DOM target identity.",
        );
    return { target, engine };
}

/**
 * Element interfaces native DOM targets answer `instanceof` for: a tag, or
 * any element (`Element`) or any HTML-namespace element (`HTMLElement`).
 */
export const DOM_ELEMENT_INTERFACES: ReadonlyMap<string, string> = new Map([
    ["Element", "element"],
    ["HTMLElement", "html-element"],
    ["HTMLInputElement", "input"],
    ["HTMLSelectElement", "select"],
    ["HTMLTextAreaElement", "textarea"],
    ["HTMLButtonElement", "button"],
    ["HTMLCanvasElement", "canvas"],
]);

/** Retained HTML element interfaces follow the element's tag and document identity. */
export function compileDomInstanceOf(
    context: Context &
        Pick<
            LoweringServices,
            "compileValue" | "emitDiscardedValue" | "cppString"
        >,
    expression: ts.Expression,
): string | undefined {
    if (
        !ts.isBinaryExpression(expression) ||
        expression.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword
    )
        return undefined;
    const tag = DOM_ELEMENT_INTERFACES.get(
        context.libraryGlobal(expression.right) ?? "",
    );
    if (!tag) return undefined;
    const value = context.compileValue(expression.left);
    const type = value.dataType;
    if (
        value.kind === "json-null" ||
        value.kind === "number" ||
        value.kind === "boolean" ||
        value.kind === "string"
    ) {
        context.emitDiscardedValue(value);
        return "false";
    }
    context.reachFeature("input:dom", expression);
    context.reachFeature("ui:rml", expression);
    const target =
        type?.kind === "optional" && type.inner.kind === "event-target"
            ? value.cpp
            : eventTargetCpp(context, value, expression.left);
    return tag === "element" || tag === "html-element"
        ? `bbl::dom_target_is_element(${target}, ${tag === "html-element"})`
        : `bbl::dom_target_has_tag(${target}, ${context.cppString(tag)})`;
}
