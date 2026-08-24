/**
 * Lowers Babylon Lite's Gaussian-splat CPU work to C++.
 *
 * Two pinned functions carry everything the renderer needs from a splat
 * asset, and both are FOLDED rather than executed: their shape is the
 * contract, they are fixed math over a fixed 32-byte row layout, and folding
 * keeps the packaged asset at the row buffer instead of the four float
 * textures it expands to (11 MB against 22 MB for scene 120).
 *
 *  - `splat-data.ts#buildSplatGeometry` — rotate-then-scale the unit
 *    covariance, store its six unique upper-triangle entries as two RGB
 *    triples, and lay centres/covariance/colour out one texel per splat.
 *  - `splat-sort-core.ts#sortSplatsBackToFront` — the uniform-key counting
 *    sort that puts splats in back-to-front order for the alpha-combine
 *    blend, plus the two helpers that size its scratch.
 *
 * The PLY parse is the opposite case and is executed at generation instead
 * (`src/splat-packager.ts` states why).
 *
 * One adaptation, measured rather than assumed: `Math.hypot` is
 * implementation-approximated by the ECMAScript spec, so no port can match
 * it by construction. `pinned_hypot` here is the plain root of the sum of
 * squares. Across scene 120's 345,217 splats that changes 10 of 2,785,280
 * emitted floats, every one of them a covariance entry below 1e-19 — a splat
 * whose projected area is zero either way. Recorded in `fidelity.json`.
 */
import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { PINNED_MATH_FUNCTIONS } from "./pinned-operators.js";

const DATA_MODULE = "src/loader-splat/splat-data.ts";
const SORT_MODULE = "src/loader-splat/splat-sort-core.ts";
const SORT_MODULE_MESH =
    "src/mesh/GaussianSplatting/gaussian-splatting-mesh.ts";

/**
 * `Math.*` as the pinned splat bodies reach it.
 *
 * The one-to-one names come from `PINNED_MATH_FUNCTIONS`, so a member one
 * lowerer learns is a member all of them know. Only the two that are NOT a
 * `<cmath>` call of the same meaning are stated here, and each says why.
 */
const MATH_CALLS: ReadonlyMap<
    string,
    (args: readonly string[]) => string
> = new Map<string, (args: readonly string[]) => string>([
    ...Object.entries(PINNED_MATH_FUNCTIONS).map(
        ([name, spelling]): [string, (a: readonly string[]) => string] => [
            `Math.${name}`,
            // std::max/min need the template argument pinned to double, or a
            // mixed-width call is ambiguous.
            name === "max" || name === "min"
                ? (a) => `${spelling}<double>(${a.join(", ")})`
                : (a) => `${spelling}(${a.join(", ")})`,
        ],
    ),
    // JS rounds a half toward +Infinity; std::round rounds it away from zero,
    // so the two disagree at -0.5, -1.5, ...
    ["Math.round", (a) => `bbl::js::round_number(${a[0]})`],
    // Math.hypot is implementation-approximated by the ECMAScript spec; see
    // the module comment for the measured effect of using the plain root.
    ["Math.hypot", (a) => `pinned_hypot({${a.join(", ")}})`],
]);

export class SplatLowerer {
    public constructor(private readonly context: LoweringContext) {}

    private declaration(
        modulePath: string,
        symbolName: string,
    ): { file: ts.SourceFile; declaration: ts.FunctionDeclaration } {
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        if (!ts.isFunctionDeclaration(declaration) || !declaration.body) {
            this.context.contractError(
                declaration,
                `Expected ${symbolName} to be a function declaration.`,
            );
        }
        return { file, declaration };
    }

    /**
     * The row layout every arm of this port reads.
     *
     * `buildSplatGeometry` indexes the buffer through two views at a stride
     * the module states as `ROW_LENGTH`, so the constant is read from the pin
     * rather than repeated: a changed stride changes every offset below it.
     */
    private rowLength(): number {
        return this.pinnedNumber(DATA_MODULE, "ROW_LENGTH");
    }

    /** A module-local numeric constant, read from its own declaration. */
    private pinnedNumber(modulePath: string, name: string): number {
        const file = this.context.sourceFile(modulePath);
        const initializer = this.context.variableInitializer(file, name);
        if (!ts.isNumericLiteral(initializer)) {
            return this.context.contractError(
                initializer,
                `Expected ${name} to be a numeric literal.`,
            );
        }
        return Number(initializer.text);
    }

    /**
     * `chooseTextureSize` picks the texel grid the four data textures share.
     *
     * Module-local upstream, so it is lowered as a file-local helper here
     * rather than inlined: inlining would have to substitute the pin's own
     * parameter names at the call site, and getting that wrong is silent.
     */
    private lowerTextureSize(): string {
        const file = this.context.sourceFile(DATA_MODULE);
        const found = this.context.findNodes(
            file,
            (node): node is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(node) &&
                node.name?.text === "chooseTextureSize",
        )[0];
        if (!found?.body || found.parameters.length !== 1) {
            this.context.contractError(
                file,
                "Expected splat-data.ts to declare chooseTextureSize(length).",
            );
        }
        const parameter = found.parameters[0]!.name;
        if (!ts.isIdentifier(parameter)) {
            this.context.contractError(
                found,
                "Expected chooseTextureSize to take a named parameter.",
            );
        }
        const bindings = new Map<string, PinnedBinding>([
            [parameter.text, { cpp: parameter.text, type: "scalar" }],
        ]);
        const lowerer: PinnedNumericLowerer = new PinnedNumericLowerer(file, {
            bindings,
            calls: MATH_CALLS,
            returnValue: (expression): string => {
                if (
                    !expression ||
                    !ts.isObjectLiteralExpression(expression)
                ) {
                    return this.context.contractError(
                        found!,
                        "Expected chooseTextureSize to return an object literal.",
                    );
                }
                return `SplatTextureSize{${this.objectFields(
                    expression,
                    ["width", "height"],
                    lowerer,
                    found!,
                ).join(", ")}}`;
            },
        });
        const body = found.body.statements
            .flatMap((statement) => lowerer.statement(statement, "    "))
            .join("\n");
        return `SplatTextureSize choose_splat_texture_size(double ${parameter.text}) {
${body}
}`;
    }

    /**
     * The named fields of a pinned returned object literal, in the order the
     * receiving struct declares them. A field the pin stops returning fails
     * here rather than leaving a default-constructed member behind.
     */
    private objectFields(
        literal: ts.ObjectLiteralExpression,
        order: readonly string[],
        lowerer: PinnedNumericLowerer,
        at: ts.Node,
    ): string[] {
        const values = new Map<string, string>();
        for (const property of literal.properties) {
            if (
                ts.isShorthandPropertyAssignment(property) &&
                ts.isIdentifier(property.name)
            ) {
                values.set(
                    property.name.text,
                    lowerer.expression(property.name),
                );
                continue;
            }
            if (
                ts.isPropertyAssignment(property) &&
                ts.isIdentifier(property.name)
            ) {
                values.set(
                    property.name.text,
                    ts.isArrayLiteralExpression(property.initializer)
                        ? `{${property.initializer.elements
                              .map((element) => lowerer.expression(element))
                              .join(", ")}}`
                        : lowerer.expression(property.initializer),
                );
            }
        }
        return order.map((name) => {
            const value = values.get(name);
            if (value === undefined) {
                return this.context.contractError(
                    at,
                    `Expected the pinned literal to carry '${name}'.`,
                );
            }
            return value;
        });
    }

    public lowerGeometry(): LoweredSource {
        const symbolName = "buildSplatGeometry";
        const { file, declaration } = this.declaration(
            DATA_MODULE,
            symbolName,
        );
        const rowLength = this.rowLength();
        const textureSize = this.lowerTextureSize();

        const bindings = new Map<string, PinnedBinding>([
            // The pin's parameter is an ArrayBuffer; ours is the packaged
            // bytes, and the two views it builds alias them.
            [
                "splatBuffer",
                {
                    cpp: "rows.data()",
                    bytesCpp: "rows.size()",
                    type: "u8-view",
                },
            ],
            // The module constant the stride comes from, read from the pin
            // above rather than repeated as a literal here.
            [
                "ROW_LENGTH",
                { cpp: `static_cast<double>(splat_row_length)`, type: "scalar" },
            ],
        ]);
        const lowerer: PinnedNumericLowerer = new PinnedNumericLowerer(file, {
            bindings,
            calls: new Map([
                ...MATH_CALLS,
                [
                    "chooseTextureSize",
                    (a) => `choose_splat_texture_size(${a[0]})`,
                ],
            ]),
            // The pin's returned literal, field by field onto the struct.
            // The four texture payloads are moved rather than copied; every
            // one is texelCount * 4 floats.
            returnValue: (expression): string => {
                if (
                    !expression ||
                    !ts.isObjectLiteralExpression(expression)
                ) {
                    return this.context.contractError(
                        declaration,
                        `Expected ${symbolName} to return an object literal.`,
                    );
                }
                const fields = this.objectFields(
                    expression,
                    [
                        "vertexCount",
                        "textureWidth",
                        "textureHeight",
                        "boundMin",
                        "boundMax",
                        "positions",
                        "centersRGBA",
                        "covARGBA",
                        "covBRGBA",
                        "colorsRGBA",
                    ],
                    lowerer,
                    declaration,
                );
                const moved = fields
                    .slice(5)
                    .map((field) => `std::move(${field})`);
                return `SplatGeometry{${[
                    ...fields.slice(0, 5),
                    ...moved,
                ].join(", ")}}`;
            },
        });

        const body = declaration
            .body!.statements.flatMap((statement) =>
                lowerer.statement(statement, "    "),
            )
            .join("\n");

        return {
            modulePath: DATA_MODULE,
            symbolName,
            header: `#pragma once

#include <cstdint>
#include <vector>

namespace bbl::upstream {

/** The texel grid the four splat data textures share. */
struct SplatTextureSize {
    double width;
    double height;
};

/** ${symbolName}'s result: four RGBA32F texture payloads plus the centres
 *  the sort reads and the bounds the camera frames. */
struct SplatGeometry {
    double vertexCount = 0.0;
    double textureWidth = 0.0;
    double textureHeight = 0.0;
    double boundMin[3]{};
    double boundMax[3]{};
    std::vector<float> positions;
    std::vector<float> centersRGBA;
    std::vector<float> covARGBA;
    std::vector<float> covBRGBA;
    std::vector<float> colorsRGBA;
};

/** Bytes per splat in the packaged row buffer. */
inline constexpr std::size_t splat_row_length = ${rowLength}u;

SplatGeometry build_splat_geometry(const std::vector<std::uint8_t>& rows);

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(DATA_MODULE, symbolName)}
#include <bblite/js_data.hpp>
#include <bblite/upstream/splat_geometry.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace bbl::upstream {

namespace {

// Math.hypot is implementation-approximated by the ECMAScript spec, so this
// is the plain root of the sum of squares. See splat-lowerer.ts for the
// measured effect and fidelity.json for the record. Every other JavaScript
// numeric semantic this body needs comes from <bblite/js_data.hpp>.
double pinned_hypot(std::initializer_list<double> values) {
    double sum = 0.0;
    for (double value : values) sum += value * value;
    return std::sqrt(sum);
}

} // namespace

${textureSize}

SplatGeometry build_splat_geometry(const std::vector<std::uint8_t>& rows) {
${body}
}

} // namespace bbl::upstream
`,
        };
    }

    /**
     * `loadSplat` minus the fetch and the worker.
     *
     * Upstream fetches, forks on the container, builds the geometry, spawns
     * a sort worker and attaches the renderable. Generation has already done
     * the fetch and the parse (`src/splat-packager.ts`), and this runtime has
     * no worker — the sort runs on the frame's own thread before the draw
     * that reads it, which is what `firstSortReady` is waiting for. What is
     * left is the geometry build and the scene registration, in the pin's own
     * order.
     */
    /**
     * The pinned re-sort epsilon, read from the declaration rather than
     * repeated. `pinned-depth-state.ts` states the rule this follows: typing
     * a pinned constant into the PALs agrees with the pin only until the
     * next bump.
     */
    private sortEpsilon(): string {
        return String(this.pinnedNumber(SORT_MODULE_MESH, "SORT_EPS"));
    }

    /**
     * `postSplatSortIfDirty`'s KERNEL, which is the part this port folds.
     *
     * The pinned function does three things: it declines when the worker has
     * no free order buffer, it rebuilds the four-coefficient affine kernel
     * from row 2 of `view * world` and compares it against the last posted
     * one, and it posts a sort job. Only the middle one is Babylon behaviour
     * this renderer shares — there is no worker here and no buffer pool, so
     * the sort runs inline and always has somewhere to write. That boundary
     * is stated rather than silently folded, and the arithmetic on either
     * side of it comes from the pinned loop's own AST.
     */
    private lowerSortDirty(): string {
        const { file, declaration } = this.declaration(
            SORT_MODULE_MESH,
            "postSplatSortIfDirty",
        );
        const loop = declaration.body!.statements.find((statement) =>
            ts.isForStatement(statement),
        );
        if (!loop || !ts.isForStatement(loop)) {
            this.context.contractError(
                declaration,
                "Expected postSplatSortIfDirty to build its kernel in a for loop.",
            );
        }
        // The two statements this port does NOT fold. Their presence is what
        // makes the boundary above true, so their absence refuses.
        for (const anchor of ["_orderPool", "postMessage"]) {
            if (
                !this.context.hasNode(
                    declaration,
                    (node) =>
                        (ts.isPropertyAccessExpression(node) &&
                            node.name.text === anchor) ||
                        (ts.isIdentifier(node) && node.text === anchor),
                )
            ) {
                this.context.contractError(
                    declaration,
                    `Expected postSplatSortIfDirty to reach ${anchor}; the ` +
                        "worker boundary this port folds around has moved.",
                );
            }
        }
        const bindings = new Map<string, PinnedBinding>([
            ["world", { cpp: "world", type: "f32" }],
            ["view", { cpp: "view", type: "f32" }],
            ["last", { cpp: "depth_transform", type: "f32" }],
            ["next", { cpp: "next", type: "f32" }],
            ["dirty", { cpp: "dirty", type: "bool" }],
            ["SORT_EPS", { cpp: this.sortEpsilon(), type: "scalar" }],
        ]);
        // The pin binds the three view lanes before the loop.
        for (const [name, lane] of [
            ["v0", 2],
            ["v1", 6],
            ["v2", 10],
        ] as const) {
            bindings.set(name, {
                cpp: `static_cast<double>(view[${lane}])`,
                type: "scalar",
            });
        }
        const lowerer = new PinnedNumericLowerer(file, {
            bindings,
            calls: MATH_CALLS,
        });
        return lowerer.statement(loop, "    ").join("\n");
    }

    /**
     * The pinned `update` hook's UBO half.
     *
     * `buildGaussianSplattingRenderable`'s update writes the three matrices
     * and the viewport/focal pair into one 224-byte block every frame. The
     * OFFSETS and the focal expression are the contract — the WGSL reads
     * `struct S` at exactly those lanes — so they come from the pinned
     * statements rather than being re-typed once per backend, which is where
     * they were.
     *
     * What the hook does besides that is engine plumbing with no shared
     * meaning: reading the camera, sizing the render target, uploading the
     * order buffer, and posting the sort. Those arrive here as parameters.
     */
    private lowerUniformWriter(): string {
        const modulePath =
            "src/mesh/GaussianSplatting/gaussian-splatting-pipeline.ts";
        const file = this.context.sourceFile(modulePath);
        const update = this.context
            .findNodes(
                file,
                (
                    node,
                ): node is ts.VariableDeclaration & {
                    initializer: ts.ArrowFunction;
                } =>
                    ts.isVariableDeclaration(node) &&
                    ts.isIdentifier(node.name) &&
                    node.name.text === "update" &&
                    node.initializer !== undefined &&
                    ts.isArrowFunction(node.initializer),
            )[0]?.initializer;
        if (!update || !ts.isBlock(update.body)) {
            return this.context.contractError(
                file,
                "Expected the splat renderable to build its UBO in an update hook.",
            );
        }
        // Exactly the statements that touch the block, in the pin's order.
        const writes = update.body.statements.filter(
            (statement) =>
                ts.isExpressionStatement(statement) &&
                statement.expression.getText(file).startsWith("cpu"),
        );
        if (writes.length !== 7) {
            return this.context.contractError(
                update,
                `Expected 7 UBO writes in the splat update hook, found ${writes.length}.`,
            );
        }
        const bindings = new Map<string, PinnedBinding>([
            ["cpu", { cpp: "block", type: "f32" }],
            ["world", { cpp: "world", type: "f32" }],
            ["view", { cpp: "view", type: "f32" }],
            ["proj", { cpp: "projection", type: "f32" }],
            ["size.width", { cpp: "width", type: "scalar" }],
            ["size.height", { cpp: "height", type: "scalar" }],
        ]);
        const lowerer = new PinnedNumericLowerer(file, {
            bindings,
            calls: MATH_CALLS,
            arrayCopy: (receiver, source, offset) =>
                `std::copy(${source}.begin(), ${source}.end(), ` +
                `${receiver}.begin() + static_cast<std::ptrdiff_t>(${offset}))`,
        });
        return writes
            .flatMap((statement) => lowerer.statement(statement, "    "))
            .join("\n");
    }

    public lowerLoader(): LoweredSource {
        const symbolName = "attachParsedSplat";
        const { declaration } = this.declaration(
            "src/loader-splat/load-splat.ts",
            symbolName,
        );
        // The two facts this port folds out of that function: the geometry
        // build it runs, and the SH fork that decides which pipeline
        // attaches. A pin that stops calling either changes what this slice
        // means, so both refuse rather than drift.
        for (const anchor of ["buildSplatGeometry", "attachGaussianSplattingMesh"]) {
            if (!this.context.hasCall(declaration, anchor)) {
                this.context.contractError(
                    declaration,
                    `Expected ${symbolName} to call ${anchor}.`,
                );
            }
        }
        if (
            !this.context.hasNode(
                declaration,
                (node) =>
                    ts.isPropertyAccessExpression(node) &&
                    node.name.text === "shDegree",
            )
        ) {
            this.context.contractError(
                declaration,
                "Expected attachParsedSplat to fork on shDegree; the " +
                    "spherical-harmonic pipeline is not lowered.",
            );
        }
        return {
            modulePath: "src/loader-splat/load-splat.ts",
            symbolName,
            header: "",
            source: `// ${this.context.provenance(
                "src/loader-splat/load-splat.ts",
                symbolName,
            )}
#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>
#include <bblite/upstream/splat_geometry.hpp>

#include <stdexcept>
#include <utility>

namespace bbl {

SplatMeshHandle load_splat(Scene& scene, const std::string& path) {
    if (!scene.engine) {
        throw std::runtime_error("loadSplat requires a scene engine.");
    }
    Engine& engine = *scene.engine;
    const std::vector<std::uint8_t> rows = pal::read_binary_file(path);
    if (rows.size() % upstream::splat_row_length != 0u || rows.empty()) {
        throw std::runtime_error(
            "loadSplat: packaged splat rows are not a whole number of splats.");
    }
    upstream::SplatGeometry geometry =
        upstream::build_splat_geometry(rows);

    SplatMeshRecord record;
    record.vertex_count =
        static_cast<std::uint32_t>(geometry.vertexCount);
    record.texture_width =
        static_cast<std::uint32_t>(geometry.textureWidth);
    record.texture_height =
        static_cast<std::uint32_t>(geometry.textureHeight);
    for (std::size_t axis = 0; axis < 3u; ++axis) {
        record.bound_min[axis] =
            static_cast<float>(geometry.boundMin[axis]);
        record.bound_max[axis] =
            static_cast<float>(geometry.boundMax[axis]);
    }
    record.positions = std::move(geometry.positions);
    record.centers_rgba = std::move(geometry.centersRGBA);
    record.cov_a_rgba = std::move(geometry.covARGBA);
    record.cov_b_rgba = std::move(geometry.covBRGBA);
    record.colors_rgba = std::move(geometry.colorsRGBA);

    engine.splat_meshes.push_back(std::move(record));
    const SplatMeshHandle handle{
        static_cast<std::uint32_t>(engine.splat_meshes.size() - 1)};
    scene.splat_meshes.push_back(handle);
    return handle;
}

} // namespace bbl
`,
        };
    }

    public lowerSort(): LoweredSource {
        const symbolName = "sortSplatsBackToFront";
        const { file, declaration } = this.declaration(
            SORT_MODULE,
            symbolName,
        );
        const bits = this.declaration(SORT_MODULE, "splatSortBucketBits");
        const sortDirty = this.lowerSortDirty();
        const uniformWriter = this.lowerUniformWriter();

        const bucketLowerer: PinnedNumericLowerer = new PinnedNumericLowerer(
            bits.file,
            {
                bindings: new Map<string, PinnedBinding>([
                    ["vertexCount", { cpp: "vertex_count", type: "scalar" }],
                ]),
                calls: MATH_CALLS,
                returnValue: (expression) =>
                    expression
                        ? bucketLowerer.expression(expression)
                        : "0.0",
            },
        );
        const bucketBody = bits.declaration
            .body!.statements.flatMap((statement) =>
                bucketLowerer.statement(statement, "    "),
            )
            .join("\n");

        const bindings = new Map<string, PinnedBinding>([
            ["positions", { cpp: "positions", type: "f32" }],
            ["vertexCount", { cpp: "vertex_count", type: "scalar" }],
            ["depthTransform", { cpp: "depth_transform", type: "f32" }],
            ["order", { cpp: "order", type: "u32" }],
            ["scratch", { cpp: "scratch", type: "scalar" }],
        ]);
        const lowerer = new PinnedNumericLowerer(file, {
            bindings,
            calls: MATH_CALLS,
            methods: new Map([
                [
                    "fill",
                    (receiver: string, a: readonly string[]) =>
                        `std::fill(${receiver}.begin(), ${receiver}.end(), ` +
                        `static_cast<std::uint32_t>(${a[0]}))`,
                ],
            ]),
        });
        // The pin destructures its scratch tuple by index; both halves are
        // named here so the translator resolves them as owned buffers.
        bindings.set("scratch[0]", { cpp: "scratch.depths", type: "f32" });
        bindings.set("scratch[1]", { cpp: "scratch.counts", type: "u32" });

        const body = declaration
            .body!.statements.flatMap((statement) =>
                lowerer.statement(statement, "    "),
            )
            .join("\n");

        return {
            modulePath: SORT_MODULE,
            symbolName,
            header: `#pragma once

#include <array>
#include <cstdint>
#include <vector>

namespace bbl::upstream {

/** Per-cloud scratch reused across sorts, sized once per upload. */
struct SplatSortScratch {
    std::vector<float> depths;
    std::vector<std::uint32_t> counts;
};

/** Sort-key bit width for a cloud. */
double splat_sort_bucket_bits(double vertex_count);

SplatSortScratch create_splat_sort_scratch(double vertex_count);

/** The pin's own splat UBO: three matrices then viewport/focal/dataSize. */
struct SplatUniforms {
    std::array<float, 56> block{};
};

/**
 * Fills one frame's splat UBO, at the offsets the pinned update hook writes
 * and the pinned WGSL reads.
 */
void write_splat_uniforms(
    SplatUniforms& uniforms,
    const std::array<float, 16>& world,
    const std::array<float, 16>& view,
    const std::array<float, 16>& projection,
    double width,
    double height,
    double texture_width,
    double texture_height);

/**
 * Whether the view-depth kernel drifted far enough to re-sort, updating
 * depth_transform to the new one when it did.
 *
 * The pin's postSplatSortIfDirty minus its worker queueing; the lowerer
 * states that boundary and refuses if it moves.
 */
bool splat_sort_dirty(
    const std::array<float, 16>& world,
    const std::array<float, 16>& view,
    std::array<float, 4>& depth_transform);

/** Writes the back-to-front splat order into order[0..vertex_count). */
void sort_splats_back_to_front(
    const std::vector<float>& positions,
    double vertex_count,
    const std::array<float, 4>& depth_transform,
    std::vector<std::uint32_t>& order,
    SplatSortScratch& scratch);

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(SORT_MODULE, symbolName)}
#include <bblite/js_data.hpp>
#include <bblite/upstream/splat_sort.hpp>

#include <algorithm>
#include <cmath>
#include <iterator>
#include <limits>

namespace bbl::upstream {

double splat_sort_bucket_bits(double vertex_count) {
${bucketBody}
}

void write_splat_uniforms(
    SplatUniforms& uniforms,
    const std::array<float, 16>& world,
    const std::array<float, 16>& view,
    const std::array<float, 16>& projection,
    double width,
    double height,
    double texture_width,
    double texture_height) {
    std::array<float, 56>& block = uniforms.block;
${uniformWriter}
    // dataSize and alpha are pre-written at construction upstream, where the
    // texture size is known and nothing a reached scene does changes either.
    block[48 + 4] = static_cast<float>(texture_width);
    block[48 + 5] = static_cast<float>(texture_height);
    block[48 + 6] = 1.0f;
    block[48 + 7] = 0.0f;
}

bool splat_sort_dirty(
    const std::array<float, 16>& world,
    const std::array<float, 16>& view,
    std::array<float, 4>& depth_transform) {
    std::array<float, 4> next{};
    bool dirty = false;
${sortDirty}
    if (dirty) depth_transform = next;
    return dirty;
}

SplatSortScratch create_splat_sort_scratch(double vertex_count) {
    const double bits = splat_sort_bucket_bits(vertex_count);
    SplatSortScratch scratch;
    scratch.depths.assign(static_cast<std::size_t>(vertex_count), 0.0f);
    scratch.counts.assign(
        static_cast<std::size_t>(1) << static_cast<std::int32_t>(bits),
        0u);
    return scratch;
}

void sort_splats_back_to_front(
    const std::vector<float>& positions,
    double vertex_count,
    const std::array<float, 4>& depth_transform,
    std::vector<std::uint32_t>& order,
    SplatSortScratch& scratch) {
${body}
}

} // namespace bbl::upstream
`,
        };
    }
}
