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
    importPinnedModuleWithExports,
    readPinnedLibraryModule,
} from "./pinned-shader-composer.js";

/** The pinned module that ships both the WGSL and the splicer. */
export const splatPipelineModule =
    "mesh/GaussianSplatting/gaussian-splatting-pipeline.js";

/**
 * The pinned module `attachParsedSplat` dynamically imports when a parse
 * came back carrying spherical harmonics.
 *
 * Its WGSL is BUILT rather than packaged: `buildShShaderSource(degree)`
 * emits one texture binding, one `textureLoad`, one unpack line per
 * coefficient and one polynomial band per degree, so there is no literal to
 * lift. It is module-local, like the DDS loader's `computeSH`, so it is
 * reached through the pin's own text with the symbol re-exported rather
 * than transcribed.
 */
export const splatShPipelineModule =
    "mesh/GaussianSplatting/gaussian-splatting-pipeline-sh.js";

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

/** The record one named export carries. */
export async function pinnedSplatFragment(
    importedName: string,
): Promise<SplatShaderFragment> {
    const modulePath = gsFragmentModules[importedName];
    if (!modulePath) {
        throw new Error(
            `'${importedName}' is not a pinned Gaussian-splat shader ` +
                `fragment; the package exports ` +
                `${Object.keys(gsFragmentModules).join(", ")}.`,
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
            if (entry.kind === "pinned") {
                return await pinnedSplatFragment(entry.exportName);
            }
            return {
                id: entry.id,
                ...(entry.helperFunctions
                    ? { helperFunctions: entry.helperFunctions }
                    : {}),
                fragmentSlots: Object.fromEntries(
                    entry.fragmentSlots.map(({ slot, code }) => [slot, code]),
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

/** One spherical-harmonic degree's module, and what its layout declares. */
export interface PinnedSplatShModule {
    degree: number;
    /** `buildShShaderSource(degree)` exactly as the pin built it. */
    base: string;
    /** The same, with this scene's plugins spliced in when it named any. */
    wgsl: string;
    /**
     * The `rgba32uint` payload textures the pin's own bind-group layout
     * appends at binding 6, from its own `SH_TEXTURE_COUNT` table rather
     * than from the ceiling division retyped here.
     */
    textureCount: number;
}

/**
 * The module the browser compiles for a cloud carrying harmonics.
 *
 * `getOrCreateShPipeline` builds it as `buildShShaderSource(shDegree)`, run
 * through `applyGsFragments` exactly when the `loadSplat` call named
 * plugins — the same splice the stock pipeline performs, so the two arms
 * share one composer.
 */
export async function composeSplatShModule(
    degree: number,
    fragments: readonly SplatShaderFragment[],
): Promise<PinnedSplatShModule> {
    const module = await importPinnedModuleWithExports<{
        buildShShaderSource?: (degree: number) => string;
        SH_TEXTURE_COUNT?: readonly number[];
    }>(splatShPipelineModule, ["buildShShaderSource", "SH_TEXTURE_COUNT"]);
    if (
        typeof module.buildShShaderSource !== "function" ||
        !Array.isArray(module.SH_TEXTURE_COUNT)
    ) {
        throw new Error(
            `The pinned module ${splatShPipelineModule} no longer declares ` +
                "buildShShaderSource beside its SH_TEXTURE_COUNT table.",
        );
    }
    const textureCount = module.SH_TEXTURE_COUNT[degree];
    if (textureCount === undefined || textureCount <= 0) {
        throw new Error(
            `A Gaussian-splat asset parsed to spherical-harmonic degree ` +
                `${degree}, which the pinned SH_TEXTURE_COUNT table does ` +
                "not cover.",
        );
    }
    const base = module.buildShShaderSource(degree);
    return {
        degree,
        textureCount,
        base,
        wgsl:
            fragments.length > 0
                ? await applySplatFragments(base, fragments)
                : base,
    };
}

/** The pin's own splicer over one base module. */
async function applySplatFragments(
    base: string,
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
    return pipeline.applyGsFragments(base, fragments);
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
    return await applySplatFragments(pinnedSplatModuleWgsl(), fragments);
}
