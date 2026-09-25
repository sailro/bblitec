import assert from "node:assert/strict";
import {
    appendFileSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
    compileOfflineShaders,
    offlineShaderFormats,
} from "../src/compile-shaders.js";
import {
    assertUniformBufferCap,
    demotableUniformBlocks,
    demoteUniformBlocks,
    parseStageLayoutRecord,
    prepareSdlUniformAdaptation,
    sdlUniformSource,
} from "../src/shader-bindings.js";
import {
    readShaderComposition,
    shaderStageConstants,
} from "../src/shader-composition.js";
import { discoverDevelopmentTools } from "../src/development-tools.js";

const tools = discoverDevelopmentTools();

function fixtureRoot(t: { after: (cleanup: () => void) => void }): string {
    const root = mkdtempSync(join(tmpdir(), "bblite-offline-shaders-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "upstream"));
    copyFileSync("upstream/tint.json", join(root, "upstream/tint.json"));
    return root;
}

/** Compiles `shader`'s stages for `target` and returns the directory. */
async function compileStages(
    root: string,
    name: string,
    shader: string,
    stages: readonly { stem: string; entryPoint: string }[],
    pinnedBindings: boolean,
    target: "d3d12" | "vulkan" | "metal" | "all" = "d3d12",
): Promise<string> {
    const directory = join(root, "generated", name, "upstream/shaders");
    mkdirSync(directory, { recursive: true });
    const [first, ...rest] = stages;
    assert.ok(first);
    writeFileSync(join(directory, `${first.stem}.native.wgsl`), shader);
    writeFileSync(
        join(directory, "composition.json"),
        JSON.stringify({
            modules: [
                {
                    output: `upstream/shaders/${first.stem}.native.wgsl`,
                    entryPoint: first.entryPoint,
                    pinnedBindings,
                    alsoStages: rest,
                },
            ],
        }),
    );
    await compileOfflineShaders({
        directories: [directory],
        repositoryRoot: root,
        target,
        tools,
    });
    return directory;
}

function sidecarLines(directory: string, stem: string): string[] {
    return readFileSync(join(directory, `${stem}.slots`), "utf8")
        .split(/\r?\n/)
        .filter((line) => line.length > 0);
}

/** A sidecar's slot lines, without its `@entry` and `@binding` lines. */
function slotLines(directory: string, stem: string): string[] {
    return sidecarLines(directory, stem).filter(
        (line) => !line.startsWith("@"),
    );
}

const pinnedResources = `
struct Mesh { world: mat4x4f };
@group(1) @binding(4) var<uniform> mesh: Mesh;
@group(0) @binding(8) var<uniform> scene: vec4f;
@group(0) @binding(1) var<storage, read> morph: array<vec4f>;
@group(1) @binding(9) var palette: texture_2d<f32>;
@group(1) @binding(12) var paletteSampler: sampler;
@group(0) @binding(5) var depth: texture_depth_2d;
@group(0) @binding(6) var depthSampler: sampler_comparison;
fn resources(i: u32) -> vec4f {
    return scene + mesh.world[0] + morph[i] +
        textureSampleLevel(palette, paletteSampler, vec2f(0.5), 0.0) +
        vec4f(textureSampleCompareLevel(depth, depthSampler, vec2f(0.5), 0.5));
}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    return resources(i);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
    return resources(u32(p.x));
}`;

test(
    "pinned registers order textures before storage and preserve uniform order across groups",
    { skip: !tools.bbliteTint || !tools.dxc },
    async (t) => {
        const directory = await compileStages(
            fixtureRoot(t),
            "pinned",
            pinnedResources,
            [
                { stem: "pinned.vert", entryPoint: "vs" },
                { stem: "pinned.frag", entryPoint: "fs" },
            ],
            true,
        );
        for (const [stem, resources, uniforms] of [
            ["pinned.vert", 0, 1],
            ["pinned.frag", 2, 3],
        ] as const) {
            const hlsl = readFileSync(join(directory, `${stem}.hlsl`), "utf8");
            assert.match(
                hlsl,
                new RegExp(
                    `cbuffer_scene : register\\(b0, space${uniforms}\\)`,
                ),
            );
            assert.match(
                hlsl,
                // Tint leaves space 0 implicit.
                new RegExp(
                    `morph : register\\(t2${resources ? `, space${resources}` : ""}\\)`,
                ),
            );
            assert.deepEqual(slotLines(directory, stem), [
                "b0 scene",
                "b1 mesh",
                "r0 morph",
                "s0 depthSampler",
                "s1 paletteSampler",
                "t0 depth",
                "t1 palette",
            ]);
        }
    },
);

/** The members of an HLSL entry point structure, in declaration order. */
function structureMembers(hlsl: string, structure: string): string[] {
    const body = hlsl.slice(hlsl.indexOf(`struct ${structure} {`));
    return body
        .slice(body.indexOf("{") + 1, body.indexOf("};"))
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);
}

const nativeVaryings = `
@group(2) @binding(9) var color: texture_2d<f32>;
@group(2) @binding(10) var colorSampler: sampler;
@group(2) @binding(7) var<storage, read> data: array<vec4f>;
struct Varyings {
    @location(0) uv: vec2f,
    @builtin(position) position: vec4f,
    @location(1) layer: f32,
};
@vertex fn vs(@builtin(vertex_index) i: u32) -> Varyings {
    return Varyings(vec2f(f32(i)), vec4f(1.0), 2.0);
}
@fragment fn fs(input: Varyings) -> @location(0) vec4f {
    if (input.layer < 0.0) { discard; }
    return textureSample(color, colorSampler, input.uv) + data[0];
}`;
const varyingStages = [
    { stem: "varyings.vert", entryPoint: "vs" },
    { stem: "varyings.frag", entryPoint: "fs" },
];

test(
    "native bindings compact within their SDL space and the position leads every interstage structure",
    { skip: !tools.bbliteTint || !tools.dxc },
    async (t) => {
        const directory = await compileStages(
            fixtureRoot(t),
            "native",
            nativeVaryings,
            varyingStages,
            false,
        );
        for (const [stem, structure] of [
            ["varyings.vert", "vs_outputs"],
            ["varyings.frag", "fs_inputs"],
        ] as const) {
            const members = structureMembers(
                readFileSync(join(directory, `${stem}.hlsl`), "utf8"),
                structure,
            );
            assert.match(members[0] ?? "", /: SV_Position;$/, stem);
            assert.equal(members.length, 3, stem);
        }
        const fragment = readFileSync(
            join(directory, "varyings.frag.hlsl"),
            "utf8",
        );
        assert.match(fragment, /color : register\(t0, space2\)/);
        assert.match(fragment, /data : register\(t1, space2\)/);
        assert.deepEqual(slotLines(directory, "varyings.frag"), [
            "r0 data",
            "s0 colorSampler",
            "t0 color",
        ]);
    },
);

test(
    "pinned interstage structures keep Tint's order, the position after the locations",
    { skip: !tools.bbliteTint || !tools.dxc },
    async (t) => {
        // A pinned fragment that omits the position reads a prefix of these.
        const directory = await compileStages(
            fixtureRoot(t),
            "pinned-varyings",
            nativeVaryings,
            varyingStages,
            true,
        );
        for (const [stem, structure] of [
            ["varyings.vert", "vs_outputs"],
            ["varyings.frag", "fs_inputs"],
        ] as const) {
            const members = structureMembers(
                readFileSync(join(directory, `${stem}.hlsl`), "utf8"),
                structure,
            );
            assert.match(members.at(-1) ?? "", /: SV_Position;$/, stem);
            assert.equal(members.length, 3, stem);
        }
    },
);

test(
    "integer and multisampled loads occupy SDL storage texture slots between sampled textures and buffers",
    { skip: !tools.bbliteTint || !tools.dxc },
    async (t) => {
        const root = fixtureRoot(t);
        const shader = `
@group(2) @binding(0) var<storage, read> morph: array<vec4f>;
@group(2) @binding(1) var cells: texture_2d<u32>;
@group(2) @binding(8) var color: texture_2d<f32>;
@group(2) @binding(9) var colorSampler: sampler;
@group(2) @binding(5) var signs: texture_2d<i32>;
@group(2) @binding(6) var samples: texture_multisampled_2d<f32>;
@fragment fn main() -> @location(0) vec4f {
    return textureSample(color, colorSampler, vec2f(0.5)) + morph[0] +
        vec4f(textureLoad(cells, vec2i(0), 0)) + vec4f(textureLoad(signs, vec2i(0), 0)) +
        textureLoad(samples, vec2i(0), 0);
}`;
        for (const pinned of [false, true]) {
            const directory = await compileStages(
                root,
                `loads-${pinned}`,
                shader,
                [{ stem: "loads.frag", entryPoint: "main" }],
                pinned,
            );
            assert.deepEqual(slotLines(directory, "loads.frag"), [
                "i0 cells",
                "i1 signs",
                "i2 samples",
                "r0 morph",
                "s0 colorSampler",
                "t0 color",
            ]);
            const hlsl = readFileSync(
                join(directory, "loads.frag.hlsl"),
                "utf8",
            );
            for (const [name, register] of [
                ["color", 0],
                ["cells", 1],
                ["signs", 2],
                ["samples", 3],
                ["morph", 4],
            ] as const)
                assert.match(
                    hlsl,
                    new RegExp(`${name} : register\\(t${register}, space2\\)`),
                );
        }
    },
);

test("uniform adaptation admits only layout-compatible blocks and caps every stage", () => {
    const wgsl = `var<uniform> scene: Scene;
var<uniform> localProbeData: Probe;
var<uniform> gp: Params;
var<uniform> shadowInfo_0: Shadow;
var<uniform> csmInfo_1: Cascade;
var<uniform> nmeShadowParams: Node;`;
    const blocks = demotableUniformBlocks(wgsl);
    assert.deepEqual(blocks, [
        "localProbeData",
        "gp",
        "nmeShadowParams",
        "shadowInfo_0",
        "csmInfo_1",
    ]);
    assert.equal(
        demoteUniformBlocks(wgsl, blocks),
        wgsl
            .replaceAll("var<uniform>", "var<storage, read>")
            .replace("var<storage, read> scene", "var<uniform> scene"),
    );
    const uniforms = ["scene", "lights", "mesh", "mat", "other"];
    assert.throws(
        () => assertUniformBufferCap(uniforms, "custom.frag"),
        /custom.frag binds 5.*scene, lights, mesh, mat, other/,
    );
    assert.doesNotThrow(() =>
        assertUniformBufferCap(uniforms.slice(0, 4), "custom.frag"),
    );
    assert.equal(
        sdlUniformSource(
            prepareSdlUniformAdaptation(wgsl),
            [],
            "local-probe.frag",
        ),
        demoteUniformBlocks(wgsl, blocks),
    );
    const params = "var<uniform> gp: Params;";
    assert.equal(
        sdlUniformSource(
            prepareSdlUniformAdaptation(params),
            [],
            "params.frag",
        ),
        undefined,
    );
    assert.equal(
        sdlUniformSource(
            prepareSdlUniformAdaptation(params),
            uniforms,
            "params.frag",
        ),
        "var<storage, read> gp: Params;",
    );
    assert.deepEqual(
        parseStageLayoutRecord(
            '{"uniformBuffers":["scene"],"bindings":[{"group":0,"binding":2,"name":"scene"}]}',
            "fixture.frag",
        ),
        {
            uniformBuffers: ["scene"],
            bindings: [{ group: 0, binding: 2, name: "scene" }],
        },
    );
    assert.throws(
        () => parseStageLayoutRecord('{"uniformBuffers":[]}', "fixture.frag"),
        /fixture.frag lacks uniformBuffers or bindings/,
    );
});

test(
    "stage layout lines reflect every declared binding's bind-group layout shape",
    { skip: !tools.bbliteTint || !tools.dxc },
    async (t) => {
        const root = fixtureRoot(t);
        const directory = await compileStages(
            root,
            "layout",
            `struct U { v: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> values: array<f32>;
@group(0) @binding(2) var<storage, read_write> results: array<f32>;
@group(1) @binding(0) var color: texture_2d<f32>;
@group(1) @binding(1) var colorSampler: sampler;
@group(1) @binding(2) var data: texture_2d<f32>;
@group(1) @binding(3) var cells: texture_2d<u32>;
@group(1) @binding(4) var shadow: texture_depth_2d_array;
@group(1) @binding(5) var shadowSampler: sampler_comparison;
@group(1) @binding(6) var sky: texture_cube<f32>;
@group(1) @binding(7) var samples: texture_multisampled_2d<f32>;
@group(1) @binding(8) var unused: texture_2d<f32>;
@group(2) @binding(0) var written: texture_storage_2d<rgba8unorm, write>;
fn tint(t: texture_2d<f32>, s: sampler, uv: vec2f) -> vec4f { return textureSample(t, s, uv); }
@fragment fn main(@builtin(position) p: vec4f) -> @location(0) vec4f {
    let a = tint(color, colorSampler, p.xy);
    let b = textureLoad(data, vec2i(0), 0);
    let c = vec4f(textureLoad(cells, vec2i(0), 0));
    let d = textureSampleCompare(shadow, shadowSampler, p.xy, 0, 0.5);
    let e = textureGather(0, sky, colorSampler, vec3f(1.0));
    let f = textureLoad(samples, vec2i(0), 0);
    return a + b + c + vec4f(d) + e + f + u.v;
}`,
            [{ stem: "layout.frag", entryPoint: "main" }],
            true,
        );
        // A texture reaching a sampling builtin through a helper's parameter
        // is filterable; one only loaded is not; a declared binding nothing
        // reads is still listed, as its bind group carries it (the writable
        // ones too, which SDL_GPU binds in compute stages only), each under
        // the name the module declares it with. The sidecar opens with the
        // entry point.
        const sidecar = sidecarLines(directory, "layout.frag");
        assert.equal(sidecar[0], "@entry main");
        assert.deepEqual(
            sidecar.filter((line) => line.startsWith("@binding ")),
            [
                "@binding 0 0 u uniform",
                "@binding 0 1 values storage read",
                "@binding 0 2 results storage read_write",
                "@binding 1 0 color texture float 2d single",
                "@binding 1 1 colorSampler sampler filtering",
                "@binding 1 2 data texture unfilterable-float 2d single",
                "@binding 1 3 cells texture uint 2d single",
                "@binding 1 4 shadow texture depth 2d-array single",
                "@binding 1 5 shadowSampler sampler comparison",
                "@binding 1 6 sky texture float cube single",
                "@binding 1 7 samples texture unfilterable-float 2d multisampled",
                "@binding 1 8 unused texture unfilterable-float 2d single",
                "@binding 2 0 written storage-texture write-only rgba8unorm 2d",
            ],
        );
        await assert.rejects(
            async () =>
                await compileStages(
                    root,
                    "external",
                    `@group(2) @binding(0) var video: texture_external;
@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }`,
                    [{ stem: "external.frag", entryPoint: "main" }],
                    true,
                ),
            /declares texture_external, which no bind-group layout represents/,
        );
    },
);

test("offline targets select only their executable format", () => {
    for (const [target, products, dxil] of [
        ["d3d12", [".hlsl", ".slots", ".tint-reflection.txt"], true],
        [
            "vulkan",
            [".hlsl", ".demote.spv", ".spv", ".slots", ".tint-reflection.txt"],
            false,
        ],
        ["metal", [".hlsl", ".msl", ".slots", ".tint-reflection.txt"], false],
        [
            "all",
            [
                ".hlsl",
                ".msl",
                ".demote.spv",
                ".spv",
                ".slots",
                ".tint-reflection.txt",
            ],
            true,
        ],
    ] as const) {
        const formats = offlineShaderFormats(target);
        assert.deepEqual(formats.tint, products, target);
        assert.equal(formats.dxil, dxil, target);
    }
});

const fragment = `@fragment fn main() -> @location(0) vec4f { return vec4f(0.25, 0.5, 0.75, 1.0); }\n`;
function shaderDirectory(
    root: string,
    scene: string,
    shader = fragment,
): string {
    const directory = join(root, "generated", scene, "upstream/shaders");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "simple.frag.native.wgsl"), shader);
    writeFileSync(
        join(directory, "composition.json"),
        JSON.stringify({
            modules: [
                {
                    output: "upstream/shaders/simple.frag.native.wgsl",
                    entryPoint: "main",
                    pinnedBindings: false,
                },
            ],
        }),
    );
    return directory;
}

function* spirvInstructions(
    bytes: Buffer,
): Generator<{ opcode: number; offset: number; words: number }> {
    for (let offset = 20; offset < bytes.length;) {
        const instruction = bytes.readUInt32LE(offset);
        const words = instruction >>> 16;
        assert.ok(words > 0 && offset + words * 4 <= bytes.length);
        yield { opcode: instruction & 0xffff, offset, words };
        offset += words * 4;
    }
}

/** A SPIR-V module's named resource and interface variables. */
function spirvVariables(bytes: Buffer): {
    resources: Map<
        string,
        { set: number; binding: number; type: number; image?: Buffer }
    >;
    locations: (storageClass: number) => number[];
} {
    const names = new Map<number, string>();
    const decorations = new Map<number, Map<number, number>>();
    const variables = new Map<number, { pointer: number; storage: number }>();
    const pointees = new Map<number, number>();
    const types = new Map<number, { opcode: number; words: Buffer }>();
    for (const { opcode, offset, words } of spirvInstructions(bytes)) {
        const word = (index: number): number =>
            bytes.readUInt32LE(offset + index * 4);
        if (opcode === 5) {
            // OpName
            names.set(
                word(1),
                bytes
                    .subarray(offset + 8, offset + words * 4)
                    .toString("utf8")
                    .split("\0")[0]!,
            );
        } else if (opcode === 71 && words >= 4) {
            // OpDecorate with one literal
            const decorated =
                decorations.get(word(1)) ?? new Map<number, number>();
            decorated.set(word(2), word(3));
            decorations.set(word(1), decorated);
        } else if (opcode === 59) {
            // OpVariable
            variables.set(word(2), { pointer: word(1), storage: word(3) });
        } else if (opcode === 32) {
            // OpTypePointer
            pointees.set(word(1), word(3));
        } else if (opcode >= 19 && opcode <= 31) {
            types.set(word(1), {
                opcode,
                words: bytes.subarray(offset, offset + words * 4),
            });
        }
    }
    const resources = new Map<
        string,
        { set: number; binding: number; type: number; image?: Buffer }
    >();
    for (const [id, { pointer, storage }] of variables) {
        const set = decorations.get(id)?.get(34);
        const binding = decorations.get(id)?.get(33);
        const type = types.get(pointees.get(pointer) ?? -1);
        if (storage !== 0 || set === undefined || binding === undefined)
            continue;
        assert.ok(type, `resource ${names.get(id)} has a type`);
        resources.set(names.get(id) ?? `%${id}`, {
            set,
            binding,
            type: type.opcode,
            ...(type.opcode === 25 ? { image: type.words } : {}),
        });
    }
    return {
        resources,
        locations: (storageClass) =>
            [...variables]
                .filter(([, { storage }]) => storage === storageClass)
                .flatMap(([id]) => {
                    const location = decorations.get(id)?.get(30);
                    return location === undefined ? [] : [location];
                })
                .sort((left, right) => left - right),
    };
}

/** OpTypeImage's Sampled operand: 1 is a sampled image, 2 a storage image. */
function imageSampled(image: Buffer | undefined): number | undefined {
    return image?.readUInt32LE(7 * 4);
}

test(
    "compute stages compile writable resources into SDL compute binding spaces",
    { skip: !tools.bbliteTint || !tools.dxc },
    async (t) => {
        const root = fixtureRoot(t);
        const directory = join(root, "generated/compute/upstream/shaders");
        mkdirSync(directory, { recursive: true });
        writeFileSync(
            join(directory, "kernel.comp.native.wgsl"),
            `
struct Params { offset: u32, scale: f32, padding: vec2f };
@group(2) @binding(9) var<storage, read_write> outputData: array<f32>;
@group(1) @binding(5) var outputTex: texture_storage_2d<rg32float, write>;
@group(3) @binding(7) var<uniform> params: Params;
@group(0) @binding(8) var<storage, read> inputData: array<f32>;
@group(1) @binding(0) var inputTex: texture_2d<f32>;
@group(1) @binding(1) var inputSampler: sampler;
@compute @workgroup_size(4, 2, 1)
fn run(@builtin(global_invocation_id) id: vec3u) {
    let value = inputData[min(params.offset + id.x, arrayLength(&inputData) - 1u)] * params.scale + textureSampleLevel(inputTex, inputSampler, vec2f(0.5), 0.0).x;
    outputData[min(id.x, arrayLength(&outputData) - 1u)] = value;
    textureStore(outputTex, vec2i(id.xy), vec4f(value, value + 1.0, 0.0, 0.0));
}`,
        );
        writeFileSync(
            join(directory, "composition.json"),
            JSON.stringify({
                modules: [
                    {
                        output: "upstream/shaders/kernel.comp.native.wgsl",
                        entryPoint: "run",
                        pinnedBindings: true,
                    },
                ],
            }),
        );
        const result = await compileOfflineShaders({
            directories: [directory],
            repositoryRoot: root,
            target: "all",
            tools,
        });
        assert.equal(result.compiled, 1);
        const hlsl = readFileSync(join(directory, "kernel.comp.hlsl"), "utf8");
        assert.match(hlsl, /outputTex\s*:\s*register\(u0, space1\)/);
        assert.match(hlsl, /outputData\s*:\s*register\(u1, space1\)/);
        assert.match(hlsl, /cbuffer_params\s*:\s*register\(b0, space2\)/);
        // Tint leaves space 0 implicit.
        assert.match(hlsl, /inputTex\s*:\s*register\(t0\)/);
        assert.match(hlsl, /inputData\s*:\s*register\(t1\)/);
        assert.match(hlsl, /numthreads\(4, 2, 1\)/);
        const slots = readFileSync(
            join(directory, "kernel.comp.slots"),
            "utf8",
        );
        for (const slot of [
            "@workgroup 4 2 1",
            "b0 params 3 7 -1 -1",
            "t0 inputTex 1 0 1 1",
            "s0 inputSampler 1 1 -1 -1",
            "r0 inputData 0 8 -1 -1",
            "j0 outputTex 1 5 -1 -1",
            "w0 outputData 2 9 -1 -1",
        ])
            assert.ok(slots.includes(slot), slot);
        assert.ok(!existsSync(join(directory, "kernel.comp.demote.spv")));
        const msl = readFileSync(join(directory, "kernel.comp.msl"), "utf8");
        assert.match(msl, /kernel void main0\(/);
        assert.match(msl, /inputTex\s*\[\[texture\(0\)\]\]/);
        assert.match(msl, /outputTex\s*\[\[texture\(1\)\]\]/);
        assert.match(msl, /params\s*\[\[buffer\(0\)\]\]/);
        assert.match(msl, /inputData\s*\[\[buffer\(1\)\]\]/);
        assert.match(msl, /outputData\s*\[\[buffer\(2\)\]\]/);
        const binary = readFileSync(join(directory, "kernel.comp.spv"));
        const executionMode = [...spirvInstructions(binary)].find(
            (instruction) =>
                instruction.opcode === 16 &&
                binary.readUInt32LE(instruction.offset + 8) === 17,
        );
        assert.ok(executionMode, "LocalSize execution mode");
        assert.deepEqual(
            [12, 16, 20].map((offset) =>
                binary.readUInt32LE(executionMode.offset + offset),
            ),
            [4, 2, 1],
        );
    },
);

test(
    "Vulkan discard has a helper-invocation variant and a baseline device fallback",
    { skip: !tools.bbliteTint },
    async (t) => {
        const root = fixtureRoot(t);
        const directory = shaderDirectory(
            root,
            "discard",
            `
@fragment fn main(@builtin(position) p: vec4f) -> @location(0) vec4f {
    if (p.x < 20.0) { discard; }
    return vec4f(dpdx(p.x), 0.0, 0.0, 1.0);
}`,
        );
        await compileOfflineShaders({
            directories: [directory],
            repositoryRoot: root,
            target: "vulkan",
            tools,
        });
        for (const [extension, discard, absent] of [
            [".spv", 252, 5380],
            [".demote.spv", 5380, 252],
        ] as const) {
            const opcodes = new Set(
                [
                    ...spirvInstructions(
                        readFileSync(
                            join(directory, `simple.frag${extension}`),
                        ),
                    ),
                ].map((i) => i.opcode),
            );
            assert.ok(opcodes.has(discard), extension);
            assert.ok(!opcodes.has(absent), extension);
        }
    },
);

test(
    "Vulkan preserves floating-point division and its dependent sampled branch",
    { skip: !tools.bbliteTint },
    async (t) => {
        const root = fixtureRoot(t);
        const directory = shaderDirectory(
            root,
            "division-branch",
            `
@group(3) @binding(0) var<uniform> params: vec4f;
@group(2) @binding(0) var color: texture_2d<f32>;
@group(2) @binding(1) var colorSampler: sampler;
@fragment fn main(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let ratio = params.x / params.x;
    if (ratio == 1.0) { return vec4f(0.0, 1.0, 0.0, 1.0); }
    return textureSample(color, colorSampler, position.xy / params.yz);
}`,
        );
        await compileOfflineShaders({
            directories: [directory],
            repositoryRoot: root,
            target: "vulkan",
            tools,
        });
        for (const extension of [".spv", ".demote.spv"]) {
            const bytes = readFileSync(
                join(directory, `simple.frag${extension}`),
            );
            const opcodes = new Set(
                [...spirvInstructions(bytes)].map(
                    (instruction) => instruction.opcode,
                ),
            );
            assert.ok(
                opcodes.has(136),
                `${extension} retains OpFDiv instead of folding x/x to one`,
            );
            assert.ok(
                opcodes.has(180),
                `${extension} retains the source floating-point comparison`,
            );
            const { resources } = spirvVariables(bytes);
            assert.deepEqual(
                [resources.get("color"), resources.get("colorSampler")].map(
                    (resource) => [resource?.set, resource?.binding],
                ),
                [
                    [2, 0],
                    [2, 0],
                ],
                `${extension} samples through SDL's combined descriptor`,
            );
        }
    },
);

test(
    "Metal uses SDL buffer slots and preserves bounds checks across reordered runtime arrays",
    { skip: !tools.bbliteTint },
    async (t) => {
        const root = fixtureRoot(t);
        const directory = shaderDirectory(
            root,
            "metal-bindings",
            `
@group(2) @binding(7) var<storage, read> later: array<vec4f>;
@group(3) @binding(2) var<uniform> second: vec4f;
@group(2) @binding(0) var<storage, read> fixed: array<vec4f, 4>;
@group(2) @binding(3) var<storage, read> earlier: array<vec4f>;
@group(3) @binding(0) var<uniform> first: vec4f;
@fragment fn main(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let index = u32(position.x);
    return later[index] + second + fixed[index] + earlier[index] + first;
}`,
        );
        await compileOfflineShaders({
            repositoryRoot: root,
            directories: [directory],
            tools,
            target: "metal",
        });
        const msl = readFileSync(join(directory, "simple.frag.msl"), "utf8");
        for (const [name, index] of [
            ["first", 0],
            ["second", 1],
            ["fixed", 2],
            ["earlier", 3],
            ["later", 4],
        ] as const) {
            assert.ok(
                msl.includes(`${name} [[buffer(${index})]]`),
                `${name} must occupy SDL buffer ${index}`,
            );
        }
        assert.match(msl, /tint_storage_buffer_sizes \[\[buffer\(30\)\]\]/);
        assert.match(msl, /tint_storage_buffer_sizes\)\[0u\]\.z/);
        assert.match(msl, /tint_storage_buffer_sizes\)\[0u\]\.y/);
        assert.doesNotMatch(msl, /tint_storage_buffer_sizes\)\[0u\]\.x/);
        assert.match(
            msl,
            /min\(/,
            "runtime and fixed-array access retain Tint bounds checks",
        );
        assert.match(
            msl,
            /^fragment\s+\w+\s+main0\(/m,
            "Tint's renamed WGSL main uses the SDL entry point",
        );
    },
);

test(
    "Metal sampler slots follow sampled textures after textureLoad removes an earlier sampler",
    { skip: !tools.bbliteTint },
    async (t) => {
        const root = fixtureRoot(t);
        const directory = shaderDirectory(
            root,
            "metal-samplers",
            `
@group(2) @binding(0) var depth: texture_depth_2d;
@group(2) @binding(1) var color: texture_2d<f32>;
@group(2) @binding(2) var colorSampler: sampler;
@fragment fn main() -> @location(0) vec4f {
    return textureSample(color, colorSampler, vec2f(0.5)) * textureLoad(depth, vec2i(0), 0);
}`,
        );
        await compileOfflineShaders({
            repositoryRoot: root,
            directories: [directory],
            tools,
            target: "metal",
        });
        const msl = readFileSync(join(directory, "simple.frag.msl"), "utf8");
        assert.match(msl, /depth \[\[texture\(0\)\]\]/);
        assert.match(msl, /color \[\[texture\(1\)\]\]/);
        assert.match(msl, /colorSampler \[\[sampler\(1\)\]\]/);
    },
);

test(
    "directory checkpoints isolate edits, ignore unchanged writes, and repair missing or changed products",
    { skip: !tools.bbliteTint },
    async (t) => {
        const root = fixtureRoot(t);
        const directories = [
            shaderDirectory(root, "first"),
            shaderDirectory(root, "second"),
        ];
        const compile = async () =>
            await compileOfflineShaders({
                repositoryRoot: root,
                directories,
                tools,
                target: "metal",
            });
        assert.equal((await compile()).directoriesCompiled, 2);
        assert.equal((await compile()).directoriesReused, 2);
        const first = directories[0]!;
        const second = directories[1]!;
        const firstSource = join(first, "simple.frag.native.wgsl");
        utimesSync(firstSource, new Date(2000, 0), new Date(2000, 0));
        assert.equal(
            (await compile()).directoriesReused,
            2,
            "a checkout of identical bytes keeps the checkpoint",
        );
        writeFileSync(firstSource, fragment.replace("0.25", "0.75"));
        const changed = await compile();
        assert.equal(changed.directoriesCompiled, 1);
        assert.equal(changed.directoriesReused, 1);
        assert.equal(changed.tintCompiled, 1);
        const artifact = join(first, "simple.frag.hlsl");
        const expected = readFileSync(artifact);
        writeFileSync(artifact, "corrupt");
        const snapshotTime = new Date(2001, 0);
        utimesSync(artifact, snapshotTime, snapshotTime);
        const repaired = await compile();
        assert.equal(repaired.directoriesReused, 1);
        assert.equal(repaired.tintCompiled, 0);
        assert.equal(repaired.tintReused, 1);
        assert.deepEqual(readFileSync(artifact), expected);
        assert.ok(statSync(artifact).mtimeMs > snapshotTime.getTime());
        rmSync(join(second, "simple.frag.slots"));
        const restored = await compile();
        assert.equal(restored.directoriesReused, 1);
        assert.equal(restored.tintReused, 1);
        assert.ok(existsSync(join(second, "simple.frag.slots")));
        const checkpoints = join(root, "artifacts/shader-cache/directories");
        for (const name of readdirSync(checkpoints))
            writeFileSync(join(checkpoints, name), "invalid JSON");
        assert.equal((await compile()).directoriesCompiled, 2);
    },
);

test("shader checkpoints include DXC codegen DLL contents only for DXC targets", async (t) => {
    const root = fixtureRoot(t);
    const directory = join(root, "shaders");
    mkdirSync(directory);
    const dxc = join(root, "dxc.exe");
    writeFileSync(dxc, "compiler identity");
    const localTools = { dxc, bbliteTint: undefined, cmake: tools.cmake };
    const compile = async (target: "metal" | "d3d12") =>
        await compileOfflineShaders({
            repositoryRoot: root,
            directories: [directory],
            tools: localTools,
            target,
        });
    // An empty shader directory records tools without executing these identity fixtures.
    assert.equal((await compile("d3d12")).directoriesCompiled, 1);
    assert.equal((await compile("d3d12")).directoriesReused, 1);
    for (const name of [
        "dxcompiler.dll",
        "dxil.dll",
        "libdxcompiler.so",
        "libdxil.so",
    ]) {
        const path = join(root, name);
        writeFileSync(path, "installed");
        assert.equal((await compile("d3d12")).directoriesCompiled, 1);
        assert.equal((await compile("d3d12")).directoriesReused, 1);
        writeFileSync(path, "replaced compiler");
        assert.equal((await compile("d3d12")).directoriesCompiled, 1);
        assert.equal((await compile("metal")).directoriesCompiled, 1);
        writeFileSync(path, "ignored by Metal");
        assert.equal((await compile("metal")).directoriesReused, 1);
    }
});

test(
    "Vulkan shader binaries match SDL sampled and storage image descriptors",
    { skip: !tools.bbliteTint },
    async (t) => {
        const root = fixtureRoot(t);
        // SDL binds a sampled texture and its sampler as one combined image
        // sampler at the texture's slot, which the image and the sampler
        // both address; storage textures are sampled images after them.
        for (const [name, expected, shader] of [
            [
                "sampled",
                { color: [0, 25], colorSampler: [0, 26] },
                `
@group(2) @binding(0) var color: texture_2d<f32>;
@group(2) @binding(1) var colorSampler: sampler;
@fragment fn main() -> @location(0) vec4f {
    return textureSample(color, colorSampler, vec2f(0.5));
}`,
            ],
            [
                "shared-sampler",
                { first: [0, 25], second: [1, 25], sharedSampler: [0, 26] },
                `
@group(2) @binding(0) var first: texture_2d<f32>;
@group(2) @binding(1) var second: texture_2d<f32>;
@group(2) @binding(2) var sharedSampler: sampler;
@fragment fn main() -> @location(0) vec4f {
    return textureSample(first, sharedSampler, vec2f(0.5)) +
        textureSample(second, sharedSampler, vec2f(0.5));
}`,
            ],
            [
                "sampler-helper",
                { first: [0, 25], second: [1, 25], sharedSampler: [0, 26] },
                `
@group(2) @binding(0) var first: texture_2d<f32>;
@group(2) @binding(1) var second: texture_2d<f32>;
@group(2) @binding(2) var sharedSampler: sampler;
fn sampleColor(tex: texture_2d<f32>, smp: sampler) -> vec4f {
    return textureSampleLevel(tex, smp, vec2f(0.5), 0.0);
}
@fragment fn main() -> @location(0) vec4f {
    return sampleColor(first, sharedSampler) + sampleColor(second, sharedSampler);
}`,
            ],
            [
                "comparison",
                { shadow: [0, 25], comparison: [0, 26] },
                `
@group(2) @binding(0) var shadow: texture_depth_2d;
@group(2) @binding(1) var comparison: sampler_comparison;
@fragment fn main() -> @location(0) vec4f {
    return vec4f(textureSampleCompare(shadow, comparison, vec2f(0.5), 0.5));
}`,
            ],
            [
                "loaded",
                { color: [0, 25] },
                `
@group(2) @binding(0) var color: texture_2d<f32>;
@fragment fn main() -> @location(0) vec4f {
    return textureLoad(color, vec2i(0), 0);
}`,
            ],
            [
                "multisampled",
                { color: [0, 25] },
                `
@group(2) @binding(0) var color: texture_multisampled_2d<f32>;
@fragment fn main() -> @location(0) vec4f {
    return textureLoad(color, vec2i(0), 0);
}`,
            ],
            [
                "integer",
                { color: [0, 25] },
                `
@group(2) @binding(0) var color: texture_2d<u32>;
@fragment fn main() -> @location(0) vec4f {
    return vec4f(textureLoad(color, vec2i(0), 0));
}`,
            ],
        ] as const) {
            const directory = shaderDirectory(root, name, shader);
            await compileOfflineShaders({
                directories: [directory],
                repositoryRoot: root,
                tools,
                target: "vulkan",
            });
            const { resources } = spirvVariables(
                readFileSync(join(directory, "simple.frag.spv")),
            );
            assert.deepEqual(
                Object.fromEntries(
                    [...resources].map(([resource, { set, binding, type }]) => [
                        resource,
                        [set, binding, type],
                    ]),
                ),
                Object.fromEntries(
                    Object.entries(expected).map(
                        ([resource, [binding, type]]) => [
                            resource,
                            [2, binding, type],
                        ],
                    ),
                ),
                name,
            );
            for (const [resource, { image }] of resources)
                if (image)
                    assert.equal(
                        imageSampled(image),
                        1,
                        `${name}: ${resource} is an image SDL's sampled descriptor reads`,
                    );
        }
    },
);

test(
    "Vulkan binaries preserve sparse vertex and interstage locations",
    { skip: !tools.bbliteTint },
    async (t) => {
        const root = fixtureRoot(t);
        const directory = join(root, "shaders");
        mkdirSync(directory);
        const shader = `
struct Input {
    @location(6) color: vec4f,
    @location(0) position: vec3f,
    @location(3) uv: vec2f,
    @location(16) instance: vec4f,
};
struct Output {
    @location(7) color: vec4f,
    @builtin(position) position: vec4f,
    @location(2) uv: vec2f,
};
@vertex fn vertexMain(input: Input) -> Output {
    return Output(input.color, vec4f(input.position, 1.0) + input.instance, input.uv);
}
@fragment fn fragmentMain(@location(2) uv: vec2f, @location(7) color: vec4f) -> @location(0) vec4f {
    return color + vec4f(uv, 0.0, 0.0);
}`;
        const modules = ["vert", "frag"].map((stage) => {
            const output = `sparse.${stage}.native.wgsl`;
            writeFileSync(join(directory, output), shader);
            return {
                output,
                entryPoint: stage === "vert" ? "vertexMain" : "fragmentMain",
                pinnedBindings: false,
            };
        });
        writeFileSync(
            join(directory, "composition.json"),
            JSON.stringify({ modules }),
        );
        writeFileSync(
            join(directory, "sparse.vert.demote.spv"),
            "stale fragment-only variant",
        );
        await compileOfflineShaders({
            repositoryRoot: root,
            directories: [directory],
            tools,
            target: "vulkan",
        });
        assert.equal(
            existsSync(join(directory, "sparse.vert.demote.spv")),
            false,
        );
        const vertex = spirvVariables(
            readFileSync(join(directory, "sparse.vert.spv")),
        );
        const fragment = spirvVariables(
            readFileSync(join(directory, "sparse.frag.spv")),
        );
        // Storage classes: Input 1, Output 3.
        assert.deepEqual(vertex.locations(1), [0, 3, 6, 16]);
        assert.deepEqual(vertex.locations(3), [2, 7]);
        assert.deepEqual(fragment.locations(1), [2, 7]);
        assert.deepEqual(fragment.locations(3), [0]);
    },
);

test(
    "a rebuilt bblite-tint invalidates cached stage products",
    { skip: !tools.bbliteTint || !tools.dxc },
    async (t) => {
        const root = fixtureRoot(t);
        const tint = tools.bbliteTint;
        assert.ok(tint);
        const directory = shaderDirectory(
            root,
            "integer",
            `@group(2) @binding(0) var values: texture_2d<u32>;
@group(2) @binding(1) var color: texture_2d<f32>;
@group(2) @binding(2) var colorSampler: sampler;
@fragment fn main() -> @location(0) vec4f {
    return textureSample(color, colorSampler, vec2f(0.5)) + vec4f(textureLoad(values, vec2i(0), 0));
}`,
        );
        // The same executable with one more trailing byte: another build
        // of the same sources, so its provenance stands.
        const rebuilt = join(root, basename(tint));
        copyFileSync(tint, rebuilt);
        appendFileSync(rebuilt, Buffer.from([0]));
        copyFileSync(
            join(dirname(tint), "provenance.json"),
            join(root, "provenance.json"),
        );
        const compile = async (bbliteTint: string) =>
            await compileOfflineShaders({
                repositoryRoot: root,
                directories: [directory],
                tools: { dxc: tools.dxc, bbliteTint, cmake: tools.cmake },
                target: "d3d12",
            });
        assert.equal((await compile(tint)).tintCompiled, 1);
        assert.equal((await compile(tint)).directoriesReused, 1);
        const slots = readFileSync(
            join(directory, "simple.frag.slots"),
            "utf8",
        );
        assert.match(slots, /i0 values/);
        const refreshed = await compile(rebuilt);
        assert.equal(refreshed.directoriesCompiled, 1);
        assert.equal(refreshed.tintCompiled, 1);
        assert.equal(refreshed.compiled, 0, "identical HLSL replays its DXIL");
        assert.equal(
            readFileSync(join(directory, "simple.frag.slots"), "utf8"),
            slots,
        );
        assert.equal((await compile(rebuilt)).directoriesReused, 1);
    },
);

test(
    "a bblite-tint built from other tool sources than this checkout's is refused",
    { skip: !tools.bbliteTint },
    async (t) => {
        const root = fixtureRoot(t);
        const tint = tools.bbliteTint;
        assert.ok(tint);
        const directory = shaderDirectory(root, "stale-tool");
        const compile = async (bbliteTint: string) =>
            await compileOfflineShaders({
                repositoryRoot: root,
                directories: [directory],
                tools: { dxc: tools.dxc, bbliteTint, cmake: tools.cmake },
                target: "metal",
            });
        const provenance: unknown = JSON.parse(
            readFileSync(join(dirname(tint), "provenance.json"), "utf8"),
        );
        assert.ok(
            typeof provenance === "object" &&
                provenance !== null &&
                "sources" in provenance &&
                typeof provenance.sources === "object" &&
                provenance.sources !== null,
        );
        // Another checkout's build: one wrapper source differs, and one it
        // read is not in this checkout.
        const stale = join(root, "stale");
        mkdirSync(stale);
        copyFileSync(tint, join(stale, basename(tint)));
        writeFileSync(
            join(stale, "provenance.json"),
            JSON.stringify({
                ...provenance,
                sources: {
                    ...provenance.sources,
                    "tools/tint-sdl/main.cc": "0".repeat(64),
                    "tools/tint-sdl/extra.cc": "1".repeat(64),
                },
            }),
        );
        await assert.rejects(
            async () => await compile(join(stale, basename(tint))),
            (error: unknown) =>
                error instanceof Error &&
                error.message.includes("tools/tint-sdl/main.cc differs") &&
                error.message.includes(
                    "tools/tint-sdl/extra.cc is not in this checkout",
                ) &&
                error.message.includes("pwsh -File tools/build-tint.ps1"),
        );
        // A tool without provenance records no sources to match.
        const bare = join(root, "bare");
        mkdirSync(bare);
        copyFileSync(tint, join(bare, basename(tint)));
        await assert.rejects(
            async () => await compile(join(bare, basename(tint))),
            /provenance\.json does not exist\. Run pwsh -File tools\/build-tint\.ps1/,
        );
        // Neither failed run left a checkpoint; this checkout's tool compiles.
        assert.equal((await compile(tint)).directoriesCompiled, 1);
    },
);

test(
    "target switches remove unrequested products and specialize all formats",
    { skip: !tools.bbliteTint || !tools.dxc },
    async (t) => {
        const root = fixtureRoot(t);
        const directory = shaderDirectory(root, "formats");
        for (const target of ["all", "metal", "d3d12", "vulkan"] as const) {
            await compileOfflineShaders({
                repositoryRoot: root,
                directories: [directory],
                tools,
                target,
            });
            const formats = offlineShaderFormats(target);
            for (const extension of [".msl", ".dxil", ".spv", ".demote.spv"]) {
                assert.equal(
                    existsSync(join(directory, `simple.frag${extension}`)),
                    formats.tint.includes(extension) ||
                        (extension === ".dxil" && formats.dxil),
                    `${target}: ${extension}`,
                );
            }
        }
    },
);

test(
    "failed shader directories never acquire a completion checkpoint",
    { skip: !tools.bbliteTint },
    async (t) => {
        const root = fixtureRoot(t);
        const first = shaderDirectory(root, "a-first");
        const second = shaderDirectory(root, "b-second", "invalid WGSL");
        const compile = async () =>
            await compileOfflineShaders({
                repositoryRoot: root,
                directories: [first, second],
                tools,
                target: "metal",
            });
        // The stage's binding reflection reads the module before Tint does,
        // so an invalid module refuses there first.
        await assert.rejects(compile, /Unsupported WGSL declaration 'invalid'/);
        writeFileSync(join(second, "simple.frag.native.wgsl"), fragment);
        const result = await compile();
        assert.equal(result.directoriesReused, 1);
        assert.equal(result.directoriesCompiled, 1);
        assert.equal(result.tintReused, 1);
    },
);

test("composition parsing validates constants and extra stage identities", (t) => {
    const directory = shaderDirectory(fixtureRoot(t), "composition");
    const manifest = join(directory, "composition.json");
    const module = {
        output: "simple.frag.native.wgsl",
        entryPoint: "main",
        pinnedBindings: true,
        constants: [
            { id: 7, value: 0.75 },
            { id: 0, value: 1 },
        ],
        alsoStages: [{ stem: "other.frag", entryPoint: "other" }],
    };
    const write = () =>
        writeFileSync(manifest, JSON.stringify({ modules: [module] }));
    write();
    const stages = readShaderComposition(directory);
    assert.equal(
        shaderStageConstants(stages.get("simple.frag")!),
        "0=1,7=0.75",
    );
    assert.equal(
        stages.get("other.frag")?.sourceName,
        "simple.frag.native.wgsl",
    );
    module.constants.push({ id: 0, value: 2 });
    write();
    assert.throws(
        () => readShaderComposition(directory),
        /Duplicate shader constant/,
    );
    module.constants.pop();
    module.alsoStages[0]!.stem = "../escape.frag";
    write();
    assert.throws(
        () => readShaderComposition(directory),
        /Invalid shader stage stem/,
    );
});
