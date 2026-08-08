#include <bblite/runtime.hpp>

namespace bbl {

CameraHandle create_arc_rotate_camera(Engine& engine, float alpha, float beta, float radius, Vec3 target) {
    CameraRecord camera;
    camera.alpha = alpha;
    camera.beta = beta;
    camera.radius = radius;
    camera.target = target;
    engine.cameras.push_back(camera);
    return CameraHandle{static_cast<std::uint32_t>(engine.cameras.size() - 1)};
}

} // namespace bbl
