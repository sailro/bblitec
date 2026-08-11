import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import {
    dirname,
    resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
    findRepositoryRoot,
    readUpstreamPin,
} from "./upstream-source.js";

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

export const hdrGgxPrefilterReferenceWgsl = String.raw`
struct Params {
    faceSize: u32,
    mipLevel: u32,
    totalMips: u32,
    srcSize: u32,
}

@group(0) @binding(0) var srcCube: texture_cube<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var dstMip: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: Params;

const PI: f32 = 3.14159265359;
const SAMPLE_COUNT: u32 = 1024u;
const FACE_CORNERS = array<vec3<f32>, 24>(
    vec3(1.0, -1.0, 1.0), vec3(-1.0, -1.0, 1.0), vec3(1.0, 1.0, 1.0), vec3(-1.0, 1.0, 1.0),
    vec3(-1.0, -1.0, -1.0), vec3(1.0, -1.0, -1.0), vec3(-1.0, 1.0, -1.0), vec3(1.0, 1.0, -1.0),
    vec3(-1.0, -1.0, -1.0), vec3(-1.0, -1.0, 1.0), vec3(1.0, -1.0, -1.0), vec3(1.0, -1.0, 1.0),
    vec3(1.0, 1.0, -1.0), vec3(1.0, 1.0, 1.0), vec3(-1.0, 1.0, -1.0), vec3(-1.0, 1.0, 1.0),
    vec3(1.0, -1.0, -1.0), vec3(1.0, -1.0, 1.0), vec3(1.0, 1.0, -1.0), vec3(1.0, 1.0, 1.0),
    vec3(-1.0, -1.0, 1.0), vec3(-1.0, -1.0, -1.0), vec3(-1.0, 1.0, 1.0), vec3(-1.0, 1.0, -1.0),
);

fn faceDirection(face: u32, u: f32, v: f32) -> vec3<f32> {
    let offset = face * 4u;
    return normalize(
        FACE_CORNERS[offset] * (1.0 - u) * (1.0 - v) +
        FACE_CORNERS[offset + 1u] * u * (1.0 - v) +
        FACE_CORNERS[offset + 2u] * (1.0 - u) * v +
        FACE_CORNERS[offset + 3u] * u * v
    );
}

fn radicalInverseVdc(bits: u32) -> f32 {
    var value = bits;
    value = (value << 16u) | (value >> 16u);
    value = ((value & 0x55555555u) << 1u) | ((value & 0xAAAAAAAAu) >> 1u);
    value = ((value & 0x33333333u) << 2u) | ((value & 0xCCCCCCCCu) >> 2u);
    value = ((value & 0x0F0F0F0Fu) << 4u) | ((value & 0xF0F0F0F0u) >> 4u);
    value = ((value & 0x00FF00FFu) << 8u) | ((value & 0xFF00FF00u) >> 8u);
    return f32(value) * 2.3283064365386963e-10;
}

fn importanceSampleGgx(xiX: f32, xiY: f32, roughness: f32) -> vec3<f32> {
    let alphaSquared = roughness * roughness;
    let phi = 2.0 * PI * xiX;
    let cosTheta = sqrt((1.0 - xiY) / (1.0 + (alphaSquared - 1.0) * xiY));
    let sinTheta = sqrt(1.0 - cosTheta * cosTheta);
    return vec3<f32>(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);
}

fn distributionGgx(nDotH: f32, alphaSquared: f32) -> f32 {
    let denominator = nDotH * nDotH * (alphaSquared - 1.0) + 1.0;
    return alphaSquared / (PI * denominator * denominator);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let face = id.z;
    let mipSize = params.faceSize >> params.mipLevel;
    if (id.x >= mipSize || id.y >= mipSize || face >= 6u) {
        return;
    }

    let u = f32(id.x) / f32(mipSize);
    let v = f32(id.y) / f32(mipSize);
    let normal = faceDirection(face, u, v);
    let roughness = pow(2.0, f32(params.mipLevel) / 0.8) / f32(params.srcSize);
    var up = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(normal.z) < 0.999);
    let tangent = normalize(cross(up, normal));
    let bitangent = cross(normal, tangent);
    var color = vec3<f32>(0.0);
    var weight = 0.0;
    let sourceSize = f32(params.srcSize);
    let texelSolidAngle = 4.0 * PI / (6.0 * sourceSize * sourceSize);
    let maxMip = f32(params.totalMips) - 1.0;

    for (var sample = 0u; sample < SAMPLE_COUNT; sample++) {
        let xiX = f32(sample) / f32(SAMPLE_COUNT);
        let xiY = radicalInverseVdc(sample);
        let halfTangent = importanceSampleGgx(xiX, xiY, roughness);
        let halfVector = tangent * halfTangent.x + bitangent * halfTangent.y + normal * halfTangent.z;
        let nDotH = max(dot(normal, halfVector), 0.0);
        let light = 2.0 * nDotH * halfVector - normal;
        let nDotL = dot(normal, light);
        if (nDotL > 0.0) {
            let alphaSquared = roughness * roughness;
            let pdf = distributionGgx(nDotH, alphaSquared) / 4.0;
            let sampleSolidAngle = 1.0 / (f32(SAMPLE_COUNT) * max(pdf, 0.0001));
            let lod = clamp(0.5 * log2(sampleSolidAngle / texelSolidAngle) + 1.0, 0.0, maxMip);
            color += textureSampleLevel(srcCube, srcSampler, light, lod).rgb * nDotL;
            weight += nDotL;
        }
    }
    if (weight > 0.0) {
        color /= weight;
    }
    textureStore(dstMip, vec2<i32>(id.xy), i32(face), vec4<f32>(color, 1.0));
}`;

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
        !prefilterCube.includes("const n=1024u") ||
        !prefilterCube.includes("pow(2.0,f32(params.mipLevel)/0.8)") ||
        typeof equirectToCube !== "string" ||
        !equirectToCube.includes("texture_storage_2d_array<rgba16float,write>")
    ) {
        throw new Error("Pinned Babylon Lite HDR IBL semantics changed.");
    }
    return { equirectToCube, prefilterCube };
}

function browserCandidates(): string[] {
    if (process.platform === "win32") {
        return [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ];
    }
    if (process.platform === "darwin") {
        return [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ];
    }
    return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
}

function resolveBrowserPath(): string {
    const candidates = [process.env.CHROME_PATH, ...browserCandidates()]
        .filter((value): value is string => !!value);
    const result = candidates.find((candidate) => existsSync(candidate));
    if (!result) {
        throw new Error("Exact HDR GGX prefiltering requires Chrome or Edge. Set CHROME_PATH.");
    }
    return result;
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

export async function prefilterCubemapGgx(
    mipZero: Uint16Array[],
    faceSize: number,
    mipCount: number,
    equirect?: HdrPrefilterSource,
): Promise<Uint16Array[][]> {
    if (mipZero.length !== 6) throw new Error("HDR cubemap mip zero must contain six faces.");
    if (mipCount === 1) return [mipZero];

    const server = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>HDR GGX prefilter</title>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
        server.close();
        throw new Error("Unable to start the HDR prefilter server.");
    }

    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
        browser = await chromium.launch({
            executablePath: resolveBrowserPath(),
            headless: true,
            args: ["--enable-unsafe-webgpu"],
        });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${address.port}`);
        const sourceBytes = equirect
            ? new Uint8Array(
                  equirect.data.buffer,
                  equirect.data.byteOffset,
                  equirect.data.byteLength,
              )
            : concatenateFaces(mipZero);
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
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
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
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
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
            source.destroy();
            output.destroy();
            device.destroy();
            return encodedMips;
        })()`);
        if (!Array.isArray(result) || !result.every((entry) => typeof entry === "string")) {
            throw new Error("HDR GGX prefilter returned an invalid result.");
        }
        return [mipZero, ...result.map((entry) => decodeMip(entry))];
    } finally {
        await browser?.close();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => error ? reject(error) : resolve()),
        );
    }
}
