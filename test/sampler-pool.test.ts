import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";

const descriptors = [
    "{}",
    '{ minFilter: "nearest" }',
    '{ magFilter: "linear", minFilter: "linear" }',
    '{ minFilter: "linear", magFilter: "linear" }',
    "{ lodMaxClamp: 32 }",
    "{ lodMaxClamp: 4 }",
    '{ addressModeU: "repeat" }',
    "{ maxAnisotropy: 1 }",
    '{ label: "named" }',
    '{ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 4 }',
];

test("getOrCreateSampler keeps one sampler per pooled key, as the pin does", async () => {
    const pool = await importPinnedModule<{
        getOrCreateSampler(
            this: void,
            engine: object,
            descriptor?: object,
        ): object;
    }>("resource/sampler-pool.js");
    const engine = { _device: { createSampler: () => ({}) } };
    const pinned = descriptors.map((descriptor) =>
        pool.getOrCreateSampler(
            engine,
            runInNewContext(`(${descriptor})`) as object,
        ),
    );
    const result = compileSource(`
        import { createEngine, getOrCreateSampler } from "@babylonjs/lite";
        const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        ${descriptors.map((descriptor, index) => `const s${index} = getOrCreateSampler(engine, ${descriptor});`).join("\n")}
        console.log(${descriptors.map((_, index) => `s${index}`).join(", ")});
    `);
    // Each native sampler is its device and canonical state: two are one
    // object exactly when the pin's pool handed back one.
    const native = descriptors.map((_, index) => {
        const match = new RegExp(
            `v_s${index} = (bbl::GpuSampler\\{[^;]*\\});`,
        ).exec(result.cpp);
        assert.ok(match, `s${index}`);
        return match[1];
    });
    for (let a = 0; a < descriptors.length; a++)
        for (let b = 0; b < descriptors.length; b++)
            assert.equal(
                native[a] === native[b],
                pinned[a] === pinned[b],
                `${descriptors[a]} vs ${descriptors[b]}`,
            );
});

test("getOrCreateSampler refuses what the backends' samplers cannot hold", () => {
    for (const descriptor of [
        '{ compare: "less" }',
        "{ lodMinClamp: 1 }",
        '{ addressModeW: "repeat" }',
        "{ maxAnisotropy: 4 }",
        '{ minFilter: "cubic" }',
    ])
        assert.throws(
            () =>
                compileSource(`
                import { createEngine, getOrCreateSampler } from "@babylonjs/lite";
                const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
                console.log(getOrCreateSampler(engine, ${descriptor}));
            `),
            /sampler/i,
            descriptor,
        );
});

test("device.createSampler applies WebGPU's descriptor defaults and makes a sampler per call", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const device = (engine as unknown as { _device: GPUDevice })._device;
        const plain = device.createSampler();
        const linear = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "repeat", lodMaxClamp: 4 });
        console.log(plain, linear);
    `);
    const state = (name: string): string => {
        const match = new RegExp(
            `v_${name} = bbl::create_device_sampler\\(v_device, (bbl::TextureSamplerState\\{[^}]*\\})\\);`,
        ).exec(result.cpp);
        assert.ok(match, name);
        return match[1]!;
    };
    assert.equal(
        state("plain"),
        "bbl::TextureSamplerState{bbl::TextureFilter::nearest, bbl::TextureFilter::nearest, bbl::TextureMipmapMode::nearest, bbl::TextureAddressMode::clamp, bbl::TextureAddressMode::clamp, 1.0f, 32.0f}",
    );
    assert.equal(
        state("linear"),
        "bbl::TextureSamplerState{bbl::TextureFilter::linear, bbl::TextureFilter::linear, bbl::TextureMipmapMode::nearest, bbl::TextureAddressMode::repeat, bbl::TextureAddressMode::clamp, 1.0f, 4.0f}",
    );
    for (const descriptor of ['{ compare: "less" }', "{ lodMinClamp: 1 }"])
        assert.throws(
            () =>
                compileSource(`
                import { createEngine } from "@babylonjs/lite";
                const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
                const device = (engine as unknown as { _device: GPUDevice })._device;
                console.log(device.createSampler(${descriptor}));
            `),
            /sampler/i,
            descriptor,
        );
});
