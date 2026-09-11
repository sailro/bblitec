#pragma once

#include <cstdint>
#include <memory>

namespace bbl::pal {

/** Resource identity is available to data containers without starting audio. */
struct AudioContextHandle {
    std::uint32_t value = 0;
    bool operator==(const AudioContextHandle&) const = default;
};

struct AudioNodeRecord;
struct AudioNodeHandle {
    std::uint32_t value = 0;
    std::shared_ptr<AudioNodeRecord> ownership;
    bool operator==(const AudioNodeHandle&) const = default;
};

struct AudioBufferRecord;
struct AudioBufferHandle {
    std::uint32_t value = 0;
    std::shared_ptr<AudioBufferRecord> ownership;
    bool operator==(const AudioBufferHandle&) const = default;
};

enum class AudioParamName : std::uint8_t {
    Gain,
    Frequency,
    Detune,
    Q,
    Pan,
    PlaybackRate,
};

/** Repeated reads of one node's parameter name refer to the same object. */
struct AudioParamHandle {
    AudioNodeHandle node;
    AudioParamName name = AudioParamName::Gain;
    bool operator==(const AudioParamHandle&) const = default;
    [[nodiscard]] std::uint64_t identity() const {
        return (static_cast<std::uint64_t>(node.value) << 32) | static_cast<std::uint32_t>(name);
    }
};

struct MediaStream;
struct MediaStreamTrack;

} // namespace bbl::pal
