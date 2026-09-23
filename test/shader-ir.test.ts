import assert from "node:assert/strict";
import test from "node:test";
import { lowerWgslShaderProgram, parseWgslFunction } from "../src/shader-ir.js";
import { emitNativeWgslProgram } from "../src/shader-wgsl-emitter.js";
import { compileSource } from "../src/compiler.js";

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

test("WGSL float shorthand types have the same typed shader identity", () => {
    const source = {
        name: "shorthand-types",
        vertexSource,
        fragmentSource:
            "@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }",
        attributes: ["position"],
        uniforms: [],
        ...renderState,
    };
    assert.deepEqual(
        lowerWgslShaderProgram({
            ...source,
            vertexSource: source.vertexSource.replaceAll("vec4<f32>", "vec4f"),
            fragmentSource: source.fragmentSource.replaceAll(
                "vec4<f32>",
                "vec4f",
            ),
        }),
        lowerWgslShaderProgram(source),
    );
});

test("shader material depth comparison survives dynamic material construction", () => {
    const result =
        compileSource(`import {createEngine,createShaderMaterial} from '@babylonjs/lite';
async function main(){const engine=await createEngine(document.createElement('canvas'));
const material=createShaderMaterial({vertexSource:${JSON.stringify(vertexSource)},fragmentSource:'@fragment fn mainFragment()->@location(0) vec4f{return vec4f(1.0);}',attributes:['position'],uniforms:[],depthCompare:'always'});
}void main();`);
    assert.equal(
        result.manifest.customShaderPrograms?.[0]?.depthCompare,
        "always",
    );
});

test("shader reflection refuses an unsupported struct member type", () => {
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

test("shader reflection ignores comments and normalizes their identity", () => {
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
    const native = emitNativeWgslProgram(program, "fragment");
    assert.doesNotMatch(native, /comments only/);
    assert.match(native, /const WHITE: vec4<f32> = vec4<f32>\(1\.0\);/);

    const reformatted = lowerWgslShaderProgram({
        ...source,
        fragmentSource:
            "const WHITE:vec4<f32> =vec4<f32>(1.0); @fragment fn mainFragment()->@location(0) vec4<f32>{return WHITE;}",
    });
    assert.deepEqual(reformatted, program);
    assert.equal(emitNativeWgslProgram(reformatted, "fragment"), native);
});

test("typed shader IR carries helper functions, loops and full operators", () => {
    const program = lowerWgslShaderProgram({
        name: "full-module",
        vertexSource,
        fragmentSource: `
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
            };
            const TAPS: i32 = 4;
            fn weight(i: i32) -> f32 {
                var w = 0.0;
                for (var j = 0; j <= i; j++) {
                    if (j % 2 == 0 && j != 3) { w += 1.0; } else if (j > 5) { break; } else { w -= -0.5; }
                }
                return w;
            }
            @fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
                let bits = (u32(TAPS) >> 1u) & 0xffu;
                return vec4<f32>(weight(TAPS) * shaderUniforms.tint.x, f32(bits), 0.0, 1.0);
            }
        `,
        attributes: ["position"],
        uniforms: ["tint:vec4<f32>"],
        ...renderState,
    });
    assert.deepEqual(
        program.reflection.uniformBlocks.map(({ stage }) => stage),
        ["fragment"],
    );
    const native = emitNativeWgslProgram(program, "fragment");
    // The emitted module parses back to the same typed module.
    const reparsed = lowerWgslShaderProgram({
        name: "full-module",
        vertexSource,
        fragmentSource: native
            .split("\n")
            .filter(
                (line) => !line.startsWith("@group") && !line.startsWith("//"),
            )
            .join("\n")
            .replace(/struct ShaderUniforms \{[^}]*\}/, ""),
        attributes: ["position"],
        uniforms: ["tint:vec4<f32>"],
        ...renderState,
    });
    assert.equal(emitNativeWgslProgram(reparsed, "fragment"), native);
    assert.match(native, /for \(var j = 0; \(j <= i\); j\+\+\) \{/);
    assert.match(native, /\} else if \(\(j > 5\)\) \{/);
    assert.match(native, /w -= -0\.5;/);
});

test("template lists are told apart from comparisons", () => {
    const fn = parseWgslFunction(
        "fn f(a: f32, b: f32) -> array<vec4<u32>, 2> { let c = a<b; let d = select(0.0, 1.0, a > b); return array<vec4<u32>, 2>(); }",
    );
    assert.equal(fn.returnType, "array<vec4<u32>,2>");
    const [compare, choose] = fn.statements;
    assert.equal(
        compare?.kind === "let" &&
            compare.value.kind === "binary" &&
            compare.value.operator,
        "<",
    );
    assert.equal(choose?.kind === "let" && choose.value.kind, "call");
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
