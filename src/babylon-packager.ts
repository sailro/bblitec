import { mkdirSync, writeFileSync } from "node:fs";
import { downloadCached } from "./asset-download-cache.js";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { asObject, asRecords } from "./gltf-document.js";

const textureFields = [
    "diffuseTexture",
    "bumpTexture",
    "specularTexture",
    "ambientTexture",
    "lightmapTexture",
    "opacityTexture",
    "reflectionTexture",
] as const;

function hash(value: string): string {
    let result = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        result ^= value.charCodeAt(index);
        result = Math.imul(result, 0x01000193);
    }
    return (result >>> 0).toString(16).padStart(8, "0");
}

function safeTextureName(source: string): string {
    const sourceName = basename(source.split(/[?#]/, 1)[0] ?? source);
    const extension = extname(sourceName);
    const stem = basename(sourceName, extension)
        .replace(/[^A-Za-z0-9._-]/g, "_")
        .replace(/^_+|_+$/g, "") || "texture";
    const safeExtension = extension.replace(/[^A-Za-z0-9.]/g, "");
    return `${hash(source)}-${stem}${safeExtension}`;
}

async function readResource(
    source: string,
    baseDirectory: string,
): Promise<Uint8Array> {
    if (/^https?:\/\//i.test(source)) return downloadCached(source);
    return new Uint8Array(await readFile(resolve(baseDirectory, source)));
}

export async function packageBabylon(
    source: string,
    baseDirectory: string,
    destination: string,
): Promise<void> {
    const rootBytes = await readResource(source, baseDirectory);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rootBytes));
    const document = asObject(parsed);
    if (!document) throw new Error(".babylon JSON root must be an object.");

    const textureOutputs = new Map<string, string>();
    const resources: Array<{ source: string; output: string }> = [];
    const addResource = (resourceSource: string, output: string): void => {
        if (textureOutputs.has(resourceSource)) return;
        textureOutputs.set(resourceSource, output);
        resources.push({ source: resourceSource, output });
    };
    for (const material of asRecords(document.materials)) {
        for (const field of textureFields) {
            const texture = asObject(material[field]);
            if (!texture || typeof texture.name !== "string") {
                continue;
            }
            const resourceSource = /^https?:\/\//i.test(source)
                ? new URL(texture.name, source).toString()
                : resolve(baseDirectory, dirname(source), texture.name);
            if (texture.isCube === true) {
                const outputBase = `textures/${safeTextureName(resourceSource)}`;
                for (const suffix of ["_px", "_nx", "_py", "_ny", "_pz", "_nz"]) {
                    addResource(
                        `${resourceSource}${suffix}.jpg`,
                        `${outputBase}${suffix}.jpg`,
                    );
                }
                texture.name = outputBase;
                continue;
            }
            let output = textureOutputs.get(resourceSource);
            if (!output) {
                output = `textures/${safeTextureName(resourceSource)}`;
                addResource(resourceSource, output);
            }
            texture.name = output;
        }
    }

    let nextResource = 0;
    const workers = Array.from(
        { length: Math.min(8, resources.length) },
        async () => {
            for (;;) {
                const index = nextResource++;
                const resource = resources[index];
                if (!resource) return;
                const output = resolve(dirname(destination), resource.output);
                mkdirSync(dirname(output), { recursive: true });
                writeFileSync(output, await readResource(resource.source, baseDirectory));
            }
        },
    );
    await Promise.all(workers);

    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `${JSON.stringify(document)}\n`);
}
