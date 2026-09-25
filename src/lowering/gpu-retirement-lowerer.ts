import ts from "typescript";
import { type LoweredSource, type LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type {
    PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";

type Kind =
    | "engine"
    | "batch"
    | "set"
    | "batches"
    | "callback"
    | "flush"
    | "promise"
    | "void"
    | "empty"
    | "null"
    | "bool"
    | "number"
    | "string"
    | "error";
interface Value {
    kind: Kind;
    cpp: string;
}
const functions = new Map<
    string,
    { cpp: string; parameters: Kind[]; result: Kind }
>([
    [
        "runBatch",
        {
            cpp: "run_gpu_retirement_batch",
            parameters: ["batch"],
            result: "void",
        },
    ],
    [
        "runGpuResourceCallbacks",
        {
            cpp: "run_gpu_resource_callbacks",
            parameters: ["batch"],
            result: "void",
        },
    ],
    [
        "retireGpuResources",
        {
            cpp: "retire_gpu_resources",
            parameters: ["engine", "callback"],
            result: "void",
        },
    ],
    [
        "retireGpuResourceBatch",
        {
            cpp: "retire_gpu_resource_batch",
            parameters: ["engine", "batch"],
            result: "void",
        },
    ],
    [
        "flushGpuResourceRetirements",
        {
            cpp: "flush_gpu_resource_retirements",
            parameters: ["engine"],
            result: "void",
        },
    ],
    [
        "waitForGpuResourceRetirements",
        {
            cpp: "wait_for_gpu_resource_retirements",
            parameters: ["engine"],
            result: "promise",
        },
    ],
    [
        "disposeGpuResourceRetirements",
        {
            cpp: "dispose_gpu_resource_retirements",
            parameters: ["engine"],
            result: "void",
        },
    ],
]);
const cppTypes: Partial<Record<Kind, string>> = {
    engine: "std::shared_ptr<pal::GpuRetirementState>",
    batch: "pal::GpuRetirementBatch",
    set: "pal::GpuRetirementSet",
    batches: "pal::GpuRetirementBatches",
    callback: "pal::GpuRetirement",
    void: "void",
    promise: "pal::GpuCompletion",
};

/** Callback/container representations for the pinned retirement module. Control flow is shared AST lowering. */
export function lowerGpuRetirement(context: LoweringContext): LoweredSource {
    const modulePath = "src/engine/gpu-resource-retirement.ts";
    const sources: string[] = [];
    for (const [name, spec] of functions) {
        const { file, declaration } = context.functionDeclaration(
            modulePath,
            name,
        );
        if (
            !declaration.body ||
            declaration.parameters.length !== spec.parameters.length
        )
            context.contractError(
                declaration,
                "GPU retirement function signature changed.",
            );
        const values = new Map<string, Value>();
        const bindings = new Map<string, PinnedBinding>();
        const bind = (name: string, value: Value): void => {
            values.set(name, value);
            bindings.set(name, { cpp: value.cpp, type: "opaque" });
        };
        const fail = (node: ts.Node): never =>
            context.contractError(
                node,
                "Unrepresented GPU retirement value or operation.",
            );
        const signature = declaration.parameters.map((parameter, index) => {
            if (
                !ts.isIdentifier(parameter.name) ||
                parameter.initializer ||
                parameter.dotDotDotToken
            )
                return fail(parameter);
            const kind = spec.parameters[index]!;
            bind(parameter.name.text, { kind, cpp: parameter.name.text });
            return `${cppTypes[kind]} ${parameter.name.text}`;
        });
        const requireKind = (
            value: Value,
            kind: Kind,
            node: ts.Node,
        ): string => {
            if (value.kind !== kind) return fail(node);
            return value.cpp;
        };
        const scope = <T>(work: () => T): T => {
            const saved = new Map(values),
                savedBindings = new Map(bindings);
            try {
                return work();
            } finally {
                values.clear();
                bindings.clear();
                for (const [key, value] of saved) values.set(key, value);
                for (const [key, value] of savedBindings)
                    bindings.set(key, value);
            }
        };
        const body = (
            statements: readonly ts.Statement[],
            indent = "    ",
        ): string =>
            lowerPinnedBody(
                file,
                statements,
                {
                    bindings,
                    calls: new Map(),
                    foldConditions: false,
                    expression: (node, lowerer) => {
                        const value = expression(node);
                        lowerer.bindLocal(node, {
                            cpp: value.cpp,
                            type:
                                value.kind === "bool"
                                    ? "bool"
                                    : value.kind === "number"
                                      ? "scalar"
                                      : value.kind === "string"
                                        ? "string"
                                        : "opaque",
                        });
                        return value.cpp;
                    },
                    statement: (node, lowerer, indent) =>
                        statement(node, lowerer, indent),
                    forOf: (source, element) => {
                        const value = values.get(source);
                        const kind =
                            value?.kind === "batch"
                                ? "callback"
                                : value?.kind === "batches"
                                  ? "batch"
                                  : undefined;
                        if (!value || !kind) return undefined;
                        bind(element, { kind, cpp: element });
                        return {
                            range:
                                value.kind === "batch"
                                    ? `*${value.cpp}`
                                    : value.cpp,
                            bindings: new Map([
                                [
                                    element,
                                    { cpp: element, type: "opaque" as const },
                                ],
                            ]),
                        };
                    },
                },
                indent,
            );
        const callback = (node: ts.ArrowFunction): Value => {
            if (node.parameters.length || node.modifiers?.length)
                return fail(node);
            const cpp = scope(() =>
                ts.isBlock(node.body)
                    ? body(node.body.statements)
                    : `    ${expression(node.body).cpp};`,
            );
            return { kind: "callback", cpp: `[=]() {\n${cpp}\n}` };
        };
        const expression = (node: ts.Expression): Value => {
            if (
                ts.isParenthesizedExpression(node) ||
                ts.isNonNullExpression(node)
            )
                return expression(node.expression);
            if (ts.isIdentifier(node)) {
                if (node.text === "undefined")
                    return { kind: "void", cpp: "(void)0" };
                const value = values.get(node.text);
                if (value) return value;
                const fn = functions.get(node.text);
                if (fn)
                    return {
                        kind:
                            fn.parameters[0] === "engine"
                                ? "flush"
                                : "callback",
                        cpp: fn.cpp,
                    };
                return fail(node);
            }
            if (ts.isArrowFunction(node)) return callback(node);
            if (ts.isStringLiteral(node))
                return { kind: "string", cpp: JSON.stringify(node.text) };
            if (ts.isNumericLiteral(node))
                return { kind: "number", cpp: node.text };
            if (node.kind === ts.SyntaxKind.NullKeyword)
                return { kind: "null", cpp: "nullptr" };
            if (ts.isAwaitExpression(node))
                return {
                    kind: "void",
                    cpp: `co_await ${requireKind(expression(node.expression), "promise", node)}`,
                };
            if (ts.isVoidExpression(node))
                return {
                    kind: "void",
                    cpp: `(void)(${expression(node.expression).cpp})`,
                };
            if (
                ts.isPrefixUnaryExpression(node) &&
                node.operator === ts.SyntaxKind.ExclamationToken
            )
                return {
                    kind: "bool",
                    cpp: `!(${expression(node.operand).cpp})`,
                };
            if (ts.isArrayLiteralExpression(node)) {
                if (!node.elements.length) return { kind: "empty", cpp: "{}" };
                const element = node.elements[0];
                if (
                    node.elements.length !== 1 ||
                    !element ||
                    !ts.isSpreadElement(element)
                )
                    return fail(node);
                return {
                    kind: "batches",
                    cpp: `pal::GpuRetirementBatches(*${requireKind(expression(element.expression), "set", node)})`,
                };
            }
            if (
                ts.isNewExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "Set" &&
                !node.arguments?.length
            )
                return {
                    kind: "set",
                    cpp: "std::make_shared<pal::GpuRetirementBatches>()",
                };
            if (ts.isConditionalExpression(node)) {
                const left = expression(node.whenTrue),
                    right = expression(node.whenFalse);
                if (left.kind !== "batches" || right.kind !== "empty")
                    return fail(node);
                return {
                    kind: "batches",
                    cpp: `(${expression(node.condition).cpp} ? ${left.cpp} : pal::GpuRetirementBatches{})`,
                };
            }
            if (ts.isPropertyAccessExpression(node)) {
                const owner = expression(node.expression),
                    property = node.name.text;
                if (owner.kind === "engine") {
                    const members: Record<string, Value | undefined> = {
                        _retirements: {
                            kind: "batch",
                            cpp: `${owner.cpp}->pending`,
                        },
                        _retiring: {
                            kind: "set",
                            cpp: `${owner.cpp}->retiring`,
                        },
                        _flushGpuRetirements: {
                            kind: "flush",
                            cpp: `${owner.cpp}->flush`,
                        },
                    };
                    return members[property] ?? fail(node);
                }
                if (
                    (owner.kind === "batch" && property === "length") ||
                    (owner.kind === "set" && property === "size")
                )
                    return {
                        kind: "number",
                        cpp: node.questionDotToken
                            ? `(${owner.cpp} ? ${owner.cpp}->size() : 0u)`
                            : `${owner.cpp}->size()`,
                    };
                return fail(node);
            }
            if (ts.isBinaryExpression(node)) {
                const left = expression(node.left),
                    right = expression(node.right);
                if (
                    node.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionEqualsToken
                ) {
                    const initial =
                        left.kind === "batch" && right.kind === "empty"
                            ? "std::make_shared<std::vector<pal::GpuRetirement>>()"
                            : right.kind === left.kind
                              ? right.cpp
                              : fail(node);
                    return {
                        kind: left.kind,
                        cpp: `pal::gpu_ensure(${left.cpp}, [=] { return ${initial}; })`,
                    };
                }
                if (
                    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                    right.kind === "null" &&
                    ["batch", "set"].includes(left.kind)
                )
                    return { kind: left.kind, cpp: `${left.cpp} = nullptr` };
                if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
                    return {
                        kind: "bool",
                        cpp: `(${left.cpp} || ${right.cpp})`,
                    };
                return fail(node);
            }
            if (ts.isCallExpression(node)) return call(node);
            return fail(node);
        };
        const call = (node: ts.CallExpression): Value => {
            const callee = node.expression;
            if (ts.isIdentifier(callee)) {
                const fn = functions.get(callee.text);
                if (fn) {
                    if (node.arguments.length !== fn.parameters.length)
                        return fail(node);
                    return {
                        kind: fn.result,
                        cpp: `${fn.cpp}(${node.arguments.map((arg, index) => requireKind(expression(arg), fn.parameters[index]!, arg)).join(", ")})`,
                    };
                }
                if (
                    callee.text === "queueMicrotask" &&
                    node.arguments.length === 1
                )
                    return {
                        kind: "void",
                        cpp: `pal::EventLoop::current().queue_microtask(${requireKind(expression(node.arguments[0]!), "callback", node)})`,
                    };
                if (!node.arguments.length)
                    return {
                        kind: "void",
                        cpp: `${requireKind(expression(callee), "callback", node)}()`,
                    };
                return fail(node);
            }
            if (!ts.isPropertyAccessExpression(callee)) return fail(node);
            const member = callee.name.text;
            if (ts.isIdentifier(callee.expression)) {
                if (
                    callee.expression.text === "Promise" &&
                    member === "resolve" &&
                    !node.arguments.length
                )
                    return {
                        kind: "promise",
                        cpp: "pal::GpuCompletion::resolved({})",
                    };
                if (
                    callee.expression.text === "console" &&
                    member === "error" &&
                    node.arguments.length === 2
                )
                    return {
                        kind: "void",
                        cpp: `pal::gpu_retirement_error(${requireKind(expression(node.arguments[0]!), "string", node)}, ${requireKind(expression(node.arguments[1]!), "error", node)})`,
                    };
            }
            if (
                member === "onSubmittedWorkDone" &&
                !node.arguments.length &&
                ts.isPropertyAccessExpression(callee.expression) &&
                callee.expression.name.text === "queue" &&
                ts.isPropertyAccessExpression(callee.expression.expression) &&
                callee.expression.expression.name.text === "_device"
            ) {
                const engine = requireKind(
                    expression(callee.expression.expression.expression),
                    "engine",
                    node,
                );
                return {
                    kind: "promise",
                    cpp: `${engine}->submitted_work_done()`,
                };
            }
            const owner = expression(callee.expression);
            if (owner.kind === "batch") {
                if (
                    member === "splice" &&
                    node.arguments.length === 1 &&
                    ts.isNumericLiteral(node.arguments[0]!) &&
                    node.arguments[0].text === "0"
                )
                    return {
                        kind: "batch",
                        cpp: `pal::gpu_splice_all(${owner.cpp})`,
                    };
                if (member === "slice" && !node.arguments.length)
                    return {
                        kind: "batch",
                        cpp: `std::make_shared<std::vector<pal::GpuRetirement>>(*${owner.cpp})`,
                    };
                if (member === "push" && node.arguments.length === 1)
                    return {
                        kind: "void",
                        cpp: `${owner.cpp}->push_back(${requireKind(expression(node.arguments[0]!), "callback", node)})`,
                    };
            }
            if (owner.kind === "set" && node.arguments.length === 1) {
                if (member === "add" || member === "delete")
                    return {
                        kind: member === "delete" ? "bool" : "void",
                        cpp: `pal::gpu_set_${member}(${owner.cpp}, ${requireKind(expression(node.arguments[0]!), "batch", node)})`,
                    };
                if (member === "forEach") {
                    const fn = requireKind(
                        expression(node.arguments[0]!),
                        "callback",
                        node,
                    );
                    return {
                        kind: "void",
                        cpp: `[&] { ${callee.questionDotToken ? `if (!${owner.cpp}) return; ` : ""}for (const auto& entry : *${owner.cpp}) ${fn}(entry); }()`,
                    };
                }
            }
            if (
                owner.kind === "promise" &&
                node.arguments.length === 1 &&
                (member === "then" || member === "catch")
            ) {
                const fn = requireKind(
                    expression(node.arguments[0]!),
                    "callback",
                    node,
                );
                return {
                    kind: "promise",
                    cpp: `${owner.cpp}.${member === "then" ? "then" : "catch_error"}([=](${member === "then" ? "js::PromiseVoid" : "std::exception_ptr"}) { ${fn}(); })`,
                };
            }
            return fail(node);
        };
        const statement = (
            node: ts.Statement,
            lowerer: PinnedNumericLowerer,
            indent: string,
        ): readonly string[] | undefined => {
            if (ts.isVariableStatement(node))
                return node.declarationList.declarations.map((local) => {
                    if (!ts.isIdentifier(local.name) || !local.initializer)
                        return fail(local);
                    const value = expression(local.initializer);
                    if (!cppTypes[value.kind]) return fail(local);
                    bind(local.name.text, {
                        kind: value.kind,
                        cpp: local.name.text,
                    });
                    return `${indent}const auto ${local.name.text} = ${value.cpp};`;
                });
            if (ts.isExpressionStatement(node))
                return [`${indent}${expression(node.expression).cpp};`];
            if (
                ts.isTryStatement(node) &&
                node.catchClause &&
                !node.finallyBlock
            ) {
                const parameter = node.catchClause.variableDeclaration?.name;
                if (!parameter || !ts.isIdentifier(parameter))
                    return fail(node);
                return [
                    `${indent}try {`,
                    ...lowerer.statements(
                        node.tryBlock.statements,
                        `${indent}    `,
                    ),
                    `${indent}} catch (...) {`,
                    `${indent}    const auto ${parameter.text} = std::current_exception();`,
                    scope(() => {
                        bind(parameter.text, {
                            kind: "error",
                            cpp: parameter.text,
                        });
                        return body(
                            node.catchClause!.block.statements,
                            `${indent}    `,
                        );
                    }),
                    `${indent}}`,
                ];
            }
            return undefined;
        };
        const lowered = body(declaration.body.statements);
        sources.push(
            `// ${context.provenance(modulePath, name)}\n${name === "runBatch" ? "static " : ""}${cppTypes[spec.result]} ${spec.cpp}(${signature.join(", ")}) {\n${lowered}\n${spec.result === "promise" ? "    co_return js::PromiseVoid{};\n" : ""}}`,
        );
    }
    return {
        modulePath,
        symbolName: [...functions.keys()].join(","),
        header: "",
        source: `#include <bblite/pal_gpu_retirement.hpp>\n#include <bblite/js_data.hpp>\nnamespace bbl {\n${sources.join("\n\n")}\n}\n`,
    };
}
