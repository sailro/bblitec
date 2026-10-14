#include "pal_audio_labsound.cpp"
#include <bblite/pal_audio_async.hpp>
#include <bblite/js_realm_state.hpp>
#define main generated_main
#include "../../artifacts/audio-events-check/program.hpp"
#undef main
#include <atomic>
#include <cassert>
#include <chrono>
#include <string>
#include <thread>

#define LABSOUND_FIXTURE_ENVIRONMENT
#include "labsound-fixture.hpp"

namespace {
/** A realm on its own thread creating `createAudioEngineAsync`'s context: its state, or why not. */
std::string context_on_other_thread(const std::atomic<bool>* initialized = nullptr) {
    using namespace bbl::pal;
    std::string outcome;
    std::thread([&] {
        const bbl::js::RealmScope realm;
        EventLoop loop;
        std::shared_ptr<AudioSession> session;
        loop.run([&] {
            try {
                audio_create_context_async(session).observe(
                    [&](const AudioContextHandle& created) {
                        // An announced initialization ran before the device opened.
                        assert(!initialized || *initialized);
                        outcome = audio_state(created);
                        loop.close();
                    },
                    [&](std::exception_ptr) {
                        outcome = "rejected";
                        loop.close();
                    });
            } catch (const std::runtime_error& refusal) {
                outcome = refusal.what();
                loop.close();
            }
        });
        session.reset();
    }).join();
    return outcome;
}
} // namespace

int main() {
    using namespace bbl::pal;
    // This is SDL's main thread, as a host's SDL initialization makes it.
    const bool main_ready = SDL_InitSubSystem(0);
    assert(main_ready);
    // Before that thread initializes audio, a realm elsewhere refuses rather
    // than initializing it on its own thread.
    assert(context_on_other_thread().starts_with(
        "Audio: SDL initializes its audio subsystem on its main thread, which has neither"));
    assert(!SDL_WasInit(SDL_INIT_AUDIO));

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
    // Closed devices leave SDL's audio up for the run.
    assert(SDL_WasInit(SDL_INIT_AUDIO));
    assert(bbl::js::managed_node_count() == baseline);

    // createAudioEngineAsync's context: the device opens in a native job and
    // the context joins its session on the realm in a later task; a device
    // that cannot open rejects the same promise with the same message. SDL's
    // audio is quit first, as SDL_Quit would, so the realm initializes it.
    SDL_QuitSubSystem(SDL_INIT_AUDIO);
    for (const bool available : {false, true}) {
        const bbl::js::RealmScope realm;
        EventLoop loop;
        std::shared_ptr<AudioSession> session;
        bool settled = false;
        if (!available)
            SDL_SetHintWithPriority(SDL_HINT_AUDIO_DRIVER, "bblite-missing-driver",
                                    SDL_HINT_OVERRIDE);
        loop.run([&] {
            auto pending = audio_create_context_async(session);
            assert(pending.pending() && session && contexts().empty());
            pending.observe(
                [&](const AudioContextHandle& created) {
                    assert(available && audio_state(created) == "running");
                    assert(contexts().size() == 1u);
                    // SDL initialized audio on this realm, its main thread,
                    // rather than on the thread that opened the device.
                    assert(SDL_IsMainThread());
                    settled = true;
                    loop.close();
                },
                [&](std::exception_ptr error) {
                    try {
                        std::rethrow_exception(error);
                    } catch (const std::runtime_error& failure) {
                        assert(!available &&
                               std::string_view(failure.what())
                                   .starts_with("Audio: SDL could not open a playback device."));
                    }
                    settled = true;
                    loop.close();
                });
        });
        SDL_ResetHint(SDL_HINT_AUDIO_DRIVER);
        assert(settled);
        session.reset();
        assert(contexts().empty());
        assert(static_cast<bool>(SDL_WasInit(SDL_INIT_AUDIO)) == available);
    }

    // Once SDL's main thread has initialized audio, a realm elsewhere is served.
    assert(context_on_other_thread() == "running");
    assert(contexts().empty() && SDL_WasInit(SDL_INIT_AUDIO));

    // A host announces the initialization before starting its realm and
    // performs it while the realm starts; the realm's device open waits for it.
    SDL_QuitSubSystem(SDL_INIT_AUDIO);
    assert(!SDL_WasInit(SDL_INIT_AUDIO));
    audio_announce_subsystem();
    std::atomic<bool> initialized = false;
    std::string outcome;
    std::thread realm([&] { outcome = context_on_other_thread(&initialized); });
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    initialized = true;
    audio_initialize_subsystem();
    realm.join();
    assert(outcome == "running" && SDL_WasInit(SDL_INIT_AUDIO));
}
