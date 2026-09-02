#pragma once

// UTF-8 <-> UTF-16 for the Win32 APIs the PAL reaches (DirectWrite font
// lookup, the common file dialogs). One copy: the two-pass
// MultiByteToWideChar/WideCharToMultiByte shape is easy to get subtly wrong
// and was written twice before it lived here. Invalid input answers
// std::nullopt; the caller decides whether that is a miss or an error.

#if defined(_WIN32)

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <limits>
#include <optional>
#include <string>
#include <string_view>

namespace bbl::pal {

inline std::optional<std::wstring> utf8_to_wide(std::string_view value) {
    if (value.empty()) return std::wstring{};
    if (value.size() > static_cast<std::size_t>(
                           (std::numeric_limits<int>::max)())) {
        return std::nullopt;
    }
    const int input_size = static_cast<int>(value.size());
    const int output_size = MultiByteToWideChar(
        CP_UTF8,
        MB_ERR_INVALID_CHARS,
        value.data(),
        input_size,
        nullptr,
        0);
    if (output_size <= 0) return std::nullopt;
    std::wstring result(static_cast<std::size_t>(output_size), L'\0');
    if (MultiByteToWideChar(
            CP_UTF8,
            MB_ERR_INVALID_CHARS,
            value.data(),
            input_size,
            result.data(),
            output_size) != output_size) {
        return std::nullopt;
    }
    return result;
}

inline std::optional<std::string> wide_to_utf8(std::wstring_view value) {
    if (value.empty()) return std::string{};
    if (value.size() > static_cast<std::size_t>(
                           (std::numeric_limits<int>::max)())) {
        return std::nullopt;
    }
    const int input_size = static_cast<int>(value.size());
    const int output_size = WideCharToMultiByte(
        CP_UTF8,
        WC_ERR_INVALID_CHARS,
        value.data(),
        input_size,
        nullptr,
        0,
        nullptr,
        nullptr);
    if (output_size <= 0) return std::nullopt;
    std::string result(static_cast<std::size_t>(output_size), '\0');
    if (WideCharToMultiByte(
            CP_UTF8,
            WC_ERR_INVALID_CHARS,
            value.data(),
            input_size,
            result.data(),
            output_size,
            nullptr,
            nullptr) != output_size) {
        return std::nullopt;
    }
    return result;
}

} // namespace bbl::pal

#endif
