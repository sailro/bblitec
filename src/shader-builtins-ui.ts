/** Native retained-UI image operations. One WGSL module serves both GPU backends. */
export function uiFilterFragmentWgsl(): string {
    return `@group(2) @binding(0) var sourceTexture: texture_2d<f32>;
@group(2) @binding(1) var sourceSampler: sampler;
@group(2) @binding(2) var shadowTexture: texture_2d<f32>;
@group(2) @binding(3) var shadowSampler: sampler;
struct Filter {
    rows: array<vec4<f32>, 4>,
    offset: vec4<f32>,
    parameters: vec4<f32>,
    color: vec4<f32>,
    weights: array<vec4<f32>, 5>,
};
@group(3) @binding(0) var<uniform> effect: Filter;
struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};
fn sampleSource(uv: vec2<f32>) -> vec4<f32> {
    if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return vec4<f32>(0.0); }
    return textureSampleLevel(sourceTexture, sourceSampler, uv, 0.0);
}
@fragment
fn mainFragment(input: FragmentInput) -> @location(0) vec4<f32> {
    let mode = u32(effect.parameters.x);
    let source = sampleSource(input.uv);
    if (mode == 1u) {
        let straight = vec4<f32>(source.rgb / max(source.a, 0.0000001), source.a);
        let transformed = clamp(vec4<f32>(dot(effect.rows[0], straight), dot(effect.rows[1], straight),
            dot(effect.rows[2], straight), dot(effect.rows[3], straight)) + effect.offset, vec4<f32>(0.0), vec4<f32>(1.0));
        return vec4<f32>(transformed.rgb * transformed.a, transformed.a);
    }
    if (mode == 2u || mode == 3u) {
        let size = vec2<f32>(textureDimensions(sourceTexture));
        var sum = vec4<f32>(0.0);
        let radius = i32(effect.parameters.y);
        for (var tap = -radius; tap <= radius; tap++) {
            let index = u32(abs(tap));
            let weight = effect.weights[index / 4u][index % 4u];
            if (weight == 0.0) { continue; }
            let delta = select(vec2<f32>(0.0, f32(tap) / size.y), vec2<f32>(f32(tap) / size.x, 0.0), mode == 2u);
            sum += sampleSource(input.uv + delta) * weight;
        }
        return sum;
    }
    if (mode == 4u) {
        let uv = input.uv - effect.parameters.zw / vec2<f32>(textureDimensions(sourceTexture));
        return effect.color * sampleSource(uv).a;
    }
    if (mode == 5u) {
        let shadow = textureSampleLevel(shadowTexture, shadowSampler, input.uv, 0.0);
        return source + shadow * (1.0 - source.a);
    }
    return source;
}
`;
}
