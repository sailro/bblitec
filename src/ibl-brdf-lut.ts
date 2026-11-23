import { bakeReplayEnabled, cachedBake, moduleIdentity } from "./bake-cache.js";
import {
    decodePageBase64,
    pageBase64Script,
    pageTextureLevelsScript,
    runPageGlobal,
    webgpuComputeBrowserArgs,
} from "./browser-harness.js";
import {
    createSuiteSceneServer,
    pinnedBrowserModuleUrl,
} from "./capture-suite-reference.js";
import {
    readPinnedLibraryModule,
    readPinnedRawShader,
} from "./pinned-shader-composer.js";

const assembly = "loader-gltf/ibl-env-assembly.js";
// The native .rgba16f asset has no header: validate its transport shape, not the dispatch.
export const brdfLutShape = {
    width: 256,
    height: 256,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    format: "rgba16float",
} as const;
const texelBytes = 8;

export function loadPinnedBrdfLutShader(): string {
    return readPinnedRawShader(assembly, "shaders/hdr-brdf-lut.compute.wgsl");
}

export function generateIblBrdfLutRgba16f(): Promise<Uint8Array> {
    if (!bakeReplayEnabled()) return runBrdfLutInChromium();
    return cachedIblBrdfLut(
        readPinnedLibraryModule(assembly),
        loadPinnedBrdfLutShader(),
        runBrdfLutInChromium,
    );
}

export function cachedIblBrdfLut(
    producer: string,
    shader: string,
    bake: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
    return cachedBake(
        {
            kind: "ibl-brdf-lut",
            version: "2",
            module: moduleIdentity(import.meta.url),
            browser: true,
            buildConditions: true,
            parameters: brdfLutShape,
            inputs: [Buffer.from(producer), Buffer.from(shader)],
        },
        bake,
    );
}

async function runBrdfLutInChromium(): Promise<Uint8Array> {
    const source = `import { generateBrdfLut } from ${JSON.stringify(pinnedBrowserModuleUrl(assembly))};
${pageBase64Script}
${pageTextureLevelsScript}
window.__bakeBrdfLut = async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error("No WebGPU adapter is available for the BRDF LUT.");
    const device = await adapter.requestDevice();
    let texture;
    try {
        // Only add readback usage; WebGPU methods must keep the real device as receiver.
        const readable = new Proxy(device, { get(target, key) {
            if (key === "createTexture") return descriptor => target.createTexture({
                ...descriptor, usage: descriptor.usage | GPUTextureUsage.COPY_SRC,
            });
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
        }});
        device.pushErrorScope("validation");
        texture = generateBrdfLut({_device: readable});
        if (!Object.entries(${JSON.stringify(brdfLutShape)}).every(([key, value]) => texture[key] === value))
            throw new Error("Unsupported glTF IBL BRDF bake contract.");
        const { packed } = await bblReadTextureLevels(device, texture, ${texelBytes});
        const error = await device.popErrorScope();
        if (error) throw new Error(error.message);
        return bblBase64(packed);
    } finally { texture?.destroy(); device.destroy(); }
};`;
    const result = await runPageGlobal(
        createSuiteSceneServer(source),
        "__bakeBrdfLut",
        {
            serverName: "BRDF LUT server",
            shared: true,
            browserRequirement:
                "Exact IBL BRDF LUT generation requires Chrome or Edge.",
            browserArgs: webgpuComputeBrowserArgs,
        },
    );
    if (typeof result !== "string")
        throw new Error("The BRDF LUT compute returned an invalid result.");
    return decodePageBase64(
        result,
        [],
        brdfLutShape.width * brdfLutShape.height * texelBytes,
        "The BRDF LUT readback",
    );
}
