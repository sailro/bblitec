#include "pal_audio_labsound.cpp"
#define main generated_main
#include "../../artifacts/audio-events-check/program.hpp"
#undef main
#include <cassert>

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

int main() {
    using namespace bbl::pal;
    const auto baseline = bbl::js::managed_node_count();
    // A never-started source/listener cycle has no pending native operation.
    const auto context = audio_create_context();
    std::weak_ptr<AudioNodeRecord> abandoned;
    {
        const auto source = audio_create_oscillator(context);
        abandoned = source.ownership;
        const auto parameter = audio_node_param(source, AudioParamName::Frequency);
        audio_add_ended_listener(
            source, 1, bbl::js::make_closure(std::tuple{source, parameter}, [](auto& captures) {
                audio_disconnect(std::get<0>(captures));
                static_cast<void>(audio_param_value(std::get<1>(captures)));
            }));
    }
    bbl::js::collect_cycles();
    assert(abandoned.expired());
    audio_close_context(context);
    assert(generated_main() == 0);
    bbl::js::collect_cycles();
    assert(contexts().empty());
    assert(!SDL_WasInit(SDL_INIT_AUDIO));
    assert(bbl::js::managed_node_count() == baseline);
}
