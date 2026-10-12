import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { Value } from "./types.js";

/**
 * The WHATWG URL object as a native value (`bblite/js_url.hpp`):
 * construction with an optional base, the component getters, its one
 * URLSearchParams, and the href/pathname/search/hash setters.
 */

const URL_TYPE = { kind: "url" } as const;

const GETTERS: ReadonlyMap<string, string> = new Map([
    ["href", "href"],
    ["protocol", "protocol"],
    ["username", "username"],
    ["password", "password"],
    ["host", "host"],
    ["hostname", "hostname"],
    ["port", "port"],
    ["pathname", "pathname"],
    ["search", "search"],
    ["hash", "hash"],
    ["origin", "origin"],
]);

const SETTERS: ReadonlySet<string> = new Set([
    "href",
    "pathname",
    "search",
    "hash",
]);

/** A string operand evaluated once, in order, into a named temporary. */
function stringOperand(
    lowerer: DataLowerer,
    expression: ts.Expression,
    label: string,
): string {
    const context = lowerer.context;
    const name = context.allocateTemporaryCppName(label);
    context.emit({
        kind: "declaration",
        type: "const std::string",
        name,
        initializer: lowerer.compileForSink(expression, { kind: "string" }),
    });
    return name;
}

/** `new URL(input, base?)`; a base is a string or a URL. */
export function compileUrlNew(
    lowerer: DataLowerer,
    node: ts.NewExpression,
): Value | undefined {
    const context = lowerer.context;
    if (context.libraryGlobal(node.expression) !== "URL") return undefined;
    const arguments_ = node.arguments ?? [];
    if (arguments_.length < 1 || arguments_.length > 2)
        return context.fail(node, "new URL takes an input and a base.");
    context.reachJsData();
    const input = stringOperand(lowerer, arguments_[0]!, "url_input");
    const baseNode = arguments_[1];
    if (!baseNode)
        return {
            ...lowerer.leafValue(`bbl::js::Url(${input})`, URL_TYPE),
            impure: true,
        };
    const base = context.compileValue(baseNode);
    if (
        (base.kind === "json-null" && base.cpp === "std::nullopt") ||
        base.dataType?.kind === "undefined"
    ) {
        context.emitDiscardedValue(base);
        return {
            ...lowerer.leafValue(`bbl::js::Url(${input})`, URL_TYPE),
            impure: true,
        };
    }
    if (base.dataType?.kind === "url") {
        const held = context.bindings.pinValueToTemporary(base, "url_base");
        return {
            ...lowerer.leafValue(
                `bbl::js::Url(${input}, &(${held.cpp}))`,
                URL_TYPE,
            ),
            impure: true,
        };
    }
    const baseText = context.allocateTemporaryCppName("url_base");
    context.emit({
        kind: "declaration",
        type: "const std::string",
        name: baseText,
        initializer: lowerer.compileKnownValueForSink(
            base,
            { kind: "string" },
            baseNode,
        ),
    });
    return {
        ...lowerer.leafValue(
            `bbl::js::Url(${input}, std::string_view(${baseText}))`,
            URL_TYPE,
        ),
        impure: true,
    };
}

/** A URL component read, or its URLSearchParams. */
export function urlProperty(
    lowerer: DataLowerer,
    owner: Value,
    property: string,
): Value | undefined {
    if (owner.dataType?.kind !== "url") return undefined;
    if (property === "searchParams")
        return lowerer.leafValue(`(${owner.cpp}).search_params()`, {
            kind: "search-params",
        });
    const getter = GETTERS.get(property);
    return getter
        ? lowerer.leafValue(`(${owner.cpp}).${getter}()`, { kind: "string" })
        : undefined;
}

/** `url.toString()` and `url.toJSON()`. */
export function compileUrlMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value {
    const context = lowerer.context;
    if (method !== "toString" && method !== "toJSON")
        return context.fail(call, `URL.${method} is not lowered.`);
    context.expectArgumentCount(call, 0, 0);
    return lowerer.leafValue(`(${owner.cpp}).href()`, { kind: "string" });
}

/**
 * `url.pathname = value` and `url.pathname += text` (and the other
 * setters): the owner, then the right side, evaluate once each; a compound
 * reads the component first. The assignment's value is the stored string.
 */
export function compileUrlAssignment(
    lowerer: DataLowerer,
    expression: ts.BinaryExpression,
): Value | undefined {
    const context = lowerer.context;
    const left = context.unwrap(expression.left);
    if (
        !ts.isPropertyAccessExpression(left) ||
        lowerer.dataTypeAt(left.expression)?.kind !== "url"
    )
        return undefined;
    const property = left.name.text;
    if (!SETTERS.has(property))
        return context.fail(left, `The URL ${property} setter is not lowered.`);
    const operator = expression.operatorToken.kind;
    if (
        operator !== ts.SyntaxKind.EqualsToken &&
        operator !== ts.SyntaxKind.PlusEqualsToken
    )
        return context.fail(
            expression,
            "URL components support '=' and '+=' assignments.",
        );
    const owner = context.bindings.pinValueToTemporary(
        lowerer.narrowOptional(
            context.compileValue(left.expression),
            left.expression,
        ),
        "url_receiver",
    );
    if (owner.dataType?.kind !== "url")
        return context.fail(
            left.expression,
            "URL setters require a represented URL.",
        );
    let stored: string;
    if (operator === ts.SyntaxKind.PlusEqualsToken) {
        const previous = context.allocateTemporaryCppName("url_component");
        context.emit({
            kind: "declaration",
            type: "const std::string",
            name: previous,
            initializer: `(${owner.cpp}).${GETTERS.get(property)!}()`,
        });
        const suffix = stringOperand(lowerer, expression.right, "url_suffix");
        stored = context.allocateTemporaryCppName("url_component");
        context.emit({
            kind: "declaration",
            type: "const std::string",
            name: stored,
            initializer: `${previous} + ${suffix}`,
        });
    } else stored = stringOperand(lowerer, expression.right, "url_component");
    context.emit({
        kind: "expression",
        code: `(${owner.cpp}).set_${property}(${stored});`,
    });
    return lowerer.leafValue(stored, { kind: "string" });
}
