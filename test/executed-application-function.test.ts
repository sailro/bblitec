import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

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
                    vertexSource: \`struct VertexOutput {
@builtin(position) position: vec4<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
var out: VertexOutput;
out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
return out;
}\`,
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
        /Shader builder 'hostSource' reads 'performance'/,
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
