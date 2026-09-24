/**
 * The pin's utility passes, deployed as the pin composes them: the mip
 * generator's blit, the transmission scene-colour grab in its multisampled
 * and single-sample arms, and the trailing image processing in both arms.
 *
 * Each is one WGSL module carrying both stages, handed to WebGPU whole with
 * the pin's own groups and bindings, so it is deployed whole: nothing is
 * split, renamed or re-addressed. The blits are module constants and are read
 * as such; the image-processing module is composed at run time
 * (`common` + the arm's texture declaration + the arm's fragment), so the
 * pin's own `createImageProcessingState` runs against the recording device
 * and its `createShaderModule` call is what is deployed.
 */
import {
    extractPackagedTemplateLiteral,
    readPinnedLibraryModule,
} from "./pinned-shader-composer.js";
import { pinnedModuleExport } from "./lowering/pinned-shader-builders.js";
import {
    createRecordingDevice,
    RecordedTexture,
    type DescriptorShapes,
} from "./recording-device.js";
import { sharedUpstreamStore } from "./upstream-source.js";

/** One pinned module and the stem pair it deploys under. */
export interface PinnedUtilityModule {
    /** `<stem>.frag` carries the module; `<stem>.vert` compiles from it. */
    stem: string;
    wgsl: string;
    /** The pinned symbol the text is, for provenance. */
    modulePath: string;
    symbolName: string;
}

const mipModule = "src/texture/generate-mipmaps.ts";
const transmissionModule = "src/frame-graph/transmission.ts";
const imageProcessingTask = "src/frame-graph/image-processing-task.ts";

/** A module-constant shader, as the packaged module ships it. */
function packagedShader(
    stem: string,
    modulePath: string,
    symbolName: string,
): PinnedUtilityModule {
    return {
        stem,
        wgsl: extractPackagedTemplateLiteral(
            readPinnedLibraryModule(
                sharedUpstreamStore().packagedModulePath(modulePath),
            ),
            symbolName,
        ),
        modulePath,
        symbolName,
    };
}

interface ImageProcessingShapes extends DescriptorShapes {
    shaderModule: { code: string };
}

/**
 * The module `createImageProcessingState` composes for a source of the given
 * sample count. The pin reads the count off the source texture and picks the
 * texture declaration and the fragment arm from it, so the texture handed
 * over is what selects the arm, exactly as a render target would.
 */
function imageProcessingModule(multisampled: boolean): PinnedUtilityModule {
    const symbolName = "createImageProcessingState";
    const create = pinnedModuleExport(imageProcessingTask, symbolName);
    const { device, recorder } = createRecordingDevice<ImageProcessingShapes>({
        producer: `image-processing-task (${multisampled ? "multisampled" : "single-sample"})`,
        device: [
            "createBuffer",
            "createBindGroupLayout",
            "createShaderModule",
            "createPipelineLayout",
            "createRenderPipeline",
            "createBindGroup",
        ],
    });
    const source = new RecordedTexture({
        size: [1, 1],
        format: "rgba16float",
        usage: 0,
        sampleCount: multisampled ? 4 : 1,
    });
    create(
        { _device: device, format: "rgba8unorm" },
        { _colorTexture: source },
    );
    const modules = recorder.shaderModules;
    if (modules.length !== 1) {
        throw new Error(
            `Pinned ${symbolName} created ${modules.length} shader modules; ` +
                "the image-processing pass deploys one.",
        );
    }
    return {
        stem: multisampled ? "image-processing" : "image-processing-single",
        wgsl: modules[0]!.code,
        modulePath: imageProcessingTask,
        symbolName,
    };
}

/** The mip generator's blit, which every renderer scene deploys. */
export function pinnedMipBlitModule(): PinnedUtilityModule {
    return packagedShader("mip-blit", mipModule, "BLIT_SHADER");
}

/**
 * What a transmission scene adds: the grab in both of the pin's arms --
 * `BLIT_MSAA_SHADER` for a multisampled source, the module's own
 * `BLIT_SHADER` otherwise -- and the image processing in both arms.
 */
export function pinnedTransmissionModules(): PinnedUtilityModule[] {
    return [
        packagedShader(
            "transmission-grab",
            transmissionModule,
            "BLIT_MSAA_SHADER",
        ),
        packagedShader(
            "transmission-grab-single",
            transmissionModule,
            "BLIT_SHADER",
        ),
        imageProcessingModule(true),
        imageProcessingModule(false),
    ];
}
