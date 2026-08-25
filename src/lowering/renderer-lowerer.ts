import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { RendererFidelityManifest } from "../fidelity.js";
import type {
    CompiledShaderProgram,
    GeometryOutputTaskManifest,
} from "../compiler.js";
import { emitNativeWgslProgram } from "../shader-wgsl-emitter.js";
import {
    pinnedShaderDefineLines,
    shaderPipelineModule,
} from "./pinned-shader-defines.js";
import {
    lowerWgslShaderProgram,
    shaderSystemMatrixEnumerator,
    shaderSystemMatrixTable,
} from "../shader-ir.js";
import type {
    ShaderProgramReflection,
    ShaderSystemMatrix,
} from "../shader-ir.js";
import {
    composeStandaloneWgsl,
    predeclaredShaderProgram,
    shaderMaterialPrograms,
} from "../shader-material-programs.js";
import {
    gridFragmentWgsl,
    gridVertexWgsl,
} from "../shader-builtins-grid.js";
import {
    blitFragmentWgsl,
    blitVertexWgsl,
    depthOnlyFragmentWgsl,
    diagnosticClusterFragmentWgsl,
    diagnosticIdFragmentWgsl,
    fogFactorWgsl,
    imageProcessingFragmentWgsl,
    imageProcessingMultisampledFragmentWgsl,
} from "../shader-builtins-utility.js";
import {
    backgroundGroundFragmentWgsl,
    backgroundSkyboxFragmentWgsl,
    readPinnedBackgroundGroundSource,
    readPinnedBackgroundSkyboxSource,
    readPinnedDitherWgsl,
    solidSkyboxFragmentWgsl,
    solidSkyboxVertexWgsl,
} from "../shader-builtins-background.js";
import type { PinnedSolidSkyboxSource } from "../shader-builtins-background.js";
import { materialVertexWgsl } from "../shader-builtins-standard.js";
import {
    extractPackagedStringLiteral,
    extractPackagedTemplateLiteral,
    extractWgslFunction,
    readPinnedLibraryModule,
    splitWgslStatements,
} from "../pinned-shader-composer.js";
import { LoweredSource, LoweringContext } from "./context.js";
import {
    lowerMat4MultiplyWriterCpp,
    lowerPinnedFunction,
} from "./pinned-function-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

/**
 * The pinned fog falloff's own component reads, paired with the scene field
 * each one packs from. `WGSL_FOG` names its inputs — `let fogMode =
 * scene.vFogInfos.x;` and so on — so the {mode, start, end, density} order of
 * every native `fogInfos` vec4 is the pin's contract, not a convention. The
 * table is the single source for both halves: the assert requires the pin to
 * still read each name from its component, and the packing emission below
 * writes the stores in table order, so a pin retune fails generation instead
 * of shading with a silently transposed vec4.
 */
const pinnedFogInfoComponentReads: ReadonlyArray<
    readonly [component: string, pinnedName: string, packedStore: string]
> = [
    ["x", "fogMode", "scene.fog_mode"],
    ["y", "fogStart", "scene.fog_start"],
    ["z", "fogEnd", "scene.fog_end"],
    ["w", "fogDensity", "scene.fog_density"],
];

function assertPinnedFogInfosOrder(): void {
    const fog = extractPackagedTemplateLiteral(
        readPinnedLibraryModule("shader/wgsl-fog.js"),
        "WGSL_FOG",
    );
    for (const [component, pinnedName] of pinnedFogInfoComponentReads) {
        if (
            !fog.includes(
                `let ${pinnedName} = scene.vFogInfos.${component};`,
            )
        ) {
            throw new Error(
                `Pinned WGSL_FOG no longer reads ${pinnedName} from vFogInfos.${component}; retune the native fogInfos packing to the pin's component order.`,
            );
        }
    }
}

/** The `fog_infos` initializer list, one pinned component read per store. */
function pinnedFogInfosPacking(): string {
    assertPinnedFogInfosOrder();
    return pinnedFogInfoComponentReads
        .map(([, , packedStore]) => `        ${packedStore},\n`)
        .join("");
}

/**
 * Applies a documented re-homing map, requiring every entry to occur so a
 * pinned rename fails generation instead of leaving a dangling reference.
 */
function rehomePinned(
    source: string,
    replacements: ReadonlyArray<readonly [string, string]>,
    what: string,
): string {
    let text = source;
    for (const [from, to] of replacements) {
        if (!text.includes(from)) {
            throw new Error(
                `Pinned Babylon Lite ${what} changed ('${from}' is gone).`,
            );
        }
        text = text.split(from).join(to);
    }
    return text;
}

/** The statement list of a packaged WGSL literal's `fn main` body. */
function pinnedEntryStatements(literal: string, what: string): string[] {
    const entry = extractWgslFunction(literal, "main");
    const open = entry.indexOf("{");
    const close = entry.lastIndexOf("}");
    if (open < 0 || close <= open) {
        throw new Error(`Pinned Babylon Lite ${what} has no entry body.`);
    }
    return splitWgslStatements(entry.slice(open + 1, close));
}

interface LiftedImageSkybox {
    /** Re-homed vertex statements, one per line at body indent. */
    vertexBody: string;
    /** Re-homed fragment statements, one per line at body indent. */
    fragmentBody: string;
}

/**
 * Lifts the cubemap skybox's two stages out of the packaged pin.
 *
 * `skybox-cubemap.ts` ships `skyVertSrc`/`skyFragSrc` as inlined string
 * literals (raw imports carry no source-map entry), so the statements are
 * taken from the packaged module text and re-homed onto the native binding
 * contract, each mapping required to occur. Three documented departures from
 * the pin, all forced by the native frame rather than chosen:
 *
 * - `mesh.world` drops out: the pinned skybox mesh carries an identity world
 *   (`build_image_skybox_plan` authors the cube around the origin exactly as
 *   the pinned `createBoxData` does), and the native vertex block is the
 *   64-byte view-projection both PALs already bind — Dawn sizes that bind
 *   group entry to 64 bytes explicitly, so the block cannot grow.
 * - `vFogDistance` moves across the stage boundary: the pin computes
 *   `(scene.view * worldPos).xyz` per vertex and interpolates it, but the
 *   vertex block above cannot carry `scene.view`, so the fragment evaluates
 *   the pin's own expression on the interpolated `vPositionW` instead — the
 *   same affine function of the same varying, evaluated after interpolation
 *   rather than before.
 * - The pin's unused `normal` vertex input is dropped: both PALs feed the
 *   pipeline a single position buffer, and the lift refuses to drop it the
 *   moment the pinned body starts reading it.
 */
function liftedImageSkyboxWgsl(): LiftedImageSkybox {
    const module = readPinnedLibraryModule(
        "material/standard/skybox-cubemap.js",
    );
    const vertexLiteral = extractPackagedStringLiteral(
        module,
        "skyVertSrc",
    );
    const fragmentLiteral = extractPackagedStringLiteral(
        module,
        "skyFragSrc",
    );
    const vertexContracts: ReadonlyArray<readonly [string, string]> = [
        ["struct e{world:mat4x4<f32>}", "skybox-cubemap mesh block"],
        [
            "@group(1) @binding(0) var<uniform> mesh:e;",
            "skybox-cubemap mesh binding",
        ],
        [
            "struct d{@builtin(position) clipPos:vec4<f32>,@location(0) vPositionW:vec3<f32>,@location(1) vPositionLocal:vec3<f32>,@location(2) vFogDistance:vec3<f32>}",
            "skybox-cubemap varying block",
        ],
        [
            "fn main(@location(0) c:vec3<f32>,@location(1) normal:vec3<f32>)->d",
            "skybox-cubemap vertex inputs",
        ],
    ];
    for (const [text, what] of vertexContracts) {
        if (!vertexLiteral.includes(text)) {
            throw new Error(`Pinned Babylon Lite ${what} changed.`);
        }
    }
    const fragmentContracts: ReadonlyArray<readonly [string, string]> = [
        [
            "@group(1) @binding(1) var c:texture_cube<f32>;",
            "skybox-cubemap texture binding",
        ],
        [
            "@group(1) @binding(2) var d:sampler;",
            "skybox-cubemap sampler binding",
        ],
        [
            "struct g{@location(0) vPositionW:vec3<f32>,@location(1) vPositionLocal:vec3<f32>,@location(2) vFogDistance:vec3<f32>}",
            "skybox-cubemap fragment inputs",
        ],
    ];
    for (const [text, what] of fragmentContracts) {
        if (!fragmentLiteral.includes(text)) {
            throw new Error(`Pinned Babylon Lite ${what} changed.`);
        }
    }

    const vertexStatements = pinnedEntryStatements(
        vertexLiteral,
        "skybox-cubemap vertex stage",
    );
    for (const statement of vertexStatements) {
        if (statement.includes("normal")) {
            throw new Error(
                "Pinned Babylon Lite skybox-cubemap vertex stage started reading its normal input; the native single-buffer pipeline can no longer drop it.",
            );
        }
    }
    const fogDistanceStatement = vertexStatements.find((statement) =>
        statement.startsWith("a.vFogDistance="),
    );
    if (!fogDistanceStatement) {
        throw new Error(
            "Pinned Babylon Lite skybox-cubemap fog distance varying changed.",
        );
    }
    // The pin's own right-hand side, re-homed for per-fragment evaluation:
    // `b` is the world-position vec4 in the pinned vertex, rebuilt here from
    // the interpolated varying that carries its xyz.
    const fogDistanceExpression = rehomePinned(
        fogDistanceStatement
            .slice("a.vFogDistance=".length)
            .replace(/;$/, ""),
        [
            ["scene.view", "uniforms.view"],
            ["*b)", "*vec4<f32>(b.vPositionW,1.0))"],
        ],
        "skybox-cubemap fog distance",
    );
    const vertexBody = rehomePinned(
        vertexStatements
            .filter((statement) => statement !== fogDistanceStatement)
            .map((statement) => `    ${statement}`)
            .join("\n"),
        [
            ["var a:d;", "var a: VertexOutput;"],
            ["mesh.world*vec4<f32>(c,1.0)", "vec4<f32>(c,1.0)"],
            ["scene.viewProjection", "uniforms.viewProjection"],
        ],
        "skybox-cubemap vertex stage",
    );

    const fragmentStatements = pinnedEntryStatements(
        fragmentLiteral,
        "skybox-cubemap fragment stage",
    );
    const fogBranchIndex = fragmentStatements.findIndex((statement) =>
        statement.startsWith("if"),
    );
    if (fogBranchIndex < 0) {
        throw new Error(
            "Pinned Babylon Lite skybox-cubemap fog branch changed.",
        );
    }
    const fragmentBody = rehomePinned(
        [
            ...fragmentStatements.slice(0, fogBranchIndex),
            `let vFogDistance=${fogDistanceExpression};`,
            ...fragmentStatements.slice(fogBranchIndex),
        ]
            .map((statement) => `    ${statement}`)
            .join("\n"),
        [
            ["scene.vFogInfos", "uniforms.fogInfos"],
            ["scene.vFogColor", "uniforms.fogColor"],
            ["calcFogFactor(b.vFogDistance)", "bblCalcFogFactor(vFogDistance)"],
        ],
        "skybox-cubemap fragment stage",
    );
    for (const [body, stage] of [
        [vertexBody, "vertex"],
        [fragmentBody, "fragment"],
    ] as const) {
        if (body.includes("scene.") || body.includes("mesh.")) {
            throw new Error(
                `Pinned Babylon Lite skybox-cubemap ${stage} stage carries an unmapped scene or mesh reference.`,
            );
        }
    }
    return { vertexBody, fragmentBody };
}

const renderTaskModule = "src/frame-graph/render-task.ts";
const pbrTemplateModule = "src/material/pbr/pbr-template.ts";
const pbrTemplateExtModule = "src/material/pbr/pbr-template-ext.ts";
const pbrHelperCoreModule = "src/material/node/blocks/pbr-mr-helper-core.ts";
const iblFragmentModule = "src/material/pbr/fragments/ibl-fragment.ts";
const iblSkyboxModule = "src/material/pbr/fragments/ibl-skybox-wgsl.ts";
const refractionModule =
    "src/material/pbr/fragments/refraction-rtt-fragment.ts";
const dispersionWgslModule =
    "src/material/pbr/fragments/refraction-dispersion-wgsl.ts";
const clearcoatFragmentModule =
    "src/material/pbr/fragments/clearcoat-fragment.ts";
const sheenFragmentModule =
    "src/material/pbr/fragments/sheen-fragment.ts";
const iridescenceFragmentModule =
    "src/material/pbr/fragments/iridescence-fragment.ts";
const clearcoatLoaderModule = "src/loader-gltf/gltf-ext-clearcoat.ts";
const sheenLoaderModule = "src/loader-gltf/gltf-ext-sheen.ts";
const iridescenceLoaderModule = "src/loader-gltf/gltf-ext-iridescence.ts";
const dielectricLoaderModule = "src/loader-gltf/gltf-ext-dielectric.ts";
const transmissionFrameGraphModule = "src/frame-graph/transmission.ts";
const sceneUniformsModule = "src/frame-graph/scene-uniforms-pack.ts";
const fogWgslModule = "src/shader/wgsl-fog.ts";
const skyboxCubemapModule =
    "src/material/standard/skybox-cubemap.ts";
const orthoMatrixModule = "src/math/mat4-ortho-lh-to-ref.ts";
const perspectiveMatrixModule = "src/math/mat4-perspective-lh-to-ref.ts";
const backgroundGroundModule = "src/material/pbr/background-ground.ts";
const backgroundDdsModule = "src/material/pbr/background-dds-skybox.ts";
const backgroundHdrModule = "src/material/pbr/background-hdr-skybox.ts";
const backgroundSolidModule =
    "src/material/pbr/background-solid-skybox.ts";
const rgbdDecodeModule = "src/loader-env/rgbd-decode.ts";
const surfaceModule = "src/engine/surface.ts";
const sceneUniformsSourceModule = "src/shader/scene-uniforms.ts";
const gridModule = "src/material/grid/grid-material.ts";

interface LoweredShader {
    output: string;
    data: string;
}

/** `as`/parenthesis/non-null unwrap for the pinned stamp walks. */
function unwrapStampExpression(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
        ts.isAsExpression(current) ||
        ts.isParenthesizedExpression(current) ||
        ts.isNonNullExpression(current)
    ) {
        current = current.expression;
    }
    return current;
}

/** The non-transparent `mesh.renderOrder ?? …` arms of one module. */
function opaqueOrderArmsOf(file: ts.SourceFile): number[] {
    const arms: number[] = [];
    const numeric = (expression: ts.Expression): number => {
        const node = unwrapStampExpression(expression);
        if (!ts.isNumericLiteral(node)) {
            throw new Error(
                `Pinned ${file.fileName} order stamp is not a ` +
                    `numeric constant: ${expression.getText(file)}.`,
            );
        }
        return Number(node.text);
    };
    // The enclosing renderable object's literal `isTransparent`, when
    // one exists — classifies the plain-numeric shader-material stamps.
    const literalTransparency = (
        node: ts.Node,
    ): boolean | undefined => {
        for (
            let current: ts.Node | undefined = node;
            current;
            current = current.parent
        ) {
            if (!ts.isObjectLiteralExpression(current)) continue;
            for (const property of current.properties) {
                if (
                    !ts.isPropertyAssignment(property) ||
                    !ts.isIdentifier(property.name) ||
                    property.name.text !== "isTransparent"
                ) {
                    continue;
                }
                const value = unwrapStampExpression(
                    property.initializer,
                );
                if (value.kind === ts.SyntaxKind.TrueKeyword) {
                    return true;
                }
                if (value.kind === ts.SyntaxKind.FalseKeyword) {
                    return false;
                }
                return undefined;
            }
        }
        return undefined;
    };
    const collectFallbacks = (root: ts.Expression): void => {
        const visit = (node: ts.Node): void => {
            ts.forEachChild(node, visit);
            if (
                !ts.isBinaryExpression(node) ||
                node.operatorToken.kind !==
                    ts.SyntaxKind.QuestionQuestionToken
            ) {
                return;
            }
            const read = unwrapStampExpression(node.left);
            if (
                !(ts.isPropertyAccessExpression(read) ||
                    ts.isPropertyAccessChain(read)) ||
                read.name.text !== "renderOrder"
            ) {
                throw new Error(
                    `Pinned ${file.fileName} order stamp no longer ` +
                        "substitutes mesh.renderOrder (the record " +
                        "transports none).",
                );
            }
            const fallback = unwrapStampExpression(node.right);
            if (ts.isConditionalExpression(fallback)) {
                // `transparent ? a : b` — the opaque arm is whenFalse;
                // both arms must be constants.
                numeric(fallback.whenTrue);
                arms.push(numeric(fallback.whenFalse));
                return;
            }
            const transparent = literalTransparency(node);
            if (transparent === undefined) {
                throw new Error(
                    `Pinned ${file.fileName} order stamp has no ` +
                        "conditional arm and no literal isTransparent " +
                        "sibling to classify it.",
                );
            }
            if (!transparent) {
                arms.push(numeric(fallback));
            }
        };
        visit(root);
    };
    const visit = (node: ts.Node): void => {
        ts.forEachChild(node, visit);
        if (
            ts.isPropertyAssignment(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "order"
        ) {
            collectFallbacks(node.initializer);
        }
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "order" &&
            node.initializer !== undefined
        ) {
            collectFallbacks(node.initializer);
        }
    };
    visit(file);
    return arms;
}

/**
 * The pinned per-family order stamps behind the adopted buildBindings
 * opaque sort: every renderable module that can reach the native draw
 * lists stamps `mesh.renderOrder ?? <arm>`, and the non-transparent
 * arms must agree on one constant for the pinned stable sort to be
 * the identity on the emitted opaque list. A missing substitution, a
 * numeric fallback with no literal `isTransparent` sibling, or arms
 * that disagree refuse generation — the moment the retired pipeline
 * grouping question has to be reopened.
 */
export function lowerOpaqueOrderStamp(
    files: readonly ts.SourceFile[],
): string {
    const opaqueArms: number[] = [];
    for (const file of files) {
        const arms = opaqueOrderArmsOf(file);
        if (arms.length === 0) {
            throw new Error(
                `Pinned ${file.fileName} no longer stamps an opaque ` +
                    "renderable order.",
            );
        }
        opaqueArms.push(...arms);
    }
    const first = opaqueArms[0]!;
    if (opaqueArms.some((arm) => arm !== first)) {
        throw new Error(
            "Pinned renderable modules no longer stamp one shared " +
                "opaque order; the adopted buildBindings sort is no " +
                "longer the identity on the emitted opaque list.",
        );
    }
    return String(first);
}

/**
 * The compiled scene-uniform WGSL per resolved module path. The pinned file
 * cannot change within a process, and `compiledSceneUniformsWgsl` is asked
 * for by every family that binds the scene block, so the read and the parse
 * happen once.
 */
const compiledSceneUniformsWgslCache = new Map<string, string>();

export class RendererLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerRenderPlan(options: {
        fog?: boolean;
        imageSkybox?: boolean;
        solidSkybox?: boolean;
        environmentRotation?: boolean;
        gpuInstancing?: boolean;
        punctualLights?: boolean;
        nodeVisibility?: boolean;
        orthographicCamera?: boolean;
        background?: boolean;
        shaderPrograms?: CompiledShaderProgram[];
    } = {}): LoweredSource {
        this.assertRenderPlanPins(options);
        this.assertPinnedTransparentSort();
        const reachedShaderPrograms =
            options.shaderPrograms ?? [];
        const { shaderVariantTable, shaderVariantEntries } =
            this.loweredShaderVariants(reachedShaderPrograms);
        // The camera matrix chain the source below emits comes from the
        // pinned writers themselves: the multiply and both projection
        // writers are translated whole from their own ASTs, and the view
        // transpose's emission is derived from the pinned store map. The
        // reverse-Z convention the projection rows carry is anchored
        // beside its clear-value half in `pinned-depth-state.ts`.
        this.assertPinnedDrawListRules();
        this.assertPinnedLightSlotPacking();
        this.assertPinnedAffectsMesh();
        const opaqueOrderStamp =
            this.provedOpaqueOrderStamp();
        // Emitted from the compiler's own table so the generated enum's
        // order and the enumerators the variant rows name cannot disagree.
        const systemMatrixEnumerators = shaderSystemMatrixTable
            .map(({ enumerator }) => "    " + enumerator + ",")
            .join("\n");
        const backgroundGeometry = this.pinnedBackgroundGeometry();
        const viewMatrixBody = this.pinnedViewMatrixBody();
        if (options.fog) {
            // PBR and Standard fog ride the PAL's pinned scene block; its
            // {mode, start, end, density} packing is the same WGSL_FOG
            // contract, asserted here so a pin retune fails generation.
            assertPinnedFogInfosOrder();
        }
        const instancingTrs = options.gpuInstancing
            ? this.pinnedTrsComposition()
            : {
                  halfAngleLocals: "",
                  quaternionProducts: "",
                  basisLocals: "",
                  basisStores: "",
              };
        // The projection writers, translated whole from their pinned
        // declarations. `near`/`far` are spelled `near_plane`/`far_plane`
        // because Windows headers define the bare names away.
        const perspectiveWriter = lowerPinnedFunction(
            this.context,
            perspectiveMatrixModule,
            "mat4PerspectiveLHToRef",
            [
                { pinned: "out", kind: "mat4", cpp: "out" },
                { pinned: "fov", kind: "number", cpp: "fov" },
                { pinned: "aspect", kind: "number", cpp: "aspect" },
                { pinned: "near", kind: "number", cpp: "near_plane" },
                { pinned: "far", kind: "number", cpp: "far_plane" },
            ],
            {
                cppName: "mat4_perspective_lh_to_ref",
                returns: "void",
                calls: pinnedNumericMathCalls(),
            },
        );
        const orthoWriter = options.orthographicCamera
            ? lowerPinnedFunction(
                  this.context,
                  orthoMatrixModule,
                  "mat4OrthoOffCenterLHToRef",
                  [
                      { pinned: "out", kind: "mat4", cpp: "out" },
                      { pinned: "left", kind: "number", cpp: "left" },
                      { pinned: "right", kind: "number", cpp: "right" },
                      { pinned: "bottom", kind: "number", cpp: "bottom" },
                      { pinned: "top", kind: "number", cpp: "top" },
                      { pinned: "near", kind: "number", cpp: "near_plane" },
                      { pinned: "far", kind: "number", cpp: "far_plane" },
                  ],
                  {
                      cppName: "mat4_ortho_off_center_lh_to_ref",
                      returns: "void",
                      calls: pinnedNumericMathCalls(),
                  },
              )
            : "";
        // Under multi-light the pinned lights block owns every light past
        // the primary slot, so the legacy capture block keeps its second
        // analytic slot empty there exactly as the retired uploader did.
        const secondAnalyticLightFill =
            options.punctualLights
                ? ""
                : `    if (scene.lights.size() > 1) {
        write_pbr_light(
            scene.lights[1],
            result.light_direction_2,
            result.light_color_2,
            result.ground_color_2);
    }
`;

        return {
            modulePath: renderTaskModule,
            symbolName: "buildBindings",
            header: this.renderPlanHeaderCpp(
                options,
                systemMatrixEnumerators,
            ),
            source: this.renderPlanSourceCpp(options, {
                viewMatrixBody,
                opaqueOrderStamp,
                shaderVariantTable,
                shaderVariantEntries,
                instancingTrs,
                secondAnalyticLightFill,
                backgroundGeometry,
                perspectiveWriter,
                orthoWriter,
                multiplyWriter: lowerMat4MultiplyWriterCpp(this.context),
            }),
        };
    }

    /**
     * The render-plan preconditions: the adopted render-task symbols must
     * still exist, GPU instancing requires its composed matrix pins, and
     * an orthographic scene refuses environment backgrounds.
     */
    private assertRenderPlanPins(options: {
        gpuInstancing?: boolean;
        orthographicCamera?: boolean;
        background?: boolean;
    }): void {
        for (const symbol of ["buildBindings", "sortTransparentBindings", "drawList"]) {
            this.context.functionDeclaration(
                renderTaskModule,
                symbol,
            );
        }
        if (options.gpuInstancing) {
            // The instance parent-world helper is translated from these
            // pinned modules; assert they still carry the composed symbols.
            // (mat4MultiplyInto needs no entry: the multiply writer
            // resolves its declaration on every plan.)
            this.context.functionDeclaration(
                "src/math/mat4-compose-into.ts",
                "mat4ComposeInto",
            );
            this.context.functionDeclaration(
                "src/math/quat-euler.ts",
                "eulerToQuat",
            );
            this.context.functionDeclaration(
                "src/scene/world-matrix-state.ts",
                "composeTrsLocalMatrix",
            );
        }
        if (options.orthographicCamera && options.background) {
            // Environment backgrounds build their own view-projection,
            // which still writes the perspective form; an orthographic
            // scene would draw its skybox or ground through a different
            // projection than its meshes.
            throw new Error(
                "Orthographic cameras are lowered for the scene projection only; environment skyboxes and grounds still build a perspective view-projection.",
            );
        }
    }

    /**
     * The adopted `sortTransparentBindings` contract: the view-space
     * depth stamp and the draw-order comparator, shape-asserted term for
     * term so the emitted sort stays the pin's.
     */
    private assertPinnedTransparentSort(): void {
        const { declaration: sortTransparentBindings } =
            this.context.functionDeclaration(
                renderTaskModule,
                "sortTransparentBindings",
            );
        const sortDistance = this.context.findNodes(
            sortTransparentBindings,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                this.context
                    .propertyPath(node.left)
                    ?.join(".") === "b._sortDistance",
        )[0];
        if (!sortDistance) {
            this.context.contractError(
                sortTransparentBindings,
                "Expected transparent depth assignment.",
            );
        }
        this.context.assertExpressionShape(
            sortDistance.right,
            "wc ? wc[0] * v[2] + wc[1] * v[6] + wc[2] * v[10] + v[14] : 0",
            "Transparent view-space depth",
        );
        const sortCall = this.context.findNodes(
            sortTransparentBindings,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(
                    node.expression,
                ) &&
                node.expression.name.text === "sort",
        )[0];
        const comparator = sortCall?.arguments[0];
        if (
            !comparator ||
            (!ts.isArrowFunction(comparator) &&
                !ts.isFunctionExpression(comparator)) ||
            ts.isBlock(comparator.body)
        ) {
            this.context.contractError(
                sortCall ?? sortTransparentBindings,
                "Expected transparent sort comparator.",
            );
        }
        this.context.assertExpressionShape(
            comparator.body,
            "b._sortDistance - a._sortDistance || a.renderable.order - b.renderable.order",
            "Transparent draw ordering",
        );
    }

    /**
     * The per-scene shader-variant metadata: pipeline state from the
     * pinned shader-pipeline mapping and the reflected per-stage uniform
     * blocks, projected once into the table the emitted
     * `shader_variants` array is rendered from.
     */
    private loweredShaderVariants(
        reachedShaderPrograms: readonly CompiledShaderProgram[],
    ) {
        const uniformComponentCount = (type: string): number =>
            type === "f32"
                ? 1
                : type === "vec2<f32>"
                    ? 2
                    : type === "vec3<f32>"
                        ? 3
                        : type === "vec4<f32>"
                            ? 4
                            : 0;
        const shaderVariantTable = reachedShaderPrograms.map(
            (program) => {
                const reflection =
                    lowerWgslShaderProgram(program).reflection;
                // Canonical custom-uniform value layout: declaration
                // order, sized by component count. The material record
                // stores this flat vector; per-stage gathers map it into
                // the reflected vec4-slot block layout.
                const valueOffsets = new Map<string, number>();
                let valueCount = 0;
                for (const signature of program.uniforms) {
                    const separator = signature.indexOf(":");
                    if (separator < 1) continue;
                    const memberName = signature.slice(0, separator);
                    const componentCount = uniformComponentCount(
                        signature.slice(separator + 1),
                    );
                    valueOffsets.set(memberName, valueCount);
                    valueCount += componentCount;
                }
                const defaults = new Array<number>(valueCount).fill(0);
                for (const entry of program.uniformDefaults) {
                    const offset = valueOffsets.get(entry.name);
                    if (offset === undefined) continue;
                    entry.values.forEach((value, index) => {
                        defaults[offset + index] = value;
                    });
                }
                const stageBlock = (stage: "vertex" | "fragment") => {
                    const block = reflection.uniformBlocks.find(
                        (candidate) => candidate.stage === stage,
                    );
                    if (!block) {
                        return { present: false, systemMatrices: [] as string[], floatSize: 0, gather: [] as number[][] };
                    }
                    return {
                        present: true,
                        systemMatrices: block.systemMatrices,
                        floatSize: block.size / 4,
                        gather: block.members.map((member) => [
                            member.offset / 4,
                            valueOffsets.get(member.name) ?? 0,
                            member.size / 4,
                        ]),
                    };
                };
                return {
                    name: program.name,
                    samplers: reflection.samplers,
                    topology: program.topology ?? "triangle-list",
                    instanceColors:
                        program.useThinInstanceColors === true,
                    alphaBlending: program.needAlphaBlending,
                    alphaTesting: program.needAlphaTesting,
                    backFaceCulling: program.backFaceCulling,
                    depthWrite: program.depthWrite,
                    valueCount,
                    defaults,
                    vertex: stageBlock("vertex"),
                    fragment: stageBlock("fragment"),
                };
            },
        );
        const floatLiteral = (value: number): string =>
            Number.isInteger(value)
                ? `${value}.0f`
                : `${value}f`;
        const stageBlockLiteral = (block: {
            present: boolean;
            systemMatrices: readonly string[];
            floatSize: number;
            gather: number[][];
        }): string =>
            `ShaderVariantStageBlock{${block.present}, {${block.systemMatrices
                .map(
                    (name) =>
                        `ShaderSystemMatrix::${shaderSystemMatrixEnumerator(
                            name as ShaderSystemMatrix,
                        )}`,
                )
                .join(", ")}}, ${block.floatSize}u, {${block.gather
                .map(
                    ([blockOffset, valueOffset, count]) =>
                        `{${blockOffset}u, ${valueOffset}u, ${count}u}`,
                )
                .join(", ")}}}`;
        const shaderVariantEntries = shaderVariantTable.map(
            (info) =>
                `    ShaderVariantInfo{
        "${info.name}",
        ShaderTopology::${info.topology === "line-list" ? "line_list" : "triangle_list"},
        ${info.instanceColors},
        ${info.alphaBlending},
        ${info.alphaTesting},
        ${info.backFaceCulling},
        ${info.depthWrite},
        ${info.valueCount}u,
        {${info.defaults.map(floatLiteral).join(", ")}},
        ${stageBlockLiteral(info.vertex)},
        ${stageBlockLiteral(info.fragment)},
        {${info.samplers.map((name) => `"${name}"`).join(", ")}},
    },`,
        ).join("\n");
        return { shaderVariantTable, shaderVariantEntries };
    }

    // The adopted buildBindings opaque sort: prove every reachable
    // family still stamps one shared non-transparent order, so the
    // emitted lists can stay in append order (see order_draw_lists).
    private provedOpaqueOrderStamp(): string {
        const opaqueOrderStamp = lowerOpaqueOrderStamp(
            [
                "src/material/pbr/pbr-renderable.ts",
                "src/material/pbr/pbr-geometry-renderable.ts",
                "src/material/standard/standard-renderable.ts",
                "src/material/standard/standard-geometry-renderable.ts",
                "src/material/shader/shader-renderable.ts",
                "src/material/shader/shader-thin-instance.ts",
            ].map((modulePath) => this.context.sourceFile(modulePath)),
        );
        return opaqueOrderStamp;
    }

    /** The emitted renderer_plan.hpp, verbatim from the adopted plan. */
    private renderPlanHeaderCpp(
        options: {
            solidSkybox?: boolean;
            imageSkybox?: boolean;
            gpuInstancing?: boolean;
        },
        systemMatrixEnumerators: string,
    ): string {
        return `#pragma once

#include <bblite/runtime.hpp>
// preferred_sample_count() lives in the always-emitted pinned_surface.hpp
// (an effect-only scene compiles no render plan); included here so every
// TU that renders through the plan still sees the one definition.
#include <bblite/upstream/pinned_surface.hpp>

#include <array>
#include <vector>

namespace bbl::upstream {

enum class RenderMaterialKind {
    pbr,
    standard,
    grid,
    shader,
    node,
};

enum class RenderBucket {
    opaque,
    alpha_mask,
    alpha_blend,
};

enum class RenderCullMode {
    back,
    none,
};

enum class RenderPipelineKind {
    pbr_opaque_back,
    pbr_opaque_none,
    pbr_opaque_none_clockwise,
    pbr_transparent_back,
    pbr_transparent_none,
    pbr_transparent_none_clockwise,
    standard_opaque_back,
    standard_opaque_none,
    standard_transparent_back,
    standard_transparent_none,
    grid_opaque_back,
    grid_opaque_none,
    grid_transparent_back,
    grid_transparent_none,
    shader,
    shader_a2c,
    node_opaque_back,
    node_opaque_none,
};

enum class RenderStage {
    skybox,
    opaque,
    transparent,
    ground,
};

struct RenderItem {
    MeshHandle mesh{};
    std::uint32_t geometry = invalid_handle;
    MaterialHandle material{};
    RenderMaterialKind material_kind = RenderMaterialKind::pbr;
    RenderBucket bucket = RenderBucket::opaque;
    RenderCullMode cull_mode = RenderCullMode::back;
    std::uint32_t shader_variant = 0;
    bool clockwise_front_face = false;
    bool alpha_to_coverage = false;
    bool transmissive = false;
    bool skybox_mode = false;
    std::uint32_t order = 0;
};

struct RenderDrawCommand {
    std::uint32_t item_index = invalid_handle;
    RenderItem item{};
    RenderPipelineKind pipeline =
        RenderPipelineKind::pbr_opaque_back;
    float sort_distance = 0.0f;
};

struct RenderDrawList {
    std::vector<RenderDrawCommand> commands;
};

struct RenderDrawLists {
    RenderDrawList opaque;
    RenderDrawList transparent;
};

struct RenderPlan {
    std::vector<RenderItem> items;
    RenderDrawLists draw_lists;
    std::array<RenderStage, 4> stages{
        RenderStage::skybox,
        RenderStage::opaque,
        RenderStage::transparent,
        RenderStage::ground,
    };
};

struct RenderFeatures {
    bool standard_material = false;
    bool grid_material = false;
    bool no_color_material = false;
    bool shader_material = false;
    bool node_material = false;
};

// Generated per-scene shader-variant metadata: pipeline state from the
// pinned shader-pipeline mapping and the reflected per-stage uniform
// blocks ([the declared system matrices][vec4-slot-packed
// custom members]) with gathers from the material's flat value storage.
// Which matrix each system slot carries, emitted from
// shaderSystemMatrixTable so this order and the compiler's cannot
// disagree. The pin lets a caller name any of nine system uniforms; these
// are the three a reached scene declares, and they head the block in the
// order the caller declared them.
enum class ShaderSystemMatrix : std::uint8_t {
${systemMatrixEnumerators}
};

struct ShaderVariantStageBlock {
    bool present = false;
    std::vector<ShaderSystemMatrix> system_matrices;
    std::uint32_t float_size = 0;
    // {block float offset, value float offset, float count}
    std::vector<std::array<std::uint32_t, 3>> gather;
};

// The pin's own material._topology, defaulted to "triangle-list": a
// material states the primitive its pipeline is built at, and the line
// family is the one reached material that names a second one.
enum class ShaderTopology : std::uint8_t {
    triangle_list,
    line_list,
};

struct ShaderVariantInfo {
    const char* name = "";
    ShaderTopology topology = ShaderTopology::triangle_list;
    // The material reads the mesh's per-instance RGBA stream, so its
    // pipeline declares the lane the pin's own thin-instance module
    // appends and its draws bind that buffer.
    bool instance_colors = false;
    bool alpha_blending = false;
    bool alpha_testing = false;
    bool back_face_culling = true;
    bool depth_write = true;
    std::uint32_t value_count = 0;
    std::vector<float> defaults;
    ShaderVariantStageBlock vertex;
    ShaderVariantStageBlock fragment;
    // The material's declared sampler names, in the order its samplers
    // option gave them -- which is the order setShaderTexture indexed and
    // the order the material record stores. The compiled stage may keep
    // fewer, at its own dense registers, so a backend that binds by
    // register looks the surviving name up here.
    std::vector<const char*> samplers;
};

std::uint32_t shader_variant_count();
const ShaderVariantInfo& shader_variant_info(std::uint32_t variant);

struct PbrUniforms {
    std::array<float, 4> light_direction{};
    std::array<float, 4> light_color{};
    std::array<float, 4> ground_color{};
    std::array<float, 4> light_direction_2{};
    std::array<float, 4> light_color_2{};
    std::array<float, 4> ground_color_2{};
    std::array<float, 4> camera_position{};
    std::array<float, 4> camera_forward_near{};
    std::array<float, 4> view_right{};
    std::array<float, 4> view_up{};
    std::array<float, 4> view_forward{};
    std::array<float, 4> base_color_factor{};
    std::array<float, 4> emissive_factor{};
    std::array<float, 4> material_factors{};
    std::array<float, 4> environment_factors{};
    std::array<float, 4> material_options{};
    std::array<float, 4> normal_options{};
    std::array<float, 4> image_processing_options{};
    std::array<std::array<float, 4>, 9> spherical_harmonics{};
};

struct GridUniforms {
    std::array<float, 4> grid_control{};
    std::array<float, 4> main_color{};
    std::array<float, 4> line_color{};
    std::array<float, 4> grid_offset_visibility{};
    std::array<float, 4> options{};
};

struct BackgroundPlan {
    std::array<ModelVertex, 4> vertices{};
    std::array<std::uint32_t, 6> indices{};
};

struct BackgroundUniforms {
    std::array<float, 4> primary_color_alpha{};
    std::array<float, 4> background_center{};
    std::array<float, 4> camera_exposure{};
    std::array<float, 4> image_parameters{};
};

struct SkyboxPlan {
    std::array<ModelVertex, 8> vertices{};
    std::array<std::uint32_t, 36> indices{};
};

struct SkyboxUniforms {
    std::array<float, 4> primary_color_exposure{};
    std::array<float, 4> background_center{};
    std::array<float, 4> image_parameters{};
};
${options.solidSkybox
    ? `
struct SolidSkyboxPlan {
    std::array<std::array<float, 3>, 8> positions{};
    std::array<std::uint32_t, 36> indices{};
};

// src/material/pbr/background-solid-skybox.ts createSkyMeshUBO: the pinned
// 96-byte mesh block, field for field, so a native capture pairs against the
// browser's own buffer.
struct SolidSkyboxUniforms {
    std::array<float, 16> world{};
    std::array<float, 3> primary_color{};
    float pad = 0.0f;
    std::array<float, 3> sky_output_color{};
    float pad2 = 0.0f;
};

// src/shader/scene-uniforms.ts SCENE_UBO_WGSL, truncated at the last member
// the pinned skybox stages read. The vertex stage keeps the pin's own
// scene.viewProjection and scene.vEyePosition references, so this block is the
// pin's per-pass prefix rather than a native invention.
struct SolidSkyboxSceneUniforms {
    std::array<float, 16> view_projection{};
    std::array<float, 16> view{};
    std::array<float, 4> eye_position{};
};
`
    : ""}\
${options.imageSkybox
    ? `
struct ImageSkyboxPlan {
    std::array<std::array<float, 3>, 8> positions{};
    std::array<std::uint32_t, 36> indices{};
};

// The lifted cubemap-skybox fragment block. The pinned fog distance is
// (scene.view * worldPos).xyz, so the block carries the view matrix the
// fragment evaluates that expression with, plus the two WGSL_FOG vec4s --
// 96 bytes, the same size the retired camera-basis block occupied.
struct ImageSkyboxUniforms {
    std::array<float, 16> view{};
    std::array<float, 4> fog_infos{};
    std::array<float, 4> fog_color{};
};
`
    : ""}\

RenderPlan build_render_plan(const Scene& scene, const Engine& engine);
RenderFeatures build_render_features(
    const Scene& scene,
    const Engine& engine);
RenderDrawLists build_render_draw_lists(
    const std::vector<RenderItem>& items,
    const Engine& engine);
RenderDrawLists build_render_task_draw_lists(
    const std::vector<RenderItem>& items,
    const Engine& engine,
    const FrameTaskRecord& task);
struct CameraBasis {
    Vec3 eye;
    Vec3 forward;
    Vec3 right;
    Vec3 up;
};
CameraBasis camera_basis(const CameraRecord& camera);
void sort_transparent_draws(
    RenderDrawList& transparent,
    const Engine& engine,
    const CameraRecord& camera);
RenderItem bind_render_item(
    RenderItem item,
    const Engine& engine,
    MaterialHandle material);
// The aspect ratio is a JavaScript number in
// src/camera/camera.ts getEffectiveAspectRatio, and the pinned
// projection writer divides by it before its single float32 store.
/** The projection alone, which the splat stage reads beside the view. */
std::array<float, 16> build_projection(
    const CameraRecord& camera,
    double aspect);
std::array<float, 16> build_view_projection(
    const CameraRecord& camera,
    double aspect);
// The pin's scene.view, from the camera's own world matrix. Declared because
// the pinned PBR variants read it out of the scene block a PAL fills, where the
// transcribed fragment never needed it.
std::array<float, 16> build_view_matrix(
    const std::array<float, 16>& camera_world);
std::array<float, 16> build_skybox_view_projection(
    const CameraRecord& camera,
    double aspect);
${options.gpuInstancing
    ? `std::array<float, 16> build_instance_parent_world(
    const MeshRecord& mesh);
`
    : ""}\
// src/render/lights-ubo.ts affectsMesh: a light applies to the meshes its
// includedOnlyMeshesIds names, or to every mesh its excludedMeshesIds does
// not. One definition, because both the Standard slot writer and the pinned
// per-draw mesh block need the same per-mesh light set.
bool light_affects_mesh(
    const LightRecord& light,
    std::uint32_t mesh_index);
PbrUniforms build_pbr_uniforms(
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const RenderItem& item);
GridUniforms build_grid_uniforms(
    const Engine& engine,
    const RenderItem& item);
BackgroundPlan build_background_plan(const EnvironmentState& environment);
BackgroundUniforms build_background_uniforms(
    const EnvironmentState& environment,
    const CameraRecord& camera);
SkyboxPlan build_skybox_plan(const EnvironmentState& environment);
SkyboxUniforms build_skybox_uniforms(
    const EnvironmentState& environment,
    bool linear_image_processing);
${options.solidSkybox
    ? `SolidSkyboxPlan build_solid_skybox_plan(
    const EnvironmentState& environment);
SolidSkyboxUniforms build_solid_skybox_uniforms(
    const Scene& scene);
SolidSkyboxSceneUniforms build_solid_skybox_scene_uniforms(
    const CameraRecord& camera,
    const std::array<float, 16>& view_projection);
`
    : ""}\
${options.imageSkybox
    ? `ImageSkyboxPlan build_image_skybox_plan(
    const EnvironmentState& environment);
ImageSkyboxUniforms build_image_skybox_uniforms(
    const Scene& scene,
    const CameraRecord& camera);
`
    : ""}\

} // namespace bbl::upstream
`;
    }

    /** The emitted renderer_plan.cpp, verbatim from the adopted plan. */
    private renderPlanSourceCpp(
        options: {
            nodeVisibility?: boolean;
            orthographicCamera?: boolean;
            gpuInstancing?: boolean;
            environmentRotation?: boolean;
            solidSkybox?: boolean;
            imageSkybox?: boolean;
        },
        inputs: {
            viewMatrixBody: string;
            opaqueOrderStamp: string;
            shaderVariantTable: { readonly length: number };
            shaderVariantEntries: string;
            instancingTrs: {
                halfAngleLocals: string;
                quaternionProducts: string;
                basisLocals: string;
                basisStores: string;
            };
            secondAnalyticLightFill: string;
            backgroundGeometry: {
                groundVertexRows: string;
                groundIndexRow: string;
                groundAlpha: string;
                skyboxVertexRows: string;
                skyboxCornerRows: string;
                skyboxIndexRows: string;
            };
            perspectiveWriter: string;
            orthoWriter: string;
            multiplyWriter: string;
        },
    ): string {
        const {
            viewMatrixBody,
            opaqueOrderStamp,
            shaderVariantTable,
            shaderVariantEntries,
            instancingTrs,
            secondAnalyticLightFill,
            backgroundGeometry,
            perspectiveWriter,
            orthoWriter,
            multiplyWriter,
        } = inputs;
        return `// ${this.context.provenance(
                renderTaskModule,
                "buildBindings",
                `${renderTaskModule}#sortTransparentBindings`,
            )}
#include <bblite/upstream/renderer_plan.hpp>
#include <bblite/upstream/camera_math.hpp>

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <iterator>

namespace bbl::upstream {

namespace {

float dot(Vec3 left, Vec3 right) {
    return left.x * right.x + left.y * right.y + left.z * right.z;
}

Vec3 normalize(Vec3 value) {
    const float length = std::sqrt(dot(value, value));
    return length > 0.000001f
        ? Vec3{value.x / length, value.y / length, value.z / length}
        : Vec3{};
}

Vec3 cross(Vec3 left, Vec3 right) {
    return Vec3{
        left.y * right.z - left.z * right.y,
        left.z * right.x - left.x * right.z,
        left.x * right.y - left.y * right.x,
    };
}

} // namespace

// src/camera/camera.ts getViewMatrix: the rotation is the transpose of
// the world matrix's basis and the translation is that basis applied to
// the negated eye, computed from the float32 world matrix in JavaScript
// doubles and stored once into the float32 view cache.
//
// Outside the anonymous namespace because a PAL binding the pinned PBR
// variants fills the pin's own scene block, which carries scene.view.
std::array<float, 16> build_view_matrix(
    const std::array<float, 16>& world) {
${viewMatrixBody}\
    return view;
}

namespace {

${multiplyWriter}

// The by-value shape every view-projection composition here uses: the
// pinned writer over whole matrices at offset zero.
std::array<float, 16> multiply_into(
    const std::array<float, 16>& a,
    const std::array<float, 16>& b) {
    std::array<float, 16> out{};
    mat4_multiply_into(out, 0, a, 0, b, 0);
    return out;
}

} // namespace

RenderItem bind_render_item(
    RenderItem item,
    const Engine& engine,
    MaterialHandle material_handle) {
    item.material = material_handle;
    if (material_handle.value >= engine.materials.size()) {
        return item;
    }
    const MaterialRecord& material = engine.materials[material_handle.value];
    item.material_kind = material.grid_material
        ? RenderMaterialKind::grid
        : material.shader_material
            ? RenderMaterialKind::shader
            : material.node_material
            ? RenderMaterialKind::node
            : material.standard_material
            ? RenderMaterialKind::standard
            : RenderMaterialKind::pbr;
    item.bucket =
        material.alpha_mode == MaterialAlphaMode::blend
            ? RenderBucket::alpha_blend
            : material.alpha_mode == MaterialAlphaMode::mask
                ? RenderBucket::alpha_mask
                : RenderBucket::opaque;
    item.cull_mode = material.double_sided
        ? RenderCullMode::none
        : RenderCullMode::back;
    item.shader_variant = material.shader_variant;
    item.alpha_to_coverage = material.alpha_to_coverage;
    item.transmissive = material.transmission_factor > 0.0f ||
        !material.transmission_texture.bytes.empty();
    item.skybox_mode = material.skybox_mode;
    return item;
}

namespace {

RenderPipelineKind render_pipeline_kind(const RenderItem& item) {
    const bool transparent =
        item.bucket == RenderBucket::alpha_blend;
    const bool double_sided =
        item.cull_mode == RenderCullMode::none;
    switch (item.material_kind) {
        case RenderMaterialKind::pbr:
            if (transparent) {
                if (!double_sided) {
                    return RenderPipelineKind::pbr_transparent_back;
                }
                return item.clockwise_front_face
                    ? RenderPipelineKind::pbr_transparent_none_clockwise
                    : RenderPipelineKind::pbr_transparent_none;
            }
            if (!double_sided) {
                return RenderPipelineKind::pbr_opaque_back;
            }
            return item.clockwise_front_face
                ? RenderPipelineKind::pbr_opaque_none_clockwise
                : RenderPipelineKind::pbr_opaque_none;
        case RenderMaterialKind::standard:
            if (transparent) {
                return double_sided
                    ? RenderPipelineKind::standard_transparent_none
                    : RenderPipelineKind::standard_transparent_back;
            }
            return double_sided
                ? RenderPipelineKind::standard_opaque_none
                : RenderPipelineKind::standard_opaque_back;
        case RenderMaterialKind::grid:
            if (transparent) {
                return double_sided
                    ? RenderPipelineKind::grid_transparent_none
                    : RenderPipelineKind::grid_transparent_back;
            }
            return double_sided
                ? RenderPipelineKind::grid_opaque_none
                : RenderPipelineKind::grid_opaque_back;
        case RenderMaterialKind::shader:
            return item.alpha_to_coverage
                ? RenderPipelineKind::shader_a2c
                : RenderPipelineKind::shader;
        // A node graph's blend state is its own; the reached slice composes
        // only the opaque arm, so the bucket cannot be transparent here.
        case RenderMaterialKind::node:
            return double_sided
                ? RenderPipelineKind::node_opaque_none
                : RenderPipelineKind::node_opaque_back;
    }
    return RenderPipelineKind::pbr_opaque_back;
}

void append_draw(
    RenderDrawLists& result,
    std::uint32_t item_index,
    const RenderItem& item) {
    RenderDrawCommand command;
    command.item_index = item_index;
    command.item = item;
    command.pipeline = render_pipeline_kind(item);
    RenderDrawList& list =
        item.bucket == RenderBucket::alpha_blend ||
        item.transmissive
            ? result.transparent
            : result.opaque;
    list.commands.push_back(command);
}

// pin-adopted(opaque-order): the pinned buildBindings sorts the opaque
// and direct buckets by renderable.order alone (render-task.ts), and
// every renderable this port reaches stamps the same non-transparent
// order ${opaqueOrderStamp} -- mesh.renderOrder has no record transport
// and no corpus scene sets it -- so the pinned stable sort is the
// identity permutation here: the draws keep the append order the pin's
// own _renderables walk produces. The pipeline_order grouping that used
// to reorder this list was an invention of this port.
void order_draw_lists(RenderDrawLists&) {}

} // namespace

void include_material_features(
    RenderFeatures& features,
    const Engine& engine,
    MaterialHandle handle) {
    if (handle.value >= engine.materials.size()) return;
    const MaterialRecord& material = engine.materials[handle.value];
    features.standard_material |= material.standard_material;
    features.grid_material |= material.grid_material;
    features.no_color_material |= material.no_color;
    features.shader_material |= material.shader_material;
    features.node_material |= material.node_material;
}

RenderFeatures build_render_features(
    const Scene& scene,
    const Engine& engine) {
    RenderFeatures result;
    for (const MeshHandle handle : scene.meshes) {
        if (handle.value < engine.meshes.size()) {
            include_material_features(
                result,
                engine,
                engine.meshes[handle.value].material);
        }
    }
    for (const FrameTaskRecord& task : engine.frame_tasks) {
        for (const RenderTaskMesh& entry : task.render_meshes) {
            include_material_features(result, engine, entry.material);
        }
    }
    return result;
}

namespace {

const std::array<ShaderVariantInfo, ${shaderVariantTable.length}> shader_variants{{
${shaderVariantEntries}
}};

} // namespace

std::uint32_t shader_variant_count() {
    return ${shaderVariantTable.length}u;
}

const ShaderVariantInfo& shader_variant_info(std::uint32_t variant) {
    if (variant >= shader_variants.size()) {
        throw std::runtime_error("Unknown shader variant id.");
    }
    return shader_variants[variant];
}

RenderDrawLists build_render_draw_lists(
    const std::vector<RenderItem>& items,
    const Engine& engine) {
    RenderDrawLists result;
    result.opaque.commands.reserve(items.size());
    result.transparent.commands.reserve(items.size());
    for (std::size_t index = 0; index < items.size(); ++index) {
        append_draw(
            result,
            static_cast<std::uint32_t>(index),
            bind_render_item(
                items[index],
                engine,
                items[index].material));
    }
    order_draw_lists(result);
    return result;
}

RenderDrawLists build_render_task_draw_lists(
    const std::vector<RenderItem>& items,
    const Engine& engine,
    const FrameTaskRecord& task) {
    if (task.kind == FrameTaskKind::geometry) {
        RenderDrawLists result;
        result.opaque.commands.reserve(items.size());
        result.transparent.commands.reserve(items.size());
        for (std::size_t index = 0; index < items.size(); ++index) {
            const RenderItem item = bind_render_item(
                items[index],
                engine,
                items[index].material);
            if (
                item.material_kind != RenderMaterialKind::pbr &&
                item.material_kind != RenderMaterialKind::standard) {
                continue;
            }
            append_draw(
                result,
                static_cast<std::uint32_t>(index),
                item);
        }
        order_draw_lists(result);
        return result;
    }
    if (task.kind != FrameTaskKind::render) {
        return build_render_draw_lists(items, engine);
    }
    if (task.render_meshes.empty()) {
        return task.render.auto_mirror
            ? build_render_draw_lists(items, engine)
            : RenderDrawLists{};
    }
    RenderDrawLists result;
    result.opaque.commands.reserve(task.render_meshes.size());
    result.transparent.commands.reserve(task.render_meshes.size());
    for (const RenderTaskMesh& entry : task.render_meshes) {
        const auto found = std::find_if(
            items.begin(),
            items.end(),
            [&](const RenderItem& item) {
                return item.mesh.value == entry.mesh.value;
            });
        if (found == items.end()) {
            continue;
        }
        const std::uint32_t item_index =
            static_cast<std::uint32_t>(
                std::distance(items.begin(), found));
        append_draw(
            result,
            item_index,
            bind_render_item(*found, engine, entry.material));
    }
    order_draw_lists(result);
    return result;
}

// The view basis every camera-facing computation starts from: the eye the
// pinned ArcRotate formula puts the camera at, and the orthonormal frame
// looking at its target. Written once because a camera feature that
// changes it -- an orthographic volume, a different up axis -- has to
// change it everywhere at once.
// The basis is read out of the pinned camera world matrix rather than
// recomputed: src/math/mat4-look-at-world-lh.ts writes columns
// [xAxis, yAxis, zAxis, eye] and src/camera/camera.ts getCameraPosition
// reads the eye straight back out of column 3, so these are the same
// float32 values every pinned consumer sees.
CameraBasis camera_basis(const CameraRecord& camera) {
    const std::array<float, 16> world = camera_world_matrix(camera);
    return CameraBasis{
        Vec3{world[12], world[13], world[14]},
        Vec3{world[8], world[9], world[10]},
        Vec3{world[0], world[1], world[2]},
        Vec3{world[4], world[5], world[6]},
    };
}

void sort_transparent_draws(
    RenderDrawList& transparent,
    const Engine& engine,
    const CameraRecord& camera) {
    const CameraBasis basis = camera_basis(camera);
    const Vec3& eye = basis.eye;
    const Vec3& forward = basis.forward;
    for (RenderDrawCommand& command : transparent.commands) {
        if (command.item.mesh.value >= engine.meshes.size()) {
            command.sort_distance = 0.0f;
            continue;
        }
        const MeshRecord& mesh = engine.meshes[command.item.mesh.value];
        // pin-adopted(sort-center): both pinned families store sortCenter =
        // worldMatrix[12..14] (pbr-renderable.ts / standard-renderable.ts),
        // the draw world's translation -- never the bounds center. The
        // record splits that world into the loader-baked node world
        // (instance_parent_matrix, identity for scene-code meshes), the live
        // TRS whose translation is mesh.position (identity for loader-baked
        // meshes), and an imported clone root's post-deformation translation.
        // The pinned center is their composed world translation.
        const std::array<float, 16>& parent = mesh.instance_parent_matrix;
        const Vec3 center{
            parent[0] * mesh.position.x + parent[4] * mesh.position.y +
                parent[8] * mesh.position.z + parent[12] +
                mesh.outer_position.x,
            parent[1] * mesh.position.x + parent[5] * mesh.position.y +
                parent[9] * mesh.position.z + parent[13] +
                mesh.outer_position.y,
            parent[2] * mesh.position.x + parent[6] * mesh.position.y +
                parent[10] * mesh.position.z + parent[14] +
                mesh.outer_position.z,
        };
        const Vec3 delta{
            center.x - eye.x,
            center.y - eye.y,
            center.z - eye.z,
        };
        command.sort_distance = dot(delta, forward);
    }
    std::stable_sort(
        transparent.commands.begin(),
        transparent.commands.end(),
        [](const RenderDrawCommand& left, const RenderDrawCommand& right) {
            return left.sort_distance > right.sort_distance ||
                (left.sort_distance == right.sort_distance &&
                 left.item.order < right.item.order);
        });
}

RenderPlan build_render_plan(const Scene& scene, const Engine& engine) {
    RenderPlan result;
    result.items.reserve(scene.meshes.size());
    for (const MeshHandle handle : scene.meshes) {
        if (handle.value >= engine.meshes.size()) {
            continue;
        }
        const MeshRecord& mesh = engine.meshes[handle.value];
        if (mesh.geometry >= engine.geometries.size()) {
            continue;
        }${options.nodeVisibility ? `
        // KHR_node_visibility, materialized per mesh by the loader and by
        // the animation pointer, exactly as the pinned setSubtreeVisible
        // materializes it per node.
        if (!mesh.visible) {
            continue;
        }` : ""}
        RenderItem item;
        item.mesh = handle;
        item.geometry = mesh.geometry;
        item.clockwise_front_face =
            mesh.clockwise_front_face;
        item.order = static_cast<std::uint32_t>(result.items.size());
        result.items.push_back(
            bind_render_item(item, engine, mesh.material));
    }
    result.draw_lists =
        build_render_draw_lists(result.items, engine);
    return result;
}

// The pinned perspective writer, translated whole below. It maps
// near -> 1 and far -> 0 and the engine compares greater-equal
// (src/engine/render-target.ts REVERSE_DEPTH_COMPARE), which is the one
// convention every pinned family renders under, so it is the one this
// renderer writes -- for the scene's own view and for the skybox's alike.
${perspectiveWriter}
${orthoWriter ? `
${orthoWriter}
` : ""}\

std::array<float, 16> build_projection(
    const CameraRecord& camera,
    double aspect) {
    // The pinned writer stores only the five perspective lanes and relies
    // on an already-zero target, which the fresh array provides.
    std::array<float, 16> projection{};
    mat4_perspective_lh_to_ref(
        projection,
        camera.fov,
        aspect,
        camera.near_plane,
        camera.far_plane);
    return projection;
}

std::array<float, 16> build_view_projection(
    const CameraRecord& camera,
    double aspect) {
    const std::array<float, 16> view =
        build_view_matrix(camera_world_matrix(camera));

${options.orthographicCamera
    ? `    if (camera.orthographic) {
        // src/camera/orthographic.ts writeOrthoProjection: every plane
        // derives from the half-extent (the derivation and all seven
        // call arguments are shape-asserted where the single-extent
        // record is emitted), and the writer itself is the pinned
        // mat4OrthoOffCenterLHToRef translated whole above.
        const double half_height =
            static_cast<double>(camera.ortho_half_height);
        const double half_width =
            half_height * static_cast<double>(aspect);
        std::array<float, 16> projection{};
        mat4_ortho_off_center_lh_to_ref(
            projection,
            -half_width,
            half_width,
            -half_height,
            half_height,
            camera.near_plane,
            camera.far_plane);
        return multiply_into(projection, view);
    }
`
    : ""}\
    return multiply_into(build_projection(camera, aspect), view);
}

std::array<float, 16> build_skybox_view_projection(
    const CameraRecord& camera,
    double aspect) {
    // A skybox follows the camera, so this view keeps the rotation and
    // drops the eye translation the other builders apply. The rotation
    // is the same transpose getViewMatrix writes, so it is taken from
    // the pinned world matrix rather than recomposed.
    std::array<float, 16> view =
        build_view_matrix(camera_world_matrix(camera));
    view[12] = 0.0f;
    view[13] = 0.0f;
    view[14] = 0.0f;
    return multiply_into(build_projection(camera, aspect), view);
}

${options.gpuInstancing
    ? `// src/scene/world-matrix-state.ts composeTrsLocalMatrix +
// src/math/mat4-compose-into.ts mat4ComposeInto: a thin-instanced mesh
// reaches the vertex stage's mesh.world (the instance parent-world
// uniform) from its record TRS, composed in JavaScript double precision
// and stored to f32 exactly like the pinned Float32Array world matrix.
// src/math/quat-euler.ts eulerToQuat converts Euler records the way the
// pinned Euler proxy writes the quaternion source of truth (non-zero
// Euler angles inherit the recorded std::sin/cos-versus-V8 ULP caveat).
// The pinned-parent multiply keeps the src/math/mat4-multiply-into.ts
// accumulation order, so a loader-built glTF pool (identity record TRS)
// reproduces instance_parent_matrix byte for byte and a user pool
// (identity parent) reproduces the composed TRS byte for byte.
std::array<float, 16> build_instance_parent_world(
    const MeshRecord& mesh) {
    if (!mesh.thin_instanced) {
        return mesh.instance_parent_matrix;
    }
    double qx = 0.0;
    double qy = 0.0;
    double qz = 0.0;
    double qw = 1.0;
    if (mesh.has_rotation_quaternion) {
        qx = mesh.rotation_quaternion.x;
        qy = mesh.rotation_quaternion.y;
        qz = mesh.rotation_quaternion.z;
        qw = mesh.rotation_quaternion.w;
    } else if (
        mesh.rotation.x != 0.0f ||
        mesh.rotation.y != 0.0f ||
        mesh.rotation.z != 0.0f) {
${instancingTrs.halfAngleLocals}\
${instancingTrs.quaternionProducts}\
    }
    const double scale_x = mesh.scaling.x;
    const double scale_y = mesh.scaling.y;
    const double scale_z = mesh.scaling.z;
${instancingTrs.basisLocals}\
    std::array<double, 16> local{};
${instancingTrs.basisStores}\
    // The pinned multiply, translated whole above: the parent is the f32
    // matrix the loader recorded and the composed TRS stays f64, which is
    // the pinned accumulation's own width for both.
    std::array<float, 16> result{};
    mat4_multiply_into(
        result, 0, mesh.instance_parent_matrix, 0, local, 0);
    return result;
}

`
    : ""}\
// src/render/lights-ubo.ts affectsMesh.
bool light_affects_mesh(
    const LightRecord& light,
    std::uint32_t mesh_index) {
    if (light.included_meshes.empty()) {
        return std::find(
                   light.excluded_meshes.begin(),
                   light.excluded_meshes.end(),
                   mesh_index) == light.excluded_meshes.end();
    }
    return std::find(
               light.included_meshes.begin(),
               light.included_meshes.end(),
               mesh_index) != light.included_meshes.end();
}

PbrUniforms build_pbr_uniforms(
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const RenderItem& item) {
    PbrUniforms result;
    result.light_direction[1] = 1.0f;
    // Analytic light kinds encode in light_direction.w: 0 hemispheric,
    // 1 point, 2 directional (src/material/pbr/fragments/
    // singlelight-directional-wgsl.ts drives the directional block).
    const auto write_pbr_light =
        [&engine](
            const LightHandle handle,
            std::array<float, 4>& light_direction,
            std::array<float, 4>& light_color,
            std::array<float, 4>& ground_color) {
        if (handle.value >= engine.lights.size()) {
            return;
        }
        const LightRecord& light = engine.lights[handle.value];
        if (light.kind == LightKind::spot) {
            // The primary slot encodes its kind in lightDirection.w across
            // three branches and carries no cone; only the extra-light slots
            // do. No reached scene puts a spot first, so this refuses rather
            // than shading it as a directional light.
            throw std::runtime_error(
                "Reached PBR lighting supports a spot light only outside the primary slot.");
        }
        const Vec3 matrix_direction{
            light.local_matrix[8],
            light.local_matrix[9],
            light.local_matrix[10],
        };
        const float matrix_length = std::sqrt(
            matrix_direction.x * matrix_direction.x +
            matrix_direction.y * matrix_direction.y +
            matrix_direction.z * matrix_direction.z);
        const Vec3 direction = matrix_length > 0.000001f
            ? Vec3{
                  matrix_direction.x / matrix_length,
                  matrix_direction.y / matrix_length,
                  matrix_direction.z / matrix_length,
              }
            : light.direction;
        light_direction =
            light.kind == LightKind::point
                ? std::array<float, 4>{
                      light.position.x,
                      light.position.y,
                      light.position.z,
                      1.0f,
                  }
                : std::array<float, 4>{
                      direction.x,
                      direction.y,
                      direction.z,
                      light.kind == LightKind::directional
                          ? 2.0f
                          : 0.0f,
                  };
        light_color = {
            light.diffuse_color.r,
            light.diffuse_color.g,
            light.diffuse_color.b,
            light.intensity,
        };
        ground_color = {
            light.ground_color.r,
            light.ground_color.g,
            light.ground_color.b,
            light.kind == LightKind::point ? light.range : 0.0f,
        };
    };
    if (!scene.lights.empty()) {
        write_pbr_light(
            scene.lights.front(),
            result.light_direction,
            result.light_color,
            result.ground_color);
    }
${secondAnalyticLightFill}    const CameraBasis basis = camera_basis(camera);
    const Vec3& eye = basis.eye;
    const Vec3& forward = basis.forward;
    const Vec3& right = basis.right;
    const Vec3& up = basis.up;
    result.camera_position = {
        eye.x,
        eye.y,
        eye.z,
        static_cast<float>(camera.far_plane),
    };
    result.camera_forward_near = {
        forward.x,
        forward.y,
        forward.z,
        static_cast<float>(camera.near_plane),
    };
    result.view_right = {right.x, right.y, right.z, 0.0f};
    result.view_up = {up.x, up.y, up.z, 0.0f};
    result.view_forward = {forward.x, forward.y, forward.z, 0.0f};
    result.base_color_factor = {1.0f, 1.0f, 1.0f, 1.0f};
    result.material_factors = {
        1.0f,
        1.0f,
        0.0f,
        scene.environment.has_irradiance ? 1.0f : 0.0f,
    };
    result.environment_factors = {
        scene.environment.exposure,
        scene.environment.contrast,
        scene.environment.lod_generation_scale,
        scene.environment.tone_mapping_enabled ? 1.0f : 0.0f,
    };
    result.image_processing_options[0] =
        scene.transmission_enabled ? 1.0f : 0.0f;
${options.environmentRotation
    ? `    result.image_processing_options[1] =
        scene.environment.rotation_y;
`
    : ""}\
    if (item.material.value < engine.materials.size()) {
        const MaterialRecord& material = engine.materials[item.material.value];
        result.base_color_factor = {
            material.base_color_factor.r,
            material.base_color_factor.g,
            material.base_color_factor.b,
            material.base_color_factor.a,
        };
        result.emissive_factor = {
            material.emissive_factor.r,
            material.emissive_factor.g,
            material.emissive_factor.b,
            material.specular_aa ? 1.0f : 0.0f,
        };
        result.material_factors[0] = material.metallic_factor;
        result.material_factors[1] = material.roughness_factor;
        result.material_factors[2] = material.has_occlusion_texture
            ? material.occlusion_strength
            : 0.0f;
        result.material_factors[3] =
            scene.environment.has_irradiance
                ? material.environment_intensity
                : 0.0f;
        result.light_color[3] *= material.direct_intensity;
        // The pinned extra-light terms multiply material.directIntensity
        // explicitly (src/material/pbr/fragments/multilight-wgsl.ts), so
        // the second analytic slot folds it into its intensity scalar
        // exactly like the primary slot.
        result.light_color_2[3] *= material.direct_intensity;
        result.material_options[2] = material.unlit ? 1.0f : 0.0f;
        result.material_options[3] = material.double_sided ? 1.0f : 0.0f;
        result.normal_options[1] =
            material.normal_texture.bytes.empty() ? 0.0f : 1.0f;
        const float dielectric_ratio =
            (material.index_of_refraction - 1.0f) /
            (material.index_of_refraction + 1.0f);
        result.normal_options[2] =
            material.has_ior
                ? dielectric_ratio * dielectric_ratio
                : material.reflectance;
        result.normal_options[3] = material.normal_texture_scale;
        if (
            item.geometry < engine.geometries.size() &&
            !engine.geometries[item.geometry].has_tangents &&
            !material.normal_texture.bytes.empty()) {
            result.normal_options[0] = 1.0f;
        }
        result.material_options[0] =
            material.alpha_mode == MaterialAlphaMode::blend
                ? 2.0f
                : material.alpha_mode == MaterialAlphaMode::mask
                    ? 1.0f
                    : 0.0f;
        result.material_options[1] = material.alpha_cutoff;
    }
    for (std::size_t index = 0; index < scene.environment.spherical_harmonics.size(); ++index) {
        result.spherical_harmonics[index] = {
            scene.environment.spherical_harmonics[index].r,
            scene.environment.spherical_harmonics[index].g,
            scene.environment.spherical_harmonics[index].b,
            0.0f,
        };
    }
    return result;
}

GridUniforms build_grid_uniforms(
    const Engine& engine,
    const RenderItem& item) {
    GridUniforms result;
    if (item.material.value >= engine.materials.size()) {
        return result;
    }
    const MaterialRecord& material =
        engine.materials[item.material.value];
    result.grid_control = {
        material.grid_control.x,
        material.grid_control.y,
        material.grid_control.z,
        material.grid_control.w,
    };
    result.main_color = {
        material.grid_main_color.r,
        material.grid_main_color.g,
        material.grid_main_color.b,
        0.0f,
    };
    result.line_color = {
        material.grid_line_color.r,
        material.grid_line_color.g,
        material.grid_line_color.b,
        0.0f,
    };
    result.grid_offset_visibility = {
        material.grid_offset.x,
        material.grid_offset.y,
        material.grid_offset.z,
        material.grid_visibility,
    };
    result.options = {
        material.alpha_mode == MaterialAlphaMode::blend
            ? 1.0f
            : 0.0f,
        material.grid_antialias ? 1.0f : 0.0f,
        material.grid_use_max_line ? 1.0f : 0.0f,
        material.grid_pre_multiply_alpha ? 1.0f : 0.0f,
    };
    return result;
}

BackgroundPlan build_background_plan(const EnvironmentState& environment) {
    const float half = environment.ground_size * 0.5f;
    const Vec3 center = environment.ground_position;
    BackgroundPlan result;
    result.vertices = {
${backgroundGeometry.groundVertexRows}
    };
    result.indices = {${backgroundGeometry.groundIndexRow}};
    return result;
}

BackgroundUniforms build_background_uniforms(
    const EnvironmentState& environment,
    const CameraRecord& camera) {
    const Vec3 eye = camera_basis(camera).eye;
    BackgroundUniforms result;
    result.primary_color_alpha = {
        environment.primary_color.r,
        environment.primary_color.g,
        environment.primary_color.b,
        ${backgroundGeometry.groundAlpha},
    };
    result.background_center = {
        0.0f,
        0.0f,
        0.0f,
        0.0f,
    };
    result.camera_exposure = {
        eye.x,
        eye.y,
        eye.z,
        environment.exposure,
    };
    result.image_parameters = {environment.contrast, 1.0f, 0.0f, 0.0f};
    return result;
}

SkyboxPlan build_skybox_plan(const EnvironmentState& environment) {
    const float half = environment.skybox_size * 0.5f;
    const Vec3 center = environment.skybox_uses_environment
        ? Vec3{}
        : environment.skybox_position;
    const auto vertex = [&](float x, float y, float z) {
        return ModelVertex{
            Vec3{
                center.x + x,
                center.y + y,
                center.z + z,
            },
            Vec3{0.0f, 1.0f, 0.0f},
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{},
        };
    };
    SkyboxPlan result;
    result.vertices = {
${backgroundGeometry.skyboxVertexRows}
    };
    result.indices = {
${backgroundGeometry.skyboxIndexRows}
    };
    return result;
}

SkyboxUniforms build_skybox_uniforms(
    const EnvironmentState& environment,
    bool linear_image_processing) {
    const Vec3 center = environment.skybox_uses_environment
        ? Vec3{}
        : environment.skybox_position;
    SkyboxUniforms result;
    result.primary_color_exposure = {
        environment.primary_color.r,
        environment.primary_color.g,
        environment.primary_color.b,
        environment.exposure,
    };
    result.background_center = {
        center.x,
        center.y,
        center.z,
        0.0f,
    };
    result.image_parameters = {
        environment.contrast,
        environment.skybox_uses_environment ? 1.0f : 0.0f,
        environment.tone_mapping_enabled ? 1.0f : 0.0f,
        linear_image_processing ? 1.0f : 0.0f,
    };
    return result;
}
${options.solidSkybox
    ? `
SolidSkyboxPlan build_solid_skybox_plan(
    const EnvironmentState& environment) {
    // createSkyboxBuffers(engine, skyHalfSize): the cube is authored around
    // the model origin and reaches world space through mesh.world, which the
    // vertex stage applies with w = 0 -- so the root translation drops out and
    // only the half extent reaches the buffer.
    const float half = environment.skybox_size * 0.5f;
    SolidSkyboxPlan result;
    result.positions = {{
${backgroundGeometry.skyboxCornerRows}
    }};
    result.indices = {
${backgroundGeometry.skyboxIndexRows}
    };
    return result;
}

SolidSkyboxUniforms build_solid_skybox_uniforms(const Scene& scene) {
    const EnvironmentState& environment = scene.environment;
    SolidSkyboxUniforms result;
    result.world[0] = 1.0f;
    result.world[5] = 1.0f;
    result.world[10] = 1.0f;
    result.world[15] = 1.0f;
    result.world[12] = environment.skybox_position.x;
    result.world[13] = environment.skybox_position.y;
    result.world[14] = environment.skybox_position.z;
    result.primary_color = {
        environment.primary_color.r,
        environment.primary_color.g,
        environment.primary_color.b,
    };
    // skyOutputColor is the scene clear colour, which this fragment writes
    // directly: the solid arm applies no image processing at all.
    result.sky_output_color = {
        scene.clear_color.r,
        scene.clear_color.g,
        scene.clear_color.b,
    };
    return result;
}

SolidSkyboxSceneUniforms build_solid_skybox_scene_uniforms(
    const CameraRecord& camera,
    const std::array<float, 16>& view_projection) {
    // The pinned vertex stage reads its own scene block, so this builds the
    // layout that stage wants -- the frame's matrix beside the view and the
    // eye position it offsets the cube by. One camera world serves all
    // three, which is also the order the pin's writers read it in.
    const std::array<float, 16> world = camera_world_matrix(camera);
    SolidSkyboxSceneUniforms result;
    result.view_projection = view_projection;
    result.view = build_view_matrix(world);
    result.eye_position = {world[12], world[13], world[14], 0.0f};
    return result;
}
`
    : ""}\
${options.imageSkybox
    ? `
ImageSkyboxPlan build_image_skybox_plan(
    const EnvironmentState& environment) {
    // Pinned loadSkybox: createBoxData(size) spans plus/minus size/2
    // around the world origin with an identity world matrix.
    const float half = environment.image_skybox_size * 0.5f;
    ImageSkyboxPlan result;
    const std::array<std::array<float, 3>, 8> corners{{
${backgroundGeometry.skyboxCornerRows}
    }};
    result.positions = corners;
    result.indices = {
${backgroundGeometry.skyboxIndexRows}
    };
    return result;
}

ImageSkyboxUniforms build_image_skybox_uniforms(
    const Scene& scene,
    const CameraRecord& camera) {
    ImageSkyboxUniforms result;
    // The pin's own scene.view, so the lifted fragment evaluates the
    // pinned (scene.view * worldPos).xyz fog distance from the same
    // float32 matrix every other pinned consumer reads.
    result.view = build_view_matrix(camera_world_matrix(camera));
    result.fog_infos = {
${pinnedFogInfosPacking()}    };
    result.fog_color = {
        scene.fog_color.r,
        scene.fog_color.g,
        scene.fog_color.b,
        0.0f,
    };
    return result;
}
`
    : ""}\

} // namespace bbl::upstream
`;
    }

    public lowerShaders(options: {
        ground: boolean;
        skybox: boolean;
        imageSkybox?: boolean;
        solidSkybox?: boolean;
        transmission?: boolean;
        fog?: boolean;
        shaderPrograms: CompiledShaderProgram[];
        gridMaterial?: boolean;
        idDiagnostics: boolean;
        geometryOutputTasks: GeometryOutputTaskManifest[];
        frameGraph?: boolean;
        gpuDeformation?: boolean;
        morphStorage?: boolean;
        gpuInstancing?: boolean;
        clearcoat?: boolean;
        sheen?: boolean;
        iridescence?: boolean;
        dispersion?: boolean;
    } = {
        ground: true,
        skybox: true,
        transmission: true,
        shaderPrograms: shaderMaterialPrograms.map(
            predeclaredShaderProgram,
        ),
        gridMaterial: false,
        idDiagnostics: true,
        geometryOutputTasks: [],
        gpuDeformation: false,
        morphStorage: false,
        gpuInstancing: false,
        clearcoat: false,
        sheen: false,
        iridescence: false,
        dispersion: false,
    }): LoweredShader[] {
        this.assertPinnedShaderFormulas(options);
        const result: Array<{ output: string; data: string }> = [];
        result.push({
            output: "upstream/shaders/pbr.vert.native.wgsl",
            data: materialVertexWgsl(
                options.gpuDeformation,
                options.gpuInstancing,
                options.morphStorage,
            ),
        });
        if (options.fog) {
            const unportedFogSurfaces: readonly (readonly [
                boolean | undefined,
                string,
            ])[] = [
                [options.gridMaterial, "GridMaterial"],
                [options.ground, "environment grounds"],
                [options.skybox, "environment skyboxes"],
                [options.transmission, "transmission"],
                [
                    options.geometryOutputTasks.length > 0,
                    "geometry outputs",
                ],
                [
                    options.shaderPrograms.length > 0,
                    "custom shader materials",
                ],
            ];
            for (const [reached, label] of unportedFogSurfaces) {
                if (reached) {
                    throw new Error(
                        `Scene fog is currently ported for PBR and Standard surfaces; ${label} with fog are not supported yet.`,
                    );
                }
            }
            // The falloff formula itself is not asserted here: every
            // consumer emits it through `fogFactorWgsl()`, which lifts the
            // pinned `WGSL_FOG` literal and throws if it changes shape.
        }
        if (options.ground) {
            const pinnedGround = readPinnedBackgroundGroundSource(
                this.context.store.packageRoot,
            );
            const groundProvenance = this.context.provenance(
                backgroundGroundModule,
                "buildBackgroundGroundRenderable",
                "the module's own groundFragSrc + WGSL_IMAGE_PROCESSING with shader/wgsl-helpers.ts WGSL_DITHER/WGSL_NO_DITHER",
            );
            // Both variants carry the pin's fragment; the pin itself selects
            // noise by composing WGSL_DITHER or WGSL_NO_DITHER in front of
            // the same body, so the undithered file is the pin's zero-noise
            // arm rather than an edited body. The PALs load the dithered
            // file for the ground, as upstream's enableNoise default does.
            result.push({
                output:
                    "upstream/shaders/background-ground.frag.native.wgsl",
                data: backgroundGroundFragmentWgsl(
                    groundProvenance,
                    pinnedGround,
                ),
            });
            result.push({
                output:
                    "upstream/shaders/background-ground-dither.frag.native.wgsl",
                data: backgroundGroundFragmentWgsl(
                    groundProvenance,
                    pinnedGround,
                    true,
                ),
            });
        }
        if (options.skybox) {
            const pinnedSkybox = readPinnedBackgroundSkyboxSource(
                this.context.store.packageRoot,
            );
            const skyboxProvenance = this.context.provenance(
                backgroundDdsModule,
                "buildDdsSkyboxRenderable",
                `${backgroundHdrModule}#buildHdrSkyboxRenderable, the modules' own ddsSkyboxFragSrc/skyboxHdrFragSrc with shader/wgsl-helpers.ts WGSL_DITHER`,
            );
            // One file per pinned arm, under the names the PALs select
            // between on `skybox_uses_environment`: the undithered file is
            // the environment-cubemap (HDR) fragment — the pin composes no
            // dither for it — and the dithered file is the DDS fragment,
            // whose image-processing block is the pin's own single
            // high-contrast arm.
            result.push({
                output:
                    "upstream/shaders/background-skybox.frag.native.wgsl",
                data: backgroundSkyboxFragmentWgsl(
                    skyboxProvenance,
                    pinnedSkybox,
                ),
            });
            result.push({
                output:
                    "upstream/shaders/background-skybox-dither.frag.native.wgsl",
                data: backgroundSkyboxFragmentWgsl(
                    skyboxProvenance,
                    pinnedSkybox,
                    true,
                ),
            });
        }
        if (options.solidSkybox) {
            const pinned = this.pinnedSolidSkyboxSource();
            this.context.functionDeclaration(
                backgroundSolidModule,
                "buildSolidSkyboxRenderable",
            );
            const provenance = this.context.provenance(
                backgroundSolidModule,
                "buildSolidSkyboxRenderable",
                "shaders/skybox.vertex.wgsl and the module's own skyboxFragSrc",
            );
            result.push(
                {
                    output:
                        "upstream/shaders/solid-skybox.vert.native.wgsl",
                    data: solidSkyboxVertexWgsl(provenance, pinned),
                },
                {
                    output:
                        "upstream/shaders/solid-skybox.frag.native.wgsl",
                    data: solidSkyboxFragmentWgsl(provenance, pinned),
                },
            );
        }
        if (options.imageSkybox) {
            // Both stages are lifted from the packaged module's own
            // literals and re-homed onto the native binding contract;
            // the departures are documented on `liftedImageSkyboxWgsl`.
            const lifted = liftedImageSkyboxWgsl();
            const imageSkyboxProvenance =
                this.context.provenance(
                    skyboxCubemapModule,
                    "buildSkyboxCubeMapGPU",
                    `the module's own skyVertSrc/skyFragSrc with ${fogWgslModule}#WGSL_FOG`,
                );
            result.push(
                {
                    output:
                        "upstream/shaders/skybox-cubemap.vert.native.wgsl",
                    data: `// ${imageSkyboxProvenance}
struct VertexUniforms {
    viewProjection: mat4x4<f32>,
}
@group(1) @binding(0) var<uniform> uniforms: VertexUniforms;

struct VertexOutput {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) vPositionW: vec3<f32>,
    @location(1) vPositionLocal: vec3<f32>,
}

@vertex
fn mainVertex(@location(0) c: vec3<f32>) -> VertexOutput {
${lifted.vertexBody}
}
`,
                },
                {
                    output:
                        "upstream/shaders/skybox-cubemap.frag.native.wgsl",
                    data: `// ${imageSkyboxProvenance}
@group(2) @binding(0) var c: texture_cube<f32>;
@group(2) @binding(1) var d: sampler;

struct FragmentUniforms {
    view: mat4x4<f32>,
    fogInfos: vec4<f32>,
    fogColor: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: FragmentUniforms;

${fogFactorWgsl()}
struct FragmentInput {
    // D3D12 links vertex and fragment signatures by hardware register,
    // so the fragment must consume the position builtin to keep the
    // varying registers aligned with the shared vertex outputs.
    @builtin(position) clipPos: vec4<f32>,
    @location(0) vPositionW: vec3<f32>,
    @location(1) vPositionLocal: vec3<f32>,
}

@fragment
fn mainFragment(b: FragmentInput) -> @location(0) vec4<f32> {
${lifted.fragmentBody}
}
`,
                },
            );
        }
        if (options.transmission) {
            result.push(
                {
                    output:
                        "upstream/shaders/image-processing.vert.native.wgsl",
                    data: blitVertexWgsl(),
                },
                {
                    output:
                        "upstream/shaders/image-processing.frag.native.wgsl",
                    data: imageProcessingFragmentWgsl(),
                },
                {
                    output:
                        "upstream/shaders/image-processing-ms.frag.native.wgsl",
                    data: imageProcessingMultisampledFragmentWgsl(),
                },
            );
        }
        if (options.gridMaterial) {
            const provenance = this.context.provenance(
                gridModule,
                "createGridMaterial",
            );
            const gridSource = this.context.sourceFile(gridModule);
            result.push(
                {
                    output: "upstream/shaders/grid.vert.native.wgsl",
                    data: gridVertexWgsl(provenance, gridSource),
                },
                {
                    output: "upstream/shaders/grid.frag.native.wgsl",
                    data: gridFragmentWgsl(provenance, gridSource),
                },
            );
        }
        if (options.idDiagnostics) {
            result.push(
                {
                    output:
                        "upstream/shaders/diagnostic-id.frag.native.wgsl",
                    data: diagnosticIdFragmentWgsl(),
                },
                {
                    output:
                        "upstream/shaders/diagnostic-cluster.frag.native.wgsl",
                    data: diagnosticClusterFragmentWgsl(),
                },
            );
        }
        if (
            options.frameGraph ||
            options.geometryOutputTasks.length > 0
        ) {
            result.push(
                {
                    output: "upstream/shaders/blit.vert.native.wgsl",
                    data: blitVertexWgsl(),
                },
                {
                    output: "upstream/shaders/blit.frag.native.wgsl",
                    data: blitFragmentWgsl(),
                },
                {
                    output:
                        "upstream/shaders/depth-only.frag.native.wgsl",
                    data: depthOnlyFragmentWgsl(),
                },
            );
        }
        const sceneUniformsWgsl = options.shaderPrograms.length > 0
            ? this.compiledSceneUniformsWgsl()
            : "";
        for (const source of options.shaderPrograms) {
            const name = source.name;
            const program = lowerWgslShaderProgram(source);
            // The prelude's `defines` lines come from the pin's own
            // builder; everything else in it this port re-addresses.
            const defineLines = pinnedShaderDefineLines(
                this.context,
                source.defines ?? [],
            );
            result.push(
                {
                    output: `upstream/shaders/${name}.vert.wgsl`,
                    data:
                        `// ${this.context.provenance(shaderPipelineModule, "buildShaderPrelude")}\n` +
                        composeStandaloneWgsl(
                            source,
                            sceneUniformsWgsl,
                            "vertex",
                            defineLines,
                        ),
                },
                {
                    output: `upstream/shaders/${name}.frag.wgsl`,
                    data:
                        `// ${this.context.provenance(shaderPipelineModule, "buildShaderPrelude")}\n` +
                        composeStandaloneWgsl(
                            source,
                            sceneUniformsWgsl,
                            "fragment",
                            defineLines,
                        ),
                },
                {
                    output: `upstream/shaders/${name}.vert.native.wgsl`,
                    data: emitNativeWgslProgram(
                        program,
                        "vertex",
                        defineLines,
                    ),
                },
                {
                    output: `upstream/shaders/${name}.frag.native.wgsl`,
                    data: emitNativeWgslProgram(
                        program,
                        "fragment",
                        defineLines,
                    ),
                },
            );
        }
        return result;
    }

    /**
     * Every pinned WGSL formula the emitted shaders transcribe or lift,
     * asserted before any file is rendered so a retuned pin fails
     * generation with the formula's own name.
     */
    private assertPinnedShaderFormulas(options: {
        morphStorage?: boolean;
        clearcoat?: boolean;
        sheen?: boolean;
        iridescence?: boolean;
        dispersion?: boolean;
        shaderPrograms: CompiledShaderProgram[];
    }): void {
        const pbr = this.context.store.getSource(pbrTemplateModule);
        const pbrExt = this.context.store.getSource(pbrTemplateExtModule);
        const pbrHelper = this.context.store.getSource(pbrHelperCoreModule);
        const ibl = this.context.store.getSource(iblFragmentModule);
        const iblSkybox = this.context.store.getSource(iblSkyboxModule);
        const refraction = this.context.store.getSource(refractionModule);
        const dielectric = this.context.store.getSource(
            dielectricLoaderModule,
        );
        const transmissionFrameGraph = this.context.store.getSource(
            transmissionFrameGraphModule,
        );
        const sceneUniforms = this.context.store.getSource(sceneUniformsModule);
        const backgroundGround = this.context.store.getSource(backgroundGroundModule);
        const backgroundDds = this.context.store.getSource(backgroundDdsModule);
        const backgroundHdr = this.context.store.getSource(backgroundHdrModule);
        const pbrGeometryModule =
            "src/material/pbr/pbr-geometry-output-shader.ts";
        const pbrGeometry = this.context.store.getSource(pbrGeometryModule);
        const clearcoatFragment = this.context.store.getSource(
            clearcoatFragmentModule,
        );
        const sheenFragment = this.context.store.getSource(
            sheenFragmentModule,
        );
        const iridescenceFragment = this.context.store.getSource(
            iridescenceFragmentModule,
        );
        const dispersionWgsl = this.context.store.getSource(
            dispersionWgslModule,
        );
        const clearcoatLoader = this.context.store.getSource(
            clearcoatLoaderModule,
        );
        const sheenLoader = this.context.store.getSource(
            sheenLoaderModule,
        );
        const iridescenceLoader = this.context.store.getSource(
            iridescenceLoaderModule,
        );
        const shaderPipeline = this.context.store.getSource(shaderPipelineModule);
        const sceneUniformsSource = this.context.store.getSource(
            sceneUniformsSourceModule,
        );
        const requiredUpstreamFormulas: Array<
            readonly [string, string, string]
        > = [
            [pbr, "roughness*roughness+0.0005", "GGX roughness"],
            [pbr, "0.5/(gl+gv)", "Smith geometry"],
            [pbr, "luminanceOverAlpha+=dot", "transparent alpha luminance"],
            [pbr, "finalAlpha=saturate", "transparent alpha fold"],
            [pbrExt, "baseColor *= input.vColor.rgb", "vertex color base color"],
            [pbrExt, "alpha *= input.vColor.a", "vertex color alpha"],
            [pbrHelper, "1.590579", "image-processing calibration"],
            [ibl, "log2(cubemapDim * alphaG) * scene.vImageInfos.z", "IBL mip selection"],
            [ibl, "getEnergyConservationFactor", "IBL energy conservation"],
            [ibl, "finalRadianceScaled", "transparent IBL alpha contribution"],
            [ibl, "environmentHorizonOcclusion", "IBL horizon occlusion"],
            [ibl, "let seo = clamp", "IBL specular occlusion"],
            [ibl, "vec2<f32>(NdotV, roughness)", "BRDF LUT coordinates"],
            [ibl, "let R = rotateY(R_raw", "environment cubemap rotation"],
            [iblSkybox, "let R = input.worldPos - scene.vEyePosition.xyz", "PBR skybox view ray"],
            [iblSkybox, "let skyboxAlphaG = max(roughness * roughness, 0.000001)", "PBR skybox LOD alphaG"],
            [refraction, "let rd=refract(-V,N,material.refractionParams.y)", "scene-color refraction ray"],
            [refraction, "let ab=exp(material.volumeParams.rgb*th)", "Beer-Lambert attenuation"],
            [refraction, "colorSpecularEnvReflectance.rgb", "transmission Fresnel complement"],
            [dielectric, "((ior - 1) / (ior + 1)) ** 2 / 0.04", "glTF IOR Fresnel"],
            [transmissionFrameGraph, "updateTransmissionTexture(state, engine)", "scene-color copy ordering"],
            [sceneUniforms, "lodGenerationScale ?? 0.8", "environment LOD scale"],
            // The ground/skybox fragment *formulas* are no longer asserted
            // here: they are lifted from the modules' own literals, and the
            // lift throws naming the missing literal itself.
            [backgroundGround, "ground renders last", "background ordering"],
            [backgroundDds, "GPUTextureFormat = \"rgba16float\"", "DDS cubemap format"],
            [backgroundDds, "pass.drawIndexed(36)", "DDS skybox draw"],
            [backgroundDds, "order: 0", "DDS skybox ordering"],
            [backgroundHdr, "order: 0", "HDR skybox ordering"],
            [backgroundHdr, "buildHdrSkyboxRenderable", "HDR skybox renderable"],
            [pbrGeometry, "directDiffuse + finalIrradiance", "geometry irradiance"],
            [pbrGeometry, "colorF0, 1.0 - roughness", "geometry reflectivity"],
            [pbrGeometry, "input.clipPos.z", "geometry screen depth"],
        ];
        if (options.morphStorage) {
            const morphCoreModule =
                "src/shader/fragments/morph-fragment-core.ts";
            const morphCore = this.context.store.getSource(morphCoreModule);
            const morphTargetsModule = "src/morph/create-morph-targets.ts";
            const morphTargets =
                this.context.store.getSource(morphTargetsModule);
            requiredUpstreamFormulas.push(
                [
                    morphCore,
                    "for (var i = 0u; i < morph.count; i = i + 1u)",
                    "storage morph accumulation loop",
                ],
                [
                    morphCore,
                    "let b = (i * morph.vertexCount + vertexIndex) * 6u;",
                    "storage morph delta indexing",
                ],
                [
                    morphCore,
                    "var<storage, read>",
                    "storage morph binding rewrite",
                ],
                [
                    morphTargets,
                    "MORPH_WEIGHTS_HEADER_BYTES = 16",
                    "morph weights header ABI",
                ],
            );
        }
        // The GridMaterial WGSL needs no marker rows: both stages are built
        // by evaluating the pinned template functions, which throws on any
        // shape the evaluator cannot fold.
        if (options.clearcoat) {
            requiredUpstreamFormulas.push(
                [
                    clearcoatFragment,
                    "return 0.25 / (VdotH_kl * VdotH_kl + 0.0000001);",
                    "clearcoat Kelemen visibility",
                ],
                [
                    clearcoatFragment,
                    "return f0 + (1.0 - f0) * (t2 * t2 * t);",
                    "clearcoat Schlick Fresnel",
                ],
                [
                    clearcoatFragment,
                    "ccDirectAttenuation = 1.0 - ccFresnel_dl * ccInt_dl;",
                    "clearcoat direct conservation",
                ],
                [
                    clearcoatFragment,
                    "let ccConservation_ibl = 1.0 - ccFresnelIBL * ccInt_ibl;",
                    "clearcoat IBL conservation",
                ],
                [
                    clearcoatLoader,
                    "useF0Remap: false",
                    "glTF clearcoat F0 remap opt-out",
                ],
            );
        }
        if (options.sheen) {
            requiredUpstreamFormulas.push(
                [
                    sheenFragment,
                    "return (2.0 + invR) * pow(sin2h, invR * 0.5) / (2.0 * 3.141592653589793);",
                    "sheen Charlie distribution",
                ],
                [
                    sheenFragment,
                    "return 1.0 / (4.0 * (NdotL_sh + NdotV_sh - NdotL_sh * NdotV_sh));",
                    "sheen Ashikhmin visibility",
                ],
                [
                    sheenFragment,
                    "sheenAlbedoScaling = 1.0 - shMax * shBrdf.b;",
                    "sheen albedo scaling",
                ],
                [
                    sheenLoader,
                    "albedoScaling: true",
                    "glTF sheen albedo scaling",
                ],
            );
        }
        if (options.iridescence) {
            requiredUpstreamFormulas.push(
                [
                    iridescenceFragment,
                    "let opd=2.0*iridescenceIor*thickness*cosTheta2;",
                    "iridescence optical path difference",
                ],
                [
                    iridescenceFragment,
                    "colorF0=mix(colorF0,iriF0,iriIntensity);",
                    "iridescence base reflectance blend",
                ],
                [
                    iridescenceLoader,
                    "iridescenceThicknessMaximum ?? 400",
                    "glTF iridescence thickness range",
                ],
            );
        }
        if (options.dispersion) {
            requiredUpstreamFormulas.push(
                [
                    dispersionWgsl,
                    "let spread=0.04*material.volumeParams.w*(realIOR-1.0);",
                    "dispersion chromatic spread",
                ],
                [
                    dielectric,
                    "20.0 / dispersion",
                    "glTF dispersion Abbe mapping",
                ],
            );
        }
        for (const [source, formula, label] of requiredUpstreamFormulas) {
            if (!source.includes(formula)) {
                throw new Error(`Pinned Babylon Lite source is missing ${label}: ${formula}.`);
            }
            if (options.shaderPrograms.length > 0) {
                for (const marker of [
                    "function buildShaderPrelude",
                    "@group(1) @binding(0) var<uniform> shaderSystem",
                    "@group(1) @binding(1) var<uniform> shaderUniforms",
                    "@location(${i}) ${attr}: ${attributeWgslType(attr)}",
                ]) {
                    if (!shaderPipeline.includes(marker)) {
                        throw new Error(
                            `Pinned custom shader composition changed: ${marker}.`,
                        );
                    }
                }
                if (!sceneUniformsSource.includes(
                    'import sceneUniformsWgsl from "../../shaders/scene-uniforms.wgsl?raw"',
                )) {
                    throw new Error("Pinned scene uniform WGSL import changed.");
                }
            }
        }
    }

    public compiledSceneUniformsWgsl(): string {
        const path = resolve(
            this.context.store.packageRoot,
            "lib/shader/scene-uniforms.js",
        );
        const cached = compiledSceneUniformsWgslCache.get(path);
        if (cached !== undefined) {
            return cached;
        }
        const file = ts.createSourceFile(
            path,
            readFileSync(path, "utf8"),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.JS,
        );
        const initializer =
            this.context.unwrapExpression(
                this.context.variableInitializer(
                    file,
                    "sceneUniformsWgsl",
                ),
            );
        if (
            !ts.isStringLiteral(initializer) &&
            !ts.isNoSubstitutionTemplateLiteral(initializer)
        ) {
            this.context.contractError(
                initializer,
                "Expected compiled scene-uniform WGSL text.",
            );
        }
        compiledSceneUniformsWgslCache.set(path, initializer.text);
        return initializer.text;
    }

    public shaderMaterialReflections(
        programs: CompiledShaderProgram[],
    ): ShaderProgramReflection[] {
        return programs.map(
            (program) =>
                lowerWgslShaderProgram(program).reflection,
        );
    }

    public fidelityManifest(): RendererFidelityManifest {
        const rgbd = this.context.store.getSource(rgbdDecodeModule);
        const surface = this.context.store.getSource(surfaceModule);
        const iblSkybox = this.context.store.getSource(iblSkyboxModule);
        const refraction = this.context.store.getSource(refractionModule);
        const dielectric = this.context.store.getSource(
            dielectricLoaderModule,
        );
        const clearcoatFragment = this.context.store.getSource(
            clearcoatFragmentModule,
        );
        const sheenFragment = this.context.store.getSource(
            sheenFragmentModule,
        );
        const iridescenceFragment = this.context.store.getSource(
            iridescenceFragmentModule,
        );
        const dispersionWgsl = this.context.store.getSource(
            dispersionWgslModule,
        );
        const transmissionFrameGraph = this.context.store.getSource(
            transmissionFrameGraphModule,
        );
        const clearcoatLoader = this.context.store.getSource(
            clearcoatLoaderModule,
        );
        if (!rgbd.includes("select(g.y,d.y-1u-g.y,f)")) {
            throw new Error("Pinned Babylon Lite RGBD vertical flip semantics changed.");
        }
        if (!surface.includes("Defaults to `4`.")) {
            throw new Error("Pinned Babylon Lite MSAA default changed.");
        }
        for (const [source, marker, label] of [
            [
                iblSkybox,
                "let R = input.worldPos - scene.vEyePosition.xyz",
                "PBR skybox mode",
            ],
            [
                iblSkybox,
                "let skyboxAlphaG = max(roughness * roughness, 0.000001)",
                "PBR skybox LOD alphaG",
            ],
            [
                refraction,
                "let ab=exp(material.volumeParams.rgb*th)",
                "volume attenuation",
            ],
            [
                dielectric,
                "((ior - 1) / (ior + 1)) ** 2 / 0.04",
                "IOR Fresnel",
            ],
            [
                transmissionFrameGraph,
                "updateTransmissionTexture(state, engine)",
                "scene-color copy",
            ],
            [
                clearcoatFragment,
                "let ccConservation_ibl = 1.0 - ccFresnelIBL * ccInt_ibl;",
                "clearcoat energy conservation",
            ],
            [
                clearcoatFragment,
                "colorF0 = mix(colorF0, remappedF0, ccInt_r);",
                "clearcoat base F0 remap",
            ],
            [
                clearcoatFragment,
                "return saturate((num / den) * (num / den));",
                "clearcoat F0 remap interface term",
            ],
            [
                clearcoatLoader,
                "useF0Remap: false",
                "glTF clearcoat F0 remap opt-out",
            ],
            [
                sheenFragment,
                "sheenAlbedoScaling = 1.0 - shMax * shBrdf.b;",
                "sheen albedo scaling",
            ],
            [
                iridescenceFragment,
                "let opd=2.0*iridescenceIor*thickness*cosTheta2;",
                "iridescence optical path difference",
            ],
            [
                dispersionWgsl,
                "let spread=0.04*material.volumeParams.w*(realIOR-1.0);",
                "dispersion chromatic spread",
            ],
        ] as const) {
            if (!source.includes(marker)) {
                throw new Error(`Pinned Babylon Lite ${label} changed.`);
            }
        }
        return {
            sourceLanguage: "WGSL",
            emittedSources: ["HLSL", "MSL"],
            compiledArtifacts: ["DXIL", "SPIR-V"],
            bindingContract: {
                vertexUniformSpace: 1,
                sampledTextureSpace: 2,
                fragmentUniformSpace: 3,
            },
            textureContract: {
                baseColor: "sRGB",
                emissive: "sRGB",
                normal: "linear",
                metallicRoughness: "linear",
                environment: "linear-rgba16f",
                brdfLut: "linear-rgba32f",
            },
            invariants: [
                {
                    id: "surface-msaa",
                    upstreamModule: surfaceModule,
                    upstreamMarker: "Defaults to `4`.",
                    nativeBehavior: "SDL_GPU requests 4x MSAA and resolves into the single-sample presentation or capture target.",
                    validation: ["source marker assertion", "edge MAD attribution"],
                },
                {
                    id: "pbr-skybox-mode",
                    upstreamModule: iblSkyboxModule,
                    upstreamMarker:
                        "let R = input.worldPos - scene.vEyePosition.xyz",
                    nativeBehavior:
                        "Skybox-mode PBR materials sample the environment along the camera-to-fragment ray with a dedicated unbiased skyboxAlphaG LOD and omit diffuse irradiance.",
                    validation: ["source marker assertion", "skybox gate parity"],
                },
                {
                    id: "scene-color-transmission",
                    upstreamModule: transmissionFrameGraphModule,
                    upstreamMarker:
                        "updateTransmissionTexture(state, engine)",
                    nativeBehavior:
                        "PAL renders linear RGBA16F scene color, copies completed opaque color and its pinned mip chain before the first transmissive draw, then applies image processing once to the final visible output.",
                    validation: [
                        "source marker assertion",
                        "scene-color gate parity",
                    ],
                },
                {
                    id: "ior-fresnel",
                    upstreamModule: dielectricLoaderModule,
                    upstreamMarker:
                        "((ior - 1) / (ior + 1)) ** 2 / 0.04",
                    nativeBehavior:
                        "KHR_materials_ior maps to dielectric F0=((ior-1)/(ior+1))^2 and the transmitted lobe uses the Fresnel complement.",
                    validation: ["source marker assertion", "IOR gate parity"],
                },
                {
                    id: "volume-beer-lambert",
                    upstreamModule: refractionModule,
                    upstreamMarker:
                        "let ab=exp(material.volumeParams.rgb*th)",
                    nativeBehavior:
                        "KHR_materials_volume attenuation uses exp(log(attenuationColor)/attenuationDistance * thickness).",
                    validation: [
                        "source marker assertion",
                        "volume gate parity",
                    ],
                },
                {
                    id: "clearcoat-layer",
                    upstreamModule: clearcoatFragmentModule,
                    upstreamMarker:
                        "let ccConservation_ibl = 1.0 - ccFresnelIBL * ccInt_ibl;",
                    nativeBehavior:
                        "KHR_materials_clearcoat adds a GGX/Kelemen direct lobe and a Jones analytical IBL lobe, attenuates the base layer by 1-F(ccF0)*intensity, and keeps the glTF loader's disabled F0 remap.",
                    validation: [
                        "source marker assertion",
                        "scene 28 GPU parity",
                    ],
                },
                {
                    id: "sheen-layer",
                    upstreamModule: sheenFragmentModule,
                    upstreamMarker:
                        "sheenAlbedoScaling = 1.0 - shMax * shBrdf.b;",
                    nativeBehavior:
                        "KHR_materials_sheen uses the Charlie distribution with Ashikhmin visibility, samples the BRDF LUT blue channel at sheen roughness, and scales the base layer by 1-maxSheenColor*brdf.b.",
                    validation: [
                        "source marker assertion",
                        "scene 29 GPU parity",
                    ],
                },
                {
                    id: "iridescence-thin-film",
                    upstreamModule: iridescenceFragmentModule,
                    upstreamMarker:
                        "let opd=2.0*iridescenceIor*thickness*cosTheta2;",
                    nativeBehavior:
                        "KHR_materials_iridescence evaluates Babylon's thin-film airy summation in XYZ and blends the result into base F0 by the iridescence intensity.",
                    validation: [
                        "source marker assertion",
                        "scene 178 GPU parity",
                    ],
                },
                {
                    id: "dispersion-chromatic-refraction",
                    upstreamModule: dispersionWgslModule,
                    upstreamMarker:
                        "let spread=0.04*material.volumeParams.w*(realIOR-1.0);",
                    nativeBehavior:
                        "KHR_materials_dispersion splits the refracted scene-color ray into per-RGB etas using Babylon's 20/dispersion Abbe strength.",
                    validation: [
                        "source marker assertion",
                        "scene 212 GPU parity",
                    ],
                },
                {
                    id: "ggx-smith",
                    upstreamModule: pbrTemplateModule,
                    upstreamMarker: "roughness*roughness+0.0005; 0.5/(gl+gv)",
                    nativeBehavior: "GGX distribution and Smith correlated geometry use Babylon alphaG conventions.",
                    validation: ["source marker assertions", "GPU parity"],
                },
                {
                    id: "ibl-energy-conservation",
                    upstreamModule: iblFragmentModule,
                    upstreamMarker: "getEnergyConservationFactor",
                    nativeBehavior: "BRDF LUT reflectance is multiplied by Babylon's energy-conservation factor.",
                    validation: ["source marker assertions", "GPU parity"],
                },
                {
                    id: "ibl-horizon-occlusion",
                    upstreamModule: iblFragmentModule,
                    upstreamMarker: "environmentHorizonOcclusion",
                    nativeBehavior: "Normal-mapped IBL squares Babylon's saturated reflection-to-geometric-normal horizon term.",
                    validation: ["source marker assertions", "Scene 1 diagnostics"],
                },
                {
                    id: "ibl-specular-occlusion",
                    upstreamModule: iblFragmentModule,
                    upstreamMarker: "let seo = clamp",
                    nativeBehavior: "Specular environment reflectance uses Babylon's NdotV and ambient-occlusion polynomial.",
                    validation: ["source marker assertions", "Scene 1 diagnostics"],
                },
                {
                    id: "environment-lod",
                    upstreamModule: sceneUniformsModule,
                    upstreamMarker: "lodGenerationScale ?? 0.8",
                    nativeBehavior: "Cubemap mip selection uses log2(cubemapDim * alphaG) with the environment's pinned lodGenerationScale.",
                    validation: ["source marker assertions", "generated uniform tests"],
                },
                {
                    id: "brdf-lut-coordinates",
                    upstreamModule: iblFragmentModule,
                    upstreamMarker: "vec2<f32>(NdotV, roughness)",
                    nativeBehavior: "The BRDF LUT is sampled with NdotV on X and perceptual roughness on Y.",
                    validation: ["source marker assertions", "CPU/GPU visual parity"],
                },
                {
                    id: "environment-cubemap-orientation",
                    upstreamModule: iblFragmentModule,
                    upstreamMarker: "let R = rotateY(R_raw",
                    nativeBehavior: "Reflection and irradiance directions use Babylon's Y-axis environment rotation before cubemap sampling.",
                    validation: ["source marker assertions", "Scenes 1 and 8 parity"],
                },
                {
                    id: "rgbd-cubemap-y-flip",
                    upstreamModule: rgbdDecodeModule,
                    upstreamMarker: "select(g.y,d.y-1u-g.y,f)",
                    nativeBehavior: "RGBD cubemap rows are vertically reversed during SDL_GPU upload.",
                    validation: ["source marker assertion", "Scene 1 foreground parity"],
                },
                {
                    id: "image-processing",
                    upstreamModule: pbrHelperCoreModule,
                    upstreamMarker: "1.590579",
                    nativeBehavior: "Exposure, exponential tone mapping, gamma, and contrast follow Babylon constants and order.",
                    validation: ["source marker assertions", "GPU parity"],
                },
                {
                    id: "hdr-cubemap-skybox",
                    upstreamModule: backgroundHdrModule,
                    upstreamMarker: "buildHdrSkyboxRenderable",
                    nativeBehavior: "Compiled HDR RGBA16F cubemap mip zero is reused for the generated cubemap skybox with exposure, gamma, and contrast.",
                    validation: ["source marker assertions", "scene 8 GPU parity"],
                },
                {
                    id: "solid-skybox",
                    upstreamModule: backgroundSolidModule,
                    upstreamMarker: "buildSolidSkyboxRenderable",
                    nativeBehavior: "The clear-colour skybox an .env scene reaches without a DDS or HDR skybox is drawn as the pin's own cube, with its infinite-distance vertex stage and unconditional dither taken from the packaged WGSL.",
                    validation: ["packaged WGSL extraction", "scene 7 background attribution"],
                },
            ],
        };
    }

    /**
     * Prints one pinned arithmetic expression as C++, renaming identifiers
     * through a required map. This is how the TRS and Euler emissions below
     * pair term for term with the pinned writers: the C++ text flows from
     * the pinned AST through the shared `PinnedNumericLowerer` — double
     * operands, explicit parenthesization — and an identifier or operator
     * the map does not know fails generation instead of drifting.
     */
    private pinnedNumericExpression(
        file: ts.SourceFile,
        expression: ts.Expression,
        rename: ReadonlyMap<string, string>,
        calls: ReadonlyMap<
            string,
            (args: readonly string[]) => string
        > = new Map(),
    ): string {
        const lowerer = new PinnedNumericLowerer(file, {
            bindings: new Map(
                [...rename].map(
                    ([name, cpp]): [string, PinnedBinding] => [
                        name,
                        { cpp, type: "scalar" },
                    ],
                ),
            ),
            calls,
        });
        return lowerer.expression(expression);
    }

    /**
     * The pinned per-mesh light predicate, anchored arm by arm. The
     * emitted `light_affects_mesh` is a representation translation — the
     * pin keys Sets of string mesh ids where the records key index
     * vectors — so it cannot be lowered by the numeric translator, and
     * each arm's fold is justified against the shape asserted here: a
     * native mesh index is always a present id, so the pin's `!!meshId`
     * conjunct folds to true and its `!meshId` disjunct folds to false,
     * leaving exactly the two membership tests the emission carries, in
     * the pinned precedence (included wins when it is non-empty).
     */
    private assertPinnedAffectsMesh(): void {
        const { declaration } = this.context.functionDeclaration(
            "src/render/lights-ubo.ts",
            "affectsMesh",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "included"),
            "light.includedOnlyMeshIds",
            "Pinned affectsMesh included source",
        );
        const gate = this.context.findNodes(
            declaration,
            (node): node is ts.IfStatement => ts.isIfStatement(node),
        );
        if (gate.length !== 1) {
            this.context.contractError(
                declaration,
                "Pinned affectsMesh no longer forks once on the " +
                    "included list.",
            );
        }
        this.context.assertExpressionShape(
            gate[0]!.expression,
            "included?.size",
            "Pinned affectsMesh included gate",
        );
        const returns = this.context.findNodes(
            declaration,
            (node): node is ts.ReturnStatement =>
                ts.isReturnStatement(node) && node.expression !== undefined,
        );
        if (returns.length !== 2) {
            this.context.contractError(
                declaration,
                "Pinned affectsMesh no longer returns the two " +
                    "membership arms.",
            );
        }
        this.context.assertExpressionShape(
            returns[0]!.expression!,
            "!!meshId && included.has(meshId)",
            "Pinned affectsMesh included arm",
        );
        this.context.assertExpressionShape(
            returns[1]!.expression!,
            "!meshId || !light.excludedMeshIds?.has(meshId)",
            "Pinned affectsMesh excluded arm",
        );
    }

    /** A literal element read `base[<n>]`, or a contract error. */
    private pinnedElementIndex(
        expression: ts.Expression,
        base: string,
    ): number {
        const unwrapped = this.context.unwrapExpression(expression);
        if (
            ts.isElementAccessExpression(unwrapped) &&
            ts.isIdentifier(unwrapped.expression) &&
            unwrapped.expression.text === base &&
            ts.isNumericLiteral(unwrapped.argumentExpression)
        ) {
            return Number(unwrapped.argumentExpression.text);
        }
        return this.context.contractError(
            expression,
            `Expected an indexed read of '${base}'.`,
        );
    }


    /** The `<base>` or `<base> + <n>` offset of a pinned indexed store. */
    private pinnedStoreOffset(
        argument: ts.Expression,
        base: string,
    ): number {
        const unwrapped = this.context.unwrapExpression(argument);
        if (ts.isIdentifier(unwrapped) && unwrapped.text === base) {
            return 0;
        }
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            ts.isIdentifier(unwrapped.left) &&
            unwrapped.left.text === base &&
            ts.isNumericLiteral(unwrapped.right)
        ) {
            return Number(unwrapped.right.text);
        }
        return this.context.contractError(
            argument,
            `Expected a '${base}'-relative store offset.`,
        );
    }

    /**
     * The view-transpose body, derived from the pinned getViewMatrix store
     * map: which world component each view cell copies, and which three
     * world components each translation row folds against the eye. The
     * emitted double-then-store-once shape is the native contract; the
     * indices and the store kinds are the pin's, so a moved store changes
     * the emission and any other shape fails generation.
     */
    private pinnedViewMatrixBody(): string {
        const { file, declaration } = this.context.functionDeclaration(
            "src/camera/camera.ts",
            "getViewMatrix",
        );
        const worldSource = this.context.unwrapExpression(
            this.context.variableInitializer(declaration, "w"),
        );
        if (
            this.context.propertyPath(worldSource)?.join(".") !==
            "camera.worldMatrix"
        ) {
            this.context.contractError(
                worldSource,
                "Expected the pinned view transpose to read the camera world matrix.",
            );
        }
        const eyeNames = ["cx", "cy", "cz"] as const;
        const eyeIndices: number[] = [];
        for (const name of eyeNames) {
            const initializer = this.context.unwrapExpression(
                this.context.variableInitializer(declaration, name),
            );
            if (
                !ts.isConditionalExpression(initializer) ||
                this.context.numericValue(initializer.whenTrue, file) !== 0
            ) {
                this.context.contractError(
                    initializer,
                    `Expected the pinned eye component ${name} to zero under floating origin and read the world translation otherwise.`,
                );
            }
            eyeIndices.push(
                this.pinnedElementIndex(initializer.whenFalse, "w"),
            );
        }
        const stores = this.context.pinnedElementStores(declaration, "v");
        if (stores.length !== 16) {
            this.context.contractError(
                declaration,
                `Pinned getViewMatrix gained or lost stores (${stores.length} of 16); the emission no longer covers it.`,
            );
        }
        const lines = new Map<number, string>();
        for (const store of stores) {
            const index = this.context.numericValue(
                store.left.argumentExpression,
                file,
            );
            if (lines.has(index)) {
                this.context.contractError(
                    store.left,
                    `Pinned getViewMatrix stores v[${index}] twice.`,
                );
            }
            const rhs = this.context.unwrapExpression(store.right);
            if (ts.isNumericLiteral(rhs)) {
                const value = Number(rhs.text);
                if (value !== 0 && value !== 1) {
                    this.context.contractError(
                        rhs,
                        "Expected a 0 or 1 view-matrix constant.",
                    );
                }
                lines.set(
                    index,
                    `    view[${index}] = ${this.context.floatLiteral(value)};\n`,
                );
                continue;
            }
            if (
                ts.isElementAccessExpression(rhs) ||
                ts.isNonNullExpression(rhs)
            ) {
                lines.set(
                    index,
                    `    view[${index}] = world[${this.pinnedElementIndex(rhs, "w")}];\n`,
                );
                continue;
            }
            // The translation rows: -(w[a] * cx + w[b] * cy + w[c] * cz).
            if (
                !ts.isPrefixUnaryExpression(rhs) ||
                rhs.operator !== ts.SyntaxKind.MinusToken
            ) {
                this.context.contractError(
                    rhs,
                    "Expected a negated eye dot for the view translation.",
                );
            }
            const dot = this.context.unwrapExpression(rhs.operand);
            const products: ts.Expression[] = [];
            let cursor: ts.Expression = dot;
            while (
                ts.isBinaryExpression(cursor) &&
                cursor.operatorToken.kind === ts.SyntaxKind.PlusToken
            ) {
                products.unshift(cursor.right);
                cursor = this.context.unwrapExpression(cursor.left);
            }
            products.unshift(cursor);
            if (products.length !== eyeNames.length) {
                this.context.contractError(
                    dot,
                    "Expected a three-term eye dot for the view translation.",
                );
            }
            const worldTerms = products.map((product, term) => {
                const unwrapped = this.context.unwrapExpression(product);
                if (
                    !ts.isBinaryExpression(unwrapped) ||
                    unwrapped.operatorToken.kind !==
                        ts.SyntaxKind.AsteriskToken ||
                    this.context.propertyPath(unwrapped.right)?.join(".") !==
                        eyeNames[term]
                ) {
                    this.context.contractError(
                        product,
                        `Expected the view translation term ${term} to multiply ${eyeNames[term]}.`,
                    );
                }
                return this.pinnedElementIndex(unwrapped.left, "w");
            });
            lines.set(
                index,
                `    view[${index}] = static_cast<float>(\n` +
                    `        -(static_cast<double>(world[${worldTerms[0]}]) * cx +\n` +
                    `          static_cast<double>(world[${worldTerms[1]}]) * cy +\n` +
                    `          static_cast<double>(world[${worldTerms[2]}]) * cz));\n`,
            );
        }
        let body =
            `    const double cx = static_cast<double>(world[${eyeIndices[0]}]);\n` +
            `    const double cy = static_cast<double>(world[${eyeIndices[1]}]);\n` +
            `    const double cz = static_cast<double>(world[${eyeIndices[2]}]);\n` +
            "    std::array<float, 16> view{};\n";
        for (let index = 0; index < 16; index++) {
            const line = lines.get(index);
            if (!line) {
                this.context.contractError(
                    declaration,
                    `Pinned getViewMatrix no longer stores v[${index}].`,
                );
            }
            body += line;
        }
        return body;
    }

    /**
     * Anchors for the emitted draw-list rules: `append_draw`'s transparent
     * predicate is the pinned buildBindings fork, the bucket order sorts are
     * the pinned comparators, and the per-family transparency, order and
     * transmissive stamps plus the cull/winding forks behind
     * `render_pipeline_kind` are each paired with the pinned line they
     * transcribe, so a pin retune fails generation at the rule that moved.
     *
     * The pinned direct bucket (`r._direct`) folds into the native opaque
     * list: no reached renderable sets it (sprites and thin-instance culling
     * draw through their own native subsystems), and the fork asserted here
     * is what makes that fold visible the moment the pin grows a reached
     * direct renderable. The clockwise arms exist only under cull-none
     * because the generated glTF loader stamps `clockwise_front_face` only
     * for double-sided mirrored materials and rewinds single-sided mirrored
     * indices instead, mirroring the pin's frontFace="cw" through data.
     *
     * `order_draw_lists` adopts the pinned buildBindings rule: opaque and
     * direct draws sort by `renderable.order` alone, and because every
     * reachable family stamps one shared non-transparent order (proven by
     * `lowerOpaqueOrderStamp` on each generation) the emitted lists stay
     * in append order with nothing to reorder.
     *
     * `sort_transparent_draws` adopts the pinned sort center: both pinned
     * mesh families store `sortCenter` = the world-matrix translation
     * (`pbr-renderable.ts` / `standard-renderable.ts`, anchored below),
     * which the record carries as `instance_parent_matrix` composed with
     * the live TRS position and an imported clone root's post-deformation
     * translation — the retired scaled-rotated bounds center was an
     * invention of this port.
     */
    private assertPinnedDrawListRules(): void {
        const { declaration: buildBindings } =
            this.context.functionDeclaration(
                renderTaskModule,
                "buildBindings",
            );
        const bucketFork = this.context.findNodes(
            buildBindings,
            (node): node is ts.IfStatement =>
                ts.isIfStatement(node) &&
                node.elseStatement !== undefined,
        )[0];
        if (!bucketFork) {
            this.context.contractError(
                buildBindings,
                "Expected the pinned bucket fork.",
            );
        }
        this.context.assertExpressionShape(
            bucketFork.expression,
            "r.isTransparent || r._transmissive",
            "Pinned transparent bucket predicate",
        );
        const bucketStore = (
            statement: ts.Statement | undefined,
            expected: string,
        ): void => {
            const push = statement
                ? this.context.findNodes(
                      statement,
                      (node): node is ts.ExpressionStatement =>
                          ts.isExpressionStatement(node),
                  )[0]
                : undefined;
            if (!push) {
                this.context.contractError(
                    bucketFork,
                    `Expected the pinned bucket store '${expected}'.`,
                );
            }
            this.context.assertExpressionShape(
                push.expression,
                expected,
                "Pinned bucket store",
            );
        };
        bucketStore(
            bucketFork.thenStatement,
            "transparent.push(binding)",
        );
        const directFork = bucketFork.elseStatement;
        if (!directFork || !ts.isIfStatement(directFork)) {
            this.context.contractError(
                bucketFork,
                "Expected the pinned direct bucket fork.",
            );
        }
        this.context.assertExpressionShape(
            directFork.expression,
            "r._direct",
            "Pinned direct bucket predicate",
        );
        bucketStore(directFork.thenStatement, "direct.push(binding)");
        bucketStore(directFork.elseStatement, "opaque.push(binding)");
        const orderSorts = this.context.findNodes(
            buildBindings,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === "sort",
        );
        const sortedBuckets = ["opaque", "direct"] as const;
        if (orderSorts.length !== sortedBuckets.length) {
            this.context.contractError(
                buildBindings,
                `Pinned buildBindings sorts ${orderSorts.length} lists ` +
                    `(${sortedBuckets.length} expected).`,
            );
        }
        orderSorts.forEach((sort, index) => {
            const receiver =
                ts.isPropertyAccessExpression(sort.expression)
                    ? this.context
                          .propertyPath(sort.expression.expression)
                          ?.join(".")
                    : undefined;
            if (receiver !== sortedBuckets[index]) {
                this.context.contractError(
                    sort,
                    `Expected the pinned ${sortedBuckets[index]} order sort.`,
                );
            }
            const comparator = sort.arguments[0];
            if (
                !comparator ||
                (!ts.isArrowFunction(comparator) &&
                    !ts.isFunctionExpression(comparator)) ||
                ts.isBlock(comparator.body)
            ) {
                this.context.contractError(
                    sort,
                    "Expected a pinned order comparator.",
                );
            }
            this.context.assertExpressionShape(
                comparator.body,
                "a.renderable.order - b.renderable.order",
                "Pinned bucket order comparator",
            );
        });
        // The pinned stamps the emitted record rules transcribe: which
        // renderables are transparent or transmissive, the order constants
        // behind the fixed skybox/opaque/transparent/ground stage sequence
        // (0 and 200 are asserted with the background renderables above in
        // `lowerShaders`; 100/150/200 live in these rows), and the
        // cull/winding forks `render_pipeline_kind` enumerates.
        for (const [modulePath, marker, label] of [
            [
                "src/material/pbr/pbr-renderable.ts",
                "const isTransparent = (features2 & (PBR2_NO_COLOR_OUTPUT | PBR2_ESM_SHADOW_OUTPUT)) === 0 && (features & PBR_HAS_ALPHA_BLEND) !== 0;",
                "PBR transparency stamp",
            ],
            [
                "src/material/pbr/pbr-renderable.ts",
                "const order = mesh.renderOrder ?? (isTransparent || needsTaskRefraction ? 150 : 100);",
                "PBR order stamp",
            ],
            [
                "src/material/pbr/pbr-renderable.ts",
                "const needsTaskRefraction = !!mat._transmissive && (features2 & PBR2_HAS_REFRACTION) !== 0;",
                "PBR transmissive-draw predicate",
            ],
            [
                "src/material/pbr/pbr-renderable.ts",
                "_transmissive: needsTaskRefraction,",
                "PBR transmissive stamp",
            ],
            [
                "src/material/pbr/set-transmission.ts",
                "mat._transmissive = true;",
                "transmission material stamp",
            ],
            [
                dielectricLoaderModule,
                "const needsTransmission = !!eTx && (intensity > 0 || !!eTx.transmissionTexture);",
                "glTF transmission activation",
            ],
            [
                // 1.23 renamed `vertexAlphaBlend` to `colorAlphaBlend` and
                // widened it: a thin-instance fragment declaring RGBA alpha
                // now blends even without a mesh colour buffer. That arm is
                // unreachable here -- `pinned-standard-variants.ts` refuses
                // `MSH_HAS_INSTANCE_COLOR` outright -- so for every Standard
                // variant this port composes the predicate is the old one.
                "src/material/standard/standard-renderable.ts",
                "const isTransparent = !shadowOutput && ((features & HAS_OPACITY_TEXTURE) !== 0 || mat.alpha < 1 || colorAlphaBlend);",
                "Standard transparency stamp",
            ],
            [
                "src/material/standard/standard-renderable.ts",
                "order: mesh.renderOrder ?? (isTransparent ? 200 : 100),",
                "Standard order stamp",
            ],
            [
                "src/material/pbr/pbr-renderable.ts",
                "const sortCenter = isTransparent || needsTaskRefraction ? ([mesh.worldMatrix[12]!, mesh.worldMatrix[13]!, mesh.worldMatrix[14]!] as [number, number, number]) : null;",
                "PBR sort center",
            ],
            [
                "src/material/standard/standard-renderable.ts",
                "const sortCenter = [mesh.worldMatrix[12]!, mesh.worldMatrix[13]!, mesh.worldMatrix[14]!] as [number, number, number];",
                "Standard sort center",
            ],
            [
                "src/material/shader/shader-renderable.ts",
                "const isTransparent = material.needAlphaBlending;",
                "shader-material transparency stamp",
            ],
            [
                "src/material/pbr/pbr-pipeline.ts",
                'cullMode: hasDoubleSided ? ("none" as GPUCullMode) : "back", ...composed._prim }',
                "PBR cull fork",
            ],
            [
                "src/material/standard/standard-pipeline.ts",
                'cullMode: features & DOUBLE_SIDED ? "none" : "back", frontFace: "ccw" }',
                "Standard cull fork",
            ],
            [
                shaderPipelineModule,
                'cullMode: material.backFaceCulling ? "back" : "none" }',
                "shader-material cull fork",
            ],
            [
                "src/loader-gltf/gltf-feature-primitive.ts",
                "const mirrored = mat4Determinant3(meshData._worldMatrix as unknown as ArrayLike<number>) > 0;",
                "mirrored-winding predicate",
            ],
            [
                "src/loader-gltf/gltf-feature-primitive.ts",
                'prim.frontFace = "cw";',
                "clockwise front face",
            ],
        ] as const) {
            if (
                !this.context.store.getSource(modulePath).includes(marker)
            ) {
                throw new Error(
                    `Pinned Babylon Lite ${label} changed: ${marker}`,
                );
            }
        }
    }

    /**
     * Anchors for the light-slot packing contract behind the emitted
     * `light_affects_mesh`: the pinned `affectsMesh` fork it transcribes,
     * and the two pinned packing loops whose slot arithmetic the PALs walk
     * against it — `writeMeshLightSelection` (per-mesh indices from
     * `MSH_LIGHT_INDEX_WORD_OFFSET`, count at word 16) and `fillLightsData`
     * (entries at `headerFloats + count * LIGHT_ENTRY_FLOATS`). Both loops
     * advance their slot cursor only for `_writeLightUbo` lights and stop at
     * `MAX_LIGHTS`; that shared walk is the invariant that keeps a mesh's
     * packed indices aligned with the UBO slots, so any retune of either
     * loop fails generation here before a PAL can walk them differently.
     */
    private assertPinnedLightSlotPacking(): void {
        const lightsUboModule = "src/render/lights-ubo.ts";
        const { declaration: affects } =
            this.context.functionDeclaration(
                lightsUboModule,
                "affectsMesh",
            );
        this.context.assertExpressionShape(
            this.context.variableInitializer(affects, "meshId"),
            "mesh.id",
            "Pinned light-inclusion mesh id",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(affects, "included"),
            "light.includedOnlyMeshIds",
            "Pinned light inclusion list",
        );
        const affectsFork = this.context.findNodes(
            affects,
            (node): node is ts.IfStatement => ts.isIfStatement(node),
        )[0];
        if (!affectsFork) {
            this.context.contractError(
                affects,
                "Expected the pinned inclusion fork.",
            );
        }
        this.context.assertExpressionShape(
            affectsFork.expression,
            "included?.size",
            "Pinned inclusion-list predicate",
        );
        const affectsReturns = this.context.findNodes(
            affects,
            (node): node is ts.ReturnStatement =>
                ts.isReturnStatement(node),
        );
        if (
            affectsReturns.length !== 2 ||
            !affectsReturns[0]?.expression ||
            !affectsReturns[1]?.expression
        ) {
            this.context.contractError(
                affects,
                "Expected the pinned two-arm affectsMesh.",
            );
        }
        this.context.assertExpressionShape(
            affectsReturns[0].expression,
            "!!meshId && included.has(meshId)",
            "Pinned included-mesh arm",
        );
        this.context.assertExpressionShape(
            affectsReturns[1].expression,
            "!meshId || !light.excludedMeshIds?.has(meshId)",
            "Pinned excluded-mesh arm",
        );

        const { declaration: selection } =
            this.context.functionDeclaration(
                lightsUboModule,
                "writeMeshLightSelection",
            );
        const selectionGuards: ReadonlyArray<readonly [string, string]> = [
            ["pi >= MAX_LIGHTS", "Pinned light-slot cursor break"],
            ["!light._writeLightUbo", "Pinned light-slot eligibility skip"],
            ["affectsMesh(light, mesh)", "Pinned per-mesh light test"],
            ["u32", "Pinned light-index write guard"],
            ["u32", "Pinned light-count write guard"],
        ];
        const selectionIfs = this.context.findNodes(
            selection,
            (node): node is ts.IfStatement => ts.isIfStatement(node),
        );
        if (selectionIfs.length !== selectionGuards.length) {
            this.context.contractError(
                selection,
                `Pinned writeMeshLightSelection has ${selectionIfs.length} ` +
                    `guards (${selectionGuards.length} expected).`,
            );
        }
        selectionIfs.forEach((guard, index) => {
            this.context.assertExpressionShape(
                guard.expression,
                selectionGuards[index]![0],
                selectionGuards[index]![1],
            );
        });
        const selectionStores = this.context.pinnedElementStores(
            selection,
            "u32",
        );
        const expectedSelectionStores: ReadonlyArray<
            readonly [offset: string, value: string, label: string]
        > = [
            [
                "MSH_LIGHT_INDEX_WORD_OFFSET + count",
                "pi",
                "Pinned per-mesh light index store",
            ],
            ["16", "count", "Pinned per-mesh light count store"],
            [
                "MSH_LIGHT_INDEX_WORD_OFFSET + i",
                "0",
                "Pinned light index zero fill",
            ],
        ];
        if (selectionStores.length !== expectedSelectionStores.length) {
            this.context.contractError(
                selection,
                `Pinned writeMeshLightSelection stores ${selectionStores.length} ` +
                    `words (${expectedSelectionStores.length} expected).`,
            );
        }
        selectionStores.forEach((store, index) => {
            const [offset, value, label] = expectedSelectionStores[index]!;
            this.context.assertExpressionShape(
                store.left.argumentExpression,
                offset,
                `${label} offset`,
            );
            this.context.assertExpressionShape(
                store.right,
                value,
                label,
            );
        });
        const selectionReturn = this.context.findNodes(
            selection,
            (node): node is ts.ReturnStatement =>
                ts.isReturnStatement(node),
        )[0];
        if (!selectionReturn?.expression) {
            this.context.contractError(
                selection,
                "Expected the pinned selection encoding.",
            );
        }
        this.context.assertExpressionShape(
            selectionReturn.expression,
            "count === 1 ? single + 1 : -count",
            "Pinned single-light encoding",
        );

        const { declaration: fill } = this.context.functionDeclaration(
            lightsUboModule,
            "fillLightsData",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(fill, "headerFloats"),
            "4",
            "Pinned lights-UBO header size",
        );
        const fillGuards: ReadonlyArray<readonly [string, string]> = [
            ["count >= MAX_LIGHTS", "Pinned lights-UBO slot break"],
            ["!light._writeLightUbo", "Pinned lights-UBO eligibility skip"],
        ];
        const fillIfs = this.context.findNodes(
            fill,
            (node): node is ts.IfStatement => ts.isIfStatement(node),
        );
        if (fillIfs.length !== fillGuards.length) {
            this.context.contractError(
                fill,
                `Pinned fillLightsData has ${fillIfs.length} guards ` +
                    `(${fillGuards.length} expected).`,
            );
        }
        fillIfs.forEach((guard, index) => {
            this.context.assertExpressionShape(
                guard.expression,
                fillGuards[index]![0],
                fillGuards[index]![1],
            );
        });
        const slotWrite = this.context.findNodes(
            fill,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === "_writeLightUbo",
        )[0];
        if (!slotWrite) {
            this.context.contractError(
                fill,
                "Expected the pinned light-entry write.",
            );
        }
        this.context.assertExpressionShape(
            slotWrite,
            "light._writeLightUbo(data, headerFloats + count * LIGHT_ENTRY_FLOATS)",
            "Pinned light-entry slot arithmetic",
        );
        const countStores = this.context.pinnedElementStores(fill, "_countU32");
        const headerStores = this.context.pinnedElementStores(fill, "data");
        if (countStores.length !== 1 || headerStores.length !== 1) {
            this.context.contractError(
                fill,
                "Expected the pinned count bit-pattern stores.",
            );
        }
        this.context.assertExpressionShape(
            countStores[0]!.left.argumentExpression,
            "0",
            "Pinned count word offset",
        );
        this.context.assertExpressionShape(
            countStores[0]!.right,
            "count",
            "Pinned count word value",
        );
        this.context.assertExpressionShape(
            headerStores[0]!.left.argumentExpression,
            "0",
            "Pinned count float slot",
        );
        this.context.assertExpressionShape(
            headerStores[0]!.right,
            "_countF32[0]",
            "Pinned count bit pattern",
        );
    }

    /**
     * The ±half / zero / numeric elements of one pinned typed-array buffer
     * literal (`new F32([...])` or `new U16([...])`): ±`halfName` tokens map
     * to ±1 and every other element must be a numeric constant. This is how
     * the background geometry tables flow from the pinned builders instead
     * of being restated by hand.
     */
    private pinnedBufferValues(
        declaration: ts.Node,
        file: ts.SourceFile,
        name: string,
        halfName: string,
    ): number[] {
        const initializer = this.context.unwrapExpression(
            this.context.variableInitializer(declaration, name),
        );
        if (
            !ts.isNewExpression(initializer) ||
            initializer.arguments?.length !== 1
        ) {
            this.context.contractError(
                initializer,
                `Expected a pinned typed-array literal for '${name}'.`,
            );
        }
        const array = this.context.unwrapExpression(
            initializer.arguments[0]!,
        );
        if (!ts.isArrayLiteralExpression(array)) {
            this.context.contractError(
                array,
                `Expected a pinned array literal for '${name}'.`,
            );
        }
        return array.elements.map((element) => {
            const unwrapped = this.context.unwrapExpression(element);
            if (
                ts.isIdentifier(unwrapped) &&
                unwrapped.text === halfName
            ) {
                return 1;
            }
            if (
                ts.isPrefixUnaryExpression(unwrapped) &&
                unwrapped.operator === ts.SyntaxKind.MinusToken
            ) {
                const operand = this.context.unwrapExpression(
                    unwrapped.operand,
                );
                if (
                    ts.isIdentifier(operand) &&
                    operand.text === halfName
                ) {
                    return -1;
                }
            }
            return this.context.numericValue(element, file);
        });
    }

    /**
     * The background geometry tables, derived from the pinned builders the
     * way the factory lowerer derives box and plane: corner signs, UVs and
     * index winding flow from the pinned buffer literals into the emitted
     * C++, so a retuned table changes the emission and anything else fails
     * generation.
     *
     * - The ground quad flows from `createGroundBuffers` (XY plane at z=0,
     *   BACKSIDE winding) composed with the `createBgMeshUBO` world matrix
     *   (rotate XY to XZ, translate to the scene root), which the emission
     *   bakes into the vertices: world = (x + tx, ty + y*eps, tz - y). The
     *   two epsilon lanes (2.220446049250313e-16, asserted below) are
     *   dropped as 0 — for the reached ground sizes they perturb y by under
     *   1e-13 of a unit, orders of magnitude below f32 vertex precision —
     *   and the same drop turns the rotated normal (0, 1, eps) into the
     *   emitted (0, 1, 0). The ModelVertex tangent lane is the record
     *   filler; no background stage declares a tangent input.
     * - The skybox cube flows from `createSkyboxBuffers`, which the pin
     *   carries in three identical copies (DDS, HDR, solid); the flow
     *   requires them equal and serves build_skybox_plan and
     *   build_solid_skybox_plan from the shared table.
     * - The image skybox borrows the same pinned corner/index table: its
     *   pinned mesh is `createBoxData(size)` — 24 vertices spanning
     *   ±size/2 (span asserted below) drawn cull-none — and the borrowed
     *   8-corner triangulation covers the identical cube surface, over
     *   which the sampled direction interpolates identically per face.
     */
    private pinnedBackgroundGeometry(): {
        groundVertexRows: string;
        groundIndexRow: string;
        groundAlpha: string;
        skyboxVertexRows: string;
        skyboxCornerRows: string;
        skyboxIndexRows: string;
    } {
        const ground = this.context.functionDeclaration(
            backgroundGroundModule,
            "createGroundBuffers",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(ground.declaration, "h"),
            "groundSize / 2",
            "Pinned ground half extent",
        );
        const groundPositions = this.pinnedBufferValues(
            ground.declaration,
            ground.file,
            "positions",
            "h",
        );
        const groundNormals = this.pinnedBufferValues(
            ground.declaration,
            ground.file,
            "normals",
            "h",
        );
        const groundUvs = this.pinnedBufferValues(
            ground.declaration,
            ground.file,
            "uvs",
            "h",
        );
        const groundIndices = this.pinnedBufferValues(
            ground.declaration,
            ground.file,
            "indices",
            "h",
        );
        if (
            groundPositions.length !== 12 ||
            groundNormals.length !== 12 ||
            groundUvs.length !== 8 ||
            groundIndices.length !== 6
        ) {
            this.context.contractError(
                ground.declaration,
                "Pinned ground quad changed shape; the emitted BackgroundPlan no longer covers it.",
            );
        }
        const groundSource = this.context.store.getSource(
            backgroundGroundModule,
        );
        for (const [marker, what] of [
            [
                "const eps = 2.220446049250313e-16;",
                "ground world epsilon",
            ],
            ["data[0] = data[15] = 1;", "ground world unit lanes"],
            ["data[5] = data[10] = eps;", "ground world epsilon lanes"],
            ["data[6] = -1;", "ground world -y-to-z lane"],
            ["data[9] = 1;", "ground world y-to-z lane"],
            ["data[12] = rootPosition[0];", "ground world translation x"],
            ["data[13] = rootPosition[1];", "ground world translation y"],
            ["data[14] = rootPosition[2];", "ground world translation z"],
            ["data[20] = 0;", "ground background-center x"],
            ["data[21] = 0;", "ground background-center y"],
            ["data[22] = 0;", "ground background-center z"],
        ] as const) {
            if (!groundSource.includes(marker)) {
                throw new Error(
                    `Pinned Babylon Lite ${what} changed ('${marker}' is gone).`,
                );
            }
        }
        const groundUbo = this.context.functionDeclaration(
            backgroundGroundModule,
            "createBgMeshUBO",
        );
        const alphaStore = this.context.pinnedElementStores(
            groundUbo.declaration,
            "data",
        ).find(
            (store) =>
                ts.isNumericLiteral(store.left.argumentExpression) &&
                Number(store.left.argumentExpression.text) === 19,
        );
        if (!alphaStore) {
            this.context.contractError(
                groundUbo.declaration,
                "Pinned ground alpha store moved.",
            );
        }
        const groundAlpha = this.context.floatLiteral(
            this.context.numericValue(alphaStore.right, groundUbo.file),
        );
        const groundVertexRows: string[] = [];
        for (let corner = 0; corner < 4; corner++) {
            const x = groundPositions[corner * 3]!;
            const y = groundPositions[corner * 3 + 1]!;
            if (
                (x !== 1 && x !== -1) ||
                (y !== 1 && y !== -1) ||
                groundPositions[corner * 3 + 2] !== 0 ||
                groundNormals[corner * 3] !== 0 ||
                groundNormals[corner * 3 + 1] !== 0 ||
                groundNormals[corner * 3 + 2] !== 1
            ) {
                this.context.contractError(
                    ground.declaration,
                    `Pinned ground corner ${corner} left the authored XY plane.`,
                );
            }
            const u = groundUvs[corner * 2]!;
            const v = groundUvs[corner * 2 + 1]!;
            if ((u !== 0 && u !== 1) || (v !== 0 && v !== 1)) {
                this.context.contractError(
                    ground.declaration,
                    `Pinned ground corner ${corner} UV left the unit square.`,
                );
            }
            groundVertexRows.push(
                `        ModelVertex{Vec3{center.x ${
                    x < 0 ? "-" : "+"
                } half, center.y, center.z ${
                    y < 0 ? "+" : "-"
                } half}, Vec3{0.0f, 1.0f, 0.0f}, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{${this.context.floatLiteral(
                    u,
                )}, ${this.context.floatLiteral(v)}}},`,
            );
        }

        const skyboxModules = [
            backgroundDdsModule,
            backgroundHdrModule,
            backgroundSolidModule,
        ] as const;
        let corners: number[] | undefined;
        let cubeIndices: number[] | undefined;
        for (const modulePath of skyboxModules) {
            const cube = this.context.functionDeclaration(
                modulePath,
                "createSkyboxBuffers",
            );
            const positions = this.pinnedBufferValues(
                cube.declaration,
                cube.file,
                "positions",
                "S",
            );
            const indices = this.pinnedBufferValues(
                cube.declaration,
                cube.file,
                "indices",
                "S",
            );
            if (
                positions.length !== 24 ||
                positions.some((value) => value !== 1 && value !== -1) ||
                indices.length !== 36 ||
                indices.some(
                    (value) =>
                        !Number.isInteger(value) ||
                        value < 0 ||
                        value >= 8,
                )
            ) {
                this.context.contractError(
                    cube.declaration,
                    `Pinned skybox cube in ${modulePath} changed shape.`,
                );
            }
            if (!corners || !cubeIndices) {
                corners = positions;
                cubeIndices = indices;
                continue;
            }
            if (
                positions.some(
                    (value, index) => value !== corners![index],
                ) ||
                indices.some(
                    (value, index) => value !== cubeIndices![index],
                )
            ) {
                this.context.contractError(
                    cube.declaration,
                    `Pinned skybox cube in ${modulePath} disagrees with ${skyboxModules[0]}.`,
                );
            }
        }
        const cornerRow = (corner: number): string =>
            [0, 1, 2]
                .map((axis) =>
                    corners![corner * 3 + axis]! < 0 ? "-half" : "half",
                )
                .join(", ");
        const skyboxVertexRows: string[] = [];
        const skyboxCornerRows: string[] = [];
        for (let corner = 0; corner < 8; corner++) {
            skyboxVertexRows.push(`        vertex(${cornerRow(corner)}),`);
            skyboxCornerRows.push(`        {${cornerRow(corner)}},`);
        }
        const skyboxIndexRows: string[] = [];
        for (let triangle = 0; triangle < 36; triangle += 6) {
            skyboxIndexRows.push(
                `        ${cubeIndices!
                    .slice(triangle, triangle + 6)
                    .join(", ")},`,
            );
        }

        // The image skybox's pinned mesh is createBoxData(size); assert its
        // ±size/2 span so the borrowed corner table above keeps covering the
        // pinned cube surface.
        const box = this.context.functionDeclaration(
            "src/mesh/create-box.ts",
            "createBoxData",
        );
        const boxStore = this.context.pinnedElementStores(
            box.declaration,
            "positions",
        )[0];
        if (!boxStore) {
            this.context.contractError(
                box.declaration,
                "Expected the pinned box position store.",
            );
        }
        this.context.assertExpressionShape(
            boxStore.right,
            "(sign - 0.5) * dimensions[index % 3]",
            "Pinned box half-extent span",
        );

        return {
            groundVertexRows: groundVertexRows.join("\n"),
            groundIndexRow: groundIndices.join(", "),
            groundAlpha,
            skyboxVertexRows: skyboxVertexRows.join("\n"),
            skyboxCornerRows: skyboxCornerRows.join("\n"),
            skyboxIndexRows: skyboxIndexRows.join("\n"),
        };
    }

    /**
     * The thin-instance TRS emissions, derived from their pinned writers:
     * eulerToQuat's four products and mat4ComposeInto's quaternion basis
     * flow from the pinned ASTs into the emitted C++ term for term, so the
     * instance parent-world stays byte-for-byte the pin's composition.
     */
    private pinnedTrsComposition(): {
        halfAngleLocals: string;
        quaternionProducts: string;
        basisLocals: string;
        basisStores: string;
    } {
        const euler = this.context.functionDeclaration(
            "src/math/quat-euler.ts",
            "eulerToQuat",
        );
        // The half-angle locals, emitted from the pinned initializers with
        // the Euler parameters renamed to the record's rotation lanes. One
        // pair table serves this emission and the quaternion products'
        // rename below.
        const rotationRename = new Map<string, string>([
            ["rx", "static_cast<double>(mesh.rotation.x)"],
            ["ry", "static_cast<double>(mesh.rotation.y)"],
            ["rz", "static_cast<double>(mesh.rotation.z)"],
        ]);
        const eulerLocalNames: readonly (readonly [string, string])[] = [
            ["cx", "cx"],
            ["sx_", "sx"],
            ["cy", "cy"],
            ["sy_", "sy"],
            ["cz", "cz"],
            ["sz_", "sz"],
        ];
        const mathCalls = pinnedNumericMathCalls();
        const halfAngleLocals = eulerLocalNames
            .map(
                ([pinned, cpp]) =>
                    `        const double ${cpp} = ${this.pinnedNumericExpression(
                        euler.file,
                        this.context.variableInitializer(
                            euler.declaration,
                            pinned,
                        ),
                        rotationRename,
                        mathCalls,
                    )};\n`,
            )
            .join("");
        const eulerReturn = this.context.findNodes(
            euler.declaration,
            (node): node is ts.ReturnStatement =>
                ts.isReturnStatement(node),
        )[0];
        const tuple = eulerReturn?.expression
            ? this.context.unwrapExpression(eulerReturn.expression)
            : undefined;
        if (
            !tuple ||
            !ts.isArrayLiteralExpression(tuple) ||
            tuple.elements.length !== 4
        ) {
            this.context.contractError(
                eulerReturn ?? euler.declaration,
                "Expected the pinned Euler quaternion tuple.",
            );
        }
        const eulerRename = new Map<string, string>(eulerLocalNames);
        const quaternionSlots = ["qx", "qy", "qz", "qw"];
        const quaternionProducts = tuple.elements
            .map(
                (component, index) =>
                    `        ${quaternionSlots[index]} = ${this.pinnedNumericExpression(
                        euler.file,
                        component,
                        eulerRename,
                    )};\n`,
            )
            .join("");

        const compose = this.context.functionDeclaration(
            "src/math/mat4-compose-into.ts",
            "mat4ComposeInto",
        );
        const productNames = [
            "xx",
            "yy",
            "zz",
            "xy",
            "xz",
            "yz",
            "wx",
            "wy",
            "wz",
        ];
        const quaternionRename = new Map<string, string>([
            ["qx", "qx"],
            ["qy", "qy"],
            ["qz", "qz"],
            ["qw", "qw"],
        ]);
        const basisLocals = productNames
            .map(
                (name) =>
                    `    const double ${name} = ${this.pinnedNumericExpression(
                        compose.file,
                        this.context.variableInitializer(
                            compose.declaration,
                            name,
                        ),
                        quaternionRename,
                    )};\n`,
            )
            .join("");
        const storeRename = new Map<string, string>([
            ...productNames.map(
                (name) => [name, name] as [string, string],
            ),
            ["sx", "scale_x"],
            ["sy", "scale_y"],
            ["sz", "scale_z"],
        ]);
        const translationStores = new Map<string, string>([
            ["tx", "mesh.position.x"],
            ["ty", "mesh.position.y"],
            ["tz", "mesh.position.z"],
        ]);
        const stores = this.context.pinnedElementStores(
            compose.declaration,
            "dst",
        );
        if (stores.length !== 16) {
            this.context.contractError(
                compose.declaration,
                `Pinned mat4ComposeInto gained or lost stores (${stores.length} of 16); the instance emission no longer covers it.`,
            );
        }
        let basisStores = "";
        for (const store of stores) {
            const offset = this.pinnedStoreOffset(
                store.left.argumentExpression,
                "off",
            );
            const rhs = this.context.unwrapExpression(store.right);
            if (ts.isNumericLiteral(rhs)) {
                const value = Number(rhs.text);
                if (value === 0) {
                    // The zero cells stay the zero-initialized locals.
                    continue;
                }
                basisStores += `    local[${offset}] = ${this.context.doubleLiteral(value)};\n`;
                continue;
            }
            if (ts.isIdentifier(rhs)) {
                const translation = translationStores.get(rhs.text);
                if (translation === undefined) {
                    this.context.contractError(
                        rhs,
                        `Pinned mat4ComposeInto stores '${rhs.text}', which the instance emission does not map.`,
                    );
                }
                basisStores += `    local[${offset}] = ${translation};\n`;
                continue;
            }
            basisStores += `    local[${offset}] = ${this.pinnedNumericExpression(
                compose.file,
                rhs,
                storeRename,
            )};\n`;
        }
        return {
            halfAngleLocals,
            quaternionProducts,
            basisLocals,
            basisStores,
        };
    }

    /**
     * The solid skybox's two WGSL stages ship as `?raw` string literals with no
     * source-map entry, so they are read out of the packaged module text — the
     * vertex stage from the shared chunk `background-solid-skybox.js` imports,
     * which keeps the pin's content hash out of this file.
     */
    private pinnedSolidSkyboxSource(): PinnedSolidSkyboxSource {
        const packageRoot = this.context.store.packageRoot;
        const modulePath = resolve(
            packageRoot,
            "lib/material/pbr/background-solid-skybox.js",
        );
        const module = readFileSync(modulePath, "utf8");
        const chunk =
            /import \{ s as skyboxVertSrc \} from '(\.\.\/\.\.\/_chunks\/[^']+)'/.exec(
                module,
            );
        if (!chunk) {
            throw new Error(
                "Pinned Babylon Lite solid skybox no longer imports the shared skybox vertex chunk.",
            );
        }
        const vertexModule = readFileSync(
            resolve(packageRoot, "lib/material/pbr", chunk[1]!),
            "utf8",
        );
        return {
            vertex: rawWgslLiteral(vertexModule, "skyboxVertSrc"),
            fragment: rawWgslLiteral(module, "skyboxFragSrc"),
            sceneUniforms: this.compiledSceneUniformsWgsl(),
            dither: readPinnedDitherWgsl(packageRoot).dither,
        };
    }
}

/**
 * Read one `const <name> = "...";` WGSL literal out of a packaged module. The
 * bundler emits these as single-line double-quoted JavaScript strings, so the
 * value is recovered by scanning to the closing quote and parsing it as JSON
 * rather than by a regex that would have to model every escape.
 */
function rawWgslLiteral(source: string, name: string): string {
    const marker = `const ${name} = "`;
    const start = source.indexOf(marker);
    if (start < 0) {
        throw new Error(
            `Pinned Babylon Lite WGSL literal '${name}' was not found.`,
        );
    }
    let index = start + marker.length;
    let escaped = "";
    while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\") {
            escaped += source[index]! + (source[index + 1] ?? "");
            index += 2;
            continue;
        }
        escaped += source[index];
        index += 1;
    }
    if (index >= source.length) {
        throw new Error(
            `Pinned Babylon Lite WGSL literal '${name}' is unterminated.`,
        );
    }
    return JSON.parse(`"${escaped}"`) as string;
}
