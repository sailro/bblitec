#pragma once

#include <bblite/js_data.hpp>
#include <bblite/pal_structured_clone.hpp>

namespace bbl::js {

template <typename T> struct CloneCodec;
template <typename T> pal::CloneId clone_write(pal::CloneWriter& writer, const T& value);
template <typename T> T clone_read(pal::CloneReader& reader, pal::CloneId id);

struct CloneObjectWriter {
    pal::CloneWriter& writer;
    pal::CloneObject& object;
    template <typename T> void operator()(std::string_view name, const T& value) const {
        object.properties.emplace_back(name, clone_write(writer, value));
    }
    template <typename T> void operator()(std::string_view name, const T& value, bool) const {
        (*this)(name, value);
    }
    template <typename T> void when(std::string_view name, const T& value, bool present) const {
        if (present) (*this)(name, value);
    }
};
struct CloneObjectReader {
    pal::CloneReader& reader;
    pal::CloneId object;
    template <typename T> void operator()(std::string_view name, T& value) const {
        value = clone_read<T>(reader, reader.property(object, name));
    }
    template <typename T> void operator()(std::string_view name, T& value, bool default_when_missing) const {
        if (const auto id = reader.find_property(object, name)) value = clone_read<T>(reader, *id);
        else if (default_when_missing) value = T{};
        else throw pal::DataCloneError("Required message property is absent: " + std::string(name));
    }
    template <typename T> void operator()(std::string_view name, std::optional<T>& value) const {
        if (const auto id = reader.find_property(object, name)) value = clone_read<std::optional<T>>(reader, *id);
        else value.reset();
    }
    template <typename T> void operator()(std::string_view name, Nullable<T>& value) const {
        if (const auto id = reader.find_property(object, name)) value = clone_read<Nullable<T>>(reader, *id);
        else value = std::nullopt;
    }
    template <typename T> void when(std::string_view name, T& value, bool present) const {
        if (present) (*this)(name, value);
        else value = T{};
    }
};

/** Generated record codecs enumerate the same typed fields used by the GC. */
template <typename T> struct CloneCodec {
    static pal::CloneNode encode(pal::CloneWriter& writer, const T& value) {
        if constexpr (std::is_same_v<T, bool> || std::is_same_v<T, std::string>) return value;
        else if constexpr (std::is_arithmetic_v<T>) return static_cast<double>(value);
        else if constexpr (requires { clone_enum_value(value); }) return clone_enum_value(value);
        else if constexpr (requires(pal::CloneObject& object) { clone_fields(value, CloneObjectWriter{writer, object}); }) {
            pal::CloneObject object;
            clone_fields(value, CloneObjectWriter{writer, object});
            return object;
        } else {
            throw pal::DataCloneError("This value cannot be structured-cloned.");
        }
    }
    static void read_into(pal::CloneReader& reader, pal::CloneId id, T& value) {
        if constexpr (std::is_same_v<T, bool> || std::is_same_v<T, std::string>) value = reader.get<T>(id);
        else if constexpr (std::is_same_v<T, double>) value = reader.get<double>(id);
        else if constexpr (requires(const std::string& text) { clone_enum_value(value, text); }) clone_enum_value(value, reader.get<std::string>(id));
        else if constexpr (requires { clone_fields(value, CloneObjectReader{reader, id}); }) {
            reader.get<pal::CloneObject>(id);
            clone_fields(value, CloneObjectReader{reader, id});
        } else {
            throw pal::DataCloneError("Message cannot be decoded into this type.");
        }
    }
};

template <typename T> struct CloneCodec<Ref<T>> {
    static pal::CloneId write(pal::CloneWriter& writer, const Ref<T>& value) {
        if (!value) return writer.add(pal::CloneNull{});
        const auto [id, fresh] = writer.remember(value.get());
        if (fresh) writer.replace(id, CloneCodec<T>::encode(writer, *value));
        return id;
    }
    static Ref<T> read(pal::CloneReader& reader, pal::CloneId id) {
        if (std::holds_alternative<pal::CloneNull>(reader.node(id))) return {};
        if (const auto* value = reader.recalled<Ref<T>>(id)) return *value;
        auto value = make_ref<T>();
        reader.remember(id, value);
        CloneCodec<T>::read_into(reader, id, *value);
        return value;
    }
};

template <typename T> struct CloneCodec<Array<T>> {
    static pal::CloneId write(pal::CloneWriter& writer, const Array<T>& value) {
        const auto [id, fresh] = writer.remember(value.identity());
        if (!fresh) return id;
        pal::CloneArray array;
        array.elements.reserve(value.size());
        for (const auto& item : value) array.elements.push_back(clone_write(writer, item));
        writer.replace(id, std::move(array));
        return id;
    }
    static Array<T> read(pal::CloneReader& reader, pal::CloneId id) {
        if (const auto* value = reader.recalled<Array<T>>(id)) return *value;
        const auto& array = reader.get<pal::CloneArray>(id);
        Array<T> value(array.elements.size());
        reader.remember(id, value);
        for (std::size_t index = 0; index < value.size(); ++index) value[index] = clone_read<T>(reader, array.elements[index]);
        return value;
    }
};

template <> struct CloneCodec<ArrayBuffer> {
    static pal::CloneId write(pal::CloneWriter& writer, const ArrayBuffer& value) {
        // Owned ArrayBuffer aliases use storage identity, including empty
        // buffers. External typed-array storage needs its view codec.
        if (!value.storage()) throw pal::DataCloneError("External ArrayBuffer requires a typed-array clone codec.");
        const auto [id, fresh] = writer.remember(value.storage().get());
        if (fresh) writer.replace(id, pal::CloneBuffer{value.bytes()});
        return id;
    }
    static ArrayBuffer read(pal::CloneReader& reader, pal::CloneId id) {
        if (const auto* value = reader.recalled<ArrayBuffer>(id)) return *value;
        ArrayBuffer value(reader.take_buffer(id));
        reader.remember(id, value);
        return value;
    }
};

template <typename T> struct CloneCodec<std::optional<T>> {
    static pal::CloneId write(pal::CloneWriter& writer, const std::optional<T>& value) {
        return value ? clone_write(writer, *value) : writer.add(pal::CloneUndefined{});
    }
    static std::optional<T> read(pal::CloneReader& reader, pal::CloneId id) {
        if (std::holds_alternative<pal::CloneUndefined>(reader.node(id))) return {};
        return clone_read<T>(reader, id);
    }
};

template <typename T> struct CloneCodec<Nullable<T>> {
    static pal::CloneId write(pal::CloneWriter& writer, const Nullable<T>& value) {
        return value ? clone_write(writer, *value) : writer.add(pal::CloneUndefined{});
    }
    static Nullable<T> read(pal::CloneReader& reader, pal::CloneId id) {
        if (std::holds_alternative<pal::CloneUndefined>(reader.node(id)) || std::holds_alternative<pal::CloneNull>(reader.node(id))) return {};
        return clone_read<T>(reader, id);
    }
};

template <typename T> pal::CloneId clone_write(pal::CloneWriter& writer, const T& value) {
    if constexpr (requires { CloneCodec<T>::write(writer, value); }) return CloneCodec<T>::write(writer, value);
    else return writer.add(CloneCodec<T>::encode(writer, value));
}
template <typename T> T clone_read(pal::CloneReader& reader, pal::CloneId id) {
    if constexpr (requires { CloneCodec<T>::read(reader, id); }) return CloneCodec<T>::read(reader, id);
    else {
        T value{};
        CloneCodec<T>::read_into(reader, id, value);
        return value;
    }
}

template <typename T> pal::SerializedMessage serialize_message(const T& value,
        std::span<pal::Transferable* const> transfers = {}) {
    pal::CloneWriter writer(transfers);
    const auto root = clone_write(writer, value);
    return std::move(writer).finish(root);
}

} // namespace bbl::js
