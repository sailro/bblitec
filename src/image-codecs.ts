import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CompileAsset } from "./compiler/types.js";
import { asObject, asRecords, glbJsonText } from "./gltf-document.js";
import { imageCodecForFileName, imageCodecs } from "./image-codec-manifest.js";

function* strings(value: unknown): Generator<string> {
    if (typeof value === "string") yield value;
    else if (Array.isArray(value)) {
        for (const item of value) yield* strings(item);
    } else {
        const object = asObject(value);
        if (object) for (const item of Object.values(object)) yield* strings(item);
    }
}

function encodedImageCodec(bytes: Buffer | undefined): string | undefined {
    if (!bytes) return undefined;
    return imageCodecs.find(({ signatures }) => signatures.every((signature) =>
        bytes.subarray(signature.offset, signature.offset + signature.bytes.length).equals(signature.bytes),
    ))?.codec;
}

export function reachedImageCodecs(
    outputPath: string,
    assets: readonly CompileAsset[],
): string[] {
    const reached = new Set<string>();
    for (const asset of assets) {
        const materialized = resolve(outputPath, "assets", asset.output);
        const bytes = existsSync(materialized)
            ? readFileSync(materialized)
            : undefined;
        // .env containers hold RGBD PNG faces; raw rgba16f LUTs need no codec.
        if (asset.kind === "environment") reached.add("png");
        const encoded = encodedImageCodec(bytes);
        if (encoded) reached.add(encoded);
        const references = [asset.output];
        if (bytes && asset.kind === "gltf") {
            const document = asObject(JSON.parse(glbJsonText(bytes) ?? bytes.toString("utf8")));
            for (const image of asRecords(document?.images)) {
                if (typeof image.mimeType === "string") references.push(image.mimeType);
                if (typeof image.uri === "string") references.push(image.uri);
            }
        } else if (bytes && asset.kind === "babylon") {
            references.push(...strings(JSON.parse(bytes.toString("utf8"))));
        }
        for (const reference of references) {
            const lower = reference.toLowerCase();
            const codec = imageCodecs.find(({ mimeType }) =>
                lower === mimeType || lower.startsWith(`data:${mimeType};`),
            ) ?? imageCodecForFileName(reference);
            if (codec) reached.add(codec.codec);
        }
    }
    return [
        ...imageCodecs
            .map(({ codec }) => codec)
            .filter((codec) => reached.has(codec)),
    ];
}
