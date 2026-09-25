import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    type PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

const renderTaskModule = "src/frame-graph/render-task-base.ts";
const sceneModule = "src/scene/scene-core.ts";

/**
 * The first expression `declaration` assigns to `target` (`att.clearValue =
 * ...`), which the pin writes once per pass.
 */
function assignedValue(
    context: LoweringContext,
    declaration: ts.Node,
    target: string,
): ts.Expression {
    const file = declaration.getSourceFile();
    const stores = context.findNodes(
        declaration,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            node.left.getText(file) === target,
    );
    const store = stores[0];
    if (stores.length !== 1 || !store) {
        return context.contractError(
            declaration,
            `Expected one '${target}' store.`,
        );
    }
    return store.right;
}

/**
 * The guard `declaration` opens its body's `index`-th statement with, which
 * must return nothing and do nothing else.
 */
function bareReturnGuard(
    context: LoweringContext,
    declaration: ts.FunctionDeclaration,
    index: number,
    what: string,
): ts.IfStatement {
    const guard = declaration.body?.statements[index];
    if (
        !guard ||
        !ts.isIfStatement(guard) ||
        guard.elseStatement !== undefined
    ) {
        return context.contractError(
            declaration,
            `Expected ${what} to open with one early return.`,
        );
    }
    const then = guard.thenStatement;
    const returns =
        ts.isBlock(then) &&
        then.statements.length === 1 &&
        ts.isReturnStatement(then.statements[0]!) &&
        then.statements[0].expression === undefined;
    if (!returns) {
        return context.contractError(
            guard,
            `Expected ${what}'s guard to return and do nothing else.`,
        );
    }
    return guard;
}

/**
 * How a render pass resolves what it renders through, lowered from
 * render-task-base.ts: the camera (`task._config.cam ?? sc.camera`, which
 * `prepareRenderTaskPass` hands the scene block, the clustered updater, the
 * bindings and the transparent sort, and `executePassBody` the viewport) and
 * the clear colour (`cfg.clrColor ?? sc.clearColor`, read live in
 * `executePass`). A null camera is the pin's camera-less pass:
 * `_writePassSceneUBO` returns before writing a scene block, and every
 * per-renderable arm that needs one returns on its own test.
 *
 * `createSceneContext`'s automatic task names neither, so a scene's own
 * pass -- the base scene's, a swapchain overlay's, a utility layer's --
 * resolves its scene's camera and clear colour through the same two
 * functions with nothing configured.
 */
export function renderTaskPassCpp(context: LoweringContext): string {
    const prepare = context.functionDeclaration(
        renderTaskModule,
        "prepareRenderTaskPass",
    );
    const execute = context.functionDeclaration(
        renderTaskModule,
        "executePass",
    );
    const body = context.functionDeclaration(
        renderTaskModule,
        "executePassBody",
    );
    const camera = context.variableInitializer(prepare.declaration, "camera");
    context.assertExpressionShape(
        context.variableInitializer(prepare.declaration, "sc"),
        "task.scene as SceneContext",
        "prepareRenderTaskPass scene",
    );
    // `executePassBody` sets the viewport from the same resolution over its
    // own aliases of the task's config and scene.
    context.assertExpressionShape(
        context.variableInitializer(body.declaration, "camera"),
        "cfg.cam ?? scene.camera",
        "executePassBody camera",
    );
    context.assertExpressionShape(
        context.variableInitializer(body.declaration, "cfg"),
        "task._config",
        "executePassBody config",
    );
    context.assertExpressionShape(
        context.variableInitializer(execute.declaration, "cfg"),
        "task._config",
        "executePass config",
    );
    context.assertExpressionShape(
        context.variableInitializer(execute.declaration, "sc"),
        "task.scene",
        "executePass scene",
    );
    const clear = assignedValue(context, execute.declaration, "att.clearValue");
    const sceneBlock = context.functionDeclaration(
        renderTaskModule,
        "_writePassSceneUBO",
    );
    const sceneBlockGuard = bareReturnGuard(
        context,
        sceneBlock.declaration,
        0,
        "_writePassSceneUBO",
    );
    const sceneBlockSkipCpp = new PinnedNumericLowerer(sceneBlock.file, {
        bindings: new Map<string, PinnedBinding>([
            [
                "camera",
                {
                    cpp: "camera",
                    type: "opaque",
                    absentCpp: "camera == nullptr",
                },
            ],
        ]),
        calls: new Map(),
    }).expression(sceneBlockGuard.expression);
    // The scene's own automatic task configures neither override.
    const defaults = context.functionDeclaration(
        sceneModule,
        "createSceneContext",
    );
    const automatic = context
        .findNodes(
            defaults.declaration,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                node.expression.getText(defaults.file) ===
                    "_createAutomaticRenderTask",
        )
        .map((call) => call.arguments[0])
        .filter(
            (argument): argument is ts.ObjectLiteralExpression =>
                argument !== undefined &&
                ts.isObjectLiteralExpression(argument),
        );
    if (
        automatic.length !== 1 ||
        automatic[0]!.properties.some((property) => {
            const name = property.name
                ? context.propertyName(property.name)
                : undefined;
            return name === "cam" || name === "clrColor";
        })
    ) {
        context.contractError(
            defaults.declaration,
            "Expected createSceneContext's automatic render task to configure no camera and no clear colour.",
        );
    }
    const cameraCpp = new PinnedNumericLowerer(prepare.file, {
        bindings: new Map<string, PinnedBinding>([
            [
                "task._config.cam",
                {
                    cpp: "configured",
                    type: "opaque",
                    nullish: "configured == nullptr",
                },
            ],
            ["sc.camera", { cpp: "scene_camera", type: "opaque" }],
        ]),
        calls: new Map(),
    }).expression(camera);
    const clearCpp = new PinnedNumericLowerer(execute.file, {
        bindings: new Map<string, PinnedBinding>([
            [
                "cfg.clrColor",
                {
                    cpp: "*configured",
                    type: "color4",
                    nullish: "!configured.has_value()",
                },
            ],
            ["sc.clearColor", { cpp: "scene_clear", type: "color4" }],
        ]),
        calls: new Map(),
    }).expression(clear);
    return `// ${context.provenance(
        renderTaskModule,
        "prepareRenderTaskPass,executePass,_writePassSceneUBO",
        `${sceneModule}#createSceneContext`,
    )}
/**
 * The camera a render pass renders through, \`task._config.cam ?? sc.camera\`;
 * null for the camera-less pass, which writes no scene block. A scene's own
 * pass configures none and passes null for \`configured\`. The mutable
 * overload serves the scene-block writer, which takes the record mutably.
 */
inline const CameraRecord* render_task_camera(
    const CameraRecord* configured,
    const CameraRecord* scene_camera) {
    return ${cameraCpp};
}

inline CameraRecord* render_task_camera(
    CameraRecord* configured,
    CameraRecord* scene_camera) {
    return ${cameraCpp};
}

/**
 * The colour a render pass clears to, \`cfg.clrColor ?? sc.clearColor\`, read
 * at the pass. A scene's own pass configures none.
 */
inline Color4 render_task_clear_color(
    const std::optional<Color4>& configured,
    const Color4& scene_clear) {
    return ${clearCpp};
}

/**
 * Whether the pass writes no scene block: \`_writePassSceneUBO\`'s own early
 * return, which leaves the task's scene UBO as it was.
 */
inline bool pass_scene_block_skips(const CameraRecord* camera) {
    return ${sceneBlockSkipCpp};
}`;
}

/**
 * camera.ts `_applyCameraViewport`, which every render task pass
 * (`executePassBody`, a scene's own automatic task included) and geometry
 * task pass (`executeTask`) calls on its own pass over its target's extent:
 * the pixel rectangle its viewport and scissor are set to, or none for a
 * pass camera without a viewport, which leaves the whole target. The pin
 * clamps nothing here, unlike `resolveCameraViewport`.
 */
export function passCameraViewportCpp(context: LoweringContext): string {
    const module = "src/camera/camera.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "_applyCameraViewport",
    );
    context.assertExpressionShape(
        context.variableInitializer(declaration, "v"),
        "camera?.viewport",
        "_applyCameraViewport viewport",
    );
    const guard = bareReturnGuard(
        context,
        declaration,
        1,
        "_applyCameraViewport",
    );
    const statements = declaration.body?.statements ?? [];
    const calls = statements.slice(6);
    const expected = [
        "pass.setViewport(x, y, width, height, 0, 1)",
        "pass.setScissorRect(x, y, width, height)",
    ];
    if (
        statements.length !== 8 ||
        calls.some(
            (statement, index) =>
                !ts.isExpressionStatement(statement) ||
                !context.expressionMatchesShape(
                    statement.expression,
                    expected[index]!,
                ),
        )
    ) {
        return context.contractError(
            declaration,
            "Expected _applyCameraViewport to compute x, y, width and height and set the pass viewport and scissor to them.",
        );
    }
    const lane = (member: string): [string, PinnedBinding] => [
        `v.${member}`,
        { cpp: `camera->viewport->${member}`, type: "scalar" },
    ];
    const bindings = new Map<string, PinnedBinding>([
        [
            "v",
            {
                cpp: "camera->viewport",
                type: "opaque",
                absentCpp: "camera == nullptr || !camera->viewport.has_value()",
            },
        ],
        lane("x"),
        lane("y"),
        lane("width"),
        lane("height"),
        ["targetWidth", { cpp: "target_width", type: "scalar" }],
        ["targetHeight", { cpp: "target_height", type: "scalar" }],
        ["x", { cpp: "x", type: "scalar" }],
        ["y", { cpp: "y", type: "scalar" }],
    ]);
    const lower = (expression: ts.Expression): string =>
        new PinnedNumericLowerer(file, {
            bindings,
            calls: pinnedNumericMathCalls(),
        }).expression(expression);
    const skips = lower(guard.expression);
    const lanes = (["x", "y", "width", "height"] as const).map(
        (name) =>
            `    const double ${name} = ${lower(context.variableInitializer(declaration, name))};`,
    );
    return `// ${context.provenance(module, "_applyCameraViewport")}
/**
 * The rectangle a pass sets its viewport and scissor to over its target's
 * extent; none for a pass camera without a viewport, which leaves the whole
 * target. Every render task pass -- a scene's own included -- and every
 * geometry task pass applies it.
 */
inline std::optional<PixelViewport> pass_camera_viewport(
    const CameraRecord* camera,
    double target_width,
    double target_height) {
    if (${skips}) return std::nullopt;
${lanes.join("\n")}
    return PixelViewport{
        static_cast<std::int32_t>(x),
        static_cast<std::int32_t>(y),
        static_cast<std::int32_t>(width),
        static_cast<std::int32_t>(height)};
}`;
}

/**
 * geometry-renderer-task.ts `executeTask`: the camera a geometry task renders
 * through, `config.camera ?? sc.camera`, and its own early return without
 * one -- the task then executes nothing, not even its clears. This port's
 * geometry tasks configure no camera (their factory takes none), so the
 * scene passes null for `configured`.
 */
export function geometryTaskCameraCpp(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        "src/frame-graph/geometry-renderer-task.ts",
        "executeTask",
    );
    const camera = context.variableInitializer(declaration, "camera");
    const guard = declaration.body?.statements[1];
    const exit =
        guard &&
        ts.isIfStatement(guard) &&
        ts.isBlock(guard.thenStatement) &&
        guard.thenStatement.statements.length === 1
            ? guard.thenStatement.statements[0]
            : undefined;
    if (
        !guard ||
        !ts.isIfStatement(guard) ||
        guard.elseStatement !== undefined ||
        !exit ||
        !ts.isReturnStatement(exit) ||
        !exit.expression ||
        !ts.isNumericLiteral(exit.expression) ||
        exit.expression.text !== "0"
    ) {
        return context.contractError(
            declaration,
            "Expected executeTask to resolve its camera and return 0 without one.",
        );
    }
    const cameraCpp = new PinnedNumericLowerer(file, {
        bindings: new Map<string, PinnedBinding>([
            [
                "config.camera",
                {
                    cpp: "configured",
                    type: "opaque",
                    nullish: "configured == nullptr",
                },
            ],
            ["sc.camera", { cpp: "scene_camera", type: "opaque" }],
        ]),
        calls: new Map(),
    }).expression(camera);
    const skips = new PinnedNumericLowerer(file, {
        bindings: new Map<string, PinnedBinding>([
            [
                "camera",
                {
                    cpp: "camera",
                    type: "opaque",
                    absentCpp: "camera == nullptr",
                },
            ],
        ]),
        calls: new Map(),
    }).expression(guard.expression);
    return `// ${context.provenance(
        "src/frame-graph/geometry-renderer-task.ts",
        "executeTask",
    )}
/** The camera a geometry task renders through, \`config.camera ?? sc.camera\`. */
inline CameraRecord* geometry_task_camera(
    CameraRecord* configured,
    CameraRecord* scene_camera) {
    return ${cameraCpp};
}

/** Whether the task executes nothing this frame: \`executeTask\`'s early return. */
inline bool geometry_task_skips(const CameraRecord* camera) {
    return ${skips};
}`;
}

/**
 * `sortTransparentBindings`' own early return, `arr.length <= 1 || !camera`,
 * over the draw list's candidates and a nullable pass camera: the pass
 * without a camera keeps the order its list was built in.
 */
export function transparentSortSkipCpp(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        renderTaskModule,
        "sortTransparentBindings",
    );
    context.assertExpressionShape(
        context.variableInitializer(declaration, "arr"),
        "task._transparentBindings",
        "sortTransparentBindings list",
    );
    const guard = bareReturnGuard(
        context,
        declaration,
        1,
        "sortTransparentBindings",
    );
    return new PinnedNumericLowerer(file, {
        bindings: new Map<string, PinnedBinding>([
            [
                "arr.length",
                {
                    cpp: "static_cast<double>(commands.size())",
                    type: "scalar",
                },
            ],
            [
                "camera",
                {
                    cpp: "camera",
                    type: "opaque",
                    absentCpp: "camera == nullptr",
                },
            ],
        ]),

        calls: new Map(),
    }).expression(guard.expression);
}
