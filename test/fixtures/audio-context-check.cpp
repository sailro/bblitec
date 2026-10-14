#include "pal_audio_labsound.cpp"
#define main generated_main
#include "../../artifacts/audio-context-check/program.hpp"
#undef main
#include <cassert>

#define LABSOUND_FIXTURE_ENVIRONMENT
#include "labsound-fixture.hpp"
#include "realm-application-fixture.hpp"

int main() {
    assert(generated_main() == 0);
    assert(bbl::pal::contexts().empty());
    // Its closed devices leave SDL's audio up for the run.
    assert(SDL_WasInit(SDL_INIT_AUDIO));
}
