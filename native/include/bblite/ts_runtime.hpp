#pragma once

#include <bblite/js_data.hpp>

#include <cstddef>
#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
#include <utility>
#include <variant>
#include <vector>

#ifndef JSON_USE_IMPLICIT_CONVERSIONS
#define JSON_USE_IMPLICIT_CONVERSIONS 0
#endif
#include <nlohmann/json.hpp>

namespace bbl::ts {

using ArrayBuffer = js::ArrayBuffer;
using Uint8Array = js::U8Array;
using DataView = js::DataView;

class TextDecoder {
  public:
    [[nodiscard]] std::string decode(const Uint8Array& bytes) const {
        return std::string(reinterpret_cast<const char*>(bytes.data()), bytes.length());
    }
};

class JsonValue {
  public:
    using Array = std::vector<JsonValue>;
    using Object = std::map<std::string, JsonValue>;
    using Storage = std::variant<std::nullptr_t, bool, double, std::string, Array, Object>;

    JsonValue() : storage_(nullptr) {}
    explicit JsonValue(Storage storage) : storage_(std::move(storage)) {}

    [[nodiscard]] const Object& as_object() const { return require<Object>("object"); }
    [[nodiscard]] const Array& as_array() const { return require<Array>("array"); }
    [[nodiscard]] const std::string& as_string() const { return require<std::string>("string"); }
    [[nodiscard]] double as_number() const { return require<double>("number"); }
    [[nodiscard]] bool as_boolean() const { return require<bool>("boolean"); }

    static JsonValue from_native(const nlohmann::json& value) {
        if (value.is_null()) return JsonValue();
        if (value.is_boolean()) return JsonValue(Storage{value.get<bool>()});
        if (value.is_number()) return JsonValue(Storage{value.get<double>()});
        if (value.is_string()) return JsonValue(Storage{value.get<std::string>()});
        if (value.is_array()) {
            Array result;
            result.reserve(value.size());
            for (const nlohmann::json& element : value) result.push_back(from_native(element));
            return JsonValue(Storage{std::move(result)});
        }
        if (value.is_object()) {
            Object result;
            for (auto iterator = value.begin(); iterator != value.end(); ++iterator) {
                result.emplace(iterator.key(), from_native(iterator.value()));
            }
            return JsonValue(Storage{std::move(result)});
        }
        throw std::runtime_error("Unsupported JSON value kind.");
    }

  private:
    template <typename T>
    [[nodiscard]] const T& require(const char* expected) const {
        const T* value = std::get_if<T>(&storage_);
        if (!value) throw std::runtime_error(std::string("Expected JSON ") + expected + ".");
        return *value;
    }

    Storage storage_;
};

inline JsonValue json_parse(const std::string& text) {
    return JsonValue::from_native(nlohmann::json::parse(text));
}

template <typename T>
class Promise {
  public:
    explicit Promise(T value) : value_(std::move(value)) {}
    T& value() { return value_; }

  private:
    T value_;
};

template <typename T>
T await(Promise<T> promise) {
    return std::move(promise.value());
}

} // namespace bbl::ts
