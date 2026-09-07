import ts from "typescript";
import { cameraRecordField } from "../compiler/properties.js";
import { snakeCase } from "../cpp-literals.js";
import { LoweringContext } from "./context.js";
import { PinnedNumericLowerer, type PinnedBinding } from "./pinned-numeric-lowerer.js";

const ARC = "src/camera/arc-rotate.ts";
const CONTROLS = "src/camera/arc-rotate-controls.ts";
const OBSERVABLE = "src/math/observable-vec3.ts";
const axes = ["x", "y", "z"] as const;
const scalarFields = ["alpha", "beta", "radius"] as const;

/** Source setters are the only transform-version writers. Matrix reads cannot
 * recover writes that returned a value to its starting point before a draw. */
export class CameraMutationLowerer {
    constructor(private readonly context: LoweringContext) {}

    private lower(file: ts.SourceFile, body: ts.Block, bindings: Map<string, PinnedBinding>,
        calls: ReadonlyMap<string, (args: readonly string[]) => string> = new Map()): string {
        const lowerer = new PinnedNumericLowerer(file, { bindings, calls, booleanAnd: true, booleanOr: true });
        return body.statements.flatMap((statement) => lowerer.statement(statement, "    ")).join("\n");
    }

    private dirty(): string {
        const module = "src/scene/world-matrix-state.ts";
        const { file, declaration } = this.context.functionDeclaration(module, "createWorldMatrixState");
        const invalidate = this.context.findNodes(declaration, (node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) && node.name?.text === "invalidate")[0];
        if (!invalidate?.body) this.context.contractError(declaration, "Expected world-state invalidate body.");
        this.context.assertExpressionShape(this.context.variableInitializer(declaration, "_worldVersion"), "0", "Initial camera transform version");
        const mark = this.context.findNodes(declaration, (node): node is ts.MethodDeclaration =>
            ts.isMethodDeclaration(node) && this.context.propertyName(node.name) === "markLocalDirty")[0];
        if (!mark?.body || mark.body.statements.length !== 1 || !ts.isExpressionStatement(mark.body.statements[0]!)) {
            this.context.contractError(declaration, "Camera dirty entry changed.");
        }
        this.context.assertExpressionShape(mark.body.statements[0]!.expression, "invalidate()", "Camera dirty entry");
        const inventory = ts.createSourceFile("camera-invalidate.ts", `const body = () => ${invalidate.body.getText(file)}`, ts.ScriptTarget.Latest, true);
        this.context.assertExpressionShape(this.context.variableInitializer(inventory, "body"), `() => {
            _cachedWorld = null;
            _worldVersion++;
            for (const child of _children) { child._invalidate(); }
        }`, "Unparented camera dirty propagation");
        const lowerer = new PinnedNumericLowerer(file, { bindings: new Map([
            ["_worldVersion", { cpp: "camera.world_matrix_version", type: "scalar" }],
        ]), calls: new Map() });
        return lowerer.statement(invalidate.body.statements[1]!, "    ").join("\n");
    }

    public setters(): string {
        const { file, declaration } = this.context.functionDeclaration(ARC, "createArcRotateCamera");
        const define = this.context.findNodes(declaration, (node): node is ts.CallExpression =>
            ts.isCallExpression(node) && this.context.propertyPath(node.expression)?.join(".") === "Object.defineProperty");
        if (define.length !== 1) this.context.contractError(declaration, "Expected one shared arc camera scalar setter.");
        const loop = this.context.findNodes(declaration, (node): node is ts.ForOfStatement =>
            ts.isForOfStatement(node) && this.context.hasNode(node.statement, (child) => child === define[0]))[0];
        if (!loop) this.context.contractError(declaration, "Expected the shared scalar accessor loop.");
        this.context.assertExpressionShape(this.context.unwrapExpression(loop.expression), '["alpha", "beta", "radius"]', "Tracked arc camera scalar fields");
        const descriptor = define[0]!.arguments[2];
        if (!descriptor || !ts.isObjectLiteralExpression(descriptor)) this.context.contractError(define[0]!, "Expected camera accessor descriptor.");
        const setter = this.context.propertyInitializer(descriptor, "set");
        if (!ts.isArrowFunction(setter) || !ts.isBlock(setter.body)) this.context.contractError(setter, "Expected camera scalar setter body.");
        this.context.assertExpressionShape(this.context.variableInitializer(declaration, "onDirty"), "(): void => wm.markLocalDirty()", "Arc camera dirty callback");
        const scalar = this.lower(file, setter.body, new Map([
            ["scalars[key]", { cpp: "camera.*field", type: "scalar", mutable: true }],
            ["v", { cpp: "value", type: "scalar" }],
        ]), new Map([
            ["onDirty", () => "dirty_camera_transform(camera)"],
            ["cam._clampToLimits", () => "clamp_installed_camera_limits(camera)"],
        ]));
        const observable = this.context.sourceFile(OBSERVABLE);
        const componentBodies = axes.map((axis) => {
            const setter = this.context.findNodes(observable, (node): node is ts.SetAccessorDeclaration =>
                ts.isSetAccessorDeclaration(node) && this.context.propertyName(node.name) === axis)[0];
            if (!setter?.body) this.context.contractError(observable, `Missing observable ${axis} setter.`);
            return this.lower(observable, setter.body, new Map([
                [`this._${axis}`, { cpp: "(camera.*vector).*component", type: "scalar" }],
                ["v", { cpp: "value", type: "scalar" }],
            ]), new Map([["this._onDirty", () => "dirty_camera_transform(camera)"]]));
        });
        if (!componentBodies.every((body) => body === componentBodies[0])) this.context.contractError(observable, "Observable vector component setters differ.");
        const bulk = this.context.findNodes(observable, (node): node is ts.MethodDeclaration =>
            ts.isMethodDeclaration(node) && this.context.propertyName(node.name) === "set")[0];
        if (!bulk?.body) this.context.contractError(observable, "Missing observable bulk setter.");
        const bulkBody = this.lower(observable, bulk.body, new Map(axes.flatMap((axis): [string, PinnedBinding][] => [
            [`this._${axis}`, { cpp: `(camera.*vector).${axis}`, type: "scalar" }],
            [axis, { cpp: `value.${axis}`, type: "scalar" }],
        ])), new Map([["this._onDirty", () => "dirty_camera_transform(camera)"]]));
        return `// ${this.context.provenance(ARC, "createArcRotateCamera", OBSERVABLE)}
void dirty_camera_transform(CameraRecord& camera) {
${this.dirty()}
}
void clamp_installed_camera_limits(CameraRecord& camera) {
    if (camera.limits_installed) clamp_camera_to_limits(camera);
}
void write_camera_scalar(CameraRecord& camera, double CameraRecord::*field, double value) {
    if (field != &CameraRecord::alpha && field != &CameraRecord::beta && field != &CameraRecord::radius) {
        camera.*field = value;
        return;
    }
${scalar}
}
void write_camera_vector_component(CameraRecord& camera, Vec3d CameraRecord::*vector,
    double Vec3d::*component, double value) {
${componentBodies[0]}
}
void set_camera_vector(CameraRecord& camera, Vec3d CameraRecord::*vector, Vec3d value) {
${bulkBody}
}`;
    }

    /** Route writes in the actual pin body through its accessor, then reuse
     * numeric lowering for every condition, intermediate and store order. */
    private controlBody(name: string): string {
        const file = this.context.sourceFile(CONTROLS);
        const declaration = this.context.findNodes(file, (node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) && node.name?.text === name)[0];
        if (!declaration?.body) this.context.contractError(file, `Missing ${name}.`);
        const transformed = ts.transform(declaration.body, [(context) => {
            const visit: ts.Visitor = (node) => {
                if (ts.isBinaryExpression(node)) {
                    const path = this.context.propertyPath(node.left)?.join(".");
                    const field = scalarFields.find((field) => path === `camera.${field}`);
                    const axis = axes.find((axis) => path === `camera.target.${axis}`);
                    if (field || axis) {
                        const operators = new Map<ts.SyntaxKind, ts.BinaryOperator | undefined>([
                            [ts.SyntaxKind.EqualsToken, undefined],
                            [ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.PlusToken],
                            [ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.MinusToken],
                        ]);
                        if (operators.has(node.operatorToken.kind)) {
                            const operator = operators.get(node.operatorToken.kind);
                            const value = operator === undefined ? node.right : ts.factory.createBinaryExpression(node.left, operator, node.right);
                            return ts.factory.createCallExpression(ts.factory.createIdentifier(`write_${field ?? `target_${axis}`}`), undefined, [value]);
                        }
                        if (node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
                            this.context.contractError(node, "Camera control setter gained an unsupported compound assignment.");
                        }
                    }
                }
                if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
                    this.context.propertyPath(node.operand)?.[0] === "camera") {
                    this.context.contractError(node, "Camera control gained an unrepresented unary store.");
                }
                return ts.visitEachChild(node, visit, context);
            };
            return (node) => ts.visitNode(node, visit) as ts.Block;
        }]);
        const translated = ts.createSourceFile(`${name}.ts`, `function body() ${ts.createPrinter().printNode(ts.EmitHint.Unspecified, transformed.transformed[0]!, file)}`, ts.ScriptTarget.Latest, true);
        transformed.dispose();
        const body = translated.statements[0];
        if (!body || !ts.isFunctionDeclaration(body) || !body.body) throw new Error("Camera body reconstruction failed.");
        const bindings = new Map<string, PinnedBinding>();
        bindings.set("Math.PI", { cpp: "pi_double", type: "scalar" });
        for (const property of ["inertialAlphaOffset", "inertialBetaOffset", "inertialRadiusOffset", "inertialPanningX", "inertialPanningY", "inertia", "panningInertia"]) {
            bindings.set(`camera.${property}`, { cpp: `camera.${snakeCase(property)}`, type: "scalar" });
        }
        for (const access of this.context.findNodes(body, ts.isPropertyAccessExpression)) {
            const path = this.context.propertyPath(access);
            if (path?.length === 2 && path[0] === "camera") {
                const field = cameraRecordField(path[1]!);
                if (field) bindings.set(path.join("."), { cpp: `camera.${field}`, type: "scalar" });
                else if (path[1]?.endsWith("Limit")) {
                    const field = snakeCase(path[1]);
                    bindings.set(path.join("."), { cpp: `*camera.${field}`, type: "scalar", absentCpp: `!camera.${field}.has_value()` });
                }
            }
        }
        for (const axis of axes) bindings.set(`camera.target.${axis}`, { cpp: `camera.target.${axis}`, type: "scalar" });
        const attach = this.context.findNodes(file, (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "attachControl")[0]!;
        for (const constant of ["ROTATION_EPSILON", "RADIUS_EPSILON", "PANNING_EPSILON"]) {
            bindings.set(constant, { cpp: this.context.doubleLiteral(this.context.numericValue(this.context.variableInitializer(attach, constant), file)), type: "scalar" });
        }
        return this.lower(translated, body.body, bindings, new Map([
            ...["cos", "sin", "abs"].map((name): [string, (args: readonly string[]) => string] => [
                `Math.${name}`, (args) => `std::${name}(${args.join(", ")})`,
            ]),
            ...["min", "max"].map((name): [string, (args: readonly string[]) => string] => [
                `Math.${name}`, (args) => {
                    if (args.length !== 2) this.context.contractError(declaration, "Camera clamp requires two numeric operands.");
                    // JS propagates NaN from either operand and orders signed
                    // zero. std::min/max alone preserve neither contract.
                    return `([](double a, double b) { if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN(); ` +
                        `if (a == b) return std::signbit(a) ? ${name === "min" ? "a : b" : "b : a"}; ` +
                        `return std::${name}(a, b); })(${args.join(", ")})`;
                },
            ]),
            ...scalarFields.map((field): [string, (args: readonly string[]) => string] => [
                `write_${field}`, (args) => `write_camera_scalar(camera, &CameraRecord::${field}, ${args.join(", ")})`,
            ]),
            ...axes.map((axis): [string, (args: readonly string[]) => string] => [
                `write_target_${axis}`, (args) => `write_camera_vector_component(camera, &CameraRecord::target, &Vec3d::${axis}, ${args.join(", ")})`,
            ]),
        ]));
    }

    public clamp(): string { return this.controlBody("clampCameraToLimits"); }
    public inertia(): string { return this.controlBody("applyInertia"); }
}
