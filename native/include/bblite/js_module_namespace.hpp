#pragma once

#include <string_view>

namespace bbl::js {

/** A finite compiled module's immutable identity; exports remain compiler-resolved live bindings. */
struct ModuleNamespace {
    std::string_view key;
    bool operator==(const ModuleNamespace&) const = default;
};

} // namespace bbl::js
