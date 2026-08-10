function fragmentInput(): string {
    return `struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>,
    @location(3) uv: vec2<f32>,
};`;
}

export function backgroundGroundFragmentWgsl(
    provenance: string,
): string {
    return `// ${provenance}
@group(2) @binding(0) var groundTexture: texture_2d<f32>;
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
    return vec4<f32>(color * alpha, alpha);
}
`;
}

export function backgroundSkyboxFragmentWgsl(
    provenance: string,
): string {
    return `// ${provenance}
@group(2) @binding(0) var skyboxTexture: texture_cube<f32>;
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
    }
    return vec4<f32>(max(color, vec3<f32>(0.0)), 1.0);
}
`;
}
