/** Storage and ordered scene writes for the executed EXT_lights_image_based feature. */
export function gltfIblLoadingCpp(): string {
    return `
    const auto& ibl_plan = required(mesh_plan, "ibl").as_object();
    struct IblTextureResource { EnvironmentState environment; std::uint64_t identity; };
    std::vector<IblTextureResource> ibl_textures;
    for (const auto& value : required(ibl_plan, "textures").as_array()) {
        const auto& prepared = value.as_object();
        EnvironmentState environment;
        environment.has_irradiance = true;
        const auto& harmonics = accessors.at(unsigned_value(required(prepared, "harmonics")));
        if (harmonics.type != "VEC4" || harmonics.component_type != 5126 || harmonics.count != 9)
            throw std::runtime_error("Invalid glTF IBL harmonic storage.");
        for (std::size_t index = 0; index < 9; ++index) {
            environment.spherical_harmonics[index] = Color3{
                read_component(buffer, container, views, harmonics, index, 0),
                read_component(buffer, container, views, harmonics, index, 1),
                read_component(buffer, container, views, harmonics, index, 2)};
        }
        environment.specular_width = static_cast<std::uint32_t>(unsigned_value(required(prepared, "width")));
        environment.specular_mip_count = static_cast<std::uint32_t>(unsigned_value(required(prepared, "mipCount")));
        const auto& faces = required(prepared, "faces").as_array();
        if (!environment.specular_width || !environment.specular_mip_count || faces.size() != static_cast<std::size_t>(environment.specular_mip_count) * 6)
            throw std::runtime_error("Invalid glTF IBL cube storage.");
        for (std::size_t index = 0; index < faces.size(); ++index)
            environment.specular_faces.push_back(image_data(buffer, container, views, faces, index));
        environment.lod_generation_scale = static_cast<float>(required(prepared, "lodScale").as_number());
        environment.brdf_lut_width = static_cast<std::uint32_t>(unsigned_value(required(prepared, "brdfWidth")));
        if (environment.brdf_lut_width != 256) throw std::runtime_error("Unsupported glTF IBL BRDF storage.");
        environment.brdf_lut.bytes = pal::read_binary_file(asset_path("gltf-ibl-brdf-lut.rgba16f"));
        environment.brdf_lut_rgba16f = true;
        ibl_textures.push_back({std::move(environment), next_scene_uniform_object_identity()});
    }
    const auto& ibl_setup = required(ibl_plan, "setup").as_array();
    if (!ibl_setup.empty()) {
        asset.scene_setup = [textures = std::move(ibl_textures), writes = ibl_setup](Scene& scene) {
            for (const auto& value : writes) {
                const auto& write = value.as_object();
                const auto& kind = required(write, "kind").as_string();
                if (kind == "textures") {
                    const auto index = unsigned_value(required(write, "index"));
                    const auto& resource = textures.at(index);
                    const auto& source = resource.environment;
                    auto& target = scene.environment;
                    target.has_irradiance = source.has_irradiance;
                    target.spherical_harmonics = source.spherical_harmonics;
                    target.specular_width = source.specular_width;
                    target.specular_mip_count = source.specular_mip_count;
                    target.specular_faces = source.specular_faces;
                    target.specular_rgba16f = source.specular_rgba16f;
                    target.lod_generation_scale = source.lod_generation_scale;
                    target.brdf_lut = source.brdf_lut;
                    target.brdf_lut_width = source.brdf_lut_width;
                    target.brdf_lut_rgba16f = source.brdf_lut_rgba16f;
                    scene.state->environment_identity = resource.identity;
                } else if (kind == "toneMappingEnabled") {
                    scene.environment.tone_mapping_enabled = required(write, "value").as_boolean();
                } else {
                    const auto number = static_cast<float>(required(write, "value").as_number());
                    if (kind == "rotation") scene.environment.rotation_y = number;
                    else if (kind == "exposure") scene.environment.exposure = number;
                    else if (kind == "contrast") scene.environment.contrast = number;
                    else throw std::runtime_error("Invalid glTF IBL scene write.");
                }
            }
        };
    }
`;
}
