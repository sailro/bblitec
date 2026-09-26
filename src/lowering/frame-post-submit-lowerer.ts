import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import { type LoweringContext, unwrapExpression } from "./context.js";
import {
    lowerPinnedBody,
    type PinnedBodyScope,
} from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import {
    pinnedRecordLiteral,
    pinnedRecordSchema,
} from "./pinned-record-literal.js";

const path = "src/engine/frame-post-submit.ts";
const stateSchema = pinnedRecordSchema("FramePostSubmitState", {
    hooks: "hooks",
    dispatch: "dispatch",
    lastDispatchedEncoder: "last_dispatched_encoder",
});
const hookSchema = pinnedRecordSchema("FramePostSubmitHook", {
    run: "run",
    cancel: "cancel",
    encoder: "encoder",
});

/** Source hook scheduling with native callback, weak-index and microtask transport. */
export function lowerFramePostSubmit(context: LoweringContext): string {
    const scope = (file: ts.SourceFile): PinnedBodyScope => {
        const bindings = new Map<string, PinnedBinding>();
        for (const name of [
            "engine",
            "scope",
            "hook",
            "cancel",
            "encoder",
            "states",
            "state",
            "hooks",
            "dispatch",
            "previousTaskResolver",
            "entry",
            "current",
        ])
            bindings.set(name, { cpp: name, type: "opaque" });
        bindings.set("submitted", { cpp: "submitted", type: "bool" });
        for (const [name, cpp] of Object.entries({
            "engine._currentEncoder": "engine->current_compute_encoder",
            "engine._gpuTaskTimerResolve": "engine->gpu_task_timer_resolve",
            "engine._gpuTimerResolve": "engine->gpu_timer_resolve",
            "state.hooks": "state->hooks",
            "state.dispatch": "state->dispatch",
            "state.lastDispatchedEncoder": "state->last_dispatched_encoder",
            "current.encoder": "current->encoder",
            "current.cancel": "current->cancel",
        }))
            bindings.set(name, { cpp, type: "opaque" });
        bindings.set("state.hooks.size", {
            cpp: "static_cast<double>(state->hooks.size())",
            type: "scalar",
        });
        const calls = new Map<string, (args: readonly string[]) => string>([
            [
                "releaseState",
                (args) => `release_frame_post_submit_state(${args.join(",")})`,
            ],
            [
                "states.get",
                (args) => `find_frame_post_submit_state(${args.join(",")})`,
            ],
            [
                "states.set",
                (args) => `states.insert_or_assign(${args.join(",")})`,
            ],
            [
                "_states.delete",
                (args) =>
                    `js::realm_scratch<FramePostSubmitRegistry>().values.erase(${args.join(",")})`,
            ],
            ["hooks.delete", (args) => `hooks.erase(${args.join(",")})`],
            [
                "state.hooks.add",
                (args) => `state->hooks.add(${args.join(",")})`,
            ],
            [
                "state.hooks.has",
                (args) => `state->hooks.has(${args.join(",")})`,
            ],
            [
                "state.hooks.delete",
                (args) => `state->hooks.erase(${args.join(",")})`,
            ],
            ["current.run", (args) => `current->run(${args.join(",")})`],
            [
                "queueMicrotask",
                (args) =>
                    `pal::EventLoop::current().queue_microtask(${args.join(",")})`,
            ],
        ]);
        return {
            bindings,
            calls,
            foldConditions: false,
            forOf(iterated, element) {
                return iterated === "hooks"
                    ? {
                          range: "hooks",
                          bindings: new Map([
                              ...[...bindings].filter(([name]) =>
                                  name.startsWith(`${element}.`),
                              ),
                              [element, { cpp: element, type: "opaque" }],
                          ]),
                      }
                    : undefined;
            },
            expression(input, lowerer) {
                const node = unwrapExpression(input);
                if (ts.isStringLiteralLike(node))
                    return `std::string{${stringLiteral(node.text)}}`;
                if (node.kind === ts.SyntaxKind.NullKeyword) return "nullptr";
                if (ts.isIdentifier(node) && node.text === "undefined")
                    return "{}";
                if (
                    ts.isNewExpression(node) &&
                    node.expression.getText(file) === "Set"
                )
                    return "js::Set<std::shared_ptr<FramePostSubmitHook>>{}";
                if (ts.isObjectLiteralExpression(node)) {
                    const schema = node.properties.some(
                        (property) => property.name?.getText(file) === "hooks",
                    )
                        ? stateSchema
                        : hookSchema;
                    return `js::make_gc_shared<${schema.cpp}>(${pinnedRecordLiteral(context, lowerer, node, schema)})`;
                }
                if (ts.isCallExpression(node)) {
                    const name = node.expression
                        .getText(file)
                        .replaceAll("!", "");
                    const call = calls.get(name);
                    if (call)
                        return call(
                            node.arguments.map((argument) =>
                                lowerer.expression(argument),
                            ),
                        );
                    if (name === "_states?.get")
                        return `find_frame_post_submit_state(${lowerer.expression(node.arguments[0]!)})`;
                    if (name === "current.cancel" || name === "cancel") {
                        if (!node.questionDotToken) return undefined;
                        const callback =
                            name === "cancel" ? "cancel" : "current->cancel";
                        return `(${callback} ? ${callback}() : void())`;
                    }
                }
                if (ts.isArrowFunction(node)) {
                    if (!ts.isBlock(node.body))
                        return context.contractError(
                            node,
                            "Expected block hook callback.",
                        );
                    const dispatch = node.parameters.length === 2;
                    if (dispatch) {
                        context.assertExpressionShape(
                            node.parameters[0]!.initializer!,
                            "engine._currentEncoder",
                            "Hook default encoder",
                        );
                        context.assertExpressionShape(
                            node.parameters[1]!.initializer!,
                            "true",
                            "Hook default submitted flag",
                        );
                    } else if (node.parameters.length)
                        return context.contractError(
                            node,
                            "Unexpected hook callback parameters.",
                        );
                    const captures = dispatch
                        ? "std::weak_ptr<Engine>(engine), state_cell, hooks"
                        : "std::weak_ptr<Engine>(engine), state, entry, encoder, cancel";
                    const locals = dispatch
                        ? "auto& state=*std::get<1>(capture);auto hooks=std::get<2>(capture);"
                        : "const auto state=std::get<1>(capture);const auto entry=std::get<2>(capture);[[maybe_unused]] const auto encoder=std::get<3>(capture);[[maybe_unused]] const auto cancel=std::get<4>(capture);";
                    return `js::make_closure(std::tuple{${captures}},[](auto& capture${dispatch ? ",std::shared_ptr<pal::ComputeCommandEncoder> encoder,bool submitted" : ""}){const auto engine=std::get<0>(capture).lock();if(!engine)return;${locals}\n${lowerPinnedBody(file, node.body.statements, scope(file))}\n})`;
                }
                return undefined;
            },
            statement(node, lowerer, indent) {
                if (
                    ts.isExpressionStatement(node) &&
                    ts.isCallExpression(node.expression)
                ) {
                    const name = node.expression.expression
                        .getText(file)
                        .replaceAll("!", "");
                    if (
                        name === "hooks.delete" ||
                        name === "state.hooks.delete"
                    )
                        return [
                            `${indent}(void)${lowerer.expression(node.expression)};`,
                        ];
                }
                if (
                    !ts.isVariableStatement(node) ||
                    node.declarationList.declarations.length !== 1
                )
                    return undefined;
                const declaration = node.declarationList.declarations[0]!;
                if (
                    !ts.isIdentifier(declaration.name) ||
                    !declaration.initializer
                )
                    return undefined;
                const name = declaration.name.text;
                if (name === "states") {
                    context.assertExpressionShape(
                        declaration.initializer,
                        "(_states ??= new WeakMap())",
                        "Frame hook engine index",
                    );
                    return [
                        `${indent}auto& states=js::realm_scratch<FramePostSubmitRegistry>().values;`,
                    ];
                }
                if (name === "state")
                    return [
                        `${indent}auto state_cell=js::make_ref<std::shared_ptr<FramePostSubmitState>>(${lowerer.expression(declaration.initializer)});auto& state=*state_cell;`,
                    ];
                if (name === "dispatch")
                    return [
                        `${indent}js::Callback<void(std::shared_ptr<pal::ComputeCommandEncoder>,bool)> dispatch=${lowerer.expression(declaration.initializer)};`,
                    ];
                if (
                    [
                        "encoder",
                        "hooks",
                        "dispatch",
                        "previousTaskResolver",
                        "entry",
                    ].includes(name)
                )
                    return [
                        `${indent}auto ${name}=${lowerer.expression(declaration.initializer)};`,
                    ];
                return undefined;
            },
            returnValue: (node, lowerer) =>
                node ? lowerer.expression(node) : "",
        };
    };
    const signatures = {
        releaseState:
            "static void release_frame_post_submit_state(const std::shared_ptr<Engine>& engine,const std::shared_ptr<FramePostSubmitState>& state)",
        addFramePostSubmitHook:
            "static js::Callback<void()> add_frame_post_submit_hook(const std::shared_ptr<Engine>& engine,const std::string& scope,js::Callback<void(std::shared_ptr<pal::ComputeCommandEncoder>)> hook,js::Callback<void()> cancel={})",
    };
    return Object.entries(signatures)
        .map(([name, signature]) => {
            const { file, declaration } = context.functionDeclaration(
                path,
                name,
            );
            return `// ${context.provenance(path, name)}\n${signature}{\n${lowerPinnedBody(file, declaration.body!.statements, scope(file))}\n}`;
        })
        .join("\n");
}
