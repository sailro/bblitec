/** Resolve serialized source captures against their retained native owners. */
export const gltfAnimationPointerOwnersCpp = `struct GltfAnimationPointerCaptureOwners {
    std::function<GltfPbrValue(std::size_t)> node;
    std::function<GltfPbrValue(std::size_t, const std::vector<std::string>&)> material;
    GltfPbrValue document;
    GltfPbrValue context;
    std::function<GltfPbrValue(const std::string&, GltfPbrValue)> bind_closure;
};
GltfPbrValue read_gltf_animation_pointer_capture(const ts::JsonValue& source, const GltfAnimationPointerCaptureOwners& owners) {
    const auto& fields = source.as_object();
    const auto& kind = fields.at("kind").as_string();
    const auto index = [&]() {
        const auto value = fields.at("index").as_number();
        if (!std::isfinite(value) || value < 0 || value > 9007199254740991.0 || std::floor(value) != value ||
            value >= static_cast<double>(std::numeric_limits<std::size_t>::max()))
            throw std::runtime_error("Invalid source pointer capture index.");
        return static_cast<std::size_t>(value);
    };
    if (kind == "undefined") return {};
    if (kind == "literal") {
        const auto& value = fields.at("value");
        if (value.is_array() || value.is_object()) throw std::runtime_error("Invalid source pointer literal.");
        return GltfPbrValue{&value};
    }
    if (kind == "document") return owners.document;
    if (kind == "context") return owners.context;
    if (kind == "node") return owners.node(index());
    if (kind == "material") {
        std::vector<std::string> path;
        for (const auto& part : fields.at("path").as_array()) path.push_back(part.as_string());
        return owners.material(index(), path);
    }
    if (kind == "array") {
        auto values = GltfPbrValue::array({});
        for (const auto& item : fields.at("values").as_array()) values.push(read_gltf_animation_pointer_capture(item, owners));
        return values;
    }
    if (kind == "closure") {
        auto captures = GltfPbrValue::object();
        for (const auto& [name, value] : fields.at("values").as_object()) captures.set(name, read_gltf_animation_pointer_capture(value, owners));
        return owners.bind_closure(fields.at("site").as_string(), std::move(captures));
    }
    throw std::runtime_error("Unrepresented source pointer capture kind.");
}`;
