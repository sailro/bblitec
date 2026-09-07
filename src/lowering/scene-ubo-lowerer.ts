import ts from "typescript";
import { LoweringContext } from "./context.js";
import { PinnedNumericLowerer, type PinnedBinding } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";

const TAA_MODULE = "src/post-process/taa.ts";
const SCENE_MODULE = "src/frame-graph/render-task.ts";

/** Pinned scene-uniform mutation over task-owned CPU storage and borrowed upload hooks. */
export class SceneUboLowerer {
    constructor(private readonly context: LoweringContext) {}

    private cameraKey(): string {
        return lowerPinnedFunction(this.context, "src/camera/camera.ts", "_cameraChangeKey", [
            { pinned: "camera", kind: "record", annotation: "Camera", cpp: "camera", cppType: "Camera", mutableRecord: true },
        ], { cppName: "scene_camera_change_key", returns: "double", templateParameters: ["class Camera"], booleanOr: true,
            memberBindings: new Map([
                ["camera._projFov", { cpp: "camera.projection_fov", type: "scalar" }],
                ["camera._projNear", { cpp: "camera.projection_near", type: "scalar" }],
                ["camera._projFar", { cpp: "camera.projection_far", type: "scalar" }],
                ["camera._projRev", { cpp: "camera.projection_revision", type: "scalar" }],
                ["camera.worldMatrixVersion", { cpp: "camera.world_matrix_version", type: "scalar" }],
                ["camera.fov", { cpp: "camera.fov", type: "scalar" }],
                ["camera.nearPlane", { cpp: "camera.near_plane", type: "scalar" }],
                ["camera.farPlane", { cpp: "camera.far_plane", type: "scalar" }],
            ]),
        });
    }

    private writeScene(): string {
        const { file, declaration } = this.context.functionDeclaration(SCENE_MODULE, "_writePassSceneUBO");
        const tailIndex = declaration.body!.statements.findIndex((statement) => ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === "data"));
        if (tailIndex < 0) this.context.contractError(declaration, "Scene UBO materialization boundary changed.");
        const tail = ts.createSourceFile(`${file.fileName}-materialize`,
            `const materialize = () => {${declaration.body!.statements.slice(tailIndex).map((statement) => statement.getText(file)).join("\n")}};`,
            ts.ScriptTarget.Latest, true);
        if (!this.context.expressionMatchesShape(this.context.variableInitializer(tail, "materialize"), `() => {
            const data = task._suData;
            _packSceneUniforms(data, eng, scene, camera, aspect);
            const contribs = scene._sceneUboContributors;
            if (contribs) {
                for (const contributor of contribs) { contributor(data, scene); }
            }
            eng._device.queue.writeBuffer(task._sceneUBO, 0, data as Float32Array<ArrayBuffer>);
        }`)) this.context.contractError(declaration, "Scene UBO pack/contributor/upload tail changed; re-read its PAL boundary.");
        const bindings = new Map<string, PinnedBinding>([
            ["camera", { cpp: "camera", type: "opaque", absentCpp: "camera == nullptr" }],
            ["camera.viewport", { cpp: "camera->viewport", type: "opaque", absentCpp: "!camera->viewport.has_value()" }],
            ["camera.viewport.width", { cpp: "camera->viewport->width", type: "scalar" }],
            ["camera.viewport.height", { cpp: "camera->viewport->height", type: "scalar" }],
            ["task._config.rt", { cpp: "source", type: "opaque" }],
            ["task._config.rt._width", { cpp: "source.width", type: "scalar" }],
            ["task._config.rt._height", { cpp: "source.height", type: "scalar" }],
            ["task._config.cs", { cpp: "source.canvas_size", type: "bool" }],
            ["eng.canvas.width", { cpp: "engine.width", type: "scalar" }],
            ["eng.canvas.height", { cpp: "engine.height", type: "scalar" }],
            ["scene.fog", { cpp: "scene.fog_identity", type: "opaque" }],
            ["scene.imageProcessing", { cpp: "scene", type: "opaque" }],
            ["scene.imageProcessing.exposure", { cpp: "scene.exposure", type: "scalar" }],
            ["scene.imageProcessing.contrast", { cpp: "scene.contrast", type: "scalar" }],
            ["scene._envTextures", { cpp: "scene.environment_identity", type: "opaque" }],
            ["task._sceneUboCacheKey", { cpp: "source.cache", type: "opaque" }],
            ...["camera", "fog", "camera_key", "aspect", "exposure", "contrast", "environment"].map((field, index): [string, PinnedBinding] => [
                `s[${index}]`, { cpp: `source.cache.${field}`, type: index === 0 || index === 1 || index === 6 ? "opaque" : "scalar", mutable: true },
            ]),
        ]);
        const lowerer = new PinnedNumericLowerer(file, { bindings, booleanAnd: true,
            calls: new Map([["_cameraChangeKey", (args) => `camera_key(${args.join(", ")})`]]) });
        return `// ${this.context.provenance(SCENE_MODULE, "_writePassSceneUBO", "cache before scene packing and upload")}
template<class Source, class Engine, class Scene, class Camera, class CameraKey, class WriteFull>
void write_pass_scene_ubo(Source& source, const Engine& engine, const Scene& scene, Camera* camera,
    CameraKey&& camera_key, WriteFull&& write_full) {
${declaration.body!.statements.slice(0, tailIndex).flatMap((statement) => lowerer.statement(statement, "    ")).join("\n")}
    write_full(source, aspect);
}`;
    }

    private halton(): string {
        return lowerPinnedFunction(this.context, TAA_MODULE, "halton", [
            { pinned: "index", kind: "number", cpp: "index" },
            { pinned: "base", kind: "number", cpp: "base" },
        ], { cppName: "taa_halton", returns: "double", inline: true, calls: pinnedNumericMathCalls() });
    }

    private sequence(): string {
        return lowerPinnedFunction(this.context, TAA_MODULE, "generateHalton", [
            { pinned: "samples", kind: "number", cpp: "samples" },
        ], { cppName: "generate_taa_halton", inline: true,
            returns: { type: "std::vector<float>", value: (lowerer, value) => {
                if (!value) throw new Error("Pinned Halton generation must return its sequence.");
                return lowerer.expression(value);
            } },
            calls: new Map([["halton", (args) => `taa_halton(${args.join(", ")})`]]),
        });
    }

    private advance(): string {
        const { file, declaration } = this.context.functionDeclaration(TAA_MODULE, "advanceJitter");
        const bindings = new Map<string, PinnedBinding>([
            ["task", { cpp: "state", type: "opaque" }],
            ["task._sourceRenderTask", { cpp: "source", type: "opaque" }],
            ["task._sourceRenderTask._suData", { cpp: "source.clean", type: "f32" }],
            ["task._sourceRenderTask._sceneUBO", { cpp: "source", type: "opaque" }],
            ["task.sourceTexture._width", { cpp: "width", type: "scalar" }],
            ["task.sourceTexture._height", { cpp: "height", type: "scalar" }],
            ["task._halton", { cpp: "state.halton", type: "f32" }],
            ["task._haltonIndex", { cpp: "state.halton_index", type: "scalar" }],
            ["task._jitterScratch", { cpp: "state.jitter_scratch", type: "f32" }],
        ]);
        const lowerer = new PinnedNumericLowerer(file, {
            bindings,
            booleanOr: true,
            calls: new Map([["task.engine._device.queue.writeBuffer", (args) =>
                `write_span(${args.join(", ")})`]]),
        });
        return `template<class State, class Source, class WriteSpan>
void advance_taa_jitter(State& state, Source& source, double width, double height, WriteSpan&& write_span) {
${declaration.body!.statements.flatMap((statement) => lowerer.statement(statement, "    ")).join("\n")}
}`;
    }

    public jitterHeader(): string {
        return `#pragma once
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

// ${this.context.provenance(TAA_MODULE, "halton,generateHalton,advanceJitter", "persistent scene-uniform jitter")}
namespace bbl::upstream {
${this.halton()}

${this.sequence()}

${this.advance()}
} // namespace bbl::upstream
`;
    }

    public cacheHeader(): string {
        return `#pragma once
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <optional>

namespace bbl::upstream {
${this.cameraKey()}

${this.writeScene()}
} // namespace bbl::upstream
`;
    }
}
