/**
 * The pin's utility passes, deployed as the pin composes them: the mip
 * generator's blit, the transmission scene-colour grab in its multisampled
 * and single-sample arms, and the trailing image processing in both arms.
 *
 * Each is one WGSL module carrying both stages, handed to WebGPU whole with
 * the pin's own groups and bindings, so it is deployed whole: nothing is
 * split, renamed or re-addressed. Module constants are read from the package;
 * composed modules are captured from the pin's own createShaderModule calls.
 */
import {
    extractPackagedTemplateLiteral,
    readPinnedLibraryModule,
} from "./pinned-shader-composer.js";
import { pinnedModuleFunction } from "./lowering/pinned-shader-builders.js";
import {
    createRecordingDevice,
    RecordedTexture,
    type DescriptorShapes,
    type RecordingContract,
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
const depthGrabModule = "src/frame-graph/transmission-depth-grab.ts";
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

interface UtilityShaderShapes extends DescriptorShapes {
    shaderModule: { code: string };
}

/** Run the pin's producer and deploy the one module it handed to the device. */
function recordedShader(
    stem: string,
    modulePath: string,
    symbolName: string,
    methods: RecordingContract["device"],
    argumentsFor: (device: object) => readonly unknown[],
): PinnedUtilityModule {
    const { device, recorder } = createRecordingDevice<UtilityShaderShapes>({
        producer: stem,
        device: methods,
    });
    pinnedModuleFunction(modulePath, symbolName)(...argumentsFor(device));
    const [module, ...rest] = recorder.shaderModules;
    if (!module || rest.length)
        throw new Error(
            `Pinned ${symbolName} must produce one shader module for ${stem}.`,
        );
    return { stem, modulePath, symbolName, wgsl: module.code };
}

function transmissionGrab(multisampled: boolean): PinnedUtilityModule {
    return recordedShader(
        multisampled ? "transmission-grab" : "transmission-grab-single",
        transmissionModule,
        "createBlitShader",
        ["createShaderModule"],
        (device) => [device, multisampled],
    );
}

/**
 * The module `createImageProcessingState` composes for a source of the given
 * sample count. The pin reads the count off the source texture and picks the
 * texture declaration and the fragment arm from it, so the texture handed
 * over is what selects the arm, exactly as a render target would.
 */
function imageProcessingModule(multisampled: boolean): PinnedUtilityModule {
    return recordedShader(
        multisampled ? "image-processing" : "image-processing-single",
        imageProcessingTask,
        "createImageProcessingState",
        [
            "createBuffer",
            "createBindGroupLayout",
            "createShaderModule",
            "createPipelineLayout",
            "createRenderPipeline",
            "createBindGroup",
        ],
        (device) => [
            { _device: device, format: "rgba8unorm" },
            {
                _colorTexture: new RecordedTexture({
                    size: [1, 1],
                    format: "rgba16float",
                    usage: 0,
                    sampleCount: multisampled ? 4 : 1,
                }),
            },
        ],
    );
}

/** The mip generator's blit, which every renderer scene deploys. */
export function pinnedMipBlitModule(): PinnedUtilityModule {
    return packagedShader("mip-blit", mipModule, "BLIT_SHADER");
}

/**
 * Scene transmission deploys the grab and image processing in both sample modes.
 */
export function pinnedTransmissionModules(): PinnedUtilityModule[] {
    return [
        transmissionGrab(true),
        transmissionGrab(false),
        imageProcessingModule(true),
        imageProcessingModule(false),
    ];
}

/**
 * What a render task's own grab adds (`enableRenderTaskTransmission`): the
 * colour grab and the `grabDepth` snapshot in the pin's single-sample arms.
 * The raw mode composes no image processing.
 */
export function pinnedTaskTransmissionModules(): PinnedUtilityModule[] {
    return [
        transmissionGrab(false),
        packagedShader(
            "transmission-depth-grab-single",
            depthGrabModule,
            "DEPTH_GRAB_SHADER",
        ),
    ];
}

/**
 * What a render task's grab of a multisampled target adds: the pin's
 * averaging colour blit and its sample-0 depth snapshot.
 */
export function pinnedMultisampledTaskTransmissionModules(): PinnedUtilityModule[] {
    return [
        transmissionGrab(true),
        packagedShader(
            "transmission-depth-grab",
            depthGrabModule,
            "DEPTH_GRAB_MSAA_SHADER",
        ),
    ];
}
