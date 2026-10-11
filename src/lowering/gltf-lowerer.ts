/** Pinned glTF lowering families and their source-derived native segments. */

export { type GltfLoaderOptions, GltfLowerer } from "./gltf/loader.js";
export {
    COLOR_CHANNEL_HELPERS_CPP,
    lowerShPrescaleCpp,
} from "./gltf/sh-prescale.js";
export {
    lowerMatrixComposeCpp,
    lowerRootedWorldCpp,
} from "./gltf/matrix-leaves.js";
