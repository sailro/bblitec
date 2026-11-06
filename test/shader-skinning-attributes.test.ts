import assert from "node:assert/strict";
import test from "node:test";
import { lowerWgslShaderProgram } from "../src/shader-ir.js";
import { emitNativeWgslProgram } from "../src/shader-wgsl-emitter.js";

const program = (attributes: string[]) =>
    lowerWgslShaderProgram({
        name: "skinned",
        vertexSource: `struct VertexOutput{@builtin(position) position:vec4f};
fn bone(input: VertexInput) -> u32 { return input.joints.x + input.joints1.y; }
@vertex fn mainVertex(input:VertexInput)->VertexOutput{
    var out:VertexOutput;
    let w = input.weights.x + input.weights1.x;
    out.position = shaderSystem.worldViewProjection * vec4f(input.position * (w + f32(bone(input))), 1.0);
    return out;
}`,
        fragmentSource:
            "@fragment fn mainFragment()->@location(0) vec4f{return vec4f(1.0);}",
        attributes,
        uniforms: ["worldViewProjection"],
        needAlphaBlending: false,
        needAlphaTesting: false,
        backFaceCulling: true,
        depthWrite: true,
    });

test("a shader material's skinning attributes read the deformation lanes as the pin types them", () => {
    const lowered = program([
        "position",
        "joints",
        "weights",
        "joints1",
        "weights1",
    ]);
    // The four-influence vertex holds joints (as floats) and weights; the
    // second pair is not carried.
    assert.deepEqual(
        lowered.reflection.attributes.map(({ name, location, type }) => [
            name,
            location,
            type,
        ]),
        [
            ["position", 0, "vec3<f32>"],
            ["joints", 8, "vec4<f32>"],
            ["weights", 9, "vec4<f32>"],
        ],
    );
    const wgsl = emitNativeWgslProgram(lowered, "vertex").replace(/\s+/g, "");
    // Joint indices read back as u32, in a helper taking the input too; the
    // absent pair reads zero.
    assert.match(wgsl, /\(vec4<u32>\(input\.joints\)\)\.x/);
    assert.match(wgsl, /\(vec4<u32>\(0u\)\)\.y/);
    assert.match(wgsl, /input\.weights\.x\+\(vec4<f32>\(0\.0\)\)\.x/);
    assert.doesNotMatch(wgsl, /joints1|weights1/);
});
