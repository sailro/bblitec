function fragmentInput(): string {
    return `struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>,
    @location(3) uv: vec2<f32>,
};`;
}

function ditherHelperWgsl(): string {
    // Pinned WGSL_DITHER (shader/wgsl-helpers.ts): position-seeded
    // +-variance/255 noise added by the background fragments.
    return `fn dither(seed: vec2<f32>, varianceAmount: f32) -> f32 {
    let rand = fract(sin(dot(seed, vec2<f32>(12.9898, 78.233))) * 43758.5453);
    let normVariance = varianceAmount / 255.0;
    return mix(-normVariance, normVariance, rand);
}

`;
}

export function backgroundGroundFragmentWgsl(
    provenance: string,
    dither = false,
): string {
    return `// ${provenance}
${dither ? ditherHelperWgsl() : ""}@group(2) @binding(0) var groundTexture: texture_2d<f32>;
@group(2) @binding(1) var groundSampler: sampler;

struct GroundUniforms {
    primaryColorAlpha: vec4<f32>,
    backgroundCenter: vec4<f32>,
    cameraExposure: vec4<f32>,
    imageParameters: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: GroundUniforms;

${fragmentInput()}

@fragment
fn mainFragment(input: FragmentInput) -> @location(0) vec4<f32> {
    let sampleValue =
        textureSample(groundTexture, groundSampler, input.uv);
    var color =
        max(sampleValue.rgb, vec3<f32>(0.0)) *
        uniforms.primaryColorAlpha.rgb;
    var alpha = uniforms.primaryColorAlpha.a * sampleValue.a;
    let normal = normalize(input.normal);
    let facing = dot(
        normal,
        normalize(
            uniforms.cameraExposure.xyz -
            uniforms.backgroundCenter.xyz,
        ),
    );
    let fade = clamp(facing / 0.1, 0.0, 1.0);
    alpha *= fade * fade;
    color *= uniforms.cameraExposure.w;
    if (uniforms.imageParameters.y > 0.5) {
        color = vec3<f32>(1.0) - exp2(-1.590579 * color);
    }
    color = pow(
        max(color, vec3<f32>(0.0)),
        vec3<f32>(1.0 / 2.2),
    );
    color = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
    let highContrast =
        color * color * (vec3<f32>(3.0) - 2.0 * color);
    if (uniforms.imageParameters.x < 1.0) {
        color = mix(
            vec3<f32>(0.5),
            color,
            uniforms.imageParameters.x,
        );
    } else {
        color = mix(
            color,
            highContrast,
            uniforms.imageParameters.x - 1.0,
        );
    }
${dither
        ? `    let premultiplied =
        color * alpha + vec3<f32>(dither(input.worldPosition.xy, 0.5));
    return max(vec4<f32>(premultiplied, alpha), vec4<f32>(0.0));`
        : "    return vec4<f32>(color * alpha, alpha);"}
}
`;
}

export function backgroundSkyboxFragmentWgsl(
    provenance: string,
    dither = false,
): string {
    return `// ${provenance}
${dither ? ditherHelperWgsl() : ""}@group(2) @binding(0) var skyboxTexture: texture_cube<f32>;
@group(2) @binding(1) var skyboxSampler: sampler;

struct SkyboxUniforms {
    primaryColorExposure: vec4<f32>,
    backgroundCenter: vec4<f32>,
    imageParameters: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: SkyboxUniforms;

${fragmentInput()}

@fragment
fn mainFragment(input: FragmentInput) -> @location(0) vec4<f32> {
    let direction = normalize(
        input.worldPosition - uniforms.backgroundCenter.xyz,
    );
    var color = textureSampleLevel(
        skyboxTexture,
        skyboxSampler,
        direction,
        0.0,
    ).rgb;
    if (uniforms.imageParameters.y < 0.5) {
        color *= uniforms.primaryColorExposure.rgb;
    }
    if (uniforms.imageParameters.w < 0.5) {
        color *= uniforms.primaryColorExposure.a;
        if (uniforms.imageParameters.z > 0.5) {
            color = vec3<f32>(1.0) - exp2(-1.590579 * color);
        }
        color = pow(
            max(color, vec3<f32>(0.0)),
            vec3<f32>(1.0 / 2.2),
        );
        color = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
        let highContrast =
            color * color * (vec3<f32>(3.0) - 2.0 * color);
        if (uniforms.imageParameters.x < 1.0) {
            color = mix(
                vec3<f32>(0.5),
                color,
                uniforms.imageParameters.x,
            );
        } else {
            color = mix(
                color,
                highContrast,
                uniforms.imageParameters.x - 1.0,
            );
        }
${dither
        ? `        color = color + vec3<f32>(dither(input.worldPosition.xy, 0.5));
`
        : ""}    }
    return vec4<f32>(max(color, vec3<f32>(0.0)), 1.0);
}
`;
}
