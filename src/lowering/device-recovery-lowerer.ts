import { type LoweredSource, LoweringContext } from "./context.js";

export function lowerDeviceRecovery(context: LoweringContext): LoweredSource {
    const modulePath = "src/engine/device-lost-recovery.ts";
    const enable = context.functionDeclaration(modulePath, "_enableDeviceLostRecovery").declaration;
    context.assertStatementInventory(enable, enable.body!.statements, "_enableDeviceLostRecovery", "native scene registration",
        ["variable statement", "variable statement", "if statement", "if statement", "expression statement", "expression statement", "variable statement", "return statement"]);
    context.expectShapeCount(enable, "registrations.splice(index, 1)", "disabled registration removal");
    const arm = context.functionDeclaration(modulePath, "arm").declaration;
    for (const expression of ["registration._onLost?.(info)", "registration._onRecovered?.()", "registration._onRecoveryFailed?.(error)", "state._recovering = false"]) {
        context.expectShapeCount(arm, expression, "recovery callback lifecycle", expression === "state._recovering = false" ? 2 : 1);
    }
    const force = context.functionDeclaration("src/engine/device-lost-recovery-testing.ts", "forceWebGpuDeviceLossForTesting").declaration;
    context.assertStatementInventory(force, force.body!.statements, "forceWebGpuDeviceLossForTesting", "native deferred device destruction", ["if statement", "expression statement"]);
    context.expectShapeCount(force, "engine._device.destroy()", "forced device destruction");
    const recovery = context.functionDeclaration("src/engine/device-lost-recovery-run.ts", "runDeviceLostRecovery").declaration;
    context.assertStatementInventory(recovery, recovery.body!.statements, "runDeviceLostRecovery", "native device reconstruction", [
        "variable statement", "other statement", "variable statement", "expression statement", "expression statement", "expression statement",
        "variable statement", "if statement", "variable statement", "if statement", "expression statement", "expression statement",
        "expression statement", "expression statement", "variable statement", "variable statement", "other statement", "if statement",
    ]);
    context.expectShapeCount(recovery, "settleTextureOwnership?.()", "ownership settlement after handlers");
    context.expectShapeCount(recovery, "(a._recoverOrder ?? 0) - (b._recoverOrder ?? 0)", "handler ordering");
    for (const call of ["stopEngine", "assertEveryActiveContextKindIsRecoverable", "disposeGpuResourceRetirements", "resizeEngine", "rebuildRecoverableTextures", "startEngine"]) {
        if (!context.hasCall(recovery, call)) context.contractError(recovery, `Recovery no longer calls ${call}.`);
    }
    context.functionDeclaration("src/engine/recovery-rebuild.ts", "rebuildRegisteredScenes");
    context.functionDeclaration("src/engine/device-lost-scene-recovery.ts", "enableDeviceLostSceneRecovery");
    return { modulePath, symbolName: "_enableDeviceLostRecovery,arm,markNextDeviceLossForRecovery", header: "", source: `
// ${context.provenance(modulePath, "_enableDeviceLostRecovery, arm")}
// Native device recreation replays generated upload/composition products over retained CPU owners.
#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>
#include <iostream>

namespace bbl {
static Engine::DeviceRecoveryState& recovery_state(Engine& engine) {
    if (!engine.device_recovery) engine.device_recovery = std::make_shared<Engine::DeviceRecoveryState>();
    return *engine.device_recovery;
}
std::shared_ptr<DeviceRecoveryRegistration> enable_device_lost_scene_recovery(Engine& engine) {
    auto& state = recovery_state(engine);
    if (state.disposed) throw std::runtime_error("Cannot register recovery on a disposed engine.");
    auto registration = std::make_shared<DeviceRecoveryRegistration>();
    registration->engine = &engine;
    state.registrations.push_back(registration);
    return registration;
}
void disable_device_recovery(const std::shared_ptr<DeviceRecoveryRegistration>& registration) {
    if (!registration || registration->disabled) return;
    registration->disabled = true;
    if (!registration->engine || !registration->engine->device_recovery) return;
    auto& registrations = registration->engine->device_recovery->registrations;
    std::erase(registrations, registration);
}
void force_device_loss(Engine& engine) {
    auto& state = recovery_state(engine);
    if (state.disposed || std::none_of(state.registrations.begin(), state.registrations.end(), [](const auto& registration) { return !registration->disabled; })) {
        throw std::runtime_error("forceWebGpuDeviceLossForTesting requires a device-lost recovery handler to be enabled first");
    }
    if (state.requested || state.recovering) throw std::runtime_error("A device-loss recovery is already in flight.");
    state.requested = true;
    engine.renderer_restart_requested = true;
}
void begin_device_recovery(Engine& engine) {
    auto& state = recovery_state(engine);
    state.requested = false;
    state.recovering = true;
    state.resources_ready = false;
    state.in_flight.clear();
    for (const auto& registration : state.registrations) if (!registration->disabled) state.in_flight.push_back(registration);
    for (const auto& registration : state.in_flight) if (registration->on_lost) registration->on_lost();
    state.was_running = !engine.stopped;
    engine.stopped = true;
    if (!engine.registered_sprite_renderers.empty() || !engine.registered_effect_renderers.empty() || !engine.registered_frame_graph_contexts.empty()) {
        throw std::runtime_error("Every active rendering context must have an enabled recovery strategy; only scene contexts are represented.");
    }
    state.environments.clear(); state.shadows.clear(); state.renderable_counts.clear(); state.fallback = {};
    ++engine.device_generation;
    engine.stopped = !state.was_running;
}
void complete_device_recovery(Engine& engine) {
    if (!engine.device_recovery) return;
    auto& state = *engine.device_recovery;
    if (!state.recovering || !state.resources_ready) return;
    state.recovering = false;
    if (pal::environment_variable("BBLITE_RUNTIME_TRACE") == "1") {
        std::cerr << "[bblite trace] recovery generation=" << engine.device_generation << " draws=" << engine.draw_call_count << '\\n';
    }
    auto registrations = std::move(state.in_flight);
    state.in_flight.clear();
    for (const auto& registration : registrations) if (registration->on_recovered) registration->on_recovered();
}
void fail_device_recovery(Engine& engine, const std::string& error) {
    auto& state = recovery_state(engine);
    state.requested = false; state.recovering = false; state.resources_ready = false;
    engine.stopped = true;
    auto registrations = std::move(state.in_flight);
    state.in_flight.clear();
    for (const auto& registration : registrations) if (registration->on_failed) registration->on_failed(error);
}
void dispose_engine(Engine& engine) {
    engine.stopped = true;
    auto& state = recovery_state(engine);
    state.disposed = true;
    state.registrations.clear(); state.error_listeners.clear();
    engine.renderer_restart_requested = false;
}
void add_gpu_error_listener(GpuDeviceIdentity device, std::function<void(const std::string&)> listener) {
    if (!device.engine) throw std::runtime_error("Invalid GPU device identity.");
    recovery_state(*device.engine).error_listeners[device.generation].push_back(std::move(listener));
}
void report_gpu_error(Engine& engine, const std::string& error) {
    if (!engine.device_recovery) return;
    const auto found = engine.device_recovery->error_listeners.find(engine.device_generation);
    if (found == engine.device_recovery->error_listeners.end()) return;
    const auto listeners = found->second;
    for (const auto& listener : listeners) listener(error);
}
EnvironmentIdentity environment_identity(const Scene& scene) {
    return {scene.engine, scene.state, scene.state->environment_identity};
}
GpuTextureIdentity environment_texture_identity(const EnvironmentIdentity& environment) {
    if (!environment.engine || !environment.engine->device_recovery) throw std::runtime_error("Environment GPU resource has not been published.");
    return environment.engine->device_recovery->environments.at(environment.scene.get());
}
GpuTextureIdentity fallback_texture_identity(const Engine& engine) {
    if (!engine.device_recovery || !engine.device_recovery->fallback.object) throw std::runtime_error("PBR fallback GPU resource has not been published.");
    return engine.device_recovery->fallback;
}
GpuTextureIdentity shadow_texture_identity(const Engine& engine, ShadowGeneratorHandle shadow) {
    if (!engine.device_recovery) throw std::runtime_error("Shadow GPU resource has not been published.");
    return engine.device_recovery->shadows.at(shadow.value);
}
std::size_t scene_renderable_count(const Scene& scene) {
    if (!scene.engine || !scene.engine->device_recovery) throw std::runtime_error("Scene renderables have not been published.");
    return scene.engine->device_recovery->renderable_counts.at(scene.state.get());
}
void set_canvas_dataset(Engine& engine, std::string key, std::string value) {
    auto& dataset = recovery_state(engine).dataset;
    if (pal::environment_variable("BBLITE_RUNTIME_TRACE") == "1" && dataset[key] != value) {
        std::cerr << "[bblite trace] dataset " << key << "=" << value << '\\n';
    }
    dataset[std::move(key)] = std::move(value);
}
std::string canvas_dataset(const Engine& engine, const std::string& key) {
    if (!engine.device_recovery) return {};
    const auto found = engine.device_recovery->dataset.find(key);
    return found == engine.device_recovery->dataset.end() ? std::string{} : found->second;
}
void set_global_callback(Engine& engine, std::string key, std::function<void()> callback) {
    recovery_state(engine).globals[std::move(key)] = std::move(callback);
}
} // namespace bbl
` };
}
