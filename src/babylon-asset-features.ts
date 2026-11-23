import { readFileSync } from "node:fs";
import {
    asRecords,
    isRecord,
    jsonValue,
    type JsonRecord,
} from "./json-fields.js";
import { pinnedBabylonLightFacts } from "./pinned-babylon-materials.js";

export interface BabylonCompositionAsset {
    materials: readonly unknown[];
    textureModes: readonly boolean[];
    renderableCount: number;
}

/** Project material and light inputs once; do not retain the packaged vertex arrays. */
export async function readBabylonAsset(
    path: string,
    textureModes: readonly boolean[],
) {
    const { lights, composition } = readComposition(path, textureModes);
    return { ...(await pinnedBabylonLightFacts(lights)), composition };
}

function readComposition(path: string, textureModes: readonly boolean[]) {
    const document = jsonValue(
        JSON.parse(readFileSync(path, "utf8")),
        isRecord,
        "Expected a packaged .babylon document.",
    );
    return {
        lights: document.lights,
        composition: {
            materials: asRecords(document.materials),
            textureModes,
            renderableCount: babylonRenderableCount(document),
        },
    };
}

/**
 * The `.babylon` renderable count, mirroring the generated loader's mesh
 * walk (`babylon-loader-cpp.ts`): visible meshes with positions,
 * normals and indices produce one record per valid submesh. The Standard
 * mesh-feature table needs one zero row per record so scene-code mesh
 * handles land at their correct indices behind them.
 */
export function babylonRenderableCount(document: JsonRecord): number {
    let count = 0;
    for (const mesh of asRecords(document.meshes)) {
        if (mesh.isVisible === false) continue;
        if (
            !Array.isArray(mesh.positions) ||
            !Array.isArray(mesh.normals) ||
            !Array.isArray(mesh.indices) ||
            mesh.indices.length === 0
        ) {
            continue;
        }
        const submeshes =
            mesh.subMeshes == null
                ? [{ indexCount: mesh.indices.length }]
                : asRecords(mesh.subMeshes);
        for (const submesh of submeshes) {
            const length = submesh.indexCount ?? 0;
            if (length === 0) {
                continue;
            }
            count += 1;
        }
    }
    return count;
}
