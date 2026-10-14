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
/** The lowered static sound, bus and sound buffer (`bblite/upstream_static_sound.hpp`), held by handle. */
struct StaticSound;
struct AudioBus;
struct SoundBuffer;

/**
 * `_listener`: the lowered spatial listener (`bblite/upstream_static_sound.hpp`),
 * shared by every copy of an engine handle. It is held type-erased; it is
 * created collectable, so tracing finds its node by identity.
 */
struct AudioEngineListenerSlot {
    std::shared_ptr<void> listener;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(listener); }
};

/**
 * The pin's `AudioEngine` (`audio-engine.ts`), which the lowered
 * `createAudioEngineAsync` fills (`bblite/upstream_static_sound.hpp`). Copies
 * share its state: the containers, the volume cell and the bus records.
 */
struct AudioEngineHandle {
    pal::AudioContextHandle context;
    /** `_mainBus._in`: the node sounds and sources feed. */
    pal::AudioNodeHandle main_bus;
    /** `_mainOut._gain`: the master output gain the main bus feeds. */
    pal::AudioNodeHandle main_out;
    /** `_mainOut` / `_mainBus`: the lowered bus records, held type-erased. */
    std::shared_ptr<void> main_out_record{};
    std::shared_ptr<void> main_bus_record{};
    /** `_sounds` / `_buses`: what `disposeAudioEngine` disposes. */
    js::Set<AudioEngineSoundHandle> sources{};
    js::Set<AudioEngineSoundHandle> buses{};
    /** `_rampDuration`: the default parameter ramp, in seconds. */
    double ramp_duration{};
    /** `_volume`: the master volume `setMasterVolume` last set. */
    std::shared_ptr<double> volume = std::make_shared<double>();
    /** `_validFormats` / `_invalidFormats`: the format probes' answers, by extension. */
    js::Set<std::string> valid_formats{};
    js::Set<std::string> invalid_formats{};
    std::shared_ptr<AudioEngineListenerSlot> listener = std::make_shared<AudioEngineListenerSlot>();
    /** `_spatialUpdaters`: the attached spatial nodes' per-frame updates. */
    js::Set<js::Callback<void()>> spatial_updaters{};
    /** `_disposers`: what `disposeAudioEngine` runs last (a media-stream tap's release). */
    js::Array<js::Callback<void()>> disposers{};
    /** `_mainOut = out`: the record, and the gain its node handle names. */
    template <typename Out> void set_main_out(const std::shared_ptr<Out>& out) {
        main_out_record = out;
        main_out = out ? out->gain : pal::AudioNodeHandle{};
    }
    /** `_mainBus = bus`: the record, and the input its node handle names. */
    template <typename Bus> void set_main_bus(const std::shared_ptr<Bus>& bus) {
        main_bus_record = bus;
        main_bus = bus ? bus->in : pal::AudioNodeHandle{};
    }
    bool operator==(const AudioEngineHandle& other) const { return context == other.context; }
    [[nodiscard]] std::uint32_t identity() const { return context.value; }
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(main_bus);
        visitor(sources);
        visitor(buses);
        visitor(main_out);
        visitor(main_out_record);
        visitor(main_bus_record);
        visitor(listener);
        visitor(spatial_updaters);
        visitor(disposers);
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
