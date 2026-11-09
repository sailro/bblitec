import ts from "typescript";
import { numberPredicateCpp } from "../compiler/number-intrinsics.js";
import { plainArrayBindingNames } from "../compiler/syntax.js";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { jsToUint32Call } from "./pinned-operators.js";
import type {
    PinnedBinding,
    PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";

const modulePath = "src/vat/vat-baker.ts";

/** Prepared VAT validation; only the typed record/map carriers are native adapters. */
export function lowerPreparedVatValidation(context: LoweringContext): string {
    const positive = context.functionDeclaration(modulePath, "positiveInteger");
    const capture = context.functionDeclaration(
        modulePath,
        "validatePreparedCapture",
    );
    const create = context.functionDeclaration(
        modulePath,
        "createVatBakeResults",
    );
    const mapped = context.variableInitializer(create.declaration, "validated");
    if (
        !ts.isCallExpression(mapped) ||
        !context.expressionMatchesShape(mapped.expression, "prepared.map") ||
        mapped.arguments.length !== 1 ||
        !ts.isArrowFunction(mapped.arguments[0]!) ||
        !ts.isBlock(mapped.arguments[0].body)
    )
        context.contractError(
            mapped,
            "Expected the prepared VAT validation map.",
        );
    const callback = mapped.arguments[0];
    const body = callback.body;
    if (!ts.isBlock(body))
        context.contractError(body, "Expected a prepared VAT validation body.");
    context.assertStatementShapes(
        create.declaration,
        create.declaration.body!.statements.slice(1),
        "return uploadPreparedMany(engine, validated);",
        "Prepared VAT validation before upload",
    );
    const calls: PinnedNumericScope["calls"] = new Map([
        [
            "Number.isSafeInteger",
            (args) => `${numberPredicateCpp("isSafeInteger")!}(${args[0]})`,
        ],
        ["Number", (args) => `bbl::js::number_from_string(${args[0]})`],
        [
            "String",
            (args) =>
                `bbl::js::number_to_string(static_cast<double>(${args[0]}))`,
        ],
        [
            "positiveInteger",
            (args) => `vat_positive_integer(${args.join(", ")})`,
        ],
        [
            "validatePreparedCapture",
            (args) => `vat_prepared_capture(${args.join(", ")})`,
        ],
    ]);
    // These tests are settled by the compiler's admitted input carriers,
    // not by field values or the validation predicates around them.
    const representation: PinnedNumericScope["expression"] = (node) => {
        if (ts.isTypeOfExpression(node)) {
            if (context.expressionMatchesShape(node.expression, "capture"))
                return '(capture ? std::string("object") : std::string("undefined"))';
            if (context.expressionMatchesShape(node.expression, "source.clips"))
                return 'std::string("object")';
        }
        if (
            ts.isCallExpression(node) &&
            context.expressionMatchesShape(node.expression, "Array.isArray") &&
            node.arguments.length === 1 &&
            ["capture", "source.clips"].some((source) =>
                context.expressionMatchesShape(node.arguments[0]!, source),
            )
        )
            return "false";
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
            context.expressionMatchesShape(node.right, "Float32Array") &&
            ["values", "source?.data"].some((source) =>
                context.expressionMatchesShape(node.left, source),
            )
        )
            return "true";
        return undefined;
    };
    const positiveBody = lowerPinnedBody(
        positive.file,
        positive.declaration.body!.statements,
        {
            bindings: new Map<string, PinnedBinding>([
                ["value", { cpp: "value", type: "scalar" }],
                ["field", { cpp: "field", type: "string" }],
            ]),
            calls,
            returnValue: (expression, lowerer) => {
                if (!expression)
                    context.contractError(
                        positive.declaration,
                        "Expected a validated VAT count.",
                    );
                return lowerer.expression(expression);
            },
        },
    );
    const captureBody = lowerPinnedBody(
        capture.file,
        capture.declaration.body!.statements,
        {
            bindings: new Map<string, PinnedBinding>([
                [
                    "capture",
                    { cpp: "capture", type: "opaque", absentCpp: "!capture" },
                ],
                ["boneCount", { cpp: "bone_count", type: "scalar" }],
                ["valuesPerFrame", { cpp: "values_per_frame", type: "scalar" }],
                ["frameCount", { cpp: "frame_count", type: "scalar" }],
                ["field", { cpp: "field", type: "string" }],
                [
                    "validated",
                    {
                        cpp: "validated",
                        type: "opaque",
                        indexedStore: (owner, key, value) =>
                            `${owner}.set(${key}, ${value})`,
                    },
                ],
            ]),
            calls,
            expression: representation,
            statement(statement, lowerer, indent) {
                if (
                    ts.isForOfStatement(statement) &&
                    context.expressionMatchesShape(
                        statement.expression,
                        "Object.entries(capture)",
                    )
                ) {
                    const [key, values] = entryNames(context, statement);
                    // Property order is the shared dictionary owner's, as for
                    // JSON/Objects elsewhere. A new nonlocal loop exit refuses.
                    if (
                        context.findNodes(
                            statement.statement,
                            (node) =>
                                ts.isBreakStatement(node) ||
                                ts.isContinueStatement(node) ||
                                ts.isReturnStatement(node),
                        ).length
                    )
                        context.contractError(
                            statement,
                            "Prepared capture property iteration cannot exit its visitor.",
                        );
                    lowerer.bindLocal(key, { cpp: "key", type: "string" });
                    lowerer.bindLocal(values, { cpp: "values", type: "f32" });
                    return [
                        `${indent}bbl::js::for_each_property_entry(*capture,`,
                        `${indent}    [&](const std::string& key, const js::F32Array& values) {`,
                        ...lowerer.statements(
                            statementsOf(statement.statement),
                            indent + "        ",
                        ),
                        `${indent}    });`,
                    ];
                }
                return undefined;
            },
            returnValue(expression, lowerer) {
                if (!expression)
                    context.contractError(
                        capture.declaration,
                        "Expected a prepared capture result.",
                    );
                return context.expressionMatchesShape(expression, "undefined")
                    ? "{}"
                    : lowerer.expression(expression);
            },
        },
    );
    context.assertExpressionShape(
        context.variableInitializer(capture.declaration, "validated"),
        "{}",
        "Prepared capture result storage",
    );
    context.assertExpressionShape(
        context.variableInitializer(callback, "clips"),
        "{}",
        "Prepared clip result storage",
    );
    const payloadBody = lowerPinnedBody(create.file, body.statements, {
        bindings: new Map<string, PinnedBinding>([
            ["source.boneCount", { cpp: "source.bone_count", type: "scalar" }],
            [
                "source.frameCount",
                { cpp: "source.frame_count", type: "scalar" },
            ],
            ["source.data", { cpp: "source.data", type: "f32" }],
            [
                "source.clips",
                { cpp: "source.clips", type: "opaque", absentCpp: "false" },
            ],
            [
                "source.boneOrigins",
                { cpp: "source.bone_origins", type: "opaque" },
            ],
            [
                "source.boneMatrices",
                { cpp: "source.bone_matrices", type: "opaque" },
            ],
            ["clips", { cpp: "bake.clips", type: "opaque" }],
        ]),
        calls,
        expression: representation,
        statement(statement, lowerer, indent) {
            if (
                ts.isForOfStatement(statement) &&
                context.expressionMatchesShape(
                    statement.expression,
                    "Object.entries(source.clips)",
                )
            ) {
                const [name, clip] = entryNames(context, statement);
                lowerer.bindLocal(name, { cpp: "row.name", type: "string" });
                lowerer.bindLocal(clip, {
                    cpp: "row",
                    type: "opaque",
                    absentCpp: "false",
                });
                lowerer.bindPorts(
                    [
                        [
                            `${clip.text}.fromRow`,
                            { cpp: "row.from_row", type: "scalar" },
                        ],
                        [
                            `${clip.text}.frameCount`,
                            { cpp: "row.frame_count", type: "scalar" },
                        ],
                        [
                            `${clip.text}.fps`,
                            { cpp: "row.fps", type: "scalar" },
                        ],
                    ],
                    statement.statement,
                );
                return [
                    `${indent}for (const VatClipRow& row : source.clips) {`,
                    ...lowerer.statements(
                        statementsOf(statement.statement),
                        indent + "    ",
                    ),
                    `${indent}}`,
                ];
            }
            if (
                ts.isExpressionStatement(statement) &&
                ts.isBinaryExpression(statement.expression)
            ) {
                const store = statement.expression;
                if (
                    store.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                    ts.isElementAccessExpression(store.left) &&
                    context.expressionMatchesShape(
                        store.left.expression,
                        "clips",
                    ) &&
                    ts.isObjectLiteralExpression(store.right)
                ) {
                    const record = store.right;
                    if (record.properties.length !== 3)
                        context.contractError(
                            record,
                            "Expected the prepared VAT clip's three fields.",
                        );
                    return [
                        `${indent}bake.clips.push_back(VatClipRow{${[
                            lowerer.expression(store.left.argumentExpression),
                            ...["fromRow", "frameCount", "fps"].map((name) =>
                                lowerer.expression(
                                    context.propertyInitializer(record, name),
                                ),
                            ),
                        ].join(", ")}});`,
                    ];
                }
            }
            if (ts.isReturnStatement(statement)) {
                const result = statement.expression;
                if (
                    !result ||
                    !ts.isObjectLiteralExpression(result) ||
                    result.properties.length !== 6
                )
                    context.contractError(
                        statement,
                        "Expected the prepared VAT result record.",
                    );
                context.assertExpressionShape(
                    context.propertyInitializer(result, "data"),
                    "source.data",
                    "Prepared VAT data identity",
                );
                context.assertExpressionShape(
                    context.propertyInitializer(result, "clips"),
                    "clips",
                    "Prepared VAT clip storage",
                );
                const field = (name: string): string =>
                    lowerer.expression(
                        context.propertyInitializer(result, name),
                    );
                return [
                    `${indent}bake.bone_count = ${jsToUint32Call(field("boneCount"))};`,
                    `${indent}bake.frame_count = ${jsToUint32Call(field("frameCount"))};`,
                    `${indent}bake.bone_origins = ${field("boneOrigins")};`,
                    `${indent}bake.bone_matrices = ${field("boneMatrices")};`,
                    `${indent}return bake;`,
                ];
            }
            return undefined;
        },
    });
    return `
// ${context.provenance(modulePath, "positiveInteger, validatePreparedCapture, createVatBakeResults")}
double vat_positive_integer(double value, [[maybe_unused]] const std::string& field) {
${positiveBody}
}

js::Nullable<js::Map<double, js::F32Array>> vat_prepared_capture(
    const js::Nullable<js::Map<double, js::F32Array>>& capture,
    double bone_count, double values_per_frame, double frame_count,
    [[maybe_unused]] const std::string& field) {
    js::Map<double, js::F32Array> validated;
${captureBody}
}

VatBakeRecord vat_validate_prepared(const PreparedVatPayload& source) {
    VatBakeRecord bake;
${payloadBody}
}
`;
}

function statementsOf(statement: ts.Statement): readonly ts.Statement[] {
    return ts.isBlock(statement) ? statement.statements : [statement];
}

function entryNames(
    context: LoweringContext,
    statement: ts.ForOfStatement,
): readonly [ts.Identifier, ts.Identifier] {
    const initializer = statement.initializer;
    const binding =
        ts.isVariableDeclarationList(initializer) &&
        initializer.declarations.length === 1
            ? initializer.declarations[0]!.name
            : undefined;
    const names = binding && plainArrayBindingNames(binding, 2);
    if (!names)
        context.contractError(statement, "Expected a prepared VAT entry pair.");
    return [names[0]!, names[1]!];
}
