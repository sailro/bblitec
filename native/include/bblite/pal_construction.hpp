#pragma once

#include <stdexcept>
#include <string>

namespace bbl::pal {

#if defined(BBLITE_PHYSICS_VIEWER) && BBLITE_PHYSICS_VIEWER
inline thread_local bool extracting_constructor_inputs = false;
inline void require_runtime_execution(const char* operation) {
    if (extracting_constructor_inputs) {
        throw std::runtime_error(std::string("Static constructor extraction refuses ") + operation + ".");
    }
}
#else
inline void require_runtime_execution(const char*) {}
#endif

} // namespace bbl::pal
