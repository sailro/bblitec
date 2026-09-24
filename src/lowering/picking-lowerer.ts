import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

import {
    type PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";
import {
    pinnedNumericMathCalls,
    pinnedNumericMathCallsWithHypot,
} from "./pinned-operators.js";
import { normalizeVec3Call } from "./pinned-normalize-vec3.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { pinnedHeader } from "./pinned-header.js";
import {
    vec3MemberBindings,
    lowerMat4InvertCpp,
    lowerPinnedFunction,
    lowerTupleComponents,
} from "./pinned-function-lowerer.js";

/** The pinned modules the detailed pipeline's CPU half lives in. */
const detailedModule = "src/picking/detailed-picking.ts";
const helpersModule = "src/picking/picking-helpers.ts";
const rayModule = "src/picking/ray.ts";
const gpuPickerModule = "src/picking/gpu-picker.ts";

/**
 * A native container standing in for one of the pin's nullable typed
 * arrays: it is ABSENT when it is empty, which is the only truthiness a
 * `Float32Array | undefined` parameter is read for.
 */
function emptyIsAbsent(
    cpp: string,
    type: PinnedBinding["type"],
): PinnedBinding {
    return { cpp, type, absentCpp: `${cpp}.empty()` };
}

/** One `std::optional` member, absent when it holds nothing. */
function optionalIsAbsent(cpp: string): PinnedBinding {
    return { cpp, type: "scalar", absentCpp: `!${cpp}.has_value()` };
}

/**
 * The `PickingInfo` scalars BOTH pinned bodies read off the record, under
 * the pin's own member names. Stated once so a renamed native field
 * cannot reach one lowering and miss the other.
 */
const PICK_INFO_SCALARS: readonly [string, PinnedBinding][] = [
    ["info.faceId", { cpp: "info.face_id", type: "scalar" }],
    ["info.bu", { cpp: "info.bu", type: "scalar" }],
    ["info.bv", { cpp: "info.bv", type: "scalar" }],
    ["info._normalsInvalid", { cpp: "info.normals_invalid", type: "bool" }],
];

/** The pin's `info.ray`, which only a detailed pick fills. */
const PICK_INFO_RAY: [string, PinnedBinding] = [
    "info.ray",
    optionalIsAbsent("info.ray"),
];

/**
 * The two members `getPickedNormal` answers with directly, which are the
 * ones its returns dereference. Named so the return hook reads the pin's
 * own member text rather than sniffing the emitted C++.
 */
const PICK_INFO_NORMAL_MEMBERS: ReadonlySet<string> = new Set([
    "info.pickedNormal",
    "info.pickedNormalWorld",
]);

/** One three-lane tuple's members, keyed by the text the pin reads them
 *  through -- `normal[0]`, `ray.direction[1]`. */
function tupleMembers(name: string, cpp: string): [string, PinnedBinding][] {
    return [0, 1, 2].map((lane): [string, PinnedBinding] => [
        `${name}[${lane}]`,
        { cpp: `${cpp}[${lane}]`, type: "scalar" },
    ]);
}

/**
 * The tail of the pin's own `pickAsyncImpl`, once the readback resolved
 * to a mesh: compose the draw-time world with the selected thin-instance
 * matrix -- the identity here, since no reached scene thin-instances a
 * picked mesh -- and run the pinned solve over what the third attachment
 * carried.
 *
 * `surfaceNormalsValid` is upstream's `!hitRange.worldAdjusted`, and no
 * reached scene passes a `worldAdjustWgsl` rule (`pickAsync` refuses its
 * options object at generation), so the pass never adjusts a world and
 * the CPU normals are always valid.
 */
const DETAILED_CONTINUATION = `    if (info.detail && info.picked_kind == PickedNodeKind::mesh) {
        const PickDetailReadback& detail = *info.detail;
        const MeshHandle mesh{info.picked_index, info.state->picked_generation};
        populate_detailed_mesh_info(
            info,
            mesh_cpu_indices(engine, mesh),
            detail.primitive_index,
            detail_rest_point(detail),
            mesh_cpu_positions(engine, mesh),
            mesh_cpu_normals(engine, mesh),
            detail.world,
            true);
    }
`;

/**
 * The runtime half of GPU picking.
 *
 * Everything that decides an ANSWER lives in the backend: the pick renders
 * the scene into a one-pixel target through a sheared view projection and
 * reads the id back, and only the renderer holds the buffers and textures
 * that draw needs. What is left here is the pin's own bookkeeping --
 * `createGpuPicker` builds a record with no device yet
 * (`_device: null`), `disposePicker` releases what the pass allocated, and
 * `pickAsync` serialises against the picker's pending pick.
 *
 * The serialisation is the one piece worth stating. Upstream chains each
 * call onto `picker._pending` so two picks cannot interleave their single
 * set of staging buffers, and *rejection does not wedge the queue*. Here a
 * pick is synchronous: the readback is a wait on submitted work, so the
 * call returns with the answer and the next one starts after it by
 * construction. The queue that upstream needs is the frame boundary this
 * runtime already has.
 */
export class PickingLowerer {
    public constructor(private readonly context: LoweringContext) {}

    /** The two pin-owned projection writers used by GPU picking. */
    public mathHeader(cloudPicking: boolean): string {
        const scalars = [
            { pinned: "sampleX", kind: "number" as const, cpp: "sample_x" },
            { pinned: "sampleY", kind: "number" as const, cpp: "sample_y" },
            { pinned: "w", kind: "number" as const, cpp: "width" },
            { pinned: "h", kind: "number" as const, cpp: "height" },
        ];
        const output = {
            pinned: "out",
            kind: "mat4" as const,
            cpp: "out",
            annotation: "Float32Array",
        };
        const projection = lowerPinnedFunction(
            this.context,
            "src/picking/gpu-picker.ts",
            "computePickVP",
            [output, { pinned: "vp", kind: "matrix", cpp: "vp" }, ...scalars],
            {
                cppName: "compute_pick_view_projection",
                returns: "void",
                inline: true,
            },
        );
        const cloud = cloudPicking
            ? lowerPinnedFunction(
                  this.context,
                  "src/picking/gs-picking-pipeline.ts",
                  "computeGsPickMatrix",
                  [output, ...scalars],
                  {
                      cppName: "compute_cloud_pick_matrix",
                      returns: "void",
                      inline: true,
                  },
              ) +
              "\n\n" +
              this.lowerEncodeIdToColor()
            : "";
        return pinnedHeader(
            [
                "<bblite/js_data.hpp>",
                "",
                "<algorithm>",
                "<array>",
                "<cmath>",
                "<cstdint>",
            ],
            `${projection}
${cloud}

${this.lowerPickPointer()}

${this.lowerDecodePickId()}`,
            { compactPragma: true },
        );
    }

    /**
     * `encodeIdToColor`, the id colour a cloud's picking block carries,
     * translated from the Gaussian-splatting picking fragment that owns it.
     * The pin returns the three unit fractions as numbers and stores them
     * through its `F32` picking block, so the fractions stay doubles here
     * and each caller rounds at its own float store.
     */
    private lowerEncodeIdToColor(): string {
        const module = "src/mesh/GaussianSplatting/gs-gpu-picking-fragment.ts";
        const at = this.context.functionDeclaration(
            module,
            "encodeIdToColor",
        ).declaration;
        return lowerPinnedFunction(
            this.context,
            module,
            "encodeIdToColor",
            [{ pinned: "id", kind: "number", cpp: "id" }],
            {
                cppName: "encode_id_to_color",
                inline: true,
                returns: {
                    type: "std::array<double, 3>",
                    value: (lowerer, expression) =>
                        `std::array<double, 3>{${lowerTupleComponents(
                            this.context,
                            lowerer,
                            expression,
                            { arity: 3, at },
                        ).join(", ")}}`,
                },
            },
        );
    }

    /**
     * The colour attachment's three bytes back into the id they encode:
     * `pickAsyncImpl`'s own `pickId = (colorData[0]! << 16) | ...` store,
     * translated from that statement over the mapped staging bytes.
     */
    private lowerDecodePickId(): string {
        const { file, declaration } = this.context.functionDeclaration(
            gpuPickerModule,
            "pickAsyncImpl",
        );
        const stores = this.context.findNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(node.left) &&
                node.left.text === "pickId",
        );
        const store = stores[0];
        if (stores.length !== 1 || !store) {
            return this.context.contractError(
                declaration,
                "Expected pinned pickAsyncImpl to decode pickId once.",
            );
        }
        const lowerer = new PinnedNumericLowerer(file, {
            bindings: new Map<string, PinnedBinding>([
                ["colorData", { cpp: "color_data", type: "u8" }],
            ]),
            calls: new Map(),
        });
        return `// ${this.context.provenance(gpuPickerModule, "pickAsyncImpl")}
// The readback's \`pickId\`, from the colour staging row's first bytes.
inline std::uint32_t decode_pick_id(const std::uint8_t* color_data) {
    return bbl::js::to_uint32(${lowerer.expression(store.right)});
}`;
    }

    /**
     * `pickAsyncImpl`'s pointer mapping and scene block, translated from the
     * pinned statements that compute them: the CSS-to-backing scale, the
     * viewport the pointer must land in, the sample inside it, the sheared
     * view projection (`computePickVP`) and the selected pixel's centre in
     * the backing framebuffer (`_pickVP[16]`/`[17]`).
     *
     * The pin reads its camera, canvas and view projection off live objects;
     * here the caller hands the canvas extents and two callables -- the
     * pin's `resolveCameraViewport` and `getViewProjectionMatrix` for the
     * picked camera -- so this header needs no render plan. What the rest
     * of the pick reads back (the viewport extent, the sample and the
     * unsheared view projection the readback reconstructs through) lands in
     * `PickPointer`; a pointer outside the viewport answers `false`, which
     * is the pin's empty info.
     */
    private lowerPickPointer(): string {
        const { file, declaration } = this.context.functionDeclaration(
            gpuPickerModule,
            "pickAsyncImpl",
        );
        const statements = declaration.body!.statements;
        const declares = (statement: ts.Statement, name: string): boolean =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.length === 1 &&
            statement.declarationList.declarations[0]!.name.getText(file) ===
                name;
        const first = statements.findIndex((statement) =>
            declares(statement, "backingWidth"),
        );
        const last = statements.findIndex(
            (statement) =>
                ts.isExpressionStatement(statement) &&
                this.context.expressionMatchesShape(
                    statement.expression,
                    "_pickVP[17] = viewport.y + pixelCenterY",
                ),
        );
        if (first < 0 || last < first) {
            return this.context.contractError(
                declaration,
                "Expected pinned pickAsyncImpl to map the pointer from " +
                    "backingWidth through _pickVP[17].",
            );
        }
        // The preamble's outputs: each local the rest of the pick reads,
        // and the member of `PickPointer` it lands in.
        const outputs = new Map<string, string>([
            ["w", "pick.w"],
            ["h", "pick.h"],
            ["sampleX", "pick.sample_x"],
            ["sampleY", "pick.sample_y"],
        ]);
        // The two locals the native pick computes on its own from the same
        // inputs: the detailed ray (`populate_pick_ray` over the sample and
        // the view projection), and the debug trace no reached pick asks for.
        const skipped = new Map<string, string>([
            [
                "pickRay",
                "detailed || debugLabel ? createPickingRay(sampleX, sampleY, vp, w, h) : null",
            ],
            [
                "debugInput",
                "debug ? [x, y, pickX, pickY, px, py, backingWidth, backingHeight, clientWidth, clientHeight, viewport.x, viewport.y, viewport.width, viewport.height] : null",
            ],
        ]);
        const bindings = new Map<string, PinnedBinding>([
            ["x", { cpp: "x", type: "scalar" }],
            ["y", { cpp: "y", type: "scalar" }],
            ["canvas.width", { cpp: "backing_width", type: "scalar" }],
            ["canvas.height", { cpp: "backing_height", type: "scalar" }],
            ["canvas.clientWidth", { cpp: "client_width", type: "scalar" }],
            ["canvas.clientHeight", { cpp: "client_height", type: "scalar" }],
            ["camera", { cpp: "camera", type: "opaque" }],
            // `_pickVP` is the pin's twenty-float scene block: the sheared
            // view projection, then the pixel centre.
            ["_pickVP", { cpp: "scene_block", type: "f32" }],
            [
                "_pickVP[16]",
                {
                    cpp: "scene_block.fragment_coord[0]",
                    type: "scalar",
                    mutable: true,
                },
            ],
            [
                "_pickVP[17]",
                {
                    cpp: "scene_block.fragment_coord[1]",
                    type: "scalar",
                    mutable: true,
                },
            ],
        ]);
        const body = lowerPinnedBody(file, statements.slice(first, last + 1), {
            bindings,
            calls: new Map([
                ...pinnedNumericMathCalls(),
                [
                    "computePickVP",
                    (args: readonly string[]) =>
                        `compute_pick_view_projection(scene_block.view_projection, ${args
                            .slice(1)
                            .join(", ")})`,
                ],
            ]),
            returnValue: (expression) => {
                if (
                    !expression ||
                    !this.context.expressionMatchesShape(
                        expression,
                        "createEmptyPickingInfo()",
                    )
                ) {
                    return this.context.contractError(
                        expression ?? declaration,
                        "Expected the pick preamble to return only the empty info.",
                    );
                }
                return "false";
            },
            expression: (node, lowerer) => {
                // `("clientWidth" in canvas ? canvas.clientWidth : 0)`:
                // a native canvas always reports its client extent.
                if (!ts.isConditionalExpression(node)) return undefined;
                const test = this.context.unwrapExpression(node.condition);
                if (
                    !ts.isBinaryExpression(test) ||
                    test.operatorToken.kind !== ts.SyntaxKind.InKeyword
                ) {
                    return undefined;
                }
                this.context.assertExpressionShape(
                    node.whenFalse,
                    "0",
                    "pick canvas client-extent fallback",
                );
                return lowerer.expression(node.whenTrue);
            },
            statement: (statement, lowerer, indent) => {
                if (!ts.isVariableStatement(statement)) return undefined;
                const local = statement.declarationList.declarations[0]!;
                const name = local.name.getText(file);
                const initializer = local.initializer;
                if (!initializer) return undefined;
                if (name === "viewport") {
                    this.context.assertExpressionShape(
                        initializer,
                        "resolveCameraViewport(camera, backingWidth, backingHeight)",
                        "pick viewport",
                    );
                    const call = this.context.unwrapExpression(initializer);
                    if (!ts.isCallExpression(call)) {
                        return this.context.contractError(
                            initializer,
                            "Expected the pick viewport to be resolved by a call.",
                        );
                    }
                    for (const member of ["x", "y", "width", "height"]) {
                        bindings.set(`viewport.${member}`, {
                            cpp: `static_cast<double>(viewport.${member})`,
                            type: "scalar",
                        });
                    }
                    return [
                        `${indent}const auto viewport = resolve_viewport(` +
                            `${call.arguments
                                .slice(1)
                                .map((argument) => lowerer.expression(argument))
                                .join(", ")});`,
                    ];
                }
                if (name === "vp") {
                    this.context.assertExpressionShape(
                        initializer,
                        "getViewProjectionMatrix(camera, aspect)",
                        "pick view projection",
                    );
                    bindings.set("vp", {
                        cpp: "pick.view_projection",
                        type: "f32",
                    });
                    return [
                        `${indent}pick.view_projection = view_projection(aspect);`,
                    ];
                }
                const output = outputs.get(name);
                if (output) {
                    bindings.set(name, { cpp: output, type: "scalar" });
                    return [
                        `${indent}${output} = ${lowerer.expression(initializer)};`,
                    ];
                }
                const shape = skipped.get(name);
                if (shape !== undefined) {
                    this.context.assertExpressionShape(
                        initializer,
                        shape,
                        `pick preamble ${name}`,
                    );
                    return [];
                }
                return undefined;
            },
        });
        return `/**
 * What \`pickAsyncImpl\`'s preamble hands the rest of the pick: the viewport
 * extent (\`w\`, \`h\`) the sheared projection and the readback are built at,
 * the sampled point inside it, and the unsheared view projection (\`vp\`).
 */
struct PickPointer {
    double w = 0.0;
    double h = 0.0;
    double sample_x = 0.0;
    double sample_y = 0.0;
    std::array<float, 16> view_projection{};
};

// ${this.context.provenance(gpuPickerModule, "pickAsyncImpl")}
// The pointer mapping and the pick scene block, from \`backingWidth\` through
// \`_pickVP[17]\`.
template <typename ResolveViewport, typename ViewProjection, typename SceneBlock>
inline bool map_pick_pointer(
    const ResolveViewport& resolve_viewport,
    const ViewProjection& view_projection,
    SceneBlock& scene_block,
    PickPointer& pick,
    double x,
    double y,
    double backing_width,
    double backing_height,
    double client_width,
    double client_height) {
${body}
    return true;
}`;
    }

    /**
     * @param billboardPick whether a scene reached `pickBillboardSprite`,
     *   which is the pin's own thin wrapper over this same pass.
     * @param detailed whether a scene reached `enableDetailedPicking`,
     *   which is the pin's own opt-in for the third attachment and the
     *   CPU solve over what it read back.
     */
    public lower(
        billboardPick: boolean,
        detailed: boolean,
        pointerDrag = false,
    ): LoweredSource {
        const modulePath = "src/picking/gpu-picker.ts";
        // Anchored rather than assumed: if the pin stops exporting these,
        // the port is describing a surface that no longer exists.
        for (const name of ["createGpuPicker", "pickAsync", "disposePicker"]) {
            this.context.functionDeclaration(modulePath, name);
        }
        // The `filter` option's two arms, restated by the shared candidate
        // collector and both backends' pick passes: a mesh the predicate
        // refuses neither answers nor occludes, and a filtered pick takes
        // no registered pick source.
        const impl = this.context.functionDeclaration(
            modulePath,
            "pickAsyncImpl",
        ).declaration;
        this.context.expectShapeCount(
            impl,
            "mesh.pickable !== false && (!pickFilter || pickFilter(mesh))",
            "pick candidate under the filter",
        );
        this.context.expectShapeCount(
            impl,
            "!pickFilter && scene._pickSources.length > 0",
            "pick sources skipped under a filter",
        );
        const invertMat4 = lowerMat4InvertCpp(this.context);
        const unprojectPoint = this.lowerUnprojectPoint();
        return {
            modulePath,
            symbolName: "pickAsync",
            header: "",
            source: `// ${this.context.provenance(modulePath, "pickAsync")}
#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
${billboardPick ? "#include <bblite/upstream/camera_math.hpp>\n" : ""}${
                detailed
                    ? "#include <bblite/upstream/pinned_normalize_vec3.hpp>\n" +
                      "#include <bblite/upstream/renderer_plan.hpp>\n"
                    : ""
            }
#include <cmath>
${detailed ? "#include <limits>\n" : ""}#include <stdexcept>
${detailed ? "#include <vector>\n" : ""}
namespace bbl {

namespace {

${invertMat4}

// One clip-space point through an inverse view projection, ending at the
// pin's own \`1 / w\` divide. The picked point is this function, and so
// are both ends of the ray a detailed pick builds -- which is why it is
// translated from the pinned declaration rather than written out twice.
${unprojectPoint}
${detailed ? this.lowerDetailedHelpers() : ""}

GpuPickerRecord& picker_record(
    Engine& engine,
    GpuPickerHandle picker) {
    if (picker.value >= engine.gpu_pickers.size()) {
        throw std::runtime_error("Invalid GPU picker handle.");
    }
    return engine.gpu_pickers[picker.value];
}

} // namespace

// The pinned record starts with no device and no targets; both are made
// on the first pick, which is why a picker created before the loop starts
// costs nothing.
GpuPickerHandle create_gpu_picker(Scene& scene) {
    if (!scene.engine) {
        throw std::runtime_error(
            "createGpuPicker requires a scene bound to an engine.");
    }
    Engine& engine = *scene.engine;
    engine.gpu_pickers.push_back(GpuPickerRecord{});
    engine.gpu_pickers.back().scene = scene.state;
    return GpuPickerHandle{
        static_cast<std::uint32_t>(engine.gpu_pickers.size() - 1)};
}
${detailed ? this.lowerDetailedEntryPoints() : ""}
${detailed || pointerDrag ? this.lowerPickRay() : ""}
// ${this.context.provenance(modulePath, "pickAsync")}
// A disposed picker answers the empty info the pin's
// \`createEmptyPickingInfo\` returns, as does a pick taken before the
// renderer installed its hook -- a scene that picks without a running
// loop has nothing to read, and reporting a miss is what upstream does
// when the scene has no camera.
namespace {

PickingInfo gpu_pick_through_hook(
    Engine& engine,
    GpuPickerHandle picker,
    double x,
    double y,
    const Engine::PickFilter* filter) {
    const GpuPickerRecord& record = picker_record(engine, picker);
    PickingInfo info = record.disposed || !engine.pick_hook
        ? PickingInfo{}
        : engine.pick_hook(picker, x, y, filter);
    info.bind_engine(engine);
${detailed ? DETAILED_CONTINUATION : ""}    return info;
}

} // namespace

PickingInfo gpu_pick(
    Engine& engine,
    GpuPickerHandle picker,
    double x,
    double y) {
    return gpu_pick_through_hook(engine, picker, x, y, nullptr);
}

// The pin's \`options.filter\` arm: the predicate rides the pick request,
// applied once while the candidate list is built so ids and resolution
// agree, and a filtered pick takes no pick source (\`pickAsyncImpl\` skips
// \`_pickSources\` under one).
PickingInfo gpu_pick(
    Engine& engine,
    GpuPickerHandle picker,
    double x,
    double y,
    const Engine::PickFilter& filter) {
    return gpu_pick_through_hook(engine, picker, x, y, &filter);
}

// The name a pick resolved to, read where the scene asks for it rather
// than captured at pick time: upstream \`pickedMesh\` is a live node
// reference, so a scene that renames the node between the pick and the
// read sees the new name.
std::string picked_node_name(
    const Engine& engine,
    const PickingInfo& info) {
    switch (info.picked_kind) {
        case PickedNodeKind::mesh:
            return engine.meshes[info.picked_index].name;
        case PickedNodeKind::splat_mesh:
            return engine.splat_meshes[info.picked_index].name;
        // A billboard sprite is not a node: the pin leaves
        // \`info.pickedMesh\` null for it and hangs \`_spritePick\` on the
        // info instead, so there is no name to read through.
        case PickedNodeKind::billboard_sprite:
        case PickedNodeKind::none:
            break;
    }
    return {};
}

MeshHandle picked_mesh(const PickingInfo& info) {
    return info.picked_kind == PickedNodeKind::mesh
        ? MeshHandle{info.picked_index, info.state->picked_generation}
        : MeshHandle{};
}

std::string picked_node_name(const PickingInfo& info) {
    return picked_node_name(picking_engine(info), info);
}

js::Nullable<js::Tuple<3>> picked_point(
    const PickingInfo& info) {
    return info.picked_point
        ? js::Nullable<js::Tuple<3>>{*info.picked_point}
        : js::Nullable<js::Tuple<3>>{};
}

// The basic picker still reconstructs \`pickedPoint\`; only \`ray\` is gated by
// the detailed flag. This is the pinned readback formula over its original
// (un-sheared) view projection, sampled NDC and r32float depth attachment --
// \`ray.ts\`'s own \`unprojectPoint\`, which the detailed ray reaches twice.
void populate_picked_point(
    PickingInfo& info,
    const std::array<float, 16>& view_projection,
    double sample_x,
    double sample_y,
    double width,
    double height,
    float depth) {
    if (!info.hit) return;
    const auto inverse = mat4_invert(view_projection);
    if (!inverse) return;
    info.picked_point = unproject_point(
        *inverse,
        2.0 * sample_x / width - 1.0,
        1.0 - 2.0 * sample_y / height,
        depth);
}

// The backend owns the resources, so it frees them through the same hook
// it installed; the record only stops answering.
void dispose_picker(Engine& engine, GpuPickerHandle picker) {
    picker_record(engine, picker).disposed = true;
}
${billboardPick ? this.lowerBillboardWrapper() : ""}
} // namespace bbl
`,
        };
    }

    /**
     * `unprojectPoint`, translated from `ray.ts`'s own declaration.
     *
     * The pin keeps it module-private beside `createPickingRay`, and both
     * of this port's readback reconstructions are it: `pickedPoint` at the
     * sampled depth, and the pick ray's near and far ends.
     */
    private lowerUnprojectPoint(): string {
        return lowerPinnedFunction(
            this.context,
            rayModule,
            "unprojectPoint",
            [
                { pinned: "invVP", kind: "mat4Const", cpp: "inv" },
                { pinned: "ndcX", kind: "number", cpp: "ndc_x" },
                { pinned: "ndcY", kind: "number", cpp: "ndc_y" },
                { pinned: "depth", kind: "number", cpp: "depth" },
            ],
            {
                cppName: "unproject_point",
                returns: {
                    type: "std::array<double, 3>",
                    value: (lowerer, expression) =>
                        `std::array<double, 3>{${lowerTupleComponents(
                            this.context,
                            lowerer,
                            expression,
                            {
                                arity: 3,
                                at: this.context.functionDeclaration(
                                    rayModule,
                                    "unprojectPoint",
                                ).declaration,
                            },
                        ).join(", ")}}`,
                },
            },
        );
    }

    /**
     * The detailed pipeline's CPU half, translated from the pinned
     * declarations that own it.
     *
     * `detailed-picking.ts` is four functions and every one of them is
     * arithmetic: the barycentric solve against the REST triangle, the
     * tiny-weight clamp, the world normal transform and the facing test
     * that decides whether a normal is flipped. They come out of the
     * pinned AST rather than being restated, which is what keeps a
     * changed pinned solve a generation failure.
     *
     * Two of the pin's parameters land differently, because what they
     * name lives elsewhere here. `mesh` is reached only for its CPU index
     * array, so the emitted parameter is that array. `deformTriangle` is
     * the pin's own optional hook into the deformed-vertex module, which
     * a skinned or morphed detailed pick DOES supply upstream -- scene 115
     * is one. It binds absent here anyway, and the arm behind it does not
     * translate, leaving the pin's own "fall back to the rest edges"
     * behaviour. What makes that unobservable rather than a divergence is
     * the reader: the only fields the hook changes are
     * `pickedFaceNormal`/`pickedFaceNormalWorld`, and their accessor
     * `getPickedFaceNormal` is not in the pinned package's export surface
     * at all, so no scene can ask. `getPickedNormal`, which scenes do
     * reach, is the smooth normal -- undeformed upstream too. If a later
     * pin exports the face reader, this binding is where it fails.
     */
    private lowerDetailedHelpers(): string {
        const calls = pinnedNumericMathCallsWithHypot();
        calls.set("normalizeVec3TupleOrUp", normalizeVec3Call);
        calls.set(
            "clampTinyBarycentric",
            (args) => `clamp_tiny_barycentric(${args.join(", ")})`,
        );
        calls.set(
            "transformNormal",
            (args) => `transform_normal(${args.join(", ")})`,
        );
        calls.set(
            "facesPickRay",
            (args) => `faces_pick_ray(${args.join(", ")})`,
        );
        const clamp = lowerPinnedFunction(
            this.context,
            detailedModule,
            "clampTinyBarycentric",
            [{ pinned: "value", kind: "number", cpp: "value" }],
            { cppName: "clamp_tiny_barycentric", returns: "double", calls },
        );
        const transformNormal = lowerPinnedFunction(
            this.context,
            detailedModule,
            "transformNormal",
            [
                { pinned: "world", kind: "mat4Const", cpp: "world" },
                {
                    pinned: "normal",
                    kind: "record",
                    cpp: "normal",
                    cppType: "std::array<double, 3>",
                    annotation: "readonly [number, number, number]",
                },
            ],
            {
                cppName: "transform_normal",
                calls,
                memberBindings: new Map<string, PinnedBinding>(
                    tupleMembers("normal", "normal"),
                ),
                returns: {
                    type: "std::array<double, 3>",
                    value: (lowerer, expression) =>
                        lowerer.expression(expression!),
                },
            },
        );
        const facesPickRay = lowerPinnedFunction(
            this.context,
            detailedModule,
            "facesPickRay",
            [
                {
                    pinned: "normal",
                    kind: "record",
                    cpp: "normal",
                    cppType: "std::array<double, 3>",
                    annotation: "readonly [number, number, number]",
                },
                {
                    pinned: "info",
                    kind: "record",
                    cpp: "info",
                    cppType: "PickingInfo",
                    annotation: "PickingInfo",
                },
            ],
            {
                cppName: "faces_pick_ray",
                calls,
                booleanAnd: true,
                memberBindings: new Map<string, PinnedBinding>([
                    ...tupleMembers("normal", "normal"),
                    PICK_INFO_RAY,
                    ...tupleMembers("ray.direction", "info.ray->direction"),
                ]),
                returns: {
                    type: "bool",
                    value: (lowerer, expression) =>
                        lowerer.expression(expression!),
                },
            },
        );
        const populate = lowerPinnedFunction(
            this.context,
            detailedModule,
            "populateDetailedMeshInfo",
            [
                {
                    pinned: "info",
                    kind: "record",
                    cpp: "info",
                    cppType: "PickingInfo",
                    mutableRecord: true,
                    annotation: "PickingInfo",
                },
                {
                    pinned: "mesh",
                    kind: "record",
                    cpp: "mesh_indices",
                    cppType: "std::vector<std::uint32_t>",
                    annotation: "Mesh",
                    binding: emptyIsAbsent("mesh_indices", "u32"),
                },
                { pinned: "faceId", kind: "number", cpp: "face_id" },
                {
                    pinned: "localPoint",
                    kind: "record",
                    cpp: "local_point",
                    cppType: "std::array<double, 3>",
                    annotation: "readonly [number, number, number]",
                },
                {
                    pinned: "positions",
                    kind: "record",
                    cpp: "positions",
                    cppType: "std::vector<float>",
                    annotation: "Float32Array | undefined",
                    binding: emptyIsAbsent("positions", "f32"),
                },
                {
                    pinned: "normals",
                    kind: "record",
                    cpp: "normals",
                    cppType: "std::vector<float>",
                    annotation: "Float32Array | undefined",
                    binding: emptyIsAbsent("normals", "f32"),
                },
                { pinned: "world", kind: "mat4Const", cpp: "world" },
                {
                    pinned: "surfaceNormalsValid",
                    kind: "boolean",
                    cpp: "surface_normals_valid",
                },
                {
                    pinned: "deformTriangle",
                    kind: "boolean",
                    cpp: "deform_triangle",
                    annotation:
                        "((mesh: Mesh, i0: number, i1: number, " +
                        "i2: number, out: Float32Array) => boolean) | null",
                    absent: true,
                },
            ],
            {
                cppName: "populate_detailed_mesh_info",
                returns: "void",
                calls,
                booleanAnd: true,
                booleanOr: true,
                fixedTupleCalls: new Map([
                    ["normalizeVec3TupleOrUp", 3],
                    ["transformNormal", 3],
                ]),
                memberBindings: new Map<string, PinnedBinding>([
                    ["mesh._cpuIndices", emptyIsAbsent("mesh_indices", "u32")],
                    ...PICK_INFO_SCALARS,
                    [
                        "info.pickedNormal",
                        { cpp: "info.picked_normal", type: "scalar" },
                    ],
                    [
                        "info.pickedNormalWorld",
                        { cpp: "info.picked_normal_world", type: "scalar" },
                    ],
                    [
                        "info.pickedFaceNormal",
                        { cpp: "info.picked_face_normal", type: "scalar" },
                    ],
                    [
                        "info.pickedFaceNormalWorld",
                        {
                            cpp: "info.picked_face_normal_world",
                            type: "scalar",
                        },
                    ],
                    [
                        "Number.EPSILON",
                        {
                            cpp: "std::numeric_limits<double>::epsilon()",
                            type: "scalar",
                        },
                    ],
                    ...tupleMembers("localPoint", "local_point"),
                ]),
            },
        );
        return `${clamp}

${transformNormal}

${facesPickRay}

${populate}

${this.lowerPickedNormalImpl(calls)}

/**
 * The interpolated vertex position, in the space the pin's own solve
 * expects it: the mesh's REST space.
 *
 * The pin's detailed vertex stage forwards \`position\` untouched, and so
 * does the module deployed here -- but an ordinary mesh's vertex buffer
 * is baked to WORLD space by this port (\`transformed_vertices\`; the
 * contract is stated in the picking section of \`fidelity.md\`), so the
 * varying arrives world-space and is mapped back through the same
 * draw-time world the bake used. Barycentric weights are affine
 * invariant, so this is a change of basis rather than a change of
 * answer; what needs it is the face normal, which is derived from the
 * triangle's EDGES and would otherwise be transformed by \`world\` twice.
 * A mesh whose transform travels as a matrix instead already forwards a
 * local position and takes no map.
 */
std::array<double, 3> detail_rest_point(
    const PickDetailReadback& detail) {
    if (!detail.world_baked) return detail.point;
    const auto inverse = mat4_invert(detail.world);
    if (!inverse) return detail.point;
    const auto& m = *inverse;
    const double x = detail.point[0];
    const double y = detail.point[1];
    const double z = detail.point[2];
    return {
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
    };
}
`;
    }

    /**
     * `getPickedNormal`, translated whole.
     *
     * The pin reads three things off the picked MESH -- its CPU normals,
     * its CPU indices and its live world matrix -- and this port keeps a
     * mesh's identity rather than a node reference, so those three arrive
     * as leading parameters and the pinned member reads bind to them.
     * `info.pickedMesh` itself is reached only for its truthiness, which
     * is the resolved kind.
     */
    private lowerPickedNormalImpl(
        calls: Map<string, (args: readonly string[]) => string>,
    ): string {
        return lowerPinnedFunction(
            this.context,
            helpersModule,
            "getPickedNormal",
            [
                {
                    pinned: "info",
                    kind: "record",
                    cpp: "info",
                    cppType: "PickingInfo",
                    annotation: "PickingInfo",
                },
                {
                    pinned: "useWorldCoordinates",
                    kind: "boolean",
                    cpp: "use_world_coordinates",
                },
            ],
            {
                cppName: "picked_normal_impl",
                calls,
                booleanAnd: true,
                booleanOr: true,
                leadingParameters: [
                    "const std::vector<float>& mesh_normals",
                    "const std::vector<std::uint32_t>& mesh_indices",
                    "const std::array<float, 16>& mesh_world",
                ],
                fixedTupleCalls: new Map([["normalizeVec3TupleOrUp", 3]]),
                memberBindings: new Map<string, PinnedBinding>([
                    ...PICK_INFO_SCALARS,
                    [
                        "info.pickedNormal",
                        optionalIsAbsent("info.picked_normal"),
                    ],
                    [
                        "info.pickedNormalWorld",
                        optionalIsAbsent("info.picked_normal_world"),
                    ],
                    [
                        // Reached only for its truthiness: the pin's
                        // `pickedMesh` is a node reference and this port
                        // resolved an identity, so "there is one" is the
                        // resolved kind. The container it names is the
                        // one the body reads through it next.
                        "info.pickedMesh",
                        {
                            cpp: "mesh_normals",
                            type: "f32",
                            absentCpp:
                                "info.picked_kind != PickedNodeKind::mesh",
                        },
                    ],
                    ["mi._cpuNormals", emptyIsAbsent("mesh_normals", "f32")],
                    ["mi._cpuIndices", emptyIsAbsent("mesh_indices", "u32")],
                    ["mi.worldMatrix", { cpp: "mesh_world", type: "f32" }],
                    ...tupleMembers(
                        "info.ray.direction",
                        "info.ray->direction",
                    ),
                    PICK_INFO_RAY,
                ]),
                returns: {
                    type: "js::Nullable<js::Tuple<3>>",
                    value: (lowerer, expression) =>
                        this.pickedNormalReturn(lowerer, expression),
                },
            },
        );
    }

    /**
     * One `return` of the pinned `getPickedNormal`, as the nullable tuple
     * the emitted function answers with.
     *
     * Three shapes, and the caller owns the conversion because it owns
     * the native type: the pin's `null`, a member it already holds, and
     * the flip conditional over a three-element literal. Every value
     * inside them is still translated by the lowerer, so no arithmetic is
     * restated here -- only how a translated triple becomes a
     * `js::Tuple<3>`.
     */
    private pickedNormalReturn(
        lowerer: PinnedNumericLowerer,
        expression: ts.Expression | undefined,
    ): string {
        const { declaration } = this.context.functionDeclaration(
            helpersModule,
            "getPickedNormal",
        );
        if (!expression) {
            return this.context.contractError(
                declaration,
                "Expected pinned getPickedNormal to return a value.",
            );
        }
        const node = this.context.unwrapExpression(expression);
        if (node.kind === ts.SyntaxKind.NullKeyword) {
            return "js::Nullable<js::Tuple<3>>{}";
        }
        const triple = (value: ts.Expression): string => {
            const inner = this.context.unwrapExpression(value);
            if (ts.isArrayLiteralExpression(inner)) {
                return `js::Tuple<3>{${lowerTupleComponents(
                    this.context,
                    lowerer,
                    inner,
                    { arity: 3, at: inner },
                ).join(", ")}}`;
            }
            // A member the pin already holds (`info.pickedNormal`) or a
            // fixed tuple it just built (`localNormal`): both are
            // three-lane storage the translator can name, and the
            // optional members dereference where the guard above proved
            // them present.
            const named = lowerer.expression(inner);
            return PICK_INFO_NORMAL_MEMBERS.has(inner.getText())
                ? `js::Tuple<3>{*${named}}`
                : `js::Tuple<3>{${named}}`;
        };
        if (ts.isConditionalExpression(node)) {
            return (
                `${lowerer.expression(node.condition)} ? ` +
                `${triple(node.whenTrue)} : ${triple(node.whenFalse)}`
            );
        }
        return triple(node);
    }

    /** The detailed pipeline's public entry points. */
    private lowerDetailedEntryPoints(): string {
        // Anchored rather than assumed, like the three above: the probe
        // this port answers `true` to has to still be the pin's.
        this.context.functionDeclaration(
            detailedModule,
            "enableDetailedPicking",
        );
        return `
// ${this.context.provenance(detailedModule, "enableDetailedPicking")}
// Upstream this is a FEATURE PROBE rather than a flag:
// \`picker._detailedPicking = engine._device.features.has("primitive-index")\`,
// and a device without the feature leaves the picker coarse. Every
// backend this port builds reaches that feature -- Dawn requests it from
// the adapter, and Tint lowers \`@builtin(primitive_index)\` onto the core
// D3D12 \`SV_PrimitiveId\` for SDL_GPU -- and a device that could not
// would fail the detailed pipeline's own shader module rather than
// answering a pick the scene cannot tell apart from a hit. So the arm
// that silently stays coarse is not composed; the throw is the answer.
void enable_detailed_picking(Engine& engine, GpuPickerHandle picker) {
    picker_record(engine, picker).detailed = true;
}

// ${this.context.provenance(helpersModule, "getPickedNormal")}
// The pinned body above reads the live mesh resolved from this handle.
js::Nullable<js::Tuple<3>> picked_normal(
    const Engine& engine,
    const PickingInfo& info,
    bool use_world_coordinates) {
    const bool resolved = info.picked_kind == PickedNodeKind::mesh;
    const MeshHandle mesh{info.picked_index, info.state->picked_generation};
    return picked_normal_impl(
        resolved ? mesh_cpu_normals(engine, mesh) : std::vector<float>{},
        resolved ? mesh_cpu_indices(engine, mesh)
                 : std::vector<std::uint32_t>{},
        resolved ? upstream::mesh_world_matrix(engine, engine.meshes[mesh.value])
                 : std::array<float, 16>{},
        info,
        use_world_coordinates);
}

js::Nullable<js::Tuple<3>> picked_normal(
    const PickingInfo& info,
    bool use_world_coordinates) {
    return picked_normal(picking_engine(info), info, use_world_coordinates);
}
`;
    }

    /**
     * `createPickingRay`, translated from `ray.ts`'s own declaration.
     *
     * The pin builds this ray only for a detailed pick and hands it to the
     * facing test that decides whether a surface normal is flipped; the
     * pointer drag builds the same ray for its plane intersection. Both
     * ends are `unproject_point` at the reverse-Z near and far planes (1
     * is near, 0 is far), and the singular-matrix and degenerate-length
     * arms answer `null`, which is the empty optional the info carries.
     */
    private lowerPickRay(): string {
        const calls = pinnedNumericMathCallsWithHypot();
        calls.set("invertMat4", (args) => `mat4_invert(${args.join(", ")})`);
        calls.set(
            "unprojectPoint",
            (args) => `unproject_point(${args.join(", ")})`,
        );
        const ray = lowerPinnedFunction(
            this.context,
            rayModule,
            "createPickingRay",
            [
                { pinned: "x", kind: "number", cpp: "x" },
                { pinned: "y", kind: "number", cpp: "y" },
                {
                    pinned: "vpMatrix",
                    kind: "mat4Const",
                    cpp: "view_projection",
                },
                { pinned: "width", kind: "number", cpp: "width" },
                { pinned: "height", kind: "number", cpp: "height" },
            ],
            {
                cppName: "create_picking_ray",
                calls,
                nullableMatrixCalls: new Set(["invertMat4"]),
                fixedTupleCalls: new Map([["unprojectPoint", 3]]),
                returns: {
                    type: "std::optional<PickRay>",
                    value: (lowerer, expression) => {
                        const returned = expression
                            ? this.context.unwrapExpression(expression)
                            : undefined;
                        if (returned?.kind === ts.SyntaxKind.NullKeyword) {
                            return "std::nullopt";
                        }
                        if (
                            !returned ||
                            !ts.isObjectLiteralExpression(returned)
                        ) {
                            return this.context.contractError(
                                returned ??
                                    this.context.functionDeclaration(
                                        rayModule,
                                        "createPickingRay",
                                    ).declaration,
                                "Expected pinned createPickingRay to return " +
                                    "null or a ray literal.",
                            );
                        }
                        const member = (name: string): ts.Expression =>
                            this.context.propertyInitializer(returned, name);
                        const direction = lowerTupleComponents(
                            this.context,
                            lowerer,
                            member("direction"),
                            { arity: 3, at: returned },
                        );
                        return (
                            `PickRay{${lowerer.expression(member("origin"))}, ` +
                            `{${direction.join(", ")}}, ` +
                            `${lowerer.expression(member("length"))}}`
                        );
                    },
                },
            },
        );
        return `namespace {

${ray}

} // namespace

// The pin's \`createPickingRay(sampleX, sampleY, vp, w, h)\` over the pick's
// own sample, kept on the info the detailed solve and the pointer drag
// read it from.
void populate_pick_ray(
    PickingInfo& info,
    const std::array<float, 16>& view_projection,
    double sample_x,
    double sample_y,
    double width,
    double height) {
    info.ray = create_picking_ray(
        sample_x, sample_y, view_projection, width, height);
}

`;
    }

    /**
     * `info.distance`, the tail of the pin's own `pickAsyncImpl` once the
     * picked point is known: the origin the pin measures from, then the
     * three deltas and the root, lowered from those five statements.
     *
     * The origin is `detailed && pickRay ? <ray origin> : getCameraPosition
     * (camera)`. This port reaches the distance only through
     * `pickBillboardSprite`, whose throwaway picker is never detailed, so
     * `detailed` binds statically false and the pin's own conditional folds
     * to the camera arm -- `getCameraPosition` reads the camera's FLOAT
     * world matrix, which `camera_position` is the lowering of. The pin
     * stores the result on the info; the scene reads it as a value, so the
     * store is the return.
     */
    private lowerPickedDistance(): string {
        const modulePath = "src/picking/gpu-picker.ts";
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            "pickAsyncImpl",
        );
        const origins = this.context.findNodes(
            declaration,
            (node): node is ts.VariableStatement =>
                ts.isVariableStatement(node) &&
                node.declarationList.declarations.length === 1 &&
                ts.isIdentifier(node.declarationList.declarations[0]!.name) &&
                node.declarationList.declarations[0]!.name.text === "origin",
        );
        const originStatement = origins[0];
        if (origins.length !== 1 || !originStatement) {
            return this.context.contractError(
                declaration,
                "Expected pinned pickAsyncImpl to bind the pick origin once.",
            );
        }
        const block = originStatement.parent;
        if (!ts.isBlock(block)) {
            return this.context.contractError(
                originStatement,
                "Expected the pick origin to be declared inside a block.",
            );
        }
        const start = block.statements.indexOf(originStatement);
        const statements = block.statements.slice(start, start + 5);
        const store = statements[4];
        const distanceStore =
            store !== undefined &&
            ts.isExpressionStatement(store) &&
            ts.isBinaryExpression(store.expression) &&
            store.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            store.expression.left.getText(file) === "info.distance"
                ? store.expression
                : undefined;
        if (statements.length !== 5 || !distanceStore) {
            return this.context.contractError(
                originStatement,
                "Expected the pick origin, three deltas and the " +
                    "info.distance store to be consecutive.",
            );
        }
        const originInitializer =
            originStatement.declarationList.declarations[0]!.initializer;
        if (!originInitializer) {
            return this.context.contractError(
                originStatement,
                "Expected the pick origin to be initialized.",
            );
        }

        const body = lowerPinnedBody(file, statements, {
            bindings: new Map<string, PinnedBinding>([
                [
                    "detailed",
                    { cpp: "false", type: "bool", staticBoolean: false },
                ],
                [
                    "pickRay",
                    {
                        cpp: "info.ray",
                        type: "scalar",
                        absentCpp: "!info.ray.has_value()",
                    },
                ],
                [
                    "pickRay.origin",
                    { cpp: "info.ray->origin", type: "f64-buffer" },
                ],
                ["camera", { cpp: "camera", type: "opaque" }],
                ["info.pickedPoint", { cpp: "point", type: "f64-buffer" }],
                ...vec3MemberBindings("origin"),
            ]),
            calls: new Map([
                ...pinnedNumericMathCallsWithHypot(),
                [
                    "getCameraPosition",
                    (args: readonly string[]) =>
                        `upstream::camera_position(${args.join(", ")})`,
                ],
            ]),
            booleanAnd: true,
            vec3Literal: (x, y, z) => `Vec3d{${x}, ${y}, ${z}}`,
            statement: (statement, inner, indent) => {
                if (statement === originStatement) {
                    return [
                        `${indent}const Vec3d origin = ` +
                            `${inner.expression(originInitializer)};`,
                    ];
                }
                if (statement === store) {
                    return [
                        `${indent}return ${inner.expression(distanceStore.right)};`,
                    ];
                }
                return undefined;
            },
        });
        return `// ${this.context.provenance(modulePath, "pickAsyncImpl")}
// \`info.distance\`, from the pick origin to the reconstructed point.
double picked_distance(const Scene& scene, const PickingInfo& info) {
    if (!info.picked_point || !scene.engine) return 0.0;
    const Engine& engine = *scene.engine;
    if (scene.camera.value >= engine.cameras.size()) return 0.0;
    const CameraRecord& camera = engine.cameras[scene.camera.value];
    const std::array<double, 3>& point = *info.picked_point;
${body}
}`;
    }

    /**
     * `pickBillboardSprite`, which is a wrapper and nothing else.
     *
     * Upstream it creates a throwaway picker, runs the shared
     * `pickAsync`, and reads the `_spritePick` payload the billboard
     * contributor hung on the info. All three statements survive: the
     * picker is still created and disposed per call (its record costs one
     * vector slot and the GPU resources are the renderer's), and the
     * payload read is the caller's -- the compiled call site tests
     * `picked_kind` and builds the scene's own record.
     *
     * `distance` is the second half the pin computes beside `pickedPoint`,
     * lowered beside it by `lowerPickedDistance`.
     */
    private lowerBillboardWrapper(): string {
        const wrapperModule = "src/sprite/picking/pick-billboard.ts";
        this.context.functionDeclaration(wrapperModule, "pickBillboardSprite");
        return `
// ${this.context.provenance(wrapperModule, "pickBillboardSprite")}
// The pin's \`picker ?? createGpuPicker(scene)\` with no caller-owned
// picker, and its \`finally\` disposing only what it made.
PickingInfo pick_billboard_sprite(
    Engine& engine,
    Scene& scene,
    double x,
    double y) {
    const GpuPickerHandle picker = create_gpu_picker(scene);
    const PickingInfo info = gpu_pick(engine, picker, x, y);
    dispose_picker(engine, picker);
    return info;
}

${this.lowerPickedDistance()}
`;
    }
}
