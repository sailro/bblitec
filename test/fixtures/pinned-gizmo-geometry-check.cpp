#include "pinned_gizmo_geometry.hpp"

#include <iomanip>
#include <iostream>
#include <string>

namespace {
void point(bbl::Vec3d value) {
    std::cout << ' ' << value.x << ' ' << value.y << ' ' << value.z;
}

void edge(const bbl::GizmoFrustumEdge& value) {
    std::cout << ' ' << value.height << ' ' << value.diameterTop
              << ' ' << value.diameterBottom << ' ' << value.tessellation;
    point(value.position);
    point(value.scaling);
    for (const double lane : value.rotation) std::cout << ' ' << lane;
}

template <typename Values>
void read(Values& values) {
    for (auto& value : values) std::cin >> value;
}

bbl::Vec3d read_point() {
    bbl::Vec3d value{};
    std::cin >> value.x >> value.y >> value.z;
    return value;
}
}

int main() {
    std::cout << std::setprecision(17);
    std::string operation;
    while (std::cin >> operation) {
        std::cout << operation;
        if (operation == "hemisphere") {
            double segments = 0.0, diameter = 0.0;
            std::cin >> segments >> diameter;
            const auto geometry = bbl::gizmo_hemisphere_geometry(segments, diameter);
            std::cout << ' ' << geometry.positions.size() << ' ' << geometry.normals.size()
                      << ' ' << geometry.indices.size() << ' ' << geometry.uvs.size();
            for (const float lane : geometry.positions) std::cout << ' ' << lane;
            for (const float lane : geometry.normals) std::cout << ' ' << lane;
            for (const std::uint32_t lane : geometry.indices) std::cout << ' ' << lane;
            for (const float lane : geometry.uvs) std::cout << ' ' << lane;
        } else if (operation == "lines") {
            double levels = 0.0;
            std::cin >> levels;
            const auto definitions = bbl::line_defs_for_level(levels);
            std::cout << ' ' << definitions.size();
            for (const auto& line : definitions) {
                std::cout << ' ' << line.pivotY << ' ' << line.pivotZ << ' ' << line.posY
                          << ' ' << line.sx << ' ' << line.sy << ' ' << line.sz;
            }
        } else if (operation == "frustum") {
            double fov = 0.0, aspect = 0.0, near_plane = 0.0, far_plane = 0.0;
            std::cin >> fov >> aspect >> near_plane >> far_plane;
            const auto edges = bbl::gizmo_frustum_geometry(fov, aspect, near_plane, far_plane);
            std::cout << ' ' << edges.size();
            for (const auto& value : edges) edge(value);
        } else if (operation == "edge") {
            double thickness = 0.0;
            std::cin >> thickness;
            const auto a = read_point();
            const auto b = read_point();
            edge(bbl::gizmo_frustum_edge(thickness, a, b));
        } else if (operation == "camera" || operation == "light") {
            bool present = false;
            std::array<float, 16> camera{};
            std::cin >> present;
            read(camera);
            if (operation == "camera") {
                std::array<float, 16> target{};
                read(target);
                point(bbl::gizmo_camera_scaling(present, camera, target));
            } else {
                const auto target = read_point();
                point(bbl::gizmo_light_scaling(present, camera, target));
            }
        } else if (operation == "projected") {
            const auto position = read_point();
            std::array<float, 16> camera{};
            read(camera);
            double ratio = 0.0;
            std::cin >> ratio;
            point(bbl::gizmo_projected_scaling(position, camera, ratio));
        } else if (operation == "bounds") {
            std::size_t count = 0;
            std::cin >> count;
            auto bounds = bbl::gizmo_bounds_initial();
            for (std::size_t index = 0; index < count; ++index) {
                std::array<std::array<double, 3>, 2> aabb{};
                for (auto& corner : aabb) read(corner);
                bbl::gizmo_bounds_fold(bounds, aabb);
            }
            bounds = bbl::gizmo_bounds_finish(bounds);
            point(bounds.min);
            point(bounds.max);
            point(bounds.centre);
            point(bounds.size);
        } else {
            return 2;
        }
        if (!std::cin) return 3;
        std::cout << '\n';
    }
    return 0;
}
