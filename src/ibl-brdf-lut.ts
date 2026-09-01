// The shipped gltf-ibl-brdf-lut.rgba16f asset, produced by executing the
// pinned BRDF-LUT compute shader in a headless Chromium instead of
// re-deriving its math in JS. The WGSL is `brdfLutWGSL`, bundled as the
// hdr-brdf-lut.compute chunk of the pinned package and consumed by
// `generateBrdfLut` in lib/loader-gltf/ibl-env-assembly.js; the dispatch
// below mirrors that function's parameters exactly (size, format, layout,
// entry point, bind group, workgroup counts).
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
import { cachedBake, moduleIdentity } from "./bake-cache.js";
import {
    findRepositoryRoot,
    readUpstreamPin,
} from "./upstream-source.js";

// generateBrdfLut's `const size = 256` and the shader's own 256u bounds.
const lutSize = 256;
// rgba16float: four 2-byte half floats per texel.
const lutBytes = lutSize * lutSize * 8;

export function getIblBrdfLutProvenance() {
    const repositoryRoot = findRepositoryRoot(
        dirname(fileURLToPath(import.meta.url)),
    );
    const pin = readUpstreamPin(repositoryRoot);
    return {
        package: `${pin.package}@${pin.version}`,
        sourceCommit: pin.sourceVersion,
        module: "src/loader-gltf/ibl-env-assembly.ts",
        shader: "shaders/hdr-brdf-lut.compute.wgsl",
        sampleCount: 1024,
    } as const;
}

// The chunk file name carries a content hash, so it is resolved through
// the import in ibl-env-assembly.js — the same module whose
// generateBrdfLut dispatch this harness mirrors — rather than hard-coded.
function loadPinnedBrdfLutShader(): string {
    const packageRoot = resolve(
        findRepositoryRoot(dirname(fileURLToPath(import.meta.url))),
        "node_modules",
        "@babylonjs",
        "lite",
    );
    const assemblyPath = resolve(
        packageRoot,
        "lib",
        "loader-gltf",
        "ibl-env-assembly.js",
    );
    const assemblySource = readFileSync(assemblyPath, "utf8");
    const chunkMatch = assemblySource.match(
        /from '(\.\.\/_chunks\/hdr-brdf-lut\.compute-[^']+\.js)'/,
    );
    if (!chunkMatch?.[1]) {
        throw new Error(
            "Pinned Babylon Lite BRDF LUT chunk import was not found.",
        );
    }
    const chunkSource = readFileSync(
        resolve(dirname(assemblyPath), chunkMatch[1]),
        "utf8",
    );
    const shaderMatch = chunkSource.match(
        /const brdfLutWGSL = ("(?:[^"\\]|\\.)*");/,
    );
    if (!shaderMatch?.[1]) {
        throw new Error(
            "Pinned Babylon Lite BRDF LUT shader was not found.",
        );
    }
    const shader: unknown = JSON.parse(shaderMatch[1]);
    if (
        typeof shader !== "string" ||
        !shader.includes("texture_storage_2d<rgba16float,write>") ||
        !shader.includes("@workgroup_size(8,8)") ||
        !shader.includes("=1024u") ||
        !shader.includes(">=256u") ||
        !shader.includes(",0.001)") ||
        !shader.includes(",0.04)") ||
        // Bias in red, scale+bias in green — the byte contract of the
        // .rgba16f asset (identifier-independent).
        !/vec4f\((\w+)\.y,\1\.x\+\1\.y,0\.0,1\.0\)/.test(shader)
    ) {
        throw new Error("Pinned Babylon Lite BRDF LUT semantics changed.");
    }
    return shader;
}

/**
 * The pinned EXT_lights_image_based BRDF LUT, executed on a real WebGPU
 * device and read back as the .rgba16f asset bytes.
 *
 * The readback is row-major with four half floats per texel — the same
 * `(y * 256 + x) * 4` Uint16 layout the former JS re-derivation wrote —
 * so the asset's byte order is unchanged; individual texel values may
 * differ from the old JS output by float16-rounding ULPs.
 */
export async function generateIblBrdfLutRgba16f(): Promise<Uint8Array> {
    return cachedIblBrdfLut(loadPinnedBrdfLutShader(), runBrdfLutInChromium);
}

/**
 * The bake-cache wrapper around the LUT compute. The asset is
 * deterministic in (pinned shader text, size, format, pin, browser) —
 * the bake-cache key — so a repeat compile of a reached scene replays
 * the exact `.rgba16f` bytes instead of launching Chromium. The LUT
 * takes no per-scene inputs, so after one warm run every compile
 * replays. The bake is injectable so the replay contract is testable
 * without a browser launch.
 */
export async function cachedIblBrdfLut(
    shader: string,
    bake: (shader: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
    return cachedBake(
        {
            kind: "ibl-brdf-lut",
            version: "1",
            module: moduleIdentity(import.meta.url),
            browser: true,
            parameters: { lutSize, format: "rgba16float" },
            inputs: [Buffer.from(shader, "utf8")],
        },
        async () => bake(shader),
    );
}

async function runBrdfLutInChromium(shader: string): Promise<Uint8Array> {
    const server = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>IBL BRDF LUT</title>");
    });
    return withBrowserPage(server, {
        serverName: "BRDF LUT server",
        browserRequirement:
            "Exact IBL BRDF LUT generation requires Chrome or Edge.",
        browserArgs: webgpuComputeBrowserArgs,
    }, async (page, origin) => {
        await page.goto(origin);
        await page.evaluate(
            (value) => {
                (
                    globalThis as typeof globalThis & {
                        brdfLutShader: string;
                    }
                ).brdfLutShader = value;
            },
            shader,
        );

        const result: unknown = await page.evaluate(`(async () => {
            const adapter = await navigator.gpu?.requestAdapter();
            if (!adapter) throw new Error("No WebGPU adapter is available for the BRDF LUT.");
            const device = await adapter.requestDevice();
            // Mirrors generateBrdfLut() in the pinned package's
            // lib/loader-gltf/ibl-env-assembly.js: size 256, rgba16float,
            // layout "auto", entry point "main", a single storage-texture
            // binding 0, dispatchWorkgroups(ceil(256/8), ceil(256/8)) over
            // the shader's @workgroup_size(8,8). COPY_SRC is the harness's
            // readback addition; the pin keeps TEXTURE_BINDING to sample
            // the LUT it never reads back.
            const size = ${lutSize};
            const module = device.createShaderModule({ code: globalThis.brdfLutShader });
            const compilation = await module.getCompilationInfo();
            const errors = compilation.messages.filter((message) => message.type === "error");
            if (errors.length > 0) throw new Error(errors.map((message) => message.message).join("\\n"));
            const pipeline = device.createComputePipeline({
                layout: "auto",
                compute: { module, entryPoint: "main" },
            });
            const texture = device.createTexture({
                size: { width: size, height: size },
                format: "rgba16float",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
            });
            const bindGroup = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: texture.createView() }],
            });
            const rowBytes = size * 8;
            const rowPitch = Math.ceil(rowBytes / 256) * 256;
            const readback = device.createBuffer({
                size: rowPitch * size,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
            pass.end();
            encoder.copyTextureToBuffer(
                { texture },
                { buffer: readback, bytesPerRow: rowPitch },
                { width: size, height: size },
            );
            device.queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            const mapped = new Uint8Array(readback.getMappedRange());
            const packed = new Uint8Array(rowBytes * size);
            for (let row = 0; row < size; row++) {
                packed.set(mapped.subarray(row * rowPitch, row * rowPitch + rowBytes), row * rowBytes);
            }
            let binary = "";
            for (let offset = 0; offset < packed.length; offset += 0x8000) {
                binary += String.fromCharCode(...packed.subarray(offset, offset + 0x8000));
            }
            const encoded = btoa(binary);
            readback.unmap();
            readback.destroy();
            texture.destroy();
            device.destroy();
            return encoded;
        })()`);
        if (typeof result !== "string") {
            throw new Error("The BRDF LUT compute returned an invalid result.");
        }
        const bytes = new Uint8Array(Buffer.from(result, "base64"));
        if (bytes.byteLength !== lutBytes) {
            throw new Error(
                `The BRDF LUT readback held ${bytes.byteLength} bytes; expected ${lutBytes}.`,
            );
        }
        return bytes;
    });
}
