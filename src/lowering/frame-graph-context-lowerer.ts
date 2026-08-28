import type { LoweredSource, LoweringContext } from "./context.js";

const modulePath = "src/frame-graph/frame-graph-context.ts";

/** Lowers the pin's scene-less RenderingContext ownership and registration. */
export class FrameGraphContextLowerer {
    public constructor(private readonly context: LoweringContext) {
        for (const symbol of [
            "createFrameGraphContext",
            "registerFrameGraphContext",
        ]) {
            this.context.functionDeclaration(modulePath, symbol);
        }
    }

    public lower(): LoweredSource {
        return {
            modulePath,
            symbolName:
                "createFrameGraphContext,registerFrameGraphContext",
            header: "",
            source: `// ${this.context.provenance(
                modulePath,
                "createFrameGraphContext,registerFrameGraphContext",
            )}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace bbl {

namespace {

void require_context_engine(const FrameGraphContext& context) {
    if (!context.engine) {
        throw std::runtime_error(
            "FrameGraphContext is not associated with an engine.");
    }
}

void require_context_task(
    const FrameGraphContext& context,
    TaskHandle task) {
    require_context_engine(context);
    if (task.value >= context.engine->frame_tasks.size()) {
        throw std::runtime_error("Invalid frame-graph task handle.");
    }
}

} // namespace

FrameGraphContext create_frame_graph_context(Engine& engine) {
    FrameGraphContext context;
    context.engine = &engine;
    return context;
}

void add_task(FrameGraphContext& context, TaskHandle task) {
    require_context_task(context, task);
    context.tasks.push_back(task);
}

void add_task_at_start(FrameGraphContext& context, TaskHandle task) {
    require_context_task(context, task);
    context.tasks.insert(context.tasks.begin(), task);
}

void on_frame_graph_update(
    FrameGraphContext& context,
    std::function<void(float)> callback) {
    context.updates.push_back(std::move(callback));
}

void register_frame_graph_context(FrameGraphContext& context) {
    require_context_engine(context);
    const auto found = std::find(
        context.engine->registered_frame_graph_contexts.begin(),
        context.engine->registered_frame_graph_contexts.end(),
        &context);
    if (found == context.engine->registered_frame_graph_contexts.end()) {
        context.engine->registered_frame_graph_contexts.push_back(&context);
    }
}

} // namespace bbl
`,
        };
    }
}
