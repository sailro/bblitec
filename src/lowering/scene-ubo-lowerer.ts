import ts from "typescript";
import { cameraChangeKeyHeader } from "./camera-change-key-lowerer.js";
import { LoweringContext } from "./context.js";
import { type PinnedBinding } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { pinnedHeader } from "./pinned-header.js";

const TAA_MODULE = "src/post-process/taa.ts";
const SCENE_MODULE = "src/frame-graph/render-task.ts";
const PACK_MODULE = "src/frame-graph/scene-uniforms-pack.ts";
const EXTRAS_MODULE = "src/scene/scene-ubo-extras.ts";

const copyFloats = (receiver: string, source: string, offset: string): string =>
    `std::transform(${source}.begin(), ${source}.end(), ${receiver}.begin() + static_cast<std::size_t>(${offset}), [](auto value) { return static_cast<float>(value); })`;

/** Pinned scene-uniform mutation over task-owned CPU storage and borrowed upload hooks. */
export class SceneUboLowerer {
    constructor(private readonly context: LoweringContext) {}

    private packMatrix(): string {
        return lowerPinnedFunction(this.context, "src/math/pack-mat4-into-f32.ts", "packMat4IntoF32", [
            { pinned: "view", kind: "mat4", annotation: "Float32Array", cpp: "data", cppType: "std::vector<float>", mutableRecord: true },
            { pinned: "mat", kind: "mat4Const", annotation: "Mat4 | Float32Array | Float64Array", cpp: "matrix", cppType: "Matrix",
                binding: { cpp: "matrix", type: "f64-buffer" } },
            { pinned: "offsetFloats", kind: "number", cpp: "offset", pinnedDefault: true },
            { pinned: "srcOffsetFloats", kind: "number", cpp: "source_offset", pinnedDefault: true },
        ], { cppName: "pack_scene_matrix", returns: "void", templateParameters: ["class Matrix"],
            booleanAnd: true, arrayCopy: copyFloats });
    }

    private packScene(): string {
        return lowerPinnedFunction(this.context, PACK_MODULE, "_packSceneUniforms", [
            { pinned: "data", kind: "mat4", annotation: "Float32Array", cpp: "data", cppType: "std::vector<float>", mutableRecord: true },
            { pinned: "eng", kind: "record", annotation: "EngineContext", cpp: "engine", cppType: "Engine" },
            { pinned: "scene", kind: "record", annotation: "SceneContext", cpp: "scene", cppType: "Scene" },
            { pinned: "camera", kind: "record", annotation: "Camera", cpp: "camera", cppType: "Camera", mutableRecord: true },
            { pinned: "aspect", kind: "number", cpp: "aspect" },
        ], { cppName: "pack_scene_uniforms", returns: "void",
            templateParameters: ["class Engine", "class Scene", "class Camera", "class ViewProjection", "class View", "class World"],
            leadingParameters: ["ViewProjection&& get_view_projection", "View&& get_view", "World&& camera_world"],
            calls: new Map([
                ["getViewProjectionMatrix", (args) => `get_view_projection(${args.join(", ")})`],
                ["getViewMatrix", (args) => `get_view(${args.join(", ")})`],
                ["packMat4IntoF32", (args) => `pack_scene_matrix(${args.join(", ")})`],
            ]),
            callShapes: new Map([["getViewProjectionMatrix", "f64-buffer"], ["getViewMatrix", "f64-buffer"]]),
            methods: new Map([["fill", (receiver, args) => `std::fill(${receiver}.begin(), ${receiver}.end(), static_cast<float>(${args[0]}))`]]),
            memberBindings: new Map<string, PinnedBinding>([
                ["camera.worldMatrix", { cpp: "camera_world(camera)", type: "f64-buffer", materializeAlias: true }],
                ["eng.useFloatingOrigin", { cpp: "engine.use_floating_origin", type: "bool" }],
                ["eng.canvas.width", { cpp: "engine.width", type: "scalar" }],
                ["eng.canvas.height", { cpp: "engine.height", type: "scalar" }],
                ["scene._envTextures", { cpp: "scene.environment", type: "opaque", optional: {
                    present: "scene.environment.has_value()",
                    members: new Map([["lodGenerationScale", { cpp: "scene.environment->lod_generation_scale" }]]),
                } }],
                ["scene.imageProcessing", { cpp: "scene", type: "opaque" }],
                ["scene.imageProcessing.exposure", { cpp: "scene.exposure", type: "scalar" }],
                ["scene.imageProcessing.contrast", { cpp: "scene.contrast", type: "scalar" }],
                ["scene.imageProcessing.toneMappingEnabled", { cpp: "scene.tone_mapping_enabled", type: "bool" }],
            ]),
        });
    }

    private contributor(symbol: "writeFogUbo" | "writeClipPlaneUbo" | "writeEnvUbo", cpp: string): string {
        return lowerPinnedFunction(this.context, EXTRAS_MODULE, symbol, [
            { pinned: "data", kind: "mat4", annotation: "Float32Array", cpp: "data", cppType: "std::vector<float>", mutableRecord: true },
            { pinned: "scene", kind: "record", annotation: "SceneContext", cpp: "scene", cppType: "Scene" },
        ], { cppName: cpp, returns: "void", templateParameters: ["class Scene"], arrayCopy: copyFloats,
            memberBindings: new Map<string, PinnedBinding>([
                ["scene.fog", { cpp: "scene.fog", type: "opaque", absentCpp: "!scene.fog.has_value()" }],
                ...["mode", "start", "end", "density"].map((field): [string, PinnedBinding] =>
                    [`scene.fog.${field}`, { cpp: `scene.fog->${field}`, type: "scalar" }]),
                ["scene.fog.color", { cpp: "scene.fog->color", type: "f64-buffer" }],
                ["scene.clipPlane", { cpp: "(*scene.clip_plane)", type: "f64-buffer", absentCpp: "!scene.clip_plane.has_value()" }],
                ["scene", { cpp: "scene", type: "opaque", optional: {
                    present: "scene.environment_rotation.has_value()",
                    members: new Map([["_environmentRotation", { cpp: "(*scene.environment_rotation)" }]]),
                } }],
                ["scene._envTextures?.sphericalHarmonics", { cpp: "scene.environment->harmonics", type: "f32",
                    absentCpp: "!scene.environment.has_value() || !scene.environment->has_harmonics" }],
            ]),
        });
    }

    public packingHeader(): string {
        return pinnedHeader(["<algorithm>","<cstddef>","<vector>"], `${this.packMatrix()}

${this.packScene()}

${this.contributor("writeFogUbo", "write_fog_scene_uniforms")}

${this.contributor("writeClipPlaneUbo", "write_clip_scene_uniforms")}

${this.contributor("writeEnvUbo", "write_environment_scene_uniforms")}`, { compactPragma: true });
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

        return `// ${this.context.provenance(SCENE_MODULE, "_writePassSceneUBO", "cache before scene packing and upload")}
template<class Source, class Engine, class Scene, class Camera, class CameraKey, class WriteFull>
void write_pass_scene_ubo(Source& source, const Engine& engine, const Scene& scene, Camera* camera,
    CameraKey&& camera_key, WriteFull&& write_full) {
${lowerPinnedBody(file, declaration.body!.statements.slice(0, tailIndex), { bindings, booleanAnd: true,
            calls: new Map([["_cameraChangeKey", (args) => `camera_key(${args.join(", ")})`]]) })}
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

        return `template<class State, class Source, class WriteSpan>
void advance_taa_jitter(State& state, Source& source, double width, double height, WriteSpan&& write_span) {
${lowerPinnedBody(file, declaration.body!.statements, {
            bindings,
            booleanOr: true,
            calls: new Map([["task.engine._device.queue.writeBuffer", (args) =>
                `write_span(${args.join(", ")})`]]),
        })}
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

${cameraChangeKeyHeader(this.context)}
namespace bbl::upstream {
${this.writeScene()}
} // namespace bbl::upstream
`;
    }

    public storageHeader(): string {
        const { file, declaration } = this.context.functionDeclaration(SCENE_MODULE, "createRenderTask");
        const task = this.context.objectInitializer(declaration, "task");
        const clean = this.context.propertyInitializer(task, "_suData");
        const cache = this.context.propertyInitializer(task, "_sceneUboCacheKey");
        if (!ts.isNewExpression(clean) || !ts.isIdentifier(clean.expression) || clean.expression.text !== "F32" ||
            clean.arguments?.length !== 1 || !ts.isArrayLiteralExpression(cache) || cache.elements.length !== 0) {
            this.context.contractError(task, "Source scene UBO scratch/cache initialization changed.");
        }
        const length = this.context.numericValue(clean.arguments[0]!, file);
        const { declaration: taaFactory } = this.context.functionDeclaration(TAA_MODULE, "createTaaPostProcessTask");
        const taa = this.context.objectInitializer(taaFactory, "task");
        if (!this.context.expressionMatchesShape(this.context.propertyInitializer(taa, "_halton"), "generateHalton(samples)") ||
            !this.context.expressionMatchesShape(this.context.propertyInitializer(taa, "_jitterScratch"), "new F32(16)")) {
            this.context.contractError(taa, "TAA Halton/scratch initialization changed.");
        }
        return `// ${this.context.provenance(SCENE_MODULE, "createRenderTask", "task-owned scene UBO storage")}
namespace bbl::upstream {
inline std::shared_ptr<PersistentSceneUniforms> create_persistent_scene_uniforms() {
    // The pin's cache starts empty. A native null camera cannot match the
    // first non-null source camera; the writer returns before comparing null.
    // Thus the other unwritten key lanes need no invented undefined value.
    return std::make_shared<PersistentSceneUniforms>(PersistentSceneUniforms{
        {}, std::vector<float>(${length}u), std::vector<float>(${length}u)});
}

inline void initialize_taa_jitter(TaaPostProcessState& state, double samples) {
    state.halton = generate_taa_halton(samples);
    state.jitter_scratch = {};
}
} // namespace bbl::upstream
`;
    }
}
