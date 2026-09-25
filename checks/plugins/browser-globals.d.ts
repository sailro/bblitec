// The globals the check init scripts (checks/plugins/*.init.js) install on an
// observed page, for tsconfig.browser.json.

/** A mesh as webgpu-recorder.init.js describes it, as the pin shapes it. */
interface RecorderMesh {
    name: string;
    material: object;
    worldMatrix: Float32Array;
    _gpu: {
        positionBuffer: GPUBuffer;
        normalBuffer: GPUBuffer;
        uvBuffer: GPUBuffer;
        indexBuffer: GPUBuffer;
    };
}

/** webgpu-recorder.init.js; a source hook may set `source`. */
declare var __webgpuRecorder: {
    source: unknown;
    identity(object: object): number;
    receipts(): import("./webgpu-records.js").RecordedReceipts;
    observation(): import("./webgpu-records.js").RecordedObservation;
    describeMeshes(
        meshes: readonly RecorderMesh[],
    ): import("./webgpu-records.js").RecordedMesh[];
};
/** scene180-uniform.init.js: the text layer uniform bytes, write for write. */
declare var __textUniform: Uint8Array | undefined;
/** raf-pacing.init.js: pace requestAnimationFrame at `rate` frames per second. */
declare var __bblRafPacing: (rate: number) => void;
