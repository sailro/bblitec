import type { LoweringContext } from "./context.js";

const gateModule = "src/shadow/csm-refit-gate.ts";
const cacheModule = "src/shadow/csm-shadow-cache.ts";
const enableModule = "src/shadow/enable-csm-static-cache.ts";

/**
 * Asserts the pinned refit gate, scheduler and cached render the header
 * below restates: their statement shapes are the contract, so a changed
 * pin fails generation instead of drifting from this port.
 */
function assertCsmStaticCacheContracts(context: LoweringContext): void {
    const gate = context.functionDeclaration(
        gateModule,
        "createCsmRefitGate",
    ).declaration;
    for (const shape of [
        "options.demoteQuietFrames ?? 120",
        "new Map<M, CasterSlot>()",
    ])
        context.expectShapeCount(gate, shape, "CSM refit gate state");
    const sync = context.propertyFunction(
        gateModule,
        "createCsmRefitGate",
        "syncCasters",
        { unique: true },
    ).declaration;
    context.assertStatementShapes(
        sync.body,
        sync.body.statements,
        `
        if (next === casters) {
            return;
        }
        const nextSet = new Set(next);
        let membershipChanged = nextSet.size !== slots.size;
        for (const m of slots.keys()) {
            if (!nextSet.has(m)) {
                slots.delete(m);
                membershipChanged = true;
            }
        }
        for (const m of next) {
            if (!slots.has(m)) {
                slots.set(m, { _last: casterVersion(m), _dynamic: true, _quiet: 0 });
                membershipChanged = true;
            }
        }
        casters = next;
        casterSetChanged ||= membershipChanged;
    `,
        "CSM refit caster sync",
    );
    const update = context.propertyFunction(
        gateModule,
        "createCsmRefitGate",
        "update",
        { unique: true },
    ).declaration;
    const statements = update.body.statements;
    if (statements.length !== 26)
        context.contractError(
            update,
            "Expected the 26-statement refit update.",
        );
    for (const shape of [
        "Math.hypot(lightDirX, lightDirY, lightDirZ) || 1",
        "hasRefit && (nx !== refitDirX || ny !== refitDirY || nz !== refitDirZ)",
        "Math.min(1, Math.max(-1, nx * refitDirX + ny * refitDirY + nz * refitDirZ))",
        "Math.acos(dot) > refitAngle",
        "refitMaxIntervalMs > 0 && nowMs - lastRefitMs >= refitMaxIntervalMs",
        "pendingDemotions > 0 && framesSinceRefit >= demoteQuietFrames",
        "force || !hasRefit || casterSetChanged || promoted || staticSum !== lastStaticSum || cameraChanged || demotionOverdue",
        "membershipCause || angleExceeded || intervalElapsed",
        "dynamicChanged || dynamicSum !== lastDynamicSum",
        "refit || lastDynamicChanged",
        "refit && !membershipCause && demoted === 0",
        "slot._dynamic && slot._quiet >= demoteQuietFrames",
    ])
        context.expectShapeCount(update, shape, "CSM refit decision");
    const version = context.functionDeclaration(
        gateModule,
        "casterVersion",
    ).declaration;
    context.assertStatementShapes(
        version.body!,
        version.body!.statements,
        "return caster.worldMatrixVersion + ~~(caster.thinInstances?._version as number);",
        "CSM refit caster version",
    );
    const scheduler = context.functionDeclaration(
        gateModule,
        "createCsmStaticRefitScheduler",
    ).declaration;
    context.assertExpressionShape(
        context.variableInitializer(scheduler, "budget"),
        "Number.isFinite(cascadesPerFrame) && cascadesPerFrame > 0 && cascadesPerFrame < count ? Math.floor(cascadesPerFrame) : 0",
        "CSM static refit budget",
    );
    const arm = context.propertyFunction(
        gateModule,
        "createCsmStaticRefitScheduler",
        "arm",
        { unique: true },
    ).declaration;
    context.assertStatementShapes(
        arm.body,
        arm.body.statements,
        `
        waiting.fill(true);
        waitingCount = count;
        immediate = budget === 0 || !spread;
    `,
        "CSM static refit arm",
    );
    const take = context.propertyFunction(
        gateModule,
        "createCsmStaticRefitScheduler",
        "take",
        { unique: true },
    ).declaration;
    context.assertStatementShapes(
        take.body,
        take.body.statements,
        `
        out.length = 0;
        if (waitingCount === 0) {
            return out;
        }
        const limit = immediate ? count : budget;
        for (let step = 0; step < count && out.length < limit; step++) {
            const cascade = (cursor + step) % count;
            if (waiting[cascade]) {
                waiting[cascade] = false;
                waitingCount--;
                out.push(cascade);
            }
        }
        if (out.length > 0) {
            cursor = (out[out.length - 1]! + 1) % count;
        }
        if (waitingCount === 0) {
            immediate = false;
        }
        return out;
    `,
        "CSM static refit take",
    );
    const render = context.functionDeclaration(
        cacheModule,
        "renderCsmShadowMapCached",
    ).declaration;
    for (const shape of [
        "camVersion !== cached._lastCamVersion || camAspect !== cached._lastCamAspect",
        "cached._scene._renderableVersion !== cached._cachedContentVersion",
        "lightWorld[0]! * direction.x + lightWorld[4]! * direction.y + lightWorld[8]! * direction.z",
        "lightWorld[1]! * direction.x + lightWorld[5]! * direction.y + lightWorld[9]! * direction.z",
        "lightWorld[2]! * direction.x + lightWorld[6]! * direction.y + lightWorld[10]! * direction.z",
        "cfg._forceRefreshEveryFrame || contentChanged",
        "!decision.renderDynamic && !hadPending",
        "scheduler.arm(cached._gate._lastRefitDriftOnly() && !scheduler.pending())",
        "scheduler.pending() ? scheduler.take() : null",
        "cached._gate._lastDynamicChanged() || cascades?.length === cfg._numCascades",
    ])
        context.expectShapeCount(render, shape, "CSM cached render");
    // A dynamic pass runs only when it lists a caster, in both copy arms.
    context.expectShapeCount(
        render,
        "task._renderables.length || task._pendingMeshes?.length",
        "CSM cached dynamic pass",
        2,
    );
    const publish = context.functionDeclaration(
        cacheModule,
        "publishCsmCascades",
    ).declaration;
    for (const shape of [
        "updatedCascades.length === cfg._numCascades",
        "_writeCsmUbo(state._uboData, cascades, cfg)",
        "state._uboData.set(transform, cascade * 16)",
        "_biasViewProjection(transform, clipBias)",
    ])
        context.expectShapeCount(publish, shape, "CSM cascade publication");
}

/**
 * The refit gate and the static refit scheduler alone, over the native
 * records: what the frame below drives, and what a fixture runs beside the
 * pin.
 */
export function csmRefitGateCpp(): string {
    return `inline constexpr double csm_demote_quiet_frames = 120.0;

/** \`casterVersion\`: the world-matrix version plus \`~~thinInstances?._version\`. */
inline double csm_refit_caster_version(const Engine& engine, MeshHandle mesh) {
    const MeshRecord& record = handle_at(engine.meshes, mesh);
    return static_cast<double>(record.transform_version) +
           static_cast<double>(js::to_int32(record.thin_instances ? record.thin_instances->version : 0.0));
}

inline CsmRefitSlot* csm_refit_slot(CsmStaticCacheState& gate, MeshHandle mesh) {
    for (CsmRefitSlot& slot : gate.slots)
        if (slot.mesh == mesh) return &slot;
    return nullptr;
}

/** \`isDynamic\`: a caster the gate has no slot for is dynamic. */
inline bool csm_refit_is_dynamic(const CsmStaticCacheState& gate, MeshHandle mesh) {
    for (const CsmRefitSlot& slot : gate.slots)
        if (slot.mesh == mesh) return slot.dynamic;
    return true;
}

/** \`syncCasters\`: the caster array the generator holds, by identity. */
inline void csm_refit_sync_casters(const Engine& engine, CsmStaticCacheState& gate,
                                   const ShadowGeneratorRecord& generator) {
    if (gate.casters_synced && gate.casters_list_version == generator.caster_list_version) return;
    std::vector<MeshHandle> next_set;
    for (const MeshHandle mesh : generator.caster_meshes)
        if (std::find(next_set.begin(), next_set.end(), mesh) == next_set.end()) next_set.push_back(mesh);
    bool membership_changed = next_set.size() != gate.slots.size();
    const auto departed = std::remove_if(gate.slots.begin(), gate.slots.end(), [&](const CsmRefitSlot& slot) {
        return std::find(next_set.begin(), next_set.end(), slot.mesh) == next_set.end();
    });
    if (departed != gate.slots.end()) membership_changed = true;
    gate.slots.erase(departed, gate.slots.end());
    for (const MeshHandle mesh : generator.caster_meshes) {
        if (!csm_refit_slot(gate, mesh)) {
            gate.slots.push_back(CsmRefitSlot{mesh, csm_refit_caster_version(engine, mesh), true, 0.0});
            membership_changed = true;
        }
    }
    if (membership_changed) gate.membership_dirty = true;
    gate.casters = generator.caster_meshes;
    gate.casters_synced = true;
    gate.casters_list_version = generator.caster_list_version;
    gate.caster_set_changed = gate.caster_set_changed || membership_changed;
}

struct CsmRefitDecision {
    bool refit = false;
    bool render_dynamic = false;
    /** A caster changed layer (\`onPromote\`/\`onDemote\`). */
    bool membership_moved = false;
};

/** The gate's \`update\`. */
inline CsmRefitDecision csm_refit_update(const Engine& engine, CsmStaticCacheState& gate, double light_x,
                                         double light_y, double light_z, double now_ms,
                                         bool camera_changed, bool force) {
    CsmRefitDecision decision;
    gate.frames_since_refit += 1.0;
    double static_sum = 0.0;
    double dynamic_sum = 0.0;
    bool dynamic_changed = false;
    bool promoted = false;
    double pending_demotions = 0.0;
    for (const MeshHandle mesh : gate.casters) {
        CsmRefitSlot& slot = *csm_refit_slot(gate, mesh);
        const double version = csm_refit_caster_version(engine, mesh);
        const bool changed = version != slot.last;
        slot.last = version;
        if (slot.dynamic) {
            dynamic_changed = dynamic_changed || changed;
            slot.quiet = changed ? 0.0 : slot.quiet + 1.0;
            if (slot.quiet >= csm_demote_quiet_frames) pending_demotions += 1.0;
            dynamic_sum += version;
        } else if (changed) {
            slot.dynamic = true;
            slot.quiet = 0.0;
            promoted = true;
            decision.membership_moved = true;
            dynamic_sum += version;
        } else {
            static_sum += version;
        }
    }
    double length = std::hypot(light_x, light_y, light_z);
    if (length == 0.0 || std::isnan(length)) length = 1.0;
    const double nx = light_x / length;
    const double ny = light_y / length;
    const double nz = light_z / length;
    const bool drifted = gate.has_refit && (nx != gate.refit_direction[0] || ny != gate.refit_direction[1] ||
                                            nz != gate.refit_direction[2]);
    bool angle_exceeded = false;
    if (drifted) {
        const double dot = std::min(1.0, std::max(-1.0, nx * gate.refit_direction[0] +
                                                            ny * gate.refit_direction[1] +
                                                            nz * gate.refit_direction[2]));
        angle_exceeded = std::acos(dot) > gate.refit_angle;
    }
    const bool interval_elapsed =
        gate.refit_max_interval_ms > 0.0 && now_ms - gate.last_refit_ms >= gate.refit_max_interval_ms;
    const bool demotion_overdue = pending_demotions > 0.0 && gate.frames_since_refit >= csm_demote_quiet_frames;
    const bool membership_cause = force || !gate.has_refit || gate.caster_set_changed || promoted ||
                                  static_sum != gate.last_static_sum || camera_changed || demotion_overdue;
    const bool refit = membership_cause || angle_exceeded || interval_elapsed;
    double demoted = 0.0;
    if (refit) {
        for (const MeshHandle mesh : gate.casters) {
            CsmRefitSlot& slot = *csm_refit_slot(gate, mesh);
            if (slot.dynamic && slot.quiet >= csm_demote_quiet_frames) {
                slot.dynamic = false;
                decision.membership_moved = true;
                demoted += 1.0;
                static_sum += slot.last;
                dynamic_sum -= slot.last;
            }
        }
        gate.has_refit = true;
        gate.caster_set_changed = false;
        gate.refit_direction = {nx, ny, nz};
        gate.last_refit_ms = now_ms;
        gate.frames_since_refit = 0.0;
    }
    gate.last_dynamic_changed = dynamic_changed || dynamic_sum != gate.last_dynamic_sum;
    decision.refit = refit;
    decision.render_dynamic = refit || gate.last_dynamic_changed;
    gate.last_drift_only = refit && !membership_cause && demoted == 0.0;
    gate.last_static_sum = static_sum;
    gate.last_dynamic_sum = dynamic_sum;
    return decision;
}

/** \`createCsmStaticRefitScheduler(cascadeCount, cascadesPerFrame)\`. */
inline void csm_scheduler_create(CsmStaticCacheState& scheduler, double cascade_count,
                                 double cascades_per_frame) {
    const double count = std::max(0.0, std::floor(cascade_count));
    scheduler.scheduler_count = static_cast<std::uint32_t>(count);
    scheduler.scheduler_budget =
        std::isfinite(cascades_per_frame) && cascades_per_frame > 0.0 && cascades_per_frame < count
            ? static_cast<std::uint32_t>(std::floor(cascades_per_frame))
            : 0u;
    scheduler.waiting.assign(scheduler.scheduler_count, false);
    scheduler.waiting_count = 0;
    scheduler.immediate = false;
    scheduler.cursor = 0;
}

inline void csm_scheduler_arm(CsmStaticCacheState& scheduler, bool spread) {
    std::fill(scheduler.waiting.begin(), scheduler.waiting.end(), true);
    scheduler.waiting_count = scheduler.scheduler_count;
    scheduler.immediate = scheduler.scheduler_budget == 0 || !spread;
}

inline bool csm_scheduler_pending(const CsmStaticCacheState& scheduler) {
    return scheduler.waiting_count > 0;
}

inline void csm_scheduler_take(CsmStaticCacheState& scheduler, std::vector<std::uint32_t>& out) {
    out.clear();
    if (scheduler.waiting_count == 0) return;
    const std::uint32_t count = scheduler.scheduler_count;
    const std::uint32_t limit = scheduler.immediate ? count : scheduler.scheduler_budget;
    for (std::uint32_t step = 0; step < count && out.size() < limit; ++step) {
        const std::uint32_t cascade = (scheduler.cursor + step) % count;
        if (scheduler.waiting[cascade]) {
            scheduler.waiting[cascade] = false;
            --scheduler.waiting_count;
            out.push_back(cascade);
        }
    }
    if (!out.empty()) scheduler.cursor = (out.back() + 1u) % count;
    if (scheduler.waiting_count == 0) scheduler.immediate = false;
}

`;
}

/**
 * `enableCsmStaticCache`'s runtime, as a header both backends' shadow
 * refresh includes: the refit gate (`createCsmRefitGate`), the static refit
 * scheduler (`createCsmStaticRefitScheduler`) and one frame of
 * `renderCsmShadowMapCached` up to its GPU work, which becomes a plan --
 * the static passes due, the cache layers to copy, the dynamic passes due
 * -- each backend's task loop executes in the pin's order.
 *
 * The pin moves a promoted or demoted caster between the cascade's static
 * and dynamic task; here the refit gate's slots are the membership, and the
 * passes are refilled from them before the frame's dynamic tests read them.
 * A caster set the generator is handed again is the pin's `syncCasters`
 * identity test, which `caster_list_version` carries.
 */
export function csmStaticCacheHeader(context: LoweringContext): string {
    assertCsmStaticCacheContracts(context);
    context.functionDeclaration(enableModule, "enableCsmStaticCache");
    return `// ${context.provenance(gateModule, "createCsmRefitGate", `${gateModule}#createCsmStaticRefitScheduler and ${cacheModule}#renderCsmShadowMapCached`)}
#pragma once
#include <bblite/runtime.hpp>
#include <bblite/upstream/pinned_shadow.hpp>
#include <bblite/upstream/csm_shadow.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace bbl::upstream {

${csmRefitGateCpp()}/**
 * \`publishCsmCascades\`: a full update publishes every cascade's block
 * (\`_writeCsmUbo\`); a spread one only the updated cascades' transforms,
 * the splits staying at the last full write. Each updated cascade's caster
 * camera takes its view and its biased transform.
 */
inline void csm_publish_cascades(ShadowGeneratorRecord& generator, const std::vector<std::uint32_t>& updated) {
    CsmStaticCacheState& cache = *generator.csm_cache;
    const bool full = updated.size() == generator.csm_num_cascades;
    generator.csm_cascades.resize(generator.csm_num_cascades);
    for (const std::uint32_t cascade : updated) {
        ShadowCascade& published = generator.csm_cascades[cascade];
        const ShadowCascade& fitted = cache.pending[cascade];
        published.transform = fitted.transform;
        published.view = fitted.view;
        published.caster_view_projection = fitted.caster_view_projection;
        if (full) {
            published.view_frustum_z = fitted.view_frustum_z;
            published.frustum_length = fitted.frustum_length;
        }
    }
}

/**
 * One frame of \`renderCsmShadowMapCached\`, before its GPU work: returns
 * whether cascades were published (the receiver block moved), and leaves the
 * plan on the cache state. \`fit\` fills the casters the cascade fit reads.
 */
template <typename Fit>
inline bool csm_static_cache_frame(Engine& engine, const Scene& scene, ShadowGeneratorHandle handle,
                                   const LightRecord& light, const CameraRecord* camera, double camera_version,
                                   double camera_aspect, double now_ms, Fit&& fit) {
    ShadowGeneratorRecord& generator = handle_at(engine.shadow_generators, handle);
    CsmStaticCacheState& cache = *generator.csm_cache;
    const std::uint32_t count = generator.csm_num_cascades;
    cache.static_due.assign(count, false);
    cache.dynamic_due.assign(count, false);
    cache.copy_layers.clear();
    if (!camera) return false;
    const bool camera_changed =
        camera_version != cache.last_camera_version || camera_aspect != cache.last_camera_aspect;
    const double content_version = static_cast<double>(scene.state->renderable_version);
    const bool content_changed = content_version != cache.cached_content_version;
    csm_refit_sync_casters(engine, cache, generator);
    const std::array<float, 16> world = light_world_matrix(light);
    const double dx = light.direction.x, dy = light.direction.y, dz = light.direction.z;
    const CsmRefitDecision decision = csm_refit_update(
        engine, cache, world[0] * dx + world[4] * dy + world[8] * dz,
        world[1] * dx + world[5] * dy + world[9] * dz, world[2] * dx + world[6] * dy + world[10] * dz,
        now_ms, camera_changed, generator.force_refresh_every_frame || content_changed);
    if (decision.membership_moved || cache.membership_dirty) {
        refresh_csm_cache_casters(engine, handle);
        cache.membership_dirty = false;
        cache.refilled = true;
    }
    const bool had_pending = csm_scheduler_pending(cache);
    if (!decision.render_dynamic && !had_pending) return false;
    if (decision.refit) {
        const std::vector<ShadowCaster>& casters = fit();
        CsmCascadeScratch scratch(count);
        const CsmConfig cfg = csm_config(generator);
        const CsmCascades& cascades = csm_compute_cascades(
            camera_aspect, *camera, light, cfg, casters, scratch,
            [](const CameraRecord& fitted_camera, double fitted_aspect) {
                return build_view_projection(fitted_camera, fitted_aspect);
            });
        cache.pending.resize(count);
        for (std::size_t index = 0; index < count; ++index) {
            ShadowCascade& fitted = cache.pending[index];
            fitted.transform = cascades._transforms[index];
            fitted.view = cascades._views[index];
            fitted.view_frustum_z = cascades._viewFrustumZ[index];
            fitted.frustum_length = cascades._frustumLengths[index];
            fitted.caster_view_projection = fitted.transform;
            csm_bias_view_projection(fitted.caster_view_projection, csm_caster_clip_bias(cfg, cascades, index));
        }
        cache.last_camera_version = camera_version;
        cache.last_camera_aspect = camera_aspect;
        cache.cached_content_version = content_version;
        csm_scheduler_arm(cache, cache.last_drift_only && !csm_scheduler_pending(cache));
    }
    std::vector<std::uint32_t> cascades;
    if (csm_scheduler_pending(cache)) csm_scheduler_take(cache, cascades);
    for (const std::uint32_t cascade : cascades) cache.static_due[cascade] = true;
    if (!cascades.empty()) csm_publish_cascades(generator, cascades);
    const auto dynamic_drawn = [&](std::uint32_t cascade) {
        const TaskHandle task = generator.caster_tasks.at(count + cascade);
        return !handle_at(engine.frame_tasks, task).render_meshes.empty();
    };
    if (cache.last_dynamic_changed || cascades.size() == count) {
        for (std::uint32_t cascade = 0; cascade < count; ++cascade) {
            cache.copy_layers.push_back(cascade);
            cache.dynamic_due[cascade] = dynamic_drawn(cascade);
        }
    } else {
        for (const std::uint32_t cascade : cascades) {
            cache.copy_layers.push_back(cascade);
            cache.dynamic_due[cascade] = dynamic_drawn(cascade);
        }
    }
    return !cascades.empty();
}

} // namespace bbl::upstream
`;
}
