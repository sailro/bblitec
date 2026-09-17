/** Package supported KTX candidates in source order; the rendering device selects one. */
import { LoweringContext } from "../lowering/context.js";
import { CompressedTextureLowerer } from "../lowering/compressed-texture-lowerer.js";
import { sharedUpstreamStore } from "../upstream-source.js";

const compiledFeatures = new Set(["texture-compression-bc", "texture-compression-astc"]);

/**
 * One lowerer per process. The pin does not change between compiles, and
 * reconstructing its sources is the expensive half.
 */
let cached: CompressedTextureLowerer | undefined;

export function compressedTextureLowerer(): CompressedTextureLowerer {
    if (!cached) {
        cached = new CompressedTextureLowerer(
            new LoweringContext(sharedUpstreamStore()),
        );
    }
    return cached;
}

/**
 * Preserve the pin's suffix mapping, URL rewrite and caller ordering.
 * Unsupported families are not exposed by the native texture loader.
 */
export function compressedTextureUrls(
    baseUrl: string,
    suffixes: readonly string[],
): string[] {
    const compressed = compressedTextureLowerer();
    const supported = suffixes.filter(
        (suffix) => compiledFeatures.has(compressed.suffixFeature(suffix) ?? ""),
    );
    return supported.map(suffix => compressed.rewriteUrl(baseUrl, suffix));
}
