/** Aliased option objects for source-lowered glTF material handlers. */
export const gltfMaterialValueRuntime = `double gltf_pbr_extremum(std::initializer_list<double> values, bool maximum) {
    double result = maximum ? -std::numeric_limits<double>::infinity() : std::numeric_limits<double>::infinity();
    for (double value : values) {
        if (std::isnan(value)) return value;
        if ((maximum ? value > result : value < result) ||
            (value == 0.0 && result == 0.0 && std::signbit(value) != maximum)) result = value;
    }
    return result;
}
class GltfPbrValue;
using GltfPbrArray = std::vector<GltfPbrValue>;
struct GltfPbrObject;
class GltfPbrValue {
    using Storage = std::variant<std::monostate, std::nullptr_t, bool, double, std::string,
        const ts::JsonValue*, std::shared_ptr<GltfPbrArray>, std::shared_ptr<GltfPbrObject>, GltfMaterialImage>;
    Storage value_;
public:
    GltfPbrValue() = default;
    GltfPbrValue(std::nullptr_t) : value_(nullptr) {}
    GltfPbrValue(bool value) : value_(value) {}
    GltfPbrValue(double value) : value_(value) {}
    GltfPbrValue(const char* value) : value_(std::string{value}) {}
    GltfPbrValue(std::string value) : value_(std::move(value)) {}
    GltfPbrValue(GltfMaterialImage value) : value_(value ? Storage{std::move(value)} : Storage{nullptr}) {}
    GltfPbrValue(const ts::JsonValue* value);
    GltfPbrValue(const std::vector<double>& value);
    GltfPbrValue(GltfMaterialTexture value);
    static GltfPbrValue object();
    static GltfPbrValue array(std::initializer_list<GltfPbrValue> values);
    bool undefined() const { return std::holds_alternative<std::monostate>(value_); }
    bool nullish() const { return undefined() || std::holds_alternative<std::nullptr_t>(value_); }
    bool is_number() const { return std::holds_alternative<double>(value_); }
    bool is_string() const { return std::holds_alternative<std::string>(value_); }
    bool is_array() const;
    bool truthy() const;
    explicit operator bool() const { return truthy(); }
    double number() const;
    const std::string& string() const;
    std::string text() const;
    const ts::JsonValue* source() const;
    const GltfMaterialTexture& texture() const;
    std::size_t size() const;
    GltfPbrValue get(const std::string& key, bool optional = false) const;
    GltfPbrValue at(double index, bool optional = false) const;
    GltfPbrValue set(const std::string& key, GltfPbrValue value) const;
    void erase(const std::string& key) const;
    void merge(const GltfPbrValue& other) const;
    GltfPbrValue clone() const;
    bool equals(const GltfPbrValue& other) const;
    GltfPbrArray elements() const;
    void push(GltfPbrValue value) const;
    GltfPbrValue add(const GltfPbrValue& other) const;
};
struct GltfPbrObject {
    std::map<std::string, GltfPbrValue> fields;
    std::optional<GltfMaterialTexture> texture;
};
GltfPbrValue::GltfPbrValue(const ts::JsonValue* value) {
    if (!value) return;
    if (value->is_null()) value_ = nullptr;
    else if (value->is_number()) value_ = value->as_number();
    else if (value->is_boolean()) value_ = value->as_boolean();
    else if (value->is_string()) value_ = value->as_string();
    else value_ = value;
}
GltfPbrValue::GltfPbrValue(const std::vector<double>& value) : value_(std::make_shared<GltfPbrArray>()) {
    auto& array = *std::get<std::shared_ptr<GltfPbrArray>>(value_);
    array.reserve(value.size());
    for (double lane : value) array.emplace_back(lane);
}
GltfPbrValue::GltfPbrValue(GltfMaterialTexture value) {
    if (!value) return;
    if (auto shared = value.identity->value.lock()) { value_ = std::move(shared); return; }
    auto object = std::make_shared<GltfPbrObject>();
    value.identity->value = object;
    object->texture = std::move(value);
    value_ = std::move(object);
}
GltfPbrValue GltfPbrValue::object() {
    GltfPbrValue result;
    result.value_ = std::make_shared<GltfPbrObject>();
    return result;
}
GltfPbrValue GltfPbrValue::array(std::initializer_list<GltfPbrValue> values) {
    GltfPbrValue result;
    result.value_ = std::make_shared<GltfPbrArray>(values);
    return result;
}
bool GltfPbrValue::is_array() const {
    if (const auto* source = std::get_if<const ts::JsonValue*>(&value_)) return (*source)->is_array();
    return std::holds_alternative<std::shared_ptr<GltfPbrArray>>(value_);
}
bool GltfPbrValue::truthy() const {
    if (nullish()) return false;
    if (const auto* value = std::get_if<bool>(&value_)) return *value;
    if (const auto* value = std::get_if<double>(&value_)) return *value != 0 && !std::isnan(*value);
    if (const auto* value = std::get_if<std::string>(&value_)) return !value->empty();
    return true;
}
double GltfPbrValue::number() const {
    if (const auto* value = std::get_if<double>(&value_)) return *value;
    if (const auto* value = std::get_if<bool>(&value_)) return *value ? 1.0 : 0.0;
    if (undefined()) return std::numeric_limits<double>::quiet_NaN();
    if (nullish()) return 0.0;
    throw std::runtime_error("Expected a numeric glTF material property.");
}
const std::string& GltfPbrValue::string() const {
    if (const auto* value = std::get_if<std::string>(&value_)) return *value;
    throw std::runtime_error("Expected a string glTF material property.");
}
std::string GltfPbrValue::text() const {
    if (is_string()) return string();
    if (is_number()) return bbl::js::number_to_string(number());
    if (undefined()) return "undefined";
    if (nullish()) return "null";
    if (const auto* value = std::get_if<bool>(&value_)) return *value ? "true" : "false";
    throw std::runtime_error("Unsupported glTF object string conversion.");
}
const ts::JsonValue* GltfPbrValue::source() const {
    if (nullish()) return nullptr;
    if (const auto* source = std::get_if<const ts::JsonValue*>(&value_)) return *source;
    throw std::runtime_error("Expected a source glTF texture descriptor.");
}
const GltfMaterialTexture& GltfPbrValue::texture() const {
    if (const auto* object = std::get_if<std::shared_ptr<GltfPbrObject>>(&value_))
        if ((*object)->texture) return *(*object)->texture;
    throw std::runtime_error("Expected a glTF material texture.");
}
std::size_t GltfPbrValue::size() const {
    if (const auto* source = std::get_if<const ts::JsonValue*>(&value_)) {
        if ((*source)->is_array()) return (*source)->as_array().size();
        return (*source)->as_object().size();
    }
    if (const auto* array = std::get_if<std::shared_ptr<GltfPbrArray>>(&value_)) return (*array)->size();
    if (const auto* object = std::get_if<std::shared_ptr<GltfPbrObject>>(&value_)) return (*object)->fields.size();
    if (const auto* text = std::get_if<std::string>(&value_)) return text->size();
    throw std::runtime_error("Expected a glTF material array or object.");
}
GltfPbrValue GltfPbrValue::get(const std::string& key, bool optional) const {
    if (nullish()) {
        if (optional) return {};
        throw std::runtime_error("Cannot read an absent glTF material object.");
    }
    if (key == "length" && (is_array() || std::holds_alternative<std::string>(value_))) return GltfPbrValue{double(size())};
    if (const auto* source = std::get_if<const ts::JsonValue*>(&value_)) {
        if ((*source)->is_object()) return GltfPbrValue{::bbl::optional((*source)->as_object(), key)};
        return {};
    }
    if (const auto* object = std::get_if<std::shared_ptr<GltfPbrObject>>(&value_)) {
        const auto found = (*object)->fields.find(key);
        return found == (*object)->fields.end() ? GltfPbrValue{} : found->second;
    }
    return {};
}
GltfPbrValue GltfPbrValue::at(double index, bool optional) const {
    if (nullish()) {
        if (optional) return {};
        throw std::runtime_error("Cannot index an absent glTF material array.");
    }
    if (!std::isfinite(index) || index < 0 || std::floor(index) != index || index >= double(size())) return {};
    const auto offset = static_cast<std::size_t>(index);
    if (const auto* source = std::get_if<const ts::JsonValue*>(&value_)) return GltfPbrValue{&(*source)->as_array()[offset]};
    if (const auto* array = std::get_if<std::shared_ptr<GltfPbrArray>>(&value_)) return (**array)[offset];
    throw std::runtime_error("Expected an indexed glTF material array.");
}
GltfPbrValue GltfPbrValue::set(const std::string& key, GltfPbrValue value) const {
    if (const auto* object = std::get_if<std::shared_ptr<GltfPbrObject>>(&value_)) {
        (*object)->fields[key] = value;
        return value;
    }
    throw std::runtime_error("Expected a mutable glTF material object.");
}
void GltfPbrValue::erase(const std::string& key) const {
    if (const auto* object = std::get_if<std::shared_ptr<GltfPbrObject>>(&value_)) { (*object)->fields.erase(key); return; }
    throw std::runtime_error("Expected a mutable glTF material object.");
}
void GltfPbrValue::merge(const GltfPbrValue& other) const {
    if (other.nullish()) return;
    if (const auto* source = std::get_if<const ts::JsonValue*>(&other.value_)) {
        for (const auto& [key, value] : (*source)->as_object()) set(key, GltfPbrValue{&value});
        return;
    }
    if (const auto* object = std::get_if<std::shared_ptr<GltfPbrObject>>(&other.value_)) {
        for (const auto& [key, value] : (*object)->fields) set(key, value);
        return;
    }
    if (std::holds_alternative<bool>(other.value_) || std::holds_alternative<double>(other.value_)) return;
    throw std::runtime_error("Expected glTF material object spread properties.");
}
GltfPbrValue GltfPbrValue::clone() const {
    if (const auto* object = std::get_if<std::shared_ptr<GltfPbrObject>>(&value_)) {
        GltfPbrValue result;
        auto copied = std::make_shared<GltfPbrObject>(**object);
        if (copied->texture) {
            copied->texture = copied->texture->clone();
            copied->texture->identity->value = copied;
        }
        result.value_ = std::move(copied);
        return result;
    }
    auto result = GltfPbrValue::object();
    result.merge(*this);
    return result;
}
bool GltfPbrValue::equals(const GltfPbrValue& other) const {
    if (value_.index() != other.value_.index()) return false;
    return value_ == other.value_;
}
GltfPbrArray GltfPbrValue::elements() const {
    if (!is_array()) throw std::runtime_error("Expected a glTF material array.");
    if (const auto* array = std::get_if<std::shared_ptr<GltfPbrArray>>(&value_)) return **array;
    GltfPbrArray result;
    for (const auto& element : std::get<const ts::JsonValue*>(value_)->as_array()) result.emplace_back(&element);
    return result;
}
void GltfPbrValue::push(GltfPbrValue value) const {
    if (const auto* array = std::get_if<std::shared_ptr<GltfPbrArray>>(&value_)) { (*array)->push_back(std::move(value)); return; }
    throw std::runtime_error("Expected a mutable glTF material array.");
}
GltfPbrValue GltfPbrValue::add(const GltfPbrValue& other) const {
    if (is_string() && other.is_string()) return GltfPbrValue{string() + other.string()};
    return GltfPbrValue{number() + other.number()};
}
template<class Callback> GltfPbrValue gltf_pbr_map(const GltfPbrValue& array, Callback callback) {
    auto result = GltfPbrValue::array({});
    for (const auto& value : array.elements()) result.push(callback(value));
    return result;
}
template<class Callback> GltfPbrValue gltf_pbr_some(const GltfPbrValue& array, Callback callback) {
    for (const auto& value : array.elements()) if (callback(value).truthy()) return GltfPbrValue{true};
    return GltfPbrValue{false};
}
GltfPbrValue gltf_pbr_includes(const GltfPbrValue& array, const GltfPbrValue& value) {
    if (array.is_string()) return GltfPbrValue{array.string().find(value.string()) != std::string::npos};
    for (const auto& element : array.elements())
        if (element.equals(value) || (element.is_number() && value.is_number() && std::isnan(element.number()) && std::isnan(value.number()))) return GltfPbrValue{true};
    return GltfPbrValue{false};
}
[[maybe_unused]] GltfPbrValue gltf_pbr_stringify_source(const GltfPbrValue& value) {
    const auto* source = value.source();
    if (!source) throw std::runtime_error("Expected source JSON for glTF serialization.");
    return GltfPbrValue{source->stringify()};
}`;
