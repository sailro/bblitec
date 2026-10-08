#pragma once

#include <bblite/js_data.hpp>

#include <memory>
#include <string>
#include <unordered_map>
#include <utility>

namespace bbl::js {

/**
 * A JavaScript Symbol: a unique identity with an optional description. Copies
 * share the identity; two symbols are equal only when they are the same one.
 */
class Symbol {
public:
    Symbol() = default;
    [[nodiscard]] static Symbol create(Nullable<std::string> description) {
        Symbol symbol;
        symbol.data_ = std::make_shared<const Data>(Data{std::move(description)});
        return symbol;
    }
    /** `Symbol.for(key)`: the realm's registered symbol for a key. */
    [[nodiscard]] static Symbol registered(const std::string& key) {
        auto& registry = registered_symbols();
        const auto found = registry.find(key);
        if (found != registry.end())
            return found->second;
        Symbol symbol = create(Nullable<std::string>(key));
        registry.emplace(key, symbol);
        return symbol;
    }
    /** `Symbol.keyFor(symbol)`: its registry key, or undefined for another symbol. */
    [[nodiscard]] Nullable<std::string> registry_key() const {
        for (const auto& [key, symbol] : registered_symbols()) {
            if (symbol == *this)
                return key;
        }
        return std::nullopt;
    }
    [[nodiscard]] Nullable<std::string> description() const { return data().description; }
    /** `Symbol.prototype.toString`: `Symbol(description)`. */
    [[nodiscard]] std::string to_string() const {
        const auto& text = data().description;
        return "Symbol(" + (text.has_value() ? *text : std::string()) + ")";
    }
    [[nodiscard]] const void* identity() const noexcept { return data_.get(); }
    friend bool operator==(const Symbol& left, const Symbol& right) noexcept {
        return left.data_ == right.data_;
    }

private:
    struct Data {
        Nullable<std::string> description;
    };
    [[nodiscard]] const Data& data() const {
        if (!data_)
            throw std::runtime_error("A symbol binding read before its assignment.");
        return *data_;
    }
    static std::unordered_map<std::string, Symbol>& registered_symbols() {
        static thread_local std::unordered_map<std::string, Symbol> registry;
        return registry;
    }
    std::shared_ptr<const Data> data_;
};

} // namespace bbl::js

template <> struct std::hash<bbl::js::Symbol> {
    std::size_t operator()(const bbl::js::Symbol& symbol) const noexcept {
        return std::hash<const void*>{}(symbol.identity());
    }
};
