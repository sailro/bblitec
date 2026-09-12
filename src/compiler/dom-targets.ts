import ts from "typescript";
import {browserGlobalNamed} from "./browser-erasure.js";
import type {LoweringServices} from "./lowering-services.js";
import type {Value} from "./types.js";
import {documentEngine} from "./window-events.js";

type Context = Pick<LoweringServices, "options" | "defaultEngine" | "unwrap" | "lookupOptional" |
    "isDefaultLibraryIdentifier" | "reachFeature" | "fail">;

export function eventTargetCpp(context: Context, value: Value, node: ts.Node): string {
    context.reachFeature("input:dom", node);
    if (value.kind === "data" && value.dataType?.kind === "event-target") return value.cpp;
    const engine = value.engineCpp ?? documentEngine(context, node) ?? context.defaultEngine();
    if (!engine) context.fail(node, "A native event target requires its owning document.");
    if (value.kind === "ui-element")
        return `bbl::dom_target_value(${engine}, bbl::DomEventTarget::node(${value.cpp}.value))`;
    let target = value.domEventTargetCpp;
    if (!target && ts.isExpression(node)) {
        const global = browserGlobalNamed(context, node)?.text;
        if (global === "window" || global === "globalThis") target = "bbl::DomEventTarget::window()";
        if (global === "document") target = "bbl::DomEventTarget::document()";
    }
    if (value.browserValue?.kind === "object" && value.browserValue.primaryCanvas) target = "bbl::DomEventTarget::canvas()";
    if (!target) context.fail(node, "This value has no represented DOM target identity.");
    return `bbl::dom_target_value(${engine}, ${target})`;
}
