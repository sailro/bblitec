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

export function imageProcessingFragmentWgsl(): string {
    return `@group(2) @binding(0) var sourceTexture: texture_2d<f32>;
@group(2) @binding(1) var sourceSampler: sampler;

struct ImageProcessingUniforms {
    parameters: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: ImageProcessingUniforms;

struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@fragment
fn mainFragment(input: FragmentInput) -> @location(0) vec4<f32> {
    let source = textureSampleLevel(
        sourceTexture,
        sourceSampler,
        input.uv,
        0.0,
    );
    var color = source.rgb * uniforms.parameters.x;
    if (uniforms.parameters.z > 0.5) {
        color = vec3<f32>(1.0) - exp2(-1.590579 * color);
    }
    color = clamp(
        pow(max(color, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2)),
        vec3<f32>(0.0),
        vec3<f32>(1.0),
    );
    let highContrast =
        color * color * (vec3<f32>(3.0) - 2.0 * color);
    if (uniforms.parameters.y < 1.0) {
        color = mix(vec3<f32>(0.5), color, uniforms.parameters.y);
    } else {
        color = mix(
            color,
            highContrast,
            uniforms.parameters.y - 1.0,
        );
    }
    return vec4<f32>(max(color, vec3<f32>(0.0)), source.a);
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

/**
 * The pinned fog falloff, shared by every native fragment that reads
 * `uniforms.fogInfos`: the standard material fragment and the cubemap
 * skybox both had the same text written out.
 *
 * The PBR fragment keeps its own copy in the renderer lowerer. That one
 * is not this text -- it is the Tint-normalized dialect, naming
 * `FragmentUniforms` and spelling every literal `1.0f`, and it carries a
 * provenance comment tying it line for line to the pinned WGSL module it
 * was converted from. Regenerating it from here would break that diff.
 */
export function fogFactorWgsl(): string {
    return `const bblFogE: f32 = 2.71828;

fn bblCalcFogFactor(fogDistance: vec3<f32>) -> f32 {
    var fogCoeff = 1.0;
    let fogMode = uniforms.fogInfos.x;
    let fogStart = uniforms.fogInfos.y;
    let fogEnd = uniforms.fogInfos.z;
    let fogDensity = uniforms.fogInfos.w;
    let dist = length(fogDistance);
    if (fogMode == 3.0) {
        fogCoeff = (fogEnd - dist) / (fogEnd - fogStart);
    } else if (fogMode == 1.0) {
        fogCoeff = 1.0 / pow(bblFogE, dist * fogDensity);
    } else if (fogMode == 2.0) {
        fogCoeff =
            1.0 / pow(bblFogE, dist * dist * fogDensity * fogDensity);
    }
    return clamp(fogCoeff, 0.0, 1.0);
}
`;
}
