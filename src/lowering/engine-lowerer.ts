import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

import { canvasDatasetSource } from "./canvas-dataset.js";

export class EngineLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerCore(workers = false): LoweredSource {
        const modulePath = "src/engine/engine.ts";
        const create =
            this.context.functionDeclaration(
                modulePath,
                "createEngine",
            ).declaration;
        const start =
            this.context.functionDeclaration(
                modulePath,
                "startEngine",
            ).declaration;
        if (
            !create.modifiers?.some(
                (modifier) =>
                    modifier.kind === ts.SyntaxKind.AsyncKeyword,
            )
        ) {
            throw new Error(
                "Upstream createEngine is no longer async.",
            );
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
        const stop =
            this.context.functionDeclaration(
                modulePath,
                "stopEngine",
            ).declaration;
        const stopText = stop.getText(
            this.context.sourceFile(modulePath),
        );
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
${workers ? "#include <bblite/pal_async_engine.hpp>" : ""}

#include <utility>

#ifndef BBLITE_ASSET_DIR
#define BBLITE_ASSET_DIR "assets"
#endif

namespace bbl {

Engine create_engine(EngineOptions options) {
    return pal::create_engine(std::move(options));
}

void start_engine(Engine& engine) {
    pal::run_engine(engine);
}

void stop_engine(Engine& engine) {
    engine.stopped = true;
}
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

    private lowerSurfaceSize(): string {
        const module = "src/engine/surface.ts";
        const { file, declaration } = this.context.functionDeclaration(module, "setSurfaceSize");
        const statements = declaration.body!.statements;
        const first = statements[0];
        if (declaration.parameters.map(parameter => parameter.name.getText(file)).join(",") !== "surface,widthPx,heightPx" ||
            !first || !ts.isVariableStatement(first) || first.declarationList.declarations.length !== 1 ||
            first.declarationList.declarations[0]!.name.getText(file) !== "canvas" ||
            !first.declarationList.declarations[0]!.initializer ||
            !this.context.expressionMatchesShape(first.declarationList.declarations[0]!.initializer!, "surface.canvas")) {
            this.context.contractError(declaration, "setSurfaceSize canvas/parameter binding changed.");
        }
        const writes = ["canvas.width = w", "canvas.height = h", "surface.scRT._width = w", "surface.scRT._height = h"];
        const split = statements.findIndex(statement => ts.isExpressionStatement(statement) &&
            this.context.expressionMatchesShape(statement.expression, writes[0]!));
        const tail = statements.slice(split);
        if (split < 1 || tail.length !== 5 || !writes.every((write, index) => {
            const statement = tail[index];
            return statement && ts.isExpressionStatement(statement) && this.context.expressionMatchesShape(statement.expression, write);
        })) this.context.contractError(declaration, "setSurfaceSize native resize boundary changed.");
        const notify = tail[4]!;
        if (!ts.isForOfStatement(notify) || !ts.isVariableDeclarationList(notify.initializer) ||
            notify.initializer.declarations.length !== 1 || notify.initializer.declarations[0]!.name.getText(file) !== "c" ||
            !this.context.expressionMatchesShape(notify.expression, "surface._renderingContexts") ||
            !ts.isBlock(notify.statement) || notify.statement.statements.length !== 1 ||
            !ts.isExpressionStatement(notify.statement.statements[0]!) ||
            !this.context.expressionMatchesShape(notify.statement.statements[0]!.expression, "c._resize?.()")) {
            this.context.contractError(notify, "setSurfaceSize renderer resize notifications changed.");
        }

        const body = lowerPinnedBody(file, statements.slice(1, split), {
            bindings: new Map([
                ["widthPx", { cpp: "width_px", type: "scalar" }],
                ["heightPx", { cpp: "height_px", type: "scalar" }],
                ["canvas.width", { cpp: "engine.offscreen_run->extent().width", type: "scalar" }],
                ["canvas.height", { cpp: "engine.offscreen_run->extent().height", type: "scalar" }],
            ]), calls: new Map(), booleanAnd: true, checkedBitwiseCoercions: true,
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
