import type {LoweredSource, LoweringContext} from "./context.js";

/** Restore the pin-executed immutable packet; runtime ownership stays with its scene/material. */
export function lowerLocalCubemap(context: LoweringContext): LoweredSource {
    const modulePath = "src/material/pbr/enable-pbr-local-cubemap.ts";
    const symbolName = "createPbrLocalEnvironmentProbeSet";
    return {modulePath, symbolName, header: "", source: `// ${context.provenance(modulePath, symbolName)}
// Geometry, grid membership, uniform values and texture copies were executed at generation.
#include <bblite/runtime.hpp>
#include <nlohmann/json.hpp>

namespace bbl {
std::shared_ptr<LocalCubemapRecord> load_local_cubemap(
    const std::string& path, std::vector<std::shared_ptr<const EnvironmentState>> environments) {
    const auto bytes = pal::read_binary_file(path);
    const auto packet = nlohmann::json::parse(bytes.begin(), bytes.end());
    auto result = std::make_shared<LocalCubemapRecord>();
    result->environments = std::move(environments);
    result->uniform_data = packet.at("uniform").get<std::vector<std::uint32_t>>();
    result->grid_data = packet.at("grid").get<std::vector<std::uint32_t>>();
    result->width = packet.at("width").get<std::uint32_t>();
    result->mip_count = packet.at("mipCount").get<std::uint32_t>();
    result->layers = packet.at("layers").get<std::uint32_t>();
    result->overrides_environment = packet.at("overridesEnvironment").get<bool>();
    result->material_fields = packet.at("fields").get<std::unordered_map<std::string, std::vector<float>>>();
    for (const auto& copy : packet.at("copies")) result->copies.push_back({
        copy.at("source").get<std::uint32_t>(), copy.at("sourceMip").get<std::uint32_t>(),
        copy.at("sourceLayer").get<std::uint32_t>(), copy.at("mip").get<std::uint32_t>(),
        copy.at("layer").get<std::uint32_t>(), copy.at("size").get<std::uint32_t>()});
    if (result->uniform_data.empty() || result->grid_data.empty() || result->width == 0 ||
        result->mip_count == 0 || result->layers == 0 || result->layers % 6 != 0)
        throw std::runtime_error("Invalid compiled local cubemap resource packet.");
    return result;
}
} // namespace bbl
`};
}
