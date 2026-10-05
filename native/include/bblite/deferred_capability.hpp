#pragma once

#include <stdexcept>
#include <memory>
#include <string>
#include <string_view>

namespace bbl {

// Nominal storage for deferred platform APIs. There is no successful producer.
class DeferredHeaders final {
    DeferredHeaders() = delete;
};
class DeferredAbortController final {
    DeferredAbortController() = delete;
};
class DeferredAbortSignal final {
    DeferredAbortSignal() = delete;
};
class DeferredMediaRecorder final {
    DeferredMediaRecorder() = delete;
};
class DeferredBlobEvent final {
    DeferredBlobEvent() = delete;
};
class DeferredIdleDeadline final {
    DeferredIdleDeadline() = delete;
};

class DeferredReadableByteStream final {
    DeferredReadableByteStream() = delete;
};
class DeferredCompressionStream final {
    DeferredCompressionStream() = delete;
};
class DeferredDecompressionStream final {
    DeferredDecompressionStream() = delete;
};
class DeferredListFormat final {
    DeferredListFormat() = delete;
};
class DeferredPluralRules final {
    DeferredPluralRules() = delete;
};

class DeferredCapabilityError final : public std::runtime_error {
public:
    DeferredCapabilityError(std::string_view capability, std::string_view site)
        : std::runtime_error("Deferred native capability '" + std::string(capability) +
                             "' reached at " + std::string(site)) {}
};

// T is the authored result type. No successful result is ever constructed.
template <typename T> T deferred_capability(std::string_view capability, std::string_view site) {
    throw DeferredCapabilityError(capability, site);
}

} // namespace bbl
