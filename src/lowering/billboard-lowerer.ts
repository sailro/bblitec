import ts from "typescript";
import { elementIndexText, LoweredSource, LoweringContext } from "./context.js";
import { PinnedShaderBuilders } from "./pinned-shader-builders.js";
import type { ShaderTextBinding } from "./pinned-shader-builders.js";
import {
    blendFactoriesCpp,
    readPinnedBlendTable,
} from "./pinned-blend-table.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import {
    type PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";
import {
    type PinnedVertexAttribute,
    pinnedVertexAttributeRows,
    vertexAttributeTableCpp,
} from "./pinned-vertex-attributes.js";
import { recordAt } from "../compiler/record-access.js";

const systemModule = "src/sprite/billboard-sprite.ts";
const sceneModule = "src/sprite/billboard-scene.ts";
const blendModule = "src/sprite/billboard-blend.ts";
const pipelineModule = "src/sprite/billboard-pipeline.ts";
const atlasModule = "src/sprite/shared/sprite-atlas.ts";
const customShaderModule = "src/sprite/billboard-custom-shader.ts";
const pickPipelineModule = "src/picking/billboard-pick-pipeline.ts";
// The particle family owns its own Multiply module, deliberately outside
// the two sprite composers: it declares no SpriteFx block at all.
const particleMultiplyModule = "src/particle/particle-billboard-renderable.ts";

/**
 * Which basis the vertex stage builds. The pin's composer emits one of two
 * functions from `system._orientation` and leaves the rest of the stage
 * identical, so this is the whole difference between the two families of
 * billboard.
 */
type BillboardOrientation = "facing" | "axis-locked";

/**
 * Which depth path a system draws through. The pin's `DEPTH_MODE_TABLE`
 * pairs `transparent` with depth writes off and `cutout` with them on, and
 * the fragment stage discards below the cutoff only on the second — so this
 * selects a fragment arm, a pipeline state, and (per the module doc) the
 * slot the system draws in.
 */
type BillboardDepthMode = "transparent" | "cutout";

/** A custom-shader program: the caller's fragment body and its extra textures. */
interface BillboardCustomProgram {
    fragment: string;
    extraTextures: readonly string[];
}

/**
 * World-space billboards, lowered from the pinned billboard family.
 *
 * The 2D sprite family that already ships and this one are the same shape
 * twice — an atlas, a packed instance buffer, a quad expanded in the vertex
 * stage — so this mirrors `SpriteLowerer` deliberately, down to which
 * contracts it asserts. What differs is the only thing that matters: the
 * quad is expanded in WORLD space around a camera-derived basis, and it
 * draws inside the scene's own pass against the scene depth buffer, which
 * is why the pinned shader binds the scene UBO at group 0 rather than
 * owning a view of its own.
 *
 * Only the permutation reached by scene code is lowered: camera-facing,
 * straight-alpha, no custom shader and no alpha-to-coverage. Every other
 * arm refuses at the intrinsic rather than silently rendering the wrong one.
 */
export class BillboardLowerer {
    private readonly shaderText: PinnedShaderBuilders;

    public constructor(private readonly context: LoweringContext) {
        this.shaderText = new PinnedShaderBuilders(context);
    }

    // -----------------------------------------------------------------
    // Pinned contracts
    // -----------------------------------------------------------------

    /** The instance layout, read from the pin's own constants. */
    private layout(): {
        instanceFloats: number;
        anchorFloats: number;
        systemUboBytes: number;
    } {
        const constant = (module: string, name: string): number => {
            const file = this.context.sourceFile(module);
            return this.context.numericValue(
                this.context.variableInitializer(file, name),
                file,
            );
        };
        return {
            instanceFloats: constant(
                systemModule,
                "BILLBOARD_INSTANCE_FLOATS_PER_SPRITE",
            ),
            anchorFloats: constant(
                systemModule,
                "BILLBOARD_ANCHOR_FLOATS_PER_SPRITE",
            ),
            systemUboBytes: constant(
                pipelineModule,
                "BILLBOARD_SYSTEM_UBO_BYTES",
            ),
        };
    }

    /**
     * The vertex attributes, as the pinned render pipeline's own `attributes`
     * literal declares them. Reading the offsets rather than deriving them
     * from the slot order is what makes a reordered pin fail loudly instead
     * of drawing garbage.
     */
    private attributeRows(instanceFloats: number): PinnedVertexAttribute[] {
        const literals = this.context.findNodes(
            this.context.sourceFile(pipelineModule),
            (node): node is ts.PropertyAssignment =>
                ts.isPropertyAssignment(node) &&
                this.context.propertyName(node.name) === "attributes",
        );
        if (literals.length !== 1) {
            return this.context.contractError(
                this.context.sourceFile(pipelineModule),
                `Expected one pinned billboard vertex attribute list, found ${literals.length}.`,
            );
        }
        return pinnedVertexAttributeRows(
            this.context,
            literals[0]!.initializer,
            instanceFloats,
        );
    }

    /** `writeInstance` writes each slot from the source the pin names. */
    private assertInstanceSlots(): void {
        const { file, declaration } = this.context.functionDeclaration(
            systemModule,
            "writeInstance",
        );
        // The F64 anchor stored beside the F32 position lanes, which the
        // floating-origin uploads subtract the camera offset from.
        const anchorStores = this.context.findNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isElementAccessExpression(node.left) &&
                node.left.expression.getText(file) === "system._anchor",
        );
        (["posX", "posY", "posZ"] as const).forEach((source, lane) => {
            const store = anchorStores.find(
                (node) =>
                    ts.isElementAccessExpression(node.left) &&
                    elementIndexText(node.left) ===
                        (lane === 0 ? "anchorBase" : `anchorBase + ${lane}`),
            );
            if (!store) {
                this.context.contractError(
                    declaration,
                    `Pinned billboard writeInstance no longer stores anchor lane ${lane}.`,
                );
            }
            this.context.assertExpressionShape(
                store.right,
                source,
                `billboard writeInstance anchor lane ${lane}`,
            );
        });
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "posX"),
            "props.position ? props.position[0] : system._anchor[anchorBase]",
            "billboard writeInstance posX",
        );
        const expected: ReadonlyArray<[number, string]> = [
            [0, "posX"],
            [1, "posY"],
            [2, "posZ"],
            [3, "visible ? trueWidth : 0"],
            [4, "visible ? trueHeight : 0"],
            [5, "uvMinX"],
            [6, "uvMinY"],
            [7, "uvMaxX"],
            [8, "uvMaxY"],
            [9, "rotation"],
            [10, "pivotX"],
            [11, "pivotY"],
        ];
        const writes = this.context.pinnedElementStores(declaration, "data");
        for (const [slot, source] of expected) {
            const write = writes.find(
                (node) => elementIndexText(node.left) === `base + ${slot}`,
            );
            if (!write) {
                this.context.contractError(
                    declaration,
                    `Pinned billboard writeInstance no longer writes slot ${slot}.`,
                );
            }
            this.context.assertExpressionShape(
                write.right,
                source,
                `billboard writeInstance slot ${slot}`,
            );
        }
        // Colour writes twice — the props arm and the add default — so it is
        // checked by count, the way the 2D layer's is.
        for (const slot of [12, 13, 14, 15]) {
            const found = writes.filter(
                (node) => elementIndexText(node.left) === `base + ${slot}`,
            );
            if (found.length !== 2) {
                this.context.contractError(
                    declaration,
                    `Pinned billboard colour slot ${slot} has ${found.length} writers, expected 2.`,
                );
            }
        }
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "base"),
            "slotIndex * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE",
            "billboard writeInstance base",
        );
        // The flip resolution is what makes flipX an absolute orientation
        // rather than a toggle.
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "currentFlipX"),
            "uvMinX > uvMaxX",
            "billboard writeInstance currentFlipX",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "wantsFlipX"),
            "props.flipX !== undefined ? props.flipX === true : prevFlipX",
            "billboard writeInstance wantsFlipX",
        );
        // On add, the pivot falls back to the frame's own pivot; a scene that
        // omits it must not silently get the centre of a frame that names
        // another anchor.
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "pivotX"),
            "props.pivot ? props.pivot[0] : prev ? prev[10] : (frame?.pivot[0] ?? 0.5)",
            "billboard writeInstance pivotX",
        );
    }

    /** The system's defaults, which the intrinsic reproduces for an add. */
    private assertSystemDefaults(): void {
        const { declaration } = this.context.functionDeclaration(
            systemModule,
            "createBillboardSystem",
        );
        for (const [name, shape] of [
            ["blendMode", "opts.blendMode ?? billboardBlendAlpha"],
            ["capacity", "Math.max(1, opts.capacity ?? DEFAULT_CAPACITY)"],
            ["depthMode", "blendMode._depthMode"],
        ] as const) {
            this.context.assertExpressionShape(
                this.context.variableInitializer(declaration, name),
                shape,
                `createBillboardSystem ${name}`,
            );
        }
        // The capacity shape above anchors DEFAULT_CAPACITY by name only;
        // the VALUE is what the intrinsic and runtime.hpp restate, so it is
        // read and checked the way the 2D lane checks sprite-2d's own
        // constant (they are independent pinned constants that both happen
        // to be 16 today).
        const file = this.context.sourceFile(systemModule);
        const defaultCapacity = this.context.numericValue(
            this.context.variableInitializer(file, "DEFAULT_CAPACITY"),
            file,
        );
        if (defaultCapacity !== 16) {
            this.context.contractError(
                file,
                `Pinned billboard DEFAULT_CAPACITY changed: ${defaultCapacity}.`,
            );
        }
        // The slot each depth mode draws in. Nothing stores this number --
        // the record carries the mode and both backends select on it -- but
        // the mapping it states is what the two draw slots ARE, so a pin
        // that retunes it has to fail generation rather than leave the
        // backends drawing in the old order.
        this.context.assertExpressionShape(
            this.context.propertyInitializer(
                this.context.objectInitializer(declaration, "system"),
                "order",
            ),
            'opts.order ?? (depthMode === "transparent" ? 200 : 100)',
            "createBillboardSystem order",
        );
        // A facing system's axis is the zero vector, which the UBO carries
        // and the facing basis ignores.
        this.context.assertExpressionShape(
            this.context.callExpression(
                this.context.functionDeclaration(
                    systemModule,
                    "createFacingBillboardSystem",
                ).declaration,
                "createBillboardSystem",
            ),
            'createBillboardSystem(atlas, "facing", [0, 0, 0], opts)',
            "createFacingBillboardSystem",
        );
        // The axis-locked factory normalises its axis before storing it, and
        // the basis reads `normalize(billboards.axisAndCutoff.xyz)` again --
        // so a scene's raw axis has to be normalised at the same point the
        // pin normalises it, not left to the shader.
        const axisLocked = this.context.functionDeclaration(
            systemModule,
            "createAxisLockedBillboardSystem",
        ).declaration;
        this.context.assertExpressionShape(
            this.context.variableInitializer(axisLocked, "lengthSq"),
            "axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]",
            "createAxisLockedBillboardSystem lengthSq",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(axisLocked, "invLength"),
            "1 / Math.sqrt(lengthSq)",
            "createAxisLockedBillboardSystem invLength",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(axisLocked, "normalized"),
            "[axis[0] * invLength, axis[1] * invLength, axis[2] * invLength]",
            "createAxisLockedBillboardSystem normalized",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                this.context.functionDeclaration(systemModule, "resolveOpacity")
                    .declaration,
                "opacity",
            ),
            "opts.opacity ?? 1",
            "resolveOpacity",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                this.context.functionDeclaration(
                    systemModule,
                    "resolveAlphaCutoff",
                ).declaration,
                "cutoff",
            ),
            'opts.alphaCutoff ?? (depthMode === "cutout" ? 0.5 : 0)',
            "resolveAlphaCutoff",
        );
    }

    /** The transparent arm draws without writing depth. */
    private assertDepthMode(): void {
        const file = this.context.sourceFile(pipelineModule);
        this.context.assertExpressionShape(
            this.context.variableInitializer(file, "DEPTH_MODE_TABLE"),
            "{ transparent: { index: 0, writeEnabled: false }, cutout: { index: 1, writeEnabled: true } }",
            "DEPTH_MODE_TABLE",
        );
    }

    /**
     * `buildBillboardSystemUbo`, translated from `billboard-pipeline.ts`:
     * the opacity multiplier (straight alpha scales only A; a premultiplied
     * source scales RGB too), the lock axis and the alpha cutoff.
     */
    private systemUboCpp(systemUboBytes: number): string {
        const scalar = (cpp: string): PinnedBinding => ({
            cpp: `static_cast<double>(${cpp})`,
            type: "scalar",
        });
        return lowerPinnedFunction(
            this.context,
            pipelineModule,
            "buildBillboardSystemUbo",
            [
                {
                    pinned: "system",
                    kind: "record",
                    cpp: "system",
                    cppType: "BillboardSystemRecord",
                    annotation: "BillboardSpriteSystem",
                },
                {
                    pinned: "ubo",
                    kind: "f32Buffer",
                    cpp: "ubo",
                    cppType: `std::array<float, ${systemUboBytes / 4}>`,
                    mutableRecord: true,
                },
            ],
            {
                cppName: "build_billboard_system_ubo",
                returns: "void",
                inline: true,
                memberBindings: new Map<string, PinnedBinding>([
                    ["system.opacity", scalar("system.opacity")],
                    [
                        "system.blendMode._premultipliedOpacity",
                        {
                            cpp: "system.blend.premultiplied_opacity",
                            type: "bool",
                        },
                    ],
                    ["system._axis[0]", scalar("system.axis.x")],
                    ["system._axis[1]", scalar("system.axis.y")],
                    ["system._axis[2]", scalar("system.axis.z")],
                    ["system.alphaCutoff", scalar("system.alpha_cutoff")],
                ]),
            },
        );
    }

    /**
     * The two expressions of `uploadSortedBillboardInstances` that decide a
     * transparent system's draw order, translated from the pin: the view
     * depth each anchor is keyed by (stored through the pin's `F32` depth
     * scratch), and the comparator the index list is sorted with -- far to
     * near, ties by logical index.
     *
     * The transparent draw is back to front; with depth writes off, the
     * order the instances are drawn in IS the composite, so these two decide
     * the image.
     */
    private sortKeyCpp(): string {
        const { file, declaration } = this.context.functionDeclaration(
            pipelineModule,
            "uploadSortedBillboardInstances",
        );
        const stores = this.context.pinnedElementStores(declaration, "depths");
        const depth = stores[0];
        if (stores.length !== 1 || !depth) {
            return this.context.contractError(
                declaration,
                "Pinned billboard sort no longer writes one depth per anchor.",
            );
        }
        const sorts = this.context.findNodes(
            declaration,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === "sort",
        );
        const sort = sorts[0];
        const comparator = sort?.arguments[0]
            ? this.context.unwrapExpression(sort.arguments[0])
            : undefined;
        if (
            sorts.length !== 1 ||
            !sort ||
            !comparator ||
            !ts.isArrowFunction(comparator) ||
            ts.isBlock(comparator.body) ||
            comparator.parameters
                .map((parameter) => parameter.name.getText(file))
                .join(",") !== "left,right"
        ) {
            return this.context.contractError(
                declaration,
                "Pinned billboard sort no longer orders its indices by one (left, right) comparator.",
            );
        }
        this.context.assertExpressionShape(
            sort.expression,
            "indices.subarray(0, count).sort",
            "billboard sort range",
        );
        // The anchor each sprite sorts and uploads by is the F64 `_anchor`
        // made eye-relative, never the F32 lane: at world scale the F32
        // store has already quantised the position.
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "anchors"),
            "system._anchor",
            "billboard sort anchors",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "anchorBase"),
            "index * BILLBOARD_ANCHOR_FLOATS_PER_SPRITE",
            "billboard sort anchor base",
        );
        const sortedStores = this.context.pinnedElementStores(
            declaration,
            "sortedData",
        );
        (["X", "Y", "Z"] as const).forEach((axis, lane) => {
            const store = sortedStores.find(
                (node) =>
                    elementIndexText(node.left) ===
                    (lane === 0 ? "destBase" : `destBase + ${lane}`),
            );
            if (!store) {
                this.context.contractError(
                    declaration,
                    `Pinned billboard sort no longer stages anchor lane ${lane}.`,
                );
            }
            this.context.assertExpressionShape(
                store.right,
                lane === 0
                    ? `anchors[sourceAnchorBase] - fo${axis}`
                    : `anchors[sourceAnchorBase + ${lane}] - fo${axis}`,
                `billboard sorted anchor lane ${lane}`,
            );
        });
        const lane = (name: string): PinnedBinding => ({
            cpp: name,
            type: "scalar",
        });
        const anchorLowerer = new PinnedNumericLowerer(file, {
            bindings: new Map<string, PinnedBinding>([
                ["anchors", { cpp: "system.anchor", type: "f64-buffer" }],
                ["anchorBase", lane("anchor_base")],
                ["foX", lane("fo_offset.x")],
                ["foY", lane("fo_offset.y")],
                ["foZ", lane("fo_offset.z")],
            ]),
            calls: new Map(),
        });
        const anchor = (axis: "X" | "Y" | "Z"): string =>
            anchorLowerer.expression(
                this.context.variableInitializer(declaration, `anchor${axis}`),
            );
        const depthLowerer = new PinnedNumericLowerer(file, {
            bindings: new Map<string, PinnedBinding>([
                ["cameraViewMatrix", { cpp: "view", type: "f32" }],
                ["anchorX", lane("anchor_x")],
                ["anchorY", lane("anchor_y")],
                ["anchorZ", lane("anchor_z")],
            ]),
            calls: new Map(),
        });
        const compareLowerer = new PinnedNumericLowerer(file, {
            bindings: new Map<string, PinnedBinding>([
                ["depths", { cpp: "depths", type: "f32" }],
                ["left", lane("left")],
                ["right", lane("right")],
            ]),
            calls: new Map(),
        });
        const provenance = this.context.provenance(
            pipelineModule,
            "uploadSortedBillboardInstances",
        );
        return `// ${provenance}
// One sprite's eye-relative anchor (\`anchorX/Y/Z\`): the F64 \`_anchor\` less
// the camera offset, zero where no floating origin applies.
inline Vec3d billboard_eye_relative_anchor(
    const BillboardSystemRecord& system,
    double anchor_base,
    Vec3d fo_offset) {
    return Vec3d{${anchor("X")}, ${anchor("Y")}, ${anchor("Z")}};
}

// ${provenance}
// The view depth an anchor sorts by (\`depths[index] = ...\`).
inline double billboard_sort_depth(
    const std::array<float, 16>& view,
    double anchor_x,
    double anchor_y,
    double anchor_z) {
    return ${depthLowerer.expression(depth.right)};
}

// ${provenance}
// The index comparator (\`indices.subarray(0, count).sort(...)\`): negative
// when \`left\` draws first.
inline double billboard_sort_compare(
    const std::vector<float>& depths,
    double left,
    double right) {
    return ${compareLowerer.expression(comparator.body)};
}`;
    }

    /**
     * `uploadSystem`'s fork between the sorted and the insertion-order
     * upload: a transparent system sorts only when its pass has a camera,
     * and every other upload keeps the logical order. Returned as the pin's
     * own text for the emitted comment; the native condition is this
     * expression over the system's depth mode and the pass camera.
     */
    private uploadCondition(): string {
        const { file, declaration } = this.context.functionDeclaration(
            "src/sprite/billboard-renderable.ts",
            "uploadSystem",
        );
        const forks = this.context.findNodes(
            declaration,
            (node): node is ts.IfStatement =>
                ts.isIfStatement(node) &&
                node.elseStatement !== undefined &&
                this.context
                    .findNodes(
                        node.thenStatement,
                        (call): call is ts.CallExpression =>
                            ts.isCallExpression(call) &&
                            call.expression.getText(file) ===
                                "uploadSortedBillboardInstances",
                    )
                    .some(() => true),
        );
        const fork = forks[0];
        if (forks.length !== 1 || !fork) {
            return this.context.contractError(
                declaration,
                "Expected uploadSystem to fork once between the sorted and the unsorted upload.",
            );
        }
        this.context.assertExpressionShape(
            fork.expression,
            'renderable._system._depthMode === "transparent" && camera',
            "billboard sorted-upload condition",
        );
        return fork.expression.getText(file);
    }

    /** The quad the vertex stage expands, and the draw that issues it. */
    private assertQuad(): void {
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                this.context.sourceFile(pipelineModule),
                "BILLBOARD_INDEX_DATA",
            ),
            "new U16([0, 1, 2, 0, 2, 3])",
            "billboard index data",
        );
    }

    /** `addFacingBillboardSystem` joins the scene's own renderables. */
    private assertSceneRegistration(): void {
        const { declaration } = this.context.functionDeclaration(
            sceneModule,
            "addFacingBillboardSystem",
        );
        this.context.assertExpressionShape(
            this.context.callExpression(declaration, "addBillboardSystem"),
            "addBillboardSystem(scene, system)",
            "addFacingBillboardSystem",
        );
        if (
            !this.context.hasCall(
                this.context.functionDeclaration(
                    sceneModule,
                    "addBillboardSystem",
                ).declaration,
                "addDeferredSceneRenderables",
            )
        ) {
            this.context.contractError(
                declaration,
                "Expected a billboard system to register as a deferred scene renderable.",
            );
        }
    }

    // -----------------------------------------------------------------
    // Shader
    // -----------------------------------------------------------------

    /**
     * The module the pin hands WebGPU for a system's program, built by
     * evaluating its own builder: `makeBillboardWgsl` for the stock
     * program, or `makeCustomBillboardWgsl`, the pin's second composer,
     * which keeps the world-space vertex stage, exposes the view distance
     * and world position to the caller's body, and adds the fx block and
     * extra textures. It is deployed whole, the pin's scene group at 0 and
     * the system's own at 1, and the compaction re-homes both for SDL_GPU.
     */
    public module(
        orientation: BillboardOrientation,
        depthMode: BillboardDepthMode,
        custom?: BillboardCustomProgram,
    ): string {
        return custom === undefined
            ? this.shaderText.evaluate(
                  pipelineModule,
                  "makeBillboardWgsl",
                  new Map<string, ShaderTextBinding>([
                      ["orientation", orientation],
                      ["depthMode", depthMode],
                      ["alphaToCoverage", false],
                  ]),
              )
            : this.shaderText.evaluate(
                  customShaderModule,
                  "makeCustomBillboardWgsl",
                  // The three the pin's own composer takes: it has no
                  // depth or coverage arm, so binding those would pre-fill
                  // a parameter a later pin could add under either name.
                  new Map<string, ShaderTextBinding>([
                      ["orientation", orientation],
                      [
                          "extraTextures",
                          custom.extraTextures.map((name) => ({ name })),
                      ],
                      ["fragment", custom.fragment],
                  ]),
              );
    }

    /**
     * The particle family's private Multiply module.
     *
     * It is a third billboard composer, not this one with a fragment swapped
     * in: `particle-billboard-renderable.ts` writes its own whole module so
     * the Multiply-only bundle carries no `SpriteFx` declaration, layout
     * entry or per-frame write at all.
     */
    public particleMultiplyModule(orientation: BillboardOrientation): string {
        return this.shaderText.evaluate(
            particleMultiplyModule,
            "makeMultiplyWgsl",
            new Map<string, ShaderTextBinding>([["orientation", orientation]]),
        );
    }
    /**
     * `packBillboardPickUbo`, translated from `billboard-pick-pipeline.ts`.
     *
     * The pin packs the 48-byte `BB` block through two aliased views of one
     * buffer -- `f32` for the camera basis, cutoff and axis, `u32` for the
     * base id -- so both views bind the caller's one block, and each lane
     * the body stores names the member the WGSL struct puts there. It rides
     * the billboard header because only a billboard system's pick draws it.
     */
    private packPickUboCpp(): string {
        const members: ReadonlyArray<readonly [string, string]> = [
            ["f32[0]", "out.cam_right[0]"],
            ["f32[1]", "out.cam_right[1]"],
            ["f32[2]", "out.cam_right[2]"],
            ["u32[3]", "out.base_id"],
            ["f32[4]", "out.cam_up[0]"],
            ["f32[5]", "out.cam_up[1]"],
            ["f32[6]", "out.cam_up[2]"],
            ["f32[7]", "out.cutoff"],
            ["f32[8]", "out.axis[0]"],
            ["f32[9]", "out.axis[1]"],
            ["f32[10]", "out.axis[2]"],
        ];
        return lowerPinnedFunction(
            this.context,
            pickPipelineModule,
            "packBillboardPickUbo",
            [
                { pinned: "view", kind: "mat4Const", cpp: "view" },
                { pinned: "baseId", kind: "number", cpp: "base_id" },
                { pinned: "cutoff", kind: "number", cpp: "cutoff" },
                {
                    pinned: "axis",
                    kind: "record",
                    cpp: "axis",
                    cppType: "Vec3",
                    annotation: "readonly [number, number, number]",
                },
                {
                    pinned: "f32",
                    kind: "f32Buffer",
                    cpp: "out",
                    specialized: true,
                    binding: { cpp: "out", type: "f32" },
                },
                {
                    pinned: "u32",
                    kind: "u32Buffer",
                    cpp: "out",
                    specialized: true,
                    binding: { cpp: "out", type: "u32" },
                },
            ],
            {
                cppName: "pack_billboard_pick_ubo",
                returns: "void",
                inline: true,
                templateParameters: ["typename PickBlock"],
                trailingParameters: ["PickBlock& out"],
                memberBindings: new Map<string, PinnedBinding>([
                    ...(["x", "y", "z"] as const).map(
                        (axis, lane): [string, PinnedBinding] => [
                            `axis[${lane}]`,
                            {
                                cpp: `static_cast<double>(axis.${axis})`,
                                type: "scalar",
                            },
                        ],
                    ),
                    ...members.map(([pinned, cpp]): [string, PinnedBinding] => [
                        pinned,
                        { cpp, type: "scalar", mutable: true },
                    ]),
                ]),
            },
        );
    }

    // -----------------------------------------------------------------
    // Emission
    // -----------------------------------------------------------------

    public lowerCore(): LoweredSource {
        const layout = this.layout();
        const rows = this.attributeRows(layout.instanceFloats);
        this.assertSystemDefaults();
        const blends = readPinnedBlendTable(
            this.context,
            blendModule,
            "billboardBlend",
        );
        this.assertDepthMode();
        this.assertInstanceSlots();
        this.assertQuad();
        this.assertSceneRegistration();
        // The squared axis length below which the axis-locked factory
        // refuses the axis as zero, read off its own `lengthSq < <floor>`.
        const axisLocked = this.context.functionDeclaration(
            systemModule,
            "createAxisLockedBillboardSystem",
        );
        const floors = this.context.findNodes(
            axisLocked.declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.LessThanToken &&
                ts.isIdentifier(node.left) &&
                node.left.text === "lengthSq",
        );
        if (floors.length !== 1) {
            this.context.contractError(
                axisLocked.declaration,
                "Expected createAxisLockedBillboardSystem to refuse one " +
                    "lengthSq floor.",
            );
        }
        const zeroAxisFloor = this.context.doubleLiteral(
            this.context.numericValue(floors[0]!.right, axisLocked.file),
        );
        const uploadCondition = this.uploadCondition();

        const provenance = this.context.provenance(
            systemModule,
            "createFacingBillboardSystem, addBillboardSpriteIndex",
            `${sceneModule}#addFacingBillboardSystem, ${blendModule}#billboardBlendAlpha, ${pipelineModule}#buildBillboardSystemUbo, ${atlasModule}#resolveSpriteFrame`,
        );
        return {
            modulePath: systemModule,
            symbolName:
                "createFacingBillboardSystem,addBillboardSpriteIndex,addFacingBillboardSystem",
            header: `#pragma once

// ${this.context.provenance(pipelineModule, "billboard vertex layout")}
#include <bblite/js_data.hpp>
#include <bblite/runtime.hpp>
#include <bblite/features/has_picking.hpp>
#include <bblite/upstream/render_capabilities.hpp>

#include <algorithm>
#include <array>
#include <cstdint>
#include <numeric>
#include <vector>

namespace bbl::upstream {

/**
 * The per-instance vertex attributes at the pin's own byte offsets, and the
 * stride billboard-sprite.ts derives from its floats-per-sprite. Both render
 * backends translate these rows into their API's descriptors, so the numbers
 * exist once, here.
 */
struct BillboardInstanceAttribute {
    std::uint32_t shader_location;
    std::uint32_t byte_offset;
    std::uint32_t float_count;
};

${vertexAttributeTableCpp("BillboardInstanceAttribute", "billboard_instance_attributes", rows)}

inline constexpr std::uint32_t billboard_instance_stride_bytes =
    ${layout.instanceFloats * 4}u;

inline constexpr std::uint32_t billboard_system_ubo_bytes = ${layout.systemUboBytes}u;

/** \`BILLBOARD_ANCHOR_FLOATS_PER_SPRITE\`: the F64 \`_anchor\` lanes per sprite. */
inline constexpr std::uint32_t billboard_anchor_floats_per_sprite = ${layout.anchorFloats}u;
#if BBLITE_HAS_PICKING

${this.packPickUboCpp()}
#endif

} // namespace bbl::upstream

namespace bbl {

/**
 * billboard-blend.ts: each exported descriptor that names a colour blend, as
 * the factory scene code reaches when it imports that descriptor by name.
 * They live here rather than in the system's own translation unit because
 * the scene names one at the call site.
 */
${blendFactoriesCpp(blends, "billboard", "billboard-blend.ts")}
} // namespace bbl

namespace bbl::upstream {

/** The quad, expanded in the vertex stage; six indices, one draw. */
inline constexpr std::array<std::uint16_t, 6> billboard_index_data{
    {0u, 1u, 2u, 0u, 2u, 3u}};


/**
 * The per-system block: the opacity multiplier, the lock axis (the facing
 * system's zero vector, which the facing basis ignores) and the cutoff,
 * which the transparent arm leaves unread.
 */
${this.systemUboCpp(layout.systemUboBytes)}

${this.sortKeyCpp()}

/**
 * uploadSortedBillboardInstances: the instance data, reordered back to front
 * for one view.
 *
 * Both backends upload the result verbatim, and neither may decide the
 * order: with depth writes off it IS the composite, so a per-backend copy of
 * this would be a per-backend copy of the image. The depth and the
 * comparator are the pin's own (above); each sorts by the F64 anchor made
 * eye-relative, and the depths are stored at the pin's float width before
 * the comparator reads them. The staged position lanes are that same
 * eye-relative anchor, stored once into float.
 */
inline void billboard_sorted_instances(
    const BillboardSystemRecord& system,
    const std::array<float, 16>& view,
    std::vector<float>& out,
    Vec3d fo_offset) {
    const std::size_t floats = system.instance_floats_per_sprite;
    out.resize(static_cast<std::size_t>(system.count) * floats);
    if (system.count == 0) {
        return;
    }
    std::vector<std::uint32_t> order(system.count);
    std::iota(order.begin(), order.end(), 0u);
    std::vector<float> depths(system.count);
    for (std::uint32_t index = 0; index < system.count; ++index) {
        const Vec3d anchor = billboard_eye_relative_anchor(
            system,
            static_cast<double>(index * billboard_anchor_floats_per_sprite),
            fo_offset);
        depths[index] = static_cast<float>(billboard_sort_depth(
            view, anchor.x, anchor.y, anchor.z));
    }
    std::sort(
        order.begin(),
        order.end(),
        [&](std::uint32_t left, std::uint32_t right) {
            return billboard_sort_compare(depths, left, right) < 0.0;
        });
    for (std::uint32_t slot = 0; slot < system.count; ++slot) {
        const std::size_t source =
            static_cast<std::size_t>(order[slot]) * floats;
        const std::size_t destination =
            static_cast<std::size_t>(slot) * floats;
        for (std::size_t field = 0; field < floats; ++field) {
            out[destination + field] =
                system.instance_data[source + field];
        }
        const Vec3d anchor = billboard_eye_relative_anchor(
            system,
            static_cast<double>(order[slot] * billboard_anchor_floats_per_sprite),
            fo_offset);
        out[destination + 0u] = static_cast<float>(anchor.x);
        out[destination + 1u] = static_cast<float>(anchor.y);
        out[destination + 2u] = static_cast<float>(anchor.z);
    }
}

/**
 * uploadBillboardInstances: the instances in logical insertion order. Under
 * a non-zero floating-origin offset every anchor is re-staged eye-relative
 * from the F64 \`_anchor\`, as the pin's own arm does; otherwise the F32
 * lanes upload as stored.
 */
inline void billboard_unsorted_instances(
    const BillboardSystemRecord& system,
    std::vector<float>& out,
    Vec3d fo_offset) {
    const std::size_t floats = system.instance_floats_per_sprite;
    out.assign(
        system.instance_data.begin(),
        system.instance_data.begin() +
            static_cast<std::ptrdiff_t>(
                static_cast<std::size_t>(system.count) * floats));
    if (fo_offset.x == 0.0 && fo_offset.y == 0.0 && fo_offset.z == 0.0) {
        return;
    }
    for (std::uint32_t index = 0; index < system.count; ++index) {
        const Vec3d anchor = billboard_eye_relative_anchor(
            system,
            static_cast<double>(index * billboard_anchor_floats_per_sprite),
            fo_offset);
        const std::size_t base = static_cast<std::size_t>(index) * floats;
        out[base + 0u] = static_cast<float>(anchor.x);
        out[base + 1u] = static_cast<float>(anchor.y);
        out[base + 2u] = static_cast<float>(anchor.z);
    }
}

/**
 * The instance data a system uploads this frame, in the order the pin's
 * \`${uploadCondition}\` gives it (billboard-renderable.ts uploadSystem).
 *
 * A transparent system writes no depth, so the draw order IS the composite
 * and, with a camera, the instances are staged back to front for its view.
 * A cutout system -- or a pass without a camera -- uploads in logical
 * insertion order. \`fo_offset\` is the pass camera's world translation
 * under floating origin and the zero vector otherwise. Neither backend
 * chooses: a per-backend copy of this choice would be a per-backend copy of
 * the image.
 */
inline void billboard_upload_instances(
    const BillboardSystemRecord& system,
    bool has_camera,
    const std::array<float, 16>& view,
    std::vector<float>& out,
    Vec3d fo_offset) {
    if (system.depth_mode == BillboardDepthMode::transparent && has_camera) {
        billboard_sorted_instances(system, view, out, fo_offset);
    } else {
        billboard_unsorted_instances(system, out, fo_offset);
    }
}

} // namespace bbl::upstream
`,
            source: `// ${provenance}
#include <bblite/runtime.hpp>
#include <bblite/upstream/billboard_system.hpp>
// resolveSpriteFrame is the shared atlas module's, lowered once beside the
// 2D layer's own layout.
#include <bblite/upstream/sprite_layer.hpp>

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace bbl {

// createBillboardSystem: both factories delegate here, differing only in the
// orientation and the axis it carries. A facing system's axis is the pin's
// zero vector -- its basis reads the camera, not the axis.
BillboardSystemHandle create_billboard_system(
    Engine& engine,
    SpriteAtlasHandle atlas,
    BillboardOrientation orientation,
    Vec3 axis,
    BillboardSystemOptions options) {
    if (atlas.value >= engine.sprite_atlases.size()) {
        throw std::runtime_error("Invalid sprite atlas handle.");
    }
    BillboardSystemRecord system;
    system.atlas = atlas;
    system.blend = options.blend;
    system.add_pass_blend = options.add_pass_blend;
    // initSystem, through the fx hook: a system built with a descriptor
    // draws that program, its extra textures bind after the atlas, and
    // its params start zeroed.
    system.custom_shader = options.custom_shader;
    system.custom_textures = std::move(options.custom_textures);
    system.custom_texture_names = std::move(options.custom_texture_names);
    system.opacity = options.opacity;
    system.visible = options.visible;
    system.orientation = orientation;
    // resolveAlphaCutoff follows the descriptor's depth mode, and so does
    // the slot the system draws in -- which is the mode itself, so only the
    // mode is stored.
    const bool cutout =
        options.blend.depth_mode == BillboardDepthMode::cutout;
    system.depth_mode = options.blend.depth_mode;
    // createAxisLockedBillboardSystem: the axis is normalised before it is
    // stored, and a non-finite or zero axis is rejected. The basis
    // normalises again in WGSL, but a zero axis has no direction to recover
    // there, so the refusal belongs here as it does upstream.
    if (orientation == BillboardOrientation::axis_locked) {
        const double length_sq =
            static_cast<double>(axis.x) * axis.x +
            static_cast<double>(axis.y) * axis.y +
            static_cast<double>(axis.z) * axis.z;
        if (!std::isfinite(length_sq)) {
            throw std::runtime_error(
                "createAxisLockedBillboardSystem: axis components must be "
                "finite numbers.");
        }
        if (length_sq < ${zeroAxisFloor}) {
            throw std::runtime_error(
                "createAxisLockedBillboardSystem: axis must be non-zero.");
        }
        const double inv_length = 1.0 / std::sqrt(length_sq);
        axis = Vec3{
            static_cast<float>(axis.x * inv_length),
            static_cast<float>(axis.y * inv_length),
            static_cast<float>(axis.z * inv_length)};
    }
    system.axis = axis;
    system.alpha_cutoff = options.has_alpha_cutoff
        ? options.alpha_cutoff
        : (cutout ? 0.5f : 0.0f);
    system.instance_floats_per_sprite = ${layout.instanceFloats}u;
    system.capacity = static_cast<std::uint32_t>(
        std::max(1.0, static_cast<double>(options.capacity)));
    system.instance_data.assign(
        static_cast<std::size_t>(system.capacity) *
            system.instance_floats_per_sprite,
        0.0f);
    system.anchor.assign(
        static_cast<std::size_t>(system.capacity) *
            upstream::billboard_anchor_floats_per_sprite,
        0.0);
    engine.billboard_systems.push_back(std::move(system));
    return BillboardSystemHandle{
        static_cast<std::uint32_t>(
            engine.billboard_systems.size() - 1u)};
}

// writeInstance's position stores: the F32 lanes and the F64 \`_anchor\`
// beside them, both from the pin's number triple.
static void write_billboard_position(
    BillboardSystemRecord& system,
    std::uint32_t index,
    Vec3d position) {
    const std::size_t base =
        static_cast<std::size_t>(index) * system.instance_floats_per_sprite;
    system.instance_data[base + 0u] = static_cast<float>(position.x);
    system.instance_data[base + 1u] = static_cast<float>(position.y);
    system.instance_data[base + 2u] = static_cast<float>(position.z);
    const std::size_t anchor_base =
        static_cast<std::size_t>(index) * upstream::billboard_anchor_floats_per_sprite;
    system.anchor[anchor_base + 0u] = position.x;
    system.anchor[anchor_base + 1u] = position.y;
    system.anchor[anchor_base + 2u] = position.z;
}

double add_billboard_sprite_index(
    Engine& engine,
    BillboardSystemHandle system_handle,
    BillboardSpriteProps props) {
    BillboardSystemRecord& system =
        ${recordAt("engine.billboard_systems", "system_handle")};
    const SpriteAtlasRecord& atlas =
        ${recordAt("engine.sprite_atlases", "system.atlas")};
    const std::uint32_t index = system.count;
    if (index >= system.capacity) {
        const std::uint32_t capacity =
            std::max(index + 1u, system.capacity * 2u);
        system.instance_data.resize(
            static_cast<std::size_t>(capacity) *
                system.instance_floats_per_sprite,
            0.0f);
        system.anchor.resize(
            static_cast<std::size_t>(capacity) *
                upstream::billboard_anchor_floats_per_sprite,
            0.0);
        system.capacity = capacity;
    }

    // writeInstance, add arm (\`prev === null\`): an unspecified field takes
    // its documented default rather than a previous value.
    const std::size_t base =
        static_cast<std::size_t>(index) *
        system.instance_floats_per_sprite;
    const bool has_frame = props.has_frame;
    const SpriteFrame frame = has_frame
        ? atlas.frames[upstream::resolve_sprite_frame(
              atlas,
              static_cast<double>(props.frame))]
        : SpriteFrame{};

    const float true_width =
        props.has_size_world ? props.size_world.x : 0.0f;
    const float true_height =
        props.has_size_world ? props.size_world.y : 0.0f;

    const bool visible =
        props.has_visible ? props.visible : true;

    float uv_min_x = 0.0f;
    float uv_min_y = 0.0f;
    float uv_max_x = 1.0f;
    float uv_max_y = 1.0f;
    if (has_frame) {
        uv_min_x = frame.uv_min.x;
        uv_min_y = frame.uv_min.y;
        uv_max_x = frame.uv_max.x;
        uv_max_y = frame.uv_max.y;
    }
    // flipX/flipY are absolute orientation flags resolved against the flip
    // already baked into the endpoints; on add there is no previous
    // orientation, so an omitted flag leaves them as the frame wrote them.
    const bool current_flip_x = uv_min_x > uv_max_x;
    const bool current_flip_y = uv_min_y > uv_max_y;
    const bool wants_flip_x =
        props.has_flip_x ? props.flip_x : false;
    const bool wants_flip_y =
        props.has_flip_y ? props.flip_y : false;
    if (current_flip_x != wants_flip_x) {
        std::swap(uv_min_x, uv_max_x);
    }
    if (current_flip_y != wants_flip_y) {
        std::swap(uv_min_y, uv_max_y);
    }

    const float rotation =
        props.has_rotation ? props.rotation : 0.0f;
    // With no previous instance the pivot falls back to the FRAME's pivot,
    // not to the quad centre.
    const float pivot_x =
        props.has_pivot ? props.pivot.x : frame.pivot.x;
    const float pivot_y =
        props.has_pivot ? props.pivot.y : frame.pivot.y;

    // Both stores are live, as in the pin: the F32 lanes feed the upload
    // without an offset and picking, the F64 anchor the eye-relative one.
    write_billboard_position(system, index, props.position);
    system.instance_data[base + 3u] = visible ? true_width : 0.0f;
    system.instance_data[base + 4u] = visible ? true_height : 0.0f;
    system.instance_data[base + 5u] = uv_min_x;
    system.instance_data[base + 6u] = uv_min_y;
    system.instance_data[base + 7u] = uv_max_x;
    system.instance_data[base + 8u] = uv_max_y;
    system.instance_data[base + 9u] = rotation;
    system.instance_data[base + 10u] = pivot_x;
    system.instance_data[base + 11u] = pivot_y;
    system.instance_data[base + 12u] =
        props.has_color ? props.color.x : 1.0f;
    system.instance_data[base + 13u] =
        props.has_color ? props.color.y : 1.0f;
    system.instance_data[base + 14u] =
        props.has_color ? props.color.z : 1.0f;
    system.instance_data[base + 15u] =
        props.has_color ? props.color.w : 1.0f;

    system.count = index + 1u;
    system.instance_version += 1u;
    return static_cast<double>(index);
}

BillboardSpriteHandle add_billboard_sprite(
    Engine& engine,
    BillboardSystemHandle system_handle,
    BillboardSpriteProps props) {
    const std::uint32_t index = static_cast<std::uint32_t>(
        add_billboard_sprite_index(engine, system_handle, props));
    BillboardSystemRecord& system =
        ${recordAt("engine.billboard_systems", "system_handle")};
    if (system.next_handle_id == invalid_handle) {
        throw std::runtime_error("Billboard sprite handle id space exhausted.");
    }
    const std::uint32_t id = system.next_handle_id++;
    if (system.index_to_handle_id.size() < system.capacity) {
        system.index_to_handle_id.resize(system.capacity, 0u);
    }
    system.handle_id_to_index[id] = index;
    system.index_to_handle_id[index] = id;
    return BillboardSpriteHandle{system_handle, id};
}

void update_billboard_sprite(
    Engine& engine,
    BillboardSpriteHandle handle,
    BillboardSpriteProps props) {
    if (handle.system.value >= engine.billboard_systems.size()) {
        throw std::runtime_error("Invalid billboard system handle.");
    }
    BillboardSystemRecord& system =
        ${recordAt("engine.billboard_systems", "handle.system")};
    const auto found = system.handle_id_to_index.find(handle.id);
    if (found == system.handle_id_to_index.end()) {
        throw std::runtime_error("Invalid billboard sprite handle.");
    }
    const std::size_t base =
        static_cast<std::size_t>(found->second) *
        system.instance_floats_per_sprite;
    if (props.has_position) {
        write_billboard_position(system, found->second, props.position);
    }
    if (props.has_size_world) {
        system.instance_data[base + 3u] = props.size_world.x;
        system.instance_data[base + 4u] = props.size_world.y;
    }
    if (props.has_color) {
        system.instance_data[base + 12u] = props.color.x;
        system.instance_data[base + 13u] = props.color.y;
        system.instance_data[base + 14u] = props.color.z;
        system.instance_data[base + 15u] = props.color.w;
    }
    system.instance_version += 1u;
}

// billboard-sprite-handle-animation.ts drives a sprite's frame through the
// same setter the 2D family has: rewrite the four UV floats from the atlas
// frame, keeping whichever axes the sprite was flipped on. The flip is read
// back off the stored endpoints rather than a stored flag, exactly as the
// add above resolves it.
void set_billboard_sprite_frame(
    Engine& engine,
    BillboardSpriteHandle handle,
    double frame) {
    if (handle.system.value >= engine.billboard_systems.size()) {
        throw std::runtime_error("Invalid billboard system handle.");
    }
    BillboardSystemRecord& system =
        ${recordAt("engine.billboard_systems", "handle.system")};
    const auto found = system.handle_id_to_index.find(handle.id);
    if (found == system.handle_id_to_index.end()) {
        throw std::runtime_error("Invalid billboard sprite handle.");
    }
    const SpriteAtlasRecord& atlas =
        ${recordAt("engine.sprite_atlases", "system.atlas")};
    const SpriteFrame& atlas_frame =
        atlas.frames[upstream::resolve_sprite_frame(atlas, frame)];
    const std::size_t base =
        static_cast<std::size_t>(found->second) *
        system.instance_floats_per_sprite;
    const bool flip_x =
        system.instance_data[base + 5u] > system.instance_data[base + 7u];
    const bool flip_y =
        system.instance_data[base + 6u] > system.instance_data[base + 8u];
    system.instance_data[base + 5u] =
        flip_x ? atlas_frame.uv_max.x : atlas_frame.uv_min.x;
    system.instance_data[base + 6u] =
        flip_y ? atlas_frame.uv_max.y : atlas_frame.uv_min.y;
    system.instance_data[base + 7u] =
        flip_x ? atlas_frame.uv_min.x : atlas_frame.uv_max.x;
    system.instance_data[base + 8u] =
        flip_y ? atlas_frame.uv_min.y : atlas_frame.uv_max.y;
    system.instance_version += 1u;
}

/** Whether a handle still names a sprite, which is what stops an animation
 *  stepping one its own removeWhenFinished already took away. */
bool billboard_sprite_alive(
    const Engine& engine,
    BillboardSpriteHandle handle) {
    if (handle.system.value >= engine.billboard_systems.size()) {
        return false;
    }
    const BillboardSystemRecord& system =
        ${recordAt("engine.billboard_systems", "handle.system")};
    return system.handle_id_to_index.count(handle.id) != 0;
}

void remove_billboard_sprite(
    Engine& engine,
    BillboardSpriteHandle handle) {
    if (handle.system.value >= engine.billboard_systems.size()) {
        return;
    }
    BillboardSystemRecord& system =
        ${recordAt("engine.billboard_systems", "handle.system")};
    const auto found = system.handle_id_to_index.find(handle.id);
    if (found == system.handle_id_to_index.end()) {
        return;
    }
    const std::uint32_t index = found->second;
    const std::uint32_t last = system.count - 1u;
    constexpr std::size_t anchor_stride = upstream::billboard_anchor_floats_per_sprite;
    if (index != last) {
        const std::size_t stride = system.instance_floats_per_sprite;
        std::copy_n(
            system.instance_data.begin() +
                static_cast<std::ptrdiff_t>(last * stride),
            stride,
            system.instance_data.begin() +
                static_cast<std::ptrdiff_t>(index * stride));
        std::copy_n(
            system.anchor.begin() +
                static_cast<std::ptrdiff_t>(last * anchor_stride),
            anchor_stride,
            system.anchor.begin() +
                static_cast<std::ptrdiff_t>(index * anchor_stride));
        const std::uint32_t moved = system.index_to_handle_id[last];
        system.index_to_handle_id[index] = moved;
        if (moved != 0u) {
            system.handle_id_to_index[moved] = index;
        }
    }
    std::fill_n(
        system.anchor.begin() + static_cast<std::ptrdiff_t>(last * anchor_stride),
        anchor_stride,
        0.0);
    system.index_to_handle_id[last] = 0u;
    system.handle_id_to_index.erase(found);
    system.count = last;
    system.instance_version += 1u;
}

void clear_billboard_sprites(
    Engine& engine,
    BillboardSystemHandle system_handle) {
    if (system_handle.value >= engine.billboard_systems.size()) {
        throw std::runtime_error("Invalid billboard system handle.");
    }
    // Keep the allocated instance buffer: the JavaScript system resets its
    // logical count and reuses capacity when a dynamic set is refilled.
    BillboardSystemRecord& system =
        ${recordAt("engine.billboard_systems", "system_handle")};
    system.handle_id_to_index.clear();
    std::fill(
        system.index_to_handle_id.begin(),
        system.index_to_handle_id.end(),
        0u);
    if (system.count != 0u) {
        std::fill_n(
            system.anchor.begin(),
            static_cast<std::size_t>(system.count) *
                upstream::billboard_anchor_floats_per_sprite,
            0.0);
        system.count = 0u;
        system.instance_version += 1u;
    }
}

// setBillboardShaderParams: the fx UBO the pipeline binds reads these four
// floats each frame. A system without a custom shader has no fx block to
// read them, which is the pin's own "no visual effect unless".
void set_billboard_shader_params(
    Engine& engine,
    BillboardSystemHandle system,
    Vec4 params) {
    if (system.value >= engine.billboard_systems.size()) {
        throw std::runtime_error("Invalid billboard system handle.");
    }
    ${recordAt("engine.billboard_systems", "system")}.shader_params = params;
}

// render/alpha-to-coverage.ts setAlphaToCoverage: membership of the enabled
// set, which the pipeline owner reads when it builds. A flag on the record
// is the same fact without the WeakSet, because the record IS the target.
void set_billboard_alpha_to_coverage(
    Engine& engine,
    BillboardSystemHandle system,
    bool enabled) {
    if (system.value >= engine.billboard_systems.size()) {
        throw std::runtime_error("Invalid billboard system handle.");
    }
    ${recordAt("engine.billboard_systems", "system")}.alpha_to_coverage = enabled;
}

void add_billboard_system(
    Scene& scene,
    BillboardSystemHandle system) {
    if (!scene.engine) {
        throw std::runtime_error("Scene has no engine.");
    }
    if (system.value >= scene.engine->billboard_systems.size()) {
        throw std::runtime_error("Invalid billboard system handle.");
    }
    scene.billboard_systems.push_back(system);
}

} // namespace bbl
`,
        };
    }
}
