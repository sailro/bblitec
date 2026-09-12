#define BBLITE_WORKERS 1
#define BBLITE_OFFSCREEN_SURFACES 1
#define BBLITE_HAS_AUDIO_BUFFER_SOURCE 1
#define BBLITE_HAS_AUDIO_DECODE_FILE 1
#define BBLITE_AUDIO_DECODE_WAV 1
#include "pal_audio_labsound.cpp"
#define main generated_main
#include "../../artifacts/audio-context-check/program.hpp"
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
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.on_error([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.on_unhandled_rejection([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.run([&] { initialize(realm); });
    return 0;
}
}

int main() {
    assert(generated_main() == 0);
    assert(bbl::pal::contexts().empty());
    assert(!SDL_WasInit(SDL_INIT_AUDIO));
}
