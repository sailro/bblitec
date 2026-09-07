import { asIndex, asObject, asRecords, GLTF_MATERIAL_EXTENSION_PAYLOAD, type JsonObject } from "./gltf-document.js";
import { ensurePinnedLoaderExecution, pinnedMaterialInputFromGltf } from "./pinned-material-input.js";

/** The loader's material initialization, evaluated during asset packaging.
 * TextureInfos retain their source indices and transforms; GPU uploads and
 * animation still operate on native material records. No equations or extension
 * predicates are repeated here: the same executed mapper supplies composition. */
export async function packageMaterialExtensions(document: JsonObject): Promise<void> {
    const materials = asRecords(document.materials);
    const reached = materials.filter((material) => {
        const extensions = asObject(material.extensions);
        return extensions?.KHR_materials_anisotropy !== undefined ||
            extensions?.KHR_materials_diffuse_transmission !== undefined;
    });
    if (reached.length === 0) return;
    await ensurePinnedLoaderExecution();
    const textures = asRecords(document.textures);
    const images = asRecords(document.images);
    const imageOf = (value: unknown): number | undefined => {
        const index = asIndex(value);
        const texture = index === undefined ? undefined : textures[index];
        const webp = asObject(asObject(texture?.extensions)?.EXT_texture_webp);
        const image = asIndex(webp?.source ?? texture?.source);
        return image !== undefined && images[image] ? image : undefined;
    };
    for (const material of reached) {
        if (GLTF_MATERIAL_EXTENSION_PAYLOAD in material) {
            throw new Error("glTF source already carries compiler material extension metadata.");
        }
        const input = pinnedMaterialInputFromGltf(material, { imageOf });
        const subsurface = asObject(input._subsurface);
        material[GLTF_MATERIAL_EXTENSION_PAYLOAD] = {
            ...(input._anisotropy ? { anisotropy: input._anisotropy } : {}),
            ...(subsurface?.translucency ? { subsurface } : {}),
        };
    }
}
