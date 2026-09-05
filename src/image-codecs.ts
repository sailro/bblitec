import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CompileAsset } from "./compiler/types.js";
import { asObject, asRecords, glbJsonText } from "./gltf-document.js";

/** Codecs used by packaged content. Capture is a separate build capability. */
const imageCodecs: ReadonlyArray<{
    codec: string;
    mimeType: string;
    namePattern: RegExp;
}> = [
    { codec: "png", mimeType: "image/png", namePattern: /\.png(?:[?#]|$)/i },
    {
        codec: "jpeg",
        mimeType: "image/jpeg",
        namePattern: /\.jpe?g(?:[?#]|$)/i,
    },
    {
        codec: "webp",
        mimeType: "image/webp",
        namePattern: /\.webp(?:[?#]|$)/i,
    },
];

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
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
    if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
    return undefined;
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
        for (const { codec, mimeType, namePattern } of imageCodecs) {
            if (reached.has(codec)) {
                continue;
            }
            if (references.some((reference) => {
                const lower = reference.toLowerCase();
                return lower === mimeType || lower.startsWith(`data:${mimeType};`) || namePattern.test(reference);
            })) {
                reached.add(codec);
            }
        }
    }
    return [
        ...imageCodecs
            .map(({ codec }) => codec)
            .filter((codec) => reached.has(codec)),
    ];
}
