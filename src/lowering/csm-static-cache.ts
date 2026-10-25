import ts from "typescript";
import { type LoweringContext, unwrapExpression } from "./context.js";
import { stringLiteral } from "../cpp-literals.js";
import { recordAt } from "../compiler/record-access.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { PinnedRecordModel, type RecordSpec } from "./pinned-record-lowerer.js";
import {
    members,
    optionalOf,
    reads,
    recordOf,
    recordScalars,
} from "./record-shapes.js";
import { soleBindingName } from "../compiler/syntax.js";

const gateModule = "src/shadow/csm-refit-gate.ts";
const cacheModule = "src/shadow/csm-shadow-cache.ts";
const enableModule = "src/shadow/enable-csm-static-cache.ts";

/**
 * The gate's records: its caster is a native view of the mesh record
 * (`CsmRefitCaster`: the world-matrix version and the thin-instance pool's
 * version), every other record is emitted from the pin's declarations.
 */
const gateRecords: readonly RecordSpec[] = [
    {
        pinned: ["CsmRefitCaster"],
        cpp: "CsmRefitCasterView",
        reference: false,
        native: true,
        members: members([
            [
                "worldMatrixVersion",
                reads(
                    recordScalars.number,
                    (owner) => `${owner}.world_matrix_version()`,
                ),
            ],
            [
                "thinInstances",
                reads(
                    optionalOf(recordOf("CsmRefitThinView")),
                    (owner) => `${owner}.thin_instances()`,
                ),
            ],
        ]),
    },
    {
        pinned: ["CsmRefitThinView"],
        cpp: "CsmRefitThinView",
        reference: false,
        native: true,
        members: members([
            [
                "_version",
                reads(recordScalars.number, (owner) => `${owner}.version`),
            ],
        ]),
    },
    {
        pinned: ["CsmRefitGateOptions"],
        cpp: "CsmRefitGateOptions",
        reference: false,
    },
    { pinned: ["CsmRefitDecision"], cpp: "CsmRefitDecision", reference: false },
    { pinned: ["CasterSlot"], cpp: "CsmCasterSlot", reference: true },
    { pinned: ["CsmRefitGate"], cpp: "CsmRefitGate", reference: true },
    {
        pinned: ["CsmStaticRefitScheduler"],
        cpp: "CsmStaticRefitScheduler",
        reference: true,
    },
];

/**
 * `createCsmRefitGate` (instantiated at its caster view, as the cache's
 * `createCsmRefitGate<Mesh>` is) and `createCsmStaticRefitScheduler`,
 * lowered whole from the pin, after the native caster view they read.
 * `includes` are the headers the lowered bodies use.
 */
export function csmRefitLibrary(context: LoweringContext): {
    includes: readonly string[];
    source: string;
} {
    const model = new PinnedRecordModel(
        context,
        context.store.program.modules([gateModule]),
        { records: gateRecords, values: new Map(), adapters: new Map() },
    );
    const gate = model.functionDeclaration(gateModule, "createCsmRefitGate");
    const caster = model.typed
        .sourceFile(gateModule)
        .statements.find(
            (statement): statement is ts.InterfaceDeclaration =>
                ts.isInterfaceDeclaration(statement) &&
                statement.name.text === "CsmRefitCaster",
        );
    const parameter = gate.typeParameters?.[0];
    if (!caster || !parameter || gate.typeParameters?.length !== 1)
        return context.contractError(
            gate,
            "Expected createCsmRefitGate<M extends CsmRefitCaster>.",
        );
    model.lowered(gate, undefined, {
        key: "CsmRefitCaster",
        stem: "of_caster",
        bindings: [
            new Map([
                [
                    model.checker.getTypeAtLocation(parameter),
                    model.checker.getTypeAtLocation(caster),
                ],
            ]),
        ],
    });
    const { declarations, definitions } = model.lower([
        model.functionDeclaration(gateModule, "createCsmStaticRefitScheduler"),
    ]);
    const records = gateRecords.map((spec) => spec.pinned[0]!);
    for (const name of records)
        if (!model.isGenericRecord(name)) model.record(name).members();
    const emitted = [
        ...records,
        ...model.instantiatedRecords(),
        ...model.literalRecords(),
    ].filter(
        (name, index, names) =>
            names.indexOf(name) === index &&
            !model.record(name).spec.native &&
            !model.isGenericRecord(name),
    );
    return {
        includes: ["bblite/pinned_records.hpp", ...model.includes],
        source: `namespace bbl {

/** A caster's thin-instance pool as the refit gate reads it. */
struct CsmRefitThinView {
    double version = 0.0;
};

/**
 * A cached generator's caster as the refit gate reads it (\`CsmRefitCaster\`):
 * the mesh by identity, the gate's Map key, and its two versions.
 */
struct CsmRefitCasterView {
    const Engine* engine = nullptr;
    MeshHandle mesh{};
    [[nodiscard]] bool operator==(const CsmRefitCasterView& other) const { return mesh == other.mesh; }
    [[nodiscard]] std::size_t key_hash() const noexcept {
        return (static_cast<std::size_t>(mesh.generation) << 32u) ^ mesh.value;
    }
    [[nodiscard]] double world_matrix_version() const {
        return static_cast<double>(handle_at(engine->meshes, mesh).transform_version);
    }
    [[nodiscard]] js::Nullable<CsmRefitThinView> thin_instances() const {
        const MeshRecord& record = handle_at(engine->meshes, mesh);
        if (!record.thin_instances) return {};
        return CsmRefitThinView{record.thin_instances->version};
    }
};

${model.structs(emitted)}
${declarations}
${definitions}

/**
 * A cached task state's \`_gate\` and \`_staticScheduler\`, the caster
 * array the gate adopts, and the promote/demote callback, which records
 * that the static and dynamic passes must be refilled.
 */
struct CsmRefitRuntime {
    decltype(create_csm_refit_gate_of_caster(CsmRefitGateOptions{})) gate;
    decltype(create_csm_static_refit_scheduler(0.0, 0.0)) scheduler;
    js::Array<CsmRefitCasterView> casters;
    std::uint64_t casters_list_version = 0;
    bool moved = false;
    js::Callback<void(CsmRefitCasterView)> on_move;
};

} // namespace bbl

namespace bbl::upstream {

inline CsmRefitRuntime* csm_refit_runtime(const CsmStaticCacheState& cache) {
    return static_cast<CsmRefitRuntime*>(cache.refit.get());
}

/** \`syncCasters(casterMeshes)\`: a replaced caster list is a new array. */
inline void csm_refit_sync(const Engine& engine, CsmRefitRuntime& runtime,
                           const ShadowGeneratorRecord& generator) {
    if (runtime.casters_list_version != generator.caster_list_version || !runtime.gate) {
        runtime.casters = js::Array<CsmRefitCasterView>{};
        for (const MeshHandle mesh : generator.caster_meshes)
            runtime.casters.push_back(CsmRefitCasterView{&engine, mesh});
        runtime.casters_list_version = generator.caster_list_version;
    }
    if (runtime.gate) runtime.gate->sync_casters(runtime.casters);
}

/**
 * \`ensureCsmShadowCacheState\`'s gate and scheduler for a new task state:
 * the gate over the cache's options, synced with the casters, and the
 * scheduler over the cascades.
 */
inline void csm_refit_start(const Engine& engine, CsmStaticCacheState& cache,
                            const ShadowGeneratorRecord& generator, std::uint32_t cascades) {
    auto runtime = std::make_shared<CsmRefitRuntime>();
    CsmRefitGateOptions options;
    options.refit_angle = cache.options.refit_angle;
    options.refit_max_interval_ms = cache.options.refit_max_interval_ms;
    runtime->casters_list_version = generator.caster_list_version;
    for (const MeshHandle mesh : generator.caster_meshes)
        runtime->casters.push_back(CsmRefitCasterView{&engine, mesh});
    runtime->gate = create_csm_refit_gate_of_caster(options);
    runtime->gate->sync_casters(runtime->casters);
    runtime->scheduler = create_csm_static_refit_scheduler(
        static_cast<double>(cascades), static_cast<double>(cache.options.static_cascades_per_frame));
    runtime->on_move = js::Callback<void(CsmRefitCasterView)>(
        [moved = &runtime->moved](CsmRefitCasterView) { *moved = true; });
    cache.refit = std::move(runtime);
}

/** \`isDynamic\`: a caster no gate has adopted is dynamic. */
inline bool csm_refit_is_dynamic(const Engine& engine, const CsmStaticCacheState& cache,
                                 MeshHandle mesh) {
    const CsmRefitRuntime* runtime = csm_refit_runtime(cache);
    return !runtime || runtime->gate->is_dynamic(CsmRefitCasterView{&engine, mesh});
}

} // namespace bbl::upstream
`,
    };
}

/**
 * Asserts the pinned cached render the frame below restates, and the
 * gate and scheduler creation it drives: their shapes are the contract,
 * so a changed pin fails generation instead of drifting from this port.
 */
function assertCsmStaticCacheContracts(context: LoweringContext): void {
    const ensure = context.functionDeclaration(
        cacheModule,
        "ensureCsmShadowCacheState",
    ).declaration;
    for (const shape of [
        "createCsmRefitGate<Mesh>({ refitAngle: cache._refitAngle, refitMaxIntervalMs: cache._refitMaxIntervalMs })",
        "createCsmStaticRefitScheduler(cascadeCount, cache._staticCascadesPerFrame ?? 0)",
        "cache._cascadeCoveragePadding ? createCoverageState(cache._cascadeCoveragePadding) : null",
    ])
        context.expectShapeCount(ensure, shape, "CSM cached task state");
    const render = context.functionDeclaration(
        cacheModule,
        "renderCsmShadowMapCached",
    ).declaration;
    for (const shape of [
        "cached._gate.syncCasters(cached._casterMeshes)",
        "camera !== cached._lastCamera",
        "swapped || camVersion !== cached._lastCamVersion || camAspect !== cached._lastCamAspect",
        "cached._scene._renderableVersion !== cached._cachedContentVersion",
        "lightWorld[0]! * direction.x + lightWorld[4]! * direction.y + lightWorld[8]! * direction.z",
        "lightWorld[1]! * direction.x + lightWorld[5]! * direction.y + lightWorld[9]! * direction.z",
        "lightWorld[2]! * direction.x + lightWorld[6]! * direction.y + lightWorld[10]! * direction.z",
        "cfg._forceRefreshEveryFrame || contentChanged",
        "!decision.renderDynamic && !hadPending && !missed",
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
        "state._uboData.set(cascades._transforms[cascade]!, cascade * 16)",
        "transform.set(cascades._transforms[cascade]!)",
        "view.set(cascades._views[cascade]!)",
        "_biasViewProjection(transform, clipBias)",
    ])
        context.expectShapeCount(publish, shape, "CSM cascade publication");
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
 * and dynamic task; here the gate's classification (`isDynamic`) is the
 * membership, and the passes are refilled from it before the frame's
 * dynamic tests read them. A caster set the generator is handed again is
 * the pin's `syncCasters` identity test, which `caster_list_version`
 * carries.
 */
export function csmStaticCacheHeader(context: LoweringContext): string {
    assertCsmStaticCacheContracts(context);
    context.functionDeclaration(enableModule, "enableCsmStaticCache");
    const library = csmRefitLibrary(context);
    return `// ${context.provenance(gateModule, "createCsmRefitGate", `${gateModule}#createCsmStaticRefitScheduler and ${cacheModule}#renderCsmShadowMapCached`)}
#pragma once
#include <bblite/runtime.hpp>
#include <bblite/upstream/pinned_shadow.hpp>
#include <bblite/upstream/csm_shadow.hpp>
${library.includes.map((header) => `#include <${header}>`).join("\n")}

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

${library.source}
namespace bbl {
/** The generated shadow surface's caster refresh, through which a cached frame refills its passes. */
void refresh_shadow_task_meshes(Engine& engine, ShadowGeneratorHandle generator);
} // namespace bbl

namespace bbl::upstream {

/**
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
    CsmRefitRuntime* refit = csm_refit_runtime(cache);
    if (!camera || !refit) return false;
    const bool camera_changed =
        camera != cache.last_camera || camera_version != cache.last_camera_version || camera_aspect != cache.last_camera_aspect;
    const double content_version = static_cast<double>(scene.state->renderable_version);
    const bool content_changed = content_version != cache.cached_content_version;
    csm_refit_sync(engine, *refit, generator);
    const std::array<float, 16> world = light_world_matrix(light);
    const double dx = light.direction.x, dy = light.direction.y, dz = light.direction.z;
    refit->moved = false;
    const CsmRefitDecision decision = refit->gate->update(
        world[0] * dx + world[4] * dy + world[8] * dz, world[1] * dx + world[5] * dy + world[9] * dz,
        world[2] * dx + world[6] * dy + world[10] * dz, now_ms, camera_changed,
        generator.force_refresh_every_frame || content_changed, refit->on_move, refit->on_move);
    if (refit->moved || cache.membership_dirty) {
        // The refill re-partitions the same casters between this generator's
        // own passes: no GPU row changes, and the backend rebuilds those
        // passes' draw lists alone (\`refilled\`), so the draw-list epoch
        // every task rebuilds on stays where it was.
        const std::uint64_t epoch = engine.draw_list_epoch;
        refresh_shadow_task_meshes(engine, handle);
        engine.draw_list_epoch = epoch;
        cache.membership_dirty = false;
        cache.refilled = true;
    }
    const bool had_pending = refit->scheduler->pending();
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
        cache.last_camera = camera;
        cache.last_camera_aspect = camera_aspect;
        cache.cached_content_version = content_version;
        refit->scheduler->arm(refit->gate->last_refit_drift_only() && !refit->scheduler->pending());
    }
    std::vector<std::uint32_t> cascades;
    if (refit->scheduler->pending())
        for (const double cascade : refit->scheduler->take()) cascades.push_back(static_cast<std::uint32_t>(cascade));
    for (const std::uint32_t cascade : cascades) cache.static_due[cascade] = true;
    if (!cascades.empty()) csm_publish_cascades(generator, cascades);
    const auto dynamic_drawn = [&](std::uint32_t cascade) {
        const TaskHandle task = generator.caster_tasks.at(count + cascade);
        return !handle_at(engine.frame_tasks, task).render_meshes.empty();
    };
    if (refit->gate->last_dynamic_changed() || cascades.size() == count) {
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

/**
 * `enableCsmStaticCache`, lowered from the pin: its rejections in its order
 * with the messages its own `Promise.reject` calls carry, then the cache
 * options it keeps. `sg._shadowTaskState` is the caster passes registration
 * builds, `sg._csmReceiverTexture` the generator's record of a
 * `getCsmReceiverTexture` call and a loaded cache `sg._csmCache`. The rest is
 * the platform's: the native cache loads synchronously (no promise in
 * flight), its texture is the cache target the task state builds, and its
 * hooks are the cached frame.
 */
export function lowerCsmStaticCacheEnable(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        enableModule,
        "enableCsmStaticCache",
    );
    const parameters = declaration.parameters.map((parameter) =>
        soleBindingName(parameter.name),
    );
    if (parameters.join() !== "engine,sg,options")
        context.contractError(
            declaration,
            "Expected enableCsmStaticCache(engine, sg, options).",
        );
    const optional = (name: string): PinnedBinding => ({
        cpp: `(*${name})`,
        type: "scalar",
        nullish: `!${name}.has_value()`,
    });
    const bindings = new Map<string, PinnedBinding>([
        ["options.refitAngle", { cpp: "refit_angle", type: "scalar" }],
        ["options.refitMaxIntervalMs", optional("refit_max_interval_ms")],
        // The compiler refuses the new coverage option; omission retains the pin's default.
        [
            "options.cascadeCoveragePadding",
            optional("cascade_coverage_padding"),
        ],
        [
            "sg._config._stabilizeCascades",
            {
                cpp: "upstream::csm_config(generator)._stabilizeCascades",
                type: "bool",
            },
        ],
        ["sg._config._mapSize", { cpp: "generator.map_size", type: "scalar" }],
        [
            "options.staticCascadesPerFrame",
            optional("static_cascades_per_frame"),
        ],
        [
            "sg._shadowTaskState",
            { cpp: "!generator.caster_tasks.empty()", type: "bool" },
        ],
        [
            "sg._csmReceiverTexture",
            { cpp: "generator.csm_receiver_texture_read", type: "bool" },
        ],
        [
            "sg._csmCache._loaded",
            { cpp: "(generator.csm_cache != nullptr)", type: "bool" },
        ],
    ]);
    // The platform's statements, each asserted at its pinned shape.
    const platformShapes = new Map([
        ["active", "const active = enabling?.get(sg);"],
        ["oldTexture", "const oldTexture = sg._depthTexture;"],
        ["mapSize", "const mapSize = sg._config._mapSize;"],
        ["if active", "if (active) { return active; }"],
        ["destroy", "oldTexture.destroy();"],
        ["enabling", "(enabling ??= new WeakMap()).set(sg, promise);"],
    ]);
    const platformKey = (statement: ts.Statement): string | undefined => {
        if (ts.isVariableStatement(statement)) {
            const name = soleBindingName(
                statement.declarationList.declarations[0]?.name,
            );
            return name && (platformShapes.has(name) || name === "promise")
                ? name
                : undefined;
        }
        if (
            ts.isIfStatement(statement) &&
            ts.isIdentifier(statement.expression)
        )
            return statement.expression.text === "active"
                ? "if active"
                : undefined;
        if (!ts.isExpressionStatement(statement)) return undefined;
        const expression = unwrapExpression(statement.expression);
        if (ts.isVoidExpression(expression)) return "void";
        if (context.expressionMatchesShape(expression, "oldTexture.destroy()"))
            return "destroy";
        if (
            context.expressionMatchesShape(
                expression,
                "(enabling ??= new WeakMap()).set(sg, promise)",
            )
        )
            return "enabling";
        return undefined;
    };
    const reached = new Set<string>();
    const rejected: string[] = [];
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls: new Map([
            [
                "Number.isInteger",
                (args: readonly string[]) =>
                    `bbl::js::number_is_integer(static_cast<double>(${args[0]}))`,
            ],
        ]),
        callShapes: new Map([
            [
                "engine.surfaces.some((surface) => surface._renderingContexts.length > 0)",
                "bool",
            ],
        ]),
        expression(node) {
            if (
                context.expressionMatchesShape(node, 'sg._shadowType !== "csm"')
            )
                return "(generator.filter != ShadowFilter::csm_directional)";
            if (
                context.expressionMatchesShape(
                    node,
                    "engine.surfaces.some((surface) => surface._renderingContexts.length > 0)",
                )
            )
                return "!engine.rendering_contexts.empty()";
            return undefined;
        },
        statement(statement, lowerer, indent) {
            const key = platformKey(statement);
            if (key !== undefined) {
                const shape = platformShapes.get(key);
                if (shape)
                    context.assertStatementShapes(
                        statement,
                        [statement],
                        shape,
                        "enableCsmStaticCache platform statement",
                    );
                reached.add(key);
                return [];
            }
            if (
                !ts.isExpressionStatement(statement) &&
                !ts.isVariableStatement(statement)
            )
                return undefined;
            const expression = ts.isExpressionStatement(statement)
                ? statement.expression
                : statement.declarationList.declarations[0]?.initializer;
            if (!expression) return undefined;
            const assigned =
                ts.isBinaryExpression(expression) &&
                expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
                    ? context.propertyPath(expression.left)?.join(".")
                    : undefined;
            // The swapped texture is the cache target the task state builds.
            if (assigned === "sg._depthTexture") {
                reached.add(assigned);
                return [];
            }
            // The options the cache keeps.
            if (assigned === "sg._csmCache") {
                const literal = unwrapLiteral(
                    (expression as ts.BinaryExpression).right,
                );
                const members = literal?.properties.map((property) =>
                    ts.isPropertyAssignment(property)
                        ? ([
                              context.propertyName(property.name),
                              property.initializer,
                          ] as const)
                        : undefined,
                );
                const names = members?.map((member) => member?.[0]).join();
                if (
                    !members ||
                    names !==
                        "_refitAngle,_refitMaxIntervalMs,_staticCascadesPerFrame,_cascadeCoveragePadding"
                )
                    return context.contractError(
                        expression,
                        "Expected the cache's four options.",
                    );
                context.assertExpressionShape(
                    members[3]![1],
                    "cascadeCoveragePadding",
                    "Omitted coverage option",
                );
                const [angle, interval, perFrame] = members.map((member) =>
                    lowerer.expression(member![1]),
                );
                reached.add(assigned);
                return [
                    `${indent}auto cache = std::make_shared<CsmStaticCacheState>();`,
                    `${indent}cache->options = {${angle}, ${interval}, static_cast<std::uint32_t>(${perFrame})};`,
                    `${indent}generator.csm_cache = std::move(cache);`,
                ];
            }
            return undefined;
        },
        returnValue(expression) {
            const node = expression && unwrapExpression(expression);
            if (node && ts.isIdentifier(node) && node.text === "promise")
                return "std::nullopt";
            if (
                node &&
                ts.isCallExpression(node) &&
                context.expressionMatchesShape(node, "Promise.resolve()")
            )
                return "std::nullopt";
            const error =
                node && ts.isCallExpression(node) && node.arguments.length === 1
                    ? unwrapExpression(node.arguments[0]!)
                    : undefined;
            if (
                node &&
                ts.isCallExpression(node) &&
                context.propertyPath(node.expression)?.join(".") ===
                    "Promise.reject" &&
                error &&
                ts.isNewExpression(error) &&
                ts.isIdentifier(error.expression) &&
                error.arguments?.length === 1 &&
                ts.isStringLiteral(error.arguments[0]!)
            ) {
                rejected.push(error.expression.text);
                return `js::make_error(${stringLiteral(error.expression.text)}, ${stringLiteral(error.arguments[0].text)})`;
            }
            return context.contractError(
                expression ?? declaration,
                "Expected enableCsmStaticCache to reject, resolve or return its promise.",
            );
        },
    });
    for (const shape of [
        ...platformShapes.keys(),
        "sg._depthTexture",
        "sg._csmCache",
        "promise",
        "void",
    ])
        if (!reached.has(shape))
            context.contractError(
                declaration,
                `enableCsmStaticCache no longer has '${shape}'.`,
            );
    if (
        rejected.join() !==
        "Error,RangeError,RangeError,RangeError,Error,RangeError,Error"
    )
        context.contractError(
            declaration,
            "Expected the seven enableCsmStaticCache rejections.",
        );
    return `
// ${context.provenance(enableModule, "enableCsmStaticCache")}
std::optional<js::Error> enable_csm_static_cache(
    Engine& engine, ShadowGeneratorHandle handle, double refit_angle,
    std::optional<double> refit_max_interval_ms,
    std::optional<double> static_cascades_per_frame) {
    ShadowGeneratorRecord& generator = ${recordAt("engine.shadow_generators", "handle")};
    const std::optional<double> cascade_coverage_padding;
${body}
}
`;
}

function unwrapLiteral(
    expression: ts.Expression,
): ts.ObjectLiteralExpression | undefined {
    const node = unwrapExpression(expression);
    return ts.isObjectLiteralExpression(node) ? node : undefined;
}
