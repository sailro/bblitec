import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { compileShaderMaterialFixture as nativeParts } from "./shader-material-fixture.js";

// Two materials a run-time choice orders, so each read takes the material's
// own record. The vertex source formats a depth bias generation lifts into
// a uniform, which the pin's uniformDecls does not hold.
const program = (body: string): string => `
import { createEngine, createShaderMaterial, type ShaderMaterial } from "babylon-lite";
const vertexSource = (depthBias: number) => \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
const DEPTH_BIAS: f32 = \${depthBias.toExponential(6)};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.position.z = out.position.z + DEPTH_BIAS / out.position.w;
  return out;
}\`;
const fragmentSource = \`@fragment fn mainFragment() -> @location(0) vec4<f32> { return shaderUniforms.uTint; }\`;
const PALETTE = { name: "uPalette", type: "array<vec4<f32>>" } as const;
const APPEARANCE = { name: "uAppearance", type: "array<vec4<f32>>" } as const;
function make(facade: boolean, depthBias = 0): ShaderMaterial {
    return createShaderMaterial({
        name: facade ? "facade" : "plain",
        vertexSource: vertexSource(depthBias),
        fragmentSource,
        attributes: facade ? ["position", "normal", "uv"] : ["position"],
        uniforms: ["worldViewProjection", { name: "uTint", type: "vec4<f32>", defaultValue: [1, 1, 1, 1] }],
        samplers: facade ? ["uAlbedo", { name: "uShadow", sampleType: "depth" }] : ["uAlbedo"],
        externalTextures: ["uVideo"],
        storageBuffers: facade ? [PALETTE, APPEARANCE] : [PALETTE],
    });
}
${body}
async function main() {
    await createEngine({});
    const facade = make(true);
    const plain = make(false);
    const ordered = Math.random() < 2;
    check(ordered ? facade : plain, ordered ? plain : facade);
}
main();
`;

test("a ShaderMaterial's declaration lists read the names its options declared, in order", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const { compiled, cpp } = nativeParts(
        program(`
function declares(material: ShaderMaterial, name: string): boolean {
    return material.storageBufferDecls.some((decl) => decl.name === name);
}
const GEOMETRY: { readonly attributes: readonly ShaderMaterial["attributes"][number][] } = { attributes: ["position", "uv"] };
function check(facade: ShaderMaterial, plain: ShaderMaterial): void {
    if (!declares(facade, APPEARANCE.name) || !declares(facade, PALETTE.name)) throw new Error("facade storage");
    if (declares(plain, APPEARANCE.name) || !declares(plain, PALETTE.name)) throw new Error("plain storage");
    if (!facade.samplerDecls.some((decl) => decl.name === "uShadow") || plain.samplerDecls.some((decl) => decl.name === "uShadow")) throw new Error("samplers");
    if (facade.samplerDecls.some((decl) => decl.name === "uVideo")) throw new Error("external texture");
    let storage = "";
    for (const decl of facade.storageBufferDecls) storage += decl.name + ";";
    if (storage !== "uPalette;uAppearance;") throw new Error("storage order " + storage);
    let uniforms = "";
    for (const decl of facade.uniformDecls) uniforms += decl.name + ";";
    if (uniforms !== "worldViewProjection;uTint;") throw new Error("uniforms " + uniforms);
    for (const name of GEOMETRY.attributes) if (!facade.attributes.includes(name)) throw new Error("facade attribute " + name);
    if (plain.attributes.includes(GEOMETRY.attributes[1]!) || !plain.attributes.some((name) => name === "position")) throw new Error("plain attributes");
    let attributes = "";
    for (const name of facade.attributes) attributes += name + ";";
    if (attributes !== "position;normal;uv;") throw new Error("attributes " + attributes);
}`),
    );
    runGeneratedProgram(
        native,
        "shader-declaration-lists/compiled",
        `${cpp}\n#define main generated_main\n${compiled.cpp}\n#undef main\nint main(){assert(generated_main()==0);}`,
        { expectedOutput: "" },
    );
});

test("a ShaderMaterial declaration entry read other than through its name refuses", () => {
    for (const use of [
        "if (facade.storageBufferDecls.some((decl) => decl === PALETTE)) throw new Error();",
        'if (plain.samplerDecls.some((decl) => decl.sampleType === "depth")) throw new Error();',
        "for (const decl of facade.uniformDecls) kept.push(decl);",
    ])
        assert.throws(
            () =>
                compileSource(
                    program(`
const kept: object[] = [];
function check(facade: ShaderMaterial, plain: ShaderMaterial): void {
    ${use}
}`),
                ),
            /A ShaderMaterial's (storageBufferDecls|samplerDecls|uniformDecls) entry is read only through its name\./,
        );
    // The attribute list takes `includes`, `some` and `for...of` alone.
    assert.throws(
        () =>
            compileSource(
                program(`
function check(facade: ShaderMaterial, plain: ShaderMaterial): void {
    if (facade.attributes.indexOf("uv") < 0) throw new Error(plain.name);
}`),
            ),
        /Unsupported property value 'facade\.attributes\.indexOf'/,
    );
});

test("a program reading no declaration list keeps its shader units unchanged", () => {
    const feature = "material:shader-declaration-lists";
    const plain = compileSource(
        program(
            "function check(facade: ShaderMaterial, plain: ShaderMaterial): void { console.log(facade.name, plain.name); }",
        ),
    );
    const reading = compileSource(
        program(
            "function check(facade: ShaderMaterial, plain: ShaderMaterial): void { if (!facade.storageBufferDecls.some((decl) => decl.name === PALETTE.name)) throw new Error(plain.name); }",
        ),
    );
    assert.ok(!plain.manifest.features.includes(feature));
    assert.ok(reading.manifest.features.includes(feature));
    const units = (declarationLists: boolean) => {
        const context = new LoweringContext();
        const plan = new RendererLowerer(context).lowerRenderPlan({
            shaderPrograms: plain.manifest.customShaderPrograms,
            shaderDeclarationLists: declarationLists,
        });
        return {
            header: plan.header,
            source: plan.source,
            factory: new FactoryLowerer(context).lowerShaderMaterialFactory({
                declarationLists,
            }).source,
        };
    };
    const off = units(false);
    const on = units(true);
    assert.doesNotMatch(
        off.header + off.source + off.factory,
        /lifted_uniforms|shader_declaration_names/,
    );
    // The feature adds the table's lifted-uniform and attribute fields, each
    // entry's count and attribute names, and the name walk, and nothing else.
    assert.equal(
        on.header.replace(
            /\n {4}\/\/ How many trailing uniform_slots[^]*?std::vector<const char\*> attributes;(?=\n)/,
            "",
        ),
        off.header,
    );
    assert.equal(
        on.source.replace(
            /\n {8}1u,\n {8}\{"position"(?:, "\w+")*\},(?=\n {8}js::Nullable<double>)/g,
            "",
        ),
        off.source,
    );
    assert.equal(
        on.factory.replace(
            /const std::vector<std::string>& shader_declaration_names\([^]*?\n}\n\n/,
            "",
        ),
        off.factory,
    );
});
