// The `.babylon` asset scans generation keys on.
//
// Each function answers one question about the materialized `.babylon`
// documents in a scene's output tree — how many light slots, which
// texture selections, which per-light mesh lists — by reading the assets
// on disk, which are materialized before any emitter runs. Moved here
// from `cli.ts` as text motion (the monolith-remainder audit item); the
// bodies are the CLI's own, unchanged.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CompileAsset } from "./compiler.js";

/**
 * How many Standard light slots the scene's materialized `.babylon` assets
 * ask for. The pinned template sizes its light array at generation time from
 * `MAX_LIGHTS`; native unrolls one slot per light instead, and the count is
 * knowable here because the loader only accepts point lights (`type: 0`) and
 * the asset is on disk before the emitters run.
 */
export interface BabylonLight {
    type?: number;
    includedOnlyMeshesIds?: unknown[];
    excludedMeshesIds?: unknown[];
}

export function babylonLights(
    outputPath: string,
    assets: CompileAsset[],
): BabylonLight[] {
    const result: BabylonLight[] = [];
    for (const asset of assets) {
        if (asset.kind !== "babylon") {
            continue;
        }
        const materialized = resolve(outputPath, "assets", asset.output);
        if (!existsSync(materialized)) {
            continue;
        }
        const document = JSON.parse(
            readFileSync(materialized, "utf8"),
        ) as { lights?: BabylonLight[] };
        result.push(...(document.lights ?? []));
    }
    return result;
}

/**
 * Whether any reached `.babylon` material authors its diffuse texture
 * against the second UV set. The specular and ambient slots always carried
 * that selection; a scene needs it on the diffuse slot only when its assets
 * ask for it, which Sponza's upper walls do.
 */
export function reachedDiffuseUv2(
    outputPath: string,
    assets: CompileAsset[],
): boolean {
    for (const asset of assets) {
        if (asset.kind !== "babylon") {
            continue;
        }
        const materialized = resolve(outputPath, "assets", asset.output);
        if (!existsSync(materialized)) {
            continue;
        }
        const document = JSON.parse(
            readFileSync(materialized, "utf8"),
        ) as {
            materials?: { diffuseTexture?: { coordinatesIndex?: number } }[];
        };
        if (
            (document.materials ?? []).some(
                (material) =>
                    material.diffuseTexture?.coordinatesIndex === 1,
            )
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Whether any reached `.babylon` material carries a bump map. The pinned
 * Standard material composes its normal-map fragment per material, so a
 * scene with none emits the loader, uniform block, shader and texture slot
 * it emitted before.
 */
export function reachedStandardBump(
    outputPath: string,
    assets: CompileAsset[],
): boolean {
    for (const asset of assets) {
        if (asset.kind !== "babylon") {
            continue;
        }
        const materialized = resolve(outputPath, "assets", asset.output);
        if (!existsSync(materialized)) {
            continue;
        }
        const document = JSON.parse(
            readFileSync(materialized, "utf8"),
        ) as { materials?: { bumpTexture?: unknown }[] };
        if (
            (document.materials ?? []).some(
                (material) => material.bumpTexture,
            )
        ) {
            return true;
        }
    }
    return false;
}

export function reachedStandardLights(lights: BabylonLight[]): number {
    return lights.filter((light) => light.type === 0).length;
}

/**
 * Whether any reached light names the meshes it applies to. The pinned
 * engine keeps that as a per-mesh light set, which the Standard uniform
 * block only has to express for a scene whose assets declare one.
 */
export function reachedStandardLightLists(
    lights: BabylonLight[],
): boolean {
    return lights.some(
        (light) =>
            light.type === 0 &&
            ((light.includedOnlyMeshesIds ?? []).length > 0 ||
                (light.excludedMeshesIds ?? []).length > 0),
    );
}
