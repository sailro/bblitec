#pragma once

/**
 * SDL3 behind LabSound's own `lab::AudioDevice` seam.
 *
 * LabSound abstracts the platform stream behind one pure-virtual class --
 * `start`/`stop`/`isRunning`/`backendReinitialize` plus a
 * `render(frames, out, in)` that pulls the graph a 128-frame quantum at a
 * time -- and every shipped backend (RtAudio, miniaudio, mock) is exactly
 * one translation unit implementing it. `AudioDevice` is public, so this
 * backend lives here rather than in a fork: SDL3 is already this
 * project's platform layer, and nothing else about LabSound changes.
 *
 * SDL3's model is a pull callback: `SDL_OpenAudioDeviceStream` installs a
 * "get" callback saying how many bytes the device wants right now, the
 * callback renders that many frames interleaved, and
 * `SDL_PutAudioStreamData` hands them over. SDL owns the audio thread and
 * the conversion to the hardware format, so the graph always runs at the
 * rate it was configured with.
 *
 * Included by `pal_audio_labsound.cpp` alone.
 */

#include "LabSound/core/AudioBus.h"
#include "LabSound/core/AudioDevice.h"
#include "LabSound/core/AudioNode.h"
#include "LabSound/extended/VectorMath.h"

#include <SDL3/SDL.h>

#include <algorithm>
#include <chrono>
#include <memory>
#include <vector>

namespace bbl::pal::detail {

class AudioDeviceSdl3 final : public lab::AudioDevice {
public:
    AudioDeviceSdl3(
        const lab::AudioStreamConfig& input_config,
        const lab::AudioStreamConfig& output_config)
        : lab::AudioDevice(input_config, output_config)
    {
        if (!SDL_InitSubSystem(SDL_INIT_AUDIO)) {
            return;
        }

        SDL_AudioSpec spec{};
        spec.format = SDL_AUDIO_F32;
        spec.channels = static_cast<int>(
            _outConfig.desired_channels ? _outConfig.desired_channels : 2);
        spec.freq = static_cast<int>(
            _outConfig.desired_samplerate > 0.0f ? _outConfig.desired_samplerate : 48000.0f);

        stream_ = SDL_OpenAudioDeviceStream(
            SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, &AudioDeviceSdl3::feed, this);
        if (!stream_) {
            return;
        }

        _outConfig.desired_channels = static_cast<std::uint32_t>(spec.channels);
        _outConfig.desired_samplerate = static_cast<float>(spec.freq);
        sample_rate_ = static_cast<float>(spec.freq);
        sampling_info_.epoch[0] = sampling_info_.epoch[1] =
            std::chrono::high_resolution_clock::now();

        // Everything the callback needs is allocated HERE, not on the
        // audio thread. `SDL_OpenAudioDeviceStream` opens the device
        // paused, so no callback can run before `start()` -- and the
        // callback's deadline is a couple of milliseconds, which is not
        // where a heap allocation belongs. `additional_amount` varies
        // per call (SDL over-estimates for buffering and resampling), so
        // the scratch is sized from the device's own buffer size with
        // headroom and the callback clamps to it rather than growing.
        const int quantum = lab::AudioNode::ProcessingSizeInFrames;
        render_bus_ = std::make_unique<lab::AudioBus>(
            _outConfig.desired_channels, quantum, true);
        render_bus_->setSampleRate(sample_rate_);
        if (_inConfig.desired_channels) {
            input_bus_ = std::make_unique<lab::AudioBus>(
                _inConfig.desired_channels, quantum, true);
            input_bus_->setSampleRate(sample_rate_);
        }

        SDL_AudioSpec device_spec{};
        int device_frames = 0;
        if (!SDL_GetAudioDeviceFormat(SDL_GetAudioStreamDevice(stream_),
                                      &device_spec, &device_frames) ||
            device_frames <= 0) {
            device_frames = 4096;
        }
        // Four device buffers of headroom, and never less than a quantum:
        // SDL asks for at most one buffer at a time in practice, and a
        // request past the scratch is clipped rather than reallocated.
        scratch_.assign(
            static_cast<std::size_t>(std::max(device_frames * 4, quantum)) *
                static_cast<std::size_t>(spec.channels),
            0.0f);
    }

    ~AudioDeviceSdl3() override
    {
        if (stream_) {
            // Destroying the stream closes the device opened with it and
            // guarantees the callback is no longer running -- so the buses
            // below cannot be in use by the time they are released.
            SDL_DestroyAudioStream(stream_);
            stream_ = nullptr;
        }
    }

    /** Whether the SDL device came up at all; the PAL turns this into a throw. */
    bool opened() const { return stream_ != nullptr; }

    void start() override
    {
        if (!stream_) return;
        if (!SDL_ResumeAudioStreamDevice(stream_)) return;
        running_ = true;
    }

    void stop() override
    {
        if (!stream_) return;
        SDL_PauseAudioStreamDevice(stream_);
        running_ = false;
    }

    bool isRunning() const override { return running_; }

    void backendReinitialize() override
    {
        stop();
        start();
    }

    /**
     * The graph pull, in the shape every LabSound backend implements it:
     * one 128-frame quantum at a time, de-interleaved to interleaved
     * through `vclip` (which clips and strides in one pass), with the
     * unconsumed tail of a quantum carried across callbacks in
     * `remainder_` because SDL asks for arbitrary byte counts.
     */
    int render(int requested_frames, void* output_buffer, void* /*input_buffer*/) override
    {
        const int quantum = lab::AudioNode::ProcessingSizeInFrames;
        int frames = requested_frames;
        if (!render_bus_) return 0;

        float* out = static_cast<float*>(output_buffer);
        const int channels = static_cast<int>(_outConfig.desired_channels);

        while (frames > 0) {
            if (remainder_ > 0) {
                const int samples = std::min(remainder_, frames);
                for (int channel = 0; channel < channels; ++channel) {
                    lab::AudioChannel* source = render_bus_->channel(channel);
                    lab::VectorMath::vclip(
                        source->data() + quantum - remainder_, /*src_stride*/ 1,
                        &kLow, &kHigh,
                        out + channel, /*dst_stride*/ channels, samples);
                }
                out += channels * samples;
                frames -= samples;
                remainder_ -= samples;
                continue;
            }

            // The low bit of `current_sample_frame` selects the epoch slot
            // written last, so time and epoch stay atomically readable from
            // the graph -- LabSound's own convention, copied exactly.
            const std::int32_t index =
                1 - static_cast<std::int32_t>(sampling_info_.current_sample_frame & 1);
            const std::uint64_t base = sampling_info_.current_sample_frame & ~1ull;
            sampling_info_.sampling_rate = sample_rate_;
            sampling_info_.current_sample_frame = base + quantum + index;
            sampling_info_.current_time =
                sampling_info_.current_sample_frame / static_cast<double>(sample_rate_);
            sampling_info_.epoch[index] = std::chrono::high_resolution_clock::now();

            _destinationNode->render(
                sourceProvider(), input_bus_.get(), render_bus_.get(), quantum,
                sampling_info_);
            remainder_ = quantum;
        }
        return requested_frames;
    }

private:
    static void SDLCALL feed(
        void* userdata, SDL_AudioStream* stream, int additional_amount, int /*total*/)
    {
        auto* self = static_cast<AudioDeviceSdl3*>(userdata);
        if (!self || additional_amount <= 0) return;

        const int channels = static_cast<int>(self->_outConfig.desired_channels);
        if (channels <= 0) return;

        int frames = additional_amount / (channels * static_cast<int>(sizeof(float)));
        if (frames <= 0) return;

        // Clamp rather than grow: allocating here would be an allocation
        // on the audio thread. A request past the scratch is served short,
        // and SDL asks again on the next callback.
        const int capacity =
            static_cast<int>(self->scratch_.size()) / channels;
        frames = std::min(frames, capacity);
        if (frames <= 0) return;

        self->render(frames, self->scratch_.data(), nullptr);
        SDL_PutAudioStreamData(
            stream, self->scratch_.data(),
            frames * channels * static_cast<int>(sizeof(float)));
    }

    static constexpr float kLow = -1.0f;
    static constexpr float kHigh = 1.0f;

    std::unique_ptr<lab::AudioBus> render_bus_;
    std::unique_ptr<lab::AudioBus> input_bus_;
    SDL_AudioStream* stream_ = nullptr;
    lab::SamplingInfo sampling_info_{};
    std::vector<float> scratch_;
    int remainder_ = 0;
    bool running_ = false;
    float sample_rate_ = 0.0f;
};

} // namespace bbl::pal::detail
