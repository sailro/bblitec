/**
 * The WebGPU flag namespaces' values, as the WebGPU specification defines
 * them. Pinned modules read them from browser globals (`GPUBufferUsage`)
 * or from `engine/gpu-flags.ts`'s snapshots of those globals; generation
 * installs them for executed pinned code, and lowered code folds them.
 */
export const webgpuFlagNamespaces: Readonly<
    Record<string, Readonly<Record<string, number>>>
> = {
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
    GPUTextureUsage: {
        COPY_SRC: 1,
        COPY_DST: 2,
        TEXTURE_BINDING: 4,
        STORAGE_BINDING: 8,
        RENDER_ATTACHMENT: 16,
    },
    GPUBufferUsage: {
        MAP_READ: 1,
        MAP_WRITE: 2,
        COPY_SRC: 4,
        COPY_DST: 8,
        INDEX: 16,
        VERTEX: 32,
        UNIFORM: 64,
        STORAGE: 128,
        INDIRECT: 256,
        QUERY_RESOLVE: 512,
    },
    GPUColorWrite: { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 },
};
