import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

/**
 * `setGpuTimingEnabled` and the pin's frame timer. The wanted state, the
 * module hop, the one-time timer and the hooks follow `engine.ts`; the
 * in-flight gate and the smoothed readback are lowered from `gpu-timer.ts`.
 * PAL writes the markers into each frame's commands (SDL_GPU outside passes,
 * Dawn in a marker pass) and resolves the pair after the frame's submission.
 */
export function lowerGpuFrameTimer(
    context: LoweringContext,
    name: string,
): { prototype: string; lines: string[] } {
    const engineModule = "src/engine/engine.ts";
    const timerModule = "src/engine/gpu-timer.ts";
    const { declaration: enable } = context.functionDeclaration(
        engineModule,
        "setGpuTimingEnabled",
    );
    context.assertStatementShapes(
        enable,
        enable.body!.statements,
        'if (!enabled) { engine._gpuTimerWanted = false; engine.gpuFrameTimeMs = 0; engine._gpuTimerBegin = undefined; engine._gpuTimerEnd = undefined; engine._gpuTimerResolve = engine._gpuTaskTimerResolve; return; } if (!isGpuTimingSupported(engine)) { return; } engine._gpuTimerWanted = true; void import("./gpu-timer.js").then(({ createGpuFrameTimer, gpuFrameTimerBegin, gpuFrameTimerEnd, gpuFrameTimerResolve }) => { if (engine._gpuTimer === undefined) { engine._gpuTimer = createGpuFrameTimer(engine._device); } const timer = engine._gpuTimer; if (timer && engine._gpuTimerWanted) { engine._gpuTimerBegin = (encoder) => gpuFrameTimerBegin(timer, encoder); engine._gpuTimerEnd = (encoder) => gpuFrameTimerEnd(timer, encoder); engine._gpuTimerResolve = () => { gpuFrameTimerResolve(timer); engine.gpuFrameTimeMs = timer.lastMs; engine._gpuTaskTimerResolve?.(); }; } });',
        "GPU frame timing switch",
    );
    const { declaration: supported } = context.functionDeclaration(
        engineModule,
        "isGpuTimingSupported",
    );
    context.assertStatementShapes(
        supported,
        supported.body!.statements,
        'return engine._device.features.has("timestamp-query");',
        "GPU frame timing support",
    );
    const { declaration: create } = context.functionDeclaration(
        timerModule,
        "createGpuFrameTimer",
    );
    context.expectShapeCount(
        create,
        'device.createQuerySet({ type: "timestamp", count: 2 })',
        "GPU frame timer query pair",
    );
    for (const [marker, index] of [
        ["gpuFrameTimerBegin", "beginningOfPassWriteIndex: 0"],
        ["gpuFrameTimerEnd", "endOfPassWriteIndex: 1"],
    ] as const) {
        const { declaration } = context.functionDeclaration(
            timerModule,
            marker,
        );
        context.expectShapeCount(
            declaration,
            `encoder.beginComputePass({ timestampWrites: { querySet: timer.querySet, ${index} } })`,
            "GPU frame timer marker pass",
        );
    }
    const { file, declaration: resolve } = context.functionDeclaration(
        timerModule,
        "gpuFrameTimerResolve",
    );
    const statements = resolve.body!.statements;
    context.assertStatementShapes(
        resolve,
        [statements[0]!, statements[7]!],
        "if (timer.inFlight > 3) { return; } timer.inFlight++;",
        "GPU frame timer readback gate",
    );
    const readback = statements[8];
    const call =
        readback && ts.isExpressionStatement(readback)
            ? readback.expression
            : undefined;
    const [fulfilled, rejected] =
        call && ts.isCallExpression(call) ? call.arguments : [];
    if (
        !fulfilled ||
        !rejected ||
        !ts.isArrowFunction(fulfilled) ||
        !ts.isArrowFunction(rejected) ||
        !ts.isBlock(fulfilled.body) ||
        !ts.isBlock(rejected.body)
    )
        return context.contractError(
            resolve,
            "Expected the frame timer's readback settlement.",
        );
    context.assertStatementShapes(
        fulfilled,
        fulfilled.body.statements,
        "const a = new BigInt64Array(rb.getMappedRange()); const ms = Number(a[1]! - a[0]!) / 1e6; if (ms >= 0 && ms < 5000) { timer.lastMs = timer.lastMs > 0 ? timer.lastMs * 0.8 + ms * 0.2 : ms; } rb.unmap(); timer.pool.push(rb); timer.inFlight--;",
        "GPU frame timer sample",
    );
    context.assertStatementShapes(
        rejected,
        rejected.body.statements,
        "timer.inFlight--;",
        "GPU frame timer failed readback",
    );
    const bindings = new Map<string, PinnedBinding>([
        ["timer.inFlight", { cpp: "timer.in_flight", type: "scalar" }],
        ["timer.lastMs", { cpp: "timer.last_ms", type: "scalar" }],
    ]);
    const scope = {
        bindings,
        calls: new Map(),
        expression: (expression: ts.Expression) =>
            context.expressionMatchesShape(expression, "Number(a[1]! - a[0]!)")
                ? "static_cast<double>(static_cast<std::int64_t>((*raw)[1] - (*raw)[0]))"
                : undefined,
    };
    const gate = lowerPinnedBody(file, [statements[0]!], scope);
    const issued = lowerPinnedBody(file, [statements[7]!], scope);
    const sample = lowerPinnedBody(
        file,
        [
            fulfilled.body.statements[1]!,
            fulfilled.body.statements[2]!,
            fulfilled.body.statements[5]!,
        ],
        scope,
        "            ",
    );
    const failed = lowerPinnedBody(
        file,
        rejected.body.statements,
        scope,
        "                ",
    );
    const state = "std::shared_ptr<bbl::pal::GpuTaskTimingState>";
    return {
        prototype: `void ${name}(${state} engine, bool enabled);`,
        lines: [
            `// ${context.provenance(engineModule, "setGpuTimingEnabled, isGpuTimingSupported")}`,
            `// ${context.provenance(timerModule, "createGpuFrameTimer, gpuFrameTimerBegin, gpuFrameTimerEnd, gpuFrameTimerResolve")}`,
            `static void ${name}_settle(bbl::pal::GpuFrameTimer& timer) {`,
            "    while (!timer.pending.empty()) {",
            "        std::optional<std::vector<std::uint64_t>> raw;",
            "        try {",
            "            raw = timer.pending.front()->poll();",
            "        } catch (const std::exception&) {",
            "            timer.pending.erase(timer.pending.begin());",
            "            {",
            failed,
            "            }",
            "            continue;",
            "        }",
            "        if (!raw) return;",
            "        timer.pending.erase(timer.pending.begin());",
            '        if (raw->size() != 2) throw std::logic_error("GPU frame timer readback has no query pair.");',
            "        {",
            sample,
            "        }",
            "    }",
            "}",
            "",
            `static void ${name}_resolve(bbl::pal::GpuTaskTimingState& engine, bbl::pal::GpuFrameTimer& timer) {`,
            gate,
            "    timer.pending.push_back(engine.device->resolve_gpu_timestamps(timer.query_set, 2));",
            issued,
            "}",
            "",
            `void ${name}(${state} engine, bool enabled) {`,
            "    if (!enabled) {",
            "        engine->frame_timer_wanted = false;",
            "        engine->gpu_frame_time_ms = 0;",
            "        engine->frame_timer_begin = nullptr;",
            "        engine->frame_timer_end = nullptr;",
            "        // Task timing resolves its own readbacks natively.",
            "        engine->frame_timer_resolve = nullptr;",
            "        return;",
            "    }",
            "    if (!engine->supported) return;",
            "    engine->frame_timer_wanted = true;",
            "    // An evaluated module's dynamic import settles with its namespace.",
            "    static_cast<void>(bbl::js::Promise<bbl::js::PromiseVoid>::resolved(bbl::js::PromiseVoid{}).then(",
            "        [owner = std::weak_ptr<bbl::pal::GpuTaskTimingState>(engine)](const bbl::js::PromiseVoid&) {",
            "            const auto state = owner.lock();",
            "            if (!state) return;",
            "            if (!state->frame_timer) {",
            "                auto created = std::make_shared<bbl::pal::GpuFrameTimer>();",
            "                created->query_set = state->device->create_gpu_timestamp_query_set(2);",
            "                state->frame_timer = std::move(created);",
            "            }",
            "            const auto timer = *state->frame_timer;",
            "            if (!timer || !state->frame_timer_wanted) return;",
            "            state->frame_timer_begin = [timer] {",
            "                // Readbacks the GPU finished settle before the next frame.",
            `                ${name}_settle(*timer);`,
            "                return bbl::pal::GpuTimestampWrite{timer->query_set, 0, true};",
            "            };",
            "            state->frame_timer_end = [timer] { return bbl::pal::GpuTimestampWrite{timer->query_set, 1, false}; };",
            "            state->frame_timer_resolve = [timing = state.get(), timer] {",
            `                ${name}_resolve(*timing, *timer);`,
            "                timing->gpu_frame_time_ms = timer->last_ms;",
            "            };",
            "        }));",
            "}",
        ],
    };
}
