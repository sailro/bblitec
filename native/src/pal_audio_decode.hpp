#pragma once

#include <algorithm>
#include <cstdint>
#include <span>
#include <string_view>
#include <limits>
#include <memory>
#include <vector>
#include <LabSound/core/AudioBus.h>
#include <libnyquist/Decoders.h>

namespace bbl::pal {

/** Bounded container detection for libnyquist's memory decoders. */
inline std::string_view audio_container_extension(std::span<const std::uint8_t> bytes) {
    if (bytes.empty()) return {};
    const std::string_view header(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    if (header.starts_with("RIFF") && header.size() >= 12 && header.substr(8, 4) == "WAVE") return "wav";
    if (header.starts_with("wvpk")) return "wv";
    if (header.starts_with("MPCK")) return "mpc";
    if (header.starts_with("fLaC")) return "flac";
    if (header.starts_with("ID3") || (bytes.size() >= 2 && bytes[0] == 0xff && (bytes[1] & 0xe0) == 0xe0)) return "mp3";
    if (header.starts_with("OggS")) {
        const auto page = header.substr(0, std::min<std::size_t>(64, header.size()));
        if (page.find("OpusHead") != std::string_view::npos) return "opus";
        if (page.find("vorbis") != std::string_view::npos) return "ogg";
    }
    return {};
}

/** Select a container decoder without constructing libnyquist's global registry. */
inline std::unique_ptr<lab::AudioBus> decode_audio_bus(
    const std::vector<std::uint8_t>& bytes, std::string_view extension) {
    (void)bytes;
    (void)extension;
    nqr::AudioData pcm;
    bool decoded = false;
#if defined(BBLITE_AUDIO_DECODE_WAV) && BBLITE_AUDIO_DECODE_WAV
    if (extension == "wav") { nqr::WavDecoder{}.LoadFromBuffer(&pcm, bytes); decoded = true; }
#endif
#if defined(BBLITE_AUDIO_DECODE_WV) && BBLITE_AUDIO_DECODE_WV
    if (extension == "wv") { nqr::WavPackDecoder{}.LoadFromBuffer(&pcm, bytes); decoded = true; }
#endif
#if defined(BBLITE_AUDIO_DECODE_MPC) && BBLITE_AUDIO_DECODE_MPC
    if (extension == "mpc") { nqr::MusepackDecoder{}.LoadFromBuffer(&pcm, bytes); decoded = true; }
#endif
#if defined(BBLITE_AUDIO_DECODE_FLAC) && BBLITE_AUDIO_DECODE_FLAC
    if (extension == "flac") { nqr::FlacDecoder{}.LoadFromBuffer(&pcm, bytes); decoded = true; }
#endif
#if defined(BBLITE_AUDIO_DECODE_MP3) && BBLITE_AUDIO_DECODE_MP3
    if (extension == "mp3") { nqr::Mp3Decoder{}.LoadFromBuffer(&pcm, bytes); decoded = true; }
#endif
#if defined(BBLITE_AUDIO_DECODE_OPUS) && BBLITE_AUDIO_DECODE_OPUS
    if (extension == "opus") { nqr::OpusDecoder{}.LoadFromBuffer(&pcm, bytes); decoded = true; }
#endif
#if defined(BBLITE_AUDIO_DECODE_OGG) && BBLITE_AUDIO_DECODE_OGG
    if (extension == "ogg") { nqr::VorbisDecoder{}.LoadFromBuffer(&pcm, bytes); decoded = true; }
#endif
    if (!decoded || pcm.channelCount <= 0 || pcm.sampleRate <= 0 || pcm.samples.empty()) return {};
    const auto channels = static_cast<std::size_t>(pcm.channelCount);
    const auto frames = pcm.samples.size() / channels;
    if (frames == 0 || frames > static_cast<std::size_t>(std::numeric_limits<int>::max())) return {};
    auto bus = std::make_unique<lab::AudioBus>(pcm.channelCount, static_cast<int>(frames));
    bus->setSampleRate(static_cast<float>(pcm.sampleRate));
    for (std::size_t channel = 0; channel < channels; ++channel) {
        auto* destination = bus->channel(static_cast<int>(channel))->mutableData();
        for (std::size_t frame = 0; frame < frames; ++frame) {
            destination[frame] = pcm.samples[frame * channels + channel];
        }
    }
    return bus;
}

} // namespace bbl::pal
