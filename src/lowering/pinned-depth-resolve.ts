/**
 * `createDepthResolveTask`, executed against the recording device: the
 * module it compiles (deployed whole, as the pin hands it to WebGPU), the
 * pass it encodes, and the refusals its build throws, each read off the
 * pin's own record, execute and errors.
 *
 * Both backends encode the pass the recording shows -- a depth-only
 * attachment cleared to the recorded value and stored, the recorded
 * pipeline's compare and write, one draw of three vertices over the source's
 * depth aspect -- so a pin that changes any of it fails generation here
 * instead of drawing something else natively.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { yieldedOperands } from "../compiler/syntax.js";
import { pinnedModuleFunction } from "./pinned-shader-builders.js";
import {
    createRecordingDevice,
    RecordedTexture,
    RecordedTextureView,
    type DescriptorShapes,
} from "../recording-device.js";
import { floatLiteral } from "../cpp-literals.js";
import { pinnedMessageConcatenation } from "./pinned-error.js";
import type { PinnedUtilityModule } from "../pinned-utility-passes.js";

const depthResolveModule = "src/frame-graph/depth-resolve-task.ts";
const factory = "createDepthResolveTask";

interface DepthResolveShapes extends DescriptorShapes {
    shaderModule: { code: string };
    bindGroupLayout: {
        entries: readonly {
            binding: number;
            texture?: { sampleType?: string; multisampled?: boolean };
        }[];
    };
    renderPipeline: {
        fragment: { targets: readonly unknown[] };
        primitive: { topology: string };
        depthStencil: {
            format: string;
            depthWriteEnabled: boolean;
            depthCompare: string;
        };
    };
    bindGroup: {
        entries: readonly { binding: number; resource: unknown }[];
    };
}

interface PinnedTask {
    name: string;
    record(): void;
    execute(): number;
}

/** A pinned render target as the task reads it, over recorded textures. */
interface TargetShape {
    _descriptor: {
        samples: number;
        dFormat?: string;
        size: { width: number; height: number };
    };
    _depthTexture: RecordedTexture | null;
    _depthView: RecordedTextureView | null;
    _colorTexture: null;
    _colorView: null;
    _width: number;
    _height: number;
}

function target(
    samples: number,
    dFormat: string | undefined,
    size: { width: number; height: number },
    allocated = true,
): TargetShape {
    const texture =
        allocated && dFormat
            ? new RecordedTexture({
                  size: [size.width, size.height],
                  format: dFormat,
                  usage: 0,
                  sampleCount: samples,
              })
            : null;
    return {
        _descriptor: { samples, ...(dFormat ? { dFormat } : {}), size },
        _depthTexture: texture,
        _depthView: texture?.createView() ?? null,
        _colorTexture: null,
        _colorView: null,
        _width: allocated ? size.width : 0,
        _height: allocated ? size.height : 0,
    };
}

/** One run of the pinned factory: its task over `config`, and what the device recorded. */
function run(config: Record<string, unknown>) {
    const recording = createRecordingDevice<DepthResolveShapes>({
        producer: "depth-resolve-task",
        device: [
            "createTexture",
            "createBindGroupLayout",
            "createShaderModule",
            "createPipelineLayout",
            "createRenderPipeline",
            "createBindGroup",
        ],
        encoder: ["beginRenderPass"],
        renderPass: ["setPipeline", "setBindGroup", "draw", "end"],
    });
    const task = pinnedModuleFunction(depthResolveModule, factory)(
        config,
        { _device: recording.device, _currentEncoder: recording.encoder },
        {},
    ) as PinnedTask;
    return { task, recorder: recording.recorder };
}

const unit = { width: 1, height: 1 };

/** The pin's error for a record over `config`. */
function refusal(config: Record<string, unknown>): string {
    try {
        run(config).task.record();
    } catch (error) {
        return (error as Error).message;
    }
    throw new Error(`Pinned ${factory} no longer refuses a record it refused.`);
}

function mismatch(what: string): never {
    throw new Error(
        `Pinned ${factory} no longer ${what}, which both native passes encode.`,
    );
}

/** What the pin's record and execute of an unnamed task show. */
interface RecordedDepthResolve {
    /** The module it compiles. */
    wgsl: string;
    /** The depth its pass clears to. */
    clearDepth: number;
    /** The task's default name. */
    name: string;
}

/** The pin's recorded run, a function of the pin alone. */
let recorded: RecordedDepthResolve | undefined;

/**
 * The pin's record and execute over a multisampled source of an unnamed
 * task, after checking the rest of the pass both backends encode against
 * what they recorded.
 */
function recordedDepthResolve(): RecordedDepthResolve {
    if (recorded) return recorded;
    const source = target(4, "depth24plus-stencil8", unit);
    const resolved = target(1, "depth24plus", unit);
    const { task, recorder } = run({
        sourceTexture: source,
        targetTexture: resolved,
    });
    task.record();
    if (task.execute() !== 1) mismatch("counts one draw per execute");
    const [module, ...modules] = recorder.shaderModules;
    if (!module || modules.length > 0) mismatch("compiles one module");
    const [layout] = recorder.bindGroupLayouts;
    const entry = layout?.entries[0];
    if (
        recorder.bindGroupLayouts.length !== 1 ||
        layout?.entries.length !== 1 ||
        entry?.binding !== 0 ||
        entry.texture?.sampleType !== "depth" ||
        entry.texture.multisampled !== true
    )
        mismatch("binds one multisampled depth texture at binding 0");
    const [pipeline] = recorder.renderPipelines;
    if (
        recorder.renderPipelines.length !== 1 ||
        pipeline?.fragment.targets.length !== 0 ||
        pipeline.primitive.topology !== "triangle-list" ||
        pipeline.depthStencil.format !== "depth24plus" ||
        pipeline.depthStencil.depthWriteEnabled !== true ||
        pipeline.depthStencil.depthCompare !== "always"
    )
        mismatch(
            "draws a colour-less triangle list writing the target's depth under 'always'",
        );
    const [group] = recorder.bindGroups;
    const view = group?.entries[0]?.resource;
    if (
        group?.entries.length !== 1 ||
        !(view instanceof RecordedTextureView) ||
        view.texture !== source._depthTexture ||
        view.descriptor.aspect !== "depth-only"
    )
        mismatch("binds the source depth's depth-only view");
    const [pass, ...passes] = recorder.renderPasses;
    const attachment = pass?.descriptor.depthStencilAttachment as
        (Record<string, unknown> & { view: unknown }) | undefined;
    if (
        !pass ||
        passes.length > 0 ||
        pass.descriptor.colorAttachments.length !== 0 ||
        attachment?.view !== resolved._depthView ||
        attachment.depthLoadOp !== "clear" ||
        typeof attachment.depthClearValue !== "number" ||
        attachment.depthStoreOp !== "store" ||
        "stencilLoadOp" in attachment ||
        "stencilStoreOp" in attachment ||
        pass.draws.length !== 1 ||
        pass.draws[0]!.join() !== "3" ||
        pass.bindGroups.length !== 1 ||
        pass.bindGroups[0]!.index !== 0 ||
        !pass.ended
    )
        mismatch(
            "encodes one pass clearing and storing the target's depth, with no stencil operations, drawing three vertices",
        );
    recorded = {
        wgsl: module.code,
        clearDepth: attachment.depthClearValue,
        name: task.name,
    };
    return recorded;
}

/** The module the pin's record compiles, deployed under the `depth-resolve` stem pair. */
export function pinnedDepthResolveModule(): PinnedUtilityModule {
    return {
        stem: "depth-resolve",
        wgsl: recordedDepthResolve().wgsl,
        modulePath: depthResolveModule,
        symbolName: factory,
    };
}

/** `name: config.name ?? <default>` on the task the factory returns. */
export function pinnedDepthResolveTaskName(context: LoweringContext): string {
    const { declaration } = context.functionDeclaration(
        depthResolveModule,
        factory,
    );
    const names = context.findNodes(
        declaration,
        (node): node is ts.PropertyAssignment =>
            ts.isPropertyAssignment(node) &&
            context.propertyName(node.name) === "name",
    );
    // `??`: the config's name whenever it is present, else the literal.
    const [given, fallback, ...more] = names[0]
        ? yieldedOperands(names[0].initializer)
        : [];
    if (
        names.length !== 1 ||
        !given ||
        !fallback ||
        more.length > 0 ||
        !context.expressionMatchesShape(given.operand, "config.name") ||
        given.classes.has("nullish") ||
        !given.classes.has("falsy") ||
        !ts.isStringLiteral(fallback.operand)
    )
        return context.contractError(
            declaration,
            "Expected the depth-resolve task's name to default config.name.",
        );
    return fallback.operand.text;
}

/**
 * One pinned refusal, the message the packaged factory throws, as a C++
 * function over its holes: each sentinel the run placed in the message
 * becomes that parameter, in the order the message reads them.
 */
function refusalFunction(
    name: string,
    message: string,
    holes: readonly { sentinel: string; parameter: string; cpp: string }[],
): string {
    const pattern = new RegExp(
        holes.map((hole) => hole.sentinel.replace(/\W/g, "\\$&")).join("|"),
        "g",
    );
    const literals: string[] = [];
    const read: string[] = [];
    const quoted = new Set<string>();
    let at = 0;
    for (const match of message.matchAll(pattern)) {
        literals.push(message.slice(at, match.index));
        const hole = holes.find((each) => each.sentinel === match[0])!;
        quoted.add(hole.parameter);
        read.push(
            hole.cpp === "std::uint32_t"
                ? `std::to_string(${hole.parameter})`
                : hole.parameter,
        );
        at = match.index + match[0].length;
    }
    literals.push(message.slice(at));
    // A packaged throw keeps its arguments off the message (`#<code>`).
    const parameters = holes
        .map(
            (hole) =>
                `${quoted.has(hole.parameter) ? "" : "[[maybe_unused]] "}${hole.cpp} ${hole.parameter}`,
        )
        .join(", ");
    return `[[nodiscard]] inline std::string ${name}(${parameters}) {
    return ${pinnedMessageConcatenation(literals, read)};
}`;
}

/**
 * The header both backends' depth-resolve pass reads: the pin's build
 * refusals, in the order its build throws them, as functions of the name it
 * quotes and the extents it compares.
 */
export function pinnedDepthResolveHeader(context: LoweringContext): string {
    const quoted = "\u0001name\u0001";
    const name = {
        sentinel: quoted,
        parameter: "name",
        cpp: "const std::string&",
    };
    const extent = (sentinel: number, parameter: string) => ({
        sentinel: String(sentinel),
        parameter,
        cpp: "std::uint32_t",
    });
    const named = (config: Record<string, unknown>) => ({
        name: quoted,
        ...config,
    });
    const sourceDepth = refusal(
        named({
            sourceTexture: target(4, undefined, unit),
            targetTexture: target(1, "depth24plus", unit),
        }),
    );
    const singleSample = refusal(
        named({
            sourceTexture: target(1, "depth24plus", unit),
            targetTexture: target(1, "depth24plus", unit),
        }),
    );
    const size = refusal(
        named({
            sourceTexture: target(4, "depth24plus", {
                width: 40003,
                height: 40004,
            }),
            targetTexture: target(
                1,
                "depth24plus",
                { width: 40001, height: 40002 },
                false,
            ),
        }),
    );
    const targetDepth = refusal(
        named({
            sourceTexture: target(4, "depth24plus", unit),
            targetTexture: target(1, undefined, unit, false),
        }),
    );
    const recording = recordedDepthResolve();
    if (recording.name !== pinnedDepthResolveTaskName(context))
        throw new Error(
            `Pinned ${factory} names an unnamed task '${recording.name}', not its declared default.`,
        );
    return `#pragma once
// ${context.provenance(depthResolveModule, factory, "its build's refusals")}
#include <cstdint>
#include <string>

namespace bbl::upstream {

/** The depth the pass clears its target to before every fragment overwrites it. */
inline constexpr float depth_resolve_clear_depth = ${floatLiteral(recording.clearDepth)};

${refusalFunction("depth_resolve_source_without_depth", sourceDepth, [name])}

${refusalFunction("depth_resolve_single_sample_source", singleSample, [name])}

${refusalFunction("depth_resolve_size_mismatch", size, [
    name,
    extent(40001, "target_width"),
    extent(40002, "target_height"),
    extent(40003, "source_width"),
    extent(40004, "source_height"),
])}

${refusalFunction("depth_resolve_target_without_depth", targetDepth, [name])}

} // namespace bbl::upstream
`;
}
