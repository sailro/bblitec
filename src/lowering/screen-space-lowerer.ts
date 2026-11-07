import type { PinnedCallSpelling } from "./pinned-numeric-lowerer.js";
import ts from "typescript";
import { CppDefinitions, type CppModule } from "../cpp-definitions.js";
import {
    SCREEN_SPACE_KINDS,
    SCREEN_SPACE_SCALAR_SETTINGS,
    SCREEN_SPACE_TEMPORAL_MODULE,
    nativeSettingName,
    screenSpaceFacts,
    screenSpaceReadsLightDirection,
    type ComposedScreenSpaceTask,
    type ScreenSpaceKindFacts,
    type ScreenSpaceTextureRef,
} from "../pinned-screen-space.js";
import {
    plannedLayoutEntryCpp,
    type PlannedLayoutEntry,
} from "../recording-engine.js";
import type { ScreenSpaceTaskManifest } from "../compiler/types.js";
import { doubleLiteral, stringLiteral } from "../cpp-literals.js";
import { LoweredSource, LoweringContext } from "./context.js";
import { pinnedErrorCode, pinnedErrorMessageCpp } from "./pinned-error.js";

import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { nativeTextureFormat } from "./post-process-lowerer.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    lowerMat4InvertCpp,
    lowerObjectComponents,
    lowerPackMat4IntoF32FastPathCpp,
    lowerPinnedFunction,
    PINNED_CAMERA_CALLS,
    PINNED_FLOAT_ARRAY_METHODS,
} from "./pinned-function-lowerer.js";
import { recordAt } from "../compiler/record-access.js";
import { sameSource, isOneOfSources } from "../compiler/syntax.js";

const TEMPORAL_MODULE = SCREEN_SPACE_TEMPORAL_MODULE;
const TEMPORAL_OWNER = "createScreenSpaceTemporalOwner";

/** The pass label the shared temporal owner encodes its resolve under. */
const RESOLVE_LABEL = "resolve";

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
 * The closure state a factory keeps between frames, the literal each
 * starts from and the native member holding it: the pin's
 * `let firstFrame = true` is `bool first_frame = true`, whose default the
 * native record restates. A member the effects spell differently lists
 * every spelling; each factory declares exactly one. Asserted against the
 * factory body so a changed starting value fails generation; a `let`
 * without an initializer starts at `undefined`.
 */
const STATE_MEMBERS: readonly {
    spellings: readonly string[];
    literal: string;
    binding: PinnedBinding;
}[] = [
    {
        spellings: ["firstFrame"],
        literal: "true",
        binding: { cpp: "state.first_frame", type: "bool" },
    },
    {
        spellings: ["pendingReallocation"],
        literal: "false",
        binding: { cpp: "state.pending_reallocation", type: "bool" },
    },
    {
        spellings: ["lastEnabled"],
        literal: "undefined",
        binding: { cpp: "state.last_enabled", type: "bool" },
    },
    {
        spellings: ["lastResetVersion"],
        literal: "undefined",
        binding: { cpp: "state.last_reset_version", type: "scalar" },
    },
    {
        spellings: ["accumulatedSamples"],
        literal: "1",
        binding: { cpp: "state.accumulated_samples", type: "scalar" },
    },
    {
        spellings: ["phaseIndex"],
        literal: "0",
        binding: { cpp: "state.phase_index", type: "scalar" },
    },
    {
        spellings: ["prevInvViewProjNull", "previousInverseWasSingular"],
        literal: "false",
        binding: { cpp: "state.prev_inv_view_proj_null", type: "bool" },
    },
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

/** One reached task, with the table rows generation assigned it. */
export interface ScreenSpaceLoweringInput {
    manifest: ScreenSpaceTaskManifest;
    composed: ComposedScreenSpaceTask;
    /** Its row in the generated `screen_space_plan_infos` table. */
    plan: number;
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

/** One reached effect: its table row and the passes its tasks encode. */
interface ReachedEffect extends ScreenSpaceKindFacts {
    intrinsic: string;
    /** The dedicated pass labels of an enabled frame, the resolve last. */
    labels: readonly string[];
    readsLightDirection: boolean;
}

/**
 * One uniform block a dedicated pass uploads, read off the pinned bodies:
 * the typed array the pin fills, the buffer it writes that array through
 * and the module constant sizing it.
 */
interface StageBlock {
    /** The pass the buffer's label names (`producer`, `blur-horizontal`). */
    label: string;
    data: string;
    buffer: string;
    floats: number;
}

/**
 * The screen-space effects, lowered from their own modules.
 *
 * What the pin decides at run time -- the temporal state machine of
 * `execute`, the reset matrix, the accumulation ramp, the uniform blocks
 * and the composite's writer -- is translated from the pinned ASTs into one
 * generated frame function per effect. What the pin decides at creation --
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
                this.compositeWriterBody(
                    task.composed.intrinsic,
                    "            ",
                ),
            );
        }
        return writers;
    }

    public lowerTaskRecords(): LoweredSource {
        const effects = this.effects();
        return {
            modulePath: effects[0]!.module,
            symbolName: effects.map((effect) => effect.intrinsic).join(","),
            header: this.header(),
            source: this.source(),
        };
    }

    private effectCache: ReachedEffect[] | undefined;

    /**
     * The reached effects in table order. Every task of one effect encodes
     * the same dedicated passes -- the frame function lowered once per
     * effect walks them in that order -- which is asserted here.
     */
    private effects(): ReachedEffect[] {
        if (this.effectCache) return this.effectCache;
        const effects: ReachedEffect[] = [];
        for (const [intrinsic, facts] of Object.entries(SCREEN_SPACE_KINDS)) {
            const tasks = this.tasks.filter(
                (task) => task.composed.intrinsic === intrinsic,
            );
            if (tasks.length === 0) continue;
            const labels = tasks[0]!.composed.passes.map((pass) => pass.label);
            for (const task of tasks) {
                const own = task.composed.passes.map((pass) => pass.label);
                if (own.join(",") !== labels.join(",")) {
                    throw new Error(
                        `Two ${intrinsic} tasks encode different passes ` +
                            `([${labels.join(", ")}] and [${own.join(", ")}]), ` +
                            "which one lowered frame function cannot walk.",
                    );
                }
            }
            if (labels.at(-1) !== RESOLVE_LABEL) {
                throw new Error(
                    `Pinned ${intrinsic} ends its passes in '${labels.at(-1)}', ` +
                        "not the temporal resolve.",
                );
            }
            effects.push({
                ...facts,
                intrinsic,
                labels,
                readsLightDirection: screenSpaceReadsLightDirection(intrinsic),
            });
        }
        this.effectCache = effects;
        return effects;
    }

    private effect(intrinsic: string): ReachedEffect {
        const found = this.effects().find(
            (effect) => effect.intrinsic === intrinsic,
        );
        if (!found) {
            throw new Error(`No reached task was created by ${intrinsic}.`);
        }
        return found;
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
 * live settings, advances the temporal state and fills every uniform block.
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
        const effects = this.effects();
        const provenance = this.context.provenance(
            effects[0]!.module,
            effects[0]!.intrinsic,
            [
                ...effects
                    .slice(1)
                    .map((effect) => `${effect.module}#${effect.intrinsic}`),
                `${TEMPORAL_MODULE}#${TEMPORAL_OWNER}`,
            ].join(", "),
        );
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
#include <string>
#include <utility>

namespace bbl::upstream {

${this.uniformSizeContract()}

namespace {

${lowerMat4InvertCpp(this.context)}

${lowerPackMat4IntoF32FastPathCpp(this.context)}

${this.clampHelper()}

${this.temporalHelpers()}

${this.resetDecision()}
${effects.some((effect) => effect.readsLightDirection) ? `\n${this.lightDirection()}\n` : ""}
${this.refreshComposite()}
${effects.map((effect) => this.frameFunction(effect)).join("\n")}
} // namespace

${this.scaledSize()}

ScreenSpaceFrameDecision screen_space_frame(
    Engine& engine,
    TaskHandle handle,
    const ScreenSpaceFrameInputs& inputs) {
    if (handle.value >= engine.frame_tasks.size()) {
        throw std::runtime_error("Invalid screen-space task handle.");
    }
    FrameTaskRecord& record = ${recordAt("engine.frame_tasks", "handle")};
    if (record.kind != FrameTaskKind::screen_space) {
        throw std::runtime_error(
            "A frame task that is not a screen-space effect was run as one.");
    }
    ScreenSpaceTaskOptions& task = record.screen_space;
    ScreenSpaceTemporalState& state = task.state;
    // The pin's record(): it resizes every target it owns between its
    // passes whenever the depth source's scaled extent changed, and flags
    // the reallocation for execute; its temporal owner does the same for
    // the stable/history pair. The backend sized and built those targets,
    // all of them in one rebuild, so a changed allocation is that event.
    if (inputs.intermediate_allocation != state.seen_intermediate_allocation) {
        state.seen_intermediate_allocation = inputs.intermediate_allocation;
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
${effects
    .map(
        (effect) =>
            `        case ScreenSpaceEffectKind::${effect.enumerator}:\n` +
            `            return ${effect.frameFunction}(engine, record, task, inputs);\n`,
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
     * The uniform blocks one effect's frame uploads, in its pass order:
     * each dedicated pass's buffer is created under `${name}-<pass>-uniforms`
     * and written from one typed array through
     * `queue.writeBuffer(buffer!, 0, data)`. The factory's own passes are
     * read off its `execute` and closure; the resolve's off the temporal
     * owner's `resolve`. Each array's `new F32(<constant>)` sizes it.
     */
    private stageBlocks(effect: ReachedEffect): StageBlock[] {
        const own = this.blocksOf(
            effect.module,
            effect.intrinsic,
            this.taskMethod(effect.intrinsic, "execute").declaration.body,
        );
        const resolve = this.blocksOf(
            TEMPORAL_MODULE,
            TEMPORAL_OWNER,
            this.resolveMethod().declaration.body,
        );
        const blocks = [...own, ...resolve];
        const labels = blocks.map((block) => block.label);
        if (labels.join(",") !== effect.labels.join(",")) {
            throw new Error(
                `Pinned ${effect.intrinsic} uploads blocks for ` +
                    `[${labels.join(", ")}] where it encodes ` +
                    `[${effect.labels.join(", ")}].`,
            );
        }
        return blocks;
    }

    private blocksOf(
        module: string,
        symbol: string,
        body: ts.Block,
    ): StageBlock[] {
        const { file, declaration } = this.context.functionDeclaration(
            module,
            symbol,
        );
        // `<buffer> = device.createBuffer({ label: \`${name}-<pass>-uniforms\` })`
        const buffers = new Map<string, string>();
        for (const assignment of this.context.findNodes(
            declaration,
            ts.isBinaryExpression,
        )) {
            if (
                assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
                !ts.isIdentifier(assignment.left)
            )
                continue;
            const call = this.context.unwrapExpression(assignment.right);
            if (
                !ts.isCallExpression(call) ||
                this.context.propertyPath(call.expression)?.at(-1) !==
                    "createBuffer"
            )
                continue;
            const descriptor = this.context.unwrapExpression(
                call.arguments[0]!,
            );
            if (!ts.isObjectLiteralExpression(descriptor)) {
                this.context.contractError(call, "Expected a buffer literal.");
            }
            const label = this.context.unwrapExpression(
                this.context.propertyInitializer(descriptor, "label"),
            );
            const span = ts.isTemplateExpression(label)
                ? label.templateSpans[0]
                : undefined;
            const suffix = span?.literal.text;
            if (
                !ts.isTemplateExpression(label) ||
                label.head.text !== "" ||
                label.templateSpans.length !== 1 ||
                !span ||
                !sameSource(span.expression, "name") ||
                !suffix?.startsWith("-") ||
                !suffix.endsWith("-uniforms")
            ) {
                this.context.contractError(
                    label,
                    "Expected a uniform buffer labelled `${name}-<pass>-uniforms`.",
                );
            }
            buffers.set(
                assignment.left.text,
                suffix.slice(1, -"-uniforms".length),
            );
        }
        const blocks: StageBlock[] = [];
        for (const call of this.context.findNodes(body, ts.isCallExpression)) {
            if (
                this.context.propertyPath(call.expression)?.join(".") !==
                "engine._device.queue.writeBuffer"
            )
                continue;
            const [target, offset, source] = call.arguments.map((argument) =>
                this.context.unwrapExpression(argument),
            );
            const buffer =
                target && ts.isIdentifier(target) ? target.text : undefined;
            const data =
                source && ts.isIdentifier(source) ? source.text : undefined;
            const label =
                buffer === undefined ? undefined : buffers.get(buffer);
            if (
                call.arguments.length !== 3 ||
                !offset ||
                !sameSource(offset, "0") ||
                buffer === undefined ||
                data === undefined ||
                label === undefined
            ) {
                this.context.contractError(
                    call,
                    "Expected a whole-block upload of one typed array " +
                        "through a uniform buffer the closure created.",
                );
            }
            const allocations = this.context.findNodes(
                declaration,
                (node): node is ts.VariableDeclaration =>
                    ts.isVariableDeclaration(node) &&
                    ts.isIdentifier(node.name) &&
                    node.name.text === data,
            );
            const allocation =
                allocations.length === 1 && allocations[0]!.initializer
                    ? this.context.unwrapExpression(allocations[0]!.initializer)
                    : undefined;
            const size =
                allocation &&
                ts.isNewExpression(allocation) &&
                sameSource(allocation.expression, "F32") &&
                allocation.arguments?.length === 1
                    ? this.context.unwrapExpression(allocation.arguments[0]!)
                    : undefined;
            if (!size || !ts.isIdentifier(size)) {
                this.context.contractError(
                    allocations[0] ?? call,
                    `Expected ${data} to be a closure's new F32(<constant>).`,
                );
            }
            blocks.push({
                label,
                data,
                buffer,
                floats: this.context.pinnedNumber(file, size.text),
            });
        }
        return blocks;
    }

    /**
     * The uniform blocks' sizes, met at both ends: each typed array's
     * pinned constant against the buffer the recording device saw the
     * factory create for that pass, and every block against the fixed rows
     * `ScreenSpaceFrameDecision` carries them in -- a block the pin grows
     * or a pass it adds fails generation here and native compilation
     * there, never a lowered write past a row.
     */
    private uniformSizeContract(): string {
        let floats = 0;
        let passes = 0;
        for (const effect of this.effects()) {
            const blocks = this.stageBlocks(effect);
            passes = Math.max(passes, blocks.length);
            for (const block of blocks) floats = Math.max(floats, block.floats);
            for (const task of this.tasks) {
                if (task.composed.intrinsic !== effect.intrinsic) continue;
                for (const [index, pass] of task.composed.passes.entries()) {
                    const expected = 4 * blocks[index]!.floats;
                    if (pass.stage.uniformBytes !== expected) {
                        throw new Error(
                            `Pinned ${effect.intrinsic} creates a ` +
                                `${pass.stage.uniformBytes}-byte '${pass.label}' block ` +
                                `where ${blocks[index]!.data} holds ${expected} bytes.`,
                        );
                    }
                }
            }
        }
        return (
            `static_assert(\n` +
            `    screen_space_max_passes >= ${passes}u,\n` +
            `    "The decision carries fewer blocks than a task's passes upload.");\n` +
            `static_assert(\n` +
            `    screen_space_max_block_floats >= ${floats}u,\n` +
            `    "A block the pin sizes does not fit one row of the decision.");`
        );
    }

    /**
     * The module-scope `CLAMP` every effect module declares. One is
     * lowered; every other reached module's must lower to the same C++
     * with its parameters bound in the same positions, so sharing one
     * native helper is the pin's arithmetic for each of them.
     */
    private clampHelper(): string {
        const lowered = this.effects().map((effect) => {
            const file = this.context.sourceFile(effect.module);
            const initializer = this.context.unwrapExpression(
                this.context.variableInitializer(file, "CLAMP"),
            );
            if (
                !ts.isArrowFunction(initializer) ||
                initializer.parameters.length !== 3 ||
                ts.isBlock(initializer.body)
            ) {
                this.context.contractError(
                    initializer,
                    "Expected CLAMP to be a three-parameter expression arrow.",
                );
            }
            const parameters = initializer.parameters.map((parameter) =>
                ts.isIdentifier(parameter.name)
                    ? parameter.name.text
                    : this.context.contractError(parameter, "CLAMP parameter"),
            );
            return { effect, file, initializer, parameters };
        });
        const first = lowered[0]!;
        const names = first.parameters;
        const body = ({
            file,
            initializer,
            parameters,
        }: (typeof lowered)[number]): string => {
            const lowerer = new PinnedNumericLowerer(file, {
                bindings: new Map(
                    parameters.map((parameter, index) => [
                        parameter,
                        { cpp: names[index]!, type: "scalar" },
                    ]),
                ),
                calls: new Map(),
            });
            return lowerer.expression(initializer.body as ts.Expression);
        };
        const expression = body(first);
        for (const other of lowered.slice(1)) {
            if (body(other) !== expression) {
                this.context.contractError(
                    other.initializer,
                    `Expected ${other.effect.module}'s CLAMP to clamp as ` +
                        `${first.effect.module}'s does.`,
                );
            }
        }
        return `// ${this.context.provenance(first.effect.module, "CLAMP")}
double screen_space_clamp(double ${names.join(", double ")}) {
    return ${expression};
}`;
    }

    /** The pure temporal helpers, lowered whole. */
    private temporalHelpers(): string {
        const calls = new Map<string, PinnedCallSpelling>();
        return [
            lowerPinnedFunction(
                this.context,
                TEMPORAL_MODULE,
                "computeTemporalWeight",
                [
                    {
                        pinned: "configuredWeight",
                        kind: "number",
                        cpp: "configured_weight",
                    },
                    {
                        pinned: "accumulatedSamples",
                        kind: "number",
                        cpp: "accumulated_samples",
                    },
                ],
                {
                    cppName: "compute_temporal_weight",
                    returns: "double",
                    calls,
                },
            ),
            lowerPinnedFunction(
                this.context,
                TEMPORAL_MODULE,
                "advanceAccumulation",
                [
                    { pinned: "current", kind: "number", cpp: "current" },
                    { pinned: "reset", kind: "boolean", cpp: "reset" },
                    {
                        pinned: "temporalSamples",
                        kind: "number",
                        cpp: "temporal_samples",
                    },
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
                    {
                        pinned: "temporalSamples",
                        kind: "number",
                        cpp: "temporal_samples",
                    },
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
        ${recordAt("engine.lights", "task.light_direction.light")}.direction;
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
        const arms = this.effects()
            .map((effect) => {
                const slots = this.compositeSlots(effect.intrinsic);
                return `        case ScreenSpaceEffectKind::${effect.enumerator}:
            if (pass.params.size() != ${slots.length}u) {
                throw std::runtime_error(
                    "A screen-space composite's parameters were resized.");
            }
${slots
    .map((slot, index) => `            write(${index}u, ${slot.native});`)
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

    /** The factory module and its entry point for an effect. */
    private factoryOf(intrinsic: string): {
        facts: ScreenSpaceKindFacts;
        module: string;
        file: ts.SourceFile;
        declaration: ts.FunctionDeclaration;
    } {
        const facts = screenSpaceFacts(intrinsic);
        const { file, declaration } = this.context.functionDeclaration(
            facts.module,
            intrinsic,
        );
        return { facts, module: facts.module, file, declaration };
    }

    /** The composite pass's one `writeUniforms`, from the factory body. */
    private compositeWriter(intrinsic: string): {
        file: ts.SourceFile;
        body: ts.Block;
    } {
        const { file, declaration } = this.context.propertyFunction(
            screenSpaceFacts(intrinsic).module,
            intrinsic,
            "writeUniforms",
            { unique: true },
        );
        return { file, body: declaration.body };
    }

    private readonly compositeSlotCache = new Map<string, CompositeSlot[]>();

    /**
     * The task fields the composite writer reads, in reading order. Each
     * becomes one parameter slot: `task.enabled ? 1 : 0` a flag the pin
     * spends through a conditional, `task.tint[0]` one lane of the triple.
     */
    private compositeSlots(intrinsic: string): CompositeSlot[] {
        const cached = this.compositeSlotCache.get(intrinsic);
        if (cached) return cached;
        const { file, body } = this.compositeWriter(intrinsic);
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
            this.context.contractError(
                body,
                "Expected the writer to read the task.",
            );
        }
        this.compositeSlotCache.set(intrinsic, slots);
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
    private compositeWriterBody(intrinsic: string, indent: string): string {
        const { file, body } = this.compositeWriter(intrinsic);
        const bindings = new Map<string, PinnedBinding>([
            ["data", { cpp: "data", type: "f32", mutable: true }],
        ]);
        for (const [slot, read] of this.compositeSlots(intrinsic).entries()) {
            bindings.set(
                read.read,
                read.boolean
                    ? { cpp: `(task.params[${slot}] != 0.0)`, type: "bool" }
                    : { cpp: `task.params[${slot}]`, type: "scalar" },
            );
        }

        return lowerPinnedBody(
            file,
            body.statements,
            {
                bindings,
                calls: new Map(),
            },
            indent,
        );
    }

    /** `computeScreenSpaceScaledSize`, whole, as the backend's sizing rule. */
    private scaledSize(): string {
        const calls = new Map<string, PinnedCallSpelling>();

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
     * exactly where the pin sets it -- after resizing the targets it owns
     * between its passes and when the owner resized the temporal pair --
     * and the viewport assertion, which an effect that asserts in record()
     * also asserts first thing in execute(), where the frame function
     * spells it.
     */
    private recordContract(): void {
        for (const effect of this.effects()) {
            const { declaration: record } = this.taskMethod(
                effect.intrinsic,
                "record",
            );
            const flagged = this.context.countNodes(
                record,
                (node) =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                    sameSource(node.left, "pendingReallocation") &&
                    node.right.kind === ts.SyntaxKind.TrueKeyword,
            );
            if (flagged !== 2 || !this.context.hasCall(record, "record")) {
                this.context.contractError(
                    record,
                    "Expected record() to flag a reallocation after resizing " +
                        "its own targets and after owner.record resized the " +
                        "temporal targets.",
                );
            }
            const { declaration: execute } = this.taskMethod(
                effect.intrinsic,
                "execute",
            );
            const asserts = (body: ts.Block): boolean => {
                const first = body.statements[0];
                return (
                    first !== undefined &&
                    ts.isExpressionStatement(first) &&
                    sameSource(first.expression, "assertFullscreenViewport()")
                );
            };
            const declared = this.viewportDeclaration(effect) !== undefined;
            if (
                asserts(record.body) !== declared ||
                asserts(execute.body) !== declared
            ) {
                this.context.contractError(
                    record,
                    declared
                        ? "Expected record() and execute() to assert the " +
                              "fullscreen viewport first."
                        : "record() or execute() asserts a viewport the " +
                              "factory does not declare.",
                );
            }
        }
    }

    /** The one method of that name an effect's factory builds on its task. */
    private taskMethod(
        intrinsic: string,
        name: string,
    ): {
        file: ts.SourceFile;
        declaration: ts.FunctionLikeDeclarationBase & { body: ts.Block };
    } {
        return this.context.propertyFunction(
            screenSpaceFacts(intrinsic).module,
            intrinsic,
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
            TEMPORAL_OWNER,
            "resolve",
            { unique: true },
        );
    }

    /**
     * The factory's own `assertFullscreenViewport`, when it declares one:
     * ambient occlusion reconstructs positions over the whole depth source,
     * so it refuses a camera drawing a sub-rectangle at creation, in
     * record() and in execute().
     */
    private viewportDeclaration(
        effect: ReachedEffect,
    ):
        | { file: ts.SourceFile; declaration: ts.FunctionDeclaration }
        | undefined {
        const { file, declaration } = this.factoryOf(effect.intrinsic);
        const statements: readonly ts.Statement[] =
            declaration.body?.statements ?? [];
        const found = statements.filter(
            (statement): statement is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(statement) &&
                statement.name?.text === "assertFullscreenViewport",
        );
        if (found.length > 1) {
            this.context.contractError(
                declaration,
                "Expected at most one assertFullscreenViewport.",
            );
        }
        return found[0] ? { file, declaration: found[0] } : undefined;
    }

    /** The native spelling of an effect's viewport assertion, if it has one. */
    private viewportCheckName(effect: ReachedEffect): string | undefined {
        return this.viewportDeclaration(effect)
            ? `${effect.enumerator}_assert_fullscreen_viewport`
            : undefined;
    }

    /**
     * The viewport assertion, its two statements asserted and spelled over
     * the camera record's optional `viewport` (absent on a camera drawing
     * the whole target, exactly where the pin's is undefined). The message
     * is the pin's own error, decoded from its table over the task name.
     */
    private viewportCheck(effect: ReachedEffect): string | undefined {
        const found = this.viewportDeclaration(effect);
        const name = this.viewportCheckName(effect);
        if (!found || !name) return undefined;
        const { declaration } = found;
        const { declaration: factory } = this.factoryOf(effect.intrinsic);
        const camera = this.context.findNodes(
            factory,
            (node): node is ts.VariableDeclaration =>
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === "camera",
        );
        if (
            camera.length !== 1 ||
            !camera[0]!.initializer ||
            !sameSource(camera[0]!.initializer, "config.camera")
        ) {
            this.context.contractError(
                factory,
                "Expected the factory to keep config.camera as camera.",
            );
        }
        const code = pinnedErrorCode(this.context, declaration, 1);
        this.context.assertStatementShapes(
            declaration,
            declaration.body?.statements ?? [],
            `const viewport = camera.viewport;
if (viewport && (viewport.x !== 0 || viewport.y !== 0 || viewport.width !== 1 || viewport.height !== 1)) {
    ThrowLiteError(${code}, name);
}`,
            "assertFullscreenViewport",
        );
        const message = pinnedErrorMessageCpp(this.context, code, [
            { cpp: "name" },
        ]);
        return `// ${this.context.provenance(effect.module, effect.intrinsic, "assertFullscreenViewport")}
void ${name}(
    const CameraRecord& camera,
    const std::string& name) {
    const std::optional<NormalizedViewport>& viewport = camera.viewport;
    if (
        viewport &&
        (viewport->x != 0.0 || viewport->y != 0.0 || viewport->width != 1.0 ||
         viewport->height != 1.0)) {
        throw std::runtime_error(${message});
    }
}`;
    }

    /**
     * One effect's frame function, lowered from its factory's `execute`
     * with the temporal owner's `resolve` inlined where the pin calls it.
     */
    private frameFunction(effect: ReachedEffect): string {
        const { file, declaration: execute } = this.taskMethod(
            effect.intrinsic,
            "execute",
        );
        const walker = new FrameWalker(
            this.context,
            this,
            effect,
            this.stageBlocks(effect),
            this.viewportCheckName(effect),
            file,
        );
        const lines = walker.lowerExecute(execute.body.statements);
        return `${this.viewportCheck(effect) ?? ""}
// ${this.context.provenance(effect.module, effect.intrinsic, "execute")}
ScreenSpaceFrameDecision ${effect.frameFunction}(
    Engine& engine,
    FrameTaskRecord& record,
    ScreenSpaceTaskOptions& task,
    const ScreenSpaceFrameInputs& inputs) {
    ScreenSpaceTemporalState& state = task.state;
    ScreenSpaceFrameDecision decision{};
    const CameraRecord& camera = ${recordAt("engine.cameras", "task.camera")};
${
    this.context.hasCall(execute, "getCameraPosition")
        ? `    // The pin reads the camera's stored world matrix for its view, its
    // view-projection and its position alike; composed once here, the
    // three reads below take the same lanes the separate builders would.
    const std::array<CameraMatrixScalar, 16> camera_world =
        camera_world_matrix(camera);
`
        : ""
}${
            effect.readsLightDirection
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
     * settings and table rows generation settled for it.
     */
    private sharedFactory(): string {
        for (const effect of this.effects()) {
            const { declaration } = this.factoryOf(effect.intrinsic);
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
                            sameSource(node.expression, shape),
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
    /** The targets it owns between its passes, by intermediate index. */
    std::vector<TextureFormatClass> intermediate_formats;
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
        ${recordAt("engine.render_targets", "options.source")};
    RenderTargetRecord& depth = ${recordAt("engine.render_targets", "options.depth")};
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
    // The dedicated passes bind the depth attachment through a depth-only
    // view.
    depth.sampled_depth = true;
    // The targets the factory owns between its passes and the temporal
    // owner's stable/history pair, sized from the depth source at the
    // pin's own rounding. Creating one can grow the record table, so
    // nothing above is read past here.
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
    for (const TextureFormatClass format : plan.intermediate_formats) {
        options.intermediates.push_back(owned(format));
    }
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
    return append_frame_task(engine, std::move(task));
}`;
    }

    /** One task's own factory: the settings the pin clamped at creation. */
    private taskFactory(task: ScreenSpaceLoweringInput): string {
        const { composed, manifest } = task;
        const effect = this.effect(composed.intrinsic);
        const { module, file, declaration } = this.factoryOf(effect.intrinsic);
        this.assertFactoryState(effect, declaration, file);
        // Every key the scene wrote reaches the pin's config, so the set is
        // checked against the config the pin declares: a renamed setting
        // would otherwise take its default silently.
        this.context.assertSuppliedOptions(
            module,
            effect.configType,
            [
                "sourceTexture",
                "camera",
                ...(manifest.hasDepthTexture ? ["depthTexture"] : []),
                ...(manifest.hasTarget ? ["targetTexture"] : []),
                ...(manifest.name !== undefined ? ["name"] : []),
                ...(effect.readsLightDirection ? ["lightDirection"] : []),
                ...Object.keys(manifest.options),
            ],
            "any-optional",
        );
        const name = manifest.name ?? this.pinnedDefault(declaration, "name");
        const composition =
            manifest.options.composition ??
            this.pinnedDefault(declaration, "composition");
        if (typeof composition !== "string") {
            this.context.contractError(
                declaration,
                "composition must be a string.",
            );
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
                        .map((lane: unknown, index) => {
                            if (typeof lane !== "number") {
                                this.context.contractError(
                                    declaration,
                                    `Pinned setting '${field}' requires numeric lanes.`,
                                );
                            }
                            return `    options.${native}[${index}] = ${doubleLiteral(lane)};`;
                        })
                        .join("\n");
                }
                if (typeof value !== "number") {
                    this.context.contractError(
                        declaration,
                        `Pinned setting '${field}' requires a number.`,
                    );
                }
                return `    options.${native} = ${doubleLiteral(value)};`;
            })
            .join("\n");
        if (
            composed.composite &&
            (composed.composite.extraTextures.length !== 1 ||
                composed.composite.extraTextures[0]?.role !== "stable")
        ) {
            throw new Error(
                `Pinned ${composed.intrinsic} composites over [${composed.composite.extraTextures
                    .map((texture) => texture.role)
                    .join(
                        ", ",
                    )}], where this port binds the stable target alone.`,
            );
        }
        const resolve = composed.passes.at(-1)!;
        const viewport = this.viewportCheckName(effect);
        return `${factorySignature(manifest.taskIndex)} {
    ScreenSpaceTaskOptions options;
    options.name = ${stringLiteral(name)};
    options.kind = ScreenSpaceEffectKind::${effect.enumerator};
    options.source = source;
    options.depth = depth;
    options.target = target;
    options.camera = camera;
    options.light_direction = light_direction;
    options.resolution_scale = ${doubleLiteral(composed.clamped.resolutionScale)};
    options.temporal_samples = ${doubleLiteral(composed.clamped.temporalSamples)};
${settings}
    options.plan = ${task.plan}u;
    ScreenSpaceTaskPlan plan;
    plan.intermediate_formats = {${composed.intermediates
        .map((format, index) =>
            nativeTextureFormat(format, `intermediate target ${index}`),
        )
        .join(", ")}};
    plan.stable_format = ${nativeTextureFormat(
        resolve.stage.targetFormat,
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
    composite.params.assign(${this.compositeSlots(effect.intrinsic).length}u, 0.0);
`
        : ""
}${
            viewport
                ? `    upstream::${viewport}(${recordAt("engine.cameras", "camera")}, options.name);\n`
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
        effect: ReachedEffect,
        declaration: ts.FunctionDeclaration,
        file: ts.SourceFile,
    ): void {
        const declared = (name: string): ts.VariableDeclaration[] =>
            this.context.findNodes(
                declaration,
                (node): node is ts.VariableDeclaration =>
                    ts.isVariableDeclaration(node) &&
                    ts.isIdentifier(node.name) &&
                    node.name.text === name,
            );
        for (const { spellings, literal } of STATE_MEMBERS) {
            const found = spellings.flatMap(declared);
            const initializer =
                found.length === 1
                    ? (found[0]!.initializer?.getText(file) ?? "undefined")
                    : undefined;
            if (initializer !== literal) {
                this.context.contractError(
                    declaration,
                    `Expected the factory to declare one of ` +
                        `[${spellings.join(", ")}] starting at ${literal}, ` +
                        "which the native temporal state restates.",
                );
            }
        }
        if (!effect.readsLightDirection) return;
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
        option: string,
    ): string {
        const fallbacks = this.context
            .findNodes(declaration, ts.isBinaryExpression)
            .map((node) => this.context.nullishDefault(node))
            .filter(
                (split) =>
                    split !== undefined &&
                    sameSource(split.left, `config.${option}`),
            );
        const literal = fallbacks[0]
            ? this.context.unwrapExpression(fallbacks[0].right)
            : undefined;
        if (
            fallbacks.length !== 1 ||
            !literal ||
            !ts.isStringLiteral(literal)
        ) {
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
 * translated statements filled in: each pass's block in its row of
 * `decision.stage_uniforms`, in the pin's pass order.
 */
class FrameWalker {
    private readonly bindings: Map<string, PinnedBinding>;
    private readonly numeric: PinnedNumericLowerer;
    private readonly boolean: PinnedNumericLowerer;
    /** The passes `execute` encoded itself, by label, and their locals. */
    private readonly encoded: string[] = [];
    private readonly passVariables = new Set<string>();
    private readonly uploaded = new Set<string>();
    /** The locals holding the camera change key and the motion test. */
    private cameraKey: string | undefined;
    private cameraMoved: string | undefined;

    public constructor(
        private readonly context: LoweringContext,
        private readonly owner: ScreenSpaceLowerer,
        private readonly effect: ReachedEffect,
        private readonly blocks: readonly StageBlock[],
        private readonly viewportCheck: string | undefined,
        private readonly file: ts.SourceFile,
    ) {
        this.bindings = this.executeBindings();
        const scope = this.scope(this.bindings);
        this.numeric = new PinnedNumericLowerer(file, scope);
        this.boolean = new PinnedNumericLowerer(file, {
            ...scope,
        });
    }

    /** The passes the factory encodes itself: every one before the resolve. */
    private get ownLabels(): readonly string[] {
        return this.effect.labels.slice(0, -1);
    }

    /** The row of `decision.stage_uniforms` a pass's block fills. */
    private static row(index: number): string {
        return `decision.stage_uniforms[${index}]`;
    }

    private scope(bindings: Map<string, PinnedBinding>) {
        const calls = new Map<string, PinnedCallSpelling>(PINNED_CAMERA_CALLS);

        calls.set("CLAMP", (args) => `screen_space_clamp(${args.join(", ")})`);
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
            "owner.clearIdentity",
            () => "decision.clear_identity = true",
        );
        calls.set(
            "composite.updateUniforms",
            () => "screen_space_refresh_composite(record, task)",
        );
        return {
            bindings,
            calls,
            methods: PINNED_FLOAT_ARRAY_METHODS,
            matrixCalls: new Set(["getViewProjectionMatrix", "getViewMatrix"]),
            recordCalls: new Map([["getCameraPosition", ["x", "y", "z"]]]),
            returnValue: (expression: ts.Expression | undefined) => {
                if (
                    !isOneOfSources(expression, [
                        "composite?.execute?.() ?? 0",
                        "draws + (composite?.execute?.() ?? 0)",
                    ])
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
        const scalar = (cpp: string): PinnedBinding => ({
            cpp,
            type: "scalar",
        });
        const flag = (cpp: string): PinnedBinding => ({ cpp, type: "bool" });
        const bindings = new Map<string, PinnedBinding>([
            ["enabled", flag("task.enabled")],
            ["task.enabled", flag("task.enabled")],
            ["camera", scalar("camera")],
            ["params.camera", scalar("camera")],
            ["params.temporalSamples", scalar("task.temporal_samples")],
            [
                "depthSource._width",
                scalar("static_cast<double>(inputs.depth_width)"),
            ],
            [
                "depthSource._height",
                scalar("static_cast<double>(inputs.depth_height)"),
            ],
            ["depthSource._depthTexture", scalar("inputs.depth_allocation")],
            ["source._colorTexture", scalar("inputs.color_allocation")],
            ["lastDepthTexture", scalar("state.last_depth_allocation")],
            ["lastColorTexture", scalar("state.last_color_allocation")],
            ["width", scalar("static_cast<double>(inputs.effect_width)")],
            ["height", scalar("static_cast<double>(inputs.effect_height)")],
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
                flag(
                    "(state.last_depth_allocation != inputs.depth_allocation)",
                ),
            ],
            [
                "colorIdentityChanged",
                flag(
                    "(state.last_color_allocation != inputs.color_allocation)",
                ),
            ],
            ["draws", scalar("0.0")],
        ]);
        for (const { spellings, binding } of STATE_MEMBERS) {
            for (const spelling of spellings) bindings.set(spelling, binding);
        }
        for (const [index, block] of this.blocks.slice(0, -1).entries()) {
            bindings.set(block.data, {
                cpp: FrameWalker.row(index),
                type: "f32",
                mutable: true,
            });
        }
        for (const setting of SCREEN_SPACE_SCALAR_SETTINGS) {
            bindings.set(
                `task.${setting}`,
                scalar(`task.${nativeSettingName(setting)}`),
            );
        }
        if (this.effect.readsLightDirection) {
            bindings.set("task.lightDirection", {
                cpp: "light_direction",
                type: "vec3",
            });
            bindings.set("lightDir", { cpp: "light_direction", type: "vec3" });
        }
        return bindings;
    }

    public lowerExecute(statements: readonly ts.Statement[]): string[] {
        const lines: string[] = [];
        for (const statement of statements) {
            lines.push(...this.lowerStatement(statement, "    "));
        }
        const own = this.ownLabels;
        if (
            this.encoded.join(",") !== own.join(",") ||
            !own.every((label) => this.uploaded.has(label))
        ) {
            this.context.contractError(
                this.file,
                `Expected execute to upload and encode [${own.join(", ")}] ` +
                    `before the resolve; it encoded [${this.encoded.join(", ")}].`,
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
    private recognise(
        statement: ts.Statement,
        indent: string,
    ): string[] | undefined {
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
            const initializer = this.context.unwrapExpression(
                declaration.initializer,
            );
            if (name === "invViewProj") {
                this.context.assertExpressionShape(
                    initializer,
                    "invertMat4(viewProj)",
                    "the inverse view-projection",
                );
                return [
                    `${indent}const std::optional<std::array<float, 16>> inv_view_proj = ` +
                        "mat4_invert(viewProj);",
                ];
            }
            if (
                ts.isCallExpression(initializer) &&
                sameSource(
                    initializer.expression,
                    "engine._currentEncoder.beginRenderPass",
                )
            ) {
                // One of the factory's own passes, which the backend
                // encodes in this order when the decision says the effect
                // ran; the resolve and history copy follow them.
                this.assertOwnPass(initializer);
                this.passVariables.add(name);
                return this.encoded.length === 1
                    ? [`${indent}decision.run_effect = true;`]
                    : [];
            }
            if (
                ts.isCallExpression(initializer) &&
                sameSource(initializer.expression, "_cameraChangeKey")
            ) {
                if (
                    initializer.arguments.length !== 1 ||
                    !isOneOfSources(initializer.arguments[0], [
                        "camera",
                        "params.camera",
                    ])
                ) {
                    this.context.contractError(
                        initializer,
                        "Expected the change key of the task camera.",
                    );
                }
                this.cameraKey = name;
                return [];
            }
            if (
                this.cameraKey !== undefined &&
                sameSource(initializer, `${this.cameraKey} !== lastCameraKey`)
            ) {
                this.cameraMoved = name;
                return [];
            }
            if (
                ts.isCallExpression(initializer) &&
                sameSource(initializer.expression, "decideScreenSpaceReset")
            ) {
                return this.lowerDecision(name, initializer, indent);
            }
            if (name === "draws") {
                return this.lowerResolveCall(initializer, indent);
            }
            if (
                name === "depthIdentityChanged" ||
                name === "colorIdentityChanged"
            ) {
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
            const expression = this.context.unwrapExpression(
                statement.expression,
            );
            if (
                this.viewportCheck !== undefined &&
                sameSource(expression, "assertFullscreenViewport()")
            ) {
                return [`${indent}${this.viewportCheck}(camera, task.name);`];
            }
            const device = this.recogniseDeviceCall(
                expression,
                this.blocks.slice(0, -1),
                this.passVariables,
                "the fullscreen triangle draw",
            );
            if (device) return [];
            if (
                ts.isBinaryExpression(expression) &&
                expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                sameSource(expression.left, "lastCameraKey")
            ) {
                if (
                    this.cameraKey === undefined ||
                    !sameSource(expression.right, this.cameraKey)
                ) {
                    this.context.contractError(
                        expression,
                        "Expected lastCameraKey to take this frame's key.",
                    );
                }
                return [];
            }
            return undefined;
        }
        if (ts.isIfStatement(statement) && this.isBindGroupGuard(statement)) {
            return [];
        }
        return undefined;
    }

    /**
     * `if (<identity changed> || !<group>) { rebuild<...>(); }`: the pin's
     * bind-group identity test, which a backend answers by building each
     * pass's group once per frame-graph rebuild. Recognised by its
     * consequent calling one of the factory's own rebuild functions and its
     * test reading a group that function assigns.
     */
    private isBindGroupGuard(statement: ts.IfStatement): boolean {
        const then = statement.thenStatement;
        const only =
            ts.isBlock(then) && then.statements.length === 1
                ? then.statements[0]
                : undefined;
        const call =
            only && ts.isExpressionStatement(only)
                ? this.context.unwrapExpression(only.expression)
                : undefined;
        if (
            statement.elseStatement ||
            !call ||
            !ts.isCallExpression(call) ||
            !ts.isIdentifier(call.expression) ||
            !call.expression.text.startsWith("rebuild") ||
            call.arguments.length !== 0
        ) {
            return false;
        }
        const callee = call.expression.text;
        const { declaration: factory } = this.context.functionDeclaration(
            this.effect.module,
            this.effect.intrinsic,
        );
        const rebuild = this.context.findNodes(
            factory,
            (node): node is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(node) && node.name?.text === callee,
        );
        const groups = new Set(
            rebuild.flatMap((declaration) =>
                this.context
                    .findNodes(declaration, ts.isBinaryExpression)
                    .filter(
                        (node) =>
                            node.operatorToken.kind ===
                                ts.SyntaxKind.EqualsToken &&
                            ts.isIdentifier(node.left) &&
                            this.context.hasCall(node.right, "createBindGroup"),
                    )
                    .map((node) => (node.left as ts.Identifier).text),
            ),
        );
        if (
            rebuild.length !== 1 ||
            groups.size === 0 ||
            !this.context.hasNode(
                statement.expression,
                (node) => ts.isIdentifier(node) && groups.has(node.text),
            )
        ) {
            this.context.contractError(
                statement,
                `Expected the guard around ${callee}() to test a bind group ` +
                    "that function builds.",
            );
        }
        return true;
    }

    /** `const <reset> = decideScreenSpaceReset({...})`, field by field. */
    private lowerDecision(
        name: string,
        initializer: ts.CallExpression,
        indent: string,
    ): string[] {
        if (initializer.arguments.length !== 1) {
            this.context.contractError(
                initializer,
                "Expected decideScreenSpaceReset(event).",
            );
        }
        const event = this.context.unwrapExpression(initializer.arguments[0]!);
        if (!ts.isObjectLiteralExpression(event)) {
            this.context.contractError(
                event,
                "Expected an event object literal.",
            );
        }
        const fields = new Map(RESET_EVENT_MEMBERS);
        const lines = [`${indent}ScreenSpaceResetEvent reset_event{};`];
        for (const property of event.properties) {
            // `cameraMoved,` names its local as much as `cameraMoved: moved`.
            const field =
                ts.isPropertyAssignment(property) &&
                ts.isIdentifier(property.name)
                    ? { name: property.name.text, value: property.initializer }
                    : ts.isShorthandPropertyAssignment(property)
                      ? { name: property.name.text, value: property.name }
                      : undefined;
            if (!field) {
                return this.context.contractError(
                    property,
                    "Expected a named event field.",
                );
            }
            const native = fields.get(field.name);
            if (!native) {
                this.context.contractError(
                    property,
                    `The reset event carries '${field.name}', which ` +
                        "this port does not know.",
                );
            }
            if (field.name === "cameraMoved") {
                // Never read by the pin's decision (asserted in
                // resetDecision), so the change key it comes from is not
                // translated; the field keeps the pin's own default.
                if (
                    this.cameraMoved === undefined ||
                    !sameSource(field.value, this.cameraMoved)
                ) {
                    this.context.contractError(
                        property,
                        "Expected the camera motion event to be this " +
                            "frame's change-key test.",
                    );
                }
                continue;
            }
            const value = this.context.unwrapExpression(field.value);
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
        this.numeric.bindPorts(
            [
                [
                    `${name}.invalidateHistory`,
                    {
                        cpp: "reset_decision.invalidate_history",
                        type: "bool",
                    },
                ],
                [
                    `${name}.restartPhase`,
                    {
                        cpp: "reset_decision.restart_phase",
                        type: "bool",
                    },
                ],
            ],
            initializer,
        );
        return lines;
    }

    /**
     * One of the factory's own passes: labelled `${name}-<pass>` in the
     * order composition recorded, one attachment cleared, read by the
     * backend.
     */
    private assertOwnPass(initializer: ts.CallExpression): void {
        const expected = this.ownLabels[this.encoded.length];
        if (initializer.arguments.length !== 1 || expected === undefined) {
            this.context.contractError(
                initializer,
                "Expected beginRenderPass(descriptor) for a pass composition " +
                    "recorded.",
            );
        }
        const descriptor = this.context.unwrapExpression(
            initializer.arguments[0]!,
        );
        if (!ts.isObjectLiteralExpression(descriptor)) {
            this.context.contractError(
                descriptor,
                "Expected a pass descriptor literal.",
            );
        }
        this.context.assertExpressionShape(
            this.context.propertyInitializer(descriptor, "label"),
            `\`\${name}-${expected}\``,
            `the '${expected}' pass label`,
        );
        const attachments = this.context.unwrapExpression(
            this.context.propertyInitializer(descriptor, "colorAttachments"),
        );
        if (
            !ts.isArrayLiteralExpression(attachments) ||
            attachments.elements.length !== 1
        ) {
            this.context.contractError(
                attachments,
                "Expected one colour attachment.",
            );
        }
        const attachment = this.context.unwrapExpression(
            attachments.elements[0]!,
        );
        if (!ts.isObjectLiteralExpression(attachment)) {
            this.context.contractError(
                attachment,
                "Expected an attachment literal.",
            );
        }
        const view = this.context.unwrapExpression(
            this.context.propertyInitializer(attachment, "view"),
        );
        if (
            !ts.isPropertyAccessExpression(view) ||
            view.name.text !== "_colorView" ||
            !ts.isIdentifier(view.expression)
        ) {
            this.context.contractError(
                view,
                `Expected the '${expected}' pass to draw into an owned target.`,
            );
        }
        this.context.assertExpressionShape(
            this.context.propertyInitializer(attachment, "loadOp"),
            '"clear"',
            `the '${expected}' load op`,
        );
        this.encoded.push(expected);
    }

    /**
     * A statement the backend owns in either body -- a block upload or a
     * call on one of the passes -- asserted, or undefined for anything
     * else. Every pass draws the same fullscreen triangle.
     */
    private recogniseDeviceCall(
        expression: ts.Expression,
        blocks: readonly StageBlock[],
        passes: ReadonlySet<string>,
        drawLabel: string,
    ): "upload" | "pass" | undefined {
        if (!ts.isCallExpression(expression)) return undefined;
        const callee = this.context.propertyPath(expression.expression);
        if (callee?.join(".") === "engine._device.queue.writeBuffer") {
            const [target, offset, source] = expression.arguments;
            const block = blocks.find(
                (candidate) =>
                    expression.arguments.length === 3 &&
                    this.context.expressionMatchesShape(
                        target!,
                        `${candidate.buffer}!`,
                    ) &&
                    this.context.expressionMatchesShape(offset!, "0") &&
                    this.context.expressionMatchesShape(
                        source!,
                        candidate.data,
                    ),
            );
            if (!block) {
                this.context.contractError(
                    expression,
                    "Expected the whole-block upload of one of this body's blocks.",
                );
            }
            this.uploaded.add(block.label);
            return "upload";
        }
        if (!callee || callee.length !== 2 || !passes.has(callee[0]!)) {
            return undefined;
        }
        if (callee[1] === "draw") {
            this.context.assertExpressionShape(
                expression,
                `${callee[0]}.draw(3)`,
                drawLabel,
            );
        }
        return "pass";
    }

    /**
     * `const draws = <own passes> + owner.resolve({...})`: the temporal
     * owner's own `resolve`, inlined with the call's inputs bound in the
     * caller's scope and its block written into the last row.
     */
    private lowerResolveCall(
        initializer: ts.Expression,
        indent: string,
    ): string[] {
        if (
            !ts.isBinaryExpression(initializer) ||
            initializer.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
            !ts.isNumericLiteral(initializer.left) ||
            Number(initializer.left.text) !== this.encoded.length
        ) {
            this.context.contractError(
                initializer,
                `Expected ${this.encoded.length} + owner.resolve({...}), ` +
                    "counting the passes execute encoded itself.",
            );
        }
        const call = this.context.unwrapExpression(initializer.right);
        if (
            !ts.isCallExpression(call) ||
            !sameSource(call.expression, "owner.resolve") ||
            call.arguments.length !== 1
        ) {
            this.context.contractError(call, "Expected owner.resolve(inputs).");
        }
        const inputs = this.context.unwrapExpression(call.arguments[0]!);
        if (!ts.isObjectLiteralExpression(inputs)) {
            this.context.contractError(
                inputs,
                "Expected a resolve inputs literal.",
            );
        }
        const block = this.blocks.at(-1)!;
        const lines: string[] = [];
        const resolveBindings = new Map<string, PinnedBinding>([
            [
                block.data,
                {
                    cpp: FrameWalker.row(this.blocks.length - 1),
                    type: "f32",
                    mutable: true,
                },
            ],
            [
                "prevViewProj",
                { cpp: "state.prev_view_proj", type: "f32", mutable: true },
            ],
            [
                "prevView",
                { cpp: "state.prev_view", type: "f32", mutable: true },
            ],
        ]);
        const matrices = new Set([
            "invViewProj",
            "viewMatrix",
            "viewProjMatrix",
        ]);
        const textures = new Set(["rawTexture", "depthTexture"]);
        for (const property of inputs.properties) {
            let name: string;
            let value: ts.Expression;
            if (ts.isShorthandPropertyAssignment(property)) {
                name = property.name.text;
                value = property.name;
            } else if (
                ts.isPropertyAssignment(property) &&
                ts.isIdentifier(property.name)
            ) {
                name = property.name.text;
                value = property.initializer;
            } else {
                return this.context.contractError(
                    property,
                    "Expected a named resolve input.",
                );
            }
            if (textures.has(name)) continue;
            const lowered = this.numeric.expression(value);
            if (matrices.has(name)) {
                resolveBindings.set(`inputs.${name}`, {
                    cpp: lowered,
                    type: "f32",
                });
                continue;
            }
            const temporary = `resolve_${name}`;
            lines.push(`${indent}const double ${temporary} = ${lowered};`);
            resolveBindings.set(`inputs.${name}`, {
                cpp: temporary,
                type: "scalar",
            });
        }
        const { file, declaration: method } = this.owner.resolveMethod();
        // An input the call site omits takes the pin's own `?? <literal>`
        // default, read off the resolve body: the GI task passes no spatial
        // radius or phase, and what the resolve then writes is the pin's
        // literal rather than a value restated here.
        for (const candidate of this.context.findNodes(
            method,
            ts.isBinaryExpression,
        )) {
            const split = this.context.nullishDefault(candidate);
            const path = split && this.context.propertyPath(split.left);
            if (!split || path?.[0] !== "inputs" || path.length < 2) continue;
            const key = path.join(".");
            if (resolveBindings.has(key)) continue;
            resolveBindings.set(key, {
                cpp: doubleLiteral(
                    this.context.numericValue(split.right, file),
                ),
                type: "scalar",
            });
        }
        const resolveScope = this.scope(resolveBindings);
        const resolver = new PinnedNumericLowerer(file, {
            ...resolveScope,
            returnValue: () =>
                this.context.contractError(method, "resolve returns"),
        });
        for (const statement of method.body.statements) {
            const recognised = this.recogniseResolve(statement, block);
            if (recognised) continue;
            lines.push(...resolver.statement(statement, indent));
        }
        return lines;
    }

    /** The resolve statements the backend owns, asserted and skipped. */
    private recogniseResolve(
        statement: ts.Statement,
        block: StageBlock,
    ): boolean {
        if (ts.isVariableStatement(statement)) {
            const declaration = statement.declarationList.declarations[0];
            if (
                !declaration ||
                !ts.isIdentifier(declaration.name) ||
                !declaration.initializer
            ) {
                return false;
            }
            const name = declaration.name.text;
            const initializer = this.context.unwrapExpression(
                declaration.initializer,
            );
            if (name.endsWith("IdentityChanged")) {
                if (!this.context.hasCall(initializer, "identityChanged")) {
                    this.context.contractError(
                        initializer,
                        "Expected an identityChanged test.",
                    );
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
            const expression = this.context.unwrapExpression(
                statement.expression,
            );
            if (
                this.recogniseDeviceCall(
                    expression,
                    [block],
                    new Set(["pass"]),
                    "the resolve triangle draw",
                )
            ) {
                return true;
            }
            if (
                ts.isBinaryExpression(expression) &&
                expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                sameSource(
                    expression.left,
                    "renderPassDescriptor.colorAttachments",
                )
            ) {
                const assigned = (name: string, value: string): boolean =>
                    this.context.hasNode(
                        expression.right,
                        (node) =>
                            ts.isPropertyAssignment(node) &&
                            this.context.propertyName(node.name) === name &&
                            this.context.expressionMatchesShape(
                                node.initializer,
                                value,
                            ),
                    );
                if (
                    !assigned("view", "stable._colorView!") ||
                    !assigned("loadOp", '"clear"')
                ) {
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
            if (
                this.context.hasNode(
                    statement.expression,
                    (node) =>
                        ts.isIdentifier(node) && node.text === "bindGroup",
                )
            ) {
                if (
                    !this.context.hasCall(
                        statement.thenStatement,
                        "rebuildBindGroup",
                    )
                ) {
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
            if (!sameSource(statement.expression, "draws")) {
                this.context.contractError(
                    statement,
                    "Expected resolve to return draws.",
                );
            }
            return true;
        }
        return false;
    }
}

/** One deployed dedicated stage: a composed stage under its stem. */
export interface ScreenSpaceStageRow {
    wgsl: string;
    stem: string;
    vertexEntry: string;
    fragmentEntry: string;
    uniformBytes: number;
    targetFormat: string;
    bindings: readonly PlannedLayoutEntry[];
}

/** One task's frame: its dedicated passes over the stage table. */
export interface ScreenSpacePlanRow {
    passes: readonly {
        /** The pass's row in the stage table. */
        stage: number;
        target: ScreenSpaceTextureRef;
        textures: readonly (ScreenSpaceTextureRef | undefined)[];
    }[];
    intermediateCount: number;
}

/** The native `ScreenSpaceTextureRef` of a composed one, `none` when absent. */
function textureRefCpp(texture: ScreenSpaceTextureRef | undefined): string {
    const role = (() => {
        switch (texture?.role) {
            case "depth":
                return "depth";
            case "source-color":
                return "source_color";
            case "intermediate":
                return "intermediate";
            case "history":
                return "history";
            case "stable":
                return "stable";
            case undefined:
                return "none";
        }
    })();
    const index = texture?.role === "intermediate" ? texture.index : 0;
    return `ScreenSpaceTextureRef{ScreenSpaceTextureRole::${role}, ${index}u}`;
}

/**
 * The generated `screen_space_shaders.hpp`: the deployed stages' table and
 * each task's frame plan over it.
 */
export function screenSpaceShadersHeader(
    provenance: string,
    stages: readonly ScreenSpaceStageRow[],
    plans: readonly ScreenSpacePlanRow[],
): CppModule {
    const cpp = new CppDefinitions();
    const bindingTables = stages
        .map(
            (stage, index) =>
                `inline constexpr std::array<PinnedLayoutEntry, ${stage.bindings.length}u>\n` +
                `    screen_space_bindings_${index}{{\n` +
                stage.bindings
                    .map((binding) => `    ${plannedLayoutEntryCpp(binding)},`)
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
                `screen_space_bindings_${index}},`,
        )
        .join("\n");
    const planTables = plans
        .map((plan, planIndex) => {
            const textures = plan.passes
                .map((pass, passIndex) => {
                    const stage = stages[pass.stage];
                    if (
                        !stage ||
                        stage.bindings.length !== pass.textures.length
                    ) {
                        throw new Error(
                            `Screen-space plan ${planIndex} pass ${passIndex} ` +
                                "names textures for a stage it does not match.",
                        );
                    }
                    return (
                        `inline constexpr std::array<ScreenSpaceTextureRef, ${pass.textures.length}u>\n` +
                        `    screen_space_textures_${planIndex}_${passIndex}{{\n` +
                        pass.textures
                            .map((texture) => `    ${textureRefCpp(texture)},`)
                            .join("\n") +
                        `\n}};`
                    );
                })
                .join("\n");
            const passes =
                `inline constexpr std::array<ScreenSpacePassInfo, ${plan.passes.length}u>\n` +
                `    screen_space_passes_${planIndex}{{\n` +
                plan.passes
                    .map(
                        (pass, passIndex) =>
                            `    ScreenSpacePassInfo{${pass.stage}u, ` +
                            `${textureRefCpp(pass.target)}, ` +
                            `screen_space_textures_${planIndex}_${passIndex}.data()},`,
                    )
                    .join("\n") +
                `\n}};`;
            return `${textures}\n${passes}`;
        })
        .join("\n");
    const planRows = plans
        .map(
            (plan, index) =>
                `    ScreenSpacePlanInfo{screen_space_passes_${index}.data(), ` +
                `screen_space_passes_${index}.size(), ${plan.intermediateCount}u},`,
        )
        .join("\n");
    return cpp.finish(`// ${provenance}
#pragma once

#include <bblite/pinned_layout.hpp>
#include <bblite/runtime.hpp>

#include <array>
#include <cstddef>
#include <cstdint>
#include <span>

namespace bbl::upstream {

/** Which frame-graph texture a pass binds or draws into. */
enum class ScreenSpaceTextureRole {
    none,
    depth,
    source_color,
    /** One of the targets the factory owns between its passes. */
    intermediate,
    history,
    stable,
};

struct ScreenSpaceTextureRef {
    ScreenSpaceTextureRole role;
    /** For an intermediate, its index in \`ScreenSpaceTaskOptions::intermediates\`. */
    std::uint32_t index;
};

/** One deployed dedicated stage: a producer, a blur, the resolve. */
struct ScreenSpaceShaderInfo {
    const char* stem{};
    const char* vertex_entry{};
    const char* fragment_entry{};
    std::uint32_t uniform_bytes{};
    TextureFormatClass target_format{};
    /** The pin's own group-0 layout, each entry under the identifier the SDL_GPU sidecar names. */
    std::span<const PinnedLayoutEntry> bindings;
};

/** One dedicated pass of a task's frame, in the pin's encoding order. */
struct ScreenSpacePassInfo {
    /** Its row in \`screen_space_shader_infos\`. */
    std::uint32_t stage;
    /** What it clears and draws into: an intermediate or the stable target. */
    ScreenSpaceTextureRef target;
    /** What each of the stage's bindings reads, in its binding order. */
    const ScreenSpaceTextureRef* textures;
};

/** One task's frame: its dedicated passes, the resolve last. */
struct ScreenSpacePlanInfo {
    const ScreenSpacePassInfo* passes;
    std::size_t pass_count;
    std::size_t intermediate_count;
};

${cpp.privateCode(`${bindingTables}\n${planTables}`)}

${cpp.table("ScreenSpaceShaderInfo", "screen_space_shader_infos", stages.length, rows)}

${cpp.table("ScreenSpacePlanInfo", "screen_space_plan_infos", plans.length, planRows)}

} // namespace bbl::upstream
`);
}
