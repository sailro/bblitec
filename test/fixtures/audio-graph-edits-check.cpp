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

std::unique_ptr<lab::AudioBus> render(AudioContextHandle handle, int frames) {
    auto& record = require_context(handle.value);
    auto scratch = std::make_shared<lab::AudioBus>(2, lab::AudioNode::ProcessingSizeInFrames);
    record.destination->offlineRender(scratch.get(), frames);
    return record.recorder->createBusFromRecording(false);
}

/** A one-channel buffer source holding `value` in every one of `frames`. */
AudioNodeHandle constant_source(AudioContextHandle context, float value, std::uint32_t frames) {
    const auto source = audio_create_buffer_source(context);
    const auto buffer = audio_create_buffer(context, 1, frames, 48000.0);
    auto channel = audio_buffer_channel(buffer, 0);
    for (std::size_t index = 0; index < channel.size(); ++index)
        channel[index] = value;
    audio_set_buffer(source, buffer);
    return source;
}

/** The DOMException name (or Error name) a call throws, empty when it returns. */
template <class Call> std::string thrown(Call call) {
    try {
        call();
    } catch (const bbl::js::NamedError& error) {
        return error.name;
    } catch (const std::runtime_error&) {
        return "runtime_error";
    }
    return {};
}

float peak_between(const lab::AudioBus& bus, int first, int last) {
    float peak = 0.0f;
    for (int index = first; index < last; ++index)
        peak = std::max(peak, std::abs(bus.channel(0)->data()[index]));
    return peak;
}

void check_targeted_disconnect() {
    const auto context = audio_create_context();
    const auto destination = audio_destination(context);
    const auto source = constant_source(context, 0.25f, 4096);
    const auto left = audio_create_gain(context);
    const auto right = audio_create_gain(context);
    audio_connect(source, left);
    audio_connect(source, right);
    audio_connect(left, destination);
    audio_connect(right, destination);
    // A parameter edge to the same node survives a disconnect of its input.
    const auto modulator = constant_source(context, 0.0f, 4096);
    audio_connect(modulator, left);
    audio_connect_param(modulator, audio_node_param(left, AudioParamName::Gain));
    audio_node_start(source, 0.0);
    audio_node_start(modulator, 0.0);
    auto both = render(context, 512);
    assert(std::abs(peak_between(*both, 256, 512) - 0.5f) < 1e-3f);

    // Only the source's edge into `left` goes; `right` still sounds.
    audio_disconnect(source, left);
    auto one = render(context, 512);
    assert(std::abs(peak_between(*one, one->length() - 256, one->length()) - 0.25f) < 1e-3f);
    // Disconnecting it again, or through an index the nodes do not have.
    assert(thrown([&] { audio_disconnect(source, left); }) == "InvalidAccessError");
    assert(thrown([&] { audio_disconnect(source, right, 1.0); }) == "IndexSizeError");
    assert(thrown([&] { audio_disconnect(source, right, 0.0, 1.0); }) == "IndexSizeError");
    assert(thrown([&] { audio_disconnect(destination, source); }) == "InvalidAccessError");
    const auto other = audio_create_context();
    assert(thrown([&] { audio_disconnect(source, audio_create_gain(other)); }) ==
           "InvalidAccessError");

    // The modulator's input edge goes; its parameter edge keeps `left` reached.
    audio_disconnect(modulator, left, 0.0, 0.0);
    auto& graph = require_context(context.value).graph;
    const auto& edges = graph.at(require_node(modulator).get());
    assert(edges.node_edges.empty() && edges.param_edges.size() == 1);
    assert(edges.outputs.size() == 1 && edges.outputs[0] == require_node(left).get());
    assert(thrown([&] { audio_disconnect(modulator, left); }) == "InvalidAccessError");
    audio_close_context(other);
    audio_close_context(context);
}

void check_value_curve() {
    const auto context = audio_create_context();
    const auto source = constant_source(context, 0.5f, 8192);
    const auto gain = audio_create_gain(context);
    audio_connect(source, gain);
    audio_connect(gain, audio_destination(context));
    const auto param = audio_node_param(gain, AudioParamName::Gain);
    bbl::js::F32Array curve(std::size_t{2});
    curve[0] = 0.0f;
    curve[1] = 1.0f;
    audio_param_cancel_scheduled_values(param, 0.0);
    audio_param_set_value_curve(param, curve, 0.0, 2048.0 / 48000.0);
    // The values were copied at the call.
    curve[1] = 0.0f;
    audio_node_start(source, 0.0);
    auto pcm = render(context, 4096);
    const auto* samples = pcm->channel(0)->data();
    // Linear between the values, as Web Audio interpolates a curve.
    assert(std::abs(samples[0]) < 0.01f);
    assert(std::abs(samples[512] - 0.125f) < 0.002f);
    assert(std::abs(samples[1024] - 0.25f) < 0.002f);
    assert(std::abs(samples[3072] - 0.5f) < 0.01f);

    bbl::js::F32Array single(std::size_t{1});
    assert(thrown([&] { audio_param_set_value_curve(param, single, 0.0, 1.0); }) ==
           "InvalidStateError");
    assert(thrown([&] { audio_param_set_value_curve(param, curve, -1.0, 1.0); }) == "RangeError");
    assert(thrown([&] { audio_param_set_value_curve(param, curve, 0.0, 0.0); }) == "RangeError");
    assert(thrown([&] { audio_param_set_value_curve(param, curve, NAN, 1.0); }) == "TypeError");
    audio_close_context(context);
}

void check_loop_points_and_duration() {
    const auto context = audio_create_context();
    const auto whole = constant_source(context, 0.25f, 480);
    assert(!audio_loop(whole) && audio_loop_start(whole) == 0.0 && audio_loop_end(whole) == 0.0);
    audio_set_loop(whole, true);
    audio_set_loop_start(whole, 0.0);
    audio_set_loop_end(whole, 0.0);
    assert(audio_loop(whole));
    audio_connect(whole, audio_destination(context));
    // An absent duration is the two-argument start: a whole-buffer loop plays on.
    audio_node_start(whole, 0.0, 0.0, bbl::js::Nullable<double>{});
    auto pcm = render(context, 4096);
    assert(peak_between(*pcm, pcm->length() - 512, pcm->length()) > 0.2f);

    // Points spanning the whole buffer are the whole-buffer loop.
    const auto spanning = constant_source(context, 0.25f, 480);
    audio_set_loop(spanning, true);
    audio_set_loop_end(spanning, 0.01);
    audio_node_start(spanning, 0.0);

    // A region inside the buffer, or a duration, is refused at start.
    const auto region = constant_source(context, 0.25f, 480);
    audio_set_loop(region, true);
    audio_set_loop_start(region, 0.001);
    audio_set_loop_end(region, 0.005);
    assert(audio_loop_start(region) == 0.001 && audio_loop_end(region) == 0.005);
    assert(thrown([&] { audio_node_start(region, 0.0); }) == "runtime_error");
    const auto timed = constant_source(context, 0.25f, 480);
    audio_set_loop(timed, true);
    assert(thrown([&] { audio_node_start(timed, 0.0, 0.0, bbl::js::Nullable<double>{0.5}); }) ==
           "runtime_error");
    assert(thrown([&] { audio_set_loop_end(timed, INFINITY); }) == "TypeError");
    // Without a loop the points and the duration are the browser's.
    const auto once = constant_source(context, 0.25f, 480);
    audio_set_loop_start(once, 0.001);
    audio_set_loop_end(once, 0.005);
    audio_node_start(once, 0.0, 0.0, bbl::js::Nullable<double>{0.005});
    audio_close_context(context);
}

} // namespace

int main() {
    _putenv_s("BBLITE_AUDIO_CAPTURE", "fixture-unused.wav");
    check_targeted_disconnect();
    check_value_curve();
    check_loop_points_and_duration();
    std::cout << "audio-graph-edits-check: ok\n";
    return 0;
}
