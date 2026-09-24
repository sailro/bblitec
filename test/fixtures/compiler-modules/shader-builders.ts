// Shader builders a scene module declares beside engine calls: executing a
// builder runs it and the declarations it reaches, never this module's
// engine imports or its other statements.
import { createShaderMaterial, type ShaderMaterial } from "@babylonjs/lite";
import { LIGHT_INTENSITY } from "./constants.js";

const SHADE_FN = `fn shade(x: f32) -> f32 { return x * ${LIGHT_INTENSITY}; }`;

function vertexSource(mode: string): string {
    return `struct VertexOutput {
@builtin(position) position: vec4<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
var out: VertexOutput;
out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, ${mode === "raised" ? "1.5" : "1.0"});
return out;
}`;
}

function fragmentSource(mode: string): string {
    const alpha = mode === "raised" ? 0.5 : 1;
    return `${SHADE_FN}
@fragment fn mainFragment() -> @location(0) vec4<f32> {
return vec4<f32>(shade(1.0), 0.0, 0.0, ${alpha.toFixed(2)});
}`;
}

export function createBuiltMaterial(mode: string): ShaderMaterial {
    return createShaderMaterial({
        name: `built-${mode}`,
        vertexSource: vertexSource(mode),
        fragmentSource: fragmentSource(mode),
        attributes: ["position"],
        uniforms: ["worldViewProjection"],
    });
}

function hostSource(): string {
    return `@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(${performance.now()}); }`;
}

export function createHostMaterial(): ShaderMaterial {
    return createShaderMaterial({
        name: "host",
        vertexSource: vertexSource("flat"),
        fragmentSource: hostSource(),
        attributes: ["position"],
        uniforms: ["worldViewProjection"],
    });
}
