import ts from "typescript";
import { LoweringContext } from "./context.js";

import {
    PinnedNumericLowerer,
    type PinnedBinding,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import { pinnedQuaternionMath } from "./pinned-euler-proxy.js";
import { pinnedTrsComposition } from "./pinned-trs.js";
import { assertAsyncSceneBuilder } from "./scene-deferred.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { lowerTextFunctions } from "./text-records.js";

const module = "src/text/text-renderable.ts";
const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });

/** CPU text transport. Renderer activation remains a separate reached consumer. */
export class TextLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public header(): string {
        return `#pragma once
#include <bblite/upstream_text_records.hpp>
#include <bblite/js_data.hpp>
#include <cmath>
#include <cstring>
namespace bbl {
namespace text_detail {
${this.quaternionMath()}
} // namespace text_detail
${this.factory()}
${this.alphaToCoverage()}
${this.transforms()}
${this.attachment()}
} // namespace bbl
`;
    }

    /** The pin's alpha-to-coverage membership, lowered whole. */
    private alphaToCoverage(): string {
        const { declarations, definitions } = lowerTextFunctions(
            this.context,
            "coverage",
            ["records"],
        );
        return `${declarations}\n${definitions}`;
    }

    private quaternionMath(): string {
        return pinnedQuaternionMath(this.context);
    }

    private factory(): string {
        const c: LoweringContext = this.context;
        const { file, declaration } = c.functionDeclaration(
            module,
            "createTextRenderable",
        );
        const object = c.variableInitializer(declaration, "r");
        if (!ts.isObjectLiteralExpression(object))
            c.contractError(object, "Expected the text factory object.");
        const names = object.properties.map((property) =>
            property.name?.getText(file),
        );
        const expected = [
            "_entityType",
            "order",
            "isTransparent",
            "position",
            "rotationQuaternion",
            "rotation",
            "scaling",
            "opacity",
            "ignoreDepth",
            "_data",
            "_wmDirty",
            "_gpu",
            "_version",
            "_worldMatrix",
            "bind",
        ];
        if (names.join() !== expected.join())
            c.contractError(
                object,
                "Text factory fields changed; update the native identity/default adapter.",
            );
        const literal = (expression: ts.Expression): string =>
            new PinnedNumericLowerer(file, {
                bindings: new Map(),
                calls: new Map(),
            }).expression(expression);
        const fallback = (
            expression: ts.Expression,
            source: string,
            cpp: string,
        ): string => {
            if (
                !ts.isBinaryExpression(expression) ||
                expression.operatorToken.kind !==
                    ts.SyntaxKind.QuestionQuestionToken
            )
                c.contractError(
                    expression,
                    "Expected a text option nullish default.",
                );
            c.assertExpressionShape(
                expression.left,
                source,
                "Text option default",
            );
            return `${cpp}.value_or(${literal(expression.right)})`;
        };
        const option = (name: string, native = name) =>
            fallback(
                c.propertyInitializer(object, name),
                `options?.${name}`,
                `options.${native}`,
            );
        const vector = (name: string, source: string) => {
            const init = c.propertyInitializer(object, name);
            if (
                !ts.isNewExpression(init) ||
                init.expression.getText(file) !== "ObservableVec3" ||
                init.arguments?.length !== 4
            )
                c.contractError(
                    init,
                    "Expected an observable text vector and dirty callback.",
                );
            c.assertExpressionShape(
                init.arguments[3]!,
                "markDirty",
                "Text vector callback",
            );
            return (
                "{" +
                ["x", "y", "z"]
                    .map((lane, index) => {
                        const argument = init.arguments![index]!;
                        if (
                            !ts.isBinaryExpression(argument) ||
                            argument.operatorToken.kind !==
                                ts.SyntaxKind.QuestionQuestionToken
                        )
                            c.contractError(
                                argument,
                                "Expected optional text vector component.",
                            );
                        c.assertExpressionShape(
                            argument.left,
                            `${source}?.${lane}`,
                            "Text vector default",
                        );
                        return `(options.${name} ? options.${name}->${lane} : ${literal(argument.right)})`;
                    })
                    .join(", ") +
                "}"
            );
        };
        const rq = c.variableInitializer(declaration, "initRq");
        if (
            !ts.isBinaryExpression(rq) ||
            !ts.isObjectLiteralExpression(rq.right)
        )
            c.contractError(rq, "Expected the text quaternion default.");
        c.assertExpressionShape(rq.left, "rq", "Text quaternion option");
        const quaternion = ["x", "y", "z", "w"].map((lane) =>
            literal(
                c.propertyInitializer(
                    rq.right as ts.ObjectLiteralExpression,
                    lane,
                ),
            ),
        );
        for (const [name, member] of [
            ["pos", "position"],
            ["rq", "rotationQuaternion"],
            ["sc", "scaling"],
        ])
            c.assertExpressionShape(
                c.variableInitializer(declaration, name!),
                `options?.${member}`,
                "Text transform option",
            );
        c.expectShapeCount(
            declaration,
            "createWorldMatrixState(() => composeTrsLocalMatrix(r.position, r.rotationQuaternion, r.scaling))",
            "Text parent-free world state",
        );
        c.expectShapeCount(
            declaration,
            "createEulerProxy(quat)",
            "Text Euler proxy",
        );
        return `// ${c.provenance(module, "createTextRenderable")}
inline TextRenderable create_text_renderable(TextData data, const TextRenderableOptions& options = {}) {
    auto result = std::make_shared<TextRenderableState>();
    result->data = std::move(data);
    result->position = ${vector("position", "pos")};
    result->scaling = ${vector("scaling", "sc")};
    result->rotation_quaternion = options.rotation_quaternion.value_or(TextQuaternion{${quaternion.join(", ")}});
    result->opacity = ${option("opacity")};
    result->order = ${option("order")};
    result->ignore_depth = ${option("ignoreDepth", "ignore_depth")};
    result->is_transparent = ${literal(c.propertyInitializer(object, "isTransparent"))};
    result->wm_dirty = ${literal(c.propertyInitializer(object, "_wmDirty"))};
    result->version = ${literal(c.propertyInitializer(object, "_version"))};
    return result;
}
`;
    }

    private transforms(): string {
        const c: LoweringContext = this.context;
        const factory = c.functionDeclaration(module, "createTextRenderable");
        const mark = c.variableInitializer(factory.declaration, "markDirty");
        if (!ts.isArrowFunction(mark) || !ts.isBlock(mark.body))
            c.contractError(mark, "Expected text dirty callback.");
        c.assertStatementInventory(
            mark,
            mark.body.statements,
            "markDirty",
            "native text invalidation",
            ["expression statement", "expression statement"],
        );
        c.assertExpressionShape(
            (mark.body.statements[0] as ts.ExpressionStatement).expression,
            "r._wmDirty = true",
            "Text dirty bit",
        );
        c.assertExpressionShape(
            (mark.body.statements[1] as ts.ExpressionStatement).expression,
            "wm.markLocalDirty()",
            "Text world invalidation",
        );
        const wm = c.functionDeclaration(
            "src/scene/world-matrix-state.ts",
            "createWorldMatrixState",
        );
        const invalidate = c.findNodes(
            wm.declaration,
            (node): node is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(node) &&
                node.name?.text === "invalidate",
        )[0]!;
        c.assertStatementInventory(
            invalidate,
            invalidate.body!.statements,
            "invalidate",
            "parent-free text invalidation",
            ["expression statement", "expression statement", "other statement"],
        );
        c.expectShapeCount(
            invalidate,
            "_cachedWorld = null",
            "Text world cache reset",
        );
        c.expectShapeCount(
            invalidate,
            "_worldVersion++",
            "Text world version increment",
        );
        let out = `inline void text_mark_dirty(TextRenderableState& r) {
    r.wm_dirty = true;
    r.world_cached = false;
    ++r.world_version;
}
`;
        for (const [className, field, lanes] of [
            ["ObservableVec3", "position", ["x", "y", "z"]],
            ["ObservableVec3", "scaling", ["x", "y", "z"]],
            ["ObservableQuat", "rotation_quaternion", ["x", "y", "z", "w"]],
        ] as const) {
            const { file, declaration: owner } = c.classDeclaration(
                `src/math/${className === "ObservableQuat" ? "observable-quat" : "observable-vec3"}.ts`,
                className,
            );
            const bindings = new Map<string, PinnedBinding>([
                ["v", scalar("value")],
                ["this._version", scalar("r.quaternion_version")],
                ...lanes.map((lane): [string, PinnedBinding] => [
                    `this._${lane}`,
                    scalar(`r.${field}.${lane}`),
                ]),
                ...lanes.map((lane): [string, PinnedBinding] => [
                    lane,
                    scalar(lane),
                ]),
            ]);
            const scope: PinnedNumericScope = {
                bindings,
                calls: new Map<string, (args: readonly string[]) => string>([
                    ["this._onDirty", () => "text_mark_dirty(r)"],
                ]),
            };
            out += `inline void text_write_${field}(TextRenderableState& r, std::size_t axis, double value) {\n    switch (axis) {\n`;
            for (const [index, lane] of lanes.entries()) {
                const setter = owner.members.find(
                    (member): member is ts.SetAccessorDeclaration =>
                        ts.isSetAccessorDeclaration(member) &&
                        member.name.getText(file) === lane,
                )!;

                out += `    case ${index}: {\n${lowerPinnedBody(file, setter.body!.statements, scope, "        ")}\n        return;\n    }\n`;
            }
            out += `    default: throw std::out_of_range("Text vector component");\n    }\n}\n`;
            const set = owner.members.find(
                (member): member is ts.MethodDeclaration =>
                    ts.isMethodDeclaration(member) &&
                    member.name.getText(file) === "set",
            )!;
            out += `inline void text_set_${field}(TextRenderableState& r, ${lanes.map((lane) => `double ${lane}`).join(", ")}) {\n${new PinnedNumericLowerer(file, scope).statements(set.body!.statements, "    ").join("\n")}\n}\n`;
        }
        const proxy = c.functionDeclaration(
            "src/scene/scene-node.ts",
            "createEulerProxy",
        );
        const bindings = new Map<string, PinnedBinding>([
            ["syncedVersion", scalar("r.synced_quaternion_version")],
            ["rq.version", scalar("r.quaternion_version")],
            ...["x", "y", "z"].map((lane): [string, PinnedBinding] => [
                `e${lane}`,
                scalar(`r.rotation.${lane}`),
            ]),
            ...["x", "y", "z", "w"].map((lane): [string, PinnedBinding] => [
                `rq.${lane}`,
                scalar(`r.rotation_quaternion.${lane}`),
            ]),
            ...["x", "y", "z", "v"].map((lane): [string, PinnedBinding] => [
                lane,
                scalar(lane),
            ]),
        ]);
        const scope: PinnedNumericScope = {
            bindings,
            calls: new Map<string, (args: readonly string[]) => string>([
                [
                    "quatToEulerXYZTuple",
                    (args) =>
                        `text_detail::quat_to_euler_xyz(${args.join(", ")})`,
                ],
                [
                    "eulerXYZToQuatTuple",
                    (args) => `text_detail::euler_to_quat(${args.join(", ")})`,
                ],
                [
                    "rq.set",
                    (args) =>
                        `text_set_rotation_quaternion(r, ${args.join(", ")})`,
                ],
                ["sync", () => "text_sync_rotation(r)"],
                ["apply", (args) => `text_set_rotation(r, ${args.join(", ")})`],
            ]),
            fixedTupleCalls: new Map([["quatToEulerXYZTuple", 3]]),
            tupleCalls: new Map([["eulerXYZToQuatTuple", 4]]),
        };
        for (const [name, cpp, parameters] of [
            ["sync", "text_sync_rotation", ""],
            ["apply", "text_set_rotation", ", double x, double y, double z"],
        ]) {
            const arrow = c.variableInitializer(proxy.declaration, name!);
            if (!ts.isArrowFunction(arrow) || !ts.isBlock(arrow.body))
                c.contractError(arrow, "Expected the pinned Euler closure.");
            out += `inline void ${cpp}(TextRenderableState& r${parameters}) {\n${new PinnedNumericLowerer(proxy.file, scope).statements(arrow.body.statements, "    ").join("\n")}\n}\n`;
        }
        const returned = proxy.declaration.body!.statements.find(
            ts.isReturnStatement,
        )?.expression;
        if (!returned || !ts.isObjectLiteralExpression(returned))
            c.contractError(proxy.declaration, "Expected Euler proxy object.");
        for (const write of [false, true]) {
            out += `inline ${write ? "void text_write_rotation" : "double text_read_rotation"}(TextRenderableState& r, std::size_t axis${write ? ", double v" : ""}) {\n    switch (axis) {\n`;
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
                    c.contractError(returned, "Expected Euler accessors.");

                out += `    case ${index}: {\n${lowerPinnedBody(proxy.file, accessor.body!.statements, { ...scope, returnValue: (expression, lowerer) => lowerer.expression(expression!) }, "        ")}\n${write ? "        return;\n" : ""}    }\n`;
            }
            out += `    default: throw std::out_of_range("Text Euler component");\n    }\n}\n`;
        }
        // This record has a quaternion unconditionally. The shared composition
        // takes that branch; its double intermediates narrow only at matrix stores.
        const composition = pinnedTrsComposition(
            c,
            "transform",
        ).composeWorldBody;
        const composeLocal = c.functionDeclaration(
            "src/scene/world-matrix-state.ts",
            "composeTrsLocalMatrixIntoBuffer",
        );
        c.expectShapeCount(
            composeLocal.declaration,
            "composeMat4IntoBuffer(local, 0, position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w, scaling.x, scaling.y, scaling.z)",
            "Text local matrix dispatch",
        );
        const localBindings = new Map<string, PinnedBinding>();
        for (const [source, field, lanes] of [
            ["position", "position", ["x", "y", "z"]],
            ["rotation", "rotation_quaternion", ["x", "y", "z", "w"]],
            ["scaling", "scaling", ["x", "y", "z"]],
        ] as const)
            for (const lane of lanes)
                localBindings.set(
                    `${source}.${lane}`,
                    scalar(`r.${field}.${lane}`),
                );
        const isIdentity = new PinnedNumericLowerer(composeLocal.file, {
            bindings: localBindings,
            calls: new Map(),
            booleanAnd: true,
        }).expression(
            c.variableInitializer(composeLocal.declaration, "isIdentity"),
        );
        const identity = c.functionDeclaration(
            "src/math/create-identity-mat4.ts",
            "createIdentityMat4",
        );
        c.assertExpressionShape(
            c.variableInitializer(identity.declaration, "m"),
            "allocateMat4()",
            "Zero-filled text identity matrix",
        );
        c.assertStatementInventory(
            identity.declaration,
            identity.declaration.body!.statements,
            "createIdentityMat4",
            "allocated identity stores",
            [
                "variable statement",
                "expression statement",
                "expression statement",
                "expression statement",
                "expression statement",
                "return statement",
            ],
        );
        const identityStores = new PinnedNumericLowerer(identity.file, {
            bindings: new Map([["m", { cpp: "matrix", type: "f32" }]]),
            calls: new Map(),
        })
            .statements(
                identity.declaration.body!.statements.slice(1, -1),
                "            ",
            )
            .join("\n");
        out += `inline const js::TypedArray<float>& text_world_matrix(TextRenderableState& r) {
    if (!r.world_cached) {
        std::array<float, 16> matrix{};
        if (${isIdentity}) {
${identityStores}
        } else {
        struct { Vec3d position; TextQuaternion rotation_quaternion; Vec3d scaling; Vec3d rotation{}; bool has_rotation_quaternion = true; }
            transform{r.position, r.rotation_quaternion, r.scaling};
${composition}
        matrix = world;
        }
        for (std::size_t index = 0; index < matrix.size(); ++index) r.world.store(index, matrix[index]);
        r.world_cached = true;
    }
    return r.world;
}
`;
        return out;
    }

    private attachment(): string {
        const c: LoweringContext = this.context;
        const add = c.functionDeclaration(
            module,
            "addTextRenderable",
        ).declaration;
        c.expectShapeCount(
            add,
            "addDeferredSceneRenderables(scene, () => { return { renderables: [renderable], dispose: () => disposeTextRenderable(renderable) }; })",
            "Retained text deferred attachment",
        );
        const deferred = c.functionDeclaration(
            "src/scene/scene-core.ts",
            "addDeferredSceneRenderables",
        ).declaration;
        assertAsyncSceneBuilder(c, deferred);
        c.expectShapeCount(
            deferred,
            "ctx._renderables.push(...built.renderables)",
            "Deferred scene publication",
        );
        c.expectShapeCount(
            deferred,
            "ctx._disposables.push(built.dispose)",
            "Deferred scene disposal ownership",
        );
        return `#if BBLITE_HAS_TEXT
inline void add_text_renderable(Scene& scene, TextRenderable renderable) {
    if (scene.disposed) throw std::runtime_error("Text attachment after scene disposal requires the pinned async late-cleanup lifecycle.");
    const std::weak_ptr<SceneState> owner = scene.state;
    scene.deferred_builders.emplace_back([owner, renderable = std::move(renderable)] {
        if (const auto state = owner.lock()) {
            state->text_renderables.push_back(renderable);
            state->disposables.push_back([renderable] { dispose_text_renderable(renderable); });
        }
    }, SceneDeferredFailure::promise_rejection);
}
#endif
`;
    }
}
