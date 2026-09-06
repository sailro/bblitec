import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    lowerPinnedFunction,
    type PinnedFunctionParameter,
} from "./pinned-function-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCallsWithHypot } from "./pinned-operators.js";

const modulePath = "src/shadow/csm-shadow-task-hooks.ts";

type Shape =
    | { kind: "number" | "boolean" }
    | { kind: "buffer"; width: "f32" | "f64-buffer" }
    | { kind: "array"; element: Shape }
    | { kind: "record"; members: ReadonlyMap<string, Member> }
    | { kind: "optional"; value: Shape };

interface Member {
    shape: Shape;
    cpp: (owner: string) => string;
}

interface Value {
    shape: Shape;
    cpp: string;
    temporary?: true;
}

const number: Shape = { kind: "number" };
const boolean: Shape = { kind: "boolean" };
const f32: Shape = { kind: "buffer", width: "f32" };
const f64: Shape = { kind: "buffer", width: "f64-buffer" };
const optionalNumber: Shape = { kind: "optional", value: number };

function record(members: Readonly<Record<string, Shape | Member>>): Shape {
    return {
        kind: "record",
        members: new Map(Object.entries(members).map(([name, member]) => [
            name,
            "shape" in member
                ? member
                : { shape: member, cpp: (owner: string) => `(${owner}).${name}` },
        ])),
    };
}

function field(shape: Shape, name: string): Member {
    return { shape, cpp: (owner) => `(${owner}).${name}` };
}

const configShape = record({
    _numCascades: number,
    _lambda: number,
    _cascadeBlendPercentage: number,
    _stabilizeCascades: boolean,
    _shadowMaxZ: optionalNumber,
    _bias: number,
    _worldSpaceBias: optionalNumber,
    _darkness: number,
    _frustumEdgeFalloff: number,
    _mapSize: number,
    _forceRefreshEveryFrame: boolean,
});
const cascadesShape = record({
    _transforms: { kind: "array", element: f32 },
    _views: { kind: "array", element: f32 },
    _near: f64,
    _far: f64,
    _viewFrustumZ: f64,
    _frustumLengths: f64,
});
const cornersShape: Shape = { kind: "array", element: f64 };
const scratchShape = record({
    _cascades: cascadesShape,
    _view: f32,
    _invViewProj: f32,
    _corners: cornersShape,
    _aabb: f64,
});
const cameraShape = record({
    nearPlane: field(number, "near_plane"),
    farPlane: field(number, "far_plane"),
});
const lightShape = record({ direction: record({ x: number, y: number, z: number }) });
const thinShape = record({ count: number, matrices: f32 });
const boundsShape = record({ _bounds: f64 });
const casterShape = record({
    worldMatrix: field(f64, "world"),
    boundMin: field(f32, "bounds_min"),
    boundMax: field(f32, "bounds_max"),
    thinInstances: {
        shape: { kind: "optional", value: thinShape },
        cpp: (owner) => `csm_thin_instance_input(${owner})`,
    },
});

const sourceCheckers = new WeakMap<ts.SourceFile, ts.TypeChecker>();

function sourceChecker(source: ts.SourceFile): ts.TypeChecker {
    const existing = sourceCheckers.get(source);
    if (existing) return existing;
    const host = ts.createCompilerHost({ noLib: true, noResolve: true });
    host.getSourceFile = (name) => name === source.fileName ? source : undefined;
    const checker = ts.createProgram({
        rootNames: [source.fileName],
        options: { noLib: true, noResolve: true, types: [] },
        host,
    }).getTypeChecker();
    sourceCheckers.set(source, checker);
    return checker;
}

/**
 * CSM's record/array representation seam. Scalar expressions, stores, loops
 * and branches still go through PinnedNumericLowerer. Object aliases are
 * resolved by declaration symbols, never by a local's spelling or source text.
 */
class CsmNumericAdapter extends PinnedNumericLowerer {
    private readonly values = new Map<ts.Symbol, Value>();
    private readonly checker: ts.TypeChecker;

    public constructor(
        private readonly context: LoweringContext,
        private readonly source: ts.SourceFile,
        private readonly numeric: PinnedNumericScope,
        private readonly aggregateCalls: ReadonlyMap<
            string, { shape: Shape; cpp: (args: readonly string[]) => string }
        > = new Map(),
    ) {
        super(source, numeric);
        for (const name of ["near", "far"]) {
            numeric.bindings.set(`@native-macro:${name}`, { cpp: name, type: "scalar" });
        }
        this.checker = sourceChecker(source);
    }

    private symbol(node: ts.Identifier): ts.Symbol {
        return this.checker.getSymbolAtLocation(node) ??
            this.context.contractError(node, "Expected a resolved pinned CSM declaration.");
    }

    public bind(name: ts.Identifier, value: Value): void {
        this.values.set(this.symbol(name), value);
        this.bindNumeric(name, value);
    }

    private bindNumeric(node: ts.Expression, value: Value): void {
        const shape = value.shape;
        const cpp = shape.kind === "optional"
            ? shape.value.kind === "number"
                ? `${value.cpp}.value_or(0.0)`
                : `(*${value.cpp})`
            : value.cpp;
        this.numeric.bindings.set(this.context.unwrapExpression(node).getText(this.source), {
            cpp,
            type: shape.kind === "buffer" ? shape.width
                : shape.kind === "boolean" ? "bool" : "scalar",
            ...(shape.kind === "optional"
                ? { absentCpp: shape.value.kind === "number"
                    ? `!${value.cpp}.has_value() || !bbl::js::number_truthy(*${value.cpp})`
                    : `!${value.cpp}.has_value()` }
                : shape.kind === "buffer" || shape.kind === "array" || shape.kind === "record"
                    ? { absentCpp: "false" } : {}),
        });
    }

    private value(expression: ts.Expression): Value | undefined {
        const node = this.context.unwrapExpression(expression);
        if (ts.isIdentifier(node)) {
            const symbol = this.checker.getSymbolAtLocation(node);
            return symbol ? this.values.get(symbol) : undefined;
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const call = this.aggregateCalls.get(node.expression.text);
            if (call) return {
                shape: call.shape,
                cpp: call.cpp(node.arguments.map((argument) => this.expression(argument))),
                temporary: true,
            };
        }
        if (ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
            const left = this.value(node.left);
            if (left && left.shape.kind !== "optional") return left;
            return undefined;
        }
        if (ts.isPropertyAccessExpression(node)) {
            let owner = this.value(node.expression);
            if (owner?.shape.kind === "optional") {
                owner = { shape: owner.shape.value, cpp: `(*${owner.cpp})` };
            }
            if (owner?.shape.kind !== "record") return undefined;
            const member = owner.shape.members.get(node.name.text);
            if (!member) this.context.contractError(node, `Unmapped pinned CSM member '${node.name.text}'.`);
            return { shape: member.shape, cpp: member.cpp(owner.cpp) };
        }
        if (ts.isElementAccessExpression(node)) {
            const owner = this.value(node.expression);
            if (!owner || (owner.shape.kind !== "array" && owner.shape.kind !== "buffer")) return undefined;
            this.bindNumeric(node.expression, owner);
            return {
                shape: owner.shape.kind === "array" ? owner.shape.element : number,
                cpp: `${owner.cpp}[static_cast<std::size_t>(${this.expression(node.argumentExpression)})]`,
            };
        }
        return undefined;
    }

    public override expression(expression: ts.Expression): string {
        const node = this.context.unwrapExpression(expression);
        if (node.kind === ts.SyntaxKind.NullKeyword) return "std::nullopt";
        if (ts.isBinaryExpression(node)) {
            if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
                node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
                for (const operand of [node.left, node.right]) {
                    const value = this.value(operand);
                    if (value) this.bindNumeric(operand, value);
                }
            }
            const left = this.value(node.left);
            if (left?.shape.kind === "optional") {
                if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
                    return `(${left.cpp}.has_value() ? *${left.cpp} : ${this.expression(node.right)})`;
                }
                if (this.context.unwrapExpression(node.right).kind === ts.SyntaxKind.NullKeyword &&
                    (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
                        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
                    return `${node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? "!" : ""}${left.cpp}.has_value()`;
                }
            }
        }
        if (ts.isPropertyAccessExpression(node) && node.name.text === "length") {
            const owner = this.value(node.expression);
            if (owner?.shape.kind === "array" || owner?.shape.kind === "buffer") {
                return `static_cast<double>(${owner.cpp}.size())`;
            }
        }
        const value = this.value(node);
        if (value) {
            this.bindNumeric(node, value);
            if (value.shape.kind === "optional") {
                return value.shape.value.kind === "number"
                    ? `${value.cpp}.value_or(0.0)` : `(*${value.cpp})`;
            }
            if (value.shape.kind === "number") return `static_cast<double>(${value.cpp})`;
            return value.cpp;
        }
        try {
            return super.expression(node);
        } catch (error) {
            if (!(error instanceof Error)) throw error;
            return this.context.contractError(node, error.message);
        }
    }

    public override statement(statement: ts.Statement, indent: string): string[] {
        if (ts.isIfStatement(statement)) {
            const value = this.value(statement.expression);
            if (value) this.bindNumeric(statement.expression, value);
        }
        if (ts.isVariableStatement(statement)) {
            return statement.declarationList.declarations.flatMap((declaration) => {
                const value = declaration.initializer ? this.value(declaration.initializer) : undefined;
                if (value && value.shape.kind !== "number" && value.shape.kind !== "boolean") {
                    if (!ts.isIdentifier(declaration.name) ||
                        !(statement.declarationList.flags & ts.NodeFlags.Const)) {
                        return this.context.contractError(declaration, "Expected a constant pinned CSM object alias.");
                    }
                    const cpp = `csm_ref_${declaration.getStart(this.source)}`;
                    this.bind(declaration.name, { shape: value.shape, cpp });
                    return [`${indent}auto${value.temporary || value.shape.kind === "optional" ? "" : "&"} ${cpp} = ${value.cpp};`];
                }
                const one = ts.factory.updateVariableStatement(statement, statement.modifiers,
                    ts.factory.updateVariableDeclarationList(statement.declarationList, [declaration]));
                return super.statement(one, indent);
            });
        }
        if (ts.isForOfStatement(statement)) {
            const collection = this.value(statement.expression);
            const list = statement.initializer;
            const declaration = ts.isVariableDeclarationList(list) && list.declarations.length === 1
                ? list.declarations[0] : undefined;
            if (!collection || collection.shape.kind !== "array" ||
                !declaration || !ts.isIdentifier(declaration.name) || statement.awaitModifier) {
                return this.context.contractError(statement, "Unsupported pinned CSM object iteration.");
            }
            const cpp = `csm_item_${declaration.getStart(this.source)}`;
            const name = declaration.name;
            const element = collection.shape.element;
            return this.withBindings(() => {
                const values = new Map(this.values);
                try {
                    this.bind(name, { shape: element, cpp });
                    const body = ts.isBlock(statement.statement) ? statement.statement.statements : [statement.statement];
                    return [
                        `${indent}for (auto& ${cpp} : ${collection.cpp}) {`,
                        ...body.flatMap((child) => this.statement(child, `${indent}    `)),
                        `${indent}}`,
                    ];
                } finally {
                    this.values.clear();
                    for (const [key, value] of values) this.values.set(key, value);
                }
            });
        }
        if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
            const expression = statement.expression;
            const target = this.context.unwrapExpression(expression.left);
            if (ts.isElementAccessExpression(target)) {
                const owner = this.value(target.expression);
                if (owner) this.bindNumeric(target.expression, owner);
            } else if (ts.isPropertyAccessExpression(target)) {
                const value = this.value(target);
                if (value) this.bindNumeric(target, value);
            }
        }
        return super.statement(statement, indent);
    }
}

interface Parameter {
    name: string;
    annotation: string;
    cpp: string;
    shape: Shape;
}

function numericScope(): PinnedNumericScope {
    const calls = pinnedNumericMathCallsWithHypot();
    calls.set("Math.round", (args) => `bbl::js::round_js(${args.join(", ")})`);
    calls.set("Number.isFinite", (args) => `std::isfinite(${args.join(", ")})`);
    return { bindings: new Map(), calls, booleanAnd: true };
}

function bindParameters(
    context: LoweringContext,
    lowerer: CsmNumericAdapter,
    declaration: ts.FunctionDeclaration,
    parameters: readonly Parameter[],
): void {
    if (declaration.parameters.length !== parameters.length) {
        context.contractError(declaration, "Pinned CSM parameter count changed.");
    }
    declaration.parameters.forEach((parameter, index) => {
        const expected = parameters[index]!;
        if (!ts.isIdentifier(parameter.name) || parameter.name.text !== expected.name ||
            parameter.type?.getText() !== expected.annotation) {
            context.contractError(parameter, `Expected pinned CSM '${expected.name}: ${expected.annotation}'.`);
        }
        lowerer.bind(parameter.name, { shape: expected.shape, cpp: expected.cpp });
    });
}

function constant(
    context: LoweringContext,
    name: string,
): { declaration: ts.VariableDeclaration; values: readonly (readonly number[])[] } {
    const file = context.sourceFile(modulePath);
    const declaration = context.findNodes(file, ts.isVariableDeclaration).find(
        (node) => ts.isIdentifier(node.name) && node.name.text === name);
    const literal = declaration?.initializer ? context.unwrapExpression(declaration.initializer) : undefined;
    if (!declaration || !literal || !ts.isArrayLiteralExpression(literal)) {
        return context.contractError(file, `Expected pinned CSM constant '${name}'.`);
    }
    const values = literal.elements.map((row) => {
        const tuple = context.unwrapExpression(row);
        if (!ts.isArrayLiteralExpression(tuple)) return context.contractError(tuple, "Expected CSM NDC tuple.");
        return tuple.elements.map((lane) => context.numericValue(lane, file));
    });
    if (values.length !== 8 || values.some((row) => row.length !== 3)) {
        context.contractError(literal, "Expected eight three-component CSM frustum corners.");
    }
    return { declaration, values };
}

function lowerTransformCoordinate(context: LoweringContext): string {
    return lowerPinnedFunction(context, modulePath, "transformCoordInto", [
        { pinned: "out", kind: "record", annotation: "number[]", cpp: "out",
            cppType: "std::array<double, 3>", mutableRecord: true, binding: { cpp: "out", type: "f64-buffer" } },
        { pinned: "m", kind: "numberArray", cpp: "m", cppType: "Matrix" },
        ...["x", "y", "z"].map((pinned): PinnedFunctionParameter => ({ pinned, kind: "number", cpp: pinned })),
    ], { cppName: "csm_transform_coord_into", inline: true, templateParameters: ["typename Matrix"], returns: "void" });
}

function lowerCsmMatrixHelpers(context: LoweringContext): string {
    const scalar = (pinned: string): PinnedFunctionParameter => ({ pinned, kind: "number", cpp: pinned });
    return [
        lowerPinnedFunction(context, modulePath, "buildLightViewMatrixInto", [
            { pinned: "out", kind: "mat4", annotation: "Float32Array", cpp: "out" },
            ...["dirX", "dirY", "dirZ", "px", "py", "pz"].map(scalar),
        ], { cppName: "build_light_view_matrix_into", inline: true, calls: numericScope().calls, returns: "void" }),
        lowerPinnedFunction(context, "src/math/mat4-invert-to-ref.ts", "mat4InvertToRefOrIdentity", [
            { pinned: "input", kind: "mat4Const", cpp: "input", cppType: "Matrix" },
            { pinned: "result", kind: "mat4", annotation: "Mat4", cpp: "result" },
        ], { cppName: "mat4_invert_to_ref_or_identity", inline: true, templateParameters: ["typename Matrix"],
            calls: numericScope().calls, returns: "void" }),
        lowerPinnedFunction(context, modulePath, "orthoViewInto", [
            { pinned: "out", kind: "mat4", annotation: "Float32Array", cpp: "out" },
            { pinned: "view", kind: "matrix", cpp: "view" },
            ...["l", "r", "b", "t", "n", "f"].map(scalar),
        ], { cppName: "ortho_view_into", inline: true, calls: numericScope().calls, returns: "void" }),
        lowerTransformCoordinate(context),
        lowerPinnedFunction(context, modulePath, "_biasViewProjection", [
            { pinned: "matrix", kind: "mat4", annotation: "Float32Array", cpp: "matrix" },
            scalar("clipOffset"),
        ], { cppName: "csm_bias_view_projection", inline: true, returns: "void" }),
        lowerPinnedFunction(context, modulePath, "csmWorldBiasClipOffset", [
            scalar("worldSpaceBias"),
            { pinned: "near", kind: "number", cpp: "near_plane" },
            { pinned: "far", kind: "number", cpp: "far_plane" },
        ], { cppName: "csm_world_bias_clip_offset", inline: true,
            calls: numericScope().calls, booleanOr: true, returns: "double" }),
    ].join("\n\n");
}

function assertStorageContracts(context: LoweringContext): void {
    for (const [name, fields] of [
        ["CsmConfig", {
            _numCascades: "number", _lambda: "number", _cascadeBlendPercentage: "number",
            _stabilizeCascades: "boolean", _shadowMaxZ: "number | null", _bias: "number",
            _worldSpaceBias: "number | null", _darkness: "number", _frustumEdgeFalloff: "number",
            _mapSize: "number", _forceRefreshEveryFrame: "boolean",
        }],
        ["CsmCascades", {
            _transforms: "Float32Array[]", _views: "Float32Array[]", _near: "number[]",
            _far: "number[]", _viewFrustumZ: "number[]", _frustumLengths: "number[]",
        }],
        ["CsmCascadeScratch", {
            _cascades: "CsmCascades", _view: "Float32Array", _invViewProj: "Float32Array",
            _corners: "number[][]", _aabb: "number[]",
        }],
    ] as const) {
        const { declaration } = context.interfaceDeclaration(modulePath, name);
        const expected = new Map<string, string>(Object.entries(fields));
        for (const member of declaration.members) {
            if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name) ||
                member.questionToken || member.type?.getText() !== expected.get(member.name.text)) {
                context.contractError(member, `Pinned CSM storage changed in ${name}.`);
            }
            expected.delete(member.name.text);
        }
        if (expected.size) context.contractError(declaration, `Missing CSM storage members in ${name}.`);
    }
    const { declaration } = context.functionDeclaration(modulePath, "_createCascadeScratch");
    const result = context.returnObject(declaration);
    for (const field of ["_view", "_invViewProj"]) {
        const initializer = context.unwrapExpression(context.propertyInitializer(result, field));
        if (!ts.isNewExpression(initializer) || !ts.isIdentifier(initializer.expression) ||
            initializer.expression.text !== "Float32Array" || initializer.arguments?.length !== 1 ||
            context.numericValue(initializer.arguments[0]!, initializer.getSourceFile()) !== 16) {
            context.contractError(initializer, `Expected 16 Float32Array lanes for ${field}.`);
        }
    }
    // Projection/aspect ownership stays with the renderer's pinned camera
    // lowering. This adapter consumes that result, not a second camera formula.
    const { declaration: aspect } = context.functionDeclaration(modulePath, "csmCameraAspect");
    context.assertExpressionShape(context.variableInitializer(aspect, "rt"),
        "scene.surface.scRT", "CSM aspect target");
    context.expectShapeCount(aspect, "getEffectiveAspectRatio(camera, rt._width, rt._height)", "CSM camera aspect");
}

/**
 * The flattened native caster carrier is current at each refit. Extract the
 * cold-cache kernel, erasing only cache identity/version bookkeeping; every
 * arithmetic statement, parked-instance test and result store is translated.
 */
function lowerThinBounds(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(modulePath, "_thinInstanceWorldAabb");
    const statements = [...declaration.body!.statements];
    const [cache, worldVersion, lookup, hit, allocate] = statements;
    if (!cache || !worldVersion || !lookup || !hit || !allocate ||
        !ts.isVariableStatement(cache) || !ts.isVariableStatement(worldVersion) ||
        !ts.isVariableStatement(lookup) || !ts.isIfStatement(hit) || !ts.isIfStatement(allocate)) {
        return context.contractError(declaration, "Expected the pinned thin-caster cache prelude.");
    }
    for (const statement of [cache, worldVersion, lookup]) {
        if (statement.declarationList.declarations.length !== 1) {
            context.contractError(statement, "Unexpected work in the pinned CSM cache prelude.");
        }
    }
    if (hit.elseStatement || allocate.elseStatement) {
        context.contractError(declaration, "Unexpected CSM cache else branch.");
    }
    context.assertExpressionShape(cache.declarationList.declarations[0]!.initializer!,
        "_getThinCasterAabbCache()", "CSM cache owner");
    context.assertExpressionShape(worldVersion.declarationList.declarations[0]!.initializer!,
        "mesh.worldMatrixVersion", "CSM cached world version");
    context.assertExpressionShape(lookup.declarationList.declarations[0]!.initializer!,
        "cache.get(mesh)", "CSM cache lookup");
    context.assertExpressionShape(hit.expression,
        "entry && entry._version === ti._version && entry._worldVersion === worldVersion", "CSM cache hit");
    context.assertStatementInventory(hit, ts.isBlock(hit.thenStatement) ? hit.thenStatement.statements : [hit.thenStatement],
        "CSM cache hit", "only cache hits are omitted", ["return statement"]);
    context.expectShapeCount(hit, "Number.isFinite(entry._bounds[0]) ? entry : null", "CSM cached result");
    context.assertExpressionShape(allocate.expression, "!entry", "CSM cache allocation");
    if (!ts.isBlock(allocate.thenStatement) || allocate.thenStatement.statements.length !== 2) {
        return context.contractError(allocate, "Expected the CSM cache entry and registration.");
    }
    const assignment = allocate.thenStatement.statements[0];
    if (!assignment || !ts.isExpressionStatement(assignment) ||
        !ts.isBinaryExpression(assignment.expression) ||
        assignment.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        !ts.isIdentifier(assignment.expression.left) ||
        !ts.isObjectLiteralExpression(assignment.expression.right)) {
        return context.contractError(allocate, "Expected the pinned CSM cache entry literal.");
    }
    context.expectShapeCount(allocate.thenStatement.statements[1]!, "cache.set(mesh, entry)", "CSM cache registration");
    const initialBounds = context.unwrapExpression(context.propertyInitializer(assignment.expression.right, "_bounds"));
    if (!ts.isArrayLiteralExpression(initialBounds) || initialBounds.elements.length !== 6) {
        return context.contractError(initialBounds, "Expected six pinned CSM bound lanes.");
    }
    const kernel = statements.slice(5).filter((statement) => {
        if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression) ||
            !ts.isPropertyAccessExpression(statement.expression.left) ||
            !["_version", "_worldVersion"].includes(statement.expression.left.name.text)) return true;
        context.assertExpressionShape(statement.expression,
            statement.expression.left.name.text === "_version" ? "entry._version = ti._version" : "entry._worldVersion = worldVersion",
            "CSM cache version publication");
        return false;
    });
    const scope = numericScope();
    const lowerer = new CsmNumericAdapter(context, file, scope);
    bindParameters(context, lowerer, declaration, [
        { name: "mesh", annotation: "Mesh", cpp: "mesh", shape: casterShape },
        { name: "ti", annotation: 'NonNullable<Mesh["thinInstances"]>', cpp: "ti", shape: thinShape },
    ]);
    lowerer.bind(assignment.expression.left, { shape: boundsShape, cpp: "entry" });
    scope.returnValue = (expression) => expression
        ? lowerer.expression(expression) : context.contractError(declaration, "Expected a CSM bounds result.");
    const initial = initialBounds.elements.map((lane) => lowerer.expression(lane)).join(", ");
    return `// ${context.provenance(modulePath, "_thinInstanceWorldAabb")}
inline std::optional<CsmThinBounds> csm_thin_instance_world_aabb(
    const ShadowCaster& mesh, const CsmThinInstanceInput& ti) {
    CsmThinBounds entry{{${initial}}};
${kernel.flatMap((statement) => lowerer.statement(statement, "    ")).join("\n")}
}`;
}

function lowerCasterBounds(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(modulePath, "_castersWorldAabbInto");
    const scope = numericScope();
    const lowerer = new CsmNumericAdapter(context, file, scope, new Map([
        ["_thinInstanceWorldAabb", {
            shape: { kind: "optional", value: boundsShape },
            cpp: (args: readonly string[]) => `csm_thin_instance_world_aabb(${args.join(", ")})`,
        }],
    ]));
    bindParameters(context, lowerer, declaration, [
        { name: "casterMeshes", annotation: "readonly Mesh[]", cpp: "casters", shape: { kind: "array", element: casterShape } },
        { name: "scratch", annotation: "CsmCascadeScratch", cpp: "scratch", shape: scratchShape },
    ]);
    scope.returnValue = (expression) => expression
        ? lowerer.expression(expression) : context.contractError(declaration, "Expected a CSM bounds validity result.");
    return `// ${context.provenance(modulePath, "_castersWorldAabbInto")}
inline bool csm_casters_world_aabb_into(
    const std::vector<ShadowCaster>& casters, CsmCascadeScratch& scratch) {
${declaration.body!.statements.flatMap((statement) => lowerer.statement(statement, "    ")).join("\n")}
}`;
}

function lowerInstancePredicate(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(modulePath, "_thinInstanceWorldAabb");
    const magnitude = context.variableInitializer(declaration, "lin").parent;
    if (!ts.isVariableDeclaration(magnitude) || !ts.isIdentifier(magnitude.name) ||
        !ts.isVariableDeclarationList(magnitude.parent) || !ts.isVariableStatement(magnitude.parent.parent)) {
        return context.contractError(magnitude, "Expected the pinned instance linear-magnitude declaration.");
    }
    const statement = magnitude.parent.parent;
    if (!ts.isBlock(statement.parent)) return context.contractError(statement, "Expected the pinned instance loop.");
    const guard = statement.parent.statements[statement.parent.statements.indexOf(statement) + 1];
    if (!guard || !ts.isIfStatement(guard) || guard.elseStatement ||
        !ts.isBlock(guard.thenStatement) || guard.thenStatement.statements.length !== 1 ||
        !ts.isContinueStatement(guard.thenStatement.statements[0]!)) {
        return context.contractError(statement, "Expected the pinned parked-instance continue guard.");
    }
    const scope = numericScope();
    scope.bindings.set("mats", { cpp: "instance", type: "f32" });
    scope.bindings.set("o", { cpp: "0.0", type: "scalar" });
    const lowerer = new PinnedNumericLowerer(file, scope);
    return `// ${context.provenance(modulePath, "_thinInstanceWorldAabb", "its parked-instance guard")}
inline bool csm_instance_contributes(const std::array<float, 16>& instance) {
${lowerer.statement(statement, "    ").join("\n")}
    return !(${lowerer.expression(guard.expression)});
}`;
}

function lowerCascades(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(modulePath, "_computeCsmCascades");
    const scope = numericScope();
    const calls = new Map(scope.calls);
    calls.set("csmCameraAspect", (args) => {
        if (args.length !== 2) context.contractError(declaration, "Expected the pinned CSM aspect arguments.");
        return args[0]!;
    });
    for (const [pinned, cpp] of [
        ["_castersWorldAabbInto", "csm_casters_world_aabb_into"],
        ["transformCoordInto", "csm_transform_coord_into"],
        ["buildLightViewMatrixInto", "build_light_view_matrix_into"],
        ["mat4InvertToRefOrIdentity", "mat4_invert_to_ref_or_identity"],
        ["orthoViewInto", "ortho_view_into"],
    ] as const) {
        calls.set(pinned, (args) => `${cpp}(${args.join(", ")})`);
    }
    scope.calls = calls;
    const lowerer = new CsmNumericAdapter(context, file, scope, new Map([
        ["getViewProjectionMatrix", { shape: f64, cpp: (args: readonly string[]) => `project(${args.join(", ")})` }],
    ]));
    bindParameters(context, lowerer, declaration, [
        { name: "scene", annotation: "SceneContext", cpp: "effective_aspect", shape: number },
        { name: "camera", annotation: "Camera", cpp: "camera", shape: cameraShape },
        { name: "light", annotation: "DirectionalLight", cpp: "light", shape: lightShape },
        { name: "cfg", annotation: "CsmConfig", cpp: "cfg", shape: configShape },
        { name: "casterMeshes", annotation: "readonly Mesh[]", cpp: "casters", shape: { kind: "array", element: casterShape } },
        { name: "scratch", annotation: "CsmCascadeScratch", cpp: "scratch", shape: scratchShape },
    ]);
    const ndc = constant(context, "FRUSTUM_NDC");
    if (!ts.isIdentifier(ndc.declaration.name)) return context.contractError(ndc.declaration, "Expected the NDC binding.");
    lowerer.bind(ndc.declaration.name, { shape: cornersShape, cpp: "csm_frustum_ndc" });
    scope.returnValue = (expression) => expression
        ? lowerer.expression(expression) : context.contractError(declaration, "Expected the CSM cascade result.");
    return `// ${context.provenance(modulePath, "_computeCsmCascades")}
template <typename Camera, typename Light, typename Project>
inline CsmCascades& csm_compute_cascades(
    double effective_aspect, const Camera& camera,
    const Light& light, const CsmConfig& cfg,
    const std::vector<ShadowCaster>& casters, CsmCascadeScratch& scratch,
    const Project& project) {
${declaration.body!.statements.flatMap((statement) => lowerer.statement(statement, "    ")).join("\n")}
}`;
}

function lowerCasterClipBias(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(modulePath, "renderCsmShadowMap");
    const expression = context.variableInitializer(declaration, "clipBias");
    const scope = numericScope();
    scope.calls = new Map([...scope.calls, [
        "csmWorldBiasClipOffset",
        (args: readonly string[]) => `csm_world_bias_clip_offset(${args.join(", ")})`,
    ]]);
    const lowerer = new CsmNumericAdapter(context, file, scope);
    const cfg = declaration.parameters.find((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === "cfg");
    const cascades = context.findNodes(declaration, ts.isVariableDeclaration).find(
        (node) => ts.isIdentifier(node.name) && node.name.text === "cascades");
    let loop: ts.Node = expression;
    while (!ts.isForStatement(loop) && loop.parent) loop = loop.parent;
    const index = ts.isForStatement(loop) && loop.initializer && ts.isVariableDeclarationList(loop.initializer)
        ? loop.initializer.declarations[0] : undefined;
    if (!cfg || !ts.isIdentifier(cfg.name) || !cascades || !ts.isIdentifier(cascades.name) ||
        !index || !ts.isIdentifier(index.name)) {
        return context.contractError(expression, "Expected the pinned CSM caster bias inputs.");
    }
    lowerer.bind(cfg.name, { shape: configShape, cpp: "cfg" });
    lowerer.bind(cascades.name, { shape: cascadesShape, cpp: "cascades" });
    lowerer.bind(index.name, { shape: number, cpp: "index" });
    return `// ${context.provenance(modulePath, "renderCsmShadowMap")}
inline double csm_caster_clip_bias(const CsmConfig& cfg, const CsmCascades& cascades, std::size_t index) {
    return ${lowerer.expression(expression)};
}`;
}

function lowerReceiverWriter(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(modulePath, "_writeCsmUbo");
    const scope = numericScope();
    scope.methods = new Map([
        ["fill", (receiver: string, args: readonly string[]) => `std::fill(${receiver}.begin(), ${receiver}.end(), static_cast<float>(${args[0]}))`],
        ["set", (receiver: string, args: readonly string[]) => `std::copy(${args[0]}.begin(), ${args[0]}.end(), ${receiver}.begin() + static_cast<std::size_t>(${args[1]}))`],
    ]);
    const lowerer = new CsmNumericAdapter(context, file, scope);
    bindParameters(context, lowerer, declaration, [
        { name: "out", annotation: "Float32Array", cpp: "out", shape: f32 },
        { name: "cascades", annotation: "CsmCascades", cpp: "cascades", shape: cascadesShape },
        { name: "cfg", annotation: "CsmConfig", cpp: "cfg", shape: configShape },
    ]);
    return `// ${context.provenance(modulePath, "_writeCsmUbo")}
template <typename Cascades>
inline void csm_write_ubo(std::array<float, 80>& out, const Cascades& cascades, const CsmConfig& cfg) {
${declaration.body!.statements.flatMap((statement) => lowerer.statement(statement, "    ")).join("\n")}
}`;
}

/** Generated numeric kernels plus their fixed native storage adapters. */
export function pinnedCsmFunctions(context: LoweringContext): string {
    assertStorageContracts(context);
    const ndc = constant(context, "FRUSTUM_NDC");
    return `struct CsmConfig {
    double _numCascades = 0.0;
    double _lambda = 0.0;
    double _cascadeBlendPercentage = 0.0;
    bool _stabilizeCascades = false;
    std::optional<double> _shadowMaxZ;
    double _bias = 0.0;
    std::optional<double> _worldSpaceBias;
    double _darkness = 0.0;
    double _frustumEdgeFalloff = 0.0;
    double _mapSize = 0.0;
    bool _forceRefreshEveryFrame = false;
};

struct CsmCascades {
    std::span<std::array<float, 16>> _transforms;
    std::span<std::array<float, 16>> _views;
    std::span<double> _near;
    std::span<double> _far;
    std::span<double> _viewFrustumZ;
    std::span<double> _frustumLengths;
};

struct CsmCascadeScratch {
    std::array<std::array<float, 16>, csm_max_cascades> transforms{}, views{};
    std::array<double, csm_max_cascades> near_planes{}, far_planes{}, split_z{}, lengths{};
    CsmCascades _cascades{};
    std::array<float, 16> _view{}, _invViewProj{};
    std::array<std::array<double, 3>, 8> _corners{};
    std::array<double, 6> _aabb{};
    explicit CsmCascadeScratch(std::size_t count) {
        if (count > csm_max_cascades) throw std::runtime_error("CSM cascade storage exceeded.");
        _cascades = {{transforms.data(), count}, {views.data(), count},
            {near_planes.data(), count}, {far_planes.data(), count},
            {split_z.data(), count}, {lengths.data(), count}};
    }
    CsmCascadeScratch(const CsmCascadeScratch&) = delete;
    CsmCascadeScratch& operator=(const CsmCascadeScratch&) = delete;
};

struct CsmThinInstanceInput {
    const std::array<float, 16>& matrices;
    double count;
};
struct CsmThinBounds { std::array<double, 6> _bounds{}; };

inline std::optional<CsmThinInstanceInput> csm_thin_instance_input(const ShadowCaster& caster) {
    if (!caster.has_instance) return std::nullopt;
    return CsmThinInstanceInput{caster.instance, 1.0};
}

// ${context.provenance(modulePath, "FRUSTUM_NDC")}
inline constexpr std::array<std::array<double, 3>, 8> csm_frustum_ndc{{
${ndc.values.map((row) => `    {{${row.map((lane) => context.doubleLiteral(lane)).join(", ")}}},`).join("\n")}
}};

${lowerCsmMatrixHelpers(context)}

${lowerThinBounds(context)}

${lowerInstancePredicate(context)}

${lowerCasterBounds(context)}

${lowerCascades(context)}

${lowerReceiverWriter(context)}

${lowerCasterClipBias(context)}
`;
}
