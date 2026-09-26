#pragma once

#include <bblite/pal_audio_types.hpp>
#include <bblite/js_data.hpp>

namespace bbl {

struct AudioSourceState;
using AudioSourceHandle = std::shared_ptr<AudioSourceState>;

/** The engine's context and main bus travel together through native storage. */
struct AudioEngineHandle {
    pal::AudioContextHandle context;
    pal::AudioNodeHandle main_bus;
    js::Set<AudioSourceHandle> sources{};
    bool operator==(const AudioEngineHandle& other) const { return context == other.context; }
    [[nodiscard]] std::uint32_t identity() const { return context.value; }
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(main_bus); visitor(sources); }
};

struct AudioSourceState {
    pal::AudioNodeHandle input;
    pal::AudioNodeHandle volume;
    AudioEngineHandle engine;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(input); visitor(volume); visitor(engine); }
};

} // namespace bbl
