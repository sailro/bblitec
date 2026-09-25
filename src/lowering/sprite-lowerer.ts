import ts from "typescript";
import { PinnedShaderBuilders } from "./pinned-shader-builders.js";
import type { ShaderTextBinding } from "./pinned-shader-builders.js";
import {
    blendFactoriesCpp,
    readPinnedBlendTable,
} from "./pinned-blend-table.js";
import { elementIndexText, LoweredSource, LoweringContext } from "./context.js";
import {
    decodeAtlasImageCpp,
    gridSpriteAtlasCpp,
    gridSpriteAtlasFramesCpp,
    pushAtlasHandleCpp,
} from "./pinned-grid-atlas.js";
import { assertFrameAtlasRule } from "./pinned-frame-atlas.js";
import {
    type PinnedVertexAttribute,
    pinnedVertexAttribute,
    pinnedVertexAttributeRows,
    vertexAttributeCpp,
    vertexAttributeTableCpp,
    vertexFormatFloats,
} from "./pinned-vertex-attributes.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import {
    absentBinding,
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import { recordAt } from "../compiler/record-access.js";
import {
    ySortCoreCpp,
    ySortEntryPointsCpp,
    ySortHandleModule,
    ySortModule,
} from "./sprite-y-sort-lowerer.js";

const atlasModule = "src/sprite/shared/sprite-atlas.ts";
const layerModule = "src/sprite/sprite-2d.ts";
const blendModule = "src/sprite/sprite-blend.ts";
const pipelineModule = "src/sprite/sprite-pipeline.ts";
const rendererModule = "src/sprite/sprite-renderer.ts";
const sceneModule = "src/sprite/sprite-scene.ts";
const renderableModule = "src/sprite/sprite-renderable.ts";
const uvScrollModule = "src/sprite/sprite-2d-uvscroll.ts";
const customShaderModule = "src/sprite/sprite-custom-shader.ts";
// Shared by both families: the fx block and its byte count.
const customShaderCoreModule = "src/sprite/custom-shader-core.ts";
const pickSpriteModule = "src/sprite/picking/pick-sprite-2d.ts";

/** A reached sprite permutation: the depth host and uv-scroll opt-ins. */
interface SpritePermutation {
    hasDepth: boolean;
    uvScroll: boolean;
}

/** A custom-shader program: the caller's fragment body and its extra textures. */
interface SpriteCustomProgram {
    fragment: string;
    extraTextures: readonly string[];
}
/**
 * Lowers Babylon Lite's Sprite2D path.
 *
 * A `depth: "none"` layer belongs to a `SpriteRenderer`; a depth-enabled layer
 * becomes a scene renderable through `addDepthHostedSpriteLayer`, widening its
 * instance row from 13 to 14 floats for per-instance z. Custom fragments,
 * UV scroll and alpha-to-coverage remain explicit opt-ins, as they are in the
 * pin. Coverage gamma is still unreached and therefore not emitted.
 */
export class SpriteLowerer {
    private readonly shaderText: PinnedShaderBuilders;

    public constructor(private readonly context: LoweringContext) {
        this.shaderText = new PinnedShaderBuilders(context);
    }

    // -----------------------------------------------------------------
    // Pinned contracts
    // -----------------------------------------------------------------

    /** `sprite-2d-uvscroll.ts` `UVSCROLL_EXTRA_FLOATS_PER_SPRITE`. */
    private uvScrollExtraFloats(): number {
        const file = this.context.sourceFile(uvScrollModule);
        return this.context.numericValue(
            this.context.variableInitializer(
                file,
                "UVSCROLL_EXTRA_FLOATS_PER_SPRITE",
            ),
            file,
        );
    }

    /** The two pinned instance widths and the CPU saved-size width. */
    private layout(): {
        pureInstanceFloats: number;
        depthInstanceFloats: number;
        savedSizeFloats: number;
        defaultCapacity: number;
    } {
        const file = this.context.sourceFile(layerModule);
        const pureInstanceFloats = this.context.numericValue(
            this.context.variableInitializer(
                file,
                "PURE_2D_INSTANCE_FLOATS_PER_SPRITE",
            ),
            file,
        );
        const depthInstanceFloats = this.context.numericValue(
            this.context.variableInitializer(
                file,
                "DEPTH_INSTANCE_FLOATS_PER_SPRITE",
            ),
            file,
        );
        const savedSizeFloats = this.context.numericValue(
            this.context.variableInitializer(
                file,
                "SAVED_SIZE_FLOATS_PER_SPRITE",
            ),
            file,
        );
        const defaultCapacity = this.context.numericValue(
            this.context.variableInitializer(file, "DEFAULT_CAPACITY"),
            file,
        );
        if (
            pureInstanceFloats !== 13 ||
            depthInstanceFloats !== 14 ||
            savedSizeFloats !== 2 ||
            defaultCapacity !== 16
        ) {
            this.context.contractError(
                file,
                `Pinned sprite instance layout changed: ${pureInstanceFloats} pure floats, ${depthInstanceFloats} depth floats, ${savedSizeFloats} saved-size floats, capacity ${defaultCapacity}.`,
            );
        }
        return {
            pureInstanceFloats,
            depthInstanceFloats,
            savedSizeFloats,
            defaultCapacity,
        };
    }

    /**
     * `sprite-2d-uvscroll.ts` ensureWide: the row the pin stashes for the
     * widened layout, read rather than typed. Its offset is the narrow
     * stride, which is the one part the pin computes at run time.
     */
    private uvScrollAttribute(instanceFloats: number): PinnedVertexAttribute {
        const { declaration } = this.context.functionDeclaration(
            uvScrollModule,
            "ensureWide",
        );
        const write = this.context.findNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(node.left) &&
                node.left.name.text === "_uvScrollAttr",
        )[0];
        if (!write) {
            this.context.contractError(
                declaration,
                "Pinned ensureWide no longer stashes _uvScrollAttr.",
            );
        }
        const literal = this.context.unwrapExpression(write.right);
        if (!ts.isObjectLiteralExpression(literal)) {
            return this.context.contractError(
                literal,
                "Expected the pinned _uvScrollAttr object literal.",
            );
        }
        const file = declaration.getSourceFile();
        const location = this.context.numericValue(
            this.context.propertyInitializer(literal, "shaderLocation"),
            file,
        );
        const format = this.context.stringValue(
            this.context.propertyInitializer(literal, "format"),
            file,
        );
        // The pin writes the offset as `oldStride * 4`, which is the narrow
        // stride in bytes -- so it is asserted rather than read.
        this.context.assertExpressionShape(
            this.context.propertyInitializer(literal, "offset"),
            "oldStride * 4",
            "ensureWide uvScroll attribute offset",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "newStride"),
            "oldStride + UVSCROLL_EXTRA_FLOATS_PER_SPRITE",
            "ensureWide newStride",
        );
        return {
            location,
            offsetBytes: instanceFloats * 4,
            floatCount: vertexFormatFloats(this.context, format, literal),
        };
    }

    /**
     * `sprite-pipeline.ts`: the pure-2D per-instance vertex attributes at
     * the pin's own byte offsets. The rows are `instanceAttributes`' base
     * literal (the depth and uv-scroll rows append behind opt-ins the
     * pure-2D slice never takes).
     */
    private instanceAttributeRows(
        instanceFloats: number,
    ): PinnedVertexAttribute[] {
        return pinnedVertexAttributeRows(
            this.context,
            this.context.variableInitializer(
                this.context.sourceFile(pipelineModule),
                "instanceAttributes",
            ),
            instanceFloats,
        );
    }

    /** The optional depth row appended by `buildSpritePipeline`. */
    private depthAttribute(): PinnedVertexAttribute {
        const file = this.context.sourceFile(pipelineModule);
        const push = this.context.findNodes(
            file,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                ts.isIdentifier(node.expression.expression) &&
                node.expression.expression.text === "instanceAttributes" &&
                node.expression.name.text === "push",
        )[0];
        if (!push || push.arguments.length !== 1) {
            return this.context.contractError(
                file,
                "Pinned sprite pipeline no longer appends one depth attribute.",
            );
        }
        const row = pinnedVertexAttribute(this.context, push.arguments[0]!);
        if (row.floatCount !== 1) {
            return this.context.contractError(
                push,
                `Pinned sprite depth attribute carries ${row.floatCount} floats, expected one.`,
            );
        }
        return row;
    }

    /** Scene-hosted bucket, growth, and hidden-update contracts. */
    private assertDepthHostedRenderable(): void {
        const { declaration: build } = this.context.functionDeclaration(
            renderableModule,
            "buildSpriteRenderable",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(build, "isTransparent"),
            'layer.depth === "test"',
            "depth-hosted sprite transparent bucket",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(build, "isDirect"),
            'layer.depth === "test-write"',
            "depth-hosted sprite direct bucket",
        );
        const renderable = this.context.unwrapExpression(
            this.context.variableInitializer(build, "renderable"),
        );
        if (!ts.isObjectLiteralExpression(renderable)) {
            this.context.contractError(
                renderable,
                "Pinned buildSpriteRenderable no longer builds a renderable literal.",
            );
        }
        this.context.assertExpressionShape(
            this.context.propertyInitializer(renderable, "order"),
            "isTransparent ? 200 : 100",
            "depth-hosted sprite fixed order",
        );
        this.context.assertExpressionShape(
            this.context.propertyInitializer(renderable, "_direct"),
            "isDirect",
            "depth-hosted sprite direct flag",
        );

        const { declaration: upload } = this.context.functionDeclaration(
            renderableModule,
            "uploadLayer",
        );
        const statements = upload.body?.statements ?? [];
        const visibleGuard = statements[1];
        if (!visibleGuard || !ts.isIfStatement(visibleGuard)) {
            this.context.contractError(
                upload,
                "Pinned uploadLayer no longer guards visibility before its update work.",
            );
        }
        this.context.assertExpressionShape(
            visibleGuard.expression,
            "!r._layer.visible || r._layer.count === 0",
            "depth-hosted sprite hidden update guard",
        );
        for (const name of [
            "ensureSpriteInstanceBuffer",
            "uploadSpriteInstances",
            "buildSpriteLayerUbo",
        ]) {
            const call = this.context.findNodes(
                upload,
                (node): node is ts.CallExpression =>
                    ts.isCallExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === name,
            )[0];
            if (!call || call.getStart() <= visibleGuard.getStart()) {
                this.context.contractError(
                    upload,
                    `Pinned uploadLayer no longer keeps ${name} after the hidden guard.`,
                );
            }
        }

        const { declaration: ensure } = this.context.functionDeclaration(
            pipelineModule,
            "ensureSpriteInstanceBuffer",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(ensure, "neededBytes"),
            "layer._capacity * layer._instanceStrideBytes",
            "sprite instance buffer required bytes",
        );
        const growthGuard = this.context.findNodes(
            ensure,
            (node): node is ts.IfStatement => ts.isIfStatement(node),
        )[0];
        if (!growthGuard) {
            this.context.contractError(
                ensure,
                "Pinned ensureSpriteInstanceBuffer no longer guards growth.",
            );
        }
        this.context.assertExpressionShape(
            growthGuard.expression,
            "currentBuffer.size >= neededBytes",
            "sprite instance buffer growth guard",
        );
        this.context.expectShapeCount(
            ensure,
            "currentBuffer.destroy()",
            "sprite instance buffer replacement destroys prior buffer",
        );
    }

    /**
     * `writeInstance` writes thirteen base slots plus the depth slot. The lowered writer
     * below reproduces them, so the slot expressions are pinned here
     * rather than trusted: a moved slot has to fail generation.
     */
    private assertInstanceSlots(): void {
        const { declaration } = this.context.functionDeclaration(
            layerModule,
            "writeInstance",
        );
        const expected: ReadonlyArray<[number, string]> = [
            [0, "posX"],
            [1, "posY"],
            [2, "visible ? trueW : 0"],
            [3, "visible ? trueH : 0"],
            [4, "uMin"],
            [5, "vMin"],
            [6, "uMax"],
            [7, "vMax"],
            [8, "rotation"],
        ];
        const writes = this.context.pinnedElementStores(declaration, "data");
        for (const [slot, source] of expected) {
            const write = writes.find(
                (node) => elementIndexText(node.left) === `base + ${slot}`,
            );
            if (!write) {
                this.context.contractError(
                    declaration,
                    `Pinned writeInstance no longer writes slot ${slot}.`,
                );
            }
            this.context.assertExpressionShape(
                write.right,
                source,
                `writeInstance slot ${slot}`,
            );
        }
        // The colour block writes slots 9..12 twice (the props arm and the
        // add default), so it is checked by count rather than by shape.
        for (const slot of [9, 10, 11, 12]) {
            const found = writes.filter(
                (node) => elementIndexText(node.left) === `base + ${slot}`,
            );
            if (found.length !== 2) {
                this.context.contractError(
                    declaration,
                    `Pinned writeInstance colour slot ${slot} has ${found.length} writers, expected 2.`,
                );
            }
        }
        const depthWrite = writes.find(
            (node) => elementIndexText(node.left) === "base + 13",
        );
        if (!depthWrite) {
            this.context.contractError(
                declaration,
                "Pinned writeInstance no longer writes depth slot 13.",
            );
        }
        this.context.assertExpressionShape(
            depthWrite.right,
            "z",
            "writeInstance depth slot 13",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "z"),
            "hasDepthSlot ? props.z ?? (prev ? prev[13] : layer.layerZ) : 0",
            "writeInstance depth fallback",
        );
        // The flip resolution is what makes flipX absolute rather than a
        // toggle, and the swap is what a preserved orientation means.
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "currentFlipX"),
            "uMin > uMax",
            "writeInstance currentFlipX",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "wantsFlipX"),
            "props.flipX !== undefined ? props.flipX === true : prevFlipX",
            "writeInstance wantsFlipX",
        );
    }

    /**
     * The update arm of the same writer.
     *
     * `addSprite2DIndex` passes `prev === null` and every unsupplied field
     * takes a documented default; `updateSprite2DIndex` passes the slot's own
     * floats back in and every unsupplied field takes the *previous* value.
     * The lowered writer carries both arms, so the expressions that read
     * `prev` are pinned here exactly as the add arm's defaults already are --
     * they are the whole of what "preserve what was not supplied" means, and
     * a slot that started reading a different index would preserve the wrong
     * quantity while still compiling.
     */
    private assertUpdateArm(): void {
        const { declaration } = this.context.functionDeclaration(
            layerModule,
            "writeInstance",
        );
        const preserved: ReadonlyArray<[string, string]> = [
            ["isAdd", "prev === null"],
            ["posX", "props.positionPx ? props.positionPx[0] : prev![0]!"],
            ["posY", "props.positionPx ? props.positionPx[1] : prev![1]!"],
            ["prevFlipX", "!isAdd && prev![4]! > prev![6]!"],
            ["prevFlipY", "!isAdd && prev![5]! > prev![7]!"],
            ["rotation", "props.rotation ?? (prev ? prev[8]! : 0)"],
        ];
        for (const [name, source] of preserved) {
            this.context.assertExpressionShape(
                this.context.variableInitializer(declaration, name),
                source,
                `writeInstance ${name}`,
            );
        }
        // The preserved quantities that are assigned inside an else branch
        // rather than initialized. Each is matched as the whole assignment,
        // because the element access alone also appears on the write side of
        // the shadow and inside the flip reads. Each states where the
        // previous value comes from: the size shadow, the zeroed GPU size
        // (which is how a hidden sprite is stored), and the UV endpoints.
        const branchArms: readonly string[] = [
            "trueW = layer._savedSize[savedBase]!",
            "trueH = layer._savedSize[savedBase + 1]!",
            "visible = prev![2]! !== 0 || prev![3]! !== 0",
            "uMin = prev![4]!",
            "vMin = prev![5]!",
            "uMax = prev![6]!",
            "vMax = prev![7]!",
        ];
        for (const source of branchArms) {
            this.context.expectShapeCount(
                declaration,
                source,
                `writeInstance ${source}`,
            );
        }
        // `updateSprite2DIndex` is the only caller that hands `prev` over,
        // and the slot it hands over is the one it is about to rewrite.
        const update = this.context.functionDeclaration(
            layerModule,
            "updateSprite2DIndex",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(update.declaration, "prev"),
            "layer._instanceData.subarray(base, base + layer._instanceFloatsPerSprite)",
            "updateSprite2DIndex prev",
        );
    }

    /**
     * `clearSprite2DLayer` drops the count without touching the instance
     * floats, so what it must get right is the size shadow and the version.
     * The shadow is cleared over the *old* count so a later re-add starts
     * from zero rather than inheriting a stale size, and the version bump is
     * what makes each backend re-upload.
     */
    private assertClearLayer(): void {
        const { declaration } = this.context.functionDeclaration(
            layerModule,
            "clearSprite2DLayer",
        );
        const statements: ReadonlyArray<[string, string]> = [
            [
                "layer._savedSize.fill(0, 0, count * SAVED_SIZE_FLOATS_PER_SPRITE)",
                "clearSprite2DLayer shadow clear",
            ],
            ["_setSprite2DCount(layer, 0)", "clearSprite2DLayer count reset"],
            ["(layer._version + 1) | 0", "clearSprite2DLayer version bump"],
        ];
        for (const [source, label] of statements) {
            this.context.expectShapeCount(declaration, source, label);
        }
        // The early return is why an empty layer does not bump the version:
        // clearing nothing is not an edit, and a bump would re-upload.
        this.context.expectShapeCount(
            declaration,
            "count === 0",
            "clearSprite2DLayer empty guard",
        );
    }

    /**
     * The renderer's own membership rules, which are not a list's defaults.
     * Adding a layer already present is a no-op rather than a second draw;
     * removing one reports whether it was there; disposing is idempotent and
     * every entry point the renderer owns tests the flag first.
     */
    private assertRendererMembership(): void {
        const add = this.context.functionDeclaration(
            rendererModule,
            "addSpriteRendererLayer",
        );
        this.context.expectShapeCount(
            add.declaration,
            "sr.layers.includes(layer)",
            "addSpriteRendererLayer membership test",
        );
        this.context.expectShapeCount(
            add.declaration,
            "sr._disposed",
            "addSpriteRendererLayer disposed guard",
        );
        const remove = this.context.functionDeclaration(
            rendererModule,
            "removeSpriteRendererLayer",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(remove.declaration, "index"),
            "sr.layers.indexOf(layer)",
            "removeSpriteRendererLayer lookup",
        );
        this.context.expectShapeCount(
            remove.declaration,
            "index < 0",
            "removeSpriteRendererLayer absent test",
        );
        const dispose = this.context.functionDeclaration(
            rendererModule,
            "disposeSpriteRenderer",
        );
        this.context.expectShapeCount(
            dispose.declaration,
            "sr._disposed",
            "disposeSpriteRenderer flag",
            2,
        );
        this.context.expectShapeCount(
            dispose.declaration,
            "unregisterSpriteRenderer(sr)",
            "disposeSpriteRenderer unregister",
        );
        // Every "a disposed renderer draws nothing" claim on both backends
        // comes from the rebuild seeing an empty list, so the statement that
        // empties it is the contract rather than an implementation detail.
        this.context.expectShapeCount(
            dispose.declaration,
            "sr._layers.length = 0",
            "disposeSpriteRenderer layer clear",
        );
    }

    /** `base` is `slotIndex * layer._instanceFloatsPerSprite`. */
    private assertInstanceBase(): void {
        const { declaration } = this.context.functionDeclaration(
            layerModule,
            "writeInstance",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "base"),
            "slotIndex * layer._instanceFloatsPerSprite",
            "writeInstance base",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "savedBase"),
            "slotIndex * SAVED_SIZE_FLOATS_PER_SPRITE",
            "writeInstance savedBase",
        );
    }

    /** `resolveSpriteFrame` is a bounds check and nothing else. */
    private assertFrameResolution(): void {
        const { declaration } = this.context.functionDeclaration(
            atlasModule,
            "resolveSpriteFrame",
        );
        const guard = this.context.findNodes(
            declaration,
            (node): node is ts.IfStatement => ts.isIfStatement(node),
        )[0];
        if (!guard) {
            this.context.contractError(
                declaration,
                "Pinned resolveSpriteFrame no longer bounds-checks.",
            );
        }
        this.context.assertExpressionShape(
            guard.expression,
            "frame < 0 || frame >= atlas.frames.length",
            "resolveSpriteFrame bounds",
        );
        const returned = this.context.findNodes(
            declaration,
            (node): node is ts.ReturnStatement =>
                ts.isReturnStatement(node) && node.expression !== undefined,
        )[0];
        this.context.assertExpressionShape(
            returned!.expression!,
            "frame",
            "resolveSpriteFrame result",
        );
    }

    /** `loadSpriteAtlas` requires `gridSize` and fixes the texture options. */
    private assertAtlasLoader(): void {
        const { declaration, file } = this.context.functionDeclaration(
            atlasModule,
            "loadSpriteAtlas",
        );
        const options = this.context.objectInitializer(declaration, "texOpts");
        for (const [name, source] of [
            ["invertY", "false"],
            ["addressModeU", '"clamp-to-edge"'],
            ["addressModeV", '"clamp-to-edge"'],
            ["mipMaps", "false"],
            [
                "minFilter",
                'options.sampling === "nearest" ? "nearest" : "linear"',
            ],
            [
                "magFilter",
                'options.sampling === "nearest" ? "nearest" : "linear"',
            ],
            ["premultiplyAlpha", "options.premultiplyOnLoad ?? false"],
        ] as const) {
            this.context.assertExpressionShape(
                this.context.propertyInitializer(options, name),
                source,
                `loadSpriteAtlas ${name}`,
            );
        }
        if (!this.context.hasCall(declaration, "createGridSpriteAtlas")) {
            this.context.contractError(
                file,
                "Pinned loadSpriteAtlas no longer partitions the texture into a grid.",
            );
        }
    }

    /**
     * `writeSpriteFxUbo`, translated from `custom-shader-core.ts`, and
     * `SPRITE_FX_UBO_BYTES`, the size the block is bound as.
     *
     * The module is shared between the two families, so the writer is
     * emitted once here and the billboard system reads it out of the same
     * header, the way it already does for `resolveSpriteFrame`. The pin's
     * trailing `writeBuffer` is the backend's upload, which each PAL makes
     * with the block this fills; the caller's `Vec4` always carries four
     * parameters, which is the pin's `params[i] ?? 0` over a full list.
     */
    private fxUboCpp(): { bytes: number; cpp: string } {
        const { declaration, file } = this.context.functionDeclaration(
            customShaderCoreModule,
            "writeSpriteFxUbo",
        );
        const bytes = this.context.numericValue(
            this.context.variableInitializer(
                this.context.sourceFile(customShaderCoreModule),
                "SPRITE_FX_UBO_BYTES",
            ),
            file,
        );
        const stores = this.context.pinnedElementStores(
            declaration,
            "scratch",
        ).length;
        if (bytes !== stores * 4) {
            this.context.contractError(
                declaration,
                `Pinned SPRITE_FX_UBO_BYTES is ${bytes}, which is not the ${stores} floats written.`,
            );
        }
        const parameters = ["device", "fxBuffer", "timeSeconds", "params"];
        const pinned = declaration.parameters.map((parameter) =>
            parameter.name.getText(file),
        );
        if (
            pinned.length !== parameters.length + 1 ||
            parameters.some((name, index) => pinned[index] !== name) ||
            pinned[parameters.length] !== "scratch"
        ) {
            this.context.contractError(
                declaration,
                "Expected pinned writeSpriteFxUbo(device, fxBuffer, timeSeconds, params, scratch).",
            );
        }
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            bindings: new Map<string, PinnedBinding>([
                ["timeSeconds", { cpp: "time_seconds", type: "scalar" }],
                ["scratch", { cpp: "ubo", type: "f32" }],
                ...(["x", "y", "z", "w"] as const).map(
                    (lane, index): [string, PinnedBinding] => [
                        `params[${index}]`,
                        {
                            cpp: `static_cast<double>(params.${lane})`,
                            type: "scalar",
                        },
                    ],
                ),
            ]),
            calls: new Map(),
            statement: (statement) => {
                if (
                    ts.isExpressionStatement(statement) &&
                    this.context.expressionMatchesShape(
                        statement.expression,
                        "device.queue.writeBuffer(fxBuffer, 0, scratch.buffer, scratch.byteOffset, SPRITE_FX_UBO_BYTES)",
                    )
                ) {
                    return [];
                }
                return undefined;
            },
        });
        return {
            bytes,
            cpp: `// ${this.context.provenance(customShaderCoreModule, "writeSpriteFxUbo")}
inline void build_sprite_fx_ubo(
    double time_seconds,
    const Vec4& params,
    std::array<float, sprite_fx_ubo_bytes / 4u>& ubo) {
${body}
}`,
        };
    }

    /**
     * `buildSpriteLayerUbo`, translated from `sprite-pipeline.ts`: the view,
     * the screen size, the pivot and the opacity multiplier. The coverage
     * gamma hook it calls last is installed only by
     * `setSprite2DCoverageGamma`, which no reached layer takes, so its lanes
     * keep the zeroes the caller's block starts with -- the pin's own
     * zero-initialized scratch.
     */
    private layerUboCpp(): string {
        const { file } = this.context.functionDeclaration(
            pipelineModule,
            "buildSpriteLayerUbo",
        );
        const bytes = this.context.numericValue(
            this.context.variableInitializer(file, "LAYER_UBO_BYTES"),
            file,
        );
        if (bytes !== 64) {
            this.context.contractError(
                file,
                `Pinned sprite layer UBO is ${bytes} bytes, expected 64.`,
            );
        }
        const scalar = (cpp: string): PinnedBinding => ({
            cpp: `static_cast<double>(${cpp})`,
            type: "scalar",
        });
        return lowerPinnedFunction(
            this.context,
            pipelineModule,
            "buildSpriteLayerUbo",
            [
                {
                    pinned: "layer",
                    kind: "record",
                    cpp: "layer",
                    cppType: "Sprite2DLayerRecord",
                    annotation: "Sprite2DLayer",
                },
                { pinned: "screenWidth", kind: "number", cpp: "screen_width" },
                {
                    pinned: "screenHeight",
                    kind: "number",
                    cpp: "screen_height",
                },
                {
                    pinned: "ubo",
                    kind: "f32Buffer",
                    cpp: "ubo",
                    cppType: `std::array<float, ${bytes / 4}>`,
                    mutableRecord: true,
                },
            ],
            {
                cppName: "build_sprite_layer_ubo",
                returns: "void",
                inline: true,
                memberBindings: new Map<string, PinnedBinding>([
                    [
                        "layer.view.positionPx[0]",
                        scalar("layer.view.position_px.x"),
                    ],
                    [
                        "layer.view.positionPx[1]",
                        scalar("layer.view.position_px.y"),
                    ],
                    ["layer.view.zoom", scalar("layer.view.zoom")],
                    ["layer.view.rotation", scalar("layer.view.rotation")],
                    ["layer.pivot[0]", scalar("layer.pivot.x")],
                    ["layer.pivot[1]", scalar("layer.pivot.y")],
                    ["layer.opacity", scalar("layer.opacity")],
                    [
                        "layer.blendMode._premultipliedOpacity",
                        {
                            cpp: "layer.blend.premultiplied_opacity",
                            type: "bool",
                        },
                    ],
                    ["_getSpriteCoverageGammaHook()", absentBinding()],
                ]),
            },
        );
    }

    /**
     * `compareLayers`, the comparator `spriteRendererUpdate` sorts a
     * renderer's layers by, translated from `sprite-renderer.ts`.
     */
    /**
     * `spriteRendererUpdate`'s `if (rr.layers.length > 1) rr._layers.sort(
     * compareLayers)`: the renderer's own list sorted IN PLACE once per frame,
     * after its hooks ran and before anything reads it. JavaScript's sort is
     * stable over the order the list was left in, so a tie after an order
     * change resolves against the previous frame's order rather than the
     * registration order; `std::stable_sort` over the record's own list is
     * that. A reorder moves each backend's per-layer GPU records with it
     * through `layers_version`, as the pin's `_layerGpu` map is keyed by layer.
     */
    private sortLayersCpp(): string {
        const { file, declaration } = this.context.functionDeclaration(
            rendererModule,
            "spriteRendererUpdate",
        );
        const guards = this.context.findNodes(
            declaration,
            (node): node is ts.IfStatement =>
                ts.isIfStatement(node) &&
                this.context
                    .findNodes(
                        node.thenStatement,
                        (call): call is ts.CallExpression =>
                            ts.isCallExpression(call) &&
                            call.expression.getText(file) === "rr._layers.sort",
                    )
                    .some(
                        (call) =>
                            call.arguments.length === 1 &&
                            call.arguments[0]!.getText(file) ===
                                "compareLayers",
                    ),
        );
        const guard = guards[0];
        if (guards.length !== 1 || !guard || guard.elseStatement) {
            return this.context.contractError(
                declaration,
                "Expected spriteRendererUpdate to sort rr._layers in place by compareLayers under one guard.",
            );
        }
        const condition = new PinnedNumericLowerer(file, {
            bindings: new Map<string, PinnedBinding>([
                [
                    "rr.layers.length",
                    {
                        cpp: "static_cast<double>(renderer.layers.size())",
                        type: "scalar",
                    },
                ],
            ]),
            calls: new Map(),
        }).expression(guard.expression);
        return `/**
 * ${this.context.provenance(rendererModule, "spriteRendererUpdate", "rr._layers.sort(compareLayers)")}
 * The renderer's layer list sorted in place, stable over the order the last
 * frame left it in; both backends and the capture then walk the list as it
 * stands. A reorder bumps \`layers_version\`, which moves each backend's
 * per-layer GPU records to the new positions without rebuilding them.
 */
inline void sort_sprite_renderer_layers(
    const Engine& engine,
    SpriteRendererRecord& renderer) {
    if (${condition}) {
        std::vector<Sprite2DLayerHandle> sorted = renderer.layers;
        std::stable_sort(
            sorted.begin(),
            sorted.end(),
            [&](Sprite2DLayerHandle left, Sprite2DLayerHandle right) {
                return upstream::compare_sprite_layers(
                           ${recordAt("engine.sprite_layers", "left")},
                           ${recordAt("engine.sprite_layers", "right")}) < 0.0;
            });
        const bool moved = !std::equal(
            sorted.begin(),
            sorted.end(),
            renderer.layers.begin(),
            [](Sprite2DLayerHandle left, Sprite2DLayerHandle right) {
                return left.value == right.value;
            });
        if (moved) {
            renderer.layers = std::move(sorted);
            renderer.layers_version += 1u;
        }
    }
}`;
    }

    private compareLayersCpp(): string {
        const layer = (name: string) => ({
            pinned: name,
            kind: "record" as const,
            cpp: name,
            cppType: "Sprite2DLayerRecord",
            annotation: "Sprite2DLayer",
        });
        return lowerPinnedFunction(
            this.context,
            rendererModule,
            "compareLayers",
            [layer("a"), layer("b")],
            {
                cppName: "compare_sprite_layers",
                returns: "double",
                inline: true,
                memberBindings: new Map<string, PinnedBinding>(
                    ["a", "b"].map((name): [string, PinnedBinding] => [
                        `${name}.order`,
                        {
                            cpp: `static_cast<double>(${name}.order)`,
                            type: "scalar",
                        },
                    ]),
                ),
            },
        );
    }

    /**
     * `pickSprite2D`, translated from `sprite/picking/pick-sprite-2d.ts`.
     *
     * The pin walks sprite LAYER records; this port holds handles, so the
     * record each one names is resolved where the pin reads `layers[li]`,
     * and the handle is what the answer carries. The optional Y-sort hook
     * is the engine's own, empty until a layer enables the extension -- the
     * pin's `_getSprite2DYSortHook()?.drawOrder(layer)`.
     */
    private pickSprite2DCpp(): string {
        const { file, declaration } = this.context.functionDeclaration(
            pickSpriteModule,
            "pickSprite2D",
        );
        const signature = declaration.parameters.map(
            (parameter) =>
                `${parameter.name.getText(file)}: ${parameter.type?.getText(file)}`,
        );
        const expected = [
            "layers: ReadonlyArray<Sprite2DLayer>",
            "xPx: number",
            "yPx: number",
        ];
        if (signature.join(", ") !== expected.join(", ")) {
            this.context.contractError(
                declaration,
                `Expected pinned pickSprite2D(${expected.join(", ")}).`,
            );
        }
        const scalar = (cpp: string): PinnedBinding => ({
            cpp: `static_cast<double>(${cpp})`,
            type: "scalar",
        });
        const bindings = new Map<string, PinnedBinding>([
            ["layers.length", scalar("layers.size()")],
            ["xPx", { cpp: "x_px", type: "scalar" }],
            ["yPx", { cpp: "y_px", type: "scalar" }],
            ["layer.visible", { cpp: "layer.visible", type: "bool" }],
            [
                "layer._instanceData",
                { cpp: "layer.instance_data", type: "f32" },
            ],
            [
                "layer._instanceFloatsPerSprite",
                scalar("layer.instance_floats_per_sprite"),
            ],
            ["layer.pivot[0]", scalar("layer.pivot.x")],
            ["layer.pivot[1]", scalar("layer.pivot.y")],
            ["layer.count", scalar("layer.count")],
        ]);
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            bindings,
            calls: pinnedNumericMathCalls(),
            booleanAnd: true,
            statement: (statement, lowerer, indent) => {
                if (!ts.isVariableStatement(statement)) return undefined;
                const local = statement.declarationList.declarations[0]!;
                const name = local.name.getText(file);
                if (name === "layer") {
                    const read = this.context.unwrapExpression(
                        local.initializer!,
                    );
                    if (
                        !ts.isElementAccessExpression(read) ||
                        read.expression.getText(file) !== "layers"
                    ) {
                        return this.context.contractError(
                            local,
                            "Expected pickSprite2D to read its layer as layers[li].",
                        );
                    }
                    return [
                        `${indent}const Sprite2DLayerHandle layer_handle = ` +
                            `layers[static_cast<std::size_t>(${lowerer.expression(read.argumentExpression)})];`,
                        `${indent}const Sprite2DLayerRecord& layer = ` +
                            `${recordAt("engine.sprite_layers", "layer_handle")};`,
                    ];
                }
                if (name === "drawOrder") {
                    this.context.assertExpressionShape(
                        local.initializer!,
                        "_getSprite2DYSortHook()?.drawOrder(layer)",
                        "pickSprite2D draw order",
                    );
                    bindings.set("drawOrder", {
                        cpp: "draw_order",
                        type: "u32",
                        absentCpp: "draw_order == nullptr",
                    });
                    return [
                        `${indent}const std::uint32_t* draw_order = ` +
                            "engine.sprite_y_sort_hook.draw_order ? " +
                            "engine.sprite_y_sort_hook.draw_order(layer) : nullptr;",
                    ];
                }
                return undefined;
            },
            returnValue: (expression, lowerer) => {
                const returned = expression
                    ? this.context.unwrapExpression(expression)
                    : undefined;
                if (returned?.kind === ts.SyntaxKind.NullKeyword) {
                    return "std::nullopt";
                }
                if (
                    !returned ||
                    !ts.isObjectLiteralExpression(returned) ||
                    returned.properties.length !== 4
                ) {
                    return this.context.contractError(
                        expression ?? declaration,
                        "Expected pickSprite2D to return null or its four-field hit.",
                    );
                }
                this.context.assertExpressionShape(
                    this.context.propertyInitializer(returned, "layer"),
                    "layer",
                    "pickSprite2D hit layer",
                );
                const member = (name: string): string =>
                    lowerer.expression(
                        this.context.propertyInitializer(returned, name),
                    );
                return (
                    `Sprite2DPickResult{layer_handle, ` +
                    `static_cast<std::uint32_t>(${member("spriteIndex")}), ` +
                    `${member("u")}, ${member("v")}}`
                );
            },
        });
        return `// ${this.context.provenance(pickSpriteModule, "pickSprite2D")}
[[nodiscard]] inline std::optional<Sprite2DPickResult> pick_sprite_2d(
    const Engine& engine,
    const std::vector<Sprite2DLayerHandle>& layers,
    double x_px,
    double y_px) {
${body}
}`;
    }

    /** The shared quad: four corners, six indices, one instanced draw. */
    private assertQuad(): void {
        const file = this.context.sourceFile(pipelineModule);
        const indices = this.context.unwrapExpression(
            this.context.variableInitializer(file, "SHARED_SPRITE_INDEX_DATA"),
        );
        this.context.assertExpressionShape(
            indices,
            "new U16([0, 1, 2, 0, 2, 3])",
            "shared sprite index buffer",
        );
        const { declaration } = this.context.functionDeclaration(
            rendererModule,
            "spriteRendererRecord",
        );
        const draw = this.context.findNodes(
            declaration,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === "drawIndexed",
        )[0];
        if (!draw) {
            this.context.contractError(
                declaration,
                "Pinned sprite record pass no longer records an indexed draw.",
            );
        }
        this.context.assertExpressionShape(
            draw.arguments[0]!,
            "6",
            "sprite drawIndexed index count",
        );
        this.context.assertExpressionShape(
            draw.arguments[1]!,
            "layer.count",
            "sprite drawIndexed instance count",
        );
    }

    // -----------------------------------------------------------------
    // Pinned WGSL
    // -----------------------------------------------------------------

    /**
     * The module the pin hands WebGPU for a layer's permutation, built by
     * evaluating its own builder: `makeSpriteWgsl`, or -- for a
     * custom-shader layer -- `makeCustomSpriteWgsl`, which composes the
     * caller's body with the same prologue, its extra textures and the fx
     * block. It is deployed whole: each stage enters where the module
     * declares it does, the compiler keeps what that entry point reads, and
     * the compaction re-homes the pin's one group for SDL_GPU. Anything the
     * evaluator cannot fold is a contract failure, so a changed builder
     * stops generation.
     */
    public module(
        permutation: SpritePermutation,
        custom?: SpriteCustomProgram,
    ): string {
        // The pin's own call: `makeSpriteWgsl(hasDepth, hasDepth ? 1 : 0,
        // uvScroll)`, the depth host's scene group taking group 0.
        const parameters = new Map<string, ShaderTextBinding>([
            ["hasDepth", permutation.hasDepth],
            ["spriteGroupIndex", permutation.hasDepth ? "1" : "0"],
            ["uvScroll", permutation.uvScroll],
        ]);
        return custom === undefined
            ? this.shaderText.evaluate(
                  pipelineModule,
                  "makeSpriteWgsl",
                  parameters,
              )
            : this.shaderText.evaluate(
                  customShaderModule,
                  "makeCustomSpriteWgsl",
                  new Map<string, ShaderTextBinding>([
                      ...parameters,
                      [
                          "extraTextures",
                          custom.extraTextures.map((name) => ({ name })),
                      ],
                      ["fragment", custom.fragment],
                  ]),
              );
    }
    // -----------------------------------------------------------------
    // Emission
    // -----------------------------------------------------------------

    public lowerCore(ySort = false): LoweredSource {
        const layout = this.layout();
        // The optional Y-sort extension, emitted only where a scene reached
        // its enabler -- upstream registers its hook from inside that call
        // and leaves every other layer on the canonical logical order, so
        // the enabler is the whole opt-in and nothing else detects it.
        const blends = readPinnedBlendTable(
            this.context,
            blendModule,
            "spriteBlend",
        );
        // The intrinsic defaults an unnamed blendMode to this factory, so the
        // descriptor the default names has to be one the pin still exports.
        // Everything about its factors is read, not asserted -- a hand-typed
        // expectation here would fail a bump the table lowers correctly.
        if (!blends.some((blend) => blend.exportName === "spriteBlendAlpha")) {
            this.context.contractError(
                this.context.sourceFile(blendModule),
                "Pinned sprite blends no longer export spriteBlendAlpha, which the default names.",
            );
        }
        const attributeRows = this.instanceAttributeRows(
            layout.pureInstanceFloats,
        );
        const depthRow = this.depthAttribute();
        const uvScrollRow = this.uvScrollAttribute(layout.pureInstanceFloats);
        assertFrameAtlasRule(this.context);
        this.assertFrameResolution();
        this.assertAtlasLoader();
        this.assertInstanceBase();
        this.assertInstanceSlots();
        this.assertDepthHostedRenderable();
        this.assertUpdateArm();
        this.assertClearLayer();
        this.assertRendererMembership();
        const fxUbo = this.fxUboCpp();
        this.assertQuad();

        // sprite-2d-y-sort.ts, emitted whole or not at all. Everything in
        // it is file-local but the three entry points scene code names, so
        // the always-loaded paths below reach it through the layer's own
        // state pointer and the engine's one lazily-installed hook.
        const ySortSource = this.ySortSource(ySort);
        const ySortEntryPoints = this.ySortEntryPoints(ySort);

        const provenance = this.context.provenance(
            layerModule,
            "createSprite2DLayer, addSprite2DIndex, updateSprite2DIndex, clearSprite2DLayer",
            `${atlasModule}#createGridSpriteAtlas, ${blendModule}#spriteBlendAlpha/spriteBlendOpaque, ${rendererModule}#createSpriteRenderer, ${sceneModule}#addDepthHostedSpriteLayer, ${renderableModule}#buildSpriteRenderable${
                ySort
                    ? `, ${ySortModule}#enableSprite2DYSort, ${ySortHandleModule}#setSprite2DYSortHandleBias`
                    : ""
            }`,
        );
        return {
            modulePath: layerModule,
            symbolName:
                "createSprite2DLayer,addSprite2DIndex,updateSprite2DIndex,clearSprite2DLayer,loadSpriteAtlas,createSpriteRenderer,addSpriteRendererLayer,removeSpriteRendererLayer,disposeSpriteRenderer" +
                (ySort
                    ? ",enableSprite2DYSort,setSprite2DYSortHandleBias"
                    : ""),
            header: `#pragma once

// ${this.context.provenance(pipelineModule, "buildSpriteLayerUbo")}
#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <numeric>
#include <optional>
#include <stdexcept>
#include <vector>

namespace bbl::upstream {

/**
 * shared/sprite-atlas.ts#createGridSpriteAtlas, the one partition every grid
 * loader shares: \`loadSpriteAtlas\`, the particle bridges and scene code's
 * own calls over a file, pixel or render texture. It lives in the shared
 * header because it is the shared atlas module's.
 */
${gridSpriteAtlasCpp(this.context)}

/**
 * sprite-pipeline.ts: the pure-2D per-instance vertex attributes at the
 * pin's own byte offsets, and the stride sprite-2d.ts derives from
 * PURE_2D_INSTANCE_FLOATS_PER_SPRITE. Both render backends translate
 * these rows into their API's vertex-attribute descriptors, so the
 * numbers exist once, here.
 */
struct SpriteInstanceAttribute {
    std::uint32_t shader_location;
    std::uint32_t byte_offset;
    std::uint32_t float_count;
};

/**
 * shared/sprite-atlas.ts#resolveSpriteFrame: a bounds check, nothing more.
 * It lives in the shared header because it is the shared atlas module's, and
 * both the 2D layer and the billboard system resolve a frame through it.
 */
inline std::uint32_t resolve_sprite_frame(
    const SpriteAtlasRecord& atlas,
    double frame) {
    if (frame < 0.0 ||
        frame >= static_cast<double>(atlas.frames.size())) {
        throw std::runtime_error(
            "resolveSpriteFrame: index out of range.");
    }
    return static_cast<std::uint32_t>(frame);
}

/**
 * custom-shader-core.ts#writeSpriteFxUbo: the block a custom-shader layer
 * or system binds beside its own. It is here for the reason the frame
 * resolver is: the pinned module is shared by both families, so the write
 * is stated once and both read it.
 *
 * The clock is seconds since the layer's first frame, which the caller
 * accumulates; a body that never names it still has the block bound.
 */
inline constexpr std::size_t sprite_fx_ubo_bytes = ${fxUbo.bytes}u;

${fxUbo.cpp}

${vertexAttributeTableCpp("SpriteInstanceAttribute", "sprite_instance_attributes", attributeRows)}

// sprite-pipeline.ts: appended when \`hasDepth\` selects the scene-hosted
// layout. Slot 13 is one float at shader location 6.
inline constexpr SpriteInstanceAttribute sprite_depth_attribute{
    ${vertexAttributeCpp(depthRow)}};

// sprite-2d-uvscroll.ts ensureWide: the uvOffset attribute the widened
// layout adds, at the byte offset the narrow stride ends on.
inline constexpr SpriteInstanceAttribute sprite_uvscroll_attribute{
    ${vertexAttributeCpp(uvScrollRow)}};

inline constexpr std::uint32_t sprite_uvscroll_stride_bytes =
    ${(layout.pureInstanceFloats + this.uvScrollExtraFloats()) * 4}u;

inline constexpr std::uint32_t sprite_instance_stride_bytes =
    ${layout.pureInstanceFloats * 4}u;

inline constexpr std::uint32_t sprite_depth_instance_stride_bytes =
    ${layout.depthInstanceFloats * 4}u;

/**
 * The per-layer UBO: [0..1] viewPos.xy  [2] viewScale  [3] viewRot
 *   [4..5] screenSize.xy  [6..7] pivot.xy  [8..11] opacityMul.rgba
 *   [12..15] aa (coverage gamma, unreached).
 */
${this.layerUboCpp()}

${this.compareLayersCpp()}

} // namespace bbl::upstream

namespace bbl {

/**
 * sprite-blend.ts: each exported descriptor, as the factory scene code
 * reaches when it names that descriptor at a layer. A mode with no colour
 * blend is the pin's opaque replacement, which is blending disabled.
 */
${blendFactoriesCpp(blends, "sprite", "sprite-blend.ts")}
${this.sortLayersCpp()}

${this.pickSprite2DCpp()}
} // namespace bbl
`,
            source: `// ${provenance}
#include <bblite/js_data.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/runtime.hpp>
#include <bblite/upstream/sprite_layer.hpp>

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace bbl {
namespace {

// sprite-2d.ts: the pure-2D instance layout and the CPU-side shadow that
// keeps a hidden sprite's true size.
constexpr std::uint32_t sprite_instance_floats = ${layout.pureInstanceFloats}u;
constexpr std::uint32_t sprite_depth_instance_floats = ${layout.depthInstanceFloats}u;
constexpr std::uint32_t sprite_saved_size_floats = ${layout.savedSizeFloats}u;
// sprite-2d-uvscroll.ts UVSCROLL_EXTRA_FLOATS_PER_SPRITE.
constexpr std::uint32_t sprite_uvscroll_extra_floats = ${this.uvScrollExtraFloats()}u;

${ySortSource}
void touch_sprite_instances(
    Sprite2DLayerRecord& layer,
    std::uint32_t begin,
    std::uint32_t end) {
    if (begin < end) {
        layer.dirty_sprite_begin = std::min(
            layer.dirty_sprite_begin,
            begin);
        layer.dirty_sprite_end = std::max(
            layer.dirty_sprite_end,
            end);
    }
    layer.version += 1u;${
        ySort
            ? `
    // markDirty's own last act: the Y-sort hook inspects the range the
    // canonical write already landed.
    observe_y_sort_dirty(layer, begin, end);`
            : ""
    }
}

void grow_sprite_capacity(
    Sprite2DLayerRecord& layer,
    std::uint32_t min_capacity) {
    std::uint32_t capacity = layer.capacity;
    while (capacity < min_capacity) {
        capacity *= 2u;
    }
    layer.instance_data.resize(
        static_cast<std::size_t>(capacity) *
        layer.instance_floats_per_sprite);
    layer.saved_size.resize(
        static_cast<std::size_t>(capacity) *
        sprite_saved_size_floats);
    layer.capacity = capacity;
    // The PAL replaces its capacity-sized buffer after this growth. Keep
    // the whole active prefix dirty so that fresh allocation is initialized
    // even though the add itself only writes the new tail slot.
    layer.dirty_sprite_begin = layer.count == 0u ? invalid_handle : 0u;
    layer.dirty_sprite_end = layer.count;
}

} // namespace

// sprite-2d.ts _setSprite2DCount / _markSprite2DDirty: the pin exports these
// two internals for the pure-2D particle bridge, which owns a layer's whole
// live range and writes it without going through add/update.
void set_sprite_2d_count(Sprite2DLayerRecord& layer, std::uint32_t count) {
    layer.count = count;
}

void mark_sprite_2d_dirty(
    Sprite2DLayerRecord& layer,
    std::uint32_t lo,
    std::uint32_t hi) {
    touch_sprite_instances(layer, lo, hi);
}

// sprite-2d-uvscroll.ts ensureWide: widen a layer from the narrow base
// layout to the uvOffset layout, re-striding the sprites already written.
// The offset slots default to zero, and the attribute the pipeline pushes
// sits right after the base layout -- so its byte offset IS the narrow
// stride.
void ensure_sprite_uv_scroll(Sprite2DLayerRecord& layer) {
    if (layer.uv_scroll) {
        return;
    }
    const std::uint32_t old_stride = layer.instance_floats_per_sprite;
    const std::uint32_t new_stride =
        old_stride + sprite_uvscroll_extra_floats;
    std::vector<float> next(
        static_cast<std::size_t>(layer.capacity) * new_stride, 0.0f);
    for (std::uint32_t index = 0; index < layer.count; ++index) {
        const std::size_t from =
            static_cast<std::size_t>(index) * old_stride;
        const std::size_t to =
            static_cast<std::size_t>(index) * new_stride;
        std::copy_n(
            layer.instance_data.begin() +
                static_cast<std::ptrdiff_t>(from),
            old_stride,
            next.begin() + static_cast<std::ptrdiff_t>(to));
    }
    layer.instance_data = std::move(next);
    layer.instance_floats_per_sprite = new_stride;
    layer.uv_scroll = true;
    touch_sprite_instances(layer, 0u, layer.count);
    layer.pipeline_version += 1u;
}

// setSprite2DShaderParams: the fx UBO the pipeline binds reads these four
// floats each frame. A layer without a custom shader has no fx block to
// read them, which is the pin's own "no visual effect unless" -- so the
// write stands on its own and the renderer decides whether it is bound.
void set_sprite_2d_shader_params(
    Engine& engine,
    Sprite2DLayerHandle layer_handle,
    Vec4 params) {
    ${recordAt("engine.sprite_layers", "layer_handle")}.shader_params = params;
}

// setSprite2DUvOffset: the two floats sit right after the base layout, and
// the first call is what enables the layout at all.
void set_sprite_2d_uv_offset(
    Engine& engine,
    Sprite2DLayerHandle layer_handle,
    double index,
    Vec2 uv_offset) {
    Sprite2DLayerRecord& layer =
        ${recordAt("engine.sprite_layers", "layer_handle")};
    if (index < 0.0 ||
        index >= static_cast<double>(layer.count)) {
        throw std::runtime_error(
            "setSprite2DUvOffset: index " +
            std::to_string(static_cast<long long>(index)) +
            " out of range [0, " + std::to_string(layer.count) + ")");
    }
    ensure_sprite_uv_scroll(layer);
    const std::size_t base =
        static_cast<std::size_t>(index) *
        layer.instance_floats_per_sprite;
    const std::size_t slot =
        base + layer.instance_floats_per_sprite -
        sprite_uvscroll_extra_floats;
    layer.instance_data[slot] = uv_offset.x;
    layer.instance_data[slot + 1u] = uv_offset.y;
    touch_sprite_instances(
        layer,
        static_cast<std::uint32_t>(index),
        static_cast<std::uint32_t>(index) + 1u);
}

SpriteAtlasHandle load_sprite_atlas(
    Engine& engine,
    const std::string& path,
    LoadSpriteAtlasOptions options) {
    if (options.grid_width_px <= 0.0f ||
        options.grid_height_px <= 0.0f) {
        throw std::runtime_error(
            "loadSpriteAtlas: gridSize required.");
    }
${decodeAtlasImageCpp()}
    if (options.premultiply_on_load) {
        // createImageBitmap({ premultiplyAlpha: "premultiply" }).
        pal::DecodedImage premultiplied{
            static_cast<int>(atlas.width),
            static_cast<int>(atlas.height),
            std::move(atlas.rgba)};
        pal::premultiply_image_alpha(premultiplied);
        atlas.rgba = std::move(premultiplied.rgba);
    }
    // The pinned sampler: clamp both axes, no mip chain, and a filter
    // chosen by \`sampling\`. mipmapFilter is "nearest" without mips, which
    // also takes maxAnisotropy back to 1.
    atlas.mip_maps = false;
    atlas.sampler.min_filter = options.sampling;
    atlas.sampler.mag_filter = options.sampling;
    atlas.sampler.mipmap_mode = TextureMipmapMode::nearest;
    // The pinned defaults, with the caller-spread texture options over them.
    atlas.sampler.address_u = options.address_u;
    atlas.sampler.address_v = options.address_v;
    atlas.sampler.max_anisotropy = 1.0f;
    atlas.sampler.max_lod = 0.0f;

    const double cell_w = static_cast<double>(options.grid_width_px);
    const double cell_h = static_cast<double>(options.grid_height_px);
${gridSpriteAtlasFramesCpp("options.premultiplied_alpha")}

${pushAtlasHandleCpp()}
}

SpriteAtlasHandle create_grid_sprite_atlas(
    Engine& engine,
    const FileTexture& texture,
    GridSpriteAtlasOptions options) {
    SpriteAtlasRecord atlas;
    pal::DecodedImage image =
        pal::decode_image(js::ArrayBuffer(texture.data.bytes));
    if (texture.data.premultiply_alpha) {
        pal::premultiply_image_alpha(image);
    }
    if (texture.data.invert_y && image.height > 1) {
        const std::size_t row_bytes =
            static_cast<std::size_t>(image.width) * 4u;
        std::vector<std::uint8_t> row(row_bytes);
        for (int y = 0; y < image.height / 2; ++y) {
            std::uint8_t* top = image.rgba.data() +
                static_cast<std::size_t>(y) * row_bytes;
            std::uint8_t* bottom = image.rgba.data() +
                static_cast<std::size_t>(image.height - 1 - y) * row_bytes;
            std::memcpy(row.data(), top, row_bytes);
            std::memcpy(top, bottom, row_bytes);
            std::memcpy(bottom, row.data(), row_bytes);
        }
    }
    atlas.rgba = std::move(image.rgba);
    atlas.width = static_cast<std::uint32_t>(image.width);
    atlas.height = static_cast<std::uint32_t>(image.height);
    atlas.mip_maps = texture.data.sampler.max_lod > 0.0f;
    atlas.sampler = texture.data.sampler;
    upstream::create_grid_sprite_atlas_frames(atlas, options);
${pushAtlasHandleCpp()}
}

SpriteAtlasHandle create_grid_sprite_atlas(
    Engine& engine,
    const PixelsTexture& texture,
    GridSpriteAtlasOptions options) {
    SpriteAtlasRecord atlas;
    atlas.rgba.assign(texture.rgba.begin(), texture.rgba.end());
    atlas.width = texture.width;
    atlas.height = texture.height;
    atlas.mip_maps = texture.sampler.max_lod > 0.0f;
    atlas.sampler = texture.sampler;
    upstream::create_grid_sprite_atlas_frames(atlas, options);
${pushAtlasHandleCpp()}
}

SpriteAtlasHandle create_grid_sprite_atlas(
    Engine& engine,
    SpriteRenderTextureHandle texture,
    GridSpriteAtlasOptions options) {
    const SpriteRenderTextureRecord& source =
        ${recordAt("engine.sprite_render_textures", "texture")};
    SpriteAtlasRecord atlas;
    atlas.width = source.width;
    atlas.height = source.height;
    atlas.mip_maps = false;
    atlas.sampler.min_filter = TextureFilter::linear;
    atlas.sampler.mag_filter = TextureFilter::linear;
    atlas.sampler.mipmap_mode = TextureMipmapMode::nearest;
    atlas.sampler.address_u = TextureAddressMode::clamp;
    atlas.sampler.address_v = TextureAddressMode::clamp;
    atlas.sampler.max_lod = 0.0f;
    atlas.has_render_texture = true;
    atlas.render_texture = texture;
    upstream::create_grid_sprite_atlas_frames(atlas, options);
${pushAtlasHandleCpp()}
}

SpriteRenderTextureHandle create_sprite_render_texture(
    Engine& engine,
    double width,
    double height) {
    SpriteRenderTextureRecord texture;
    texture.width = js::to_uint32(width);
    texture.height = js::to_uint32(height);
    engine.sprite_render_textures.push_back(texture);
    return SpriteRenderTextureHandle{
        static_cast<std::uint32_t>(
            engine.sprite_render_textures.size() - 1u)};
}

void dispose_sprite_render_texture(
    Engine& engine,
    SpriteRenderTextureHandle texture) {
    ${recordAt("engine.sprite_render_textures", "texture")}.disposed = true;
}

void set_sprite_renderer_target(
    Engine& engine,
    SpriteRendererHandle renderer,
    SpriteRenderTextureHandle target,
    bool has_target) {
    SpriteRendererRecord& record =
        ${recordAt("engine.sprite_renderers", "renderer")};
    record.has_target = has_target;
    record.target = target;
}

SpriteAtlasHandle create_sprite_atlas_from_frames(
    Engine& engine,
    const std::vector<SpriteAtlasFramePixelsView>& sources,
    SpriteAtlasPackOptions options) {
    if (sources.empty() && !options.has_capacity) {
        throw std::runtime_error(
            "createSpriteAtlasFromFrames: at least one frame is required.");
    }
    if (options.max_width_px == 0u) {
        throw std::runtime_error(
            "createSpriteAtlasFromFrames: maxWidthPx must be positive.");
    }
    const std::uint32_t shelf_width = options.has_capacity
        ? std::min(options.max_width_px, options.capacity_width)
        : options.max_width_px;
    std::vector<std::uint32_t> xs(sources.size());
    std::vector<std::uint32_t> ys(sources.size());
    std::uint32_t pen_x = 0u;
    std::uint32_t pen_y = 0u;
    std::uint32_t shelf_height = 0u;
    std::uint32_t content_width = 0u;
    for (std::size_t index = 0; index < sources.size(); ++index) {
        const SpriteAtlasFramePixelsView& source = sources[index];
        if (source.width == 0u || source.height == 0u) {
            throw std::runtime_error(
                "createSpriteAtlasFromFrames: frame has non-positive size.");
        }
        const std::uint32_t stride =
            source.src_stride_bytes.value_or(source.width * 4u);
        const std::uint64_t row_end =
            static_cast<std::uint64_t>(source.src_x + source.width) * 4u;
        if (row_end > stride) {
            throw std::runtime_error(
                "createSpriteAtlasFromFrames: source rectangle exceeds its stride.");
        }
        const std::uint64_t required =
            static_cast<std::uint64_t>(source.src_y + source.height - 1u) * stride +
            row_end;
        if (required > source.byte_length) {
            throw std::runtime_error(
                "createSpriteAtlasFromFrames: source pixel buffer is too short.");
        }
        if (pen_x > 0u && pen_x + source.width > shelf_width) {
            pen_y += shelf_height + options.padding_px;
            pen_x = 0u;
            shelf_height = 0u;
        }
        if (source.width > shelf_width) {
            throw std::runtime_error(
                "createSpriteAtlasFromFrames: frame exceeds shelf width.");
        }
        xs[index] = pen_x;
        ys[index] = pen_y;
        content_width = std::max(content_width, pen_x + source.width);
        pen_x += source.width + options.padding_px;
        shelf_height = std::max(shelf_height, source.height);
    }
    const std::uint32_t content_height = sources.empty()
        ? 0u
        : pen_y + shelf_height;
    const std::uint32_t atlas_width = options.has_capacity
        ? options.capacity_width
        : std::max(1u, content_width);
    const std::uint32_t atlas_height = options.has_capacity
        ? options.capacity_height
        : std::max(1u, content_height);
    if (atlas_width == 0u || atlas_height == 0u ||
        content_width > atlas_width || content_height > atlas_height) {
        throw std::runtime_error(
            "createSpriteAtlasFromFrames: atlas capacity is too small.");
    }

    SpriteAtlasRecord atlas;
    atlas.width = atlas_width;
    atlas.height = atlas_height;
    atlas.rgba.assign(
        static_cast<std::size_t>(atlas_width) * atlas_height * 4u, 0u);
    atlas.premultiplied_alpha = options.premultiplied_alpha;
    atlas.mip_maps = false;
    atlas.sampler.min_filter = options.sampling;
    atlas.sampler.mag_filter = options.sampling;
    atlas.sampler.mipmap_mode = TextureMipmapMode::nearest;
    atlas.sampler.address_u = TextureAddressMode::clamp;
    atlas.sampler.address_v = TextureAddressMode::clamp;
    atlas.sampler.max_anisotropy = 1.0f;
    atlas.sampler.max_lod = 0.0f;
    atlas.frames.reserve(sources.size());
    for (std::size_t index = 0; index < sources.size(); ++index) {
        const SpriteAtlasFramePixelsView& source = sources[index];
        const std::uint32_t stride =
            source.src_stride_bytes.value_or(source.width * 4u);
        const std::size_t row_bytes =
            static_cast<std::size_t>(source.width) * 4u;
        for (std::uint32_t row = 0; row < source.height; ++row) {
            const std::size_t source_offset =
                static_cast<std::size_t>(source.src_y + row) * stride +
                static_cast<std::size_t>(source.src_x) * 4u;
            const std::size_t destination_offset =
                (static_cast<std::size_t>(ys[index] + row) * atlas_width +
                 xs[index]) * 4u;
            std::copy_n(
                source.pixels + source_offset,
                row_bytes,
                atlas.rgba.begin() +
                    static_cast<std::ptrdiff_t>(destination_offset));
        }
        atlas.frames.push_back(SpriteFrame{
            Vec2{
                static_cast<float>(xs[index]) / atlas_width,
                static_cast<float>(ys[index]) / atlas_height},
            Vec2{
                static_cast<float>(xs[index] + source.width) / atlas_width,
                static_cast<float>(ys[index] + source.height) / atlas_height},
            Vec2{
                static_cast<float>(source.width),
                static_cast<float>(source.height)},
            source.pivot});
    }
${pushAtlasHandleCpp()}
}

Sprite2DLayerHandle create_sprite_2d_layer(
    Engine& engine,
    SpriteAtlasHandle atlas,
    Sprite2DLayerOptions options) {
    Sprite2DLayerRecord layer;
    layer.atlas = atlas;
    layer.blend = options.blend_mode;
    // initLayer, through the fx hook: a layer built with a descriptor
    // draws that program, its extra textures bind after the atlas, and
    // its params start zeroed.
    layer.custom_shader = options.custom_shader;
    layer.custom_textures = std::move(options.custom_textures);
    layer.custom_texture_names = std::move(options.custom_texture_names);
    layer.opacity = options.opacity;
    layer.visible = options.visible;
    layer.order = options.order;
    layer.depth_mode = options.depth_mode;
    layer.layer_z = options.layer_z;
    layer.pivot = options.pivot;
    layer.instance_floats_per_sprite =
        options.depth_mode == Sprite2DDepthMode::none
            ? sprite_instance_floats
            : sprite_depth_instance_floats;
    layer.capacity = static_cast<std::uint32_t>(
        std::max(1.0, static_cast<double>(options.capacity)));
    layer.instance_data.assign(
        static_cast<std::size_t>(layer.capacity) *
            layer.instance_floats_per_sprite,
        0.0f);
    layer.saved_size.assign(
        static_cast<std::size_t>(layer.capacity) *
            sprite_saved_size_floats,
        0.0f);
    engine.sprite_layers.push_back(std::move(layer));
    return Sprite2DLayerHandle{
        static_cast<std::uint32_t>(
            engine.sprite_layers.size() - 1u)};
}

// sprite-scene.ts#addDepthHostedSpriteLayer: a depth-enabled layer is a
// scene renderable, not a separately registered SpriteRenderer context.
void add_depth_hosted_sprite_layer(
    Scene& scene,
    Sprite2DLayerHandle layer_handle) {
    const Sprite2DLayerRecord& layer =
        ${recordAt("scene.engine->sprite_layers", "layer_handle")};
    if (layer.depth_mode == Sprite2DDepthMode::none) {
        throw std::runtime_error(
            "Depth-hosted sprites require depth != none.");
    }
    scene.depth_hosted_sprite_layers.push_back(layer_handle);
}

// render/alpha-to-coverage.ts: immutable pipeline state, read when the
// scene-hosted pipeline is created.
void set_sprite_2d_alpha_to_coverage(
    Engine& engine,
    Sprite2DLayerHandle layer_handle,
    bool enabled) {
    Sprite2DLayerRecord& layer =
        ${recordAt("engine.sprite_layers", "layer_handle")};
    if (layer.alpha_to_coverage == enabled) return;
    layer.alpha_to_coverage = enabled;
    layer.pipeline_version += 1u;
}

namespace {

// writeInstance: one writer, two arms. \`prev === null\` is the add arm,
// where an unspecified field takes its documented default; an update hands
// the slot's own floats back in, and an unspecified field takes the value
// already there. The pin shares this body between addSprite2DIndex and
// updateSprite2DIndex, so this port shares it too -- two writers would be
// two places for a slot to drift.
void write_sprite_instance(
    Sprite2DLayerRecord& layer,
    const SpriteAtlasRecord& atlas,
    std::uint32_t index,
    const Sprite2DProps& props,
    bool is_add) {
    const std::size_t base =
        static_cast<std::size_t>(index) *
        layer.instance_floats_per_sprite;
    const std::size_t saved_base =
        static_cast<std::size_t>(index) *
        sprite_saved_size_floats;
    const bool has_frame = props.has_frame;
    const SpriteFrame frame = has_frame
        ? atlas.frames[upstream::resolve_sprite_frame(
              atlas,
              static_cast<double>(props.frame))]
        : SpriteFrame{};
    // The pin's \`prev\` is a subarray view onto the slot being rewritten. It
    // needs no alias here: every preserved read below is guarded by
    // \`is_add\` and happens before the write phase at the end.

    // props.sizePx -> the frame's own size -> the previous TRUE size. The
    // shadow is what makes that last arm unambiguous: a hidden sprite's GPU
    // size is zeroed, so the instance floats cannot answer it.
    float true_w = 0.0f;
    float true_h = 0.0f;
    if (props.has_size_px) {
        true_w = props.size_px.x;
        true_h = props.size_px.y;
    } else if (has_frame) {
        true_w = frame.source_size_px.x;
        true_h = frame.source_size_px.y;
    } else if (!is_add) {
        true_w = layer.saved_size[saved_base];
        true_h = layer.saved_size[saved_base + 1u];
    }
    layer.saved_size[saved_base] = true_w;
    layer.saved_size[saved_base + 1u] = true_h;

    // A previous sprite was hidden exactly when its GPU size was zeroed.
    const bool visible =
        props.has_visible
            ? props.visible
            : (is_add ||
               layer.instance_data[base + 2u] != 0.0f ||
               layer.instance_data[base + 3u] != 0.0f);

    float u_min = 0.0f;
    float v_min = 0.0f;
    float u_max = 1.0f;
    float v_max = 1.0f;
    if (has_frame) {
        u_min = frame.uv_min.x;
        v_min = frame.uv_min.y;
        u_max = frame.uv_max.x;
        v_max = frame.uv_max.y;
    } else if (!is_add) {
        u_min = layer.instance_data[base + 4u];
        v_min = layer.instance_data[base + 5u];
        u_max = layer.instance_data[base + 6u];
        v_max = layer.instance_data[base + 7u];
    }
    // flipX/flipY are absolute orientation flags resolved against the flip
    // already baked into the endpoints, so re-sending the same value every
    // frame is idempotent. An omitted flag preserves the orientation the
    // slot already had, which is what keeps a frame change from unflipping
    // a sprite; on add there is no previous orientation, so it is false.
    const bool current_flip_x = u_min > u_max;
    const bool current_flip_y = v_min > v_max;
    const bool prev_flip_x =
        !is_add &&
        layer.instance_data[base + 4u] >
            layer.instance_data[base + 6u];
    const bool prev_flip_y =
        !is_add &&
        layer.instance_data[base + 5u] >
            layer.instance_data[base + 7u];
    const bool wants_flip_x =
        props.has_flip_x ? props.flip_x : prev_flip_x;
    const bool wants_flip_y =
        props.has_flip_y ? props.flip_y : prev_flip_y;
    if (current_flip_x != wants_flip_x) {
        std::swap(u_min, u_max);
    }
    if (current_flip_y != wants_flip_y) {
        std::swap(v_min, v_max);
    }

    const float rotation =
        props.has_rotation
            ? props.rotation
            : (is_add ? 0.0f : layer.instance_data[base + 8u]);
    // An omitted position preserves the slot's own; the add arm's
    // \`has_position_px\` is always true, because the pin throws without one.
    const float pos_x =
        props.has_position_px
            ? props.position_px.x
            : layer.instance_data[base + 0u];
    const float pos_y =
        props.has_position_px
            ? props.position_px.y
            : layer.instance_data[base + 1u];
    // The colour is the one block the pin leaves alone on update: without
    // \`props.color\` the four floats already in place are the answer, so an
    // update writes them only when the caller supplied one.

    layer.instance_data[base + 0u] = pos_x;
    layer.instance_data[base + 1u] = pos_y;
    layer.instance_data[base + 2u] = visible ? true_w : 0.0f;
    layer.instance_data[base + 3u] = visible ? true_h : 0.0f;
    layer.instance_data[base + 4u] = u_min;
    layer.instance_data[base + 5u] = v_min;
    layer.instance_data[base + 6u] = u_max;
    layer.instance_data[base + 7u] = v_max;
    layer.instance_data[base + 8u] = rotation;
    if (props.has_color) {
        layer.instance_data[base + 9u] = props.color.x;
        layer.instance_data[base + 10u] = props.color.y;
        layer.instance_data[base + 11u] = props.color.z;
        layer.instance_data[base + 12u] = props.color.w;
    } else if (is_add) {
        layer.instance_data[base + 9u] = 1.0f;
        layer.instance_data[base + 10u] = 1.0f;
        layer.instance_data[base + 11u] = 1.0f;
        layer.instance_data[base + 12u] = 1.0f;
    }
    if (layer.depth_mode != Sprite2DDepthMode::none) {
        layer.instance_data[base + 13u] =
            props.has_z
                ? props.z
                : (is_add
                      ? layer.layer_z
                      : layer.instance_data[base + 13u]);
    }
}

} // namespace

double add_sprite_2d_index(
    Engine& engine,
    Sprite2DLayerHandle layer_handle,
    Sprite2DProps props) {
    Sprite2DLayerRecord& layer =
        ${recordAt("engine.sprite_layers", "layer_handle")};
    const SpriteAtlasRecord& atlas =
        ${recordAt("engine.sprite_atlases", "layer.atlas")};
    if (!props.has_position_px) {
        throw std::runtime_error(
            "addSprite2DIndex: positionPx required.");
    }
    const std::uint32_t index = layer.count;
    if (index >= layer.capacity) {
        grow_sprite_capacity(layer, index + 1u);
    }
    write_sprite_instance(layer, atlas, index, props, true);
    layer.count = index + 1u;${
        ySort
            ? `
    observe_y_sort_add(layer, index);`
            : ""
    }
    touch_sprite_instances(layer, index, index + 1u);
    return static_cast<double>(index);
}

// sprite-2d.ts#updateSprite2DIndex: rewrite one slot in place, preserving
// every field the patch did not supply. The range check is the pin's own
// throw rather than a native guard.
void update_sprite_2d_index(
    Engine& engine,
    Sprite2DLayerHandle layer_handle,
    double index_value,
    Sprite2DProps props) {
    Sprite2DLayerRecord& layer =
        ${recordAt("engine.sprite_layers", "layer_handle")};
    if (!(index_value >= 0.0) ||
        index_value >= static_cast<double>(layer.count)) {
        throw std::runtime_error(
            "updateSprite2DIndex: index out of range.");
    }
    const SpriteAtlasRecord& atlas =
        ${recordAt("engine.sprite_atlases", "layer.atlas")};
    const std::uint32_t index =
        static_cast<std::uint32_t>(index_value);
    write_sprite_instance(
        layer,
        atlas,
        index,
        props,
        false);
    touch_sprite_instances(layer, index, index + 1u);
}


// sprite-2d-handle.ts: a stable id over a moving index. Upstream keeps the
// pair in a Map and a Uint32Array beside the layer, updated by a hook the
// layer calls on every removal; the same two tables live on the record here,
// and the same hook is the removal below. A layer only grows them once a
// scene asks for a handle, which is what keeps an index-only layer free of
// them.
double add_sprite_2d(
    Engine& engine,
    Sprite2DLayerHandle layer_handle,
    Sprite2DProps props) {
    const double index = add_sprite_2d_index(engine, layer_handle, props);
    Sprite2DLayerRecord& layer =
        ${recordAt("engine.sprite_layers", "layer_handle")};
    const std::uint32_t id = layer.next_sprite_id;
    if (id == invalid_handle) {
        throw std::runtime_error("addSprite2D: handle id space exhausted.");
    }
    layer.next_sprite_id = id + 1u;
    const std::uint32_t slot = static_cast<std::uint32_t>(index);
    if (layer.sprite_index_to_id.size() <= slot) {
        layer.sprite_index_to_id.resize(slot + 1u, 0u);
    }
    layer.sprite_id_to_index[id] = slot;
    layer.sprite_index_to_id[slot] = id;
    return static_cast<double>(id);
}

/** The slot an id names, or the layer's count where it names none. */
std::uint32_t sprite_2d_slot_of(
    const Sprite2DLayerRecord& layer,
    std::uint32_t sprite_id) {
    const auto found = layer.sprite_id_to_index.find(sprite_id);
    return found == layer.sprite_id_to_index.end() ? layer.count
                                                   : found->second;
}

bool sprite_2d_id_alive(
    const Engine& engine,
    Sprite2DLayerHandle layer_handle,
    std::uint32_t sprite_id) {
    const Sprite2DLayerRecord& layer =
        ${recordAt("engine.sprite_layers", "layer_handle")};
    return sprite_2d_slot_of(layer, sprite_id) < layer.count;
}

// sprite-2d.ts#setSprite2DFrameIndex: rewrite the slot's four UV floats from
// the atlas frame, keeping whichever axes the sprite was flipped on -- which
// the pin reads back off the stored UVs rather than a stored flag.
void set_sprite_2d_frame_id(
    Engine& engine,
    Sprite2DLayerHandle layer_handle,
    std::uint32_t sprite_id,
    double frame) {
    Sprite2DLayerRecord& layer =
        ${recordAt("engine.sprite_layers", "layer_handle")};
    const std::uint32_t index =
        sprite_2d_slot_of(layer, sprite_id);
    if (index >= layer.count) {
        throw std::runtime_error(
            "setSprite2DFrameIndex: index out of range");
    }
    const SpriteAtlasRecord& atlas =
        ${recordAt("engine.sprite_atlases", "layer.atlas")};
    const SpriteFrame& atlas_frame =
        atlas.frames[upstream::resolve_sprite_frame(atlas, frame)];
    const std::size_t base =
        static_cast<std::size_t>(index) * layer.instance_floats_per_sprite;
    const bool flip_x =
        layer.instance_data[base + 4] > layer.instance_data[base + 6];
    const bool flip_y =
        layer.instance_data[base + 5] > layer.instance_data[base + 7];
    layer.instance_data[base + 4] =
        flip_x ? atlas_frame.uv_max.x : atlas_frame.uv_min.x;
    layer.instance_data[base + 5] =
        flip_y ? atlas_frame.uv_max.y : atlas_frame.uv_min.y;
    layer.instance_data[base + 6] =
        flip_x ? atlas_frame.uv_min.x : atlas_frame.uv_max.x;
    layer.instance_data[base + 7] =
        flip_y ? atlas_frame.uv_min.y : atlas_frame.uv_max.y;
    touch_sprite_instances(layer, index, index + 1u);
}

// sprite-2d.ts#removeSprite2DIndex: a swap-remove. The last sprite moves
// into the hole, so the id tables move with it -- that reindexing is the
// whole reason a handle exists, and dropping it would leave every animation
// past the removed one driving the wrong sprite.
void remove_sprite_2d_id(
    Engine& engine,
    Sprite2DLayerHandle layer_handle,
    std::uint32_t sprite_id) {
    Sprite2DLayerRecord& layer =
        ${recordAt("engine.sprite_layers", "layer_handle")};
    const std::uint32_t index = sprite_2d_slot_of(layer, sprite_id);
    // removeSprite2D: a handle already gone does nothing, which is what
    // lets an animation's own removeWhenFinished race a scene's own remove.
    // The throw belongs to the INDEX form, whose caller has no id to miss.
    if (index >= layer.count) {
        return;
    }
    const std::uint32_t last = layer.count - 1u;
    const std::uint32_t moved_id =
        last < layer.sprite_index_to_id.size()
            ? layer.sprite_index_to_id[last]
            : 0u;
    layer.sprite_id_to_index.erase(sprite_id);
    if (index != last) {
        if (moved_id != 0u) {
            layer.sprite_id_to_index[moved_id] = index;
        }
        if (index < layer.sprite_index_to_id.size()) {
            layer.sprite_index_to_id[index] = moved_id;
        }
        const std::size_t stride = layer.instance_floats_per_sprite;
        std::copy(
            layer.instance_data.begin() +
                static_cast<std::ptrdiff_t>(last * stride),
            layer.instance_data.begin() +
                static_cast<std::ptrdiff_t>((last + 1u) * stride),
            layer.instance_data.begin() +
                static_cast<std::ptrdiff_t>(index * stride));
        layer.saved_size[index * 2u] = layer.saved_size[last * 2u];
        layer.saved_size[index * 2u + 1u] = layer.saved_size[last * 2u + 1u];
    } else if (index < layer.sprite_index_to_id.size()) {
        layer.sprite_index_to_id[index] = 0u;
    }
    if (last < layer.sprite_index_to_id.size()) {
        layer.sprite_index_to_id[last] = 0u;
    }
    layer.saved_size[last * 2u] = 0.0f;
    layer.saved_size[last * 2u + 1u] = 0.0f;
    layer.count = last;${
        ySort
            ? `
    observe_y_sort_remove(layer, index, last);`
            : ""
    }
    // Only a swap writes a row that remains active. Removing the tail still
    // bumps the version because a second GPU consumer must observe the new
    // draw count, but it needs no byte upload.
    touch_sprite_instances(
        layer,
        index,
        index == last ? index : index + 1u);
}

// sprite-2d.ts#clearSprite2DLayer: drop the count and the size shadow, and
// leave the instance floats where they are -- nothing reads past the count.
// An already-empty layer returns before the version moves, which is what
// keeps a per-frame clear on an idle layer from re-uploading.
void clear_sprite_2d_layer(
    Engine& engine,
    Sprite2DLayerHandle layer_handle) {
    Sprite2DLayerRecord& layer =
        ${recordAt("engine.sprite_layers", "layer_handle")};
    // The pin's clear runs the handle hooks' own clear first, so a layer
    // emptied under live handles answers "gone" rather than naming a slot
    // it no longer has.
    layer.sprite_id_to_index.clear();
    std::fill(
        layer.sprite_index_to_id.begin(),
        layer.sprite_index_to_id.end(),
        0u);
    const std::uint32_t count = layer.count;
    if (count == 0u) return;
    std::fill_n(
        layer.saved_size.begin(),
        static_cast<std::size_t>(count) *
            sprite_saved_size_floats,
        0.0f);
    layer.count = 0u;${
        ySort
            ? `
    observe_y_sort_clear(layer, count);`
            : ""
    }
    layer.dirty_sprite_begin = invalid_handle;
    layer.dirty_sprite_end = 0u;
    layer.version += 1u;
}

// sprite-2d-handle.ts#getSprite2DHandleIndex: the slot a stable id names
// right now. The throw is the pin's own -- a handle whose sprite was
// removed has no slot, and answering with one would drive another sprite.
double sprite_2d_handle_index(
    const Engine& engine,
    Sprite2DLayerHandle layer_handle,
    std::uint32_t sprite_id) {
    const Sprite2DLayerRecord& layer =
        ${recordAt("engine.sprite_layers", "layer_handle")};
    const std::uint32_t index = sprite_2d_slot_of(layer, sprite_id);
    if (index >= layer.count) {
        throw std::runtime_error(
            "getSprite2DHandleIndex: the handle is not alive.");
    }
    return static_cast<double>(index);
}

// sprite-2d-handle.ts#updateSprite2D: the index form over the slot the id
// currently names, so the same patch rules apply.
void update_sprite_2d_id(
    Engine& engine,
    Sprite2DLayerHandle layer_handle,
    std::uint32_t sprite_id,
    Sprite2DProps props) {
    update_sprite_2d_index(
        engine,
        layer_handle,
        sprite_2d_handle_index(engine, layer_handle, sprite_id),
        props);
}${ySortEntryPoints}

SpriteRendererHandle create_sprite_renderer(
    Engine& engine,
    SpriteRendererOptions options) {
    SpriteRendererRecord renderer;
    renderer.layers = std::move(options.layers);
    renderer.clear = options.clear;
    renderer.clear_value = options.clear_value;
    for (const Sprite2DLayerHandle& layer : renderer.layers) {
        if (layer.value >= engine.sprite_layers.size()) {
            throw std::runtime_error(
                "SpriteRenderer received an unknown layer.");
        }
        if (${recordAt("engine.sprite_layers", "layer")}.depth_mode !=
            Sprite2DDepthMode::none) {
            throw std::runtime_error(
                "SpriteRenderer requires layers with depth == none.");
        }
    }
    engine.sprite_renderers.push_back(std::move(renderer));
    return SpriteRendererHandle{
        static_cast<std::uint32_t>(
            engine.sprite_renderers.size() - 1u)};
}

// sprite-renderer.ts#addSpriteRendererLayer, whose membership rule is its
// own: a layer already present is a no-op, not a second draw.
void add_sprite_renderer_layer(
    Engine& engine,
    SpriteRendererHandle renderer,
    Sprite2DLayerHandle layer) {
    SpriteRendererRecord& record =
        ${recordAt("engine.sprite_renderers", "renderer")};
    if (record.disposed) {
        throw std::runtime_error(
            "SpriteRenderer has been disposed.");
    }
    if (layer.value >= engine.sprite_layers.size()) {
        throw std::runtime_error(
            "SpriteRenderer received an unknown layer.");
    }
    if (${recordAt("engine.sprite_layers", "layer")}.depth_mode !=
        Sprite2DDepthMode::none) {
        throw std::runtime_error(
            "SpriteRenderer requires layers with depth == none.");
    }
    std::vector<Sprite2DLayerHandle>& layers = record.layers;
    const auto present = std::any_of(
        layers.begin(),
        layers.end(),
        [&](const Sprite2DLayerHandle& candidate) {
            return candidate.value == layer.value;
        });
    if (present) return;
    layers.push_back(layer);
    record.layers_version += 1u;
}

// sprite-renderer.ts#removeSpriteRendererLayer: reports whether the layer
// was a member. Upstream also drops that layer's GPU state here; each
// backend does the same by rebuilding its pass off \`layers_version\`.
bool remove_sprite_renderer_layer(
    Engine& engine,
    SpriteRendererHandle renderer,
    Sprite2DLayerHandle layer) {
    SpriteRendererRecord& record =
        ${recordAt("engine.sprite_renderers", "renderer")};
    std::vector<Sprite2DLayerHandle>& layers = record.layers;
    const auto found = std::find_if(
        layers.begin(),
        layers.end(),
        [&](const Sprite2DLayerHandle& candidate) {
            return candidate.value == layer.value;
        });
    if (found == layers.end()) return false;
    layers.erase(found);
    record.layers_version += 1u;
    return true;
}

// sprite-renderer.ts#unregisterSpriteRenderer: drop the renderer from the
// engine's rendering contexts, which is what stops the frame loop walking
// it. Its own entry point in the pin, so its own function here.
void unregister_sprite_renderer(
    Engine& engine,
    SpriteRendererHandle renderer) {
    std::vector<SpriteRendererHandle>& registered =
        engine.registered_sprite_renderers;
    const auto found = std::find_if(
        registered.begin(),
        registered.end(),
        [&](const SpriteRendererHandle& candidate) {
            return candidate.value == renderer.value;
        });
    if (found == registered.end()) return;
    registered.erase(found);
}

// sprite-renderer.ts#disposeSpriteRenderer: idempotent, and the observable
// half is the unregistration -- a disposed renderer stops being walked by
// the frame loop. The pin's remaining work is releasing GPU objects, which
// each backend does when it sees the emptied layer list.
void dispose_sprite_renderer(
    Engine& engine,
    SpriteRendererHandle renderer) {
    SpriteRendererRecord& record =
        ${recordAt("engine.sprite_renderers", "renderer")};
    if (record.disposed) return;
    unregister_sprite_renderer(engine, renderer);
    record.disposed = true;
    record.layers.clear();
    record.layers_version += 1u;
}

void register_sprite_renderer(
    Engine& engine,
    SpriteRendererHandle renderer) {
    engine.registered_sprite_renderers.push_back(renderer);
}

// sprite-renderer.ts: \`_beforeUpdate\` is an ordinary array a caller
// pushes onto, and \`spriteRendererUpdate\` runs it with the frame's delta
// before it reads the renderer's layers. Both pure-2D node-particle
// bridges push their per-frame step here too.
void sprite_renderer_before_update(
    Engine& engine,
    SpriteRendererHandle renderer,
    std::function<void(double)> callback) {
    ${recordAt("engine.sprite_renderers", "renderer")}.before_update.push_back(
        std::move(callback));
}

} // namespace bbl
`,
        };
    }

    private ySortSource(ySort: boolean): string {
        return ySort
            ? `
// ── sprite-2d-y-sort.ts ─────────────────────────────────────────────────
// The optional stable GPU-order permutation for a pure-2D layer, lowered
// from the pin. It never reorders the layer's own instance rows: numeric
// slots, swap-remove and stable handle ids all stay canonical, and what is
// permuted is the copy the GPU reads. A scene that never enables a layer
// compiles none of this and finds the engine's hook empty.
${ySortCoreCpp(this.context)}
`
            : "";
    }

    private ySortEntryPoints(ySort: boolean): string {
        return ySort
            ? `

${ySortEntryPointsCpp(this.context)}

/**
 * The state's own live \`enabled\`.
 *
 * Upstream flips it false and detaches the state in the same call, and
 * \`disableSprite2DYSort\` is the only thing that reaches either, so a
 * scene holding the state and the layer holding its attachment answer the
 * same question. The disabler is not lowered, which is what keeps that
 * true -- re-enabling after a disable would build a fresh state and leave
 * the old one reading false while the layer read true.
 */
bool sprite_2d_y_sort_enabled(
    const Engine& engine,
    Sprite2DLayerHandle layer_handle) {
    return static_cast<bool>(
        ${recordAt("engine.sprite_layers", "layer_handle")}.y_sort);
}
`
            : "";
    }
}
