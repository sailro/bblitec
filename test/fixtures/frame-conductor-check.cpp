#include "pal_frame_conductor.hpp"
#include <algorithm>
#include <cassert>
#include <stdexcept>
#include <string>
#include <vector>

using namespace bbl::pal;

// The turn's end the conductor runs once an application replaced `engine._renderFn`
// (render-function-conductor-check drives that path); these frames never reach it.
void bbl::pal::finish_animation_turn(bbl::Engine&) { assert(false); }

namespace {
bbl::Engine engine;
} // namespace

template <FrameAcquirePhase Acquire> struct Renderer {
    static constexpr FrameAcquirePhase acquire_phase = Acquire;
    std::vector<std::string> events;
    bool running = true;
    bool surface_available = true;
    FramePreparation preparation = FramePreparation::ready;
    FramePreparation update_result = FramePreparation::ready;
    FramePreparation present_result = FramePreparation::ready;
    bool holds_image = true;
    std::string fail_at;
    unsigned completed = 0;
    void event(const char* name) {
        events.emplace_back(name);
        if (fail_at == name)
            throw std::runtime_error(name);
    }
    bool keep_running() {
        event("gate");
        return running;
    }
    FramePreparation prepare() {
        event("prepare");
        return preparation;
    }
    bool freeze() {
        event("freeze");
        return holds_image;
    }
    bool begin_animation_turn() {
        event("turn");
        return true;
    }
    FramePreparation update() {
        event("update");
        return update_result;
    }
    bool acquire() {
        event("acquire");
        return surface_available;
    }
    void synchronize() { event("sync"); }
    void encode() { event("encode"); }
    FramePreparation present() {
        event("present");
        return present_result;
    }
    void complete() {
        event("complete");
        ++completed;
    }
};

template <FrameAcquirePhase Acquire> void check() {
    Renderer<Acquire> renderer;
    assert(conduct_frame(renderer, engine) == FrameOutcome::rendered);
    std::vector<std::string> expected{"gate",   "prepare", "update",  "sync",
                                      "encode", "present", "complete"};
    const auto position = Acquire == FrameAcquirePhase::before_update    ? 2
                          : Acquire == FrameAcquirePhase::before_uploads ? 3
                                                                         : 4;
    expected.insert(expected.begin() + position, "acquire");
    assert(renderer.events == expected && renderer.completed == 1);
    for (const auto [preparation, outcome] :
         {std::pair{FramePreparation::stop, FrameOutcome::stopped},
          std::pair{FramePreparation::restart, FrameOutcome::restart},
          std::pair{FramePreparation::skip, FrameOutcome::skipped}}) {
        Renderer<Acquire> preparing;
        preparing.preparation = preparation;
        assert(conduct_frame(preparing, engine) == outcome);
        assert(preparing.events == std::vector<std::string>({"gate", "prepare"}));
        Renderer<Acquire> updating;
        updating.update_result = preparation;
        assert(conduct_frame(updating, engine) == outcome);
        assert(updating.events ==
               std::vector<std::string>(expected.begin(),
                                        std::find(expected.begin(), expected.end(), "update") + 1));
        Renderer<Acquire> presenting;
        presenting.present_result = preparation;
        assert(conduct_frame(presenting, engine) == outcome && presenting.completed == 0);
        assert(presenting.events == std::vector<std::string>(expected.begin(), expected.end() - 1));
    }
    struct VoidPresent : Renderer<Acquire> {
        void present() { this->event("present"); }
    };
    VoidPresent ordinary;
    assert(conduct_frame(ordinary, engine) == FrameOutcome::rendered &&
           ordinary.events == expected);
    renderer.events.clear();
    renderer.update_result = FramePreparation::restart;
    assert(conduct_frame(renderer, engine) == FrameOutcome::restart);
    assert(renderer.events ==
           std::vector<std::string>(expected.begin(),
                                    std::find(expected.begin(), expected.end(), "update") + 1));
    renderer.update_result = FramePreparation::ready;
    renderer.events.clear();
    renderer.surface_available = false;
    assert(conduct_frame(renderer, engine) == FrameOutcome::skipped);
    assert(renderer.events ==
           std::vector<std::string>(expected.begin(), expected.begin() + position + 1));
    assert(renderer.completed == 1);
    renderer.events.clear();
    renderer.preparation = FramePreparation::restart;
    assert(conduct_frame(renderer, engine) == FrameOutcome::restart);
    assert(renderer.events == std::vector<std::string>({"gate", "prepare"}));
    renderer.events.clear();
    renderer.preparation = FramePreparation::stop;
    assert(conduct_frame(renderer, engine) == FrameOutcome::stopped);
    assert(renderer.events == std::vector<std::string>({"gate", "prepare"}));
    renderer.events.clear();
    renderer.running = false;
    assert(conduct_frame(renderer, engine) == FrameOutcome::stopped);
    assert(renderer.events == std::vector<std::string>({"gate"}));
    // A frame that begins with the engine stopped draws nothing; a renderer
    // holding no image for a pending capture draws the frame once more.
    engine.stopped = true;
    Renderer<Acquire> frozen;
    assert(conduct_frame(frozen, engine) == FrameOutcome::frozen && frozen.completed == 0);
    assert(frozen.events == std::vector<std::string>({"gate", "prepare", "freeze"}));
    Renderer<Acquire> redrawn;
    redrawn.holds_image = false;
    assert(conduct_frame(redrawn, engine) == FrameOutcome::rendered && redrawn.completed == 1);
    std::vector<std::string> redrawn_events = expected;
    redrawn_events.insert(redrawn_events.begin() + 2, "freeze");
    assert(redrawn.events == redrawn_events);
    engine.stopped = false;
    for (const auto& stage : expected) {
        Renderer<Acquire> failing;
        failing.fail_at = stage;
        bool threw = false;
        try {
            conduct_frame(failing, engine);
        } catch (const std::runtime_error&) {
            threw = true;
        }
        assert(threw && failing.events.back() == stage && failing.completed == 0);
    }
}

int main() {
    check<FrameAcquirePhase::before_update>();
    check<FrameAcquirePhase::before_uploads>();
    check<FrameAcquirePhase::before_encoding>();
}
