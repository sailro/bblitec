import { importPinnedModuleFetching, installPinnedImportHook, pinnedModuleUrl } from "./pinned-shader-composer.js";
import type { PinnedStandardMaterialInput } from "./pinned-standard-variants.js";

/** Execute loader material construction with texture allocation as the transport boundary. */
export async function pinnedBabylonMaterials(materials: readonly unknown[], loadTextures = true): Promise<PinnedStandardMaterialInput[]> {
    const records: PinnedStandardMaterialInput[] = [];
    const { hook, release } = installPinnedImportHook((material: PinnedStandardMaterialInput) => records.push(material));
    const moduleUrl = (code: string): string => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
    const factory = moduleUrl(`import { createStandardMaterial as create } from ${JSON.stringify(pinnedModuleUrl("material/standard/create-standard-material.js"))};
        export function createStandardMaterial() { const material=create(); globalThis[${JSON.stringify(hook)}](material); return material; }`);
    const redirects = new Map([
        ["../material/standard/create-standard-material.js", factory],
        ["../texture/texture-2d.js", moduleUrl("export async function loadTexture2D() { return {}; }")],
        ["../texture/cube-texture.js", moduleUrl("export async function loadCubeTexture() { return {}; }")],
    ]);
    try {
        const imported = await importPinnedModuleFetching<{
            loadBabylon(engine: object, url: string, options: { loadTextures: boolean }): Promise<unknown>;
        }>("loader-babylon/load-babylon.js", () => Buffer.from(JSON.stringify({ materials })), redirects);
        try { await imported.module.loadBabylon({}, "https://bblite.invalid/materials.babylon", { loadTextures }); }
        finally { imported.release(); }
        return records;
    } finally { release(); }
}
