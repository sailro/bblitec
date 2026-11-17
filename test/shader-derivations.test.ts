import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { compileShaderMaterialFixture } from "./shader-material-fixture.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/** Shader materials derived at run time from a material's own creation options, looked up by identity. */

const recipeModule = `
    import { createEngine, createShaderMaterial, getShaderUniform, wgsl } from "@babylonjs/lite";
    import type { ShaderMaterial } from "@babylonjs/lite";
    type Options = Parameters<typeof createShaderMaterial>[0];
    interface Recipe {
        readonly options: Options;
        readonly bind?: (material: ShaderMaterial) => void;
        readonly fragment?: { readonly prelude: string; readonly input: string };
    }
    const recipes = new WeakMap<ShaderMaterial, Recipe>();
    const VERT = \`struct VOut { @builtin(position) position: vec4<f32> };
@vertex fn mainVertex(input: VertexInput) -> VOut { var o: VOut; o.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0); return o; }\`;
    const FRAG = \`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }\`;
    const fade = (prelude = "", input = ""): string => \`\${prelude}
@fragment fn mainFragment(\${input}) -> @location(0) vec4<f32> {
  return vec4<f32>(shaderUniforms.uCoverage, 0.0, 0.0, 0.0);
}\`;
    function silhouette(options: Options, bind?: (material: ShaderMaterial) => void, extra?: Omit<Recipe, "options" | "bind">): ShaderMaterial {
        const material = createShaderMaterial(options);
        bind?.(material);
        recipes.set(material, { options, ...(bind ? { bind } : {}), ...extra });
        return material;
    }
    function coverageOf(source: ShaderMaterial): ShaderMaterial {
        const recipe = recipes.get(source);
        if (!recipe) return source;
        const twin = createShaderMaterial({
            ...recipe.options,
            name: \`\${recipe.options.name}-coverage\`,
            fragmentSource: wgsl\`\${fade(recipe.fragment?.prelude, recipe.fragment?.input)}\`,
            uniforms: [...(recipe.options.uniforms ?? []), { name: "uCoverage", type: "f32", defaultValue: 1 }],
            depthOnlyFragment: false,
        });
        recipe.bind?.(twin);
        return twin;
    }
    function silhouettes(): ShaderMaterial[] {
        const plain = silhouette({ name: "sil-plain", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${FRAG}\`, attributes: ["position"], uniforms: ["worldViewProjection"], depthWrite: true, depthOnlyFragment: true });
        const keyed = silhouette(
            { name: "sil-keyed", vertexSource: wgsl\`\${VERT}\`, fragmentSource: wgsl\`\${FRAG}\`, attributes: ["position", "uv"], uniforms: ["worldViewProjection", { name: "uSel", type: "vec4<f32>", defaultValue: [-1, 0, 0, 0] }], depthWrite: true, depthOnlyFragment: true },
            (material) => { if (getShaderUniform(material, "uSel") === 7) throw new Error("bind"); },
            { fragment: { prelude: "// keyed clip", input: "" } },
        );
        return [plain, keyed];
    }
`;

const derivedSource = `${recipeModule}
    function check(source: ShaderMaterial): void {
        const twin = coverageOf(source);
        if (twin.attributes.includes("uv") !== source.attributes.includes("uv")) throw new Error("twin attributes");
        if (twin.uniformDecls.some((decl) => decl.name === "uSel") !== source.uniformDecls.some((decl) => decl.name === "uSel")) throw new Error("twin uniforms");
        if (getShaderUniform(twin, "uCoverage") !== 1) throw new Error("twin coverage");
    }
    async function main(): Promise<void> {
        await createEngine({});
        const [plain, keyed] = silhouettes();
        check(plain!);
        check(keyed!);
    }
    void main();
`;

test("a material spreading a looked-up recipe's options takes, at run time, the variant derived from its source's", () => {
    const { cpp, manifest } = compileSource(derivedSource);
    const programs = manifest.customShaderPrograms ?? [];
    const named = (name: string) =>
        programs.findIndex((program) => program.name === name);
    const plain = programs[named("sil-plain-coverage")];
    const keyed = programs[named("sil-keyed-coverage")];
    assert.deepEqual(plain?.attributes, ["position"]);
    assert.deepEqual(plain?.uniforms, ["worldViewProjection", "uCoverage:f32"]);
    assert.equal(plain?.depthOnlyFragment, false);
    assert.doesNotMatch(plain?.fragmentSource ?? "", /keyed clip/);
    // The keyed source's own attributes, uniform defaults and clip prelude.
    assert.deepEqual(keyed?.attributes, ["position", "uv"]);
    assert.deepEqual(keyed?.uniforms, [
        "worldViewProjection",
        "uSel:vec4<f32>",
        "uCoverage:f32",
    ]);
    assert.deepEqual(
        keyed?.uniformDefaults.find(({ name }) => name === "uSel")?.values,
        [-1, 0, 0, 0],
    );
    assert.match(keyed?.fragmentSource ?? "", /^\/\/ keyed clip/);
    assert.match(
        cpp,
        /bbl::create_shader_material\((\w+), bblscene::derived_shader_variant_0\(bbl::shader_material\(\1, \w+\)\.shader_variant\)\)/,
    );
    const table = cpp.slice(
        cpp.indexOf("derived_shader_variant_0(std::uint32_t source)"),
    );
    for (const [source, derived] of [
        ["sil-plain", "sil-plain-coverage"],
        ["sil-keyed", "sil-keyed-coverage"],
    ] as const)
        assert.match(
            table,
            new RegExp(`case ${named(source)}u: return ${named(derived)}u;`),
        );
    // The recipe's bind runs on the derived material.
    assert.match(cpp, /->bind\)/);
});

test("a recipe whose options the program may change, or that another store holds, refuses the derivation", () => {
    assert.throws(
        () =>
            compileSource(
                derivedSource.replace(
                    "    async function main",
                    '    export function rename(options: { name?: string }): void { options.name = "renamed"; }\n    async function main',
                ),
            ),
        /one store's are unknown: the program may write 'name' of/,
    );
    assert.throws(
        () =>
            compileSource(
                derivedSource.replace(
                    "recipes.set(material, { options, ",
                    "recipes.set(material, { options: { ...options }, ",
                ),
            ),
        /no member of its record is the options its key was created from/,
    );
    assert.throws(
        () =>
            compileSource(
                derivedSource.replace(
                    "    void main();",
                    "    async function later(): Promise<void> { await main(); silhouettes(); }\n    void later();",
                ),
            ),
        /stored after a material derived from this map compiled/,
    );
});

test("a material derived inside a run-time loop takes the variant of the element its recipe was looked up by", () => {
    const { cpp } = compileSource(`${recipeModule}
    async function main(): Promise<void> {
        await createEngine({});
        const picked = silhouettes().filter(() => Math.random() < 0.5);
        const twins: ShaderMaterial[] = [];
        for (const source of picked) twins.push(coverageOf(source));
        console.log(twins.length);
    }
    void main();
`);
    // The loop's element is pinned where the lookup reads it; each pass
    // creates its twin from that material's variant.
    assert.match(
        cpp,
        /auto v_bblite_recipe_key_\d+ = bbl::js::snapshot_value\(\w+\);/,
    );
    assert.match(
        cpp,
        /bbl::create_shader_material\((\w+), bblscene::derived_shader_variant_0\(bbl::shader_material\(\1, v_bblite_recipe_key_\d+\)\.shader_variant\)\)/,
    );
});

test("the derived material natively takes the variant derived from its source material's", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const { compiled, cpp } = compileShaderMaterialFixture(derivedSource);
    const variants = compiled.manifest.customShaderPrograms?.length ?? 0;
    runGeneratedProgram(
        native,
        "shader-derivations/variants",
        `
${cpp}
#define main generated_main
${compiled.cpp}
#undef main
#include <cstdio>
int main(){
    if(generated_main()!=0)return 1;
    // Each source's variant derives the twin compiled from its options.
    for(std::uint32_t source=0;source<${variants}u;++source){
        const std::string name=bbl::upstream::shader_variant_info(source).name;
        if(name.ends_with("-coverage"))continue;
        std::printf("%s>%s ",name.c_str(),std::string(bbl::upstream::shader_variant_info(bblscene::derived_shader_variant_0(source)).name).c_str());
    }
}
`,
        {
            expectedOutput:
                "sil-plain>sil-plain-coverage sil-keyed>sil-keyed-coverage ",
        },
    );
});
