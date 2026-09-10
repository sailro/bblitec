import type ts from "typescript";
import {floatLiteral} from "../../cpp-literals.js";
import {pinnedRootFlip} from "./shared.js";

/** Native storage for source-constructed cameras; live pose scheduling is separate. */
export function lowerGltfCamerasCpp(parser: ts.SourceFile): {parentWriter: string; loading: string; poseRefresh: string} {
    const flip = pinnedRootFlip(parser);
    return {parentWriter: `
void write_gltf_camera_parent_world(CameraRecord& camera, Matrix node_world, const Matrix& local) {
    for (std::size_t column = 0; column < 4; ++column)
        node_world[column * 4 + ${flip.lane}] *= ${floatLiteral(flip.sign)};
    camera.parent_world = upstream::matrix_product(node_world, local);
    camera.has_parent_world = true;
}
`, loading: `
    if (load_cameras) {
        std::vector<CameraHandle> loaded_cameras;
        const auto camera_matrix = [&](const ts::JsonValue& value) {
            const auto& accessor = accessors.at(unsigned_value(value));
            if (accessor.type != "VEC4" || accessor.component_type != 5126 || accessor.count != 4)
                throw std::runtime_error("Invalid glTF camera matrix storage.");
            return read_matrix(accessor, 0);
        };
        for (const auto& value : required(mesh_plan, "cameras").as_array()) {
            const auto& prepared = value.as_object();
            const auto vector = [&](const char* name) {
                const auto& lanes = required(prepared, name).as_array();
                if (lanes.size() != 3) throw std::runtime_error("Invalid glTF camera vector storage.");
                return Vec3d{lanes[0].as_number(), lanes[1].as_number(), lanes[2].as_number()};
            };
            const auto handle = create_free_camera(engine, vector("position"), vector("target"));
            auto& camera = engine.cameras.at(handle.value);
            camera.name = required(prepared, "name").as_string();
            camera.fov = required(prepared, "fov").as_number();
            camera.near_plane = required(prepared, "nearPlane").as_number();
            camera.far_plane = required(prepared, "farPlane").as_number();
            camera.speed = required(prepared, "speed").as_number();
            camera.angular_sensibility = required(prepared, "angularSensitivity").as_number();
            camera.inertia = required(prepared, "inertia").as_number();
            camera.free_yaw = required(prepared, "yaw").as_number();
            camera.free_pitch = required(prepared, "pitch").as_number();
            camera.parent_world = camera_matrix(required(prepared, "parentWorld"));
            camera.has_parent_world = true;
            const auto& binding = required(prepared, "binding");
            if (!binding.is_null()) {
                const auto& record = binding.as_object();
                const auto node = unsigned_value(required(record, "node"));
                if (node >= node_json.size()) throw std::runtime_error("Invalid glTF camera node binding.");
                camera_node_bindings.push_back(AnimatedCameraBinding{handle, node, camera_matrix(required(record, "local"))});
            }
            loaded_cameras.push_back(handle);
        }
        for (const auto& index : required(mesh_plan, "containerCameras").as_array())
            asset.cameras.push_back(loaded_cameras.at(unsigned_value(index)));
    }
`, poseRefresh: `
            for (const AnimatedCameraBinding& binding : animation_runtime->camera_nodes) {
                if (binding.camera.value >= engine.cameras.size() || binding.node >= animation_runtime->nodes.size()) continue;
                write_gltf_camera_parent_world(engine.cameras[binding.camera.value],
                    compute_animated_world(binding.node), binding.local);
            }
`};
}
