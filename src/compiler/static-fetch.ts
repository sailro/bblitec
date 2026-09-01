// Generation-time fetch for immutable JSON inputs.
//
// A source URL that is statically known can be read while the synchronous
// compiler runs. The response remains a compile-time value: `ok` and `status`
// fold exactly, and `json()` turns the document into the same tuple/record
// values an equivalent literal would have produced. No browser Response or
// JSON parser leaks into the native program.
import ts from "typescript";
import { readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { floatLiteral } from "../cpp-literals.js";
import { readAssetBytesSync } from "./asset-bytes-sync.js";
import { resolveBundledAsset } from "./assets.js";
import {
    jsonToValue,
    type JsonValuePolicy,
} from "./json-value.js";
import type { CompileAsset, Value } from "./types.js";

export interface StaticFetchContext {
    readonly options: { fileName: string };
    compileValue(expression: ts.Expression): Value;
    unwrap(expression: ts.Expression): ts.Expression;
    compileStringLiteral(expression: ts.Expression): string;
    staticAssetUrlCandidates(): readonly string[];
    cppString(value: string): string;
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    registerAsset(
        source: string,
        kind: CompileAsset["kind"],
    ): CompileAsset;
    reachJsData(): void;
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
    const dynamic = compileDynamicPackagedAsset(
        context,
        call.arguments[0]!,
        "binary",
    );
    if (dynamic) return dynamic;
    if (ts.isIdentifier(call.arguments[0]!)) {
        const bound = context.lookupOptional(call.arguments[0]!);
        if (bound && bound.staticString === undefined) {
            context.fail(
                call.arguments[0]!,
                `Generation-time fetch URL '${call.arguments[0]!.text}' lost its static value (${bound.kind}: ${bound.cpp}).`,
            );
        }
    }
    const logicalSource = context.compileStringLiteral(call.arguments[0]!);
    const source = resolveBundledAsset(
        logicalSource,
        context.options.fileName,
    );
    return {
        kind: "static-fetch-response",
        cpp: "",
        staticString: source,
    };
}

/**
 * Packages the finite local files a runtime string may select and returns a
 * closed native path lookup. Consumers choose the manifest kind and may limit
 * the reached directory to the file formats they can actually decode.
 */
export function compileDynamicPackagedAsset(
    context: StaticFetchContext,
    expression: ts.Expression,
    kind: CompileAsset["kind"],
    accepts: (source: string) => boolean = () => true,
): Value | undefined {
    return (
        compileDynamicDirectoryFetch(context, expression, kind, accepts) ??
        compileDynamicCandidateFetch(context, expression, kind, accepts)
    );
}

/**
 * Packages a finite set of module-relative asset URLs for a runtime selection.
 * Demos commonly put immutable asset URLs in descriptor tables, collect a
 * reached subset in a Set, and fetch the selected string later. The native
 * lookup stays closed: only generation-known, readable files are packaged and
 * every other runtime key throws.
 */
function compileDynamicCandidateFetch(
    context: StaticFetchContext,
    expression: ts.Expression,
    kind: CompileAsset["kind"],
    accepts: (source: string) => boolean,
): Value | undefined {
    const selected = context.compileValue(expression);
    if (
        selected.staticString !== undefined ||
        !(
            selected.kind === "string" ||
            (selected.kind === "data" &&
                selected.dataType?.kind === "string")
        )
    ) {
        return undefined;
    }
    const discovered = context.staticAssetUrlCandidates().flatMap(
        (logicalSource) => {
            const source = resolveBundledAsset(
                logicalSource,
                context.options.fileName,
            );
            try {
                readAssetBytesSync(source, context.options.fileName);
                return [{ logicalSource, source }];
            } catch {
                const directory = resolve(
                    dirname(resolve(context.options.fileName)),
                    source,
                );
                try {
                    const logicalBase = logicalSource.endsWith("/")
                        ? logicalSource
                        : `${logicalSource}/`;
                    return listFiles(directory).map((file) => ({
                        logicalSource:
                            logicalBase +
                            relative(directory, file)
                                .split(sep)
                                .join("/"),
                        source: file,
                    }));
                } catch {
                    return [];
                }
            }
        },
    ).filter(({ source }) => accepts(source));
    const candidates = new Map<
        string,
        { logicalSource: string; source: string }
    >();
    for (const candidate of discovered) {
        if (!candidates.has(candidate.logicalSource)) {
            candidates.set(candidate.logicalSource, candidate);
        }
    }
    if (candidates.size === 0) return undefined;
    const entries = [...candidates.values()].map(({ logicalSource, source }) => {
        const asset = context.registerAsset(source, kind);
        return `{${context.cppString(logicalSource)}, ${context.cppString(asset.output)}}`;
    });
    context.reachJsData();
    return {
        kind: "static-fetch-response",
        cpp: "",
        dynamicAssetPathCpp:
            `([&](const std::string& key) -> std::string { ` +
            `static bbl::js::Map<std::string, std::string> paths{${entries.join(", ")}}; ` +
            `auto found = paths.get(key); ` +
            `if (!found.has_value()) throw std::runtime_error("Unknown packaged asset: " + key); ` +
            `return bbl::asset_path(found.value()); })(${selected.cpp})`,
    };
}

export function compileStaticFetchMethod(
    context: StaticFetchContext,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value | undefined {
    if (owner.kind !== "static-fetch-response") return undefined;
    if (method === "arrayBuffer") {
        if (call.arguments.length !== 0) {
            context.fail(call, "Response.arrayBuffer() takes no arguments.");
        }
        if (owner.dynamicAssetPathCpp) {
            return {
                kind: "data",
                cpp:
                    "bbl::js::ArrayBuffer(bbl::pal::read_binary_file(" +
                    `${owner.dynamicAssetPathCpp}))`,
                dataType: { kind: "arraybuffer" },
                dynamicAssetPathCpp: owner.dynamicAssetPathCpp,
            };
        }
        if (!owner.staticString) {
            context.fail(call.expression, "Fetched response has no static source.");
        }
        const asset = context.registerAsset(
            owner.staticString,
            "binary",
        );
        context.reachJsData();
        return {
            kind: "data",
            cpp:
                "bbl::js::ArrayBuffer(bbl::pal::read_binary_file(" +
                `bbl::asset_path(${context.cppString(asset.output)})))`,
            dataType: { kind: "arraybuffer" },
        };
    }
    if (method === "text") {
        if (call.arguments.length !== 0) {
            context.fail(call, "Response.text() takes no arguments.");
        }
        let source: string;
        try {
            const bytes = readAssetBytesSync(
                owner.staticString ?? "",
                context.options.fileName,
            );
            source = new TextDecoder().decode(bytes);
        } catch (error: unknown) {
            context.fail(
                call,
                `Generation-time fetch of '${owner.staticString ?? ""}' failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        return {
            kind: "string",
            cpp: context.cppString(source),
            staticString: source,
        };
    }
    if (method !== "json") {
        context.fail(
            call.expression,
            `Generation-time fetch responses support json(), text(), and arrayBuffer(), not '${method}()'.`,
        );
    }
    if (call.arguments.length !== 0) {
        context.fail(call, "Response.json() takes no arguments.");
    }
    let parsed: unknown;
    try {
        const bytes = readAssetBytesSync(
            owner.staticString ?? "",
            context.options.fileName,
        );
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error: unknown) {
        context.fail(
            call,
            `Generation-time fetch of '${owner.staticString ?? ""}' failed: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    return jsonValue(context, parsed, call);
}

/**
 * Packages a closed local directory for `fetch(BASE + runtimeName)`. The
 * generated lookup maps the source's relative name to the deterministic
 * packaged filename; consumers such as audio decode receive the resolved
 * native path without adding a network fetcher.
 */
function compileDynamicDirectoryFetch(
    context: StaticFetchContext,
    expression: ts.Expression,
    kind: CompileAsset["kind"],
    accepts: (source: string) => boolean,
): Value | undefined {
    const unwrapped = context.unwrap(expression);
    let logicalPrefix: string | undefined;
    let suffix: Value | undefined;
    let prefixNode: ts.Node = unwrapped;
    if (
        ts.isBinaryExpression(unwrapped) &&
        unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
        const prefix = context.compileValue(unwrapped.left);
        logicalPrefix = prefix.staticString;
        suffix = context.compileValue(unwrapped.right);
        prefixNode = unwrapped.left;
    } else if (ts.isTemplateExpression(unwrapped)) {
        let prefix = unwrapped.head.text;
        for (const [index, span] of unwrapped.templateSpans.entries()) {
            const value = context.compileValue(span.expression);
            if (value.staticString !== undefined) {
                prefix += value.staticString + span.literal.text;
                continue;
            }
            if (
                index !== unwrapped.templateSpans.length - 1 ||
                span.literal.text.length !== 0
            ) {
                return undefined;
            }
            logicalPrefix = prefix;
            suffix = value;
            prefixNode = unwrapped;
        }
    } else {
        return undefined;
    }
    if (logicalPrefix === undefined || !suffix) return undefined;
    if (
        suffix.kind !== "string" &&
        !(
            suffix.kind === "data" &&
            suffix.dataType?.kind === "string"
        )
    ) {
        return undefined;
    }
    const logicalBase = logicalPrefix.endsWith("/")
        ? logicalPrefix
        : `${logicalPrefix}/`;
    // Network prefixes cannot name a repository directory. A fully static
    // URL falls through to the ordinary fetch path, while a genuinely
    // dynamic network fetch retains that path's static-URL diagnostic.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(logicalBase)) {
        return undefined;
    }
    const resolvedBase = resolveBundledAsset(
        logicalBase,
        context.options.fileName,
    );
    const directory = resolve(
        dirname(resolve(context.options.fileName)),
        resolvedBase,
    );
    let files: string[];
    try {
        files = listFiles(directory).filter(accepts).sort();
    } catch (error: unknown) {
        context.fail(
            prefixNode,
            `Dynamic fetch base '${logicalBase}' is not a readable local asset directory: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    if (files.length === 0) {
        context.fail(
            prefixNode,
            `Dynamic fetch base '${logicalBase}' contains no files.`,
        );
    }
    const entries = files.map((file) => {
        const key = relative(directory, file).split(sep).join("/");
        const asset = context.registerAsset(
            `${logicalBase}${key}`,
            kind,
        );
        return `{${context.cppString(key)}, ${context.cppString(asset.output)}}`;
    });
    context.reachJsData();
    return {
        kind: "static-fetch-response",
        cpp: "",
        dynamicAssetPathCpp:
            `([&](const std::string& key) -> std::string { ` +
            `static bbl::js::Map<std::string, std::string> paths{${entries.join(", ")}}; ` +
            `auto found = paths.get(key); ` +
            `if (!found.has_value()) throw std::runtime_error("Unknown packaged asset: " + key); ` +
            `return bbl::asset_path(found.value()); })(${suffix.cpp})`,
    };
}

function listFiles(directory: string): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
            result.push(...listFiles(path));
        } else if (entry.isFile()) {
            result.push(path);
        }
    }
    return result;
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

/**
 * This lane's whole policy for the shared converter: a fetched document
 * keeps only the per-kind static fields (its numbers land in the default
 * float sinks, so they render float), and the historical finite guard
 * stays even though JSON.parse cannot trip it.
 */
const staticFetchJsonPolicy: JsonValuePolicy = {
    numberLiteral: floatLiteral,
    nullCpp: "",
    staticMetadata: false,
    nonFiniteMessage: "JSON numeric values must be finite.",
    unsupportedMessage: "Fetched JSON contains an unsupported value.",
};

function jsonValue(
    context: StaticFetchContext,
    value: unknown,
    node: ts.Node,
): Value {
    return jsonToValue(context, staticFetchJsonPolicy, value, node);
}
