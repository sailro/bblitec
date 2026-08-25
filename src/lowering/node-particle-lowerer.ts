// The pinned functions that stand between a frozen particle buffer and the
// two families this port already renders: world-space billboards, and the
// pure-2D Sprite2D layers a SpriteRenderer draws with no scene at all.
//
// `createParticleBillboard` and `syncParticleBillboard` are small and their
// SHAPE is the contract, so they are folded from their own declarations
// rather than executed with the simulation: which atlas the pin derives from
// the system's texture and sprite sheet, which blend its numeric mode
// selects, and exactly which five props the sync writes per live particle.
// Each of those is asserted against the pinned source here, so a pin that
// changes any of them fails generation instead of baking over it.
//
// What the bake supplies is only the values: the particle columns, the
// texture the graph loaded and the mode the system block set.
import ts from "typescript";
import { floatLiteral } from "../cpp-literals.js";
import { LoweredSource, LoweringContext } from "./context.js";
import {
    blendFactorySymbol,
    nativeBlendFactor,
} from "./pinned-blend-table.js";
import {
    decodeAtlasImageCpp,
    gridSpriteAtlasFramesCpp,
    pushAtlasHandleCpp,
} from "./pinned-grid-atlas.js";
import {
    pinnedDefaultFlag,
    pinnedDefaultNumber,
    pinnedDefaultVec2,
} from "./pinned-material-defaults.js";
import { pixelsTextureOptionsCpp } from "../pinned-address-modes.js";
import type { NodeParticleSystemBake } from "../pinned-node-particle.js";
import type {
    CompileAsset,
    PixelsTextureSource,
} from "../compiler/types.js";

const billboardModule = "src/particle/particle-billboard.ts";
const blendModule = "src/particle/particle-blend.ts";
const sceneModule = "src/particle/particle-scene.ts";
const blendSceneModule = "src/particle/particle-billboard-scene.ts";
const sprite2dModule = "src/particle/particle-sprite-2d.ts";
const sprite2dBlendModule =
    "src/particle/particle-sprite-2d-blend-modes.ts";

/** One baked system, with the asset its texture packaged under. */
export interface NodeParticleSystemEmit {
    bake: NodeParticleSystemBake;
    /**
     * Whether this system's set reached the exact-blend chain
     * (`buildNodeParticleSetWithBlendModes` or the enabler over any
     * builder). It selects which mapping the blend takes: the plain
     * builder's three-arm `blendForMode`, or `createParticleBlend`'s five.
     */
    exactBlend: boolean;
    /** `assets/<output>` of the packaged texture, for a graph texture. */
    textureAsset: string;
    /**
     * The native expression for a texture SCENE CODE assigned, which is a
     * `createTexture2DFromPixels` and therefore carries the pixels loader's
     * own sampler rather than `loadTexture2D`'s. The atlas is built from
     * that texture, exactly as `createGridSpriteAtlas` builds it from the
     * `Texture2D` the pin was handed.
     */
    texturePixels?: PixelsTextureSource;
    /**
     * The asset record the caller registers and materializes. The bake
     * builds it because only the pin knows the URL it resolved, and the
     * caller owns the manifest it belongs to.
     */
    asset?: CompileAsset;
}

/**
 * One registrar call, as the systems it actually walked.
 *
 * A set's system list is the graph's answer and `systems.push` can add one
 * built elsewhere, so the membership is the bake's observation rather than
 * a set index matched again at run time. `registerNodeParticleSet` needs
 * nothing else; the pure-2D call adds its own mapping below.
 */
export interface NodeParticleRegistrationEmit {
    systems: ReadonlyArray<{ set: number; system: number }>;
}

/**
 * One `registerNodeParticleSet2D*` call: the same walked systems, plus the
 * mapping constants, which unlike the system list are the scene's own.
 */
export interface NodeParticleSprite2DEmit
    extends NodeParticleRegistrationEmit {
    exact: boolean;
    pixelsPerUnit: number;
    originPx: readonly [number, number];
    invertY: boolean;
    opacity?: number;
    visible?: boolean;
    order?: number;
}

/**
 * The `set:system` key a baked system is looked up by.
 *
 * A system carries the pair it was BUILT as, and both registrars report the
 * pairs they walked, so every membership question in the family is one set
 * lookup on this key — here rather than spelled out at each of them.
 */
export function nodeParticleKey(entry: {
    set: number;
    system: number;
}): string {
    return `${entry.set}:${entry.system}`;
}

/** Every system a list of registrations or bindings walked. */
export function expandedSystems(
    bindings: readonly NodeParticleRegistrationEmit[],
): Set<string> {
    return new Set(
        bindings.flatMap((binding) => binding.systems.map(nodeParticleKey)),
    );
}

/**
 * Lowers the pinned particle-to-billboard bridge.
 *
 * The reached slice is a frozen system: `createParticleBillboard` over a
 * texture the graph loaded, `syncParticleBillboard` once, and the facing
 * billboard system the scene adds. A live system -- one the pin animates
 * from `scene._beforeRender` -- is refused at its call site instead.
 */
export class NodeParticleLowerer {
    public constructor(private readonly context: LoweringContext) {}

    // -----------------------------------------------------------------
    // Pinned contracts
    // -----------------------------------------------------------------

    /**
     * A three-arm `blendForMode`, as the C++ the mapping is.
     *
     * The family owns TWO of these — `particle-billboard.ts` maps the same
     * three numbers onto billboard descriptors and `particle-sprite-2d.ts`
     * onto the 2D ones, whose alpha factors differ — so each is read from
     * its own declaration and neither is restated here. A pin that adds a
     * fourth arm fails in whichever module grew it.
     */
    private blendForModeCpp(
        module: string,
        family: "billboard" | "sprite",
        cppName: string,
        label: string,
    ): string {
        const { file, declaration } = this.context.functionDeclaration(
            module,
            "blendForMode",
        );
        const constant = (name: string): number =>
            this.context.numericValue(
                this.context.variableInitializer(file, name),
                file,
            );
        const returns = this.context
            .findNodes(declaration.body!, ts.isReturnStatement)
            .map((statement) => statement.expression);
        if (returns.length !== 3) {
            this.context.contractError(
                declaration,
                `${label} changed; expected three returns.`,
            );
        }
        const prefix = family === "billboard" ? "billboardBlend" : "spriteBlend";
        const arms: ReadonlyArray<readonly [string, number | null]> = [
            [`${prefix}Alpha`, constant("BLENDMODE_STANDARD")],
            [`${prefix}OneOne`, constant("BLENDMODE_ONEONE")],
            [`${prefix}Additive`, null],
        ];
        const lines = [
            `// ${module.split("/").pop()}#blendForMode.`,
            `SpriteBlendDescriptor ${cppName}(int mode) {`,
        ];
        for (const [index, [exportName, mode]] of arms.entries()) {
            this.context.assertExpressionShape(
                returns[index]!,
                exportName,
                `${label} arm ${index}`,
            );
            const factory = blendFactorySymbol(family, exportName);
            lines.push(
                mode === null
                    ? `    return ${factory}();`
                    : `    if (mode == ${mode}) return ${factory}();`,
            );
        }
        lines.push("}");
        return lines.join("\n");
    }

    /**
     * `createParticleBlend`, as the C++ the five-arm mapping is.
     *
     * This is the second mapping in the family and the exact one: the plain
     * builder's `blendForMode` names three public descriptors, while the
     * enabler resolves a private descriptor per mode -- including the two
     * Babylon.js modes the plain path degrades to Add. Both are read from
     * their own declarations rather than tabulated here, so a factor the pin
     * edits changes what we emit and a sixth arm refuses.
     */
    /**
     * How many render passes each serialized blend mode draws, read off the
     * pin's own arms.
     *
     * `createParticleBlend` carries the count as `createBlend`'s last
     * argument, so it is pinned data like the factors beside it — and the
     * same data decides which SHADER PROGRAMS a scene deploys. Reading it
     * once here is what keeps the two answers from drifting: a pin that
     * gave a third mode a second pass would otherwise emit correct C++
     * beside the wrong shader set.
     */
    public particlePassesByMode(): ReadonlyMap<number, number> {
        const { file, declaration } = this.context.functionDeclaration(
            blendModule,
            "createParticleBlend",
        );
        const passes = new Map<number, number>();
        for (const clause of this.context.findNodes(
            declaration.body!,
            ts.isCaseOrDefaultClause,
        )) {
            if (ts.isDefaultClause(clause)) continue;
            const returned = this.context.findNodes(
                clause,
                ts.isReturnStatement,
            )[0]?.expression;
            if (!returned || !ts.isCallExpression(returned)) {
                this.context.contractError(
                    clause,
                    "createParticleBlend's arms are createBlend calls.",
                );
            }
            const count = returned.arguments[5];
            passes.set(
                this.context.numericValue(clause.expression, file),
                count ? this.context.numericValue(count, file) : 0,
            );
        }
        return passes;
    }

    private particleBlendCpp(): string {
        const { file, declaration } = this.context.functionDeclaration(
            blendModule,
            "createParticleBlend",
        );
        const factory = this.context.functionDeclaration(
            blendModule,
            "createBlend",
        );
        // `createBlend` writes one add-operation state around the four
        // factors it is handed, so what varies per arm is exactly its
        // arguments; the shape around them is asserted once.
        const descriptor = this.context.findNodes(
            factory.declaration.body!,
            ts.isObjectLiteralExpression,
        )[0];
        if (!descriptor) {
            this.context.contractError(
                factory.declaration,
                "particle createBlend no longer returns a descriptor.",
            );
        }
        this.context.assertExpressionShape(
            this.context.propertyInitializer(descriptor, "_depthMode"),
            '"transparent"',
            "particle blend depth mode",
        );
        const state = this.context.propertyInitializer(
            descriptor,
            "_descriptor",
        );
        if (!ts.isObjectLiteralExpression(state)) {
            this.context.contractError(
                state,
                "particle createBlend's descriptor changed.",
            );
        }
        for (const side of ["color", "alpha"] as const) {
            const value = this.context.propertyInitializer(state, side);
            if (!ts.isObjectLiteralExpression(value)) {
                this.context.contractError(
                    value,
                    `particle createBlend's ${side} changed.`,
                );
            }
            this.context.assertExpressionShape(
                this.context.propertyInitializer(value, "srcFactor"),
                `${side}Src`,
                `particle blend ${side} source`,
            );
            this.context.assertExpressionShape(
                this.context.propertyInitializer(value, "dstFactor"),
                `${side}Dst`,
                `particle blend ${side} destination`,
            );
            this.context.assertExpressionShape(
                this.context.propertyInitializer(value, "operation"),
                '"add"',
                `particle blend ${side} operation`,
            );
        }
        const lines = [
            "// particle-blend.ts#createParticleBlend: the exact Babylon.js",
            "// particle blend for a serialized mode, with the pass count the",
            "// pin carries on the descriptor itself.",
            "SpriteBlendDescriptor create_particle_blend(int mode) {",
            "    SpriteBlendDescriptor blend;",
            "    blend.enabled = true;",
            "    blend.depth_mode = BillboardDepthMode::transparent;",
            "    blend.premultiplied_opacity = false;",
        ];
        let fallback: string | undefined;
        for (const clause of this.context.findNodes(
            declaration.body!,
            ts.isCaseOrDefaultClause,
        )) {
            const returned = this.context.findNodes(
                clause,
                ts.isReturnStatement,
            )[0]?.expression;
            if (
                !returned ||
                !ts.isCallExpression(returned) ||
                !ts.isIdentifier(returned.expression) ||
                returned.expression.text !== "createBlend"
            ) {
                this.context.contractError(
                    clause,
                    "createParticleBlend's arms are createBlend calls.",
                );
            }
            const [, colorSrc, colorDst, alphaSrc, alphaDst, passes] =
                returned.arguments;
            const factor = (
                expression: ts.Expression | undefined,
                what: string,
            ): string => {
                if (!expression) {
                    this.context.contractError(
                        returned,
                        `createParticleBlend arm is missing its ${what}.`,
                    );
                }
                return nativeBlendFactor(
                    this.context.stringValue(expression, file),
                );
            };
            const body = [
                `        blend.color.src = SpriteBlendFactor::${factor(colorSrc, "colour source")};`,
                `        blend.color.dst = SpriteBlendFactor::${factor(colorDst, "colour destination")};`,
                `        blend.alpha.src = SpriteBlendFactor::${factor(alphaSrc, "alpha source")};`,
                `        blend.alpha.dst = SpriteBlendFactor::${factor(alphaDst, "alpha destination")};`,
                `        blend.particle_passes = ${
                    passes
                        ? this.context.numericValue(passes, file)
                        : 0
                };`,
                "        return blend;",
            ].join("\n");
            if (ts.isDefaultClause(clause)) {
                fallback = body;
                continue;
            }
            const mode = this.context.numericValue(
                clause.expression,
                file,
            );
            lines.push(`    if (mode == ${mode}) {`, body, "    }");
        }
        if (fallback === undefined) {
            this.context.contractError(
                declaration,
                "createParticleBlend no longer has a default arm.",
            );
        }
        lines.push(fallback, "}");
        return lines.join("\n");
    }

    /**
     * `addFacingBillboardSystemWithParticleBlend`: the enabler's own rule for
     * which systems take the specialized path.
     *
     * Only the descriptor's `_particlePasses` decides it — a mode without one
     * delegates to the ordinary registrar — which is why the native record
     * carries the pass count rather than the mode.
     */
    private assertParticleBlendRegistrar(): void {
        const { declaration } = this.context.functionDeclaration(
            blendSceneModule,
            "addFacingBillboardSystemWithParticleBlend",
        );
        const guard = this.context.findNodes(
            declaration.body!,
            ts.isIfStatement,
        )[0];
        if (!guard) {
            this.context.contractError(
                declaration,
                "The particle blend registrar no longer forks on the " +
                    "descriptor's pass count.",
            );
        }
        this.context.assertExpressionShape(
            guard.expression,
            "!billboard.blendMode._particlePasses",
            "particle blend registrar fork",
        );
    }

    /**
     * `registerNodeParticleSet`'s own body, as the two calls it makes per
     * system plus the per-frame callback it appends.
     *
     * The callback is what the frozen bake has to answer for, and it does so
     * by measurement rather than by argument: the driver takes each
     * registered system's state, steps it once more, and reports whether
     * anything moved. `assertRegistrable` refuses when it did.
     */
    private assertRegistrationRules(): void {
        const { declaration } = this.context.functionDeclaration(
            sceneModule,
            "registerNodeParticleSet",
        );
        for (const name of [
            "createParticleBillboard",
            "startParticleSystem",
            "animateParticleSystem",
            "syncParticleBillboard",
        ]) {
            if (!this.context.hasCall(declaration, name)) {
                this.context.contractError(
                    declaration,
                    `registerNodeParticleSet no longer calls '${name}'.`,
                );
            }
        }
        // The default half of the shape comes from the table the intrinsic
        // reads, so the resolved `autoStart` and the pin's own fallback are
        // one value with one anchor.
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "autoStart"),
            `options.autoStart ?? ${
                pinnedDefaultFlag("nodeParticleAutoStart")
            }`,
            "registerNodeParticleSet autoStart",
        );
        // The registrar the pin picks per system: the enabler's, when one is
        // installed, and `addFacingBillboardSystem` otherwise. Both reach the
        // same generated add; which blend the system carries is what differs,
        // and that is decided where the system is built.
        const registrar = this.context.findNodes(
            declaration.body!,
            ts.isParenthesizedExpression,
        )[0];
        if (!registrar) {
            this.context.contractError(
                declaration,
                "registerNodeParticleSet no longer selects its registrar.",
            );
        }
        this.context.assertExpressionShape(
            registrar.expression,
            "system._registerBillboard ?? addFacingBillboardSystem",
            "registerNodeParticleSet registrar",
        );
    }

    /**
     * The pinned grid-atlas cell rule, stated once for the two factories
     * that both declare it: a sprite sheet's positive cell size wins,
     * otherwise the whole texture is one cell.
     */
    private assertAtlasCellRule(
        atlasOptions: ts.ObjectLiteralExpression,
        labelPrefix: string,
    ): void {
        this.context.assertExpressionShape(
            this.context.propertyInitializer(atlasOptions, "cellWidthPx"),
            "sheet && sheet.cellWidth > 0 ? sheet.cellWidth : texture.width",
            `${labelPrefix} cell width`,
        );
        this.context.assertExpressionShape(
            this.context.propertyInitializer(atlasOptions, "cellHeightPx"),
            "sheet && sheet.cellHeight > 0 ? sheet.cellHeight : texture.height",
            `${labelPrefix} cell height`,
        );
    }

    /**
     * `createParticleSprite2DBridge`'s own rules: the atlas it grids, and
     * the layer it makes.
     *
     * The mirror of `assertBillboardRules`, and needed for the same reason:
     * the bridge has its OWN cell rule and its OWN layer options, so a port
     * that reused the billboard's answers would keep agreeing only while the
     * two pinned expressions happened to match. Returns the pivot the layer
     * takes, which the generated registrar emits rather than restating.
     */
    private sprite2dBridgeRules(): readonly [number, number] {
        const { declaration } = this.context.functionDeclaration(
            sprite2dModule,
            "createParticleSprite2DBridge",
        );
        this.assertSprite2dDefaults(declaration);
        const call = (name: string): ts.CallExpression =>
            this.context.callExpression(declaration, name);
        const atlasOptions = call("createGridSpriteAtlas").arguments[1];
        if (!atlasOptions || !ts.isObjectLiteralExpression(atlasOptions)) {
            this.context.contractError(
                declaration,
                "The pure-2D bridge's atlas options changed.",
            );
        }
        // The same cell rule the billboard bridge states, which is what lets
        // one baked cell size serve both.
        this.assertAtlasCellRule(atlasOptions, "pure-2D bridge atlas");
        const layerOptions = call("createSprite2DLayer").arguments[1];
        if (!layerOptions || !ts.isObjectLiteralExpression(layerOptions)) {
            this.context.contractError(
                declaration,
                "The pure-2D bridge's layer options changed.",
            );
        }
        this.context.assertExpressionShape(
            this.context.propertyInitializer(layerOptions, "capacity"),
            "system.buffer.capacity",
            "pure-2D bridge layer capacity",
        );
        this.context.assertExpressionShape(
            this.context.propertyInitializer(layerOptions, "depth"),
            '"none"',
            "pure-2D bridge layer depth",
        );
        const pivot = this.context.unwrapExpression(
            this.context.propertyInitializer(layerOptions, "pivot"),
        );
        if (
            !ts.isArrayLiteralExpression(pivot) ||
            pivot.elements.length !== 2
        ) {
            this.context.contractError(
                pivot,
                "The pure-2D bridge's layer pivot changed.",
            );
        }
        const file = declaration.getSourceFile();
        return [
            this.context.numericValue(pivot.elements[0]!, file),
            this.context.numericValue(pivot.elements[1]!, file),
        ];
    }

    /**
     * The pure-2D bridge's mapping defaults, asserted against the table
     * the intrinsic resolves them from (`pinned-material-defaults.ts`).
     *
     * These `?? d` fallbacks never pass through a UBO writer's discard
     * site, so the anchor lives here, beside the family's other pinned
     * shapes: the default half of each expected shape is BUILT from the
     * table entry, which makes the intrinsic's resolved value and the
     * pin's own fallback one number with one guard.
     */
    private assertSprite2dDefaults(
        declaration: ts.FunctionDeclaration,
    ): void {
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "pixelsPerUnit"),
            `options.pixelsPerUnit ?? ${
                pinnedDefaultNumber("sprite2dPixelsPerUnit")
            }`,
            "pure-2D bridge pixelsPerUnit default",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "origin"),
            `options.originPx ?? [${
                pinnedDefaultVec2("sprite2dOriginPx").join(", ")
            }]`,
            "pure-2D bridge originPx default",
        );
        const returned = this.context
            .findNodes(declaration.body!, ts.isReturnStatement)
            .map((statement) => statement.expression)
            .find(
                (expression): expression is ts.ObjectLiteralExpression =>
                    expression !== undefined &&
                    ts.isObjectLiteralExpression(expression),
            );
        if (!returned) {
            this.context.contractError(
                declaration,
                "createParticleSprite2DBridge no longer returns its " +
                    "bridge record literal.",
            );
        }
        this.context.assertExpressionShape(
            this.context.propertyInitializer(returned, "invertY"),
            `options.invertY ?? ${pinnedDefaultFlag("sprite2dInvertY")}`,
            "pure-2D bridge invertY default",
        );
        const registrar = this.context.functionDeclaration(
            sprite2dModule,
            "registerNodeParticleSet2D",
        ).declaration;
        const autoStartShape = `options.autoStart ?? ${
            pinnedDefaultFlag("sprite2dAutoStart")
        }`;
        if (
            !this.context
                .findNodes(registrar.body!, ts.isIfStatement)
                .some((statement) =>
                    this.context.expressionMatchesShape(
                        statement.expression,
                        autoStartShape,
                    )
                )
        ) {
            this.context.contractError(
                registrar,
                "registerNodeParticleSet2D no longer gates its start on " +
                    `'${autoStartShape}'.`,
            );
        }
    }

    /**
     * The exact Sprite2D Multiply fragment, as the pin's own text.
     *
     * It is the billboard fragment with the layer's opacity in place of the
     * system's, read out of the module that owns it rather than restated,
     * so the sprite composer wraps the pin's body exactly as it wraps a
     * scene's.
     */
    public sprite2dMultiplyFragment(): string {
        const file = this.context.sourceFile(sprite2dBlendModule);
        return this.context.stringValue(
            this.context.variableInitializer(
                file,
                "MULTIPLY_FRAGMENT_WGSL",
            ),
            file,
        );
    }

    /**
     * The pure-2D sync's packed write, asserted term by term.
     *
     * The bridge writes the thirteen instance floats directly where the
     * billboard path calls the pin's own index writer, so what is checked
     * here is that those writes still mean what the generated
     * `add_sprite_2d_index` produces: the mapped position, the scaled size,
     * the frame's UVs, the signed rotation and the colour.
     */
    private assertSprite2dSyncRules(): void {
        const { declaration } = this.context.functionDeclaration(
            sprite2dModule,
            "syncParticleSprite2DBridge",
        );
        const assigned = (offset: number): ts.Expression => {
            const target =
                offset === 0 ? "data[base]" : `data[base + ${offset}]`;
            const found = this.context
                .findNodes(declaration.body!, ts.isBinaryExpression)
                .find(
                    (candidate) =>
                        candidate.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken &&
                        candidate.left
                            .getText()
                            .replace(/\s+/g, " ")
                            .trim() === target,
                );
            if (!found) {
                this.context.contractError(
                    declaration,
                    `The pure-2D bridge no longer writes ${target}.`,
                );
            }
            return found.right;
        };
        const expected: ReadonlyArray<readonly [number, string]> = [
            [0, "originX + buffer.posX[i]! * pixelsPerUnit"],
            [1, "originY + buffer.posY[i]! * pixelsPerUnit * ySign"],
            [2, "width"],
            [3, "height"],
            [4, "frame.uvMin[0]"],
            [5, "frame.uvMin[1]"],
            [6, "frame.uvMax[0]"],
            [7, "frame.uvMax[1]"],
            [8, "buffer.angle[i]! * ySign"],
            [9, "buffer.colorR[i]!"],
            [10, "buffer.colorG[i]!"],
            [11, "buffer.colorB[i]!"],
            [12, "buffer.colorA[i]!"],
        ];
        for (const [offset, shape] of expected) {
            this.context.assertExpressionShape(
                assigned(offset),
                shape,
                `pure-2D bridge instance float ${offset}`,
            );
        }
        const local = (name: string, shape: string): void => {
            this.context.assertExpressionShape(
                this.context.variableInitializer(declaration, name),
                shape,
                `pure-2D bridge ${name}`,
            );
        };
        local("width", "buffer.size[i]! * buffer.scaleX[i]! * pixelsPerUnit");
        local("height", "buffer.size[i]! * buffer.scaleY[i]! * pixelsPerUnit");
        local("ySign", "bridge.invertY ? -1 : 1");
    }

    /**
     * The exact bridge's own rules: which descriptor replaces the layer's,
     * and that a two-pass mode adds a second layer over the SAME atlas
     * rather than a second system.
     */
    private assertSprite2dExactRules(): void {
        const { declaration } = this.context.functionDeclaration(
            sprite2dBlendModule,
            "createParticleSprite2DBridgeWithBlendModes",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "blendMode"),
            "createParticleBlend(system.blendMode)",
            "exact pure-2D bridge blend",
        );
        for (const name of [
            "setLayerBlendMode",
            "attachMultiplyShader",
            "createAdditionalPass",
        ]) {
            if (!this.context.hasCall(declaration, name)) {
                this.context.contractError(
                    declaration,
                    `The exact pure-2D bridge no longer calls '${name}'.`,
                );
            }
        }
        const additional = this.context.functionDeclaration(
            sprite2dBlendModule,
            "createAdditionalPass",
        );
        this.context.assertExpressionShape(
            this.context.callExpression(
                additional.declaration,
                "createSprite2DLayer",
            ).arguments[0]!,
            "source.atlas",
            "exact pure-2D second pass atlas",
        );
    }

    /**
     * `createParticleBillboard`'s own rules: which cell size the atlas takes,
     * and what the facing system is built with.
     */
    private assertBillboardRules(): void {
        const { declaration } = this.context.functionDeclaration(
            billboardModule,
            "createParticleBillboard",
        );
        const call = (name: string): ts.CallExpression =>
            this.context.callExpression(declaration, name);
        const atlasOptions = call("createGridSpriteAtlas").arguments[1];
        if (!atlasOptions || !ts.isObjectLiteralExpression(atlasOptions)) {
            this.context.contractError(
                declaration,
                "createParticleBillboard's atlas options changed.",
            );
        }
        this.assertAtlasCellRule(atlasOptions, "particle atlas");
        const systemOptions =
            call("createFacingBillboardSystem").arguments[1];
        if (!systemOptions || !ts.isObjectLiteralExpression(systemOptions)) {
            this.context.contractError(
                declaration,
                "createParticleBillboard's system options changed.",
            );
        }
        if (systemOptions.properties.length !== 2) {
            this.context.contractError(
                systemOptions,
                "createParticleBillboard names " +
                    `${systemOptions.properties.length} system options; two ` +
                    "are lowered.",
            );
        }
        this.context.assertExpressionShape(
            this.context.propertyInitializer(systemOptions, "capacity"),
            "system.buffer.capacity",
            "particle billboard capacity",
        );
        this.context.assertExpressionShape(
            this.context.propertyInitializer(systemOptions, "blendMode"),
            "blendForMode(system.blendMode)",
            "particle billboard blend",
        );
    }

    /**
     * `syncParticleBillboard`'s five props, in the pin's own order.
     *
     * This is the whole reason the sync is folded rather than executed: the
     * bake carries the buffer, and which of its columns reach which prop --
     * `size * scaleX` into the world size, `angle` into the rotation, the
     * sprite sheet's cell into the frame -- is the pin's to say.
     */
    private assertSyncProps(): void {
        const { declaration } = this.context.functionDeclaration(
            billboardModule,
            "syncParticleBillboard",
        );
        const calls = this.context.findNodes(
            declaration.body!,
            ts.isCallExpression,
        );
        const write = calls.find(
            (candidate) =>
                ts.isIdentifier(candidate.expression) &&
                candidate.expression.text === "addBillboardSpriteIndex",
        );
        const props = write?.arguments[1];
        if (!props || !ts.isObjectLiteralExpression(props)) {
            this.context.contractError(
                declaration,
                "syncParticleBillboard no longer writes sprite props.",
            );
        }
        const expected: ReadonlyArray<readonly [string, string]> = [
            ["position", "[posX[i], posY[i], posZ[i]]"],
            ["sizeWorld", "[size[i] * scaleX[i], size[i] * scaleY[i]]"],
            ["color", "[colR[i], colG[i], colB[i], colA[i]]"],
            ["rotation", "angle[i]"],
            ["frame", "cellIndex ? cellIndex[i] : 0"],
        ];
        if (props.properties.length !== expected.length) {
            this.context.contractError(
                props,
                `syncParticleBillboard writes ${props.properties.length} ` +
                    `props; ${expected.length} are lowered.`,
            );
        }
        for (const [name, shape] of expected) {
            this.context.assertExpressionShape(
                this.context.propertyInitializer(props, name),
                shape,
                `syncParticleBillboard ${name}`,
            );
        }
        // The sync clears first, so a second call replaces rather than
        // appends -- which is what makes one frozen write the whole state.
        if (
            !calls.some(
                (candidate) =>
                    ts.isIdentifier(candidate.expression) &&
                    candidate.expression.text === "clearBillboardSprites",
            )
        ) {
            this.context.contractError(
                declaration,
                "syncParticleBillboard no longer clears before writing.",
            );
        }
    }
    // -----------------------------------------------------------------
    // Emission
    // -----------------------------------------------------------------

    public lower(
        systems: readonly NodeParticleSystemEmit[],
        sprite2d: readonly NodeParticleSprite2DEmit[] = [],
        registrations: readonly NodeParticleRegistrationEmit[] = [],
        /**
         * A preformatted " (reached from <file:line>)" suffix naming the
         * scene call site that pulled the particle family in, appended to
         * the bake refusals; empty when the caller has no site to name.
         */
        refusalSite = "",
    ): LoweredSource {
        this.assertBillboardRules();
        this.assertSyncProps();
        // Every registrar upstream installs a per-frame step: the scene
        // one appends to `scene._beforeRender`, and BOTH pure-2D ones push
        // onto `renderer._beforeUpdate`. The frozen fold has to answer for
        // all of them, so the hooked set is derived once here rather than
        // read off whichever call site happened to be checked.
        const hooked = expandedSystems(sprite2d);
        const registeredSystems = expandedSystems(registrations);
        const isRegistered = (entry: NodeParticleSystemEmit): boolean =>
            registeredSystems.has(nodeParticleKey(entry.bake));
        for (const entry of systems) {
            this.assertBakeable(
                entry,
                isRegistered(entry) || hooked.has(nodeParticleKey(entry.bake)),
                refusalSite,
            );
        }
        // The exact blend table is reached by either half: the billboard
        // enabler, or a pure-2D binding. EVERY pure-2D registrar references
        // it, because the emitted body carries both arms of its own
        // `bridge.exact ? …` fork, so the table's presence follows the
        // registrar rather than the binding's mode.
        const exact =
            systems.some((entry) => entry.exactBlend) ||
            sprite2d.length > 0;
        const registered = registrations.length > 0;
        if (exact) {
            this.assertParticleBlendRegistrar();
        }
        if (registered) {
            this.assertRegistrationRules();
        }
        const sprite2dPivot =
            sprite2d.length > 0
                ? this.sprite2dBridgeRules()
                : ([0, 0] as const);
        if (sprite2d.length > 0) {
            this.assertSprite2dSyncRules();
        }
        if (sprite2d.some((binding) => binding.exact)) {
            this.assertSprite2dExactRules();
        }
        // Which halves of the family this scene reaches. The two render
        // targets are exclusive per system, so a system a pure-2D binding
        // took draws no billboard — and a scene of nothing but bridges
        // compiles no billboard code at all.
        const billboard = systems.some(
            (entry) =>
                isRegistered(entry) || !hooked.has(nodeParticleKey(entry.bake)),
        );
        const provenance = this.context.provenance(
            billboardModule,
            "createParticleBillboard,syncParticleBillboard",
            "over a node-particle state baked at generation",
        );
        return {
            modulePath: billboardModule,
            symbolName: "createParticleBillboard,syncParticleBillboard",
            header: `#pragma once

// ${provenance}
#include <bblite/runtime.hpp>

namespace bbl::upstream {

${
    !billboard
        ? ""
        : `/**
 * The billboard createParticleBillboard builds for one frozen node-particle
 * system: the pin's grid atlas over the texture the graph loaded, at the
 * buffer's capacity, on the blend its mode selects.
 */
BillboardSystemHandle create_node_particle_billboard(
    Engine& engine,
    int set_index,
    int system_index);

/**
 * syncParticleBillboard over the baked buffer: one
 * addBillboardSpriteIndex per live particle, in buffer order.
 */
void sync_node_particle_billboard(
    Engine& engine,
    int set_index,
    int system_index,
    BillboardSystemHandle billboard);`
}
${
    !registered
        ? ""
        : `
/**
 * registerNodeParticleSet over a set the scene froze: one billboard per
 * system, in \`set.systems\` order, each synced once and added to the scene.
 *
 * The pin's per-frame callback animates and re-synchronizes, and both are
 * the identity here: generation measured a further step against the baked
 * state and refused the registration when anything moved.
 */
void register_node_particle_set(
    Engine& engine,
    Scene& scene,
    int request);
`
}
${
    sprite2d.length === 0
        ? ""
        : `
/**
 * registerNodeParticleSet2D over a set the scene froze: one bridge-owned
 * Sprite2D layer per system, packed from the baked columns and attached to
 * the renderer in the pin's own order. The exact binding adds the Multiply
 * fragment and, for mode 4, the second Add layer over the same atlas.
 */
void register_node_particle_set_2d(
    Engine& engine,
    SpriteRendererHandle renderer,
    int request);
`
}
}  // namespace bbl::upstream
`,
            source: `// ${provenance}
#include <bblite/pal.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/ts_runtime.hpp>
${
    billboard
        ? `#include <bblite/upstream/billboard_system.hpp>
`
        : ""
}${
    sprite2d.length === 0
        ? ""
        : `#include <bblite/upstream/sprite_layer.hpp>
`
}#include <bblite/upstream/node_particles.hpp>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <utility>
#include <vector>

namespace bbl::upstream {
namespace {

/** One live particle, as syncParticleBillboard reads it. */
struct BakedParticle {
    Vec3 position;
    Vec2 size_world;
    Vec4 color;
    float rotation;
    float frame;
};

struct BakedSystem {
    int set_index;
    int system_index;
    double capacity;
    int blend_mode;
    // Whether the set reached the enabler, which is what decides WHICH
    // mapping the mode takes -- upstream installs it per system rather than
    // reading the mode differently.
    bool exact_blend;
    const char* texture_asset;
    // createParticleBillboard's own cell rule, resolved: the sprite sheet's
    // cell size, or the texture's own.
    double cell_width_px;
    double cell_height_px;
    const BakedParticle* particles;
    std::size_t particle_count;
};

${
    billboard
        ? this.blendForModeCpp(
              billboardModule,
              "billboard",
              "blend_for_mode",
              "blendForMode",
          )
        : ""
}
${exact ? `
${this.particleBlendCpp()}
` : ""}${
    sprite2d.length === 0
        ? ""
        : `
${this.blendForModeCpp(
    sprite2dModule,
    "sprite",
    "sprite_2d_blend_for_mode",
    "the pure-2D blendForMode",
)}
`
}
/**
 * createGridSpriteAtlas over a loadTexture2D texture.
 *
 * The sampler is that loader's, not loadSpriteAtlas's: repeat addressing on
 * both axes, a mip chain, and the pin's maxAnisotropy rule -- all three
 * filters are linear here, so it asks for 4.
 */
SpriteAtlasHandle load_particle_atlas(
    Engine& engine,
    const std::string& path,
    double cell_w,
    double cell_h) {
${decodeAtlasImageCpp()}
    atlas.premultiplied_alpha = false;
    atlas.mip_maps = true;
    atlas.sampler.min_filter = TextureFilter::linear;
    atlas.sampler.mag_filter = TextureFilter::linear;
    atlas.sampler.mipmap_mode = TextureMipmapMode::linear;
    atlas.sampler.address_u = TextureAddressMode::repeat;
    atlas.sampler.address_v = TextureAddressMode::repeat;
    atlas.sampler.max_anisotropy = 4.0f;

${gridSpriteAtlasFramesCpp(this.context)}

${pushAtlasHandleCpp()}
}
${
    systems.some((entry) => entry.texturePixels)
        ? `
/**
 * The same grid over a texture SCENE CODE assigned.
 *
 * \`createGridSpriteAtlas\` is handed the \`Texture2D\` itself, so the atlas
 * rides whatever sampler that texture was created with --
 * \`createTexture2DFromPixels\` fixes nearest/clamp and builds no mip chain,
 * where \`loadTexture2D\` fixes linear/repeat and does. Nothing here decides
 * either: the record comes from the pin's own factory.
 */
SpriteAtlasHandle grid_atlas_from_pixels(
    Engine& engine,
    const PixelsTexture& texture,
    double cell_w,
    double cell_h) {
    SpriteAtlasRecord atlas;
    atlas.rgba = texture.rgba;
    atlas.width = texture.width;
    atlas.height = texture.height;
    atlas.premultiplied_alpha = false;
    atlas.mip_maps = false;
    atlas.sampler = texture.sampler;

${gridSpriteAtlasFramesCpp(this.context)}

${pushAtlasHandleCpp()}
}
`
        : ""
}
${systems.map(particleRowsCpp).join("\n\n")}

const BakedSystem baked_systems[] = {
${systems.map(bakedSystemRowCpp).join("\n")}
};
${
    !registered
        ? ""
        : `
/** Which systems one registerNodeParticleSet call walked, as it walked them. */
struct RegisteredSystem {
    int request;
    int set_index;
    int system_index;
};

const RegisteredSystem registered_systems[] = {
${registrations
    .flatMap((binding, request) =>
        binding.systems.map(
            (entry) => `    {${request}, ${entry.set}, ${entry.system}},`,
        ),
    )
    .join("\n")}
};
`
}
${
    sprite2d.length === 0
        ? ""
        : `
/** One pure-2D binding's mapping, per system it walks. */
struct Sprite2DBridge {
    int request;
    int set_index;
    int system_index;
    bool exact;
    double pixels_per_unit;
    double origin_x;
    double origin_y;
    double y_sign;
    float opacity;
    bool has_opacity;
    bool visible;
    bool has_visible;
    float order;
    bool has_order;
};

const Sprite2DBridge sprite_2d_bridges[] = {
${sprite2d
    .flatMap((binding, request) =>
        binding.systems.map((entry) => sprite2dBridgeRowCpp(binding, request, entry)),
    )
    .join("\n")}
};
`
}
const BakedSystem& baked(int set_index, int system_index) {
    for (const BakedSystem& candidate : baked_systems) {
        if (candidate.set_index == set_index &&
            candidate.system_index == system_index) {
            return candidate;
        }
    }
    throw std::runtime_error(
        "No baked node-particle system for this index.");
}

/**
 * The atlas createParticleBillboard grids, for one system.
 *
 * The pin is handed the Texture2D itself, so which loader produced it
 * decides the sampler and the mip chain; this dispatch is that fork, one arm
 * per system, resolved at generation because the assignment is static.
 */
SpriteAtlasHandle particle_atlas(
    Engine& engine,
    int set_index,
    int system_index) {
    const BakedSystem& system = baked(set_index, system_index);
${systems
    .filter((entry) => entry.texturePixels)
    .map(
        (entry) => `    if (set_index == ${entry.bake.set} &&
        system_index == ${entry.bake.system}) {
        return grid_atlas_from_pixels(
            engine,
            ${pixelsTextureCpp(entry.texturePixels!)},
            system.cell_width_px,
            system.cell_height_px);
    }`,
    )
    .join("\n")}
    return load_particle_atlas(
        engine,
        asset_path(system.texture_asset),
        system.cell_width_px,
        system.cell_height_px);
}

${
    sprite2d.length === 0
        ? ""
        : `
/**
 * syncParticleSprite2DBridge over the baked buffer: NPE world XY mapped into
 * Sprite2D pixels, one sprite per live particle, in buffer order. The
 * mapping's terms are asserted against the pin's own packed writes.
 */
void write_bridge_sprites(
    Engine& engine,
    Sprite2DLayerHandle layer,
    const Sprite2DBridge& bridge,
    const BakedSystem& system) {
    for (std::size_t i = 0; i < system.particle_count; ++i) {
        const BakedParticle& particle = system.particles[i];
        Sprite2DProps props;
        props.position_px = Vec2{
            static_cast<float>(
                bridge.origin_x +
                static_cast<double>(particle.position.x) *
                    bridge.pixels_per_unit),
            static_cast<float>(
                bridge.origin_y +
                static_cast<double>(particle.position.y) *
                    bridge.pixels_per_unit * bridge.y_sign)};
        props.size_px = Vec2{
            static_cast<float>(
                static_cast<double>(particle.size_world.x) *
                bridge.pixels_per_unit),
            static_cast<float>(
                static_cast<double>(particle.size_world.y) *
                bridge.pixels_per_unit)};
        props.has_size_px = true;
        props.frame = particle.frame;
        props.has_frame = true;
        props.rotation = static_cast<float>(
            static_cast<double>(particle.rotation) * bridge.y_sign);
        props.has_rotation = true;
        props.color = particle.color;
        props.has_color = true;
        add_sprite_2d_index(engine, layer, props);
    }
}
`
}
}  // namespace

${
    !billboard
        ? ""
        : `BillboardSystemHandle create_node_particle_billboard(
    Engine& engine,
    int set_index,
    int system_index) {
    const BakedSystem& system = baked(set_index, system_index);
    const SpriteAtlasHandle atlas =
        particle_atlas(engine, set_index, system_index);
    // The plain builder maps three modes and degrades the rest to Add; the
    // enabler resolves all five exactly. Which one this system took is the
    // set's own answer, recorded at its build.
    const SpriteBlendDescriptor blend = ${
        exact
            ? [
                  "system.exact_blend",
                  "        ? create_particle_blend(system.blend_mode)",
                  "        : blend_for_mode(system.blend_mode)",
              ].join("\n")
            : "blend_for_mode(system.blend_mode)"
    };
    // Every member named: the C++20 designators pair each value to its
    // field by name (a renamed or reordered header field fails here),
    // and the full spelling means no member rides a header default the
    // generated code never stated. The values beyond the capacity and
    // blend are the pinned factory defaults.
    BillboardSystemOptions options{
        .capacity = system.capacity,
        .blend = blend,
        .opacity = 1.0f,
        .visible = true,
        .alpha_cutoff = 0.0f,
        .has_alpha_cutoff = false,
        .custom_shader = false,
        .custom_textures = {},${
        exact
            ? [
                  "",
                  "        // The mode-4 wrapper's second pass, built where the",
                  "        // pin builds it: createParticleBlend(2) over the same",
                  "        // instances, with no custom shader. Read only when",
                  "        // the blend carries two passes.",
                  "        .add_pass_blend = blend.particle_passes == 2",
                  "            ? create_particle_blend(2)",
                  "            : SpriteBlendDescriptor{}};",
              ].join("\n")
            : [
                  "",
                  "        // The three-arm mapping never builds a two-pass",
                  "        // blend, so the second pass stays empty.",
                  "        .add_pass_blend = SpriteBlendDescriptor{}};",
              ].join("\n")
    }
    return create_billboard_system(
        engine,
        atlas,
        BillboardOrientation::facing,
        Vec3{0.0f, 0.0f, 0.0f},
        std::move(options));
}

void sync_node_particle_billboard(
    Engine& engine,
    int set_index,
    int system_index,
    BillboardSystemHandle billboard) {
    // createParticleBillboard hands this a system with no sprites, so the
    // pin's own clearBillboardSprites is the identity here; a second sync is
    // refused at generation.
    const BakedSystem& system = baked(set_index, system_index);
    for (std::size_t i = 0; i < system.particle_count; ++i) {
        const BakedParticle& particle = system.particles[i];
        BillboardSpriteProps props;
        props.position = particle.position;
        props.size_world = particle.size_world;
        props.has_size_world = true;
        props.frame = particle.frame;
        props.has_frame = true;
        props.rotation = particle.rotation;
        props.has_rotation = true;
        props.color = particle.color;
        props.has_color = true;
        add_billboard_sprite_index(engine, billboard, props);
    }
}`
}
${
    !registered
        ? ""
        : `
void register_node_particle_set(
    Engine& engine,
    Scene& scene,
    int request) {
    for (const RegisteredSystem& entry : registered_systems) {
        if (entry.request != request) continue;
        const BillboardSystemHandle billboard =
            create_node_particle_billboard(
                engine, entry.set_index, entry.system_index);
        sync_node_particle_billboard(
            engine, entry.set_index, entry.system_index, billboard);
        add_billboard_system(scene, billboard);
    }
}
`
}${
    sprite2d.length === 0
        ? ""
        : `
void register_node_particle_set_2d(
    Engine& engine,
    SpriteRendererHandle renderer,
    int request) {
    for (const Sprite2DBridge& bridge : sprite_2d_bridges) {
        if (bridge.request != request) continue;
        const BakedSystem& system =
            baked(bridge.set_index, bridge.system_index);
        const SpriteAtlasHandle atlas =
            particle_atlas(engine, bridge.set_index, bridge.system_index);
        Sprite2DLayerOptions options;
        options.capacity = static_cast<float>(system.capacity);
        // The bridge owns capacity, depth, blend and pivot; only the four
        // presentation fields come from the caller, and an unnamed one keeps
        // the layer factory's own default.
        options.blend_mode = bridge.exact
            ? create_particle_blend(system.blend_mode)
            : sprite_2d_blend_for_mode(system.blend_mode);
        if (bridge.has_opacity) options.opacity = bridge.opacity;
        if (bridge.has_visible) options.visible = bridge.visible;
        if (bridge.has_order) options.order = bridge.order;
        options.pivot = Vec2{${bakedFloatLiteral(sprite2dPivot[0])}, ${bakedFloatLiteral(sprite2dPivot[1])}};
        // Modes 3 and 4 draw the pin's own Multiply fragment on the primary
        // layer; mode 4's second layer keeps the stock one.
        options.custom_shader = options.blend_mode.particle_passes >= 1;
        const Sprite2DLayerHandle layer =
            create_sprite_2d_layer(engine, atlas, options);
        write_bridge_sprites(engine, layer, bridge, system);
        add_sprite_renderer_layer(engine, renderer, layer);
        if (options.blend_mode.particle_passes != 2) continue;
        Sprite2DLayerOptions add = options;
        add.blend_mode = create_particle_blend(2);
        add.custom_shader = false;
        const Sprite2DLayerHandle second =
            create_sprite_2d_layer(engine, atlas, add);
        write_bridge_sprites(engine, second, bridge, system);
        add_sprite_renderer_layer(engine, renderer, second);
    }
}
`
}
}  // namespace bbl::upstream
`,
        };
    }

    /**
     * Refuse a bake the emitted loader cannot serve.
     *
     * Both cases are the pin's own: `createParticleBillboard` throws without
     * a texture, and a texture block asking for a flipped upload reaches an
     * arm the sprite atlas record does not carry.
     */
    private assertBakeable(
        entry: NodeParticleSystemEmit,
        perFrameStep: boolean,
        refusalSite: string,
    ): void {
        // A registered system carries the pin's own per-frame callback,
        // which animates and re-synchronizes. Both are the identity only for
        // a system the scene froze, and that is measured rather than argued:
        // the driver stepped this system once more and compared every column
        // the sync reads.
        if (perFrameStep) {
            if (entry.bake.updateSpeed !== 0) {
                throw new Error(
                    "A registered node-particle set animates its systems " +
                        "every frame; this one's updateSpeed is " +
                        `${entry.bake.updateSpeed}, so the frozen bake is ` +
                        `not the image it renders.${refusalSite}`,
                );
            }
            if (!entry.bake.stepIsIdentity) {
                throw new Error(
                    "A registration's per-frame step moved this system's " +
                        "particles at generation, so one frozen state " +
                        `cannot answer for it.${refusalSite}`,
                );
            }
        }
        if (!entry.bake.texture) {
            throw new Error(
                "A node-particle system reached createParticleBillboard " +
                    `without a texture; the pin throws there.${refusalSite}`,
            );
        }
        if (entry.bake.texture.invertY) {
            throw new Error(
                "A node-particle texture block asked for a flipped upload; " +
                    `the reached atlas path uploads unflipped.${refusalSite}`,
            );
        }
    }
}

/**
 * The `createTexture2DFromPixels` call a texture assignment named, written
 * against the atlas builder's own engine parameter.
 *
 * The sampler literals travel as the pin's own spellings and are mapped
 * through the shared name-to-enumerator tables here, so a mode with no row
 * fails generation naming it -- the same rule the call site applies.
 */
function pixelsTextureCpp(texture: PixelsTextureSource): string {
    const options = pixelsTextureOptionsCpp(texture.options, (message) => {
        throw new Error(message);
    });
    return (
        "create_texture_2d_from_pixels(\n                engine," +
        `\n                asset_path(${texture.asset}),` +
        `\n                ${texture.width}.0,` +
        `\n                ${texture.height}.0` +
        (options ? `,\n                ${options}` : "") +
        ")"
    );
}

/**
 * A baked value as the shared C++ float literal, refusing a non-finite one
 * by name: the node-particle bake is the only producer here, and a NaN or
 * Infinity in its columns is a broken bake, not a value to silently emit
 * as `0.0f`.
 */
function bakedFloatLiteral(value: number): string {
    if (!Number.isFinite(value)) {
        throw new Error(
            `The node-particle bake produced a non-finite float ` +
                `(${value}); the frozen particle table cannot carry it.`,
        );
    }
    return floatLiteral(value);
}

/** One system's live particles, as the table the sync walks. */
function particleRowsCpp(
    entry: NodeParticleSystemEmit,
    index: number,
): string {
    const { bake } = entry;
    const rows: string[] = [];
    for (let i = 0; i < bake.alive; i += 1) {
        rows.push(
            `    {{${bakedFloatLiteral(bake.positions[i * 3]!)}, ` +
                `${bakedFloatLiteral(bake.positions[i * 3 + 1]!)}, ` +
                `${bakedFloatLiteral(bake.positions[i * 3 + 2]!)}}, ` +
                `{${bakedFloatLiteral(bake.sizes[i * 2]!)}, ` +
                `${bakedFloatLiteral(bake.sizes[i * 2 + 1]!)}}, ` +
                `{${bakedFloatLiteral(bake.colors[i * 4]!)}, ` +
                `${bakedFloatLiteral(bake.colors[i * 4 + 1]!)}, ` +
                `${bakedFloatLiteral(bake.colors[i * 4 + 2]!)}, ` +
                `${bakedFloatLiteral(bake.colors[i * 4 + 3]!)}}, ` +
                `${bakedFloatLiteral(bake.rotations[i]!)}, ` +
                `${bakedFloatLiteral(bake.frames ? bake.frames[i]! : 0)}},`,
        );
    }
    if (rows.length === 0) rows.push("    {}");
    const body = rows.join("\n");
    return `const BakedParticle particles_${index}[] = {\n${body}\n};`;
}

/** One row of the pure-2D bridge table, per system a binding walks. */
function sprite2dBridgeRowCpp(
    binding: NodeParticleSprite2DEmit,
    request: number,
    entry: { set: number; system: number },
): string {
    const optional = (value: number | boolean | undefined, fallback: string) =>
        value === undefined
            ? `${fallback}, false`
            : `${typeof value === "boolean" ? value : bakedFloatLiteral(value)}, true`;
    return (
        `    {${request}, ${entry.set}, ${entry.system}, ${binding.exact}, ` +
        `${binding.pixelsPerUnit}, ${binding.originPx[0]}, ` +
        `${binding.originPx[1]}, ${binding.invertY ? -1 : 1}, ` +
        `${optional(binding.opacity, "0.0f")}, ` +
        `${optional(binding.visible, "false")}, ` +
        `${optional(binding.order, "0.0f")}},`
    );
}

/** One row of the table `baked()` looks a (set, system) pair up in. */
function bakedSystemRowCpp(
    entry: NodeParticleSystemEmit,
    index: number,
): string {
    const { bake, textureAsset } = entry;
    const sheet = bake.spriteSheet;
    const cellWidth =
        sheet && sheet.cellWidth > 0 ? sheet.cellWidth : bake.texture!.width;
    const cellHeight =
        sheet && sheet.cellHeight > 0
            ? sheet.cellHeight
            : bake.texture!.height;
    return (
        `    {${bake.set}, ${bake.system}, ${bake.capacity}, ` +
        `${bake.blendMode}, ${entry.exactBlend}, ` +
        `${JSON.stringify(textureAsset)}, ` +
        `${cellWidth}, ${cellHeight}, particles_${index}, ${bake.alive}},`
    );
}
