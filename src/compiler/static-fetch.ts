import { EmissionMap } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
// Closed asset discovery serves both generation-time inputs and owned fetch
// responses in asynchronous realms. Other asset consumers retain native paths.
import ts from "typescript";
import { argumentAt } from "./syntax.js";
import { readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { floatLiteral } from "../cpp-literals.js";
import { readAssetBytesSync } from "./asset-bytes-sync.js";
import { canonicalLocalAssetSource, resolveBundledAsset } from "./assets.js";
import { deploymentUrl } from "./deployment.js";
import { jsonToValue, type JsonValuePolicy } from "./json-value.js";
import { isStringValue, type CompileAsset, type Value } from "./types.js";

export interface StaticFetchContext extends Pick<
    LoweringServices,
    | "options"
    | "compileValue"
    | "unwrap"
    | "compileStringLiteral"
    | "staticAssetUrlCandidates"
    | "cppString"
    | "bindings"
    | "libraryGlobal"
    | "assetRegistry"
    | "reachJsData"
    | "reachFeature"
    | "dataLowerer"
    | "probeEmission"
    | "fail"
> {}

export function compileStaticFetch(
    context: StaticFetchContext,
    call: ts.CallExpression,
    callee: ts.Identifier,
): Value | undefined {
    if (context.libraryGlobal(callee) !== "fetch") {
        return undefined;
    }
    if (call.arguments.length !== 1) {
        context.fail(
            call,
            "Generation-time fetch requires exactly one static URL argument.",
        );
    }
    const url = argumentAt(call, 0);
    const response = context.options.workers !== undefined;
    const dynamic =
        context.probeEmission(() =>
            compileDynamicDirectoryFetch(
                context,
                url,
                "binary",
                () => true,
                response,
            ),
        ) ??
        context.probeEmission(() =>
            compileDynamicCandidateFetch(
                context,
                url,
                "binary",
                () => true,
                response,
            ),
        );
    if (dynamic) return dynamic;
    if (ts.isIdentifier(url)) {
        const bound = context.bindings.lookupOptional(url);
        if (bound && bound.staticString === undefined) {
            context.fail(
                url,
                `Generation-time fetch URL '${url.text}' lost its static value (${bound.kind}: ${bound.cpp}).`,
            );
        }
    }
    const logicalSource = context.compileStringLiteral(argumentAt(call, 0));
    const source = resolveBundledAsset(
        logicalSource,
        context.options.fileName,
        context.options,
    );
    if (response) {
        const asset = context.assetRegistry.registerAsset(source, "binary");
        return ownedPackagedResponse(
            context,
            url,
            [{ key: logicalSource, logicalSource, output: asset.output }],
            { kind: "string", cpp: context.cppString(logicalSource) },
        );
    }
    return {
        kind: "static-fetch-response",
        cpp: "",
        staticString: source,
        packagedSources: [source],
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
        context.probeEmission(() =>
            compileDynamicDirectoryFetch(context, expression, kind, accepts),
        ) ??
        context.probeEmission(() =>
            compileDynamicCandidateFetch(context, expression, kind, accepts),
        )
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
    response = false,
): Value | undefined {
    const selected = context.compileValue(expression);
    if (selected.staticString !== undefined || !isStringValue(selected)) {
        return undefined;
    }
    const discovered = context
        .staticAssetUrlCandidates()
        .flatMap((logicalSource) => {
            const source = resolveBundledAsset(
                logicalSource,
                context.options.fileName,
                context.options,
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
                            relative(directory, file).split(sep).join("/"),
                        // Keep filesystem discoveries entry-relative: on Unix
                        // a leading slash otherwise denotes a browser public URL.
                        source: canonicalLocalAssetSource(
                            file,
                            context.options.fileName,
                        ),
                    }));
                } catch {
                    return [];
                }
            }
        })
        .filter(({ source }) => accepts(source));
    const candidates = new EmissionMap<
        string,
        { logicalSource: string; source: string }
    >();
    for (const candidate of discovered) {
        if (!candidates.has(candidate.logicalSource)) {
            candidates.set(candidate.logicalSource, candidate);
        }
    }
    if (candidates.size === 0) return undefined;
    if (response)
        return ownedPackagedResponse(
            context,
            expression,
            [...candidates.values()].map(({ logicalSource, source }) => ({
                key: logicalSource,
                logicalSource,
                output: context.assetRegistry.registerAsset(source, kind)
                    .output,
            })),
            selected,
        );
    const entries = [...candidates.values()].map(
        ({ logicalSource, source }) => ({
            key: logicalSource,
            output: context.assetRegistry.registerAsset(source, kind).output,
        }),
    );
    context.reachJsData();
    return {
        kind: "static-fetch-response",
        cpp: "",
        nativeCompanionCaptures: {
            dynamicAssetPathCpp: selected.nativeCaptures ?? [],
        },
        packagedSources: [...candidates.values()].map(
            (candidate) => candidate.source,
        ),
        dynamicAssetPathCpp: packagedAssetLookup(
            context,
            entries,
            expression,
            selected.cpp,
        ),
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
                nativeCompanionCaptures: {
                    dynamicAssetPathCpp:
                        owner.nativeCompanionCaptures?.dynamicAssetPathCpp ??
                        owner.nativeCaptures ??
                        [],
                },
                ...(owner.packagedSources
                    ? {
                          fetchedBytes: {
                              expression: call,
                              sources: owner.packagedSources,
                          },
                      }
                    : {}),
            };
        }
        if (!owner.staticString) {
            context.fail(
                call.expression,
                "Fetched response has no static source.",
            );
        }
        const asset = context.assetRegistry.registerAsset(
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
            fetchedBytes: { expression: call, sources: [asset.source] },
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
    response = false,
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
    if (
        logicalPrefix === undefined ||
        !suffix ||
        suffix.staticString !== undefined
    )
        return undefined;
    if (!isStringValue(suffix)) {
        return undefined;
    }
    const logicalBase = logicalPrefix.endsWith("/")
        ? logicalPrefix
        : `${logicalPrefix}/`;
    const resolvedBase = resolveBundledAsset(
        logicalBase,
        context.options.fileName,
        context.options,
    );
    // Deployment URLs may resolve to public files; other network prefixes
    // still cannot supply a closed directory of packaged assets.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(resolvedBase)) return undefined;
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
    const assets = files.map((file) => {
        const key = relative(directory, file).split(sep).join("/");
        const asset = context.assetRegistry.registerAsset(
            `${logicalBase}${key}`,
            kind,
        );
        return {
            key,
            logicalSource: `${logicalBase}${key}`,
            output: asset.output,
        };
    });
    if (response)
        return ownedPackagedResponse(context, expression, assets, suffix);
    context.reachJsData();
    return {
        kind: "static-fetch-response",
        cpp: "",
        nativeCompanionCaptures: {
            dynamicAssetPathCpp: suffix.nativeCaptures ?? [],
        },
        packagedSources: files,
        dynamicAssetPathCpp: packagedAssetLookup(
            context,
            assets,
            expression,
            suffix.cpp,
        ),
    };
}

function ownedPackagedResponse(
    context: StaticFetchContext,
    node: ts.Node,
    assets: readonly { key: string; logicalSource: string; output: string }[],
    selected: Value,
): Value {
    context.reachFeature("platform:packaged-fetch", node);
    context.reachJsData();
    const entries = assets.map(({ key, logicalSource, output }) => {
        const url = new URL(logicalSource, deploymentUrl(context.options));
        url.hash = "";
        return `{${context.cppString(key)}, ${context.cppString(url.href)}, ${context.cppString(output)}}`;
    });
    const response = context.dataLowerer.leafValue(
            `bbl::pal::fetch_packaged(${selected.cpp}, std::array<bbl::pal::PackagedFetchEntry, ${entries.length}>{{${entries.join(", ")}}})`,
            { kind: "promise", result: { kind: "http-response" } },
        );
    if (response.kind !== "promise" || !response.promiseResult) return response;
    return {
        ...response,
        ...(assets.length === 1 ? {promiseResult: {
            ...response.promiseResult,
            packagedBodySource: assets[0]!.logicalSource,
        }} : {}),
        nativeCaptures: selected.nativeCaptures ?? [],
    };
}

/**
 * The packaged-asset path a dynamic fetch site selects by key.
 *
 * The key-to-output table is one namespace-scope constant per distinct
 * asset set, shared by every site that fetches from it. Its entries are
 * immutable literals, so every realm reads the same table without owning
 * a JS object on another thread; each site keeps only the lookup loop.
 */
function packagedAssetLookup(
    context: StaticFetchContext,
    entries: readonly { key: string; output: string }[],
    node: ts.Node,
    keyCpp: string,
): string {
    const table = context.dataLowerer.stringPairTable(
        "packaged_asset_paths",
        entries.map(({ key, output }) => [key, output] as const),
        node,
    );
    return (
        `([&](const std::string& key) -> std::string { ` +
        `for (const auto& [source, output] : ${table}) ` +
        `if (source == key) return bbl::asset_path(std::string(output)); ` +
        `throw std::runtime_error("Unknown packaged asset: " + key); ` +
        `})(${keyCpp})`
    );
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
