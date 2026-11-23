import {
    importPinnedModuleFetching,
    installPinnedImportHook,
    pinnedModuleUrl,
} from "./pinned-shader-composer.js";
import type { PinnedStandardMaterialInput } from "./pinned-standard-variants.js";

import { javascriptModuleUrl } from "./data-url.js";
import type { JsonRecord } from "./json-fields.js";

/** Execute a data-only slice of loadBabylon; no meshes or cameras are supplied. */
async function loadBabylonSlice(
    document: JsonRecord,
    loadTextures: boolean,
    redirects?: ReadonlyMap<string, string>,
) {
    const imported = await importPinnedModuleFetching<{
        loadBabylon(
            engine: object,
            url: string,
            options: { loadTextures: boolean },
        ): Promise<{ entities: JsonRecord[] }>;
    }>(
        "loader-babylon/load-babylon.js",
        () => Buffer.from(JSON.stringify(document)),
        redirects,
    );
    try {
        return await imported.module.loadBabylon(
            {},
            "https://bblite.invalid/asset.babylon",
            { loadTextures },
        );
    } finally {
        imported.release();
    }
}

export async function pinnedBabylonLightFacts(lights: unknown) {
    const loaded = await loadBabylonSlice({ lights }, false);
    for (const light of loaded.entities)
        if (light.lightType !== "point")
            throw new Error("Unsupported .babylon light kind.");
    return {
        pointLights: loaded.entities.length > 0,
        standardLightLists: loaded.entities.some(
            (light) =>
                light.excludedMeshIds instanceof Set ||
                light.includedOnlyMeshIds instanceof Set,
        ),
    };
}

/** Execute loader material construction with texture allocation as the transport boundary. */
export async function pinnedBabylonMaterials(
    materials: readonly unknown[],
    loadTextures = true,
): Promise<PinnedStandardMaterialInput[]> {
    const records: PinnedStandardMaterialInput[] = [];
    const { hook, release } = installPinnedImportHook(
        (material: PinnedStandardMaterialInput) => records.push(material),
    );
    const factory =
        javascriptModuleUrl(`import { createStandardMaterial as create } from ${JSON.stringify(pinnedModuleUrl("material/standard/create-standard-material.js"))};
        export function createStandardMaterial() { const material=create(); globalThis[${JSON.stringify(hook)}](material); return material; }`);
    const redirects = new Map([
        ["../material/standard/create-standard-material.js", factory],
        [
            "../texture/texture-2d.js",
            javascriptModuleUrl(
                "export async function loadTexture2D() { return {}; }",
            ),
        ],
        [
            "../texture/cube-texture.js",
            javascriptModuleUrl(
                "export async function loadCubeTexture() { return {}; }",
            ),
        ],
    ]);
    try {
        await loadBabylonSlice({ materials }, loadTextures, redirects);
        return records;
    } finally {
        release();
    }
}
