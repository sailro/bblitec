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

/** What an element interface's `instanceof` tests on a native DOM target. */
type ElementInterfaceTest =
    | { readonly kind: "tag"; readonly tag: string }
    | { readonly kind: "element"; readonly html: boolean };

type WindowInterface =
    | { readonly kind: "observer" }
    | { readonly kind: "element"; readonly test: ElementInterfaceTest };

/**
 * The Window interfaces native represents: element interfaces `instanceof`
 * answers by tag or namespace, and observers an application realm builds.
 */
const WINDOW_INTERFACES: ReadonlyMap<string, WindowInterface> = new Map<
    string,
    WindowInterface
>([
    ["Element", { kind: "element", test: { kind: "element", html: false } }],
    ["HTMLElement", { kind: "element", test: { kind: "element", html: true } }],
    ...(
        [
            ["HTMLInputElement", "input"],
            ["HTMLSelectElement", "select"],
            ["HTMLTextAreaElement", "textarea"],
            ["HTMLButtonElement", "button"],
            ["HTMLCanvasElement", "canvas"],
        ] as const
    ).map(([name, tag]): [string, WindowInterface] => [
        name,
        { kind: "element", test: { kind: "tag", tag } },
    ]),
    ["MutationObserver", { kind: "observer" }],
    ["ResizeObserver", { kind: "observer" }],
]);

export function isWindowObserver(name: string | undefined): boolean {
    return WINDOW_INTERFACES.get(name ?? "")?.kind === "observer";
}

/**
 * `typeof` of a represented Window interface: function where the Window is,
 * undefined in a dedicated worker. Outside an application realm an observer
 * is undecided, since only that realm builds one.
 */
export function windowInterfaceTypeof(
    name: string | undefined,
    workers: { readonly namespace: string | undefined } | undefined,
): "function" | "undefined" | undefined {
    const entry = WINDOW_INTERFACES.get(name ?? "");
    if (!entry) return undefined;
    if (workers?.namespace) return "undefined";
    return entry.kind === "observer" && !workers ? undefined : "function";
}

/** The tag a declared element interface names. */
export function elementInterfaceTag(name: string): string | undefined {
    const entry = WINDOW_INTERFACES.get(name);
    return entry?.kind === "element" && entry.test.kind === "tag"
        ? entry.test.tag
        : undefined;
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
        expression.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword
    )
        return undefined;
    const entry = WINDOW_INTERFACES.get(
        context.libraryGlobal(expression.right) ?? "",
    );
    if (entry?.kind !== "element") return undefined;
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
    return entry.test.kind === "element"
        ? `bbl::dom_target_is_element(${target}, ${entry.test.html})`
        : `bbl::dom_target_has_tag(${target}, ${context.cppString(entry.test.tag)})`;
}
