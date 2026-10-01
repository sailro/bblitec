import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

/** Shader-material uniform writes from typed arrays. */

const source = `
    import { createBox, createEngine, createShaderMaterial, setShaderUniform } from "@babylonjs/lite";

    const vertexSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}\`;
    const fragmentSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return shaderUniforms.uTint;}\`;

    async function main() {
        const engine = await createEngine({});
        const material = createShaderMaterial({
            vertexSource,
            fragmentSource,
            attributes: ["position"],
            uniforms: ["worldViewProjection", { name: "uTint", type: "vec4<f32>", defaultValue: [0.25, 0.5, 0.75, 1] }],
        });
        const box = createBox(engine);
        box.material = material;
        const state = new Float32Array(4);
        state[1] = 0.5;
        setShaderUniform(material, "uTint", state);
    }
`;

test("writes a typed-array uniform value lane by lane after the pinned length check", () => {
    const { cpp } = compileSource(source);
    assert.match(
        cpp,
        /if \(v_state\.size\(\) != 4u\) throw std::runtime_error\(\(std::string\("ShaderMaterial: uniform \\"uTint\\" of type vec4<f32> expects 4 value\(s\), got "\) \+ std::to_string\(v_state\.size\(\)\) \+ "\."\)\);/,
    );
    assert.match(
        cpp,
        /set_scene_shader_uniform_value\([^;]*v_state\.load\(0u\), v_state\.load\(1u\), v_state\.load\(2u\), v_state\.load\(3u\)\)/,
    );
});
