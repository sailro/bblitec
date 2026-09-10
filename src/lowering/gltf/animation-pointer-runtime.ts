import {gltfMaterialPropertyFields, gltfMaterialTextureFields} from "./material-projection.js";

const transforms = [["uScale", "u_scale"], ["vScale", "v_scale"], ["uOffset", "u_offset"],
    ["vOffset", "v_offset"], ["uAng", "rotation"]] as const;
const path = (parts: readonly string[]) => `{${parts.map(part => JSON.stringify(part)).join(", ")}}`;

/** Live native fields are storage leaves; source writers retain all guards and arithmetic. */
export function gltfAnimationPointerRuntimeCpp(): string {
    const fields = [...gltfMaterialPropertyFields,
        {kind: "color", path: [], key: "_animEmissiveFactor", field: "emissive_base_factor"},
        {kind: "number", path: [], key: "_animEmissiveStrength", field: "emissive_strength"},
    ];
    const numeric = fields.flatMap(field => field.kind === "number" ? [{path: field.path, key: field.key, field: field.field, lane: -1}]
        : ["r", "g", "b"].map((lane, index) => ({path: field.path, key: field.key, field: `${field.field}.${lane}`, lane: index})));
    const texture = gltfMaterialTextureFields.flatMap(slot => transforms.map(([key, field]) =>
        ({path: slot.path, key, field: `${slot.transform}.${field}`, lane: -1})));
    const slots = [...numeric, ...texture];
    const readSource = slots.map(slot => `gltf_pointer_number(gltf_pointer_path(props, ${path(slot.path)}), ${JSON.stringify(slot.key)}, ${slot.lane})`);
    const observe = slots.map(slot => `static_cast<double>(material.${slot.field})`).join(", ");
    const refresh = slots.map((slot, index) => `        refresh_number(${path(slot.path)}, ${JSON.stringify(slot.key)}, ${slot.lane},
            static_cast<double>(material.${slot.field}), observed[${index}]);`).join("\n");
    const publish = slots.map((slot, index) => `        if (gltf_pointer_number_changed(source[${index}], observed_source[${index}]) && source[${index}])
            material.${slot.field} = static_cast<float>(*source[${index}]);`).join("\n");
    const refractionIndex = slots.findIndex(slot => slot.field === "transmission_factor");
    return `GltfPbrValue gltf_pointer_path(GltfPbrValue value, std::initializer_list<const char*> path) {
    for (const auto* key : path) value = value.get(key, true);
    return value;
}
GltfPbrValue gltf_pointer_material_value(const ts::JsonValue& value) {
    const auto& fields = value.as_object();
    const auto& kind = fields.at("kind").as_string();
    if (kind == "undefined") return {};
    if (kind == "literal") return GltfPbrValue{&fields.at("value")};
    if (kind == "number") {
        const auto& number = fields.at("value");
        if (number.is_number()) return GltfPbrValue{number.as_number()};
        const auto& special = number.as_string();
        if (special == "-0") return GltfPbrValue{-0.0};
        if (special == "NaN") return GltfPbrValue{std::numeric_limits<double>::quiet_NaN()};
        if (special == "Infinity") return GltfPbrValue{std::numeric_limits<double>::infinity()};
        if (special == "-Infinity") return GltfPbrValue{-std::numeric_limits<double>::infinity()};
    }
    if (kind == "array") {
        auto result = GltfPbrValue::array({});
        for (const auto& item : fields.at("values").as_array()) result.push(gltf_pointer_material_value(item));
        return result;
    }
    if (kind == "object") {
        auto result = GltfPbrValue::object();
        for (const auto& [key, item] : fields.at("fields").as_object()) result.set(key, gltf_pointer_material_value(item));
        return result;
    }
    throw std::runtime_error("Invalid source pointer material value.");
}
std::optional<double> gltf_pointer_number(const GltfPbrValue& owner, const char* key, int lane = -1) {
    auto value = owner.get(key, true);
    if (lane >= 0) value = value.at(static_cast<double>(lane), true);
    return value.nullish() ? std::nullopt : std::optional<double>{value.number()};
}
bool gltf_pointer_number_changed(const std::optional<double>& value, const std::optional<double>& previous) {
    if (value.has_value() != previous.has_value()) return true;
    return value && std::bit_cast<std::uint64_t>(*value) != std::bit_cast<std::uint64_t>(*previous);
}
void gltf_pointer_material_patch(GltfPbrValue props, const ts::JsonValue& value) {
    const auto& patch = value.as_object();
    const auto& path = patch.at("path").as_array();
    if (path.empty()) throw std::runtime_error("Invalid source pointer material patch path.");
    for (std::size_t index = 0; index + 1 < path.size(); ++index) props = props.get(path[index].as_string());
    const auto& key = path.back().as_string();
    const auto& operation = patch.at("operation").as_string();
    if (operation == "set") props.set(key, gltf_pointer_material_value(patch.at("value")));
    else if (operation == "clone") props.set(key, props.get(key).clone());
    else if (operation == "erase") props.erase(key);
    else throw std::runtime_error("Invalid source pointer material patch operation.");
}
struct GltfAnimationPointerMaterial {
    MaterialHandle handle;
    GltfPbrValue props;
    std::array<double, ${slots.length}> observed{};
    std::array<std::optional<double>, ${slots.length}> observed_source{};
    std::array<bool, 2> observed_flags{};
    std::array<bool, 5> source_flags{};
    std::shared_ptr<std::vector<double>> observed_base;
    std::optional<double> observed_refraction;
    bool observed_transmissive = false;
    std::uint64_t orm_generation = 0, occlusion_generation = 0;

    GltfAnimationPointerMaterial(Engine& engine, MaterialHandle material, GltfPbrValue properties)
        : handle(material), props(std::move(properties)) {
        const auto& record = engine.materials.at(handle.value);
        if (record.source_base_color_factor) props.set("baseColorFactor", GltfPbrValue{record.source_base_color_factor});
        orm_generation = record.orm_texture_generation;
        occlusion_generation = record.occlusion_texture_generation;
        observe(record);
    }
    void observe(const MaterialRecord& material) {
        observed_source = {${readSource.join(", ")}};
        source_flags = flags();
        observe_native(material);
    }
    void observe_native(const MaterialRecord& material) {
        observed = {${observe}};
        observed_flags = {material.has_uv_transform, material.use_thickness_as_depth};
        observed_base = material.source_base_color_factor;
        observed_refraction = material.source_refraction_intensity;
        observed_transmissive = material.source_transmissive;
    }
    std::array<bool, 5> flags() const {
        return {props.get("_hasUvTx").truthy(), props.get("_transmissive").truthy(),
            gltf_pointer_path(props, {"_subsurface", "refraction", "useThicknessAsDepth"}).truthy(),
            gltf_pointer_path(props, {"_subsurface", "tint"}).truthy(),
            !props.get("_metallicF0Factor").nullish() || !props.get("_metallicReflectanceColor").nullish() ||
                !props.get("_metallicReflectanceTexture").nullish() || !props.get("_reflectanceTexture").nullish()};
    }
    void refresh_number(std::initializer_list<const char*> path, const char* key, int lane, double value, double previous) {
        if (std::bit_cast<std::uint64_t>(value) == std::bit_cast<std::uint64_t>(previous)) return;
        auto owner = props;
        for (const auto* part : path) {
            auto next = owner.get(part);
            if (next.nullish()) { next = GltfPbrValue::object(); owner.set(part, next); }
            owner = next;
        }
        if (lane < 0) owner.set(key, GltfPbrValue{value});
        else {
            auto color = owner.get(key);
            if (color.nullish()) { color = GltfPbrValue::array({}); owner.set(key, color); }
            color.set_at(static_cast<double>(lane), GltfPbrValue{value});
        }
    }
    void replace_texture(const char* key, const TextureTransform& transform) {
        auto texture = GltfPbrValue::object();
${transforms.map(([key, field]) => `        texture.set(${JSON.stringify(key)}, GltfPbrValue{static_cast<double>(transform.${field})});`).join("\n")}
        props.set(key, texture);
    }
    void refresh(Engine& engine) {
        const auto& material = engine.materials.at(handle.value);
        if (orm_generation != material.orm_texture_generation) {
            replace_texture("ormTexture", material.orm_transform); orm_generation = material.orm_texture_generation;
        }
        if (occlusion_generation != material.occlusion_texture_generation) {
            replace_texture("occlusionTexture", material.occlusion_transform); occlusion_generation = material.occlusion_texture_generation;
        }
        if (observed_base != material.source_base_color_factor)
            props.set("baseColorFactor", GltfPbrValue{material.source_base_color_factor});
${refresh}
        if (observed_refraction != material.source_refraction_intensity) {
            auto refraction = gltf_pointer_path(props, {"_subsurface", "refraction"});
            if (!refraction.nullish()) refraction.set("intensity", material.source_refraction_intensity
                ? GltfPbrValue{*material.source_refraction_intensity} : GltfPbrValue{});
        }
        if (observed_transmissive != material.source_transmissive)
            props.set("_transmissive", GltfPbrValue{material.source_transmissive});
        if (observed_flags[0] != material.has_uv_transform) props.set("_hasUvTx", GltfPbrValue{material.has_uv_transform});
        if (observed_flags[1] != material.use_thickness_as_depth) {
            const auto refraction = gltf_pointer_path(props, {"_subsurface", "refraction"});
            if (!refraction.nullish()) refraction.set("useThicknessAsDepth", GltfPbrValue{material.use_thickness_as_depth});
        }
    }
    void publish(Engine& engine) {
        auto& material = engine.materials.at(handle.value);
        const std::array<std::optional<double>, ${slots.length}> source = {${readSource.join(", ")}};
${publish}
        if (const auto base = props.get("baseColorFactor"); !base.nullish()) {
            if (base.size() != 4) throw std::runtime_error("Invalid source pointer base-color width.");
            material.source_base_color_factor = base.numeric_array();
            props.set("baseColorFactor", GltfPbrValue{material.source_base_color_factor});
            project_material_source_colors(material);
        }
        const auto current_flags = flags();
        if (source_flags[0] != current_flags[0]) material.has_uv_transform = current_flags[0];
        if (source_flags[1] != current_flags[1]) material.source_transmissive = current_flags[1];
        if (source_flags[2] != current_flags[2]) material.use_thickness_as_depth = current_flags[2];
        if (source_flags[3] != current_flags[3]) material.has_volume = current_flags[3];
        if (gltf_pointer_number_changed(source[${refractionIndex}], observed_source[${refractionIndex}]))
            material.source_refraction_intensity = source[${refractionIndex}];
        if (source_flags[4] != current_flags[4]) material.has_metallic_reflectance = current_flags[4];
        observed_source = source;
        source_flags = current_flags;
        observe_native(material);
    }
};
struct GltfAnimationPointerLight {
    LightHandle handle;
    GltfPbrValue props = GltfPbrValue::object();
    std::array<double, 9> observed{};
    std::array<std::optional<double>, 9> observed_source{};
    GltfAnimationPointerLight(const Engine& engine, LightHandle light, const ts::JsonValue& source) : handle(light) {
        const auto& fields = source.as_object();
        props.set("lightType", GltfPbrValue{&fields.at("kind")});
        props.set("intensity", GltfPbrValue{&fields.at("intensity")});
        for (const auto* key : {"diffuse", "specular"}) {
            auto color = GltfPbrValue::array({});
            for (const auto& value : fields.at(key).as_array()) color.push(GltfPbrValue{value.as_number()});
            props.set(key, color);
        }
        if (const auto found = fields.find("range"); found != fields.end()) props.set("range", GltfPbrValue{&found->second});
        if (const auto found = fields.find("spot"); found != fields.end()) props.set("angle", GltfPbrValue{&found->second.as_object().at("angle")});
        if (fields.at("bumpVersion").as_boolean()) props.set("_bumpLightVersion", GltfPbrValue{true});
        props.set("__nativeLight", GltfPbrValue{static_cast<double>(handle.value)});
        observe(engine.lights.at(handle.value));
    }
    void observe(const LightRecord& light) {
        observed_source = source();
        observe_native(light);
    }
    void observe_native(const LightRecord& light) {
        observed = {light.intensity, light.range, light.angle, light.diffuse_color.r, light.diffuse_color.g, light.diffuse_color.b,
            light.specular_color.r, light.specular_color.g, light.specular_color.b};
    }
    std::array<std::optional<double>, 9> source() const {
        return {gltf_pointer_number(props, "intensity"), gltf_pointer_number(props, "range"), gltf_pointer_number(props, "angle"),
            gltf_pointer_number(props, "diffuse", 0), gltf_pointer_number(props, "diffuse", 1), gltf_pointer_number(props, "diffuse", 2),
            gltf_pointer_number(props, "specular", 0), gltf_pointer_number(props, "specular", 1), gltf_pointer_number(props, "specular", 2)};
    }
    void refresh(const Engine& engine) {
        const auto& light = engine.lights.at(handle.value);
        const std::array<double, 9> current = {light.intensity, light.range, light.angle, light.diffuse_color.r, light.diffuse_color.g,
            light.diffuse_color.b, light.specular_color.r, light.specular_color.g, light.specular_color.b};
        for (std::size_t index = 0; index < current.size(); ++index) {
            if (std::bit_cast<std::uint64_t>(current[index]) == std::bit_cast<std::uint64_t>(observed[index])) continue;
            if (index < 3) props.set(std::array<const char*, 3>{"intensity", "range", "angle"}[index], GltfPbrValue{current[index]});
            else props.get(index < 6 ? "diffuse" : "specular").set_at(static_cast<double>((index - 3) % 3), GltfPbrValue{current[index]});
        }
    }
    void publish(Engine& engine, const std::function<void(Engine&, LightHandle, double)>& set_angle) {
        auto& light = engine.lights.at(handle.value);
        const auto values = source();
        const std::array<float*, 8> fields = {&light.intensity, &light.range, &light.diffuse_color.r, &light.diffuse_color.g,
            &light.diffuse_color.b, &light.specular_color.r, &light.specular_color.g, &light.specular_color.b};
        for (std::size_t field = 0; field < fields.size(); ++field) {
            const auto index = field < 2 ? field : field + 1;
            if (gltf_pointer_number_changed(values[index], observed_source[index]) && values[index]) *fields[field] = static_cast<float>(*values[index]);
        }
        if (const auto angle = props.get("angle"); !angle.nullish() &&
            std::bit_cast<std::uint64_t>(angle.number()) != std::bit_cast<std::uint64_t>(light.angle)) {
            if (!set_angle) throw std::runtime_error("Missing source spot angle setter.");
            set_angle(engine, handle, angle.number());
        }
        observed_source = values;
        observe_native(light);
    }
};
struct GltfAnimationPointerRuntime {
    Engine* engine = nullptr;
    std::vector<MaterialHandle> handles;
    std::vector<GltfPbrValue> properties;
    std::map<std::size_t, std::shared_ptr<GltfAnimationPointerMaterial>> materials;
    std::function<GltfPbrValue(std::size_t)> node;
    GltfPbrValue document;
    GltfAnimationPointerEffects effects;
    std::map<std::uint32_t, GltfAnimationPointerLight> lights;
    std::vector<std::uint32_t> touched_lights;
    std::function<std::optional<LightHandle>(std::size_t)> lookup_light;
    std::function<void(Engine&, LightHandle, double)> set_light_angle;
    std::function<void(Engine&, LightHandle)> bump_light_version;
    void add_light(LightHandle handle, const ts::JsonValue& source) {
        lights.try_emplace(handle.value, *engine, handle, source);
    }
    void configure_light_effects() {
        effects.lookup_light = [this](GltfPbrValue owner, GltfPbrValue index) {
            if (!owner.equals(document)) throw std::runtime_error("Unrepresented source light document owner.");
            const auto target = lookup_light ? lookup_light(gltf_checked_index(index.number())) : std::nullopt;
            if (!target) return GltfPbrValue{nullptr};
            auto& light = lights.at(target->value);
            light.refresh(*engine);
            if (std::find(touched_lights.begin(), touched_lights.end(), target->value) == touched_lights.end()) touched_lights.push_back(target->value);
            return light.props;
        };
        effects.bump_light_version = [this](GltfPbrValue owner) {
            auto& light = lights.at(static_cast<std::uint32_t>(gltf_checked_index(owner.get("__nativeLight").number())));
            light.publish(*engine, set_light_angle);
            if (bump_light_version) bump_light_version(*engine, light.handle);
            return GltfPbrValue{};
        };
    }
    void finish_lights() {
        for (auto index : touched_lights) lights.at(index).publish(*engine, set_light_angle);
        touched_lights.clear();
    }
    std::shared_ptr<GltfAnimationPointerMaterial> material(std::size_t index) {
        if (!engine) throw std::runtime_error("Missing source pointer engine.");
        auto& binding = materials[index];
        if (!binding) binding = std::make_shared<GltfAnimationPointerMaterial>(*engine, handles.at(index), properties.at(index));
        return binding;
    }
    void initialize(const ts::JsonValue& states) {
        for (const auto& state : states.as_array()) {
            const auto& fields = state.as_object();
            const auto index = gltf_checked_index(fields.at("index").as_number());
            const auto binding = material(index);
            for (const auto& patch : fields.at("patches").as_array()) gltf_pointer_material_patch(binding->props, patch);
            binding->publish(*engine);
        }
    }
};
struct GltfAnimationPointerProgram {
    struct Closure { GltfAnimationPointerFunction function; GltfPbrValue captures; };
    std::shared_ptr<GltfAnimationPointerRuntime> runtime;
    std::vector<Closure> closures;
    std::vector<std::shared_ptr<GltfAnimationPointerMaterial>> materials;
    GltfAnimationPointerEffects effects;
    std::size_t entry = 0;

    void bind(const ts::JsonValue& source) {
        effects = runtime->effects;
        effects.invoke_closure = [this](GltfPbrValue value) {
            const auto& closure = closures.at(gltf_checked_index(value.number()));
            return closure.function(effects, closure.captures, {}, {});
        };
        GltfAnimationPointerCaptureOwners owners;
        owners.node = runtime->node;
        owners.document = runtime->document;
        owners.context = GltfPbrValue::object(); owners.context.set("_json", owners.document);
        owners.material = [this](std::size_t index, const std::vector<std::string>& path) {
            auto material = runtime->material(index);
            if (std::find(materials.begin(), materials.end(), material) == materials.end()) materials.push_back(material);
            auto value = material->props;
            for (const auto& key : path) value = value.get(key);
            if (value.nullish()) throw std::runtime_error("Missing source pointer captured material owner.");
            return value;
        };
        owners.bind_closure = [this](const std::string& site, GltfPbrValue captures) {
            closures.push_back({gltf_animation_pointer_function(site), std::move(captures)});
            return GltfPbrValue{static_cast<double>(closures.size() - 1)};
        };
        entry = gltf_checked_index(read_gltf_animation_pointer_capture(source, owners).number());
    }
    void run(const std::vector<float>& output, double offset) {
        for (const auto& material : materials) material->refresh(*runtime->engine);
        const auto& closure = closures.at(entry);
        closure.function(effects, closure.captures, GltfPbrValue::float32(output), GltfPbrValue{offset});
        for (const auto& material : materials) material->publish(*runtime->engine);
        runtime->finish_lights();
    }
};
js::Callback<void(const std::vector<float>&, double)> gltf_bind_animation_pointer(
    const std::shared_ptr<GltfAnimationPointerRuntime>& runtime, const ts::JsonValue& source) {
    auto program = std::make_shared<GltfAnimationPointerProgram>();
    program->runtime = runtime;
    program->bind(source);
    return [program = std::move(program)](const std::vector<float>& output, double offset) { program->run(output, offset); };
}`;
}
