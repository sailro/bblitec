#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CompileAsset, CompileError, compileSource } from "./compiler.js";
import { emitUpstreamGenerated } from "./upstream-lower.js";
import { emitAssetSpecializations } from "./asset-specializer.js";
import { packageBabylon } from "./babylon-packager.js";
import { packageGltf } from "./gltf-packager.js";
import { packageHdrEnvironment } from "./hdr-packager.js";

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
    const destination = resolve(outputPath, "assets", asset.output);
    mkdirSync(dirname(destination), { recursive: true });

    if (asset.kind === "babylon") {
        await packageBabylon(asset.source, dirname(inputPath), destination);
        return;
    }

    if (asset.kind === "gltf" && /\.gltf(?:[?#]|$)/i.test(asset.source)) {
        writeFileSync(
            destination,
            await packageGltf(asset.source, dirname(inputPath)),
        );
        return;
    }

    if (asset.kind === "hdr-environment") {
        const bytes = /^https?:\/\//i.test(asset.source)
            ? await fetch(asset.source).then(async (response) => {
                  if (!response.ok) {
                      throw new Error(
                          `Failed to download ${asset.source}: HTTP ${response.status}.`,
                      );
                  }
                  return new Uint8Array(await response.arrayBuffer());
              })
            : new Uint8Array(readFileSync(resolve(dirname(inputPath), asset.source)));
        writeFileSync(
            destination,
            await packageHdrEnvironment(bytes, asset.faceSize ?? 256),
        );
        return;
    }

    if (/^https?:\/\//i.test(asset.source)) {
        const response = await fetch(asset.source);
        if (!response.ok) {
            throw new Error(`Failed to download ${asset.source}: HTTP ${response.status}.`);
        }
        writeFileSync(destination, new Uint8Array(await response.arrayBuffer()));
        return;
    }

    copyFileSync(resolve(dirname(inputPath), asset.source), destination);
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
    emitAssetSpecializations(outputPath, result.manifest.assets);
    emitUpstreamGenerated(outputPath, result.manifest.features, {
        idDiagnostics: options.idDiagnostics,
        pbrDiagnostics: options.pbrDiagnostics,
        shaderVariants: result.manifest.shaderVariants,
        geometryOutputTasks: result.manifest.geometryOutputTasks,
    });
    writeFileSync(resolve(outputPath, "main.cpp"), result.cpp);
    writeFileSync(resolve(outputPath, "features.cmake"), result.cmake);
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
