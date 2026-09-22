@group(0) @binding(0) var output_faces: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(1,1,1)
fn main(@builtin(global_invocation_id) id: vec3u) {
    textureStore(output_faces, vec2i(id.xy), i32(id.z), vec4f(f32(id.z + 1u), f32(id.x), f32(id.y), 1.0));
}
