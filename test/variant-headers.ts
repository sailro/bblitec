import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoweringContext } from "../src/lowering/context.js";
import { meshFeaturesHeader } from "../src/lowering/mesh-attribute-features.js";
import { pinnedSharedVariantDecls } from "../src/pinned-pbr-variant-cpp.js";

/**
 * The shared variant bindings header and the mesh-feature header it
 * includes, written into a fixture's `bblite/upstream` include directory.
 */
export function writeSharedVariantHeaders(
    upstreamIncludes: string,
    context: LoweringContext,
    provenance: string,
): void {
    writeFileSync(
        join(upstreamIncludes, "pinned_variant_bindings.hpp"),
        pinnedSharedVariantDecls(context, provenance),
    );
    writeFileSync(
        join(upstreamIncludes, "pinned_mesh_features.hpp"),
        meshFeaturesHeader(context),
    );
}

/**
 * The composition table's feature read for a fixture whose PBR materials
 * compose no features (`_computePbrMaterialFeatures` of 0).
 */
export const featurelessPbrMaterialFeatures =
    "std::uint32_t pinned_pbr_material_features(const Engine&, MaterialHandle) { return 0; }";
