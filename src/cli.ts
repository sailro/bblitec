#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CompileAsset, CompileError, compileSource } from "./compiler.js";
import { emitUpstreamGenerated } from "./upstream-lower.js";
import { emitAssetSpecializations } from "./asset-specializer.js";
import { packageBabylon } from "./babylon-packager.js";
import { packageGltf } from "./gltf-packager.js";
import { packageHdrEnvironment } from "./hdr-packager.js";
import { generateIblBrdfLutRgba16f } from "./ibl-brdf-lut.js";
import { readUpstreamPin } from "./upstream-source.js";

interface CliOptions {
    input: string;
    output: string;
    title?: string;
    width?: number;
    height?: number;
    idDiagnostics: boolean;
    pbrDiagnostics: boolean;
}

function usage(): never {
    console.error("Usage: bblitec <entry.ts> --out <directory> [--title <text>] [--width <pixels>] [--height <pixels>] [--id-diagnostics] [--pbr-diagnostics]");
    process.exit(2);
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${flag} expects a positive integer.`);
    }
    return parsed;
}

function parseArguments(arguments_: string[]): CliOptions {
    const input = arguments_[0];
    if (!input || input.startsWith("--")) {
        usage();
    }

    let output: string | undefined;
    let title: string | undefined;
    let width: number | undefined;
    let height: number | undefined;
    let idDiagnostics = false;
    let pbrDiagnostics = false;

    for (let index = 1; index < arguments_.length; index += 1) {
        const flag = arguments_[index];
        const value = arguments_[index + 1];
        switch (flag) {
            case "--out":
                if (!value) usage();
                output = value;
                index += 1;
                break;
            case "--title":
                if (!value) usage();
                title = value;
                index += 1;
                break;
            case "--width":
                width = parsePositiveInteger(value, flag);
                index += 1;
                break;
            case "--height":
                height = parsePositiveInteger(value, flag);
                index += 1;
                break;
            case "--id-diagnostics":
                idDiagnostics = true;
                break;
            case "--pbr-diagnostics":
                pbrDiagnostics = true;
                break;
            default:
                throw new Error(`Unknown argument '${flag}'.`);
        }
    }

    if (!output) {
        usage();
    }

    return {
        input,
        output,
        idDiagnostics,
        pbrDiagnostics,
        ...(title ? { title } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
    };
}

async function materializeAsset(asset: CompileAsset, inputPath: string, outputPath: string): Promise<void> {
    const source = materializedAssetSource(
        asset.source,
        inputPath,
    );
    const destination = resolve(outputPath, "assets", asset.output);
    mkdirSync(dirname(destination), { recursive: true });

    if (asset.source === "generated:pinned-ibl-brdf-lut") {
        writeFileSync(destination, generateIblBrdfLutRgba16f());
        return;
    }

    if (asset.kind === "babylon") {
        await packageBabylon(source, dirname(inputPath), destination);
        return;
    }

    if (asset.kind === "gltf" && /\.gltf(?:[?#]|$)/i.test(source)) {
        writeFileSync(
            destination,
            await packageGltf(source, dirname(inputPath)),
        );
        return;
    }

    if (asset.kind === "hdr-environment") {
        const bytes = /^https?:\/\//i.test(source)
            ? await fetch(source).then(async (response) => {
                  if (!response.ok) {
                      throw new Error(
                          `Failed to download ${source}: HTTP ${response.status}.`,
                      );
                  }
                  return new Uint8Array(await response.arrayBuffer());
              })
            : new Uint8Array(readFileSync(resolve(dirname(inputPath), source)));
        writeFileSync(
            destination,
            await packageHdrEnvironment(bytes, asset.faceSize ?? 256),
        );
        return;
    }

    if (/^https?:\/\//i.test(source)) {
        const response = await fetch(source);
        if (!response.ok) {
            throw new Error(`Failed to download ${source}: HTTP ${response.status}.`);
        }
        writeFileSync(destination, new Uint8Array(await response.arrayBuffer()));
        return;
    }

    copyFileSync(resolve(dirname(inputPath), source), destination);
}

const jpegNamePattern = /\.jpe?g(?:[?#]|$)/i;

function glbReachesJpeg(bytes: Buffer): boolean {
    if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) {
        return false;
    }
    const jsonLength = bytes.readUInt32LE(12);
    if (bytes.length < 20 + jsonLength) {
        return false;
    }
    const document = JSON.parse(
        bytes.subarray(20, 20 + jsonLength).toString("utf8"),
    ) as { images?: { mimeType?: string; uri?: string }[] };
    return (document.images ?? []).some(
        (image) =>
            image.mimeType === "image/jpeg" ||
            (typeof image.uri === "string" &&
                (/^data:image\/jpeg/i.test(image.uri) ||
                    jpegNamePattern.test(image.uri))),
    );
}

function reachedImageCodecs(
    outputPath: string,
    assets: CompileAsset[],
): string[] {
    // PNG stays unconditional: .env RGBD payloads and the RGBD BRDF
    // LUT decode through PNG, and screenshot capture encodes PNG.
    // JPEG is reached only when a materialized asset carries JPEG
    // content; the native build then links the JPEG codec (vcpkg
    // manifest feature "jpeg") and packaging ships its runtime.
    let jpeg = false;
    for (const asset of assets) {
        if (jpegNamePattern.test(asset.output)) {
            jpeg = true;
            break;
        }
        const materialized = resolve(outputPath, "assets", asset.output);
        if (!existsSync(materialized)) {
            continue;
        }
        if (/\.glb$/i.test(asset.output)) {
            jpeg = glbReachesJpeg(readFileSync(materialized));
        } else if (/\.(?:babylon|gltf)$/i.test(asset.output)) {
            const text = readFileSync(materialized, "utf8");
            jpeg =
                /image\/jpeg/i.test(text) ||
                /\.jpe?g["']/i.test(text);
        }
        if (jpeg) {
            break;
        }
    }
    return jpeg ? ["png", "jpeg"] : ["png"];
}

function materializedAssetSource(
    source: string,
    inputPath: string,
): string {
    if (
        !source.startsWith("/") ||
        !inputPath
            .replace(/\\/g, "/")
            .includes(
                "/corpus/babylon-lite/lab/lite/src/lite/",
            )
    ) {
        return source;
    }
    const pin = readUpstreamPin();
    return (
        "https://raw.githubusercontent.com/" +
        `BabylonJS/Babylon-Lite/${pin.sourceVersion}` +
        `/lab/public${source}`
    );
}

async function main(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));
    const inputPath = resolve(options.input);
    const outputPath = resolve(options.output);
    const source = readFileSync(inputPath, "utf8");
    const result = compileSource(source, {
        fileName: inputPath,
        ...(options.title ? { title: options.title } : {}),
        ...(options.width ? { width: options.width } : {}),
        ...(options.height ? { height: options.height } : {}),
    });

    mkdirSync(outputPath, { recursive: true });
    rmSync(resolve(outputPath, "assets"), { recursive: true, force: true });
    rmSync(resolve(outputPath, "upstream"), { recursive: true, force: true });
    await Promise.all(result.manifest.assets.map((asset) => materializeAsset(asset, inputPath, outputPath)));
    const specializationFeatures =
        emitAssetSpecializations(outputPath, result.manifest.assets);
    if (specializationFeatures.imageBasedLighting) {
        const brdfAsset: CompileAsset = {
            source: "generated:pinned-ibl-brdf-lut",
            output: "gltf-ibl-brdf-lut.rgba16f",
            kind: "texture",
        };
        writeFileSync(
            resolve(outputPath, "assets", brdfAsset.output),
            generateIblBrdfLutRgba16f(),
        );
        result.manifest.assets.push(brdfAsset);
    }
    emitUpstreamGenerated(outputPath, result.manifest.features, {
        idDiagnostics: options.idDiagnostics,
        pbrDiagnostics: options.pbrDiagnostics,
        shaderVariants: result.manifest.shaderVariants,
        geometryOutputTasks: result.manifest.geometryOutputTasks,
        gpuDeformation: specializationFeatures.gpuDeformation,
        morphStorage: specializationFeatures.morphStorage,
        textureTransform:
            specializationFeatures.textureTransform,
        imageBasedLighting:
            specializationFeatures.imageBasedLighting,
        gpuInstancing:
            specializationFeatures.gpuInstancing,
        multiLight:
            specializationFeatures.multiLight,
        clearcoat: specializationFeatures.clearcoat,
        sheen: specializationFeatures.sheen,
        iridescence: specializationFeatures.iridescence,
        dispersion: specializationFeatures.dispersion,
        occlusionUv2: specializationFeatures.occlusionUv2,
    });
    writeFileSync(resolve(outputPath, "main.cpp"), result.cpp);
    const imageCodecs = reachedImageCodecs(
        outputPath,
        result.manifest.assets,
    );
    const imageCodecLines = imageCodecs
        .map((codec) => `    "${codec}"`)
        .join("\n");
    writeFileSync(
        resolve(outputPath, "features.cmake"),
        `${result.cmake}
set(BBLITE_IMAGE_CODECS
${imageCodecLines}
)
`,
    );
    writeFileSync(resolve(outputPath, "manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`);
    writeFileSync(
        resolve(outputPath, "fidelity.json"),
        `${JSON.stringify(
            {
                source: result.manifest.source,
                adaptations: result.manifest.adaptations,
            },
            null,
            2,
        )}\n`,
    );

    console.log(`Generated ${outputPath}`);
    console.log(`Features: ${result.manifest.features.join(", ")}`);
    if (result.manifest.assets.length > 0) {
        console.log(`Assets: ${result.manifest.assets.map((asset) => asset.output).join(", ")}`);
    }
}

main().catch((error: unknown) => {
    if (error instanceof CompileError || error instanceof Error) {
        console.error(error.message);
    } else {
        console.error(String(error));
    }
    process.exitCode = 1;
});
