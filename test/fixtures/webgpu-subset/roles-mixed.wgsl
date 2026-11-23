@group(0) @binding(0) var<storage, read_write> result: array<u32>;
@group(0) @binding(1) var<storage, read> bbl_num_workgroups: vec3u;

fn copyAuthored() {
    result[0] = bbl_num_workgroups.x;
    result[1] = bbl_num_workgroups.y;
    result[2] = bbl_num_workgroups.z;
}

@compute @workgroup_size(1)
fn both(@builtin(global_invocation_id) bbl_num_workgroups_1: vec3u, @builtin(num_workgroups) counts: vec3u) {
    if (all(bbl_num_workgroups_1 == vec3u(0))) {
        copyAuthored();
        result[3] = counts.x;
        result[4] = counts.y;
        result[5] = counts.z;
    }
}

@compute @workgroup_size(1)
fn other(@builtin(global_invocation_id) id: vec3u) {
    if (all(id == vec3u(0))) { copyAuthored(); }
}
