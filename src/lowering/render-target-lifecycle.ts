import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type {
    PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";
import { recordAt } from "../compiler/record-access.js";

const modulePath = "src/texture/rtt-surface.ts";

/** Lower callback delivery, cancellation and retirement from the pinned surface owner. */
export function lowerRenderTargetLifecycle(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        modulePath,
        "installSurfaceResizeSync",
    );
    for (const name of ["notificationPending", "notifying"])
        context.assertExpressionShape(
            context.variableInitializer(declaration, name),
            "false",
            `Initial ${name}`,
        );
    const release = context.functionDeclaration(
        "src/texture/rtt.ts",
        "releaseAttachments",
    ).declaration;
    const disposed = release.body?.statements[0];
    if (!disposed || !ts.isExpressionStatement(disposed))
        return context.contractError(
            release,
            "Expected the attachment release disposed marker.",
        );
    context.assertExpressionShape(
        disposed.expression,
        "this._disposed = true",
        "Attachment release marker",
    );
    const fail = (node: ts.Node): never =>
        context.contractError(
            node,
            "Unrepresented render-target lifecycle operation.",
        );
    const closure = (name: string): ts.ArrowFunction => {
        const value = context.variableInitializer(declaration, name);
        if (!ts.isArrowFunction(value) || !ts.isBlock(value.body))
            return fail(value);
        return value;
    };
    const block = (fn: ts.ArrowFunction): ts.Block =>
        ts.isBlock(fn.body) ? fn.body : fail(fn);
    const hooks = new Map<string, ts.ArrowFunction>();
    for (const node of declaration.body?.statements ?? []) {
        if (
            !ts.isExpressionStatement(node) ||
            !ts.isBinaryExpression(node.expression)
        )
            continue;
        const assign = node.expression;
        if (
            assign.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(assign.left) &&
            ts.isArrowFunction(assign.right)
        )
            hooks.set(assign.left.name.text, assign.right);
    }
    const sync = hooks.get("_syncEager"),
        dispose = hooks.get("_disposeAttachments");
    if (!sync || !dispose) return fail(declaration);
    const syncStatements = block(sync).statements;
    const guards = syncStatements.filter(ts.isIfStatement).slice(0, 3);
    if (guards.length !== 3) return fail(sync);
    context.assertExpressionShape(
        guards[0]!.expression,
        "rt._disposed",
        "Disposed surface guard",
    );
    context.assertExpressionShape(
        guards[2]!.expression,
        "notifying",
        "Reentrant surface guard",
    );
    const mark = syncStatements.findIndex(ts.isForOfStatement);
    if (mark < 0) return fail(sync);
    const subscription = context.functionDeclaration(
        modulePath,
        "onRenderTargetTextureResize",
    ).declaration;

    const lower = (
        statements: readonly ts.Statement[],
        indent = "    ",
        extra = new Map<string, PinnedBinding>(),
    ): string => {
        const bindings = new Map<string, PinnedBinding>([
            ["notifying", { cpp: "state->notifying", type: "scalar" }],
            [
                "notificationPending",
                { cpp: "state->notification_pending", type: "scalar" },
            ],
            ["rt._disposed", { cpp: "state->disposed", type: "scalar" }],
            ["this._disposed", { cpp: "state->disposed", type: "scalar" }],
            ["result.rt._disposed", { cpp: "state->disposed", type: "scalar" }],
            ["callbacks", { cpp: "state->callbacks", type: "opaque" }],
            ["retiredAttachments", { cpp: "state->retired", type: "opaque" }],
            [
                "retiredAttachments.length",
                { cpp: "state->retired->size()", type: "scalar" },
            ],
            ["currentEngine", { cpp: "engine", type: "opaque" }],
            ["engine", { cpp: "engine", type: "opaque" }],
            ["callback", { cpp: "callback", type: "opaque" }],
            ["observer", { cpp: "observer", type: "opaque" }],
            ["observer.pending", { cpp: "observer->pending", type: "scalar" }],
            [
                "observer.callback",
                { cpp: "observer->callback", type: "opaque" },
            ],
            ["errors", { cpp: "errors", type: "opaque" }],
            ["errors.length", { cpp: "errors->size()", type: "scalar" }],
            ...extra,
        ]);
        const calls = new Map<string, (args: readonly string[]) => string>([
            [
                "retireReplacements",
                (args) =>
                    `retire_surface_replacements(state, ${args[0] ?? "state->engine"})`,
            ],
            [
                "settleResizeCallbacks",
                (args) =>
                    `settle_surface_callbacks(state, ${args[0] ?? "state->engine"})`,
            ],
            [
                "notifyResize",
                (args) =>
                    `notify_surface_resize(state, ${args[0] ?? "state->engine"})`,
            ],
            [
                "runGpuResourceCallbacks",
                (args) => `run_gpu_resource_callbacks(${args.join(", ")})`,
            ],
            [
                "retireGpuResources",
                (args) => `retire_gpu_resources(${args.join(", ")})`,
            ],
            [
                "flushGpuResourceRetirements",
                (args) => `flush_gpu_resource_retirements(${args.join(", ")})`,
            ],
            ["callback", () => "callback()"],
        ]);
        const scope = {
            bindings,
            calls,
            foldConditions: false,
            returnValue: (
                expression: ts.Expression | undefined,
                numeric: PinnedNumericLowerer,
            ) => (expression ? numeric.expression(expression) : ""),
            forOf: (source: string, element: string) =>
                source === "callbacks"
                    ? {
                          range: "state->callbacks",
                          bindings: new Map<string, PinnedBinding>([
                              [element, { cpp: element, type: "opaque" }],
                              [
                                  `${element}.pending`,
                                  {
                                      cpp: `${element}->pending`,
                                      type: "scalar",
                                  },
                              ],
                              [
                                  `${element}.callback`,
                                  {
                                      cpp: `${element}->callback`,
                                      type: "opaque",
                                  },
                              ],
                          ]),
                      }
                    : undefined,
            expression: (
                node: ts.Expression,
                numeric: PinnedNumericLowerer,
            ): string | undefined => {
                if (ts.isStringLiteral(node)) return JSON.stringify(node.text);
                if (ts.isArrowFunction(node)) {
                    if (node.parameters.length) return fail(node);
                    const nested = ts.isBlock(node.body)
                        ? lower(node.body.statements, "    ", bindings)
                        : `    ${numeric.expression(node.body)};`;
                    return `[=]() {\n${nested}\n}`;
                }
                if (
                    ts.isArrayLiteralExpression(node) &&
                    node.elements.length === 0
                )
                    return "std::make_shared<std::vector<std::function<void()>>>()";
                if (
                    ts.isElementAccessExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "errors"
                )
                    return `(*errors)[static_cast<std::size_t>(${numeric.expression(node.argumentExpression)})]`;
                if (
                    ts.isNewExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "AggregateError"
                ) {
                    if (node.arguments?.length !== 2) return fail(node);
                    return `std::make_exception_ptr(js::AggregateError(*${numeric.expression(node.arguments[0]!)}, ${numeric.expression(node.arguments[1]!)}))`;
                }
                if (
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression)
                ) {
                    const member = node.expression;
                    const owner = context.unwrapExpression(member.expression);
                    if (ts.isIdentifier(owner) && owner.text === "callbacks") {
                        const method = {
                            add: "add",
                            delete: "erase",
                            clear: "clear",
                        }[member.name.text];
                        if (!method) return fail(node);
                        return `state->callbacks.${method}(${node.arguments.map((arg) => numeric.expression(arg)).join(", ")})`;
                    }
                    if (
                        member.name.text === "push" &&
                        ts.isBinaryExpression(owner) &&
                        owner.operatorToken.kind ===
                            ts.SyntaxKind.QuestionQuestionEqualsToken
                    ) {
                        context.assertExpressionShape(
                            owner,
                            "errors ??= []",
                            "Resize error collection",
                        );
                        if (node.arguments.length !== 1) return fail(node);
                        return `pal::gpu_ensure(errors, [] { return std::make_shared<std::vector<std::exception_ptr>>(); })->push_back(${numeric.expression(node.arguments[0]!)})`;
                    }
                    if (
                        member.name.text === "_settleResizeCallbacks" &&
                        node.questionDotToken
                    ) {
                        context.assertExpressionShape(
                            member.expression,
                            "result",
                            "Resize settlement owner",
                        );
                        return "(state->surface ? settle_surface_callbacks(state, state->engine) : (void)0)";
                    }
                    if (
                        member.name.text === "call" &&
                        ts.isIdentifier(owner) &&
                        owner.text === "disposeAttachments"
                    ) {
                        if (node.arguments.length !== 3) return fail(node);
                        context.assertExpressionShape(
                            node,
                            "disposeAttachments.call(rt, color, depth)",
                            "Attachment release delegation",
                        );
                        return "release()";
                    }
                }
                return undefined;
            },
            statement: (
                node: ts.Statement,
                numeric: PinnedNumericLowerer,
                prefix: string,
            ): readonly string[] | undefined => {
                if (ts.isVariableStatement(node)) {
                    const statements: string[] = [];
                    for (const local of node.declarationList.declarations) {
                        if (!ts.isIdentifier(local.name)) return fail(local);
                        const name = local.name.text;
                        if (name === "errors" && !local.initializer) {
                            statements.push(
                                `${prefix}std::shared_ptr<std::vector<std::exception_ptr>> errors;`,
                            );
                        } else if (name === "callbacks" && local.initializer) {
                            context.assertExpressionShape(
                                local.initializer,
                                "result._resizeCallbacks ??= new Set()",
                                "Resize observer set",
                            );
                        } else if (name === "observer" && local.initializer) {
                            context.assertExpressionShape(
                                local.initializer,
                                "{ callback, pending: false }",
                                "Resize observer state",
                            );
                            statements.push(
                                `${prefix}const auto observer = std::make_shared<SurfaceResizeObserver>(SurfaceResizeObserver{callback, false});`,
                            );
                        } else {
                            if (!local.initializer) return fail(local);
                            statements.push(
                                `${prefix}const auto ${name} = ${numeric.expression(local.initializer)};`,
                            );
                            numeric.bindLocal(local.name, {
                                cpp: name,
                                type: "opaque",
                            });
                        }
                    }
                    return statements;
                }
                if (
                    ts.isTryStatement(node) &&
                    node.catchClause &&
                    !node.finallyBlock
                ) {
                    const parameter =
                        node.catchClause.variableDeclaration?.name;
                    if (!parameter || !ts.isIdentifier(parameter))
                        return fail(node);
                    const nested = new Map(bindings);
                    nested.set(parameter.text, {
                        cpp: parameter.text,
                        type: "opaque",
                    });
                    return [
                        `${prefix}try {`,
                        ...numeric.statements(
                            node.tryBlock.statements,
                            `${prefix}    `,
                        ),
                        `${prefix}} catch (...) {`,
                        `${prefix}    const auto ${parameter.text} = std::current_exception();`,
                        lower(
                            node.catchClause.block.statements,
                            `${prefix}    `,
                            nested,
                        ),
                        `${prefix}}`,
                    ];
                }
                if (ts.isThrowStatement(node))
                    return [
                        `${prefix}std::rethrow_exception(${numeric.expression(node.expression)});`,
                    ];
                return undefined;
            },
        };
        return lowerPinnedBody(
            statements[0]?.getSourceFile() ?? file,
            statements,
            scope,
            indent,
        );
    };
    const functions = [
        ["retireReplacements", "retire_surface_replacements"],
        ["settleResizeCallbacks", "settle_surface_callbacks"],
        ["notifyResize", "notify_surface_resize"],
    ]
        .map(
            ([pinned, cpp]) =>
                `static void ${cpp}(const std::shared_ptr<SurfaceResizeState>& state, std::shared_ptr<pal::GpuRetirementState> engine) {\n${lower(block(closure(pinned!)).statements)}\n}`,
        )
        .join("\n\n");
    if (!subscription.body) return fail(subscription);
    return `// ${context.provenance(modulePath, "installSurfaceResizeSync", "onRenderTargetTextureResize")}
namespace {
struct SurfaceResizeObserver { std::function<void()> callback; bool pending; };
struct SurfaceResizeState {
    js::Set<std::shared_ptr<SurfaceResizeObserver>> callbacks;
    bool notification_pending = false;
    bool notifying = false;
    bool disposed = false;
    bool surface = false;
    pal::GpuRetirementBatch retired = std::make_shared<std::vector<pal::GpuRetirement>>();
    std::shared_ptr<pal::GpuRetirementState> engine;
};
${functions}
class SourceRenderTargetLifecycle final : public RenderTargetLifecycle {
    std::shared_ptr<SurfaceResizeState> backing = std::make_shared<SurfaceResizeState>();
public:
    SourceRenderTargetLifecycle(std::shared_ptr<pal::GpuRetirementState> engine, bool surface) {
        backing->engine = std::move(engine);
        backing->surface = surface;
    }
    void prepare_resize() override {
        const auto state = backing;
${lower([guards[0]!, guards[2]!], "        ")}
    }
    void replaced(std::function<void()> release) override {
        const auto state = backing;
        state->retired->push_back(std::move(release));
        const auto engine = state->engine;
${lower(syncStatements.slice(mark), "        ")}
    }
    void synchronize() override {
        const auto state = backing;
${lower([guards[0]!], "        ")}
        notify_surface_resize(state, state->engine);
    }
    void dispose(std::function<void()> release) override {
        const auto state = backing;
        const auto engine = state->engine;
${lower([disposed], "        ")}
${lower(block(dispose).statements, "        ")}
    }
    js::Callback<void()> subscribe(std::function<void()> callback) override {
        const auto state = backing;
${lower(subscription.body.statements, "        ")}
    }
};
std::shared_ptr<RenderTargetLifecycle> make_render_target_lifecycle(Engine& engine, bool surface) {
    return std::make_shared<SourceRenderTargetLifecycle>(pal::gpu_retirement_state(engine), surface);
}
} // namespace
js::Callback<void()> on_render_target_texture_resize(Engine& engine, RenderTargetTexture result, std::function<void()> callback) {
    auto& target = ${recordAt("engine.render_targets", "result.rt")};
    if (!target.lifecycle) target.lifecycle = make_render_target_lifecycle(engine, false);
    return target.lifecycle->subscribe(std::move(callback));
}
`;
}
