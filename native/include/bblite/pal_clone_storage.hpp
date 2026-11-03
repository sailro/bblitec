#pragma once

// StructuredSerializeForStorage's byte form: a clone graph (pal_structured_clone.hpp) written to
// and read back from durable storage, as IndexedDB keeps a value. A transferred resource is a
// realm's exclusive object and has no stored form, so a graph holding one refuses, as the standard's
// storage serialization does. Integers are little-endian whatever the host, so a store written on
// one platform reads on every other; a truncated or foreign record refuses rather than decoding.

#include <bblite/pal_structured_clone.hpp>

#include <bit>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

namespace bbl::pal {

namespace detail {

inline constexpr std::string_view kCloneStorageMagic = "bblc\x01";

enum class CloneStorageTag : std::uint8_t {
    undefined,
    null,
    boolean,
    number,
    string,
    array,
    object,
    buffer,
    map,
    set,
    date,
    view,
    blob,
};

class CloneStorageOutput {
public:
    void bytes(const void* data, std::size_t size) {
        out_.append(static_cast<const char*>(data), size);
    }
    void u8(std::uint8_t value) { out_.push_back(static_cast<char>(value)); }
    void tag(CloneStorageTag value) { u8(static_cast<std::uint8_t>(value)); }
    void u32(std::uint32_t value) { little_endian(value); }
    void u64(std::uint64_t value) { little_endian(value); }
    void size(std::size_t value) {
        if (value > std::numeric_limits<std::uint32_t>::max())
            throw DataCloneError("A stored value exceeds the storage record's size limit.");
        u32(static_cast<std::uint32_t>(value));
    }
    void number(double value) { u64(std::bit_cast<std::uint64_t>(value)); }
    void text(std::string_view value) {
        size(value.size());
        bytes(value.data(), value.size());
    }
    void ids(const std::vector<CloneId>& values) {
        size(values.size());
        for (const auto id : values)
            u32(id);
    }
    std::string take() && { return std::move(out_); }

private:
    template <typename Unsigned> void little_endian(Unsigned value) {
        for (std::size_t shift = 0; shift < sizeof(Unsigned) * 8; shift += 8)
            u8(static_cast<std::uint8_t>(value >> shift));
    }
    std::string out_;
};

class CloneStorageInput {
public:
    explicit CloneStorageInput(std::string_view bytes) : in_(bytes) {}
    std::string_view bytes(std::size_t size) {
        if (size > in_.size() - at_)
            throw DataCloneError("A stored value is truncated.");
        const auto result = in_.substr(at_, size);
        at_ += size;
        return result;
    }
    std::uint8_t u8() { return static_cast<std::uint8_t>(bytes(1)[0]); }
    CloneStorageTag tag() { return static_cast<CloneStorageTag>(u8()); }
    std::uint32_t u32() { return little_endian<std::uint32_t>(); }
    std::uint64_t u64() { return little_endian<std::uint64_t>(); }
    double number() { return std::bit_cast<double>(u64()); }
    std::string text() { return std::string(bytes(u32())); }
    /** A count of following records, each at least `minimum` bytes: a corrupt count refuses here. */
    std::size_t count(std::size_t minimum) {
        const std::size_t value = u32();
        if (minimum && value > (in_.size() - at_) / minimum)
            throw DataCloneError("A stored value is truncated.");
        return value;
    }
    std::vector<CloneId> ids() {
        std::vector<CloneId> values(count(4));
        for (auto& id : values)
            id = u32();
        return values;
    }
    bool done() const { return at_ == in_.size(); }

private:
    template <typename Unsigned> Unsigned little_endian() {
        Unsigned value = 0;
        for (std::size_t shift = 0; shift < sizeof(Unsigned) * 8; shift += 8)
            value |= static_cast<Unsigned>(u8()) << shift;
        return value;
    }
    std::string_view in_;
    std::size_t at_ = 0;
};

} // namespace detail

/** The stored bytes of `message`, whose graph holds no transferred resource. */
[[nodiscard]] inline std::string serialize_for_storage(const SerializedMessage& message) {
    using detail::CloneStorageTag;
    detail::CloneStorageOutput out;
    out.bytes(detail::kCloneStorageMagic.data(), detail::kCloneStorageMagic.size());
    out.u32(message.root);
    out.size(message.nodes.size());
    for (const auto& node : message.nodes) {
        std::visit(
            [&](const auto& value) {
                using Node = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<Node, CloneUndefined>) {
                    out.tag(CloneStorageTag::undefined);
                } else if constexpr (std::is_same_v<Node, CloneNull>) {
                    out.tag(CloneStorageTag::null);
                } else if constexpr (std::is_same_v<Node, bool>) {
                    out.tag(CloneStorageTag::boolean);
                    out.u8(value ? 1 : 0);
                } else if constexpr (std::is_same_v<Node, double>) {
                    out.tag(CloneStorageTag::number);
                    out.number(value);
                } else if constexpr (std::is_same_v<Node, std::string>) {
                    out.tag(CloneStorageTag::string);
                    out.text(value);
                } else if constexpr (std::is_same_v<Node, CloneArray>) {
                    out.tag(CloneStorageTag::array);
                    out.ids(value.elements);
                } else if constexpr (std::is_same_v<Node, CloneObject>) {
                    out.tag(CloneStorageTag::object);
                    out.size(value.properties.size());
                    for (const auto& [name, id] : value.properties) {
                        out.text(name);
                        out.u32(id);
                    }
                } else if constexpr (std::is_same_v<Node, CloneBuffer>) {
                    out.tag(CloneStorageTag::buffer);
                    out.size(value.bytes.size());
                    out.bytes(value.bytes.data(), value.bytes.size());
                } else if constexpr (std::is_same_v<Node, CloneTransfer>) {
                    throw DataCloneError("A transferred value has no stored form.");
                } else if constexpr (std::is_same_v<Node, CloneMap>) {
                    out.tag(CloneStorageTag::map);
                    out.size(value.entries.size());
                    for (const auto& [key, entry] : value.entries) {
                        out.u32(key);
                        out.u32(entry);
                    }
                } else if constexpr (std::is_same_v<Node, CloneSet>) {
                    out.tag(CloneStorageTag::set);
                    out.ids(value.elements);
                } else if constexpr (std::is_same_v<Node, CloneDate>) {
                    out.tag(CloneStorageTag::date);
                    out.number(value.time);
                } else if constexpr (std::is_same_v<Node, CloneBlob>) {
                    out.tag(CloneStorageTag::blob);
                    out.text(value.type);
                    out.size(value.bytes.size());
                    out.bytes(value.bytes.data(), value.bytes.size());
                } else {
                    static_assert(std::is_same_v<Node, CloneView>);
                    out.tag(CloneStorageTag::view);
                    out.u8(static_cast<std::uint8_t>(value.kind));
                    out.u32(value.buffer);
                    out.u64(value.byte_offset);
                    out.u64(value.byte_length);
                }
            },
            node);
    }
    return std::move(out).take();
}

/** The clone graph `bytes` stores; a record another program or version wrote refuses. */
[[nodiscard]] inline SerializedMessage deserialize_from_storage(std::string_view bytes) {
    using detail::CloneStorageTag;
    detail::CloneStorageInput in(bytes);
    if (in.bytes(detail::kCloneStorageMagic.size()) != detail::kCloneStorageMagic)
        throw DataCloneError("A stored value is not a structured clone record.");
    SerializedMessage message;
    message.root = in.u32();
    message.nodes.resize(in.count(1));
    for (auto& node : message.nodes) {
        switch (in.tag()) {
        case CloneStorageTag::undefined:
            node = CloneUndefined{};
            break;
        case CloneStorageTag::null:
            node = CloneNull{};
            break;
        case CloneStorageTag::boolean:
            node = in.u8() != 0;
            break;
        case CloneStorageTag::number:
            node = in.number();
            break;
        case CloneStorageTag::string:
            node = in.text();
            break;
        case CloneStorageTag::array:
            node = CloneArray{in.ids()};
            break;
        case CloneStorageTag::object: {
            CloneObject object;
            object.properties.resize(in.count(8));
            for (auto& [name, id] : object.properties) {
                name = in.text();
                id = in.u32();
            }
            node = std::move(object);
            break;
        }
        case CloneStorageTag::buffer: {
            const auto stored = in.bytes(in.count(1));
            node = CloneBuffer{std::vector<std::uint8_t>(stored.begin(), stored.end())};
            break;
        }
        case CloneStorageTag::map: {
            CloneMap map;
            map.entries.resize(in.count(8));
            for (auto& [key, entry] : map.entries) {
                key = in.u32();
                entry = in.u32();
            }
            node = std::move(map);
            break;
        }
        case CloneStorageTag::set:
            node = CloneSet{in.ids()};
            break;
        case CloneStorageTag::date:
            node = CloneDate{in.number()};
            break;
        case CloneStorageTag::blob: {
            CloneBlob blob;
            blob.type = in.text();
            const auto stored = in.bytes(in.count(1));
            blob.bytes.assign(stored.begin(), stored.end());
            node = std::move(blob);
            break;
        }
        case CloneStorageTag::view: {
            const auto kind = in.u8();
            if (kind > static_cast<std::uint8_t>(CloneViewKind::data_view))
                throw DataCloneError("A stored value names an unknown buffer view.");
            CloneView view{static_cast<CloneViewKind>(kind), in.u32(), 0, 0};
            view.byte_offset = static_cast<std::size_t>(in.u64());
            view.byte_length = static_cast<std::size_t>(in.u64());
            node = view;
            break;
        }
        default:
            throw DataCloneError("A stored value holds an unknown record.");
        }
    }
    if (!in.done() || message.root >= message.nodes.size())
        throw DataCloneError("A stored value is malformed.");
    return message;
}

} // namespace bbl::pal
