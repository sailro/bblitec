export function gridVertexWgsl(provenance: string): string {
    return `// ${provenance}
struct VertexUniforms {
    viewProjection: mat4x4<f32>,
}
@group(1) @binding(0) var<uniform> uniforms: VertexUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(4) localPosition: vec3<f32>,
    @location(7) localNormal: vec3<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) localPosition: vec3<f32>,
    @location(1) localNormal: vec3<f32>,
};

@vertex
fn mainVertex(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position =
        uniforms.viewProjection * vec4<f32>(input.position, 1.0);
    output.localPosition = input.localPosition;
    output.localNormal = input.localNormal;
    return output;
}
`;
}

export function gridFragmentWgsl(provenance: string): string {
    return `// ${provenance}
struct GridUniforms {
    gridControl: vec4<f32>,
    mainColor: vec4<f32>,
    lineColor: vec4<f32>,
    gridOffsetVisibility: vec4<f32>,
    options: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: GridUniforms;

struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) localPosition: vec3<f32>,
    @location(1) localNormal: vec3<f32>,
};

const SQRT2: f32 = 1.41421356;
const PI: f32 = 3.14159;

fn gridDynamicVisibility(position: f32) -> f32 {
    let frequency = uniforms.gridControl.y;
    if (
        floor(position + 0.5) ==
        floor(position / frequency + 0.5) * frequency
    ) {
        return 1.0;
    }
    return uniforms.gridControl.z;
}

fn gridAniso(derivative: f32) -> f32 {
    return clamp(
        1.0 / (derivative + 1.0) - 1.0 / 10.0,
        0.0,
        1.0,
    );
}

fn gridIsOnLine(position: f32, derivative: f32) -> f32 {
    var fraction = position - floor(position + 0.5);
    fraction /= derivative;
    if (uniforms.options.y > 0.5) {
        fraction = clamp(fraction, -1.0, 1.0);
        return 0.5 + 0.5 * cos(fraction * PI);
    }
    if (abs(fraction) < SQRT2 / 4.0) {
        return 1.0;
    }
    return 0.0;
}

fn gridContrib(position: f32) -> f32 {
    var derivative =
        length(vec2<f32>(dpdx(position), dpdy(position)));
    derivative *= SQRT2;
    var result = gridIsOnLine(position, derivative);
    result *= gridDynamicVisibility(position);
    result *= gridAniso(derivative);
    return result;
}

fn gridNormalImpact(value: f32) -> f32 {
    return clamp(
        1.0 - 3.0 * abs(value * value * value),
        0.0,
        1.0,
    );
}

@fragment
fn mainFragment(input: FragmentInput) -> @location(0) vec4<f32> {
    let gridPosition =
        (input.localPosition + uniforms.gridOffsetVisibility.xyz) /
        uniforms.gridControl.x;
    var x = gridContrib(gridPosition.x);
    var y = gridContrib(gridPosition.y);
    var z = gridContrib(gridPosition.z);
    let normal = normalize(input.localNormal);
    x *= gridNormalImpact(normal.x);
    y *= gridNormalImpact(normal.y);
    z *= gridNormalImpact(normal.z);

    var grid = clamp(x + y + z, 0.0, 1.0);
    if (uniforms.options.z > 0.5) {
        grid = clamp(max(max(x, y), z), 0.0, 1.0);
    }

    var rgb = mix(
        uniforms.mainColor.rgb,
        uniforms.lineColor.rgb,
        vec3<f32>(grid),
    );
    var opacity = 1.0;
    if (uniforms.options.x > 0.5) {
        opacity = clamp(
            grid,
            0.08,
            uniforms.gridControl.w * grid,
        );
    }
    if (
        uniforms.options.x > 0.5 &&
        uniforms.options.w > 0.5
    ) {
        rgb *= opacity;
    }
    return vec4<f32>(
        rgb,
        opacity * uniforms.gridOffsetVisibility.w,
    );
}
`;
}
