#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>
#include <bblite/upstream/env_parse.hpp>

#include <utility>

namespace bbl {

void load_environment(Scene& scene, EnvironmentOptions options) {
    upstream::ParsedEnvironment parsed =
        upstream::parse_env_file(pal::read_binary_file(options.environment_url));

    scene.environment.enabled = true;
    scene.environment.has_irradiance = true;
    scene.environment.spherical_harmonics = parsed.spherical_harmonics;
    scene.environment.specular_width = parsed.width;
    scene.environment.specular_mip_count = parsed.mip_count;
    scene.environment.specular_faces = std::move(parsed.faces);
    scene.environment.brdf_lut = {};
    if (!options.brdf_url.empty()) {
        scene.environment.brdf_lut.bytes = pal::read_binary_file(options.brdf_url);
        scene.environment.brdf_lut.mime_type = "image/png";
    }
    scene.environment.source_url = std::move(options.environment_url);
    scene.clear_color = Color4{0.2f, 0.2f, 0.29f, 1.0f};
}

} // namespace bbl
