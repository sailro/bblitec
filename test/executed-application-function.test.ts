import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { POSITION_VERTEX_WGSL } from "./program-snippets.js";
import { compileShaderMaterialFixture } from "./shader-material-fixture.js";

function refusal(source: string, fileName: string): string {
    try {
        compileSource(source, { fileName });
    } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
    }
    assert.fail("expected a refusal");
}

test("runs an imported shader builder with the declarations it reaches", () => {
    const result = compileSource(
        `
            import { createEngine } from "@babylonjs/lite";
            import { createBuiltMaterial } from "./fixtures/compiler-modules/shader-builders.js";

            async function main() {
                await createEngine({});
                createBuiltMaterial("raised");
            }
        `,
        { fileName: "test/executed-builder-entry.ts" },
    );
    const [program] = result.manifest.customShaderPrograms;
    // The argument picked the arm, the module constant spliced the sibling
    // module's value, and the number formatted as the running code does.
    assert.match(
        program?.vertexSource ?? "",
        /vec4<f32>\(input\.position, 1\.5\)/,
    );
    assert.match(
        program?.fragmentSource ?? "",
        /fn shade\(x: f32\) -> f32 \{ return x \* 0\.75; \}/,
    );
    assert.match(program?.fragmentSource ?? "", /0\.0, 0\.0, 0\.50\)/);
});

test("runs a builder beside its module's engine code with the pin's wgsl tag", () => {
    const result = compileSource(
        `
            import { createEngine, createShaderMaterial } from "babylon-lite";
            import { wgsl } from "babylon-lite/shader/wgsl.js";

            const TINT = wgsl\`vec4<f32>(0.25, 0.5, 1.0, 1.0)\`;

            function fragmentSource(): string {
                return wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> {
return \${TINT};
}\`;
            }

            async function main() {
                await createEngine({});
                createShaderMaterial({
                    name: "tagged",
                    vertexSource: \`${POSITION_VERTEX_WGSL}\`,
                    fragmentSource: fragmentSource(),
                    attributes: ["position"],
                    uniforms: ["worldViewProjection"],
                });
            }
            main();
        `,
    );
    assert.match(
        result.manifest.customShaderPrograms[0]?.fragmentSource ?? "",
        /return vec4<f32>\(0\.25, 0\.5, 1\.0, 1\.0\);/,
    );
});

test("refuses a shader builder that reaches the host", () => {
    assert.match(
        refusal(
            `
                import { createEngine } from "@babylonjs/lite";
                import { createHostMaterial } from "./fixtures/compiler-modules/shader-builders.js";

                async function main() {
                    await createEngine({});
                    createHostMaterial();
                }
            `,
            "test/executed-builder-host-entry.ts",
        ),
        /Builder 'hostSource' reads 'performance'/,
    );
});

/**
 * A factory reading its stages from the record a helper returns for an
 * option's presence: `hold` runs between the option's test and the material,
 * `vertex` and `fragment` spell the two sources, `member` adds to the record.
 */
const stageFactory = (stages: {
    hold: string;
    vertex: string;
    fragment: string;
    member?: string;
    check?: string;
}): string => `
    const VERTEX = \`${POSITION_VERTEX_WGSL}\`;
    const LIT = \`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(shaderUniforms.uGain); }\`;
    const FLAT = \`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(0.25); }\`;

    function stageSources(lit: boolean) {
        return { vertex: VERTEX, fragment: lit ? \`// lit\\n\${LIT}\` : \`// flat\\n\${FLAT}\`${stages.member ?? ""} };
    }

    function surface(gain?: { amount: number }): ShaderMaterial {
        const lit = gain !== undefined;
        ${stages.hold}
        const material = createShaderMaterial({
            vertexSource: ${stages.vertex},
            fragmentSource: ${stages.fragment},
            attributes: ["position"],
            uniforms: ["worldViewProjection", ...(lit ? [{ name: "uGain", type: "f32" as const, defaultValue: 0.5 }] : [])],
        });
        ${stages.check ?? ""}
        return material;
    }
`;

const stageScene = (stages: Parameters<typeof stageFactory>[0]): string => `
    import { createBox, createEngine, createShaderMaterial, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
    ${stageFactory(stages)}
    async function main() {
        const engine = await createEngine({});
        const lit = createBox(engine);
        lit.material = surface({ amount: 0.5 });
        const flat = createBox(engine);
        flat.material = surface();
    }
`;

const stageFragments = (stages: Parameters<typeof stageFactory>[0]) =>
    compileSource(stageScene(stages)).manifest.customShaderPrograms.map(
        (program) => program.fragmentSource,
    );

const heldStages = {
    hold: "const sources = stageSources(lit);",
    vertex: "wgsl`${sources.vertex}`",
    fragment: "wgsl`${sources.fragment}`",
};

test("reads a stage from the record a helper call returns", () => {
    for (const stages of [
        heldStages,
        // Read where the call is.
        {
            hold: "",
            vertex: "stageSources(lit).vertex",
            fragment: "wgsl`${stageSources(lit).fragment}`",
        },
        // A member the generation realm does not carry leaves the literal.
        {
            ...heldStages,
            member: ", box: (engine: EngineContext) => createBox(engine)",
        },
    ]) {
        const [lit, flat] = stageFragments(stages);
        assert.match(lit ?? "", /^\/\/ lit\n@fragment/);
        assert.match(flat ?? "", /^\/\/ flat\n@fragment/);
    }
});

test("reads the arm a settled conditional selects as a stage", () => {
    const [lit, flat] = stageFragments({
        ...heldStages,
        fragment: "lit ? sources.fragment : FLAT",
    });
    assert.match(lit ?? "", /^\/\/ lit\n@fragment/);
    assert.match(flat ?? "", /^@fragment fn mainFragment.*0\.25/);
});

test("refuses a helper's record a later read would not see as declared", () => {
    for (const hold of [
        // Written through after the call.
        "const sources = stageSources(lit); sources.fragment = FLAT;",
        // An argument rebound after the call.
        "let mode = lit; const sources = stageSources(mode); mode = !mode;",
    ])
        assert.match(
            refusal(
                stageScene({ ...heldStages, hold }),
                "test/executed-stage-entry.ts",
            ),
            /Expected a string literal|without a static string/,
        );
});

test("selects a helper-built stage per outcome of a run-time option", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    // Each outcome's material declares what its own stage reads.
    const { compiled, cpp } = compileShaderMaterialFixture(`
    import { createEngine, createShaderMaterial, getShaderUniform, wgsl, type ShaderMaterial } from "babylon-lite";
    ${stageFactory({
        ...heldStages,
        check: `let declared = 0;
        for (const name of ["uGain"]) {
            try { if (getShaderUniform(material, name) === 0.5) declared++; } catch (error) { declared--; }
        }
        if (declared !== (lit ? 1 : -1)) throw new Error("stage variant");`,
    })}
    async function main() {
        await createEngine({});
        const rows = JSON.parse('[{"gain":0.5},{"gain":null}]') as { gain: number | null }[];
        let built = 0;
        for (const row of rows) {
            const gain = row.gain === null ? undefined : { amount: row.gain };
            if (surface(gain)) built++;
        }
        if (built !== 2) throw new Error("rows");
    }
    main();`);
    assert.equal(compiled.manifest.customShaderPrograms.length, 2);
    runGeneratedProgram(
        native,
        "executed-application-function/stage-outcomes",
        `${cpp}\n#define main generated_main\n${compiled.cpp}\n#undef main\nint main(){assert(generated_main()==0);}`,
        { expectedOutput: "" },
    );
});

const pluginScene = (plugin: string, prelude = ""): string => `
    import {
        addToScene,
        createBox,
        createEngine,
        createSceneContext,
        createStandardMaterial,
        enableMaterialPlugins,
        registerScene,
        type MaterialPlugin,
    } from "@babylonjs/lite";

    ${prelude}

    async function main() {
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const box = createBox(engine);
        const material = createStandardMaterial();
        material.plugins = [${plugin}];
        box.material = material;
        addToScene(scene, box);
        enableMaterialPlugins(scene);
        await registerScene(scene);
    }
`;

test("runs getCustomCode over the bindings its factory folds", () => {
    const result = compileSource(
        pluginScene(
            "createTint(HALF)",
            `
            const HALF = 0.5;
            function createTint(scale: number): MaterialPlugin {
                return {
                    name: "tint",
                    getCustomCode(shaderType) {
                        if (shaderType !== "fragment") return null;
                        return { CUSTOM_FRAGMENT_UPDATE_ALPHA: \`alpha *= \${scale.toFixed(2)};\` };
                    },
                };
            }
            `,
        ),
    );
    assert.match(JSON.stringify(result.manifest), /alpha \*= 0\.50;/);
});

test("refuses getCustomCode reading state the pin would read at run time", () => {
    assert.match(
        refusal(
            pluginScene(
                "createCounted()",
                `
                let calls = 0;
                function createCounted(): MaterialPlugin {
                    return {
                        name: "counted",
                        getCustomCode: (shaderType) =>
                            shaderType === "fragment"
                                ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: \`alpha *= \${calls}.0;\` }
                                : null,
                    };
                }
                `,
            ),
            "test/executed-plugin-entry.ts",
        ),
        /getCustomCode reads a module-scope 'let' or 'var'/,
    );
});
