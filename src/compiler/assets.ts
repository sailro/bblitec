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
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
    Feature,
    ResolvedCompileOptions,
    Value,
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

/**
 * What a splat container's spherical harmonics package to, beside its rows.
 *
 * The packaged `.splat` IS upstream's own row layout -- a scene fetching a
 * `.splat` directly must produce the same bytes -- so harmonics cannot ride
 * inside it, and `registerAsset` -- the AST-driven entry point -- gives one output
 * file per record. `assetRecord` beneath it is NOT AST-driven and a
 * generation-time second record is possible (a node-particle graph
 * texture already takes that path), so the honest reason to prefer a
 * sidecar is the first one alone: the packaging identity is what a second
 * record would not break either, but a trailer inside the row buffer
 * would. They go
 * to a sidecar named off the row file instead, which is why the suffix is
 * declared here beside the packaged-name rule rather than at either end:
 * `materializeAsset` writes it and the generated loader appends it.
 */
export const SPLAT_HARMONICS_SUFFIX = ".sh";

/**
 * One splat CONTAINER kind, as every site that touches it needs it.
 *
 * The pin's second and third splat entry points differ from `loadSplat` and
 * from each other in a fixed handful of names: the loader a scene calls, the
 * module declaring it, the feature that call reaches, the generated entry
 * point it emits, and the module-local parser the loader reads its rows with.
 * Those names travel together through four passes -- the intrinsic that
 * registers the asset, the packaging that runs the loader, the CLI that reads
 * the observed rotation back and records the adaptation, and the lowering that
 * emits the definition -- so they are stated here once and each site reads a
 * row instead of restating the pairing. A fourth container is then one row
 * plus the loader body, rather than five edits that can disagree.
 */
export interface SplatContainer {
    /** The asset kind this container packages under. */
    readonly kind: Extract<CompileAsset["kind"], "spz" | "sog">;
    /** The pinned entry point a scene calls. */
    readonly loader: string;
    /** The pinned module declaring it, repository-relative. */
    readonly module: string;
    /** The feature that call reaches, which gates the emitted definition. */
    readonly feature: Feature;
    /** The generated entry point the call emits and the lowering defines. */
    readonly entryPoint: string;
    /** The module-local parser that loader reads its rows with. */
    readonly parser: string;
}

export type SplatContainerKind = SplatContainer["kind"];

const SPLAT_CONTAINER_ROWS: readonly SplatContainer[] = [
    {
        kind: "spz",
        loader: "loadSPZ",
        module: "src/loader-splat/load-spz.ts",
        feature: "loader:splat-spz",
        entryPoint: "load_spz",
        parser: "parseSpz",
    },
    {
        kind: "sog",
        loader: "loadSOG",
        module: "src/loader-splat/load-sog.ts",
        feature: "loader:splat-sog",
        entryPoint: "load_sog",
        parser: "parseSogDatas",
    },
];

/**
 * The container rows by the asset kind each packages under.
 *
 * Keyed by the whole asset-kind union rather than by the container kinds
 * alone, so a site holding any packaged asset can ask whether it came out of
 * a container and get `undefined` for a plain `.splat`; iterating `values()`
 * hands back the narrow kind where a site needs it.
 */
export const SPLAT_CONTAINERS: ReadonlyMap<
    CompileAsset["kind"],
    SplatContainer
> = new Map(SPLAT_CONTAINER_ROWS.map((row) => [row.kind, row]));

/**
 * The row one pinned loader's own name selects.
 *
 * The asset intrinsic switches on that name rather than on a kind, so it asks
 * the table in that direction; every other site already holds a kind.
 */
export function splatContainerByLoader(
    loader: string,
): SplatContainer | undefined {
    return SPLAT_CONTAINER_ROWS.find((row) => row.loader === loader);
}

/**
 * The asset kinds that package to the one splat row layout.
 *
 * Three kinds because the pin has three loaders and the call site picks one --
 * none sniffs another's container -- but one packaged form, so every
 * question about the *output* (its name, the sidecar beside it, the feature
 * it joins) is asked of the set rather than of a kind. A fourth container
 * that lands here without joining the set would package under its source
 * extension and be missed by all, which is why the set is the container
 * table plus the plain rows rather than a second hand-kept list.
 */
export const SPLAT_ASSET_KINDS: ReadonlySet<CompileAsset["kind"]> = new Set([
    "splat",
    ...SPLAT_CONTAINERS.keys(),
]);

export function registerAsset(
    context: AssetRegistryContext,
    source: string,
    kind: CompileAsset["kind"],
    faceSize?: number,
): CompileAsset {
    source = resolveBundledAsset(
        source,
        context.options.fileName,
    );
    source = canonicalLocalAssetSource(
        source,
        context.options.fileName,
    );
    const key = `${kind}:${source}:${faceSize ?? ""}`;
    const existing = context.assets.get(key);
    if (existing) {
        return existing;
    }
    // The registry key carries the kind but the packaged name does not, and
    // every splat kind packages to `<stem>.splat` -- so one URL loaded
    // through two entry points would register twice and materialize two
    // different byte sequences into one file, concurrently. No scene does
    // that; it refuses here rather than racing.
    if (SPLAT_ASSET_KINDS.has(kind)) {
        for (const other of SPLAT_ASSET_KINDS) {
            if (
                other !== kind &&
                context.assets.has(`${other}:${source}:${faceSize ?? ""}`)
            ) {
                throw new Error(
                    `'${source}' is loaded as both a '${other}' and a ` +
                        `'${kind}' container; the two pinned loaders parse ` +
                        "it differently and both package to the same file.",
                );
            }
        }
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
 * Package one root-relative browser UI image at the same logical path.
 *
 * A retained style can choose its image at runtime, so unlike an ordinary
 * texture URL it cannot embed one generation-known hashed file name. Keeping
 * the closed, audited browser path below `assets/` lets the style retain that
 * choice while still resolving beside the native executable.
 */
export function registerUiImageAsset(
    context: AssetRegistryContext,
    source: string,
    logicalPath: string,
): CompileAsset {
    const output = logicalPath
        .replace(/\\/g, "/")
        .replace(/^\/+/, "");
    if (
        output.length === 0 ||
        output.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
        throw new Error(
            `Retained UI image path '${logicalPath}' is not a bounded root-relative asset path.`,
        );
    }
    source = resolveBundledAsset(source, context.options.fileName);
    source = canonicalLocalAssetSource(source, context.options.fileName);
    const key = `ui-image:${source}:${output}`;
    const existing = context.assets.get(key);
    if (existing) return existing;
    const collision = [...context.assets.values()].find(
        (asset) => asset.output === output && asset.source !== source,
    );
    if (collision) {
        throw new Error(
            `Retained UI image path '${output}' names both '${collision.source}' and '${source}'.`,
        );
    }
    const asset = {
        ...assetRecord(source, "texture", context.assetPayloads),
        output,
    };
    context.assets.set(key, asset);
    return asset;
}

/**
 * Gives one repository file one manifest identity regardless of how it was
 * discovered. Static URLs are normally entry-relative, while a closed
 * directory scan necessarily discovers absolute filesystem paths. Keeping
 * the source entry-relative makes manifests portable and lets both routes
 * share the same packaged payload and output name.
 */
function canonicalLocalAssetSource(
    source: string,
    entryFileName: string,
): string {
    if (
        isDataUrl(source) ||
        (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source) &&
            !isAbsolute(source))
    ) {
        return source;
    }
    const entryDirectory = dirname(resolve(entryFileName));
    const absoluteSource = isAbsolute(source)
        ? resolve(source)
        : resolve(entryDirectory, source);
    if (!existsSync(absoluteSource)) return source;
    return relative(entryDirectory, absoluteSource)
        .split(sep)
        .join("/");
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
            : SPLAT_ASSET_KINDS.has(kind)
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
function executedModuleReference(
    context: ExecutedModuleReferenceContext,
    identifier: ts.Expression,
): { module: string; exportName: string } | undefined {
    const unwrapped = context.unwrap(identifier);
    if (!ts.isIdentifier(unwrapped)) return undefined;
    if (!context.symbols.isModuleExport(unwrapped)) return undefined;
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
/**
 * Returns a bakeable module-produced pixel buffer when the expression has
 * that shape. Runtime Uint8Array expressions deliberately return undefined
 * so the intrinsic can lower their bytes directly instead of manufacturing
 * an asset.
 */
export function probePixelsAsset(
    context: AssetRegistryContext,
    expression: ts.Expression,
): { cpp: string; source: string } | undefined {
    const unwrapped = context.unwrap(expression);
    // A module call with arguments is a runtime producer, not the
    // zero-argument generation hook. Declining it here lets the intrinsic's
    // native Uint8Array path compile the call normally.
    if (
        ts.isCallExpression(unwrapped) &&
        unwrapped.arguments.length !== 0
    ) {
        return undefined;
    }
    return registerExecutedModuleAsset(
        context,
        expression,
        "pixels",
        "pixel buffer",
    );
}
export function resolveBundledAsset(
    source: string,
    entryFileName?: string,
): string {
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
    if (source.startsWith("/") && entryFileName) {
        const entryDirectory = dirname(resolve(entryFileName));
        const local = resolve(
            entryDirectory,
            `.${source}`,
        );
        if (existsSync(local)) {
            return relative(entryDirectory, local)
                .split(sep)
                .join("/");
        }
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
interface StaticGraphDocumentContext
    extends ExecutedModuleReferenceContext, StaticJsonContext {
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    fail(node: ts.Node, message: string): never;
}

type StaticGraphDocument =
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
    const carried = ts.isIdentifier(unwrapped)
        ? context.lookupOptional(unwrapped)?.staticJson
        : undefined;
    if (carried !== undefined) {
        if (
            typeof carried !== "object" ||
            carried === null ||
            Array.isArray(carried)
        ) {
            context.fail(expression, `A ${label} graph is a JSON object.`);
        }
        return {
            kind: "literal",
            graph: carried as Record<string, unknown>,
        };
    }
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
