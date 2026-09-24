#pragma once

#include <bblite/js_data.hpp>
#include <bblite/pal_structured_clone.hpp>

#include <cstdint>
#include <cstring>

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
        if (present)
            (*this)(name, value);
    }
};
struct CloneObjectReader {
    pal::CloneReader& reader;
    pal::CloneId object;
    template <typename T> void operator()(std::string_view name, T& value) const {
        value = clone_read<T>(reader, reader.property(object, name));
    }
    template <typename T>
    void operator()(std::string_view name, T& value, bool default_when_missing) const {
        if (const auto id = reader.find_property(object, name))
            value = clone_read<T>(reader, *id);
        else if (default_when_missing)
            value = T{};
        else
            throw pal::DataCloneError("Required message property is absent: " + std::string(name));
    }
    template <typename T> void operator()(std::string_view name, std::optional<T>& value) const {
        if (const auto id = reader.find_property(object, name))
            value = clone_read<std::optional<T>>(reader, *id);
        else
            value.reset();
    }
    template <typename T> void operator()(std::string_view name, Nullable<T>& value) const {
        if (const auto id = reader.find_property(object, name))
            value = clone_read<Nullable<T>>(reader, *id);
        else
            value = std::nullopt;
    }
    template <typename T> void when(std::string_view name, T& value, bool present) const {
        if (present)
            (*this)(name, value);
        else
            value = T{};
    }
};

/** Generated record codecs enumerate the same typed fields used by the GC. */
template <typename T> struct CloneCodec {
    static pal::CloneNode encode(pal::CloneWriter& writer, const T& value) {
        if constexpr (std::is_same_v<T, bool> || std::is_same_v<T, std::string>)
            return value;
        else if constexpr (std::is_arithmetic_v<T>)
            return static_cast<double>(value);
        else if constexpr (requires { clone_enum_value(value); })
            return clone_enum_value(value);
        else if constexpr (requires(pal::CloneObject& object) {
                               clone_fields(value, CloneObjectWriter{writer, object});
                           }) {
            pal::CloneObject object;
            clone_fields(value, CloneObjectWriter{writer, object});
            return object;
        } else {
            throw pal::DataCloneError("This value cannot be structured-cloned.");
        }
    }
    static void read_into(pal::CloneReader& reader, pal::CloneId id, T& value) {
        if constexpr (std::is_same_v<T, bool> || std::is_same_v<T, std::string>)
            value = reader.get<T>(id);
        else if constexpr (std::is_same_v<T, double>)
            value = reader.get<double>(id);
        else if constexpr (requires(const std::string& text) { clone_enum_value(value, text); })
            clone_enum_value(value, reader.get<std::string>(id));
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
        if (!value)
            return writer.add(pal::CloneNull{});
        const auto [id, fresh] = writer.remember(value.get());
        if (fresh)
            writer.replace(id, CloneCodec<T>::encode(writer, *value));
        return id;
    }
    static Ref<T> read(pal::CloneReader& reader, pal::CloneId id) {
        if (std::holds_alternative<pal::CloneNull>(reader.node(id)))
            return {};
        if (const auto* value = reader.recalled<Ref<T>>(id))
            return *value;
        auto value = make_ref<T>();
        reader.remember(id, value);
        CloneCodec<T>::read_into(reader, id, *value);
        return value;
    }
};

template <typename T> struct CloneCodec<Array<T>> {
    static pal::CloneId write(pal::CloneWriter& writer, const Array<T>& value) {
        const auto [id, fresh] = writer.remember(value.identity());
        if (!fresh)
            return id;
        pal::CloneArray array;
        array.elements.reserve(value.size());
        for (const auto& item : value)
            array.elements.push_back(clone_write(writer, item));
        writer.replace(id, std::move(array));
        return id;
    }
    static Array<T> read(pal::CloneReader& reader, pal::CloneId id) {
        if (const auto* value = reader.recalled<Array<T>>(id))
            return *value;
        const auto& array = reader.get<pal::CloneArray>(id);
        Array<T> value(array.elements.size());
        reader.remember(id, value);
        for (std::size_t index = 0; index < value.size(); ++index)
            value[index] = clone_read<T>(reader, array.elements[index]);
        return value;
    }
};

template <std::size_t N> struct CloneCodec<Tuple<N>> {
    static pal::CloneId write(pal::CloneWriter& writer, const Tuple<N>& value) {
        const auto [id, fresh] = writer.remember(value.identity());
        if (!fresh)
            return id;
        pal::CloneArray array;
        array.elements.reserve(N);
        for (const double item : value)
            array.elements.push_back(writer.add(item));
        writer.replace(id, std::move(array));
        return id;
    }
    static Tuple<N> read(pal::CloneReader& reader, pal::CloneId id) {
        if (const auto* value = reader.recalled<Tuple<N>>(id))
            return *value;
        const auto& array = reader.get<pal::CloneArray>(id);
        if (array.elements.size() != N)
            throw pal::DataCloneError("Message array length does not match the receiving tuple.");
        Tuple<N> value;
        reader.remember(id, value);
        for (std::size_t index = 0; index < N; ++index)
            value[index] = reader.get<double>(array.elements[index]);
        return value;
    }
};

template <typename K, typename V> struct CloneCodec<Map<K, V>> {
    static pal::CloneId write(pal::CloneWriter& writer, const Map<K, V>& value) {
        const auto [id, fresh] = writer.remember(value.identity());
        if (!fresh)
            return id;
        pal::CloneMap map;
        map.entries.reserve(value.size());
        for (const auto& [key, item] : value) {
            const auto key_id = clone_write(writer, key);
            map.entries.emplace_back(key_id, clone_write(writer, item));
        }
        writer.replace(id, std::move(map));
        return id;
    }
    static Map<K, V> read(pal::CloneReader& reader, pal::CloneId id) {
        if (const auto* value = reader.recalled<Map<K, V>>(id))
            return *value;
        const auto& map = reader.get<pal::CloneMap>(id);
        Map<K, V> value;
        reader.remember(id, value);
        for (const auto& [key_id, item_id] : map.entries) {
            auto key = clone_read<K>(reader, key_id);
            value.set(key, clone_read<V>(reader, item_id));
        }
        return value;
    }
};

template <typename T> struct CloneCodec<Set<T>> {
    static pal::CloneId write(pal::CloneWriter& writer, const Set<T>& value) {
        const auto [id, fresh] = writer.remember(value.identity());
        if (!fresh)
            return id;
        pal::CloneSet set;
        set.elements.reserve(value.size());
        for (const auto& item : value)
            set.elements.push_back(clone_write(writer, item));
        writer.replace(id, std::move(set));
        return id;
    }
    static Set<T> read(pal::CloneReader& reader, pal::CloneId id) {
        if (const auto* value = reader.recalled<Set<T>>(id))
            return *value;
        const auto& set = reader.get<pal::CloneSet>(id);
        Set<T> value;
        reader.remember(id, value);
        for (const auto element : set.elements)
            value.add(clone_read<T>(reader, element));
        return value;
    }
};

/** Date is the runtime's only Ref<double>: a mutable time value with object identity. */
template <> struct CloneCodec<Date> {
    static pal::CloneId write(pal::CloneWriter& writer, const Date& value) {
        if (!value)
            return writer.add(pal::CloneNull{});
        const auto [id, fresh] = writer.remember(value.get());
        if (fresh)
            writer.replace(id, pal::CloneDate{*value});
        return id;
    }
    static Date read(pal::CloneReader& reader, pal::CloneId id) {
        if (std::holds_alternative<pal::CloneNull>(reader.node(id)))
            return {};
        if (const auto* value = reader.recalled<Date>(id))
            return *value;
        auto value = make_ref<double>(reader.get<pal::CloneDate>(id).time);
        reader.remember(id, value);
        return value;
    }
};

template <> struct CloneCodec<ArrayBuffer> {
    static pal::CloneId write(pal::CloneWriter& writer, const ArrayBuffer& value) {
        // Retained storage is keyed by its owner, so every view of it shares
        // one received buffer. Borrowed native bytes are keyed by address; an
        // empty borrowed buffer has neither, and its identity is unobservable.
        const void* identity = value.retains_storage() ? value.identity() : value.data();
        const auto copy = [&value] {
            return pal::CloneBuffer{
                std::vector<std::uint8_t>(value.data(), value.data() + value.byte_length())};
        };
        if (!identity)
            return writer.add(copy());
        const auto [id, fresh] = writer.remember(identity, pal::CloneIdentitySpace::buffer);
        if (fresh)
            writer.replace(id, copy());
        return id;
    }
    static ArrayBuffer read(pal::CloneReader& reader, pal::CloneId id) {
        if (const auto* value = reader.recalled<ArrayBuffer>(id))
            return *value;
        ArrayBuffer value(reader.take_buffer(id));
        reader.remember(id, value);
        return value;
    }
};

template <typename T> struct CloneElement;
template <> struct CloneElement<std::int8_t> {
    static constexpr auto kind = pal::CloneViewKind::int8;
};
template <> struct CloneElement<std::uint8_t> {
    static constexpr auto kind = pal::CloneViewKind::uint8;
};
template <> struct CloneElement<std::int16_t> {
    static constexpr auto kind = pal::CloneViewKind::int16;
};
template <> struct CloneElement<std::uint16_t> {
    static constexpr auto kind = pal::CloneViewKind::uint16;
};
template <> struct CloneElement<std::int32_t> {
    static constexpr auto kind = pal::CloneViewKind::int32;
};
template <> struct CloneElement<std::uint32_t> {
    static constexpr auto kind = pal::CloneViewKind::uint32;
};
template <> struct CloneElement<float> {
    static constexpr auto kind = pal::CloneViewKind::float32;
};
template <> struct CloneElement<double> {
    static constexpr auto kind = pal::CloneViewKind::float64;
};

/** A view copies its whole buffer once per message, as HTML serializes [[ViewedArrayBuffer]]. */
template <typename View>
pal::CloneId clone_write_view(pal::CloneWriter& writer, const View& view, pal::CloneViewKind kind) {
    const auto [id, fresh] = writer.remember(view.identity(), pal::CloneIdentitySpace::view);
    if (fresh) {
        const auto buffer = clone_write(writer, view.buffer());
        writer.replace(id, pal::CloneView{kind, buffer, view.byte_offset(), view.byte_length()});
    }
    return id;
}
inline pal::CloneView clone_view_node(const pal::CloneReader& reader, pal::CloneId id,
                                      pal::CloneViewKind kind, std::size_t element_size) {
    const auto& view = reader.get<pal::CloneView>(id);
    if (view.kind != kind)
        throw pal::DataCloneError("Message value does not match the receiving type.");
    if (view.byte_offset % element_size != 0 || view.byte_length % element_size != 0)
        throw pal::DataCloneError("Message view is not aligned to its elements.");
    const auto& bytes = reader.get<pal::CloneBuffer>(view.buffer).bytes;
    const auto* decoded = reader.recalled<ArrayBuffer>(view.buffer);
    const auto available = decoded ? decoded->byte_length() : bytes.size();
    if (view.byte_offset > available || view.byte_length > available - view.byte_offset)
        throw pal::DataCloneError("Message view exceeds its buffer.");
    return view;
}

template <typename T> struct CloneCodec<TypedArray<T>> {
    static pal::CloneId write(pal::CloneWriter& writer, const TypedArray<T>& value) {
        return clone_write_view(writer, value, CloneElement<T>::kind);
    }
    static TypedArray<T> read(pal::CloneReader& reader, pal::CloneId id) {
        if (const auto* value = reader.recalled<TypedArray<T>>(id))
            return *value;
        const auto view = clone_view_node(reader, id, CloneElement<T>::kind, sizeof(T));
        auto value = [&] {
            // The first view spanning a whole buffer receives owned contiguous
            // elements, which every typed-array operation supports; later views
            // of that buffer alias the same storage.
            if (!reader.recalled<ArrayBuffer>(view.buffer) && view.byte_offset == 0 &&
                view.byte_length == reader.get<pal::CloneBuffer>(view.buffer).bytes.size()) {
                const auto bytes = reader.take_buffer(view.buffer);
                TypedArray<T> owned(bytes.size() / sizeof(T));
                if (!bytes.empty())
                    std::memcpy(owned.data(), bytes.data(), bytes.size());
                reader.remember(view.buffer, ArrayBuffer(owned.storage()));
                return owned;
            }
            return TypedArray<T>(clone_read<ArrayBuffer>(reader, view.buffer),
                                 static_cast<double>(view.byte_offset),
                                 static_cast<double>(view.byte_length / sizeof(T)));
        }();
        reader.remember(id, value);
        return value;
    }
};

template <> struct CloneCodec<U8Array> {
    static pal::CloneId write(pal::CloneWriter& writer, const U8Array& value) {
        return clone_write_view(writer, value, pal::CloneViewKind::uint8);
    }
    static U8Array read(pal::CloneReader& reader, pal::CloneId id) {
        if (const auto* value = reader.recalled<U8Array>(id))
            return *value;
        const auto view = clone_view_node(reader, id, pal::CloneViewKind::uint8, 1);
        U8Array value(clone_read<ArrayBuffer>(reader, view.buffer), view.byte_offset,
                      view.byte_length);
        reader.remember(id, value);
        return value;
    }
};

template <> struct CloneCodec<DataView> {
    static pal::CloneId write(pal::CloneWriter& writer, const DataView& value) {
        return clone_write_view(writer, value, pal::CloneViewKind::data_view);
    }
    static DataView read(pal::CloneReader& reader, pal::CloneId id) {
        if (const auto* value = reader.recalled<DataView>(id))
            return *value;
        const auto view = clone_view_node(reader, id, pal::CloneViewKind::data_view, 1);
        DataView value(clone_read<ArrayBuffer>(reader, view.buffer), view.byte_offset,
                       view.byte_length);
        reader.remember(id, value);
        return value;
    }
};

template <typename T> struct CloneCodec<std::optional<T>> {
    static pal::CloneId write(pal::CloneWriter& writer, const std::optional<T>& value) {
        return value ? clone_write(writer, *value) : writer.add(pal::CloneUndefined{});
    }
    static std::optional<T> read(pal::CloneReader& reader, pal::CloneId id) {
        if (std::holds_alternative<pal::CloneUndefined>(reader.node(id)))
            return {};
        return clone_read<T>(reader, id);
    }
};

template <typename T> struct CloneCodec<Nullable<T>> {
    static pal::CloneId write(pal::CloneWriter& writer, const Nullable<T>& value) {
        return value ? clone_write(writer, *value) : writer.add(pal::CloneUndefined{});
    }
    static Nullable<T> read(pal::CloneReader& reader, pal::CloneId id) {
        if (std::holds_alternative<pal::CloneUndefined>(reader.node(id)) ||
            std::holds_alternative<pal::CloneNull>(reader.node(id)))
            return {};
        return clone_read<T>(reader, id);
    }
};

template <typename T> pal::CloneId clone_write(pal::CloneWriter& writer, const T& value) {
    if constexpr (requires { CloneCodec<T>::write(writer, value); })
        return CloneCodec<T>::write(writer, value);
    else
        return writer.add(CloneCodec<T>::encode(writer, value));
}
template <typename T> T clone_read(pal::CloneReader& reader, pal::CloneId id) {
    if constexpr (requires { CloneCodec<T>::read(reader, id); })
        return CloneCodec<T>::read(reader, id);
    else {
        T value{};
        CloneCodec<T>::read_into(reader, id, value);
        return value;
    }
}

template <typename T>
pal::SerializedMessage serialize_message(const T& value,
                                         std::span<pal::Transferable* const> transfers = {}) {
    pal::CloneWriter writer(transfers);
    const auto root = clone_write(writer, value);
    return std::move(writer).finish(root);
}

} // namespace bbl::js
