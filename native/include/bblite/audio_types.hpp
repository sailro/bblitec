#pragma once

#include <bblite/pal_audio_types.hpp>
#include <bblite/js_callback.hpp>
#include <bblite/js_data.hpp>

#include <string>

namespace bbl {

/**
 * What an engine disposes with itself: the pin's `{ _dispose(): void }`
 * (`AudioEngine._sounds`), the base of every sound and source it holds.
 */
struct AudioEngineSound {
    js::Callback<void()> dispose;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(dispose); }
};
using AudioEngineSoundHandle = std::shared_ptr<AudioEngineSound>;

struct AudioSourceState;
using AudioSourceHandle = std::shared_ptr<AudioSourceState>;
/** The lowered static sound (`bblite/upstream_static_sound.hpp`), held by handle. */
struct StaticSound;

/**
 * `_listener`: the lowered spatial listener (`bblite/upstream_static_sound.hpp`),
 * shared by every copy of an engine handle. It is held type-erased; it is
 * created collectable, so tracing finds its node by identity.
 */
struct AudioEngineListenerSlot {
    std::shared_ptr<void> listener;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(listener); }
};

/** The engine's context and main bus travel together through native storage. */
struct AudioEngineHandle {
    pal::AudioContextHandle context;
    pal::AudioNodeHandle main_bus;
    /** `_sounds`: the sounds and sources `disposeAudioEngine` disposes. */
    js::Set<AudioEngineSoundHandle> sources{};
    /** `_rampDuration`: the default parameter ramp, in seconds. */
    double ramp_duration = 0.01;
    /** `_validFormats` / `_invalidFormats`: the format probes' answers, by extension. */
    js::Set<std::string> valid_formats{};
    js::Set<std::string> invalid_formats{};
    std::shared_ptr<AudioEngineListenerSlot> listener = std::make_shared<AudioEngineListenerSlot>();
    /** `_spatialUpdaters`: the attached spatial nodes' per-frame updates. */
    js::Set<js::Callback<void()>> spatial_updaters{};
    bool operator==(const AudioEngineHandle& other) const { return context == other.context; }
    [[nodiscard]] std::uint32_t identity() const { return context.value; }
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(main_bus);
        visitor(sources);
        visitor(listener);
        visitor(spatial_updaters);
    }
};

/** A caller-built node routed through the engine (`createSoundSourceAsync`). */
struct AudioSourceState : AudioEngineSound {
    pal::AudioNodeHandle input;
    pal::AudioNodeHandle volume;
    AudioEngineHandle engine;
    void gc_trace(const js::TraceVisitor& visitor) const {
        AudioEngineSound::gc_trace(visitor);
        visitor(input);
        visitor(volume);
        visitor(engine);
    }
};

} // namespace bbl
