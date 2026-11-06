import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

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

/** A program that logs `calls`, with an engine and its device in scope. */
const program = (calls: readonly string[]): string => `
    import { createEngine, getOrCreateSampler } from "@babylonjs/lite";
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    const device = (engine as unknown as { _device: GPUDevice })._device;
    ${calls.map((call, index) => `const s${index} = ${call};`).join("\n")}
    console.log(${calls.map((_, index) => `s${index}`).join(", ")});
`;

/** The C++ each `s<index>` of `program` is initialized with. */
const initializers = (cpp: string, count: number): string[] =>
    Array.from({ length: count }, (_, index) => {
        const match = new RegExp(`v_s${index} = ([^;]*);`).exec(cpp);
        assert.ok(match, `s${index}`);
        return match[1]!;
    });

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
    // Each native sampler is its device and the state of its key's
    // canonical descriptor: two are one object exactly when the pin's pool
    // handed back one.
    const native = initializers(
        compileSource(
            program(
                descriptors.map(
                    (descriptor) => `getOrCreateSampler(engine, ${descriptor})`,
                ),
            ),
        ).cpp,
        descriptors.length,
    );
    for (const sampler of native)
        assert.match(
            sampler,
            /^bbl::GpuSampler\{bbl::gpu_device_identity\(v_engine\), bbl::texture_sampler_state\(bbl::GpuSamplerDescriptor\{/,
        );
    for (let a = 0; a < descriptors.length; a++)
        for (let b = 0; b < descriptors.length; b++)
            assert.equal(
                native[a] === native[b],
                pinned[a] === pinned[b],
                `${descriptors[a]} vs ${descriptors[b]}`,
            );
});

test("device.createSampler passes the members its descriptor gives", () => {
    const [plain, linear] = initializers(
        compileSource(
            program([
                "device.createSampler()",
                'device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "repeat", lodMaxClamp: 4, label: "named" })',
            ]),
        ).cpp,
        2,
    );
    assert.equal(
        plain,
        "bbl::create_device_sampler(v_device, bbl::GpuSamplerDescriptor{})",
    );
    assert.equal(
        linear,
        'bbl::create_device_sampler(v_device, bbl::GpuSamplerDescriptor{.label = std::string("named"), .address_mode_u = std::string("repeat"), .mag_filter = std::string("linear"), .min_filter = std::string("linear"), .lod_max_clamp = 4.0})',
    );
});

test("a sampler descriptor's members are GPUSamplerDescriptor's, known at generation", () => {
    for (const call of [
        'getOrCreateSampler(engine, { minFiltr: "linear" } as unknown as GPUSamplerDescriptor)',
        'device.createSampler({ minFiltr: "linear" } as unknown as GPUSamplerDescriptor)',
        "device.createSampler({ lodMaxClamp: Math.random() })",
    ])
        assert.throws(
            () => compileSource(program([call])),
            /GPUSamplerDescriptor|sampler descriptor/,
            call,
        );
});

test("a sampler's native state is its descriptor as WebGPU resolves and validates it", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    // Each descriptor, and the state (filters min/mag/mip, then address
    // U/V as enumerators; anisotropy; LOD clamp) or the refusal.
    const cases: readonly (readonly [string, string])[] = [
        ["{}", "00011 1 32"],
        ['{ label: "named", lodMinClamp: 0 }', "00011 1 32"],
        [
            '{ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "mirror-repeat", maxAnisotropy: 2.5, lodMaxClamp: 4 }',
            "11102 2 4",
        ],
        [
            '{ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 70000 }',
            "11111 65535 32",
        ],
        ["{ maxAnisotropy: 4 }", "refused"],
        ["{ maxAnisotropy: 0.4 }", "refused"],
        ['{ compare: "less" }', "refused"],
        ["{ lodMinClamp: 1 }", "refused"],
        ["{ lodMinClamp: 0, lodMaxClamp: -1 }", "refused"],
        ["{ lodMaxClamp: Infinity }", "refused"],
        ['{ addressModeW: "repeat" }', "refused"],
        ['{ minFilter: "cubic" as GPUFilterMode }', "refused"],
    ];
    const samplers = initializers(
        compileSource(
            program(
                cases.map(
                    ([descriptor]) => `device.createSampler(${descriptor})`,
                ),
            ),
        ).cpp,
        cases.length,
    ).map((sampler) => {
        const match = /^bbl::create_device_sampler\(v_device, (.*)\)$/.exec(
            sampler,
        );
        assert.ok(match, sampler);
        return match[1]!;
    });
    runGeneratedProgram(
        tools,
        "sampler-pool/states",
        `#include <bblite/runtime.hpp>
#include <iostream>
using namespace bbl;
void print(const GpuSamplerDescriptor& descriptor) {
    try {
        const TextureSamplerState state = texture_sampler_state(descriptor);
        std::cout << static_cast<int>(state.min_filter) << static_cast<int>(state.mag_filter)
                  << static_cast<int>(state.mipmap_mode) << static_cast<int>(state.address_u)
                  << static_cast<int>(state.address_v) << " " << state.max_anisotropy << " "
                  << state.max_lod << ";";
    } catch (const std::runtime_error&) {
        std::cout << "refused;";
    }
}
int main() {
${samplers.map((descriptor) => `    print(${descriptor});`).join("\n")}
}
`,
        {
            timeoutMs: 10000,
            expectedOutput: cases.map(([, state]) => `${state};`).join(""),
        },
    );
});
