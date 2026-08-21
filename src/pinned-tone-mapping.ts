/**
 * The tone-mapping curve a scene selects, taken from the pin that owns it.
 *
 * Upstream models a tone mapping as a *value* rather than a closed union:
 * `material/pbr/tone-mapping.ts` declares `{ id, helpersWGSL, callWGSL }` and
 * each algorithm is one exported record, so `pbr-renderable.ts` composes
 * `scene.imageProcessing.toneMapping ?? StandardToneMapping` straight into the
 * fragment. That makes the curve pure data, and this port reads the same
 * records rather than restating a single one: the scene names an export, and
 * the WGSL that reaches the composer is whatever that export carries.
 *
 * The three the package exports live in three modules, because each is
 * tree-shaken independently — a bundle carries only the algorithm it
 * references. So the module is part of the record here too, and an export the
 * pin renames or moves fails at the import rather than composing the default.
 */
import { importPinnedModule } from "./pinned-shader-composer.js";

/** The two halves of a pinned `ToneMapping` the composer takes. */
export interface PinnedToneMapping {
    helpersWGSL: string;
    callWGSL: string;
}

/**
 * Each exported curve and the module it is tree-shaken into, by the name a
 * scene imports it under.
 */
const toneMappingModules: Readonly<Record<string, string>> = {
    StandardToneMapping: "material/pbr/tone-mapping.js",
    AcesToneMapping: "material/pbr/pbr-aces-wgsl.js",
    NeutralToneMapping: "material/pbr/pbr-neutral-wgsl.js",
};

/** The pin's own default, which an unset `toneMapping` resolves to. */
export const defaultToneMappingName = "StandardToneMapping";

/** Whether an imported name is one of the pin's tone-mapping records. */
export function isToneMappingExport(importedName: string): boolean {
    return Object.hasOwn(toneMappingModules, importedName);
}

/** The names a scene may select, for a refusal that lists them. */
export function toneMappingExportNames(): readonly string[] {
    return Object.keys(toneMappingModules);
}

/** The WGSL one named export carries. */
export async function pinnedToneMapping(
    importedName: string,
): Promise<PinnedToneMapping> {
    const modulePath = toneMappingModules[importedName];
    if (!modulePath) {
        throw new Error(
            `'${importedName}' is not a pinned tone mapping; the package ` +
                `exports ${toneMappingExportNames().join(", ")}.`,
        );
    }
    const module = await importPinnedModule<
        Record<string, PinnedToneMapping>
    >(modulePath);
    const record = module[importedName];
    if (!record) {
        throw new Error(
            `The pinned module ${modulePath} no longer exports ` +
                `'${importedName}'.`,
        );
    }
    return { helpersWGSL: record.helpersWGSL, callWGSL: record.callWGSL };
}
