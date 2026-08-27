// Generation-time fetch for immutable JSON inputs.
//
// A source URL that is statically known can be read while the synchronous
// compiler runs. The response remains a compile-time value: `ok` and `status`
// fold exactly, and `json()` turns the document into the same tuple/record
// values an equivalent literal would have produced. No browser Response or
// JSON parser leaks into the native program.
import ts from "typescript";

import { floatLiteral } from "../cpp-literals.js";
import { readAssetBytesSync } from "./asset-bytes-sync.js";
import { resolveBundledAsset } from "./assets.js";
import type { Value } from "./types.js";

export interface StaticFetchContext {
    readonly options: { fileName: string };
    compileStringLiteral(expression: ts.Expression): string;
    cppString(value: string): string;
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    fail(node: ts.Node, message: string): never;
}

export function compileStaticFetch(
    context: StaticFetchContext,
    call: ts.CallExpression,
    callee: ts.Identifier,
): Value | undefined {
    if (callee.text !== "fetch" || context.lookupOptional(callee)) {
        return undefined;
    }
    if (call.arguments.length !== 1) {
        context.fail(
            call,
            "Generation-time fetch requires exactly one static URL argument.",
        );
    }
    const logicalSource = context.compileStringLiteral(call.arguments[0]!);
    const source = resolveBundledAsset(logicalSource);
    let parsed: unknown;
    try {
        const bytes = readAssetBytesSync(source, context.options.fileName);
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error: unknown) {
        context.fail(
            call,
            `Generation-time fetch of '${logicalSource}' failed: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    return {
        kind: "static-fetch-response",
        cpp: "",
        staticString: source,
        staticJson: parsed,
    };
}

export function compileStaticFetchMethod(
    context: StaticFetchContext,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value | undefined {
    if (owner.kind !== "static-fetch-response") return undefined;
    if (method !== "json") {
        context.fail(
            call.expression,
            `Generation-time fetch responses support json(), not '${method}()'.`,
        );
    }
    if (call.arguments.length !== 0) {
        context.fail(call, "Response.json() takes no arguments.");
    }
    return jsonValue(context, owner.staticJson, call);
}

export function staticFetchProperty(
    owner: Value,
    property: string,
): Value | undefined {
    if (owner.kind !== "static-fetch-response") return undefined;
    if (property === "ok") {
        return { kind: "boolean", cpp: "true" };
    }
    if (property === "status") {
        return { kind: "number", cpp: "200.0f", staticNumber: 200 };
    }
    return undefined;
}

function jsonValue(
    context: StaticFetchContext,
    value: unknown,
    node: ts.Node,
): Value {
    if (value === null) {
        return { kind: "json-null", cpp: "" };
    }
    if (typeof value === "boolean") {
        return { kind: "boolean", cpp: value ? "true" : "false" };
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            context.fail(node, "JSON numeric values must be finite.");
        }
        return {
            kind: "number",
            cpp: floatLiteral(value),
            staticNumber: value,
        };
    }
    if (typeof value === "string") {
        return {
            kind: "string",
            cpp: context.cppString(value),
            staticString: value,
        };
    }
    if (Array.isArray(value)) {
        return {
            kind: "tuple",
            cpp: "",
            tupleElements: value.map((entry) =>
                jsonValue(context, entry, node),
            ),
        };
    }
    if (typeof value === "object") {
        return {
            kind: "record",
            cpp: "",
            recordProperties: Object.fromEntries(
                Object.entries(value).map(([name, entry]) => [
                    name,
                    jsonValue(context, entry, node),
                ]),
            ),
        };
    }
    context.fail(node, "Fetched JSON contains an unsupported value.");
}
