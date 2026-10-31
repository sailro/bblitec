import {
    closeSync,
    existsSync,
    openSync,
    readFileSync,
    readSync,
} from "node:fs";
import { resolve } from "node:path";
import type { CompileAsset } from "./compiler/types.js";
import { glbJsonText } from "./gltf-document.js";
import { asObject, asRecords } from "./json-fields.js";
import { imageCodecForFileName, imageCodecs } from "./image-codec-manifest.js";

function* strings(value: unknown): Generator<string> {
    if (typeof value === "string") yield value;
    else if (Array.isArray(value)) {
        for (const item of value) yield* strings(item);
    } else {
        const object = asObject(value);
        if (object)
            for (const item of Object.values(object)) yield* strings(item);
    }
}

/** How far into a file the codec signatures reach. */
const signatureBytes = Math.max(
    ...imageCodecs.flatMap(({ signatures }) =>
        signatures.map(({ offset, bytes }) => offset + bytes.length),
    ),
);

/** A file's first `length` bytes, or all of a shorter file. */
function readPrefix(path: string, length: number): Buffer {
    const prefix = Buffer.alloc(length);
    const file = openSync(path, "r");
    try {
        return prefix.subarray(0, readSync(file, prefix, 0, length, 0));
    } finally {
        closeSync(file);
    }
}

function encodedImageCodec(bytes: Buffer | undefined): string | undefined {
    if (!bytes) return undefined;
    return imageCodecs.find(({ signatures }) =>
        signatures.every((signature) =>
            bytes
                .subarray(
                    signature.offset,
                    signature.offset + signature.bytes.length,
                )
                .equals(signature.bytes),
        ),
    )?.codec;
}

/**
 * The image codecs a program links: those its packaged assets reach, and
 * WebP for a run-time `createImageBitmap` decode (`image:runtime-decode`),
 * whose bytes generation cannot see.
 */
export function reachedImageCodecs(
    outputPath: string,
    assets: readonly CompileAsset[],
    features: readonly string[] = [],
): string[] {
    const reached = new Set<string>();
    if (features.includes("image:runtime-decode")) reached.add("webp");
    for (const asset of assets) {
        const materialized = resolve(outputPath, "assets", asset.output);
        // Only glTF and .babylon documents are read past their signature.
        const bytes = !existsSync(materialized)
            ? undefined
            : asset.kind === "gltf" || asset.kind === "babylon"
              ? readFileSync(materialized)
              : readPrefix(materialized, signatureBytes);
        // .env containers hold RGBD PNG faces; raw rgba16f LUTs need no codec.
        if (asset.kind === "environment") reached.add("png");
        const encoded = encodedImageCodec(bytes);
        if (encoded) reached.add(encoded);
        const references = [asset.output];
        if (bytes && asset.kind === "gltf") {
            const document = asObject(
                JSON.parse(glbJsonText(bytes) ?? bytes.toString("utf8")),
            );
            for (const image of asRecords(document?.images)) {
                if (typeof image.mimeType === "string")
                    references.push(image.mimeType);
                if (typeof image.uri === "string") references.push(image.uri);
            }
        } else if (bytes && asset.kind === "babylon") {
            references.push(...strings(JSON.parse(bytes.toString("utf8"))));
        }
        for (const reference of references) {
            const lower = reference.toLowerCase();
            const codec =
                imageCodecs.find(
                    ({ mimeType }) =>
                        lower === mimeType ||
                        lower.startsWith(`data:${mimeType};`),
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
