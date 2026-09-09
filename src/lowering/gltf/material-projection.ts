/** Project source-built options and texture descriptors into native renderer storage. */
export function gltfMaterialProjection(animationPointerMaterials: boolean): string {
    return `void gltf_pbr_number(const GltfPbrValue& object, const char* key, float& field) {
    const auto value = object.get(key, true);
    if (!value.nullish()) field = static_cast<float>(value.number());
}
void gltf_pbr_color(const GltfPbrValue& object, const char* key, Color3& field) {
    const auto value = object.get(key, true);
    if (value.nullish()) return;
    if (!value.is_array() || value.size() != 3) throw std::runtime_error("Invalid glTF material color width.");
    field = Color3{static_cast<float>(value.at(0).number()), static_cast<float>(value.at(1).number()), static_cast<float>(value.at(2).number())};
}
void gltf_pbr_transform(TextureTransform& transform, const GltfPbrValue& texture) {
    gltf_pbr_number(texture, "uScale", transform.u_scale);
    gltf_pbr_number(texture, "vScale", transform.v_scale);
    gltf_pbr_number(texture, "uOffset", transform.u_offset);
    gltf_pbr_number(texture, "vOffset", transform.v_offset);
    gltf_pbr_number(texture, "uAng", transform.rotation);
}
MaterialHandle load_material(
    Engine& engine,
    const JsonObject& material_json,
    const GltfCoreMaterial& core,
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const JsonArray& images,
    const JsonArray& textures,
    const JsonArray& samplers,
    const GltfImageFetcher& extension_fetcher,
    bool animated_base_color,
    const GltfPbrValue& features = GltfPbrValue::array({}),
    bool extended_material = false,
    bool texture_wrap = false,
    bool sampled_material = false,
    GltfTextureCache* texture_cache = nullptr,
    GltfSamplerContext* sampler_context = nullptr) {
    static_cast<void>(material_json);
    MaterialRecord material;
    if (core._baseColorFactor.size() != 4 || core._emissiveFactor.size() != 3)
        throw std::runtime_error("Invalid glTF material color width.");
    const auto core_value = gltf_pbr_core_value(core);
    std::optional<GltfTextureCache> local_texture_cache;
    if (!texture_cache) { local_texture_cache.emplace(); texture_cache = &*local_texture_cache; }
    std::optional<GltfSamplerContext> local_sampler_context;
    if (!sampler_context) { local_sampler_context.emplace(textures, samplers); sampler_context = &*local_sampler_context; }
    const auto wrap = [texture_wrap](GltfMaterialTexture texture) {
        const auto value = GltfPbrValue{texture};
        return texture_wrap ? gltf_pbr_gltf_ext_uv_transform_wrapTexture(value, GltfPbrValue{texture.info}) : value;
    };
    const auto texture_values = [&](const GltfPbrTextures& textures, bool extended) {
        const auto slot = [&](GltfMaterialTexture texture) {
            const auto value = wrap(texture);
            return extended ? gltf_pbr_gltf_pbr_builder_ext_wrapTexCoord(value, GltfPbrValue{texture.info}) : value;
        };
        auto result = GltfPbrValue::object();
        result.set("baseColorTexture", slot(textures.baseColorTexture));
        result.set("ormTexture", slot(textures.ormTexture));
        result.set("normalTexture", slot(textures.normalTexture));
        result.set("emissiveTexture", slot(textures.emissiveTexture));
        result.set("occlusionTexture", slot(textures.occlusionTexture));
        return result;
    };
    GltfPbrContext context;
    context.default_textures = [&](const GltfPbrValue&) { return texture_values(gltf_default_pbr_textures(core, texture_cache, sampler_context), false); };
    context.sampled_textures = [&](const GltfPbrValue&) { return texture_values(gltf_sampled_pbr_textures(core, texture_cache, sampler_context), false); };
    context.extended_textures = [&](const GltfPbrValue&) { return texture_values(gltf_default_pbr_textures_ext(core, sampled_material, texture_cache, sampler_context), true); };
    context.texture = [&](const GltfPbrValue& info, bool srgb) {
        return gltf_extension_texture(info, srgb, extension_fetcher,
            [&](GltfMaterialImage image, bool encoded) { return gltf_cached_material_texture(*texture_cache, std::move(image), encoded, sampler_context->default_sampler); },
            [&](GltfMaterialTexture texture, const GltfPbrValue& selected) { return wrap(gltf_wrap_material_texture(std::move(texture), selected.source())); });
    };
    const auto props = gltf_pbr_build_material(core_value, features, context, GltfPbrValue{extended_material}, GltfPbrValue{sampled_material});
    const auto stage = [&](const GltfPbrValue& value, bool srgb) {
        if (value.nullish()) return TextureData{};
        const auto& texture = value.texture();
        if (texture.srgb != srgb) throw std::runtime_error("Unsupported glTF texture color space for material slot.");
        auto result = texture.image ? image_data(buffer, container, views, images, texture.image->index) : TextureData{};
        result.sampler = texture.sampler ? *texture.sampler : gltf_default_sampler_state();
        return result;
    };
    const auto project_texture = [&](const GltfPbrValue& object, const char* key, TextureData& data, TextureTransform& transform, bool srgb) {
        const auto value = object.get(key, true);
        data = stage(value, srgb);
        gltf_pbr_transform(transform, value);
    };
    project_texture(props, "baseColorTexture", material.base_color_texture, material.base_color_transform, true);
    project_texture(props, "ormTexture", material.metallic_roughness_texture, material.orm_transform, false);
    project_texture(props, "normalTexture", material.normal_texture, material.normal_transform, false);
    project_texture(props, "emissiveTexture", material.emissive_texture, material.emissive_transform, true);
    material.has_public_base_color_texture = props.get("baseColorTexture").truthy();
    if (const auto name = props.get("name"); !name.nullish()) material.name = name.string();
    const auto base_factor = props.get("baseColorFactor");
    if (!base_factor.nullish()) {
        if (!base_factor.is_array() || base_factor.size() != 4) throw std::runtime_error("Invalid glTF base color width.");
        material.source_base_color_factor = std::make_shared<std::vector<double>>();
        for (const auto& lane : base_factor.elements()) material.source_base_color_factor->push_back(lane.number());
        material.base_color_factor = Color4{static_cast<float>(base_factor.at(0).number()), static_cast<float>(base_factor.at(1).number()),
            static_cast<float>(base_factor.at(2).number()), static_cast<float>(base_factor.at(3).number())};
    }
    const auto& base_texture = props.get("baseColorTexture").texture();
    if (base_texture.fallback) material.base_color_fallback = *base_texture.fallback;
    const auto& orm_texture = props.get("ormTexture").texture();
    if (orm_texture.fallback) material.orm_fallback = *orm_texture.fallback;
    if (animated_base_color) {
        material.source_base_color_factor = std::make_shared<std::vector<double>>(core._baseColorFactor);
        const auto& factor = core._baseColorFactor;
        material.base_color_factor = Color4{static_cast<float>(factor[0]), static_cast<float>(factor[1]), static_cast<float>(factor[2]), static_cast<float>(factor[3])};
        if (base_texture.fallback) { material.base_color_fallback = {255, 255, 255, 255}; material.animated_base_color = true; }
    }
    gltf_pbr_number(props, "metallicFactor", material.metallic_factor);
    gltf_pbr_number(props, "roughnessFactor", material.roughness_factor);
    gltf_pbr_number(props, "reflectance", material.reflectance);
    gltf_pbr_number(props, "normalTextureScale", material.normal_texture_scale);
    gltf_pbr_number(props, "occlusionStrength", material.occlusion_strength);
    material.specular_aa = props.get("enableSpecularAA").truthy();
    material.double_sided = props.get("doubleSided").truthy();
    material.has_uv_transform = props.get("_hasUvTx").truthy();
    material.unlit = props.get("_unlit").truthy();
    gltf_pbr_color(props, "_unlitColor", material.unlit_color);
    material.emissive_factor = Color3{static_cast<float>(core._emissiveFactor[0]), static_cast<float>(core._emissiveFactor[1]), static_cast<float>(core._emissiveFactor[2])};
${animationPointerMaterials ? `    material.emissive_base_factor = material.emissive_factor;
    material.emissive_strength = static_cast<float>(gltf_pbr_emissive_strength(core, features));` : ""}
    gltf_pbr_color(props, "_emissiveColor", material.emissive_factor);
    if (props.get("alphaBlend").truthy()) material.alpha_mode = MaterialAlphaMode::blend;
    else if (!props.get("_alphaCutOff").nullish()) material.alpha_mode = MaterialAlphaMode::mask;
    gltf_pbr_number(props, "_alphaCutOff", material.alpha_cutoff);
    if (!animated_base_color) gltf_pbr_number(props, "alpha", material.alpha);
    material.has_occlusion_texture = static_cast<bool>(core._occlusionImage);
    if (core._occlusionImage) {
        const auto coord = props.get("occlusionTexCoord");
        const auto uv = coord.nullish() ? 0 : gltf_checked_index(coord.number());
        if (uv > 1) throw std::runtime_error("Reached glTF occlusion texture uses an unsupported texture-coordinate set.");
        if (core._metallicRoughnessImage && core._metallicRoughnessImage != core._occlusionImage)
            throw std::runtime_error("Reached glTF material uses distinct occlusion and metallic-roughness images.");
        const auto occlusion = props.get("occlusionTexture");
        if (uv == 1 && core._metallicRoughnessImage && occlusion.nullish())
            throw std::runtime_error("Reached glTF occlusion texture on TEXCOORD_1 composes an occlusion binding with no texture.");
        material.has_occlusion_transform = occlusion.truthy();
        gltf_pbr_transform(material.occlusion_transform, occlusion);
        if (uv == 1) material.occlusion_texture = stage(occlusion, false);
        material.occlusion_texture_uv2 = uv == 1;
    }
    const auto spec_gloss = props.get("specGlossTexture");
    if (!spec_gloss.nullish() && texture_transform_value(spec_gloss.texture().info))
        throw std::runtime_error("Reached KHR_materials_pbrSpecularGlossiness supports an untransformed specular-glossiness texture only.");
    material.spec_gloss_texture = stage(spec_gloss, true);
    project_texture(props, "_metallicReflectanceTexture", material.metallic_reflectance_texture, material.metallic_reflectance_transform, false);
    project_texture(props, "_reflectanceTexture", material.reflectance_texture, material.reflectance_transform, false);
    gltf_pbr_number(props, "_metallicF0Factor", material.metallic_f0_factor);
    gltf_pbr_number(props, "_specularWeight", material.specular_weight);
    gltf_pbr_color(props, "_metallicReflectanceColor", material.metallic_reflectance_color);
    material.has_metallic_reflectance = !props.get("_metallicF0Factor").nullish() || !props.get("_metallicReflectanceColor").nullish() ||
        !props.get("_metallicReflectanceTexture").nullish() || !props.get("_reflectanceTexture").nullish();
    const auto subsurface = props.get("_subsurface");
    const auto refraction = subsurface.get("refraction", true);
    const auto thickness = subsurface.get("thickness", true);
    const auto tint = subsurface.get("tint", true);
    gltf_pbr_number(refraction, "indexOfRefraction", material.index_of_refraction);
    gltf_pbr_number(refraction, "intensity", material.transmission_factor);
    gltf_pbr_number(refraction, "dispersion", material.dispersion);
    material.use_thickness_as_depth = refraction.get("useThicknessAsDepth", true).truthy();
    gltf_pbr_number(thickness, "max", material.thickness);
    gltf_pbr_color(tint, "color", material.attenuation_color);
    gltf_pbr_number(tint, "atDistance", material.attenuation_distance);
    material.has_volume = tint.truthy();
    project_texture(refraction, "texture", material.transmission_texture, material.transmission_transform, false);
    project_texture(thickness, "texture", material.thickness_texture, material.thickness_transform, false);
    const auto translucency = subsurface.get("translucency", true);
    material.has_subsurface = translucency.truthy();
    gltf_pbr_number(translucency, "intensity", material.subsurface_intensity);
    gltf_pbr_color(translucency, "color", material.subsurface_color);
    gltf_pbr_color(translucency, "diffusionDistance", material.subsurface_diffusion_distance);
    gltf_pbr_number(thickness, "min", material.subsurface_minimum_thickness);
    gltf_pbr_number(thickness, "max", material.subsurface_maximum_thickness);
    project_texture(translucency, "colorTexture", material.translucency_color_texture, material.translucency_color_transform, true);
    project_texture(translucency, "intensityTexture", material.translucency_intensity_texture, material.translucency_intensity_transform, false);
    const auto coat = props.get("_clearCoat");
    gltf_pbr_number(coat, "intensity", material.clearcoat_intensity);
    gltf_pbr_number(coat, "roughness", material.clearcoat_roughness);
    gltf_pbr_number(coat, "indexOfRefraction", material.clearcoat_index_of_refraction);
    gltf_pbr_number(coat, "bumpTextureScale", material.clearcoat_normal_scale);
    project_texture(coat, "texture", material.clearcoat_texture, material.clearcoat_transform, false);
    project_texture(coat, "roughnessTexture", material.clearcoat_roughness_texture, material.clearcoat_roughness_transform, false);
    project_texture(coat, "bumpTexture", material.clearcoat_normal_texture, material.clearcoat_normal_transform, false);
    const auto sheen = props.get("_sheen");
    gltf_pbr_number(sheen, "intensity", material.sheen_intensity);
    gltf_pbr_number(sheen, "roughness", material.sheen_roughness);
    gltf_pbr_color(sheen, "color", material.sheen_color);
    project_texture(sheen, "texture", material.sheen_color_texture, material.sheen_transform, true);
    project_texture(sheen, "roughnessTexture", material.sheen_roughness_texture, material.sheen_roughness_transform, false);
    if (sheen.get("roughnessTexture", true).nullish()) {
        material.sheen_roughness_texture = material.sheen_color_texture;
        material.sheen_roughness_transform = material.sheen_transform;
    }
    const auto iri = props.get("_iridescence");
    gltf_pbr_number(iri, "intensity", material.iridescence_intensity);
    gltf_pbr_number(iri, "indexOfRefraction", material.iridescence_index_of_refraction);
    gltf_pbr_number(iri, "minimumThickness", material.iridescence_minimum_thickness);
    gltf_pbr_number(iri, "maximumThickness", material.iridescence_maximum_thickness);
    project_texture(iri, "texture", material.iridescence_texture, material.iridescence_transform, true);
    project_texture(iri, "thicknessTexture", material.iridescence_thickness_texture, material.iridescence_thickness_transform, true);
    const auto anisotropy = props.get("_anisotropy");
    material.has_anisotropy = anisotropy.get("isEnabled", true).truthy();
    gltf_pbr_number(anisotropy, "intensity", material.anisotropy_intensity);
    if (const auto direction = anisotropy.get("direction", true); !direction.nullish()) {
        if (!direction.is_array() || direction.size() != 2) throw std::runtime_error("Invalid glTF anisotropy direction.");
        material.anisotropy_direction = Vec2{static_cast<float>(direction.at(0).number()), static_cast<float>(direction.at(1).number())};
    }
    project_texture(anisotropy, "texture", material.anisotropy_texture, material.anisotropy_transform, false);
    engine.materials.push_back(std::move(material));
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}`;
}
