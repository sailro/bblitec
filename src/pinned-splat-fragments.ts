/**
 * The `GsShaderFragment` plugins a `loadSplat` call passes, and the module
 * the pin's own splicer composes from them.
 *
 * Upstream models a splat shader plugin as pure data — `{ id,
 * helperFunctions?, fragmentSlots }` — and `applyGsFragments` in
 * `mesh/GaussianSplatting/gaussian-splatting-pipeline.ts` is what turns a
 * list of them plus the packaged WGSL into the module the browser compiles.
 * That function is EXECUTED here rather than reimplemented, for two reasons
 * that are both in its own body: it concatenates several plugins into one
 * slot, and it then runs a thirty-five-entry field-name mangler over the
 * whole spliced string so a plugin written against `u.projection` agrees
 * with a base the bundler already shortened to `u.p`. A second copy of that
 * table would agree with upstream only until it moved.
 *
 * Which plugins exist is the pin's too. `gs-depth-fragments.ts` exports the
 * two depth records a scene names by importing them, exactly as
 * `tone-mapping.ts` exports its three curves — so this module carries the
 * export-to-module map and nothing about what the records contain. A scene
 * may also declare its own record inline, which is plain data the compiler
 * reads statically.
 *
 * The opt-in is the call site: `loadSplat(scene, url)` composes the stock
 * module and pays nothing, and the pin says why in `applyGsFragments`'s own
 * comment — the mangling table is inlined there "so it tree-shakes out when
 * fragments are never used".
 */
import type { SplatFragmentManifest } from "./compiler/types.js";
import {
    extractPackagedStringLiteral,
    importPinnedModule,
    readPinnedLibraryModule,
} from "./pinned-shader-composer.js";

/** The pinned module that ships both the WGSL and the splicer. */
export const splatPipelineModule =
    "mesh/GaussianSplatting/gaussian-splatting-pipeline.js";

/** One plugin, in the shape `applyGsFragments` reads. */
export interface SplatShaderFragment {
    readonly id: string;
    readonly helperFunctions?: string;
    readonly fragmentSlots: Readonly<Record<string, string>>;
}

/**
 * Each exported plugin and the module it is tree-shaken into, by the name a
 * scene imports it under. Both depth variants live in one module today; the
 * map is per export so a pin that splits them needs no shape change here.
 */
const gsFragmentModules: Readonly<Record<string, string>> = {
    gsLinearDepthFragment: "mesh/GaussianSplatting/gs-depth-fragments.js",
    gsAlphaBlendedDepthFragment: "mesh/GaussianSplatting/gs-depth-fragments.js",
};

/** Whether an imported name is one of the pin's own splat plugins. */
export function isSplatFragmentExport(importedName: string): boolean {
    return Object.hasOwn(gsFragmentModules, importedName);
}

/** The names a scene may import, for a refusal that lists them. */
export function splatFragmentExportNames(): readonly string[] {
    return Object.keys(gsFragmentModules);
}

/** The record one named export carries. */
export async function pinnedSplatFragment(
    importedName: string,
): Promise<SplatShaderFragment> {
    const modulePath = gsFragmentModules[importedName];
    if (!modulePath) {
        throw new Error(
            `'${importedName}' is not a pinned Gaussian-splat shader ` +
                `fragment; the package exports ` +
                `${splatFragmentExportNames().join(", ")}.`,
        );
    }
    const module = await importPinnedModule<
        Record<string, SplatShaderFragment>
    >(modulePath);
    const record = module[importedName];
    if (!record) {
        throw new Error(
            `The pinned module ${modulePath} no longer exports ` +
                `'${importedName}'.`,
        );
    }
    return record;
}

/**
 * The records behind a scene's reached plugin list.
 *
 * A manifest entry is one of the two shapes a scene writes: an export the
 * pin owns, read from the module that owns it, or a record the scene
 * declared, which the compiler already read statically.
 */
export async function splatFragmentRecords(
    manifest: readonly SplatFragmentManifest[],
): Promise<SplatShaderFragment[]> {
    return await Promise.all(
        manifest.map(async (entry) => {
            if (entry.pinnedExport) {
                return await pinnedSplatFragment(entry.pinnedExport);
            }
            if (!entry.record) {
                throw new Error(
                    "A splat shader fragment names neither a pinned export " +
                        "nor a scene-declared record.",
                );
            }
            const { id, helperFunctions, fragmentSlots } = entry.record;
            return {
                id,
                ...(helperFunctions ? { helperFunctions } : {}),
                fragmentSlots: Object.fromEntries(
                    fragmentSlots.map(({ slot, code }) => [slot, code]),
                ),
            };
        }),
    );
}

/** The packaged WGSL both stages are split out of. */
export function pinnedSplatModuleWgsl(): string {
    return extractPackagedStringLiteral(
        readPinnedLibraryModule(splatPipelineModule),
        "WGSL",
    );
}

/**
 * The module the browser compiles for one plugin list: the pin's own
 * `applyGsFragments` over the pin's own WGSL.
 *
 * The list is in the order the `loadSplat` call wrote it, because that is
 * the order upstream concatenates two plugins sharing a slot in.
 */
export async function composeSplatModule(
    fragments: readonly SplatShaderFragment[],
): Promise<string> {
    const pipeline = await importPinnedModule<{
        applyGsFragments?: (
            wgsl: string,
            fragments: readonly SplatShaderFragment[],
        ) => string;
    }>(splatPipelineModule);
    if (typeof pipeline.applyGsFragments !== "function") {
        throw new Error(
            `The pinned module ${splatPipelineModule} no longer exports ` +
                "applyGsFragments.",
        );
    }
    return pipeline.applyGsFragments(pinnedSplatModuleWgsl(), fragments);
}
