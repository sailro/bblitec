/**
 * Which compressed container a `loadKtxTexture2D` call fetches.
 *
 * The pin decides this at run time from `device.features`: it keeps every
 * suffix whose feature the adapter reports, tries them in the order the
 * caller listed, and falls back to the base image when none loads. A native
 * build has no network to try a second candidate with, so generation makes
 * the same choice once — over block compression, which is what the
 * validated platform reports. That is the same question
 * `BBLITE_IMAGE_CODECS` answers for an encoded image, and it lands on the
 * golden's own answer by construction: the browser reference runs D3D12,
 * where a WebGPU adapter reports `texture-compression-bc` and neither ASTC
 * nor ETC2. Dawn is D3D12 here too, and SDL_GPU's other targets are
 * generated rather than device-validated
 * (`docs/features.md#platform-validation`), so a build that reached an
 * ASTC-only device would refuse the format by name at upload rather than
 * render something else.
 *
 * A call listing no block-compression suffix refuses rather than packaging
 * the pin's fallback image: the fallback is a different texture, so
 * compiling it would render something the golden does not.
 */
import { LoweringContext } from "../lowering/context.js";
import { CompressedTextureLowerer } from "../lowering/compressed-texture-lowerer.js";
import { sharedUpstreamStore } from "../upstream-source.js";

/** The compressed-format feature a D3D12 adapter reports, and the one the
 *  emitted format table and both backends' upload are built around. */
const compiledFeature = "texture-compression-bc";

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
 * The URL a reached call resolves to, by the pin's own suffix-to-feature
 * mapping and its own URL rewrite — or undefined when the call lists no
 * suffix this build can sample, which is the caller's refusal to raise
 * against its own argument.
 */
export function compressedTextureUrl(
    baseUrl: string,
    suffixes: readonly string[],
): string | undefined {
    const compressed = compressedTextureLowerer();
    const supported = suffixes.filter(
        (suffix) => compressed.suffixFeature(suffix) === compiledFeature,
    );
    // The pin tries its supported suffixes in order and takes the first
    // that loads; a fetch that fails is a generation error here rather than
    // a fall-through, so the first supported suffix is the answer.
    return supported.length === 0
        ? undefined
        : compressed.rewriteUrl(baseUrl, supported[0]!);
}
