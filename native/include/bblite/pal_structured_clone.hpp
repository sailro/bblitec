#pragma once

#include <any>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>

namespace bbl::pal {

struct DataCloneError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

/** Exclusive native resources, never source-language references or callbacks. */
struct TransferredResource {
    virtual ~TransferredResource() = default;
};

/** Implemented by a realm-owned transferable's shared logical state. */
struct Transferable {
    virtual ~Transferable() = default;
    virtual std::unique_ptr<TransferredResource> transfer() = 0;
};

using CloneId = std::uint32_t;
struct CloneUndefined {};
struct CloneNull {};
struct CloneArray { std::vector<CloneId> elements; };
struct CloneObject { std::vector<std::pair<std::string, CloneId>> properties; };
struct CloneBuffer { std::vector<std::uint8_t> bytes; };
struct CloneTransfer { std::size_t index; };
using CloneNode = std::variant<CloneUndefined, CloneNull, bool, double, std::string,
                               CloneArray, CloneObject, CloneBuffer, CloneTransfer>;

/** Edges are indices: cycles neither share JS ownership nor form native leaks. */
struct SerializedMessage {
    CloneId root = 0;
    std::vector<CloneNode> nodes;
    std::vector<std::unique_ptr<TransferredResource>> transfers;
};

class CloneWriter {
  public:
    explicit CloneWriter(std::span<Transferable* const> transfers = {})
        : transfer_list_(transfers.begin(), transfers.end()) {
        for (std::size_t index = 0; index < transfer_list_.size(); ++index) {
            auto* value = transfer_list_[index];
            if (!value || identities_.contains(value)) throw DataCloneError("Invalid or duplicate transferable.");
            identities_.emplace(value, add(CloneTransfer{index}));
        }
    }

    CloneId add(CloneNode node) {
        if (nodes_.size() >= std::numeric_limits<CloneId>::max()) throw DataCloneError("Message graph is too large.");
        const auto id = static_cast<CloneId>(nodes_.size());
        nodes_.push_back(std::move(node));
        return id;
    }
    void replace(CloneId id, CloneNode node) { nodes_.at(id) = std::move(node); }

    /** Reserve before traversing fields, preserving repeated and cyclic edges. */
    std::pair<CloneId, bool> remember(const void* identity) {
        if (!identity) throw DataCloneError("Cannot clone an empty object identity.");
        if (const auto found = identities_.find(identity); found != identities_.end()) return {found->second, false};
        const auto id = add(CloneUndefined{});
        identities_.emplace(identity, id);
        return {id, true};
    }

    CloneId transferable(Transferable& value) const {
        const auto found = identities_.find(&value);
        if (found == identities_.end()) throw DataCloneError("Transferable is missing from the transfer list.");
        return found->second;
    }

    SerializedMessage finish(CloneId root) && {
        if (root >= nodes_.size()) throw DataCloneError("Message has no root.");
        SerializedMessage result{root, std::move(nodes_), {}};
        result.transfers.reserve(transfer_list_.size());
        // Serialization must finish before transfer side effects begin. The
        // standard then transfers in list order; a later failure does not
        // undo an earlier successful detachment.
        for (auto* value : transfer_list_) {
            auto resource = value->transfer();
            if (!resource) throw DataCloneError("Transfer produced no resource.");
            result.transfers.push_back(std::move(resource));
        }
        return result;
    }

  private:
    std::vector<CloneNode> nodes_;
    std::unordered_map<const void*, CloneId> identities_;
    std::vector<Transferable*> transfer_list_;
};

/** Temporary decode memoization lives and is destroyed on the receiving realm. */
class CloneReader {
  public:
    explicit CloneReader(SerializedMessage message) : message_(std::move(message)) {
        if (message_.root >= message_.nodes.size()) throw DataCloneError("Message has no root.");
    }
    CloneReader(const CloneReader&) = delete;
    CloneReader& operator=(const CloneReader&) = delete;
    CloneId root() const { return message_.root; }
    const CloneNode& node(CloneId id) const {
        if (id >= message_.nodes.size()) throw DataCloneError("Invalid message graph edge.");
        return message_.nodes[id];
    }
    template <typename T> const T& get(CloneId id) const {
        const auto* value = std::get_if<T>(&node(id));
        if (!value) throw DataCloneError("Message value does not match the receiving type.");
        return *value;
    }
    CloneId property(CloneId id, std::string_view name) const {
        if (const auto found = find_property(id, name)) return *found;
        throw DataCloneError("Required message property is absent: " + std::string(name));
    }
    std::optional<CloneId> find_property(CloneId id, std::string_view name) const {
        const auto& properties = get<CloneObject>(id).properties;
        // Small protocol records need no second allocation. For wider records
        // build one index over the immutable message strings, reused by every
        // typed field lookup instead of rescanning F properties for F fields.
        if (properties.size() <= 8) {
            for (const auto& [key, value] : properties) if (key == name) return value;
            return std::nullopt;
        }
        auto [entry, inserted] = property_indices_.try_emplace(id);
        if (inserted) {
            entry->second.reserve(properties.size());
            for (const auto& [key, value] : properties) entry->second.try_emplace(key, value);
        }
        const auto found = entry->second.find(name);
        return found == entry->second.end() ? std::nullopt : std::optional<CloneId>(found->second);
    }
    std::vector<std::uint8_t> take_buffer(CloneId id) {
        get<CloneBuffer>(id);
        return std::move(std::get<CloneBuffer>(message_.nodes[id]).bytes);
    }
    template <typename T> const T* recalled(CloneId id) const {
        const auto found = decoded_.find(id);
        if (found == decoded_.end()) return nullptr;
        const auto* value = std::any_cast<T>(&found->second);
        if (!value) throw DataCloneError("Incompatible receiving types for one message identity.");
        return value;
    }
    template <typename T> void remember(CloneId id, T value) {
        node(id);
        if (!decoded_.emplace(id, std::move(value)).second) throw DataCloneError("Message identity was decoded twice.");
    }
    std::unique_ptr<TransferredResource> take_transfer(CloneId id) {
        const auto index = get<CloneTransfer>(id).index;
        if (index >= message_.transfers.size() || !message_.transfers[index]) throw DataCloneError("Transferred resource is missing or already received.");
        return std::move(message_.transfers[index]);
    }

  private:
    SerializedMessage message_;
    mutable std::unordered_map<CloneId, std::unordered_map<std::string_view, CloneId>> property_indices_;
    std::unordered_map<CloneId, std::any> decoded_;
};

} // namespace bbl::pal
