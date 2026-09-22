import ts from "typescript";
import { browserGlobalNamed } from "./browser-erasure.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { documentEngine } from "./window-events.js";

type Context = Pick<
    LoweringServices,
    | "options"
    | "defaultEngine"
    | "requireDefaultEngine"
    | "unwrap"
    | "lookupOptional"
    | "isDefaultLibraryIdentifier"
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
        return `bbl::dom_target_value(${engine}, bbl::DomEventTarget::node(${value.cpp}.value))`;
    let target = value.domEventTargetCpp;
    if (!target && ts.isExpression(node)) {
        const global = browserGlobalNamed(context, node)?.text;
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
    return `bbl::dom_target_value(${engine}, ${target})`;
}

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
        expression.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword ||
        !ts.isIdentifier(expression.right) ||
        !context.isDefaultLibraryIdentifier(expression.right)
    )
        return undefined;
    const tags = new Map([
        ["HTMLInputElement", "input"],
        ["HTMLSelectElement", "select"],
        ["HTMLTextAreaElement", "textarea"],
        ["HTMLButtonElement", "button"],
        ["HTMLCanvasElement", "canvas"],
    ]);
    const tag = tags.get(expression.right.text);
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
    return `bbl::dom_target_has_tag(${target}, ${context.cppString(tag)})`;
}
