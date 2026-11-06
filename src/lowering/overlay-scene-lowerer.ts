import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { stringLiteral } from "../cpp-literals.js";
import {
    equalityOperator,
    operandYield,
    unwrapExpression,
} from "../compiler/syntax.js";
import {
    lowerPinnedBody,
    type PinnedBodyScope,
} from "./pinned-body-lowerer.js";
import type {
    PinnedBinding,
    PinnedCallSpelling,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";

const OVERLAY_MODULE = "src/scene/overlay-scene.ts";
const CORE_MODULE = "src/scene/scene-core.ts";
const ORDER_MODULE = "src/engine/rendering-context-order.ts";
const RENDERING_CONTEXTS = "engine.rendering_contexts";

/**
 * The overlay shapes a native layer does not stand for, refused at
 * generation where the source shows them and at run time otherwise.
 */
export const overlayRefusals = {
    auxiliarySurface:
        "An overlay of a scene on an auxiliary surface is not supported: that scene presents through its own frame graph.",
} as const;

/**
 * registerScene's overlay hook, the pinned shape of the runtime's
 * composition (runtime.hpp `composited_scenes`): registerScene leaves every
 * scene clearing its surface unless `createOverlayScene` made it. Asserted
 * for every program, since both renderers draw that composition whether or
 * not one builds an overlay.
 */
export function assertOverlayComposition(context: LoweringContext): void {
    for (const name of ["registerScene", "registerSceneWithShadowSupport"])
        context.expectShapeCount(
            context.functionDeclaration(CORE_MODULE, name).declaration,
            "_lateCleanup?.get(ctx)?.() || (registerRenderingContext(surface, ctx) && _overlaySceneRegistered?.(ctx))",
            `${name}'s registration and overlay hook`,
        );
}

/** A native `const SceneState*` the overlay list helpers hold a scene as. */
interface SceneValues {
    /** Pinned names bound to a scene pointer. */
    readonly names: Set<string>;
}

/** `text` without one pair of parentheses enclosing all of it. */
function withoutOuterParentheses(text: string): string {
    if (!text.startsWith("(") || !text.endsWith(")")) return text;
    let depth = 0;
    for (let index = 0; index < text.length; ++index) {
        if (text[index] === "(") ++depth;
        else if (
            text[index] === ")" &&
            --depth === 0 &&
            index !== text.length - 1
        )
            return text;
    }
    return text.slice(1, -1);
}

/** The owner of an `X._overlayBase` read. */
function overlayBaseOwner(
    expression: ts.Expression,
): ts.Expression | undefined {
    const node = unwrapExpression(expression);
    return ts.isPropertyAccessExpression(node) &&
        node.name.text === "_overlayBase"
        ? node.expression
        : undefined;
}

/**
 * `&&` or `||`, as the operand its left side passes on says: `||` yields a
 * truthy left operand, `&&` a falsy one.
 */
function logicalJoiner(node: ts.Expression): "&&" | "||" | undefined {
    if (!ts.isBinaryExpression(node)) return undefined;
    const left = operandYield(node, node.left);
    if (!left) return undefined;
    if (!left.has("truthy")) return "&&";
    return left.size === 1 ? "||" : undefined;
}

/**
 * The surface's `_renderingContexts` is the engine's one list
 * (`engine.rendering_contexts`), each element a scene pointer, null for
 * another context kind.
 */
function renderingContextBindings(surface: string): [string, PinnedBinding][] {
    return [
        [surface, { cpp: "engine", type: "opaque" }],
        [
            `${surface}._renderingContexts`,
            { cpp: RENDERING_CONTEXTS, type: "opaque" },
        ],
        [
            `${surface}._renderingContexts.length`,
            {
                cpp: "static_cast<double>(engine.rendering_contexts.size())",
                type: "scalar",
            },
        ],
    ];
}

/**
 * The scope every overlay list helper lowers through: a SceneContext is a
 * `const SceneState*`, compared by identity, `_overlayBase` its base, and
 * the rendering-context list's `indexOf`, `splice`, `filter` and
 * `findIndex` the engine list's.
 */
function overlayListScope(
    context: LoweringContext,
    scenes: readonly string[],
    bindings: [string, PinnedBinding][],
    calls: [string, PinnedCallSpelling][],
    /** Names holding any rendering context, a null pointer for one that is no scene. */
    contexts: readonly string[] = [],
): PinnedBodyScope {
    const values: SceneValues = { names: new Set([...scenes, ...contexts]) };
    const nullable = new Set(contexts);
    /** `contexts[i]`, an element of the engine's rendering-context list. */
    const listElement = (
        node: ts.Expression,
        lowerer: PinnedNumericLowerer,
    ): ts.ElementAccessExpression | undefined =>
        ts.isElementAccessExpression(node) &&
        lowerer.binding(node.expression)?.cpp === RENDERING_CONTEXTS
            ? node
            : undefined;
    const sceneValued = (
        expression: ts.Expression,
        lowerer: PinnedNumericLowerer,
    ): boolean => {
        const node = unwrapExpression(expression);
        return (
            (ts.isIdentifier(node) && values.names.has(node.text)) ||
            overlayBaseOwner(node) !== undefined ||
            listElement(node, lowerer) !== undefined
        );
    };
    /** JavaScript truthiness over scene pointers, booleans and comparisons. */
    const truthiness = (
        expression: ts.Expression,
        lowerer: PinnedNumericLowerer,
    ): string => {
        const node = unwrapExpression(expression);
        if (
            ts.isPrefixUnaryExpression(node) &&
            node.operator === ts.SyntaxKind.ExclamationToken
        ) {
            const operand = unwrapExpression(node.operand);
            // `!!value` is the value's truthiness.
            if (
                ts.isPrefixUnaryExpression(operand) &&
                operand.operator === ts.SyntaxKind.ExclamationToken
            )
                return truthiness(operand.operand, lowerer);
            return `!${truthiness(operand, lowerer)}`;
        }
        const joiner = logicalJoiner(node);
        if (joiner && ts.isBinaryExpression(node))
            return `(${truthiness(node.left, lowerer)} ${joiner} ${truthiness(node.right, lowerer)})`;
        if (sceneValued(node, lowerer))
            return `(${lowerer.expression(node)} != nullptr)`;
        return lowerer.expression(node);
    };
    const condition = (
        expression: ts.Expression,
        lowerer: PinnedNumericLowerer,
    ): string => withoutOuterParentheses(truthiness(expression, lowerer));
    const sceneLocal = (
        declaration: ts.VariableDeclaration,
        lowerer: PinnedNumericLowerer,
        cpp: string,
    ): void => {
        if (!ts.isIdentifier(declaration.name))
            context.contractError(declaration, "Expected a named scene local.");
        values.names.add(declaration.name.text);
        lowerer.bindLocal(declaration.name, {
            cpp,
            type: "opaque",
            absentCpp: `!${cpp}`,
        });
    };
    /** `contexts.filter(f)` or `contexts.findIndex(f)` over the engine list. */
    const listWalk = (
        initializer: ts.Expression,
    ):
        | { method: "filter" | "findIndex"; predicate: ts.ArrowFunction }
        | undefined => {
        const node = unwrapExpression(initializer);
        if (
            !ts.isCallExpression(node) ||
            !ts.isPropertyAccessExpression(node.expression) ||
            (node.expression.name.text !== "filter" &&
                node.expression.name.text !== "findIndex")
        )
            return undefined;
        const [predicate] = node.arguments;
        if (
            node.arguments.length !== 1 ||
            !predicate ||
            !ts.isArrowFunction(predicate) ||
            predicate.parameters.length !== 1 ||
            ts.isBlock(predicate.body)
        )
            context.contractError(node, "Expected one expression predicate.");
        return { method: node.expression.name.text, predicate };
    };
    return {
        bindings: new Map([
            ...[...scenes, ...contexts].map((name): [string, PinnedBinding] => [
                name,
                { cpp: name, type: "opaque", absentCpp: `!${name}` },
            ]),
            ...bindings,
        ]),
        calls: new Map<string, PinnedCallSpelling>([
            [
                "Number.isInteger",
                ([value]) => `(std::trunc(${value}) == ${value})`,
            ],
            ...calls,
        ]),
        methods: new Map([
            [
                "indexOf",
                (_receiver: string, [scene]: readonly string[]) =>
                    `[&] { const auto at = rendering_context_index(engine, *${scene}); ` +
                    `return at ? static_cast<double>(*at) : -1.0; }()`,
            ],
            // `list.splice(i, 1)` then `list.splice(at, 0, context)`: the
            // entry the first takes is the context the second inserts.
            [
                "splice",
                (receiver: string, args: readonly string[]) =>
                    args.length === 2
                        ? `auto removed = ${receiver}.take_at(static_cast<std::size_t>(${args[0]}))`
                        : `${receiver}.insert_at(static_cast<std::size_t>(${args[0]}), std::move(removed))`,
            ],
        ]),
        condition,
        expression(expression, lowerer) {
            const node = unwrapExpression(expression);
            const element = listElement(node, lowerer);
            if (element)
                return `rendering_context_scene(engine, static_cast<std::size_t>(${lowerer.expression(element.argumentExpression)}))`;
            const base = overlayBaseOwner(node);
            if (base) {
                const owner = unwrapExpression(base);
                const cpp = lowerer.expression(owner);
                return ts.isIdentifier(owner) && nullable.has(owner.text)
                    ? `(${cpp} ? ${cpp}->overlay_base.get() : nullptr)`
                    : `${cpp}->overlay_base.get()`;
            }
            if (!ts.isBinaryExpression(node)) return undefined;
            const equality = equalityOperator(node.operatorToken.kind);
            if (
                equality &&
                !equality.loose &&
                sceneValued(node.left, lowerer) &&
                sceneValued(node.right, lowerer)
            )
                return `(${lowerer.expression(node.left)} ${equality.negated ? "!=" : "=="} ${lowerer.expression(node.right)})`;
            // `"_overlayBase" in context`: a scene `createOverlayScene` made.
            if (
                node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
                ts.isStringLiteral(node.left) &&
                node.left.text === "_overlayBase"
            ) {
                const owner = lowerer.expression(node.right);
                return `(${owner} != nullptr && ${owner}->overlay_base != nullptr)`;
            }
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (ts.isForOfStatement(statement)) {
                const list = statement.initializer;
                const declaration = ts.isVariableDeclarationList(list)
                    ? list.declarations[0]
                    : undefined;
                if (
                    !declaration ||
                    !ts.isIdentifier(declaration.name) ||
                    !sceneValued(statement.expression, lowerer)
                )
                    return undefined;
                const name = declaration.name.text;
                sceneLocal(declaration, lowerer, name);
                return [
                    `${indent}for (const SceneState* ${name} : ${lowerer.expression(statement.expression)}) {`,
                    ...lowerer.statements(
                        ts.isBlock(statement.statement)
                            ? statement.statement.statements
                            : [statement.statement],
                        `${indent}    `,
                    ),
                    `${indent}}`,
                ];
            }
            if (!ts.isVariableStatement(statement)) return undefined;
            const [declaration] = statement.declarationList.declarations;
            if (
                statement.declarationList.declarations.length !== 1 ||
                !declaration?.initializer ||
                !ts.isIdentifier(declaration.name)
            )
                return undefined;
            const name = declaration.name.text;
            const initializer = declaration.initializer;
            const walk = listWalk(initializer);
            if (walk) {
                const element = walk.predicate.parameters[0]!;
                if (!ts.isIdentifier(element.name))
                    context.contractError(element, "Expected a named element.");
                values.names.add(element.name.text);
                lowerer.bindLocal(element.name, {
                    cpp: element.name.text,
                    type: "opaque",
                    absentCpp: `!${element.name.text}`,
                });
                const predicate = condition(
                    walk.predicate.body as ts.Expression,
                    lowerer,
                );
                const at = `${name}_at`;
                const head = [
                    `${indent}for (std::size_t ${at} = 0; ${at} < engine.rendering_contexts.size(); ++${at}) {`,
                    `${indent}    const SceneState* ${element.name.text} = rendering_context_scene(engine, ${at});`,
                ];
                if (walk.method === "filter") {
                    // A list of scene pointers, which a for-of walks.
                    values.names.add(name);
                    lowerer.bindLocal(declaration.name, {
                        cpp: name,
                        type: "opaque",
                    });
                    return [
                        `${indent}std::vector<const SceneState*> ${name};`,
                        ...head,
                        `${indent}    if (${predicate}) ${name}.push_back(${element.name.text});`,
                        `${indent}}`,
                    ];
                }
                lowerer.bindLocal(declaration.name, {
                    cpp: name,
                    type: "scalar",
                });
                return [
                    `${indent}double ${name} = -1.0;`,
                    ...head,
                    `${indent}    if (${predicate}) {`,
                    `${indent}        ${name} = static_cast<double>(${at});`,
                    `${indent}        break;`,
                    `${indent}    }`,
                    `${indent}}`,
                ];
            }
            if (!sceneValued(initializer, lowerer)) return undefined;
            const value = lowerer.expression(initializer);
            sceneLocal(declaration, lowerer, name);
            return [`${indent}const SceneState* ${name} = ${value};`];
        },
    };
}

/** One overlay list helper's pinned body under `overlayListScope`. */
function lowerListHelper(
    context: LoweringContext,
    module: string,
    name: string,
    parameters: readonly string[],
    scope: PinnedBodyScope,
    returnValue: "condition" | "expression" | "void",
): string {
    const { file, declaration } = context.functionDeclaration(module, name);
    context.assertParameterNames(declaration, parameters, `${name} parameters`);
    return lowerPinnedBody(file, declaration.body!.statements, {
        ...scope,
        returnValue: (expression, lowerer) => {
            if (returnValue === "void") {
                if (expression)
                    context.contractError(
                        expression,
                        `Expected ${name} to return nothing.`,
                    );
                return "";
            }
            if (!expression)
                context.contractError(
                    declaration,
                    `Expected ${name} to return a value.`,
                );
            return returnValue === "condition"
                ? scope.condition!(expression, lowerer)
                : lowerer.expression(expression);
        },
    });
}

/**
 * overlay-scene.ts `createOverlayScene` and the registration order it
 * installs: `register_scene` runs `move_swapchain_overlays_after_base`
 * after every insertion, as the installed `_overlaySceneRegistered` hook
 * does once an overlay exists (before one does, it moves nothing). The
 * overlay's suspended `_update` and `_record` are the renderers', which
 * consult `SceneState::overlay_suspended` (the lowered `isSuspended`), and
 * its `configureSwapchainOverlayScene` record is runtime.hpp
 * `overlay_composition` over its `default_swapchain_task`, which each frame
 * re-resolves, so the record's replaced-task restore has nothing to restore.
 */
export function lowerOverlayScenes(context: LoweringContext): string {
    context.assertFunctionContract(
        OVERLAY_MODULE,
        "createOverlayScene",
        `
export function createOverlayScene(baseScene: SceneContext): SceneContext {
    const scene = createSceneContext(baseScene.surface);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 0 };
    scene._overlayBase = baseScene;
    _installOverlaySceneRegistration(moveSwapchainOverlaysAfterBase);
    configureSwapchainOverlayScene(scene);

    const update = scene._update;
    const record = scene._record;
    scene._update = () => {
        if (isSuspended(scene)) {
            scene._drawCallsPre = 0;
        } else {
            update();
        }
    };
    scene._record = () => (isSuspended(scene) ? 0 : record());
    return scene;
}
`,
        "overlay-scene.createOverlayScene native contract",
    );
    context.assertFunctionContract(
        CORE_MODULE,
        "_installOverlaySceneRegistration",
        `
export function _installOverlaySceneRegistration(registered: (scene: SceneContext) => void): void {
    _overlaySceneRegistered = registered;
}
`,
        "scene-core._installOverlaySceneRegistration native contract",
    );
    context.assertFunctionContract(
        "src/scene/swapchain-overlay.ts",
        "configureSwapchainOverlayScene",
        `
export function configureSwapchainOverlayScene(overlay: SceneContext): void {
    const surface = overlay.surface;
    const record = overlay._record;
    let task: RenderTask | undefined;
    let clr: boolean | undefined;
    overlay._record = () => {
        const current = getDefaultSwapchainTask(overlay, surface);
        if (current !== task) {
            if (task) {
                task._config.clr = clr;
                task._colorAttachment.view = task._config.rt._colorView!;
            }
            task = current;
            clr = current?._config.clr;
        }
        if (current) {
            if (surface.msaaSamples > 1) {
                let root = overlay._overlayBase!;
                while (root._overlayBase) {
                    root = root._overlayBase;
                }
                const rootTask = getDefaultSwapchainTask(root, surface);
                const view = rootTask?.enabled !== false && rootTask?.executionEnabled !== false && rootTask?._config.rst === surface.scRT && rootTask._colorAttachment.view;
                if (!view) {
                    const enabled = current.enabled;
                    current.enabled = false;
                    try {
                        return record();
                    } finally {
                        current.enabled = enabled;
                    }
                }
                current._colorAttachment.view = view;
            }
            current._config.clr = false;
        }
        return record();
    };
}
`,
        "swapchain-overlay.configureSwapchainOverlayScene native contract",
    );
    const moveContext: [string, PinnedCallSpelling] = [
        "moveRenderingContext",
        ([, scene, index]) =>
            `move_rendering_context(engine, ${scene}, ${index})`,
    ];
    const moveRenderingContext = lowerListHelper(
        context,
        ORDER_MODULE,
        "moveRenderingContext",
        ["surface", "context", "index"],
        overlayListScope(
            context,
            ["context"],
            [
                ...renderingContextBindings("surface"),
                ["index", { cpp: "index", type: "scalar" }],
            ],
            [],
        ),
        "condition",
    );
    const isOverlayDescendant = lowerListHelper(
        context,
        OVERLAY_MODULE,
        "isOverlayDescendant",
        ["context", "base"],
        overlayListScope(context, ["base"], [], [], ["context"]),
        "condition",
    );
    const moveOverlayDescendants = lowerListHelper(
        context,
        OVERLAY_MODULE,
        "moveOverlayDescendants",
        ["base", "baseIndex"],
        overlayListScope(
            context,
            ["base"],
            [
                ...renderingContextBindings("base.surface"),
                ["baseIndex", { cpp: "base_index", type: "scalar" }],
            ],
            [
                moveContext,
                [
                    "moveOverlayDescendants",
                    ([overlay, index]) =>
                        `move_overlay_descendants(engine, ${overlay}, ${index})`,
                ],
            ],
        ),
        "expression",
    );
    const moveSwapchainOverlaysAfterBase = lowerListHelper(
        context,
        OVERLAY_MODULE,
        "moveSwapchainOverlaysAfterBase",
        ["scene"],
        overlayListScope(
            context,
            ["scene"],
            renderingContextBindings("base.surface"),
            [
                moveContext,
                [
                    "isOverlayDescendant",
                    ([scene, base]) =>
                        `is_overlay_descendant(${scene}, ${base})`,
                ],
                [
                    "moveOverlayDescendants",
                    ([base, index]) =>
                        `static_cast<void>(move_overlay_descendants(engine, ${base}, ${index}))`,
                ],
            ],
        ),
        "void",
    );
    const isSuspended = lowerListHelper(
        context,
        OVERLAY_MODULE,
        "isSuspended",
        ["scene"],
        overlayListScope(
            context,
            ["scene"],
            [["scene.surface", { cpp: "engine", type: "opaque" }]],
            [
                [
                    "isRenderingContextRegistered",
                    ([, scene]) =>
                        `rendering_context_index(engine, *${scene}).has_value()`,
                ],
            ],
        ),
        "condition",
    );
    return `
namespace {

// ${context.provenance(ORDER_MODULE, "moveRenderingContext")}
bool move_rendering_context(Engine& engine, const SceneState* context, double index) {
${moveRenderingContext}
}

// ${context.provenance(OVERLAY_MODULE, "isOverlayDescendant")}
bool is_overlay_descendant(const SceneState* context, const SceneState* base) {
${isOverlayDescendant}
}

// ${context.provenance(OVERLAY_MODULE, "moveOverlayDescendants")}
double move_overlay_descendants(Engine& engine, const SceneState* base, double base_index) {
${moveOverlayDescendants}
}

// ${context.provenance(OVERLAY_MODULE, "isSuspended")}
bool is_suspended(const Engine& engine, const SceneState& scene_state) {
    const SceneState* scene = &scene_state;
${isSuspended}
}

} // namespace

// ${context.provenance(OVERLAY_MODULE, "moveSwapchainOverlaysAfterBase")}
void move_swapchain_overlays_after_base(const Scene& registered) {
    require_scene_engine(registered);
    Engine& engine = *registered.engine;
    const SceneState* scene = registered.identity();
${moveSwapchainOverlaysAfterBase}
}

// ${context.provenance(OVERLAY_MODULE, "createOverlayScene")}
Scene create_overlay_scene(const Scene& base_scene) {
    require_scene_engine(base_scene);
    Engine& engine = *base_scene.engine;
#if BBLITE_HAS_UI
    const std::optional<UiElementHandle> primary = engine.surface_canvas;
#else
    const std::optional<UiElementHandle> primary;
#endif
    if (!scene_on_surface(base_scene, primary))
        throw std::runtime_error(${stringLiteral(overlayRefusals.auxiliarySurface)});
    // \`createSceneContext(baseScene.surface)\`: the engine's own surface.
    Scene scene = create_scene_context(engine);
    scene.clear_color = Color4{0.0f, 0.0f, 0.0f, 0.0f};
    scene.state->overlay_base = base_scene.state;
    scene.state->overlay_suspended = &is_suspended;
    return scene;
}
`;
}
