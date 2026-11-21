import {
    createEngine,
    createRenderTarget,
    createRenderTargetTexture,
    getOrCreateSampler,
    type RenderTarget,
    type RenderTargetTextureResult,
    type Texture2D,
} from "@babylonjs/lite";

const engine = await createEngine(document.createElement("canvas"));
const source = createRenderTargetTexture(engine, {
    format: "r8unorm",
    samples: 1,
    size: { width: 1, height: 1 },
});
const target = createRenderTarget({
    format: "r8unorm",
    samples: 1,
    size: { width: 1, height: 1 },
});
const sampler = getOrCreateSampler(engine, {
    minFilter: "nearest",
    magFilter: "nearest",
});
const expected: Texture2D[] = [source.texture];
let stableCalls = 0;
let wrapped = 0;
let tracked = 0;
let conditions = 0;
let last: Texture2D | null = null;
function setup() {
    return {
        stableTexture(): Texture2D {
            stableCalls++;
            return source.texture;
        },
    };
}
function wrap(rt: RenderTarget): Texture2D {
    wrapped++;
    const internals = rt as RenderTarget & {
        _colorView: GPUTextureView | null;
    };
    return {
        get view(): GPUTextureView {
            return internals._colorView!;
        },
        sampler,
    } as Texture2D;
}
function track<T extends RenderTargetTextureResult>(rt: T): T {
    tracked++;
    last = rt.texture;
    return rt;
}
function enabled(mode: number): boolean {
    conditions++;
    return mode !== 2;
}
const modes = new Float32Array([0, 1, 2, 3]);
for (const mode of modes) {
    const accumulation = mode === 0 ? setup() : null;
    const available = mode === 3 ? null : target;
    const selected: Texture2D = accumulation
        ? accumulation.stableTexture()
        : enabled(mode) && available
          ? wrap(available)
          : track(
                createRenderTargetTexture(engine, {
                    format: "r8unorm",
                    samples: 1,
                    size: { width: 1, height: 1 },
                }),
            ).texture;
    if (stableCalls !== 1 || conditions !== mode)
        throw new Error("outer arm or condition repeated");
    if (wrapped !== (mode > 0 ? 1 : 0) || tracked !== Math.max(0, mode - 1))
        throw new Error("untaken preparation ran");
    if (mode === 0 && selected !== expected[0])
        throw new Error("stable selection");
    if (mode === 1 && selected.sampler !== sampler)
        throw new Error("wrapped selection");
    if (mode > 1 && selected !== last)
        throw new Error("fallback selection");
}
