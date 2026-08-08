#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <functional>
#include <map>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

#ifndef JSON_USE_IMPLICIT_CONVERSIONS
#define JSON_USE_IMPLICIT_CONVERSIONS 0
#endif
#include <nlohmann/json.hpp>

namespace bbl::ts {

class ArrayBuffer {
  public:
    ArrayBuffer() = default;
    explicit ArrayBuffer(std::size_t size) : bytes_(size) {}
    explicit ArrayBuffer(std::vector<std::uint8_t> bytes) : bytes_(std::move(bytes)) {}

    [[nodiscard]] std::size_t byte_length() const { return bytes_.size(); }
    [[nodiscard]] const std::uint8_t* data() const { return bytes_.data(); }
    [[nodiscard]] std::uint8_t* data() { return bytes_.data(); }
    [[nodiscard]] const std::vector<std::uint8_t>& bytes() const { return bytes_; }

    [[nodiscard]] ArrayBuffer slice(std::size_t start, std::size_t end) const {
        start = std::min(start, bytes_.size());
        end = std::clamp(end, start, bytes_.size());
        return ArrayBuffer(std::vector<std::uint8_t>(bytes_.begin() + start, bytes_.begin() + end));
    }

  private:
    std::vector<std::uint8_t> bytes_;
};

template <typename T>
class TypedArray {
  public:
    TypedArray() = default;
    explicit TypedArray(std::size_t length) : values_(length) {}
    explicit TypedArray(std::vector<T> values) : values_(std::move(values)) {}
    TypedArray(const ArrayBuffer& buffer, std::size_t byte_offset, std::size_t length) : values_(length) {
        const std::size_t byte_length = length * sizeof(T);
        if (byte_offset + byte_length > buffer.byte_length()) {
            throw std::runtime_error("TypedArray view exceeds ArrayBuffer.");
        }
        std::memcpy(values_.data(), buffer.data() + byte_offset, byte_length);
    }

    [[nodiscard]] std::size_t length() const { return values_.size(); }
    [[nodiscard]] std::size_t byte_length() const { return values_.size() * sizeof(T); }
    [[nodiscard]] T* data() { return values_.data(); }
    [[nodiscard]] const T* data() const { return values_.data(); }
    T& operator[](std::size_t index) { return values_.at(index); }
    const T& operator[](std::size_t index) const { return values_.at(index); }
    [[nodiscard]] const std::vector<T>& values() const { return values_; }

  private:
    std::vector<T> values_;
};

using Uint8Array = TypedArray<std::uint8_t>;
using Uint16Array = TypedArray<std::uint16_t>;
using Uint32Array = TypedArray<std::uint32_t>;
using Float32Array = TypedArray<float>;

class DataView {
  public:
    explicit DataView(const ArrayBuffer& buffer, std::size_t byte_offset = 0, std::size_t byte_length = 0)
        : buffer_(&buffer),
          byte_offset_(byte_offset),
          byte_length_(byte_length == 0 ? buffer.byte_length() - byte_offset : byte_length) {
        if (byte_offset_ + byte_length_ > buffer.byte_length()) {
            throw std::runtime_error("DataView exceeds ArrayBuffer.");
        }
    }

    [[nodiscard]] std::uint32_t get_uint32(std::size_t offset, bool little_endian) const {
        if (offset + 4 > byte_length_) throw std::runtime_error("DataView read exceeds buffer.");
        const std::uint8_t* bytes = buffer_->data() + byte_offset_ + offset;
        if (little_endian) {
            return static_cast<std::uint32_t>(bytes[0]) |
                (static_cast<std::uint32_t>(bytes[1]) << 8) |
                (static_cast<std::uint32_t>(bytes[2]) << 16) |
                (static_cast<std::uint32_t>(bytes[3]) << 24);
        }
        return (static_cast<std::uint32_t>(bytes[0]) << 24) |
            (static_cast<std::uint32_t>(bytes[1]) << 16) |
            (static_cast<std::uint32_t>(bytes[2]) << 8) |
            static_cast<std::uint32_t>(bytes[3]);
    }

    [[nodiscard]] std::size_t byte_offset() const { return byte_offset_; }
    [[nodiscard]] std::size_t byte_length() const { return byte_length_; }

  private:
    const ArrayBuffer* buffer_;
    std::size_t byte_offset_;
    std::size_t byte_length_;
};

class Blob {
  public:
    Blob() = default;
    explicit Blob(ArrayBuffer buffer, std::string type = {})
        : buffer_(std::move(buffer)), type_(std::move(type)) {}

    [[nodiscard]] const ArrayBuffer& array_buffer() const { return buffer_; }
    [[nodiscard]] const std::string& type() const { return type_; }
    [[nodiscard]] std::size_t size() const { return buffer_.byte_length(); }

  private:
    ArrayBuffer buffer_;
    std::string type_;
};

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

    [[nodiscard]] bool is_object() const { return std::holds_alternative<Object>(storage_); }
    [[nodiscard]] bool is_array() const { return std::holds_alternative<Array>(storage_); }
    [[nodiscard]] bool is_string() const { return std::holds_alternative<std::string>(storage_); }
    [[nodiscard]] bool is_number() const { return std::holds_alternative<double>(storage_); }
    [[nodiscard]] bool is_boolean() const { return std::holds_alternative<bool>(storage_); }
    [[nodiscard]] bool is_null() const { return std::holds_alternative<std::nullptr_t>(storage_); }

    [[nodiscard]] const Object& as_object() const { return require<Object>("object"); }
    [[nodiscard]] const Array& as_array() const { return require<Array>("array"); }
    [[nodiscard]] const std::string& as_string() const { return require<std::string>("string"); }
    [[nodiscard]] double as_number() const { return require<double>("number"); }
    [[nodiscard]] bool as_boolean() const { return require<bool>("boolean"); }

    [[nodiscard]] const JsonValue* find(const std::string& key) const {
        const Object& object = as_object();
        const auto found = object.find(key);
        return found == object.end() ? nullptr : &found->second;
    }

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
    const T& value() const { return value_; }

    template <typename Callback>
    auto then(Callback&& callback) -> Promise<std::decay_t<std::invoke_result_t<Callback, T&>>> {
        using Result = std::decay_t<std::invoke_result_t<Callback, T&>>;
        return Promise<Result>(std::invoke(std::forward<Callback>(callback), value_));
    }

  private:
    T value_;
};

template <typename T>
T await(Promise<T> promise) {
    return std::move(promise.value());
}

template <typename Module>
struct StaticImport {
    Module module;
};

} // namespace bbl::ts
