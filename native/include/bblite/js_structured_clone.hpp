#pragma once

#include <bblite/js_data.hpp>
#include <bblite/pal_structured_clone.hpp>

#include <algorithm>
#include <charconv>
#include <cstdint>
#include <cstring>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

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
    void operator()(std::string_view name, const Nullable<Undefined>& value) const {
        if (value.has_value())
            (*this)(name, *value);
    }
    template <typename T> void operator()(std::string_view name, const T& value, bool) const {
        (*this)(name, value);
    }
    template <typename T> void when(std::string_view name, const T& value, bool present) const {
        if (present)
            (*this)(name, value);
    }
    // An accessor property clones as data: serialization reads it through its
    // getter, as [[Get]] does, and a removed own key stays absent.
    template <typename T> void operator()(std::string_view name, const Accessor<T>& value) const {
        (*this)(name, value.get());
    }
    template <typename T, typename Receiver>
    void operator()(std::string_view name, const ReceiverAccessor<T, Receiver>& value) const {
        if (value.has_own())
            (*this)(name, value.get());
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
            if constexpr (std::is_same_v<T, Undefined>)
                value = Nullable<Undefined>{clone_read<Undefined>(reader, *id)};
            else
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
    // A cloned accessor property is a plain data slot holding the read value.
    template <typename T> void operator()(std::string_view name, Accessor<T>& value) const {
        T stored{};
        (*this)(name, stored);
        value = Accessor<T>(std::move(stored));
    }
    template <typename T>
    void operator()(std::string_view name, Accessor<T>& value, bool default_when_missing) const {
        T stored{};
        (*this)(name, stored, default_when_missing);
        value = Accessor<T>(std::move(stored));
    }
    template <typename T, typename Receiver>
    void operator()(std::string_view name, ReceiverAccessor<T, Receiver>& value) const {
        if (const auto id = reader.find_property(object, name))
            value = ReceiverAccessor<T, Receiver>(clone_read<T>(reader, *id));
        else
            value = ReceiverAccessor<T, Receiver>{};
    }
    template <typename T, typename Receiver>
    void operator()(std::string_view name, ReceiverAccessor<T, Receiver>& value, bool) const {
        (*this)(name, value);
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

template <> struct CloneCodec<Undefined> {
    static pal::CloneNode encode(pal::CloneWriter&, Undefined) { return pal::CloneUndefined{}; }
    static void read_into(pal::CloneReader& reader, pal::CloneId id, Undefined&) {
        reader.get<pal::CloneUndefined>(id);
    }
};

template <> struct CloneCodec<Null> {
    static pal::CloneNode encode(pal::CloneWriter&, Null) { return pal::CloneNull{}; }
    static void read_into(pal::CloneReader& reader, pal::CloneId id, Null&) {
        reader.get<pal::CloneNull>(id);
    }
};

/** A function cannot be cloned; an absent one (an empty callback) clones as undefined. */
template <typename R, typename... Args> struct CloneCodec<Callback<R(Args...)>> {
    static pal::CloneNode encode(pal::CloneWriter&, const Callback<R(Args...)>& value) {
        if (value)
            throw pal::DataCloneError("A function cannot be structured-cloned.");
        return pal::CloneUndefined{};
    }
    static void read_into(pal::CloneReader& reader, pal::CloneId id, Callback<R(Args...)>& value) {
        reader.get<pal::CloneUndefined>(id);
        value = {};
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

/** A record key: a string is itself, a numeric key is its own spelling. */
[[nodiscard]] inline const std::string& json_object_key(const std::string& key) { return key; }
/** A temporary key would leave the returned reference dangling. */
const std::string& json_object_key(std::string&&) = delete;

[[nodiscard]] inline std::string json_object_key(double key) { return number_to_string(key); }

[[nodiscard]] inline std::optional<std::uint32_t> json_property_index(std::string_view name) {
    if (name.empty() || (name.size() > 1 && name.front() == '0'))
        return std::nullopt;
    std::uint32_t index = 0;
    const auto parsed = std::from_chars(name.data(), name.data() + name.size(), index);
    if (parsed.ec != std::errc{} || parsed.ptr != name.data() + name.size() ||
        index == std::numeric_limits<std::uint32_t>::max())
        return std::nullopt;
    return index;
}

[[nodiscard]] inline bool json_property_key_less(std::string_view left, std::string_view right) {
    const auto a = json_property_index(left), b = json_property_index(right);
    return a && (!b || *a < *b);
}

/**
 * A dictionary's own entries in property order: array-index names ascending,
 * then the other names as they were inserted.
 */
template <typename Map, typename Visitor>
inline void for_each_property_entry(const Map& map, Visitor&& visitor) {
    using Entry = std::remove_cvref_t<decltype(*map.begin())>;
    std::vector<std::pair<std::string, const Entry*>> ordered;
    ordered.reserve(map.size());
    for (const auto& entry : map)
        ordered.emplace_back(json_object_key(entry.first), &entry);
    std::stable_sort(ordered.begin(), ordered.end(), [](const auto& left, const auto& right) {
        return json_property_key_less(left.first, right.first);
    });
    for (const auto& [name, entry] : ordered)
        visitor(name, entry->second);
}

/**
 * The number a number-keyed dictionary stores property `name` under: the
 * number whose string `name` is, or none when no number spells it (its
 * `get` then misses).
 */
[[nodiscard]] inline Nullable<double> number_property_key(const std::string& name) {
    const double key = number_from_string(name);
    if (number_to_string(key) != name)
        return Nullable<double>{std::nullopt};
    return Nullable<double>{key};
}

/** A dictionary is a plain object: its own properties, in property order. */
template <typename K, typename V> struct CloneCodec<Dictionary<K, V>> {
    static pal::CloneId write(pal::CloneWriter& writer, const Dictionary<K, V>& value) {
        const auto [id, fresh] = writer.remember(value.identity());
        if (!fresh)
            return id;
        pal::CloneObject object;
        object.properties.reserve(value.size());
        for_each_property_entry(value, [&](const std::string& name, const V& item) {
            object.properties.emplace_back(name, clone_write(writer, item));
        });
        writer.replace(id, std::move(object));
        return id;
    }
    static Dictionary<K, V> read(pal::CloneReader& reader, pal::CloneId id) {
        if (const auto* value = reader.recalled<Dictionary<K, V>>(id))
            return *value;
        const auto properties = reader.get<pal::CloneObject>(id).properties;
        Dictionary<K, V> value;
        reader.remember(id, value);
        for (const auto& [name, item] : properties) {
            if constexpr (std::is_same_v<K, std::string>)
                value.set(name, clone_read<V>(reader, item));
            else {
                const auto key = number_property_key(name);
                if (!key)
                    throw pal::DataCloneError("A number-keyed dictionary receives property '" +
                                              name + "', which no number spells.");
                value.set(*key, clone_read<V>(reader, item));
            }
        }
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
        // No other agent can share this realm's memory, as without cross-origin isolation.
        if (value.shared())
            throw pal::DataCloneError("A SharedArrayBuffer cannot be shared with another agent.");
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
template <> struct CloneElement<ClampedByte> {
    static constexpr auto kind = pal::CloneViewKind::uint8_clamped;
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

/** A slot telling `undefined` from `null`: undefined until defined, then its value (`null` its empty state). */
template <typename T> struct CloneCodec<Tagged<T>> {
    static pal::CloneId write(pal::CloneWriter& writer, const Tagged<T>& value) {
        return value.defined() ? clone_write(writer, value.value())
                               : writer.add(pal::CloneUndefined{});
    }
    static Tagged<T> read(pal::CloneReader& reader, pal::CloneId id) {
        if (std::holds_alternative<pal::CloneUndefined>(reader.node(id)))
            return {};
        return Tagged<T>(clone_read<T>(reader, id), true);
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

/**
 * Whether a message node is the kind `T`'s codec writes: how a union reads
 * its member back. The compiler admits a union only where its members' kinds
 * differ.
 */
template <typename T> struct CloneShape {
    static bool holds(const pal::CloneNode& node) {
        if constexpr (std::is_same_v<T, bool>)
            return std::holds_alternative<bool>(node);
        else if constexpr (std::is_same_v<T, std::string>)
            return std::holds_alternative<std::string>(node);
        else if constexpr (std::is_arithmetic_v<T>)
            return std::holds_alternative<double>(node);
        else if constexpr (requires(const T& value) { clone_enum_value(value); })
            return std::holds_alternative<std::string>(node);
        else
            return std::holds_alternative<pal::CloneObject>(node);
    }
};
template <> struct CloneShape<Undefined> {
    static bool holds(const pal::CloneNode& node) {
        return std::holds_alternative<pal::CloneUndefined>(node);
    }
};
template <> struct CloneShape<Null> {
    static bool holds(const pal::CloneNode& node) {
        return std::holds_alternative<pal::CloneNull>(node);
    }
};
template <typename T> struct CloneShape<Array<T>> {
    static bool holds(const pal::CloneNode& node) {
        return std::holds_alternative<pal::CloneArray>(node);
    }
};
template <std::size_t N> struct CloneShape<Tuple<N>> : CloneShape<Array<double>> {};
template <typename K, typename V> struct CloneShape<Map<K, V>> {
    static bool holds(const pal::CloneNode& node) {
        return std::holds_alternative<pal::CloneMap>(node);
    }
};
template <typename K, typename V> struct CloneShape<Dictionary<K, V>> {
    static bool holds(const pal::CloneNode& node) {
        return std::holds_alternative<pal::CloneObject>(node);
    }
};
template <typename T> struct CloneShape<Set<T>> {
    static bool holds(const pal::CloneNode& node) {
        return std::holds_alternative<pal::CloneSet>(node);
    }
};
template <> struct CloneShape<Date> {
    static bool holds(const pal::CloneNode& node) {
        return std::holds_alternative<pal::CloneDate>(node);
    }
};
template <> struct CloneShape<ArrayBuffer> {
    static bool holds(const pal::CloneNode& node) {
        return std::holds_alternative<pal::CloneBuffer>(node);
    }
};
template <typename T> struct CloneShape<TypedArray<T>> {
    static bool holds(const pal::CloneNode& node) {
        const auto* view = std::get_if<pal::CloneView>(&node);
        return view && view->kind == CloneElement<T>::kind;
    }
};
template <> struct CloneShape<U8Array> {
    static bool holds(const pal::CloneNode& node) {
        const auto* view = std::get_if<pal::CloneView>(&node);
        return view && view->kind == pal::CloneViewKind::uint8;
    }
};
template <> struct CloneShape<DataView> {
    static bool holds(const pal::CloneNode& node) {
        const auto* view = std::get_if<pal::CloneView>(&node);
        return view && view->kind == pal::CloneViewKind::data_view;
    }
};
template <typename T> struct CloneShape<Ref<T>> : CloneShape<T> {};

/** A union clones as its present member and is received as the member its node holds. */
template <typename... Ts> struct CloneCodec<std::variant<Ts...>> {
    using Union = std::variant<Ts...>;
    static pal::CloneId write(pal::CloneWriter& writer, const Union& value) {
        return std::visit([&](const auto& member) { return clone_write(writer, member); }, value);
    }
    static Union read(pal::CloneReader& reader, pal::CloneId id) {
        const auto& node = reader.node(id);
        std::optional<Union> result;
        static_cast<void>(
            ((CloneShape<Ts>::holds(node) &&
              (result.emplace(std::in_place_type<Ts>, clone_read<Ts>(reader, id)), true)) ||
             ...));
        if (!result)
            throw pal::DataCloneError("Message value matches no member of the receiving union.");
        return std::move(*result);
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

/**
 * An ArrayBuffer in a transfer list (a typed array's `.buffer` included):
 * serialization meets it by its storage, and the transfer detaches it after
 * serialization, as HTML's StructuredSerializeWithTransfer does.
 */
class BufferTransfer final : public pal::Transferable {
public:
    explicit BufferTransfer(ArrayBuffer buffer) : buffer_(std::move(buffer)) {}
    /** Serialization asks first: a buffer no transfer detaches throws before any is serialized. */
    [[nodiscard]] std::pair<const void*, pal::CloneIdentitySpace>
    transfer_identity() const override {
        if (buffer_.shared())
            throw pal::DataCloneError("A SharedArrayBuffer cannot be transferred.");
        if (!buffer_.detachable())
            throw pal::DataCloneError("A borrowed native buffer cannot be transferred.");
        return {buffer_.identity(), pal::CloneIdentitySpace::buffer};
    }
    std::unique_ptr<pal::TransferredResource> transfer() override {
        return std::make_unique<pal::TransferredBuffer>(buffer_.detach());
    }

private:
    ArrayBuffer buffer_;
};

/** An ArrayBuffer held in a run-time transfer list (`Transferable[]`). */
inline std::shared_ptr<pal::Transferable> transferable_buffer(ArrayBuffer buffer) {
    return std::make_shared<BufferTransfer>(std::move(buffer));
}

/** A run-time transfer list's entries, as serialization takes them. */
inline std::vector<pal::Transferable*>
transfer_list(const Array<std::shared_ptr<pal::Transferable>>& list) {
    std::vector<pal::Transferable*> entries;
    entries.reserve(list.size());
    for (const auto& entry : list)
        entries.push_back(entry.get());
    return entries;
}

template <typename T>
pal::SerializedMessage serialize_message(const T& value,
                                         std::span<pal::Transferable* const> transfers = {}) {
    pal::CloneWriter writer(transfers);
    const auto root = clone_write(writer, value);
    return std::move(writer).finish(root);
}

/** `structuredClone(value)`: a deep copy keeping aliases and cycles, or a DataCloneError DOMException. */
template <typename T> T structured_clone(const T& value) {
    try {
        pal::CloneReader reader(serialize_message(value));
        return clone_read<T>(reader, reader.root());
    } catch (const pal::DataCloneError& error) {
        throw make_dom_exception(error.what(), "DataCloneError");
    }
}

} // namespace bbl::js
