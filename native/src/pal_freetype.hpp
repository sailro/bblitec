#pragma once

#include <ft2build.h>
#include FT_FREETYPE_H
#include <memory>
#include <type_traits>

namespace bbl::pal {

template <typename T, auto Destroy>
using FontOwner = std::unique_ptr<std::remove_pointer_t<T>, decltype(Destroy)>;

inline FT_Library platform_font_library() {
    static thread_local FontOwner<FT_Library, &FT_Done_FreeType> library([] {
        FT_Library value = nullptr;
        return FT_Init_FreeType(&value) ? nullptr : value;
    }(), FT_Done_FreeType);
    return library.get();
}

} // namespace bbl::pal
