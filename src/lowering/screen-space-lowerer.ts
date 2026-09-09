import ts from "typescript";
import { CppDefinitions, type CppModule } from "../cpp-definitions.js";
import {
    SCREEN_SPACE_KINDS,
    SCREEN_SPACE_SCALAR_SETTINGS,
    SCREEN_SPACE_TEMPORAL_MODULE,
    SCREEN_SPACE_TEMPORAL_UNIFORM_FLOATS,
    nativeSettingName,
    screenSpaceFactsOfKind,
    type ComposedScreenSpaceTask,
    type ScreenSpaceKindFacts,
    type ScreenSpaceStageBinding,
} from "../pinned-screen-space.js";
import type { ScreenSpaceTaskManifest } from "../compiler/types.js";
import { doubleLiteral, stringLiteral } from "../cpp-literals.js";
import { LoweredSource, LoweringContext } from "./context.js";

import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import {
    pinnedNumericMathCallsWithHypot,
    pinnedRoundCall,
} from "./pinned-operators.js";
import { nativeTextureFormat } from "./post-process-lowerer.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    lowerMat4InvertCpp,
    lowerObjectComponents,
    lowerPinnedFunction,
} from "./pinned-function-lowerer.js";

const CONTACT = screenSpaceFactsOfKind("scalar");
const GI = screenSpaceFactsOfKind("color");
const TEMPORAL_MODULE = SCREEN_SPACE_TEMPORAL_MODULE;
const PACK_MODULE = "src/math/pack-mat4-into-f32.ts";

/**
 * The pinned reset event's members and their native spellings, which the
 * lowered decision reads and the frame function fills.
 */
const RESET_EVENT_MEMBERS: readonly (readonly [string, string])[] = [
    ["firstAllocation", "first_allocation"],
    ["targetReallocated", "target_reallocated"],
    ["sourceIdentityChanged", "source_identity_changed"],
    ["resetVersionChanged", "reset_version_changed"],
    ["enabledTransitionedOn", "enabled_transitioned_on"],
    ["singularInverse", "singular_inverse"],
    ["cameraMoved", "camera_moved"],
];

/**
 * The closure state a factory keeps between frames and the literal each
 * starts from, which the native record's defaults restate: the pin's
 * `let firstFrame = true` is `bool first_frame = true`. Asserted against
 * the factory body so a changed starting value fails generation.
 */
const STATE_INITIALIZERS: readonly (readonly [string, string])[] = [
    ["firstFrame", "true"],
    ["pendingReallocation", "false"],
    ["lastEnabled", "undefined"],
    ["lastResetVersion", "undefined"],
    ["accumulatedSamples", "1"],
    ["phaseIndex", "0"],
    ["prevInvViewProjNull", "false"],
];

/** The generated factory's signature, declared and defined alike. */
function factorySignature(taskIndex: number): string {
    return (
        `TaskHandle create_screen_space_task_${taskIndex}(\n` +
        `    Engine& engine,\n` +
        `    RenderTargetHandle source,\n` +
        `    RenderTargetHandle depth,\n` +
        `    RenderTargetHandle target,\n` +
        `    CameraHandle camera,\n` +
        `    ScreenSpaceLightDirection light_direction)`
    );
}

/** One reached task, with the table indices generation assigned its stages. */
export interface ScreenSpaceLoweringInput {
    manifest: ScreenSpaceTaskManifest;
    composed: ComposedScreenSpaceTask;
    /** Rows in the generated `screen_space_shader_infos` table. */
    producerStage: number;
    resolveStage: number;
    /** Rows in the post-process stage table, shared with every other pass. */
    historyCopyShader: number;
    compositeShader: number | undefined;
}

/** A composite writer's slot: what the pin reads off the task, in order. */
interface CompositeSlot {
    /** The pinned read, as the writer spells it (`intensity`, `tint[0]`). */
    read: string;
    /** The native expression the frame function copies into the slot. */
    native: string;
    boolean: boolean;
}

/**
 * The screen-space effects, lowered from their own modules.
 *
 * What the pin decides at run time -- the temporal state machine of
 * `execute`, the reset matrix, the accumulation ramp, the two uniform blocks
 * and the composite's writer -- is translated from the pinned ASTs into one
 * generated frame function per kind. What the pin decides at creation --
 * modules, layouts, formats, pass order, clamped settings -- was obtained by
 * running the factory (`pinned-screen-space.ts`) and is emitted as data.
 * The GPU work between those statements (bind groups, passes, uploads) is
 * the backend's, reached through `ScreenSpaceFrameDecision`; every such
 * statement is still asserted here so an added pass or upload fails
 * generation by name.
 */
export class ScreenSpaceLowerer {
    public constructor(
        private readonly context: LoweringContext,
        private readonly tasks: readonly ScreenSpaceLoweringInput[],
    ) {}

    /** The writer body each composite's post-process stage index needs. */
    public compositeWriters(): Map<number, string> {
        const writers = new Map<number, string>();
        for (const task of this.tasks) {
            if (task.compositeShader === undefined) continue;
            writers.set(
                task.compositeShader,
                this.compositeWriterBody(task.composed.kind, "            "),
            );
        }
        return writers;
    }

    public lowerTaskRecords(): LoweredSource {
        return {
            modulePath: CONTACT.module,
            symbolName: Object.keys(SCREEN_SPACE_KINDS).join(","),
            header: this.header(),
            source: this.source(),
        };
    }

    private header(): string {
        const factories = this.tasks
            .map((task) => `${factorySignature(task.manifest.taskIndex)};`)
            .join("\n");
        return `#pragma once

#include <bblite/runtime.hpp>

#include <cstdint>

namespace bbl::upstream {

/** The pin's \`computeScreenSpaceScaledSize\`: an owned target's extent. */
struct ScreenSpaceScaledSize {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
};

ScreenSpaceScaledSize screen_space_scaled_size(
    double width,
    double height,
    double scale);

/**
 * One frame of one task, lowered from the pin's own \`execute\`: samples the
 * live settings, advances the temporal state and fills both uniform blocks.
 * The backend encodes what it decided.
 */
ScreenSpaceFrameDecision screen_space_frame(
    Engine& engine,
    TaskHandle handle,
    const ScreenSpaceFrameInputs& inputs);

} // namespace bbl::upstream

namespace bbl {

${factories}

} // namespace bbl
`;
    }

    private source(): string {
        const provenance = this.context.provenance(
            CONTACT.module,
            CONTACT.intrinsic,
            `${GI.module}#${GI.intrinsic}, ` +
                `${TEMPORAL_MODULE}#createScreenSpaceTemporalOwner`,
        );
        const kinds = new Set(this.tasks.map((task) => task.composed.kind));
        this.recordContract();
        return `// ${provenance}
#include <bblite/upstream/frame_graph_screen_space.hpp>

#include <bblite/js_data.hpp>
#include <bblite/upstream/camera_math.hpp>
#include <bblite/upstream/pinned_matrix.hpp>
#include <bblite/upstream/renderer_plan.hpp>

#include <algorithm>
#include <cmath>
#include <optional>
#include <stdexcept>
#include <utility>

namespace bbl::upstream {

${this.uniformSizeContract()}

namespace {

${lowerMat4InvertCpp(this.context)}

${this.packMat4()}

${this.clampHelper()}

${this.temporalHelpers()}

${this.resetDecision()}

${this.lightDirection()}

${this.refreshComposite()}
${kinds.has("scalar") ? this.frameFunction("scalar") : ""}
${kinds.has("color") ? this.frameFunction("color") : ""}
} // namespace

${this.scaledSize()}

ScreenSpaceFrameDecision screen_space_frame(
    Engine& engine,
    TaskHandle handle,
    const ScreenSpaceFrameInputs& inputs) {
    if (handle.value >= engine.frame_tasks.size()) {
        throw std::runtime_error("Invalid screen-space task handle.");
    }
    FrameTaskRecord& record = engine.frame_tasks[handle.value];
    if (record.kind != FrameTaskKind::screen_space) {
        throw std::runtime_error(
            "A frame task that is not a screen-space effect was run as one.");
    }
    ScreenSpaceTaskOptions& task = record.screen_space;
    ScreenSpaceTemporalState& state = task.state;
    // The pin's record(): it resizes its raw, stable and history targets
    // whenever the depth source's scaled extent changed and flags the
    // reallocation for execute. The backend sized and built those targets;
    // a changed allocation is that same event.
    if (inputs.raw_allocation != state.seen_raw_allocation) {
        state.seen_raw_allocation = inputs.raw_allocation;
        state.pending_reallocation = true;
    }
    if (
        inputs.stable_allocation != state.seen_stable_allocation ||
        inputs.history_allocation != state.seen_history_allocation) {
        state.seen_stable_allocation = inputs.stable_allocation;
        state.seen_history_allocation = inputs.history_allocation;
        state.pending_reallocation = true;
    }
    switch (task.kind) {
${[CONTACT, GI]
    .filter((facts) => kinds.has(facts.kind))
    .map(
        (facts) =>
            `        case ScreenSpaceEffectKind::${facts.enumerator}:\n` +
            `            return ${facts.frameFunction}(engine, record, task, inputs);\n`,
    )
    .join("")}        default:
            throw std::runtime_error(
                "A screen-space task of a kind this scene never composed.");
    }
}

} // namespace bbl::upstream

namespace bbl {

${this.sharedFactory()}

${this.tasks.map((task) => this.taskFactory(task)).join("\n\n")}

} // namespace bbl
`;
    }

    /**
     * `packMat4IntoF32`'s fast path, which is the only path a screen-space
     * task reaches: every pack is of one sixteen-element matrix at source
     * offset zero, so the pin's own `view.set(src, offsetFloats)` is a copy
     * of sixteen floats. The slab walk behind the guard is asserted present
     * and not translated.
     */
    private packMat4(): string {
        const { file, declaration } = this.context.functionDeclaration(
            PACK_MODULE,
            "packMat4IntoF32",
        );
        const guard = this.context.findNodes(
            declaration,
            (node): node is ts.IfStatement =>
                ts.isIfStatement(node) &&
                node.expression.getText(file) ===
                    "srcOffsetFloats === 0 && src.length === 16",
        );
        if (
            guard.length !== 1 ||
            !this.context.hasCall(guard[0]!.thenStatement, "set")
        ) {
            this.context.contractError(
                declaration,
                "Expected packMat4IntoF32 to copy a sixteen-element matrix " +
                    "at source offset zero through view.set.",
            );
        }
        return `// ${this.context.provenance(PACK_MODULE, "packMat4IntoF32")}
// The fast path: one matrix, source offset zero, \`view.set(src, offset)\`.
void pack_mat4_into_f32(
    float* view,
    const std::array<float, 16>& mat,
    double offset_floats) {
    std::copy_n(
        mat.data(),
        16,
        view + static_cast<std::size_t>(offset_floats));
}`;
    }

    /**
     * The two uniform blocks' sizes, met at both ends: the pin's own
     * `SS_*_UNIFORM_FLOATS` constants against the buffers the recording
     * device saw the factory create, and those byte counts against the
     * fixed arrays `ScreenSpaceFrameDecision` carries them in -- a block
     * the pin grows fails generation here and native compilation there,
     * never a lowered write past the array.
     */
    private uniformSizeContract(): string {
        const floats = (module: string, name: string): number => {
            const initializer = this.context.unwrapExpression(
                this.context.variableInitializer(
                    this.context.sourceFile(module),
                    name,
                ),
            );
            if (!ts.isNumericLiteral(initializer)) {
                this.context.contractError(
                    initializer,
                    `Expected ${name} to be a numeric literal.`,
                );
            }
            return Number(initializer.text);
        };
        const temporalBytes =
            4 * floats(TEMPORAL_MODULE, SCREEN_SPACE_TEMPORAL_UNIFORM_FLOATS);
        let producerBytes: number | undefined;
        for (const task of this.tasks) {
            const facts = task.composed.kind === "scalar" ? CONTACT : GI;
            const expected = 4 * floats(facts.module, facts.producerUniformFloats);
            if (task.composed.producer.uniformBytes !== expected) {
                throw new Error(
                    `Pinned ${facts.intrinsic} creates a ${task.composed.producer.uniformBytes}-byte ` +
                        `producer block where ${facts.producerUniformFloats} sizes ${expected}.`,
                );
            }
            if (task.composed.resolve.uniformBytes !== temporalBytes) {
                throw new Error(
                    `Pinned ${facts.intrinsic} creates a ${task.composed.resolve.uniformBytes}-byte ` +
                        `temporal block where ${SCREEN_SPACE_TEMPORAL_UNIFORM_FLOATS} sizes ${temporalBytes}.`,
                );
            }
            if (producerBytes !== undefined && producerBytes !== expected) {
                throw new Error(
                    "The two screen-space producers size their blocks differently, " +
                        "which one decision record cannot carry.",
                );
            }
            producerBytes = expected;
        }
        return (
            `static_assert(\n` +
            `    sizeof(ScreenSpaceFrameDecision::producer_uniforms) == ${producerBytes ?? 0}u,\n` +
            `    "The producer block the pin sizes is not the one the decision carries.");\n` +
            `static_assert(\n` +
            `    sizeof(ScreenSpaceFrameDecision::temporal_uniforms) == ${temporalBytes}u,\n` +
            `    "The temporal block the pin sizes is not the one the decision carries.");`
        );
    }

    /** The module-scope `CLAMP`, identical in both producer modules. */
    private clampHelper(): string {
        const contact = this.context.sourceFile(CONTACT.module);
        const initializer = this.context.unwrapExpression(
            this.context.variableInitializer(contact, "CLAMP"),
        );
        const twin = this.context.unwrapExpression(
            this.context.variableInitializer(
                this.context.sourceFile(GI.module),
                "CLAMP",
            ),
        );
        if (
            !ts.isArrowFunction(initializer) ||
            initializer.parameters.length !== 3 ||
            ts.isBlock(initializer.body) ||
            initializer.getText(contact) !==
                twin.getText(this.context.sourceFile(GI.module))
        ) {
            this.context.contractError(
                initializer,
                "Expected both screen-space modules to declare the same " +
                    "three-parameter CLAMP arrow.",
            );
        }
        const names = initializer.parameters.map((parameter) => {
            if (!ts.isIdentifier(parameter.name)) {
                return this.context.contractError(parameter, "CLAMP parameter");
            }
            return parameter.name.text;
        });
        const lowerer = new PinnedNumericLowerer(contact, {
            bindings: new Map(
                names.map((name) => [name, { cpp: name, type: "scalar" }]),
            ),
            calls: pinnedNumericMathCallsWithHypot(),
        });
        return `// ${this.context.provenance(CONTACT.module, "CLAMP")}
double screen_space_clamp(double ${names.join(", double ")}) {
    return ${lowerer.expression(initializer.body)};
}`;
    }

    /** The pure temporal helpers, lowered whole. */
    private temporalHelpers(): string {
        const calls = pinnedNumericMathCallsWithHypot();
        return [
            lowerPinnedFunction(
                this.context,
                TEMPORAL_MODULE,
                "computeTemporalWeight",
                [
                    { pinned: "configuredWeight", kind: "number", cpp: "configured_weight" },
                    { pinned: "accumulatedSamples", kind: "number", cpp: "accumulated_samples" },
                ],
                { cppName: "compute_temporal_weight", returns: "double", calls },
            ),
            lowerPinnedFunction(
                this.context,
                TEMPORAL_MODULE,
                "advanceAccumulation",
                [
                    { pinned: "current", kind: "number", cpp: "current" },
                    { pinned: "reset", kind: "boolean", cpp: "reset" },
                    { pinned: "temporalSamples", kind: "number", cpp: "temporal_samples" },
                ],
                { cppName: "advance_accumulation", returns: "double", calls },
            ),
            lowerPinnedFunction(
                this.context,
                TEMPORAL_MODULE,
                "advancePhaseIndex",
                [
                    { pinned: "index", kind: "number", cpp: "index" },
                    { pinned: "restart", kind: "boolean", cpp: "restart" },
                ],
                { cppName: "advance_phase_index", returns: "double", calls },
            ),
            lowerPinnedFunction(
                this.context,
                TEMPORAL_MODULE,
                "phaseValue",
                [
                    { pinned: "index", kind: "number", cpp: "index" },
                    { pinned: "temporalSamples", kind: "number", cpp: "temporal_samples" },
                ],
                { cppName: "phase_value", returns: "double", calls },
            ),
        ].join("\n\n");
    }

    /**
     * `decideScreenSpaceReset`, whole, over a record whose members are the
     * pinned event's. The pin never reads `cameraMoved` -- camera motion
     * keeps history -- which the frame function relies on to leave the
     * camera change key untranslated, so that absence is asserted here.
     */
    private resetDecision(): string {
        const { declaration } = this.context.functionDeclaration(
            TEMPORAL_MODULE,
            "decideScreenSpaceReset",
        );
        const members = RESET_EVENT_MEMBERS;
        const { declaration: event } = this.context.interfaceDeclaration(
            TEMPORAL_MODULE,
            "ScreenSpaceResetEvent",
        );
        const declared = event.members.map((member) =>
            member.name ? this.context.propertyName(member.name) : undefined,
        );
        if (
            declared.length !== members.length ||
            !members.every(([pinned], index) => declared[index] === pinned)
        ) {
            this.context.contractError(
                event,
                `Expected ScreenSpaceResetEvent to declare exactly [${members
                    .map(([pinned]) => pinned)
                    .join(", ")}].`,
            );
        }
        if (
            this.context.hasNode(
                declaration,
                (node) =>
                    ts.isPropertyAccessExpression(node) &&
                    node.name.text === "cameraMoved",
            )
        ) {
            this.context.contractError(
                declaration,
                "decideScreenSpaceReset now reads cameraMoved; the frame " +
                    "function leaves the camera change key untranslated " +
                    "because it did not.",
            );
        }
        const memberBindings = new Map<string, PinnedBinding>(
            members.map(([pinned, cpp]) => [
                `ev.${pinned}`,
                { cpp: `ev.${cpp}`, type: "bool" },
            ]),
        );
        const body = lowerPinnedFunction(
            this.context,
            TEMPORAL_MODULE,
            "decideScreenSpaceReset",
            [
                {
                    pinned: "ev",
                    kind: "record",
                    cpp: "ev",
                    annotation: "ScreenSpaceResetEvent",
                    cppType: "ScreenSpaceResetEvent",
                },
            ],
            {
                cppName: "decide_screen_space_reset",
                returns: {
                    type: "ScreenSpaceResetDecision",
                    value: (lowerer, expression) => {
                        if (!expression) {
                            return this.context.contractError(
                                declaration,
                                "Expected decideScreenSpaceReset to return " +
                                    "its decision.",
                            );
                        }
                        const [invalidate, restart] = lowerObjectComponents(
                            this.context,
                            lowerer,
                            expression,
                            ["invalidateHistory", "restartPhase"],
                        );
                        return (
                            `ScreenSpaceResetDecision{` +
                            `(${invalidate}) != 0.0, (${restart}) != 0.0}`
                        );
                    },
                },
                booleanOr: true,
                memberBindings,
            },
        );
        return `struct ScreenSpaceResetEvent {
${members.map(([, cpp]) => `    bool ${cpp} = false;`).join("\n")}
};

struct ScreenSpaceResetDecision {
    bool invalidate_history = false;
    bool restart_phase = false;
};

${body}`;
    }

    /**
     * The contact producer's light direction: the pin keeps the object the
     * scene passed and reads it every frame. A scene that passed a light's
     * own `direction` reads that record; one that passed a literal keeps it.
     */
    private lightDirection(): string {
        return `Vec3d screen_space_light_direction(
    const Engine& engine,
    const ScreenSpaceTaskOptions& task) {
    if (task.light_direction.light.value == invalid_handle) {
        return task.light_direction.value;
    }
    const Vec3& direction =
        engine.lights.at(task.light_direction.light.value).direction;
    return Vec3d{
        static_cast<double>(direction.x),
        static_cast<double>(direction.y),
        static_cast<double>(direction.z)};
}`;
    }

    /**
     * The pin's `composite?.updateUniforms()`: the composite's writer reads
     * the task's live fields, so the pass's parameter vector takes their
     * current values. The slot order is the writer's own reading order
     * (`compositeSlots`), so the copy here and the lowered writer name the
     * same slot. The pin rewrites its block every frame; the pass's dirty
     * flag exists to skip that upload, so it is raised only when a slot
     * moved.
     */
    private refreshComposite(): string {
        const arms = (["scalar", "color"] as const)
            .filter((kind) => this.tasks.some((task) => task.composed.kind === kind))
            .map((kind) => {
                const slots = this.compositeSlots(kind);
                const facts = kind === "scalar" ? CONTACT : GI;
                return `        case ScreenSpaceEffectKind::${facts.enumerator}:
            if (pass.params.size() != ${slots.length}u) {
                throw std::runtime_error(
                    "A screen-space composite's parameters were resized.");
            }
${slots
    .map(
        (slot, index) =>
            `            write(${index}u, ${slot.native});`,
    )
    .join("\n")}
            break;`;
            })
            .join("\n");
        return `void screen_space_refresh_composite(
    FrameTaskRecord& record,
    const ScreenSpaceTaskOptions& task) {
    if (record.post_process.passes.size() < 2) {
        return;
    }
    PostProcessPassOptions& pass = record.post_process.passes[1];
    const auto write = [&pass](std::size_t slot, double value) {
        if (pass.params[slot] != value) {
            pass.params[slot] = value;
            pass.uniforms_dirty = true;
        }
    };
    switch (task.kind) {
${arms}
        default:
            break;
    }
}`;
    }

    /** The factory module and its entry point for a temporal kind. */
    private factoryOf(kind: "scalar" | "color"): {
        facts: ScreenSpaceKindFacts & { intrinsic: string };
        module: string;
        symbol: string;
        file: ts.SourceFile;
        declaration: ts.FunctionDeclaration;
    } {
        const facts = kind === "scalar" ? CONTACT : GI;
        const { file, declaration } = this.context.functionDeclaration(
            facts.module,
            facts.intrinsic,
        );
        return {
            facts,
            module: facts.module,
            symbol: facts.intrinsic,
            file,
            declaration,
        };
    }

    /** The composite pass's one `writeUniforms`, from the factory body. */
    private compositeWriter(kind: "scalar" | "color"): {
        file: ts.SourceFile;
        body: ts.Block;
    } {
        const facts = kind === "scalar" ? CONTACT : GI;
        const { file, declaration } = this.context.propertyFunction(
            facts.module,
            facts.intrinsic,
            "writeUniforms",
            { unique: true },
        );
        return { file, body: declaration.body };
    }

    private readonly compositeSlotCache = new Map<
        "scalar" | "color",
        CompositeSlot[]
    >();

    /**
     * The task fields the composite writer reads, in reading order. Each
     * becomes one parameter slot: `task.enabled ? 1 : 0` a flag the pin
     * spends through a conditional, `task.tint[0]` one lane of the triple.
     */
    private compositeSlots(kind: "scalar" | "color"): CompositeSlot[] {
        const cached = this.compositeSlotCache.get(kind);
        if (cached) return cached;
        const { file, body } = this.compositeWriter(kind);
        const slots: CompositeSlot[] = [];
        const seen = new Set<string>();
        const visit = (node: ts.Node): void => {
            const read = this.taskRead(node, file);
            if (read && !seen.has(read.read)) {
                seen.add(read.read);
                slots.push(read);
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(body);
        if (slots.length === 0) {
            this.context.contractError(body, "Expected the writer to read the task.");
        }
        this.compositeSlotCache.set(kind, slots);
        return slots;
    }

    /** `task.<field>` or `task.<field>[k]` as a writer reads it. */
    private taskRead(
        node: ts.Node,
        file: ts.SourceFile,
    ): CompositeSlot | undefined {
        if (
            ts.isElementAccessExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "task" &&
            ts.isNumericLiteral(node.argumentExpression)
        ) {
            const field = node.expression.name.text;
            const lane = Number(node.argumentExpression.text);
            if (field !== "tint" || lane < 0 || lane > 2) {
                this.context.contractError(
                    node,
                    `The composite writer indexes task.${field}[${lane}], ` +
                        "which the native record does not carry.",
                );
            }
            return {
                read: node.getText(file),
                native: `task.tint[${lane}]`,
                boolean: false,
            };
        }
        if (
            ts.isPropertyAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "task" &&
            !(
                node.parent &&
                ts.isElementAccessExpression(node.parent) &&
                node.parent.expression === node
            )
        ) {
            const field = node.name.text;
            if (field === "enabled") {
                return {
                    read: node.getText(file),
                    native: "task.enabled ? 1.0 : 0.0",
                    boolean: true,
                };
            }
            if (!SCREEN_SPACE_SCALAR_SETTINGS.includes(field)) {
                this.context.contractError(
                    node,
                    `The composite writer reads task.${field}, which the ` +
                        "native record does not carry as a scalar.",
                );
            }
            return {
                read: node.getText(file),
                native: `task.${nativeSettingName(field)}`,
                boolean: false,
            };
        }
        return undefined;
    }

    /**
     * The composite writer's body over the pass's parameter vector, for the
     * shared `write_post_process_uniforms` switch, whose pass parameter is
     * named `task` like the pin's closure variable.
     */
    private compositeWriterBody(kind: "scalar" | "color", indent: string): string {
        const { file, body } = this.compositeWriter(kind);
        const bindings = new Map<string, PinnedBinding>([
            ["data", { cpp: "data", type: "f32", mutable: true }],
        ]);
        for (const [slot, read] of this.compositeSlots(kind).entries()) {
            bindings.set(
                read.read,
                read.boolean
                    ? { cpp: `(task.params[${slot}] != 0.0)`, type: "bool" }
                    : { cpp: `task.params[${slot}]`, type: "scalar" },
            );
        }

        return lowerPinnedBody(file, body.statements, {
            bindings,
            calls: pinnedNumericMathCallsWithHypot(),
        }, indent);
    }

    /** `computeScreenSpaceScaledSize`, whole, as the backend's sizing rule. */
    private scaledSize(): string {
        const calls = pinnedNumericMathCallsWithHypot();
        calls.set("Math.round", pinnedRoundCall);
        return lowerPinnedFunction(
            this.context,
            TEMPORAL_MODULE,
            "computeScreenSpaceScaledSize",
            [
                { pinned: "width", kind: "number", cpp: "width" },
                { pinned: "height", kind: "number", cpp: "height" },
                { pinned: "scale", kind: "number", cpp: "scale" },
            ],
            {
                cppName: "screen_space_scaled_size",
                returns: {
                    type: "ScreenSpaceScaledSize",
                    value: (lowerer, expression) => {
                        const [width, height] = lowerObjectComponents(
                            this.context,
                            lowerer,
                            expression!,
                            ["width", "height"],
                        );
                        return (
                            `ScreenSpaceScaledSize{` +
                            `static_cast<std::uint32_t>(${width}), ` +
                            `static_cast<std::uint32_t>(${height})}`
                        );
                    },
                },
                calls,
            },
        );
    }

    /**
     * The pin's `record`: asserted rather than translated, because every
     * statement in it allocates or resizes GPU targets the backend owns.
     * What the frame function keeps from it is the reallocation flag, set
     * exactly where the pin sets it -- after resizing the raw target and
     * when the owner resized the temporal pair.
     */
    private recordContract(): void {
        for (const kind of ["scalar", "color"] as const) {
            if (!this.tasks.some((task) => task.composed.kind === kind)) continue;
            const { file, declaration: record } = this.taskMethod(kind, "record");
            const flagged = this.context.countNodes(
                record,
                (node) =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                    node.left.getText(file) === "pendingReallocation" &&
                    node.right.kind === ts.SyntaxKind.TrueKeyword,
            );
            if (flagged !== 2 || !this.context.hasCall(record, "record")) {
                this.context.contractError(
                    record,
                    "Expected record() to flag a reallocation after resizing " +
                        "the raw target and after owner.record resized the " +
                        "temporal targets.",
                );
            }
        }
    }

    /** The one method of that name a kind's factory builds on its task. */
    private taskMethod(
        kind: "scalar" | "color",
        name: string,
    ): {
        file: ts.SourceFile;
        declaration: ts.FunctionLikeDeclarationBase & { body: ts.Block };
    } {
        const facts = kind === "scalar" ? CONTACT : GI;
        return this.context.propertyFunction(
            facts.module,
            facts.intrinsic,
            name,
            { unique: true },
        );
    }

    /** The temporal owner's `resolve` method. */
    public resolveMethod(): {
        file: ts.SourceFile;
        declaration: ts.FunctionLikeDeclarationBase & { body: ts.Block };
    } {
        return this.context.propertyFunction(
            TEMPORAL_MODULE,
            "createScreenSpaceTemporalOwner",
            "resolve",
            { unique: true },
        );
    }

    /**
     * One kind's frame function, lowered from its factory's `execute` with
     * the temporal owner's `resolve` inlined where the pin calls it.
     */
    private frameFunction(kind: "scalar" | "color"): string {
        const { facts, module, symbol } = this.factoryOf(kind);
        const { file, declaration: execute } = this.taskMethod(kind, "execute");
        const walker = new FrameWalker(this.context, this, kind, file);
        const lines = walker.lowerExecute(execute.body.statements);
        return `// ${this.context.provenance(module, symbol, "execute")}
ScreenSpaceFrameDecision ${facts.frameFunction}(
    Engine& engine,
    FrameTaskRecord& record,
    ScreenSpaceTaskOptions& task,
    const ScreenSpaceFrameInputs& inputs) {
    ScreenSpaceTemporalState& state = task.state;
    ScreenSpaceFrameDecision decision{};
    const CameraRecord& camera = engine.cameras.at(task.camera.value);
    // The pin reads the camera's stored world matrix for its view, its
    // view-projection and its position alike; composed once here, the
    // three reads below take the same lanes the separate builders would.
    const std::array<CameraMatrixScalar, 16> camera_world =
        camera_world_matrix(camera);
${
    kind === "scalar"
        ? "    const Vec3d light_direction = screen_space_light_direction(engine, task);\n"
        : ""
}${lines.join("\n")}
}`;
    }

    /**
     * The creation-time half of the pin's factory, shared by every task:
     * its validation, the targets it creates and the passes it builds. The
     * pin creates each owned target at 1x1 and sizes it in `record`;
     * natively the backend sizes them from the depth source by the pin's
     * own rounding rule. Each task's own factory below supplies the
     * settings and stage indices generation settled for it.
     */
    private sharedFactory(): string {
        for (const kind of ["scalar", "color"] as const) {
            if (!this.tasks.some((task) => task.composed.kind === kind)) continue;
            const { file, declaration } = this.factoryOf(kind);
            for (const shape of [
                "(source._descriptor.samples ?? 1) !== 1",
                "(depthSource._descriptor.samples ?? 1) !== 1",
                "!depthSource._descriptor.dFormat",
            ]) {
                if (
                    !this.context.hasNode(
                        declaration,
                        (node) =>
                            ts.isIfStatement(node) &&
                            node.expression.getText(file) === shape,
                    )
                ) {
                    this.context.contractError(
                        declaration,
                        `Expected the factory to refuse on ${shape}.`,
                    );
                }
            }
            if (
                !this.context.hasCall(
                    declaration,
                    "assertScreenSpaceTargetNotAliasingSource",
                )
            ) {
                this.context.contractError(
                    declaration,
                    "Expected the factory to refuse a target aliasing its source.",
                );
            }
        }
        return `/** What one task's own factory settled beyond its settings. */
struct ScreenSpaceTaskPlan {
    TextureFormatClass raw_format{};
    TextureFormatClass stable_format{};
    PostProcessPassOptions history_copy;
    std::optional<PostProcessPassOptions> composite;
};

TaskHandle create_screen_space_task(
    Engine& engine,
    ScreenSpaceTaskOptions options,
    ScreenSpaceTaskPlan plan) {
    if (options.source.value >= engine.render_targets.size()) {
        throw std::runtime_error("Screen-space source is invalid.");
    }
    // config.depthTexture ?? source
    if (options.depth.value == invalid_handle) {
        options.depth = options.source;
    }
    if (options.depth.value >= engine.render_targets.size()) {
        throw std::runtime_error("Screen-space depth source is invalid.");
    }
    const RenderTargetRecord& source =
        engine.render_targets[options.source.value];
    RenderTargetRecord& depth = engine.render_targets[options.depth.value];
    if (source.samples != 1) {
        throw std::runtime_error(
            options.name + ": sourceTexture must be single-sample.");
    }
    if (depth.samples != 1) {
        throw std::runtime_error(
            options.name + ": depthTexture must be single-sample.");
    }
    if (!depth.has_depth) {
        throw std::runtime_error(
            options.name + ": depth source has no depth attachment.");
    }
    if (
        options.target.value != invalid_handle &&
        options.target.value == options.source.value) {
        throw std::runtime_error(
            options.name + ": targetTexture must differ from sourceTexture.");
    }
    // The producers bind the depth attachment through a depth-only view.
    depth.sampled_depth = true;
    // The raw producer target and the temporal owner's stable/history
    // pair, sized from the depth source at the pin's own rounding.
    const auto owned = [&](TextureFormatClass format) {
        RenderTargetOptions target;
        target.samples = 1u;
        target.has_color = true;
        target.has_depth = false;
        target.scale_source = options.depth;
        target.width_ratio = options.resolution_scale;
        target.height_ratio = options.resolution_scale;
        target.format = format;
        target.has_format = true;
        target.scale_rounding = ScaleRounding::round;
        return create_render_target(engine, target);
    };
    options.raw = owned(plan.raw_format);
    options.stable = owned(plan.stable_format);
    options.history = owned(plan.stable_format);
    PostProcessTaskOptions passes;
    passes.name = options.name;
    plan.history_copy.name = options.name + "-history-copy";
    plan.history_copy.source = render_target_texture(options.stable);
    plan.history_copy.target = options.history;
    resolve_post_process_pass_output(engine, plan.history_copy);
    passes.passes.push_back(std::move(plan.history_copy));
    if (plan.composite) {
        PostProcessPassOptions& composite = *plan.composite;
        composite.name = options.name + "-composite";
        composite.source = render_target_texture(options.source);
        composite.target = options.target;
        composite.extra_textures.push_back(
            render_target_texture(options.stable));
        resolve_post_process_pass_output(engine, composite);
        passes.passes.push_back(std::move(composite));
        options.output_target = passes.passes.back().output_target;
    } else {
        options.output_target = options.stable;
    }
    FrameTaskRecord task;
    task.kind = FrameTaskKind::screen_space;
    task.post_process = std::move(passes);
    task.screen_space = std::move(options);
    engine.frame_tasks.push_back(std::move(task));
    return TaskHandle{
        static_cast<std::uint32_t>(engine.frame_tasks.size() - 1)};
}`;
    }

    /** One task's own factory: the settings the pin clamped at creation. */
    private taskFactory(task: ScreenSpaceLoweringInput): string {
        const { composed, manifest } = task;
        const kind = composed.kind;
        const { facts, module, file, declaration } = this.factoryOf(kind);
        this.assertFactoryState(kind, declaration, file);
        // Every key the scene wrote reaches the pin's config, so the set is
        // checked against the config the pin declares: a renamed setting
        // would otherwise take its default silently.
        this.context.assertSuppliedOptions(
            module,
            facts.configType,
            [
                "sourceTexture",
                "camera",
                ...(manifest.hasDepthTexture ? ["depthTexture"] : []),
                ...(manifest.hasTarget ? ["targetTexture"] : []),
                ...(manifest.name !== undefined ? ["name"] : []),
                ...(kind === "scalar" ? ["lightDirection"] : []),
                ...Object.keys(manifest.options),
            ],
        );
        const name = manifest.name ?? this.pinnedDefault(declaration, file, "name");
        const composition =
            manifest.options.composition ??
            this.pinnedDefault(declaration, file, "composition");
        if (typeof composition !== "string") {
            this.context.contractError(declaration, "composition must be a string.");
        }
        if ((composition === "none") !== (composed.composite === null)) {
            throw new Error(
                `Pinned ${composed.intrinsic} composed ${
                    composed.composite ? "a" : "no"
                } composite for composition '${composition}'.`,
            );
        }
        // Composition kept only the settings the two tables name, so each
        // maps to its native member by spelling alone.
        const settings = Object.entries(composed.settings)
            .map(([field, value]) => {
                const native = nativeSettingName(field);
                if (Array.isArray(value)) {
                    return value
                        .map(
                            (lane, index) =>
                                `    options.${native}[${index}] = ${doubleLiteral(lane)};`,
                        )
                        .join("\n");
                }
                return `    options.${native} = ${doubleLiteral(value as number)};`;
            })
            .join("\n");
        if (
            composed.composite &&
            (composed.composite.extraTextures.length !== 1 ||
                composed.composite.extraTextures[0] !== "stable")
        ) {
            throw new Error(
                `Pinned ${composed.intrinsic} composites over [${composed.composite.extraTextures.join(
                    ", ",
                )}], where this port binds the stable target alone.`,
            );
        }
        return `${factorySignature(manifest.taskIndex)} {
    ScreenSpaceTaskOptions options;
    options.name = ${stringLiteral(name)};
    options.kind = ScreenSpaceEffectKind::${facts.enumerator};
    options.source = source;
    options.depth = depth;
    options.target = target;
    options.camera = camera;
    options.light_direction = light_direction;
    options.resolution_scale = ${doubleLiteral(composed.clamped.resolutionScale)};
    options.temporal_samples = ${doubleLiteral(composed.clamped.temporalSamples)};
${settings}
    options.producer_shader = ${task.producerStage}u;
    options.resolve_shader = ${task.resolveStage}u;
    ScreenSpaceTaskPlan plan;
    plan.raw_format = ${nativeTextureFormat(
        composed.producer.targetFormat,
        "the raw producer target",
    )};
    plan.stable_format = ${nativeTextureFormat(
        composed.resolve.targetFormat,
        "the stable temporal target",
    )};
    plan.history_copy.shader_index = ${task.historyCopyShader}u;
    plan.history_copy.sampling = PostProcessSampling::${composed.historyCopy.sampling};
    plan.history_copy.clear = ${composed.historyCopy.clear ? "true" : "false"};
${
    composed.composite
        ? `    PostProcessPassOptions& composite = plan.composite.emplace();
    composite.shader_index = ${task.compositeShader}u;
    composite.sampling = PostProcessSampling::${composed.composite.sampling};
    composite.clear = ${composed.composite.clear ? "true" : "false"};
    composite.params.assign(${this.compositeSlots(kind).length}u, 0.0);
`
        : ""
}    return create_screen_space_task(engine, std::move(options), std::move(plan));
}`;
    }

    /**
     * The closure state a factory starts from and the light reference it
     * keeps, asserted against the factory body: the native record's
     * defaults restate the former, and the frame function reads a light's
     * record live because the pin keeps `config.lightDirection` by
     * reference and normalises it every frame.
     */
    private assertFactoryState(
        kind: "scalar" | "color",
        declaration: ts.FunctionDeclaration,
        file: ts.SourceFile,
    ): void {
        const initializerText = (name: string): string | undefined => {
            const found = this.context.findNodes(
                declaration,
                (node): node is ts.VariableDeclaration =>
                    ts.isVariableDeclaration(node) &&
                    ts.isIdentifier(node.name) &&
                    node.name.text === name,
            );
            return found.length === 1
                ? found[0]!.initializer?.getText(file)
                : undefined;
        };
        for (const [name, literal] of STATE_INITIALIZERS) {
            if (initializerText(name) !== literal) {
                this.context.contractError(
                    declaration,
                    `Expected the factory to start ${name} at ${literal}, ` +
                        "which the native temporal state restates.",
                );
            }
        }
        if (kind !== "scalar") return;
        const references = this.context.findNodes(
            declaration,
            (node): node is ts.PropertyAssignment =>
                ts.isPropertyAssignment(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === "lightDirection",
        );
        const spellings = references
            .map((reference) => reference.initializer.getText(file))
            .sort();
        if (
            spellings.length !== 2 ||
            spellings[0] !== "config.lightDirection" ||
            spellings[1] !== "params.lightDirection"
        ) {
            this.context.contractError(
                declaration,
                "Expected the factory to keep config.lightDirection by " +
                    "reference on its params and task.",
            );
        }
    }

    /** The pin's `config.<option> ?? <literal>` default, read off the AST. */
    private pinnedDefault(
        declaration: ts.FunctionDeclaration,
        file: ts.SourceFile,
        option: string,
    ): string {
        const fallbacks = this.context
            .findNodes(declaration, ts.isBinaryExpression)
            .map((node) => this.context.nullishDefault(node))
            .filter(
                (split) =>
                    split !== undefined &&
                    split.left.getText(file) === `config.${option}`,
            );
        const literal = fallbacks[0]
            ? this.context.unwrapExpression(fallbacks[0].right)
            : undefined;
        if (fallbacks.length !== 1 || !literal || !ts.isStringLiteral(literal)) {
            this.context.contractError(
                declaration,
                `Expected the factory to default config.${option} to a string.`,
            );
        }
        return literal.text;
    }
}

/**
 * Walks a pinned `execute` body statement by statement.
 *
 * Arithmetic and state go through the shared numeric translator over a
 * binding table that spells the task's fields, the closure's state and the
 * frame's inputs natively. The statements that touch the device -- the
 * uploads, the passes, the bind-group identity checks -- are recognised by
 * shape, asserted, and left to the backend, which reads the decision the
 * translated statements filled in.
 */
class FrameWalker {
    private readonly bindings: Map<string, PinnedBinding>;
    private readonly numeric: PinnedNumericLowerer;
    private readonly boolean: PinnedNumericLowerer;
    private producerPassSeen = false;
    private producerUploadSeen = false;

    public constructor(
        private readonly context: LoweringContext,
        private readonly owner: ScreenSpaceLowerer,
        private readonly kind: "scalar" | "color",
        private readonly file: ts.SourceFile,
    ) {
        this.bindings = this.executeBindings();
        const scope = this.scope(this.bindings);
        this.numeric = new PinnedNumericLowerer(file, scope);
        this.boolean = new PinnedNumericLowerer(file, { ...scope, booleanOr: true });
    }

    private scope(bindings: Map<string, PinnedBinding>) {
        const calls = pinnedNumericMathCallsWithHypot();
        calls.set("Math.round", pinnedRoundCall);
        calls.set("CLAMP", (args) => `screen_space_clamp(${args.join(", ")})`);
        calls.set(
            "getEffectiveAspectRatio",
            (args) => `effective_aspect_ratio(${args.join(", ")})`,
        );
        // Each of the pin's three camera reads over the world matrix the
        // frame function composed once: `build_view_projection` and
        // `camera_position` compose it themselves, so their bodies are
        // spelled here over `camera_world` instead.
        calls.set(
            "getViewProjectionMatrix",
            (args) =>
                `matrix_product(build_scene_projection(${args.join(", ")}), ` +
                "build_view_matrix(camera_world))",
        );
        calls.set("getViewMatrix", () => "build_view_matrix(camera_world)");
        calls.set(
            "getCameraPosition",
            () =>
                "Vec3d{static_cast<double>(camera_world[12]), " +
                "static_cast<double>(camera_world[13]), " +
                "static_cast<double>(camera_world[14])}",
        );
        calls.set("identityChanged", (args) => `(${args[0]} != ${args[1]})`);
        calls.set(
            "advanceAccumulation",
            (args) => `advance_accumulation(${args.join(", ")})`,
        );
        calls.set(
            "computeTemporalWeight",
            (args) => `compute_temporal_weight(${args.join(", ")})`,
        );
        calls.set(
            "advancePhaseIndex",
            (args) => `advance_phase_index(${args.join(", ")})`,
        );
        calls.set("phaseValue", (args) => `phase_value(${args.join(", ")})`);
        calls.set(
            "packMat4IntoF32",
            (args) => `pack_mat4_into_f32(${args[0]}.data(), ${args[1]}, ${args[2]})`,
        );
        calls.set("owner.clearIdentity", () => "decision.clear_identity = true");
        calls.set(
            "composite.updateUniforms",
            () => "screen_space_refresh_composite(record, task)",
        );
        return {
            bindings,
            calls,
            methods: new Map([
                [
                    "fill",
                    (receiver: string, args: readonly string[]) =>
                        `${receiver}.fill(static_cast<float>(${args[0]}))`,
                ],
            ]),
            matrixCalls: new Set(["getViewProjectionMatrix", "getViewMatrix"]),
            recordCalls: new Map([["getCameraPosition", ["x", "y", "z"]]]),
            returnValue: (expression: ts.Expression | undefined) => {
                const text = expression?.getText(this.file) ?? "";
                if (
                    text !== "composite?.execute?.() ?? 0" &&
                    text !== "draws + (composite?.execute?.() ?? 0)"
                ) {
                    return this.context.contractError(
                        expression ?? this.file,
                        "Expected execute to return the composite's draw count.",
                    );
                }
                return "decision";
            },
        };
    }

    /** The execute scope: the task's fields, the closure's state, the inputs. */
    private executeBindings(): Map<string, PinnedBinding> {
        const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });
        const flag = (cpp: string): PinnedBinding => ({ cpp, type: "bool" });
        const bindings = new Map<string, PinnedBinding>([
            ["enabled", flag("task.enabled")],
            ["task.enabled", flag("task.enabled")],
            ["camera", scalar("camera")],
            ["params.temporalSamples", scalar("task.temporal_samples")],
            ["depthSource._width", scalar("static_cast<double>(inputs.depth_width)")],
            ["depthSource._height", scalar("static_cast<double>(inputs.depth_height)")],
            ["depthSource._depthTexture", scalar("inputs.depth_allocation")],
            ["source._colorTexture", scalar("inputs.color_allocation")],
            ["lastDepthTexture", scalar("state.last_depth_allocation")],
            ["lastColorTexture", scalar("state.last_color_allocation")],
            ["lastEnabled", flag("state.last_enabled")],
            ["lastResetVersion", scalar("state.last_reset_version")],
            ["firstFrame", flag("state.first_frame")],
            ["pendingReallocation", flag("state.pending_reallocation")],
            ["prevInvViewProjNull", flag("state.prev_inv_view_proj_null")],
            ["accumulatedSamples", scalar("state.accumulated_samples")],
            ["phaseIndex", scalar("state.phase_index")],
            ["width", scalar("static_cast<double>(inputs.effect_width)")],
            ["height", scalar("static_cast<double>(inputs.effect_height)")],
            [
                "producerUniformData",
                { cpp: "decision.producer_uniforms", type: "f32", mutable: true },
            ],
            [
                "invViewProj",
                {
                    cpp: "(*inv_view_proj)",
                    type: "f32",
                    absentCpp: "!inv_view_proj.has_value()",
                },
            ],
            [
                "depthIdentityChanged",
                flag("(state.last_depth_allocation != inputs.depth_allocation)"),
            ],
            [
                "colorIdentityChanged",
                flag("(state.last_color_allocation != inputs.color_allocation)"),
            ],
            ["draws", scalar("0.0")],
        ]);
        for (const setting of SCREEN_SPACE_SCALAR_SETTINGS) {
            bindings.set(`task.${setting}`, scalar(`task.${nativeSettingName(setting)}`));
        }
        if (this.kind === "scalar") {
            bindings.set("task.lightDirection", { cpp: "light_direction", type: "vec3" });
            bindings.set("lightDir", { cpp: "light_direction", type: "vec3" });
        }
        return bindings;
    }

    public lowerExecute(statements: readonly ts.Statement[]): string[] {
        const lines: string[] = [];
        for (const statement of statements) {
            lines.push(...this.lowerStatement(statement, "    "));
        }
        if (!this.producerPassSeen || !this.producerUploadSeen) {
            this.context.contractError(
                this.file,
                "Expected execute to upload the producer block and encode " +
                    "the producer pass.",
            );
        }
        return lines;
    }

    private lowerStatement(statement: ts.Statement, indent: string): string[] {
        const recognised = this.recognise(statement, indent);
        if (recognised) return recognised;
        return this.numeric.statement(statement, indent);
    }

    /**
     * The statements the backend owns, asserted and left untranslated, and
     * the few whose native shape the translator cannot spell on its own.
     */
    private recognise(statement: ts.Statement, indent: string): string[] | undefined {
        const file = this.file;
        if (ts.isVariableStatement(statement)) {
            const declaration = statement.declarationList.declarations[0];
            if (
                statement.declarationList.declarations.length !== 1 ||
                !declaration ||
                !ts.isIdentifier(declaration.name) ||
                !declaration.initializer
            ) {
                return undefined;
            }
            const name = declaration.name.text;
            const initializer = this.context.unwrapExpression(declaration.initializer);
            if (name === "invViewProj") {
                this.context.assertExpressionShape(
                    initializer,
                    "mat4Invert(viewProj)",
                    "the inverse view-projection",
                );
                return [
                    `${indent}const std::optional<std::array<float, 16>> inv_view_proj = ` +
                        "mat4_invert(viewProj);",
                ];
            }
            if (name === "pass") {
                // The producer pass, which the backend encodes when the
                // decision says the effect ran; the resolve and history
                // copy follow it in the pin's own sequence.
                this.assertProducerPass(initializer);
                this.producerPassSeen = true;
                return [`${indent}decision.run_effect = true;`];
            }
            if (name === "camKey") {
                this.context.assertExpressionShape(
                    initializer,
                    "_cameraChangeKey(camera)",
                    "the camera change key",
                );
                return [];
            }
            if (name === "moved") {
                this.context.assertExpressionShape(
                    initializer,
                    "camKey !== lastCameraKey",
                    "the camera motion test",
                );
                return [];
            }
            if (name === "decision") {
                return this.lowerDecision(initializer, indent);
            }
            if (name === "draws") {
                return this.lowerResolveCall(initializer, indent);
            }
            if (name === "depthIdentityChanged" || name === "colorIdentityChanged") {
                this.context.assertExpressionShape(
                    initializer,
                    name === "depthIdentityChanged"
                        ? "identityChanged(lastDepthTexture, depthSource._depthTexture)"
                        : "identityChanged(lastColorTexture, source._colorTexture)",
                    "the source identity test",
                );
                return [];
            }
            if (name === "lightDir") {
                this.context.assertExpressionShape(
                    initializer,
                    "task.lightDirection",
                    "the light direction",
                );
                return [];
            }
            if (name === "camera") {
                this.context.assertExpressionShape(
                    initializer,
                    "params.camera",
                    "the task camera",
                );
                return [];
            }
            return undefined;
        }
        if (ts.isExpressionStatement(statement)) {
            const expression = this.context.unwrapExpression(statement.expression);
            const device = this.recogniseDeviceCall(
                expression,
                file,
                { buffer: "producerUniformBuffer!", data: "producerUniformData" },
                "the fullscreen triangle draw",
            );
            if (device === "upload") this.producerUploadSeen = true;
            if (device) return [];
            if (
                ts.isBinaryExpression(expression) &&
                expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                expression.left.getText(file) === "lastCameraKey"
            ) {
                return [];
            }
            return undefined;
        }
        if (ts.isIfStatement(statement)) {
            const condition = statement.expression.getText(file);
            if (condition.includes("producerBindGroup")) {
                if (!this.context.hasCall(statement.thenStatement, "rebuildProducerBindGroup")) {
                    this.context.contractError(
                        statement,
                        "Expected the producer bind-group guard to rebuild it.",
                    );
                }
                return [];
            }
            return undefined;
        }
        return undefined;
    }

    /** `const decision = decideScreenSpaceReset({...})`, field by field. */
    private lowerDecision(initializer: ts.Expression, indent: string): string[] {
        if (
            !ts.isCallExpression(initializer) ||
            initializer.expression.getText(this.file) !== "decideScreenSpaceReset" ||
            initializer.arguments.length !== 1
        ) {
            this.context.contractError(initializer, "Expected decideScreenSpaceReset(event).");
        }
        const event = this.context.unwrapExpression(initializer.arguments[0]!);
        if (!ts.isObjectLiteralExpression(event)) {
            this.context.contractError(event, "Expected an event object literal.");
        }
        const fields = new Map(RESET_EVENT_MEMBERS);
        const lines = [`${indent}ScreenSpaceResetEvent reset_event{};`];
        for (const property of event.properties) {
            if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
                this.context.contractError(property, "Expected a named event field.");
            }
            const native = fields.get(property.name.text);
            if (!native) {
                this.context.contractError(
                    property,
                    `The reset event carries '${property.name.text}', which ` +
                        "this port does not know.",
                );
            }
            if (property.name.text === "cameraMoved") {
                // Never read by the pin's decision (asserted in
                // resetDecision), so the change key it comes from is not
                // translated; the field keeps the pin's own default.
                this.context.assertExpressionShape(
                    property.initializer,
                    "moved",
                    "the camera motion event",
                );
                continue;
            }
            const value = this.context.unwrapExpression(property.initializer);
            const lowered =
                value.kind === ts.SyntaxKind.FalseKeyword
                    ? "false"
                    : this.boolean.expression(value);
            lines.push(`${indent}reset_event.${native} = ${lowered};`);
        }
        lines.push(
            `${indent}const ScreenSpaceResetDecision reset_decision = ` +
                "decide_screen_space_reset(reset_event);",
        );
        this.bindings.set("decision.invalidateHistory", {
            cpp: "reset_decision.invalidate_history",
            type: "bool",
        });
        this.bindings.set("decision.restartPhase", {
            cpp: "reset_decision.restart_phase",
            type: "bool",
        });
        return lines;
    }

    /** The producer pass: raw target cleared, one draw, read by the backend. */
    private assertProducerPass(initializer: ts.Expression): void {
        if (
            !ts.isCallExpression(initializer) ||
            initializer.expression.getText(this.file) !==
                "engine._currentEncoder.beginRenderPass" ||
            initializer.arguments.length !== 1
        ) {
            this.context.contractError(initializer, "Expected beginRenderPass(descriptor).");
        }
        const descriptor = this.context.unwrapExpression(initializer.arguments[0]!);
        if (!ts.isObjectLiteralExpression(descriptor)) {
            this.context.contractError(descriptor, "Expected a pass descriptor literal.");
        }
        const attachments = this.context.unwrapExpression(
            this.context.propertyInitializer(descriptor, "colorAttachments"),
        );
        if (!ts.isArrayLiteralExpression(attachments) || attachments.elements.length !== 1) {
            this.context.contractError(attachments, "Expected one colour attachment.");
        }
        const attachment = this.context.unwrapExpression(attachments.elements[0]!);
        if (!ts.isObjectLiteralExpression(attachment)) {
            this.context.contractError(attachment, "Expected an attachment literal.");
        }
        this.context.assertExpressionShape(
            this.context.propertyInitializer(attachment, "view"),
            "raw._colorView!",
            "the producer target",
        );
        this.context.assertExpressionShape(
            this.context.propertyInitializer(attachment, "loadOp"),
            '"clear"',
            "the producer load op",
        );
    }

    /**
     * A statement the backend owns in either body -- the block upload or a
     * `pass.*` call -- asserted and named, or undefined for anything else.
     * The producer and the resolve upload through differently named
     * buffers and draw the same fullscreen triangle.
     */
    private recogniseDeviceCall(
        expression: ts.Expression,
        file: ts.SourceFile,
        upload: { buffer: string; data: string },
        drawLabel: string,
    ): "upload" | "pass" | undefined {
        if (!ts.isCallExpression(expression)) return undefined;
        const callee = expression.expression.getText(file);
        if (callee === "engine._device.queue.writeBuffer") {
            this.assertUpload(expression, file, upload.buffer, upload.data);
            return "upload";
        }
        if (!callee.startsWith("pass.")) return undefined;
        if (callee === "pass.draw") {
            this.context.assertExpressionShape(expression, "pass.draw(3)", drawLabel);
        }
        return "pass";
    }

    private assertUpload(
        call: ts.CallExpression,
        file: ts.SourceFile,
        buffer: string,
        data: string,
    ): void {
        if (
            call.arguments.length !== 3 ||
            call.arguments[0]!.getText(file) !== buffer ||
            call.arguments[1]!.getText(file) !== "0" ||
            !this.context.unwrapExpression(call.arguments[2]!).getText(file).startsWith(data)
        ) {
            this.context.contractError(
                call,
                `Expected the upload of ${data} through ${buffer} at offset 0.`,
            );
        }
    }

    /**
     * `const draws = 1 + owner.resolve({...})`: the temporal owner's own
     * `resolve`, inlined with the call's inputs bound in the caller's scope.
     */
    private lowerResolveCall(initializer: ts.Expression, indent: string): string[] {
        if (
            !ts.isBinaryExpression(initializer) ||
            initializer.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
            initializer.left.getText(this.file) !== "1"
        ) {
            this.context.contractError(initializer, "Expected 1 + owner.resolve({...}).");
        }
        const call = this.context.unwrapExpression(initializer.right);
        if (
            !ts.isCallExpression(call) ||
            call.expression.getText(this.file) !== "owner.resolve" ||
            call.arguments.length !== 1
        ) {
            this.context.contractError(call, "Expected owner.resolve(inputs).");
        }
        const inputs = this.context.unwrapExpression(call.arguments[0]!);
        if (!ts.isObjectLiteralExpression(inputs)) {
            this.context.contractError(inputs, "Expected a resolve inputs literal.");
        }
        const lines: string[] = [];
        const resolveBindings = new Map<string, PinnedBinding>([
            ["uniformData", { cpp: "decision.temporal_uniforms", type: "f32", mutable: true }],
            ["prevViewProj", { cpp: "state.prev_view_proj", type: "f32", mutable: true }],
            ["prevView", { cpp: "state.prev_view", type: "f32", mutable: true }],
        ]);
        const matrices = new Set(["invViewProj", "viewMatrix", "viewProjMatrix"]);
        const textures = new Set(["rawTexture", "depthTexture"]);
        for (const property of inputs.properties) {
            let name: string;
            let value: ts.Expression;
            if (ts.isShorthandPropertyAssignment(property)) {
                name = property.name.text;
                value = property.name;
            } else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
                name = property.name.text;
                value = property.initializer;
            } else {
                return this.context.contractError(property, "Expected a named resolve input.");
            }
            if (textures.has(name)) continue;
            const lowered = this.numeric.expression(value);
            if (matrices.has(name)) {
                resolveBindings.set(`inputs.${name}`, { cpp: lowered, type: "f32" });
                continue;
            }
            const temporary = `resolve_${name}`;
            lines.push(`${indent}const double ${temporary} = ${lowered};`);
            resolveBindings.set(`inputs.${name}`, { cpp: temporary, type: "scalar" });
        }
        const { file, declaration: method } = this.owner.resolveMethod();
        // An input the call site omits takes the pin's own `?? <literal>`
        // default, read off the resolve body: the GI task passes no spatial
        // radius or phase, and what the resolve then writes is the pin's
        // literal rather than a value restated here.
        for (const candidate of this.context.findNodes(method, ts.isBinaryExpression)) {
            const split = this.context.nullishDefault(candidate);
            if (!split) continue;
            const key = split.left.getText(file);
            if (!key.startsWith("inputs.") || resolveBindings.has(key)) continue;
            const literal = this.context.unwrapExpression(split.right);
            if (!ts.isNumericLiteral(literal)) {
                this.context.contractError(
                    literal,
                    `Expected the resolve default of ${key} to be a number.`,
                );
            }
            resolveBindings.set(key, {
                cpp: doubleLiteral(Number(literal.text)),
                type: "scalar",
            });
        }
        const resolveScope = this.scope(resolveBindings);
        const resolver = new PinnedNumericLowerer(file, {
            ...resolveScope,
            returnValue: () => this.context.contractError(method, "resolve returns"),
        });
        for (const statement of method.body.statements) {
            const recognised = this.recogniseResolve(statement, file);
            if (recognised) continue;
            lines.push(...resolver.statement(statement, indent));
        }
        return lines;
    }

    /** The resolve statements the backend owns, asserted and skipped. */
    private recogniseResolve(statement: ts.Statement, file: ts.SourceFile): boolean {
        if (ts.isVariableStatement(statement)) {
            const declaration = statement.declarationList.declarations[0];
            if (!declaration || !ts.isIdentifier(declaration.name) || !declaration.initializer) {
                return false;
            }
            const name = declaration.name.text;
            const initializer = this.context.unwrapExpression(declaration.initializer);
            if (name.endsWith("IdentityChanged")) {
                if (!this.context.hasCall(initializer, "identityChanged")) {
                    this.context.contractError(initializer, "Expected an identityChanged test.");
                }
                return true;
            }
            if (name === "pass") {
                this.context.assertExpressionShape(
                    initializer,
                    "engine._currentEncoder.beginRenderPass(renderPassDescriptor)",
                    "the resolve pass",
                );
                return true;
            }
            if (name === "draws") {
                this.context.assertExpressionShape(
                    initializer,
                    "1 + (historyCopy.execute?.() ?? 0)",
                    "the history copy",
                );
                return true;
            }
            return false;
        }
        if (ts.isExpressionStatement(statement)) {
            const expression = this.context.unwrapExpression(statement.expression);
            if (
                this.recogniseDeviceCall(
                    expression,
                    file,
                    { buffer: "uniformBuffer!", data: "uniformData" },
                    "the resolve triangle draw",
                )
            ) {
                return true;
            }
            if (
                ts.isBinaryExpression(expression) &&
                expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                expression.left.getText(file) === "renderPassDescriptor.colorAttachments"
            ) {
                const text = expression.right.getText(file);
                if (!text.includes("stable._colorView!") || !text.includes('loadOp: "clear"')) {
                    this.context.contractError(
                        expression,
                        "Expected the resolve pass to clear into the stable target.",
                    );
                }
                return true;
            }
            return false;
        }
        if (ts.isIfStatement(statement)) {
            if (statement.expression.getText(file).includes("bindGroup")) {
                if (!this.context.hasCall(statement.thenStatement, "rebuildBindGroup")) {
                    this.context.contractError(
                        statement,
                        "Expected the resolve bind-group guard to rebuild it.",
                    );
                }
                return true;
            }
            return false;
        }
        if (ts.isReturnStatement(statement)) {
            if (statement.expression?.getText(file) !== "draws") {
                this.context.contractError(statement, "Expected resolve to return draws.");
            }
            return true;
        }
        return false;
    }

}

/** One deployed producer or resolve stage: a composed stage under its stem. */
export interface ScreenSpaceStageRow {
    wgsl: string;
    stem: string;
    vertexEntry: string;
    fragmentEntry: string;
    uniformBytes: number;
    targetFormat: string;
    bindings: readonly ScreenSpaceStageBinding[];
}

/** The generated `screen_space_shaders.hpp`: the deployed stages' table. */
export function screenSpaceShadersHeader(
    provenance: string,
    stages: readonly ScreenSpaceStageRow[],
): CppModule {
    const cpp = new CppDefinitions();
    const roleName = (role: ScreenSpaceStageBinding["role"]): string => {
        switch (role) {
            case "depth":
                return "depth";
            case "source-color":
                return "source_color";
            case "raw":
                return "raw";
            case "history":
                return "history";
            case "stable":
                return "stable";
            default:
                return "none";
        }
    };
    const kindName = (kind: ScreenSpaceStageBinding["kind"]): string =>
        kind === "depth-texture" ? "depth_texture" : kind;
    const tables = stages
        .map(
            (stage, index) =>
                `inline constexpr std::array<ScreenSpaceStageBinding, ${stage.bindings.length}u>\n` +
                `    screen_space_bindings_${index}{{\n` +
                stage.bindings
                    .map(
                        (binding) =>
                            `    ScreenSpaceStageBinding{${binding.binding}u, ` +
                            `${stringLiteral(binding.name)}, ` +
                            `ScreenSpaceBindingKind::${kindName(binding.kind)}, ` +
                            `ScreenSpaceTextureRole::${roleName(binding.role)}},`,
                    )
                    .join("\n") +
                `\n}};`,
        )
        .join("\n");
    const rows = stages
        .map(
            (stage, index) =>
                `    ScreenSpaceShaderInfo{${stringLiteral(stage.stem)}, ` +
                `${stringLiteral(stage.vertexEntry)}, ` +
                `${stringLiteral(stage.fragmentEntry)}, ` +
                `${stage.uniformBytes}u, ` +
                `${nativeTextureFormat(stage.targetFormat, stage.stem)}, ` +
                `screen_space_bindings_${index}.data(), ` +
                `screen_space_bindings_${index}.size()},`,
        )
        .join("\n");
    return cpp.finish(`// ${provenance}
#pragma once

#include <bblite/runtime.hpp>

#include <array>
#include <cstddef>
#include <cstdint>

namespace bbl::upstream {

enum class ScreenSpaceBindingKind {
    depth_texture,
    texture,
    sampler,
    uniform,
};

/** Which frame-graph texture a stage binding reads. */
enum class ScreenSpaceTextureRole {
    none,
    depth,
    source_color,
    raw,
    history,
    stable,
};

struct ScreenSpaceStageBinding {
    /** The pin's own group-0 binding index. */
    std::uint32_t binding;
    /** The identifier the pin declared, which the SDL_GPU sidecar names. */
    const char* name;
    ScreenSpaceBindingKind kind;
    ScreenSpaceTextureRole role;
};

/** One deployed producer or resolve stage. */
struct ScreenSpaceShaderInfo {
    const char* stem;
    const char* vertex_entry;
    const char* fragment_entry;
    std::uint32_t uniform_bytes;
    TextureFormatClass target_format;
    const ScreenSpaceStageBinding* bindings;
    std::size_t binding_count;
};

${cpp.privateCode(tables)}

${cpp.table("ScreenSpaceShaderInfo", "screen_space_shader_infos", stages.length, rows)}

} // namespace bbl::upstream
`);
}
