import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { lowerShaderExternalTextures } from "../src/lowering/shader-external-texture.js";
import { lowerShaderUniformRangeUpdates } from "../src/lowering/shader-uniforms.js";
import { pinnedError } from "./pinned-errors.js";
import { compileShaderMaterialFixture } from "./shader-material-fixture.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/** A ShaderMaterial's built fields read at generation, and the material views derived from them. */

const prelude = `
    import { addToScene, createEngine, createMaterialView, createMeshFromData, createSceneContext, createShaderMaterial, wgsl } from "@babylonjs/lite";
    import type { ShaderMaterial } from "@babylonjs/lite";
    const VERT = \`struct VOut { @builtin(position) position: vec4<f32>, @location(0) vWorldPos: vec3<f32> };
@vertex fn mainVertex(input: VertexInput) -> VOut { var o: VOut; o.vWorldPos = (shaderSystem.world * vec4<f32>(input.position, 1.0)).xyz; o.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0); return o; }\`;
    const surface = (tint: string): string => \`@fragment fn mainFragment(@location(0) vWorldPos: vec3<f32>) -> @location(0) vec4<f32> { return vec4<f32>(\${tint} * vWorldPos.y, 1.0); }\`;
    const NORMAL = \`@fragment fn mainFragment(@location(0) vWorldPos: vec3<f32>) -> @location(0) vec4<f32> { let n = normalize(cross(dpdx(vWorldPos), dpdy(vWorldPos))); return vec4<f32>(n * 0.5 + vec3<f32>(0.5), 1.0); }\`;
    const depthOnly = (source: string): string => \`\${source.replace("@fragment fn mainFragment(@location(0) vWorldPos: vec3<f32>) -> @location(0) vec4<f32>", "fn surface(vWorldPos: vec3<f32>) -> vec4<f32>")}
@fragment fn mainFragment(@location(0) vWorldPos: vec3<f32>) { _ = surface(vWorldPos); }\`;
    function draw(engine: Awaited<ReturnType<typeof createEngine>>, material: ShaderMaterial): void {
        const mesh = createMeshFromData(engine, "tri", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2]));
        mesh.material = material;
        addToScene(createSceneContext(engine), mesh);
    }
`;

const groundOptions = `{ name: "ground", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${surface("shaderUniforms.uTint")}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world", { name: "uTint", type: "vec3<f32>", defaultValue: [1, 0.5, 0.25] }], samplers: ["albedo", { name: "depthTex", sampleType: "depth" }], storageBuffers: [{ name: "points", type: "array<vec4<f32>>" }] }`;

const program = (
    compiled: ReturnType<typeof compileSource>,
    name: string,
): NonNullable<typeof compiled.manifest.customShaderPrograms>[number] => {
    const found = compiled.manifest.customShaderPrograms?.find(
        (candidate) => candidate.name === name,
    );
    assert.ok(found, `program ${name}`);
    return found;
};

test("a ShaderMaterial of a known variant reads the declarations and sources the pin builds from its options", () => {
    const compiled = compileSource(`${prelude}
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const ground = createShaderMaterial(${groundOptions});
        // The pin normalizes a bare sampler name and copies typed uniforms.
        const depth = ground.samplerDecls.filter((decl) => decl.name !== "albedo");
        const copy = createShaderMaterial({
            name: ground.samplerDecls[0]!.sampleType === "float" && ground.uniformDecls[2]!.type === "vec3<f32>" ? "copy" : "mismatch",
            vertexSource: ground.vertexSource,
            fragmentSource: ground.fragmentSource,
            attributes: ["position"],
            uniforms: ground.uniformDecls,
            samplers: depth,
            storageBuffers: ground.storageBufferDecls,
        });
        draw(engine, copy);
    }
    void main();
`);
    const ground = program(compiled, "ground");
    const copy = program(compiled, "copy");
    assert.equal(copy.vertexSource, ground.vertexSource);
    assert.equal(copy.fragmentSource, ground.fragmentSource);
    // A system matrix the pin's uniformDecls types is that system uniform.
    assert.deepEqual(copy.uniforms, ground.uniforms);
    assert.deepEqual(copy.uniformDefaults, ground.uniformDefaults);
    assert.deepEqual(copy.samplers, ["depthTex"]);
    assert.equal(copy.samplerDeclarations[0]?.sampleType, "depth");
    assert.deepEqual(copy.storageBuffers, ground.storageBuffers);
});

test("a ShaderMaterial's fields and slot maps refuse where the run time decides them", () => {
    const source = (body: string): string => `${prelude}
    import type { Mesh } from "@babylonjs/lite";
    type Slots = ShaderMaterial & { _textureSlots: Map<string, unknown> };
    function read(mesh: Mesh): number {
        const material = mesh.material as ShaderMaterial;
        return ${body};
    }
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const ground = createShaderMaterial(${groundOptions});
        const mesh = createMeshFromData(engine, "tri", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2]));
        mesh.material = ground;
        addToScene(createSceneContext(engine), mesh);
        const registry = { add(target: Mesh): number { return read(target); } };
        console.log(registry.add(mesh));
    }
    void main();
`;
    assert.throws(
        () => compileSource(source("material.vertexSource.length")),
        /'material\.vertexSource' reads a ShaderMaterial's 'vertexSource', which its shader variant decides; this material's variant is decided at run time\./,
    );
    assert.throws(
        () => compileSource(source("(material as Slots)._textureSlots.size")),
        /'\(material as Slots\)\._textureSlots' reads a ShaderMaterial's '_textureSlots', which its shader variant decides; this material's variant is decided at run time\./,
    );
});

test("a view whose fragment a statement redefines draws the program derived from its source's options, over its source's slots", () => {
    const compiled = compileSource(`${prelude}
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const ground = createShaderMaterial(${groundOptions});
        const view = createMaterialView(ground, { features: 0 }) as ShaderMaterial;
        Object.defineProperty(view, "fragmentSource", { value: wgsl\`\${NORMAL}\`, configurable: true });
        // The view reads its own redefinition back.
        const again = createShaderMaterial({ name: "again", vertexSource: view.vertexSource, fragmentSource: view.fragmentSource, attributes: ["position"], uniforms: ["worldViewProjection", "world"] });
        draw(engine, view);
        draw(engine, again);
    }
    void main();
`);
    const ground = program(compiled, "ground");
    const view = program(compiled, "ground-1");
    assert.match(view.fragmentSource, /normalize\(cross\(dpdx/);
    assert.equal(view.vertexSource, ground.vertexSource);
    assert.deepEqual(
        [view.uniforms, view.samplers, view.storageBuffers],
        [ground.uniforms, ground.samplers, ground.storageBuffers],
    );
    assert.equal(
        program(compiled, "again").fragmentSource,
        view.fragmentSource,
    );
    const programs = compiled.manifest.customShaderPrograms;
    assert.match(
        compiled.cpp,
        /auto (\w+) = bbl::create_shader_material_view\(\w+, \w+\);[\s\S]*bbl::derive_shader_material_view\(\w+, \1, (\d+)u, false\);/,
    );
    assert.equal(
        compiled.cpp.match(
            /derive_shader_material_view\(\w+, \w+, (\d+)u/,
        )?.[1],
        String(programs.indexOf(view)),
    );
    assert.ok(compiled.manifest.features.includes("material:shader-view"));
});

test("a view redefined on the branches of a run-time test draws the program of the branch that ran, and later redefinitions derive from each", () => {
    const compiled = compileSource(`${prelude}
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const ground = createShaderMaterial(${groundOptions});
        const view = createMaterialView(ground, { features: 0 }) as ShaderMaterial;
        if (Math.random() > 0.5) {
            Object.defineProperty(view, "fragmentSource", { value: wgsl\`\${NORMAL}\`, configurable: true });
        } else {
            Object.defineProperty(view, "blend", { value: { color: { operation: "add", srcFactor: "zero", dstFactor: "one" }, alpha: { operation: "add", srcFactor: "zero", dstFactor: "one" } } });
        }
        Object.defineProperty(view, "depthOnlyFragment", { value: true });
        draw(engine, view);
    }
    void main();
`);
    const programs = compiled.manifest.customShaderPrograms;
    const id = (name: string): number =>
        programs.findIndex((candidate) => candidate.name === name);
    // Each branch derives from the source; the last definition derives
    // from the program of each branch, the one that ran selected.
    const normal = program(compiled, "ground-1");
    const blended = program(compiled, "ground-2");
    assert.match(normal.fragmentSource, /normalize\(cross\(dpdx/);
    assert.deepEqual(blended.blend, ["zero", "one", "zero", "one"]);
    const derives = [
        ...compiled.cpp.matchAll(
            /bbl::derive_shader_material_view\(\w+, \w+, ([^;]*), false\);/g,
        ),
    ].map(([, variant]) => variant);
    assert.deepEqual(derives.slice(0, 2), [
        `${id("ground-1")}u`,
        `${id("ground-2")}u`,
    ]);
    const site = derives[2]!.match(/derived_shader_variant_(\d+)\(/)?.[1];
    assert.ok(site, "the last definition selects from the view's variant");
    const table = cppFunction(
        compiled.cpp,
        `inline std::uint32_t derived_shader_variant_${site}(`,
    );
    assert.doesNotMatch(table, new RegExp(`case ${id("ground")}u:`));
    for (const from of ["ground-1", "ground-2"]) {
        const to = table.match(
            new RegExp(`case ${id(from)}u: return (\\d+)u;`),
        )?.[1];
        assert.ok(to, from);
        assert.equal(programs[Number(to)]!.depthOnlyFragment, true, from);
    }
});

test("a helper's unreassigned view parameter redefines the caller's branch before a later definition", () => {
    const compiled = compileSource(`${prelude}
    function finish(view: ShaderMaterial): void {
        Object.defineProperty(view, "depthOnlyFragment", { value: true });
    }
    function adapt(view: ShaderMaterial): void {
        Object.defineProperty(view, "fragmentSource", { value: wgsl\`\${NORMAL}\` });
        finish(view);
    }
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const ground = createShaderMaterial(${groundOptions});
        const view = createMaterialView(ground, { features: 0 }) as ShaderMaterial;
        if (Math.random() > 0.5) {
            adapt(view);
        } else {
            Object.defineProperty(view, "blend", { value: { color: { operation: "add", srcFactor: "zero", dstFactor: "one" }, alpha: { operation: "add", srcFactor: "zero", dstFactor: "one" } } });
        }
        Object.defineProperty(view, "transmissive", { value: false });
        draw(engine, view);
    }
    void main();
`);
    const programs = compiled.manifest.customShaderPrograms;
    assert.ok(
        programs.some(
            (item) =>
                /normalize\(cross\(dpdx/.test(item.fragmentSource) &&
                item.depthOnlyFragment,
        ),
    );
    assert.ok(
        programs.some(
            (item) => item.blend?.[0] === "zero" && !item.depthOnlyFragment,
        ),
    );
    assert.equal(
        (compiled.cpp.match(/bbl::derive_shader_material_view\(/g) ?? [])
            .length,
        4,
    );
});

const revisionHelper = `
    type Revisions = ShaderMaterial & { _uniformVersion: number; _resourceVersion: number; _uboVersion: number };
    function revision(read: () => number, related: () => number = read): PropertyDescriptor {
        let offset = 0;
        return {
            get() { return Math.max(read(), related()) + offset; },
            set(value: number) { offset = value - Math.max(read(), related()); },
            configurable: true,
        };
    }
`;

test("an unentered definition-only helper branch does not make the later view definition an observed use", () => {
    const compiled = compileSource(`${prelude}
    function install(view: ShaderMaterial): void {
        Object.defineProperty(view, "fragmentSource", { value: wgsl\`\${NORMAL}\` });
    }
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const ground = createShaderMaterial(${groundOptions});
        const view = createMaterialView(ground, { features: 0 }) as ShaderMaterial;
        if (ground.needAlphaBlending) install(view);
        else Object.defineProperty(view, "depthOnlyFragment", { value: true });
        Object.defineProperty(view, "transmissive", { value: false });
        draw(engine, view);
    }
    void main();
`);
    assert.ok(
        compiled.manifest.customShaderPrograms.some(
            (item) => item.depthOnlyFragment,
        ),
    );
});

test("a helper installs native revisions and exact cache resets before the caller's next definition", () => {
    const compiled = compileSource(`${prelude}${revisionHelper}
    type Decl = { name: string; type: "vec4<f32>" };
    type UniformSlot = { decl: Decl; value: Float32Array };
    type UniformState = Revisions & { _uniformValues: Map<string, UniformSlot> };
    const EXTRA: Decl = { name: "uIdentity", type: "vec4<f32>" };
    function install(view: ShaderMaterial, source: ShaderMaterial, base: number): void {
        const src = source as UniformState;
        const values = new Map<string, UniformSlot>(src._uniformValues);
        values.set(EXTRA.name, { decl: EXTRA, value: Float32Array.of(base, 0, 0, 0) });
        Object.defineProperties(view, {
            uniformDecls: { value: [...source.uniformDecls.filter(d => d.name !== EXTRA.name), EXTRA], configurable: true },
            _uniformValues: { value: values, configurable: true },
            _uniformVersion: revision(() => src._uniformVersion),
            _resourceVersion: revision(() => src._resourceVersion),
            _uboVersion: revision(() => src._uboVersion, () => src._uniformVersion),
            _shaderDevice: { value: undefined, writable: true },
            _shaderBindings: { value: undefined, writable: true },
            _shaderCustomUbo: { value: null, writable: true },
            _shaderCustomSpec: { value: null, writable: true },
            _shaderCustomData: { value: null, writable: true },
            _shaderCustomVersion: { value: -1, writable: true },
        });
    }
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const ground = createShaderMaterial(${groundOptions});
        const view = createMaterialView(ground, { features: 0 }) as ShaderMaterial;
        if (Math.random() > 0.5) {
            Object.defineProperty(view, "vertexSource", { value: ground.vertexSource });
            Object.defineProperty(view, "fragmentSource", { value: wgsl\`\${NORMAL}\` });
            install(view, ground, Math.random());
        } else {
            Object.defineProperty(view, "depthOnlyFragment", { value: true });
        }
        Object.defineProperty(view, "transmissive", { value: false });
        draw(engine, view);
    }
    void main();
`);
    assert.match(compiled.cpp, /bbl::install_shader_view_slots\(/);
    assert.ok(
        compiled.manifest.customShaderPrograms.some((item) =>
            item.uniforms.includes("uIdentity:vec4<f32>"),
        ),
    );
    assert.doesNotMatch(compiled.cpp, /_shaderCustomVersion|_uniformVersion/);
});

test("view helpers refuse observed or reassigned parameters, early returns, and non-native descriptors", () => {
    const source = (
        helper: string,
        call = "install(view, ground);",
    ): string => `${prelude}${revisionHelper}
    function install(view: ShaderMaterial, source: ShaderMaterial): void { ${helper} }
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const ground = createShaderMaterial(${groundOptions});
        const view = createMaterialView(ground, { features: 0 }) as ShaderMaterial;
        ${call}
        Object.defineProperty(view, "transmissive", { value: false });
        draw(engine, view);
    }
    void main();`;
    for (const helper of [
        `view = source; Object.defineProperty(view, "depthOnlyFragment", { value: true });`,
        `console.log(view.name); Object.defineProperty(view, "depthOnlyFragment", { value: true });`,
        `if (Math.random() > 0.5) return; Object.defineProperty(view, "depthOnlyFragment", { value: true });`,
        `Object.defineProperty(view, "_uniformVersion", revision(() => (source as Revisions)._resourceVersion));`,
        `Object.defineProperty(view, "_uniformVersion", { get() { return 0; }, set(value: number) {} });`,
        `Object.defineProperty(view, "_shaderDevice", { value: null });`,
        `Object.defineProperty(view, "_shaderCustomVersion", { value: 0 });`,
        `Object.defineProperty(view, "_shaderCustomData", { value: undefined });`,
    ])
        assert.throws(
            () => compileSource(source(helper)),
            /ShaderMaterial|material view/,
        );
    assert.throws(
        () =>
            compileSource(
                source(
                    `Object.defineProperty(view, "depthOnlyFragment", { value: true });`,
                    `console.log(view.name); install(view, ground);`,
                ),
            ),
        /ShaderMaterial view/,
    );
    const revisionSource = source(
        `Object.defineProperty(view, "_uniformVersion", revision(() => (source as Revisions)._uniformVersion));`,
    );
    for (const changed of [
        revisionSource.replace("+ offset;", "+ 1;"),
        revisionSource.replace(
            "offset = value - Math.max(read(), related());",
            "offset = 0;",
        ),
        revisionSource.replace(
            "let offset = 0;",
            `let offset = 0; console.log("effect");`,
        ),
        revisionSource.replace("related()) + offset", "related()) * offset"),
    ])
        assert.throws(
            () => compileSource(changed),
            /source-following additive revision/,
        );
});

/**
 * A view revision counting the changes it observes: a followed revision
 * unlike the one its last read saw, or an assignment unlike the last one.
 */
const observedRevisionSource = `${prelude}
    import { setShaderUniform } from "@babylonjs/lite";
    type Decl = { name: string; type: "vec4<f32>" };
    type UniformSlot = { decl: Decl; value: Float32Array };
    type UniformState = ShaderMaterial & { _uniformValues: Map<string, UniformSlot>; _uniformVersion: number; _resourceVersion: number; _uboVersion: number };
    const GAIN: Decl = { name: "uGain", type: "vec4<f32>" };
    function observed(follow: () => number, alongside: () => number = () => 0): PropertyDescriptor {
        let lastFollowed = follow();
        let lastAlongside = alongside();
        let lastStored = lastFollowed;
        let count = lastFollowed;
        return {
            get() {
                const followed = follow();
                const beside = alongside();
                if (followed !== lastFollowed || beside !== lastAlongside) {
                    lastFollowed = followed;
                    lastAlongside = beside;
                    count += 1;
                }
                return count;
            },
            set(next: number) {
                if (next !== lastStored) {
                    ++count;
                    lastStored = next;
                }
            },
            enumerable: true,
            configurable: true,
        };
    }
    function gained(view: ShaderMaterial, source: ShaderMaterial): void {
        const src = source as UniformState;
        const values = new Map<string, UniformSlot>(src._uniformValues);
        values.set(GAIN.name, { decl: GAIN, value: Float32Array.of(1, 1, 1, 1) });
        Object.defineProperties(view, {
            fragmentSource: { value: wgsl\`\${surface("shaderUniforms.uTint * shaderUniforms.uGain.xyz")}\`, configurable: true },
            uniformDecls: { value: [...source.uniformDecls, GAIN], configurable: true },
            _uniformValues: { value: values, configurable: true },
            _uniformVersion: observed(() => src._uniformVersion),
            _resourceVersion: observed(() => src._resourceVersion),
            _uboVersion: observed(() => src._uboVersion, () => src._uniformVersion),
            _shaderCustomVersion: { value: -1, writable: true },
        });
    }
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const ground = createShaderMaterial(${groundOptions});
        const view = createMaterialView(ground, { features: 0 }) as ShaderMaterial;
        gained(view, ground);
        draw(engine, view);
        setShaderUniform(ground, "uTint", [0, 1, 0]);
        setShaderUniform(view, "uGain", [2, 2, 2, 1]);
    }
    void main();
`;

test("a view revision counting the changes it observes is the native view counter, and other counting shapes refuse", () => {
    const compiled = compileSource(observedRevisionSource);
    assert.match(compiled.cpp, /bbl::install_shader_view_slots\(/);
    assert.ok(
        compiled.manifest.customShaderPrograms.some((item) =>
            item.uniforms.includes("uGain:vec4<f32>"),
        ),
    );
    assert.doesNotMatch(compiled.cpp, /_uniformVersion|lastFollowed/);
    for (const [from, to] of [
        // An assignment of the same number is a change.
        ["if (next !== lastStored) {", "{"],
        // A change of the related revision goes unseen.
        [
            "followed !== lastFollowed || beside !== lastAlongside",
            "followed !== lastFollowed",
        ],
        // The sentinel the pin resets its upload stamp to.
        ["let count = lastFollowed;", "let count = -1;"],
        // An assignment equal to the first count would go unseen.
        [
            "let lastStored = lastFollowed;",
            "let lastStored = lastFollowed + 1;",
        ],
        // The read is not the count.
        ["return count;", "return lastFollowed;"],
        // Another revision followed.
        [
            "_uniformVersion: observed(() => src._uniformVersion)",
            "_uniformVersion: observed(() => src._resourceVersion)",
        ],
    ] as const) {
        const changed = observedRevisionSource.replace(from, to);
        assert.notEqual(changed, observedRevisionSource);
        assert.throws(
            () => compileSource(changed),
            /a revision counting the changes it observes/,
            to,
        );
    }
    // The program reading or writing the number would meet the native counter's.
    for (const use of [
        "if ((view as UniformState)._uniformVersion > 3) draw(engine, ground);",
        "(view as UniformState)._uniformVersion = 5;",
    ])
        assert.throws(
            () =>
                compileSource(
                    observedRevisionSource.replace(
                        "draw(engine, view);",
                        `draw(engine, view); ${use}`,
                    ),
                ),
            /Unsupported property (value|assignment) '\(view as UniformState\)\._uniformVersion'/,
        );
});

test("a view revision counting the changes it observes natively re-uploads the view's uniforms on a source change and a local set", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const { compiled, cpp } = compileShaderMaterialFixture(
        observedRevisionSource,
    );
    const views = new FactoryLowerer(
        new LoweringContext(),
    ).lowerNoColorMaterialViews(false, false, false, false, true).source;
    const id = (name: string): number =>
        compiled.manifest.customShaderPrograms.findIndex(
            (candidate) => candidate.name === name,
        );
    const gained = compiled.manifest.customShaderPrograms.find((item) =>
        item.uniforms.includes("uGain:vec4<f32>"),
    )!.name;
    runGeneratedProgram(
        native,
        "shader-material-views/observed-revision",
        `
${cpp}
#include <array>
#include <cstdio>
namespace bbl {
namespace {
${cppFunction(views, "MaterialHandle create_no_color_material_view(")}
}
${cppFunction(views, "MaterialHandle create_shader_material_view(")}
${cppFunction(views, "void derive_shader_material_view(")}
// The slot maps' setters, which this run does not reach.
void set_shader_pixels_texture(Engine&, MaterialHandle, std::uint32_t, const std::variant<FileTexture, PixelsTexture>&) { throw std::runtime_error("unreached"); }
void set_shader_storage_buffer(Engine&, MaterialHandle, std::uint32_t, StorageBufferHandle) { throw std::runtime_error("unreached"); }
}
int main(){
    bbl::Engine engine;
    const auto source = bbl::create_shader_material(engine, ${id("ground")}u);
    const auto view = bbl::create_shader_material_view(engine, source);
    bbl::derive_shader_material_view(engine, view, ${id(gained)}u, false);
    const auto& own = bbl::handle_at(engine.materials, view);
    const auto offset = [](const char* name) {
        for (const auto& slot : bbl::upstream::shader_variant_info(${id(gained)}u).uniform_slots)
            if (std::string_view(slot.name) == name) return slot.offset;
        throw std::runtime_error("no uniform");
    };
    // What the view's UBO holds after a draw, and whether that draw re-uploaded it.
    double stamp = -1;
    const auto draw = [&] {
        const auto& values = bbl::shader_uniform_render_values(own);
        for (std::uint32_t lane = 0; lane < 3u; ++lane) std::printf("%g,", static_cast<double>(values.at(offset("uTint") + lane)));
        std::printf("%g%s ", static_cast<double>(values.at(offset("uGain"))), own.shader_uniform_upload->version != stamp ? "+" : "=");
        stamp = own.shader_uniform_upload->version;
    };
    draw();
    draw();
    bbl::set_shader_uniform(engine, source, "uTint", std::array<double, 3>{0.0, 1.0, 0.0});
    draw();
    bbl::set_shader_uniform(engine, view, "uGain", std::array<double, 4>{2.0, 2.0, 2.0, 1.0});
    draw();
    // An unchanged value is no change.
    bbl::set_shader_uniform(engine, view, "uGain", std::array<double, 4>{2.0, 2.0, 2.0, 1.0});
    draw();
}
`,
        {
            // uGain is the view's own slot: zero until set, as this run installs no slot map.
            expectedOutput:
                "1,0.5,0.25,0+ 1,0.5,0.25,0= 0,1,0,0+ 0,1,0,2+ 0,1,0,2= ",
        },
    );
});

const variantsSource = `${prelude}
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const warm = createShaderMaterial({ name: "warm", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${surface("vec3<f32>(1.0, 0.5, 0.0)")}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world"] });
        const cold = createShaderMaterial({ name: "cold", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${surface("vec3<f32>(0.0, 0.5, 1.0)")}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world"], needAlphaBlending: true });
        const pick = (flag: boolean): ShaderMaterial => (flag ? warm : cold);
        const source = pick(Math.random() > 0.5);
        const view = createMaterialView(source, { features: 0 });
        Object.defineProperties(view, {
            fragmentSource: { value: wgsl\`\${depthOnly(source.fragmentSource)}\`, enumerable: true, configurable: true },
            depthOnlyFragment: { value: true },
            blend: { value: { color: { operation: "add", srcFactor: "zero", dstFactor: "one" }, alpha: { operation: "add", srcFactor: "zero", dstFactor: "one" } } },
        });
        draw(engine, view as ShaderMaterial);
    }
    void main();
`;

test("a view's redefinition may reach a throw: generation evaluates it, and one that throws there refuses", () => {
    const source = (check: string): string => `${prelude}
    function capture(fragment: string): string {
        if (${check}) throw new Error("expected one fragment entry point");
        return fragment.replace("vWorldPos.y", "0.5");
    }
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const ground = createShaderMaterial(${groundOptions});
        const view = createMaterialView(ground, { features: 0 }) as ShaderMaterial;
        Object.defineProperty(view, "fragmentSource", { value: capture(ground.fragmentSource), configurable: true });
        draw(engine, view);
    }
    void main();
`;
    const compiled = compileSource(
        source(`fragment.split("@fragment").length !== 2`),
    );
    assert.match(program(compiled, "ground-1").fragmentSource, /uTint \* 0\.5/);
    assert.throws(
        () => compileSource(source(`fragment.length > 0`)),
        /A ShaderMaterial view's 'fragmentSource' compiles into its program at generation; this value is decided at run time\./,
    );
});

test("a view's redefinition on one branch of a run-time test follows uses of the view on the other branch", () => {
    const compiled = compileSource(`${prelude}
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const ground = createShaderMaterial(${groundOptions});
        const view = createMaterialView(ground, { features: 0 }) as ShaderMaterial;
        if (Math.random() > 0.5) {
            draw(engine, view);
        } else {
            Object.defineProperty(view, "fragmentSource", { value: wgsl\`\${NORMAL}\`, configurable: true });
            draw(engine, view);
        }
    }
    void main();
`);
    // The redefinition derives from the source, the program the view
    // draws on the branch that does not redefine it.
    assert.match(
        program(compiled, "ground-1").fragmentSource,
        /normalize\(cross\(dpdx/,
    );
});

test("a view over a material of several variants derives one program per variant, chosen at run time from the view's", () => {
    const compiled = compileSource(variantsSource);
    const programs = compiled.manifest.customShaderPrograms;
    const warm = program(compiled, "warm-1");
    const cold = program(compiled, "cold-1");
    // Each program reads its own source's fragment.
    assert.match(warm.fragmentSource, /vec3<f32>\(1\.0, 0\.5, 0\.0\)/);
    assert.match(cold.fragmentSource, /vec3<f32>\(0\.0, 0\.5, 1\.0\)/);
    for (const derived of [warm, cold]) {
        assert.equal(derived.depthOnlyFragment, true);
        assert.deepEqual(derived.blend, ["zero", "one", "zero", "one"]);
    }
    // A redefined blend keeps the alpha blending and depth writes each
    // source resolved, as the view inherits them.
    assert.deepEqual([warm.needAlphaBlending, warm.depthWrite], [false, true]);
    assert.deepEqual([cold.needAlphaBlending, cold.depthWrite], [true, false]);
    assert.match(
        compiled.cpp,
        /bbl::derive_shader_material_view\((\w+), (\w+), bblscene::derived_shader_variant_0\(bbl::shader_material_view_variant\(\1, \2\)\), false\);/,
    );
    const table = compiled.cpp.slice(
        compiled.cpp.indexOf("derived_shader_variant_0(std::uint32_t source)"),
    );
    for (const [source, derived] of [
        ["warm", warm],
        ["cold", cold],
    ] as const)
        assert.match(
            table,
            new RegExp(
                `case ${programs.findIndex((candidate) => candidate.name === source)}u: return ${programs.indexOf(derived)}u;`,
            ),
        );
});

test("a view refuses redefinitions generation cannot derive a program from", () => {
    const view = (statement: string, source = "ground"): string => `${prelude}
    import type { Mesh } from "@babylonjs/lite";
    let tint = NORMAL;
    function setTint(text: string): void { tint = text; }
    function derive(mesh: Mesh): ShaderMaterial {
        const material = mesh.material as ShaderMaterial;
        const view = createMaterialView(material, { features: 0 }) as ShaderMaterial;
        ${source === "material" ? statement : ""}
        return view;
    }
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const ground = createShaderMaterial(${groundOptions});
        const view = createMaterialView(ground, { features: 0 }) as ShaderMaterial;
        ${source === "ground" ? statement : ""}
        draw(engine, view);
        const mesh = createMeshFromData(engine, "tri", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2]));
        mesh.material = ground;
        const registry = { add(target: Mesh): ShaderMaterial { return derive(target); } };
        draw(engine, registry.add(mesh));
    }
    void main();
`;
    const cases: Array<[string, RegExp, string?]> = [
        [
            `Object.defineProperty(view, "uniformDecls", { value: [...view.uniformDecls, { name: "uExtra", type: "f32" }] });`,
            /A ShaderMaterial view keeps its source's slots; its redefinitions \(uniformDecls\) declare other uniforms, samplers or storage buffers than shader variant 'ground'/,
        ],
        [
            `Object.defineProperty(view, "_textureSlots", { value: new Map<string, number>() });`,
            /A ShaderMaterial's slot map is a Map from names to records of 'decl' and 'current'/,
        ],
        [
            `Object.defineProperties(view, { _shaderCustomUbo: { value: 0, writable: true } });`,
            /A ShaderMaterial view's '_shaderCustomUbo' cache reset requires the literal null\./,
        ],
        [
            `Object.defineProperty(view, "fragmentSource", { get: () => NORMAL });`,
            /A ShaderMaterial view's 'fragmentSource' is redefined by a literal data descriptor/,
        ],
        [
            `while (Math.random() > 2) Object.defineProperty(view, "fragmentSource", { value: NORMAL });`,
            /A ShaderMaterial view's program is redefined by a statement after the view's `const` declaration, in its block or the `if` branches there, before any other use of the view/,
        ],
        [
            `draw(engine, view); Object.defineProperty(view, "fragmentSource", { value: NORMAL });`,
            /A ShaderMaterial view's program is redefined by a statement after the view's `const` declaration, in its block or the `if` branches there, before any other use of the view/,
        ],
        [
            `const redefine = (): void => { Object.defineProperty(view, "fragmentSource", { value: NORMAL }); }; redefine();`,
            /A ShaderMaterial view's program is redefined by a statement after the view's `const` declaration, in its block or the `if` branches there, before any other use of the view/,
        ],
        [
            `setTint(String(Math.random())); Object.defineProperty(view, "fragmentSource", { value: tint });`,
            /A ShaderMaterial view's 'fragmentSource' compiles into its program at generation; this value is decided at run time\./,
        ],
        [
            `Object.defineProperty(ground, "fragmentSource", { value: NORMAL });`,
            /Object\.defineProperty redefines a ShaderMaterial's properties only on a material view a `const` names/,
        ],
        [
            `const nested = createMaterialView(view, { features: 0 }); console.log(nested !== view);`,
            /createMaterialView of a material view views that view's source, without its redefinitions; pass the source material\./,
        ],
    ];
    for (const [statement, refusal, source] of cases)
        assert.throws(() => compileSource(view(statement, source)), refusal);
});

test("a view over a material of run-time variant derives a program per variant the program creates, later creations included", () => {
    const source = (creates: boolean): string => `${prelude}
    import { createStandardMaterial } from "@babylonjs/lite";
    import type { Mesh } from "@babylonjs/lite";
    function derive(mesh: Mesh): ShaderMaterial {
        const material = mesh.material as ShaderMaterial;
        const view = createMaterialView(material, { features: 0 }) as ShaderMaterial;
        Object.defineProperty(view, "fragmentSource", { value: wgsl\`\${NORMAL}\` });
        return view;
    }
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const mesh = createMeshFromData(engine, "tri", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2]));
        mesh.material = createStandardMaterial();
        const registry = { add(target: Mesh): ShaderMaterial { return derive(target); } };
        draw(engine, registry.add(mesh));
        ${creates ? `mesh.material = createShaderMaterial(${groundOptions}); draw(engine, registry.add(mesh));` : ""}
    }
    void main();
`;
    assert.throws(
        () => compileSource(source(false)),
        /A ShaderMaterial view derives its program from its source's shader variant; this source's variant is decided at run time, and the program creates none\./,
    );
    const compiled = compileSource(source(true));
    const programs = compiled.manifest.customShaderPrograms;
    const id = (name: string): number =>
        programs.findIndex((candidate) => candidate.name === name);
    assert.match(
        program(compiled, "ground-1").fragmentSource,
        /normalize\(cross\(dpdx/,
    );
    const site = compiled.cpp.match(
        /bbl::derive_shader_material_view\(\w+, \w+, bblscene::derived_shader_variant_(\d+)\(bbl::shader_material_view_variant\(/,
    )?.[1];
    assert.ok(site, "the view selects its program from its run-time variant");
    assert.match(
        cppFunction(
            compiled.cpp,
            `inline std::uint32_t derived_shader_variant_${site}(`,
        ),
        new RegExp(`case ${id("ground")}u: return ${id("ground-1")}u;`),
    );
});

test("a derived view natively draws the variant derived from its source's, keeping the source's slots", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const { compiled, cpp } = compileShaderMaterialFixture(variantsSource);
    const views = new FactoryLowerer(
        new LoweringContext(),
    ).lowerNoColorMaterialViews(false, false, false, false, true).source;
    const programs = compiled.manifest.customShaderPrograms;
    const id = (name: string): number =>
        programs.findIndex((candidate) => candidate.name === name);
    const table = cppFunction(
        compiled.cpp,
        "inline std::uint32_t derived_shader_variant_0(",
    );
    runGeneratedProgram(
        native,
        "shader-material-views/derive",
        `
${cpp}
#include <cstdio>
namespace bbl {
namespace {
${cppFunction(views, "MaterialHandle create_no_color_material_view(")}
}
${cppFunction(views, "MaterialHandle create_shader_material_view(")}
${cppFunction(views, "void derive_shader_material_view(")}
${cppFunction(views, "std::uint32_t shader_material_view_variant(")}
}
namespace bblscene {
${table}
}
int main(){
    bbl::Engine engine;
    // Each source variant: the view draws the variant derived from it with
    // that program's state, and binds through its source's record.
    for(const std::uint32_t source : {${id("warm")}u, ${id("cold")}u}){
        const auto material = bbl::create_shader_material(engine, source);
        const auto view = bbl::create_shader_material_view(engine, material);
        bbl::derive_shader_material_view(engine, view, bblscene::derived_shader_variant_0(bbl::shader_material_view_variant(engine, view)), false);
        const auto& record = bbl::handle_at(engine.materials, view);
        std::printf("%s:%u:%d:%d:%d ", std::string(bbl::upstream::shader_variant_info(record.shader_variant).name).c_str(), record.source_material.value == material.value ? 1u : 0u, record.alpha_mode == bbl::MaterialAlphaMode::blend ? 1 : 0, record.shader_depth_write ? 1 : 0, record.no_color ? 1 : 0);
    }
}
`,
        { expectedOutput: "warm-1:1:0:1:0 cold-1:1:1:0:0 " },
    );
});

const conditionalSpreadSource = (descriptors: string): string => `${prelude}
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const ground = createShaderMaterial(${groundOptions});
        const view = createMaterialView(ground, { features: 0 }) as ShaderMaterial;
        const lifted = Math.random() > 0.5;
        Object.defineProperties(view, {${descriptors}});
        Object.defineProperty(view, "depthOnlyFragment", { value: true });
        draw(engine, view);
    }
    void main();
`;

const liftedDescriptors = `
            vertexSource: { value: wgsl\`\${VERT.replace("1.0); return o;", "2.0); return o;")}\`, enumerable: true, configurable: true },
            attributes: { value: ["position"], enumerable: true, configurable: true },`;

const conditionalSpread = `
        ...(lifted ? {${liftedDescriptors}
        } : {}),
        fragmentSource: { value: wgsl\`\${NORMAL}\`, enumerable: true, configurable: true },`;

test("a view's descriptor map opening with a conditional spread defines the spread's keys only where its test selects them", () => {
    for (const [spread, liftedWhen] of [
        [conditionalSpread, "true"],
        [
            conditionalSpread
                .replace(`lifted ? {${liftedDescriptors}`, "lifted ? {} : {")
                .replace("} : {}),", `${liftedDescriptors} }),`),
            "false",
        ],
    ] as const) {
        const compiled = compileSource(conditionalSpreadSource(spread));
        const programs = compiled.manifest.customShaderPrograms;
        const id = (name: string): number =>
            programs.findIndex((candidate) => candidate.name === name);
        // Both definition sets derive from the source's options.
        const sets = programs.filter(
            (candidate) =>
                /dpdx/.test(candidate.fragmentSource) &&
                !candidate.depthOnlyFragment,
        );
        const raised = sets.find((candidate) =>
            /2\.0\); return o;/.test(candidate.vertexSource),
        );
        const kept = sets.find((candidate) => candidate !== raised);
        assert.ok(raised && kept && sets.length === 2);
        assert.equal(
            kept.vertexSource,
            program(compiled, "ground").vertexSource,
        );
        // The test selects the set at run time.
        const [first, second] =
            liftedWhen === "true" ? [raised, kept] : [kept, raised];
        assert.match(
            compiled.cpp,
            new RegExp(
                `if \\(v_lifted\\) \\{\\s*bbl::derive_shader_material_view\\(\\w+, \\w+, ${id(first.name)}u, false\\);\\s*\\} else \\{\\s*bbl::derive_shader_material_view\\(\\w+, \\w+, ${id(second.name)}u, false\\);\\s*\\}`,
            ),
        );
        // A later definition derives from either set's program.
        const site = compiled.cpp.match(
            /derive_shader_material_view\(\w+, \w+, bblscene::derived_shader_variant_(\d+)\(/,
        )?.[1];
        assert.ok(site, "the later definition selects from the view's variant");
        const table = cppFunction(
            compiled.cpp,
            `inline std::uint32_t derived_shader_variant_${site}(`,
        );
        for (const from of [raised, kept])
            assert.match(table, new RegExp(`case ${id(from.name)}u:`));
    }
});

test("a view's descriptor map spreads only a leading conditional between descriptors and {}, and other targets refuse spreads", () => {
    const viewRefusal =
        /Object\.defineProperties on a ShaderMaterial view spreads only, as the map's first member, a conditional between a literal descriptor map and \{\}\./;
    const refuses = (descriptors: string, refusal: RegExp): void =>
        assert.throws(
            () => compileSource(conditionalSpreadSource(descriptors)),
            refusal,
            descriptors,
        );
    const [opening, closing] = conditionalSpread.split(
        "        fragmentSource:",
    );
    refuses(`fragmentSource:${closing!}${opening!}`, viewRefusal);
    refuses(
        conditionalSpread.replace(
            "} : {}),",
            `} : { depthOnlyFragment: { value: true } }),`,
        ),
        viewRefusal,
    );
    refuses(`...{${liftedDescriptors} },`, viewRefusal);
    refuses(
        conditionalSpread.replace(
            "...(lifted ? {",
            "...(lifted ? { ...{ transmissive: { value: false } },",
        ),
        /Object\.defineProperties needs distinct literal property keys without spreads, methods or accessors\./,
    );
    assert.throws(
        () =>
            compileSource(`
    const record = { a: 1, b: 2 };
    Object.defineProperties(record, { ...(Math.random() > 0.5 ? { a: { value: 3, enumerable: true, writable: true, configurable: true } } : {}) });
    console.log(record.a);
`),
        /Object\.defineProperties needs distinct literal property keys without spreads, methods or accessors\./,
    );
});

test("a view's conditional spread natively derives the set its test selects, and a later definition derives from it", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const { compiled, cpp } = compileShaderMaterialFixture(
        conditionalSpreadSource(conditionalSpread),
    );
    const views = new FactoryLowerer(
        new LoweringContext(),
    ).lowerNoColorMaterialViews(false, false, false, false, true).source;
    // The generated definition statements, run as the program runs them.
    const statements = compiled.cpp.match(
        /if \(v_lifted\) \{[\s\S]*?\} else \{[\s\S]*?\}\s*bbl::derive_shader_material_view\(v_engine, v_view, bblscene::derived_shader_variant_(\d+)\(.*\);/,
    );
    assert.ok(statements, "the spread's selection and the later definition");
    const programs = compiled.manifest.customShaderPrograms;
    const table = cppFunction(
        compiled.cpp,
        `inline std::uint32_t derived_shader_variant_${statements[1]!}(`,
    );
    // The depth-only program derived from each set's, the lifted set first.
    const drawn = (from: string): string => {
        const id = programs.findIndex((candidate) => candidate.name === from);
        const to = table.match(new RegExp(`case ${id}u: return (\\d+)u;`))?.[1];
        assert.ok(to, from);
        return programs[Number(to)]!.name;
    };
    assert.match(
        program(compiled, "ground-1").vertexSource,
        /2\.0\); return o;/,
    );
    runGeneratedProgram(
        native,
        "shader-material-views/conditional-spread",
        `
${cpp}
#include <cstdio>
namespace bbl {
namespace {
${cppFunction(views, "MaterialHandle create_no_color_material_view(")}
}
${cppFunction(views, "MaterialHandle create_shader_material_view(")}
${cppFunction(views, "void derive_shader_material_view(")}
${cppFunction(views, "std::uint32_t shader_material_view_variant(")}
}
namespace bblscene {
${table}
}
int main(){
    bbl::Engine v_engine;
    const auto ground = bbl::create_shader_material(v_engine, ${programs.findIndex((candidate) => candidate.name === "ground")}u);
    for (const bool v_lifted : {true, false}) {
        const auto v_view = bbl::create_shader_material_view(v_engine, ground);
        ${statements[0]}
        const auto& record = bbl::handle_at(v_engine.materials, v_view);
        std::printf("%s ", bbl::upstream::shader_variant_info(record.shader_variant).name);
    }
}
`,
        { expectedOutput: `${drawn("ground-1")} ${drawn("ground-2")} ` },
    );
});

const runtimeSource = (count: number): string => `${prelude}
    import type { Mesh } from "@babylonjs/lite";
    function fields(material: ShaderMaterial): number {
        return material.samplerDecls.length * 1000 + material.fragmentSource.length;
    }
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const mesh = (material: ShaderMaterial): Mesh => {
            const made = createMeshFromData(engine, "tri", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2]));
            made.material = material;
            addToScene(scene, made);
            return made;
        };
        const registry = { add(target: Mesh): number { return fields(target.material as ShaderMaterial); } };
        const early = mesh(createShaderMaterial({ name: "early", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${surface("vec3<f32>(1.0)")}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world"], samplers: ["a"] }));
        console.log(registry.add(early));
        ${Array.from(
            { length: count },
            (_, index) =>
                `console.log(registry.add(mesh(createShaderMaterial({ name: "late${index}", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${surface("vec3<f32>(${index}.5)")}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world"] }))));`,
        ).join("\n        ")}
    }
    void main();
`;

test("a call reading a run-time ShaderMaterial's fields compiles once per variant the program creates, later creations included", () => {
    const compiled = compileSource(runtimeSource(1));
    const programs = compiled.manifest.customShaderPrograms;
    const early = programs.findIndex(({ name }) => name === "early");
    const late = programs.findIndex(({ name }) => name === "late0");
    // Each arm reads its variant's fields at generation.
    const length = (name: string): number =>
        programs.find((program) => program.name === name)!.fragmentSource
            .length;
    for (const [samplers, name] of [
        [1, "early"],
        [0, "late0"],
    ] as const)
        assert.ok(
            compiled.cpp.includes(
                `= ((${samplers}.0 * 1000.0) + ${length(name)}.0);`,
            ),
            name,
        );
    // The arm is the one the material's run-time variant selects.
    const site = compiled.cpp.match(
        /const std::uint32_t (\w+) = bblscene::derived_shader_variant_(\d+)\(bbl::shader_material_variant\(/,
    );
    assert.ok(site, "variant arm selection");
    const table = cppFunction(
        compiled.cpp,
        `inline std::uint32_t derived_shader_variant_${site[2]}(`,
    );
    assert.match(table, new RegExp(`case ${early}u: return 0u;`));
    assert.match(table, new RegExp(`case ${late}u: return 1u;`));
    assert.ok(compiled.cpp.includes(`if (${site[1]} == 0u) {`));
});

const unshadedSource = (late: boolean): string => `${prelude}
    import { createStandardMaterial } from "@babylonjs/lite";
    import type { Mesh } from "@babylonjs/lite";
    function fields(material: ShaderMaterial): number {
        return material.samplerDecls.length * 1000 + material.fragmentSource.length;
    }
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const made = createMeshFromData(engine, "tri", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2]));
        made.material = createStandardMaterial();
        addToScene(createSceneContext(engine), made);
        const registry = { add(target: Mesh): number { return fields(target.material as ShaderMaterial); } };
        console.log(registry.add(made));
        ${late ? `made.material = createShaderMaterial({ name: "late", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${surface("vec3<f32>(1.0)")}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world"] }); console.log(registry.add(made));` : ""}
    }
    void main();
`;

test("a call reading a run-time ShaderMaterial's fields before any creation takes the arms of the later ones, and refuses where the program creates none", () => {
    const table = (compiled: ReturnType<typeof compileSource>): string => {
        const site = compiled.cpp.match(
            /= bblscene::derived_shader_variant_(\d+)\(bbl::shader_material_variant\(/,
        );
        assert.ok(site, "variant arm selection");
        return cppFunction(
            compiled.cpp,
            `inline std::uint32_t derived_shader_variant_${site[1]}(`,
        );
    };
    // With no variant at all the call's own refusal stands, naming the
    // variants it would compile once per.
    assert.throws(
        () => compileSource(unshadedSource(false)),
        /'material\.samplerDecls' reads a ShaderMaterial's 'samplerDecls', which its shader variant decides; this material's variant is decided at run time\. The call compiles once per outcome of the shader variants the program creates, and it creates none: target\.material as ShaderMaterial\./,
    );
    const compiled = compileSource(unshadedSource(true));
    const late = compiled.manifest.customShaderPrograms.findIndex(
        ({ name }) => name === "late",
    );
    assert.match(table(compiled), new RegExp(`case ${late}u: return 0u;`));
});

test("a method no call reaches that views a run-time ShaderMaterial and reads its vertex source refuses where the program creates no ShaderMaterial", () => {
    const source = (creates: boolean): string => `${prelude}
    import { createStandardMaterial } from "@babylonjs/lite";
    import type { MaterialView, Mesh } from "@babylonjs/lite";
    const geometries = new WeakMap<ShaderMaterial, { readonly source: string }>();
    function view(source: ShaderMaterial): ShaderMaterial & MaterialView {
        const derived = createMaterialView(source, { features: 0 }) as ShaderMaterial & MaterialView;
        const vertexSource = geometries.get(source)?.source ?? source.vertexSource;
        console.log(vertexSource.length);
        return derived;
    }
    function createNormalSource(): { register(mesh: Mesh): void } {
        const views = new Map<ShaderMaterial, ShaderMaterial & MaterialView>();
        return {
            register(mesh: Mesh): void {
                if (!mesh.material) return;
                const source = mesh.material as ShaderMaterial;
                if (!views.has(source)) views.set(source, view(source));
            },
        };
    }
    function setup(normals: { register(mesh: Mesh): void }, mesh: Mesh): void {
        const held = { normals };
        if (Math.random() > 2) held.normals.register(mesh);
    }
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const mesh = createMeshFromData(engine, "tri", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2]));
        mesh.material = createStandardMaterial();
        addToScene(createSceneContext(engine), mesh);
        ${creates ? `createShaderMaterial(${groundOptions});` : ""}
        setup(createNormalSource(), mesh);
    }
    void main();
`;
    assert.throws(
        () => compileSource(source(false)),
        /input\.ts:\d+:\d+: 'source\.vertexSource' reads a ShaderMaterial's 'vertexSource', which its shader variant decides; this material's variant is decided at run time\. The call compiles once per outcome of the shader variants the program creates, and it creates none: source\./,
    );
    // A creation gives the call its arm.
    assert.ok(
        compileSource(source(true)).cpp.includes("derived_shader_variant_"),
    );
});

test("a run-time ShaderMaterial split refuses past its arm bound", () => {
    assert.throws(
        () => compileSource(runtimeSource(81)),
        /compiles once per outcome of run-time tests in at most 81 arms; its tests make 82: target\.material as ShaderMaterial/,
    );
});

test("a ShaderMaterial field built from an option the run time decides refuses, naming the variant", () => {
    const tinted = (uniform: string, read: string): string => `${prelude}
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const lanes: [number, number, number] = [Math.random(), 0.5, 0.25];
        lanes[1] = 0.75;
        const tinted = createShaderMaterial({ name: "tinted", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${surface("vec3<f32>(1.0)")}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world", ${uniform}] });
        draw(engine, tinted);
        draw(engine, createShaderMaterial({ name: String(${read}), vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${surface("vec3<f32>(1.0)")}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world"] }));
    }
    void main();
`;
    // A run-time name decides the field, and the material it would name.
    assert.throws(
        () =>
            compileSource(
                tinted(
                    `{ name: Math.random() > 0.5 ? "uA" : "uB", type: "f32" }`,
                    "tinted.uniformDecls.length",
                ),
            ),
        /input\.ts:\d+:\d+: Expected a string literal\./,
    );
});

/**
 * A material whose `uTint` default is an array the program writes after the
 * creation: the pin's `uniformDecls` holds that array, the material only the
 * numbers it had.
 */
const sharedDefaultSource = (body: string): string => `${prelude}
    import { setShaderUniform } from "@babylonjs/lite";
    import type { ShaderUniformDecl } from "@babylonjs/lite";
    const CARVE_MAP: [number, number, number, number] = [-64, -64, 1 / 128, 4];
    const CARVE: ShaderUniformDecl = { name: "uCarve", type: "vec4<f32>", defaultValue: CARVE_MAP };
    function hasDecl<T extends { name: string }>(decls: readonly T[], name: string): boolean {
        return decls.some((decl) => decl.name === name);
    }
    function withDecl<T extends { name: string }>(decls: readonly T[], decl: T): T[] {
        return hasDecl(decls, decl.name) ? [...decls] : [...decls, decl];
    }
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const lanes: [number, number, number] = [Math.random(), 0.5, 0.25];
        lanes[1] = 0.75;
        const tinted = createShaderMaterial({ name: "tinted", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${surface("shaderUniforms.uTint")}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world", { name: "uTint", type: "vec3<f32>", defaultValue: lanes }] });
        draw(engine, tinted);
        const decl = tinted.uniformDecls[2]!;
        const leaf = decl.defaultValue as readonly number[];
        const mesh = createMeshFromData(engine, "probe", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2]));
        ${body}
    }
    void main();
`;

const sharedDefaultRefusal =
    /'tinted\.uniformDecls' reads a ShaderMaterial's 'defaultValue' of uniform 'uTint', the array its creation was given, which the program may change after the creation \('lanes': .*\); the material keeps only that array's numbers at its creation\./;

/** That compiling `body` refuses with `sharedDefaultRefusal` on the line of `read`. */
function refusesAtRead(body: string, read = body): void {
    const source = sharedDefaultSource(body);
    const at = source.split("\n").findIndex((text) => text.includes(read)) + 1;
    assert.throws(
        () => compileSource(source),
        (error: unknown) =>
            error instanceof Error &&
            error.message.startsWith(`input.ts:${at}:`) &&
            sharedDefaultRefusal.test(error.message),
        body,
    );
}

test("a ShaderMaterial default the program may change passes on with the declarations holding it", () => {
    const compiled = compileSource(
        sharedDefaultSource(`
        // Spread, rebuilt and searched by a helper, the declarations keep
        // the default without reading it.
        const decls = withDecl(withDecl(tinted.uniformDecls, CARVE), { name: "uTint", type: "vec3<f32>" });        const copy = { ...decl };
        const spread = [...tinted.uniformDecls];
        mesh.position.x = decls.length;
        mesh.position.y = hasDecl(decls, "uCarve") && decls[2]!.name === copy.name && spread.length === 3 ? 1 : 0;
        // What any array answers folds.
        mesh.name = typeof (copy.defaultValue ?? 0);
        mesh.position.z = decl.defaultValue && decl.defaultValue !== undefined ? 1 : 0;
        if (!leaf) throw new Error("absent");
    `),
    );
    assert.match(compiled.cpp, /\.position\.x = 4\.0;/);
    assert.match(compiled.cpp, /\.position\.y = 1\.0;/);
    assert.match(compiled.cpp, /\.name = "object";/);
    assert.match(compiled.cpp, /\.position\.z = 1\.0;/);
    assert.doesNotMatch(compiled.cpp, /shader_uniform_creation_lane/);
});

test("each read of a ShaderMaterial default the program may change refuses at the read", () => {
    for (const read of [
        // Its members, elements and methods.
        "mesh.position.x = leaf.length;",
        "mesh.position.x = leaf[0]!;",
        "mesh.position.x = leaf.map((lane) => lane * 2).length;",
        "mesh.position.x = (decl.defaultValue as number[] | undefined)?.length ?? 0;",
        "const copy = { ...decl }; mesh.position.x = (copy.defaultValue as number[]).length;",
        // Its iteration and spread.
        "for (const lane of leaf) mesh.position.x += lane;",
        "mesh.position.x = [...leaf].length;",
        "mesh.position.x = Math.max(...leaf);",
        "const [first] = leaf; mesh.position.x = first!;",
        // Native storage, a library call, a pinned call.
        "const kept: (readonly number[])[] = []; kept.push(leaf); mesh.position.x = kept.length;",
        "let held: readonly number[] = lanes; held = leaf; mesh.position.x = held.length;",
        "const picked = Math.random() > 0.5 ? leaf : lanes; mesh.position.x = picked.length;",
        "mesh.position.x = Float32Array.from(leaf).length;",
        'setShaderUniform(tinted, "uTint", leaf);',
        // Its identity.
        "mesh.position.x = leaf === lanes ? 1 : 2;",
        "mesh.position.x = [lanes as readonly number[]].includes(leaf) ? 1 : 2;",
        "const keyed = new Map<readonly number[], number>(); keyed.set(leaf, 1); mesh.position.x = keyed.size;",
        // A conversion.
        'mesh.name = "tint " + leaf;',
        "mesh.name = `tint ${leaf}`;",
        "mesh.position.x = +(leaf as unknown as number);",
    ])
        refusesAtRead(read);
});

test("a ShaderMaterial created from declarations holding a default the program may change reads it, and refuses", () => {
    const created = (uniforms: string): string =>
        `draw(engine, createShaderMaterial({ name: "copy", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${surface("vec3<f32>(1.0)")}\`, attributes: ["position"], uniforms: ${uniforms} }));`;
    for (const uniforms of [
        "tinted.uniformDecls",
        "[...tinted.uniformDecls]",
        'withDecl(tinted.uniformDecls, { name: "uCarve", type: "f32" })',
        "[decl]",
        '[{ name: "uCopy", type: "vec3<f32>", defaultValue: decl.defaultValue }]',
    ])
        refusesAtRead(created(uniforms));
});

test("a ShaderMaterial view's program takes no defaults, so declarations it is given are not read", () => {
    const viewed = (definition: string, read = ""): string => `
        const view = createMaterialView(tinted, { features: 0 }) as ShaderMaterial;
        ${definition}
        draw(engine, view);
        ${read}`;
    const defined = (value: string): string =>
        `Object.defineProperties(view, { fragmentSource: { value: wgsl\`\${NORMAL}\`, configurable: true }, uniformDecls: { value: ${value}, configurable: true } });`;
    const compiled = compileSource(
        sharedDefaultSource(
            viewed(
                `const decls = withDecl(tinted.uniformDecls, { name: "uTint", type: "vec3<f32>" });
        ${defined("decls")}`,
            ),
        ),
    );
    const view = program(compiled, "tinted-1");
    assert.match(view.fragmentSource, /normalize\(cross\(dpdx/);
    assert.deepEqual(view.uniforms, program(compiled, "tinted").uniforms);
    assert.deepEqual(view.uniformDefaults, []);
    assert.match(compiled.cpp, /bbl::derive_shader_material_view\(/);
    // The view's field holds what it was given: the source's default, and
    // one the run time decides, whose reads refuse.
    const readBack =
        "mesh.position.x = (view.uniformDecls[2]!.defaultValue as number[]).length;";
    refusesAtRead(
        viewed(defined("[...tinted.uniformDecls]"), readBack),
        readBack,
    );
    assert.throws(
        () =>
            compileSource(
                sharedDefaultSource(
                    viewed(
                        defined(
                            '[tinted.uniformDecls[0]!, tinted.uniformDecls[1]!, { name: "uTint", type: "vec3<f32>", defaultValue: [lanes[0], 0, 0] }]',
                        ),
                        readBack,
                    ),
                ),
            ),
        /input\.ts:\d+:\d+: '\[tinted\.uniformDecls\[0\]!, .*\]' gives a ShaderMaterial view's 'uniformDecls' a 'defaultValue' of 'uTint' the run time decides; a view's program takes none, so generation keeps none to read\./,
    );
    // A leaf the program reads still refuses.
    assert.throws(
        () =>
            compileSource(
                sharedDefaultSource(
                    viewed(
                        defined(
                            '[tinted.uniformDecls[0]!, tinted.uniformDecls[1]!, { name: "uTint", type: leaf as unknown as string }]',
                        ),
                    ),
                ),
            ),
        sharedDefaultRefusal,
    );
});

const viewOwnSlotsRefusal =
    /input\.ts:\d+:\d+: A ShaderMaterial view keeps its source's slots; its redefinitions \(fragmentSource, uniformDecls\) declare other uniforms, samplers or storage buffers than shader variant 'tinted', which slots of the view's own would hold: the same definition gives the view the slot maps holding them\./;

test("a descriptor stores a view's declaration list in the target property's type, independently of unrelated identity uses", () => {
    for (const definition of [
        `Object.defineProperties(view, { fragmentSource: { value: wgsl\`\${NORMAL}\`, configurable: true }, uniformDecls: { value: decls, configurable: true } });`,
        `Object.defineProperties(view, { "fragmentSource": { value: wgsl\`\${NORMAL}\`, configurable: true }, "uniformDecls": { "value": decls, configurable: true } });`,
        `Object.defineProperty(view, "uniformDecls", { value: decls, configurable: true });`,
    ]) {
        const source = sharedDefaultSource(`
        const a: readonly number[] = [1, 2];
        const b: readonly number[] = [3, 4];
        mesh.position.x = a === b ? 1 : 2;
        const view = createMaterialView(tinted, { features: 0 }) as ShaderMaterial;
        const decls = withDecl(withDecl(tinted.uniformDecls, CARVE), { name: "uWater", type: "f32" });
        ${definition}
        draw(engine, view);
        `);
        assert.throws(
            () => compileSource(source),
            /A ShaderMaterial view keeps its source's slots;.*which slots of the view's own would hold/,
            definition,
        );
    }
});

test("a ShaderMaterial view's declarations a helper adds a module constant declaration to are known at generation", () => {
    // The helper's read-only parameter keeps the constant's fields and own
    // keys while the helper stores it in the list.
    const source = sharedDefaultSource(`
        const view = createMaterialView(tinted, { features: 0 }) as ShaderMaterial;
        const decls = withDecl(tinted.uniformDecls, WATER);
        Object.defineProperties(view, { fragmentSource: { value: wgsl\`\${NORMAL}\`, configurable: true }, uniformDecls: { value: decls, configurable: true } });
        draw(engine, view);
    `).replace(
        "async function main",
        'const WATER: ShaderUniformDecl = { name: "uWater", type: "vec4<f32>" };\n    async function main',
    );
    assert.throws(() => compileSource(source), viewOwnSlotsRefusal);
});

test("a ShaderMaterial view's declarations a helper adds a module constant declaration with a literal default array to are known at generation", () => {
    // The helper's read-only parameter keeps the constant's fields, its
    // default array included, while the helper stores it in the list.
    const source = sharedDefaultSource(`
        const view = createMaterialView(tinted, { features: 0 }) as ShaderMaterial;
        Object.defineProperties(view, { fragmentSource: { value: wgsl\`\${NORMAL}\`, configurable: true }, uniformDecls: { value: withDecl(tinted.uniformDecls, WATER), configurable: true } });
        draw(engine, view);
    `).replace(
        "async function main",
        'const WATER: ShaderUniformDecl = { name: "uWater", type: "vec4<f32>", defaultValue: [0, 0, 0, 0] };\n    async function main',
    );
    assert.throws(() => compileSource(source), viewOwnSlotsRefusal);
});

test("a ShaderMaterial view's declarations a helper adds a module constant declaration defaulting to a constant array to are known at generation", () => {
    // Every reference to `CARVE_MAP` hands it on as a readonly array, so no
    // write reaches it and `CARVE` keeps its lanes.
    const withCarve = (after: string): string =>
        sharedDefaultSource(`
        const view = createMaterialView(tinted, { features: 0 }) as ShaderMaterial;
        Object.defineProperties(view, { fragmentSource: { value: wgsl\`\${NORMAL}\`, configurable: true }, uniformDecls: { value: withDecl(tinted.uniformDecls, CARVE), configurable: true } });
        draw(engine, view);
        ${after}
    `);
    assert.throws(() => compileSource(withCarve("")), viewOwnSlotsRefusal);
    // A write the program makes, or a mutable view it hands the array to,
    // leaves its lanes to the run time.
    for (const after of [
        "CARVE_MAP[0] = 0;",
        "const held: number[] = CARVE_MAP; mesh.position.x = held.length;",
    ])
        assert.throws(
            () => compileSource(withCarve(after)),
            /input\.ts:\d+:\d+: A ShaderMaterial view's 'uniformDecls' compiles into its program at generation; this value is decided at run time\./,
            after,
        );
});

test("a ShaderMaterial view's declarations a helper adds to a material's own readable declarations are known at generation", () => {
    // The helper's search folds over the declarations, and its spread of
    // them is a list generation holds, as `[a, b]` is.
    const withView = (uniformDecls: string, source = "plain"): string =>
        sharedDefaultSource(`
        const plain = createShaderMaterial({ name: "plain", vertexSource: wgsl\`\${VERT.replace("1.0)).xyz", "2.0)).xyz")}\`, fragmentSource: wgsl\`\${surface("vec3<f32>(1.0)")}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world"] });
        draw(engine, plain);
        const chosen = Math.random() > 0.5 ? tinted : plain;
        draw(engine, viewOf(${source}));
    `).replace(
            "async function main",
            `const WATER: ShaderUniformDecl = { name: "uWater", type: "vec4<f32>", defaultValue: [0, 0, 0, 0] };
    function viewOf(source: ShaderMaterial): ShaderMaterial {
        const view = createMaterialView(source, { features: 0 }) as ShaderMaterial;
        const uniformDecls = ${uniformDecls};
        Object.defineProperties(view, { fragmentSource: { value: wgsl\`\${NORMAL}\`, configurable: true }, uniformDecls: { value: uniformDecls, configurable: true } });
        return view;
    }
    async function main`,
        );
    const plainSlotsRefusal =
        /input\.ts:\d+:\d+: A ShaderMaterial view keeps its source's slots; its redefinitions \(fragmentSource, uniformDecls\) declare other uniforms, samplers or storage buffers than shader variant 'plain'/;
    for (const [uniformDecls, source] of [
        ["withDecl(source.uniformDecls, WATER)", "plain"],
        ["withDecl(withDecl(source.uniformDecls, CARVE), WATER)", "plain"],
        // Each material the run time may pass is viewed on its own.
        ["withDecl(withDecl(source.uniformDecls, CARVE), WATER)", "chosen"],
    ] as const)
        assert.throws(
            () => compileSource(withView(uniformDecls, source)),
            plainSlotsRefusal,
            `${source}: ${uniformDecls}`,
        );
});

const runtimeDefaultsSource = `${prelude}
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const tint = Date.now() > 0 ? 0.1 : 0.2;
        const tinted = createShaderMaterial({ name: "tinted", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${surface("vec3<f32>(shaderUniforms.uTint)")}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world", { name: "uTint", type: "f32", defaultValue: tint }, { name: "uMix", type: "vec4<f32>", defaultValue: [tint, 0.5, tint * 3, 1] }, { name: "uFresh", type: "vec2<f32>", defaultValue: [...[tint, 0.25]] }] });
        draw(engine, tinted);
        // The declarations' names and types are the pin's; their run-time
        // defaults are the numbers the creation was given.
        const decls = tinted.uniformDecls;
        const mix = decls[3]!.defaultValue as readonly number[];
        const fresh = decls[4]!.defaultValue as readonly number[];
        const named = createShaderMaterial({ name: decls.length === 5 && decls[1]!.type === "mat4x4<f32>" && decls[3]!.name === "uMix" && decls[3]!.type === "vec4<f32>" && decls[4]!.name === "uFresh" && fresh.length === 2 ? "named" : "unnamed", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${surface("vec3<f32>(shaderUniforms.uCopy.xyz)")}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world", { name: "uCopy", type: "vec4<f32>", defaultValue: [decls[2]!.defaultValue as number, mix[1]!, mix[2]!, fresh[0]!] }] });
        draw(engine, named);
    }
    void main();
`;

test("a ShaderMaterial view over a material of run-time defaults compiles its program without them", () => {
    const compiled = compileSource(
        runtimeDefaultsSource.replace(
            "draw(engine, named);",
            `draw(engine, named);
        const view = createMaterialView(tinted, { features: 0 }) as ShaderMaterial;
        Object.defineProperty(view, "fragmentSource", { value: wgsl\`\${NORMAL}\`, configurable: true });
        draw(engine, view);
        // The view's field keeps its source's defaults, read from the view.
        draw(engine, createShaderMaterial({ name: "back", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${surface("vec3<f32>(shaderUniforms.uBack)")}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world", { name: "uBack", type: "f32", defaultValue: view.uniformDecls[2]!.defaultValue as number }] }));`,
        ),
    );
    const view = program(compiled, "tinted-1");
    assert.deepEqual(view.uniforms, program(compiled, "tinted").uniforms);
    assert.deepEqual(view.uniformDefaults, []);
    assert.match(
        compiled.cpp,
        /auto (\w+) = bbl::create_shader_material_view\([\s\S]*bbl::shader_uniform_creation_lane\(\w+, \1, 0u, 0u\)/,
    );
});

test("a ShaderMaterial's uniformDecls holds the names and types the pin builds, its run-time defaults read from the numbers its creation kept", () => {
    const compiled = compileSource(runtimeDefaultsSource);
    program(compiled, "named");
    const escaped = (text: string): string =>
        text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The creation keeps each run-time default's own numbers, as doubles.
    const kept = (offset: number, values: readonly string[]): RegExp =>
        new RegExp(
            `const std::array<double, ${values.length}> values\\{${values.join(", ")}\\}; bbl::initialize_shader_uniform_creation_values\\(\\w+, \\w+, ${offset}u, ${values.length}u, values\\.data\\(\\)\\);`,
        );
    assert.match(compiled.cpp, kept(0, ["v_tint"]));
    assert.match(
        compiled.cpp,
        kept(1, ["v_tint", "0\\.5", escaped("(v_tint * 3.0)"), "1\\.0"]),
    );
    assert.match(compiled.cpp, kept(5, ["v_tint", "0\\.25"]));
    // A default the run time decides reads the material's lanes; a static
    // one stays generation's.
    const lane = (offset: number, index: number): string =>
        escaped(`bbl::shader_uniform_creation_lane(`) +
        `\\w+, \\w+, ${offset}u, ${index}u\\)`;
    assert.match(
        compiled.cpp,
        kept(0, [lane(0, 0), "0\\.5", lane(1, 2), lane(5, 0)]),
    );
});

test("only a program whose creations keep run-time defaults defines the creation-lane functions", () => {
    const feature = "material:shader-uniform-creation-lanes";
    assert.ok(
        compileSource(runtimeDefaultsSource).manifest.features.includes(
            feature,
        ),
    );
    assert.ok(
        !compileSource(variantsSource).manifest.features.includes(feature),
    );
    const factory = (creationLanes: boolean): string =>
        new FactoryLowerer(new LoweringContext()).lowerShaderMaterialFactory({
            creationLanes,
        }).source;
    for (const name of [
        "initialize_shader_uniform_creation_values(",
        "shader_uniform_creation_lane(",
    ]) {
        assert.ok(factory(true).includes(name), name);
        assert.ok(!factory(false).includes(name), name);
    }
});

test("a ShaderMaterial natively keeps a run-time default's own numbers beside the floats it draws with, and a view reads its source's", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const { compiled, cpp } = compileShaderMaterialFixture(
        runtimeDefaultsSource,
    );
    const views = new FactoryLowerer(
        new LoweringContext(),
    ).lowerNoColorMaterialViews(false, false, false, false, true).source;
    const tinted = compiled.manifest.customShaderPrograms.findIndex(
        (candidate) => candidate.name === "tinted",
    );
    runGeneratedProgram(
        native,
        "shader-material-views/creation-lanes",
        `
${cpp}
#include <algorithm>
#include <array>
#include <cstdio>
namespace bbl {
namespace {
${cppFunction(views, "MaterialHandle create_no_color_material_view(")}
}
${cppFunction(views, "MaterialHandle create_shader_material_view(")}
}
int main(){
    bbl::Engine engine;
    const auto material = bbl::create_shader_material(engine, ${tinted}u);
    const std::array<double, 4> mix{0.1, 0.5, 0.30000000000000004, 1.0};
    bbl::initialize_shader_uniform_creation_values(engine, material, 1u, 4u, mix.data());
    const auto view = bbl::create_shader_material_view(engine, material);
    const auto& slots = bbl::shader_material(engine, material).shader_uniforms->slots;
    const auto& slot = *std::find_if(slots.begin(), slots.end(), [](const bbl::ShaderUniformSlot& candidate) { return candidate.offset == 1u; });
    // The doubles the creation was given, and the floats the uniform draws with.
    std::printf("%.17g %.17g %.9g ", bbl::shader_uniform_creation_lane(engine, material, 1u, 0u), bbl::shader_uniform_creation_lane(engine, view, 1u, 2u), static_cast<double>(slot.value.load(0u)));
    try {
        static_cast<void>(bbl::shader_uniform_creation_lane(engine, material, 0u, 0u));
    } catch (const std::runtime_error& error) {
        std::printf("%s", error.what());
    }
}
`,
        {
            expectedOutput:
                "0.10000000000000001 0.30000000000000004 0.100000001 A shader uniform's creation default is absent.",
        },
    );
});

const slotTablesSource = `${prelude}
    async function main(): Promise<void> {
        const engine = await createEngine({});
        draw(engine, createShaderMaterial(${groundOptions}));
        draw(engine, createShaderMaterial({ name: "wider", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${surface("shaderUniforms.uTint + shaderUniforms.uExtra.xyz")}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world", { name: "uExtra", type: "vec4<f32>", defaultValue: [4, 3, 2, 1] }, { name: "uTint", type: "vec3<f32>" }], samplers: ["carve", "albedo"], storageBuffers: [{ name: "extra", type: "array<vec4<f32>>" }, { name: "points", type: "array<vec4<f32>>" }] }));
        draw(engine, createShaderMaterial({ name: "clash", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${surface("shaderUniforms.uTint.xyz")}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world", { name: "uTint", type: "vec4<f32>" }] }));
        draw(engine, createShaderMaterial({ name: "screen", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`@fragment fn mainFragment(@location(0) vWorldPos: vec3<f32>) -> @location(0) vec4<f32> { return textureSampleBaseClampToEdge(frame, frameSampler, vWorldPos.xy); }\`, attributes: ["position"], uniforms: ["worldViewProjection", "world"], externalTextures: ["frame"] }));
    }
    void main();
`;

test("a view's slots natively alias its source's by name, the names only its variant declares are its own, and its uploads follow both", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const { compiled, cpp } = compileShaderMaterialFixture(slotTablesSource);
    const views = new FactoryLowerer(
        new LoweringContext(),
    ).lowerNoColorMaterialViews(false, false, false, false, true).source;
    const id = (name: string): number =>
        compiled.manifest.customShaderPrograms.findIndex(
            (candidate) => candidate.name === name,
        );
    runGeneratedProgram(
        native,
        "shader-material-views/slot-tables",
        `
${cpp}
#include <array>
#include <cstdio>
namespace bbl {
namespace {
${cppFunction(views, "MaterialHandle create_no_color_material_view(")}
}
${cppFunction(views, "MaterialHandle create_shader_material_view(")}
${cppFunction(views, "void derive_shader_material_view(")}
}
int main(){
    using bbl::ShaderDeclarationList;
    bbl::Engine engine;
    const auto source = bbl::create_shader_material(engine, ${id("ground")}u);
    bbl::handle_at(engine.materials, source).shader_textures.resize(2);
    bbl::handle_at(engine.materials, source).shader_storage_buffers = {bbl::StorageBufferHandle{5}};
    const auto view = bbl::create_shader_material_view(engine, source);
    const auto where = [&](ShaderDeclarationList list, std::uint32_t slot) {
        const auto owner = bbl::shader_slot_owner(engine, bbl::handle_at(engine.materials, view), list, slot);
        std::printf("%s%u ", &owner.material == &bbl::handle_at(engine.materials, source) ? "source" : "own", owner.slot);
    };
    // A new view aliases each slot of its source.
    where(ShaderDeclarationList::samplers, 0); where(ShaderDeclarationList::samplers, 1); where(ShaderDeclarationList::storage_buffers, 0);
    bbl::derive_shader_material_view(engine, view, ${id("wider")}u, false);
    // carve and extra are the view's own; albedo and points stay its source's.
    where(ShaderDeclarationList::samplers, 0); where(ShaderDeclarationList::samplers, 1);
    where(ShaderDeclarationList::storage_buffers, 0); where(ShaderDeclarationList::storage_buffers, 1);
    try { where(ShaderDeclarationList::samplers, 2); } catch (const std::runtime_error& error) { std::printf("| %s | ", error.what()); }
    auto& own = bbl::handle_at(engine.materials, view);
    auto& from = bbl::handle_at(engine.materials, source);
    const auto version = [&] { return bbl::shader_slot_version(engine, own, &bbl::MaterialRecord::shader_texture_version); };
    const auto before = version();
    ++from.shader_texture_version;
    const auto followed = version();
    ++own.shader_texture_version;
    std::printf("%d%d ", followed > before ? 1 : 0, version() > followed ? 1 : 0);
    const auto offset = [](std::uint32_t variant, const char* name) {
        for (const auto& slot : bbl::upstream::shader_variant_info(variant).uniform_slots)
            if (std::string_view(slot.name) == name) return slot.offset;
        throw std::runtime_error("no uniform");
    };
    // uTint is the source's slot at the view's offset; uExtra the view's own default.
    const auto uniforms = [&] {
        const auto& values = bbl::shader_uniform_render_values(own);
        for (const char* name : {"uTint", "uExtra"})
            for (std::uint32_t lane = 0; lane < (name[1] == 'T' ? 3u : 4u); ++lane)
                std::printf("%g,", static_cast<double>(values.at(offset(${id("wider")}u, name) + lane)));
        std::printf(" ");
    };
    bbl::set_shader_uniform(engine, source, "uTint", std::array<double, 3>{0.0, 1.0, 0.0});
    uniforms();
    bbl::set_shader_uniform(engine, source, "uTint", std::array<double, 3>{0.5, 0.0, 1.0});
    uniforms();
    const auto clash = bbl::create_shader_material_view(engine, source);
    try { bbl::derive_shader_material_view(engine, clash, ${id("clash")}u, false); } catch (const std::runtime_error& error) { std::printf("| %s", error.what()); }
}
`,
        {
            expectedOutput:
                "source0 source1 source0 own0 source0 own0 source0 | A shader view's table does not hold the slot its variant declares. | 11 0,1,0,4,3,2,1, 0.5,0,1,4,3,2,1, | A ShaderMaterial view declares uniform 'uTint' as vec4<f32>; the slot it reads holds vec3<f32>.",
        },
    );
});

test("setters on a view natively write the slot its table names, by name, and move the view's own versions", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const { compiled, cpp } = compileShaderMaterialFixture(slotTablesSource);
    const context = new LoweringContext();
    const factory = new FactoryLowerer(context).lowerShaderMaterialFactory({
        views: true,
    }).source;
    const views = new FactoryLowerer(context).lowerNoColorMaterialViews(
        false,
        false,
        false,
        false,
        true,
    ).source;
    const external = lowerShaderExternalTextures(context).source;
    const id = (name: string): number =>
        compiled.manifest.customShaderPrograms.findIndex(
            (candidate) => candidate.name === name,
        );
    runGeneratedProgram(
        native,
        "shader-material-views/setters",
        `#include <bit>
#include <iterator>
#include <utility>
${cpp}
#include <array>
#include <cstdio>
namespace bbl {
namespace {
${cppFunction(views, "MaterialHandle create_no_color_material_view(")}
bool external_texture_resolvers_installed = false;
}
${cppFunction(views, "MaterialHandle create_shader_material_view(")}
${cppFunction(views, "void derive_shader_material_view(")}
${["void set_shader_texture(", "void set_shader_render_texture(", "void set_shader_storage_buffer(", "void set_shader_storage_buffer_by_name("].map((signature) => cppFunction(factory, signature)).join("\n")}
void set_shader_pixels_texture(Engine&, MaterialHandle, std::uint32_t, const PixelsTexture&) { throw std::runtime_error("no frame"); }
${["VideoHandle create_baked_video(int ready_state)", "ExternalTextureHandle create_external_texture(", "void set_shader_external_texture("].map((signature) => cppFunction(external, signature)).join("\n")}
${lowerShaderUniformRangeUpdates(context)}
}
int main(){
    bbl::Engine engine;
    engine.storage_buffers.resize(2);
    const auto source = bbl::create_shader_material(engine, ${id("ground")}u);
    const auto view = bbl::create_shader_material_view(engine, source);
    bbl::derive_shader_material_view(engine, view, ${id("wider")}u, false);
    const auto& from = bbl::handle_at(engine.materials, source);
    const auto& own = bbl::handle_at(engine.materials, view);
    const auto lanes = [&](bbl::MaterialHandle material, const char* name) {
        const auto values = std::get<bbl::js::F32Array>(bbl::get_shader_uniform(engine, material, name));
        for (std::size_t lane = 0; lane < values.size(); ++lane) std::printf("%g,", static_cast<double>(values.load(lane)));
        std::printf(" ");
    };
    // uTint is its source's slot: the view writes the source's value and moves its own version only.
    bbl::set_shader_uniform(engine, view, "uTint", std::array<double, 3>{0.25, 0.5, 0.75});
    lanes(source, "uTint");
    std::printf("%g %g ", from.shader_uniforms->version, own.shader_uniforms->version);
    // uExtra is the view's own.
    bbl::set_shader_uniform(engine, view, "uExtra", std::array<double, 4>{1.0, 2.0, 3.0, 4.0});
    lanes(view, "uExtra");
    try { lanes(source, "uExtra"); } catch (const std::runtime_error& error) { std::printf("| %s | ", error.what()); }
    // An offset the compiler resolved is the view's own variant's.
    for (const auto& slot : bbl::upstream::shader_variant_info(${id("wider")}u).uniform_slots)
        if (std::string_view(slot.name) == "uTint") bbl::set_shader_uniform_value(engine, view, slot.offset, 1.0f, 0.0f, 0.0f);
    lanes(source, "uTint");
    // albedo is its source's slot, carve the view's own.
    bbl::FileTexture albedo; albedo.identity = 7;
    bbl::set_shader_texture(engine, view, bbl::shader_texture_slot_by_name(engine, view, "albedo", false), albedo);
    bbl::FileTexture carve; carve.identity = 9;
    bbl::set_shader_texture(engine, view, bbl::shader_texture_slot_by_name(engine, view, "carve", false), carve);
    std::printf("%llu %llu %zu %zu %llu ", static_cast<unsigned long long>(from.shader_textures.at(0).identity), static_cast<unsigned long long>(own.shader_textures.at(0).identity), from.shader_textures.size(), own.shader_textures.size(), static_cast<unsigned long long>(from.shader_texture_version + from.shader_resource_version));
    // points is its source's slot, extra the view's own.
    bbl::set_shader_storage_buffer_by_name(engine, view, "points", bbl::StorageBufferHandle{1});
    bbl::set_shader_storage_buffer_by_name(engine, view, "extra", bbl::StorageBufferHandle{0});
    std::printf("%u %u %llu ", from.shader_storage_buffers.at(0).value, own.shader_storage_buffers.at(0).value, static_cast<unsigned long long>(from.shader_resource_version));
    // An external texture binds on the view's source (getMaterialSource).
    const auto screen = bbl::create_shader_material(engine, ${id("screen")}u);
    const auto shown = bbl::create_shader_material_view(engine, screen);
    const auto frame = bbl::create_external_texture(bbl::create_baked_video(4));
    bbl::set_shader_external_texture(engine, shown, 0u, frame);
    std::printf("%d %zu %llu ", bbl::handle_at(engine.materials, screen).shader_external_textures.at(0) == frame ? 1 : 0, bbl::handle_at(engine.materials, shown).shader_external_textures.size(), static_cast<unsigned long long>(bbl::handle_at(engine.materials, shown).shader_resource_version));
    bbl::Scene scene;
    scene.engine = &engine;
    try { bbl::enable_shader_uniform_range_updates(engine, scene, view); } catch (const std::runtime_error& error) { std::printf("| %s", error.what()); }
}
`,
        {
            expectedOutput: `0.25,0.5,0.75, 0 1 1,2,3,4, | ${pinnedError('ShaderMaterial: uniform "${a0}" was not declared.', { module: "src/material/shader/shader-material.ts", name: "getShaderUniform" })} | 1,0,0, 7 9 1 1 0 1 0 0 1 0 0 | enableShaderUniformRangeUpdates over a ShaderMaterial view is unsupported.`,
            flags: ["/DBBLITE_GPU_INSTANCING=0"],
        },
    );
});

/**
 * A view given its own slot maps, as a post-process view widens its
 * source: its source's slots copied by name into new Maps, a fallback
 * texture slot and a uniform slot of its own, and `new Map` of the
 * source's uniform values, defined with the declarations they hold.
 */
const slotMapsSource = `${prelude}
    import { createStorageBuffer, createTexture2DFromPixels, setShaderStorageBuffer, setShaderTexture, setShaderUniform } from "@babylonjs/lite";
    import type { ShaderSamplerDecl, ShaderUniformDecl, StorageBuffer, Texture2D } from "@babylonjs/lite";
    interface UniformSlot { decl: ShaderUniformDecl; value: Float32Array }
    interface TextureSlot { decl: ShaderSamplerDecl; current: Texture2D | null }
    interface StorageSlot { decl: { name: string; type: string }; current: StorageBuffer | null }
    type Internals = ShaderMaterial & { _textureSlots: Map<string, TextureSlot>; _storageBufferSlots: Map<string, StorageSlot>; _uniformValues: Map<string, UniformSlot> };
    const CARVE: ShaderSamplerDecl = { name: "carve", sampleType: "float" };
    const EXTRA: ShaderUniformDecl = { name: "uExtra", type: "vec4<f32>", defaultValue: [0, 0, 0, 0] };
    const SAMPLED = \`@fragment fn mainFragment(@location(0) vWorldPos: vec3<f32>) -> @location(0) vec4<f32> { return vec4<f32>(shaderUniforms.uTint, 1.0) + textureSample(albedo, albedoSampler, vWorldPos.xy) + points[0]; }\`;
    const WIDER = \`@fragment fn mainFragment(@location(0) vWorldPos: vec3<f32>) -> @location(0) vec4<f32> { return vec4<f32>(shaderUniforms.uTint, 1.0) + shaderUniforms.uExtra + textureSample(albedo, albedoSampler, vWorldPos.xy) + textureSample(carve, carveSampler, vWorldPos.xy) + points[0]; }\`;
    function widerView(source: ShaderMaterial, fallback: Texture2D): ShaderMaterial {
        const src = source as Internals;
        const view = createMaterialView(source, { features: 0 }) as ShaderMaterial;
        const storageBufferSlots = new Map<string, StorageSlot>();
        for (const decl of source.storageBufferDecls) {
            const slot = src._storageBufferSlots.get(decl.name);
            if (slot) storageBufferSlots.set(decl.name, slot);
        }
        const textureSlots = new Map<string, TextureSlot>();
        for (const decl of source.samplerDecls) {
            const slot = src._textureSlots.get(decl.name);
            if (slot) textureSlots.set(decl.name, slot);
        }
        if (!textureSlots.has("carve")) textureSlots.set("carve", { decl: CARVE, current: fallback });
        const uniformValues = new Map<string, UniformSlot>(src._uniformValues);
        if (!uniformValues.has("uExtra")) uniformValues.set("uExtra", { decl: EXTRA, value: Float32Array.from([1, 2, 3, 4]) });
        Object.defineProperties(view, {
            fragmentSource: { value: wgsl\`\${WIDER}\`, enumerable: true, configurable: true },
            samplerDecls: { value: [...source.samplerDecls, { name: "carve", sampleType: "float" }], enumerable: true, configurable: true },
            uniformDecls: { value: [...source.uniformDecls, { name: "uExtra", type: "vec4<f32>" }], enumerable: true, configurable: true },
            storageBufferDecls: { value: source.storageBufferDecls, enumerable: true, configurable: true },
            _textureSlots: { value: textureSlots, enumerable: true, configurable: true },
            _storageBufferSlots: { value: storageBufferSlots, enumerable: true, configurable: true },
            _uniformValues: { value: uniformValues, enumerable: true, configurable: true },
        });
        return view;
    }
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const base = createShaderMaterial({ name: "base", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${SAMPLED}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world", { name: "uTint", type: "vec3<f32>", defaultValue: [1, 0.5, 0.25] }], samplers: ["albedo"], storageBuffers: [{ name: "points", type: "array<vec4<f32>>" }] });
        const view = widerView(base, createTexture2DFromPixels(engine, new Uint8Array([255, 0, 0, 255]), 1, 1));
        // The view's copied slots follow what the source binds later.
        setShaderTexture(base, "albedo", createTexture2DFromPixels(engine, new Uint8Array([0, 255, 0, 255]), 1, 1));
        setShaderUniform(base, "uTint", [0, 1, 0]);
        setShaderStorageBuffer(base, "points", createStorageBuffer(engine, new Float32Array([0, 0, 0, 0])));
        draw(engine, view);
    }
    void main();
`;

test("a view given slot maps by its definition installs them: slots read from its source alias that source's, the others are its own", () => {
    const compiled = compileSource(slotMapsSource);
    const view = program(compiled, "base-1");
    assert.deepEqual(view.samplers, ["albedo", "carve"]);
    assert.ok(view.uniforms.some((uniform) => uniform.startsWith("uExtra:")));
    assert.ok(compiled.manifest.features.includes("material:shader-slot-maps"));
    // Each read is a new record per declaration, registered as its slot.
    assert.match(
        compiled.cpp,
        /bbl::register_shader_slot_read\(\w+, \w+, bbl::ShaderDeclarationList::samplers, 0u, \w+\.weak_identity\(\)\);/,
    );
    assert.match(
        compiled.cpp,
        /bbl::register_shader_slot_read\(\w+, \w+, bbl::ShaderDeclarationList::storage_buffers, 0u, \w+\.weak_identity\(\)\);/,
    );
    assert.match(
        compiled.cpp,
        /bbl::shader_slot_uniform_value\(\w+, \w+, "uTint", "vec3<f32>", 3u\)/,
    );
    // The maps install over the derived program's slots, in source order.
    assert.match(
        compiled.cpp,
        /bbl::derive_shader_material_view\((\w+), (\w+), \d+u, false\);\s*\{[^\n]*bbl::install_shader_view_slots\(\1, \2, bbl::ShaderDeclarationList::samplers, \w+\); \}\s*\{[^\n]*bbl::install_shader_view_slots\(\1, \2, bbl::ShaderDeclarationList::storage_buffers, \w+\); \}\s*\{[^\n]*->value\}\); bbl::install_shader_view_slots\(\1, \2, bbl::ShaderDeclarationList::uniforms, \w+\); \}/,
    );
});

test("slot maps refuse where a read is held or written, and where their records are not the pin's slot objects", () => {
    const refuses = (from: string, to: string, refusal: RegExp): void => {
        assert.ok(slotMapsSource.includes(from), from);
        assert.throws(
            () => compileSource(slotMapsSource.replace(from, to)),
            refusal,
        );
    };
    refuses(
        "const src = source as Internals;",
        "const src = source as Internals; const held = src._textureSlots; console.log(held.size);",
        /'src\._textureSlots' reads a ShaderMaterial's '_textureSlots' other than by 'get', 'has', 'size', an iteration or a 'new Map' copy/,
    );
    refuses(
        "const src = source as Internals;",
        'const src = source as Internals; src._textureSlots.set("carve", { decl: CARVE, current: fallback });',
        /reads a ShaderMaterial's '_textureSlots' other than by 'get'/,
    );
    refuses(
        "interface TextureSlot { decl: ShaderSamplerDecl; current: Texture2D | null }",
        "interface TextureSlot { decl: ShaderSamplerDecl; current: Texture2D | null; label: string }",
        /A ShaderMaterial's slot map is a Map from names to records of 'decl' and 'current'/,
    );
    // Without its maps, a view declaring other slots keeps refusing.
    refuses(
        "_textureSlots: { value: textureSlots, enumerable: true, configurable: true },",
        "",
        /A ShaderMaterial view keeps its source's slots; its redefinitions \(fragmentSource, samplerDecls, uniformDecls, storageBufferDecls\) declare other uniforms, samplers or storage buffers than shader variant 'base'/,
    );
});

test("installed slot maps natively alias the source's slots their records were read from, hold the others as the view's own, and pack the uniforms they hold", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const { compiled, cpp } = compileShaderMaterialFixture(slotMapsSource);
    const context = new LoweringContext();
    const factory = new FactoryLowerer(context).lowerShaderMaterialFactory({
        views: true,
        slotMaps: true,
    }).source;
    const views = new FactoryLowerer(context).lowerNoColorMaterialViews(
        false,
        false,
        false,
        false,
        true,
    ).source;
    const id = (name: string): number =>
        compiled.manifest.customShaderPrograms.findIndex(
            (candidate) => candidate.name === name,
        );
    runGeneratedProgram(
        native,
        "shader-material-views/slot-maps",
        `
${cpp}
#include <array>
#include <cstdio>
namespace bbl {
namespace {
${cppFunction(views, "MaterialHandle create_no_color_material_view(")}
}
${cppFunction(views, "MaterialHandle create_shader_material_view(")}
${cppFunction(views, "void derive_shader_material_view(")}
${["void set_shader_texture(", "void set_shader_render_texture(", "void set_shader_storage_buffer(", "void set_shader_pixels_texture( Engine& engine, MaterialHandle material, std::uint32_t slot, const StoredTexture& texture)"].map((signature) => cppFunction(factory, signature)).join("\n")}
void set_shader_pixels_texture(Engine&, MaterialHandle, std::uint32_t, const PixelsTexture&) { throw std::runtime_error("no pixels"); }
}
int main(){
    using bbl::ShaderDeclarationList;
    bbl::Engine engine;
    engine.storage_buffers.resize(3);
    const auto source = bbl::create_shader_material(engine, ${id("base")}u);
    const auto other = bbl::create_shader_material(engine, ${id("base")}u);
    const auto view = bbl::create_shader_material_view(engine, source);
    bbl::derive_shader_material_view(engine, view, ${id("base-1")}u, false);
    // The records a program reads out of the maps, as generation builds them.
    struct TextureSlot { bbl::js::Nullable<bbl::StoredTexture> current; };
    struct StorageSlot { bbl::js::Nullable<bbl::StorageBufferHandle> current; };
    const auto texture_read = [&](bbl::MaterialHandle material) {
        auto slot = bbl::js::make_ref<TextureSlot>(TextureSlot{bbl::shader_slot_texture(engine, material, 0u)});
        bbl::register_shader_slot_read(engine, material, ShaderDeclarationList::samplers, 0u, slot.weak_identity());
        return slot;
    };
    const auto entry = [](const char* name, const auto& slot) {
        return bbl::ShaderViewSlotEntry{name, slot.weak_identity(), slot->current};
    };
    const auto where = [&](ShaderDeclarationList list, std::uint32_t slot) {
        const auto owner = bbl::shader_slot_owner(engine, bbl::handle_at(engine.materials, view), list, slot);
        std::printf("%s%u ", &owner.material == &bbl::handle_at(engine.materials, source) ? "source" : "own", owner.slot);
    };
    const auto albedo = texture_read(source);
    bbl::FileTexture fallback; fallback.identity = 9;
    const auto carve = bbl::js::make_ref<TextureSlot>(TextureSlot{bbl::StoredTexture{fallback}});
    auto points = bbl::js::make_ref<StorageSlot>(StorageSlot{bbl::shader_slot_storage_buffer(engine, source, 0u)});
    bbl::register_shader_slot_read(engine, source, ShaderDeclarationList::storage_buffers, 0u, points.weak_identity());
    bbl::install_shader_view_slots(engine, view, ShaderDeclarationList::samplers, {entry("albedo", albedo), entry("carve", carve)});
    bbl::install_shader_view_slots(engine, view, ShaderDeclarationList::storage_buffers, {entry("points", points)});
    where(ShaderDeclarationList::samplers, 0); where(ShaderDeclarationList::samplers, 1); where(ShaderDeclarationList::storage_buffers, 0);
    // What the source binds later is what the view's copied slots hold.
    bbl::FileTexture green; green.identity = 7; green.data.bytes = bbl::SharedTextureBytes::Storage{1};
    bbl::set_shader_texture(engine, source, 0u, green);
    bbl::set_shader_storage_buffer(engine, source, 0u, bbl::StorageBufferHandle{2});
    const auto held = bbl::shader_slot_texture(engine, view, 1u);
    std::printf("%llu %llu %d %u ", static_cast<unsigned long long>(std::get<bbl::FileTexture>(bbl::shader_slot_texture(engine, view, 0u).value()).identity),
        static_cast<unsigned long long>(bbl::handle_at(engine.materials, view).shader_textures.at(1).identity), held.has_value() ? 1 : 0,
        bbl::shader_slot_storage_buffer(engine, view, 0u).value().value);
    // A record read through the view is its source's slot.
    const auto again = texture_read(view);
    bbl::install_shader_view_slots(engine, view, ShaderDeclarationList::samplers, {entry("albedo", again), entry("carve", carve)});
    where(ShaderDeclarationList::samplers, 0);
    const auto refused = [&](std::vector<bbl::ShaderViewSlotEntry> entries) {
        try { bbl::install_shader_view_slots(engine, view, ShaderDeclarationList::samplers, entries); } catch (const std::runtime_error& error) { std::printf("| %s ", error.what()); }
    };
    refused({entry("albedo", texture_read(other)), entry("carve", carve)});
    refused({entry("albedo", albedo)});
    // Uniforms: a record read from the source shares its array.
    const auto offset = [](const char* name) {
        for (const auto& slot : bbl::upstream::shader_variant_info(${id("base-1")}u).uniform_slots)
            if (std::string_view(slot.name) == name) return slot.offset;
        throw std::runtime_error("no uniform");
    };
    const auto packed = [&] {
        const auto& values = bbl::shader_uniform_render_values(bbl::handle_at(engine.materials, view));
        for (const auto& [name, lanes] : {std::pair{"uTint", 3u}, std::pair{"uExtra", 4u}})
            for (std::uint32_t lane = 0; lane < lanes; ++lane) std::printf("%g,", static_cast<double>(values.at(offset(name) + lane)));
        std::printf(" ");
    };
    const auto tint = bbl::shader_slot_uniform_value(engine, source, "uTint", "vec3<f32>", 3u);
    const auto world = bbl::shader_slot_uniform_value(engine, source, "world", "mat4x4<f32>", 16u);
    const auto extra = bbl::normalize_shader_uniform_value("uExtra", "vec4<f32>", 4u, {1.0f, 2.0f, 3.0f, 4.0f});
    bbl::install_shader_view_slots(engine, view, ShaderDeclarationList::uniforms, {{"world", {}, world}, {"uTint", {}, tint}, {"uExtra", {}, extra}});
    std::printf("%zu ", world.size());
    packed();
    bbl::set_shader_uniform(engine, source, "uTint", std::array<double, 3>{0.0, 1.0, 0.0});
    packed();
    // A declared uniform the map lacks packs as zero.
    bbl::install_shader_view_slots(engine, view, ShaderDeclarationList::uniforms, {{"uTint", {}, tint}});
    packed();
    try { bbl::install_shader_view_slots(engine, view, ShaderDeclarationList::uniforms, {{"uExtra", {}, tint}}); } catch (const std::runtime_error& error) { std::printf("| %s", error.what()); }
}
`,
        {
            expectedOutput:
                "source0 own1 source0 7 9 0 2 source0 | A ShaderMaterial view's slot map holds, for 'albedo', a slot of a material other than its source. | A ShaderMaterial view's slot map holds no slot for 'carve', which its variant declares. 16 1,0.5,0.25,1,2,3,4, 0,1,0,1,2,3,4, 0,1,0,0,0,0,0, | A ShaderMaterial view declares uniform 'uExtra' as vec4<f32>; the slot its map holds does not.",
            flags: ["/DBBLITE_GPU_INSTANCING=0"],
        },
    );
});
