import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
    dirname,
    resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
    webgpuComputeBrowserArgs,
    withBrowserPage,
} from "./browser-harness.js";
import {
    findRepositoryRoot,
    readUpstreamPin,
} from "./upstream-source.js";
import { cachedBake, moduleIdentity } from "./bake-cache.js";

export function getHdrGgxPrefilterProvenance() {
    const repositoryRoot = findRepositoryRoot(
        dirname(fileURLToPath(import.meta.url)),
    );
    const pin = readUpstreamPin(repositoryRoot);
    return {
        package: `${pin.package}@${pin.version}`,
        sourceCommit: pin.sourceVersion,
        module: "src/loader-hdr/hdr-ibl-pipeline.ts",
        shader: "shaders/hdr-prefilter-cube.compute.wgsl",
        sampleCount: 1024,
    } as const;
}

export interface HdrPrefilterSource {
    width: number;
    height: number;
    data: Float32Array;
}

function loadPinnedHdrShaders(): {
    equirectToCube: string;
    prefilterCube: string;
} {
    const pipelinePath = resolve(
        "node_modules",
        "@babylonjs",
        "lite",
        "lib",
        "loader-hdr",
        "hdr-ibl-pipeline.js",
    );
    const bundledSource = readFileSync(pipelinePath, "utf8");
    const prefilterMatch = bundledSource.match(
        /const prefilterCubeWGSL = ("(?:[^"\\]|\\.)*");/,
    );
    const equirectMatch = bundledSource.match(
        /const equirectToCubeWGSL = ("(?:[^"\\]|\\.)*");/,
    );
    if (!prefilterMatch?.[1] || !equirectMatch?.[1]) {
        throw new Error(
            "Pinned Babylon Lite HDR IBL shaders were not found.",
        );
    }
    const prefilterCube: unknown = JSON.parse(prefilterMatch[1]);
    const equirectToCube: unknown = JSON.parse(equirectMatch[1]);
    if (
        typeof prefilterCube !== "string" ||
        // The sample count, whatever miniray named its constant.
        !/const \w+=1024u/.test(prefilterCube) ||
        !prefilterCube.includes("pow(2.0,f32(params.mipLevel)/0.8)") ||
        typeof equirectToCube !== "string" ||
        !equirectToCube.includes("texture_storage_2d_array<rgba16float,write>")
    ) {
        throw new Error("Pinned Babylon Lite HDR IBL semantics changed.");
    }
    return { equirectToCube, prefilterCube };
}


function concatenateFaces(faces: Uint16Array[]): Uint8Array {
    const faceBytes = faces[0]?.byteLength ?? 0;
    const result = new Uint8Array(faceBytes * faces.length);
    for (let face = 0; face < faces.length; face += 1) {
        const bytes = new Uint8Array(
            faces[face]!.buffer,
            faces[face]!.byteOffset,
            faces[face]!.byteLength,
        );
        result.set(bytes, face * faceBytes);
    }
    return result;
}

function decodeMip(base64: string): Uint16Array[] {
    const bytes = Buffer.from(base64, "base64");
    const faceBytes = bytes.byteLength / 6;
    const result: Uint16Array[] = [];
    for (let face = 0; face < 6; face += 1) {
        const copy = Uint8Array.from(bytes.subarray(face * faceBytes, (face + 1) * faceBytes));
        result.push(new Uint16Array(copy.buffer));
    }
    return result;
}

/** The levels as one replayable payload: a u32 mip count, then per mip
 *  a u32 per-face byte length followed by the six faces' bytes. */
function encodePrefilterLevels(levels: Uint16Array[][]): Uint8Array {
    let total = 4;
    for (const mip of levels) {
        total += 4 + mip.reduce((sum, face) => sum + face.byteLength, 0);
    }
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, levels.length, true);
    let offset = 4;
    for (const mip of levels) {
        view.setUint32(offset, mip[0]?.byteLength ?? 0, true);
        offset += 4;
        for (const face of mip) {
            out.set(
                new Uint8Array(
                    face.buffer,
                    face.byteOffset,
                    face.byteLength,
                ),
                offset,
            );
            offset += face.byteLength;
        }
    }
    return out;
}

function decodePrefilterLevels(bytes: Uint8Array): Uint16Array[][] {
    const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
    );
    const mipCount = view.getUint32(0, true);
    let offset = 4;
    const levels: Uint16Array[][] = [];
    for (let mip = 0; mip < mipCount; mip += 1) {
        const faceBytes = view.getUint32(offset, true);
        offset += 4;
        const faces: Uint16Array[] = [];
        for (let face = 0; face < 6; face += 1) {
            const copy = Uint8Array.from(
                bytes.subarray(offset, offset + faceBytes),
            );
            faces.push(new Uint16Array(copy.buffer));
            offset += faceBytes;
        }
        levels.push(faces);
    }
    return levels;
}

export async function prefilterCubemapGgx(
    faceSize: number,
    mipCount: number,
    source: { equirect: HdrPrefilterSource } | { faces: Uint16Array[] },
): Promise<Uint16Array[][]> {
    const equirect = "equirect" in source ? source.equirect : undefined;
    const faces = "faces" in source ? source.faces : undefined;
    if (faces && faces.length !== 6) {
        throw new Error("HDR cubemap mip zero must contain six faces.");
    }
    // With faces given and nothing to prefilter there is no GPU work at all;
    // an equirect source still needs the pinned equirect-to-cube compute for
    // its level zero, so it always launches.
    if (faces && mipCount === 1) return [faces];

    const sourceBytes = equirect
        ? new Uint8Array(
              equirect.data.buffer,
              equirect.data.byteOffset,
              equirect.data.byteLength,
          )
        : concatenateFaces(faces!);
    // The GGX chain is the pin's own compute run in the reference
    // Chromium, deterministic in (source, faceSize, mipCount, pin,
    // browser) — the bake-cache key — so a repeat compile replays the
    // levels instead of launching Chromium (~1.6 s per HDR scene).
    const replayed = await cachedBake(
        {
            kind: "hdr-prefilter",
            version: "1",
            module: moduleIdentity(import.meta.url),
            browser: true,
            parameters: {
                faceSize,
                mipCount,
                source: equirect
                    ? {
                          kind: "equirect",
                          width: equirect.width,
                          height: equirect.height,
                      }
                    : { kind: "faces" },
            },
            inputs: [sourceBytes],
        },
        async () =>
            encodePrefilterLevels(
                await runPrefilterInChromium(
                    faceSize,
                    mipCount,
                    equirect,
                    sourceBytes,
                ),
            ),
    );
    return decodePrefilterLevels(replayed);
}

async function runPrefilterInChromium(
    faceSize: number,
    mipCount: number,
    equirect: HdrPrefilterSource | undefined,
    sourceBytes: Uint8Array,
): Promise<Uint16Array[][]> {
    const server = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>HDR GGX prefilter</title>");
    });
    return withBrowserPage(server, {
        serverName: "HDR prefilter server",
        browserRequirement:
            "Exact HDR GGX prefiltering requires Chrome or Edge.",
        browserArgs: webgpuComputeBrowserArgs,
    }, async (page, origin) => {
        await page.goto(origin);
        await page.evaluate(
            (source) => {
                (
                    globalThis as typeof globalThis & {
                        hdrSource: {
                            base64: string;
                            width: number;
                            height: number;
                            equirect: boolean;
                        };
                    }
                ).hdrSource = source;
            },
            {
                base64: Buffer.from(sourceBytes).toString("base64"),
                width: equirect?.width ?? faceSize,
                height: equirect?.height ?? faceSize,
                equirect: !!equirect,
            },
        );
        const shaders = loadPinnedHdrShaders();
        await page.evaluate(
            (value) => {
                (
                    globalThis as typeof globalThis & {
                        hdrIblShaders: {
                            equirectToCube: string;
                            prefilterCube: string;
                        };
                    }
                ).hdrIblShaders = value;
            },
            shaders,
        );

        const result: unknown = await page.evaluate(`(async () => {
            const adapter = await navigator.gpu?.requestAdapter();
            if (!adapter) throw new Error("No WebGPU adapter is available for HDR prefiltering.");
            const device = await adapter.requestDevice();
            const sourceBinary = atob(globalThis.hdrSource.base64);
            const sourceBytes = new Uint8Array(sourceBinary.length);
            for (let index = 0; index < sourceBinary.length; index++) {
                sourceBytes[index] = sourceBinary.charCodeAt(index);
            }
            const faceSize = ${faceSize};
            const mipCount = ${mipCount};
            let source;
            if (globalThis.hdrSource.equirect) {
                const sourceFloats = new Float32Array(sourceBytes.buffer);
                const pixelCount = globalThis.hdrSource.width * globalThis.hdrSource.height;
                const rgba = new Float32Array(pixelCount * 4);
                for (let pixel = 0; pixel < pixelCount; pixel++) {
                    rgba[pixel * 4] = sourceFloats[pixel * 3];
                    rgba[pixel * 4 + 1] = sourceFloats[pixel * 3 + 1];
                    rgba[pixel * 4 + 2] = sourceFloats[pixel * 3 + 2];
                    rgba[pixel * 4 + 3] = 1;
                }
                const equirectTexture = device.createTexture({
                    size: [globalThis.hdrSource.width, globalThis.hdrSource.height],
                    format: "rgba32float",
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                });
                const rowBytes = globalThis.hdrSource.width * 16;
                const rowPitch = Math.ceil(rowBytes / 256) * 256;
                let upload = new Uint8Array(rgba.buffer);
                if (rowPitch !== rowBytes) {
                    const padded = new Uint8Array(rowPitch * globalThis.hdrSource.height);
                    for (let row = 0; row < globalThis.hdrSource.height; row++) {
                        padded.set(upload.subarray(row * rowBytes, (row + 1) * rowBytes), row * rowPitch);
                    }
                    upload = padded;
                }
                device.queue.writeTexture(
                    { texture: equirectTexture },
                    upload,
                    { bytesPerRow: rowPitch },
                    { width: globalThis.hdrSource.width, height: globalThis.hdrSource.height },
                );
                source = device.createTexture({
                    size: [faceSize, faceSize, 6],
                    format: "rgba16float",
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
                });
                const module = device.createShaderModule({ code: globalThis.hdrIblShaders.equirectToCube });
                const pipeline = device.createComputePipeline({
                    layout: "auto",
                    compute: { module, entryPoint: "main" },
                });
                const paramsBuffer = device.createBuffer({
                    size: 16,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                device.queue.writeBuffer(paramsBuffer, 0, new Uint32Array([
                    faceSize,
                    globalThis.hdrSource.width,
                    globalThis.hdrSource.height,
                    0,
                ]));
                const bindGroup = device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: equirectTexture.createView() },
                        { binding: 1, resource: source.createView({ dimension: "2d-array", arrayLayerCount: 6 }) },
                        { binding: 2, resource: { buffer: paramsBuffer } },
                    ],
                });
                const encoder = device.createCommandEncoder();
                const pass = encoder.beginComputePass();
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, bindGroup);
                pass.dispatchWorkgroups(Math.ceil(faceSize / 8), Math.ceil(faceSize / 8), 6);
                pass.end();
                device.queue.submit([encoder.finish()]);
            } else {
                source = device.createTexture({
                    size: { width: faceSize, height: faceSize, depthOrArrayLayers: 6 },
                    format: "rgba16float",
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
                });
                const sourceRowBytes = faceSize * 8;
                const sourceRowPitch = Math.ceil(sourceRowBytes / 256) * 256;
                const faceBytes = sourceRowBytes * faceSize;
                for (let face = 0; face < 6; face++) {
                    let upload = sourceBytes.subarray(face * faceBytes, (face + 1) * faceBytes);
                    if (sourceRowPitch !== sourceRowBytes) {
                        const padded = new Uint8Array(sourceRowPitch * faceSize);
                        for (let row = 0; row < faceSize; row++) {
                            padded.set(upload.subarray(row * sourceRowBytes, (row + 1) * sourceRowBytes), row * sourceRowPitch);
                        }
                        upload = padded;
                    }
                    device.queue.writeTexture(
                        { texture: source, origin: { x: 0, y: 0, z: face } },
                        upload,
                        { bytesPerRow: sourceRowPitch, rowsPerImage: faceSize },
                        { width: faceSize, height: faceSize, depthOrArrayLayers: 1 },
                    );
                }
            }

            const output = device.createTexture({
                size: { width: faceSize, height: faceSize, depthOrArrayLayers: 6 },
                mipLevelCount: mipCount,
                format: "rgba16float",
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
            });
            const module = device.createShaderModule({ code: globalThis.hdrIblShaders.prefilterCube });
            const compilation = await module.getCompilationInfo();
            const errors = compilation.messages.filter((message) => message.type === "error");
            if (errors.length > 0) throw new Error(errors.map((message) => message.message).join("\\n"));
            const pipeline = device.createComputePipeline({
                layout: "auto",
                compute: { module, entryPoint: "main" },
            });
            const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
            const encodedMips = [];

            for (let mip = 1; mip < mipCount; mip++) {
                const size = faceSize >> mip;
                const params = new Uint32Array([faceSize, mip, mipCount, faceSize]);
                const paramsBuffer = device.createBuffer({
                    size: 16,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                device.queue.writeBuffer(paramsBuffer, 0, params);
                const bindGroup = device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: source.createView({ dimension: "cube" }) },
                        { binding: 1, resource: sampler },
                        { binding: 2, resource: output.createView({
                            dimension: "2d-array",
                            baseMipLevel: mip,
                            mipLevelCount: 1,
                            arrayLayerCount: 6,
                        }) },
                        { binding: 3, resource: { buffer: paramsBuffer } },
                    ],
                });
                const rowBytes = size * 8;
                const rowPitch = Math.ceil(rowBytes / 256) * 256;
                const readback = device.createBuffer({
                    size: rowPitch * size * 6,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
                });
                const encoder = device.createCommandEncoder();
                const pass = encoder.beginComputePass();
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, bindGroup);
                pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), 6);
                pass.end();
                encoder.copyTextureToBuffer(
                    { texture: output, mipLevel: mip },
                    { buffer: readback, bytesPerRow: rowPitch, rowsPerImage: size },
                    { width: size, height: size, depthOrArrayLayers: 6 },
                );
                device.queue.submit([encoder.finish()]);
                await readback.mapAsync(GPUMapMode.READ);
                const mapped = new Uint8Array(readback.getMappedRange());
                const packed = new Uint8Array(rowBytes * size * 6);
                for (let face = 0; face < 6; face++) {
                    for (let row = 0; row < size; row++) {
                        const sourceOffset = (face * size + row) * rowPitch;
                        const destinationOffset = (face * size + row) * rowBytes;
                        packed.set(mapped.subarray(sourceOffset, sourceOffset + rowBytes), destinationOffset);
                    }
                }
                let binary = "";
                for (let offset = 0; offset < packed.length; offset += 0x8000) {
                    binary += String.fromCharCode(...packed.subarray(offset, offset + 0x8000));
                }
                encodedMips.push(btoa(binary));
                readback.unmap();
                readback.destroy();
                paramsBuffer.destroy();
            }
            {
                // Level zero is the source cubemap itself — for an equirect
                // source that is the pinned equirect-to-cube compute's own
                // output, which is what ships as the package's mip zero.
                const rowBytes = faceSize * 8;
                const rowPitch = Math.ceil(rowBytes / 256) * 256;
                const readback = device.createBuffer({
                    size: rowPitch * faceSize * 6,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
                });
                const encoder = device.createCommandEncoder();
                encoder.copyTextureToBuffer(
                    { texture: source },
                    { buffer: readback, bytesPerRow: rowPitch, rowsPerImage: faceSize },
                    { width: faceSize, height: faceSize, depthOrArrayLayers: 6 },
                );
                device.queue.submit([encoder.finish()]);
                await readback.mapAsync(GPUMapMode.READ);
                const mapped = new Uint8Array(readback.getMappedRange());
                const packed = new Uint8Array(rowBytes * faceSize * 6);
                for (let face = 0; face < 6; face++) {
                    for (let row = 0; row < faceSize; row++) {
                        const sourceOffset = (face * faceSize + row) * rowPitch;
                        const destinationOffset = (face * faceSize + row) * rowBytes;
                        packed.set(mapped.subarray(sourceOffset, sourceOffset + rowBytes), destinationOffset);
                    }
                }
                let binary = "";
                for (let offset = 0; offset < packed.length; offset += 0x8000) {
                    binary += String.fromCharCode(...packed.subarray(offset, offset + 0x8000));
                }
                encodedMips.unshift(btoa(binary));
                readback.unmap();
                readback.destroy();
            }
            source.destroy();
            output.destroy();
            device.destroy();
            return encodedMips;
        })()`);
        if (!Array.isArray(result) || !result.every((entry) => typeof entry === "string")) {
            throw new Error("HDR GGX prefilter returned an invalid result.");
        }
        return result.map((entry) => decodeMip(entry));
    });
}
