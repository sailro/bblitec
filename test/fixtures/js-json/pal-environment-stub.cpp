// `pal_storage.cpp` reads one PAL service it does not own:
// `environment_variable`, which the engine's own translation unit defines
// beside the window and the clock. That unit pulls the whole runtime in,
// which a standalone storage check has no use for, so the check links this
// two-line stand-in instead. It is the same body `pal.cpp` carries -- if
// the two ever disagree, the disagreement is about `getenv`, not about
// storage.

#include <bblite/pal.hpp>

#include <cstdlib>
#include <string>

namespace bbl::pal {

std::string environment_variable(const char* name) {
#if defined(_MSC_VER)
    char* value = nullptr;
    std::size_t length = 0;
    if (_dupenv_s(&value, &length, name) != 0 || !value) {
        return {};
    }
    std::string result(value);
    std::free(value);
    return result;
#else
    const char* value = std::getenv(name);
    return value ? value : "";
#endif
}

} // namespace bbl::pal
