import assert from "node:assert/strict";
import test from "node:test";
import { lowerWgslShaderProgram } from "../src/shader-ir.js";

const vertexSource = `
    struct VertexOutput {
        @builtin(position) position: vec4<f32>,
    };
    @vertex fn mainVertex(input: VertexInput) -> VertexOutput {
        var out: VertexOutput;
        out.position = vec4<f32>(input.position, 1.0);
        return out;
    }
`;

const renderState = {
    needAlphaBlending: false,
    needAlphaTesting: false,
    backFaceCulling: true,
    depthWrite: true,
} as const;

test("raw shader reflection refuses an unsupported struct member type", () => {
    assert.throws(
        () =>
            lowerWgslShaderProgram({
                name: "strict-raw-struct",
                vertexSource: `
                    struct VertexOutput {
                        @builtin(position) position: vec4<f32>,
                        @location(0) code: u32,
                    };
                    const SCALE: f32 = 1.0;
                    @vertex fn mainVertex(input: VertexInput) -> VertexOutput {
                        var out: VertexOutput;
                        out.position = vec4<f32>(input.position * SCALE, 1.0);
                        out.code = 1u;
                        return out;
                    }
                `,
                fragmentSource:
                    "@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }",
                attributes: ["position"],
                uniforms: [],
                ...renderState,
            }),
        /Unsupported WGSL shader type 'u32' in struct 'VertexOutput'/,
    );
});

test("raw shader reflection ignores comments and normalizes their identity", () => {
    const source = {
        name: "comment-free-reflection",
        vertexSource,
        fragmentSource: `
            const WHITE: vec4<f32> = vec4<f32>(1.0);
            // shaderUniforms.tint and unusedTexSampler are comments only.
            @fragment fn mainFragment() -> @location(0) vec4<f32> {
                return WHITE;
            }
        `,
        attributes: ["position"],
        uniforms: ["tint:vec4<f32>"],
        samplers: ["unusedTex"],
        ...renderState,
    };
    const program = lowerWgslShaderProgram(source);
    assert.equal(
        program.reflection.uniformBlocks.some(
            ({ stage }) => stage === "fragment",
        ),
        false,
    );
    assert.doesNotMatch(program.fragment.rawSource ?? "", /comments only/);

    const reformatted = lowerWgslShaderProgram({
        ...source,
        fragmentSource:
            "const WHITE:vec4<f32> =vec4<f32>(1.0); @fragment fn mainFragment()->@location(0) vec4<f32>{return WHITE;}",
    });
    assert.equal(program.fragment.rawSource, reformatted.fragment.rawSource);
});

test("parses a direct identifier comparison as an expression", () => {
    const program = lowerWgslShaderProgram({
        name: "identifier-comparison",
        vertexSource,
        fragmentSource: `
            @fragment fn mainFragment() -> @location(0) vec4<f32> {
                let intensity = 1.0;
                if (intensity < 0.01) { discard; }
                return vec4<f32>(intensity);
            }
        `,
        attributes: ["position"],
        uniforms: [],
        ...renderState,
    });

    assert.equal(program.fragment.entryPoint.statements[1]?.kind, "if");
});
