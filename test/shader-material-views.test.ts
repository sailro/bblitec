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
    // With no variant at all the call's own refusal stands.
    assert.throws(
        () => compileSource(unshadedSource(false)),
        /'material\.samplerDecls' reads a ShaderMaterial's 'samplerDecls', which its shader variant decides; this material's variant is decided at run time\./,
    );
    const compiled = compileSource(unshadedSource(true));
    const late = compiled.manifest.customShaderPrograms.findIndex(
        ({ name }) => name === "late",
    );
    assert.match(table(compiled), new RegExp(`case ${late}u: return 0u;`));
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
    // The pin's field holds the creation's own array, which the program
    // writes after the material keeps its numbers.
    assert.throws(
        () =>
            compileSource(
                tinted(
                    `{ name: "uTint", type: "vec3<f32>", defaultValue: lanes }`,
                    "tinted.uniformDecls[2]!.name",
                ),
            ),
        /'tinted\.uniformDecls' reads a ShaderMaterial's 'defaultValue' of uniform 'uTint', the array its creation was given, which the program may change after the creation \('lanes': .*\); the material keeps only that array's numbers at its creation\./,
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
