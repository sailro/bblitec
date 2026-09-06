import ts from "typescript";
import { LoweringContext } from "./context.js";
import { lowerObjectComponents, lowerPinnedFunction, lowerTupleComponents } from "./pinned-function-lowerer.js";
import { PinnedNumericLowerer, type PinnedBinding, type PinnedNumericScope } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCallsWithHypot } from "./pinned-operators.js";

const CAMERA = "src/gizmo/camera-gizmo.ts";
const LIGHT = "src/gizmo/light-gizmo.ts";
const CORE = "src/gizmo/gizmo-core.ts";
const BOUNDS = "src/gizmo/bounding-box-gizmo.ts";
const POINT_MEMBERS = ["x", "y", "z"] as const;
const LINE_MEMBERS = ["pivotY", "pivotZ", "posY", "sx", "sy", "sz"] as const;
const CYLINDER_MEMBERS = ["height", "diameterTop", "diameterBottom", "tessellation"] as const;

function numericScope(bindings: Iterable<[string, PinnedBinding]> = []): PinnedNumericScope {
    return {
        bindings: new Map([
            ["Math.PI", { cpp: "pi_double", type: "scalar" }],
            ...bindings,
        ]),
        calls: pinnedNumericMathCallsWithHypot(),
        vec3Literal: (x, y, z) => `Vec3d{${x}, ${y}, ${z}}`,
    };
}

function objectValues(
    context: LoweringContext,
    lowerer: PinnedNumericLowerer,
    expression: ts.Expression,
    members: readonly string[],
): string[] {
    const literal = context.unwrapExpression(expression);
    if (!ts.isObjectLiteralExpression(literal) ||
        literal.properties.length !== members.length ||
        literal.properties.some((property, index) =>
            !(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) ||
            context.propertyName(property.name) !== members[index])) {
        context.contractError(expression, `Expected pinned geometry record { ${members.join(", ")} }.`);
    }
    return lowerObjectComponents(context, lowerer, literal, members);
}

function numericParameters(
    context: LoweringContext,
    declaration: ts.FunctionDeclaration,
    names: readonly string[],
): void {
    if (declaration.parameters.length !== names.length ||
        declaration.parameters.some((parameter, index) =>
            !ts.isIdentifier(parameter.name) || parameter.name.text !== names[index] ||
            parameter.type?.kind !== ts.SyntaxKind.NumberKeyword)) {
        context.contractError(declaration, `Expected pinned geometry parameters (${names.join(", ")}).`);
    }
}

/**
 * Only the native carriers missing from the numeric lowerer: a LineDef list,
 * a point list, and the frustum's list of fixed index pairs. Arithmetic and
 * ordinary control flow always go through PinnedNumericLowerer.
 */
class GeometryNumericLowerer extends PinnedNumericLowerer {
    private readonly lists = new WeakMap<PinnedBinding, "record" | "edge" | "pair">();

    public constructor(
        private readonly context: LoweringContext,
        source: ts.SourceFile,
        private readonly geometryScope: PinnedNumericScope,
        private readonly record?: { annotation: string; cpp: string; members: readonly string[] },
    ) {
        super(source, geometryScope);
    }

    public override expression(expression: ts.Expression): string {
        const node = this.context.unwrapExpression(expression);
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "push") {
            const receiver = this.context.unwrapExpression(node.expression.expression);
            const binding = this.geometryScope.bindings.get(receiver.getText());
            const shape = binding && this.lists.get(binding);
            if (shape && binding) {
                if (node.arguments.length === 0 || !ts.isExpressionStatement(node.parent)) {
                    this.context.contractError(node, "Expected a pinned geometry append statement.");
                }
                const values = node.arguments.map((argument) => {
                    const value = this.context.unwrapExpression(argument);
                    if (shape === "record" && this.record && ts.isObjectLiteralExpression(value)) {
                        return this.expression(value);
                    }
                    if (shape === "edge" && ts.isCallExpression(value) &&
                        ts.isIdentifier(value.expression) && value.expression.text === "buildFrustumEdge") {
                        return this.expression(value);
                    }
                    if (shape === "pair") {
                        return `std::array<double, 2>{${lowerTupleComponents(
                            this.context, this, value, { arity: 2, at: argument },
                        ).join(", ")}}`;
                    }
                    return this.context.contractError(argument, `Expected a pinned '${shape}' geometry list element.`);
                });
                const calls = values.map((value) => `${binding.cpp}.push_back(${value})`);
                return calls.length === 1 ? calls[0]! : `(${calls.join(", ")})`;
            }
        }
        if (this.record && ts.isObjectLiteralExpression(node)) {
            return `${this.record.cpp}{${objectValues(
                this.context, this, node, this.record.members,
            ).join(", ")}}`;
        }
        return super.expression(expression);
    }

    public listResult(expression: ts.Expression | undefined, shape: "record" | "edge", at: ts.Node): string {
        const returned = expression && this.context.unwrapExpression(expression);
        const binding = returned && this.geometryScope.bindings.get(returned.getText());
        if (!binding || this.lists.get(binding) !== shape) {
            this.context.contractError(returned ?? at, `Expected the pinned '${shape}' geometry list result.`);
        }
        return binding.cpp;
    }

    private bindList(name: string, shape: "record" | "edge" | "pair", at: ts.Node): void {
        if (this.geometryScope.bindings.has(name)) {
            this.context.contractError(at, "A pinned geometry list must not shadow another local.");
        }
        const binding: PinnedBinding = { cpp: name, type: "scalar" };
        this.geometryScope.bindings.set(name, binding);
        this.lists.set(binding, shape);
    }

    public override statement(statement: ts.Statement, indent: string): string[] {
        if (ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.length === 1) {
            const declared = statement.declarationList.declarations[0]!;
            const value = declared.initializer
                ? this.context.unwrapExpression(declared.initializer)
                : undefined;
            if (ts.isIdentifier(declared.name) && value && ts.isArrayLiteralExpression(value)) {
                const annotation = declared.type;
                const element = annotation && ts.isArrayTypeNode(annotation)
                    ? annotation.elementType : undefined;
                const name = declared.name.text;
                if (this.record && element && ts.isTypeReferenceNode(element) &&
                    ts.isIdentifier(element.typeName) &&
                    element.typeName.text === this.record.annotation) {
                    if (value.elements.length !== 0) {
                        this.context.contractError(value, "Expected an initially empty pinned geometry record list.");
                    }
                    this.bindList(name, "record", declared);
                    return [`${indent}std::vector<${this.record.cpp}> ${name};`];
                }
                if (element && ts.isTypeReferenceNode(element) &&
                    ts.isIdentifier(element.typeName) && element.typeName.text === "Mesh") {
                    if (value.elements.length !== 0) {
                        this.context.contractError(value, "Expected an initially empty pinned frustum edge list.");
                    }
                    this.bindList(name, "edge", declared);
                    return [`${indent}std::vector<GizmoFrustumEdge> ${name};`];
                }
                if (element && ts.isTupleTypeNode(element) &&
                    element.elements.length === 2 &&
                    element.elements.every((lane) => lane.kind === ts.SyntaxKind.NumberKeyword)) {
                    const rows = value.elements.map((row) =>
                        `std::array<double, 2>{${lowerTupleComponents(
                            this.context, this, row, { arity: 2, at: row },
                        ).join(", ")}}`);
                    this.bindList(name, "pair", declared);
                    return [`${indent}std::vector<std::array<double, 2>> ${name}{${rows.join(", ")}};`];
                }
                if (!annotation && value.elements.length > 0 &&
                    value.elements.every((entry) =>
                        ts.isObjectLiteralExpression(this.context.unwrapExpression(entry)))) {
                    const rows = value.elements.map((entry) =>
                        `Vec3d{${objectValues(this.context, this, entry, POINT_MEMBERS).join(", ")}}`);
                    this.geometryScope.bindings.set(name, { cpp: name, type: "vec3-list" });
                    return [`${indent}std::vector<Vec3d> ${name}{${rows.join(", ")}};`];
                }
                this.context.contractError(declared, "Unsupported pinned geometry list carrier.");
            }
        }
        if (ts.isForOfStatement(statement) &&
            ts.isVariableDeclarationList(statement.initializer) &&
            statement.initializer.declarations.length === 1) {
            const declared = statement.initializer.declarations[0]!;
            if (ts.isArrayBindingPattern(declared.name)) {
                const elements = declared.name.elements;
                if (elements.length !== 2 || elements.some((element) =>
                    ts.isOmittedExpression(element) || !ts.isIdentifier(element.name) ||
                    element.dotDotDotToken || element.propertyName || element.initializer)) {
                    this.context.contractError(declared, "Expected a pinned two-index edge destructuring.");
                }
                const rangeBinding = this.geometryScope.bindings.get(
                    this.context.unwrapExpression(statement.expression).getText(),
                );
                if (!rangeBinding || this.lists.get(rangeBinding) !== "pair") {
                    this.context.contractError(statement, "Expected a pinned index-pair range.");
                }
                const range = rangeBinding.cpp;
                return this.withBindings(() => {
                    const names = elements.map((element) => {
                        if (ts.isOmittedExpression(element) || !ts.isIdentifier(element.name)) {
                            return this.context.contractError(element, "Expected a pinned edge index.");
                        }
                        const name = element.name.text;
                        if (this.geometryScope.bindings.has(name)) {
                            this.context.contractError(element, "A pinned geometry index must not shadow another local.");
                        }
                        this.geometryScope.bindings.set(name, { cpp: name, type: "scalar" });
                        return name;
                    });
                    const body = ts.isBlock(statement.statement)
                        ? statement.statement.statements
                        : [statement.statement];
                    return [
                        `${indent}for (const auto& [${names.join(", ")}] : ${range}) {`,
                        ...body.flatMap((inner) => this.statement(inner, `${indent}    `)),
                        `${indent}}`,
                    ];
                });
            }
        }
        try {
            return super.statement(statement, indent);
        } catch (error) {
            this.context.contractError(statement, error instanceof Error ? error.message : String(error));
        }
    }
}

function lowerHemisphere(context: LoweringContext): string {
    const { declaration } = context.functionDeclaration(LIGHT, "buildHemisphereMesh");
    return lowerPinnedFunction(context, LIGHT, "buildHemisphereMesh", [
        {
            pinned: "engine", kind: "record", cpp: "engine", cppType: "Engine",
            annotation: "EngineContext", specialized: true,
            binding: { cpp: "engine", type: "scalar" },
        },
        { pinned: "segments", kind: "number", cpp: "segments" },
        { pinned: "diameter", kind: "number", cpp: "diameter" },
    ], {
        cppName: "gizmo_hemisphere_geometry",
        calls: pinnedNumericMathCallsWithHypot(),
        memberBindings: new Map([["Math.PI", { cpp: "pi_double", type: "scalar" }]]),
        returns: {
            type: "GizmoHemisphereGeometry",
            value: (lowerer, expression) => {
                const returned = expression ? context.unwrapExpression(expression) : undefined;
                if (!returned || !ts.isCallExpression(returned) ||
                    !ts.isIdentifier(returned.expression) || returned.expression.text !== "createMeshFromData" ||
                    returned.arguments.length !== 6 ||
                    !ts.isIdentifier(returned.arguments[0]!) || returned.arguments[0]!.text !== "engine" ||
                    !ts.isStringLiteral(returned.arguments[1]!)) {
                    context.contractError(declaration, "Expected the pinned hemisphere to return its mesh-data factory call.");
                }
                return `GizmoHemisphereGeometry{${JSON.stringify(returned.arguments[1]!.text)}, ${
                    returned.arguments.slice(2).map((argument) => lowerer.expression(argument)).join(", ")
                }}`;
            },
        },
    });
}

function lowerLineDefinitions(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(LIGHT, "lineDefsForLevel");
    numericParameters(context, declaration, ["levels"]);
    const { declaration: shape } = context.interfaceDeclaration(LIGHT, "LineDef");
    if (shape.members.length !== LINE_MEMBERS.length ||
        shape.members.some((member, index) =>
            !ts.isPropertySignature(member) || !member.name ||
            context.propertyName(member.name) !== LINE_MEMBERS[index] ||
            member.type?.kind !== ts.SyntaxKind.NumberKeyword || member.questionToken)) {
        context.contractError(shape, "Expected the pinned numeric LineDef record.");
    }
    const scope = numericScope([["levels", { cpp: "levels", type: "scalar" }]]);
    const lowerer = new GeometryNumericLowerer(context, file, scope, {
        annotation: "LineDef", cpp: "GizmoLineDef", members: LINE_MEMBERS,
    });
    scope.returnValue = (expression) => lowerer.listResult(expression, "record", declaration);
    return `// ${context.provenance(LIGHT, "lineDefsForLevel")}
struct GizmoLineDef {
${LINE_MEMBERS.map((member) => `    double ${member};`).join("\n")}
};
std::vector<GizmoLineDef> line_defs_for_level(double levels) {
${declaration.body!.statements.flatMap((statement) => lowerer.statement(statement, "    ")).join("\n")}
}`;
}

/** Only the resource-registration statements cross the native mesh boundary. */
function lowerFrustumEdge(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(CAMERA, "buildFrustumEdge");
    const names = ["engine", "utilityScene", "material", "root", "thickness", "a", "b"];
    if (declaration.parameters.length !== names.length ||
        declaration.parameters.some((parameter, index) =>
            !ts.isIdentifier(parameter.name) || parameter.name.text !== names[index])) {
        context.contractError(declaration, "Expected the pinned frustum-edge parameter order.");
    }
    if (declaration.parameters[4]!.type?.kind !== ts.SyntaxKind.NumberKeyword ||
        declaration.parameters.slice(5).some((parameter) => {
            const type = parameter.type;
            return !type || !ts.isTypeLiteralNode(type) || type.members.length !== 3 ||
                type.members.some((member, index) =>
                    !ts.isPropertySignature(member) || !member.name ||
                    context.propertyName(member.name) !== POINT_MEMBERS[index] ||
                    member.type?.kind !== ts.SyntaxKind.NumberKeyword || member.questionToken);
        })) {
        context.contractError(declaration, "Expected a numeric thickness and two pinned point records.");
    }
    const scope = numericScope([
        ["thickness", { cpp: "thickness", type: "scalar" }],
        ["a", { cpp: "a", type: "vec3" }],
        ["b", { cpp: "b", type: "vec3" }],
        ...["position", "scaling", "rotationQuaternion"].map((channel): [string, PinnedBinding] => [
            `mesh.${channel}`, { cpp: channel, type: "scalar" },
        ]),
    ]);
    scope.methods = new Map([["set", (receiver: string, args: readonly string[]): string => {
        const rotation = receiver === "rotationQuaternion";
        if ((!rotation && receiver !== "position" && receiver !== "scaling") ||
            args.length !== (rotation ? 4 : 3)) {
            context.contractError(declaration, "Unsupported pinned frustum transform write.");
        }
        return `edge.${rotation ? "rotation" : receiver} = ${
            rotation ? "std::array<double, 4>" : "Vec3d"
        }{${args.join(", ")}}`;
    }]]);
    const lowerer = new PinnedNumericLowerer(file, scope);
    const seen = new Set<string>();
    const record = (name: string, at: ts.Node): void => {
        if (seen.has(name)) context.contractError(at, `Duplicate pinned frustum '${name}' boundary.`);
        seen.add(name);
    };
    const body: string[] = [];
    for (const statement of declaration.body!.statements) {
        if (ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.length === 1) {
            const mesh = statement.declarationList.declarations[0]!;
            if (ts.isIdentifier(mesh.name) && mesh.name.text === "mesh") {
                const call = mesh.initializer ? context.unwrapExpression(mesh.initializer) : undefined;
                if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) ||
                    call.expression.text !== "createCylinder" || call.arguments.length !== 2 ||
                    !ts.isIdentifier(call.arguments[0]!) || call.arguments[0]!.text !== "engine") {
                    context.contractError(mesh, "Expected a pinned frustum cylinder factory.");
                }
                const options = objectValues(context, lowerer, call.arguments[1]!, CYLINDER_MEMBERS);
                body.push(...CYLINDER_MEMBERS.map((name, index) => `    edge.${name} = ${options[index]};`));
                record("mesh", statement);
                continue;
            }
        }
        if (ts.isExpressionStatement(statement)) {
            const expression = context.unwrapExpression(statement.expression);
            if (ts.isBinaryExpression(expression) &&
                expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(expression.left) &&
                ts.isIdentifier(expression.left.expression) && expression.left.expression.text === "mesh") {
                const name = expression.left.name.text;
                const value = context.unwrapExpression(expression.right);
                const expected = name === "material" ? "material" : name === "parent" ? "root" : undefined;
                if ((expected && ts.isIdentifier(value) && value.text === expected) ||
                    (name === "pickable" && value.kind === ts.SyntaxKind.FalseKeyword)) {
                    record(name, statement);
                    continue;
                }
                context.contractError(expression, "Unsupported pinned frustum mesh attachment.");
            }
            if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) &&
                expression.expression.text === "addToScene") {
                if (expression.arguments.length !== 2 ||
                    expression.arguments.some((argument, index) =>
                        !ts.isIdentifier(argument) || argument.text !== ["utilityScene", "mesh"][index])) {
                    context.contractError(expression, "Expected pinned frustum registration in its utility scene.");
                }
                record("addToScene", statement);
                continue;
            }
        }
        if (ts.isReturnStatement(statement)) {
            if (!statement.expression || !ts.isIdentifier(statement.expression) || statement.expression.text !== "mesh") {
                context.contractError(statement, "Expected the pinned frustum edge mesh result.");
            }
            body.push("    return edge;");
            record("return", statement);
            continue;
        }
        body.push(...lowerer.statement(statement, "    "));
    }
    if (seen.size !== 6) {
        context.contractError(declaration, "Expected the pinned frustum cylinder, attachment, registration and return.");
    }
    return `// ${context.provenance(CAMERA, "buildFrustumEdge")}
GizmoFrustumEdge gizmo_frustum_edge(double thickness, Vec3d a, Vec3d b) {
    GizmoFrustumEdge edge{};
${body.join("\n")}
}`;
}

function lowerFrustum(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(CAMERA, "buildFrustumWireframe");
    const resources = ["engine", "utilityScene", "material", "root"];
    const scalars = ["fov", "aspect", "nearPlane", "farPlane"];
    const parameters = [...resources, ...scalars];
    if (declaration.parameters.length !== parameters.length ||
        declaration.parameters.some((parameter, index) =>
            !ts.isIdentifier(parameter.name) || parameter.name.text !== parameters[index] ||
            (index >= resources.length && parameter.type?.kind !== ts.SyntaxKind.NumberKeyword))) {
        context.contractError(declaration, "Expected the pinned frustum geometry parameter order.");
    }
    const scope = numericScope(parameters.map((name): [string, PinnedBinding] =>
        [name, { cpp: name, type: "scalar" }]));
    scope.calls = new Map([
        ...scope.calls,
        ["buildFrustumEdge", (args: readonly string[]): string => {
            if (args.length !== 7 || resources.some((name, index) => args[index] !== name)) {
                context.contractError(declaration, "Expected the pinned frustum to attach each edge to the same resources.");
            }
            return `gizmo_frustum_edge(${args.slice(4).join(", ")})`;
        }],
    ]);
    const lowerer = new GeometryNumericLowerer(context, file, scope);
    scope.returnValue = (expression) => lowerer.listResult(expression, "edge", declaration);
    return `// ${context.provenance(CAMERA, "buildFrustumWireframe")}
std::vector<GizmoFrustumEdge> gizmo_frustum_geometry(${scalars.map((name) => `double ${name}`).join(", ")}) {
${declaration.body!.statements.flatMap((statement) => lowerer.statement(statement, "    ")).join("\n")}
}`;
}

/**
 * CPU geometry stays at JS-number width until the pin constructs typed arrays
 * or the native transform setter stores its float lanes. Resource handles,
 * materials and parenting remain in GizmoLowerer's native scene adapter.
 */
export function pinnedGizmoGeometry(context: LoweringContext): string {
    return `struct GizmoHemisphereGeometry {
    std::string name;
    bbl::js::F32Array positions;
    bbl::js::F32Array normals;
    bbl::js::U32Array indices;
    bbl::js::F32Array uvs;
};
struct GizmoFrustumEdge {
${CYLINDER_MEMBERS.map((member) => `    double ${member};`).join("\n")}
    Vec3d position{};
    Vec3d scaling{1.0, 1.0, 1.0};
    std::array<double, 4> rotation{0.0, 0.0, 0.0, 1.0};
};

${lowerHemisphere(context)}

${lowerLineDefinitions(context)}

${lowerFrustumEdge(context)}

${lowerFrustum(context)}
`;
}

function block(context: LoweringContext, node: ts.Node): ts.Block {
    if (!ts.isBlock(node)) context.contractError(node, "Expected a pinned geometry block.");
    return node;
}

function callback(context: LoweringContext, call: ts.CallExpression, index: number): ts.ArrowFunction {
    const argument = call.arguments[index];
    if (!argument || !ts.isArrowFunction(argument)) {
        context.contractError(call, "Expected the pinned geometry callback.");
    }
    return argument;
}

function containingIf(
    context: LoweringContext,
    scope: ts.Node,
    callee: string,
): ts.IfStatement {
    const call = context.findNodes(scope, (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && context.propertyPath(node.expression)?.join(".") === callee)[0];
    if (!call) context.contractError(scope, `Expected pinned '${callee}'.`);
    let parent: ts.Node | undefined = call.parent;
    while (parent && parent !== scope && !ts.isIfStatement(parent)) parent = parent.parent;
    if (!parent || !ts.isIfStatement(parent)) {
        context.contractError(call, "Expected a guarded pinned geometry write.");
    }
    return parent;
}

function scaleBody(
    context: LoweringContext,
    modulePath: string,
    statements: readonly ts.Statement[],
    bindings: Iterable<[string, PinnedBinding]>,
    receiver: string,
    worldPath: readonly string[],
): string {
    const worldLoads = statements.flatMap((statement) => context.findNodes(statement,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "cw"));
    if (worldLoads.length !== 1 || !worldLoads[0]!.initializer ||
        context.propertyPath(context.unwrapExpression(worldLoads[0]!.initializer))?.join(".") !== worldPath.join(".")) {
        context.contractError(statements[0]!, "Expected the pinned follow to read its utility camera's world matrix.");
    }
    const scope = numericScope([
        ...bindings,
        [receiver, { cpp: "result", type: "scalar" }],
        ["cw", { cpp: "cw", type: "f32" }],
    ]);
    scope.methods = new Map([["set", (target: string, args: readonly string[]): string => {
        if (target !== "result" || args.length !== 3) {
            context.contractError(statements[0]!, "Unsupported pinned gizmo scaling write.");
        }
        return `result = Vec3d{${args.join(", ")}}`;
    }]]);
    const lowerer = new PinnedNumericLowerer(context.sourceFile(modulePath), scope);
    return statements.flatMap((statement) => lowerer.statement(statement, "    ")).join("\n");
}

/** The live-record seam supplies matrices/presence; the callbacks supply all scaling arithmetic. */
export function pinnedGizmoFollowGeometry(context: LoweringContext, editing: boolean): string {
    const camera = context.functionDeclaration(CAMERA, "createCameraGizmo").declaration;
    const afterFollow = callback(context, context.callExpression(camera, "attachFollowTarget"), 4);
    const bodyOuter = containingIf(context, afterFollow, "gizmo._bodyOuter.scaling.set");
    const cameraBody = scaleBody(context, CAMERA, block(context, bodyOuter.thenStatement).statements, [
        ["cam", { cpp: "has_camera", type: "bool" }],
        ["wm", { cpp: "wm", type: "f32" }],
    ], "gizmo._bodyOuter.scaling", ["cam", "worldMatrix"]);
    if (context.propertyPath(context.unwrapExpression(context.variableInitializer(bodyOuter, "cam")))?.join(".") !== "utilityScene.camera") {
        context.contractError(bodyOuter, "Expected the pinned camera-body follow to use the utility camera.");
    }

    const light = context.functionDeclaration(LIGHT, "createLightGizmo").declaration;
    const lightFollow = callback(context, context.callExpression(light, "onBeforeRender"), 1);
    const cameraScale = containingIf(context, lightFollow, "root.scaling.set");
    const lightBody = scaleBody(context, LIGHT, [cameraScale], [
        ["camera", { cpp: "has_camera", type: "bool" }],
        ...POINT_MEMBERS.map((lane): [string, PinnedBinding] =>
            [`root.position.${lane}`, { cpp: `position.${lane}`, type: "scalar" }]),
    ], "root.scaling", ["camera", "worldMatrix"]);
    if (context.propertyPath(context.unwrapExpression(context.variableInitializer(lightFollow, "camera")))?.join(".") !== "utilityScene.camera") {
        context.contractError(lightFollow, "Expected the pinned light follow to use the utility camera.");
    }
    let projected = "";
    if (editing) {
        const follow = context.functionDeclaration(CORE, "attachFollowTarget").declaration;
        const update = callback(context, context.callExpression(follow, "onBeforeRender"), 1);
        const guardedScale = containingIf(context, update, "gizmoRoot.scaling.set");
        const projectedBody = scaleBody(context, CORE, block(context, guardedScale.thenStatement).statements, [
            ...POINT_MEMBERS.map((lane): [string, PinnedBinding] =>
                [`t${lane}`, { cpp: `position.${lane}`, type: "scalar" }]),
            ["scaleRatio", { cpp: "scale_ratio", type: "scalar" }],
        ], "gizmoRoot.scaling", ["scene", "camera", "worldMatrix"]);
        projected = `// ${context.provenance(CORE, "attachFollowTarget")}
Vec3d gizmo_projected_scaling(Vec3d position, const std::array<float, 16>& cw, double scale_ratio) {
    Vec3d result{};
${projectedBody}
    return result;
}
`;
    }
    return `// ${context.provenance(CAMERA, "createCameraGizmo")}
Vec3d gizmo_camera_scaling(bool has_camera, const std::array<float, 16>& cw, const std::array<float, 16>& wm) {
    Vec3d result{};
${cameraBody}
    return result;
}
// ${context.provenance(LIGHT, "createLightGizmo")}
Vec3d gizmo_light_scaling(bool has_camera, const std::array<float, 16>& cw, Vec3d position) {
    Vec3d result{};
${lightBody}
    return result;
}
${projected}`;
}

function boundsValue(
    context: LoweringContext,
    lowerer: PinnedNumericLowerer,
    expression: ts.Expression,
): string {
    let literal = context.unwrapExpression(expression);
    if (ts.isIdentifier(literal)) {
        const initializer = context.moduleScopeConstant(context.sourceFile(BOUNDS), literal.text);
        if (!initializer) context.contractError(literal, "Expected a pinned bounds constant.");
        literal = context.unwrapExpression(initializer);
    }
    if (!ts.isObjectLiteralExpression(literal) || literal.properties.length !== 4) {
        context.contractError(literal, "Expected the pinned AabbBounds record.");
    }
    const rows = ["min", "max", "centre", "size"].map((name, index) => {
        const member = literal.properties[index]!;
        if (!ts.isPropertyAssignment(member) || context.propertyName(member.name) !== name) {
            context.contractError(member, `Expected pinned bounds '${name}'.`);
        }
        return `Vec3d{${objectValues(context, lowerer, member.initializer, POINT_MEMBERS).join(", ")}}`;
    });
    return `BoundingBoxBounds{${rows.join(", ")}}`;
}

/** Numeric projection of the bounds walk; native scene traversal remains outside this helper. */
export function pinnedGizmoBoundsGeometry(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(BOUNDS, "computeBoundsRecursive");
    const bindings = new Map<string, PinnedBinding>();
    for (const extent of ["min", "max"]) {
        for (const lane of POINT_MEMBERS) {
            bindings.set(`${extent}${lane.toUpperCase()}`, {
                cpp: `bounds.${extent}.${lane}`, type: "scalar",
            });
        }
    }
    const initialScope = numericScope();
    const initial = new PinnedNumericLowerer(file, initialScope);
    const initialization: string[] = [];
    const initialStatements = declaration.body!.statements.slice(0, 2);
    for (const statement of initialStatements) {
        if (!ts.isVariableStatement(statement)) {
            context.contractError(statement, "Expected pinned min/max bound initializers.");
        }
        for (const declared of statement.declarationList.declarations) {
            const target = ts.isIdentifier(declared.name) ? bindings.get(declared.name.text) : undefined;
            if (!target || !declared.initializer) {
                context.contractError(declared, "Expected a pinned scalar bound initializer.");
            }
            initialization.push(`    ${target.cpp} = ${initial.expression(declared.initializer)};`);
        }
    }
    if (initialization.length !== bindings.size) {
        context.contractError(declaration, "Expected all six pinned bounds to be initialized.");
    }
    const visitor = context.unwrapExpression(context.variableInitializer(declaration, "visit"));
    if (!ts.isArrowFunction(visitor)) context.contractError(visitor, "Expected the pinned bounds visitor.");
    const finite = context.callExpression(visitor, "isFinite");
    if (context.propertyPath(finite.expression)?.join(".") !== "Number.isFinite") {
        context.contractError(finite, "Expected the pinned Number.isFinite bounds guard.");
    }
    const guardedFold = finite.parent;
    if (!ts.isIfStatement(guardedFold) || guardedFold.expression !== finite) {
        context.contractError(finite, "Expected the pinned finite-AABB fold guard.");
    }
    const foldScope = numericScope([
        ...bindings,
        ["aabb[0]", { cpp: "aabb[0]", type: "f64-buffer" }],
        ["aabb[1]", { cpp: "aabb[1]", type: "f64-buffer" }],
    ]);
    foldScope.calls = new Map([["Number.isFinite", (args: readonly string[]) => `std::isfinite(${args.join(", ")})`]]);
    const fold = new PinnedNumericLowerer(file, foldScope);

    const finishScope = numericScope(bindings);
    finishScope.calls = foldScope.calls;
    const finish = new PinnedNumericLowerer(file, finishScope);
    finishScope.returnValue = (expression) => expression
        ? boundsValue(context, finish, expression)
        : context.contractError(declaration, "Expected a pinned bounds result.");
    const candidates = declaration.body!.statements.filter((statement): statement is ts.IfStatement =>
        ts.isIfStatement(statement) && ts.isIdentifier(statement.expression) &&
        statement.expression.text === "extraCandidates");
    if (candidates.length !== 1) {
        context.contractError(declaration, "Expected the pinned supplemental candidate traversal.");
    }
    const suffix = declaration.body!.statements.slice(
        declaration.body!.statements.indexOf(candidates[0]!) + 1,
    );
    if (suffix.length === 0 || !ts.isReturnStatement(suffix[suffix.length - 1]!)) {
        context.contractError(declaration, "Expected the pinned bounds result after traversal.");
    }
    const loweredRegions = new Set<ts.Node>([...initialStatements, guardedFold, ...suffix]);
    const outsideProjection = context.findNodes(declaration, (node): node is ts.Identifier => {
        if (!ts.isIdentifier(node) || !bindings.has(node.text)) return false;
        let parent: ts.Node | undefined = node;
        while (parent && parent !== declaration) {
            if (loweredRegions.has(parent)) return false;
            parent = parent.parent;
        }
        return true;
    });
    if (outsideProjection.length > 0) {
        context.contractError(outsideProjection[0]!, "Pinned bounds arithmetic escaped the numeric projection.");
    }
    return `// ${context.provenance(BOUNDS, "computeBoundsRecursive")}
BoundingBoxBounds gizmo_bounds_initial() {
    BoundingBoxBounds bounds{};
${initialization.join("\n")}
    return bounds;
}
void gizmo_bounds_fold(BoundingBoxBounds& bounds, const std::array<std::array<double, 3>, 2>& aabb) {
${fold.statement(guardedFold, "    ").join("\n")}
}
BoundingBoxBounds gizmo_bounds_finish(BoundingBoxBounds bounds) {
${suffix.flatMap((statement) => finish.statement(statement, "    ")).join("\n")}
}
`;
}
