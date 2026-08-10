export function blitVertexWgsl(): string {
    return `struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn mainVertex(
    @builtin(vertex_index) vertexIndex: u32,
) -> VertexOutput {
    let positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    let uvs = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0),
    );
    var output: VertexOutput;
    output.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
    output.uv = uvs[vertexIndex];
    return output;
}
`;
}

export function blitFragmentWgsl(): string {
    return `@group(2) @binding(0) var sourceTexture: texture_2d<f32>;
@group(2) @binding(1) var sourceSampler: sampler;

struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@fragment
fn mainFragment(input: FragmentInput) -> @location(0) vec4<f32> {
    return textureSampleLevel(
        sourceTexture,
        sourceSampler,
        input.uv,
        0.0,
    );
}
`;
}

export function depthOnlyFragmentWgsl(): string {
    return `@fragment
fn mainFragment() {
}
`;
}

function diagnosticPrelude(uniformStruct: string): string {
    return `@group(2) @binding(0) var baseColorTexture: texture_2d<f32>;
@group(2) @binding(1) var baseColorSampler: sampler;

${uniformStruct}

struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>,
    @location(3) uv: vec2<f32>,
};

fn diagnosticAlpha(input: FragmentInput, alphaOptions: vec4<f32>) -> f32 {
    let alpha =
        textureSample(baseColorTexture, baseColorSampler, input.uv).a *
        alphaOptions.z;
    if (
        (alphaOptions.x > 0.5 &&
         alphaOptions.x < 1.5 &&
         alpha < alphaOptions.y) ||
        (alphaOptions.x > 1.5 && alpha <= 0.0)
    ) {
        discard;
    }
    return alpha;
}
`;
}

export function diagnosticIdFragmentWgsl(): string {
    return `${diagnosticPrelude(`struct IdUniforms {
    idColor: vec4<f32>,
    alphaOptions: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: IdUniforms;`)}

@fragment
fn mainFragment(input: FragmentInput) -> @location(0) vec4<f32> {
    _ = diagnosticAlpha(input, uniforms.alphaOptions);
    return uniforms.idColor;
}
`;
}

export function diagnosticClusterFragmentWgsl(): string {
    return `enable primitive_index;

${diagnosticPrelude(`struct ClusterUniforms {
    clusterOptions: vec4<u32>,
    alphaOptions: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: ClusterUniforms;`)}

@fragment
fn mainFragment(
    input: FragmentInput,
    @builtin(primitive_index) primitiveIndex: u32,
) -> @location(0) vec4<f32> {
    _ = diagnosticAlpha(input, uniforms.alphaOptions);
    let clusterId =
        uniforms.clusterOptions.x +
        primitiveIndex / max(uniforms.clusterOptions.y, 1u);
    return vec4<f32>(
        f32(clusterId & 0xffu) / 255.0,
        f32((clusterId >> 8u) & 0xffu) / 255.0,
        f32((clusterId >> 16u) & 0xffu) / 255.0,
        1.0,
    );
}
`;
}
