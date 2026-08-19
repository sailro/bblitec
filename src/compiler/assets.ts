// Asset registration: from a scene URL to a packaged local file.
//
// A reached asset URL registers once per (kind, source) pair and maps
// to a deterministic hashed output name beside the executable; bundled
// root-relative paths resolve against the pinned upstream tree, and a
// drawn sprite atlas registers the module that draws it rather than a
// URL. The intrinsic lowerers in asset.ts and sprite.ts call these
// through their contexts.
import ts from "typescript";
import { dirname, relative, resolve, sep } from "node:path";
import {
    findRepositoryRoot,
    readUpstreamPin,
} from "../upstream-source.js";
import {
    pixelsAssetSource,
    spriteAtlasAssetSource,
} from "../sprite-atlas-packager.js";
import type { CompilerSymbols } from "./symbols.js";
import type {
    CompileAsset,
    ResolvedCompileOptions,
} from "./types.js";

export interface AssetRegistryContext {
    readonly assets: Map<string, CompileAsset>;
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

    const sourcePath = source.split(/[?#]/, 1)[0] ?? source;
    const sourceName = sourcePath.split(/[\\/]/).pop() || `${kind}.bin`;
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
            : sourceName;
    const safeName = packagedName.replace(/[^A-Za-z0-9._-]/g, "_");
    const output =
        kind === "babylon"
            ? `${hash(source)}-${basenameWithoutExtension(safeName)}/${safeName}`
            : `${hash(source)}-${safeName}`;
    const asset: CompileAsset = {
        source,
        output,
        kind,
        ...(faceSize === undefined ? {} : { faceSize }),
    };
    context.assets.set(key, asset);
    return asset;
}

/**
 * A sprite atlas that is DRAWN rather than fetched.
 *
 * `getSpriteAtlasDataUrl()` builds its image with canvas2D and returns a
 * data URL, so there is no URL to materialize and no pixels to lower.
 * The call resolves to the module that draws them, and generation runs
 * that module in headless Chromium and bakes the PNG it returns — the
 * same executable route the pinned GGX prefilter already takes.
 */
export function registerSpriteAtlasAsset(
    context: AssetRegistryContext,
    expression: ts.Expression,
): string {
    const unwrapped = context.unwrap(expression);
    if (ts.isCallExpression(unwrapped)) {
        const callee = context.unwrap(unwrapped.expression);
        const modulePath = ts.isIdentifier(callee)
            ? context.symbols.declarationSourcePath(callee)
            : undefined;
        if (modulePath && ts.isIdentifier(callee)) {
            if (unwrapped.arguments.length !== 0) {
                context.fail(
                    unwrapped,
                    "A drawn sprite atlas factory takes no arguments.",
                );
            }
            const root = findRepositoryRoot(
                dirname(resolve(context.options.fileName)),
            );
            const asset = registerAsset(
                context,
                spriteAtlasAssetSource(
                    relative(root, modulePath)
                        .split(sep)
                        .join("/"),
                    callee.text,
                ),
                "sprite-atlas",
            );
            return context.cppString(asset.output);
        }
    }
    // A plain URL still works: the atlas is an image either way.
    const url = context.compileStringLiteral(expression);
    return context.cppString(
        registerAsset(context, url, "texture").output,
    );
}

/**
 * A texture built from bytes a scene module computes.
 *
 * The same shape as a drawn atlas: a zero-argument export whose result is
 * settled at compile time, so it is executed and baked rather than lowered.
 * The reason differs — these bytes are arithmetic, not a rasterizer's — but
 * rounding `Math.sin` to an integer is exactly where one libm and another
 * part company, so the bytes the golden's own engine produced are the ones
 * that ship.
 */
export function registerPixelsAsset(
    context: AssetRegistryContext,
    expression: ts.Expression,
): string {
    const unwrapped = context.unwrap(expression);
    const callee = ts.isCallExpression(unwrapped)
        ? context.unwrap(unwrapped.expression)
        : undefined;
    const modulePath =
        callee && ts.isIdentifier(callee)
            ? context.symbols.declarationSourcePath(callee)
            : undefined;
    if (
        !ts.isCallExpression(unwrapped) ||
        !callee ||
        !ts.isIdentifier(callee) ||
        !modulePath
    ) {
        return context.fail(
            expression,
            "Texture pixels must come from a module function this compiler can run at generation.",
        );
    }
    if (unwrapped.arguments.length !== 0) {
        context.fail(
            unwrapped,
            "A pixel-buffer factory takes no arguments.",
        );
    }
    const root = findRepositoryRoot(
        dirname(resolve(context.options.fileName)),
    );
    const asset = registerAsset(
        context,
        pixelsAssetSource(
            relative(root, modulePath).split(sep).join("/"),
            callee.text,
        ),
        "pixels",
    );
    return context.cppString(asset.output);
}

export function resolveBundledAsset(source: string): string {
    if (source === "/brdf-lut.png") {
        const pin = readUpstreamPin();
        return `https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/${pin.sourceVersion}/packages/babylon-lite/assets/brdf-lut.png`;
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
