import type { PinnedCallSpelling } from "./pinned-numeric-lowerer.js";
import ts from "typescript";
import { type LoweredSource, type LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    computeTextureDescriptorCpp,
    computeTextureSamplingCpp,
    computeTextureAccessCpp,
} from "./compute-texture-descriptor.js";

import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { stringLiteral } from "../cpp-literals.js";
import { pinnedRecordLiteral } from "./pinned-record-literal.js";

export function textureOwnershipCpp(
    context: LoweringContext,
    prefix = "",
): string {
    return [
        [
            "src/resource/gpu-texture-acquire.ts",
            "acquireGPUTexture",
            "void",
            "acquire_gpu_texture_source",
        ],
        [
            "src/resource/texture-allocation-release.ts",
            "releaseTextureAllocation",
            "bool",
            "release_gpu_texture_source",
        ],
    ]
        .map(([path, symbol, type, name]) => {
            const { file, declaration } = context.functionDeclaration(
                path!,
                symbol!,
            );
            if (symbol === "releaseTextureAllocation")
                context.assertExpressionShape(
                    context.variableInitializer(file, "_textureReleaseHook"),
                    "null",
                    "Unreached texture capture hook",
                );
            const body = lowerPinnedBody(file, declaration.body!.statements, {
                bindings: new Map([
                    ["texture", { cpp: "image", type: "opaque" }],
                    ["allocation", { cpp: "image", type: "opaque" }],
                    ["facade", { cpp: "false", type: "bool" }],
                ]),
                calls: new Map([
                    ["references.get", () => "image.owners"],
                    [
                        "references.set",
                        (args: readonly string[]) =>
                            `(image.owners = ${args[1]})`,
                    ],
                    ["allocation.destroy", () => "image.allocation->destroy()"],
                    ["_textureReleaseHook", () => "void()"],
                ]),
                expression(node) {
                    if (
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.QuestionQuestionToken &&
                        ts.isCallExpression(node.left) &&
                        node.left.expression.getText(file) === "references.get"
                    )
                        return "image.owners";
                    return undefined;
                },
                statement(node, _lowerer, indent) {
                    if (!ts.isVariableStatement(node)) return undefined;
                    const [variable] = node.declarationList.declarations;
                    if (
                        !variable ||
                        !ts.isIdentifier(variable.name) ||
                        variable.name.text !== "references"
                    )
                        return undefined;
                    context.assertExpressionShape(
                        variable.initializer!,
                        "getTextureReferenceStore()",
                        "Allocation ownership storage",
                    );
                    return [
                        `${indent}// The native image carries this allocation's reference-store entry.`,
                    ];
                },
                returnValue(node, lowerer) {
                    return node ? lowerer.expression(node) : "";
                },
            });
            return `// ${context.provenance(path!, symbol!)}\nstatic ${type} ${prefix}${name}(GpuTextureSource& image) {\n${body}\n}`;
        })
        .join("\n");
}

function sampledResourcesCpp(context: LoweringContext): string {
    const path = "src/compute/compute-texture-resource.ts";
    const functions: string[] = [];
    for (const [symbol, signature] of [
        [
            "_createOwnedComputeTextureResource",
            "static std::shared_ptr<ComputeTextureResource> create_owned_compute_texture_resource(const std::shared_ptr<Engine>& engine, FileTexture texture, const std::string& sample_type, const std::string& view_dimension)",
        ],
        [
            "_isComputeTextureSampleTypeCompatible",
            "bool is_compute_texture_sample_type_compatible(const std::string& actual, const std::string& declared)",
        ],
        [
            "_validateComputeTextureResource",
            "void validate_compute_texture_resource(const std::shared_ptr<ComputeTextureResource>& resource)",
        ],
        [
            "invalidateComputeTextureResource",
            "void invalidate_compute_texture_resource(const std::shared_ptr<ComputeTextureResource>& resource)",
        ],
    ] as const) {
        const { file, declaration } = context.functionDeclaration(path, symbol);
        const bindings = new Map<string, PinnedBinding>([
            ["engine", { cpp: "engine", type: "opaque" }],
            ["texture", { cpp: "texture", type: "opaque" }],
            [
                "texture.texture",
                { cpp: "texture.data.gpu_source->allocation", type: "opaque" },
            ],
            ["texture.texture.sampleCount", { cpp: "1.0", type: "scalar" }],
            ["sampleType", { cpp: "sample_type", type: "opaque" }],
            ["viewDimension", { cpp: "view_dimension", type: "opaque" }],
            ["actual", { cpp: "actual", type: "opaque" }],
            ["declared", { cpp: "declared", type: "opaque" }],
            ["resource._handle", { cpp: "resource->handle", type: "opaque" }],
            ["resource.texture", { cpp: "resource->texture", type: "opaque" }],
            [
                "resource.texture.texture",
                {
                    cpp: "resource->texture.data.gpu_source->allocation",
                    type: "opaque",
                },
            ],
            [
                "resource._destroyed",
                { cpp: "resource->destroyed", type: "bool" },
            ],
            [
                "resource._engine._resourceEpoch",
                { cpp: "engine->resource_epoch", type: "scalar" },
            ],
        ]);
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            bindings,
            calls: new Map([
                [
                    "_isTextureReleased",
                    () => "(resource->texture.data.gpu_source->owners == 0)",
                ],
            ]),

            expression(node) {
                if (ts.isStringLiteral(node)) return stringLiteral(node.text);
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.QuestionQuestionToken &&
                    node.left.getText(file) ===
                        "resource._engine._resourceEpoch"
                )
                    return "engine->resource_epoch";
                return undefined;
            },
            returnValue(node, lowerer) {
                if (!node) return "";
                if (symbol !== "_createOwnedComputeTextureResource")
                    return lowerer.expression(node);
                return `std::make_shared<ComputeTextureResource>(${pinnedRecordLiteral(
                    context,
                    lowerer,
                    node,
                    {
                        cpp: "ComputeTextureResource",
                        fields: {
                            texture: { cpp: "texture" },
                            sampleType: { cpp: "sample_type" },
                            multisampled: { cpp: "multisampled" },
                            viewDimension: { cpp: "view_dimension" },
                            _engine: { cpp: "engine" },
                            _handle: { cpp: "handle" },
                            _destroyed: { cpp: "destroyed" },
                        },
                    },
                )})`;
            },
        });
        const needsEngine =
            symbol === "_validateComputeTextureResource" ||
            symbol === "invalidateComputeTextureResource";
        functions.push(
            `// ${context.provenance(path, symbol)}\n${signature} {\n${needsEngine ? '    const auto engine = resource->engine.lock();\n    if (!engine) throw std::runtime_error("Compute texture engine has expired.");\n' : ""}${body}\n}`,
        );
    }
    return functions.join("\n");
}

function factoryCpp(context: LoweringContext): string {
    const path = "src/resource/compute-storage-texture-view.ts";
    const normalize = context.functionDeclaration(path, "normalizeOptions");
    const sampledDefault = context.variableInitializer(
        normalize.declaration,
        "sampled",
    );
    if (
        !ts.isBinaryExpression(sampledDefault) ||
        sampledDefault.operatorToken.kind !==
            ts.SyntaxKind.QuestionQuestionToken ||
        sampledDefault.right.kind !== ts.SyntaxKind.TrueKeyword
    )
        return context.contractError(
            sampledDefault,
            "Compute sampling default changed.",
        );
    const requested = context.variableInitializer(
        normalize.declaration,
        "requested",
    );
    context.assertExpressionShape(
        requested,
        'typeof options.access === "string" ? [options.access] : [...(options.access ?? ["write-only"])]',
        "Compute access input representation",
    );
    const { file, declaration } = context.functionDeclaration(
        path,
        "createComputeStorageTexture",
    );
    const statements = declaration.body!.statements;
    const scopeIndex = statements.findIndex(ts.isTryStatement);
    if (scopeIndex < 0)
        return context.contractError(
            declaration,
            "Expected a GPU validation scope.",
        );
    const scope = statements[scopeIndex]!;
    if (!ts.isTryStatement(scope) || !scope.finallyBlock)
        return context.contractError(
            scope,
            "Expected asynchronous GPU validation.",
        );
    context.assertExpressionShape(
        context.variableInitializer(declaration, "normalized"),
        "normalizeOptions(engine, options)",
        "Compute descriptor normalization",
    );
    context.assertExpressionShape(
        context.variableInitializer(declaration, "device"),
        "engine._device",
        "Compute device snapshot",
    );
    // The PAL batches this WebGPU validation scope into one native completion.
    // Its payload retains creation and GPU-validation failures separately.
    const completion = scope.finallyBlock.statements[0];
    if (
        scope.finallyBlock.statements.length !== 1 ||
        !completion ||
        !ts.isExpressionStatement(completion)
    )
        return context.contractError(
            scope,
            "Compute validation completion changed.",
        );
    context.assertExpressionShape(
        completion.expression,
        "validationError = await device.popErrorScope()",
        "Compute validation completion",
    );
    const bindings = new Map<string, PinnedBinding>([
        [
            "creationError",
            { cpp: "static_cast<bool>(creation_error)", type: "bool" },
        ],
        ["gpu", { cpp: "static_cast<bool>(gpu)", type: "bool" }],
        ["engine._device", { cpp: "engine->offscreen_run", type: "opaque" }],
        ["device", { cpp: "device", type: "opaque" }],
        [
            "validationError",
            { cpp: "validation_error.has_value()", type: "bool" },
        ],
        [
            "validationError.message",
            { cpp: "*validation_error", type: "opaque" },
        ],
    ]);
    const body = lowerPinnedBody(file, statements.slice(scopeIndex + 1), {
        bindings,
        calls: new Map([["gpu.texture.destroy", () => "gpu->destroy()"]]),

        expression(node) {
            if (
                ts.isCallExpression(node) &&
                node.expression.getText(file) === "gpu?.texture.destroy" &&
                !node.arguments.length
            )
                return "(gpu ? gpu->destroy() : void())";
            return undefined;
        },
        statement(node, _lowerer, indent) {
            if (ts.isReturnStatement(node)) {
                if (!node.expression)
                    return context.contractError(
                        node,
                        "Expected a compute texture result.",
                    );
                context.assertExpressionShape(
                    node.expression,
                    "_createComputeStorageTexture(engine, normalized, gpu)",
                    "Compute texture registration",
                );
                return [
                    `${indent}co_return register_compute_storage_texture(engine, std::move(options), std::move(gpu));`,
                ];
            }
            if (
                !ts.isThrowStatement(node) ||
                !ts.isNewExpression(node.expression)
            )
                return undefined;
            const error = node.expression;
            if (
                !ts.isIdentifier(error.expression) ||
                error.expression.text !== "Error" ||
                error.arguments?.length !== 2 ||
                !ts.isTemplateExpression(error.arguments[0]!)
            )
                return context.contractError(
                    node,
                    "Expected the invalid descriptor error.",
                );
            const message = error.arguments[0];
            if (
                message.templateSpans.length !== 1 ||
                message.templateSpans[0]!.literal.text !== ""
            )
                return context.contractError(
                    message,
                    "Expected one creation-error interpolation.",
                );
            context.assertExpressionShape(
                message.templateSpans[0]!.expression,
                "creationError instanceof Error ? creationError.message : String(creationError)",
                "Compute creation error message",
            );
            context.assertExpressionShape(
                error.arguments[1]!,
                "{ cause: creationError }",
                "Compute creation error cause",
            );
            return [
                `${indent}std::rethrow_exception(js::make_error("Error", ${stringLiteral(message.head.text)} + (creation_error ? js::promise_error_message(creation_error) : std::string("undefined")), creation_error));`,
            ];
        },
    });
    return `// ${context.provenance(path, "createComputeStorageTexture")}
js::Promise<std::shared_ptr<ComputeStorageTexture>> create_compute_storage_texture(std::shared_ptr<Engine> engine, ComputeStorageTextureOptions options) {
    if (!engine || !engine->offscreen_run) throw pal::InvalidCanvasState("Compute texture has no engine device.");
    const auto caps = engine->offscreen_run->device().compute_texture_capabilities();
    auto& descriptor = options.descriptor;
    const auto extent = upstream::normalize_compute_texture_extent(options.width, options.height, options.depth, descriptor.dimension, options.mip_maps, caps.limits);
    for (std::size_t i = 0; i < extent.size(); ++i) {
        if (extent[i] > static_cast<double>(std::numeric_limits<std::uint32_t>::max())) throw std::runtime_error("Compute texture extent exceeds the native GPU API range.");
        descriptor.extent[i] = static_cast<std::uint32_t>(extent[i]);
    }
    descriptor.mip_levels = static_cast<std::uint32_t>(upstream::compute_texture_mip_count(extent, descriptor.dimension, options.mip_maps));
    descriptor.accesses = upstream::normalize_compute_texture_accesses(options.access_supplied ? descriptor.accesses : std::vector<std::string>{"write-only"});
    descriptor.sampled = options.sampled.value_or(true);
    if (descriptor.sampled) {
        descriptor.sample_type = upstream::resolve_compute_texture_sample_type(descriptor.format, descriptor.sampler, caps);
        descriptor.sampler_type = upstream::compute_texture_sampler_type(descriptor.sampler);
    }
    descriptor.render_attachment = options.mip_maps && upstream::compute_texture_render_mips(descriptor.dimension, descriptor.format, descriptor.sampled, caps);
    const auto device = engine->offscreen_run;
    auto creation = co_await pal::allocate_compute_texture(device, descriptor);
    auto gpu = std::move(creation.allocation);
    const auto creation_error = creation.creation_error;
    const auto validation_error = std::move(creation.validation_error);
${body}
}
`;
}

function registrationCpp(context: LoweringContext): string {
    const path = "src/resource/compute-storage-texture.ts";
    const { file, declaration } = context.functionDeclaration(
        path,
        "_createComputeStorageTexture",
    );
    const bindings = new Map<string, PinnedBinding>([
        ["gpu.sampling", { cpp: "options.descriptor.sampled", type: "bool" }],
        ["resource", { cpp: "resource", type: "opaque" }],
        [
            "sampledTexture",
            { cpp: "resource->sampled_texture", type: "opaque" },
        ],
        [
            "computeTexture",
            { cpp: "resource->compute_texture", type: "opaque" },
        ],
    ]);
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls: new Map(),
        expression(node) {
            if (ts.isCallExpression(node)) {
                const callee = node.expression.getText(file);
                if (callee === "acquireTexture")
                    return "acquire_gpu_texture_source(*resource->sampled_texture->data.gpu_source)";
                if (callee === "_createOwnedComputeTextureResource")
                    return "create_owned_compute_texture_resource(engine, *resource->sampled_texture, options.descriptor.sample_type, options.descriptor.dimension)";
                if (callee === "hooked.has")
                    return "static_cast<bool>(engine->dispose_compute_textures)";
                if (callee === "hooked.add") return "void()";
                if (callee === "resourcesFor(engine).add")
                    return "register_compute_resource(engine, resource)";
                if (callee === "registerManagedResourceDisposer") {
                    context.assertExpressionShape(
                        node,
                        "registerManagedResourceDisposer(engine, () => _disposeComputeStorageTextures(engine))",
                        "Compute engine cleanup hook",
                    );
                    return `(engine->dispose_compute_textures = [weak = std::weak_ptr<Engine>(engine)] { if (auto owner = weak.lock()) if (auto registry = owner->compute_storage_textures.lock()) dispose_compute_storage_textures(registry); }, register_managed_resource_disposer(*engine, engine->dispose_compute_textures))`;
                }
            }
            if (ts.isObjectLiteralExpression(node)) {
                context.assertExpressionShape(
                    node,
                    '{ texture: gpu.texture, view: sampling.view, sampler: sampling.sampler._sampler, width: options.width, height: options.height, invertY: options.invertY ?? true, ...(options.viewDimension === "2d-array" ? { layers: options.depthOrArrayLayers } : {}), ...(options.viewDimension === "3d" ? { depth: options.depthOrArrayLayers } : {}) }',
                    "Sampled facade GPU transport",
                );
                return "sampled_facade";
            }
            return undefined;
        },
        statement(node, lowerer, indent) {
            if (!ts.isVariableStatement(node)) return undefined;
            return node.declarationList.declarations.flatMap(
                (entry): string[] => {
                    if (!ts.isIdentifier(entry.name) || !entry.initializer)
                        return context.contractError(
                            entry,
                            "Expected compute resource local.",
                        );
                    const name = entry.name.text;
                    if (name === "resource") {
                        context.assertExpressionShape(
                            entry.initializer,
                            "{ width: options.width, height: options.height, depthOrArrayLayers: options.depthOrArrayLayers, viewDimension: options.viewDimension, format: options.format, accesses: options.accesses, sampledTexture, computeTexture, computeSampler, _engine: engine, _texture: gpu.texture, _view: gpu.view, _destroyed: false } as unknown as ComputeStorageTexture",
                            "Native compute resource fields",
                        );
                        return [];
                    }
                    if (name === "hooked") {
                        context.assertExpressionShape(
                            entry.initializer,
                            "_hookedEngines ??= new WeakSet()",
                            "Compute engine hook identity",
                        );
                        return [];
                    }
                    if (name === "computeSampler") {
                        context.assertExpressionShape(
                            entry.initializer,
                            "sampling?.sampler ?? null",
                            "Compute sampler facade",
                        );
                        return [
                            `${indent}if (options.descriptor.sampled) resource->compute_sampler = std::make_shared<ComputeSamplerResource>(ComputeSamplerResource{engine, engine->offscreen_run, resource->allocation, options.descriptor.sampler_type});`,
                        ];
                    }
                    if (
                        name !== "sampling" &&
                        name !== "sampledTexture" &&
                        name !== "computeTexture"
                    )
                        return context.contractError(
                            entry,
                            "Unrepresented compute resource local.",
                        );
                    if (name === "sampledTexture" || name === "computeTexture")
                        return [];
                    const rhs =
                        entry.initializer.kind === ts.SyntaxKind.NullKeyword
                            ? "false"
                            : lowerer.expression(entry.initializer);
                    bindings.set(name, { cpp: name, type: "bool" });
                    return [`${indent}[[maybe_unused]] bool ${name} = ${rhs};`];
                },
            );
        },
        returnValue(node, lowerer) {
            return node ? lowerer.expression(node) : "";
        },
    });
    return `// Native representation of the pin's per-engine WeakMap<Engine, Set<Resource>>.
static void register_compute_resource(const std::shared_ptr<Engine>& engine, const std::shared_ptr<ComputeStorageTexture>& resource) {
    auto registry = engine->compute_storage_textures.lock();
    if (!registry) {
        registry = std::make_shared<ComputeStorageTextureRegistry>();
        registry->engine = engine;
        engine->compute_storage_textures = registry;
        engine->native_resource_owners.push_back(registry);
    }
    resource->registry = registry;
    registry->resources.insert(resource);
}
// ${context.provenance(path, "_createComputeStorageTexture")}
static std::shared_ptr<ComputeStorageTexture> register_compute_storage_texture(const std::shared_ptr<Engine>& engine, ComputeStorageTextureOptions options, std::shared_ptr<pal::ComputeTextureAllocation> gpu) {
    auto resource = std::make_shared<ComputeStorageTexture>();
    resource->run = engine->offscreen_run;
    resource->allocation = std::move(gpu);
    resource->descriptor = options.descriptor;
    resource->invert_y = options.invert_y;
    FileTexture sampled_facade;
    sampled_facade.identity = engine->next_file_texture_identity++;
    sampled_facade.width = options.descriptor.extent[0];
    sampled_facade.height = options.descriptor.extent[1];
    sampled_facade.data.uv_invert_y = options.invert_y;
    sampled_facade.data.gpu_source = std::make_shared<GpuTextureSource>();
    sampled_facade.data.gpu_source->run = resource->run;
    sampled_facade.data.gpu_source->allocation = resource->allocation;
    sampled_facade.data.gpu_source->acquire = acquire_gpu_texture_source;
    sampled_facade.data.gpu_source->release = release_gpu_texture_source;
${body}
}
`;
}

function disposalCpp(context: LoweringContext): string {
    const path = "src/resource/compute-storage-texture.ts";
    const { file, declaration } = context.functionDeclaration(
        path,
        "disposeComputeStorageTextureInternal",
    );
    const bindings = new Map<string, PinnedBinding>([
        ["resource", { cpp: "resource", type: "opaque" }],
        ["force", { cpp: "force", type: "bool" }],
        ["resource._destroyed", { cpp: "resource->destroyed", type: "bool" }],
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
        [
            "resource.computeTexture._destroyed",
            { cpp: "resource->compute_texture->destroyed", type: "bool" },
        ],
        [
            "resource._engine._resourceEpoch",
            { cpp: "engine->resource_epoch", type: "scalar" },
        ],
        [
            "resources.size",
            {
                cpp: "static_cast<double>(resources->resources.size())",
                type: "scalar",
            },
        ],
    ]);
    const calls = new Map<string, PinnedCallSpelling>();
    calls.set(
        "_textureOwners",
        () => "resource->sampled_texture->data.gpu_source->owners",
    );
    calls.set(
        "releaseTexture",
        () => "pal::release_compute_texture_owner(resource)",
    );
    calls.set(
        "resource._texture.destroy",
        () => "resource->allocation->destroy()",
    );
    calls.set("resources.delete", () => "resources->resources.erase(resource)");
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls,
        statement(node, _lowerer, indent) {
            if (!ts.isVariableStatement(node)) return undefined;
            const entries = node.declarationList.declarations;
            if (
                entries.length !== 1 ||
                !ts.isIdentifier(entries[0]!.name) ||
                entries[0]!.name.text !== "resources"
            )
                return undefined;
            const initializer = entries[0]!.initializer;
            if (
                !initializer ||
                !ts.isCallExpression(initializer) ||
                initializer.expression.getText(file) !== "_resources?.get" ||
                initializer.arguments.length !== 1 ||
                initializer.arguments[0]!.getText(file) !== "resource._engine"
            )
                return context.contractError(
                    node,
                    "Compute registry lookup changed.",
                );
            bindings.set("resources", { cpp: "resources", type: "opaque" });
            return [
                `${indent}const auto resources = resource->registry.lock();`,
                `${indent}const auto engine = resources ? resources->engine.lock() : nullptr;`,
            ];
        },
        expression(node) {
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionToken &&
                node.left.getText(file) === "resource._engine._resourceEpoch"
            )
                return "engine->resource_epoch";
            if (!ts.isCallExpression(node)) return undefined;
            const name = node.expression.getText(file);
            if (
                name === "resources?.has" &&
                node.arguments.length === 1 &&
                node.arguments[0]!.getText(file) === "resource"
            )
                return "(resources && resources->resources.contains(resource))";
            if (
                name === "_resources?.delete" &&
                node.arguments.length === 1 &&
                node.arguments[0]!.getText(file) === "resource._engine"
            )
                return "pal::remove_compute_registry(resources)";
            return undefined;
        },
        callShapes: new Map([["resources?.has", "bool"]]),
    });
    return `// ${context.provenance(path, "disposeComputeStorageTextureInternal")}
static void dispose_compute_storage_texture_internal(const std::shared_ptr<ComputeStorageTexture>& resource, bool force) {
${body}
}
void dispose_compute_storage_texture(const std::shared_ptr<ComputeStorageTexture>& resource) {
    dispose_compute_storage_texture_internal(resource, false);
}
void dispose_compute_storage_textures(const std::shared_ptr<ComputeStorageTextureRegistry>& registry) {
    const auto snapshot = registry->resources;
    for (const auto& resource : snapshot) dispose_compute_storage_texture_internal(resource, true);
}
`;
}

export function lowerComputeTexture(context: LoweringContext): LoweredSource {
    return {
        modulePath: "src/resource/compute-storage-texture.ts",
        symbolName: "disposeComputeStorageTextureInternal",
        header: "",
        source: `#include <bblite/pal_compute_storage_texture.hpp>
namespace bbl {
namespace upstream {
${computeTextureDescriptorCpp(context)}
${computeTextureSamplingCpp(context)}
${computeTextureAccessCpp(context)}
}
${textureOwnershipCpp(context)}
${disposalCpp(context)}
${sampledResourcesCpp(context)}
${registrationCpp(context)}
${factoryCpp(context)}
}
`,
    };
}
