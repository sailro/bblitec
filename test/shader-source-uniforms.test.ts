import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { compilerRepositoryRoot } from "../src/repository-root.js";
import { lowerWgslShaderProgram } from "../src/shader-ir.js";
import { emitNativeWgslProgram } from "../src/shader-wgsl-emitter.js";
import { findPinnedTint } from "../src/tint-tool.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { compileShaderMaterialFixture } from "./shader-material-fixture.js";
import { validateTintStages } from "./tint-stage-validation.js";

/** Run-time numbers a shader stage's builder formats, read from material uniforms. */

const VERTEX = `struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
    out.uv = input.uv;
    return out;
}`;

/**
 * A particle system whose textured fragment cuts its sprite from an atlas
 * rectangle measured at run time: the helper formats the rectangle inside
 * its fragment function, and the stage joins a prelude to the helper's text
 * under a conditional, as the real application's billboard does.
 */
const ATLAS_SCENE = `
    import { createEngine, createShaderMaterial, wgsl } from "babylon-lite";

    const LIGHT_WGSL = \`
fn daylight() -> f32 {
  return 0.75;
}
\`;

    function texturedFragment(uvRect?: readonly [number, number, number, number], lit = false): string {
        const remap = uvRect
            ? \`vec2<f32>(\${uvRect[0].toFixed(6)}, \${uvRect[1].toFixed(6)}) + vec2<f32>(input.uv.x, 1.0 - input.uv.y) * vec2<f32>(\${uvRect[2].toFixed(6)}, \${uvRect[3].toFixed(6)})\`
            : \`vec2<f32>(input.uv.x, 1.0 - input.uv.y)\`;
        return \`
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  let iconUv = \${remap};
  return vec4<f32>(iconUv\${lit ? " * daylight()" : ""}, 0.0, 1.0);
}
\`;
    }

    function plainFragment(): string {
        return \`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
    }

    interface SystemOptions {
        textured?: boolean;
        uvRect?: readonly [number, number, number, number];
        lit?: boolean;
    }

    function createSystem(options: SystemOptions) {
        const textured = options.textured === true;
        const lit = options.lit === true;
        const prelude = lit ? \`\${LIGHT_WGSL}\n\` : "";
        return createShaderMaterial({
            name: "atlas-sprites",
            vertexSource: wgsl\`${VERTEX}\`,
            fragmentSource: wgsl\`\${prelude + (textured ? texturedFragment(options.uvRect, lit) : plainFragment())}\`,
            attributes: ["position", "uv"],
            uniforms: ["worldViewProjection"],
        });
    }

    async function main() {
        await createEngine({});
        const u = Math.random();
        const uvRect: [number, number, number, number] = [u, u * 0.5, 0.25, 0.125];
        createSystem({ textured: true, uvRect, lit: true });
    }
    main();
`;

test("reads each run-time number a nested builder formats into a function body from a uniform", () => {
    const result = compileSource(ATLAS_SCENE);
    const [program] = result.manifest.customShaderPrograms;
    assert.ok(program);
    assert.deepEqual(program.uniforms, [
        "worldViewProjection",
        "bblDynamicFragment0:f32",
        "bblDynamicFragment1:f32",
        "bblDynamicFragment2:f32",
        "bblDynamicFragment3:f32",
    ]);
    assert.equal(program.liftedUniforms, 4);
    assert.match(
        program.fragmentSource,
        /let iconUv = vec2<f32>\(shaderUniforms\.bblDynamicFragment0, shaderUniforms\.bblDynamicFragment1\) \+ vec2<f32>\(input\.uv\.x, 1\.0 - input\.uv\.y\) \* vec2<f32>\(shaderUniforms\.bblDynamicFragment2, shaderUniforms\.bblDynamicFragment3\);/,
    );
    // The prelude and the helper's other text keep their spelling.
    assert.match(program.fragmentSource, /fn daylight\(\) -> f32 \{/);
    assert.match(
        program.fragmentSource,
        /vec4<f32>\(iconUv \* daylight\(\), 0\.0, 1\.0\)/,
    );
    // No representative a generation run spelled survives.
    assert.doesNotMatch(program.fragmentSource, /1\.210938|3804\.687500/);
    assert.doesNotMatch(program.vertexSource, /bblDynamic/);
    // Each uniform holds the number the formatted text denotes, read from
    // its own lane of the run-time tuple.
    for (const [lane, offset] of [0, 1, 2, 3].entries()) {
        assert.match(
            result.cpp,
            new RegExp(
                `std::array<float, 1> values\\{static_cast<float>\\(bbl::js::number_from_string\\(bbl::js::number_to_fixed\\([^;]*\\[${lane}\\], 6\\.0\\)\\)\\)\\}; bbl::initialize_shader_uniform_values\\([^;]*, ${offset}u, 1u, values\\.data\\(\\)\\);`,
            ),
        );
    }
});

test("spells an atlas rectangle generation knows instead of lifting it", () => {
    const result = compileSource(
        ATLAS_SCENE.replace("const u = Math.random();", "const u = 0.5;"),
    );
    const [program] = result.manifest.customShaderPrograms;
    assert.deepEqual(program?.uniforms, ["worldViewProjection"]);
    assert.match(
        program?.fragmentSource ?? "",
        /vec2<f32>\(0\.500000, 0\.250000\) \+ vec2<f32>\(input\.uv\.x, 1\.0 - input\.uv\.y\) \* vec2<f32>\(0\.250000, 0\.125000\)/,
    );
    assert.doesNotMatch(result.cpp, /initialize_shader_uniform_values/);
});

test("the lifted stage is one native WGSL module whose uniform block holds each number", (t) => {
    const [program] = compileSource(ATLAS_SCENE).manifest.customShaderPrograms;
    assert.ok(program);
    const lowered = lowerWgslShaderProgram(program);
    const fragment = lowered.reflection.uniformBlocks.find(
        ({ stage }) => stage === "fragment",
    );
    assert.deepEqual(
        fragment?.members.map(({ name, offset }) => ({ name, offset })),
        [0, 1, 2, 3].map((index) => ({
            name: `bblDynamicFragment${index}`,
            offset: index * 4,
        })),
    );
    // Dawn compiles this module itself; SDL_GPU compiles it offline with the
    // pinned Tint.
    const native = emitNativeWgslProgram(lowered, "fragment");
    assert.match(native, /bblDynamicFragment3: f32/);
    assert.match(native, /shaderUniforms\.bblDynamicFragment0/);
    const tint = findPinnedTint(
        compilerRepositoryRoot(),
        discoverDevelopmentTools().cmake,
    );
    if (!tint) {
        t.skip("Pinned Tint unavailable.");
        return;
    }
    const directory = mkdtempSync(join(tmpdir(), "bblite-lifted-stage-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const stages = (["vertex", "fragment"] as const).map((stage) => {
        const file = join(directory, `atlas-sprites.${stage}.native.wgsl`);
        writeFileSync(file, emitNativeWgslProgram(lowered, stage));
        return file;
    });
    assert.deepEqual(
        validateTintStages(tint, stages, join(directory, "cache"), false)
            .failures,
        [],
    );
});

/**
 * A scene creating one material from run-time numbers parsed from JSON: a
 * vertex depth bias a module-scope constant spells with toExponential, and
 * a fragment offset pair formatted with toFixed in the function body.
 */
const EXACT_SCENE = `
    import { createEngine, createShaderMaterial } from "babylon-lite";

    const vertexSource = (bias: number) => \`struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};
const DEPTH_BIAS: f32 = \${bias.toExponential(2)};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
    out.position.z = out.position.z + DEPTH_BIAS * out.position.w;
    return out;
}\`;

    function fragmentSource(offset: readonly [number, number]): string {
        return \`@fragment fn mainFragment() -> @location(0) vec4<f32> {
    return vec4<f32>(\${offset[0].toFixed(6)}, \${offset[1].toFixed(6)}, 0.0, 1.0);
}\`;
    }

    async function main() {
        await createEngine({});
        const parsed = JSON.parse("[0.3333333333333333, 0.000123456789]") as number[];
        const third = parsed[0]!;
        const offset: [number, number] = [third, third * 2];
        createShaderMaterial({
            name: "exact-lift",
            vertexSource: vertexSource(parsed[1]!),
            fragmentSource: fragmentSource(offset),
            attributes: ["position"],
            uniforms: ["worldViewProjection"],
        });
    }
    main();
`;

test("a lifted uniform holds the number its formatted text denotes", (t) => {
    // The raw doubles round to other floats than their spellings do.
    const third = 1 / 3;
    const bias = 0.000123456789;
    const expected = [
        Math.fround(Number(bias.toExponential(2))),
        Math.fround(Number(third.toFixed(6))),
        Math.fround(Number((third * 2).toFixed(6))),
    ];
    assert.notDeepEqual(expected, [bias, third, third * 2].map(Math.fround));
    const { compiled, cpp } = compileShaderMaterialFixture(EXACT_SCENE);
    const [program] = compiled.manifest.customShaderPrograms;
    assert.deepEqual(program?.uniforms, [
        "worldViewProjection",
        "bblDynamicVertex0:f32",
        "bblDynamicFragment0:f32",
        "bblDynamicFragment1:f32",
    ]);
    // The module-scope constant is gone; its reads read the uniform.
    assert.doesNotMatch(program?.vertexSource ?? "", /DEPTH_BIAS/);
    assert.match(
        program?.vertexSource ?? "",
        /out\.position\.z = out\.position\.z \+ shaderUniforms\.bblDynamicVertex0 \* out\.position\.w;/,
    );
    assert.match(
        program?.fragmentSource ?? "",
        /return vec4<f32>\(shaderUniforms\.bblDynamicFragment0, shaderUniforms\.bblDynamicFragment1, 0\.0, 1\.0\);/,
    );
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    // The scene's initializations are recorded on their way to the material.
    runGeneratedProgram(
        native,
        "shader-source-uniforms/exact",
        `${cpp}
#include <utility>
#include <vector>
namespace bbl {
std::vector<std::pair<std::uint32_t, float>> initialized_uniforms;
void recorded_initialize_shader_uniform_values(Engine& engine, MaterialHandle material, std::uint32_t offset, std::uint32_t count, const float* values) {
    for (std::uint32_t index = 0; index < count; ++index) initialized_uniforms.emplace_back(offset + index, values[index]);
    initialize_shader_uniform_values(engine, material, offset, count, values);
}
}
#define initialize_shader_uniform_values recorded_initialize_shader_uniform_values
#define main generated_main
${compiled.cpp}
#undef main
#undef initialize_shader_uniform_values
int main() {
    assert(generated_main() == 0);
    const std::vector<std::pair<std::uint32_t, float>> expected{${expected
        .map((value, offset) => `{${offset}u, ${value.toPrecision(9)}f}`)
        .join(", ")}};
    assert(bbl::initialized_uniforms == expected);
}
`,
        { expectedOutput: "" },
    );
});

test("a function literal's known number reads from a uniform holding its spelling's number", () => {
    const { cpp, manifest } = compileSource(
        EXACT_SCENE.replace(
            "vertexSource(parsed[1]!)",
            "vertexSource(0.000123456789)",
        ),
    );
    assert.deepEqual(manifest.customShaderPrograms[0]?.uniforms.slice(0, 2), [
        "worldViewProjection",
        "bblDynamicVertex0:f32",
    ]);
    assert.match(
        cpp,
        /values\{0\.000123f\}; bbl::initialize_shader_uniform_values\([^;]*, 0u, 1u,/,
    );
});

test("spells a function literal's known number where no uniform can take its place", () => {
    const [program] = compileSource(`
        import { createEngine, createShaderMaterial } from "babylon-lite";
        const fragment = (scale: number) => \`@fragment fn mainFragment() -> @location(0) vec4<f32> {
    const k = \${scale.toFixed(2)};
    return vec4<f32>(k);
}\`;
        async function main() {
            await createEngine({});
            createShaderMaterial({
                name: "known-constant",
                vertexSource: \`${VERTEX}\`,
                fragmentSource: fragment(0.5),
                attributes: ["position", "uv"],
                uniforms: ["worldViewProjection"],
            });
        }
        main();
    `).manifest.customShaderPrograms;
    assert.deepEqual(program?.uniforms, ["worldViewProjection"]);
    assert.match(program?.fragmentSource ?? "", /const k = 0\.50;/);
});

/** A scene whose fragment `fragment(rect)` spells `text`, `rect` a run-time pair. */
function holeScene(text: string): string {
    return `
        import { createEngine, createShaderMaterial } from "babylon-lite";
        function fragment(rect: readonly [number, number], x: number): string {
            return \`${text}\`;
        }
        async function main() {
            await createEngine({});
            const u = Math.random();
            const rect: [number, number] = [u, u * 0.5];
            createShaderMaterial({
                name: "lifted",
                vertexSource: \`${VERTEX}\`,
                fragmentSource: fragment(rect, u),
                attributes: ["position"],
                uniforms: ["worldViewProjection"],
            });
        }
        main();
    `;
}

const FRAGMENT_HEAD = "@fragment fn mainFragment() -> @location(0) vec4<f32> {";

test("reads a run-time module-scope f32 constant and a run-time scalar from uniforms", () => {
    const [program] = compileSource(
        holeScene(`const OFFSET: f32 = \${rect[0].toFixed(3)};
${FRAGMENT_HEAD}
    return vec4<f32>(OFFSET, \${x.toExponential(4)}, OFFSET, 1.0);
}`),
    ).manifest.customShaderPrograms;
    assert.deepEqual(program?.uniforms, [
        "worldViewProjection",
        "bblDynamicFragment0:f32",
        "bblDynamicFragment1:f32",
    ]);
    assert.match(
        program?.fragmentSource ?? "",
        /return vec4<f32>\(shaderUniforms\.bblDynamicFragment0, shaderUniforms\.bblDynamicFragment1, shaderUniforms\.bblDynamicFragment0, 1\.0\);/,
    );
});

test("refuses a run-time number a shader stage spells where WGSL does not read an f32 value", () => {
    const positions: Array<[string, RegExp]> = [
        [
            `${FRAGMENT_HEAD}
    const k = \${rect[0].toFixed(3)};
    return vec4<f32>(k);
}`,
            /'rect\[0\]\.toFixed\(3\)' in a function-scope 'const' or 'const_assert'/,
        ],
        [
            `const K: f32 = 2.0 * \${rect[0].toFixed(3)};
${FRAGMENT_HEAD}
    return vec4<f32>(K);
}`,
            /in a module-scope 'const' other than 'const NAME: f32 = <number>;'/,
        ],
        [
            `const A: f32 = \${rect[0].toFixed(3)};
const B: f32 = A * 2.0;
${FRAGMENT_HEAD}
    return vec4<f32>(B);
}`,
            /in a module-scope 'const' other than/,
        ],
        [
            `var<private> k: f32 = \${rect[0].toFixed(3)};
${FRAGMENT_HEAD}
    return vec4<f32>(k);
}`,
            /in a module-scope 'var' declaration/,
        ],
        [
            `@fragment fn mainFragment() -> @location(\${rect[0].toFixed(1)}) vec4<f32> {
    return vec4<f32>(1.0);
}`,
            /in the signature of function 'mainFragment'/,
        ],
        [
            `${FRAGMENT_HEAD}
    var values: array<f32, \${rect[0].toFixed(1)}>;
    return vec4<f32>(values[0]);
}`,
            /in a type/,
        ],
        [
            `${FRAGMENT_HEAD}
    let values = array<f32, 2>(0.0, 1.0);
    return vec4<f32>(values[\${rect[1].toFixed(1)}]);
}`,
            /'rect\[1\]\.toFixed\(1\)' in an index, which WGSL reads as an integer/,
        ],
        [
            `${FRAGMENT_HEAD}
    return vec4<f32>(\${rect[0].toFixed(0)});
}`,
            /'rect\[0\]\.toFixed\(0\)' spells an integer literal for some numbers/,
        ],
        [
            `${FRAGMENT_HEAD}
    return vec4<f32>(\${rect[0].toPrecision(3)});
}`,
            /'rect\[0\]\.toPrecision\(3\)' spells an integer literal for some numbers/,
        ],
        [
            `${FRAGMENT_HEAD}
    return vec4<f32>(\${rect[0] > 0.5 ? "1.0" : "0.0"});
}`,
            /Builder 'fragment' threw at generation: it reads the run-time number 'rect' other than through a number formatter with literal digits/,
        ],
        [
            `${FRAGMENT_HEAD}
    return vec4<f32>(\${x.toFixed(2)}, \${x > 0.5 ? "1.0" : "0.0"}, 0.0, 1.0);
}`,
            /Builder 'fragment' cannot run at generation: it reads the run-time number 'x' other than through a number formatter with literal digits/,
        ],
        [
            `${FRAGMENT_HEAD}
    return vec4<f32>(\${rect[0].toFixed(rect.length)});
}`,
            /'rect\[0\]\.toFixed\(rect\.length\)' requires literal toFixed digits/,
        ],
    ];
    for (const [text, refusal] of positions)
        assert.throws(() => compileSource(holeScene(text)), refusal, text);
});
