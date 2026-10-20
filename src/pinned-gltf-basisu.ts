import { javascriptModuleUrl } from "./data-url.js";
import type { JsonRecord } from "./json-fields.js";
import {
    importPinnedModuleWithExports,
    installPinnedImportHook,
} from "./pinned-shader-composer.js";
const BASISU_EXTENSION = "KHR_texture_basisu";

/** One upload `gltf-ext-basisu.ts` made: the image it read and its colour space. */
interface BasisuUpload {
    image: number;
    srgb: boolean;
}

/**
 * One material's routing run, handed to the pin as its engine: the KTX2
 * stand-in receives the engine with every upload, so concurrent packaging
 * runs record into their own observation.
 */
export class BasisuObservation {
    public readonly uploads: BasisuUpload[] = [];

    public constructor(
        private readonly transport?: (image: number, srgb: boolean) => object,
    ) {}

    public upload(image: number, srgb: boolean): object {
        this.uploads.push({ image, srgb });
        return this.transport?.(image, srgb) ?? { image, sRGB: srgb };
    }
}

/** Why the pinned extension took an arm this packager does not resolve. */
export class BasisuArmRefusal extends Error {}

export interface PinnedBasisuFeature {
    id: string;
    preMesh: (
        json: JsonRecord,
        binChunk: DataView,
        baseUrl: string,
    ) => Promise<unknown>;
    applyMaterial: (
        mat: JsonRecord,
        ctx: JsonRecord,
    ) => Promise<JsonRecord | null>;
}

let pinnedBasisuFeature: Promise<PinnedBasisuFeature> | undefined;

/**
 * `gltf-ext-basisu.ts`, executed with its two transport imports answered.
 *
 * The KTX2 loader is where the pin hands over an image's bytes and the
 * colour space it wants, so its stand-in records that pair and returns a
 * token texture; the bytes are a marker naming the image (see
 * `basisuImageColorSpaces`). Its bitmap decoder is reached only by the composite
 * ORM arm, and `set-metallic-reflectance.js` only by the specular arm --
 * the two arms that do not end in a compressed upload of a core slot -- so
 * both stand-ins refuse, naming what the pin does there.
 */
export function loadPinnedBasisuFeature(): Promise<PinnedBasisuFeature> {
    pinnedBasisuFeature ??= (async () => {
        const { hook } = installPinnedImportHook(
            (engine: unknown, image: number, srgb: boolean): object => {
                if (!(engine instanceof BasisuObservation)) {
                    throw new Error(
                        "The pinned KTX2 upload reached a basisu routing run " +
                            "with no observation.",
                    );
                }
                return engine.upload(image, srgb);
            },
        );
        const { hook: refuse } = installPinnedImportHook(
            (what: string): never => {
                throw new BasisuArmRefusal(what);
            },
        );
        const marker = "new DataView(buffer).getUint32(0, true)";
        const ktx2 = javascriptModuleUrl(
            `export async function uploadKtx2Texture2D(engine, buffer, sRGB) {
    return globalThis[${JSON.stringify(hook)}](engine, ${marker}, sRGB);
}
export async function decodeKtx2ImageBitmapFromBuffer() {
    globalThis[${JSON.stringify(refuse)}]("composites separate occlusion and metallic-roughness images, which the pinned extension decodes to RGBA through an OffscreenCanvas rather than uploading compressed blocks");
}`,
        );
        const reflectance = javascriptModuleUrl(
            `export function setPbrMetallicReflectance() {
    globalThis[${JSON.stringify(refuse)}]("reaches KHR_materials_specular textures, which the pinned extension uploads through setPbrMetallicReflectance rather than the core texture path");
}`,
        );
        const module = await importPinnedModuleWithExports<{
            default: PinnedBasisuFeature;
        }>(
            "loader-gltf/gltf-ext-basisu.js",
            [],
            new Map([
                ["../texture/ktx2-loader.js", ktx2],
                ["../material/pbr/set-metallic-reflectance.js", reflectance],
            ]),
        );
        const feature = module.default;
        if (
            feature?.id !== BASISU_EXTENSION ||
            !feature.preMesh ||
            !feature.applyMaterial
        ) {
            throw new Error(
                "Pinned gltf-ext-basisu.js no longer exports a default " +
                    `${BASISU_EXTENSION} feature with preMesh and applyMaterial.`,
            );
        }
        return feature;
    })();
    return pinnedBasisuFeature;
}
