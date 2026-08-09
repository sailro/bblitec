import ts from "typescript";

export interface CompileOptions {
    fileName?: string;
    title?: string;
    width?: number;
    height?: number;
}

export interface CompileManifest {
    source: string;
    features: string[];
    runtimeSources: string[];
    generatedSources: string[];
    assets: CompileAsset[];
}

export interface CompileAsset {
    source: string;
    output: string;
    kind: "environment" | "gltf" | "texture";
}

export interface CompileResult {
    cpp: string;
    cmake: string;
    manifest: CompileManifest;
}

type ValueKind = "asset" | "browser" | "camera" | "engine" | "light" | "material" | "mesh" | "number" | "scene" | "void";

interface Value {
    kind: ValueKind;
    cpp: string;
    engineCpp?: string;
}

type Feature =
    | "core"
    | "backend:sdl"
    | "camera:arc-rotate"
    | "camera:default"
    | "environment:ibl"
    | "light:hemispheric"
    | "loader:gltf"
    | "material:standard"
    | "mesh:box"
    | "mesh:ground";

const featureSources: Record<Feature, string[]> = {
    "core": ["src/pal.cpp"],
    "backend:sdl": ["src/pal_sdl.cpp"],
    "camera:arc-rotate": [],
    "camera:default": [],
    "environment:ibl": [],
    "light:hemispheric": [],
    "loader:gltf": ["src/pal_sdl_gpu.cpp"],
    "material:standard": [],
    "mesh:box": [],
    "mesh:ground": [],
};

const featureOrder = Object.keys(featureSources) as Feature[];

export class CompileError extends Error {
    public readonly fileName: string;
    public readonly line: number;
    public readonly column: number;

    public constructor(fileName: string, line: number, column: number, message: string) {
        super(`${fileName}:${line}:${column}: ${message}`);
        this.name = "CompileError";
        this.fileName = fileName;
        this.line = line;
        this.column = column;
    }
}

export function compileSource(source: string, options: CompileOptions = {}): CompileResult {
    const fileName = options.fileName ?? "input.ts";
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const compiler = new Compiler(sourceFile, {
        fileName,
        title: options.title ?? "Babylon Lite Native",
        width: options.width ?? 1280,
        height: options.height ?? 720,
    });
    return compiler.compile();
}

interface ResolvedCompileOptions {
    fileName: string;
    title: string;
    width: number;
    height: number;
}

class Compiler {
    private readonly imports = new Map<string, string>();
    private readonly variables = new Map<string, Value>();
    private readonly features = new Set<Feature>(["core"]);
    private readonly assets = new Map<string, CompileAsset>();
    private readonly body: string[] = [];
    private defaultEngineCpp: string | undefined;

    public constructor(
        private readonly sourceFile: ts.SourceFile,
        private readonly options: ResolvedCompileOptions,
    ) {}

    public compile(): CompileResult {
        this.collectImports();
        for (const statement of this.entryStatements()) {
            this.emitStatement(statement);
        }

        const features = featureOrder.filter((feature) => this.features.has(feature));
        const runtimeSources = features.flatMap((feature) => featureSources[feature]);
        const generatedSources: string[] = [
            "upstream/src/engine.cpp",
            "upstream/src/scene_core.cpp",
        ];
        if (features.includes("camera:arc-rotate") || features.includes("camera:default")) {
            generatedSources.push(
                "upstream/src/camera_arc_rotate.cpp",
                "upstream/src/camera_controls.cpp",
            );
        }
        if (features.includes("camera:default")) {
            generatedSources.push("upstream/src/camera_default.cpp");
        }
        if (features.includes("environment:ibl")) {
            generatedSources.push(
                "upstream/src/env_parse.cpp",
                "upstream/src/environment.cpp",
            );
        }
        if (features.includes("light:hemispheric")) {
            generatedSources.push("upstream/src/light_matrix.cpp", "upstream/src/light_hemispheric.cpp");
        }
        if (features.includes("loader:gltf")) {
            generatedSources.push(
                "upstream/src/gltf_glb_parser.cpp",
                "upstream/src/gltf_loader.cpp",
                "upstream/src/renderer_plan.cpp",
            );
        }
        if (features.includes("material:standard")) {
            generatedSources.push("upstream/src/material_standard.cpp");
        }
        if (features.includes("mesh:box") || features.includes("mesh:ground")) {
            generatedSources.push("upstream/src/mesh_factories.cpp");
        }
        return {
            cpp: this.renderCpp(),
            cmake: this.renderCmake(features, runtimeSources, generatedSources),
            manifest: {
                source: this.options.fileName,
                features,
                runtimeSources,
                generatedSources,
                assets: [...this.assets.values()],
            },
        };
    }

    private collectImports(): void {
        for (const statement of this.sourceFile.statements) {
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
                continue;
            }
            if (statement.moduleSpecifier.text !== "@babylonjs/lite" && statement.moduleSpecifier.text !== "babylon-lite") {
                continue;
            }

            const clause = statement.importClause;
            if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
                continue;
            }

            for (const element of clause.namedBindings.elements) {
                if (!element.isTypeOnly) {
                    this.imports.set(element.name.text, element.propertyName?.text ?? element.name.text);
                }
            }
        }
    }

    private entryStatements(): readonly ts.Statement[] {
        const main = this.sourceFile.statements.find(
            (statement): statement is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(statement) && statement.name?.text === "main" && statement.body !== undefined,
        );
        if (main) {
            return main.body!.statements;
        }

        const statements = this.sourceFile.statements.filter((statement) => !ts.isImportDeclaration(statement));
        if (statements.length === 0) {
            this.failAtFile("Expected top-level scene statements or a function named main with a body.");
        }
        return statements;
    }

    private emitStatement(statement: ts.Statement): void {
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                this.emitVariableDeclaration(declaration);
            }
            return;
        }

        if (ts.isExpressionStatement(statement)) {
            this.emitExpressionStatement(statement.expression);
            return;
        }

        if (ts.isReturnStatement(statement) && !statement.expression) {
            return;
        }

        if (ts.isEmptyStatement(statement)) {
            return;
        }

        this.fail(statement, `Unsupported statement: ${ts.SyntaxKind[statement.kind]}.`);
    }

    private emitVariableDeclaration(declaration: ts.VariableDeclaration): void {
        if (!ts.isIdentifier(declaration.name)) {
            this.fail(declaration.name, "Only identifier variable declarations are supported.");
        }
        if (!declaration.initializer) {
            this.fail(declaration, `Variable '${declaration.name.text}' requires an initializer.`);
        }

        const sourceName = declaration.name.text;
        if (this.variables.has(sourceName)) {
            this.fail(declaration.name, `Variable shadowing is not supported for '${sourceName}'.`);
        }

        if (this.isBrowserOnlyExpression(declaration.initializer)) {
            this.variables.set(sourceName, { kind: "browser", cpp: "" });
            return;
        }

        const value = this.compileValue(declaration.initializer);
        if (value.kind === "void" || value.kind === "browser") {
            this.fail(declaration.initializer, `Expression assigned to '${sourceName}' does not produce a native value.`);
        }

        const cppName = this.cppIdentifier(sourceName);
        this.emit(`auto ${cppName} = ${value.cpp};`);
        const stored = { ...value, cpp: cppName };
        this.variables.set(sourceName, stored);
        if (value.kind === "engine") {
            if (this.defaultEngineCpp) {
                this.fail(declaration, "The prototype currently supports one engine per entry point.");
            }
            this.defaultEngineCpp = cppName;
        }
    }

    private emitExpressionStatement(expression: ts.Expression): void {
        const unwrapped = this.unwrap(expression);

        if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            this.emitAssignment(unwrapped);
            return;
        }

        if (ts.isCallExpression(unwrapped) && this.emitMemberSetCall(unwrapped)) {
            return;
        }

        if (ts.isCallExpression(unwrapped) && this.isBrowserInstrumentationCall(unwrapped)) {
            return;
        }

        if (ts.isCallExpression(unwrapped)) {
            const value = this.compileCall(unwrapped);
            this.emit(`${value.cpp};`);
            return;
        }

        this.fail(unwrapped, `Unsupported expression statement: ${ts.SyntaxKind[unwrapped.kind]}.`);
    }

    private emitAssignment(expression: ts.BinaryExpression): void {
        if (!ts.isPropertyAccessExpression(expression.left)) {
            this.fail(expression.left, "Only property assignments are supported.");
        }

        const left = expression.left;
        if (ts.isIdentifier(left.expression)) {
            const target = this.lookup(left.expression);
            const property = left.name.text;

            if (target.kind === "scene" && property === "clearColor") {
                this.emit(`${target.cpp}.clear_color = ${this.compileColor4(expression.right)};`);
                return;
            }

            if (target.kind === "scene" && property === "camera") {
                const camera = this.compileValue(expression.right);
                this.expectKind(camera, "camera", expression.right);
                this.emit(`${target.cpp}.camera = ${camera.cpp};`);
                return;
            }

            if (target.kind === "mesh" && property === "material") {
                const material = this.compileValue(expression.right);
                this.expectKind(material, "material", expression.right);
                this.expectSameEngine(target, material, expression);
                this.emit(
                    `${this.requireEngine(target, expression)}.meshes[${target.cpp}.value].material = ${material.cpp};`,
                );
                return;
            }

            if (target.kind === "material" && property === "diffuseColor") {
                this.emit(
                    `${this.requireEngine(target, expression)}.materials[${target.cpp}.value].diffuse_color = ${this.compileColor3(expression.right)};`,
                );
                return;
            }

            if (target.kind === "camera" && (property === "alpha" || property === "beta" || property === "radius")) {
                this.emit(
                    `${this.requireEngine(target, expression)}.cameras[${target.cpp}.value].${property} = ${this.compileNumber(expression.right)};`,
                );
                return;
            }
        }

        if (
            ts.isPropertyAccessExpression(left.expression) &&
            ts.isIdentifier(left.expression.expression) &&
            left.expression.name.text === "rotation"
        ) {
            const mesh = this.lookup(left.expression.expression);
            this.expectKind(mesh, "mesh", left.expression.expression);
            const axis = { x: 0, y: 1, z: 2 }[left.name.text as "x" | "y" | "z"];
            if (axis === undefined) {
                this.fail(left.name, `Unsupported rotation axis '${left.name.text}'.`);
            }
            const component = ["x", "y", "z"][axis]!;
            this.emit(
                `${this.requireEngine(mesh, expression)}.meshes[${mesh.cpp}.value].rotation.${component} = ${this.compileNumber(expression.right)};`,
            );
            return;
        }

        this.fail(left, `Unsupported property assignment '${left.getText(this.sourceFile)}'.`);
    }

    private emitMemberSetCall(call: ts.CallExpression): boolean {
        if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "set") {
            return false;
        }
        const owner = call.expression.expression;
        if (!ts.isPropertyAccessExpression(owner) || !ts.isIdentifier(owner.expression)) {
            return false;
        }

        const target = this.lookup(owner.expression);
        if (target.kind !== "mesh") {
            return false;
        }
        if (!["position", "rotation", "scaling"].includes(owner.name.text)) {
            return false;
        }
        if (call.arguments.length !== 3) {
            this.fail(call, `${owner.name.text}.set expects exactly three numeric arguments.`);
        }

        const vector = `bbl::Vec3{${call.arguments.map((argument) => this.compileNumber(argument)).join(", ")}}`;
        this.emit(
            `${this.requireEngine(target, call)}.meshes[${target.cpp}.value].${owner.name.text} = ${vector};`,
        );
        return true;
    }

    private compileValue(expression: ts.Expression): Value {
        const unwrapped = this.unwrap(expression);

        if (ts.isIdentifier(unwrapped)) {
            return this.lookup(unwrapped);
        }
        if (ts.isCallExpression(unwrapped)) {
            return this.compileCall(unwrapped);
        }
        if (this.isNumberExpression(unwrapped)) {
            return { kind: "number", cpp: this.compileNumber(unwrapped) };
        }
        if (this.isBrowserOnlyExpression(unwrapped)) {
            return { kind: "browser", cpp: "" };
        }

        this.fail(unwrapped, `Unsupported value expression: ${ts.SyntaxKind[unwrapped.kind]}.`);
    }

    private compileCall(call: ts.CallExpression): Value {
        const callee = this.unwrap(call.expression);
        if (!ts.isIdentifier(callee)) {
            this.fail(callee, `Unsupported call target '${callee.getText(this.sourceFile)}'.`);
        }

        const importedName = this.imports.get(callee.text);
        if (!importedName) {
            this.fail(callee, `Call '${callee.text}' is not a named import from @babylonjs/lite.`);
        }

        switch (importedName) {
            case "createEngine":
                return {
                    kind: "engine",
                    cpp: `bbl::create_engine(bbl::EngineOptions{${this.cppString(this.options.title)}, ${this.options.width}, ${this.options.height}})`,
                };

            case "createSceneContext": {
                this.expectArgumentCount(call, 1, 2);
                const engine = this.compileValue(call.arguments[0]!);
                this.expectKind(engine, "engine", call.arguments[0]!);
                return { kind: "scene", cpp: `bbl::create_scene_context(${engine.cpp})`, engineCpp: engine.cpp };
            }

            case "createBox": {
                this.expectArgumentCount(call, 1, 2);
                const engine = this.compileValue(call.arguments[0]!);
                this.expectKind(engine, "engine", call.arguments[0]!);
                const size = call.arguments[1] ? this.compileBoxSize(call.arguments[1]) : "1.0f";
                this.features.add("mesh:box");
                return { kind: "mesh", cpp: `bbl::create_box(${engine.cpp}, ${size})`, engineCpp: engine.cpp };
            }

            case "createGround": {
                this.expectArgumentCount(call, 1, 2);
                const engine = this.compileValue(call.arguments[0]!);
                this.expectKind(engine, "engine", call.arguments[0]!);
                const options = call.arguments[1] ? this.compileGroundOptions(call.arguments[1]) : ["1.0f", "1.0f"];
                this.features.add("mesh:ground");
                return {
                    kind: "mesh",
                    cpp: `bbl::create_ground(${engine.cpp}, bbl::GroundOptions{${options[0]}, ${options[1]}})`,
                    engineCpp: engine.cpp,
                };
            }

            case "createStandardMaterial": {
                this.expectArgumentCount(call, 0, 0);
                const engine = this.requireDefaultEngine(call);
                this.features.add("material:standard");
                return { kind: "material", cpp: `bbl::create_standard_material(${engine})`, engineCpp: engine };
            }

            case "createHemisphericLight": {
                this.expectArgumentCount(call, 0, 2);
                const engine = this.requireDefaultEngine(call);
                const direction = call.arguments[0] ? this.compileVec3(call.arguments[0]) : "bbl::Vec3{0.0f, 1.0f, 0.0f}";
                const intensity = call.arguments[1] ? this.compileNumber(call.arguments[1]) : "1.0f";
                this.features.add("light:hemispheric");
                return {
                    kind: "light",
                    cpp: `bbl::create_hemispheric_light(${engine}, ${direction}, ${intensity})`,
                    engineCpp: engine,
                };
            }

            case "createArcRotateCamera": {
                this.expectArgumentCount(call, 4, 4);
                const engine = this.requireDefaultEngine(call);
                this.features.add("camera:arc-rotate");
                return {
                    kind: "camera",
                    cpp: `bbl::create_arc_rotate_camera(${engine}, ${this.compileNumber(call.arguments[0]!)}, ${this.compileNumber(call.arguments[1]!)}, ${this.compileNumber(call.arguments[2]!)}, ${this.compileVec3(call.arguments[3]!)})`,
                    engineCpp: engine,
                };
            }

            case "createDefaultCamera": {
                this.expectArgumentCount(call, 1, 1);
                const scene = this.compileValue(call.arguments[0]!);
                this.expectKind(scene, "scene", call.arguments[0]!);
                const engine = this.requireEngine(scene, call);
                this.features.add("camera:arc-rotate");
                this.features.add("camera:default");
                return {
                    kind: "camera",
                    cpp: `bbl::create_default_camera(${engine}, ${scene.cpp})`,
                    engineCpp: engine,
                };
            }

            case "loadGltf": {
                this.expectArgumentCount(call, 2, 2);
                const engine = this.compileValue(call.arguments[0]!);
                this.expectKind(engine, "engine", call.arguments[0]!);
                const source = this.compileStringLiteral(call.arguments[1]!);
                const asset = this.registerAsset(source, "gltf");
                this.features.add("loader:gltf");
                return {
                    kind: "asset",
                    cpp: `bbl::load_gltf(${engine.cpp}, bbl::asset_path(${this.cppString(asset.output)}))`,
                    engineCpp: engine.cpp,
                };
            }

            case "loadEnvironment": {
                this.expectArgumentCount(call, 2, 3);
                const scene = this.compileValue(call.arguments[0]!);
                this.expectKind(scene, "scene", call.arguments[0]!);
                const environmentUrl = this.compileStringLiteral(call.arguments[1]!);
                const environmentAsset = this.registerAsset(environmentUrl, "environment");
                const options: [string, string, string, string] = call.arguments[2]
                    ? this.compileEnvironmentOptions(call.arguments[2])
                    : ["", "", "1000.0f", ""];
                const groundAsset = options[0]
                    ? this.registerAsset(options[0], "texture")
                    : undefined;
                const skyboxAsset = options[1]
                    ? this.registerAsset(options[1], "texture")
                    : undefined;
                const brdfAsset = options[3]
                    ? this.registerAsset(this.resolveBundledAsset(options[3]), "texture")
                    : undefined;
                this.features.add("environment:ibl");
                return {
                    kind: "void",
                    cpp: `bbl::load_environment(${scene.cpp}, bbl::EnvironmentOptions{bbl::asset_path(${this.cppString(environmentAsset.output)}), ${groundAsset ? `bbl::asset_path(${this.cppString(groundAsset.output)})` : this.cppString("")}, ${skyboxAsset ? `bbl::asset_path(${this.cppString(skyboxAsset.output)})` : this.cppString("")}, ${options[2]}, ${brdfAsset ? `bbl::asset_path(${this.cppString(brdfAsset.output)})` : this.cppString("")}})`,
                };
            }

            case "addToScene": {
                this.expectArgumentCount(call, 2, 2);
                const scene = this.compileValue(call.arguments[0]!);
                const resource = this.compileValue(call.arguments[1]!);
                this.expectKind(scene, "scene", call.arguments[0]!);
                if (resource.kind !== "asset" && resource.kind !== "mesh" && resource.kind !== "light") {
                    this.fail(call.arguments[1]!, `addToScene supports asset, mesh, and light values, received ${resource.kind}.`);
                }
                this.expectSameEngine(scene, resource, call);
                return { kind: "void", cpp: `bbl::add_to_scene(${scene.cpp}, ${resource.cpp})` };
            }

            case "attachControl": {
                this.expectArgumentCount(call, 2, 3);
                const camera = this.compileValue(call.arguments[0]!);
                const sceneArgument = call.arguments.length === 3 ? call.arguments[2]! : call.arguments[1]!;
                const scene = this.compileValue(sceneArgument);
                this.expectKind(camera, "camera", call.arguments[0]!);
                this.expectKind(scene, "scene", sceneArgument);
                this.expectSameEngine(camera, scene, call);
                return {
                    kind: "void",
                    cpp: `bbl::attach_control(${this.requireEngine(camera, call)}, ${camera.cpp}, ${scene.cpp})`,
                };
            }

            case "registerScene": {
                this.expectArgumentCount(call, 1, 1);
                const scene = this.compileValue(call.arguments[0]!);
                this.expectKind(scene, "scene", call.arguments[0]!);
                return { kind: "void", cpp: `bbl::register_scene(${scene.cpp})` };
            }

            case "startEngine": {
                this.expectArgumentCount(call, 1, 1);
                const engine = this.compileValue(call.arguments[0]!);
                this.expectKind(engine, "engine", call.arguments[0]!);
                this.features.add("backend:sdl");
                return { kind: "void", cpp: `bbl::start_engine(${engine.cpp})` };
            }

            default:
                this.fail(
                    callee,
                    `Babylon Lite intrinsic '${importedName}' is not supported by this prototype. Supported scene APIs are documented in README.md.`,
                );
        }
    }

    private compileBoxSize(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (ts.isObjectLiteralExpression(unwrapped)) {
            const size = this.objectProperty(unwrapped, "size");
            return size ? this.compileNumber(size) : "1.0f";
        }
        return this.compileNumber(unwrapped);
    }

    private compileGroundOptions(expression: ts.Expression): [string, string] {
        const object = this.expectObjectLiteral(expression);
        const width = this.objectProperty(object, "width");
        const height = this.objectProperty(object, "height");
        return [width ? this.compileNumber(width) : "1.0f", height ? this.compileNumber(height) : "1.0f"];
    }

    private compileEnvironmentOptions(expression: ts.Expression): [string, string, string, string] {
        const object = this.expectObjectLiteral(expression);
        const groundTextureUrl = this.objectProperty(object, "groundTextureUrl");
        const skyboxUrl = this.objectProperty(object, "skyboxUrl");
        const skyboxSize = this.objectProperty(object, "skyboxSize");
        const brdfUrl = this.objectProperty(object, "brdfUrl");
        return [
            groundTextureUrl ? this.compileStringLiteral(groundTextureUrl) : "",
            skyboxUrl ? this.compileStringLiteral(skyboxUrl) : "",
            skyboxSize ? this.compileNumber(skyboxSize) : "1000.0f",
            brdfUrl ? this.compileStringLiteral(brdfUrl) : "",
        ];
    }

    private compileVec3(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (ts.isArrayLiteralExpression(unwrapped)) {
            if (unwrapped.elements.length !== 3) {
                this.fail(unwrapped, "A Vec3 array must contain exactly three numbers.");
            }
            return `bbl::Vec3{${unwrapped.elements.map((element) => this.compileNumber(element)).join(", ")}}`;
        }
        if (ts.isObjectLiteralExpression(unwrapped)) {
            return `bbl::Vec3{${this.requiredObjectNumber(unwrapped, "x")}, ${this.requiredObjectNumber(unwrapped, "y")}, ${this.requiredObjectNumber(unwrapped, "z")}}`;
        }
        this.fail(unwrapped, "Expected a Vec3 array [x, y, z] or object { x, y, z }.");
    }

    private compileColor3(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (ts.isArrayLiteralExpression(unwrapped) && unwrapped.elements.length === 3) {
            return `bbl::Color3{${unwrapped.elements.map((element) => this.compileNumber(element)).join(", ")}}`;
        }
        if (ts.isObjectLiteralExpression(unwrapped)) {
            return `bbl::Color3{${this.requiredObjectNumber(unwrapped, "r")}, ${this.requiredObjectNumber(unwrapped, "g")}, ${this.requiredObjectNumber(unwrapped, "b")}}`;
        }
        this.fail(unwrapped, "Expected a Color3 array [r, g, b] or object { r, g, b }.");
    }

    private compileColor4(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (ts.isArrayLiteralExpression(unwrapped) && unwrapped.elements.length === 4) {
            return `bbl::Color4{${unwrapped.elements.map((element) => this.compileNumber(element)).join(", ")}}`;
        }
        if (ts.isObjectLiteralExpression(unwrapped)) {
            return `bbl::Color4{${this.requiredObjectNumber(unwrapped, "r")}, ${this.requiredObjectNumber(unwrapped, "g")}, ${this.requiredObjectNumber(unwrapped, "b")}, ${this.requiredObjectNumber(unwrapped, "a")}}`;
        }
        this.fail(unwrapped, "Expected a Color4 array [r, g, b, a] or object { r, g, b, a }.");
    }

    private compileNumber(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (ts.isNumericLiteral(unwrapped)) {
            const value = Number(unwrapped.text);
            if (!Number.isFinite(value)) {
                this.fail(unwrapped, `Invalid numeric literal '${unwrapped.text}'.`);
            }
            return this.floatLiteral(value);
        }
        if (ts.isPrefixUnaryExpression(unwrapped)) {
            if (unwrapped.operator !== ts.SyntaxKind.MinusToken && unwrapped.operator !== ts.SyntaxKind.PlusToken) {
                this.fail(unwrapped, "Only unary plus and minus are supported in numeric expressions.");
            }
            const operator = unwrapped.operator === ts.SyntaxKind.MinusToken ? "-" : "+";
            return `(${operator}${this.compileNumber(unwrapped.operand)})`;
        }
        if (ts.isBinaryExpression(unwrapped)) {
            const operator = new Map<ts.SyntaxKind, string>([
                [ts.SyntaxKind.PlusToken, "+"],
                [ts.SyntaxKind.MinusToken, "-"],
                [ts.SyntaxKind.AsteriskToken, "*"],
                [ts.SyntaxKind.SlashToken, "/"],
            ]).get(unwrapped.operatorToken.kind);
            if (!operator) {
                this.fail(unwrapped.operatorToken, "Only +, -, *, and / are supported in numeric expressions.");
            }
            return `(${this.compileNumber(unwrapped.left)} ${operator} ${this.compileNumber(unwrapped.right)})`;
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            ts.isIdentifier(unwrapped.expression) &&
            unwrapped.expression.text === "Math" &&
            unwrapped.name.text === "PI"
        ) {
            return "bbl::pi";
        }
        if (ts.isIdentifier(unwrapped)) {
            const value = this.lookup(unwrapped);
            this.expectKind(value, "number", unwrapped);
            return value.cpp;
        }
        this.fail(unwrapped, `Expected a compileable number, received '${unwrapped.getText(this.sourceFile)}'.`);
    }

    private isNumberExpression(expression: ts.Expression): boolean {
        const unwrapped = this.unwrap(expression);
        return (
            ts.isNumericLiteral(unwrapped) ||
            ts.isPrefixUnaryExpression(unwrapped) ||
            ts.isBinaryExpression(unwrapped) ||
            (ts.isPropertyAccessExpression(unwrapped) &&
                ts.isIdentifier(unwrapped.expression) &&
                unwrapped.expression.text === "Math" &&
                unwrapped.name.text === "PI")
        );
    }

    private expectObjectLiteral(expression: ts.Expression): ts.ObjectLiteralExpression {
        const unwrapped = this.unwrap(expression);
        if (!ts.isObjectLiteralExpression(unwrapped)) {
            this.fail(unwrapped, "Expected an object literal.");
        }
        return unwrapped;
    }

    private objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
        for (const property of object.properties) {
            if (ts.isPropertyAssignment(property) && this.propertyName(property.name) === name) {
                return property.initializer;
            }
            if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
                return property.name;
            }
        }
        return undefined;
    }

    private requiredObjectNumber(object: ts.ObjectLiteralExpression, name: string): string {
        const value = this.objectProperty(object, name);
        if (!value) {
            this.fail(object, `Object literal is missing numeric property '${name}'.`);
        }
        return this.compileNumber(value);
    }

    private propertyName(name: ts.PropertyName): string | undefined {
        if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
            return name.text;
        }
        return undefined;
    }

    private compileStringLiteral(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
            return unwrapped.text;
        }
        this.fail(unwrapped, "Expected a string literal.");
    }

    private registerAsset(source: string, kind: CompileAsset["kind"]): CompileAsset {
        const existing = this.assets.get(source);
        if (existing) {
            return existing;
        }

        const sourcePath = source.split(/[?#]/, 1)[0] ?? source;
        const sourceName = sourcePath.split(/[\\/]/).pop() || `${kind}.bin`;
        const safeName = sourceName.replace(/[^A-Za-z0-9._-]/g, "_");
        const asset: CompileAsset = {
            source,
            output: `${this.hash(source)}-${safeName}`,
            kind,
        };
        this.assets.set(source, asset);
        return asset;
    }

    private resolveBundledAsset(source: string): string {
        if (source === "/brdf-lut.png") {
            return "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/master/packages/babylon-lite/assets/brdf-lut.png";
        }
        return source;
    }

    private hash(value: string): string {
        let hash = 0x811c9dc5;
        for (let index = 0; index < value.length; index += 1) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(16).padStart(8, "0");
    }

    private isBrowserOnlyExpression(expression: ts.Expression): boolean {
        const unwrapped = this.unwrap(expression);
        const isCanvasLookup =
            ts.isCallExpression(unwrapped) &&
            ts.isPropertyAccessExpression(unwrapped.expression) &&
            ts.isIdentifier(unwrapped.expression.expression) &&
            unwrapped.expression.expression.text === "document" &&
            (unwrapped.expression.name.text === "getElementById" || unwrapped.expression.name.text === "querySelector");
        const isPerformanceNow =
            ts.isCallExpression(unwrapped) &&
            ts.isPropertyAccessExpression(unwrapped.expression) &&
            ts.isIdentifier(unwrapped.expression.expression) &&
            unwrapped.expression.expression.text === "performance" &&
            unwrapped.expression.name.text === "now";
        return isCanvasLookup || isPerformanceNow;
    }

    private isBrowserInstrumentationCall(call: ts.CallExpression): boolean {
        return (
            ts.isPropertyAccessExpression(call.expression) &&
            ts.isIdentifier(call.expression.expression) &&
            call.expression.expression.text === "Object" &&
            call.expression.name.text === "assign"
        );
    }

    private unwrap(expression: ts.Expression): ts.Expression {
        let current = expression;
        while (
            ts.isAwaitExpression(current) ||
            ts.isParenthesizedExpression(current) ||
            ts.isAsExpression(current) ||
            ts.isTypeAssertionExpression(current) ||
            ts.isNonNullExpression(current)
        ) {
            current = current.expression;
        }
        return current;
    }

    private lookup(identifier: ts.Identifier): Value {
        const value = this.variables.get(identifier.text);
        if (!value) {
            this.fail(identifier, `Unknown or unsupported variable '${identifier.text}'.`);
        }
        return value;
    }

    private expectKind(value: Value, kind: ValueKind, node: ts.Node): void {
        if (value.kind !== kind) {
            this.fail(node, `Expected ${kind}, received ${value.kind}.`);
        }
    }

    private expectSameEngine(left: Value, right: Value, node: ts.Node): void {
        if (left.engineCpp && right.engineCpp && left.engineCpp !== right.engineCpp) {
            this.fail(node, "Values from different engines cannot be combined.");
        }
    }

    private requireEngine(value: Value, node: ts.Node): string {
        if (!value.engineCpp) {
            this.fail(node, `A ${value.kind} value is not associated with an engine.`);
        }
        return value.engineCpp;
    }

    private requireDefaultEngine(node: ts.Node): string {
        if (!this.defaultEngineCpp) {
            this.fail(node, "This intrinsic requires createEngine to run first.");
        }
        return this.defaultEngineCpp;
    }

    private expectArgumentCount(call: ts.CallExpression, minimum: number, maximum: number): void {
        if (call.arguments.length < minimum || call.arguments.length > maximum) {
            const expected = minimum === maximum ? `${minimum}` : `${minimum}-${maximum}`;
            this.fail(call, `Expected ${expected} arguments, received ${call.arguments.length}.`);
        }
    }

    private cppIdentifier(sourceName: string): string {
        return `v_${sourceName.replace(/[^A-Za-z0-9_]/g, "_")}`;
    }

    private cppString(value: string): string {
        return JSON.stringify(value)
            .replace(/\u2028/g, "\\u2028")
            .replace(/\u2029/g, "\\u2029");
    }

    private floatLiteral(value: number): string {
        if (Number.isInteger(value)) {
            return `${value}.0f`;
        }
        return `${value}f`;
    }

    private emit(line: string): void {
        this.body.push(`        ${line}`);
    }

    private renderCpp(): string {
        return `// Generated by bblitec. Do not edit.
#include <bblite/runtime.hpp>

#include <exception>
#include <iostream>

int main() {
    try {
${this.body.join("\n")}
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Babylon Lite native error: " << error.what() << '\\n';
        return 1;
    }
}
`;
    }

    private renderCmake(features: Feature[], runtimeSources: string[], generatedSources: string[]): string {
        const sourceLines = runtimeSources.map((source) => `    "\${BBLITE_NATIVE_ROOT}/${source}"`).join("\n");
        const generatedSourceLines = generatedSources
            .map((source) => `    "\${BBLITE_GENERATED_DIR}/${source}"`)
            .join("\n");
        const featureLines = features.map((feature) => `    "${feature}"`).join("\n");
        return `# Generated by bblitec. Included by native/CMakeLists.txt.
set(BBLITE_RUNTIME_FEATURES
${featureLines}
)

set(BBLITE_RUNTIME_SOURCES
${sourceLines}
)

set(BBLITE_GENERATED_SOURCES
${generatedSourceLines}
)
`;
    }

    private fail(node: ts.Node, message: string): never {
        const position = this.sourceFile.getLineAndCharacterOfPosition(node.getStart(this.sourceFile));
        throw new CompileError(this.options.fileName, position.line + 1, position.character + 1, message);
    }

    private failAtFile(message: string): never {
        throw new CompileError(this.options.fileName, 1, 1, message);
    }
}
