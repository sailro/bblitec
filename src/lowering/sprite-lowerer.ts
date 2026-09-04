import ts from "typescript";
import {
    PinnedShaderText,
    ShaderTextBinding,
} from "./pinned-shader-text.js";
import {
    blendFactoriesCpp,
    readPinnedBlendTable,
} from "./pinned-blend-table.js";
import { LoweredSource, LoweringContext } from "./context.js";
import {
    decodeAtlasImageCpp,
    gridSpriteAtlasFramesCpp,
    pushAtlasHandleCpp,
} from "./pinned-grid-atlas.js";
import { assertFrameAtlasRule } from "./pinned-frame-atlas.js";
import {
    extraTextureBindingsWgsl,
    extraTextureRecords,
} from "../shader-builtins-sprite-fx.js";
import { packagedWgsl } from "../pinned-wgsl-build.js";

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
const ySortModule = "src/sprite/sprite-2d-y-sort.ts";
const ySortHandleModule = "src/sprite/sprite-2d-handle-y-sort.ts";

/** The pinned WGSL, reconstructed for a reached 2D/depth/scroll permutation. */
export interface SpriteShaderSource {
    /** `Lr` struct body, one field per line, as the pin declares it. */
    layerStructFields: string;
    /** `I` struct body: the per-instance vertex attributes. */
    instanceStructFields: string;
    /** `O` struct body: the interpolants. */
    varyingStructFields: string;
    /** The `vs` body between its braces. */
    vertexBody: string;
    /** The `fs` body between its braces. */
    fragmentBody: string;
    /**
     * `SpriteFx` struct body, present only for a custom-shader layer. The
     * pin declares the block in the same builder that splices the caller's
     * fragment in, because a body that never names `fx` still has it bound.
     */
    fxStructFields?: string | undefined;
    /**
     * The `<name>Tex` / `<name>Samp` pairs a custom shader's extra textures
     * bind through, at this backend's own group, and empty when the body
     * named none. Emitted by the pin's own builder, so the pair it writes
     * per texture is the pin's.
     */
    extraTextureBindings: string;
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
    private readonly shaderText: PinnedShaderText;

    public constructor(private readonly context: LoweringContext) {
        this.shaderText = new PinnedShaderText(context);
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
            this.context.variableInitializer(
                file,
                "DEFAULT_CAPACITY",
            ),
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
     * One row per pinned Y-sort body the emitted module restates, measured
     * rather than guessed. `assertYSortInventory` reads them; a further body
     * is a row here rather than a method.
     */
    private static readonly ySortInventory: ReadonlyArray<
        readonly [string, readonly string[]]
    > = [
        ["keyAt", ["return statement"]],
        ["allocateSerial", ["return statement"]],
        [
            "ensureStorage",
            [
                "variable statement",
                "if statement",
                "variable statement",
                "if statement",
            ],
        ],
        [
            "syncCount",
            ["expression statement", "if statement", "expression statement"],
        ],
        [
            "comesBefore",
            [
                "variable statement",
                "variable statement",
                "if statement",
                "if statement",
                "return statement",
            ],
        ],
        [
            "ensureSorted",
            [
                "expression statement",
                "if statement",
                "variable statement",
                "variable statement",
                "for statement",
                "variable statement",
                "variable statement",
                "for statement",
                "if statement",
                "for statement",
                "expression statement",
            ],
        ],
        ["markPackedDirty", ["if statement"]],
        [
            "observeDirty",
            [
                "variable statement",
                "if statement",
                "expression statement",
                "variable statement",
                "for statement",
            ],
        ],
        [
            "observeAdd",
            [
                "variable statement",
                "if statement",
                ...Array(7).fill("expression statement"),
            ],
        ],
        [
            "observeRemove",
            [
                "variable statement",
                "if statement",
                "if statement",
                ...Array(6).fill("expression statement"),
            ],
        ],
        [
            "observeClear",
            [
                "variable statement",
                "if statement",
                ...Array(8).fill("expression statement"),
            ],
        ],
        ["packRange", ["variable statement", "for statement"]],
        [
            "uploadSorted",
            [
                "variable statement",
                "if statement",
                "if statement",
                "expression statement",
                "if statement",
                "if statement",
                "variable statement",
                "variable statement",
                "if statement",
                ...Array(5).fill("expression statement"),
                "return statement",
            ],
        ],
        [
            "getDrawOrder",
            [
                "variable statement",
                "if statement",
                "expression statement",
                "return statement",
            ],
        ],
        [
            "enableSprite2DYSort",
            [
                "if statement",
                "variable statement",
                "if statement",
                "variable statement",
                "if statement",
                "variable statement",
                "variable statement",
                "for statement",
                "expression statement",
                "expression statement",
                "expression statement",
                "return statement",
            ],
        ],
    ];

    /**
     * `sprite-2d-y-sort.ts`: the two things about the extension that are
     * arithmetic rather than shape, read off the pin instead of typed here.
     *
     * The draw KEY is which instance lane the order is taken from plus the
     * slot's bias, and the TIE is the insertion serial. Everything else the
     * module does -- allocating the permutation, packing, mapping a logical
     * dirty range through the inverse -- is bookkeeping around those two,
     * and a bump that moved either would silently reorder every Y-sorted
     * layer, so both are asserted where they are read.
     */
    private ySortContract(): number {
        this.assertYSortInventory();
        const { file, declaration } = this.context.functionDeclaration(
            ySortModule,
            "keyAt",
        );
        const returned = this.context.findNodes(
            declaration,
            ts.isReturnStatement,
        )[0]?.expression;
        if (
            !returned ||
            !ts.isBinaryExpression(returned) ||
            returned.operatorToken.kind !== ts.SyntaxKind.PlusToken
        ) {
            return this.context.contractError(
                declaration,
                "Pinned Sprite2D Y-sort keyAt no longer adds a bias to a stored lane.",
            );
        }
        const lane = this.elementIndexAddend(
            this.context.unwrapExpression(returned.left),
            "_instanceData",
        );
        if (
            lane === undefined ||
            this.elementAccessName(
                this.context.unwrapExpression(returned.right),
            ) !== "_biases"
        ) {
            return this.context.contractError(
                declaration,
                "Pinned Sprite2D Y-sort keyAt no longer reads _instanceData plus _biases.",
            );
        }
        const comparator = this.context.functionDeclaration(
            ySortModule,
            "comesBefore",
        );
        const returns = this.context.findNodes(
            comparator.declaration,
            ts.isReturnStatement,
        );
        const tie = returns[returns.length - 1]?.expression;
        if (
            !tie ||
            !ts.isBinaryExpression(tie) ||
            tie.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
            this.elementAccessName(tie.left) !== "_serials" ||
            this.elementAccessName(tie.right) !== "_serials"
        ) {
            return this.context.contractError(
                comparator.declaration,
                "Pinned Sprite2D Y-sort no longer breaks equal keys by ascending insertion serial.",
            );
        }
        if (
            !this.context.hasNode(
                comparator.declaration,
                (node) =>
                    ts.isElementAccessExpression(node) &&
                    this.elementAccessName(node) === "_keys",
            )
        ) {
            return this.context.contractError(
                comparator.declaration,
                "Pinned Sprite2D Y-sort no longer orders by the cached key.",
            );
        }
        // The handle companion is the one entry point scene code reaches
        // the bias through; it resolving the slot rather than taking one is
        // why a removal cannot leave a scene biasing another sprite.
        const handleSetter = this.context.functionDeclaration(
            ySortHandleModule,
            "setSprite2DYSortHandleBias",
        );
        if (
            !this.context.hasNode(
                handleSetter.declaration,
                (node) =>
                    ts.isCallExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "getSprite2DHandleIndex",
            )
        ) {
            this.context.contractError(
                handleSetter.declaration,
                "Pinned setSprite2DYSortHandleBias no longer resolves the handle's current slot.",
            );
        }
        if (lane !== 1) {
            // The emitted key reads the lane the pin names, but the writer
            // that PUTS positionPx.y there spells its own offset, so the
            // two have to agree or a Y-sorted layer would order by whatever
            // lane 1 now holds without anything saying so.
            this.context.contractError(
                file,
                `Pinned Sprite2D Y-sort orders by instance lane ${lane}, ` +
                    "which is not the lane write_sprite_instance stores " +
                    "positionPx.y into.",
            );
        }
        return lane;
    }

    /**
     * Every pinned Y-sort body this module restates, by statement kind.
     *
     * The two expression anchors above pin the draw key and its tie, which
     * is what decides ORDER. They say nothing about the rest of the module,
     * and the rest of the module is restated in C++ rather than lowered
     * from its AST -- a mirror, which `docs/fidelity.md` records as the
     * weaker form precisely because it can silently omit an arm where a
     * lowering refuses one it cannot express. A bump that adds a branch to
     * `syncCount`'s grow/shrink arms, to `uploadSorted`'s dirty-range
     * mapping, or to the enabler's guards would reorder every Y-sorted
     * layer with generation staying green.
     *
     * So the inventory is the third anchor, the same technique
     * `physics-lowerer.ts` applies to the bodies it restates whole: an
     * added, removed or reordered statement fails generation by name
     * instead. It is a count of shapes, not of behaviour -- it cannot see a
     * changed expression inside a statement, which is what the two anchors
     * above are for.
     */
    private assertYSortInventory(): void {
        for (const [symbolName, kinds] of SpriteLowerer.ySortInventory) {
            const { declaration } = this.context.functionDeclaration(
                ySortModule,
                symbolName,
            );
            this.context.assertStatementInventory(
                declaration,
                declaration.body!.statements,
                symbolName,
                "the emitted Y-sort module restates a body",
                kinds,
            );
        }
    }

    /**
     * The `_name` an `x._name[i]` element access reads, if it is one.
     *
     * The pinned source spells every one of these with a non-null assertion
     * (`state._serials[left]!`), so the expression is unwrapped first.
     */
    private elementAccessName(node: ts.Node): string | undefined {
        const unwrapped = ts.isExpression(node)
            ? this.context.unwrapExpression(node)
            : node;
        return ts.isElementAccessExpression(unwrapped) &&
            ts.isPropertyAccessExpression(unwrapped.expression)
            ? unwrapped.expression.name.text
            : undefined;
    }

    /**
     * The literal added to the row base in an `x._name[i * stride + N]`
     * read: the lane the expression addresses.
     */
    private elementIndexAddend(
        node: ts.Node,
        name: string,
    ): number | undefined {
        if (
            !ts.isElementAccessExpression(node) ||
            this.elementAccessName(node) !== name
        ) {
            return undefined;
        }
        const argument = this.context.unwrapExpression(
            node.argumentExpression,
        );
        if (
            !ts.isBinaryExpression(argument) ||
            argument.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
            !ts.isNumericLiteral(argument.right)
        ) {
            return undefined;
        }
        return this.context.numericValue(
            argument.right,
            node.getSourceFile(),
        );
    }

    /**
     * `sprite-2d-uvscroll.ts` ensureWide: the row the pin stashes for the
     * widened layout, read rather than typed. Its offset is the narrow
     * stride, which is the one part the pin computes at run time.
     */
    private uvScrollAttribute(instanceFloats: number): {
        location: number;
        offsetBytes: number;
        floatCount: number;
    } {
        const { declaration } = this.context.functionDeclaration(
            uvScrollModule,
            "ensureWide",
        );
        const write = this.context.findNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
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
        const match = /^float32(?:x([234]))?$/.exec(format);
        if (!match) {
            this.context.contractError(
                literal,
                `Unsupported uvScroll attribute format '${format}'.`,
            );
        }
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
            floatCount: match[1] === undefined ? 1 : Number(match[1]),
        };
    }

    /**
     * `sprite-pipeline.ts`: the pure-2D per-instance vertex attributes at
     * the pin's own byte offsets. The offsets are the module's named
     * constants and the rows are `instanceAttributes`' base literal (the
     * depth and uv-scroll rows append behind opt-ins the pure-2D slice
     * never takes), so a moved slot or widened format fails generation
     * instead of drifting inside two hand-written PAL tables.
     */
    private instanceAttributeRows(instanceFloats: number): Array<{
        location: number;
        offsetBytes: number;
        floatCount: number;
    }> {
        const file = this.context.sourceFile(pipelineModule);
        const array = this.context.unwrapExpression(
            this.context.variableInitializer(file, "instanceAttributes"),
        );
        if (!ts.isArrayLiteralExpression(array)) {
            return this.context.contractError(
                array,
                "Expected the pinned instanceAttributes array literal.",
            );
        }
        const rows = array.elements.map((element) => {
            const literal = this.context.unwrapExpression(element);
            if (!ts.isObjectLiteralExpression(literal)) {
                return this.context.contractError(
                    literal,
                    "Expected a pinned sprite attribute object literal.",
                );
            }
            let location: number | undefined;
            let offsetBytes: number | undefined;
            let floatCount: number | undefined;
            for (const property of literal.properties) {
                if (!ts.isPropertyAssignment(property)) continue;
                const name = this.context.propertyName(property.name);
                if (name === "shaderLocation") {
                    location = this.context.numericValue(
                        property.initializer,
                        file,
                    );
                } else if (name === "offset") {
                    const reference = this.context.unwrapExpression(
                        property.initializer,
                    );
                    if (!ts.isIdentifier(reference)) {
                        return this.context.contractError(
                            reference,
                            "Expected a named sprite offset constant.",
                        );
                    }
                    offsetBytes = this.context.numericValue(
                        this.context.variableInitializer(
                            file,
                            reference.text,
                        ),
                        file,
                    );
                } else if (name === "format") {
                    const format = this.context.unwrapExpression(
                        property.initializer,
                    );
                    if (!ts.isStringLiteral(format)) {
                        return this.context.contractError(
                            format,
                            "Expected a sprite attribute format string.",
                        );
                    }
                    const match = /^float32(?:x([234]))?$/.exec(
                        format.text,
                    );
                    if (!match) {
                        return this.context.contractError(
                            format,
                            `Unsupported sprite attribute format '${format.text}'.`,
                        );
                    }
                    floatCount =
                        match[1] === undefined ? 1 : Number(match[1]);
                }
            }
            if (
                location === undefined ||
                offsetBytes === undefined ||
                floatCount === undefined
            ) {
                return this.context.contractError(
                    literal,
                    "Pinned sprite attribute misses shaderLocation, offset or format.",
                );
            }
            return { location, offsetBytes, floatCount };
        });
        // The base rows must tile the pure-2D stride exactly: the last
        // attribute ends where PURE_2D_INSTANCE_FLOATS_PER_SPRITE says the
        // instance does, or the two pinned modules disagree.
        const lastEnd = rows.reduce(
            (max, row) =>
                Math.max(max, row.offsetBytes + row.floatCount * 4),
            0,
        );
        if (lastEnd !== instanceFloats * 4) {
            this.context.contractError(
                array,
                `Pinned sprite attributes end at ${lastEnd} bytes, expected ${instanceFloats * 4}.`,
            );
        }
        return rows;
    }

    /** The optional depth row appended by `buildSpritePipeline`. */
    private depthAttribute(): {
        location: number;
        offsetBytes: number;
        floatCount: number;
    } {
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
        const literal = this.context.unwrapExpression(push.arguments[0]!);
        if (!ts.isObjectLiteralExpression(literal)) {
            return this.context.contractError(
                literal,
                "Expected the pinned sprite depth attribute literal.",
            );
        }
        const location = this.context.numericValue(
            this.context.propertyInitializer(literal, "shaderLocation"),
            file,
        );
        const offset = this.context.unwrapExpression(
            this.context.propertyInitializer(literal, "offset"),
        );
        if (!ts.isIdentifier(offset)) {
            return this.context.contractError(
                offset,
                "Expected the named sprite depth offset constant.",
            );
        }
        const offsetBytes = this.context.numericValue(
            this.context.variableInitializer(file, offset.text),
            file,
        );
        const format = this.context.stringValue(
            this.context.propertyInitializer(literal, "format"),
            file,
        );
        if (format !== "float32") {
            return this.context.contractError(
                literal,
                `Pinned sprite depth attribute uses '${format}', expected float32.`,
            );
        }
        return { location, offsetBytes, floatCount: 1 };
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
        const writes = this.context.findNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                ts.isElementAccessExpression(node.left) &&
                ts.isIdentifier(node.left.expression) &&
                node.left.expression.text === "data",
        );
        for (const [slot, source] of expected) {
            const write = writes.find(
                (node) =>
                    this.elementIndexText(node.left) ===
                    `base + ${slot}`,
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
                (node) =>
                    this.elementIndexText(node.left) ===
                    `base + ${slot}`,
            );
            if (found.length !== 2) {
                this.context.contractError(
                    declaration,
                    `Pinned writeInstance colour slot ${slot} has ${found.length} writers, expected 2.`,
                );
            }
        }
        const depthWrite = writes.find(
            (node) =>
                this.elementIndexText(node.left) === "base + 13",
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
            this.context.variableInitializer(
                declaration,
                "currentFlipX",
            ),
            "uMin > uMax",
            "writeInstance currentFlipX",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "wantsFlipX",
            ),
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
            [
                "posX",
                "props.positionPx ? props.positionPx[0] : prev![0]!",
            ],
            [
                "posY",
                "props.positionPx ? props.positionPx[1] : prev![1]!",
            ],
            ["prevFlipX", "!isAdd && prev![4]! > prev![6]!"],
            ["prevFlipY", "!isAdd && prev![5]! > prev![7]!"],
            ["rotation", "props.rotation ?? (prev ? prev[8]! : 0)"],
        ];
        for (const [name, source] of preserved) {
            this.context.assertExpressionShape(
                this.context.variableInitializer(
                    declaration,
                    name,
                ),
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
            this.context.variableInitializer(
                update.declaration,
                "prev",
            ),
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
            [
                "_setSprite2DCount(layer, 0)",
                "clearSprite2DLayer count reset",
            ],
            [
                "(layer._version + 1) | 0",
                "clearSprite2DLayer version bump",
            ],
        ];
        for (const [source, label] of statements) {
            this.context.expectShapeCount(
                declaration,
                source,
                label,
            );
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
            this.context.variableInitializer(
                remove.declaration,
                "index",
            ),
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
            this.context.variableInitializer(
                declaration,
                "base",
            ),
            "slotIndex * layer._instanceFloatsPerSprite",
            "writeInstance base",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "savedBase",
            ),
            "slotIndex * SAVED_SIZE_FLOATS_PER_SPRITE",
            "writeInstance savedBase",
        );
    }

    /** `createGridSpriteAtlas` derives columns, rows, and each frame's UVs. */
    private assertGridAtlas(): void {
        const { declaration } = this.context.functionDeclaration(
            atlasModule,
            "createGridSpriteAtlas",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "cols",
            ),
            "options.columns ?? Math.max(1, Math.floor((texture.width - margin * 2 + spacing) / (cellW + spacing)))",
            "createGridSpriteAtlas columns",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "rows",
            ),
            "options.rows ?? Math.max(1, Math.floor((texture.height - margin * 2 + spacing) / (cellH + spacing)))",
            "createGridSpriteAtlas rows",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "x",
            ),
            "margin + c * (cellW + spacing)",
            "createGridSpriteAtlas frame x",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "y",
            ),
            "margin + r * (cellH + spacing)",
            "createGridSpriteAtlas frame y",
        );
        const push = this.context.findNodes(
            declaration,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(
                    node.expression,
                ) &&
                node.expression.name.text === "push",
        )[0];
        const frame = push
            ? this.context.unwrapExpression(
                  push.arguments[0]!,
              )
            : undefined;
        if (!frame || !ts.isObjectLiteralExpression(frame)) {
            this.context.contractError(
                declaration,
                "Pinned createGridSpriteAtlas no longer pushes frame literals.",
            );
        }
        for (const [name, source] of [
            ["uvMin", "[x / tw, y / th]"],
            ["uvMax", "[(x + cellW) / tw, (y + cellH) / th]"],
            ["sourceSizePx", "[cellW, cellH]"],
            ["pivot", "[pivot[0], pivot[1]]"],
        ] as const) {
            this.context.assertExpressionShape(
                this.context.propertyInitializer(
                    frame,
                    name,
                ),
                source,
                `createGridSpriteAtlas frame ${name}`,
            );
        }
    }

    /** `resolveSpriteFrame` is a bounds check and nothing else. */
    private assertFrameResolution(): void {
        const { declaration } = this.context.functionDeclaration(
            atlasModule,
            "resolveSpriteFrame",
        );
        const guard = this.context.findNodes(
            declaration,
            (node): node is ts.IfStatement =>
                ts.isIfStatement(node),
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
                ts.isReturnStatement(node) &&
                node.expression !== undefined,
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
        const options = this.context.objectInitializer(
            declaration,
            "texOpts",
        );
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
            [
                "premultiplyAlpha",
                "options.premultiplyOnLoad ?? false",
            ],
        ] as const) {
            this.context.assertExpressionShape(
                this.context.propertyInitializer(
                    options,
                    name,
                ),
                source,
                `loadSpriteAtlas ${name}`,
            );
        }
        if (
            !this.context.hasCall(
                declaration,
                "createGridSpriteAtlas",
            )
        ) {
            this.context.contractError(
                file,
                "Pinned loadSpriteAtlas no longer partitions the texture into a grid.",
            );
        }
    }

    /**
     * The slot expressions a pinned writer fills, checked against the pin.
     *
     * Both pinned writers this lowerer reads state their layout the same
     * way — an assignment per float into a named array — so the walk is
     * written once and each caller says which array and what it expects.
     */
    private assertSlotWrites(
        declaration: ts.FunctionDeclaration,
        symbolName: string,
        arrayName: string,
        expected: ReadonlyArray<[number, string]>,
    ): void {
        const writes = this.context.findNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                ts.isElementAccessExpression(node.left) &&
                ts.isIdentifier(node.left.expression) &&
                node.left.expression.text === arrayName,
        );
        for (const [slot, source] of expected) {
            const write = writes.find(
                (node) =>
                    this.elementIndexText(node.left) ===
                    String(slot),
            );
            if (!write) {
                this.context.contractError(
                    declaration,
                    `Pinned ${symbolName} no longer writes float ${slot}.`,
                );
            }
            this.context.assertExpressionShape(
                write.right,
                source,
                `${symbolName} float ${slot}`,
            );
        }
    }

    /**
     * `writeSpriteFxUbo` fills eight floats in a fixed order, and
     * `SPRITE_FX_UBO_BYTES` is what the block is bound as.
     *
     * The module is shared between the two families, so the check and the
     * function it guards are stated once here and the billboard system
     * reads them out of the same header, the way it already does for
     * `resolveSpriteFrame`.
     */
    private assertFxUbo(): number {
        const { declaration, file } = this.context.functionDeclaration(
            customShaderCoreModule,
            "writeSpriteFxUbo",
        );
        const expected: readonly string[] = [
            "timeSeconds",
            "0",
            "0",
            "0",
            "params[0] ?? 0",
            "params[1] ?? 0",
            "params[2] ?? 0",
            "params[3] ?? 0",
        ];
        this.assertSlotWrites(
            declaration,
            "writeSpriteFxUbo",
            "scratch",
            expected.map((source, slot) => [slot, source]),
        );
        const bytes = this.context.numericValue(
            this.context.variableInitializer(
                this.context.sourceFile(customShaderCoreModule),
                "SPRITE_FX_UBO_BYTES",
            ),
            file,
        );
        if (bytes !== expected.length * 4) {
            this.context.contractError(
                declaration,
                `Pinned SPRITE_FX_UBO_BYTES is ${bytes}, which is not the ${expected.length} floats written.`,
            );
        }
        return bytes;
    }

    /** `buildSpriteLayerUbo` fills sixteen floats in a fixed order. */
    private assertLayerUbo(): void {
        const { declaration, file } = this.context.functionDeclaration(
            pipelineModule,
            "buildSpriteLayerUbo",
        );
        const expected: ReadonlyArray<[number, string]> = [
            [0, "layer.view.positionPx[0]"],
            [1, "layer.view.positionPx[1]"],
            [2, "layer.view.zoom"],
            [3, "layer.view.rotation"],
            [4, "screenWidth"],
            [5, "screenHeight"],
            [6, "layer.pivot[0]"],
            [7, "layer.pivot[1]"],
        ];
        this.assertSlotWrites(
            declaration,
            "buildSpriteLayerUbo",
            "ubo",
            expected,
        );
        // Straight alpha scales only A; premultiplied scales RGB too. Only
        // the straight arm is reached, and it has to be the `else`.
        const branch = this.context.findNodes(
            declaration,
            (node): node is ts.IfStatement =>
                ts.isIfStatement(node),
        )[0];
        if (
            !branch?.elseStatement ||
            !this.context.hasNode(
                branch.expression,
                (node) =>
                    ts.isPropertyAccessExpression(node) &&
                    node.name.text ===
                        "_premultipliedOpacity",
            )
        ) {
            this.context.contractError(
                declaration,
                "Pinned buildSpriteLayerUbo no longer branches on premultiplied opacity.",
            );
        }
        const bytes = this.context.numericValue(
            this.context.variableInitializer(
                file,
                "LAYER_UBO_BYTES",
            ),
            file,
        );
        if (bytes !== 64) {
            this.context.contractError(
                file,
                `Pinned sprite layer UBO is ${bytes} bytes, expected 64.`,
            );
        }
    }

    /** The shared quad: four corners, six indices, one instanced draw. */
    private assertQuad(): void {
        const file = this.context.sourceFile(pipelineModule);
        const indices = this.context.unwrapExpression(
            this.context.variableInitializer(
                file,
                "SHARED_SPRITE_INDEX_DATA",
            ),
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
                ts.isPropertyAccessExpression(
                    node.expression,
                ) &&
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
     * Reconstructs the shader the pin builds for the reached permutation
     * selected depth/uv permutation by evaluating its
     * own template rather than by transcribing the result. Anything the
     * evaluator cannot fold is a contract failure, so a changed shader
     * stops generation instead of silently keeping this copy.
     */
    public shaderSource(
        uvScroll = false,
        customFragment?: string,
        extraTextures: readonly string[] = [],
        hasDepth = false,
    ): SpriteShaderSource {
        const permutation = new Map<string, ShaderTextBinding>([
            ["hasDepth", hasDepth],
            ["spriteGroupIndex", hasDepth ? "1" : "0"],
            ["uvScroll", uvScroll],
        ]);
        // A custom-shader layer keeps the engine's vertex stage and
        // replaces only the fragment body, which the pin expresses by
        // composing the same prologue with the caller's text -- so one
        // builder yields both halves here.
        const composed =
            customFragment === undefined
                ? undefined
                : this.shaderText.evaluate(
                      customShaderModule,
                      "makeCustomSpriteWgsl",
                      new Map<string, ShaderTextBinding>([
                          ...permutation,
                          [
                              "extraTextures",
                              extraTextureRecords(extraTextures),
                          ],
                          ["fragment", customFragment],
                      ]),
                  );
        const prologue =
            composed ??
            this.shaderText.evaluate(
                pipelineModule,
                "makeSpritePrologueWgsl",
                permutation,
            );
        const full =
            composed ??
            this.shaderText.evaluate(
                pipelineModule,
                "makeSpriteWgsl",
                permutation,
            );
        return {
            layerStructFields: this.shaderText.braced(
                prologue,
                packagedWgsl`struct Lr {`,
                "sprite layer uniform struct",
            ),
            instanceStructFields: this.shaderText.braced(
                prologue,
                packagedWgsl`struct I {`,
                "sprite instance struct",
            ),
            varyingStructFields: this.shaderText.braced(
                prologue,
                packagedWgsl`struct O {`,
                "sprite varying struct",
            ),
            vertexBody: this.shaderText.braced(
                prologue,
                packagedWgsl`fn vs(in: I) -> O {`,
                "sprite vertex stage",
            ),
            fragmentBody: this.shaderText.braced(
                full,
                packagedWgsl`fn fs(in: O) -> @location(0) vec4f {`,
                "sprite fragment stage",
            ),
            fxStructFields: composed
                ? this.shaderText.braced(
                      composed,
                      packagedWgsl`struct SpriteFx {`,
                      "sprite fx uniform struct",
                  )
                : undefined,
            extraTextureBindings: extraTextureBindingsWgsl(
                this.shaderText,
                extraTextures,
            ),
        };
    }



    // -----------------------------------------------------------------
    // Emission
    // -----------------------------------------------------------------

    private elementIndexText(
        target: ts.Expression,
    ): string | undefined {
        if (!ts.isElementAccessExpression(target)) {
            return undefined;
        }
        return target.argumentExpression
            .getText(target.getSourceFile())
            .replace(/\s+/g, " ")
            .trim();
    }

    public lowerCore(ySort = false): LoweredSource {
        const layout = this.layout();
        // The optional Y-sort extension, emitted only where a scene reached
        // its enabler -- upstream registers its hook from inside that call
        // and leaves every other layer on the canonical logical order, so
        // the enabler is the whole opt-in and nothing else detects it.
        const ySortKeyLane = ySort ? this.ySortContract() : 0;
        const blends = readPinnedBlendTable(
            this.context,
            blendModule,
            "spriteBlend",
        );
        // The intrinsic defaults an unnamed blendMode to this factory, so the
        // descriptor the default names has to be one the pin still exports.
        // Everything about its factors is read, not asserted -- a hand-typed
        // expectation here would fail a bump the table lowers correctly.
        if (
            !blends.some(
                (blend) => blend.exportName === "spriteBlendAlpha",
            )
        ) {
            this.context.contractError(
                this.context.sourceFile(blendModule),
                "Pinned sprite blends no longer export spriteBlendAlpha, which the default names.",
            );
        }
        const attributeRows = this.instanceAttributeRows(
            layout.pureInstanceFloats,
        );
        const depthRow = this.depthAttribute();
        const uvScrollRow = this.uvScrollAttribute(
            layout.pureInstanceFloats,
        );
        this.assertGridAtlas();
        assertFrameAtlasRule(this.context);
        this.assertFrameResolution();
        this.assertAtlasLoader();
        this.assertInstanceBase();
        this.assertInstanceSlots();
        this.assertDepthHostedRenderable();
        this.assertUpdateArm();
        this.assertClearLayer();
        this.assertRendererMembership();
        this.assertLayerUbo();
        const fxUboBytes = this.assertFxUbo();
        this.assertQuad();

        // sprite-2d-y-sort.ts, emitted whole or not at all. Everything in
        // it is file-local but the three entry points scene code names, so
        // the always-loaded paths below reach it through the layer's own
        // state pointer and the engine's one lazily-installed hook.
        const ySortSource = ySort
            ? `
// ── sprite-2d-y-sort.ts ─────────────────────────────────────────────────
// The optional stable GPU-order permutation for a pure-2D layer. It never
// reorders the layer's own instance rows: numeric slots, swap-remove and
// stable handle ids all stay canonical, and what is permuted is the copy
// the GPU reads. Upstream keeps this state private to its own module and
// lets the always-loaded mutation, upload and pick paths reach it through
// one lazily registered hook, which is why a scene that never enables a
// layer compiles none of this and finds that hook empty.
struct YSortState {
    double default_bias = 0.0;
    /** Draw slot -> logical slot, and its inverse. */
    std::vector<std::uint32_t> permutation;
    std::vector<std::uint32_t> inverse_permutation;
    std::vector<std::uint32_t> merge_scratch;
    /** Persistent insertion serial, ordering bias and cached key per slot. */
    std::vector<double> serials;
    std::vector<double> biases;
    std::vector<double> keys;
    /** The GPU-order rows the backends upload. */
    std::vector<float> packed_instances;
    std::uint32_t capacity = 0;
    std::uint32_t packed_stride = 0;
    std::uint32_t active_count = 0;
    double next_serial = 0.0;
    bool sort_dirty = true;
    bool full_upload = true;
    std::uint32_t dirty_min = 0;
    std::uint32_t dirty_max = 0;
};

YSortState* y_sort_state(const Sprite2DLayerRecord& layer) {
    return static_cast<YSortState*>(layer.y_sort.get());
}

double allocate_y_sort_serial(YSortState& state) {
    const double serial = state.next_serial;
    state.next_serial = serial + 1.0;
    return serial;
}

/**
 * Object.is over two keys: the pin compares them with it rather than with
 * equality, so a key that did not move leaves the order alone and one that
 * moved between the two zeroes does not.
 */
bool y_sort_same_key(double left, double right) {
    if (std::isnan(left) || std::isnan(right)) {
        return std::isnan(left) && std::isnan(right);
    }
    return left == right &&
        std::signbit(left) == std::signbit(right);
}

// keyAt: the slot's own stored ordering lane plus its bias, summed at the
// width the pin's F64 bias array gives it. Lane ${ySortKeyLane} is
// positionPx.y, read off the pin rather than typed here.
double y_sort_key_at(
    const Sprite2DLayerRecord& layer,
    const YSortState& state,
    std::uint32_t index) {
    const std::size_t base =
        static_cast<std::size_t>(index) *
        layer.instance_floats_per_sprite;
    return static_cast<double>(
               layer.instance_data[base + ${ySortKeyLane}u]) +
        state.biases[index];
}

// ensureStorage: the metadata follows the layer's capacity, and the packed
// buffer additionally follows its instance stride -- a UV-scroll widening
// replaces that buffer once.
void ensure_y_sort_storage(
    const Sprite2DLayerRecord& layer,
    YSortState& state) {
    if (layer.capacity > state.capacity) {
        state.permutation.resize(layer.capacity, 0u);
        state.inverse_permutation.resize(layer.capacity, 0u);
        state.merge_scratch.resize(layer.capacity, 0u);
        state.serials.resize(layer.capacity, 0.0);
        state.biases.resize(layer.capacity, 0.0);
        state.keys.resize(layer.capacity, 0.0);
        state.capacity = layer.capacity;
        state.sort_dirty = true;
        state.full_upload = true;
    }
    const std::size_t packed = static_cast<std::size_t>(layer.capacity) *
        layer.instance_floats_per_sprite;
    if (state.packed_instances.size() < packed ||
        state.packed_stride != layer.instance_floats_per_sprite) {
        state.packed_instances.assign(packed, 0.0f);
        state.packed_stride = layer.instance_floats_per_sprite;
        state.full_upload = true;
    }
}

// syncCount: metadata follows the layer's live count, so a slot that
// entered without being observed still gets its serial and default bias.
void sync_y_sort_count(
    const Sprite2DLayerRecord& layer,
    YSortState& state) {
    ensure_y_sort_storage(layer, state);
    if (layer.count > state.active_count) {
        for (std::uint32_t index = state.active_count;
             index < layer.count;
             ++index) {
            state.biases[index] = state.default_bias;
            state.serials[index] = allocate_y_sort_serial(state);
            state.keys[index] = y_sort_key_at(layer, state, index);
        }
        state.sort_dirty = true;
        state.full_upload = true;
    } else if (layer.count < state.active_count) {
        const auto retired_begin =
            static_cast<std::ptrdiff_t>(layer.count);
        const auto retired_end =
            static_cast<std::ptrdiff_t>(state.active_count);
        std::fill(
            state.serials.begin() + retired_begin,
            state.serials.begin() + retired_end,
            0.0);
        std::fill(
            state.biases.begin() + retired_begin,
            state.biases.begin() + retired_end,
            0.0);
        std::fill(
            state.keys.begin() + retired_begin,
            state.keys.begin() + retired_end,
            0.0);
        state.sort_dirty = true;
        state.full_upload = true;
    }
    state.active_count = layer.count;
}

// comesBefore: ascending key, then ascending insertion serial. The serials
// are unique, so the order is total and equal keys keep the order they
// entered in even after unrelated removals moved their slots.
bool y_sort_comes_before(
    const YSortState& state,
    std::uint32_t left,
    std::uint32_t right) {
    const double left_key = state.keys[left];
    const double right_key = state.keys[right];
    if (left_key < right_key) return true;
    if (left_key > right_key) return false;
    return state.serials[left] < state.serials[right];
}

// ensureSorted: a bottom-up stable merge over the cached keys.
void ensure_y_sorted(
    const Sprite2DLayerRecord& layer,
    YSortState& state) {
    sync_y_sort_count(layer, state);
    if (!state.sort_dirty) return;
    const std::uint32_t count = layer.count;
    for (std::uint32_t index = 0u; index < count; ++index) {
        state.permutation[index] = index;
    }
    std::vector<std::uint32_t>* source = &state.permutation;
    std::vector<std::uint32_t>* target = &state.merge_scratch;
    for (std::uint32_t width = 1u; width < count; width *= 2u) {
        for (std::uint32_t start = 0u;
             start < count;
             start += width * 2u) {
            const std::uint32_t middle = std::min(start + width, count);
            const std::uint32_t end = std::min(start + width * 2u, count);
            std::uint32_t left = start;
            std::uint32_t right = middle;
            for (std::uint32_t output = start; output < end; ++output) {
                if (left < middle &&
                    (right >= end ||
                     y_sort_comes_before(
                         state, (*source)[left], (*source)[right]))) {
                    (*target)[output] = (*source)[left++];
                } else {
                    (*target)[output] = (*source)[right++];
                }
            }
        }
        std::swap(source, target);
    }
    if (source != &state.permutation) {
        for (std::uint32_t index = 0u; index < count; ++index) {
            state.permutation[index] = (*source)[index];
        }
    }
    for (std::uint32_t draw_index = 0u; draw_index < count; ++draw_index) {
        state.inverse_permutation[state.permutation[draw_index]] =
            draw_index;
    }
    state.sort_dirty = false;
}

void mark_y_sort_packed_dirty(YSortState& state, std::uint32_t draw_index) {
    if (state.dirty_min >= state.dirty_max) {
        state.dirty_min = draw_index;
        state.dirty_max = draw_index + 1u;
    } else {
        state.dirty_min = std::min(state.dirty_min, draw_index);
        state.dirty_max = std::max(state.dirty_max, draw_index + 1u);
    }
}

// observeDirty: a changed Y key invalidates the order; every other change
// maps its logical slots through the inverse permutation into the packed
// draw slots that have to be refreshed.
void observe_y_sort_dirty(
    Sprite2DLayerRecord& layer,
    std::uint32_t lo,
    std::uint32_t hi) {
    YSortState* state = y_sort_state(layer);
    if (!state) return;
    sync_y_sort_count(layer, *state);
    const std::uint32_t end = std::min(hi, layer.count);
    for (std::uint32_t index = lo; index < end; ++index) {
        const double key = y_sort_key_at(layer, *state, index);
        if (!y_sort_same_key(key, state->keys[index])) {
            state->keys[index] = key;
            state->sort_dirty = true;
            state->full_upload = true;
        } else if (!state->full_upload) {
            mark_y_sort_packed_dirty(
                *state, state->inverse_permutation[index]);
        }
    }
}

void observe_y_sort_add(
    Sprite2DLayerRecord& layer,
    std::uint32_t index) {
    YSortState* state = y_sort_state(layer);
    if (!state) return;
    ensure_y_sort_storage(layer, *state);
    state->biases[index] = state->default_bias;
    state->serials[index] = allocate_y_sort_serial(*state);
    state->keys[index] = y_sort_key_at(layer, *state, index);
    state->active_count = layer.count;
    state->sort_dirty = true;
    state->full_upload = true;
}

// observeRemove: the swap-remove moves the bias, serial and cached key with
// the sprite the layer moved, which is what keeps an equal-key tie in its
// original insertion order across an unrelated removal.
void observe_y_sort_remove(
    Sprite2DLayerRecord& layer,
    std::uint32_t index,
    std::uint32_t last) {
    YSortState* state = y_sort_state(layer);
    if (!state) return;
    if (index != last) {
        state->biases[index] = state->biases[last];
        state->serials[index] = state->serials[last];
        state->keys[index] = state->keys[last];
    }
    state->biases[last] = 0.0;
    state->serials[last] = 0.0;
    state->keys[last] = 0.0;
    state->active_count = layer.count;
    state->sort_dirty = true;
    state->full_upload = true;
}

// observeClear: the active metadata goes, the allocation and the next
// insertion serial stay.
void observe_y_sort_clear(
    Sprite2DLayerRecord& layer,
    std::uint32_t previous_count) {
    YSortState* state = y_sort_state(layer);
    if (!state) return;
    const auto end = static_cast<std::ptrdiff_t>(previous_count);
    std::fill(state->biases.begin(), state->biases.begin() + end, 0.0);
    std::fill(state->serials.begin(), state->serials.begin() + end, 0.0);
    std::fill(state->keys.begin(), state->keys.begin() + end, 0.0);
    state->active_count = 0u;
    state->sort_dirty = true;
    state->full_upload = true;
    state->dirty_min = 0u;
    state->dirty_max = 0u;
}

// packRange: copy the active records into the packed buffer in draw order,
// lane by lane into reused storage.
void pack_y_sort_range(
    const Sprite2DLayerRecord& layer,
    YSortState& state,
    std::uint32_t lo,
    std::uint32_t hi) {
    const std::size_t stride = layer.instance_floats_per_sprite;
    for (std::uint32_t draw_index = lo; draw_index < hi; ++draw_index) {
        const std::size_t source_base =
            static_cast<std::size_t>(state.permutation[draw_index]) *
            stride;
        const std::size_t target_base =
            static_cast<std::size_t>(draw_index) * stride;
        // The pin's own \`packRange\` writes lane by lane because JavaScript
        // has nothing else; the values are the same either way, and two
        // \`std::vector<float>\` subscripts the compiler cannot prove
        // non-aliasing would not collapse to a move on their own. This is
        // the innermost loop of the whole feature -- a full repack is what
        // any key change forces, and a moving sprite changes its key every
        // frame.
        std::copy_n(
            layer.instance_data.data() + source_base,
            stride,
            state.packed_instances.data() + target_base);
    }
}

/**
 * uploadSorted's staging half.
 *
 * The port's shared derivation has already said which LOGICAL rows moved
 * for this copy, so what is left is the pin's own: sort when the order went
 * stale, and either repack everything or refresh just the draw slots the
 * inverse permutation maps those rows onto. A consumer handed the whole
 * active prefix -- a fresh GPU buffer, or a second pass whose stamp
 * predates the shared reset -- repacks in full, which is what the pin's
 * uploadedVersion of -1 does.
 */
SpriteInstanceUpload stage_y_sort_upload(
    Sprite2DLayerRecord& layer,
    std::uint32_t dirty_begin,
    std::uint32_t dirty_end) {
    YSortState* state = y_sort_state(layer);
    // A layer that never enabled the extension takes its own canonical
    // rows back, which is uploadSorted returning undefined and letting
    // the ordinary upload run.
    if (!state) {
        return {layer.instance_data.data(), dirty_begin, dirty_end};
    }
    ensure_y_sorted(layer, *state);
    if (layer.count == 0u) {
        state->full_upload = false;
        state->dirty_min = 0u;
        state->dirty_max = 0u;
        return {state->packed_instances.data(), 0u, 0u};
    }
    std::uint32_t lo = layer.count;
    std::uint32_t hi = 0u;
    if (state->full_upload ||
        (dirty_begin == 0u && dirty_end >= layer.count)) {
        lo = 0u;
        hi = layer.count;
    } else {
        // The rows this copy was handed, mapped onto the draw slots that
        // answer for them and folded into the packed range the mutations
        // already widened.
        const std::uint32_t end = std::min(dirty_end, layer.count);
        for (std::uint32_t index = dirty_begin; index < end; ++index) {
            mark_y_sort_packed_dirty(
                *state, state->inverse_permutation[index]);
        }
        lo = state->dirty_min;
        hi = std::min(state->dirty_max, layer.count);
    }
    if (hi > lo) {
        pack_y_sort_range(layer, *state, lo, hi);
    }
    state->full_upload = false;
    state->dirty_min = 0u;
    state->dirty_max = 0u;
    return {state->packed_instances.data(), lo, hi};
}

// getDrawOrder: the picker asks for this before walking a layer, and the
// hook sorts the CPU permutation if a same-frame mutation left it stale
// without packing or touching the GPU. The layer is const because picking
// does not change it; the state behind its own pointer is not, which is
// exactly the pin's arrangement -- the order is derived state, and reading
// it is what settles it.
const std::uint32_t* y_sort_draw_order(
    const Sprite2DLayerRecord& layer) {
    YSortState* state = y_sort_state(layer);
    if (!state) return nullptr;
    ensure_y_sorted(layer, *state);
    return state->permutation.data();
}
`
            : "";
        const ySortEntryPoints = ySort
            ? `
// sprite-2d-y-sort.ts#enableSprite2DYSort. The support boundary is the
// pin's: a depth-hosted layer resolves overlap by per-sprite z and
// intervening geometry, which a CPU Y-order alone cannot describe.
Sprite2DLayerHandle enable_sprite_2d_y_sort(
    Engine& engine,
    Sprite2DLayerHandle layer_handle,
    double default_bias) {
    Sprite2DLayerRecord& layer =
        engine.sprite_layers[layer_handle.value];
    if (layer.depth_mode != Sprite2DDepthMode::none) {
        throw std::runtime_error(
            "enableSprite2DYSort requires a layer with depth == none.");
    }
    if (!std::isfinite(default_bias)) {
        throw std::runtime_error(
            "enableSprite2DYSort: defaultBias must be finite.");
    }
    // A valid repeated enable is idempotent and first-options-wins, so an
    // installed state is returned unchanged rather than reseeded.
    if (layer.y_sort) return layer_handle;
    const auto state = std::make_shared<YSortState>();
    state->default_bias = default_bias;
    state->capacity = layer.capacity;
    state->packed_stride = layer.instance_floats_per_sprite;
    state->permutation.assign(layer.capacity, 0u);
    state->inverse_permutation.assign(layer.capacity, 0u);
    state->merge_scratch.assign(layer.capacity, 0u);
    state->serials.assign(layer.capacity, 0.0);
    state->biases.assign(layer.capacity, 0.0);
    state->keys.assign(layer.capacity, 0.0);
    state->packed_instances.assign(
        static_cast<std::size_t>(layer.capacity) *
            layer.instance_floats_per_sprite,
        0.0f);
    state->active_count = layer.count;
    layer.y_sort = state;
    // Enabling an already populated layer assigns serials in its current
    // logical order, so what is on screen keeps the order it entered in.
    for (std::uint32_t index = 0u; index < layer.count; ++index) {
        state->biases[index] = default_bias;
        state->serials[index] = allocate_y_sort_serial(*state);
        state->keys[index] = y_sort_key_at(layer, *state, index);
    }
    // sprite-2d-y-sort-hook.ts: the one lazily registered hook, installed
    // from inside the enabler exactly as upstream installs it.
    engine.sprite_y_sort_hook.stage = stage_y_sort_upload;
    engine.sprite_y_sort_hook.draw_order = y_sort_draw_order;
    touch_sprite_instances(layer, 0u, layer.count);
    // Upstream hands back the state object. What a scene reads off it is a
    // live question about the layer the state is attached to, so the layer
    // is what travels here and every read is keyed by it.
    return layer_handle;
}

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
        engine.sprite_layers[layer_handle.value].y_sort);
}

// sprite-2d-handle-y-sort.ts#setSprite2DYSortHandleBias: resolve the
// handle's current logical slot, then set its finite ordering bias. Only
// a bias that actually moves the key invalidates the order.
void set_sprite_2d_y_sort_bias_id(
    Engine& engine,
    Sprite2DLayerHandle layer_handle,
    std::uint32_t sprite_id,
    double bias) {
    Sprite2DLayerRecord& layer =
        engine.sprite_layers[layer_handle.value];
    const std::uint32_t index = sprite_2d_slot_of(layer, sprite_id);
    if (index >= layer.count) {
        throw std::runtime_error(
            "setSprite2DYSortHandleBias: the handle is not alive.");
    }
    YSortState* state = y_sort_state(layer);
    if (!state) {
        throw std::runtime_error(
            "setSprite2DYSortBias: Y-sort is not enabled on this layer.");
    }
    if (!std::isfinite(bias)) {
        throw std::runtime_error(
            "setSprite2DYSortBias: bias must be finite.");
    }
    if (state->biases[index] == bias) return;
    state->biases[index] = bias;
    const double key = y_sort_key_at(layer, *state, index);
    if (!y_sort_same_key(key, state->keys[index])) {
        state->keys[index] = key;
        state->sort_dirty = true;
        state->full_upload = true;
        touch_sprite_instances(layer, index, index + 1u);
    }
}
`
            : "";

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
                (ySort ? ",enableSprite2DYSort,setSprite2DYSortHandleBias" : ""),
            header: `#pragma once

// ${this.context.provenance(pipelineModule, "buildSpriteLayerUbo")}
#include <bblite/runtime.hpp>

#include <array>
#include <cstdint>
#include <stdexcept>

namespace bbl::upstream {

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
inline constexpr std::size_t sprite_fx_ubo_bytes = ${fxUboBytes}u;

inline void build_sprite_fx_ubo(
    float time_seconds,
    const Vec4& params,
    std::array<float, sprite_fx_ubo_bytes / 4u>& ubo) {
    ubo[0] = time_seconds;
    ubo[1] = 0.0f;
    ubo[2] = 0.0f;
    ubo[3] = 0.0f;
    ubo[4] = params.x;
    ubo[5] = params.y;
    ubo[6] = params.z;
    ubo[7] = params.w;
}

inline constexpr std::array<SpriteInstanceAttribute, ${attributeRows.length}>
    sprite_instance_attributes{{
${attributeRows
    .map(
        (row) =>
            `        {${row.location}u, ${row.offsetBytes}u, ${row.floatCount}u},`,
    )
    .join("\n")}
    }};

// sprite-pipeline.ts: appended when \`hasDepth\` selects the scene-hosted
// layout. Slot 13 is one float at shader location 6.
inline constexpr SpriteInstanceAttribute sprite_depth_attribute{
    ${depthRow.location}u, ${depthRow.offsetBytes}u, ${depthRow.floatCount}u};

// sprite-2d-uvscroll.ts ensureWide: the uvOffset attribute the widened
// layout adds, at the byte offset the narrow stride ends on.
inline constexpr SpriteInstanceAttribute sprite_uvscroll_attribute{
    ${uvScrollRow.location}u, ${uvScrollRow.offsetBytes}u, ${uvScrollRow.floatCount}u};

inline constexpr std::uint32_t sprite_uvscroll_stride_bytes =
    ${(layout.pureInstanceFloats + this.uvScrollExtraFloats()) * 4}u;

inline constexpr std::uint32_t sprite_instance_stride_bytes =
    ${layout.pureInstanceFloats * 4}u;

inline constexpr std::uint32_t sprite_depth_instance_stride_bytes =
    ${layout.depthInstanceFloats * 4}u;

/**
 * The sixteen floats of the per-layer UBO, in the pinned order:
 *   [0..1] viewPos.xy  [2] viewScale  [3] viewRot
 *   [4..5] screenSize.xy  [6..7] pivot.xy
 *   [8..11] opacityMul.rgba  [12..15] aa (coverage gamma, unreached)
 *
 * Premultiplied sources scale RGB and A together for a correct fade;
 * straight alpha scales only A, because the blend stage already uses
 * source alpha as the colour factor.
 */
inline void build_sprite_layer_ubo(
    const Sprite2DLayerRecord& layer,
    float screen_width,
    float screen_height,
    std::array<float, 16>& ubo) {
    ubo[0] = layer.view.position_px.x;
    ubo[1] = layer.view.position_px.y;
    ubo[2] = layer.view.zoom;
    ubo[3] = layer.view.rotation;
    ubo[4] = screen_width;
    ubo[5] = screen_height;
    ubo[6] = layer.pivot.x;
    ubo[7] = layer.pivot.y;
    const float opacity = layer.opacity;
    if (layer.blend.premultiplied_opacity) {
        ubo[8] = opacity;
        ubo[9] = opacity;
        ubo[10] = opacity;
        ubo[11] = opacity;
    } else {
        ubo[8] = 1.0f;
        ubo[9] = 1.0f;
        ubo[10] = 1.0f;
        ubo[11] = opacity;
    }
}

} // namespace bbl::upstream

namespace bbl {

/**
 * sprite-blend.ts: each exported descriptor, as the factory scene code
 * reaches when it names that descriptor at a layer. A mode with no colour
 * blend is the pin's opaque replacement, which is blending disabled.
 */
${blendFactoriesCpp(blends, "sprite", "sprite-blend.ts")}
} // namespace bbl
`,
            source: `// ${provenance}
#include <bblite/pal.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
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

void populate_grid_sprite_atlas_frames(
    SpriteAtlasRecord& atlas,
    const GridSpriteAtlasOptions& options) {
    const double cell_w = options.cell_width_px;
    const double cell_h = options.cell_height_px;
    const double margin = options.margin_px;
    const double spacing = options.spacing_px;
    const double tw = static_cast<double>(atlas.width);
    const double th = static_cast<double>(atlas.height);
    const double columns = options.has_columns
        ? options.columns
        : std::max(1.0, std::floor(
              (tw - margin * 2.0 + spacing) / (cell_w + spacing)));
    const double rows = options.has_rows
        ? options.rows
        : std::max(1.0, std::floor(
              (th - margin * 2.0 + spacing) / (cell_h + spacing)));
    for (double r = 0.0; r < rows; r += 1.0) {
        for (double c = 0.0; c < columns; c += 1.0) {
            const double x = margin + c * (cell_w + spacing);
            const double y = margin + r * (cell_h + spacing);
            atlas.frames.push_back(SpriteFrame{
                Vec2{static_cast<float>(x / tw), static_cast<float>(y / th)},
                Vec2{static_cast<float>((x + cell_w) / tw), static_cast<float>((y + cell_h) / th)},
                Vec2{static_cast<float>(cell_w), static_cast<float>(cell_h)},
                options.pivot});
        }
    }
}

} // namespace

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
    engine.sprite_layers[layer_handle.value].shader_params = params;
}

// setSprite2DUvOffset: the two floats sit right after the base layout, and
// the first call is what enables the layout at all.
void set_sprite_2d_uv_offset(
    Engine& engine,
    Sprite2DLayerHandle layer_handle,
    double index,
    Vec2 uv_offset) {
    Sprite2DLayerRecord& layer =
        engine.sprite_layers[layer_handle.value];
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
    atlas.premultiplied_alpha = options.premultiplied_alpha;
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

    // createGridSpriteAtlas: row-major frames over a uniform grid.
    const double cell_w = static_cast<double>(options.grid_width_px);
    const double cell_h = static_cast<double>(options.grid_height_px);
${gridSpriteAtlasFramesCpp(this.context)}

${pushAtlasHandleCpp()}
}

SpriteAtlasHandle create_grid_sprite_atlas(
    Engine& engine,
    const FileTexture& texture,
    GridSpriteAtlasOptions options) {
    SpriteAtlasRecord atlas;
    pal::DecodedImage image =
        pal::decode_image(ts::ArrayBuffer(texture.data.bytes));
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
    atlas.premultiplied_alpha = options.premultiplied_alpha;
    atlas.mip_maps = texture.data.sampler.max_lod > 0.0f;
    atlas.sampler = texture.data.sampler;
    populate_grid_sprite_atlas_frames(atlas, options);
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
    atlas.premultiplied_alpha = options.premultiplied_alpha;
    atlas.mip_maps = texture.sampler.max_lod > 0.0f;
    atlas.sampler = texture.sampler;
    populate_grid_sprite_atlas_frames(atlas, options);
${pushAtlasHandleCpp()}
}

SpriteAtlasHandle create_grid_sprite_atlas(
    Engine& engine,
    SpriteRenderTextureHandle texture,
    GridSpriteAtlasOptions options) {
    const SpriteRenderTextureRecord& source =
        engine.sprite_render_textures[texture.value];
    SpriteAtlasRecord atlas;
    atlas.width = source.width;
    atlas.height = source.height;
    atlas.premultiplied_alpha = options.premultiplied_alpha;
    atlas.mip_maps = false;
    atlas.sampler.min_filter = TextureFilter::linear;
    atlas.sampler.mag_filter = TextureFilter::linear;
    atlas.sampler.mipmap_mode = TextureMipmapMode::nearest;
    atlas.sampler.address_u = TextureAddressMode::clamp;
    atlas.sampler.address_v = TextureAddressMode::clamp;
    atlas.sampler.max_lod = 0.0f;
    atlas.has_render_texture = true;
    atlas.render_texture = texture;
    populate_grid_sprite_atlas_frames(atlas, options);
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
    engine.sprite_render_textures[texture.value].disposed = true;
}

void set_sprite_renderer_target(
    Engine& engine,
    SpriteRendererHandle renderer,
    SpriteRenderTextureHandle target,
    bool has_target) {
    SpriteRendererRecord& record =
        engine.sprite_renderers[renderer.value];
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
        const std::uint32_t stride = source.src_stride_bytes == 0u
            ? source.width * 4u
            : source.src_stride_bytes;
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
        const std::uint32_t stride = source.src_stride_bytes == 0u
            ? source.width * 4u
            : source.src_stride_bytes;
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
        scene.engine->sprite_layers[layer_handle.value];
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
        engine.sprite_layers[layer_handle.value];
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
        engine.sprite_layers[layer_handle.value];
    const SpriteAtlasRecord& atlas =
        engine.sprite_atlases[layer.atlas.value];
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
        engine.sprite_layers[layer_handle.value];
    if (!(index_value >= 0.0) ||
        index_value >= static_cast<double>(layer.count)) {
        throw std::runtime_error(
            "updateSprite2DIndex: index out of range.");
    }
    const SpriteAtlasRecord& atlas =
        engine.sprite_atlases[layer.atlas.value];
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
        engine.sprite_layers[layer_handle.value];
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
        engine.sprite_layers[layer_handle.value];
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
        engine.sprite_layers[layer_handle.value];
    const std::uint32_t index =
        sprite_2d_slot_of(layer, sprite_id);
    if (index >= layer.count) {
        throw std::runtime_error(
            "setSprite2DFrameIndex: index out of range");
    }
    const SpriteAtlasRecord& atlas =
        engine.sprite_atlases[layer.atlas.value];
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
        engine.sprite_layers[layer_handle.value];
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
        engine.sprite_layers[layer_handle.value];
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
        engine.sprite_layers[layer_handle.value];
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
        std::move(props));
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
        if (engine.sprite_layers[layer.value].depth_mode !=
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
        engine.sprite_renderers[renderer.value];
    if (record.disposed) {
        throw std::runtime_error(
            "SpriteRenderer has been disposed.");
    }
    if (layer.value >= engine.sprite_layers.size()) {
        throw std::runtime_error(
            "SpriteRenderer received an unknown layer.");
    }
    if (engine.sprite_layers[layer.value].depth_mode !=
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
        engine.sprite_renderers[renderer.value];
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
        engine.sprite_renderers[renderer.value];
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
    std::function<void(float)> callback) {
    engine.sprite_renderers[renderer.value].before_update.push_back(
        std::move(callback));
}

} // namespace bbl
`,
        };
    }
}
