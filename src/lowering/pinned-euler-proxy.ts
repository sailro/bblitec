import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    lowerPinnedFunction,
    lowerTupleComponents,
} from "./pinned-function-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import { pinnedHeader } from "./pinned-header.js";

export function pinnedQuaternionHeader(context: LoweringContext): string {
    return pinnedHeader(
        ["<array>", "<cmath>", "<algorithm>"],
        pinnedQuaternionMath(context),
    );
}

/** The pin's quaternion conversions, shared by observable transform adapters. */
export function pinnedQuaternionMath(context: LoweringContext): string {
    const calls = pinnedNumericMathCalls();
    calls.set("Math.asin", (args) => `std::asin(${args.join(", ")})`);
    return (
        [
            ["eulerXYZToQuatTuple", "euler_to_quat", ["rx", "ry", "rz"], 4],
            [
                "quatToEulerXYZTuple",
                "quat_to_euler_xyz",
                ["qx", "qy", "qz", "qw"],
                3,
            ],
        ] as const
    )
        .map(([symbol, cppName, parameters, arity]) =>
            lowerPinnedFunction(
                context,
                "src/math/quat-euler.ts",
                symbol,
                parameters.map((pinned) => ({
                    pinned,
                    cpp: pinned,
                    kind: "number",
                })),
                {
                    cppName,
                    inline: true,
                    calls,
                    returns: {
                        type: `std::array<double, ${arity}>`,
                        value: (lowerer, expression) =>
                            `{${lowerTupleComponents(
                                context,
                                lowerer,
                                expression,
                                {
                                    arity,
                                    at:
                                        expression ??
                                        context.sourceFile(
                                            "src/math/quat-euler.ts",
                                        ),
                                },
                            ).join(", ")}}`,
                    },
                },
            ),
        )
        .join("\n");
}

interface EulerProxyStorage {
    parameters: string;
    arguments: string;
    prefix: string;
    rotation: string;
    quaternion: string;
    version: string;
    syncedVersion: string;
    mathNamespace: string;
    setQuaternion(this: void, args: readonly string[]): string;
}

/** Lower all cached Euler reads/writes, including the pin's version synchronization. */
export function pinnedEulerProxy(
    context: LoweringContext,
    storage: EulerProxyStorage,
): string {
    const proxy = context.functionDeclaration(
        "src/scene/scene-node.ts",
        "createEulerProxy",
    );
    const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });
    const call = (suffix: string, args: readonly string[] = []) =>
        `${storage.prefix}_${suffix}(${[storage.arguments, ...args].join(", ")})`;
    const scope: PinnedNumericScope = {
        bindings: new Map<string, PinnedBinding>([
            ["syncedVersion", scalar(storage.syncedVersion)],
            ["rq.version", scalar(storage.version)],
            ...["x", "y", "z"].map((lane): [string, PinnedBinding] => [
                `e${lane}`,
                scalar(`${storage.rotation}.${lane}`),
            ]),
            ...["x", "y", "z", "w"].map((lane): [string, PinnedBinding] => [
                `rq.${lane}`,
                scalar(`${storage.quaternion}.${lane}`),
            ]),
            ...["x", "y", "z", "v"].map((lane): [string, PinnedBinding] => [
                lane,
                scalar(lane),
            ]),
        ]),
        calls: new Map([
            [
                "quatToEulerXYZTuple",
                (args) =>
                    `${storage.mathNamespace}::quat_to_euler_xyz(${args.join(", ")})`,
            ],
            [
                "eulerXYZToQuatTuple",
                (args) =>
                    `${storage.mathNamespace}::euler_to_quat(${args.join(", ")})`,
            ],
            ["rq.set", storage.setQuaternion],
            ["sync", () => call("sync")],
            ["apply", (args) => call("set", args)],
        ]),
        fixedTupleCalls: new Map([["quatToEulerXYZTuple", 3]]),
        tupleCalls: new Map([["eulerXYZToQuatTuple", 4]]),
    };
    let out = "";
    for (const [name, suffix, parameters] of [
        ["sync", "sync", ""],
        ["apply", "set", ", double x, double y, double z"],
    ] as const) {
        const arrow = context.variableInitializer(proxy.declaration, name);
        if (!ts.isArrowFunction(arrow) || !ts.isBlock(arrow.body))
            context.contractError(arrow, "Expected the pinned Euler closure.");
        out += `inline void ${storage.prefix}_${suffix}(${storage.parameters}${parameters}) {\n${new PinnedNumericLowerer(proxy.file, scope).statements(arrow.body.statements, "    ").join("\n")}\n}\n`;
    }
    const returned = proxy.declaration.body!.statements.find(
        ts.isReturnStatement,
    )?.expression;
    if (!returned || !ts.isObjectLiteralExpression(returned))
        context.contractError(
            proxy.declaration,
            "Expected Euler proxy object.",
        );
    for (const write of [false, true]) {
        out += `inline ${write ? "void" : "double"} ${storage.prefix}_${write ? "write" : "read"}(${storage.parameters}, std::size_t axis${write ? ", double v" : ""}) {\n    switch (axis) {\n`;
        for (const [index, lane] of ["x", "y", "z"].entries()) {
            const accessor = returned.properties.find(
                (property) =>
                    (write
                        ? ts.isSetAccessorDeclaration(property)
                        : ts.isGetAccessorDeclaration(property)) &&
                    property.name?.getText(proxy.file) === lane,
            );
            if (
                !accessor ||
                !(
                    ts.isGetAccessorDeclaration(accessor) ||
                    ts.isSetAccessorDeclaration(accessor)
                )
            )
                context.contractError(returned, "Expected Euler accessors.");
            out += `    case ${index}: {\n${lowerPinnedBody(proxy.file, accessor.body!.statements, { ...scope, returnValue: (expression, lowerer) => lowerer.expression(expression!) }, "        ")}\n${write ? "        return;\n" : ""}    }\n`;
        }
        out += `    default: throw std::out_of_range("Euler component");\n    }\n}\n`;
    }
    return out;
}
