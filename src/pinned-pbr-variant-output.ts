/**
 * Writes the pin's own composed PBR stages into the generated tree.
 *
 * Babylon composes one fragment per renderable feature set, and both
 * backends draw every PBR material through the composed stages written here
 * — the per-scene transcribed fragment these replaced re-expressed every
 * upstream fork as a uniform branch.
 *
 * These are the composer's own stages: one content-addressed file per distinct
 * vertex or fragment stage, plus the per-pipeline material UBO layout the pin
 * declares for it. A
 * variant carries only the fields its own extensions contribute, in registration
 * order, which is why the layout travels with the fragment instead of being a
 * monolithic struct.
 */
import type { GeneratedTree } from "./generated-tree.js";
import type { PinnedRenderableVariant } from "./pinned-material-arms.js";
import { createHash } from "node:crypto";

/** Stable stage identity: the file exists exactly once for these bytes. */
function stageName(stage: "vert" | "frag", text: string): string {
    const digest = createHash("sha256").update(text).digest("hex");
    return `pbr-${stage}-${digest}.${stage}.wgsl`;
}

/** Stable identity of one vertex/fragment pipeline pair. */
function pipelineDigest(vertex: string, fragment: string): string {
    return createHash("sha256")
        .update(vertex)
        .update("\0")
        .update(fragment)
        .digest("hex");
}

/** How a renderable selects this variant, as the pin's own composition key. */
export interface PinnedVariantSelector {
    materialIndex: number;
    materialName: string;
    materialView?: "no-color" | "esm-shadow";
    meshFeatures: number;
    lightMode: 0 | 1 | 2;
    singleLightType: string;
    toneMapping: boolean;
    /** The geometry-output task the MRT variant draws in; absent for the
     *  colour passes. */
    geometryTask?: number;
}

export interface PinnedVariantManifestEntry {
    fragmentKey: string;
    /** Stable identity of this vertex/fragment pipeline pair. */
    pipeline: string;
    /** Every renderable key that composes exactly these stages. */
    selectors: readonly PinnedVariantSelector[];
    vertex: string;
    fragment: string;
    materialUbo: unknown;
    /** The composed stages, for the emitter; omitted from `variants.json`. */
    vertexWgsl: string;
    fragmentWgsl: string;
}

/**
 * Emits `upstream/pbr-variants/` and returns the manifest entries.
 *
 * Variants are keyed by their composed text rather than by `fragmentKey`: the
 * key names the material's feature set, and two renderables that share it still
 * compose different stages when their light mode, tone mapping or mesh
 * attributes differ. Keying on the text is what makes one file mean one pipeline.
 */
export function writePinnedPbrVariants(
    tree: GeneratedTree,
    composed: readonly PinnedRenderableVariant[],
): readonly PinnedVariantManifestEntry[] {
    if (composed.length === 0) return [];
    const byStages = new Map<
        string,
        {
            variant: PinnedRenderableVariant;
            selectors: PinnedVariantSelector[];
        }
    >();
    for (const variant of composed) {
        const pipeline = pipelineDigest(
            variant.vertexWgsl,
            variant.fragmentWgsl,
        );
        const entry = byStages.get(pipeline) ?? { variant, selectors: [] };
        if (
            entry.variant.vertexWgsl !== variant.vertexWgsl ||
            entry.variant.fragmentWgsl !== variant.fragmentWgsl
        ) {
            throw new Error(`PBR pipeline hash collision '${pipeline}'.`);
        }
        entry.selectors.push({
            materialIndex: variant.materialIndex,
            materialName: variant.materialName,
            ...(variant.materialView
                ? { materialView: variant.materialView }
                : {}),
            meshFeatures: variant.meshFeatures,
            lightMode: variant.lightMode,
            singleLightType: variant.singleLightType,
            toneMapping: variant.toneMapping,
            ...(variant.geometryTask !== undefined
                ? { geometryTask: variant.geometryTask }
                : {}),
        });
        byStages.set(pipeline, entry);
    }
    // Provenance, not runtime payload: `upstream/shaders/` is the directory
    // deployed beside the executable and checked file-by-file before a
    // measurement, so a variant written there would both ship as dead weight
    // and make every built scene read stale. These sit with the other
    // provenance artifacts instead.
    const directory = "upstream/pbr-variants";
    const manifest: PinnedVariantManifestEntry[] = [];
    const writtenStages = new Set<string>();
    const entries = [...byStages.entries()].sort(([, a], [, b]) => {
        const left = `${a.variant.fragmentKey}|${a.variant.armLabel}`;
        const right = `${b.variant.fragmentKey}|${b.variant.armLabel}`;
        return left < right ? -1 : left > right ? 1 : 0;
    });
    for (const [pipeline, { variant, selectors }] of entries) {
        const vertex = stageName("vert", variant.vertexWgsl);
        const fragment = stageName("frag", variant.fragmentWgsl);
        if (!writtenStages.has(vertex)) {
            tree.write(`${directory}/${vertex}`, variant.vertexWgsl);
            writtenStages.add(vertex);
        }
        if (!writtenStages.has(fragment)) {
            tree.write(`${directory}/${fragment}`, variant.fragmentWgsl);
            writtenStages.add(fragment);
        }
        manifest.push({
            fragmentKey: variant.fragmentKey,
            pipeline,
            selectors,
            vertex,
            fragment,
            materialUbo: variant.materialUboSpec,
            vertexWgsl: variant.vertexWgsl,
            fragmentWgsl: variant.fragmentWgsl,
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
