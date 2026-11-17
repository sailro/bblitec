import type { LoweringContext } from "./context.js";

const module =
    "src/material/shader/enable-async-shader-pipeline-compilation.ts";

/**
 * `prepareShaderMaterialPipelineForTask`: the pin compiles the material's
 * pipeline for the render task's attachment signature before its first
 * draw, and its promise settles once the pipeline exists or rejects with
 * what its reads or the compile threw. Native pipelines are built when a
 * draw first binds them, on either backend, so the preparation keeps the
 * reads that can fail: a render task's signature and a shader material's
 * bindings.
 */
export function lowerShaderPipelinePreparation(
    context: LoweringContext,
    name: string,
): { prototype: string; lines: string[] } {
    const { declaration: forTask } = context.functionDeclaration(
        module,
        "prepareShaderMaterialPipelineForTask",
    );
    context.assertStatementShapes(
        forTask,
        forTask.body!.statements,
        "return prepareShaderMaterialPipeline(task.engine, material, layout, task, mesh);",
        "Task pipeline preparation",
    );
    const { declaration: prepare } = context.functionDeclaration(
        module,
        "prepareShaderMaterialPipeline",
    );
    context.expectShapeCount(
        prepare,
        "isRenderTask(target) ? target._targetSignature : renderTargetSignature(target)",
        "Preparation target signature",
    );
    context.expectShapeCount(
        prepare,
        "currentBindings(engine, material)",
        "Preparation material bindings",
    );
    const prototype = `bbl::js::Promise<bbl::js::PromiseVoid> ${name}(bbl::Engine& engine, bbl::TaskHandle task, bbl::MaterialHandle material);`;
    return {
        prototype,
        lines: [
            `// ${context.provenance(module, "prepareShaderMaterialPipelineForTask, prepareShaderMaterialPipeline")}`,
            `bbl::js::Promise<bbl::js::PromiseVoid> ${name}(bbl::Engine& engine, bbl::TaskHandle task, bbl::MaterialHandle material) {`,
            "    try {",
            "        if (bbl::handle_at(engine.frame_tasks, task).kind != bbl::FrameTaskKind::render)",
            '            throw std::runtime_error("prepareShaderMaterialPipelineForTask reads a render task\'s attachment signature.");',
            "        if (!bbl::handle_at(engine.materials, material).shader_material)",
            '            throw std::runtime_error("prepareShaderMaterialPipelineForTask reads a ShaderMaterial\'s pipeline bindings.");',
            "    } catch (...) {",
            "        return bbl::js::Promise<bbl::js::PromiseVoid>::rejected(std::current_exception());",
            "    }",
            "    return bbl::js::Promise<bbl::js::PromiseVoid>::resolved(bbl::js::PromiseVoid{});",
            "}",
        ],
    };
}
