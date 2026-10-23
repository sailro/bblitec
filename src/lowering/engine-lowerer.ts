import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import ts from "typescript";
import { lowerThinInstanceDisposal } from "./thin-instance-lowerer.js";
import { LoweredSource, LoweringContext } from "./context.js";

import { canvasDatasetSource } from "./canvas-dataset.js";
import {
    meshCompositionRowsCpp,
    type MeshProfileTable,
} from "./resource-profiles.js";
import {
    isAsyncFunction,
    sameSource,
    soleBindingName,
} from "../compiler/syntax.js";

export class EngineLowerer {
    public constructor(private readonly context: LoweringContext) {}

    /**
     * `meshProfiles` is the scene's runtime composition-profile table when
     * it has one; `create_engine` hands the engine its rows
     * (`MeshCompositionRows`) before the program stores a mesh.
     */
    public lowerCore(
        workers = false,
        frameConductor = true,
        meshProfiles?: MeshProfileTable,
    ): LoweredSource {
        const modulePath = "src/engine/engine.ts";
        const create = this.context.functionDeclaration(
            modulePath,
            "createEngine",
        ).declaration;
        const start = this.context.functionDeclaration(
            modulePath,
            "startEngine",
        ).declaration;
        if (!isAsyncFunction(create)) {
            throw new Error("Upstream createEngine is no longer async.");
        }
        if (!this.context.hasCall(start, "requestAnimationFrame")) {
            throw new Error(
                "Upstream startEngine no longer schedules requestAnimationFrame.",
            );
        }
        // `stopEngine` is the other half of the same contract: it cancels
        // the frame the start scheduled and clears the render function, so
        // no further frame submits. There is no `requestAnimationFrame`
        // here -- the frame conductor IS the loop -- so what is emitted is
        // a flag it checks, and the pin's own two writes are what say the
        // flag means the right thing.
        const stop = this.context.functionDeclaration(
            modulePath,
            "stopEngine",
        ).declaration;
        const stopText = stop.getText(this.context.sourceFile(modulePath));
        for (const fragment of [
            "cancelAnimationFrame(engine._animFrameId)",
            "engine._animFrameId = 0",
            "engine._renderFn = null",
        ]) {
            if (!stopText.includes(fragment)) {
                this.context.contractError(
                    stop,
                    `Expected stopEngine to carry '${fragment}'. The ` +
                        "generated stop is a flag the frame conductor " +
                        "reads, so a pinned change to what stopping " +
                        "means has to fail generation.",
                );
            }
        }
        return {
            modulePath,
            symbolName: "createEngine,startEngine,stopEngine",
            header: "",
            source: `// ${this.context.provenance(modulePath, "createEngine, startEngine, stopEngine")}
#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>
#include <bblite/upstream/thin_instance_sync.hpp>
${workers ? "#include <bblite/pal_async_engine.hpp>" : ""}

#include <utility>

namespace bbl {

Engine create_engine(EngineOptions options) {
${
    meshProfiles
        ? `    Engine engine = pal::create_engine(std::move(options));
${meshCompositionRowsCpp(meshProfiles)}    return engine;`
        : "    return pal::create_engine(std::move(options));"
}
}

${
    frameConductor
        ? `void start_engine(Engine& engine) {
    pal::run_engine(engine);
}`
        : ""
}

void stop_engine(Engine& engine) {
    engine.stopped = true;
    if (engine.flush_gpu_retirements) engine.flush_gpu_retirements();
}
${this.lowerFrameRetirementFlush()}
${lowerThinInstanceDisposal(this.context)}
${workers ? this.lowerSurfaceSize() : ""}

// The native reading of a bounded multi-frame drain: the scene's own
// condition, recorded for the frame loops to consult before they capture.
// Upstream the wait sits in front of the canvas ready flag, which is what
// the harness screenshots on.
void defer_capture_until(
    Engine& engine,
    std::function<bool()> ready) {
    engine.capture_ready.push_back(std::move(ready));
}

std::string asset_path(const std::string& relative_path) {
    const std::string override = pal::environment_variable("BBLITE_ASSET_DIR");
    const std::string root = override.empty()
        ? pal::join_path(pal::executable_directory(), BBLITE_ASSET_DIR)
        : override;
    return pal::join_path(
        root,
        relative_path);
}

} // namespace bbl
${canvasDatasetSource}
`,
        };
    }

    private lowerFrameRetirementFlush(): string {
        const module = "src/engine/engine.ts";
        const { file, declaration } = this.context.functionDeclaration(
            module,
            "_renderFrame",
        );
        const frame = declaration.body!.statements.find(ts.isTryStatement);
        if (!frame)
            return this.context.contractError(
                declaration,
                "Expected a guarded frame submit.",
            );
        const statements = frame.tryBlock.statements;
        const submit = statements.findIndex(
            (statement) =>
                ts.isExpressionStatement(statement) &&
                ts.isCallExpression(statement.expression) &&
                sameSource(
                    statement.expression.expression,
                    "engine._device.queue.submit",
                ),
        );
        const flush = statements[submit + 1];
        if (submit < 0 || !flush)
            return this.context.contractError(
                frame,
                "Expected a post-submit retirement flush.",
            );
        this.context.assertStatementShapes(
            frame.tryBlock,
            [flush],
            "engine._flushGpuRetirements?.(engine);",
            "Post-submit retirement scheduling",
        );
        const body = lowerPinnedBody(file, [flush], {
            bindings: new Map(),
            calls: new Map(),
            expression: (node) =>
                ts.isCallExpression(node) && node.questionDotToken
                    ? "(engine.flush_gpu_retirements ? engine.flush_gpu_retirements() : void())"
                    : undefined,
        });
        return `// ${this.context.provenance(module, "_renderFrame", "post-submit retirement flush")}
void flush_frame_gpu_retirements(Engine& engine) {
${body}
}`;
    }

    private lowerSurfaceSize(): string {
        const module = "src/engine/surface.ts";
        const { file, declaration } = this.context.functionDeclaration(
            module,
            "setSurfaceSize",
        );
        const statements = declaration.body!.statements;
        const first = statements[0];
        if (
            declaration.parameters
                .map((parameter) => soleBindingName(parameter.name))
                .join(",") !== "surface,widthPx,heightPx" ||
            !first ||
            !ts.isVariableStatement(first) ||
            first.declarationList.declarations.length !== 1 ||
            !sameSource(
                first.declarationList.declarations[0]!.name,
                "canvas",
            ) ||
            !first.declarationList.declarations[0]!.initializer ||
            !this.context.expressionMatchesShape(
                first.declarationList.declarations[0]!.initializer,
                "surface.canvas",
            )
        ) {
            this.context.contractError(
                declaration,
                "setSurfaceSize canvas/parameter binding changed.",
            );
        }
        const writes = [
            "canvas.width = w",
            "canvas.height = h",
            "surface.scRT._width = w",
            "surface.scRT._height = h",
        ];
        const split = statements.findIndex(
            (statement) =>
                ts.isExpressionStatement(statement) &&
                this.context.expressionMatchesShape(
                    statement.expression,
                    writes[0]!,
                ),
        );
        const tail = statements.slice(split);
        if (
            split < 1 ||
            tail.length !== 5 ||
            !writes.every((write, index) => {
                const statement = tail[index];
                return (
                    statement &&
                    ts.isExpressionStatement(statement) &&
                    this.context.expressionMatchesShape(
                        statement.expression,
                        write,
                    )
                );
            })
        )
            this.context.contractError(
                declaration,
                "setSurfaceSize native resize boundary changed.",
            );
        const notify = tail[4]!;
        if (
            !ts.isForOfStatement(notify) ||
            !ts.isVariableDeclarationList(notify.initializer) ||
            notify.initializer.declarations.length !== 1 ||
            !sameSource(notify.initializer.declarations[0]!.name, "c") ||
            !this.context.expressionMatchesShape(
                notify.expression,
                "surface._renderingContexts",
            ) ||
            !ts.isBlock(notify.statement) ||
            notify.statement.statements.length !== 1 ||
            !ts.isExpressionStatement(notify.statement.statements[0]!) ||
            !this.context.expressionMatchesShape(
                notify.statement.statements[0].expression,
                "c._resize?.()",
            )
        ) {
            this.context.contractError(
                notify,
                "setSurfaceSize renderer resize notifications changed.",
            );
        }

        const body = lowerPinnedBody(file, statements.slice(1, split), {
            bindings: new Map([
                ["widthPx", { cpp: "width_px", type: "scalar" }],
                ["heightPx", { cpp: "height_px", type: "scalar" }],
                [
                    "canvas.width",
                    {
                        cpp: "engine.offscreen_run->extent().width",
                        type: "scalar",
                    },
                ],
                [
                    "canvas.height",
                    {
                        cpp: "engine.offscreen_run->extent().height",
                        type: "scalar",
                    },
                ],
            ]),
            calls: new Map(),
        });
        return `
// ${this.context.provenance(module, "setSurfaceSize")}
void set_engine_size(Engine& engine, double width_px, double height_px) {
    if (!engine.offscreen_run) throw pal::InvalidCanvasState("Engine has no realm canvas.");
${body}
    pal::resize_realm_surface(engine, static_cast<std::uint32_t>(w), static_cast<std::uint32_t>(h));
}
`;
    }
}
