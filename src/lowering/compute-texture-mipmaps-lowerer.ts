import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";
import {
    lowerPinnedBody,
    type PinnedBodyScope,
} from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { stringLiteral } from "../cpp-literals.js";
import { computeTextureSamplingCpp } from "./compute-texture-descriptor.js";

/** Source validation, level iteration and task closures over PAL-owned mip bindings. */
export function lowerComputeTextureMipmaps(
    context: LoweringContext,
): LoweredSource {
    const taskPath = "src/compute/compute-storage-texture-mipmaps.ts";
    const mipPath = "src/texture/mipmap-preparation.ts";
    const factory = context.functionDeclaration(
        taskPath,
        "createComputeStorageTextureMipmapsTask",
    );
    const prepare = context.functionDeclaration(mipPath, "prepareMipmaps");
    const record = context.functionDeclaration(
        mipPath,
        "recordPreparedMipmaps",
    );
    const shader = context.variableInitializer(prepare.file, "BLIT_SHADER");
    if (
        !ts.isNoSubstitutionTemplateLiteral(shader) &&
        !ts.isStringLiteral(shader)
    )
        return context.contractError(
            shader,
            "Expected the pinned mip blit shader.",
        );
    const shaderCode = shader.text;
    const pipeline = context.functionDeclaration(mipPath, "getPipeline");
    context.assertExpressionShape(
        context.callObjectArgument(
            pipeline.declaration,
            "createRenderPipeline",
        ),
        "{layout:device.createPipelineLayout({bindGroupLayouts:[bindGroupLayout!]}),vertex:{module:shaderModule!,entryPoint:'vs'},fragment:{module:shaderModule!,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list'}}",
        "Native mipmap pipeline descriptor",
    );
    const ensure = context.functionDeclaration(mipPath, "ensureResources");
    context.assertExpressionShape(
        context.callObjectArgument(ensure.declaration, "createBindGroupLayout"),
        "{entries:[{binding:0,visibility:SS.FRAGMENT,texture:{sampleType:'float'}},{binding:1,visibility:SS.FRAGMENT,sampler:{}}]}",
        "Native mipmap binding layout",
    );
    context.assertExpressionShape(
        context.callExpression(ensure.declaration, "getBilinearSampler"),
        "getBilinearSampler(engine)",
        "Mipmap bilinear sampler",
    );
    context.assertExpressionShape(
        context.variableInitializer(
            context.functionDeclaration(
                "src/resource/samplers.ts",
                "getBilinearSampler",
            ).file,
            "_bilinearDesc",
        ),
        "{magFilter:'linear',minFilter:'linear'}",
        "Native mipmap sampler descriptor",
    );
    const bindings = new Map<string, PinnedBinding>([
        ["resources.length", { cpp: "resources.size()", type: "scalar" }],
        [
            "textures.length",
            {
                cpp: "static_cast<std::int64_t>(textures.size())",
                type: "scalar",
            },
        ],
        [
            "texture.mipLevelCount",
            { cpp: "texture_descriptor.mip_levels", type: "scalar" },
        ],
        [
            "texture.format",
            { cpp: "texture_descriptor.format", type: "opaque" },
        ],
        [
            "engine._device",
            { cpp: "engine->offscreen_run->device()", type: "opaque" },
        ],
        [
            "engine._currentEncoder",
            { cpp: "engine->current_compute_encoder", type: "opaque" },
        ],
        [
            "resource._engine",
            { cpp: "compute_mipmap_resource_engine(resource)", type: "opaque" },
        ],
        ["resource._destroyed", { cpp: "resource->destroyed", type: "bool" }],
        [
            "resource.viewDimension",
            { cpp: "resource->descriptor.dimension", type: "opaque" },
        ],
        [
            "resource.format",
            { cpp: "resource->descriptor.format", type: "opaque" },
        ],
        [
            "resource.sampledTexture",
            { cpp: "resource->sampled_texture.has_value()", type: "bool" },
        ],
        [
            "resource.computeTexture",
            {
                cpp: "static_cast<bool>(resource->compute_texture)",
                type: "bool",
            },
        ],
        ["resource._texture", { cpp: "resource", type: "opaque" }],
        [
            "resource._texture.mipLevelCount",
            { cpp: "resource->descriptor.mip_levels", type: "scalar" },
        ],
        ["levels.length", { cpp: "levels.size()", type: "scalar" }],
        ["level.descriptor", { cpp: "level", type: "opaque" }],
        ["level.pipeline", { cpp: "level", type: "opaque" }],
        ["level.bindGroup", { cpp: "level", type: "opaque" }],
    ]);
    for (const name of [
        "engine",
        "name",
        "textures",
        "prepared",
        "resource",
        "pipeline",
        "bindGroup",
        "pass",
        "level",
        "levels",
        "texture",
    ])
        bindings.set(name, {
            cpp: name === "bindGroup" ? "bind_group" : name,
            type: "opaque",
        });
    bindings.set("drawCount", { cpp: "draw_count", type: "scalar" });
    bindings.set("count", { cpp: "count", type: "scalar" });
    const calls = new Map<string, (args: readonly string[]) => string>([
        [
            "_supportsComputeRenderMipmaps",
            (a) =>
                `mipmap_source::compute_texture_render_mips(${a[1]}, ${a[2]}, ${a[3]}, ${a[0]}->offscreen_run->device().compute_texture_capabilities())`,
        ],
        ["prepareMipmaps", (a) => `prepare_compute_mipmaps(${a.join(", ")})`],
        [
            "recordPreparedMipmaps",
            (a) => `record_compute_mipmaps(${a.join(", ")})`,
        ],
        [
            "getPipeline",
            (a) =>
                `${a[0]}->offscreen_run->device().prepare_compute_mipmap_pipeline(${a[1]}, ${stringLiteral(shaderCode)})`,
        ],
        [
            "encoder.beginRenderPass",
            (a) => `encoder->begin_mipmap_pass(${a[0]})`,
        ],
        ["pass.setPipeline", (a) => `pass.set_pipeline(${a[0]})`],
        [
            "pass.setBindGroup",
            (a) =>
                `pass.set_bind_group(static_cast<std::uint32_t>(${a[0]}), ${a[1]})`,
        ],
        ["pass.draw", (a) => `pass.draw(static_cast<std::uint32_t>(${a[0]}))`],
        ["pass.end", () => "pass.end()"],
    ]);
    const scope = (file: ts.SourceFile): PinnedBodyScope => ({
        bindings: new Map(bindings),
        calls,
        expression(node) {
            if (ts.isStringLiteral(node)) return stringLiteral(node.text);
            if (context.expressionMatchesShape(node, "resources[0]!._engine"))
                return "compute_mipmap_resource_engine(resources.at(0))";
            if (
                ts.isElementAccessExpression(node) &&
                ["textures", "prepared"].includes(node.expression.getText(file))
            )
                return `${node.expression.getText(file)}[static_cast<std::size_t>(${node.argumentExpression.getText(file)})]`;
            return undefined;
        },
        forOf(iterated, element) {
            if (!["textures", "prepared"].includes(iterated)) return undefined;
            return {
                range: iterated,
                bindings: new Map([
                    [element, { cpp: element, type: "opaque" }],
                ]),
            };
        },
        statement(node, lowerer, indent) {
            if (ts.isExpressionStatement(node)) {
                const value = node.expression;
                if (
                    context.expressionMatchesShape(value, "textures.length = 0")
                )
                    return [`${indent}textures.clear();`];
                if (
                    ts.isCallExpression(value) &&
                    value.expression.getText(file) === "prepared.push"
                ) {
                    context.assertExpressionShape(
                        value,
                        "prepared.push({pipeline,bindGroup,descriptor:{colorAttachments:[{view:texture.createView({baseMipLevel:mip,mipLevelCount:1,...viewOptions}),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:0}}]}})",
                        "Prepared mip pass descriptor",
                    );
                    return [`${indent}prepared.push_back(bind_group);`];
                }
            }
            if (
                !ts.isVariableStatement(node) ||
                node.declarationList.declarations.length !== 1
            )
                return undefined;
            const declaration = node.declarationList.declarations[0]!;
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
                return undefined;
            const name = declaration.name.text,
                init = declaration.initializer;
            if (name === "textures") {
                context.assertExpressionShape(
                    init,
                    "[...resources]",
                    "Mipmap resource list snapshot",
                );
                return [
                    `${indent}auto textures = js::Array<std::shared_ptr<ComputeStorageTexture>>(resources.begin(), resources.end());`,
                ];
            }
            if (name === "viewOptions") {
                context.assertExpressionShape(
                    init,
                    "face === undefined ? {} : {dimension:'2d' as const,baseArrayLayer:face,arrayLayerCount:1}",
                    "Mipmap view layer selection",
                );
                return [];
            }
            if (name === "prepared") {
                if (
                    ts.isArrayLiteralExpression(init) &&
                    init.elements.length === 0
                )
                    return [`${indent}PreparedComputeMipmaps prepared;`];
                if (
                    !ts.isCallExpression(init) ||
                    init.expression.getText(file) !== "textures.map" ||
                    init.arguments.length !== 1 ||
                    !ts.isArrowFunction(init.arguments[0]!)
                )
                    return context.contractError(
                        init,
                        "Expected prepared mipmap mapping.",
                    );
                const callback = init.arguments[0];
                if (ts.isBlock(callback.body))
                    return context.contractError(
                        callback.body,
                        "Expected mipmap preparation expression.",
                    );
                return [
                    `${indent}js::Array<PreparedComputeMipmaps> prepared;`,
                    `${indent}for (const auto& resource : textures) prepared.push_back(${lowerer.expression(callback.body)});`,
                ];
            }
            if (name === "drawCount") {
                if (
                    !ts.isCallExpression(init) ||
                    init.expression.getText(file) !== "prepared.reduce" ||
                    init.arguments.length !== 2 ||
                    !ts.isArrowFunction(init.arguments[0]!)
                )
                    return context.contractError(
                        init,
                        "Expected mipmap draw count reduction.",
                    );
                const callback = init.arguments[0];
                if (ts.isBlock(callback.body))
                    return context.contractError(
                        callback.body,
                        "Expected mipmap draw count expression.",
                    );
                return [
                    `${indent}const double draw_count = std::accumulate(prepared.begin(), prepared.end(), ${lowerer.expression(init.arguments[1]!)}, [&](double count, const auto& levels) { return ${lowerer.expression(callback.body)}; });`,
                ];
            }
            if (name === "bindGroup") {
                context.assertExpressionShape(
                    init,
                    "device.createBindGroup({layout:bindGroupLayout!,entries:[{binding:0,resource:texture.createView({baseMipLevel:mip-1,mipLevelCount:1,...viewOptions})},{binding:1,resource:linearSampler!}]})",
                    "Prepared mip sampled view",
                );
                return [
                    `${indent}const auto bind_group = engine->offscreen_run->device().prepare_compute_mipmap_level(pipeline, texture_allocation, texture_descriptor, static_cast<std::uint32_t>(mip - 1), static_cast<std::uint32_t>(mip), face.value_or(0));`,
                ];
            }
            if (name === "device") {
                context.assertExpressionShape(
                    init,
                    "engine._device",
                    "Mipmap device",
                );
                return [];
            }
            if (["engine", "pipeline", "resource", "pass"].includes(name))
                return [
                    `${indent}${name === "pass" ? "auto" : "const auto"} ${name} = ${lowerer.expression(init)};`,
                ];
            return undefined;
        },
        returnValue(value, lowerer) {
            return !value
                ? ""
                : ts.isArrayLiteralExpression(value) &&
                    value.elements.length === 0
                  ? "{}"
                  : lowerer.expression(value);
        },
    });
    const returned = factory.declaration.body!.statements.find(
        ts.isReturnStatement,
    )?.expression;
    if (!returned || !ts.isObjectLiteralExpression(returned))
        return context.contractError(
            factory.declaration,
            "Expected a mipmap task record.",
        );
    const methods = new Map<string, ts.MethodDeclaration>();
    for (const member of returned.properties) {
        if (ts.isMethodDeclaration(member))
            methods.set(member.name.getText(factory.file), member);
        else if (
            ts.isShorthandPropertyAssignment(member) &&
            ["name", "engine"].includes(member.name.text)
        )
            continue;
        else if (
            ts.isPropertyAssignment(member) &&
            member.name.getText(factory.file) === "_passes"
        )
            context.assertExpressionShape(
                member.initializer,
                "[]",
                "Empty mipmap task passes",
            );
        else
            return context.contractError(
                member,
                "Unrepresented mipmap task property.",
            );
    }
    const closures = ["record", "execute", "dispose"]
        .map((name) => {
            const method = methods.get(name);
            if (!method?.body)
                return context.contractError(
                    returned,
                    `Missing mipmap task ${name}.`,
                );
            const body = lowerPinnedBody(
                factory.file,
                method.body.statements,
                scope(factory.file),
            );
            return `    task->${name} = js::make_closure(std::tuple{textures, prepared, draw_count, engine, name}, [](auto& captures) -> ${name === "execute" ? "double" : "void"} {
        [[maybe_unused]] auto& textures = std::get<0>(captures);
        [[maybe_unused]] auto& prepared = std::get<1>(captures);
        [[maybe_unused]] auto& draw_count = std::get<2>(captures);
        [[maybe_unused]] auto& engine = std::get<3>(captures);
        [[maybe_unused]] auto& name = std::get<4>(captures);
${body}
    });`;
        })
        .join("\n");
    return {
        modulePath: taskPath,
        symbolName: "createComputeStorageTextureMipmapsTask",
        header: "",
        source: `#include <bblite/pal_compute_texture_mipmaps.hpp>
#include <numeric>
namespace bbl {
namespace mipmap_source {
${computeTextureSamplingCpp(context)}
}
// ${context.provenance(mipPath, "prepareMipmaps")}
PreparedComputeMipmaps prepare_compute_mipmaps(const std::shared_ptr<Engine>& engine, const std::shared_ptr<pal::ComputeTextureAllocation>& texture_allocation, const pal::ComputeTextureDescriptor& texture_descriptor, std::optional<std::uint32_t> face) {
${lowerPinnedBody(prepare.file, prepare.declaration.body!.statements, scope(prepare.file))}
}
// ${context.provenance(mipPath, "recordPreparedMipmaps")}
void record_compute_mipmaps(const std::shared_ptr<pal::ComputeCommandEncoder>& encoder, const PreparedComputeMipmaps& prepared) {
${lowerPinnedBody(record.file, record.declaration.body!.statements, scope(record.file))}
}
// ${context.provenance(taskPath, "createComputeStorageTextureMipmapsTask")}
std::shared_ptr<ComputeTask> create_compute_storage_texture_mipmaps_task(std::string name, const std::vector<std::shared_ptr<ComputeStorageTexture>>& resources) {
${lowerPinnedBody(
    factory.file,
    factory.declaration.body!.statements.filter(
        (node) => !ts.isReturnStatement(node),
    ),
    scope(factory.file),
)}
    auto task = js::make_gc_shared<ComputeTask>();
    task->engine = engine;
    task->name = name;
    // Absent Task.executionEnabled is enabled; ComputeTask's factory explicitly disables its own.
    task->execution_enabled = true;
${closures}
    return task;
}
}
`,
    };
}
