import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
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

test("a ShaderMaterial's fields refuse where the run time decides them, and its slot maps refuse", () => {
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
        /reads a ShaderMaterial's '_textureSlots', which holds the textures `setShaderTexture` binds at run time/,
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
            `Object.defineProperty(view, "_textureSlots", { value: new Map() });`,
            /A ShaderMaterial view keeps its source's slots; redefining '_textureSlots' would give it slots of its own for the textures `setShaderTexture` binds/,
        ],
        [
            `Object.defineProperties(view, { _shaderCustomUbo: { value: null, writable: true } });`,
            /A ShaderMaterial view redefines only the properties its program is built from \(.*\); '_shaderCustomUbo' is not one\./,
        ],
        [
            `Object.defineProperty(view, "fragmentSource", { get: () => NORMAL });`,
            /A ShaderMaterial view's 'fragmentSource' is redefined by a literal data descriptor/,
        ],
        [
            `if (Math.random() > 0.5) Object.defineProperty(view, "fragmentSource", { value: NORMAL });`,
            /A ShaderMaterial view's program is redefined by a statement after the view's `const` declaration, in the same block/,
        ],
        [
            `setTint(String(Math.random())); Object.defineProperty(view, "fragmentSource", { value: tint });`,
            /A ShaderMaterial view's 'fragmentSource' compiles into its program at generation; this value is decided at run time\./,
        ],
        [
            `Object.defineProperty(view, "fragmentSource", { value: NORMAL });`,
            /A ShaderMaterial view derives its program from its source's shader variant; this source's variant is decided at run time\./,
            "material",
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

test("a run-time ShaderMaterial split refuses past its arm bound", () => {
    assert.throws(
        () => compileSource(runtimeSource(81)),
        /compiles once per outcome of run-time tests in at most 81 arms; its tests make 82: target\.material as ShaderMaterial/,
    );
});

test("a ShaderMaterial field built from an option the run time decides refuses, naming the variant", () => {
    assert.throws(
        () =>
            compileSource(`${prelude}
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const tinted = createShaderMaterial({ name: "tinted", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${surface("vec3<f32>(shaderUniforms.uTint)")}\`, attributes: ["position"], uniforms: ["worldViewProjection", "world", { name: "uTint", type: "f32", defaultValue: Math.random() }] });
        draw(engine, tinted);
        console.log(tinted.uniformDecls.map((decl) => decl.name).join());
    }
    void main();
`),
        /'tinted\.uniformDecls' reads a ShaderMaterial's 'uniformDecls', which generation does not hold for shader variant 'tinted': its 'uniforms' option is decided at run time\./,
    );
});
