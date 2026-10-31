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
    decodePageBase64,
    pageBase64Script,
    pagePayloadHeader,
    pageTextureLevelsScript,
    runPageGlobal,
    webgpuComputeBrowserArgs,
} from "./browser-harness.js";
import { cachedBake, moduleIdentity } from "./bake-cache.js";
import { HOST_PRIMARY_CANVAS_ID } from "./host-primary-canvas.js";

interface HdrPrefilterSource {
    width: number;
    height: number;
    data: Float32Array;
}

/** The served path the page fetches the parsed equirect floats from. */
const equirectPath = "/hdr-equirect.f32";

/** One rgba16float texel. */
const texelBytes = 8;

/** The cached payload's header words: face size, level count; every level's
 *  six faces follow, level-major, in face order. */
const headerWords = 2;

function faceBytes(faceSize: number, level: number): number {
    return Math.max(1, faceSize >> level) ** 2 * texelBytes;
}

function cubeBytes(faceSize: number, levels: number): number {
    let bytes = 0;
    for (let level = 0; level < levels; level++)
        bytes += faceBytes(faceSize, level) * 6;
    return bytes;
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
${pageTextureLevelsScript}
window.__prefilterHdr = async () => {
    const engine = await createEngine(document.getElementById(${JSON.stringify(HOST_PRIMARY_CANVAS_ID)}));
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
    if (cube.mipLevelCount !== mipCount) {
        throw new Error("prefilterCubemapGPU made " + cube.mipLevelCount + " levels, not " + mipCount + ".");
    }
    const { packed } = await bblReadTextureLevels(device, cube, ${texelBytes});
    cube.destroy();
    return { levels: mipCount, cube: bblBase64(packed) };
};
`;
}

/** The page's result as the cached payload, the cube decoded straight into
 *  it. */
function cachePayload(faceSize: number, result: unknown): Uint8Array {
    if (
        typeof result !== "object" ||
        result === null ||
        !("levels" in result) ||
        !("cube" in result) ||
        typeof result.levels !== "number" ||
        !Number.isSafeInteger(result.levels) ||
        result.levels < 1 ||
        typeof result.cube !== "string"
    )
        throw new Error("The pinned HDR prefilter returned no levels.");
    return decodePageBase64(
        result.cube,
        [faceSize, result.levels],
        cubeBytes(faceSize, result.levels),
        `The pinned HDR prefilter's ${result.levels}-level ${faceSize} cube`,
    );
}

/** A cached payload as faces: views into its one buffer. */
function decodeCube(faceSize: number, payload: Uint8Array): Uint16Array[][] {
    const [size = 0, levelCount = 0] =
        pagePayloadHeader(payload, headerWords) ?? [];
    if (
        size !== faceSize ||
        levelCount < 1 ||
        levelCount > 32 ||
        payload.byteLength !== headerWords * 4 + cubeBytes(faceSize, levelCount)
    )
        throw new Error(
            `A prefiltered HDR payload does not hold a ${faceSize} cube.`,
        );
    const levels: Uint16Array[][] = [];
    let offset = payload.byteOffset + headerWords * 4;
    for (let level = 0; level < levelCount; level++) {
        const faces: Uint16Array[] = [];
        const bytes = faceBytes(faceSize, level);
        for (let face = 0; face < 6; face++) {
            faces.push(new Uint16Array(payload.buffer, offset, bytes / 2));
            offset += bytes;
        }
        levels.push(faces);
    }
    return levels;
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
    const payload = await cachedBake(
        {
            kind: "hdr-prefilter",
            version: "3",
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
            cachePayload(
                faceSize,
                await runPageGlobal(
                    createSuiteSceneServer(
                        prefilterModule(faceSize, equirect),
                        { virtualAssets: { [equirectPath]: sourceBytes } },
                    ),
                    "__prefilterHdr",
                    {
                        serverName: "HDR prefilter server",
                        shared: true,
                        browserRequirement:
                            "Executing the pinned HDR GGX prefilter requires Chrome or Edge.",
                        browserArgs: webgpuComputeBrowserArgs,
                    },
                ),
            ),
    );
    return decodeCube(faceSize, payload);
}
