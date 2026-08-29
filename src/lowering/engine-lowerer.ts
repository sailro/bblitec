import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

export class EngineLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerCore(): LoweredSource {
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
`,
        };
    }
}
