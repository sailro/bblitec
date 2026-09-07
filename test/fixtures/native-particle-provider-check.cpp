#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>

// Compiler boundary fixture: the particle lowerer's own tests verify the
// pinned simulation. This receiver observes source call and callback order.
namespace bbl::upstream {
bbl::js::Callback<bbl::js::F32Array()> provider;
bool started = false;
std::array<float, 16> sample_node_particle_emitter(bbl::js::Callback<bbl::js::F32Array()> callback) {
    const auto matrix = callback();
    assert(matrix.size() == 16);
    std::array<float, 16> result;
    std::copy_n(matrix.begin(), 16, result.begin());
    return result;
}
void initialize_native_node_particle_set(int set, bbl::js::Callback<bbl::js::F32Array()> callback,
    const std::array<float, 16>& matrix) {
    assert(set == 0);
    assert(matrix[12] == 0); // The wrapper's snapshot preceded the source write.
    provider = std::move(callback);
}
void start_native_node_particle_system(int set, int system) { assert(set == 0 && system == 0); started = true; }
void stop_native_node_particle_system(int set, int system) { assert(set == 0 && system == 0); }
void animate_native_node_particle_system(int set, int system, double ratio) {
    assert(set == 0 && system == 0 && ratio == 1);
    if (started) assert(sample_node_particle_emitter(provider)[12] == 9);
}
void set_native_node_particle_scalar(int set, int system, std::string_view name, double value) {
    assert(set == 0 && system == 0 && name == "updateSpeed" && value == 0);
}
double native_node_particle_alive(int set, int system) { assert(set == 0 && system == 0); return 0; }
double native_node_particle_capacity(int set, int system) { assert(set == 0 && system == 0); return 640; }
}

#define main generated_main
#include "provider.hpp"
#undef main

namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
Scene create_scene_context(Engine& engine) { Scene scene{}; scene.engine = &engine; return scene; }
}

int main() {
    const auto initial = bbl::js::managed_node_count();
    assert(generated_main() == 0);
    assert(!bbl::js::random_override());
    bbl::upstream::provider = {};
    bbl::js::collect_cycles();
    assert(bbl::js::managed_node_count() == initial);
}
