@group(0) @binding(0) var<storage, read_write> result: array<u32>;

@compute @workgroup_size(1)
fn builtinOnly(@builtin(num_workgroups) counts: vec3u, @builtin(global_invocation_id) id: vec3u) {
    if (all(id == vec3u(0))) {
        result[3] = counts.x;
        result[4] = counts.y;
        result[5] = counts.z;
    }
}
