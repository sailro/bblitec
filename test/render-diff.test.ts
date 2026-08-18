import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    buildRenderDiff,
    correspond,
    formatRenderDiff,
    mirrorMatrixConvention,
    nativeFields,
    parseCppUniformStructs,
    pinnedBlockFields,
    readTextureUploads,
    sampleCalls,
    shaderArmReport,
    texturePaletteReport,
    type NativeCapture,
    type RenderDiffReport,
    type TextureUpload,
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

// The member grammar the generated pinned-variant headers write
// (`standard_variants.hpp` / `pbr_variants.hpp`): brace-initialized
// scalars, u32 lanes, explicit byte padding and u32 row vectors — the
// text below mirrors the generated headers' own spelling, comments
// included.
const variantHeader = `
// src/material/standard/standard-template.ts stdUniforms
struct StandardMaterialUniforms {
    // offset 0, vec4<f32>
    std::array<float, 4> dc{};
    // offset 16, vec4<f32>
    std::array<float, 4> sc{};
    // offset 32, vec3<f32>
    std::array<float, 3> ec{};
    // offset 44, f32
    float bs{};
};
static_assert(
    sizeof(StandardMaterialUniforms) == 48,
    "The pinned Standard material UBO is 48 bytes.");

// src/render/lights-ubo.ts fillLightsData
struct LightEntry {
    // offset 0, vec4<f32>
    std::array<float, 4> vLightData{};
    // offset 16, vec4<f32>
    std::array<float, 4> vLightDiffuse{};
};

// src/render/lights-ubo.ts appendMeshLightUboFields
struct MeshUniforms {
    // offset 0, mat4x4<f32>
    std::array<float, 16> world{};
    // offset 64, u32
    std::uint32_t lc{};
    // 12 bytes of WGSL alignment padding.
    std::array<std::uint8_t, 12> _padArray{};
    // offset 80, array<vec4<u32>, 4>
    std::array<std::array<std::uint32_t, 4>, 4> li{};
};

struct StandardVariantEntry {
    std::string_view key;
    std::uint32_t features;
};
`;

test("reads the pinned-variant header mirrors: brace-init scalars, u32 lanes, byte padding", () => {
    const structs = parseCppUniformStructs(variantHeader);
    assert.deepEqual(structs.get("StandardMaterialUniforms"), [
        { name: "dc", floats: 4 },
        { name: "sc", floats: 4 },
        { name: "ec", floats: 3 },
        { name: "bs", floats: 1 },
    ]);
    assert.deepEqual(structs.get("LightEntry"), [
        { name: "vLightData", floats: 4 },
        { name: "vLightDiffuse", floats: 4 },
    ]);
    // The u32 light count, the explicit 12-byte pad (three lanes) and the
    // u32 rows all read through the same flat float view the capture
    // dumps, so the 144-byte block maps to 36 named lanes.
    assert.deepEqual(structs.get("MeshUniforms"), [
        { name: "world", floats: 16 },
        { name: "lc", floats: 1 },
        { name: "_padArray", floats: 3 },
        { name: "li[0]", floats: 4 },
        { name: "li[1]", floats: 4 },
        { name: "li[2]", floats: 4 },
        { name: "li[3]", floats: 4 },
    ]);
    // Table rows carry string_views: still abandoned, not misread.
    assert.equal(structs.has("StandardVariantEntry"), false);
});

test("byte padding that is not whole lanes abandons the struct", () => {
    // Three bytes cannot be expressed in the flat float view; naming the
    // fields after them anyway would shift every one of them.
    const structs = parseCppUniformStructs(`
struct Odd {
    std::array<float, 4> first{};
    std::array<std::uint8_t, 3> _pad{};
    std::array<float, 4> second{};
};
`);
    assert.equal(structs.has("Odd"), false);
});

test("splits a pinned MeshUniforms block into named lanes, padding included", () => {
    const structs = parseCppUniformStructs(variantHeader);
    const floats = Array.from({ length: 36 }, (_, index) => index + 1);
    const fields = nativeFields(
        { stage: "vertex", slot: 0, type: "MeshUniforms", floats },
        structs,
    );
    assert.deepEqual(
        fields.map((field) => [field.name, field.values.length]),
        [
            ["MeshUniforms.world", 16],
            ["MeshUniforms.lc", 1],
            ["MeshUniforms._padArray", 3],
            ["MeshUniforms.li[0]", 4],
            ["MeshUniforms.li[1]", 4],
            ["MeshUniforms.li[2]", 4],
            ["MeshUniforms.li[3]", 4],
        ],
    );
    // The rows after the pad sit where the header's offsets put them: a
    // wrong pad width would shift all of them.
    assert.deepEqual(fields[3]!.values, [21, 22, 23, 24]);
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

test("decodes pinned blocks into vec4 rows, flagging blocks no draw carries", () => {
    const capture: NativeCapture = {
        backend: "sdl_gpu",
        buildStamp: "t",
        viewport: { width: 1, height: 1 },
        draws: [
            {
                stage: "opaque",
                pipeline: "pbr_opaque_back",
                materialKind: "pbr",
                bucket: "opaque",
                mesh: 1,
                material: 2,
                geometry: 0,
                uniforms: [],
            },
        ],
        backgroundUniforms: [],
        pinnedMaterialBlocks: [
            {
                materialIndex: 2,
                variant: 0,
                key: "ibl|linear",
                bytes: 32,
                values: [1, 2, 3, 4, 5, 6, 7, 8],
            },
            // Material 3 is drawn by no PBR draw: the gate refused its
            // variant or nothing draws it at this pose. The block is
            // still decoded — the writers built it — but flagged.
            {
                materialIndex: 3,
                variant: 1,
                key: "",
                bytes: 16,
                values: [9, 10, 11, 12],
            },
        ],
        pinnedMeshBlocks: [
            {
                meshIndex: 1,
                world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1],
                lightCount: 2,
                boneCount: 1,
                bone0: [1, 0, 0, 0, 0, 1, 0, 0],
            },
            // The capture dumps one entry per draw; a mesh drawn twice
            // repeats byte-identically and collapses to one block.
            {
                meshIndex: 1,
                world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1],
                lightCount: 2,
                boneCount: 1,
                bone0: [1, 0, 0, 0, 0, 1, 0, 0],
            },
        ],
    };
    const decoded = pinnedBlockFields(capture);
    assert.deepEqual(
        decoded.material.map((entry) => [
            entry.refused,
            entry.fields.map((field) => field.name),
        ]),
        [
            [
                false,
                [
                    "pinned material[2] variant0:ibl|linear values[0..3]",
                    "pinned material[2] variant0:ibl|linear values[4..7]",
                ],
            ],
            [true, ["pinned material[3] variant1 values[0..3] (refused)"]],
        ],
    );
    assert.equal(decoded.mesh.length, 1);
    assert.deepEqual(
        decoded.mesh[0]!.fields.map((field) => field.name),
        [
            "pinned mesh[1] world[0..3]",
            "pinned mesh[1] world[4..7]",
            "pinned mesh[1] world[8..11]",
            "pinned mesh[1] world[12..15]",
            "pinned mesh[1] lightCount",
            "pinned mesh[1] bone0[0..3]",
            "pinned mesh[1] bone0[4..7]",
        ],
    );
    assert.deepEqual(decoded.mesh[0]!.fields[3]!.values, [4, 5, 6, 1]);
});

test("applies the documented mirror map: negate column-major 1, 2, 3, 4, 8, 12", () => {
    const matrix = [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ];
    assert.deepEqual(
        mirrorMatrixConvention(matrix),
        [0, -1, -2, -3, -4, 5, 6, 7, -8, 9, 10, 11, -12, 13, 14, 15],
    );
    // The map is an involution: applying it twice is the identity, which
    // is why matching mirrored-native against browser is the same
    // correspondence the docs describe in the other direction.
    assert.deepEqual(
        mirrorMatrixConvention(mirrorMatrixConvention(matrix)),
        matrix,
    );
});

test("matches native bone palettes against rgba32float uploads, mirror map applied", () => {
    const nativeBone = [
        0.5, 0.1, -0.2, 0,
        0.3, 0.9, 0.05, 0,
        -0.4, 0.2, 0.8, 0,
        1.5, -2.5, 3.5, 1,
    ];
    // The browser's upload carries the mirrored form of ours; encode it
    // as the raw rgba32float texel bytes the capture records.
    const browserMatrix = mirrorMatrixConvention(nativeBone);
    const bytes = Buffer.alloc(64);
    browserMatrix.forEach((value, index) =>
        bytes.writeFloatLE(value, index * 4),
    );
    const uploads: TextureUpload[] = [
        {
            tex: 5,
            kind: "writeTexture",
            desc: { format: "rgba32float" },
            mipLevel: 0,
            bytes: Array.from(bytes),
            byteLength: 64,
        },
        {
            tex: 6,
            kind: "writeTexture",
            desc: { format: "rgba8unorm" },
            bytes: [255, 255, 255, 255],
            byteLength: 4,
        },
        { tex: 7, kind: "copyExternalImage", desc: { format: "rgba8unorm" } },
        // A palette above the capture's byte cap records size only.
        {
            tex: 8,
            kind: "writeTexture",
            desc: { format: "rgba32float" },
            bytes: null,
            byteLength: 1 << 20,
        },
    ];
    const capture: NativeCapture = {
        backend: "sdl_gpu",
        buildStamp: "t",
        viewport: { width: 1, height: 1 },
        draws: [],
        backgroundUniforms: [],
        pinnedMeshBlocks: [
            {
                meshIndex: 2,
                lightCount: 1,
                boneCount: 2,
                bone0: nativeBone,
                bone1: nativeBone.map((value) => value + 10),
            },
            // One entry per PBR draw in the capture; the duplicate
            // collapses like every other pairing.
            {
                meshIndex: 2,
                lightCount: 1,
                boneCount: 2,
                bone0: nativeBone,
                bone1: nativeBone.map((value) => value + 10),
            },
        ],
    };
    const report = texturePaletteReport(capture, uploads);
    assert.deepEqual(report.floatUploads, [
        {
            tex: 5,
            format: "rgba32float",
            matrices: 1,
            byteLength: 64,
            truncated: false,
        },
        {
            tex: 8,
            format: "rgba32float",
            matrices: 0,
            byteLength: 1 << 20,
            truncated: true,
        },
    ]);
    assert.equal(report.colorUploads, 1);
    assert.equal(report.externalImages, 1);
    assert.deepEqual(
        report.palettes.map((entry) => [
            entry.native,
            entry.match,
            entry.browser,
        ]),
        [
            ["pinned mesh[2] bone0", "exact", "tex#5 upload0 matrix[0]"],
            // bone1 exists nowhere in the uploads: divergent, with the
            // nearest matrix and its delta named.
            ["pinned mesh[2] bone1", "divergent", "tex#5 upload0 matrix[0]"],
        ],
    );
    assert.ok((report.palettes[1]!.maxDelta ?? 0) > 5);
});

test("readTextureUploads distinguishes a pre-palette capture from an unreadable one", () => {
    const root = mkdtempSync(join(tmpdir(), "tex-uploads-"));
    try {
        // No file: the capture predates tex-uploads.json entirely.
        assert.equal(readTextureUploads(root), undefined);
        writeFileSync(join(root, "tex-uploads.json"), "not json");
        assert.deepEqual(readTextureUploads(root), []);
        writeFileSync(
            join(root, "tex-uploads.json"),
            JSON.stringify([{ tex: 1, kind: "writeTexture" }]),
        );
        assert.deepEqual(readTextureUploads(root), [
            { tex: 1, kind: "writeTexture" },
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a capture without tex-uploads.json says to recapture when the scene has bones", () => {
    const report: RenderDiffReport = {
        scene: "t",
        backend: "sdl_gpu",
        findings: [],
        summary: {
            nativeDraws: 0,
            nativeMeshes: 0,
            nativeMaterials: 0,
            nativeLights: 0,
            nativeFields: 0,
            browserFields: 0,
            exact: 0,
            vec3: 0,
            divergent: 0,
        },
        draws: {
            shared: [],
            onlyInNative: [],
            onlyInBrowser: [],
            browserNonIndexed: [],
        },
        divergent: [],
        browserOnly: [],
        pinned: {
            materialBlocks: [],
            meshBlocks: [
                {
                    meshIndex: 0,
                    lightCount: 1,
                    boneCount: 4,
                    rows: { exact: 0, vec3: 0, divergent: 0 },
                },
            ],
        },
        shaders: {
            browserModules: [],
            nativeShaders: [],
            arms: { matched: [], browserOnly: [], nativeOnly: [] },
            browserSampleCalls: [],
            nativeSampleCalls: [],
        },
    };
    assert.match(formatRenderDiff(report), /predates tex-uploads\.json/);
});

test("matches shader arms by normalized content and opens the closest near miss", () => {
    const browser = new Map([
        ["02-match.wgsl", "// arm\n@fragment\nfn main() { }\n"],
        [
            "01-pbr.wgsl",
            "// pbr\n@fragment\nfn shade() {\n  let colorF0 = 1.0;\n  let arm = 2.0;\n}\n",
        ],
    ]);
    const native = new Map([
        // Trailing whitespace and a trailing blank line are the cosmetic
        // differences the normalization forgives — nothing else.
        ["pbr-variants/match.frag.wgsl", "// arm  \n@fragment\nfn main() { }\n\n"],
        [
            "pbr-variants/near.frag.wgsl",
            "// pbr\n@fragment\nfn shade() {\n  let colorF0 = 1.0;\n  let arm = 3.0;\n}\n",
        ],
    ]);
    const report = shaderArmReport(browser, native);
    assert.deepEqual(report.matched, [
        {
            browser: ["02-match.wgsl"],
            native: ["pbr-variants/match.frag.wgsl"],
        },
    ]);
    assert.deepEqual(report.browserOnly, ["01-pbr.wgsl"]);
    assert.deepEqual(report.nativeOnly, ["pbr-variants/near.frag.wgsl"]);
    // The near miss is compose's longest-common-prefix idiom: the first
    // divergent line names the arm.
    assert.equal(report.nearMiss?.browser, "01-pbr.wgsl");
    assert.equal(report.nearMiss?.native, "pbr-variants/near.frag.wgsl");
    assert.equal(report.nearMiss?.line, 5);
    assert.deepEqual(report.nearMiss?.browserLines, ["  let arm = 2.0;", "}"]);
    assert.deepEqual(report.nearMiss?.nativeLines, ["  let arm = 3.0;", "}"]);
});

test("two shaders sharing no line are not reported as a near miss", () => {
    const report = shaderArmReport(
        new Map([["a.wgsl", "@vertex\nfn v() { }\n"]]),
        new Map([["pbr-variants/b.frag.wgsl", "// unrelated\nfn f() { }\n"]]),
    );
    assert.equal(report.nearMiss, undefined);
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
        mkdirSync(join(generated, "upstream", "pbr-variants"), {
            recursive: true,
        });
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
                "struct M { a : f32, b : f32, c : f32, d : f32 }\n" +
                "fn main() { let c = textureSample(baseColorTexture, baseColorSampler, input.uv); }\n",
        );
        // A captured PBR fragment we never emitted, and its nearest
        // generated arm differing by one line — the compose-class defect
        // the shader-arm section exists to catch.
        const orphanFragment =
            "// pinned pbr\n@fragment\nfn shade() {\n  let colorF0 = 1.0;\n  let arm = 2.0;\n}\n";
        writeFileSync(join(capture, "shaders", "01-pbr.wgsl"), orphanFragment);
        writeFileSync(
            join(generated, "upstream", "pbr-variants", "near.frag.wgsl"),
            orphanFragment.replace("arm = 2.0", "arm = 3.0"),
        );
        // A module that matches a generated variant modulo trailing
        // whitespace, whose deployed .native.wgsl twin is byte-equal.
        const matchedArm = "// composed arm\n@fragment\nfn main2() { }\n";
        writeFileSync(join(capture, "shaders", "02-match.wgsl"), matchedArm);
        writeFileSync(
            join(generated, "upstream", "pbr-variants", "match.frag.wgsl"),
            matchedArm.replace("arm\n", "arm  \n"),
        );
        writeFileSync(
            join(generated, "upstream", "shaders", "twin.frag.native.wgsl"),
            matchedArm,
        );
        const bytes = Buffer.alloc(32);
        [0.25, 0.5, 0.75, 0, 1, 1, 1, 1].forEach((value, index) =>
            bytes.writeFloatLE(value, index * 4),
        );
        // A 16-byte buffer the shaders declare as four f32 scalars: the
        // width a pinned vec4 chunk can only meet through the raw rows.
        const scalarBytes = Buffer.alloc(16);
        [3, 5, 7, 9].forEach((value, index) =>
            scalarBytes.writeFloatLE(value, index * 4),
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
                {
                    id: 2,
                    size: 16,
                    usage: 0x40,
                    writes: [
                        { offset: 0, data: scalarBytes.toString("base64") },
                    ],
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
        // A boneless scene's upload record: census only, nothing to match.
        writeFileSync(
            join(capture, "tex-uploads.json"),
            JSON.stringify([
                {
                    tex: 1,
                    kind: "writeTexture",
                    desc: { format: "rgba8unorm" },
                    bytes: [0, 0, 0, 255],
                    byteLength: 4,
                },
                {
                    tex: 2,
                    kind: "copyExternalImage",
                    desc: { format: "rgba8unorm" },
                    sample: {},
                },
            ]),
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
                pinnedMaterialBlocks: [
                    // Material 0 is drawn; its values sit in the 16-byte
                    // browser buffer, reachable only via the raw rows.
                    {
                        materialIndex: 0,
                        variant: 0,
                        key: "ibl",
                        bytes: 16,
                        values: [3, 5, 7, 9],
                    },
                    // Material 5 is drawn by no PBR draw: flagged, and
                    // its unmatched values stay flagged in the list too.
                    {
                        materialIndex: 5,
                        variant: 1,
                        key: "ibl",
                        bytes: 16,
                        values: [11, 12, 13, 14],
                    },
                ],
                pinnedMeshBlocks: [
                    {
                        meshIndex: 0,
                        world: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                        lightCount: 1,
                        boneCount: 0,
                    },
                    {
                        meshIndex: 0,
                        world: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                        lightCount: 1,
                        boneCount: 0,
                    },
                ],
            }),
        );

        const report = buildRenderDiff("test", capture, nativeCapture, generated);
        assert.deepEqual(report.draws.shared.sort(), ["120x1", "36x1"]);
        assert.deepEqual(report.draws.onlyInNative, []);
        assert.deepEqual(report.draws.onlyInBrowser, []);
        // The vec3 slot agrees despite its packed fourth lane; the
        // invented GridUniforms payload does not.
        const names = report.divergent.map((entry) => entry.native);
        assert.ok(names.includes("GridUniforms.grid_control"));
        assert.equal(report.summary.vec3, 1);
        assert.equal(report.backend, "sdl_gpu");
        // The refused block's unmatched row is the widest divergence and
        // carries its flag in the name.
        assert.equal(
            report.divergent[0]!.native,
            "pinned material[5] variant1:ibl values[0..3] (refused)",
        );
        // The drawn block's bytes sit in the browser's 16-byte buffer,
        // reachable only through the raw vec4 rows — so it is matched,
        // not listed.
        assert.ok(
            !names.some((name) =>
                name.startsWith("pinned material[0] variant0:ibl"),
            ),
        );
        assert.deepEqual(report.pinned?.materialBlocks, [
            {
                materialIndex: 0,
                variant: 0,
                key: "ibl",
                bytes: 16,
                refused: false,
                rows: { exact: 1, vec3: 0, divergent: 0 },
            },
            {
                materialIndex: 5,
                variant: 1,
                key: "ibl",
                bytes: 16,
                refused: true,
                rows: { exact: 0, vec3: 0, divergent: 1 },
            },
        ]);
        // The duplicate mesh dump collapsed to one block; its rows (four
        // world rows and the light count) match nothing in this fixture.
        assert.deepEqual(report.pinned?.meshBlocks, [
            {
                meshIndex: 0,
                lightCount: 1,
                boneCount: 0,
                rows: { exact: 0, vec3: 0, divergent: 5 },
            },
        ]);
        // tex-uploads.json is present, so the palette section reports its
        // census even with no float uploads and no bones to match.
        assert.deepEqual(report.texturePalettes, {
            floatUploads: [],
            palettes: [],
            colorUploads: 1,
            externalImages: 1,
        });
        // Shader arms: the matched module names its variant and deployed
        // twin; the orphaned PBR fragment is one-sided with a near miss.
        const arms = report.shaders.arms;
        assert.deepEqual(arms.matched, [
            {
                browser: ["02-match.wgsl"],
                native: [
                    "pbr-variants/match.frag.wgsl",
                    "shaders/twin.frag.native.wgsl",
                ],
            },
        ]);
        assert.deepEqual(arms.browserOnly, [
            "00-fragment.wgsl",
            "01-pbr.wgsl",
        ]);
        assert.deepEqual(arms.nativeOnly, ["pbr-variants/near.frag.wgsl"]);
        assert.equal(arms.nearMiss?.browser, "01-pbr.wgsl");
        assert.equal(arms.nearMiss?.native, "pbr-variants/near.frag.wgsl");
        assert.equal(arms.nearMiss?.line, 5);
        assert.ok(
            report.findings.some((finding) =>
                finding.includes("match no generated shader arm"),
            ),
        );
        const text = formatRenderDiff(report);
        assert.match(
            text,
            /REFUSED — no PBR draw this frame carries this material/,
        );
        assert.match(
            text,
            /0 float upload\(s\), 1 color texel upload\(s\), 1 external image\(s\)/,
        );
        assert.match(text, /no bone palettes in the native capture/);
        assert.match(
            text,
            /Shader arms[^:]*: 1 matched, 2 browser-only, 1 native-only/,
        );
        assert.deepEqual(report.shaders.browserSampleCalls, [
            "textureSample(baseColorTexture,baseColorSampler,input.uv)",
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("decodes standard-family blocks through the generated variant headers", () => {
    // The scene9 hunt's gap: a StandardMaterialUniforms block whose struct
    // lives in the generated standard_variants.hpp, not renderer_plan.hpp,
    // used to decode as unnamed vec4 rows. The headers are found from the
    // capture's scene directory, and renderer_plan.hpp keeps precedence
    // over a name both declare.
    const root = mkdtempSync(join(tmpdir(), "render-diff-std-"));
    try {
        const capture = join(root, "capture");
        const generated = join(root, "generated");
        const include = join(
            generated,
            "upstream",
            "include",
            "bblite",
            "upstream",
        );
        mkdirSync(capture, { recursive: true });
        mkdirSync(include, { recursive: true });
        writeFileSync(join(include, "renderer_plan.hpp"), header);
        writeFileSync(
            join(include, "standard_variants.hpp"),
            variantHeader +
                // A conflicting redeclaration: the plan header's reading
                // must win, or a shared name would silently rename lanes.
                "\nstruct GridUniforms {\n    std::array<float, 4> impostor{};\n};\n",
        );
        const bytes = Buffer.alloc(16);
        [0.9, 0.8, 0.7, 0.6].forEach((value, index) =>
            bytes.writeFloatLE(value, index * 4),
        );
        writeFileSync(
            join(capture, "buffers.json"),
            JSON.stringify([
                {
                    id: 1,
                    size: 16,
                    usage: 0x40,
                    writes: [{ offset: 0, data: bytes.toString("base64") }],
                },
            ]),
        );
        const nativeCapture = join(capture, "native-dawn.json");
        writeFileSync(
            nativeCapture,
            JSON.stringify({
                backend: "dawn",
                buildStamp: "t",
                viewport: { width: 4, height: 4 },
                draws: [
                    {
                        stage: "opaque",
                        pipeline: "standard_opaque",
                        materialKind: "standard",
                        bucket: "opaque",
                        mesh: 0,
                        material: 0,
                        geometry: 0,
                        indexCount: 36,
                        instanceCount: 1,
                        uniforms: [
                            {
                                stage: "fragment",
                                slot: 0,
                                type: "StandardMaterialUniforms",
                                // dc, sc (trivial), ec, bs — the pinned
                                // 48-byte mirror as the capture dumps it.
                                floats: [
                                    0.5, 0.25, 0.125, 2,
                                    1, 1, 1, 1,
                                    0.75, 0.5, 0.25,
                                    24,
                                ],
                            },
                        ],
                    },
                ],
                backgroundUniforms: [
                    {
                        stage: "fragment",
                        slot: 0,
                        type: "GridUniforms",
                        floats: [9, 8, 7, 6],
                    },
                ],
            }),
        );
        const report = buildRenderDiff(
            "std",
            capture,
            nativeCapture,
            generated,
        );
        const names = report.divergent.map((entry) => entry.native);
        // Named lanes from the variant header, not the unnamed fallback.
        assert.ok(names.includes("StandardMaterialUniforms.dc"));
        assert.ok(names.includes("StandardMaterialUniforms.ec"));
        assert.ok(names.includes("StandardMaterialUniforms.bs"));
        assert.ok(
            !names.some((name) =>
                name.startsWith("StandardMaterialUniforms["),
            ),
        );
        // The name both headers declare reads through renderer_plan.hpp.
        assert.ok(names.includes("GridUniforms.grid_control"));
        assert.ok(!names.includes("GridUniforms.impostor"));
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
