#pragma once

#include <bblite/deferred_capability.hpp>
#include <bblite/js_data.hpp>
#include <bblite/js_error.hpp>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace bbl::pal {

/**
 * The samples a MediaStreamAudioDestinationNode writes and stream sources read
 * (`pal_audio_labsound.cpp`); native data only.
 */
class MediaStreamAudioTap;

/** A track's live and enabled state, read by audio rendering threads. */
struct MediaStreamTrackState {
    std::atomic<bool> live{true};
    std::atomic<bool> enabled{true};
};

/** A MediaStreamTrack: an audio stream destination's output or a canvas capture. */
struct MediaStreamTrack {
    std::string kind;
    std::string id;
    std::string label;
    std::shared_ptr<MediaStreamTrackState> state = std::make_shared<MediaStreamTrackState>();
    /** The destination's samples an audio track carries; shared with its clones. */
    std::shared_ptr<MediaStreamAudioTap> audio;
};
using MediaStreamTrackHandle = std::shared_ptr<MediaStreamTrack>;

/** A MediaStream's track set, in insertion order. */
struct MediaStream {
    std::string id;
    std::vector<MediaStreamTrackHandle> tracks;
};
using MediaStreamHandle = std::shared_ptr<MediaStream>;

/**
 * Types JavaScript can name but no native operation produces: no media
 * recording encoder exists, so `new MediaRecorder` always throws and no
 * recorder or recording event is ever constructed.
 */
class UninhabitedMediaRecorder final {
    UninhabitedMediaRecorder() = delete;
};
class UninhabitedBlobEvent final {
    UninhabitedBlobEvent() = delete;
};

/** A UUID-shaped identifier, unique in the process. */
inline std::string media_stream_identifier() {
    static std::atomic<std::uint64_t> next{1};
    const auto value = next.fetch_add(1, std::memory_order_relaxed);
    char text[37];
    std::snprintf(text, sizeof text, "00000000-0000-4000-8000-%012llx",
                  static_cast<unsigned long long>(value & 0xffffffffffffULL));
    return text;
}

inline MediaStreamTrackHandle
create_media_stream_track(std::string kind, std::shared_ptr<MediaStreamAudioTap> audio = {}) {
    auto track = std::make_shared<MediaStreamTrack>();
    track->kind = std::move(kind);
    track->id = media_stream_identifier();
    track->audio = std::move(audio);
    return track;
}

inline void media_stream_add_track(const MediaStreamHandle& stream,
                                   const MediaStreamTrackHandle& track) {
    if (std::find(stream->tracks.begin(), stream->tracks.end(), track) == stream->tracks.end())
        stream->tracks.push_back(track);
}

/** `new MediaStream()`, `new MediaStream(tracks)`: each track once, in order. */
inline MediaStreamHandle create_media_stream(const js::Array<MediaStreamTrackHandle>& tracks = {}) {
    auto stream = std::make_shared<MediaStream>();
    stream->id = media_stream_identifier();
    for (const auto& track : tracks) {
        if (!track)
            throw js::NamedError("TypeError", "MediaStream requires MediaStreamTrack values.");
        media_stream_add_track(stream, track);
    }
    return stream;
}

/** `new MediaStream(stream)`: the same track objects. */
inline MediaStreamHandle create_media_stream(const MediaStreamHandle& source) {
    return create_media_stream(
        js::Array<MediaStreamTrackHandle>(source->tracks.begin(), source->tracks.end()));
}

/** `getTracks()` (audio, then video, as Chromium orders them), `getAudioTracks()`, `getVideoTracks()`. */
inline js::Array<MediaStreamTrackHandle> media_stream_tracks(const MediaStreamHandle& stream,
                                                             std::string_view kind = {}) {
    js::Array<MediaStreamTrackHandle> result;
    for (const std::string_view selected : {std::string_view("audio"), std::string_view("video")})
        if (kind.empty() || kind == selected)
            for (const auto& track : stream->tracks)
                if (track->kind == selected)
                    result.push_back(track);
    return result;
}

inline void media_stream_remove_track(const MediaStreamHandle& stream,
                                      const MediaStreamTrackHandle& track) {
    std::erase(stream->tracks, track);
}

inline js::Nullable<MediaStreamTrackHandle>
media_stream_track_by_id(const MediaStreamHandle& stream, const std::string& id) {
    for (const auto& track : stream->tracks)
        if (track->id == id)
            return track;
    return {};
}

inline std::string media_stream_id(const MediaStreamHandle& stream) { return stream->id; }
inline std::string media_stream_track_kind(const MediaStreamTrackHandle& track) {
    return track->kind;
}
inline std::string media_stream_track_id(const MediaStreamTrackHandle& track) { return track->id; }
inline std::string media_stream_track_label(const MediaStreamTrackHandle& track) {
    return track->label;
}

/** `stream.active`: some track is live. */
inline bool media_stream_active(const MediaStreamHandle& stream) {
    return std::any_of(stream->tracks.begin(), stream->tracks.end(),
                       [](const auto& track) { return track->state->live.load(); });
}

inline std::string media_stream_track_ready_state(const MediaStreamTrackHandle& track) {
    return track->state->live.load() ? "live" : "ended";
}

inline bool media_stream_track_enabled(const MediaStreamTrackHandle& track) {
    return track->state->enabled.load();
}

inline void media_stream_track_set_enabled(const MediaStreamTrackHandle& track, bool enabled) {
    track->state->enabled.store(enabled);
}

/** `track.stop()`: ended for good; an audio track's readers fall silent. */
inline void media_stream_track_stop(const MediaStreamTrackHandle& track) {
    track->state->live.store(false);
}

/** `track.clone()`: the same source, with the track's own enabled and ready state. */
inline MediaStreamTrackHandle media_stream_track_clone(const MediaStreamTrackHandle& track) {
    auto clone = create_media_stream_track(track->kind, track->audio);
    clone->label = track->label;
    clone->state->live.store(track->state->live.load());
    clone->state->enabled.store(track->state->enabled.load());
    return clone;
}

/** `stream.clone()`: a new stream of cloned tracks. */
inline MediaStreamHandle media_stream_clone(const MediaStreamHandle& stream) {
    js::Array<MediaStreamTrackHandle> tracks;
    for (const auto& track : stream->tracks)
        tracks.push_back(media_stream_track_clone(track));
    return create_media_stream(tracks);
}

/**
 * `canvas.captureStream(frameRate)`: one live video track. Natively no
 * consumer encodes its frames (there is no media recording encoder).
 */
inline MediaStreamHandle canvas_capture_stream(js::Nullable<double> frame_rate) {
    if (frame_rate && (std::isnan(*frame_rate) || *frame_rate < 0))
        throw js::make_dom_exception("Given frame rate is not supported.", "NotSupportedError");
    js::Array<MediaStreamTrackHandle> tracks;
    tracks.push_back(create_media_stream_track("video"));
    return create_media_stream(tracks);
}

/** `MediaRecorder.isTypeSupported(type)`: no type has a native encoder. */
inline bool media_recorder_type_supported(const std::string&) { return false; }

/**
 * `new MediaRecorder(stream, options)`: the NotSupportedError a browser throws
 * for a type it cannot encode; natively that is every type, the default one
 * included. T is the never-constructed recorder.
 */
template <typename T> T media_recorder_unsupported(const std::string& mime_type) {
    return opaque_throw<T>(std::make_exception_ptr(js::make_dom_exception(
        mime_type.empty()
            ? "Failed to construct 'MediaRecorder': no media recording encoder is available."
            : "Failed to construct 'MediaRecorder': Unsupported mimeType: " + mime_type,
        "NotSupportedError")));
}

/** A member of a never-constructed recorder or recording event: unreachable by construction. */
template <typename T> T uninhabited_member(std::string_view member) {
    return opaque_throw<T>(std::make_exception_ptr(
        std::logic_error(std::string(member) + " has no native instance to read.")));
}

} // namespace bbl::pal
