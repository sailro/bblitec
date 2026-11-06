/**
 * `createSsaoTask`, lowered from its own modules.
 *
 * What the pin decides at creation -- modules, layouts, formats, owned
 * textures and the pass sequence of each working mode and history parity --
 * was obtained by running the factory (`pinned-ssao.ts`) and is emitted as
 * the plan table `ssao_plan.hpp`. What it decides every frame is translated
 * from the pinned ASTs into one generated frame function: the task's
 * `execute` (settings and camera validation, the projection terms), the
 * temporal filter's `prepare` and `execute` (`ssao-temporal.ts`: its reset
 * rules, view tracking, the 96-float block and the phase), the
 * half-resolution adapter's activation rule and `writeSsaoGpuParameters`.
 * The GPU work between those statements is the backend's: every statement
 * that creates, binds or encodes is asserted here and answered through
 * `SsaoFrameInputs` / `SsaoFrameDecision`, so a pin that grows a pass or an
 * upload fails generation by name.
 */
import ts from "typescript";
import { CppDefinitions, type CppModule } from "../cpp-definitions.js";
import { doubleLiteral, stringLiteral } from "../cpp-literals.js";
import type { SsaoTaskManifest } from "../compiler/types.js";
import {
    SSAO_GPU_MODULE,
    SSAO_HALF_MODULE,
    SSAO_MODULE,
    SSAO_MOTION_MASK_MODULE,
    SSAO_TEMPORAL_MODULE,
    SSAO_XEGTAO_GPU_MODULE,
    type ComposedSsaoTask,
    type SsaoBindingKind,
    type SsaoPassPlan,
} from "../pinned-ssao.js";
import { sameSource } from "../compiler/syntax.js";
import type { LoweredSource, LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    lowerInvertMat4ToRefOrIdentityCpp,
    lowerPackMat4IntoF32FastPathCpp,
    lowerPinnedFunction,
} from "./pinned-function-lowerer.js";
import { lowerMat4Determinant3 } from "./pinned-mat4-decompose.js";
import type {
    PinnedBinding,
    PinnedNumericLowerer,
    PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";

export interface SsaoLoweringInput {
    manifest: SsaoTaskManifest;
    composed: ComposedSsaoTask;
}

/** One deployed SSAO program: its stems and the constants each stage compiles with. */
export interface SsaoShaderModule {
    output: string;
    data: string;
    entryPoint: string;
    alsoStages?: {
        stem: string;
        entryPoint: string;
        namedConstants: { name: string; value: number }[];
    }[];
    namedConstants: { name: string; value: number }[];
}

/** The pin's uniform buffers, by label, and the decision block each fills. */
const UNIFORM_BLOCKS: ReadonlyMap<string, string> = new Map([
    ["ssao-params", "params"],
    ["ssao-half-pipeline-full-params", "full_params"],
    ["ssao-temporal-params", "temporal"],
]);

const BINDING_KINDS: Readonly<Record<SsaoBindingKind, string>> = {
    uniform: "uniform",
    "depth-texture": "depth_texture",
    "float-texture": "float_texture",
    "unfilterable-texture": "unfilterable_texture",
    "uint-texture": "uint_texture",
    "storage-texture": "storage_texture",
    "storage-buffer": "storage_buffer",
    "read-only-storage-buffer": "read_only_storage_buffer",
    "filtering-sampler": "filtering_sampler",
    "non-filtering-sampler": "non_filtering_sampler",
};

/** The closure `let`s of `initializeSsaoTemporal`, their initializers and native members. */
const TEMPORAL_STATE: readonly {
    name: string;
    initializer: string;
    binding: PinnedBinding;
}[] = [
    {
        name: "valid",
        initializer: "false",
        binding: { cpp: "task.state.valid", type: "bool" },
    },
    {
        name: "phase",
        initializer: "0",
        binding: { cpp: "task.state.phase", type: "scalar" },
    },
    {
        name: "resetVersion",
        initializer: "-1",
        binding: { cpp: "task.state.reset_version", type: "scalar" },
    },
    {
        name: "historySamples",
        initializer: "0",
        binding: { cpp: "task.state.history_samples", type: "scalar" },
    },
    {
        name: "radius",
        initializer: "0",
        binding: { cpp: "task.state.radius", type: "scalar" },
    },
    {
        name: "intensity",
        initializer: "0",
        binding: { cpp: "task.state.intensity", type: "scalar" },
    },
    {
        name: "tanX",
        initializer: "0",
        binding: { cpp: "task.state.tan_x", type: "scalar" },
    },
    {
        name: "tanY",
        initializer: "0",
        binding: { cpp: "task.state.tan_y", type: "scalar" },
    },
    {
        name: "near",
        initializer: "0",
        binding: { cpp: "task.state.near_plane", type: "scalar" },
    },
    {
        name: "far",
        initializer: "0",
        binding: { cpp: "task.state.far_plane", type: "scalar" },
    },
    {
        name: "quality",
        initializer: "task.quality",
        binding: { cpp: "task.state.quality", type: "string" },
    },
    {
        name: "viewChanged",
        initializer: "true",
        binding: { cpp: "task.state.view_changed", type: "bool" },
    },
];

/**
 * The closure constants of `initializeSsaoTemporal` that read its velocity
 * input, with their initializers; the factory evaluates them for the input
 * generation composed.
 */
const TEMPORAL_VELOCITY_CONSTANTS: readonly (readonly [string, string])[] = [
    [
        "previousDepth",
        "options.velocityHasPreviousDepth === undefined ? false : options.velocityHasPreviousDepth",
    ],
    [
        "halfVelocity",
        'velocity?._descriptor.format === "rg16float" || velocity?._descriptor.format === "rgba16float"',
    ],
];

/** The closure's matrices, each `createIdentityMat4()`. */
const TEMPORAL_MATRICES: readonly (readonly [string, string])[] = [
    ["inverse", "inverse"],
    ["currentView", "current_view"],
    ["previousView", "previous_view"],
    ["previousProjection", "previous_projection"],
    ["previousInverse", "previous_inverse"],
    ["inverseProjection", "inverse_projection"],
    ["previousInverseProjection", "previous_inverse_projection"],
];

/** The `SsaoGpuParameters` members, their native spellings and types. */
const PARAMS_MEMBERS: readonly (readonly [
    string,
    string,
    PinnedBinding["type"],
])[] = [
    ["depthMultiply", "depth_multiply", "scalar"],
    ["depthAdd", "depth_add", "scalar"],
    ["tanX", "tan_x", "scalar"],
    ["tanY", "tan_y", "scalar"],
    ["radius", "radius", "scalar"],
    ["intensity", "intensity", "scalar"],
];

const MATRIX_CALLS = new Set([
    "getProjectionMatrix",
    "getViewMatrix",
    "getViewProjectionMatrix",
]);

function cameraCalls(): Map<string, (args: readonly string[]) => string> {
    return new Map<string, (args: readonly string[]) => string>([
        [
            "getEffectiveAspectRatio",
            (args) => `effective_aspect_ratio(${args.join(", ")})`,
        ],
        [
            "getProjectionMatrix",
            (args) => `build_projection(${args.join(", ")})`,
        ],
        [
            "getViewMatrix",
            (args) => `build_camera_view_matrix(${args.join(", ")})`,
        ],
        [
            "getViewProjectionMatrix",
            (args) => `build_view_projection(${args.join(", ")})`,
        ],
        ["copyMatrix", (args) => `ssao_copy_matrix(${args.join(", ")})`],
        [
            "invertMat4ToRefOrIdentity",
            (args) => `mat4_invert_to_ref_or_identity(${args.join(", ")})`,
        ],
        [
            "mat4Determinant3",
            (args) => `pinned_mat4_determinant3(${args.join(", ")})`,
        ],
        [
            "packMat4IntoF32",
            (args) =>
                `pack_mat4_into_f32(${args[0]}.data(), ${args[1]}, ${args[2]})`,
        ],
        [
            "validateSsaoSettings",
            (args) => `validate_ssao_settings(${args.join(", ")})`,
        ],
        [
            "validateSsaoQuality",
            (args) => `validate_ssao_quality(${args.join(", ")})`,
        ],
        [
            "validateSsaoTemporalSettings",
            (args) => `validate_ssao_temporal_settings(${args.join(", ")})`,
        ],
        [
            "Number.isInteger",
            (args) => `bbl::js::number_is_integer(${args.join(", ")})`,
        ],
        [
            "Number.isSafeInteger",
            (args) => `bbl::js::number_is_safe_integer(${args.join(", ")})`,
        ],
    ]);
}

const BOOL_CALLS = new Map<string, PinnedBinding["type"]>([
    ["Number.isInteger", "bool"],
    ["Number.isSafeInteger", "bool"],
]);

/** The `task._filter = {...}` object `initializeSsaoTemporal` installs. */
function temporalFilter(context: LoweringContext): {
    file: ts.SourceFile;
    initialize: ts.FunctionDeclaration;
    filter: ts.ObjectLiteralExpression;
} {
    const { file, declaration } = context.functionDeclaration(
        SSAO_TEMPORAL_MODULE,
        "initializeSsaoTemporal",
    );
    const assignments = context.findNodes(
        declaration,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            sameSource(node.left, "task._filter") &&
            ts.isObjectLiteralExpression(node.right),
    );
    if (assignments.length !== 1) {
        return context.contractError(
            declaration,
            "Expected initializeSsaoTemporal to install one task._filter.",
        );
    }
    return {
        file,
        initialize: declaration,
        filter: assignments[0]!.right as ts.ObjectLiteralExpression,
    };
}

/** A method of an object literal, by name. */
function objectMethod(
    context: LoweringContext,
    object: ts.ObjectLiteralExpression,
    name: string,
): ts.MethodDeclaration {
    const method = object.properties.find(
        (property): property is ts.MethodDeclaration =>
            ts.isMethodDeclaration(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === name,
    );
    if (!method?.body)
        return context.contractError(
            object,
            `Expected a '${name}' method with a body.`,
        );
    return method;
}

/** The task object literal `createSsaoTask` builds. */
function ssaoTaskObject(context: LoweringContext): {
    file: ts.SourceFile;
    factory: ts.FunctionDeclaration;
    task: ts.ObjectLiteralExpression;
} {
    const { file, declaration } = context.functionDeclaration(
        SSAO_MODULE,
        "createSsaoTask",
    );
    const initializer = context.variableInitializer(declaration.body!, "task");
    const task = context.unwrapExpression(initializer);
    if (!ts.isObjectLiteralExpression(task)) {
        return context.contractError(
            initializer,
            "Expected createSsaoTask to build its task as an object literal.",
        );
    }
    return { file, factory: declaration, task };
}

/** The `task._resolution = {...}` object `enableSsaoHalfResolution` installs. */
function halfAdapter(context: LoweringContext): {
    file: ts.SourceFile;
    adapter: ts.ObjectLiteralExpression;
    enable: ts.FunctionDeclaration;
} {
    const { file, declaration } = context.functionDeclaration(
        SSAO_HALF_MODULE,
        "enableSsaoHalfResolution",
    );
    const assignments = context.findNodes(
        declaration,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            sameSource(node.left, "task._resolution") &&
            ts.isObjectLiteralExpression(node.right),
    );
    if (assignments.length !== 1) {
        return context.contractError(
            declaration,
            "Expected enableSsaoHalfResolution to install one task._resolution.",
        );
    }
    return {
        file,
        adapter: assignments[0]!.right as ts.ObjectLiteralExpression,
        enable: declaration,
    };
}

/** One `let` of a closure, asserted against its initializer. */
function assertClosureLet(
    context: LoweringContext,
    scope: ts.Node,
    name: string,
    initializer: string,
): void {
    const declarations = context.findNodes(
        scope,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === name,
    );
    const declaration = declarations[0];
    if (declarations.length !== 1 || !declaration?.initializer) {
        context.contractError(
            scope,
            `Expected one '${name}' with an initializer.`,
        );
    }
    context.assertExpressionShape(
        declaration.initializer,
        initializer,
        `The pinned '${name}' state`,
    );
}

export class SsaoLowerer {
    public constructor(
        private readonly context: LoweringContext,
        private readonly tasks: readonly SsaoLoweringInput[],
    ) {}

    /** The pass label stem a program deploys under. */
    private static stem(index: number, stage: "compute" | "render"): string {
        return `ssao-${index}.${stage === "compute" ? "comp" : "frag"}`;
    }

    private get provenance(): string {
        return this.context.provenance(SSAO_MODULE, "createSsaoTask");
    }

    /**
     * Every program of every task, deduplicated across tasks by its plan.
     * Each task's composed programs map into this list.
     */
    private programTable(): {
        programs: ComposedSsaoTask["programs"][number][];
        remap: number[][];
    } {
        const programs: ComposedSsaoTask["programs"][number][] = [];
        const keys: string[] = [];
        const remap = this.tasks.map((task) =>
            task.composed.programs.map((program) => {
                const key = JSON.stringify(program);
                const found = keys.indexOf(key);
                if (found >= 0) return found;
                keys.push(key);
                programs.push(program);
                return programs.length - 1;
            }),
        );
        return { programs, remap };
    }

    /** The deployed modules: the pin's own text under each program's stem. */
    public shaderModules(): SsaoShaderModule[] {
        const { programs } = this.programTable();
        return programs.map((program, index) => {
            const stem = SsaoLowerer.stem(index, program.stage);
            const namedConstants = program.constants.map(({ name, value }) => ({
                name,
                value,
            }));
            const data = `// ${this.provenance}\n${program.wgsl}`;
            if (program.stage === "compute") {
                return {
                    output: `upstream/shaders/${stem}.native.wgsl`,
                    data,
                    entryPoint: program.entry,
                    namedConstants,
                };
            }
            return {
                output: `upstream/shaders/${stem}.native.wgsl`,
                data,
                entryPoint: program.entry,
                namedConstants,
                alsoStages: [
                    {
                        stem: `ssao-${index}.vert`,
                        entryPoint: program.vertexEntry!,
                        namedConstants,
                    },
                ],
            };
        });
    }

    /** The generated `ssao_plan.hpp`: programs, samplers and each task's modes. */
    public planHeader(): CppModule {
        const cpp = new CppDefinitions();
        const { programs, remap } = this.programTable();
        const tables: string[] = [];
        const programRows = programs.map((program, index) => {
            const layout = `ssao_layout_${index}`;
            tables.push(
                `inline constexpr std::array<SsaoLayoutInfo, ${program.layout.length}u> ${layout}{{\n` +
                    program.layout
                        .map(
                            (entry) =>
                                `    SsaoLayoutInfo{${entry.binding}u, ${stringLiteral(entry.name)}, ` +
                                `SsaoBindingKind::${BINDING_KINDS[entry.kind]}, ${stringLiteral(entry.storageFormat ?? "")}},`,
                        )
                        .join("\n") +
                    "\n}};",
            );
            const constants = `ssao_constants_${index}`;
            tables.push(
                `inline constexpr std::array<SsaoConstantInfo, ${program.constants.length}u> ${constants}{{\n` +
                    program.constants
                        .map(
                            (constant) =>
                                `    SsaoConstantInfo{${stringLiteral(constant.name)}, ${doubleLiteral(constant.value)}},`,
                        )
                        .join("\n") +
                    "\n}};",
            );
            const targets = `ssao_targets_${index}`;
            tables.push(
                `inline constexpr std::array<std::string_view, ${program.targets.length}u> ${targets}{{\n` +
                    program.targets
                        .map((format) => `    ${stringLiteral(format)},`)
                        .join("\n") +
                    "\n}};",
            );
            const stem = SsaoLowerer.stem(index, program.stage);
            return (
                `    SsaoProgramInfo{${program.stage === "compute"}, ${stringLiteral(stem)}, ` +
                `${stringLiteral(program.stage === "render" ? `ssao-${index}.vert` : "")}, ` +
                `${stringLiteral(program.vertexEntry ?? "")}, ${stringLiteral(program.entry)}, ` +
                `${constants}, ${targets}, ${layout}, ` +
                `${program.workgroup?.[0] ?? 0}u, ${program.workgroup?.[1] ?? 0}u},`
            );
        });
        const samplerRows: string[] = [];
        const samplerKeys: string[] = [];
        const samplerRemap = this.tasks.map((task) =>
            task.composed.samplers.map((sampler) => {
                const key = JSON.stringify(sampler);
                const found = samplerKeys.indexOf(key);
                if (found >= 0) return found;
                samplerKeys.push(key);
                samplerRows.push(
                    `    SsaoSamplerInfo{${sampler.minFilter === "linear"}, ${sampler.magFilter === "linear"}},`,
                );
                return samplerRows.length - 1;
            }),
        );
        const planRows = this.tasks.map((task, taskIndex) => {
            const { composed } = task;
            const blocks = composed.uniforms.map((uniform) => {
                const block = UNIFORM_BLOCKS.get(uniform.label);
                if (!block) {
                    this.context.contractError(
                        this.context.sourceFile(SSAO_GPU_MODULE),
                        `Pinned SSAO writes uniform buffer '${uniform.label}', which no lowered writer fills.`,
                    );
                }
                return { ...uniform, block };
            });
            const textureTable = `ssao_${taskIndex}_textures`;
            tables.push(
                `inline constexpr std::array<SsaoTextureInfo, ${composed.textures.length}u> ${textureTable}{{\n` +
                    composed.textures
                        .map(
                            (texture) =>
                                `    SsaoTextureInfo{${stringLiteral(texture.label)}, ${stringLiteral(texture.format)}, ` +
                                `SsaoExtent::${texture.extent}, ${texture.chain}, ${texture.usage}u},`,
                        )
                        .join("\n") +
                    "\n}};",
            );
            const bufferTable = `ssao_${taskIndex}_buffers`;
            tables.push(
                `inline constexpr std::array<SsaoBufferInfo, ${composed.buffers.length}u> ${bufferTable}{{\n` +
                    composed.buffers
                        .map(
                            (buffer) =>
                                `    SsaoBufferInfo{${stringLiteral(buffer.label)}, ` +
                                (buffer.size.kind === "fixed"
                                    ? `SsaoBufferSize::fixed, ${buffer.size.bytes}u`
                                    : "SsaoBufferSize::motion_cells, 0u") +
                                `, ${buffer.usage}u},`,
                        )
                        .join("\n") +
                    "\n}};",
            );
            const uniforms = `ssao_uniforms_${taskIndex}`;
            tables.push(
                `inline constexpr std::array<SsaoUniformInfo, ${blocks.length}u> ${uniforms}{{\n` +
                    blocks
                        .map(
                            (block) =>
                                `    SsaoUniformInfo{SsaoUniformBlock::${block.block}, ${block.bytes}u},`,
                        )
                        .join("\n") +
                    "\n}};",
            );
            const modes = composed.modes.map((mode, modeIndex) => {
                const prefix = `ssao_${taskIndex}_${modeIndex}`;
                for (const [label, indices] of [
                    ["textures", mode.textures],
                    ["buffers", mode.buffers],
                ] as const) {
                    tables.push(
                        `inline constexpr std::array<std::uint32_t, ${indices.length}u> ${prefix}_${label}{{${indices.map((index) => `${index}u`).join(", ")}}};`,
                    );
                }
                tables.push(
                    `inline constexpr std::array<SsaoViewInfo, ${mode.views.length}u> ${prefix}_views{{\n` +
                        mode.views
                            .map((view) => {
                                const source = (
                                    {
                                        owned: "owned",
                                        "depth-source": "depth",
                                        "normal-source": "normal",
                                        "velocity-source": "velocity",
                                    } as const
                                )[view.texture.kind];
                                const texture =
                                    view.texture.kind === "owned"
                                        ? view.texture.texture
                                        : 0;
                                return (
                                    `    SsaoViewInfo{SsaoTextureSource::${source}, ${texture}u, ${view.baseMip}, ` +
                                    `${view.mipCount ?? 0}u, ${view.relative === true}},`
                                );
                            })
                            .join("\n") +
                        "\n}};",
                );
                const frame = (
                    passes: readonly SsaoPassPlan[],
                    label: string,
                ): string => {
                    const rows = passes.map((pass, passIndex) => {
                        const resources = `${prefix}_${label}_${passIndex}_resources`;
                        tables.push(
                            `inline constexpr std::array<SsaoResourceInfo, ${pass.resources.length}u> ${resources}{{\n` +
                                pass.resources
                                    .map((resource) => {
                                        if (resource.kind === "uniform") {
                                            const block =
                                                blocks[resource.block]!.block;
                                            return `    SsaoResourceInfo{SsaoResourceKind::uniform, static_cast<std::uint16_t>(SsaoUniformBlock::${block})},`;
                                        }
                                        if (resource.kind === "sampler") {
                                            return `    SsaoResourceInfo{SsaoResourceKind::sampler, ${samplerRemap[taskIndex]![resource.sampler]}u},`;
                                        }
                                        if (resource.kind === "buffer") {
                                            return `    SsaoResourceInfo{SsaoResourceKind::buffer, ${resource.buffer}u},`;
                                        }
                                        return `    SsaoResourceInfo{SsaoResourceKind::view, ${resource.view}u},`;
                                    })
                                    .join("\n") +
                                "\n}};",
                        );
                        const attachments = `${prefix}_${label}_${passIndex}_attachments`;
                        tables.push(
                            `inline constexpr std::array<SsaoAttachmentInfo, ${pass.attachments.length}u> ${attachments}{{\n` +
                                pass.attachments
                                    .map(
                                        (attachment) =>
                                            `    SsaoAttachmentInfo{${attachment.view}u, {${attachment.clear.map((value) => doubleLiteral(value)).join(", ")}}},`,
                                    )
                                    .join("\n") +
                                "\n}};",
                        );
                        const program =
                            pass.program === undefined
                                ? 0
                                : remap[taskIndex]![pass.program]!;
                        return (
                            `    SsaoPassInfo{${stringLiteral(pass.label)}, SsaoPassStage::${pass.stage.replace("-", "_")}, ${program}u, ` +
                            `${resources}, ${pass.domain ?? -1}, ${pass.buffer ?? -1}, ${attachments}, ${pass.repeat?.texture ?? -1}, ${pass.continues === true}},`
                        );
                    });
                    tables.push(
                        `inline constexpr std::array<SsaoPassInfo, ${passes.length}u> ${prefix}_${label}{{\n${rows.join("\n")}\n}};`,
                    );
                    return `${prefix}_${label}`;
                };
                const first = frame(mode.frames[0], "frame0");
                const second = frame(mode.frames[1], "frame1");
                const disabled = frame(mode.disabled, "disabled");
                const { key } = mode;
                return (
                    `    SsaoModeInfo{${mode.resolution === "half"}, SsaoModeKeyInfo{${stringLiteral(key.quality)}, ${key.normal}, ${key.temporal}, ${key.pruning}}, ` +
                    `${prefix}_textures, ${prefix}_buffers, ${mode.output}u, ${prefix}_views, ` +
                    `{${first}, ${second}}, ${disabled}, ${mode.samplingFootprint === undefined ? "std::nullopt" : doubleLiteral(mode.samplingFootprint)}},`
                );
            });
            const modeTable = `ssao_modes_${taskIndex}`;
            tables.push(
                `inline constexpr std::array<SsaoModeInfo, ${modes.length}u> ${modeTable}{{\n${modes.join("\n")}\n}};`,
            );
            return `    SsaoPlanInfo{${uniforms}, ${textureTable}, ${bufferTable}, ${modeTable}},`;
        });
        return cpp.finish(`// ${this.provenance}
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string_view>

namespace bbl::upstream {

/** Where an owned texture's extent comes from: its source, half of it rounded up, one texel. */
enum class SsaoExtent : std::uint8_t { source, half, unit };

/** One texture the task owns, as the pin created it. */
struct SsaoTextureInfo {
    std::string_view label;
    std::string_view format;
    SsaoExtent extent;
    /** The pin's AO chain, \`min(5, floor(log2(max(w, h))) + 1)\` levels; one otherwise. */
    bool chain;
    /** The pin's \`GPUTextureUsage\` bits. */
    std::uint32_t usage;
};

enum class SsaoTextureSource : std::uint8_t { owned, depth, normal, velocity };

/** How a storage buffer the task owns is sized. */
enum class SsaoBufferSize : std::uint8_t {
    fixed,
    /** \`ssaoMotionMaskCellCount(width, height) * 16\` over the working extent. */
    motion_cells,
};

/** One storage buffer the task owns, as the pin created it. */
struct SsaoBufferInfo {
    std::string_view label;
    SsaoBufferSize size;
    /** A fixed buffer's bytes. */
    std::uint32_t bytes;
    /** The pin's \`GPUBufferUsage\` bits. */
    std::uint32_t usage;
};

/** One view a pass binds or draws into. */
struct SsaoViewInfo {
    SsaoTextureSource source;
    /** The task-level texture an owned view names. */
    std::uint32_t texture;
    /** Relative to the pass's chain level when \`relative\`. */
    std::int32_t base_mip;
    /** Zero views every level from \`base_mip\`. */
    std::uint32_t mip_count;
    bool relative;
};

enum class SsaoBindingKind : std::uint8_t {
    uniform,
    depth_texture,
    float_texture,
    unfilterable_texture,
    uint_texture,
    storage_texture,
    storage_buffer,
    read_only_storage_buffer,
    filtering_sampler,
    non_filtering_sampler,
};

/** One group-0 layout entry and the identifier the module declares there. */
struct SsaoLayoutInfo {
    std::uint32_t binding;
    std::string_view name;
    SsaoBindingKind kind;
    std::string_view storage_format;
};

/** A pipeline-overridable constant, by its name. */
struct SsaoConstantInfo {
    std::string_view name;
    double value;
};

/** One compute or fullscreen render program the pin built. */
struct SsaoProgramInfo {
    bool compute;
    /** The compute or fragment stage's deployed stem. */
    std::string_view stem;
    std::string_view vertex_stem;
    std::string_view vertex_entry;
    std::string_view entry;
    std::span<const SsaoConstantInfo> constants;
    std::span<const std::string_view> targets;
    std::span<const SsaoLayoutInfo> layout;
    std::uint32_t workgroup_x;
    std::uint32_t workgroup_y;
};

/** The decision block a uniform buffer the pin writes is filled from. */
enum class SsaoUniformBlock : std::uint16_t { params, full_params, temporal };

struct SsaoUniformInfo {
    SsaoUniformBlock block;
    std::uint32_t bytes;
};

struct SsaoSamplerInfo {
    bool min_linear;
    bool mag_linear;
};

enum class SsaoResourceKind : std::uint8_t { uniform, view, sampler, buffer };

/** What one layout entry of a pass binds: a uniform block, a view, a sampler or a buffer. */
struct SsaoResourceInfo {
    SsaoResourceKind kind;
    std::uint16_t index;
};

struct SsaoAttachmentInfo {
    std::uint32_t view;
    std::array<double, 4> clear;
};

enum class SsaoPassStage : std::uint8_t { compute, render, clear, clear_buffer };

/** One pass, in the pin's encoding order. */
struct SsaoPassInfo {
    std::string_view label;
    SsaoPassStage stage;
    std::uint32_t program;
    /** One per layout entry of the program, in layout order. */
    std::span<const SsaoResourceInfo> resources;
    /**
     * The layout entry whose storage view's extent a dispatch covers; -1 for
     * a dispatch covering the working extent, and for every other stage.
     */
    std::int32_t domain;
    /** A buffer clear's buffer, or the buffer a draw reads its arguments from; -1 for none. */
    std::int32_t buffer;
    std::span<const SsaoAttachmentInfo> attachments;
    /** Repeated for levels 1..levels-1 of this owned chain; -1 runs once. */
    std::int32_t repeat_texture;
    /**
     * A dispatch the pin encodes in the compute pass of the one before it;
     * a repeated dispatch's levels share one pass. GPU task timing counts
     * the pin's passes.
     */
    bool continues;
};

/** The live settings a mode was composed for. */
struct SsaoModeKeyInfo {
    std::string_view quality;
    bool normal;
    bool temporal;
    /** Motion pruning's transport extension is installed. */
    bool pruning;
};

/** One working mode: its textures, its output and the passes of both history parities. */
struct SsaoModeInfo {
    bool half;
    SsaoModeKeyInfo key;
    /** The task-level textures and buffers the mode uses. */
    std::span<const std::uint32_t> textures;
    std::span<const std::uint32_t> buffers;
    /** The task-level texture published as \`outputTexture\`. */
    std::uint32_t output;
    std::span<const SsaoViewInfo> views;
    std::array<std::span<const SsaoPassInfo>, 2> frames;
    /** The frame a disabled task encodes: its output cleared to the AO identity. */
    std::span<const SsaoPassInfo> disabled;
    /** \`SsaoGpu.samplingFootprint\`, set by a working-resolution adapter. */
    std::optional<double> sampling_footprint;
};

struct SsaoPlanInfo {
    std::span<const SsaoUniformInfo> uniforms;
    /** Every texture and buffer a mode owns; a mode switch keeps the ones both use. */
    std::span<const SsaoTextureInfo> textures;
    std::span<const SsaoBufferInfo> buffers;
    /** Full modes first, then half modes when the adapter is reached. */
    std::span<const SsaoModeInfo> modes;
};

${cpp.privateCode(tables.join("\n"))}

${cpp.table("SsaoProgramInfo", "ssao_program_infos", programs.length, programRows.join("\n"))}

${cpp.table("SsaoSamplerInfo", "ssao_sampler_infos", samplerRows.length, samplerRows.join("\n"))}

${cpp.table("SsaoPlanInfo", "ssao_plan_infos", planRows.length, planRows.join("\n"))}

} // namespace bbl::upstream
`);
    }

    public lowerTaskRecords(): LoweredSource {
        return {
            modulePath: SSAO_MODULE,
            symbolName: "createSsaoTask",
            header: this.header(),
            source: this.source(),
        };
    }

    private header(): string {
        const factories = this.tasks
            .map((task) => `${this.factorySignature(task.manifest.taskIndex)};`)
            .join("\n");
        return `// ${this.provenance}
#pragma once

#include <bblite/runtime.hpp>
#include <bblite/ssao_task.hpp>

#include <cstdint>
#include <optional>

namespace bbl::upstream {

/** \`resetSsaoTemporal\`, lowered from its own body. */
void reset_ssao_temporal(SsaoTemporalSettings& settings);

/** The half-resolution adapter's activation for a source extent; whether Half is active. */
bool ssao_prepare_resolution(SsaoTaskOptions& task, std::uint32_t width, std::uint32_t height);

/** \`ssaoMotionMaskCellCount\`: the 4-word cells of the motion-mask pyramid over an extent. */
double ssao_motion_mask_cell_count(double width, double height);

/** One frame of the task's \`execute\`, with the backend's answers for its GPU state. */
SsaoFrameDecision ssao_frame(Engine& engine, SsaoTaskOptions& task, const SsaoFrameInputs& inputs);

/** The task's \`record\` (\`buildFrameGraphTask\`): its settings' validation and working resolution. */
void ssao_task_record(SsaoTaskOptions& task);

${factories}

} // namespace bbl::upstream
`;
    }

    private factorySignature(taskIndex: number): string {
        return (
            `TaskHandle create_ssao_task_${taskIndex}(\n` +
            `    Engine& engine,\n` +
            `    RenderTextureRef depth,\n` +
            `    std::optional<RenderTextureRef> normal,\n` +
            `    CameraHandle camera,\n` +
            `    std::optional<RenderTextureRef> velocity,\n` +
            `    std::optional<double> history_samples)`
        );
    }

    private source(): string {
        const context = this.context;
        const calls = cameraCalls();
        return `// ${this.provenance}
#include <bblite/upstream/frame_graph_ssao.hpp>

#include <bblite/js_data.hpp>
#include <bblite/upstream/camera_math.hpp>
#include <bblite/upstream/pinned_matrix.hpp>
#include <bblite/upstream/renderer_plan.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

namespace bbl::upstream {

namespace {

/** \`SsaoGpuParameters\`: the frame's parameters, explicit data as the pin keeps them. */
struct SsaoGpuParameters {
    double depth_multiply = 0.0;
    double depth_add = 0.0;
    double tan_x = 0.0;
    double tan_y = 0.0;
    double radius = 0.0;
    double intensity = 0.0;
    bool has_view = false;
    std::array<float, 16> view{};
    std::optional<double> phase{};
    std::string quality;
};

${lowerPackMat4IntoF32FastPathCpp(context)}

${lowerInvertMat4ToRefOrIdentityCpp(context, calls)}

${lowerMat4Determinant3(context, calls)}

${this.copyMatrix()}

${this.validateQuality()}

${this.validateSettings()}

${this.validateTemporalSettings()}

${this.writeParameters()}

${this.temporalReset()}

${this.temporalPrepare()}

${this.temporalExecute()}

} // namespace

${this.resetTemporal()}

${this.prepareResolution()}

${this.motionMaskCellCount()}

${this.frame()}

${this.taskRecord()}

${this.sharedFactory()}

${this.tasks.map((task) => this.taskFactory(task)).join("\n\n")}

} // namespace bbl::upstream
`;
    }

    private copyMatrix(): string {
        return lowerPinnedFunction(
            this.context,
            SSAO_TEMPORAL_MODULE,
            "copyMatrix",
            [
                {
                    pinned: "target",
                    kind: "mat4",
                    annotation: "Mat4",
                    cpp: "target",
                },
                { pinned: "source", kind: "mat4Const", cpp: "source" },
            ],
            {
                cppName: "ssao_copy_matrix",
                returns: "void",
                localStorage: [
                    {
                        pinned: "storage",
                        initializer: "target as unknown as Mat4Storage",
                        binding: { cpp: "target", type: "f32", mutable: true },
                    },
                ],
                calls: new Map(),
            },
        );
    }

    private validateQuality(): string {
        return lowerPinnedFunction(
            this.context,
            SSAO_GPU_MODULE,
            "validateSsaoQuality",
            [
                {
                    pinned: "quality",
                    kind: "record",
                    annotation: "SsaoQuality",
                    cpp: "quality",
                    cppType: "std::string",
                    binding: { cpp: "quality", type: "string" },
                },
            ],
            {
                cppName: "validate_ssao_quality",
                returns: "void",
                calls: new Map(),
            },
        );
    }

    private validateSettings(): string {
        return lowerPinnedFunction(
            this.context,
            SSAO_MODULE,
            "validateSsaoSettings",
            [
                { pinned: "radius", kind: "number", cpp: "radius" },
                { pinned: "intensity", kind: "number", cpp: "intensity" },
                {
                    pinned: "quality",
                    kind: "record",
                    annotation: "SsaoQuality",
                    cpp: "quality",
                    cppType: "std::string",
                    binding: { cpp: "quality", type: "string" },
                },
            ],
            {
                cppName: "validate_ssao_settings",
                returns: "void",
                calls: cameraCalls(),
            },
        );
    }

    /** The temporal settings record read as `owner`, held natively as `cpp`. */
    private settingsBindings(
        owner: string,
        cpp = owner,
    ): Map<string, PinnedBinding> {
        return new Map<string, PinnedBinding>([
            [`${owner}.enabled`, { cpp: `${cpp}.enabled`, type: "bool" }],
            [
                `${owner}.historySamples`,
                { cpp: `${cpp}.history_samples`, type: "scalar" },
            ],
            [
                `${owner}.resetVersion`,
                { cpp: `${cpp}.reset_version`, type: "scalar" },
            ],
        ]);
    }

    private validateTemporalSettings(): string {
        return lowerPinnedFunction(
            this.context,
            SSAO_TEMPORAL_MODULE,
            "validateSsaoTemporalSettings",
            [
                {
                    pinned: "settings",
                    kind: "record",
                    annotation: "SsaoTemporalSettings",
                    cpp: "settings",
                    cppType: "SsaoTemporalSettings",
                },
            ],
            {
                cppName: "validate_ssao_temporal_settings",
                returns: "void",
                calls: cameraCalls(),
                callShapes: BOOL_CALLS,
                memberBindings: this.settingsBindings("settings"),
            },
        );
    }

    private resetTemporal(): string {
        return lowerPinnedFunction(
            this.context,
            SSAO_TEMPORAL_MODULE,
            "resetSsaoTemporal",
            [
                {
                    pinned: "settings",
                    kind: "record",
                    annotation: "SsaoTemporalSettings",
                    cpp: "settings",
                    cppType: "SsaoTemporalSettings",
                    mutableRecord: true,
                },
            ],
            {
                cppName: "reset_ssao_temporal",
                returns: "void",
                calls: cameraCalls(),
                callShapes: BOOL_CALLS,
                memberBindings: new Map([
                    ...this.settingsBindings("settings"),
                    [
                        "Number.MAX_SAFE_INTEGER",
                        { cpp: "9007199254740991.0", type: "scalar" },
                    ],
                ]),
            },
        );
    }

    /** `writeSsaoGpuParameters`, over the decision block it fills. */
    private writeParameters(): string {
        const memberBindings = new Map<string, PinnedBinding>([
            ["gpu.data", { cpp: "data", type: "f32", mutable: true }],
            [
                "gpu.integers",
                {
                    cpp: "data",
                    type: "u32",
                    indexedStore: (_owner, index, value) =>
                        `data[static_cast<std::size_t>(${index})] = std::bit_cast<float>(bbl::js::to_uint32(${value}))`,
                },
            ],
            ["gpu.width", { cpp: "width", type: "scalar" }],
            ["gpu.height", { cpp: "height", type: "scalar" }],
            [
                "gpu.samplingFootprint",
                {
                    cpp: "*sampling_footprint",
                    type: "scalar",
                    nullish: "!sampling_footprint.has_value()",
                },
            ],
            ...PARAMS_MEMBERS.map(
                ([pinned, native, type]) =>
                    [
                        `params.${pinned}`,
                        { cpp: `params.${native}`, type },
                    ] as const,
            ),
            [
                "params.view",
                {
                    cpp: "params.view",
                    type: "f32",
                    absentCpp: "!params.has_view",
                },
            ],
            [
                "params.phase",
                {
                    cpp: "*params.phase",
                    type: "scalar",
                    nullish: "!params.phase.has_value()",
                },
            ],
        ]);
        return lowerPinnedFunction(
            this.context,
            SSAO_GPU_MODULE,
            "writeSsaoGpuParameters",
            [
                {
                    pinned: "gpu",
                    kind: "record",
                    annotation:
                        'Pick<SsaoGpu, "device" | "width" | "height" | "uniform" | "data" | "integers" | "samplingFootprint">',
                    cpp: "gpu",
                    specialized: true,
                    binding: { cpp: "gpu", type: "opaque" },
                },
                {
                    pinned: "params",
                    kind: "record",
                    annotation: "SsaoGpuParameters",
                    cpp: "params",
                    cppType: "SsaoGpuParameters",
                },
            ],
            {
                cppName: "write_ssao_gpu_parameters",
                returns: "void",
                leadingParameters: [
                    "std::array<float, 44>& data",
                    "double width",
                    "double height",
                    "std::optional<double> sampling_footprint",
                ],
                calls: new Map(),
                memberBindings,
                methods: new Map([
                    [
                        "fill",
                        (receiver, args) =>
                            `${receiver}.fill(static_cast<float>(${args[0]}))`,
                    ],
                ]),
                statement: (statement, _lowerer, indent) => {
                    if (
                        ts.isExpressionStatement(statement) &&
                        sameSource(
                            statement.expression,
                            "gpu.device.queue.writeBuffer(gpu.uniform, 0, data)",
                        )
                    ) {
                        // The block is the decision's; the backend uploads it.
                        return [
                            `${indent}// queue.writeBuffer(uniform, 0, data): the decision's block.`,
                        ];
                    }
                    return undefined;
                },
            },
        );
    }

    /** The temporal filter's bindings: its closure, the task, the frame's inputs. */
    private temporalBindings(): Map<string, PinnedBinding> {
        const bindings = new Map<string, PinnedBinding>([
            ["settings", { cpp: "task.temporal", type: "opaque" }],
            ...this.settingsBindings("settings", "task.temporal"),
            [
                "settings._prepareGpu",
                { cpp: "", type: "opaque", staticallyAbsent: true },
            ],
            ["task.radius", { cpp: "task.radius", type: "scalar" }],
            ["task.intensity", { cpp: "task.intensity", type: "scalar" }],
            ["task.quality", { cpp: "task.quality", type: "string" }],
            ["task.camera", { cpp: "camera", type: "opaque" }],
            [
                "task.camera.nearPlane",
                { cpp: "camera.near_plane", type: "scalar" },
            ],
            [
                "task.camera.farPlane",
                { cpp: "camera.far_plane", type: "scalar" },
            ],
            [
                "task.engine.useFloatingOrigin",
                { cpp: "false", type: "bool", staticBoolean: false },
            ],
            ["disposed", { cpp: "false", type: "bool", staticBoolean: false }],
            [
                "velocity",
                {
                    cpp: "task.velocity",
                    type: "opaque",
                    absentCpp: "!task.velocity.has_value()",
                },
            ],
            // A geometry attachment is built once its producer recorded: an
            // unbuilt one has no extent.
            [
                "velocity._colorView",
                {
                    cpp: "inputs.velocity_width",
                    type: "opaque",
                    absentCpp: "inputs.velocity_width == 0u",
                },
            ],
            [
                "velocity._width",
                {
                    cpp: "static_cast<double>(inputs.velocity_width)",
                    type: "scalar",
                },
            ],
            [
                "velocity._height",
                {
                    cpp: "static_cast<double>(inputs.velocity_height)",
                    type: "scalar",
                },
            ],
            [
                "previousDepth",
                { cpp: "task.velocity_previous_depth", type: "bool" },
            ],
            ["halfVelocity", { cpp: "task.velocity_half", type: "bool" }],
            [
                "owner",
                {
                    cpp: "task.state.owner",
                    type: "opaque",
                    absentCpp: "!task.state.owner.present",
                },
            ],
            [
                "owner.owner",
                {
                    cpp: "static_cast<double>(task.state.owner.owner)",
                    type: "scalar",
                },
            ],
            [
                "owner.sourceDepth",
                {
                    cpp: "static_cast<double>(task.state.owner.source_depth)",
                    type: "scalar",
                },
            ],
            [
                "owner.sourceNormal",
                {
                    cpp: "static_cast<double>(task.state.owner.source_normal)",
                    type: "scalar",
                },
            ],
            [
                "owner.data",
                { cpp: "task.state.owner.data", type: "f32", mutable: true },
            ],
            ["gpu", { cpp: "static_cast<double>(inputs.gpu)", type: "scalar" }],
            [
                "gpu.sourceDepth",
                {
                    cpp: "static_cast<double>(inputs.source_depth)",
                    type: "scalar",
                },
            ],
            [
                "gpu.sourceNormal",
                {
                    cpp: "static_cast<double>(inputs.source_normal)",
                    type: "scalar",
                },
            ],
            ["params.tanX", { cpp: "params.tan_x", type: "scalar" }],
            ["params.tanY", { cpp: "params.tan_y", type: "scalar" }],
            ["params.phase", { cpp: "params.phase", type: "scalar" }],
            ["params.view", { cpp: "params.view", type: "f32" }],
        ]);
        for (const { name, binding } of TEMPORAL_STATE)
            bindings.set(name, binding);
        for (const [name, native] of TEMPORAL_MATRICES) {
            bindings.set(name, {
                cpp: `task.state.${native}`,
                type: "f32",
                mutable: true,
            });
        }
        return bindings;
    }

    private assertTemporalClosure(initialize: ts.FunctionDeclaration): void {
        for (const { name, initializer } of TEMPORAL_STATE) {
            assertClosureLet(this.context, initialize, name, initializer);
        }
        // The velocity contract the factory evaluates (`temporalVelocity`).
        for (const [name, initializer] of TEMPORAL_VELOCITY_CONSTANTS)
            assertClosureLet(this.context, initialize, name, initializer);
        for (const [name] of TEMPORAL_MATRICES) {
            assertClosureLet(
                this.context,
                initialize,
                name,
                "createIdentityMat4()",
            );
        }
        assertClosureLet(this.context, initialize, "owner", "null");
    }

    /** The `reset` arrow the filter installs and every reset site calls. */
    private temporalReset(): string {
        const { file, initialize } = temporalFilter(this.context);
        const reset = this.context.unwrapExpression(
            this.context.variableInitializer(initialize.body!, "reset"),
        );
        if (!ts.isArrowFunction(reset) || !ts.isBlock(reset.body)) {
            return this.context.contractError(
                reset,
                "Expected the temporal reset to be a block-bodied arrow.",
            );
        }
        const body = lowerPinnedBody(file, reset.body.statements, {
            bindings: this.temporalBindings(),
            calls: new Map(),
        });
        return `// ${this.context.provenance(SSAO_TEMPORAL_MODULE, "initializeSsaoTemporal", "its reset")}
void ssao_temporal_reset(SsaoTaskOptions& task) {
${body}
}`;
    }

    /**
     * The statements of the filter's `prepare` and `execute` that create,
     * bind or encode, answered through the frame's inputs and decision.
     */
    private temporalStatement(
        statement: ts.Statement,
        lowerer: PinnedNumericLowerer,
        indent: string,
    ): readonly string[] | undefined {
        const context = this.context;
        if (ts.isExpressionStatement(statement)) {
            const expression = context.unwrapExpression(statement.expression);
            if (sameSource(expression, "disposeXegtaoTemporalGpu(owner)")) {
                return [`${indent}task.state.owner.present = false;`];
            }
            if (sameSource(expression, "owner = null")) {
                return [`${indent}task.state.owner = SsaoTemporalOwner{};`];
            }
            if (
                sameSource(
                    expression,
                    "owner = createXegtaoTemporalGpu(gpu, velocityView, !!velocity, previousDepth)",
                )
            ) {
                // The owner binds its sources at creation (`bindXegtaoTemporalGpu`).
                return [
                    `${indent}task.state.owner = SsaoTemporalOwner{};`,
                    `${indent}task.state.owner.present = true;`,
                    `${indent}task.state.owner.owner = inputs.gpu;`,
                    `${indent}task.state.owner.source_depth = inputs.source_depth;`,
                    `${indent}task.state.owner.source_normal = inputs.source_normal;`,
                    `${indent}task.state.owner.source_velocity = inputs.source_velocity;`,
                ];
            }
            if (
                sameSource(
                    expression,
                    "bindXegtaoTemporalGpu(owner, velocityView)",
                ) ||
                sameSource(
                    expression,
                    "bindXegtaoTemporalGpu(owner, owner.velocity)",
                )
            ) {
                const velocity = sameSource(
                    expression,
                    "bindXegtaoTemporalGpu(owner, velocityView)",
                )
                    ? [
                          `${indent}task.state.owner.source_velocity = inputs.source_velocity;`,
                      ]
                    : [];
                return [
                    `${indent}task.state.owner.source_depth = inputs.source_depth;`,
                    `${indent}task.state.owner.source_normal = inputs.source_normal;`,
                    ...velocity,
                ];
            }
            if (
                sameSource(
                    expression,
                    "settings._prepareGpu?.(owner, velocityView)",
                ) ||
                sameSource(
                    expression,
                    "settings._prepareGpu?.(owner, owner.velocity)",
                ) ||
                sameSource(
                    expression,
                    "gpu.resolveGroup = owner.scratchResolve",
                ) ||
                sameSource(expression, "gpu.resolveGroup = owner.baseResolve")
            ) {
                // Motion pruning's extension and the resolve group that runs
                // are the plan mode's: the backend selects it from the same
                // settings (`plan_ssao_frame`), which nothing between the
                // frame's start and these statements writes.
                return [];
            }
            if (
                sameSource(
                    expression,
                    "executeXegtaoTemporalGpu(owner!, encoder)",
                )
            ) {
                this.assertTemporalExecute();
                return [
                    `${indent}decision.history_index = task.state.owner.index;`,
                    `${indent}decision.temporal = task.state.owner.data;`,
                    `${indent}task.state.owner.index = 1u - task.state.owner.index;`,
                ];
            }
            if (
                sameSource(expression, "params.phase = 0") ||
                sameSource(expression, "params.phase = phase")
            ) {
                return [
                    `${indent}params.phase = ${sameSource(expression, "params.phase = 0") ? "0.0" : "task.state.phase"};`,
                ];
            }
        }
        if (
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.length === 1
        ) {
            const declaration = statement.declarationList.declarations[0]!;
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
                return undefined;
            const name = declaration.name.text;
            const initializer = declaration.initializer;
            if (name === "width" || name === "height") {
                context.assertExpressionShape(
                    initializer,
                    `gpu.outputTexture?.${name} ?? gpu.${name}`,
                    "The temporal output extent",
                );
                lowerer.bindLocal(declaration.name, {
                    cpp: name,
                    type: "scalar",
                });
                return [
                    `${indent}const double ${name} = static_cast<double>(inputs.output_${name});`,
                ];
            }
            if (name === "velocityView") {
                context.assertExpressionShape(
                    initializer,
                    "velocity ? (gpu.sourceVelocity ?? velocity._colorView) : null",
                    "The temporal velocity view",
                );
                // The backend numbers the view the owner binds: the half
                // adapter's reduced copy, else the source's own.
                lowerer.bindLocal(declaration.name, {
                    cpp: "static_cast<double>(inputs.source_velocity)",
                    type: "scalar",
                });
                return [];
            }
            if (name === "view") {
                context.assertExpressionShape(
                    initializer,
                    "params.view!",
                    "The temporal view",
                );
                lowerer.bindLocal(declaration.name, {
                    cpp: "params.view",
                    type: "f32",
                });
                return [];
            }
            if (name === "data") {
                context.assertExpressionShape(
                    initializer,
                    "owner.data",
                    "The temporal block",
                );
                lowerer.bindLocal(declaration.name, {
                    cpp: "task.state.owner.data",
                    type: "f32",
                    mutable: true,
                });
                return [];
            }
        }
        return undefined;
    }

    /** `executeXegtaoTemporalGpu`: one upload of its block, the stages of its index, the flip. */
    private assertTemporalExecute(): void {
        const { declaration } = this.context.functionDeclaration(
            SSAO_XEGTAO_GPU_MODULE,
            "executeXegtaoTemporalGpu",
        );
        this.context.assertStatementShapes(
            declaration,
            declaration.body!.statements,
            "state.owner.device.queue.writeBuffer(state.uniform, 0, state.data); " +
                "state.transportExtension?.execute(encoder); " +
                "for (const stage of state.stages[state.index]!) { const pass = encoder.beginRenderPass(stage.pass); " +
                "pass.setPipeline(stage.pipeline); pass.setBindGroup(0, stage.group); " +
                "if (stage.indirect) { pass.drawIndirect(stage.indirect, 0); } else { pass.draw(3); } pass.end(); } " +
                "state.index = 1 - state.index;",
            "The temporal encoder",
        );
    }

    private temporalScope(): Omit<PinnedNumericScope, "returnValue"> {
        return {
            bindings: this.temporalBindings(),
            calls: new Map([
                ...cameraCalls(),
                ["reset", () => "ssao_temporal_reset(task)"],
            ]),
            callShapes: BOOL_CALLS,
            matrixCalls: MATRIX_CALLS,
            expression: (expression) => {
                if (sameSource(expression, "owner.velocity !== velocityView"))
                    return "(task.state.owner.source_velocity != inputs.source_velocity)";
                if (
                    sameSource(
                        expression,
                        "!!owner.sourceNormal !== !!gpu.sourceNormal",
                    )
                ) {
                    return "((task.state.owner.source_normal != 0u) != (inputs.source_normal != 0u))";
                }
                if (sameSource(expression, "owner?.owner === gpu")) {
                    return "(task.state.owner.present && task.state.owner.owner == inputs.gpu)";
                }
                for (const extent of ["width", "height"] as const) {
                    if (
                        sameSource(
                            expression,
                            `gpu.outputTexture?.${extent} ?? gpu.${extent}`,
                        )
                    ) {
                        return `static_cast<double>(inputs.output_${extent})`;
                    }
                }
                return undefined;
            },
            statement: (statement, lowerer, indent) =>
                this.temporalStatement(statement, lowerer, indent),
        };
    }

    private temporalPrepare(): string {
        const { file, initialize, filter } = temporalFilter(this.context);
        this.assertTemporalClosure(initialize);
        const prepare = objectMethod(this.context, filter, "prepare");
        const body = lowerPinnedBody(file, prepare.body!.statements, {
            ...this.temporalScope(),
            returnValue: () => "",
        });
        return `// ${this.context.provenance(SSAO_TEMPORAL_MODULE, "initializeSsaoTemporal", "its filter's prepare")}
void ssao_temporal_prepare(SsaoTaskOptions& task, const CameraRecord& camera, const SsaoFrameInputs& inputs, SsaoGpuParameters& params) {
${body}
}`;
    }

    private temporalExecute(): string {
        const { file, filter } = temporalFilter(this.context);
        const execute = objectMethod(this.context, filter, "execute");
        const body = lowerPinnedBody(file, execute.body!.statements, {
            ...this.temporalScope(),
            returnValue: () => "",
        });
        return `// ${this.context.provenance(SSAO_TEMPORAL_MODULE, "initializeSsaoTemporal", "its filter's execute")}
void ssao_temporal_execute(SsaoTaskOptions& task, const CameraRecord& camera, const SsaoFrameInputs& inputs, SsaoFrameDecision& decision) {
${body}
}`;
    }

    private motionMaskCellCount(): string {
        return lowerPinnedFunction(
            this.context,
            SSAO_MOTION_MASK_MODULE,
            "ssaoMotionMaskCellCount",
            [
                { pinned: "width", kind: "number", cpp: "width" },
                { pinned: "height", kind: "number", cpp: "height" },
            ],
            {
                cppName: "ssao_motion_mask_cell_count",
                returns: "double",
                calls: new Map(),
            },
        );
    }

    /**
     * The half-resolution adapter's activation: its first two statements,
     * which set `settings.active` and reset history when it changed. The
     * rest of its `prepare` allocates, which the backend does from the plan
     * and reports through `SsaoFrameInputs`.
     */
    private prepareResolution(): string {
        const { file, adapter, enable } = halfAdapter(this.context);
        assertClosureLet(this.context, enable, "active", "false");
        const prepare = objectMethod(this.context, adapter, "prepare");
        const [activation, change] = prepare.body!.statements;
        this.context.assertStatementShapes(
            prepare,
            [activation!, change!],
            "settings.active = settings.enabled && width >= 320 && height >= 224; " +
                "if (active !== settings.active) { task._filter?.reset(); active = settings.active; }",
            "The half-resolution activation",
        );
        this.assertResolutionResets(prepare);
        const body = lowerPinnedBody(file, [activation!, change!], {
            bindings: new Map<string, PinnedBinding>([
                ["settings.active", { cpp: "half.active", type: "bool" }],
                ["settings.enabled", { cpp: "half.enabled", type: "bool" }],
                ["active", { cpp: "task.state.half_active", type: "bool" }],
                [
                    "width",
                    { cpp: "static_cast<double>(width)", type: "scalar" },
                ],
                [
                    "height",
                    { cpp: "static_cast<double>(height)", type: "scalar" },
                ],
            ]),
            calls: new Map([
                ["task._filter?.reset", () => "ssao_temporal_reset(task)"],
            ]),
            statement: (statement, _lowerer, indent) =>
                ts.isExpressionStatement(statement) &&
                sameSource(statement.expression, "task._filter?.reset()")
                    ? [`${indent}ssao_temporal_reset(task);`]
                    : undefined,
        });
        return `// ${this.context.provenance(SSAO_HALF_MODULE, "enableSsaoHalfResolution", "its adapter's activation")}
bool ssao_prepare_resolution(SsaoTaskOptions& task, std::uint32_t width, std::uint32_t height) {
    if (!task.half) {
        return false;
    }
    SsaoHalfResolutionSettings& half = *task.half;
${body}
    return half.active;
}`;
    }

    /**
     * The adapter resets history when it creates its pipeline and when a
     * rebind changed its sources: the two inputs the backend answers.
     */
    private assertResolutionResets(prepare: ts.MethodDeclaration): void {
        const resets = this.context.findNodes(
            prepare,
            (node): node is ts.IfStatement =>
                ts.isIfStatement(node) &&
                this.context.hasNode(
                    node.thenStatement,
                    (inner) =>
                        ts.isCallExpression(inner) &&
                        sameSource(inner, "task._filter?.reset()"),
                ),
        );
        const tests = resets.map((statement) =>
            statement.expression.getText(statement.getSourceFile()),
        );
        const created = resets.some((statement) =>
            this.context.hasNode(
                statement.thenStatement,
                (node) =>
                    ts.isCallExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "createPipeline",
            ),
        );
        const rebound = resets.some((statement) =>
            sameSource(
                statement.expression,
                "bindPipeline(state, depth, normal, velocity?._colorView ?? null)",
            ),
        );
        if (!created || !rebound || resets.length !== 3) {
            this.context.contractError(
                prepare,
                `Expected the adapter to reset history on activation, pipeline creation and a source rebind; found [${tests.join("; ")}].`,
            );
        }
    }

    /** `before`: the full-size block, then the reduced owner's passes. */
    private assertResolutionBefore(): void {
        const { adapter } = halfAdapter(this.context);
        const before = objectMethod(this.context, adapter, "before");
        this.context.assertStatementShapes(
            before,
            before.body!.statements,
            "if (!state) { return false; } " +
                'const pass = encoder.beginComputePass({ label: "ssao-half-pipeline-prepare" }); ' +
                "pass.setPipeline(state.prepare); pass.setBindGroup(0, state.prepareGroup!); " +
                "pass.dispatchWorkgroups(Math.ceil(gpu.width / 8), Math.ceil(gpu.height / 8)); pass.end(); " +
                "writeSsaoGpuParameters(state.parameters, params); executeSsaoGpu(gpu, encoder, params.quality); return true;",
            "The half-resolution prepare",
        );
    }

    /** `createSsaoTask`'s `execute`, with its GPU statements answered by the backend. */
    private frame(): string {
        const context = this.context;
        const { file, factory, task } = ssaoTaskObject(context);
        assertClosureLet(context, factory, "wasEnabled", "false");
        assertClosureLet(context, factory, "neutral", "false");
        this.assertResolutionBefore();
        const execute = objectMethod(context, task, "execute");
        const bindings = new Map<string, PinnedBinding>([
            ["task.enabled", { cpp: "task.enabled", type: "bool" }],
            ["task.radius", { cpp: "task.radius", type: "scalar" }],
            ["task.intensity", { cpp: "task.intensity", type: "scalar" }],
            ["task.quality", { cpp: "task.quality", type: "string" }],
            ["wasEnabled", { cpp: "task.state.was_enabled", type: "bool" }],
            ["neutral", { cpp: "task.state.neutral", type: "bool" }],
            [
                "depth._width",
                {
                    cpp: "static_cast<double>(inputs.depth_width)",
                    type: "scalar",
                },
            ],
            [
                "depth._height",
                {
                    cpp: "static_cast<double>(inputs.depth_height)",
                    type: "scalar",
                },
            ],
            ["camera.nearPlane", { cpp: "camera.near_plane", type: "scalar" }],
            ["camera.farPlane", { cpp: "camera.far_plane", type: "scalar" }],
            ["camera.fov", { cpp: "camera.fov", type: "scalar" }],
            ...PARAMS_MEMBERS.map(
                ([pinned, native, type]) =>
                    [
                        `params.${pinned}`,
                        { cpp: `params.${native}`, type },
                    ] as const,
            ),
            ["Math.PI", { cpp: "3.141592653589793", type: "scalar" }],
        ]);
        const statement = (
            node: ts.Statement,
            lowerer: PinnedNumericLowerer,
            indent: string,
        ): readonly string[] | undefined => {
            if (
                ts.isVariableStatement(node) &&
                node.declarationList.declarations.length === 1
            ) {
                const declaration = node.declarationList.declarations[0]!;
                const name = ts.isIdentifier(declaration.name)
                    ? declaration.name.text
                    : "";
                if (name === "gpu" && declaration.initializer) {
                    context.assertExpressionShape(
                        declaration.initializer,
                        "prepare()",
                        "The task's prepare",
                    );
                    // The adapter's pipeline creation and source rebinds reset history inside prepare().
                    return [
                        `${indent}if (inputs.pipeline_created) {`,
                        `${indent}    ssao_temporal_reset(task);`,
                        `${indent}}`,
                        `${indent}if (inputs.sources_rebound) {`,
                        `${indent}    ssao_temporal_reset(task);`,
                        `${indent}}`,
                    ];
                }
                if (name === "camera" && declaration.initializer) {
                    context.assertExpressionShape(
                        declaration.initializer,
                        "task.camera",
                        "The task camera",
                    );
                    lowerer.bindLocal(declaration.name as ts.Identifier, {
                        cpp: "camera",
                        type: "opaque",
                    });
                    return [];
                }
                if (name === "viewport" && declaration.initializer) {
                    context.assertExpressionShape(
                        declaration.initializer,
                        "camera.viewport",
                        "The camera viewport",
                    );
                    return [];
                }
                if (name === "projection" && declaration.initializer) {
                    context.assertExpressionShape(
                        declaration.initializer,
                        "getProjectionMatrix(camera, getEffectiveAspectRatio(camera, depth._width, depth._height))",
                        "The task projection",
                    );
                    lowerer.bindLocal(declaration.name as ts.Identifier, {
                        cpp: "projection",
                        type: "f32",
                    });
                    return [
                        `${indent}const std::array<float, 16> projection = build_projection(camera, effective_aspect_ratio(camera, static_cast<double>(inputs.depth_width), static_cast<double>(inputs.depth_height)));`,
                    ];
                }
            }
            if (
                ts.isIfStatement(node) &&
                sameSource(
                    node.expression,
                    "camera.ortho || (viewport && (viewport.x !== 0 || viewport.y !== 0 || viewport.width !== 1 || viewport.height !== 1))",
                )
            ) {
                // The test reads the camera record's projection kind and
                // optional viewport; the refusal is the pin's own statement.
                return [
                    `${indent}if (camera.orthographic || (camera.viewport && (camera.viewport->x != 0.0 || camera.viewport->y != 0.0 || camera.viewport->width != 1.0 || camera.viewport->height != 1.0)))`,
                    ...lowerer.statement(node.thenStatement, indent),
                ];
            }
            if (ts.isExpressionStatement(node)) {
                const expression = context.unwrapExpression(node.expression);
                if (sameSource(expression, "task._filter?.reset()")) {
                    return [`${indent}ssao_temporal_reset(task);`];
                }
                if (
                    sameSource(
                        expression,
                        "clearSsaoGpu(gpu, engine._currentEncoder)",
                    )
                ) {
                    return [`${indent}decision.clear_output = true;`];
                }
                if (
                    sameSource(
                        expression,
                        "params.view = getViewMatrix(camera)",
                    )
                ) {
                    return [
                        `${indent}params.view = build_camera_view_matrix(camera);`,
                        `${indent}params.has_view = true;`,
                    ];
                }
                if (sameSource(expression, "params.quality = task.quality")) {
                    return [`${indent}params.quality = task.quality;`];
                }
                if (
                    sameSource(expression, "task._filter?.prepare(gpu, params)")
                ) {
                    return [
                        `${indent}ssao_temporal_prepare(task, camera, inputs, params);`,
                    ];
                }
                if (
                    sameSource(
                        expression,
                        "writeSsaoGpuParameters(gpu, params)",
                    )
                ) {
                    return [
                        `${indent}write_ssao_gpu_parameters(decision.params, static_cast<double>(inputs.working_width), static_cast<double>(inputs.working_height), inputs.sampling_footprint, params);`,
                    ];
                }
                if (
                    sameSource(
                        expression,
                        "task._filter?.execute(gpu, engine._currentEncoder)",
                    )
                ) {
                    return [
                        `${indent}ssao_temporal_execute(task, camera, inputs, decision);`,
                    ];
                }
                if (
                    sameSource(
                        expression,
                        "task._resolution?.after?.(gpu, engine._currentEncoder)",
                    )
                ) {
                    return [];
                }
            }
            if (
                ts.isIfStatement(node) &&
                sameSource(
                    node.expression,
                    "!task._resolution?.before(gpu, engine._currentEncoder, params)",
                )
            ) {
                // `before` writes the full-size block and encodes the reduced
                // owner when the adapter is active; `executeSsaoGpu` is the
                // plan's passes either way.
                return [
                    `${indent}if (task.half && task.half->active) {`,
                    `${indent}    write_ssao_gpu_parameters(decision.full_params, static_cast<double>(inputs.depth_width), static_cast<double>(inputs.depth_height), std::nullopt, params);`,
                    `${indent}}`,
                    `${indent}decision.run = true;`,
                ];
            }
            return undefined;
        };
        const body = lowerPinnedBody(file, execute.body!.statements, {
            bindings,
            calls: cameraCalls(),
            callShapes: BOOL_CALLS,
            matrixCalls: MATRIX_CALLS,
            statement,
            returnValue: (expression) => {
                if (!expression || !sameSource(expression, "0")) {
                    context.contractError(
                        expression ?? execute,
                        "Expected execute to return 0.",
                    );
                }
                return "decision";
            },
        });
        return `// ${this.context.provenance(SSAO_MODULE, "createSsaoTask", "its task's execute")}
SsaoFrameDecision ssao_frame(Engine& engine, SsaoTaskOptions& task, const SsaoFrameInputs& inputs) {
    SsaoFrameDecision decision;
    SsaoGpuParameters params;
    const CameraRecord& camera = ${"handle_at(engine.cameras, task.camera)"};
${body}
}`;
    }

    /**
     * The task's `record`: its settings' validation, then `prepare()`,
     * whose half-resolution activation reads the depth source's built extent
     * (the one the task's last frame read). The owner it decides is the
     * backend's at the next frame, and before any frame the first one decides.
     */
    private taskRecord(): string {
        const context = this.context;
        const { task } = ssaoTaskObject(context);
        const record = objectMethod(context, task, "record");
        context.assertStatementShapes(
            record,
            record.body!.statements,
            "validateSsaoSettings(task.radius, task.intensity, task.quality); prepare();",
            "The task's record",
        );
        return `// ${context.provenance(SSAO_MODULE, "createSsaoTask", "its task's record")}
void ssao_task_record(SsaoTaskOptions& task) {
    validate_ssao_settings(task.radius, task.intensity, task.quality);
    if (task.source_width != 0u)
        ssao_prepare_resolution(task, task.source_width, task.source_height);
}`;
    }

    /** The native record's creation, shared by every task's factory. */
    private sharedFactory(): string {
        return `TaskHandle create_ssao_task(Engine& engine, SsaoTaskOptions options) {
    options.state.quality = options.quality;
    FrameTaskRecord task;
    task.kind = FrameTaskKind::ssao;
    task.ssao = std::move(options);
    engine.frame_tasks.push_back(std::move(task));
    return TaskHandle{static_cast<std::uint32_t>(engine.frame_tasks.size() - 1)};
}`;
    }

    /**
     * The closure constants `initializeSsaoTemporal` derives from its
     * velocity input (asserted by `assertTemporalClosure`), for the input
     * generation composed: whether Z holds previous depth and whether the
     * format is half-float.
     */
    private temporalVelocity(task: SsaoLoweringInput): {
        previousDepth: boolean;
        half: boolean;
    } {
        const velocity = task.manifest.velocity;
        if (!velocity) return { previousDepth: false, half: false };
        const format = task.composed.velocityFormat;
        return {
            previousDepth: velocity.previousDepth,
            half: format === "rg16float" || format === "rgba16float",
        };
    }

    /**
     * One task's factory: the settings the pin published at creation. A
     * history limit only run time knows is the call's own, validated where
     * the pin's factory validates it.
     */
    private taskFactory(task: SsaoLoweringInput): string {
        const { composed, manifest } = task;
        const { settings } = composed;
        const velocity = this.temporalVelocity(task);
        return `${this.factorySignature(manifest.taskIndex)} {
    SsaoTaskOptions options;
    options.name = ${stringLiteral(manifest.name ?? "ssao")};
    options.depth = depth;
    options.normal = normal;
    options.camera = camera;
    options.velocity = velocity;
    options.velocity_previous_depth = ${velocity.previousDepth};
    options.velocity_half = ${velocity.half};
    options.quality = ${stringLiteral(settings.quality)};
    options.radius = ${doubleLiteral(settings.radius)};
    options.intensity = ${doubleLiteral(settings.intensity)};
    options.temporal.enabled = ${settings.temporalEnabled};
    options.temporal.history_samples = history_samples.value_or(${doubleLiteral(settings.historySamples)});
    options.temporal.reset_version = 0.0;
    options.plan = ${manifest.taskIndex}u;
    validate_ssao_settings(options.radius, options.intensity, options.quality);
    validate_ssao_temporal_settings(options.temporal);
    return create_ssao_task(engine, std::move(options));
}`;
    }
}
