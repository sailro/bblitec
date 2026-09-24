/**
 * The HDR specular cube, executed.
 *
 * `loadHdrEnvironment` builds its prefiltered cube in two pinned calls:
 * `equirectToCubemapGPU` (upload, the equirect-to-cube compute) and
 * `prefilterCubemapGPU` over `mipLevelCount(faceSize, faceSize)` levels
 * (the exact mip-zero copy, then one importance-sampled GGX dispatch per
 * level). Both are GPU compute, so generation runs them -- the pin's own
 * module, uniform layouts, sampler, dispatch sizes and early stop -- on the
 * pin's own engine in the reference Chromium, and reads the finished cube
 * back. `_enableHdrEnvironmentCopySource` is the pin's switch for the one
 * usage bit a read-back needs; it changes no texel.
 */
import {
    createSuiteSceneServer,
    pinnedBrowserEntryUrl,
    pinnedBrowserModuleUrl,
} from "./capture-suite-reference.js";
import {
    pageBase64Script,
    runPageGlobal,
    webgpuComputeBrowserArgs,
} from "./browser-harness.js";
import { cachedJsonBake, moduleIdentity } from "./bake-cache.js";

export interface HdrPrefilterSource {
    width: number;
    height: number;
    data: Float32Array;
}

/** The served path the page fetches the parsed equirect floats from. */
const equirectPath = "/hdr-equirect.f32";

/** Each level's six faces as rgba16float texels, in face order. */
interface CapturedCube {
    levels: string[];
}

function prefilterModule(faceSize: number, source: HdrPrefilterSource): string {
    return `import { createEngine } from ${JSON.stringify(pinnedBrowserEntryUrl)};
import {
    _enableHdrEnvironmentCopySource,
    equirectToCubemapGPU,
    prefilterCubemapGPU,
} from ${JSON.stringify(pinnedBrowserModuleUrl("loader-hdr/hdr-ibl-pipeline.js"))};
import { mipLevelCount } from ${JSON.stringify(pinnedBrowserModuleUrl("texture/mip-count.js"))};

${pageBase64Script}
window.__prefilterHdr = async () => {
    const engine = await createEngine(document.getElementById("renderCanvas"));
    const device = engine._device;
    const response = await fetch(${JSON.stringify(equirectPath)});
    const hdr = {
        width: ${source.width},
        height: ${source.height},
        data: new Float32Array(await response.arrayBuffer()),
    };
    const faceSize = ${faceSize};
    _enableHdrEnvironmentCopySource();
    // loadHdrEnvironment's steps 3 and 4, as it composes them.
    const srcCube = equirectToCubemapGPU(engine, hdr, faceSize);
    const mipCount = mipLevelCount(faceSize, faceSize);
    const cube = prefilterCubemapGPU(engine, srcCube, faceSize, mipCount);
    const levels = [];
    for (let mip = 0; mip < mipCount; mip++) {
        const size = Math.max(1, faceSize >> mip);
        const rowBytes = size * 8;
        const rowPitch = Math.ceil(rowBytes / 256) * 256;
        const readback = device.createBuffer({
            size: rowPitch * size * 6,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture: cube, mipLevel: mip },
            { buffer: readback, bytesPerRow: rowPitch, rowsPerImage: size },
            { width: size, height: size, depthOrArrayLayers: 6 },
        );
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(readback.getMappedRange());
        const packed = new Uint8Array(rowBytes * size * 6);
        for (let row = 0; row < size * 6; row++) {
            packed.set(mapped.subarray(row * rowPitch, row * rowPitch + rowBytes), row * rowBytes);
        }
        levels.push(bblBase64(packed));
        readback.unmap();
        readback.destroy();
    }
    cube.destroy();
    return { levels };
};
`;
}

function decodeLevel(base64: string): Uint16Array[] {
    const bytes = Buffer.from(base64, "base64");
    const faceBytes = bytes.byteLength / 6;
    const faces: Uint16Array[] = [];
    for (let face = 0; face < 6; face += 1) {
        const copy = Uint8Array.from(
            bytes.subarray(face * faceBytes, (face + 1) * faceBytes),
        );
        faces.push(new Uint16Array(copy.buffer));
    }
    return faces;
}

/**
 * The pinned specular cube for one parsed equirect: every mip level the
 * pin's own `mipLevelCount` gives, each as six rgba16float faces.
 *
 * Deterministic in (source, faceSize, pin, browser) -- the bake-cache key --
 * so a repeat compile replays the levels instead of launching Chromium.
 */
export async function prefilterEquirectGgx(
    faceSize: number,
    equirect: HdrPrefilterSource,
): Promise<Uint16Array[][]> {
    const sourceBytes = new Uint8Array(
        equirect.data.buffer,
        equirect.data.byteOffset,
        equirect.data.byteLength,
    );
    const captured = await cachedJsonBake<CapturedCube>(
        {
            kind: "hdr-prefilter",
            version: "2",
            module: moduleIdentity(import.meta.url),
            browser: true,
            parameters: {
                faceSize,
                width: equirect.width,
                height: equirect.height,
            },
            inputs: [sourceBytes],
        },
        async () =>
            (await runPageGlobal(
                createSuiteSceneServer(prefilterModule(faceSize, equirect), {
                    virtualAssets: { [equirectPath]: sourceBytes },
                }),
                "__prefilterHdr",
                {
                    serverName: "HDR prefilter server",
                    shared: true,
                    browserRequirement:
                        "Executing the pinned HDR GGX prefilter requires Chrome or Edge.",
                    browserArgs: webgpuComputeBrowserArgs,
                },
            )) as CapturedCube,
    );
    if (
        !Array.isArray(captured.levels) ||
        captured.levels.length === 0 ||
        !captured.levels.every((level) => typeof level === "string")
    ) {
        throw new Error("The pinned HDR prefilter returned no levels.");
    }
    return captured.levels.map(decodeLevel);
}
