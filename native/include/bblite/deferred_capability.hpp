#pragma once

#include <exception>
#include <stdexcept>
#include <memory>
#include <string>
#include <string_view>
#include <utility>

namespace bbl {

/**
 * Throws `error` from a call typed as returning T that optimizers cannot see
 * through, so the authored statements after it are not diagnosed as
 * unreachable. No T is ever constructed.
 */
template <typename T> T opaque_throw(std::exception_ptr error) {
    T (*volatile rethrow)(std::exception_ptr) = [](std::exception_ptr value) -> T {
        std::rethrow_exception(value);
    };
    return rethrow(std::move(error));
}

class DeferredCapabilityError final : public std::runtime_error {
public:
    DeferredCapabilityError(std::string_view capability, std::string_view site)
        : std::runtime_error("Deferred native capability '" + std::string(capability) +
                             "' reached at " + std::string(site)) {}
};

// T is the authored result type. No successful result is ever constructed.
template <typename T> T deferred_capability(std::string_view capability, std::string_view site) {
    return opaque_throw<T>(std::make_exception_ptr(DeferredCapabilityError(capability, site)));
}

} // namespace bbl
