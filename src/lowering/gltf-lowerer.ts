/*
 * ──────────────────────── lowered loader leaves ────────────────────────
 *
 * The segments below used to live verbatim inside the loader template.
 * They are now emitted from the pinned declarations' own ASTs,
 * the way `pinned-ubo-writer-lowerer.ts` and `light-lowerer.ts`'s
 * `lowerMatrix` emit theirs: every constant, operator, and field name in
 * the output comes from the pin, and a construct the walk cannot carry
 * refuses generation instead of shipping a stale transcription.
 *
 * Round 1 lowered the animation interpolation and the sampler mapping;
 * round 2 adds the accessor normalization scales
 * (`gltf-ext-quantization.ts`), the COLOR_0 build
 * (`gltf-color-normalize.ts`), the dielectric/iridescence JSON defaults
 * (`gltf-ext-dielectric.ts`, `gltf-ext-iridescence.ts`), the SH prescale
 * (`ibl-env-assembly.ts`, proven identical to `load-env.ts`'s canonical),
 * and the image-processing defaults (`gltf-ext-lights-image-based.ts`).
 *
 * What these emitters own is the translation, never the formula:
 * JavaScript numbers become C++ doubles with one `static_cast<float>`
 * per Float32Array store, `Math.*` becomes `std::*`, the pin's
 * Float32Array lanes become vector members, an absent JSON sampler
 * property becomes a substituted glTF default the soundness check below
 * proves equivalent, and the line layout is the fixed presentation the
 * loader template has always carried. Byte-for-byte stability of the
 * output against the previously hand-written text is pinned by
 * `test/gltf-lowered-leaves.test.ts`.
 */

export { GltfLoaderOptions, GltfLowerer } from "./gltf/loader.js";
export {
    lowerAnimationInterpolationCpp,
} from "./gltf/animation-interpolation.js";
export { lowerSamplerMappingCpp } from "./gltf/sampler-mapping.js";
export {
    lowerAccessorNormalizationCpp,
    lowerVertexColorCpp,
} from "./gltf/accessor-normalization.js";
export { lowerShPrescaleCpp } from "./gltf/sh-prescale.js";
export {
    lowerImageProcessingDefaultsCpp,
} from "./gltf/image-processing-defaults.js";
export { lowerGltfExtensionDefaults } from "./gltf/extension-defaults.js";
export {
    lowerLocalMatrixCpp,
    lowerMatrixComposeCpp,
    lowerMatrixMultiplyCpp,
    lowerMatrixNativeCpp,
} from "./gltf/matrix-leaves.js";
export {
    lowerIblEnvironmentScalarsCpp,
    lowerIblPolynomialCpp,
} from "./gltf/ibl.js";
export { lowerPunctualLightsCpp } from "./gltf/punctual-lights.js";
export { lowerGltfMaterialDefaults } from "./gltf/material-defaults.js";
export { lowerGltfFactorBake } from "./gltf/factor-bake.js";
