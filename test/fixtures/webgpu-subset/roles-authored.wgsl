@group(0) @binding(0) var<storage, read_write> result: array<u32>;
@group(0) @binding(1) var<storage, read> bbl_num_workgroups: vec3u;

@compute @workgroup_size(1)
fn authored(@builtin(global_invocation_id) id: vec3u) {
    if (all(id == vec3u(0))) {
        result[0] = bbl_num_workgroups.x;
        result[1] = bbl_num_workgroups.y;
        result[2] = bbl_num_workgroups.z;
    }
}
