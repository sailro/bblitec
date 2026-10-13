#include "pal_audio_labsound.cpp"

#include <cassert>
#include <cmath>
#include <iostream>
#include <string>

namespace bbl::pal {
std::string environment_variable(const char* name) {
    char* value = nullptr;
    std::size_t length = 0;
    _dupenv_s(&value, &length, name);
    const std::string result = value ? value : "";
    std::free(value);
    return result;
}
} // namespace bbl::pal

using namespace bbl::pal;

namespace {

/** Renders `frames` more frames; the bus holds every frame rendered so far. */
std::unique_ptr<lab::AudioBus> render(AudioContextHandle handle, int frames) {
    auto& record = require_context(handle.value);
    auto scratch = std::make_shared<lab::AudioBus>(2, lab::AudioNode::ProcessingSizeInFrames);
    record.destination->offlineRender(scratch.get(), frames);
    return record.recorder->createBusFromRecording(false);
}

/** A one-channel buffer source holding `value` in every one of `frames`, started. */
AudioNodeHandle constant_source(AudioContextHandle context, float value, std::uint32_t frames) {
    const auto source = audio_create_buffer_source(context);
    const auto buffer = audio_create_buffer(context, 1, frames, 48000.0);
    auto channel = audio_buffer_channel(buffer, 0);
    for (std::size_t index = 0; index < channel.size(); ++index)
        channel[index] = value;
    audio_set_buffer(source, buffer);
    audio_node_start(source, 0.0);
    return source;
}

template <class Call> std::string thrown(Call call) {
    try {
        call();
    } catch (const bbl::js::NamedError& error) {
        return error.name;
    }
    return {};
}

/** What a lowered `catch (error)` reads off any thrown value: its name and message. */
template <class Call> std::string caught(Call call) {
    try {
        call();
    } catch (...) {
        const bbl::js::Error error(std::current_exception());
        return bbl::js::error_name(error) + ": " + bbl::js::error_message(error);
    }
    return {};
}

/** The smallest and largest sample of both channels in [first, last). */
std::pair<float, float> range_between(const lab::AudioBus& bus, int first, int last) {
    float low = 1e9f, high = -1e9f;
    for (int channel = 0; channel < 2; ++channel)
        for (int index = first; index < last; ++index) {
            low = std::min(low, bus.channel(channel)->data()[index]);
            high = std::max(high, bus.channel(channel)->data()[index]);
        }
    return {low, high};
}

bool holds(const lab::AudioBus& bus, int first, int last, float value) {
    assert(last <= bus.length());
    const auto [low, high] = range_between(bus, first, last);
    return std::abs(low - value) < 1e-4f && std::abs(high - value) < 1e-4f;
}

/** Whether the last `frames` frames rendered all hold `value`. */
bool ends_with(const lab::AudioBus& bus, int frames, float value) {
    return holds(bus, bus.length() - frames, bus.length(), value);
}

void check_same_context_routing() {
    const auto context = audio_create_context();
    const auto destination = audio_create_media_stream_destination(context);
    const auto stream = audio_destination_stream(destination);
    // One stream per node, one live audio track.
    assert(audio_destination_stream(destination) == stream);
    assert(stream->tracks.size() == 1 && stream->tracks[0]->kind == "audio");
    assert(media_stream_track_ready_state(stream->tracks[0]) == "live");
    // A mono input is up-mixed to both channels of the stream.
    audio_connect(constant_source(context, 0.25f, 48000), destination);
    const auto input = audio_create_media_stream_source(context, stream);
    audio_connect(input, audio_destination(context));
    const auto bus = render(context, 1024);
    // The destination renders after the context's own output pulls the
    // source, so the stream reaches it one quantum late.
    assert(holds(*bus, 0, 128, 0.0f));
    assert(holds(*bus, 128, 1024, 0.25f));
    audio_close_context(context);
}

void check_cross_context_routing() {
    // The capture mixer's shape: producers in their own contexts, one mixer.
    const auto producer = audio_create_context();
    const auto mixer = audio_create_context();
    const auto output = audio_create_gain(producer);
    audio_connect(constant_source(producer, 0.5f, 48000), output);
    audio_connect(output, audio_destination(producer));
    const auto tap = audio_create_media_stream_destination(producer);
    audio_connect(output, tap);
    const auto stream = audio_destination_stream(tap);
    const auto mix = audio_create_media_stream_destination(mixer);
    const auto input = audio_create_media_stream_source(mixer, stream);
    audio_connect(input, mix);
    audio_connect(input, audio_destination(mixer));
    // Offline contexts render in turn: the mixer reads the producer's whole render.
    const auto produced = render(producer, 1024);
    assert(holds(*produced, 0, 1024, 0.5f));
    const auto mixed = render(mixer, 1024);
    assert(holds(*mixed, 0, 1024, 0.5f));

    // A disabled track is silent; enabled again, it carries the audio.
    const auto& track = stream->tracks[0];
    media_stream_track_set_enabled(track, false);
    render(producer, 512);
    assert(ends_with(*render(mixer, 512), 512, 0.0f));
    media_stream_track_set_enabled(track, true);
    // A clone shares the source; stopping the original leaves the clone live.
    const auto clone = media_stream_track_clone(track);
    assert(clone != track && clone->id != track->id && clone->audio == track->audio);
    bbl::js::Array<MediaStreamTrackHandle> cloned;
    cloned.push_back(clone);
    const auto clone_input = audio_create_media_stream_source(mixer, create_media_stream(cloned));
    audio_disconnect(input);
    audio_connect(clone_input, audio_destination(mixer));
    media_stream_track_stop(track);
    assert(media_stream_track_ready_state(track) == "ended");
    assert(media_stream_track_ready_state(clone) == "live");
    render(producer, 1024);
    assert(ends_with(*render(mixer, 1024), 1024, 0.5f));
    media_stream_track_stop(clone);
    render(producer, 2048);
    assert(ends_with(*render(mixer, 512), 512, 0.0f));
    // Disconnecting the producer's tap edge ends what reaches the mix.
    audio_disconnect(output, tap);
    assert(thrown([&] { audio_disconnect(output, tap); }) == "InvalidAccessError");
    audio_close_context(mixer);
    audio_close_context(producer);
}

void check_sources_need_audio_tracks() {
    const auto context = audio_create_context();
    assert(thrown([&] { audio_create_media_stream_source(context, create_media_stream()); }) ==
           "InvalidStateError");
    // A canvas capture carries one live video track and no audio.
    const auto captured = canvas_capture_stream(60.0);
    assert(media_stream_tracks(captured, "video").size() == 1 &&
           media_stream_tracks(captured, "audio").size() == 0);
    assert(thrown([&] { audio_create_media_stream_source(context, captured); }) ==
           "InvalidStateError");
    assert(thrown([] { canvas_capture_stream(-1.0); }) == "NotSupportedError");
    audio_close_context(context);
}

/** An absent stream or track is a TypeError a script's catch observes. */
void check_absent_operands_are_type_errors() {
    const auto context = audio_create_context();
    assert(caught([&] { audio_create_media_stream_source(context, nullptr); }) ==
           "TypeError: createMediaStreamSource requires a MediaStream.");
    assert(caught([] {
               create_media_stream(
                   bbl::js::Array<MediaStreamTrackHandle>{MediaStreamTrackHandle{}});
           }) == "TypeError: MediaStream requires MediaStreamTrack values.");
    audio_close_context(context);
}

void check_stream_objects() {
    const auto context = audio_create_context();
    const auto audio = audio_destination_stream(audio_create_media_stream_destination(context));
    const auto video = canvas_capture_stream(std::nullopt);
    const auto stream = create_media_stream(media_stream_tracks(video));
    assert(stream != video && stream->id != video->id && stream->tracks == video->tracks);
    // Insertion order within a kind; audio before video; one entry per track.
    media_stream_add_track(stream, audio->tracks[0]);
    media_stream_add_track(stream, audio->tracks[0]);
    const auto tracks = media_stream_tracks(stream);
    assert(tracks.size() == 2 && tracks[0] == audio->tracks[0] && tracks[1] == video->tracks[0]);
    assert(media_stream_track_by_id(stream, video->tracks[0]->id).has_value());
    media_stream_remove_track(stream, audio->tracks[0]);
    assert(media_stream_tracks(stream, "audio").size() == 0);
    assert(media_stream_active(stream));
    media_stream_track_stop(video->tracks[0]);
    media_stream_track_stop(video->tracks[0]);
    assert(!media_stream_active(stream));
    // A clone of an ended track is ended.
    assert(media_stream_track_ready_state(media_stream_track_clone(video->tracks[0])) == "ended");
    const auto copy = media_stream_clone(stream);
    assert(copy->tracks.size() == 1 && copy->tracks[0] != video->tracks[0]);
    audio_close_context(context);
}

void check_media_recorder() {
    for (const char* type :
         {"video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm", ""})
        assert(!media_recorder_type_supported(type));
    using Recorder = std::shared_ptr<UninhabitedMediaRecorder>;
    assert(thrown([] { media_recorder_unsupported<Recorder>("video/mp4"); }) ==
           "NotSupportedError");
    assert(thrown([] { media_recorder_unsupported<Recorder>(""); }) == "NotSupportedError");
}

} // namespace

int main() {
    // Offline capture contexts, rendered here quantum by quantum.
    _putenv_s("BBLITE_AUDIO_CAPTURE", "fixture-unused.wav");
    check_same_context_routing();
    check_cross_context_routing();
    check_sources_need_audio_tracks();
    check_absent_operands_are_type_errors();
    check_stream_objects();
    check_media_recorder();
    std::cout << "media-stream-audio-check: ok\n";
    return 0;
}
