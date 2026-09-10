import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asObject } from "./gltf-document.js";
import { findRepositoryRoot } from "./repository-root.js";

export interface ImageCodec {
    codec: string;
    mimeType: string;
    extensions: readonly string[];
    signatures: readonly { offset: number; bytes: Buffer }[];
}

/** Image metadata belongs to the vcpkg feature that installs its decoder. */
export function parseImageCodecs(manifest: unknown): ImageCodec[] {
    const features = asObject(asObject(manifest)?.features);
    if (!features) throw new Error("Image codec manifest must declare features.");
    const codecs: ImageCodec[] = [];
    for (const [codec, feature] of Object.entries(features)) {
        const raw = asObject(feature)?.["$bblite-image"];
        if (raw === undefined) continue;
        const metadata = asObject(raw);
        const refuse = (): never => {
            throw new Error(`Invalid image codec metadata for vcpkg feature '${codec}'.`);
        };
        const mimeType = metadata?.mimeType;
        const extensions: unknown = metadata?.extensions;
        const signatures: unknown = metadata?.signatures;
        if (!/^[a-z][a-z0-9-]*$/.test(codec) || typeof mimeType !== "string" ||
            !/^image\/[a-z0-9.+-]+$/.test(mimeType) ||
            !Array.isArray(extensions) || extensions.length === 0 ||
            !Array.isArray(signatures) || signatures.length === 0) return refuse();
        codecs.push({
            codec, mimeType,
            extensions: extensions.map((extension: unknown) => {
                if (typeof extension !== "string" || !/^[a-z0-9]+$/.test(extension)) return refuse();
                return extension;
            }),
            signatures: signatures.map((signature: unknown) => {
                const entry = asObject(signature);
                const offset = entry?.offset;
                const hex = entry?.hex;
                if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
                    typeof hex !== "string" || !/^(?:[0-9a-f]{2})+$/.test(hex)) return refuse();
                return { offset, bytes: Buffer.from(hex, "hex") };
            }),
        });
    }
    if (codecs.length === 0) throw new Error("Image codec manifest declares no image features.");
    return codecs;
}

export const imageCodecs = parseImageCodecs(JSON.parse(readFileSync(resolve(
    findRepositoryRoot(dirname(fileURLToPath(import.meta.url))), "native/vcpkg.json",
), "utf8")));

export function imageCodecForFileName(reference: string): ImageCodec | undefined {
    const separator = reference.search(/[?#]/);
    const name = (separator < 0 ? reference : reference.slice(0, separator)).toLowerCase();
    return imageCodecs.find(({ extensions }) => extensions.some((extension) => name.endsWith(`.${extension}`)));
}
