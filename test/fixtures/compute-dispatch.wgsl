struct Params { increment: f32, padding: vec3f };
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(7) var<storage, read_write> values: array<f32>;
@compute @workgroup_size(4)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x < arrayLength(&values)) {
        values[id.x] = values[id.x] + params.increment;
    }
}
