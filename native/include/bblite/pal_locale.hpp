#pragma once

#include <optional>
#include <string>

namespace bbl::pal {

struct CollationOptions {
    std::optional<bool> numeric;
    std::optional<std::string> sensitivity;
    bool operator==(const CollationOptions&) const = default;
};

[[nodiscard]] std::string normalize_string(const std::string& value, const std::string& form);
[[nodiscard]] double compare_strings(const std::string& left, const std::string& right,
    const std::optional<std::string>& locale, const CollationOptions& options);

}
