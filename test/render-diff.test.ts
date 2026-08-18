import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    buildRenderDiff,
    correspond,
    nativeFields,
    parseCppUniformStructs,
    sampleCalls,
    type UniformField,
} from "../src/render-diff.js";

const header = `
struct PbrUniforms {
    std::array<float, 4> camera_position{};
    std::array<float, 4> base_color_factor{};
    std::array<std::array<float, 4>, 2> spherical_harmonics{};
};

struct GridUniforms {
    std::array<float, 4> grid_control{};
};
`;

test("reads generated uniform struct layouts, expanding nested arrays per row", () => {
    const structs = parseCppUniformStructs(header);
    assert.deepEqual(structs.get("PbrUniforms"), [
        { name: "camera_position", floats: 4 },
        { name: "base_color_factor", floats: 4 },
        // A nested array is one field per row: nine harmonics compared as
        // one thirty-six-float tuple would never match anything.
        { name: "spherical_harmonics[0]", floats: 4 },
        { name: "spherical_harmonics[1]", floats: 4 },
    ]);
    assert.deepEqual(structs.get("GridUniforms"), [
        { name: "grid_control", floats: 4 },
    ]);
});

test("a member the layout parser does not recognize abandons the struct", () => {
    // Skipping it would shift every field after it and silently rename
    // values, which is worse than reporting no layout at all.
    const structs = parseCppUniformStructs(`
struct Mixed {
    std::array<float, 4> first{};
    std::vector<float> unsupported;
    std::array<float, 4> second{};
};
`);
    assert.equal(structs.has("Mixed"), false);
});

test("splits a captured block into named fields and reports an uncovered tail", () => {
    const structs = parseCppUniformStructs(header);
    const fields = nativeFields(
        {
            stage: "fragment",
            slot: 0,
            type: "GridUniforms",
            floats: [1, 2, 3, 4, 9, 9, 9, 9],
        },
        structs,
    );
    assert.deepEqual(fields, [
        { name: "GridUniforms.grid_control", values: [1, 2, 3, 4] },
        { name: "GridUniforms.<unmapped at 4>", values: [9, 9, 9, 9] },
    ]);
});

test("an unknown struct still yields comparable vec4 rows", () => {
    const fields = nativeFields(
        { stage: "vertex", slot: 0, type: "viewProjection", floats: [1, 2, 3, 4, 5, 6, 7, 8] },
        new Map(),
    );
    assert.deepEqual(fields.map((field) => field.name), [
        "viewProjection[0]",
        "viewProjection[4]",
    ]);
});

test("classifies correspondence by value, tolerating last-bit drift", () => {
    const browser: UniformField[] = [
        { name: "b vEyePosition", values: [0.25, 0.5, 0.75, 0] },
        { name: "b vAlbedoColor", values: [1, 0.5, 0.25, 1] },
        { name: "b viewProjection", values: [1, 0, 0, 0, 0, 1, 0, 0] },
    ];
    const results = correspond(
        [
            // Two pipelines that computed the same number in a different
            // order differ in the last bits; an exact comparison would
            // report that as a finding and the tool would stop being read.
            { name: "n base_color_factor", values: [1, 0.500000119, 0.25, 1] },
            // vec3 + a packed scalar: our camera slot carries the far
            // plane where the pin's carries zero.
            { name: "n camera_position", values: [0.25, 0.5, 0.75, 1000] },
            // A matrix the pin uploads whole and we declare per row.
            { name: "n view_projection[1]", values: [0, 1, 0, 0] },
            { name: "n metallic", values: [0.75, 0.1, 0.2, 0.3] },
        ],
        browser,
    );
    assert.deepEqual(
        results.map((entry) => [entry.native, entry.match, entry.browser]),
        [
            ["n base_color_factor", "exact", "b vAlbedoColor"],
            ["n camera_position", "vec3", "b vEyePosition"],
            ["n view_projection[1]", "exact", "b viewProjection[1]"],
            // The nearest candidate is whichever is closest by value, not
            // whichever shares a name — the two sides share no naming.
            ["n metallic", "divergent", "b viewProjection[0]"],
        ],
    );
    assert.ok((results[3]!.maxDelta ?? 0) > 0.1);
});

test("pairs a native capture against a browser capture end to end", () => {
    const root = mkdtempSync(join(tmpdir(), "render-diff-"));
    try {
        const capture = join(root, "capture");
        const generated = join(root, "generated");
        mkdirSync(join(capture, "shaders"), { recursive: true });
        mkdirSync(
            join(generated, "upstream", "include", "bblite", "upstream"),
            { recursive: true },
        );
        mkdirSync(join(generated, "upstream", "shaders"), { recursive: true });
        writeFileSync(
            join(
                generated,
                "upstream",
                "include",
                "bblite",
                "upstream",
                "renderer_plan.hpp",
            ),
            header,
        );
        writeFileSync(
            join(capture, "shaders", "00-fragment.wgsl"),
            "struct Scene { vEyePosition : vec4<f32>, vAlbedoColor : vec4<f32> }\n" +
                "fn main() { let c = textureSample(baseColorTexture, baseColorSampler, input.uv); }\n",
        );
        const bytes = Buffer.alloc(32);
        [0.25, 0.5, 0.75, 0, 1, 1, 1, 1].forEach((value, index) =>
            bytes.writeFloatLE(value, index * 4),
        );
        writeFileSync(
            join(capture, "buffers.json"),
            JSON.stringify([
                {
                    id: 1,
                    size: 32,
                    usage: 0x48,
                    writes: [{ offset: 0, data: bytes.toString("base64") }],
                },
            ]),
        );
        writeFileSync(
            join(capture, "draws.json"),
            JSON.stringify({
                // Recorded once because it is a render bundle, and 700
                // times because it is not: the counts are incomparable to
                // a one-frame native capture, the shapes are not.
                "bundle.drawIndexed(120,1,0,0)": 1,
                "pass.drawIndexed(36,1,0,0)": 700,
                "pass.draw(3,1,0)": 700,
            }),
        );
        const nativeCapture = join(capture, "native-gpu.json");
        writeFileSync(
            nativeCapture,
            JSON.stringify({
                backend: "sdl_gpu",
                buildStamp: "test",
                viewport: { width: 1280, height: 720 },
                meshes: [{}, {}],
                materials: [{}],
                lights: [],
                draws: [
                    {
                        stage: "opaque",
                        pipeline: "pbr_opaque_back",
                        materialKind: "pbr",
                        bucket: "opaque",
                        mesh: 0,
                        material: 0,
                        geometry: 0,
                        indexCount: 120,
                        instanceCount: 1,
                        uniforms: [
                            {
                                stage: "fragment",
                                slot: 0,
                                type: "GridUniforms",
                                floats: [0.25, 0.5, 0.75, 1000],
                            },
                        ],
                    },
                    {
                        stage: "transparent",
                        pipeline: "pbr_transparent_back",
                        materialKind: "pbr",
                        bucket: "alphaBlend",
                        mesh: 1,
                        material: 0,
                        geometry: 0,
                        indexCount: 36,
                        instanceCount: 1,
                        uniforms: [
                            {
                                stage: "fragment",
                                slot: 0,
                                type: "GridUniforms",
                                floats: [7, 8, 9, 10],
                            },
                        ],
                    },
                ],
                backgroundUniforms: [],
            }),
        );

        const report = buildRenderDiff("test", capture, nativeCapture, generated);
        assert.deepEqual(report.draws.shared.sort(), ["120x1", "36x1"]);
        assert.deepEqual(report.draws.onlyInNative, []);
        assert.deepEqual(report.draws.onlyInBrowser, []);
        // The vec3 slot agrees despite its packed fourth lane; the
        // invented one does not and is the only reported divergence.
        assert.deepEqual(
            report.divergent.map((entry) => entry.native),
            ["GridUniforms.grid_control"],
        );
        assert.deepEqual(report.divergent[0]!.values, [7, 8, 9, 10]);
        assert.equal(report.summary.vec3, 1);
        assert.equal(report.backend, "sdl_gpu");
        assert.deepEqual(report.shaders.browserSampleCalls, [
            "textureSample(baseColorTexture,baseColorSampler,input.uv)",
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("extracts texture sample expressions without their trailing statement", () => {
    assert.deepEqual(
        sampleCalls(
            "let a = textureSample(t, s, uv); let b = textureSampleLevel(t2, s2, uv, 0.0);",
        ),
        ["textureSample(t,s,uv)", "textureSampleLevel(t2,s2,uv,0.0)"],
    );
});

test("refuses a missing native capture with the command that writes one", () => {
    assert.throws(
        () => buildRenderDiff("test", tmpdir(), join(tmpdir(), "absent.json"), tmpdir()),
        /capture <id> --native/,
    );
});
