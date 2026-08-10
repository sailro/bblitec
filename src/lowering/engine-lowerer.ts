import { LoweredSource, LoweringContext } from "./context.js";

export class EngineLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerCore(): LoweredSource {
        const modulePath = "src/engine/engine.ts";
        const source = this.context.store.getSource(modulePath);
        for (const marker of [
            "export async function createEngine",
            "export function startEngine",
            "requestAnimationFrame",
        ]) {
            if (!source.includes(marker)) throw new Error(`Upstream engine contract changed: ${marker}.`);
        }
        return {
            modulePath,
            symbolName: "createEngine,startEngine",
            header: "",
            source: `// ${this.context.provenance(modulePath, "createEngine, startEngine")}
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
