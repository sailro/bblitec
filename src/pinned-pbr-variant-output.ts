/**
 * Writes the pin's own composed PBR stages into the generated tree.
 *
 * The renderer currently emits one fragment per scene, converted from a
 * transcription under `src/lowering/templates/renderer/`, and selects
 * per-material behaviour from `materialOptions`/`normalOptions` uniform lanes.
 * Babylon composes one fragment per material feature set instead, so every
 * fork it makes has to be re-expressed here as a uniform branch — which is
 * where hand-written shader arms come from.
 *
 * Generation already composes every material through the pin to check its arms
 * (`pinned-material-arms.ts`). These are that composer's stages, kept rather
 * than discarded: one file per distinct `fragmentKey`, plus the per-variant
 * material UBO layout the pin declares for it. A variant carries only the
 * fields its own extensions contribute, in registration order, which is why the
 * layout travels with the fragment instead of being a monolithic struct.
 */
import type { GeneratedTree } from "./generated-tree.js";
import type { PinnedComposedMaterial } from "./pinned-material-arms.js";

/** A variant name safe to use as a file name. */
function variantFileName(fragmentKey: string): string {
    const safe = fragmentKey.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
    return safe.replace(/^-+|-+$/g, "") || "base";
}

export interface PinnedVariantManifestEntry {
    fragmentKey: string;
    materials: readonly string[];
    vertex: string;
    fragment: string;
    materialUbo: unknown;
    /** The composed stages, for the emitter; omitted from `variants.json`. */
    vertexWgsl: string;
    fragmentWgsl: string;
}

/**
 * Emits `upstream/shaders/variants/` and returns the manifest entries.
 *
 * Nothing consumes these yet — the PALs hold a single `geometry.pbr_fragment`
 * per scene. They are written first because every later step (a pipeline per
 * variant, a variant recorded per renderable, the per-variant material UBO in
 * place of `PbrUniforms`) reads them, and because a variant that stops
 * composing becomes visible in the generated tree immediately.
 */
export function writePinnedPbrVariants(
    tree: GeneratedTree,
    composed: readonly PinnedComposedMaterial[],
): readonly PinnedVariantManifestEntry[] {
    if (composed.length === 0) return [];
    const byKey = new Map<string, PinnedComposedMaterial[]>();
    for (const material of composed) {
        const list = byKey.get(material.fragmentKey) ?? [];
        list.push(material);
        byKey.set(material.fragmentKey, list);
    }
    // Provenance, not runtime payload: `upstream/shaders/` is the directory
    // deployed beside the executable and checked file-by-file before a
    // measurement, so a variant written there would both ship as dead weight
    // and make every built scene read stale. These sit with the other
    // provenance artifacts instead.
    const directory = "upstream/pbr-variants";
    const manifest: PinnedVariantManifestEntry[] = [];
    for (const [fragmentKey, materials] of [...byKey].sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
    )) {
        const name = variantFileName(fragmentKey);
        const vertex = `${name}.vert.wgsl`;
        const fragment = `${name}.frag.wgsl`;
        tree.write(`${directory}/${vertex}`, materials[0]!.vertexWgsl);
        tree.write(`${directory}/${fragment}`, materials[0]!.fragmentWgsl);
        manifest.push({
            fragmentKey,
            materials: materials.map((material) => material.name),
            vertex,
            fragment,
            materialUbo: materials[0]!.materialUboSpec,
            vertexWgsl: materials[0]!.vertexWgsl,
            fragmentWgsl: materials[0]!.fragmentWgsl,
        });
    }
    tree.write(
        `${directory}/variants.json`,
        `${JSON.stringify(
            // The stage text is already on disk beside this file; repeating it
            // inside the manifest would double every variant.
            manifest.map(({ vertexWgsl: _v, fragmentWgsl: _f, ...entry }) =>
                entry
            ),
            undefined,
            4,
        )}\n`,
    );
    return manifest;
}
