/**
 * Assets a scene module PRODUCES rather than fetches.
 *
 * Two kinds reach this, for two different reasons, and both end the same way:
 * run the module the golden runs, in the engine the golden runs it in, and
 * bake what it returned.
 *
 *   - A drawn sprite atlas (`_shared/sprite-atlas-image.ts`) builds its image
 *     with canvas2D and returns a data URL. Those pixels are a browser
 *     rasterizer's — `arc`, the rotated wedge and `hsl` all antialias in ways
 *     nothing outside a browser reproduces — so it is unlowerable in
 *     principle.
 *   - A computed pixel buffer (`_shared/palette-remap.ts`) is pure
 *     arithmetic, so in principle it could be lowered. It is not lowerable in
 *     THIS compiler: `Math.round` is not among the Math functions the data
 *     model compiles, and the module memoizes through a module-level binding
 *     the model does not carry either. And it would be fragile if it became
 *     lowerable — three of the palette's 768 channel values land 2.8e-14
 *     below a rounding boundary, which is one ulp of `sin`, so any change in
 *     how the expression is evaluated flips an entry and with it a pixel.
 *
 * The tradeoff is the HDR prefilter's, and it is the same one: the baked
 * bytes depend on the Chrome that compiled them. Both kinds record it as a
 * fidelity adaptation.
 */
import { relative, resolve, sep } from "node:path";
import { createSuiteSceneServer } from "./capture-suite-reference.js";
import {
    pageBase64Script,
    runPageGlobal,
} from "./browser-harness.js";

/** The module that produces an asset, and the factory that returns it. */
export interface ExecutedModuleSource {
    /** Absolute path of the scene-adjacent `.ts` module. */
    modulePath: string;
    /** Exported zero-argument function whose result is baked. */
    exportName: string;
}

/** The `source` string a drawn atlas carries through the asset list. */
export const spriteAtlasSourcePrefix = "generated:sprite-atlas:";
/** The `source` string baked pixel bytes carry through the asset list. */
export const pixelsSourcePrefix = "generated:pixels:";

export function spriteAtlasAssetSource(
    repositoryRelativeModulePath: string,
    exportName: string,
): string {
    return `${spriteAtlasSourcePrefix}${repositoryRelativeModulePath}#${exportName}`;
}

export function pixelsAssetSource(
    repositoryRelativeModulePath: string,
    exportName: string,
): string {
    return `${pixelsSourcePrefix}${repositoryRelativeModulePath}#${exportName}`;
}

/**
 * The module and export a generated source names, whichever kind it is.
 *
 * The prefix is matched rather than assumed: the two differ in length, and
 * slicing the wrong one off would leave a path that resolves to nothing in
 * particular instead of failing here.
 */
export function parseExecutedModuleSource(
    source: string,
    repositoryRoot: string,
): ExecutedModuleSource {
    const prefix = [
        spriteAtlasSourcePrefix,
        pixelsSourcePrefix,
    ].find((candidate) => source.startsWith(candidate));
    const separator = source.lastIndexOf("#");
    if (!prefix || separator < 0) {
        throw new Error(
            `Malformed executed-module asset source '${source}'.`,
        );
    }
    return {
        modulePath: resolve(
            repositoryRoot,
            source.slice(prefix.length, separator),
        ),
        exportName: source.slice(separator + 1),
    };
}

/**
 * Run a scene-adjacent module in headless Chromium and return the text its
 * zero-argument export produced.
 *
 * Bytes come back base64-encoded rather than as an array of numbers: the
 * page boundary serializes JSON, so a number per byte costs about four bytes
 * of wire each and turns a megapixel lookup into ten seconds. A data URL
 * already arrives this way, so both kinds now cross as text.
 */
async function evaluateModuleExport(
    source: ExecutedModuleSource,
): Promise<string> {
    // The module is served at its own repository-relative path rather than
    // at the root under its basename, because a scene module may import a
    // SIBLING -- scene 283's pixel buffer and its graph live in one file
    // that reads scene 262's graph next door. A relative specifier only
    // resolves if the module keeps its directory, and the suite server
    // already transpiles any repository `.ts` on demand.
    const root = resolve(".");
    const relativePath = relative(root, source.modulePath)
        .split(sep)
        .join("/");
    if (relativePath.startsWith("..")) {
        throw new Error(
            `Executed module '${source.modulePath}' is outside the ` +
                "repository, so its siblings cannot be served.",
        );
    }
    const specifier = `/${relativePath.replace(/\.ts$/, ".js")}`;
    const server = createSuiteSceneServer(
        `${pageBase64Script}
window.__runModuleExport = () =>
            import(${JSON.stringify(specifier)}).then((module) => {
                    const factory = module[${JSON.stringify(source.exportName)}];
                    if (typeof factory !== "function") {
                        throw new Error(
                            "Module export ${source.exportName} is not a function."
                        );
                    }
                    const value = factory();
                    if (!ArrayBuffer.isView(value)) return value;
                    return bblBase64(new Uint8Array(
                        value.buffer, value.byteOffset, value.byteLength));
                });
`,
    );
    const result: unknown = await runPageGlobal(
        server,
        "__runModuleExport",
        {
            serverName: `${relativePath} server`,
            browserRequirement:
                "Baking a scene module's own output requires Chrome or Edge.",
        },
    );
    if (typeof result !== "string") {
        throw new Error(
            `Module export ${source.exportName} did not return text.`,
        );
    }
    return result;
}

/**
 * Run the atlas module in headless Chromium and return the PNG bytes its
 * factory draws.
 */
export async function drawSpriteAtlasPng(
    source: ExecutedModuleSource,
): Promise<Uint8Array> {
    const dataUrl = await evaluateModuleExport(source);
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match?.[1]) {
        throw new Error(
            "A drawn sprite atlas must return a base64 image/png data URL.",
        );
    }
    return new Uint8Array(Buffer.from(match[1], "base64"));
}

/**
 * Run a pixel-buffer module in headless Chromium and return the bytes its
 * factory built, as the texture upload takes them.
 */
export async function bakePixelBytes(
    source: ExecutedModuleSource,
): Promise<Uint8Array> {
    return new Uint8Array(
        Buffer.from(await evaluateModuleExport(source), "base64"),
    );
}
