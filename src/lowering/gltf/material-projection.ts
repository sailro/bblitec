/** Shared source-property to native-field transport for load and animation. */
export const gltfMaterialPropertyFields = [
    {"kind": "number", "owner": "props", "path": [], "key": "metallicFactor", "field": "metallic_factor"},
    {"kind": "number", "owner": "props", "path": [], "key": "roughnessFactor", "field": "roughness_factor"},
    {"kind": "number", "owner": "props", "path": [], "key": "reflectance", "field": "reflectance"},
    {"kind": "number", "owner": "props", "path": [], "key": "normalTextureScale", "field": "normal_texture_scale"},
    {"kind": "number", "owner": "props", "path": [], "key": "occlusionStrength", "field": "occlusion_strength"},
    {"kind": "number", "owner": "props", "path": [], "key": "_alphaCutOff", "field": "alpha_cutoff"},
    {"kind": "number", "owner": "props", "path": [], "key": "alpha", "field": "alpha"},
    {"kind": "number", "owner": "props", "path": [], "key": "_metallicF0Factor", "field": "metallic_f0_factor"},
    {"kind": "number", "owner": "props", "path": [], "key": "_specularWeight", "field": "specular_weight"},
    {"kind": "number", "owner": "refraction", "path": ["_subsurface", "refraction"], "key": "indexOfRefraction", "field": "index_of_refraction"},
    {"kind": "number", "owner": "refraction", "path": ["_subsurface", "refraction"], "key": "intensity", "field": "transmission_factor"},
    {"kind": "number", "owner": "refraction", "path": ["_subsurface", "refraction"], "key": "dispersion", "field": "dispersion"},
    {"kind": "number", "owner": "thickness", "path": ["_subsurface", "thickness"], "key": "max", "field": "thickness"},
    {"kind": "number", "owner": "tint", "path": ["_subsurface", "tint"], "key": "atDistance", "field": "attenuation_distance"},
    {"kind": "number", "owner": "translucency", "path": ["_subsurface", "translucency"], "key": "intensity", "field": "subsurface_intensity"},
    {"kind": "number", "owner": "thickness", "path": ["_subsurface", "thickness"], "key": "min", "field": "subsurface_minimum_thickness"},
    {"kind": "number", "owner": "thickness", "path": ["_subsurface", "thickness"], "key": "max", "field": "subsurface_maximum_thickness"},
    {"kind": "number", "owner": "coat", "path": ["_clearCoat"], "key": "intensity", "field": "clearcoat_intensity"},
    {"kind": "number", "owner": "coat", "path": ["_clearCoat"], "key": "roughness", "field": "clearcoat_roughness"},
    {"kind": "number", "owner": "coat", "path": ["_clearCoat"], "key": "indexOfRefraction", "field": "clearcoat_index_of_refraction"},
    {"kind": "number", "owner": "coat", "path": ["_clearCoat"], "key": "bumpTextureScale", "field": "clearcoat_normal_scale"},
    {"kind": "number", "owner": "sheen", "path": ["_sheen"], "key": "intensity", "field": "sheen_intensity"},
    {"kind": "number", "owner": "sheen", "path": ["_sheen"], "key": "roughness", "field": "sheen_roughness"},
    {"kind": "number", "owner": "iri", "path": ["_iridescence"], "key": "intensity", "field": "iridescence_intensity"},
    {"kind": "number", "owner": "iri", "path": ["_iridescence"], "key": "indexOfRefraction", "field": "iridescence_index_of_refraction"},
    {"kind": "number", "owner": "iri", "path": ["_iridescence"], "key": "minimumThickness", "field": "iridescence_minimum_thickness"},
    {"kind": "number", "owner": "iri", "path": ["_iridescence"], "key": "maximumThickness", "field": "iridescence_maximum_thickness"},
    {"kind": "number", "owner": "anisotropy", "path": ["_anisotropy"], "key": "intensity", "field": "anisotropy_intensity"},
    {"kind": "color", "owner": "props", "path": [], "key": "_unlitColor", "field": "unlit_color"},
    {"kind": "color", "owner": "props", "path": [], "key": "_emissiveColor", "field": "emissive_factor"},
    {"kind": "color", "owner": "props", "path": [], "key": "_metallicReflectanceColor", "field": "metallic_reflectance_color"},
    {"kind": "color", "owner": "tint", "path": ["_subsurface", "tint"], "key": "color", "field": "attenuation_color"},
    {"kind": "color", "owner": "translucency", "path": ["_subsurface", "translucency"], "key": "color", "field": "subsurface_color"},
    {"kind": "color", "owner": "translucency", "path": ["_subsurface", "translucency"], "key": "diffusionDistance", "field": "subsurface_diffusion_distance"},
    {"kind": "color", "owner": "sheen", "path": ["_sheen"], "key": "color", "field": "sheen_color"},
] as const;

function materialProperty(field: string): string {
    const value = gltfMaterialPropertyFields.find(value => value.field === field);
    if (!value) throw new Error(`Unknown glTF material field ${field}.`);
    return `gltf_pbr_${value.kind}(${value.owner}, "${value.key}", material.${value.field});`;
}

export const gltfMaterialTextureFields = [
    {"owner": "props", "path": ["baseColorTexture"], "key": "baseColorTexture", "data": "base_color_texture", "transform": "base_color_transform", "srgb": true},
    {"owner": "props", "path": ["ormTexture"], "key": "ormTexture", "data": "metallic_roughness_texture", "transform": "orm_transform", "srgb": false},
    {"owner": "props", "path": ["normalTexture"], "key": "normalTexture", "data": "normal_texture", "transform": "normal_transform", "srgb": false},
    {"owner": "props", "path": ["emissiveTexture"], "key": "emissiveTexture", "data": "emissive_texture", "transform": "emissive_transform", "srgb": true},
    {"owner": "props", "path": ["_metallicReflectanceTexture"], "key": "_metallicReflectanceTexture", "data": "metallic_reflectance_texture", "transform": "metallic_reflectance_transform", "srgb": false},
    {"owner": "props", "path": ["_reflectanceTexture"], "key": "_reflectanceTexture", "data": "reflectance_texture", "transform": "reflectance_transform", "srgb": false},
    {"owner": "refraction", "path": ["_subsurface", "refraction", "texture"], "key": "texture", "data": "transmission_texture", "transform": "transmission_transform", "srgb": false},
    {"owner": "thickness", "path": ["_subsurface", "thickness", "texture"], "key": "texture", "data": "thickness_texture", "transform": "thickness_transform", "srgb": false},
    {"owner": "translucency", "path": ["_subsurface", "translucency", "colorTexture"], "key": "colorTexture", "data": "translucency_color_texture", "transform": "translucency_color_transform", "srgb": true},
    {"owner": "translucency", "path": ["_subsurface", "translucency", "intensityTexture"], "key": "intensityTexture", "data": "translucency_intensity_texture", "transform": "translucency_intensity_transform", "srgb": false},
    {"owner": "coat", "path": ["_clearCoat", "texture"], "key": "texture", "data": "clearcoat_texture", "transform": "clearcoat_transform", "srgb": false},
    {"owner": "coat", "path": ["_clearCoat", "roughnessTexture"], "key": "roughnessTexture", "data": "clearcoat_roughness_texture", "transform": "clearcoat_roughness_transform", "srgb": false},
    {"owner": "coat", "path": ["_clearCoat", "bumpTexture"], "key": "bumpTexture", "data": "clearcoat_normal_texture", "transform": "clearcoat_normal_transform", "srgb": false},
    {"owner": "sheen", "path": ["_sheen", "texture"], "key": "texture", "data": "sheen_color_texture", "transform": "sheen_transform", "srgb": true},
    {"owner": "sheen", "path": ["_sheen", "roughnessTexture"], "key": "roughnessTexture", "data": "sheen_roughness_texture", "transform": "sheen_roughness_transform", "srgb": false},
    {"owner": "iri", "path": ["_iridescence", "texture"], "key": "texture", "data": "iridescence_texture", "transform": "iridescence_transform", "srgb": true},
    {"owner": "iri", "path": ["_iridescence", "thicknessTexture"], "key": "thicknessTexture", "data": "iridescence_thickness_texture", "transform": "iridescence_thickness_transform", "srgb": true},
    {"owner": "anisotropy", "path": ["_anisotropy", "texture"], "key": "texture", "data": "anisotropy_texture", "transform": "anisotropy_transform", "srgb": false},
    {"owner": "props", "path": ["occlusionTexture"], "key": "occlusionTexture", "data": "occlusion_texture", "transform": "occlusion_transform", "srgb": false},
] as const;

function materialTexture(field: string): string {
    const value = gltfMaterialTextureFields.find(value => value.transform === field);
    if (!value) throw new Error(`Unknown glTF texture field ${field}.`);
    return `project_texture(${value.owner}, "${value.key}", material.${value.data}, material.${value.transform}, ${value.srgb});`;
}

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
    bool base_color_definition,
    const GltfPbrValue& features = GltfPbrValue::array({}),
    bool extended_material = false,
    bool texture_wrap = false,
    bool sampled_material = false,
    GltfTextureCache* texture_cache = nullptr,
    GltfSamplerContext* sampler_context = nullptr,
    const std::function<pal::DecodedImage(const TextureData&)>& decode_image = {},
    bool variant_material = false,
    GltfPbrValue* source_properties = nullptr,
    bool base_color_module = false) {
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
    context.base_color_definition = base_color_definition;
    context.base_color_module = base_color_module;
    const auto upload_texture = [&](GltfMaterialImage bitmap, bool encoded) {
        return GltfMaterialTexture{std::move(bitmap), encoded, std::nullopt, nullptr, sampler_context->default_sampler};
    };
    context.decode_image = [&](const GltfMaterialImage& image) {
        if (image->decoded) return *image->decoded;
        if (!decode_image) throw std::runtime_error("Missing glTF bitmap decoder.");
        return decode_image(image_data(buffer, container, views, images, image->index));
    };
    context.upload_image = [&](const GltfPbrValue& image, bool srgb) {
        const auto upload = [&](GltfMaterialImage bitmap, bool encoded) {
            return GltfPbrValue{upload_texture(std::move(bitmap), encoded)};
        };
        return variant_material ? gltf_variant_upload_image(image, srgb, upload) : gltf_extension_upload_image(image, srgb, upload);
    };
    context.default_textures = [&](const GltfPbrValue& value) { return texture_values(gltf_default_pbr_textures(gltf_pbr_core_storage(value), texture_cache, sampler_context), false); };
    context.sampled_textures = [&](const GltfPbrValue& value) { return texture_values(gltf_sampled_pbr_textures(gltf_pbr_core_storage(value), texture_cache, sampler_context), false); };
    context.extended_textures = [&](const GltfPbrValue& value) {
        std::function<GltfMaterialTexture(GltfMaterialImage, bool)> upload;
        if (variant_material) upload = [&](GltfMaterialImage bitmap, bool encoded) {
            return gltf_pbr_variant_texture(GltfPbrValue{std::move(bitmap)}, GltfPbrValue{encoded}, context).texture();
        };
        return texture_values(gltf_default_pbr_textures_ext(gltf_pbr_core_storage(value), !variant_material && sampled_material, texture_cache, sampler_context, upload), true);
    };
    context.texture = [&](const GltfPbrValue& info, bool srgb) {
        const auto upload = [&](GltfMaterialImage image, bool encoded) {
            return variant_material ? upload_texture(std::move(image), encoded)
                : gltf_cached_material_texture(*texture_cache, std::move(image), encoded, sampler_context->default_sampler);
        };
        const auto wrap_texture = [&](GltfMaterialTexture texture, const GltfPbrValue& selected) {
            return wrap(gltf_wrap_material_texture(std::move(texture), selected.source()));
        };
        return variant_material ? gltf_variant_texture(info, srgb, extension_fetcher, upload, wrap_texture)
            : gltf_extension_texture(info, srgb, extension_fetcher, upload, wrap_texture);
    };
    const auto props = variant_material ? gltf_pbr_build_variant(core_value, features, context)
        : gltf_pbr_build_material(core_value, features, context, GltfPbrValue{extended_material}, GltfPbrValue{sampled_material});
    material.source_pbr_group_builder = props.get("_buildGroup").truthy();
    material.source_gamma_albedo = props.get("_gammaAlbedo").truthy();
    const auto stage = [&](const GltfPbrValue& value, bool srgb) {
        if (value.nullish()) return TextureData{};
        const auto& texture = value.texture();
        if (texture.srgb != srgb) throw std::runtime_error("Unsupported glTF texture color space for material slot.");
        TextureData result;
        if (texture.image) {
            if (texture.image->decoded) {
                const auto& image = *texture.image->decoded;
                result.bytes = image.rgba;
                result.rgba_width = static_cast<std::uint32_t>(image.width);
                result.rgba_height = static_cast<std::uint32_t>(image.height);
            } else result = image_data(buffer, container, views, images, texture.image->index);
        }
        result.sampler = texture.sampler ? *texture.sampler : *sampler_context->default_sampler;
        return result;
    };
    const auto project_texture = [&](const GltfPbrValue& object, const char* key, TextureData& data, TextureTransform& transform, bool srgb) {
        const auto value = object.get(key, true);
        data = stage(value, srgb);
        gltf_pbr_transform(transform, value);
    };
    ${materialTexture("base_color_transform")}
    ${materialTexture("orm_transform")}
    ${materialTexture("normal_transform")}
    ${materialTexture("emissive_transform")}
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
    ${materialProperty("metallic_factor")}
    ${materialProperty("roughness_factor")}
    ${materialProperty("reflectance")}
    ${materialProperty("normal_texture_scale")}
    ${materialProperty("occlusion_strength")}
    material.specular_aa = props.get("enableSpecularAA").truthy();
    material.double_sided = props.get("doubleSided").truthy();
    material.has_uv_transform = props.get("_hasUvTx").truthy();
    material.unlit = props.get("_unlit").truthy();
    ${materialProperty("unlit_color")}
    material.emissive_factor = Color3{static_cast<float>(core._emissiveFactor[0]), static_cast<float>(core._emissiveFactor[1]), static_cast<float>(core._emissiveFactor[2])};
${animationPointerMaterials ? `    material.emissive_base_factor = material.emissive_factor;
    material.emissive_strength = static_cast<float>(gltf_pbr_emissive_strength(core, features));` : ""}
    ${materialProperty("emissive_factor")}
    if (props.get("alphaBlend").truthy()) material.alpha_mode = MaterialAlphaMode::blend;
    else if (!props.get("_alphaCutOff").nullish()) material.alpha_mode = MaterialAlphaMode::mask;
    ${materialProperty("alpha_cutoff")}
    ${materialProperty("alpha")}
    material.has_occlusion_texture = static_cast<bool>(core._occlusionImage);
    if (core._occlusionImage) {
        const auto coord = props.get("occlusionTexCoord");
        const auto uv = coord.nullish() ? 0 : gltf_checked_index(coord.number());
        if (uv > 1) throw std::runtime_error("Reached glTF occlusion texture uses an unsupported texture-coordinate set.");
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
    ${materialTexture("metallic_reflectance_transform")}
    ${materialTexture("reflectance_transform")}
    ${materialProperty("metallic_f0_factor")}
    ${materialProperty("specular_weight")}
    ${materialProperty("metallic_reflectance_color")}
    material.has_metallic_reflectance = !props.get("_metallicF0Factor").nullish() || !props.get("_metallicReflectanceColor").nullish() ||
        !props.get("_metallicReflectanceTexture").nullish() || !props.get("_reflectanceTexture").nullish();
    const auto subsurface = props.get("_subsurface");
    const auto refraction = subsurface.get("refraction", true);
    material.source_transmissive = props.get("_transmissive").truthy();
    if (const auto intensity = refraction.get("intensity", true); !intensity.nullish())
        material.source_refraction_intensity = intensity.number();
    const auto thickness = subsurface.get("thickness", true);
    const auto tint = subsurface.get("tint", true);
    ${materialProperty("index_of_refraction")}
    ${materialProperty("transmission_factor")}
    ${materialProperty("dispersion")}
    material.use_thickness_as_depth = refraction.get("useThicknessAsDepth", true).truthy();
    ${materialProperty("thickness")}
    ${materialProperty("attenuation_color")}
    ${materialProperty("attenuation_distance")}
    material.has_volume = tint.truthy();
    ${materialTexture("transmission_transform")}
    ${materialTexture("thickness_transform")}
    const auto translucency = subsurface.get("translucency", true);
    material.has_subsurface = translucency.truthy();
    ${materialProperty("subsurface_intensity")}
    ${materialProperty("subsurface_color")}
    ${materialProperty("subsurface_diffusion_distance")}
    ${materialProperty("subsurface_minimum_thickness")}
    ${materialProperty("subsurface_maximum_thickness")}
    ${materialTexture("translucency_color_transform")}
    ${materialTexture("translucency_intensity_transform")}
    const auto coat = props.get("_clearCoat");
    ${materialProperty("clearcoat_intensity")}
    ${materialProperty("clearcoat_roughness")}
    ${materialProperty("clearcoat_index_of_refraction")}
    ${materialProperty("clearcoat_normal_scale")}
    ${materialTexture("clearcoat_transform")}
    ${materialTexture("clearcoat_roughness_transform")}
    ${materialTexture("clearcoat_normal_transform")}
    const auto sheen = props.get("_sheen");
    ${materialProperty("sheen_intensity")}
    ${materialProperty("sheen_roughness")}
    ${materialProperty("sheen_color")}
    ${materialTexture("sheen_transform")}
    ${materialTexture("sheen_roughness_transform")}
    if (sheen.get("roughnessTexture", true).nullish()) {
        material.sheen_roughness_texture = material.sheen_color_texture;
        material.sheen_roughness_transform = material.sheen_transform;
    }
    const auto iri = props.get("_iridescence");
    ${materialProperty("iridescence_intensity")}
    ${materialProperty("iridescence_index_of_refraction")}
    ${materialProperty("iridescence_minimum_thickness")}
    ${materialProperty("iridescence_maximum_thickness")}
    ${materialTexture("iridescence_transform")}
    ${materialTexture("iridescence_thickness_transform")}
    const auto anisotropy = props.get("_anisotropy");
    material.has_anisotropy = anisotropy.get("isEnabled", true).truthy();
    ${materialProperty("anisotropy_intensity")}
    if (const auto direction = anisotropy.get("direction", true); !direction.nullish()) {
        if (!direction.is_array() || direction.size() != 2) throw std::runtime_error("Invalid glTF anisotropy direction.");
        material.anisotropy_direction = Vec2{static_cast<float>(direction.at(0).number()), static_cast<float>(direction.at(1).number())};
    }
    ${materialTexture("anisotropy_transform")}
    if (source_properties) *source_properties = props;
    engine.materials.push_back(std::move(material));
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}`;
}
