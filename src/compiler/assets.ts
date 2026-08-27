// Asset registration: from a scene URL to a packaged local file.
//
// A reached asset URL registers once per (kind, source) pair and maps
// to a deterministic hashed output name beside the executable; bundled
// root-relative paths resolve against the pinned upstream tree, and a
// drawn sprite atlas registers the module that draws it rather than a
// URL. The intrinsic lowerers in asset.ts and sprite.ts call these
// through their contexts.
import ts from "typescript";
import { createHash } from "node:crypto";
import { dirname, relative, resolve, sep } from "node:path";
import {
    findRepositoryRoot,
    readUpstreamPin,
} from "../upstream-source.js";
import {
    pixelsAssetSource,
    spriteAtlasAssetSource,
} from "../executed-module-assets.js";
import { dataUrlAssetName, isDataUrl } from "../data-url.js";
import {
    notJson,
    staticJsonValue,
    type StaticJsonContext,
} from "./option-helpers.js";
import type { CompilerSymbols } from "./symbols.js";
import type {
    CompileAsset,
    ResolvedCompileOptions,
} from "./types.js";

export interface AssetRegistryContext {
    readonly assets: Map<string, CompileAsset>;
    readonly assetPayloads: Map<string, string>;
    readonly symbols: CompilerSymbols;
    readonly options: ResolvedCompileOptions;
    unwrap(expression: ts.Expression): ts.Expression;
    compileStringLiteral(
        expression: ts.Expression,
    ): string;
    cppString(value: string): string;
    fail(node: ts.Node, message: string): never;
}

function basenameWithoutExtension(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
}

export function registerAsset(
    context: AssetRegistryContext,
    source: string,
    kind: CompileAsset["kind"],
    faceSize?: number,
): CompileAsset {
    source = resolveBundledAsset(source);
    const key = `${kind}:${source}:${faceSize ?? ""}`;
    const existing = context.assets.get(key);
    if (existing) {
        return existing;
    }
    const asset = assetRecord(
        source,
        kind,
        context.assetPayloads,
        faceSize,
    );
    context.assets.set(key, asset);
    return asset;
}

/**
 * The packaged record one source becomes, without the registry.
 *
 * Two callers register an asset: the compiler, whose sources come out of the
 * entry AST, and generation, whose one source -- a node-particle graph's
 * texture -- is only known once the pin has resolved it against the scene's
 * `textureBaseUrl`. Both must package it under the same name, so the naming
 * rule lives here rather than in either.
 */
export function assetRecord(
    source: string,
    kind: CompileAsset["kind"],
    assetPayloads: Map<string, string>,
    faceSize?: number,
): CompileAsset {
    source = resolveBundledAsset(source);
    const materializationSource = source;
    const sourcePath = source.split(/[?#]/, 1)[0] ?? source;
    // A data URL's text IS the payload, so it names nothing; the media type
    // does the naming instead, which keeps the packaged file's extension --
    // and with it the reached image codec -- derivable as it is for every
    // other asset.
    const inline = isDataUrl(source);
    const sourceName = inline
        ? dataUrlAssetName(source)
        : sourcePath.split(/[\\/]/).pop() || `${kind}.bin`;
    const packagedName =
        kind === "gltf" && /\.gltf$/i.test(sourceName)
            ? sourceName.replace(/\.gltf$/i, ".glb")
            : kind === "hdr-environment"
                ? sourceName.replace(/\.hdr$/i, ".bblhdr")
            : kind === "dds-environment"
                ? sourceName.replace(/\.dds$/i, ".bblhdr")
            // A drawn atlas names the module that draws it; what lands
            // beside the executable is the PNG that module returns.
            : kind === "sprite-atlas"
                ? `${basenameWithoutExtension(sourceName)}.png`
            // A pixels module likewise names the module; what lands beside
            // the executable is the raw RGBA buffer it built.
            : kind === "pixels"
                ? `${basenameWithoutExtension(sourceName)}.rgba`
            // Every splat container packages to the one row layout, so the
            // extension names what lands beside the executable, not what the
            // scene fetched.
            : kind === "splat"
                ? `${basenameWithoutExtension(sourceName)}.splat`
            // A transcoded Basis texture packages as the KTX1 container the
            // runtime's one compressed-texture reader takes.
            : kind === "basis"
                ? `${basenameWithoutExtension(sourceName)}.ktx`
            : sourceName;
    const safeName = packagedName.replace(/[^A-Za-z0-9._-]/g, "_");
    const output =
        kind === "babylon"
            ? `${hash(source)}-${basenameWithoutExtension(safeName)}/${safeName}`
            : `${hash(source)}-${safeName}`;
    if (inline) {
        source =
            "generated:data-url:" +
            createHash("sha256")
                .update(materializationSource)
                .digest("hex");
        const existing = assetPayloads.get(source);
        if (
            existing !== undefined &&
            existing !== materializationSource
        ) {
            throw new Error(
                `Data URL asset identity collision for '${source}'.`,
            );
        }
        assetPayloads.set(source, materializationSource);
    }
    return {
        source,
        output,
        kind,
        ...(faceSize === undefined ? {} : { faceSize }),
    };
}

/**
 * The module and export an identifier names, repository-relative.
 *
 * Every executed-module route asks the same question -- which scene-adjacent
 * module holds this, and under what name -- so the resolution is written once
 * here. The path is relative because it travels through `manifest.json`,
 * which has to stay machine-independent. Returns undefined when the
 * expression is not a module binding at all, which each caller reads as "not
 * my shape" rather than as an error.
 */
export function executedModuleReference(
    context: ExecutedModuleReferenceContext,
    identifier: ts.Expression,
): { module: string; exportName: string } | undefined {
    const unwrapped = context.unwrap(identifier);
    if (!ts.isIdentifier(unwrapped)) return undefined;
    const modulePath = context.symbols.declarationSourcePath(unwrapped);
    if (!modulePath) return undefined;
    const root = findRepositoryRoot(
        dirname(resolve(context.options.fileName)),
    );
    return {
        module: relative(root, modulePath).split(sep).join("/"),
        exportName: unwrapped.text,
    };
}

/** What `executedModuleReference` reads; the asset registry is a superset. */
export interface ExecutedModuleReferenceContext {
    readonly symbols: CompilerSymbols;
    readonly options: ResolvedCompileOptions;
    unwrap(expression: ts.Expression): ts.Expression;
}

/**
 * The asset a zero-argument scene-module call produces, registered under
 * the given kind.
 *
 * Both executed kinds resolve the same way -- the call names the module and
 * the export, and generation runs it -- so the resolution is written once
 * and each caller says which kind it is registering and what to call the
 * thing when it refuses. Returns undefined when the expression is not such
 * a call at all, which the atlas treats as a plain URL.
 */
function registerExecutedModuleAsset(
    context: AssetRegistryContext,
    expression: ts.Expression,
    kind: "sprite-atlas" | "pixels",
    label: string,
): { cpp: string; source: string } | undefined {
    const unwrapped = context.unwrap(expression);
    if (!ts.isCallExpression(unwrapped)) {
        return undefined;
    }
    const reference = executedModuleReference(context, unwrapped.expression);
    if (!reference) {
        return undefined;
    }
    if (unwrapped.arguments.length !== 0) {
        context.fail(
            unwrapped,
            `A ${label} factory takes no arguments.`,
        );
    }
    const asset = registerAsset(
        context,
        kind === "pixels"
            ? pixelsAssetSource(reference.module, reference.exportName)
            : spriteAtlasAssetSource(reference.module, reference.exportName),
        kind,
    );
    return { cpp: context.cppString(asset.output), source: asset.source };
}

/**
 * A sprite atlas that is DRAWN rather than fetched.
 *
 * `getSpriteAtlasDataUrl()` builds its image with canvas2D and returns a
 * data URL, so there is no URL to materialize and no pixels to lower.
 * The call resolves to the module that draws them, and generation runs
 * that module in headless Chromium and bakes the PNG it returns -- the
 * same executable route the pinned GGX prefilter already takes.
 */
export function registerSpriteAtlasAsset(
    context: AssetRegistryContext,
    expression: ts.Expression,
): string {
    return (
        registerExecutedModuleAsset(
            context,
            expression,
            "sprite-atlas",
            "drawn sprite atlas",
        )?.cpp ??
        // A plain URL still works: the atlas is an image either way.
        context.cppString(
            registerAsset(
                context,
                context.compileStringLiteral(expression),
                "texture",
            ).output,
        )
    );
}

/**
 * A texture built from bytes a scene module computes.
 *
 * The same shape as a drawn atlas: a zero-argument export whose result is
 * settled at compile time, so it is executed and baked rather than lowered.
 * The reason differs -- these bytes are arithmetic, not a rasterizer's --
 * but this compiler has no `Math.round` to lower them with, and the palette
 * they build sits one ulp from a rounding boundary in three places, so the
 * bytes the golden's own engine produced are the ones that ship.
 */
export function registerPixelsAsset(
    context: AssetRegistryContext,
    expression: ts.Expression,
): { cpp: string; source: string } {
    const registered = registerExecutedModuleAsset(
        context,
        expression,
        "pixels",
        "pixel buffer",
    );
    if (!registered) {
        context.fail(
            expression,
            "Texture pixels must come from a module function this compiler can run at generation.",
        );
    }
    return registered;
}
export function resolveBundledAsset(source: string): string {
    if (source === "/brdf-lut.png") {
        const pin = readUpstreamPin();
        return `https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/${pin.sourceVersion}/packages/babylon-lite/assets/brdf-lut.png`;
    }
    if (source === "/environment.env") {
        const pin = readUpstreamPin();
        return (
            "https://raw.githubusercontent.com/" +
            `BabylonJS/Babylon-Lite/${pin.sourceVersion}` +
            "/lab/public/textures/environment.env"
        );
    }
    if (source.startsWith("/")) {
        // Root-relative asset paths always mean the pinned lab/public
        // root: corpus scenes and project-owned gates share the demo
        // asset conventions, and repository-local fixtures use
        // relative paths instead.
        const pin = readUpstreamPin();
        return (
            "https://raw.githubusercontent.com/" +
            `BabylonJS/Babylon-Lite/${pin.sourceVersion}` +
            `/lab/public${source}`
        );
    }
    return source;
}

function hash(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * A serialized graph document the scene hands a pinned parser, resolved the
 * one way this compiler resolves them.
 *
 * Two families take one: a node material's NME document and a node
 * particle's NPE document. The corpus writes each of them both ways, and
 * each way gets the answer it deserves — a module exporting the document
 * outright is read as data, which is the fold and cannot drift, while a
 * module that BUILDS its document at load is code this compiler does not
 * lower, so generation runs it instead. Only the reason for the refusal
 * differs between the families, which is why the label is a parameter.
 *
 * `factory` says whether a module that *computes* the document is accepted:
 * a node particle's is (`createSceneNNNNpeJson()`), and a node material's is
 * not, because the pin's own graph loader is what would have to run.
 */
export interface StaticGraphDocumentContext
    extends ExecutedModuleReferenceContext, StaticJsonContext {
    fail(node: ts.Node, message: string): never;
}

export type StaticGraphDocument =
    | { kind: "literal"; graph: Record<string, unknown> }
    | {
          kind: "module";
          module: string;
          exportName: string;
          /** The factory's own call, when it was one. */
          call?: ts.CallExpression;
      };

export function staticGraphDocument(
    context: StaticGraphDocumentContext,
    expression: ts.Expression,
    label: string,
    factory: "factory" | "export-only",
): StaticGraphDocument {
    const literal = staticJsonValue(context, expression);
    if (literal !== notJson) {
        if (
            typeof literal !== "object" ||
            literal === null ||
            Array.isArray(literal)
        ) {
            context.fail(expression, `A ${label} graph is a JSON object.`);
        }
        return {
            kind: "literal",
            graph: literal as Record<string, unknown>,
        };
    }
    const unwrapped = context.unwrap(expression);
    const call =
        factory === "factory" && ts.isCallExpression(unwrapped)
            ? unwrapped
            : undefined;
    const reference = executedModuleReference(
        context,
        call ? call.expression : expression,
    );
    if (!reference) {
        context.fail(
            expression,
            `A ${label} graph must be a static JSON literal or a module ` +
                "export this compiler can run at generation.",
        );
    }
    return {
        kind: "module",
        ...reference,
        ...(call ? { call } : {}),
    };
}
