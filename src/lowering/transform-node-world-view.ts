import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { lowerMat4MultiplyWriterCpp } from "./pinned-function-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { recordAt } from "../compiler/record-access.js";

/** The pin's lazy world getter over retained native matrix owners. */
export function lowerTransformNodeWorldView(context: LoweringContext): string {
    const module = "src/scene/world-matrix-state.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "createWorldMatrixState",
    );
    const method = (name: string) =>
        context.propertyFunction(module, "createWorldMatrixState", name)
            .declaration;
    const getter = method("getWorldMatrix");
    const dirty = method("markLocalDirty");
    context.assertStatementShapes(
        dirty,
        dirty.body.statements,
        "_cachedLocal = null; invalidate();",
        "Transform local cache invalidation",
    );
    const invalidate = context.findNodes(
        declaration,
        (node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) && node.name?.text === "invalidate",
    )[0];
    if (!invalidate?.body)
        context.contractError(declaration, "Missing world-state invalidation.");
    context.assertStatementShapes(
        invalidate,
        invalidate.body.statements,
        "_cachedWorld = null; _worldVersion++; for (const child of _children) { child._invalidate(); }",
        "Transform subtree cache invalidation",
    );

    // TransformNode parents are represented engine nodes. Foreign providers
    // are refused by the parent setter, so their polling arm is not reached.
    const statements = getter.body.statements;
    context.assertStatementShapes(
        getter,
        [statements[0]!],
        "if (_parentState === null && _parent !== null) { pollForeignParent(); }",
        "Foreign world-matrix parent polling",
    );
    const bindings = new Map<string, PinnedBinding>([
        [
            "_cachedWorld",
            {
                cpp: "*cache.world",
                type: "f32",
                absentCpp: "!cache.world",
                absentValue: "null",
            },
        ],
        [
            "_ownedWorld",
            { cpp: "cache.world_owner", type: "f32", mutable: true },
        ],
        [
            "_parent",
            {
                cpp: "record.parent",
                type: "opaque",
                absentCpp:
                    "record.parent.value >= engine.transform_nodes.size()",
                absentValue: "null",
            },
        ],
        ["local", { cpp: "local", type: "f32" }],
        ["pw", { cpp: "pw", type: "f32" }],
    ]);
    const body = lowerPinnedBody(file, statements.slice(1), {
        bindings,
        calls: new Map([
            [
                "multiplyMat4IntoBuffer",
                (args) =>
                    `mat4_multiply_into_view(${args.map((arg, index) => (index % 2 === 1 ? `static_cast<std::size_t>(${arg})` : arg)).join(", ")})`,
            ],
        ]),
        statement(statement, lowerer, indent) {
            if (
                ts.isVariableStatement(statement) &&
                statement.declarationList.declarations.length === 1
            ) {
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name) || !variable.initializer)
                    return undefined;
                if (variable.name.text === "local") {
                    context.assertExpressionShape(
                        context.unwrapExpression(variable.initializer),
                        "_cachedLocal ??= getLocalMatrix()",
                        "Lazy transform local matrix",
                    );
                    return [
                        `${indent}if (!cache.local) cache.local = transform_node_local_view(record, cache);`,
                        `${indent}const js::F32Array local = *cache.local;`,
                    ];
                }
                if (variable.name.text === "pw") {
                    context.assertExpressionShape(
                        variable.initializer,
                        "_parent.worldMatrix",
                        "Parent world matrix view",
                    );
                    return [
                        `${indent}const js::F32Array pw = transform_node_world_view(engine, record.parent);`,
                    ];
                }
            }
            if (
                ts.isExpressionStatement(statement) &&
                ts.isBinaryExpression(statement.expression)
            ) {
                const assignment = statement.expression;
                if (
                    ts.isIdentifier(assignment.left) &&
                    assignment.left.text === "_cachedWorld" &&
                    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
                ) {
                    return [
                        `${indent}cache.world = ${lowerer.expression(assignment.right)};`,
                    ];
                }
            }
            return undefined;
        },
        returnValue: (value, lowerer) => {
            if (!value)
                context.contractError(
                    getter,
                    "World getter must return its retained matrix.",
                );
            return lowerer.expression(value);
        },
    });

    const scene = context.functionDeclaration(
        "src/scene/scene-node.ts",
        "initSceneNodeTransform",
    );
    const state = context.variableInitializer(scene.declaration, "wm");
    if (!ts.isCallExpression(state) || !state.arguments[0])
        context.contractError(
            state,
            "SceneNode world state requires a local matrix producer.",
        );
    context.assertExpressionShape(
        state.arguments[0],
        `() => {
        if (node._localMatrix) { return node._localMatrix; }
        localMatrix ??= allocateMat4();
        composeTrsLocalMatrixIntoBuffer(localMatrix as unknown as Mat4Storage, position, rq, scaling);
        return localMatrix;
    }`,
        "Retained SceneNode local matrix storage",
    );
    return `
${lowerMat4MultiplyWriterCpp(context, "view")}
// ${context.provenance(module, "createWorldMatrixState", "getWorldMatrix; src/scene/scene-node.ts#initSceneNodeTransform")}
inline js::F32Array transform_node_local_view(
    const TransformNodeRecord& record,
    TransformNodeMatrixCache& cache) {
    if (record.local_matrix) return *record.local_matrix;
    if (!cache.trs_owner) cache.trs_owner.emplace(std::size_t{16});
    const auto local = trs_matrix(record);
    for (std::size_t i = 0; i < local.size(); ++i) cache.trs_owner->store(i, local[i]);
    return *cache.trs_owner;
}

inline js::F32Array transform_node_world_view(const Engine& engine, TransformNodeHandle node) {
    const auto& record = ${recordAt("engine.transform_nodes", "node")};
    if (!record.matrix_cache) record.matrix_cache = std::make_shared<TransformNodeMatrixCache>();
    auto& cache = *record.matrix_cache;
${body}
}
`;
}
