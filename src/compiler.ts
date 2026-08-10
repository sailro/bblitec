import ts from "typescript";
import { CompileAdaptation } from "./fidelity.js";
import {
    normalizeShaderSource,
    shaderMaterialPrograms,
} from "./shader-material-programs.js";

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
    shaderVariants: ShaderMaterialVariantName[];
    geometryOutputTasks: GeometryOutputTaskManifest[];
    adaptations: CompileAdaptation[];
}

export interface CompileAsset {
    source: string;
    output: string;
    kind: "babylon" | "environment" | "gltf" | "hdr-environment" | "texture";
    faceSize?: number;
}

export type GeometryTextureTypeName =
    | "IRRADIANCE"
    | "WORLD_POSITION"
    | "LOCAL_POSITION"
    | "REFLECTIVITY"
    | "VIEW_DEPTH"
    | "NORMALIZED_VIEW_DEPTH"
    | "SCREENSPACE_DEPTH"
    | "VIEW_NORMAL"
    | "WORLD_NORMAL"
    | "ALBEDO"
    | "LINEAR_VELOCITY";

export type ShaderMaterialVariantName = "alpha-card" | "circular-cutout";

export interface GeometryOutputTaskManifest {
    shaderIndex: number;
    attachments: GeometryTextureTypeName[];
    emitColor: boolean;
}

export interface CompileResult {
    cpp: string;
    cmake: string;
    manifest: CompileManifest;
}

type ValueKind =
    | "asset"
    | "browser"
    | "camera"
    | "engine"
    | "light"
    | "material"
    | "mesh"
    | "number"
    | "render-target"
    | "render-target-texture"
    | "render-texture"
    | "scene"
    | "task"
    | "texture"
    | "void";

interface Value {
    kind: ValueKind;
    cpp: string;
    engineCpp?: string;
    geometryTask?: GeometryOutputTaskManifest;
    shaderVariant?: ShaderMaterialVariantName;
}

type Feature =
    | "background:ground"
    | "background:skybox"
    | "core"
    | "backend:sdl"
    | "camera:arc-rotate"
    | "camera:default"
    | "camera:free"
    | "environment:ibl"
    | "environment:env"
    | "environment:hdr"
    | "light:hemispheric"
    | "light:point"
    | "loader:babylon"
    | "loader:gltf"
    | "material:pbr"
    | "material:no-color-view"
    | "material:grid"
    | "material:shader"
    | "material:standard"
    | "mesh:box"
    | "mesh:ground"
    | "mesh:plane"
    | "mesh:sphere"
    | "mesh:torus"
    | "renderer:pbr"
    | "renderer:transmission"
    | "renderer:geometry-output";

const featureSources: Record<Feature, string[]> = {
    "core": ["src/pal.cpp"],
    "backend:sdl": ["src/pal_sdl.cpp"],
    "camera:arc-rotate": [],
    "camera:default": [],
    "camera:free": [],
    "environment:ibl": [],
    "environment:env": [],
    "environment:hdr": [],
    "background:ground": [],
    "background:skybox": [],
    "light:hemispheric": [],
    "light:point": [],
    "loader:babylon": [],
    "loader:gltf": [],
    "material:pbr": [],
    "material:no-color-view": [],
    "material:grid": [],
    "material:shader": [],
    "material:standard": [],
    "mesh:box": [],
    "mesh:ground": [],
    "mesh:plane": [],
    "mesh:sphere": [],
    "mesh:torus": [],
    "renderer:pbr": ["src/pal_sdl_gpu.cpp"],
    "renderer:transmission": [],
    "renderer:geometry-output": [],
};

const featureOrder = Object.keys(featureSources) as Feature[];

function basenameWithoutExtension(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
}

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
    private readonly staticConstants = new Map<string, ts.Expression>();
    private readonly variables = new Map<string, Value>();
    private readonly features = new Set<Feature>(["core"]);
    private readonly assets = new Map<string, CompileAsset>();
    private readonly shaderVariants = new Set<ShaderMaterialVariantName>();
    private readonly body: string[] = [];
    private readonly erasedBrowserExpressions = new Set<number>();
    private readonly erasedBrowserInstrumentation = new Set<number>();
    private readonly unwrappedAwaitExpressions = new Set<number>();
    private readonly geometryOutputTasks: GeometryOutputTaskManifest[] = [];
    private hasMainEntry = false;
    private defaultEngineCpp: string | undefined;
    private indentLevel = 2;

    public constructor(
        private readonly sourceFile: ts.SourceFile,
        private readonly options: ResolvedCompileOptions,
    ) {}

    public compile(): CompileResult {
        this.collectImports();
        this.collectStaticConstants();
        for (const statement of this.entryStatements()) {
            this.emitStatement(statement);
        }

        const features = featureOrder.filter((feature) => this.features.has(feature));
        const runtimeSources = features.flatMap((feature) => featureSources[feature]);
        const generatedSources: string[] = [
            "upstream/src/engine.cpp",
            "upstream/src/scene_core.cpp",
        ];
        if (
            features.includes("camera:arc-rotate") ||
            features.includes("camera:default") ||
            features.includes("camera:free")
        ) {
            generatedSources.push(
                "upstream/src/camera_arc_rotate.cpp",
                "upstream/src/camera_controls.cpp",
            );
        }
        if (features.includes("camera:free")) {
            generatedSources.push("upstream/src/camera_free.cpp");
        }
        if (features.includes("camera:default")) {
            generatedSources.push("upstream/src/camera_default.cpp");
        }
        if (features.includes("environment:env")) {
            generatedSources.push(
                "upstream/src/env_parse.cpp",
                "upstream/src/environment.cpp",
            );
        }
        if (features.includes("environment:hdr")) {
            generatedSources.push("upstream/src/environment_hdr.cpp");
        }
        if (features.includes("light:hemispheric")) {
            generatedSources.push("upstream/src/light_matrix.cpp", "upstream/src/light_hemispheric.cpp");
        }
        if (features.includes("light:point")) {
            generatedSources.push("upstream/src/light_point.cpp");
        }
        if (features.includes("loader:gltf")) {
            generatedSources.push(
                "upstream/src/gltf_glb_parser.cpp",
                "upstream/src/gltf_loader.cpp",
            );
        }
        if (features.includes("loader:babylon")) {
            generatedSources.push("upstream/src/babylon_loader.cpp");
        }
        if (features.includes("renderer:pbr")) {
            generatedSources.push("upstream/src/renderer_plan.cpp");
        }
        if (features.includes("renderer:geometry-output")) {
            generatedSources.push("upstream/src/frame_graph_geometry.cpp");
        }
        if (features.includes("material:pbr")) {
            generatedSources.push("upstream/src/material_pbr.cpp");
        }
        if (features.includes("material:no-color-view")) {
            generatedSources.push("upstream/src/material_views.cpp");
        }
        if (features.includes("material:grid")) {
            generatedSources.push("upstream/src/material_grid.cpp");
        }
        if (features.includes("material:shader")) {
            generatedSources.push("upstream/src/material_shader.cpp");
        }
        if (features.includes("material:standard")) {
            generatedSources.push("upstream/src/material_standard.cpp");
        }
        if (
            features.includes("mesh:box") ||
            features.includes("mesh:ground") ||
            features.includes("mesh:plane") ||
            features.includes("mesh:sphere") ||
            features.includes("mesh:torus")
        ) {
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
                shaderVariants: [...this.shaderVariants],
                geometryOutputTasks: this.geometryOutputTasks,
                adaptations: this.compileAdaptations(features),
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

    private collectStaticConstants(): void {
        for (const statement of this.sourceFile.statements) {
            if (!ts.isVariableStatement(statement)) continue;
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name) && declaration.initializer) {
                    this.staticConstants.set(
                        declaration.name.text,
                        declaration.initializer,
                    );
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
            this.hasMainEntry = true;
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

        if (ts.isIfStatement(statement)) {
            this.emitIfStatement(statement);
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

    private emitIfStatement(statement: ts.IfStatement): void {
        if (statement.elseStatement) {
            this.fail(statement.elseStatement, "Reached callbacks do not support else branches.");
        }
        this.emit(`if (${this.compileCondition(statement.expression)}) {`);
        this.indentLevel += 1;
        const statements = ts.isBlock(statement.thenStatement)
            ? statement.thenStatement.statements
            : [statement.thenStatement];
        for (const nested of statements) {
            this.emitStatement(nested);
        }
        this.indentLevel -= 1;
        this.emit("}");
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
            this.erasedBrowserExpressions.add(declaration.initializer.pos);
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

        if (
            ts.isBinaryExpression(unwrapped) &&
            [
                ts.SyntaxKind.EqualsToken,
                ts.SyntaxKind.PlusEqualsToken,
                ts.SyntaxKind.MinusEqualsToken,
            ].includes(unwrapped.operatorToken.kind)
        ) {
            this.emitAssignment(unwrapped);
            return;
        }

        if (
            ts.isPostfixUnaryExpression(unwrapped) &&
            unwrapped.operator === ts.SyntaxKind.PlusPlusToken &&
            ts.isIdentifier(unwrapped.operand)
        ) {
            const target = this.lookup(unwrapped.operand);
            this.expectKind(target, "number", unwrapped.operand);
            this.emit(`${target.cpp}++;`);
            return;
        }

        if (ts.isCallExpression(unwrapped) && this.emitMemberSetCall(unwrapped)) {
            return;
        }

        if (ts.isCallExpression(unwrapped) && this.emitTaskMethodCall(unwrapped)) {
            return;
        }

        if (ts.isCallExpression(unwrapped) && this.isBrowserInstrumentationCall(unwrapped)) {
            this.erasedBrowserInstrumentation.add(unwrapped.pos);
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
        if (
            ts.isPropertyAccessExpression(left.expression) &&
            left.expression.name.text === "dataset" &&
            ts.isIdentifier(left.expression.expression)
        ) {
            const target = this.lookup(left.expression.expression);
            if (target.kind === "browser") {
                this.erasedBrowserInstrumentation.add(expression.pos);
                return;
            }
        }
        if (
            ts.isPropertyAccessExpression(left.expression) &&
            left.expression.name.text === "imageProcessing" &&
            ts.isIdentifier(left.expression.expression)
        ) {
            const scene = this.lookup(left.expression.expression);
            this.expectKind(scene, "scene", left.expression.expression);
            const property = left.name.text;
            if (!["exposure", "contrast"].includes(property)) {
                this.fail(left.name, `Unsupported image-processing property '${property}'.`);
            }
            this.emit(
                `${scene.cpp}.environment.${property} = ${this.compileNumber(expression.right)};`,
            );
            return;
        }
        if (
            ts.isPropertyAccessExpression(left.expression) &&
            left.expression.name.text === "camera" &&
            ts.isIdentifier(left.expression.expression)
        ) {
            const scene = this.lookup(left.expression.expression);
            this.expectKind(scene, "scene", left.expression.expression);
            const property = left.name.text;
            if (!["alpha", "beta", "radius", "fov", "nearPlane", "farPlane"].includes(property)) {
                this.fail(left.name, `Unsupported camera property '${property}'.`);
            }
            const nativeProperty =
                property === "nearPlane"
                    ? "near_plane"
                    : property === "farPlane"
                        ? "far_plane"
                        : property;
            this.emit(
                `${this.requireEngine(scene, expression)}.cameras[${scene.cpp}.camera.value].${nativeProperty} = ${this.compileNumber(expression.right)};`,
            );
            return;
        }
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

            if (target.kind === "scene" && property === "fixedDeltaMs") {
                this.emit(
                    `${target.cpp}.fixed_delta_ms = ${this.compileNumber(expression.right)};`,
                );
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

            if (target.kind === "material" && property === "alpha") {
                this.emit(
                    `${this.requireEngine(target, expression)}.materials[${target.cpp}.value].base_color_factor.a = ${this.compileNumber(expression.right)};`,
                );
                return;
            }

            if (target.kind === "material" && property === "specularColor") {
                this.emit(
                    `${this.requireEngine(target, expression)}.materials[${target.cpp}.value].specular_color = ${this.compileColor3(expression.right)};`,
                );
                return;
            }

            if (target.kind === "material" && property === "specularPower") {
                this.emit(
                    `${this.requireEngine(target, expression)}.materials[${target.cpp}.value].specular_power = ${this.compileNumber(expression.right)};`,
                );
                return;
            }

            if (target.kind === "material" && property === "emissiveColor") {
                this.emit(
                    `${this.requireEngine(target, expression)}.materials[${target.cpp}.value].emissive_factor = ${this.compileColor3(expression.right)};`,
                );
                return;
            }

            if (target.kind === "material" && property === "disableLighting") {
                this.emit(
                    `${this.requireEngine(target, expression)}.materials[${target.cpp}.value].disable_lighting = ${this.compileBoolean(expression.right)};`,
                );
                return;
            }

            if (target.kind === "material" && property === "emissiveTexture") {
                const texture = this.compileValue(expression.right);
                this.expectKind(texture, "render-texture", expression.right);
                this.expectSameEngine(target, texture, expression);
                const engine = this.requireEngine(target, expression);
                this.emit(
                    `${engine}.materials[${target.cpp}.value].emissive_render_texture = ${texture.cpp};`,
                );
                this.emit(
                    `${engine}.materials[${target.cpp}.value].has_emissive_render_texture = true;`,
                );
                return;
            }

            if (
                target.kind === "camera" &&
                ["alpha", "beta", "radius", "fov", "nearPlane", "farPlane"].includes(property)
            ) {
                const operator =
                    expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
                        ? "+="
                        : expression.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken
                            ? "-="
                            : "=";
                const nativeProperty =
                    property === "nearPlane"
                        ? "near_plane"
                        : property === "farPlane"
                            ? "far_plane"
                            : property;
                this.emit(
                    `${this.requireEngine(target, expression)}.cameras[${target.cpp}.value].${nativeProperty} ${operator} ${this.compileNumber(expression.right)};`,
                );
                return;
            }
        }

        if (
            ts.isPropertyAccessExpression(left.expression) &&
            ts.isIdentifier(left.expression.expression) &&
            ["position", "rotation", "scaling"].includes(
                left.expression.name.text,
            )
        ) {
            const mesh = this.lookup(left.expression.expression);
            this.expectKind(mesh, "mesh", left.expression.expression);
            const axis = { x: 0, y: 1, z: 2 }[left.name.text as "x" | "y" | "z"];
            if (axis === undefined) {
                this.fail(left.name, `Unsupported rotation axis '${left.name.text}'.`);
            }
            const component = ["x", "y", "z"][axis]!;
            this.emit(
                `${this.requireEngine(mesh, expression)}.meshes[${mesh.cpp}.value].${left.expression.name.text}.${component} = ${this.compileNumber(expression.right)};`,
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

    private emitTaskMethodCall(call: ts.CallExpression): boolean {
        if (
            !ts.isPropertyAccessExpression(call.expression) ||
            call.expression.name.text !== "addMesh" ||
            !ts.isIdentifier(call.expression.expression)
        ) {
            return false;
        }
        const task = this.lookup(call.expression.expression);
        if (task.kind !== "task") return false;
        this.expectArgumentCount(call, 2, 2);
        const mesh = this.compileValue(call.arguments[0]!);
        this.expectKind(mesh, "mesh", call.arguments[0]!);
        const options = this.expectObjectLiteral(call.arguments[1]!);
        const materialExpression = this.objectProperty(options, "material");
        if (!materialExpression || options.properties.length !== 1) {
            this.fail(
                options,
                "Reached RenderTask.addMesh requires only a material override.",
            );
        }
        const material = this.compileValue(materialExpression);
        this.expectKind(material, "material", materialExpression);
        this.expectSameEngine(task, mesh, call);
        this.expectSameEngine(task, material, call);
        this.emit(
            `bbl::add_render_task_mesh(${this.requireEngine(task, call)}, ${task.cpp}, ${mesh.cpp}, ${material.cpp});`,
        );
        return true;
    }

    private compileValue(expression: ts.Expression): Value {
        const unwrapped = this.unwrap(expression);

        if (ts.isIdentifier(unwrapped)) {
            return this.lookup(unwrapped);
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            return this.compilePropertyAccess(unwrapped);
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

    private compilePropertyAccess(expression: ts.PropertyAccessExpression): Value {
        if (!ts.isIdentifier(expression.expression)) {
            this.fail(
                expression,
                `Unsupported property value '${expression.getText(this.sourceFile)}'.`,
            );
        }
        const owner = this.lookup(expression.expression);
        const property = expression.name.text;
        if (owner.kind === "engine" && property === "scRT") {
            return {
                kind: "render-target",
                cpp: `bbl::swapchain_render_target(${owner.cpp})`,
                engineCpp: owner.cpp,
            };
        }
        if (owner.kind === "scene" && property === "camera") {
            return {
                kind: "camera",
                cpp: `${owner.cpp}.camera`,
                ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}),
            };
        }
        if (owner.kind === "render-target-texture") {
            if (property === "rt") {
                return {
                    kind: "render-target",
                    cpp: `${owner.cpp}.rt`,
                    ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}),
                };
            }
            if (property === "texture") {
                return {
                    kind: "render-texture",
                    cpp: `${owner.cpp}.texture`,
                    ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}),
                };
            }
        }
        if (owner.kind === "task" && owner.geometryTask) {
            if (property === "outputTexture") {
                if (!owner.geometryTask.emitColor) {
                    this.fail(expression, "Geometry task has no targetTexture output.");
                }
                return {
                    kind: "render-texture",
                    cpp: `bbl::geometry_task_output_texture(${owner.cpp})`,
                    ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}),
                };
            }
            const geometryProperties: Record<string, GeometryTextureTypeName> = {
                geometryIrradianceTexture: "IRRADIANCE",
                geometryWorldPositionTexture: "WORLD_POSITION",
                geometryLocalPositionTexture: "LOCAL_POSITION",
                geometryReflectivityTexture: "REFLECTIVITY",
                geometryViewDepthTexture: "VIEW_DEPTH",
                geometryNormalizedViewDepthTexture: "NORMALIZED_VIEW_DEPTH",
                geometryScreenspaceDepthTexture: "SCREENSPACE_DEPTH",
                geometryViewNormalTexture: "VIEW_NORMAL",
                geometryWorldNormalTexture: "WORLD_NORMAL",
                geometryAlbedoTexture: "ALBEDO",
                geometryLinearVelocityTexture: "LINEAR_VELOCITY",
            };
            const type = geometryProperties[property];
            if (type) {
                if (!owner.geometryTask.attachments.includes(type)) {
                    this.fail(
                        expression,
                        `Geometry task did not request ${type}.`,
                    );
                }
                return {
                    kind: "render-texture",
                    cpp: `bbl::geometry_task_texture(${owner.cpp}, bbl::GeometryTextureType::${this.geometryEnumMember(type)})`,
                    ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}),
                };
            }
        }
        this.fail(
            expression,
            `Unsupported property value '${expression.getText(this.sourceFile)}'.`,
        );
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

            case "createRenderTarget": {
                this.expectArgumentCount(call, 1, 1);
                const engine = this.requireDefaultEngine(call);
                const options = this.compileRenderTargetOptions(call.arguments[0]!);
                this.features.add("renderer:pbr");
                this.features.add("renderer:geometry-output");
                return {
                    kind: "render-target",
                    cpp: `bbl::create_render_target(${engine}, ${options})`,
                    engineCpp: engine,
                };
            }

            case "createRenderTargetTexture": {
                this.expectArgumentCount(call, 2, 2);
                const engine = this.compileValue(call.arguments[0]!);
                this.expectKind(engine, "engine", call.arguments[0]!);
                const options = this.compileRenderTargetOptions(
                    call.arguments[1]!,
                );
                this.features.add("renderer:pbr");
                this.features.add("renderer:geometry-output");
                return {
                    kind: "render-target-texture",
                    cpp: `bbl::create_render_target_texture(${engine.cpp}, ${options})`,
                    engineCpp: engine.cpp,
                };
            }

            case "createRenderTask": {
                this.expectArgumentCount(call, 3, 3);
                const engine = this.compileValue(call.arguments[1]!);
                const scene = this.compileValue(call.arguments[2]!);
                this.expectKind(engine, "engine", call.arguments[1]!);
                this.expectKind(scene, "scene", call.arguments[2]!);
                this.expectSameEngine(engine, scene, call);
                const options = this.compileRenderTaskOptions(call.arguments[0]!);
                this.features.add("renderer:pbr");
                this.features.add("renderer:geometry-output");
                return {
                    kind: "task",
                    cpp: `bbl::create_render_task(${engine.cpp}, ${scene.cpp}, ${options})`,
                    engineCpp: engine.cpp,
                };
            }

            case "createGeometryRendererTask": {
                this.expectArgumentCount(call, 3, 3);
                const engine = this.compileValue(call.arguments[1]!);
                const scene = this.compileValue(call.arguments[2]!);
                this.expectKind(engine, "engine", call.arguments[1]!);
                this.expectKind(scene, "scene", call.arguments[2]!);
                this.expectSameEngine(engine, scene, call);
                const compiled = this.compileGeometryTaskOptions(call.arguments[0]!);
                this.geometryOutputTasks.push(compiled.manifest);
                this.features.add("renderer:pbr");
                this.features.add("renderer:geometry-output");
                return {
                    kind: "task",
                    cpp: `bbl::create_geometry_renderer_task(${engine.cpp}, ${scene.cpp}, ${compiled.cpp})`,
                    engineCpp: engine.cpp,
                    geometryTask: compiled.manifest,
                };
            }

            case "createCopyToTextureTask": {
                this.expectArgumentCount(call, 3, 3);
                const engine = this.compileValue(call.arguments[1]!);
                const scene = this.compileValue(call.arguments[2]!);
                this.expectKind(engine, "engine", call.arguments[1]!);
                this.expectKind(scene, "scene", call.arguments[2]!);
                this.expectSameEngine(engine, scene, call);
                const options = this.compileCopyTaskOptions(call.arguments[0]!);
                this.features.add("renderer:pbr");
                this.features.add("renderer:geometry-output");
                return {
                    kind: "task",
                    cpp: `bbl::create_copy_to_texture_task(${engine.cpp}, ${scene.cpp}, ${options})`,
                    engineCpp: engine.cpp,
                };
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

            case "createPlane": {
                this.expectArgumentCount(call, 1, 2);
                const engine = this.compileValue(call.arguments[0]!);
                this.expectKind(engine, "engine", call.arguments[0]!);
                const options = call.arguments[1]
                    ? this.compilePlaneOptions(call.arguments[1])
                    : ["1.0f", "1.0f"];
                this.features.add("mesh:plane");
                return {
                    kind: "mesh",
                    cpp: `bbl::create_plane(${engine.cpp}, bbl::PlaneOptions{${options[0]}, ${options[1]}})`,
                    engineCpp: engine.cpp,
                };
            }

            case "createSphere": {
                this.expectArgumentCount(call, 1, 2);
                const engine = this.compileValue(call.arguments[0]!);
                this.expectKind(engine, "engine", call.arguments[0]!);
                const options = call.arguments[1]
                    ? this.compileSphereOptions(call.arguments[1])
                    : ["32u", "1.0f"];
                this.features.add("mesh:sphere");
                return {
                    kind: "mesh",
                    cpp: `bbl::create_sphere(${engine.cpp}, bbl::SphereOptions{${options[0]}, ${options[1]}})`,
                    engineCpp: engine.cpp,
                };
            }

            case "createTorus": {
                this.expectArgumentCount(call, 1, 2);
                const engine = this.compileValue(call.arguments[0]!);
                this.expectKind(engine, "engine", call.arguments[0]!);
                const options = call.arguments[1]
                    ? this.compileTorusOptions(call.arguments[1])
                    : ["1.0f", "0.5f", "16u"];
                this.features.add("mesh:torus");
                return {
                    kind: "mesh",
                    cpp: `bbl::create_torus(${engine.cpp}, bbl::TorusOptions{${options[0]}, ${options[1]}, ${options[2]}})`,
                    engineCpp: engine.cpp,
                };
            }

            case "createSolidTexture2D": {
                this.expectArgumentCount(call, 4, 5);
                const engine = this.compileValue(call.arguments[0]!);
                this.expectKind(engine, "engine", call.arguments[0]!);
                const channels = call.arguments.slice(1).map((argument) => this.compileNumber(argument));
                if (channels.length === 3) channels.push("1.0f");
                this.features.add("material:pbr");
                return {
                    kind: "texture",
                    cpp: `bbl::create_solid_texture(${engine.cpp}, ${channels.join(", ")})`,
                    engineCpp: engine.cpp,
                };
            }

            case "createPbrMaterial": {
                this.expectArgumentCount(call, 1, 1);
                const engine = this.requireDefaultEngine(call);
                const [
                    baseColor,
                    orm,
                    metallic,
                    roughness,
                    direct,
                    environment,
                    alpha,
                    reflectance,
                    unlit,
                    doubleSided,
                    skyboxMode,
                    transmission,
                    ior,
                    thickness,
                    attenuationColor,
                    attenuationDistance,
                ] =
                    this.compilePbrMaterialOptions(call.arguments[0]!);
                this.expectSameEngine(baseColor, orm, call);
                this.features.add("material:pbr");
                this.features.add("renderer:pbr");
                if (
                    skyboxMode !== "false" ||
                    transmission !== "0.0f" ||
                    thickness !== "0.0f" ||
                    attenuationColor !== "bbl::Color3{1.0f, 1.0f, 1.0f}" ||
                    attenuationDistance !== "1.0f"
                ) {
                    this.features.add("renderer:transmission");
                }
                return {
                    kind: "material",
                    cpp: `bbl::create_pbr_material(${engine}, bbl::PbrMaterialOptions{${baseColor.cpp}, ${orm.cpp}, ${metallic}, ${roughness}, ${direct}, ${environment}, ${alpha}, ${reflectance}, ${unlit}, ${doubleSided}, ${skyboxMode}, ${transmission}, ${ior}, ${thickness}, ${attenuationColor}, ${attenuationDistance}})`,
                    engineCpp: engine,
                };
            }

            case "enableSceneTransmission": {
                this.expectArgumentCount(call, 2, 2);
                const scene = this.compileValue(call.arguments[0]!);
                const engine = this.compileValue(call.arguments[1]!);
                this.expectKind(scene, "scene", call.arguments[0]!);
                this.expectKind(engine, "engine", call.arguments[1]!);
                this.expectSameEngine(scene, engine, call);
                this.features.add("renderer:pbr");
                this.features.add("renderer:transmission");
                return {
                    kind: "void",
                    cpp: `bbl::enable_scene_transmission(${scene.cpp})`,
                };
            }

            case "createGridMaterial": {
                this.expectArgumentCount(call, 0, 1);
                const engine = this.requireDefaultEngine(call);
                const options = call.arguments[0]
                    ? this.compileGridMaterialOptions(call.arguments[0])
                    : [
                          "bbl::Color3{0.0f, 0.0f, 0.0f}",
                          "bbl::Color3{0.0f, 0.5f, 0.5f}",
                          "1.0f",
                          "bbl::Vec3{}",
                          "10.0f",
                          "0.33f",
                          "1.0f",
                          "1.0f",
                          "true",
                          "false",
                          "false",
                          "true",
                      ];
                this.features.add("material:grid");
                this.features.add("renderer:pbr");
                return {
                    kind: "material",
                    cpp: `bbl::create_grid_material(${engine}, bbl::GridMaterialOptions{${options.join(", ")}})`,
                    engineCpp: engine,
                };
            }

            case "createStandardNoColorMaterialView":
            case "createPbrNoColorMaterialView": {
                this.expectArgumentCount(call, 1, 1);
                const source = this.compileValue(call.arguments[0]!);
                this.expectKind(source, "material", call.arguments[0]!);
                this.features.add("material:no-color-view");
                this.features.add("renderer:pbr");
                return {
                    kind: "material",
                    cpp:
                        importedName === "createStandardNoColorMaterialView"
                            ? `bbl::create_standard_no_color_material_view(${this.requireEngine(source, call)}, ${source.cpp})`
                            : `bbl::create_pbr_no_color_material_view(${this.requireEngine(source, call)}, ${source.cpp})`,
                    engineCpp: this.requireEngine(source, call),
                };
            }

            case "markMaterialUboDirty": {
                this.expectArgumentCount(call, 1, 1);
                const material = this.compileValue(call.arguments[0]!);
                this.expectKind(material, "material", call.arguments[0]!);
                return {
                    kind: "void",
                    cpp: `bbl::mark_material_ubo_dirty(${this.requireEngine(material, call)}, ${material.cpp})`,
                };
            }

            case "createShaderMaterial": {
                this.expectArgumentCount(call, 1, 1);
                const engine = this.requireDefaultEngine(call);
                const variant = this.compileShaderMaterialOptions(
                    call.arguments[0]!,
                );
                this.shaderVariants.add(variant);
                this.features.add("material:shader");
                this.features.add("renderer:pbr");
                return {
                    kind: "material",
                    cpp: `bbl::create_shader_material(${engine}, bbl::ShaderMaterialVariant::${variant.replaceAll("-", "_")})`,
                    engineCpp: engine,
                    shaderVariant: variant,
                };
            }

            case "setShaderUniform": {
                this.expectArgumentCount(call, 3, 3);
                const material = this.compileValue(call.arguments[0]!);
                this.expectKind(material, "material", call.arguments[0]!);
                this.expectShaderVariant(material, "alpha-card", call.arguments[0]!);
                const name = this.compileStringLiteral(call.arguments[1]!);
                if (name !== "center") {
                    this.fail(call.arguments[1]!, `Unsupported shader vec2 uniform '${name}'.`);
                }
                const value = this.compileVec2(call.arguments[2]!);
                return {
                    kind: "void",
                    cpp: `bbl::set_shader_center(${this.requireEngine(material, call)}, ${material.cpp}, ${value})`,
                };
            }

            case "setShaderFloat": {
                this.expectArgumentCount(call, 3, 3);
                const material = this.compileValue(call.arguments[0]!);
                this.expectKind(material, "material", call.arguments[0]!);
                this.expectShaderVariant(material, "alpha-card", call.arguments[0]!);
                const name = this.compileStringLiteral(call.arguments[1]!);
                if (!["angle", "depth", "opacity"].includes(name)) {
                    this.fail(call.arguments[1]!, `Unsupported shader float uniform '${name}'.`);
                }
                return {
                    kind: "void",
                    cpp: `bbl::set_shader_float(${this.requireEngine(material, call)}, ${material.cpp}, ${this.cppString(name)}, ${this.compileNumber(call.arguments[2]!)})`,
                };
            }

            case "setShaderVector3": {
                this.expectArgumentCount(call, 3, 3);
                const material = this.compileValue(call.arguments[0]!);
                this.expectKind(material, "material", call.arguments[0]!);
                this.expectShaderVariant(material, "alpha-card", call.arguments[0]!);
                const name = this.compileStringLiteral(call.arguments[1]!);
                if (name !== "color") {
                    this.fail(call.arguments[1]!, `Unsupported shader vec3 uniform '${name}'.`);
                }
                return {
                    kind: "void",
                    cpp: `bbl::set_shader_vector3(${this.requireEngine(material, call)}, ${material.cpp}, ${this.cppString(name)}, ${this.compileColor3(call.arguments[2]!)})`,
                };
            }

            case "setAlphaToCoverage": {
                this.expectArgumentCount(call, 2, 2);
                const material = this.compileValue(call.arguments[0]!);
                this.expectKind(material, "material", call.arguments[0]!);
                this.expectShaderVariant(material, "alpha-card", call.arguments[0]!);
                const enabled = this.compileBoolean(call.arguments[1]!);
                return {
                    kind: "void",
                    cpp: `bbl::set_alpha_to_coverage(${this.requireEngine(material, call)}, ${material.cpp}, ${enabled})`,
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

            case "createPointLight": {
                this.expectArgumentCount(call, 1, 2);
                const engine = this.requireDefaultEngine(call);
                const position = this.compileVec3(call.arguments[0]!);
                const intensity = call.arguments[1]
                    ? this.compileNumber(call.arguments[1])
                    : "1.0f";
                this.features.add("light:point");
                return {
                    kind: "light",
                    cpp: `bbl::create_point_light(${engine}, ${position}, ${intensity})`,
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

            case "createFreeCamera": {
                this.expectArgumentCount(call, 2, 2);
                const engine = this.requireDefaultEngine(call);
                this.features.add("camera:free");
                return {
                    kind: "camera",
                    cpp: `bbl::create_free_camera(${engine}, ${this.compileVec3(call.arguments[0]!)}, ${this.compileVec3(call.arguments[1]!)})`,
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
                this.features.add("renderer:pbr");
                return {
                    kind: "asset",
                    cpp: `bbl::load_gltf(${engine.cpp}, bbl::asset_path(${this.cppString(asset.output)}))`,
                    engineCpp: engine.cpp,
                };
            }

            case "loadBabylon": {
                this.expectArgumentCount(call, 2, 3);
                const engine = this.compileValue(call.arguments[0]!);
                this.expectKind(engine, "engine", call.arguments[0]!);
                const source = this.compileStringLiteral(call.arguments[1]!);
                if (call.arguments[2]) this.expectObjectLiteral(call.arguments[2]);
                const asset = this.registerAsset(source, "babylon");
                this.features.add("camera:free");
                this.features.add("loader:babylon");
                this.features.add("material:standard");
                this.features.add("renderer:pbr");
                return {
                    kind: "asset",
                    cpp: `bbl::load_babylon(${engine.cpp}, bbl::asset_path(${this.cppString(asset.output)}))`,
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
                this.features.add("environment:env");
                if (groundAsset) this.features.add("background:ground");
                if (skyboxAsset) this.features.add("background:skybox");
                return {
                    kind: "void",
                    cpp: `bbl::load_environment(${scene.cpp}, bbl::EnvironmentOptions{bbl::asset_path(${this.cppString(environmentAsset.output)}), ${groundAsset ? `bbl::asset_path(${this.cppString(groundAsset.output)})` : this.cppString("")}, ${skyboxAsset ? `bbl::asset_path(${this.cppString(skyboxAsset.output)})` : this.cppString("")}, ${options[2]}, ${brdfAsset ? `bbl::asset_path(${this.cppString(brdfAsset.output)})` : this.cppString("")}})`,
                };
            }

            case "loadHdrEnvironment": {
                this.expectArgumentCount(call, 2, 3);
                const scene = this.compileValue(call.arguments[0]!);
                this.expectKind(scene, "scene", call.arguments[0]!);
                const source = this.compileStringLiteral(call.arguments[1]!);
                const options = call.arguments[2]
                    ? this.compileHdrEnvironmentOptions(call.arguments[2])
                    : {
                          faceSize: 256,
                          useCubemapSkybox: false,
                          skipGround: false,
                          skyboxSize: "0.0f",
                          skyboxPosition: "bbl::Vec3{}",
                      };
                if (!options.skipGround) {
                    this.fail(
                        call.arguments[2] ?? call,
                        "Reached HDR environment lowering currently requires skipGround: true.",
                    );
                }
                const environmentAsset = this.registerAsset(
                    source,
                    "hdr-environment",
                    options.faceSize,
                );
                const brdfAsset = this.registerAsset(
                    this.resolveBundledAsset("/brdf-lut.png"),
                    "texture",
                );
                this.features.add("environment:ibl");
                this.features.add("environment:hdr");
                if (options.useCubemapSkybox) {
                    this.features.add("background:skybox");
                }
                return {
                    kind: "void",
                    cpp: `bbl::load_hdr_environment(${scene.cpp}, bbl::HdrEnvironmentOptions{bbl::asset_path(${this.cppString(environmentAsset.output)}), bbl::asset_path(${this.cppString(brdfAsset.output)}), ${options.useCubemapSkybox ? "true" : "false"}, ${options.skyboxSize}, ${options.skyboxPosition}})`,
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

            case "onBeforeRender": {
                this.expectArgumentCount(call, 2, 2);
                const scene = this.compileValue(call.arguments[0]!);
                this.expectKind(scene, "scene", call.arguments[0]!);
                return {
                    kind: "void",
                    cpp: `bbl::on_before_render(${scene.cpp}, ${this.compileFrameCallback(call.arguments[1]!)})`,
                };
            }

            case "addTask":
            case "addTaskAtStart": {
                this.expectArgumentCount(call, 2, 2);
                const scene = this.compileValue(call.arguments[0]!);
                const task = this.compileValue(call.arguments[1]!);
                this.expectKind(scene, "scene", call.arguments[0]!);
                this.expectKind(task, "task", call.arguments[1]!);
                this.expectSameEngine(scene, task, call);
                return {
                    kind: "void",
                    cpp:
                        importedName === "addTaskAtStart"
                            ? `bbl::add_task_at_start(${scene.cpp}, ${task.cpp})`
                            : `bbl::add_task(${scene.cpp}, ${task.cpp})`,
                };
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

            case "attachFreeControl": {
                this.expectArgumentCount(call, 2, 3);
                const camera = this.compileValue(call.arguments[0]!);
                const sceneArgument = call.arguments.length === 3 ? call.arguments[2]! : call.arguments[1]!;
                const scene = this.compileValue(sceneArgument);
                this.expectKind(camera, "camera", call.arguments[0]!);
                this.expectKind(scene, "scene", sceneArgument);
                this.expectSameEngine(camera, scene, call);
                this.features.add("camera:free");
                return {
                    kind: "void",
                    cpp: `bbl::attach_free_control(${this.requireEngine(camera, call)}, ${camera.cpp}, ${scene.cpp})`,
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

    private compileRenderTargetOptions(expression: ts.Expression): string {
        const object = this.expectObjectLiteral(expression);
        const samples = this.objectProperty(object, "samples");
        const colorFormat = this.objectProperty(object, "format");
        const depthFormat = this.objectProperty(object, "dFormat");
        const size = this.objectProperty(object, "size");
        let width = "0u";
        let height = "0u";
        if (size) {
            const unwrappedSize = this.unwrap(size);
            if (ts.isObjectLiteralExpression(unwrappedSize)) {
                const widthExpression = this.objectProperty(
                    unwrappedSize,
                    "width",
                );
                const heightExpression = this.objectProperty(
                    unwrappedSize,
                    "height",
                );
                if (!widthExpression || !heightExpression) {
                    this.fail(
                        unwrappedSize,
                        "Fixed render target size requires width and height.",
                    );
                }
                width = this.compilePositiveInteger(widthExpression);
                height = this.compilePositiveInteger(heightExpression);
            } else {
                const surface = this.compileValue(unwrappedSize);
                this.expectKind(surface, "engine", unwrappedSize);
            }
        }
        return `bbl::RenderTargetOptions{${samples ? this.compilePositiveInteger(samples) : "1u"}, ${colorFormat ? "true" : "false"}, ${depthFormat ? "true" : "false"}, false, ${width}, ${height}}`;
    }

    private compileRenderTaskOptions(expression: ts.Expression): string {
        const object = this.expectObjectLiteral(expression);
        const nameExpression = this.objectProperty(object, "name");
        const targetExpression = this.objectProperty(object, "rt");
        if (!targetExpression) {
            this.fail(object, "Render task requires an rt render target.");
        }
        const target = this.compileValue(targetExpression);
        this.expectKind(target, "render-target", targetExpression);
        const clearColor = this.objectProperty(object, "clrColor");
        const clear = this.objectProperty(object, "clr");
        const cameraExpression = this.objectProperty(object, "cam");
        const camera = cameraExpression
            ? this.compileValue(cameraExpression)
            : undefined;
        if (camera && cameraExpression) {
            this.expectKind(camera, "camera", cameraExpression);
            this.expectSameEngine(target, camera, object);
        }
        const canvasSize = this.objectProperty(object, "cs");
        const autoMirror = this.objectProperty(object, "autoMirror");
        return `bbl::RenderTaskOptions{${this.cppString(
            nameExpression ? this.compileStringLiteral(nameExpression) : "render-task",
        )}, ${target.cpp}, ${clearColor ? this.compileColor4(clearColor) : "bbl::Color4{}"}, ${clear ? this.compileBoolean(clear) : "true"}, ${camera?.cpp ?? "bbl::CameraHandle{}"}, ${camera ? "true" : "false"}, ${canvasSize ? this.compileBoolean(canvasSize) : "false"}, ${autoMirror ? this.compileBoolean(autoMirror) : "true"}}`;
    }

    private compileGeometryTaskOptions(expression: ts.Expression): {
        cpp: string;
        manifest: GeometryOutputTaskManifest;
    } {
        const object = this.expectObjectLiteral(expression);
        const nameExpression = this.objectProperty(object, "name");
        const samplesExpression = this.objectProperty(object, "samples");
        const descriptionsExpression = this.objectProperty(
            object,
            "textureDescriptions",
        );
        if (!descriptionsExpression) {
            this.fail(object, "Geometry renderer task requires textureDescriptions.");
        }
        const descriptions = this.unwrap(descriptionsExpression);
        if (!ts.isArrayLiteralExpression(descriptions)) {
            this.fail(descriptions, "Geometry textureDescriptions must be an array literal.");
        }
        if (
            descriptions.elements.length === 0 ||
            descriptions.elements.length > 8
        ) {
            this.fail(
                descriptions,
                "Geometry textureDescriptions must contain 1-8 entries.",
            );
        }
        const attachments: GeometryTextureTypeName[] = [];
        const compiledDescriptions = descriptions.elements.map((element) => {
            const description = this.expectObjectLiteral(element);
            const typeExpression = this.objectProperty(description, "type");
            if (!typeExpression) {
                this.fail(description, "Geometry texture description requires type.");
            }
            const type = this.compileGeometryTextureType(typeExpression);
            if (attachments.includes(type)) {
                this.fail(typeExpression, `Duplicate geometry texture type ${type}.`);
            }
            attachments.push(type);
            const formatExpression = this.objectProperty(description, "format");
            const format = formatExpression
                ? this.compileStringLiteral(formatExpression)
                : "";
            if (format && format !== "r16float") {
                this.fail(
                    formatExpression!,
                    `Unsupported geometry texture format override '${format}'.`,
                );
            }
            return `bbl::GeometryTextureDescription{bbl::GeometryTextureType::${this.geometryEnumMember(type)}, ${format === "r16float" ? "bbl::GeometryTextureFormat::r16_float" : "bbl::GeometryTextureFormat::automatic"}}`;
        });
        const targetExpression = this.objectProperty(object, "targetTexture");
        const target = targetExpression
            ? this.compileValue(targetExpression)
            : undefined;
        if (target && targetExpression) {
            this.expectKind(target, "render-target", targetExpression);
        }
        const clearColorExpression = this.objectProperty(
            object,
            "targetTextureClearColor",
        );
        if (clearColorExpression && !target) {
            this.fail(
                clearColorExpression,
                "targetTextureClearColor requires targetTexture.",
            );
        }
        const manifest: GeometryOutputTaskManifest = {
            shaderIndex: this.geometryOutputTasks.length,
            attachments,
            emitColor: target !== undefined,
        };
        return {
            cpp: `bbl::GeometryTaskOptions{${this.cppString(
                nameExpression
                    ? this.compileStringLiteral(nameExpression)
                    : `geometry-${manifest.shaderIndex}`,
            )}, ${manifest.shaderIndex}u, ${samplesExpression ? this.compilePositiveInteger(samplesExpression) : "1u"}, {${compiledDescriptions.join(", ")}}, ${target?.cpp ?? "bbl::RenderTargetHandle{}"}, ${clearColorExpression ? "true" : "false"}, ${clearColorExpression ? this.compileColor4(clearColorExpression) : "bbl::Color4{}"}}`,
            manifest,
        };
    }

    private compileCopyTaskOptions(expression: ts.Expression): string {
        const object = this.expectObjectLiteral(expression);
        const nameExpression = this.objectProperty(object, "name");
        const sourceExpression = this.objectProperty(object, "sourceTexture");
        if (!sourceExpression) {
            this.fail(object, "Copy task requires sourceTexture.");
        }
        const source = this.compileValue(sourceExpression);
        const sourceCpp =
            source.kind === "render-target"
                ? `bbl::render_target_texture(${source.cpp})`
                : source.kind === "render-texture"
                    ? source.cpp
                    : this.fail(
                          sourceExpression,
                          `Copy source must be a render texture, received ${source.kind}.`,
                      );
        const targetExpression = this.objectProperty(object, "targetTexture");
        const resolveExpression = this.objectProperty(object, "resolveTexture");
        const target = targetExpression
            ? this.compileValue(targetExpression)
            : undefined;
        const resolveTarget = resolveExpression
            ? this.compileValue(resolveExpression)
            : undefined;
        if (!target && !resolveTarget) {
            this.fail(object, "Copy task requires targetTexture or resolveTexture.");
        }
        if (target && targetExpression) {
            this.expectKind(target, "render-target", targetExpression);
        }
        if (resolveTarget && resolveExpression) {
            this.expectKind(resolveTarget, "render-target", resolveExpression);
        }
        const viewportExpression = this.objectProperty(object, "viewport");
        let viewport = "bbl::NormalizedViewport{}";
        if (viewportExpression) {
            const viewportObject = this.expectObjectLiteral(viewportExpression);
            viewport = `bbl::NormalizedViewport{${this.requiredObjectNumber(viewportObject, "x")}, ${this.requiredObjectNumber(viewportObject, "y")}, ${this.requiredObjectNumber(viewportObject, "width")}, ${this.requiredObjectNumber(viewportObject, "height")}}`;
        }
        return `bbl::CopyTaskOptions{${this.cppString(
            nameExpression ? this.compileStringLiteral(nameExpression) : "copy-task",
        )}, ${sourceCpp}, ${target?.cpp ?? "bbl::RenderTargetHandle{}"}, ${resolveTarget?.cpp ?? "bbl::RenderTargetHandle{}"}, ${viewportExpression ? "true" : "false"}, ${viewport}}`;
    }

    private compileGeometryTextureType(
        expression: ts.Expression,
    ): GeometryTextureTypeName {
        const unwrapped = this.unwrap(expression);
        if (
            !ts.isPropertyAccessExpression(unwrapped) ||
            !ts.isIdentifier(unwrapped.expression) ||
            this.imports.get(unwrapped.expression.text) !== "GeometryTextureType"
        ) {
            this.fail(
                unwrapped,
                "Expected a GeometryTextureType enum member.",
            );
        }
        const type = unwrapped.name.text as GeometryTextureTypeName;
        const supported = new Set<GeometryTextureTypeName>([
            "IRRADIANCE",
            "WORLD_POSITION",
            "LOCAL_POSITION",
            "REFLECTIVITY",
            "VIEW_DEPTH",
            "NORMALIZED_VIEW_DEPTH",
            "SCREENSPACE_DEPTH",
            "VIEW_NORMAL",
            "WORLD_NORMAL",
            "ALBEDO",
            "LINEAR_VELOCITY",
        ]);
        if (!supported.has(type)) {
            this.fail(unwrapped.name, `Unsupported geometry texture type '${type}'.`);
        }
        return type;
    }

    private geometryEnumMember(type: GeometryTextureTypeName): string {
        return type.toLowerCase();
    }

    private compileGroundOptions(expression: ts.Expression): [string, string] {
        const object = this.expectObjectLiteral(expression);
        const width = this.objectProperty(object, "width");
        const height = this.objectProperty(object, "height");
        return [width ? this.compileNumber(width) : "1.0f", height ? this.compileNumber(height) : "1.0f"];
    }

    private compilePlaneOptions(expression: ts.Expression): [string, string] {
        const object = this.expectObjectLiteral(expression);
        for (const property of object.properties) {
            const name =
                ts.isPropertyAssignment(property) ||
                ts.isShorthandPropertyAssignment(property)
                    ? this.propertyName(property.name)
                    : undefined;
            if (!name || !["size", "width", "height"].includes(name)) {
                this.fail(
                    property,
                    "Plane options support only size, width, and height.",
                );
            }
        }
        const size = this.objectProperty(object, "size");
        const width = this.objectProperty(object, "width");
        const height = this.objectProperty(object, "height");
        const compiledSize = size ? this.compileNumber(size) : "1.0f";
        return [
            width ? this.compileNumber(width) : compiledSize,
            height ? this.compileNumber(height) : compiledSize,
        ];
    }

    private compileSphereOptions(expression: ts.Expression): [string, string] {
        const object = this.expectObjectLiteral(expression);
        const segments = this.objectProperty(object, "segments");
        const diameter = this.objectProperty(object, "diameter");
        return [
            segments ? this.compilePositiveInteger(segments) : "32u",
            diameter ? this.compileNumber(diameter) : "1.0f",
        ];
    }

    private compileTorusOptions(
        expression: ts.Expression,
    ): [string, string, string] {
        const object = this.expectObjectLiteral(expression);
        for (const property of object.properties) {
            const name =
                ts.isPropertyAssignment(property) ||
                ts.isShorthandPropertyAssignment(property)
                    ? this.propertyName(property.name)
                    : undefined;
            if (
                !name ||
                !["diameter", "thickness", "tessellation"].includes(name)
            ) {
                this.fail(
                    property,
                    "Torus options support diameter, thickness, and tessellation.",
                );
            }
        }
        const diameter = this.objectProperty(object, "diameter");
        const thickness = this.objectProperty(object, "thickness");
        const tessellation = this.objectProperty(object, "tessellation");
        return [
            diameter ? this.compileNumber(diameter) : "1.0f",
            thickness ? this.compileNumber(thickness) : "0.5f",
            tessellation
                ? this.compilePositiveInteger(tessellation)
                : "16u",
        ];
    }

    private compilePbrMaterialOptions(
        expression: ts.Expression,
    ): [
        Value,
        Value,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
    ] {
        const object = this.expectObjectLiteral(expression);
        const supported = new Set([
            "baseColorTexture",
            "ormTexture",
            "metallicFactor",
            "roughnessFactor",
            "directIntensity",
            "environmentIntensity",
            "alpha",
            "reflectance",
            "unlit",
            "doubleSided",
            "skyboxMode",
            "transmissive",
            "subsurface",
        ]);
        for (const property of object.properties) {
            const name =
                ts.isPropertyAssignment(property) ||
                ts.isShorthandPropertyAssignment(property)
                    ? this.propertyName(property.name)
                    : undefined;
            if (
                !name ||
                !supported.has(name)
            ) {
                this.fail(
                    property,
                    "Reached PBR lowering supports base/ORM textures, metallic/roughness factors, alpha, reflectance, lighting intensities, skybox mode, and transmission subsurface fields.",
                );
            }
        }
        const baseColorExpression = this.objectProperty(object, "baseColorTexture");
        const ormExpression = this.objectProperty(object, "ormTexture");
        if (!baseColorExpression || !ormExpression) {
            this.fail(object, "PBR material requires baseColorTexture and ormTexture.");
        }
        const baseColor = this.compileValue(baseColorExpression);
        const orm = this.compileValue(ormExpression);
        this.expectKind(baseColor, "texture", baseColorExpression);
        this.expectKind(orm, "texture", ormExpression);
        const metallic = this.objectProperty(object, "metallicFactor");
        const roughness = this.objectProperty(object, "roughnessFactor");
        const direct = this.objectProperty(object, "directIntensity");
        const environment = this.objectProperty(
            object,
            "environmentIntensity",
        );
        const alpha = this.objectProperty(object, "alpha");
        const reflectance = this.objectProperty(object, "reflectance");
        const unlit = this.objectProperty(object, "unlit");
        const doubleSided = this.objectProperty(object, "doubleSided");
        const skyboxMode = this.objectProperty(object, "skyboxMode");
        const transmissive = this.objectProperty(object, "transmissive");
        const subsurfaceExpression = this.objectProperty(object, "subsurface");
        let transmission = "0.0f";
        let ior = "1.5f";
        let thickness = "0.0f";
        let attenuationColor = "bbl::Color3{1.0f, 1.0f, 1.0f}";
        let attenuationDistance = "1.0f";
        if (subsurfaceExpression) {
            const subsurface = this.expectObjectLiteral(subsurfaceExpression);
            const refractionExpression = this.objectProperty(
                subsurface,
                "refraction",
            );
            if (refractionExpression) {
                const refraction = this.expectObjectLiteral(refractionExpression);
                const intensity = this.objectProperty(refraction, "intensity");
                const indexOfRefraction = this.objectProperty(
                    refraction,
                    "indexOfRefraction",
                );
                transmission = intensity
                    ? this.compileNumber(intensity)
                    : transmissive
                        ? "1.0f"
                        : "0.0f";
                ior = indexOfRefraction
                    ? this.compileNumber(indexOfRefraction)
                    : "1.5f";
            }
            const thicknessExpression = this.objectProperty(
                subsurface,
                "thickness",
            );
            if (thicknessExpression) {
                const thicknessObject =
                    this.expectObjectLiteral(thicknessExpression);
                const maximum = this.objectProperty(thicknessObject, "max");
                thickness = maximum ? this.compileNumber(maximum) : "1.0f";
            }
            const tintExpression = this.objectProperty(subsurface, "tint");
            if (tintExpression) {
                const tint = this.expectObjectLiteral(tintExpression);
                const color = this.objectProperty(tint, "color");
                const distance = this.objectProperty(tint, "atDistance");
                attenuationColor = color
                    ? this.compileColor3(color)
                    : attenuationColor;
                attenuationDistance = distance
                    ? this.compileNumber(distance)
                    : attenuationDistance;
            }
        }
        return [
            baseColor,
            orm,
            metallic ? this.compileNumber(metallic) : "1.0f",
            roughness ? this.compileNumber(roughness) : "1.0f",
            direct ? this.compileNumber(direct) : "1.0f",
            environment ? this.compileNumber(environment) : "1.0f",
            alpha ? this.compileNumber(alpha) : "1.0f",
            reflectance ? this.compileNumber(reflectance) : "0.04f",
            unlit ? this.compileBoolean(unlit) : "false",
            doubleSided ? this.compileBoolean(doubleSided) : "false",
            skyboxMode ? this.compileBoolean(skyboxMode) : "false",
            transmission,
            ior,
            thickness,
            attenuationColor,
            attenuationDistance,
        ];
    }

    private compileGridMaterialOptions(expression: ts.Expression): string[] {
        const object = this.expectObjectLiteral(expression);
        const supported = new Set([
            "name",
            "mainColor",
            "lineColor",
            "gridRatio",
            "gridOffset",
            "majorUnitFrequency",
            "minorUnitVisibility",
            "opacity",
            "antialias",
            "preMultiplyAlpha",
            "useMaxLine",
            "visibility",
            "backFaceCulling",
        ]);
        for (const property of object.properties) {
            const name =
                ts.isPropertyAssignment(property) ||
                ts.isShorthandPropertyAssignment(property)
                    ? this.propertyName(property.name)
                    : undefined;
            if (!name || !supported.has(name)) {
                this.fail(
                    property,
                    "Grid material options support colors, object-space spacing/offset, line frequency/visibility, opacity, antialiasing, premultiplication, max-line composition, visibility, and culling.",
                );
            }
        }
        const mainColor = this.objectProperty(object, "mainColor");
        const lineColor = this.objectProperty(object, "lineColor");
        const gridRatio = this.objectProperty(object, "gridRatio");
        const gridOffset = this.objectProperty(object, "gridOffset");
        const majorUnitFrequency = this.objectProperty(
            object,
            "majorUnitFrequency",
        );
        const minorUnitVisibility = this.objectProperty(
            object,
            "minorUnitVisibility",
        );
        const opacity = this.objectProperty(object, "opacity");
        const visibility = this.objectProperty(object, "visibility");
        const antialias = this.objectProperty(object, "antialias");
        const preMultiplyAlpha = this.objectProperty(
            object,
            "preMultiplyAlpha",
        );
        const useMaxLine = this.objectProperty(object, "useMaxLine");
        const backFaceCulling = this.objectProperty(
            object,
            "backFaceCulling",
        );
        return [
            mainColor
                ? this.compileColor3(mainColor)
                : "bbl::Color3{0.0f, 0.0f, 0.0f}",
            lineColor
                ? this.compileColor3(lineColor)
                : "bbl::Color3{0.0f, 0.5f, 0.5f}",
            gridRatio ? this.compileNumber(gridRatio) : "1.0f",
            gridOffset ? this.compileVec3(gridOffset) : "bbl::Vec3{}",
            majorUnitFrequency
                ? this.compileNumber(majorUnitFrequency)
                : "10.0f",
            minorUnitVisibility
                ? this.compileNumber(minorUnitVisibility)
                : "0.33f",
            opacity ? this.compileNumber(opacity) : "1.0f",
            visibility ? this.compileNumber(visibility) : "1.0f",
            antialias ? this.compileBoolean(antialias) : "true",
            preMultiplyAlpha
                ? this.compileBoolean(preMultiplyAlpha)
                : "false",
            useMaxLine ? this.compileBoolean(useMaxLine) : "false",
            backFaceCulling
                ? this.compileBoolean(backFaceCulling)
                : "true",
        ];
    }

    private compileShaderMaterialOptions(
        expression: ts.Expression,
    ): ShaderMaterialVariantName {
        const object = this.expectObjectLiteral(expression);
        const supportedProperties = new Set([
            "name",
            "vertexSource",
            "fragmentSource",
            "attributes",
            "uniforms",
            "needAlphaBlending",
            "needAlphaTesting",
            "backFaceCulling",
            "depthWrite",
        ]);
        for (const property of object.properties) {
            const name =
                ts.isPropertyAssignment(property) ||
                ts.isShorthandPropertyAssignment(property)
                    ? this.propertyName(property.name)
                    : undefined;
            if (!name || !supportedProperties.has(name)) {
                this.fail(
                    property,
                    "Reached shader materials support source, attributes, uniforms, alpha state, culling, and depthWrite only.",
                );
            }
        }

        const vertexExpression = this.objectProperty(object, "vertexSource");
        const fragmentExpression = this.objectProperty(object, "fragmentSource");
        const attributesExpression = this.objectProperty(object, "attributes");
        const uniformsExpression = this.objectProperty(object, "uniforms");
        if (
            !vertexExpression ||
            !fragmentExpression ||
            !attributesExpression ||
            !uniformsExpression
        ) {
            this.fail(
                object,
                "Shader material requires vertexSource, fragmentSource, attributes, and uniforms.",
            );
        }

        const vertexSource = normalizeShaderSource(
            this.compileStaticString(vertexExpression),
        );
        const fragmentSource = normalizeShaderSource(
            this.compileStaticString(fragmentExpression),
        );
        const attributes = this.compileStaticStringArray(attributesExpression);
        const uniforms = this.compileShaderUniformSignatures(uniformsExpression);
        const needAlphaBlending = this.compileOptionalStaticBoolean(
            this.objectProperty(object, "needAlphaBlending"),
            false,
        );
        const needAlphaTesting = this.compileOptionalStaticBoolean(
            this.objectProperty(object, "needAlphaTesting"),
            false,
        );
        const backFaceCulling = this.compileOptionalStaticBoolean(
            this.objectProperty(object, "backFaceCulling"),
            true,
        );
        const depthWrite = this.compileOptionalStaticBoolean(
            this.objectProperty(object, "depthWrite"),
            !needAlphaBlending,
        );

        for (const program of shaderMaterialPrograms) {
            if (
                vertexSource === normalizeShaderSource(program.vertexSource) &&
                fragmentSource === normalizeShaderSource(program.fragmentSource) &&
                this.stringArraysEqual(attributes, program.attributes) &&
                this.stringArraysEqual(uniforms, program.uniforms) &&
                needAlphaBlending === program.needAlphaBlending &&
                needAlphaTesting === program.needAlphaTesting &&
                backFaceCulling === program.backFaceCulling &&
                depthWrite === program.depthWrite
            ) {
                return program.name;
            }
        }

        this.fail(
            object,
            "Unsupported reached shader material variant. Add a typed shader variant instead of selecting by scene or material name.",
        );
    }

    private compileShaderUniformSignatures(expression: ts.Expression): string[] {
        const array = this.expectStaticArrayLiteral(expression);
        return array.elements.map((element) => {
            const resolved = this.resolveStaticExpression(element);
            if (
                ts.isStringLiteral(resolved) ||
                ts.isNoSubstitutionTemplateLiteral(resolved)
            ) {
                return resolved.text;
            }
            if (!ts.isObjectLiteralExpression(resolved)) {
                this.fail(
                    resolved,
                    "Shader uniforms must be string or typed object literals.",
                );
            }
            const name = this.objectProperty(resolved, "name");
            const type = this.objectProperty(resolved, "type");
            if (!name || !type) {
                this.fail(
                    resolved,
                    "Typed shader uniforms require name and type.",
                );
            }
            return `${this.compileStaticString(name)}:${this.compileStaticString(type)}`;
        });
    }
    private compileStaticStringArray(expression: ts.Expression): string[] {
        return this.expectStaticArrayLiteral(expression).elements.map(
            (element) => this.compileStaticString(element),
        );
    }

    private expectStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression {
        const resolved = this.resolveStaticExpression(expression);
        if (!ts.isArrayLiteralExpression(resolved)) {
            this.fail(resolved, "Expected a static array literal.");
        }
        return resolved;
    }

    private compileOptionalStaticBoolean(
        expression: ts.Expression | undefined,
        fallback: boolean,
    ): boolean {
        if (!expression) return fallback;
        return this.compileBoolean(this.resolveStaticExpression(expression)) ===
            "true";
    }

    private stringArraysEqual(left: string[], right: string[]): boolean {
        return (
            left.length === right.length &&
            left.every((value, index) => value === right[index])
        );
    }

    private compilePositiveInteger(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (!ts.isNumericLiteral(unwrapped)) {
            this.fail(unwrapped, "Expected a positive integer literal.");
        }
        const value = Number(unwrapped.text);
        if (!Number.isInteger(value) || value <= 0) {
            this.fail(unwrapped, "Expected a positive integer literal.");
        }
        return `${value}u`;
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

    private compileHdrEnvironmentOptions(expression: ts.Expression): {
        faceSize: number;
        useCubemapSkybox: boolean;
        skipGround: boolean;
        skyboxSize: string;
        skyboxPosition: string;
    } {
        const object = this.expectObjectLiteral(expression);
        const supported = new Set([
            "faceSize",
            "useCubemapSkybox",
            "skipGround",
            "skyboxSize",
            "skyboxPosition",
        ]);
        for (const property of object.properties) {
            const name =
                ts.isPropertyAssignment(property) ||
                ts.isShorthandPropertyAssignment(property)
                    ? this.propertyName(property.name)
                    : undefined;
            if (!name || !supported.has(name)) {
                this.fail(
                    property,
                    "HDR environment options support faceSize, cubemap skybox, ground skipping, skybox size, and skybox position.",
                );
            }
        }
        const faceSizeExpression = this.objectProperty(object, "faceSize");
        const faceSize = faceSizeExpression
            ? Number(this.compilePositiveInteger(faceSizeExpression).slice(0, -1))
            : 256;
        if ((faceSize & (faceSize - 1)) !== 0 || faceSize > 2048) {
            this.fail(
                faceSizeExpression ?? object,
                "HDR faceSize must be a power of two no larger than 2048.",
            );
        }
        const useCubemapSkybox = this.compileOptionalStaticBoolean(
            this.objectProperty(object, "useCubemapSkybox"),
            false,
        );
        const skipGround = this.compileOptionalStaticBoolean(
            this.objectProperty(object, "skipGround"),
            false,
        );
        const skyboxSize = this.objectProperty(object, "skyboxSize");
        const skyboxPosition = this.objectProperty(object, "skyboxPosition");
        if (useCubemapSkybox && (!skyboxSize || !skyboxPosition)) {
            this.fail(
                object,
                "Reached HDR cubemap skyboxes require explicit skyboxSize and skyboxPosition.",
            );
        }
        return {
            faceSize,
            useCubemapSkybox,
            skipGround,
            skyboxSize: skyboxSize ? this.compileNumber(skyboxSize) : "0.0f",
            skyboxPosition: skyboxPosition
                ? this.compileVec3(skyboxPosition)
                : "bbl::Vec3{}",
        };
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

    private compileVec2(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (ts.isArrayLiteralExpression(unwrapped) && unwrapped.elements.length === 2) {
            return `bbl::Vec2{${unwrapped.elements.map((element) => this.compileNumber(element)).join(", ")}}`;
        }
        this.fail(unwrapped, "Expected a Vec2 array [x, y].");
    }

    private compileBoolean(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) return "true";
        if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) return "false";
        this.fail(unwrapped, "Expected a boolean literal.");
    }

    private compileCondition(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (ts.isPrefixUnaryExpression(unwrapped) && unwrapped.operator === ts.SyntaxKind.ExclamationToken) {
            return `!(${this.compileCondition(unwrapped.operand)})`;
        }
        if (ts.isBinaryExpression(unwrapped)) {
            const operator = new Map<ts.SyntaxKind, string>([
                [ts.SyntaxKind.EqualsEqualsEqualsToken, "=="],
                [ts.SyntaxKind.ExclamationEqualsEqualsToken, "!="],
                [ts.SyntaxKind.LessThanToken, "<"],
                [ts.SyntaxKind.LessThanEqualsToken, "<="],
                [ts.SyntaxKind.GreaterThanToken, ">"],
                [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
                [ts.SyntaxKind.AmpersandAmpersandToken, "&&"],
                [ts.SyntaxKind.BarBarToken, "||"],
            ]).get(unwrapped.operatorToken.kind);
            if (!operator) {
                this.fail(
                    unwrapped.operatorToken,
                    "Reached callback conditions support numeric comparisons and logical operators.",
                );
            }
            if (
                unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
                unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken
            ) {
                return `(${this.compileCondition(unwrapped.left)} ${operator} ${this.compileCondition(unwrapped.right)})`;
            }
            return `(${this.compileNumber(unwrapped.left)} ${operator} ${this.compileNumber(unwrapped.right)})`;
        }
        this.fail(unwrapped, "Expected a reached callback condition.");
    }

    private compileFrameCallback(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (!ts.isArrowFunction(unwrapped) && !ts.isFunctionExpression(unwrapped)) {
            this.fail(unwrapped, "onBeforeRender requires an inline callback.");
        }
        if (!ts.isBlock(unwrapped.body)) {
            this.fail(unwrapped.body, "onBeforeRender callback requires a block body.");
        }
        if (unwrapped.parameters.length > 1) {
            this.fail(unwrapped, "onBeforeRender callback supports at most one deltaMs parameter.");
        }

        const parameter = unwrapped.parameters[0];
        if (parameter && !ts.isIdentifier(parameter.name)) {
            this.fail(parameter.name, "onBeforeRender deltaMs parameter must be an identifier.");
        }
        const parameterName = parameter && ts.isIdentifier(parameter.name)
            ? parameter.name.text
            : undefined;
        const previousParameter = parameterName
            ? this.variables.get(parameterName)
            : undefined;
        if (parameterName && previousParameter) {
            this.fail(parameter!, `Variable shadowing is not supported for '${parameterName}'.`);
        }

        const start = this.body.length;
        const previousIndent = this.indentLevel;
        this.indentLevel = 0;
        if (parameterName) {
            this.variables.set(parameterName, {
                kind: "number",
                cpp: this.cppIdentifier(parameterName),
            });
        }
        for (const statement of unwrapped.body.statements) {
            this.emitStatement(statement);
        }
        const callbackBody = this.body.splice(start);
        this.indentLevel = previousIndent;
        if (parameterName) {
            this.variables.delete(parameterName);
        }
        const cppParameter = parameterName
            ? `float ${this.cppIdentifier(parameterName)}`
            : "float";
        return `[&](${cppParameter}) {\n${callbackBody.map((line) => `            ${line}`).join("\n")}\n        }`;
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
        const unwrapped = this.resolveStaticExpression(expression);
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
        if (
            ts.isCallExpression(unwrapped) &&
            ts.isPropertyAccessExpression(unwrapped.expression) &&
            ts.isIdentifier(unwrapped.expression.expression) &&
            unwrapped.expression.expression.text === "Math" &&
            unwrapped.expression.name.text === "sqrt" &&
            unwrapped.arguments.length === 1
        ) {
            return `std::sqrt(${this.compileNumber(unwrapped.arguments[0]!)})`;
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
                unwrapped.name.text === "PI") ||
            (ts.isCallExpression(unwrapped) &&
                ts.isPropertyAccessExpression(unwrapped.expression) &&
                ts.isIdentifier(unwrapped.expression.expression) &&
                unwrapped.expression.expression.text === "Math" &&
                unwrapped.expression.name.text === "sqrt" &&
                unwrapped.arguments.length === 1)
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
        const unwrapped = this.resolveStaticExpression(expression);
        if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
            return unwrapped.text;
        }
        this.fail(unwrapped, "Expected a string literal.");
    }

    private compileStaticString(expression: ts.Expression): string {
        return this.compileStringLiteral(expression);
    }

    private resolveStaticExpression(
        expression: ts.Expression,
        resolving: ReadonlySet<string> = new Set(),
    ): ts.Expression {
        const unwrapped = this.unwrap(expression);
        if (!ts.isIdentifier(unwrapped)) return unwrapped;
        const initializer = this.staticConstants.get(unwrapped.text);
        if (!initializer) return unwrapped;
        if (resolving.has(unwrapped.text)) {
            this.fail(unwrapped, `Circular static constant '${unwrapped.text}'.`);
        }
        return this.resolveStaticExpression(
            initializer,
            new Set([...resolving, unwrapped.text]),
        );
    }

    private registerAsset(
        source: string,
        kind: CompileAsset["kind"],
        faceSize?: number,
    ): CompileAsset {
        const key = `${kind}:${source}:${faceSize ?? ""}`;
        const existing = this.assets.get(key);
        if (existing) {
            return existing;
        }

        const sourcePath = source.split(/[?#]/, 1)[0] ?? source;
        const sourceName = sourcePath.split(/[\\/]/).pop() || `${kind}.bin`;
        const packagedName =
            kind === "gltf" && /\.gltf$/i.test(sourceName)
                ? sourceName.replace(/\.gltf$/i, ".glb")
                : kind === "hdr-environment"
                    ? sourceName.replace(/\.hdr$/i, ".bblhdr")
                : sourceName;
        const safeName = packagedName.replace(/[^A-Za-z0-9._-]/g, "_");
        const output =
            kind === "babylon"
                ? `${this.hash(source)}-${basenameWithoutExtension(safeName)}/${safeName}`
                : `${this.hash(source)}-${safeName}`;
        const asset: CompileAsset = {
            source,
            output,
            kind,
            ...(faceSize === undefined ? {} : { faceSize }),
        };
        this.assets.set(key, asset);
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
            if (ts.isAwaitExpression(current)) {
                this.unwrappedAwaitExpressions.add(current.pos);
            }
            current = current.expression;
        }
        return current;
    }

    private compileAdaptations(features: Feature[]): CompileAdaptation[] {
        const adaptations: CompileAdaptation[] = [];
        if (this.hasMainEntry) {
            adaptations.push({
                id: "entry-main-wrapper-erasure",
                category: "browser-erasure",
                sourceSemantics: "The TypeScript scene setup is wrapped in a browser-facing main function.",
                nativeSemantics: "The compiler emits the body of main into the native entry point and omits the browser promise wrapper.",
                risk: "low",
                validation: ["compiler entry-order tests", "source-located unsupported syntax errors"],
            });
        }
        const erasedBrowserCount =
            this.erasedBrowserExpressions.size + this.erasedBrowserInstrumentation.size;
        if (erasedBrowserCount > 0) {
            adaptations.push({
                id: "browser-setup-erasure",
                category: "browser-erasure",
                sourceSemantics: `${erasedBrowserCount} DOM, performance, or dataset instrumentation expression(s) execute in the browser.`,
                nativeSemantics: "Those expressions are erased because window creation, timing, and diagnostics are provided by PAL.",
                risk: "medium",
                validation: ["compiler browser-erasure tests", "generated main.cpp inspection"],
            });
        }
        if (this.unwrappedAwaitExpressions.size > 0) {
            adaptations.push({
                id: "synchronous-aot-await",
                category: "async",
                sourceSemantics: `${this.unwrappedAwaitExpressions.size} await expression(s) suspend JavaScript promises.`,
                nativeSemantics: "Reachable asset promises resolve immediately because remote data is materialized during compilation.",
                risk: "medium",
                validation: ["typed Promise<T> runtime", "local asset manifest", "generated glTF loader tests"],
            });
        }
        if (this.assets.size > 0) {
            adaptations.push({
                id: "compile-time-asset-materialization",
                category: "asset-materialization",
                sourceSemantics: `${this.assets.size} asset URL(s) are fetched at runtime by Babylon Lite.`,
                nativeSemantics: "The compiler downloads them into the generated asset directory and generated code performs deterministic local reads.",
                risk: "medium",
                validation: ["asset paths in manifest.json", "typed asset specialization tests"],
            });
        }
        if (features.includes("backend:sdl")) {
            adaptations.push({
                id: "sdl-platform-boundary",
                category: "platform",
                sourceSemantics: "Canvas, pointer, keyboard, timing, and presentation use browser platform APIs.",
                nativeSemantics: "SDL implements the platform boundary and translates input into generated Babylon camera state.",
                risk: "medium",
                validation: ["ArcRotate constant extraction tests", "native input smoke tests"],
            });
        }
        if (features.includes("renderer:pbr")) {
            adaptations.push({
                id: "sdl-gpu-shader-backends",
                category: "rendering",
                sourceSemantics: "Babylon Lite composes WGSL and renders through WebGPU.",
                nativeSemantics: "The compiler emits native-specialized WGSL; pinned Tint produces HLSL/MSL, register normalization and DXC produce SDL-compatible DXIL/SPIR-V, and SDL_GPU selects the native backend.",
                risk: "high",
                validation: ["upstream formula marker tests", "renderer-fidelity.json", "CPU/GPU visual parity"],
            });
        }
        if (features.includes("renderer:transmission")) {
            adaptations.push({
                id: "sdl-gpu-scene-transmission",
                category: "rendering",
                sourceSemantics: "Babylon Lite copies scene color before transmissive draws and applies KHR_materials_transmission, IOR Fresnel, and KHR_materials_volume attenuation.",
                nativeSemantics: "Generated render stages copy opaque scene color into an SDL_GPU sampled texture; Tint WGSL applies dielectric F0 ((ior-1)/(ior+1))^2 and Beer-Lambert exp(log(color)/distance*thickness) attenuation.",
                risk: "high",
                validation: [
                    "independent skybox/transmission/IOR/volume gates",
                    "scene 176 MosquitoInAmber parity",
                    "Tint binding reflection",
                ],
            });
        }
        if (features.includes("environment:hdr")) {
            adaptations.push({
                id: "compile-time-hdr-cubemap",
                category: "asset-materialization",
                sourceSemantics: "Babylon Lite decodes RGBE, converts the equirectangular panorama to RGBA16F cubemap faces, and generates a GGX-prefiltered mip chain on the GPU.",
                nativeSemantics: "The compiler performs the pinned RGBE decode, spherical-harmonics integration, and cubemap projection, preserves mip zero exactly, then uses the pinned 1024-sample GGX WebGPU prefilter to store a deterministic RGBA16F mip chain for native upload.",
                risk: "high",
                validation: [
                    "pinned HDR parser and cubemap marker tests",
                    "generated HDR package validation",
                    "scene 8 native/reference parity",
                ],
            });
        }
        if (features.includes("material:grid")) {
            adaptations.push({
                id: "grid-tint-specialization",
                category: "rendering",
                sourceSemantics: "Babylon Lite composes GridMaterial WGSL variants from antialias, max-line, transparency, premultiplication, and opacity-texture features, with world/view/projection system uniforms.",
                nativeSemantics: "The compiler emits one generated native WGSL program parameterized by the reached GridMaterial controls, uses the native view-projection matrix plus local position/normal attributes, and compiles it through pinned Tint.",
                risk: "medium",
                validation: [
                    "pinned GridMaterial formula marker tests",
                    "Tint binding reflection",
                    "scene 213 native/reference parity",
                ],
            });
        }
        if (this.shaderVariants.size > 0) {
            adaptations.push({
                id: "typed-reached-shader-variants",
                category: "rendering",
                sourceSemantics: `Babylon Lite composes the reached custom WGSL shader variant(s): ${[...this.shaderVariants].join(", ")}.`,
                nativeSemantics: "The compiler validates reached WGSL, attributes, uniforms, and fixed-function state, lowers the supported WGSL subset into typed shader IR, reflects interfaces and uniform layouts, and emits native-specialized WGSL. Pinned Tint emits HLSL/MSL; register normalization and DXC emit SDL-compatible DXIL/SPIR-V.",
                risk: "high",
                validation: [
                    "shader variant compiler tests",
                    "typed WGSL IR and reflection tests",
                    "portable shader compilation",
                    "scene 163/274 native/reference parity",
                ],
            });
        }
        if (features.includes("renderer:geometry-output")) {
            adaptations.push({
                id: "sdl-gpu-frame-graph",
                category: "rendering",
                sourceSemantics: `Babylon Lite frame-graph tasks execute with ${this.geometryOutputTasks.length} typed geometry renderer task(s), explicit render lists, render-target textures, and ordered copy/resolve tasks.`,
                nativeSemantics: "Generated task records preserve cameras, material overrides, geometry attachment order, depth-only targets, and shader semantics while PAL executes SDL_GPU passes, reverse-depth views, MSAA resolve, and viewport blits.",
                risk: "high",
                validation: [
                    "geometry task compiler tests",
                    "pinned geometry shader marker tests",
                    "scene 116/145/146 native/reference parity",
                ],
            });
        }
        if (features.includes("background:ground")) {
            adaptations.push({
                id: "background-ground-opt-in",
                category: "rendering",
                sourceSemantics: "Babylon Lite creates the requested transparent environment ground.",
                nativeSemantics: "The generated ground is available behind BBLITE_GROUND=1 because the committed Babylon.js golden composes it differently.",
                risk: "high",
                validation: ["explicit runtime flag", "separate background render pass", "documented parity reference"],
            });
        }
        if (
            features.includes("background:skybox") ||
            features.includes("background:ground")
        ) {
            adaptations.push({
                id: "background-dither-disabled",
                category: "rendering",
                sourceSemantics: "Babylon Lite adds position-seeded ±0.5/255 dither to generated background fragments.",
                nativeSemantics: "Native backgrounds omit the dither because backend interpolation differences decorrelate the position-seeded noise; the exact formula increases BoomBox full MAD from 0.311 to 0.399.",
                risk: "medium",
                validation: [
                    "pinned dither formula experiment",
                    "BoomBox background attribution",
                    "documented no-dither regression floor",
                ],
            });
        }
        return adaptations;
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

    private expectShaderVariant(
        value: Value,
        variant: ShaderMaterialVariantName,
        node: ts.Node,
    ): void {
        if (value.shaderVariant !== variant) {
            this.fail(
                node,
                `Shader operation requires the '${variant}' reached variant.`,
            );
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
        this.body.push(`${"    ".repeat(this.indentLevel)}${line}`);
    }

    private renderCpp(): string {
        return `// Generated by bblitec. Do not edit.
#include <bblite/runtime.hpp>

#include <cmath>
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
