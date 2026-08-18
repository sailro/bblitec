import ts from "typescript";
import {
    emitPropertyAssignment,
    type AssignmentContext,
} from "./compiler/assignments.js";
import {
    compileRegisteredIntrinsic,
    type IntrinsicContext,
} from "./compiler/intrinsics/registry.js";
import {
    DataLowerer,
    type DataLoweringContext,
} from "./compiler/data-lowering.js";
import {
    DataTypeRegistry,
    type DataType,
} from "./compiler/data-types.js";
import {
    NativeFunctionLowerer,
    type NativeFunctionContext,
} from "./compiler/native-functions.js";
import {
    createCompilerProgram,
} from "./compiler/program.js";
import {
    readProperty,
    type PropertyContext,
} from "./compiler/properties.js";
import {
    compileImmediatePromise,
    type PromiseLoweringContext,
} from "./compiler/promises.js";
import {
    CompilerSymbols,
} from "./compiler/symbols.js";
import {
    StaticEvaluator,
} from "./compiler/static-evaluator.js";
import {
    type StatementLoweringContext,
    StatementLowerer,
} from "./compiler/statements.js";
import {
    type UserFunctionContext,
    UserFunctionLowerer,
} from "./compiler/user-functions.js";
import type {
    CompileAsset,
    CompileOptions,
    CompileResult,
    CompiledShaderProgram,
    CompiledShaderUniformDefault,
    Feature,
    GeometryOutputTaskManifest,
    GeometryTextureTypeName,
    ResolvedCompileOptions,
    SceneMeshManifest,
    ScenePbrClearCoatManifest,
    ScenePbrMaterialManifest,
    ScenePbrSheenManifest,
    Value,
    ValueKind,
} from "./compiler/types.js";
export type {
    CompileAsset,
    CompileManifest,
    CompileOptions,
    CompileResult,
    CompiledShaderProgram,
    CompiledShaderUniformDefault,
    GeometryOutputTaskManifest,
    GeometryTextureTypeName,
    ShaderMaterialVariantName,
} from "./compiler/types.js";
import type { CompileAdaptation } from "./fidelity.js";
import { ClassLowerer } from "./compiler/classes.js";
import {
    lowerWgslShaderProgram,
    type ShaderIrProgram,
} from "./shader-ir.js";
import {
    shaderMaterialPrograms,
    shaderUniformValueLayout,
} from "./shader-material-programs.js";
import {
    findRepositoryRoot,
    readUpstreamPin,
} from "./upstream-source.js";
import { spriteAtlasAssetSource } from "./sprite-atlas-packager.js";
import { reachedGeneratedSources } from "./generated-sources.js";
import { dirname, relative, resolve, sep } from "node:path";

const featureSources: Record<Feature, string[]> = {
    "animation:property": [],
    "core": ["src/pal.cpp"],
    "backend:sdl": ["src/pal_sdl.cpp"],
    "camera:arc-rotate": [],
    "camera:default": [],
    "camera:free": [],
    "camera:orthographic": [],
    "environment:ibl": [],
    "environment:env": [],
    "environment:hdr": [],
    "environment:dds": [],
    "background:ground": [],
    "background:skybox": [],
    "background:image-skybox": [],
    "background:solid-skybox": [],
    "light:hemispheric": [],
    "light:directional": [],
    "light:point": [],
    "light:spot": [],
    "loader:babylon": [],
    "loader:gltf": [],
    "material:pbr": [],
    "material:clearcoat": [],
    "material:sheen": [],
    "material:sheen-albedo-scaling": [],
    "material:clearcoat-f0-remap": [],
    "material:no-color-view": [],
    "material:grid": [],
    "material:shader": [],
    "material:standard": [],
    "material:standard-vertex-colors": [],
    "mesh:box": [],
    "mesh:from-data": [],
    "mesh:ground": [],
    "mesh:morph-targets": [],
    "mesh:plane": [],
    "mesh:sphere": [],
    "mesh:thin-instances": [],
    "mesh:thin-instances-dynamic": [],
    "mesh:torus": [],
    "scene:remove": [],
    "sprite:2d": [],
    "renderer:sprite": ["src/pal_sdl_gpu_sprite.cpp"],
    "renderer:pbr": ["src/pal_sdl_gpu.cpp"],
    "renderer:transmission": [],
    "renderer:fog": [],
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
    const frontend = createCompilerProgram(source, fileName);
    const compiler = new Compiler(
        frontend.program,
        frontend.sourceFile,
        frontend.checker,
        {
        fileName,
        title: options.title ?? "Babylon Lite Native",
        width: options.width ?? 1280,
        height: options.height ?? 720,
        },
    );
    return compiler.compile();
}

class Compiler
    implements
        IntrinsicContext,
        AssignmentContext,
        DataLoweringContext,
        NativeFunctionContext,
        PromiseLoweringContext,
        PropertyContext,
        StatementLoweringContext,
        UserFunctionContext {
    private readonly symbols: CompilerSymbols;
    private readonly evaluator: StaticEvaluator;
    private readonly statements = new StatementLowerer();
    private readonly userFunctions: UserFunctionLowerer;
    public readonly dataTypes: DataTypeRegistry;
    public readonly dataLowerer: DataLowerer;
    private readonly classLowerer: ClassLowerer;
    private readonly nativeFunctions: NativeFunctionLowerer;
    private readonly nativeFunctionPrototypes: string[] =
        [];
    private readonly nativeFunctionDefinitions: string[] =
        [];
    private readonly returnFrames: Array<
        | { kind: "native"; type: DataType | "void" }
        | { kind: "inline"; wrapped: boolean }
    > = [];
    private jsDataReached = false;
    private jsRandomReached = false;
    private readonly staticConstants = new Map<
        ts.Symbol,
        ts.Expression
    >();
    private readonly sourceCppNames = new Set<string>();
    private readonly variableScopes: Array<
        Map<
            ts.Symbol,
            { name: string; value: Value }
        >
    > = [new Map()];
    private readonly cppNamePrefixes: string[] = [""];
    private readonly features = new Set<Feature>(["core"]);
    private readonly assets = new Map<string, CompileAsset>();
    private readonly reachedShaderPrograms: CompiledShaderProgram[] = [];
    private thisInstance: Value | undefined;
    private readonly classInstances = new Map<Value, ts.ClassDeclaration>();
    private readonly body: string[] = [];
    private readonly erasedBrowserExpressions = new Set<number>();
    private readonly erasedBrowserInstrumentation = new Set<number>();
    private readonly unwrappedAwaitExpressions = new Set<number>();
    private readonly geometryOutputTasks: GeometryOutputTaskManifest[] = [];
    private readonly scenePbrMaterials: ScenePbrMaterialManifest[] = [];
    private readonly sceneMeshes: SceneMeshManifest[] = [];
    private sceneMaterialCount = 0;
    private hasMainEntry = false;
    private defaultEngineCpp: string | undefined;
    private indentLevel = 2;
    private temporaryIndex = 0;
    private defaultRenderTaskAdapted = false;

    public constructor(
        private readonly program: ts.Program,
        private readonly sourceFile: ts.SourceFile,
        public readonly checker: ts.TypeChecker,
        private readonly options: ResolvedCompileOptions,
    ) {
        this.symbols = new CompilerSymbols(checker);
        this.userFunctions =
            new UserFunctionLowerer(checker);
        this.dataTypes = new DataTypeRegistry(
            checker,
            (node, message) => this.fail(node, message),
        );
        this.dataLowerer = new DataLowerer(this);
        this.classLowerer = new ClassLowerer(this);
        this.nativeFunctions =
            new NativeFunctionLowerer(this);
        this.evaluator = new StaticEvaluator(
            this.staticConstants,
            (identifier) =>
                this.symbols.valueSymbol(identifier),
            (expression) =>
                this.canvasSizeValue(expression) ??
                this.lookupRecordProperty(expression) ??
                this.dataLowerer.compileDataPath(
                    expression,
                    "read",
                ),
            (expression) => this.compileValue(expression),
            (expression) => this.compileValue(expression),
            (expression) => this.compileValue(expression),
            (expression) =>
                this.compileCondition(expression),
            (identifier) => this.lookup(identifier),
            (node, message) => this.fail(node, message),
            (expression) =>
                this.unwrappedAwaitExpressions.add(
                    expression.pos,
                ),
            () => this.reachJsData(),
        );
    }

    public compile(): CompileResult {
        this.collectSourceCppNames();
        this.collectStaticConstants();
        for (const statement of this.entryStatements()) {
            this.emitStatement(statement);
        }

        const features = featureOrder.filter((feature) => this.features.has(feature));
        // Two features can name the same PAL translation unit (the sprite
        // and PBR renderers share one), and CMake must list it once.
        const runtimeSources = [
            ...new Set(
                features.flatMap(
                    (feature) => featureSources[feature],
                ),
            ),
        ];
        // The manifest and CMake projection of the same table the upstream
        // lowerer emits from, so a feature's sources are declared once.
        const generatedSources =
            reachedGeneratedSources(features);
        return {
            cpp: this.renderCpp(features),
            cmake: this.renderCmake(features, runtimeSources, generatedSources),
            manifest: {
                source: this.options.fileName,
                features,
                runtimeSources,
                generatedSources,
                assets: [...this.assets.values()],
                shaderVariants: this.reachedShaderPrograms.map(
                    ({ name }) => name,
                ),
                customShaderPrograms:
                    this.reachedShaderPrograms.filter(
                        ({ name }) =>
                            !shaderMaterialPrograms.some(
                                (predeclared) =>
                                    predeclared.name === name,
                            ),
                    ),
                geometryOutputTasks: this.geometryOutputTasks,
                adaptations: this.compileAdaptations(features),
                scenePbrMaterials: this.scenePbrMaterials,
                sceneMaterialCount: this.sceneMaterialCount,
                sceneMeshes: this.sceneMeshes,
            },
        };
    }

    private collectStaticConstants(): void {
        for (const file of this.program.getSourceFiles()) {
            if (file.isDeclarationFile) {
                continue;
            }
            for (const statement of file.statements) {
                if (
                    !ts.isVariableStatement(statement) ||
                    (file !== this.sourceFile &&
                        (statement.declarationList.flags &
                            ts.NodeFlags.Const) ===
                            0)
                ) {
                    continue;
                }
                for (const declaration of statement
                    .declarationList.declarations) {
                    if (
                        ts.isIdentifier(declaration.name) &&
                        declaration.initializer
                    ) {
                        const symbol =
                            this.symbols.valueSymbol(
                                declaration.name,
                            );
                        if (symbol) {
                            this.staticConstants.set(
                                symbol,
                                declaration.initializer,
                            );
                        }
                    }
                }
            }
        }
    }

    private collectSourceCppNames(): void {
        const visit = (node: ts.Node): void => {
            if (
                (ts.isVariableDeclaration(node) ||
                    ts.isParameter(node)) &&
                ts.isIdentifier(node.name)
            ) {
                this.sourceCppNames.add(
                    this.cppIdentifier(node.name.text),
                );
            }
            ts.forEachChild(node, visit);
        };
        for (const file of this.program.getSourceFiles()) {
            if (!file.isDeclarationFile) {
                visit(file);
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

        const statements = this.sourceFile.statements.filter(
            (statement) =>
                !ts.isImportDeclaration(statement) &&
                !ts.isFunctionDeclaration(statement) &&
                !ts.isExportDeclaration(statement),
        );
        if (statements.length === 0) {
            this.failAtFile("Expected top-level scene statements or a function named main with a body.");
        }
        return statements;
    }

    public emitStatement(statement: ts.Statement): void {
        this.statements.emit(this, statement);
    }

    public emitVariableDeclaration(declaration: ts.VariableDeclaration): void {
        if (ts.isObjectBindingPattern(declaration.name)) {
            this.emitObjectBindingDeclaration(declaration);
            return;
        }
        if (ts.isArrayBindingPattern(declaration.name)) {
            this.emitArrayBindingDeclaration(declaration);
            return;
        }
        if (!ts.isIdentifier(declaration.name)) {
            this.fail(declaration.name, "Only identifier variable declarations are supported.");
        }
        if (!declaration.initializer) {
            this.fail(declaration, `Variable '${declaration.name.text}' requires an initializer.`);
        }

        const sourceName = declaration.name.text;
        if (
            declaration.parent !== undefined &&
            ts.isVariableDeclarationList(
                declaration.parent,
            ) &&
            (declaration.parent.flags &
                ts.NodeFlags.Const) ===
                0
        ) {
            const symbol = this.symbols.valueSymbol(
                declaration.name,
            );
            if (symbol) {
                this.staticConstants.delete(symbol);
            }
        }
        const cppName = this.cppIdentifier(sourceName);
        if (
            ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(
                declaration.initializer,
            )
        ) {
            return;
        }

        if (this.isBrowserOnlyExpression(declaration.initializer)) {
            const browserValue =
                this.evaluateBrowserValue(
                    declaration.initializer,
                );
            this.erasedBrowserExpressions.add(declaration.initializer.pos);
            this.defineVariable(declaration.name, {
                kind: "browser",
                cpp: "",
                ...(browserValue
                    ? { browserValue }
                    : {}),
            });
            return;
        }

        const engineCall = this.importedCall(
            declaration.initializer,
            "createEngine",
        );
        if (engineCall) {
            const engine = this.compileEngineCreation(
                engineCall,
                cppName,
            );
            this.defineVariable(declaration.name, engine);
            return;
        }

        if (
            this.emitAnnotatedDataDeclaration(
                declaration,
                cppName,
            )
        ) {
            return;
        }

        const value = this.compileValue(declaration.initializer);
        if (value.kind === "void" || value.kind === "browser") {
            this.fail(declaration.initializer, `Expression assigned to '${sourceName}' does not produce a native value.`);
        }
        if (
            value.kind === "tuple" ||
            value.kind === "record" ||
            value.kind === "morph-targets"
        ) {
            this.defineVariable(declaration.name, value);
            return;
        }
        if (value.kind === "data") {
            const narrowed =
                this.dataLowerer.narrowForDeclaration(
                    value,
                    declaration.name,
                );
            if (!narrowed.dataType) {
                this.fail(
                    declaration.initializer,
                    "Data expression is missing its type.",
                );
            }
            const initializer = this.unwrap(
                declaration.initializer,
            );
            const constructs =
                ts.isCallExpression(initializer) ||
                ts.isNewExpression(initializer) ||
                ts.isObjectLiteralExpression(initializer) ||
                ts.isArrayLiteralExpression(initializer);
            // A const local bound to an element or member of a
            // container binds a reference, so writes through it reach
            // the container the way a JavaScript object binding does.
            // `let` keeps the copy: a reference cannot be reseated.
            const aliases =
                !constructs &&
                declaration.parent !== undefined &&
                ts.isVariableDeclarationList(
                    declaration.parent,
                ) &&
                (declaration.parent.flags &
                    ts.NodeFlags.Const) !==
                    0 &&
                (ts.isElementAccessExpression(initializer) ||
                    ts.isPropertyAccessExpression(
                        initializer,
                    )) &&
                narrowed.dataType.kind !== "table" &&
                // A value read out of a span is const, so it cannot be
                // bound by reference; the source language would not let
                // it be written through either.
                !narrowed.readOnly;
            this.emit(
                `${this.dataTypes.cppType(narrowed.dataType)}${aliases ? "&" : ""} ${cppName} = ${narrowed.cpp};`,
            );
            if (aliases) {
                this.dataLowerer.registerAlias(
                    cppName,
                    narrowed.cpp,
                );
            } else {
                this.dataLowerer.registerLocal(
                    cppName,
                    constructs ? "owned" : "copy",
                );
            }
            this.defineVariable(declaration.name, {
                kind: "data",
                cpp: cppName,
                dataType: narrowed.dataType,
            });
            return;
        }

        const nativeType =
            value.kind === "number"
                ? "double"
                : value.kind === "boolean"
                  ? "bool"
                  : "auto";
        const initializerCpp =
            value.kind === "number" &&
            !ts.isCallExpression(
                this.unwrap(declaration.initializer),
            ) &&
            !ts.isConditionalExpression(
                this.unwrap(declaration.initializer),
            )
                ? this.compileNumber(
                      declaration.initializer,
                      "double",
                  )
                : value.cpp;
        const maybeUnused =
            value.kind === "boolean"
                ? "[[maybe_unused]] "
                : "";
        this.emit(
            `${maybeUnused}${nativeType} ${cppName} = ${initializerCpp};`,
        );
        const stored = { ...value, cpp: cppName };
        if (value.kind === "animation-clip") {
            stored.animationFrameRate = `${cppName}.frame_rate`;
            stored.animationDuration = `${cppName}.duration`;
        }
        if (
            declaration.parent !== undefined &&
            ts.isVariableDeclarationList(
                declaration.parent,
            ) &&
            (declaration.parent.flags &
                ts.NodeFlags.Const) ===
                0
        ) {
            // Mutable locals must never fold to their initial value:
            // later reads reference the native local, not the constant
            // the declaration happened to start from.
            delete stored.staticNumber;
            delete stored.staticString;
        }
        this.defineVariable(declaration.name, stored);
        if (value.kind === "engine") {
            if (this.defaultEngineCpp) {
                this.fail(declaration, "The prototype currently supports one engine per entry point.");
            }
            this.defaultEngineCpp = cppName;
        }
    }

    /**
     * Emits a data-typed local when the declaration carries an explicit
     * annotation mapping to a composite data type. Object literals compile
     * against the annotated struct (including one leading spread); other
     * initializers compile through the typed sink. Returns false when the
     * annotation is absent or not a composite data type.
     */
    private emitAnnotatedDataDeclaration(
        declaration: ts.VariableDeclaration,
        cppName: string,
    ): boolean {
        if (!declaration.type || !declaration.initializer) {
            return false;
        }
        const annotated = this.dataTypes.fromTsType(
            this.checker.getTypeFromTypeNode(
                declaration.type,
            ),
            declaration.type,
        );
        const initializerLiteral = this.unwrap(
            declaration.initializer,
        );
        if (
            !annotated ||
            annotated.kind === "number" ||
            annotated.kind === "boolean" ||
            annotated.kind === "span" ||
            annotated.kind === "table" ||
            (annotated.kind === "tuple" &&
                !ts.isArrayLiteralExpression(
                    initializerLiteral,
                ))
        ) {
            // Readonly views keep the legacy static-tuple declaration
            // semantics; only owning composites (and mutable tuple
            // locals initialized from array literals) take the data
            // path.
            return false;
        }
        this.reachJsData();
        const initializer = this.unwrap(
            declaration.initializer,
        );
        const spreadTarget =
            annotated.kind === "struct"
                ? annotated
                : annotated.kind === "optional" &&
                    annotated.inner.kind === "struct"
                  ? annotated.inner
                  : undefined;
        if (
            spreadTarget &&
            ts.isObjectLiteralExpression(initializer) &&
            initializer.properties.some((property) =>
                ts.isSpreadAssignment(property),
            )
        ) {
            this.dataLowerer.emitSpreadStructDeclaration(
                cppName,
                initializer,
                spreadTarget,
            );
        } else {
            this.emit(
                `${this.dataTypes.cppType(annotated)} ${cppName} = ${this.dataLowerer.compileForSink(declaration.initializer, annotated)};`,
            );
        }
        this.dataLowerer.registerLocal(
            cppName,
            ts.isCallExpression(initializer) ||
                ts.isNewExpression(initializer) ||
                ts.isObjectLiteralExpression(initializer) ||
                ts.isArrayLiteralExpression(initializer)
                ? "owned"
                : "copy",
        );
        this.defineVariable(declaration.name as ts.Identifier, {
            kind: "data",
            cpp: cppName,
            dataType: annotated,
        });
        return true;
    }

    /**
     * Destructures a tuple-producing initializer (inlined callback results,
     * static tuples, or data tuples) into per-element locals.
     */
    private emitArrayBindingDeclaration(
        declaration: ts.VariableDeclaration,
    ): void {
        if (
            !ts.isArrayBindingPattern(declaration.name) ||
            !declaration.initializer
        ) {
            this.fail(
                declaration,
                "Array destructuring requires an initializer.",
            );
        }
        const value = this.compileValue(
            declaration.initializer,
        );
        const bindings = declaration.name.elements;
        const bindElement = (
            element: ts.ArrayBindingElement,
            bound: Value,
        ): void => {
            if (ts.isOmittedExpression(element)) {
                return;
            }
            if (
                !ts.isIdentifier(element.name) ||
                element.initializer ||
                element.dotDotDotToken
            ) {
                this.fail(
                    element,
                    "Tuple destructuring supports plain identifiers.",
                );
            }
            this.bindLocalValue(element.name, bound);
        };
        if (
            value.kind === "tuple" &&
            value.tupleElements
        ) {
            if (
                bindings.length >
                value.tupleElements.length
            ) {
                this.fail(
                    declaration.name,
                    `Tuple has ${value.tupleElements.length} elements, destructuring expects ${bindings.length}.`,
                );
            }
            bindings.forEach((element, index) => {
                bindElement(
                    element,
                    value.tupleElements![index]!,
                );
            });
            return;
        }
        if (
            value.kind === "data" &&
            value.dataType?.kind === "tuple"
        ) {
            const temporary =
                this.allocateTemporaryCppName("tuple");
            this.emit(
                `const ${this.dataTypes.cppType(value.dataType)} ${temporary} = ${value.cpp};`,
            );
            bindings.forEach((element, index) => {
                bindElement(element, {
                    kind: "number",
                    cpp: `${temporary}[${index}]`,
                    dataType: { kind: "number" },
                });
            });
            return;
        }
        this.fail(
            declaration.initializer,
            "Array destructuring requires a tuple-producing initializer.",
        );
    }

    private emitObjectBindingDeclaration(
        declaration: ts.VariableDeclaration,
    ): void {
        if (
            !ts.isObjectBindingPattern(declaration.name) ||
            !declaration.initializer
        ) {
            this.fail(
                declaration,
                "Object destructuring requires an initializer.",
            );
        }
        const value = this.compileValue(
            declaration.initializer,
        );
        if (value.kind === "record") {
            this.emitRecordBindingDeclaration(
                declaration.name,
                value,
            );
            return;
        }
        if (
            value.kind !== "render-target-texture"
        ) {
            this.fail(
                declaration.initializer,
                `Object destructuring is not supported for ${value.kind}.`,
            );
        }
        const temporary =
            this.allocateTemporaryCppName(
                "destructure",
            );
        this.emit(`auto ${temporary} = ${value.cpp};`);
        for (const element of declaration.name.elements) {
            const { name, property } =
                this.bindingProperty(element);
            const cppName = this.cppIdentifier(name.text);
            // The same properties `rtt.rt` and `rtt.texture` name, read
            // off the temporary the destructuring bound.
            const propertyValue =
                readProperty(
                    this,
                    { ...value, cpp: temporary },
                    property,
                    element,
                ) ??
                this.fail(
                    element,
                    `Unsupported render-target texture property '${property}'.`,
                );
            this.emit(
                `auto ${cppName} = ${propertyValue.cpp};`,
            );
            this.defineVariable(name, {
                ...propertyValue,
                cpp: cppName,
            });
        }
    }

    /**
     * The source property a destructuring element reads, with the
     * binding forms the compiler does not lower rejected first. The
     * record and render-target paths share this and then diverge on
     * where the value comes from.
     */
    private bindingProperty(element: ts.BindingElement): {
        name: ts.Identifier;
        property: string;
    } {
        if (
            element.dotDotDotToken ||
            !ts.isIdentifier(element.name)
        ) {
            this.fail(
                element,
                "Object destructuring supports identifier properties only.",
            );
        }
        return {
            name: element.name,
            property:
                element.propertyName &&
                (ts.isIdentifier(element.propertyName) ||
                    ts.isStringLiteral(element.propertyName))
                    ? element.propertyName.text
                    : element.name.text,
        };
    }

    private emitRecordBindingDeclaration(
        pattern: ts.ObjectBindingPattern,
        value: Value,
    ): void {
        for (const element of pattern.elements) {
            const { name, property } =
                this.bindingProperty(element);
            const propertyValue =
                value.recordProperties?.[property];
            if (!propertyValue) {
                this.fail(
                    element,
                    `Record has no property '${property}'.`,
                );
            }
            if (propertyValue.kind !== "number") {
                this.fail(
                    element,
                    `Record destructuring supports numeric properties only, received ${propertyValue.kind}.`,
                );
            }
            const cppName = this.cppIdentifier(name.text);
            this.emit(
                `[[maybe_unused]] double ${cppName} = ${propertyValue.cpp};`,
            );
            this.defineVariable(name, {
                kind: "number",
                cpp: cppName,
                ...(propertyValue.staticNumber === undefined
                    ? {}
                    : {
                          staticNumber:
                              propertyValue.staticNumber,
                      }),
            });
        }
    }

    public emitAssignment(expression: ts.BinaryExpression): void {
        if (this.dataLowerer.emitAssignment(expression)) {
            return;
        }
        emitPropertyAssignment(this, expression);
    }

    public compileValue(expression: ts.Expression): Value {
        const unwrapped = this.unwrap(expression);

        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken
        ) {
            return this.compileValue(
                this.evaluator.resolveNullish(unwrapped),
            );
        }
        if (
            unwrapped.kind === ts.SyntaxKind.ThisKeyword
        ) {
            const instance = this.activeThis();
            if (!instance) {
                this.fail(
                    unwrapped,
                    "'this' is only reached inside a class constructor or method.",
                );
            }
            return instance;
        }
        if (ts.isIdentifier(unwrapped)) {
            const value = this.lookupOptional(unwrapped);
            if (value) {
                return value;
            }
            const resolved =
                this.resolveStaticExpression(unwrapped);
            if (resolved !== unwrapped) {
                return this.compileValue(resolved);
            }
            return this.lookup(unwrapped);
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const canvasSize =
                this.canvasSizeValue(unwrapped);
            if (canvasSize) {
                return canvasSize;
            }
            const data = this.dataLowerer.compileDataPath(
                unwrapped,
                "read",
            );
            if (data) {
                return data;
            }
            return this.compilePropertyAccess(unwrapped);
        }
        if (ts.isNewExpression(unwrapped)) {
            const constructed =
                this.dataLowerer.compileNewExpression(
                    unwrapped,
                );
            if (constructed) {
                return constructed;
            }
            const classDeclaration =
                this.classLowerer.resolveClass(unwrapped);
            if (classDeclaration) {
                const instance =
                    this.classLowerer.construct(
                        unwrapped,
                        classDeclaration,
                    );
                this.registerClassInstance(
                    instance,
                    classDeclaration,
                );
                return instance;
            }
            this.fail(
                unwrapped,
                "Unsupported constructor expression.",
            );
        }
        if (ts.isElementAccessExpression(unwrapped)) {
            const data = this.dataLowerer.compileDataPath(
                unwrapped,
                "read",
            );
            if (data) {
                return data;
            }
            const owner = this.compileValue(
                unwrapped.expression,
            );
            if (owner.kind === "camera-world-matrix") {
                const index = this.compileValue(
                    unwrapped.argumentExpression,
                );
                if (
                    index.kind !== "number" ||
                    index.staticNumber === undefined ||
                    ![12, 13, 14].includes(
                        index.staticNumber,
                    )
                ) {
                    this.fail(
                        unwrapped.argumentExpression,
                        "Reached camera world-matrix access supports translation indices 12-14.",
                    );
                }
                // The pinned `getCameraPosition` reads these three back out
                // of the camera's float32 world matrix, so the rounded
                // stored value is what a scene observes -- not the double
                // the eye was composed at.
                const element = index.staticNumber as
                    | 12
                    | 13
                    | 14;
                return {
                    kind: "number",
                    cpp: `bbl::upstream::camera_world_matrix(${this.requireEngine(owner, unwrapped)}.cameras[${owner.cpp}.value])[${element}]`,
                    ...(owner.engineCpp
                        ? { engineCpp: owner.engineCpp }
                        : {}),
                };
            }
            if (owner.kind !== "tuple") {
                this.fail(
                    unwrapped.expression,
                    `Element access is not supported for ${owner.kind}.`,
                );
            }
            const index = this.compileValue(
                unwrapped.argumentExpression,
            );
            if (
                index.kind !== "number" ||
                index.staticNumber === undefined ||
                !Number.isInteger(index.staticNumber)
            ) {
                this.fail(
                    unwrapped.argumentExpression,
                    "Static tuple access requires an integer index.",
                );
            }
            const value =
                owner.tupleElements?.[index.staticNumber];
            if (!value) {
                this.fail(
                    unwrapped,
                    `Tuple index ${index.staticNumber} is out of range.`,
                );
            }
            return value;
        }
        if (ts.isCallExpression(unwrapped)) {
            return this.compileCall(unwrapped);
        }
        if (ts.isConditionalExpression(unwrapped)) {
            const whenTrue = this.compileValue(
                unwrapped.whenTrue,
            );
            const whenFalse = this.compileValue(
                unwrapped.whenFalse,
            );
            // A tuple value is a compile-time list of element values with
            // no native expression of its own, so selecting between two
            // tuples is selecting element by element. Same arity is the
            // condition for that to be the same thing.
            if (
                whenTrue.kind === "tuple" &&
                whenFalse.kind === "tuple"
            ) {
                const trueElements =
                    whenTrue.tupleElements ?? [];
                const falseElements =
                    whenFalse.tupleElements ?? [];
                if (
                    trueElements.length !==
                    falseElements.length
                ) {
                    this.fail(
                        unwrapped,
                        "Conditional tuple branches must have the same length.",
                    );
                }
                const condition = this.compileCondition(
                    unwrapped.condition,
                );
                return {
                    kind: "tuple",
                    cpp: "",
                    tupleElements: trueElements.map(
                        (element, index) =>
                            this.selectValue(
                                condition,
                                element,
                                falseElements[index]!,
                                unwrapped,
                            ),
                    ),
                };
            }
            return this.selectValue(
                this.compileCondition(unwrapped.condition),
                whenTrue,
                whenFalse,
                unwrapped,
            );
        }
        if (ts.isArrayLiteralExpression(unwrapped)) {
            return {
                kind: "tuple",
                cpp: "",
                tupleElements: unwrapped.elements.map(
                    (element) =>
                        this.compileValue(element),
                ),
            };
        }
        if (ts.isObjectLiteralExpression(unwrapped)) {
            const properties: Record<string, Value> = {};
            const methods: Record<
                string,
                | ts.Identifier
                | ts.ArrowFunction
                | ts.FunctionExpression
            > = {};
            const getters: Record<
                string,
                ts.GetAccessorDeclaration
            > = {};
            for (const property of unwrapped.properties) {
                if (
                    ts.isGetAccessorDeclaration(property)
                ) {
                    const name = this.propertyName(
                        property.name,
                    );
                    if (!name) {
                        this.fail(
                            property.name,
                            "Static record properties require literal names.",
                        );
                    }
                    getters[name] = property;
                    continue;
                }
                if (ts.isPropertyAssignment(property)) {
                    const name = this.propertyName(
                        property.name,
                    );
                    if (!name) {
                        this.fail(
                            property.name,
                            "Static record properties require literal names.",
                        );
                    }
                    const initializer = this.unwrap(
                        property.initializer,
                    );
                    if (
                        ts.isIdentifier(initializer) &&
                        this.namesLocalFunction(initializer)
                    ) {
                        methods[name] = initializer;
                        continue;
                    }
                    if (
                        ts.isArrowFunction(initializer) ||
                        ts.isFunctionExpression(initializer)
                    ) {
                        methods[name] = initializer;
                        continue;
                    }
                    properties[name] = this.compileValue(
                        property.initializer,
                    );
                } else if (
                    ts.isShorthandPropertyAssignment(
                        property,
                    )
                ) {
                    if (
                        this.namesLocalFunction(
                            property.name,
                        )
                    ) {
                        methods[property.name.text] =
                            property.name;
                        continue;
                    }
                    properties[property.name.text] =
                        this.compileValue(property.name);
                } else {
                    this.fail(
                        property,
                        "Static records support property assignments, getters, and properties naming a local function.",
                    );
                }
            }
            const closes =
                Object.keys(methods).length > 0 ||
                Object.keys(getters).length > 0;
            return {
                kind: "record",
                cpp: "",
                recordProperties: properties,
                recordMethods: methods,
                recordGetters: getters,
                // Only a record with code in it needs its scope: a
                // plain property already holds a resolved value.
                ...(closes
                    ? {
                          recordScopes: [
                              ...this.variableScopes,
                          ],
                      }
                    : {}),
            };
        }
        if (
            ts.isStringLiteral(unwrapped) ||
            ts.isNoSubstitutionTemplateLiteral(unwrapped) ||
            ts.isTemplateExpression(unwrapped)
        ) {
            const value =
                this.compileStringLiteral(unwrapped);
            return {
                kind: "string",
                cpp: this.cppString(value),
                staticString: value,
            };
        }
        if (this.isNumberExpression(unwrapped)) {
            const staticNumber =
                ts.isNumericLiteral(unwrapped)
                    ? Number(unwrapped.text)
                    : undefined;
            return {
                kind: "number",
                cpp: this.compileNumber(unwrapped),
                ...(staticNumber === undefined
                    ? {}
                    : { staticNumber }),
            };
        }
        if (this.evaluator.isBooleanExpression(unwrapped)) {
            return {
                kind: "boolean",
                cpp: this.compileBoolean(unwrapped),
            };
        }
        // A comparison in value position is the same expression a
        // condition position already lowers; only where it lands differs.
        if (
            this.evaluator.isComparisonExpression(unwrapped)
        ) {
            return {
                kind: "boolean",
                cpp: this.compileCondition(unwrapped),
            };
        }
        if (this.isBrowserOnlyExpression(unwrapped)) {
            const browserValue =
                this.evaluateBrowserValue(unwrapped);
            return {
                kind: "browser",
                cpp: "",
                ...(browserValue
                    ? { browserValue }
                    : {}),
            };
        }

        this.fail(unwrapped, `Unsupported value expression: ${ts.SyntaxKind[unwrapped.kind]}.`);
    }

    /**
     * `condition ? whenTrue : whenFalse` for two already-compiled values.
     * Both branches must name the same kind of native expression, since
     * the result has to be one expression the caller can use.
     */
    private selectValue(
        condition: string,
        whenTrue: Value,
        whenFalse: Value,
        node: ts.Node,
    ): Value {
        if (
            whenTrue.kind !== whenFalse.kind ||
            whenTrue.cpp.length === 0 ||
            whenFalse.cpp.length === 0 ||
            (whenTrue.engineCpp &&
                whenFalse.engineCpp &&
                whenTrue.engineCpp !== whenFalse.engineCpp)
        ) {
            this.fail(
                node,
                "Conditional expressions require matching native value branches.",
            );
        }
        const conditional: Value = {
            ...whenTrue,
            cpp: `(${condition} ? ${whenTrue.cpp} : ${whenFalse.cpp})`,
        };
        if (
            whenTrue.staticNumber !== whenFalse.staticNumber
        ) {
            delete conditional.staticNumber;
        }
        if (
            whenTrue.staticString !== whenFalse.staticString
        ) {
            delete conditional.staticString;
        }
        return conditional;
    }

    private compilePropertyAccess(expression: ts.PropertyAccessExpression): Value {
        const ownerExpression = this.unwrap(
            expression.expression,
        );
        if (
            ownerExpression.kind ===
            ts.SyntaxKind.ThisKeyword
        ) {
            // Field reads resolve through the instance record the
            // constructor built.
            const instance = this.compileValue(ownerExpression);
            const field =
                instance.recordProperties?.[
                    expression.name.text
                ];
            if (!field) {
                this.fail(
                    expression,
                    `Field '${expression.name.text}' is not assigned before this read.`,
                );
            }
            return field;
        }
        if (
            !ts.isIdentifier(ownerExpression) &&
            !ts.isPropertyAccessExpression(ownerExpression)
        ) {
            this.fail(
                expression,
                `Unsupported property value '${expression.getText()}'.`,
            );
        }
        // Through compileValue rather than lookup: a module-level
        // constant is never bound in a variable scope, so it resolves
        // through its own initializer the way an entry-scope constant
        // resolves through its binding, and a property-access owner
        // resolves by recursing here, so `camera.ortho.halfHeight` reads
        // as the path it is written as. Unknown identifiers still fail
        // in lookup at the end of that chain, and an owner that is
        // itself unsupported fails naming the sub-path that failed.
        const owner = this.compileValue(ownerExpression);
        const property = expression.name.text;
        if (owner.kind === "record") {
            const accessor = owner.recordGetters?.[property];
            if (accessor) {
                return this.compileRecordGetter(
                    owner,
                    accessor,
                );
            }
            const value =
                owner.recordProperties?.[property];
            if (!value) {
                if (owner.recordMethods?.[property]) {
                    this.fail(
                        expression,
                        `Property '${property}' is a method; it can be called but not read as a value.`,
                    );
                }
                this.fail(
                    expression,
                    `Static record has no property '${property}'.`,
                );
            }
            return value;
        }
        return (
            this.readOwnerProperty(owner, expression) ??
            this.fail(
                expression,
                `Unsupported property value '${expression.getText()}'.`,
            )
        );
    }

    private compileCall(call: ts.CallExpression): Value {
        const promise = compileImmediatePromise(
            this,
            call,
        );
        if (promise) {
            return promise;
        }
        const callee = this.unwrap(call.expression);
        if (ts.isPropertyAccessExpression(callee)) {
            const math =
                this.dataLowerer.compileMathCall(call);
            if (math) {
                return math;
            }
            const method =
                this.dataLowerer.compileDataMethodCall(
                    call,
                );
            if (method) {
                return method;
            }
            // A method on a constructed instance inlines with `this`
            // bound to that instance's field record.
            const receiver = this.unwrap(callee.expression);
            if (
                ts.isIdentifier(receiver) ||
                receiver.kind === ts.SyntaxKind.ThisKeyword
            ) {
                const instance = ts.isIdentifier(receiver)
                    ? this.lookupOptional(receiver)
                    : this.activeThis();
                const declaration = instance
                    ? this.classOf(instance)
                    : undefined;
                // A record property naming a local function inlines at
                // the call site exactly as a direct call to that
                // function does, by handing the identifier the literal
                // wrote to the same resolver.
                const recordMethod =
                    instance?.kind === "record"
                        ? instance.recordMethods?.[
                              callee.name.text
                          ]
                        : undefined;
                if (instance && recordMethod) {
                    // A literal written in the record has no identifier
                    // to resolve, so it takes the callback path a
                    // function-literal argument already takes. Both
                    // arrive at the same inliner.
                    if (!ts.isIdentifier(recordMethod)) {
                        return this.userFunctions.compileCallbackCall(
                            this,
                            call,
                            recordMethod,
                            (work) =>
                                this.withRecordScopes(
                                    instance,
                                    work,
                                ),
                        );
                    }
                    const method =
                        this.userFunctions.compile(
                            this,
                            call,
                            recordMethod,
                            // Only the body runs in the record's
                            // scope; the arguments were written at
                            // the call site and resolve there.
                            (work) =>
                                this.withRecordScopes(
                                    instance,
                                    work,
                                ),
                        );
                    if (method) {
                        return method;
                    }
                }
                if (instance && declaration) {
                    return this.classLowerer.compileMethodCall(
                        instance,
                        callee.name.text,
                        call,
                        declaration,
                    );
                }
            }
        }
        if (!ts.isIdentifier(callee)) {
            this.fail(callee, `Unsupported call target '${callee.getText()}'.`);
        }

        const bound = this.lookupOptional(callee);
        if (bound?.kind === "callback") {
            if (!bound.callbackDeclaration) {
                this.fail(
                    callee,
                    "Callback value is missing its declaration.",
                );
            }
            return this.userFunctions.compileCallbackCall(
                this,
                call,
                bound.callbackDeclaration,
            );
        }

        const importedName =
            this.symbols.importedName(callee);
        if (importedName) {
            const registered = compileRegisteredIntrinsic(
                this,
                importedName,
                call,
            );
            if (registered) {
                return registered;
            }
            this.fail(
                callee,
                `Babylon Lite intrinsic '${importedName}' is not supported by this prototype. Supported scene APIs are documented in README.md.`,
            );
        }
        const nativeFunction =
            this.nativeFunctions.tryCompileCall(
                call,
                callee,
            );
        if (nativeFunction) {
            return nativeFunction;
        }
        const userFunction = this.userFunctions.compile(
            this,
            call,
            callee,
        );
        if (userFunction) {
            return userFunction;
        }
        this.fail(
            callee,
            `Call '${callee.text}' does not resolve to a supported Babylon intrinsic or local function declaration.`,
        );
    }

    public compileBoxOptions(
        expression: ts.Expression,
    ): [string, string, string] {
        const unwrapped = this.unwrap(expression);
        if (ts.isObjectLiteralExpression(unwrapped)) {
            this.validateObjectProperties(
                unwrapped,
                ["size", "width", "height", "depth"],
                "Box options support size, width, height, and depth.",
            );
            const size = this.objectProperty(unwrapped, "size");
            const width = this.objectProperty(unwrapped, "width");
            const height = this.objectProperty(unwrapped, "height");
            const depth = this.objectProperty(unwrapped, "depth");
            const compiledSize = size
                ? this.compileNumber(size)
                : "1.0f";
            return [
                width ? this.compileNumber(width) : compiledSize,
                height ? this.compileNumber(height) : compiledSize,
                depth ? this.compileNumber(depth) : compiledSize,
            ];
        }
        const size = this.compileNumber(unwrapped);
        return [size, size, size];
    }

    public compileRenderTargetOptions(expression: ts.Expression): string {
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

    public compileRenderTaskOptions(expression: ts.Expression): string {
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

    public compileGeometryTaskOptions(expression: ts.Expression): {
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

    public compileCopyTaskOptions(expression: ts.Expression): string {
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
            viewport = `bbl::NormalizedViewport{${this.requiredObjectNumber(viewportObject, "x", "double")}, ${this.requiredObjectNumber(viewportObject, "y", "double")}, ${this.requiredObjectNumber(viewportObject, "width", "double")}, ${this.requiredObjectNumber(viewportObject, "height", "double")}}`;
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
            this.symbols.importedName(unwrapped.expression) !==
                "GeometryTextureType"
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

    public compileGroundOptions(
        expression: ts.Expression,
    ): [string, string, string, string, string] {
        const object = this.expectObjectLiteral(expression);
        this.validateObjectProperties(
            object,
            ["width", "height", "subdivisions", "uvScale"],
            "Ground options support width, height, subdivisions, and uvScale.",
        );
        const width = this.objectProperty(object, "width");
        const height = this.objectProperty(object, "height");
        const subdivisions = this.objectProperty(
            object,
            "subdivisions",
        );
        const uvScale = this.objectProperty(object, "uvScale");
        let compiledUvScale: [string, string] = ["1.0f", "1.0f"];
        if (uvScale) {
            const values = this.expectStaticArrayLiteral(uvScale);
            if (values.elements.length !== 2) {
                this.fail(
                    values,
                    "Ground uvScale requires [uScale, vScale].",
                );
            }
            compiledUvScale = [
                this.compileNumber(values.elements[0]!),
                this.compileNumber(values.elements[1]!),
            ];
        }
        return [
            width ? this.compileNumber(width) : "1.0f",
            height ? this.compileNumber(height) : "1.0f",
            subdivisions
                ? this.compilePositiveInteger(subdivisions)
                : "1u",
            compiledUvScale[0],
            compiledUvScale[1],
        ];
    }

    public compilePlaneOptions(expression: ts.Expression): [string, string] {
        const object = this.expectObjectLiteral(expression);
        this.validateObjectProperties(
            object,
            ["size", "width", "height"],
            "Plane options support only size, width, and height.",
        );
        const size = this.objectProperty(object, "size");
        const width = this.objectProperty(object, "width");
        const height = this.objectProperty(object, "height");
        const compiledSize = size ? this.compileNumber(size) : "1.0f";
        return [
            width ? this.compileNumber(width) : compiledSize,
            height ? this.compileNumber(height) : compiledSize,
        ];
    }

    public compileSphereOptions(
        expression: ts.Expression,
    ): [string, string, string, string] {
        const unwrapped = this.unwrap(expression);
        if (!ts.isObjectLiteralExpression(unwrapped)) {
            const record = this.compileValue(unwrapped);
            if (
                record.kind !== "record" ||
                !record.recordProperties
            ) {
                this.fail(
                    unwrapped,
                    "Expected sphere options as an object literal or static record.",
                );
            }
            const supported = new Set([
                "segments",
                "diameter",
                "diameterX",
                "diameterY",
                "diameterZ",
            ]);
            for (const name of Object.keys(
                record.recordProperties,
            )) {
                if (!supported.has(name)) {
                    this.fail(
                        unwrapped,
                        "Sphere options support segments, diameter, diameterX, diameterY, and diameterZ.",
                    );
                }
            }
            const number = (
                name: string,
                fallback: string,
            ): string => {
                const value =
                    record.recordProperties?.[name];
                if (!value) {
                    return fallback;
                }
                if (value.kind !== "number") {
                    this.fail(
                        unwrapped,
                        `Sphere option '${name}' must be numeric.`,
                    );
                }
                return value.cpp;
            };
            const diameter = number(
                "diameter",
                "1.0f",
            );
            const segments =
                record.recordProperties.segments;
            if (
                segments &&
                (segments.kind !== "number" ||
                    segments.staticNumber === undefined ||
                    !Number.isInteger(
                        segments.staticNumber,
                    ) ||
                    segments.staticNumber <= 0)
            ) {
                this.fail(
                    unwrapped,
                    "Sphere segments must be a positive static integer.",
                );
            }
            return [
                segments
                    ? `${segments.staticNumber}u`
                    : "32u",
                number("diameterX", diameter),
                number("diameterY", diameter),
                number("diameterZ", diameter),
            ];
        }
        const object = unwrapped;
        this.validateObjectProperties(
            object,
            [
                "segments",
                "diameter",
                "diameterX",
                "diameterY",
                "diameterZ",
            ],
            "Sphere options support segments, diameter, diameterX, diameterY, and diameterZ.",
        );
        const segments = this.objectProperty(object, "segments");
        const diameter = this.objectProperty(object, "diameter");
        const diameterX = this.objectProperty(object, "diameterX");
        const diameterY = this.objectProperty(object, "diameterY");
        const diameterZ = this.objectProperty(object, "diameterZ");
        const compiledDiameter = diameter
            ? this.compileNumber(diameter)
            : "1.0f";
        return [
            segments ? this.compilePositiveInteger(segments) : "32u",
            diameterX
                ? this.compileNumber(diameterX)
                : compiledDiameter,
            diameterY
                ? this.compileNumber(diameterY)
                : compiledDiameter,
            diameterZ
                ? this.compileNumber(diameterZ)
                : compiledDiameter,
        ];
    }

    private validateObjectProperties(
        object: ts.ObjectLiteralExpression,
        supported: readonly string[],
        message: string,
    ): void {
        const supportedNames = new Set(supported);
        for (const property of object.properties) {
            const name =
                ts.isPropertyAssignment(property) ||
                ts.isShorthandPropertyAssignment(property)
                    ? this.propertyName(property.name)
                    : undefined;
            if (!name || !supportedNames.has(name)) {
                this.fail(property, message);
            }
        }
    }

    public compileTorusOptions(
        expression: ts.Expression,
    ): [string, string, string] {
        const object = this.expectObjectLiteral(expression);
        this.validateObjectProperties(
            object,
            ["diameter", "thickness", "tessellation"],
            "Torus options support diameter, thickness, and tessellation.",
        );
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

    public compilePbrMaterialOptions(
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
        string,
        string,
    ] {
        const object = this.expectObjectLiteral(expression);
        this.validateObjectProperties(
            object,
            [
                "baseColorTexture",
                "ormTexture",
                "metallicFactor",
                "roughnessFactor",
                "directIntensity",
                "environmentIntensity",
                "alpha",
                "reflectance",
                "doubleSided",
                "transmissive",
                "subsurface",
            ],
            "Reached PBR lowering supports base/ORM textures, metallic/roughness factors, alpha, reflectance, lighting intensities, skybox mode, and transmission subsurface fields.",
        );
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
        const doubleSided = this.objectProperty(object, "doubleSided");
        const transmissive = this.objectProperty(object, "transmissive");
        const subsurfaceExpression = this.objectProperty(object, "subsurface");
        let transmission = "0.0f";
        let ior = "1.5f";
        let thickness = "0.0f";
        let useThicknessAsDepth = "false";
        let hasVolume = "false";
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
                const thicknessAsDepth = this.objectProperty(
                    refraction,
                    "useThicknessAsDepth",
                );
                transmission = intensity
                    ? this.compileNumber(intensity)
                    : transmissive
                        ? "1.0f"
                        : "0.0f";
                ior = indexOfRefraction
                    ? this.compileNumber(indexOfRefraction)
                    : "1.5f";
                useThicknessAsDepth = thicknessAsDepth
                    ? this.compileBoolean(thicknessAsDepth)
                    : "false";
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
                hasVolume = distance ? "true" : "false";
                attenuationColor = color
                    ? this.compileColor3(color)
                    : attenuationColor;
                attenuationDistance = distance
                    ? this.compileNumber(distance)
                    : attenuationDistance;
            }
        }
        const metallicCpp = metallic
            ? this.compileNumber(metallic)
            : "1.0f";
        const roughnessCpp = roughness
            ? this.compileNumber(roughness)
            : "1.0f";
        const directCpp = direct ? this.compileNumber(direct) : "1.0f";
        const environmentCpp = environment
            ? this.compileNumber(environment)
            : "1.0f";
        const alphaCpp = alpha ? this.compileNumber(alpha) : "1.0f";
        const reflectanceCpp = reflectance
            ? this.compileNumber(reflectance)
            : "0.04f";
        const doubleSidedCpp = doubleSided
            ? this.compileBoolean(doubleSided)
            : "false";
        // The resolved option values, in creation order, for the pinned
        // composer: the pin's `createPbrMaterial` is `{...props}`, so these
        // ARE the material record its feature derivation reads. Every value
        // above compiles from a static literal, which is why parsing the C++
        // text back is exact.
        this.scenePbrMaterials.push({
            materialsBefore: this.recordSceneMaterialSlot(),
            gltfAssetsBefore: [...this.assets.values()].filter(
                (asset) => asset.kind === "gltf",
            ).length,
            hasBaseColorTexture: true,
            hasOrmTexture: true,
            metallicFactor: Number.parseFloat(metallicCpp),
            roughnessFactor: Number.parseFloat(roughnessCpp),
            directIntensity: Number.parseFloat(directCpp),
            environmentIntensity: Number.parseFloat(environmentCpp),
            alpha: Number.parseFloat(alphaCpp),
            reflectance: Number.parseFloat(reflectanceCpp),
            doubleSided: doubleSidedCpp === "true",
            transmission: Number.parseFloat(transmission),
            ior: Number.parseFloat(ior),
            thickness: Number.parseFloat(thickness),
        });
        return [
            baseColor,
            orm,
            metallicCpp,
            roughnessCpp,
            directCpp,
            environmentCpp,
            alphaCpp,
            reflectanceCpp,
            "false",
            doubleSidedCpp,
            "false",
            transmission,
            ior,
            thickness,
            useThicknessAsDepth,
            hasVolume,
            attenuationColor,
            attenuationDistance,
        ];
    }

    public compileGridMaterialOptions(expression: ts.Expression): string[] {
        const object = this.expectObjectLiteral(expression);
        this.validateObjectProperties(
            object,
            [
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
            ],
            "Grid material options support colors, object-space spacing/offset, line frequency/visibility, opacity, antialiasing, premultiplication, max-line composition, visibility, and culling.",
        );
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

    /**
     * The reached slice of `ClearCoatProps`. The pinned defaults come from
     * `writeClearcoatUBO`, which is also where the `isEnabled` guard lives:
     * a disabled coat writes no slice at all. The three optional textures
     * are rejected rather than ignored — no reached scene carries one, and
     * they would need their own binding pairs.
     */
    public compileClearCoatOptions(
        expression: ts.Expression,
    ): [string, string, string, string, string] {
        const object = this.expectObjectLiteral(expression);
        this.validateObjectProperties(
            object,
            [
                "isEnabled",
                "intensity",
                "roughness",
                "indexOfRefraction",
                "bumpTextureScale",
            ],
            "Reached clearcoat options support isEnabled, intensity, roughness, indexOfRefraction, and bumpTextureScale.",
        );
        const isEnabled = this.objectProperty(object, "isEnabled");
        const intensity = this.objectProperty(object, "intensity");
        const roughness = this.objectProperty(object, "roughness");
        const indexOfRefraction = this.objectProperty(
            object,
            "indexOfRefraction",
        );
        const bumpTextureScale = this.objectProperty(
            object,
            "bumpTextureScale",
        );
        return [
            isEnabled ? this.compileBoolean(isEnabled) : "false",
            intensity ? this.compileNumber(intensity) : "1.0f",
            roughness ? this.compileNumber(roughness) : "0.0f",
            indexOfRefraction
                ? this.compileNumber(indexOfRefraction)
                : "1.5f",
            bumpTextureScale
                ? this.compileNumber(bumpTextureScale)
                : "1.0f",
        ];
    }

    /**
     * The reached slice of `SheenProps`. The pinned defaults come from
     * `writeSheenUBO`, which is also where the `isEnabled` guard lives.
     * `albedoScaling` is read here rather than rejected because it selects
     * which of the two pinned sheen models the fragment composes, and the
     * reached scene leaves it at its legacy default. `roughnessTexture` is
     * rejected: it would need its own binding pair and its own UV.
     */
    public compileSheenOptions(
        expression: ts.Expression,
    ): {
        enabled: string;
        color: string;
        roughness: string;
        intensity: string;
        texture: ts.Expression | undefined;
        albedoScaling: boolean;
    } {
        const object = this.expectObjectLiteral(expression);
        this.validateObjectProperties(
            object,
            [
                "isEnabled",
                "color",
                "roughness",
                "intensity",
                "texture",
                "albedoScaling",
            ],
            "Reached sheen options support isEnabled, color, roughness, intensity, texture, and albedoScaling.",
        );
        const isEnabled = this.objectProperty(object, "isEnabled");
        const color = this.objectProperty(object, "color");
        const roughness = this.objectProperty(object, "roughness");
        const intensity = this.objectProperty(object, "intensity");
        const albedoScaling = this.objectProperty(
            object,
            "albedoScaling",
        );
        const albedoScalingValue = albedoScaling
            ? this.compileBoolean(albedoScaling)
            : "false";
        if (
            albedoScalingValue !== "true" &&
            albedoScalingValue !== "false"
        ) {
            this.fail(
                albedoScaling ?? object,
                "Sheen albedoScaling must be a static boolean; it selects the composed fragment.",
            );
        }
        return {
            enabled: isEnabled
                ? this.compileBoolean(isEnabled)
                : "false",
            color: color
                ? this.compileColor3(color)
                : "bbl::Color3{1.0f, 1.0f, 1.0f}",
            roughness: roughness
                ? this.compileNumber(roughness)
                : "0.0f",
            intensity: intensity
                ? this.compileNumber(intensity)
                : "1.0f",
            texture: this.objectProperty(object, "texture"),
            albedoScaling: albedoScalingValue === "true",
        };
    }

    public compileShaderMaterialOptions(
        expression: ts.Expression,
    ): { name: string; id: number } {
        const object = this.expectObjectLiteral(expression);
        this.validateObjectProperties(
            object,
            [
                "name",
                "vertexSource",
                "fragmentSource",
                "attributes",
                "uniforms",
                "needAlphaBlending",
                "needAlphaTesting",
                "backFaceCulling",
                "depthWrite",
            ],
            "Reached shader materials support source, attributes, uniforms, alpha state, culling, and depthWrite only.",
        );

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

        const vertexSource =
            this.compileStaticString(vertexExpression);
        const fragmentSource =
            this.compileStaticString(fragmentExpression);
        const attributes = this.compileStaticStringArray(attributesExpression);
        const { signatures: uniforms, defaults: uniformDefaults } =
            this.compileShaderUniformSignatures(uniformsExpression);
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
                this.stringArraysEqual(attributes, program.attributes) &&
                this.stringArraysEqual(uniforms, program.uniforms) &&
                needAlphaBlending === program.needAlphaBlending &&
                needAlphaTesting === program.needAlphaTesting &&
                backFaceCulling === program.backFaceCulling &&
                depthWrite === program.depthWrite
            ) {
                let candidate: ShaderIrProgram;
                try {
                    candidate = lowerWgslShaderProgram({
                        ...program,
                        vertexSource,
                        fragmentSource,
                        attributes,
                        uniforms,
                        needAlphaBlending,
                        needAlphaTesting,
                        backFaceCulling,
                        depthWrite,
                    });
                } catch (error: unknown) {
                    const message =
                        error instanceof Error
                            ? error.message
                            : String(error);
                    this.fail(
                        object,
                        `Invalid reached shader material WGSL: ${message}`,
                    );
                }
                const expected =
                    lowerWgslShaderProgram(program);
                if (
                    JSON.stringify(candidate) ===
                    JSON.stringify(expected)
                ) {
                    return this.reachShaderProgram({
                        name: program.name,
                        vertexSource: program.vertexSource,
                        fragmentSource: program.fragmentSource,
                        attributes: program.attributes,
                        uniforms: program.uniforms,
                        uniformDefaults: [],
                        needAlphaBlending: program.needAlphaBlending,
                        needAlphaTesting: program.needAlphaTesting,
                        backFaceCulling: program.backFaceCulling,
                        depthWrite: program.depthWrite,
                        clipDepth: program.clipDepth,
                    });
                }
            }
        }

        // Scene-local variant: the entry file's own WGSL compiles through
        // the typed shader IR instead of matching a predeclared program.
        const nameExpression = this.objectProperty(object, "name");
        if (!nameExpression) {
            this.fail(
                object,
                "Scene-local shader materials require a name (it becomes the generated variant identity).",
            );
        }
        const slug = this.compileStaticString(nameExpression)
            .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
            .replace(/[^A-Za-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .toLowerCase();
        if (slug.length === 0) {
            this.fail(
                nameExpression,
                "Scene-local shader material names must contain letters or digits.",
            );
        }
        if (
            shaderMaterialPrograms.some(
                ({ name }) => name === slug,
            )
        ) {
            this.fail(
                nameExpression,
                `Shader material name '${slug}' collides with a predeclared variant.`,
            );
        }
        // The reached subset composes the system block from
        // worldViewProjection alone (or none); other system uniforms
        // (view, world, projection splits) stay unreached.
        for (const signature of uniforms) {
            if (
                !signature.includes(":") &&
                signature !== "worldViewProjection"
            ) {
                this.fail(
                    uniformsExpression,
                    `Reached scene-local shader materials support the worldViewProjection system uniform only, received '${signature}'.`,
                );
            }
        }
        const sceneProgram: CompiledShaderProgram = {
            name: slug,
            vertexSource,
            fragmentSource,
            attributes,
            uniforms,
            uniformDefaults,
            needAlphaBlending,
            needAlphaTesting,
            backFaceCulling,
            depthWrite,
            // The pinned prelude clips through the composed matrix when
            // one is requested; matrix-free programs write clip
            // positions directly like the pinned alpha-card.
            clipDepth: uniforms.includes("worldViewProjection")
                ? "matrix"
                : "direct-webgpu",
        };
        try {
            lowerWgslShaderProgram(sceneProgram);
        } catch (error: unknown) {
            const message =
                error instanceof Error
                    ? error.message
                    : String(error);
            this.fail(
                object,
                `Invalid reached shader material WGSL: ${message}`,
            );
        }
        const reflection =
            lowerWgslShaderProgram(sceneProgram).reflection;
        for (const entry of uniformDefaults) {
            const declared = uniforms.find((signature) =>
                signature.startsWith(`${entry.name}:`),
            );
            if (!declared) {
                this.fail(
                    uniformsExpression,
                    `Shader uniform default '${entry.name}' has no typed declaration.`,
                );
            }
            const componentCount =
                declared.endsWith(":f32")
                    ? 1
                    : declared.endsWith(":vec2<f32>")
                        ? 2
                        : declared.endsWith(":vec3<f32>")
                            ? 3
                            : declared.endsWith(":vec4<f32>")
                                ? 4
                                : 0;
            if (componentCount === 0) {
                this.fail(
                    uniformsExpression,
                    `Shader uniform default '${entry.name}' has an unsupported type.`,
                );
            }
            if (entry.values.length !== componentCount) {
                this.fail(
                    uniformsExpression,
                    `Shader uniform default '${entry.name}' expects ${componentCount} component(s).`,
                );
            }
        }
        void reflection;
        return this.reachShaderProgram(sceneProgram);
    }

    private compileShaderUniformSignatures(expression: ts.Expression): {
        signatures: string[];
        defaults: CompiledShaderUniformDefault[];
    } {
        const array = this.expectStaticArrayLiteral(expression);
        const defaults: CompiledShaderUniformDefault[] = [];
        const signatures = array.elements.map((element) => {
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
            for (const property of resolved.properties) {
                const propertyName =
                    ts.isPropertyAssignment(property) ||
                    ts.isShorthandPropertyAssignment(property)
                        ? this.propertyName(property.name)
                        : undefined;
                if (
                    !propertyName ||
                    !["name", "type", "defaultValue"].includes(propertyName)
                ) {
                    this.fail(
                        property,
                        "Typed shader uniforms support name, type, and defaultValue.",
                    );
                }
            }
            const name = this.objectProperty(resolved, "name");
            const type = this.objectProperty(resolved, "type");
            if (!name || !type) {
                this.fail(
                    resolved,
                    "Typed shader uniforms require name and type.",
                );
            }
            const uniformName = this.compileStaticString(name);
            const defaultExpression = this.objectProperty(
                resolved,
                "defaultValue",
            );
            if (defaultExpression) {
                const resolvedDefault =
                    this.resolveStaticExpression(defaultExpression);
                const values = ts.isArrayLiteralExpression(resolvedDefault)
                    ? resolvedDefault.elements.map((entry) =>
                          this.expectStaticNumber(entry),
                      )
                    : [this.expectStaticNumber(resolvedDefault)];
                defaults.push({ name: uniformName, values });
            }
            return `${uniformName}:${this.compileStaticString(type)}`;
        });
        return { signatures, defaults };
    }

    /**
     * Registers a reached shader program (predeclared or scene-local)
     * and returns its stable generated variant identity: the id indexes
     * the emitted variant table in reach order.
     */
    private reachShaderProgram(
        program: CompiledShaderProgram,
    ): { name: string; id: number } {
        const existing = this.reachedShaderPrograms.findIndex(
            ({ name }) => name === program.name,
        );
        if (existing >= 0) {
            return { name: program.name, id: existing };
        }
        this.reachedShaderPrograms.push(program);
        return {
            name: program.name,
            id: this.reachedShaderPrograms.length - 1,
        };
    }

    public reachedShaderProgram(
        name: string,
        node: ts.Node,
    ): CompiledShaderProgram {
        const program = this.reachedShaderPrograms.find(
            (candidate) => candidate.name === name,
        );
        if (!program) {
            this.fail(
                node,
                `Shader variant '${name}' was not created in this scene.`,
            );
        }
        return program;
    }

    public resolveShaderUniform(
        material: Value,
        nameExpression: ts.Expression,
        expectedCounts: number[],
    ): { offset: number; count: number } {
        if (!material.shaderVariant) {
            this.fail(
                nameExpression,
                "Shader uniform writes require a shader material.",
            );
        }
        const program = this.reachedShaderProgram(
            material.shaderVariant,
            nameExpression,
        );
        const name =
            this.compileStringLiteral(nameExpression);
        const entry = shaderUniformValueLayout(
            program.uniforms,
        ).get(name);
        if (!entry) {
            this.fail(
                nameExpression,
                `Shader variant '${program.name}' declares no custom uniform '${name}'.`,
            );
        }
        if (!expectedCounts.includes(entry.count)) {
            this.fail(
                nameExpression,
                `Shader uniform '${name}' has ${entry.count} component(s); this setter expects ${expectedCounts.join(" or ")}.`,
            );
        }
        return entry;
    }

    public compileShaderUniformComponents(
        expression: ts.Expression,
        count: number,
    ): string[] {
        if (count === 1) {
            return [this.compileNumber(expression)];
        }
        const resolved =
            this.resolveStaticExpression(expression);
        if (
            ts.isArrayLiteralExpression(resolved) &&
            resolved.elements.length === count
        ) {
            return resolved.elements.map((element) =>
                this.compileNumber(element),
            );
        }
        const value = this.compileValue(expression);
        if (
            value.kind === "tuple" &&
            value.tupleElements?.length === count
        ) {
            return value.tupleElements.map(
                (element) => element.cpp,
            );
        }
        this.fail(
            expression,
            `Expected a ${count}-component array value.`,
        );
    }

    public compilePropertyAnimationClip(
        nameExpression: ts.Expression,
        tracksExpression: ts.Expression,
        optionsExpression: ts.Expression | undefined,
    ): {
        cpp: string;
        frameRate: string;
        duration: string;
    } {
        const tracks = this.expectStaticArrayLiteral(tracksExpression);
        if (tracks.elements.length === 0) {
            this.fail(
                tracks,
                "createPropertyAnimationClip requires at least one track.",
            );
        }
        let frameRate = optionsExpression
            ? this.compilePropertyAnimationFrameRate(
                  optionsExpression,
              )
            : undefined;
        if (!frameRate) {
            const trackFrameRates = tracks.elements
                .map((element) =>
                    this.objectProperty(
                        this.expectObjectLiteral(element),
                        "frameRate",
                    ),
                )
                .filter(
                    (
                        value,
                    ): value is ts.Expression =>
                        value !== undefined,
                )
                .map((value) =>
                    this.compileNumber(value),
                );
            const distinct = [
                ...new Set(trackFrameRates),
            ];
            if (distinct.length > 1) {
                this.fail(
                    tracks,
                    "Property animation tracks require one shared frame rate when clip options omit frameRate.",
                );
            }
            frameRate = distinct[0] ?? "60.0f";
        }
        const compiledTracks = tracks.elements.map((element) => {
            const track = this.expectObjectLiteral(
                this.resolveStaticExpression(element),
            );
            const pathExpression = this.objectProperty(track, "path");
            const keysExpression = this.objectProperty(track, "keys");
            if (!pathExpression || !keysExpression) {
                this.fail(
                    track,
                    "Property animation tracks require path and keys.",
                );
            }
            const path = this.compileStaticString(pathExpression);
            const pathInfo = new Map<
                string,
                { native: string; components: number }
            >([
                [
                    "position",
                    {
                        native: "position",
                        components: 3,
                    },
                ],
                [
                    "position.x",
                    {
                        native: "position_x",
                        components: 1,
                    },
                ],
                [
                    "scaling",
                    {
                        native: "scaling",
                        components: 3,
                    },
                ],
                [
                    "rotationQuaternion",
                    {
                        native: "rotation_quaternion",
                        components: 4,
                    },
                ],
            ]).get(path);
            if (!pathInfo) {
                this.fail(
                    pathExpression,
                    `Unsupported property animation path '${path}'.`,
                );
            }
            const interpolationExpression =
                this.objectProperty(track, "interpolation");
            const interpolation = interpolationExpression
                ? this.compileStaticString(interpolationExpression)
                : "linear";
            if (!["linear", "step"].includes(interpolation)) {
                this.fail(
                    interpolationExpression!,
                    `Unsupported property animation interpolation '${interpolation}'.`,
                );
            }
            const trackFrameRateExpression =
                this.objectProperty(track, "frameRate");
            const trackFrameRate = trackFrameRateExpression
                ? this.compileNumber(trackFrameRateExpression)
                : frameRate;
            const keys = this.expectStaticArrayLiteral(keysExpression);
            if (keys.elements.length === 0) {
                this.fail(
                    keys,
                    `Property animation track '${path}' requires at least one key.`,
                );
            }
            const compiledKeys = keys.elements.map((keyElement) => {
                const key = this.expectObjectLiteral(
                    this.resolveStaticExpression(keyElement),
                );
                const timeExpression = this.objectProperty(key, "time");
                const frameExpression = this.objectProperty(key, "frame");
                const valueExpression = this.objectProperty(key, "value");
                if (
                    (!timeExpression && !frameExpression) ||
                    (timeExpression && frameExpression) ||
                    !valueExpression
                ) {
                    this.fail(
                        key,
                        "Property animation keys require value and exactly one of time or frame.",
                    );
                }
                const time = timeExpression
                    ? this.compileNumber(timeExpression)
                    : `(${this.compileNumber(frameExpression!)} / ${trackFrameRate})`;
                const value = this.compilePropertyAnimationKeyValue(
                    valueExpression,
                    pathInfo.components,
                );
                return `bbl::PropertyAnimationKey{${time}, ${value}}`;
            });
            return `bbl::PropertyAnimationTrack{bbl::PropertyAnimationPath::${pathInfo.native}, bbl::PropertyAnimationInterpolation::${interpolation}, {${compiledKeys.join(", ")}}}`;
        });
        const name = this.compileStaticString(nameExpression);
        return {
            cpp: `bbl::create_property_animation_clip(${this.cppString(name)}, {${compiledTracks.join(", ")}}, ${frameRate})`,
            frameRate,
            duration: "0.0f",
        };
    }

    private compilePropertyAnimationFrameRate(
        expression: ts.Expression,
    ): string {
        const options = this.expectObjectLiteral(expression);
        const frameRate = this.objectProperty(options, "frameRate");
        return frameRate
            ? this.compileNumber(frameRate)
            : "60.0f";
    }

    private compilePropertyAnimationKeyValue(
        expression: ts.Expression,
        components: number,
    ): string {
        const resolved = this.resolveStaticExpression(expression);
        const values =
            components === 1
                ? [this.compileNumber(resolved)]
                : this.expectStaticArrayLiteral(resolved).elements.map(
                      (element) => this.compileNumber(element),
                  );
        if (values.length !== components) {
            this.fail(
                resolved,
                `Property animation value requires ${components} components.`,
            );
        }
        while (values.length < 4) values.push("0.0f");
        return `std::array<float, 4>{${values.join(", ")}}`;
    }

    public compilePropertyAnimationGroupOptions(
        expression: ts.Expression | undefined,
        clip: Value,
    ): string {
        const frameRate =
            clip.animationFrameRate ??
            this.fail(
                expression ?? this.sourceFile,
                "Property animation clip frame rate is unavailable.",
            );
        const duration =
            clip.animationDuration ??
            this.fail(
                expression ?? this.sourceFile,
                "Property animation clip duration is unavailable.",
            );
        if (!expression) {
            return `bbl::PropertyAnimationGroupOptions{0.0f, ${duration}, 1.0f, true}`;
        }
        const options = this.expectObjectLiteral(expression);
        const fromTime = this.objectProperty(options, "fromTime");
        const fromFrame = this.objectProperty(options, "fromFrame");
        const toTime = this.objectProperty(options, "toTime");
        const toFrame = this.objectProperty(options, "toFrame");
        if (fromTime && fromFrame) {
            this.fail(
                options,
                "Property animation group cannot specify both fromTime and fromFrame.",
            );
        }
        if (toTime && toFrame) {
            this.fail(
                options,
                "Property animation group cannot specify both toTime and toFrame.",
            );
        }
        const from = fromTime
            ? this.compileNumber(fromTime)
            : fromFrame
                ? `(${this.compileNumber(fromFrame)} / ${frameRate})`
                : "0.0f";
        const to = toTime
            ? this.compileNumber(toTime)
            : toFrame
                ? `(${this.compileNumber(toFrame)} / ${frameRate})`
                : duration;
        const speedRatio = this.objectProperty(options, "speedRatio");
        const loop = this.objectProperty(options, "loop");
        return `bbl::PropertyAnimationGroupOptions{${from}, ${to}, ${speedRatio ? this.compileNumber(speedRatio) : "1.0f"}, ${loop ? this.compileBoolean(loop) : "true"}}`;
    }

    private compileStaticStringArray(expression: ts.Expression): string[] {
        return this.expectStaticArrayLiteral(expression).elements.map(
            (element) => this.compileStaticString(element),
        );
    }

    public expectStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression {
        return this.evaluator.expectStaticArrayLiteral(
            expression,
        );
    }

    private compileOptionalStaticBoolean(
        expression: ts.Expression | undefined,
        fallback: boolean,
    ): boolean {
        if (!expression) return fallback;
        return this.compileBoolean(this.resolveStaticExpression(expression)) ===
            "true";
    }

    private expectStaticNumber(expression: ts.Expression): number {
        const resolved = this.resolveStaticExpression(expression);
        if (ts.isNumericLiteral(resolved)) {
            return Number(resolved.text);
        }
        if (
            ts.isPrefixUnaryExpression(resolved) &&
            resolved.operator === ts.SyntaxKind.MinusToken &&
            ts.isNumericLiteral(resolved.operand)
        ) {
            return -Number(resolved.operand.text);
        }
        this.fail(resolved, "Expected a static numeric literal.");
    }

    private stringArraysEqual(left: string[], right: string[]): boolean {
        return (
            left.length === right.length &&
            left.every((value, index) => value === right[index])
        );
    }

    private compilePositiveInteger(expression: ts.Expression): string {
        const unwrapped = this.resolveStaticExpression(
            expression,
        );
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            ts.isIdentifier(unwrapped.expression) &&
            unwrapped.name.text === "msaaSamples" &&
            this.lookup(unwrapped.expression).kind ===
                "engine"
        ) {
            const engine = this.lookup(
                unwrapped.expression,
            );
            return `${engine.msaaSamples ?? 4}u`;
        }
        if (ts.isIdentifier(unwrapped)) {
            const value = this.lookup(unwrapped);
            if (
                value.kind === "number" &&
                value.staticNumber !== undefined &&
                Number.isInteger(value.staticNumber) &&
                value.staticNumber > 0
            ) {
                return `${value.staticNumber}u`;
            }
        }
        if (!ts.isNumericLiteral(unwrapped)) {
            this.fail(unwrapped, "Expected a positive integer literal.");
        }
        const value = Number(unwrapped.text);
        if (!Number.isInteger(value) || value <= 0) {
            this.fail(unwrapped, "Expected a positive integer literal.");
        }
        return `${value}u`;
    }

    public compileEnvironmentOptions(expression: ts.Expression): {
        groundTextureUrl: string;
        skyboxUrl: string;
        skyboxSize: string;
        brdfUrl: string;
        skipSkybox: boolean;
        skipGround: boolean;
    } {
        const object = this.expectObjectLiteral(expression);
        this.validateObjectProperties(
            object,
            [
                "groundTextureUrl",
                "skyboxUrl",
                "skyboxSize",
                "brdfUrl",
                "skipSkybox",
                "skipGround",
            ],
            "Reached environment options support groundTextureUrl, skyboxUrl, skyboxSize, brdfUrl, skipSkybox, and skipGround.",
        );
        const groundTextureUrl = this.objectProperty(object, "groundTextureUrl");
        const skyboxUrl = this.objectProperty(object, "skyboxUrl");
        const skyboxSize = this.objectProperty(object, "skyboxSize");
        const brdfUrl = this.objectProperty(object, "brdfUrl");
        // `skipSkybox` and `skipGround` decide whether `loadEnvironment`'s
        // deferred builder pushes a background renderable at all, so they are
        // read rather than tolerated: the solid-colour skybox is what a scene
        // gets when it sets neither.
        const skipFlag = (name: "skipSkybox" | "skipGround"): boolean => {
            const property = this.objectProperty(object, name);
            if (!property) {
                return false;
            }
            const compiled = this.compileBoolean(property);
            if (compiled !== "true" && compiled !== "false") {
                this.fail(
                    property,
                    `${name} must be a static boolean.`,
                );
            }
            return compiled === "true";
        };
        return {
            groundTextureUrl: groundTextureUrl ? this.compileStringLiteral(groundTextureUrl) : "",
            skyboxUrl: skyboxUrl ? this.compileStringLiteral(skyboxUrl) : "",
            // Zero asks the loader for the pinned default rather than
            // inventing one here: `createDefaultEnvironment`'s skyboxSize is
            // 20, and the generated loader already resolves it. Passing a
            // size of our own produced a skybox large enough for the camera's
            // far plane to clip it, which shows as a straight-edged hole in
            // the background once the camera moves off the reference pose.
            skyboxSize: skyboxSize ? this.compileNumber(skyboxSize) : "0.0f",
            brdfUrl: brdfUrl ? this.compileStringLiteral(brdfUrl) : "",
            skipSkybox: skipFlag("skipSkybox"),
            skipGround: skipFlag("skipGround"),
        };
    }

    /**
     * `loadDdsEnvironment` takes a required `brdfUrl` plus `skipSkybox` and
     * `skipGround`, which it accepts and never acts on — it creates neither.
     * Rejecting them keeps a scene that sets one from compiling as though it
     * had been honoured.
     */
    public compileDdsEnvironmentOptions(
        expression: ts.Expression,
    ): string {
        const object = this.expectObjectLiteral(expression);
        this.validateObjectProperties(
            object,
            ["brdfUrl"],
            "Reached DDS environment options support brdfUrl.",
        );
        const brdfUrl = this.objectProperty(object, "brdfUrl");
        return brdfUrl ? this.compileStringLiteral(brdfUrl) : "";
    }

    public compileSceneDefaultRenderTask(
        expression: ts.Expression | undefined,
    ): boolean {
        if (!expression) {
            return true;
        }
        const options = this.expectObjectLiteral(expression);
        const value = this.objectProperty(
            options,
            "defaultRenderTask",
        );
        if (!value) {
            return true;
        }
        const compiled = this.compileBoolean(value);
        if (compiled !== "true" && compiled !== "false") {
            this.fail(
                value,
                "defaultRenderTask must be a static boolean.",
            );
        }
        return compiled === "true";
    }

    public compileHdrEnvironmentOptions(expression: ts.Expression): {
        faceSize: number;
        useCubemapSkybox: boolean;
        skipGround: boolean;
        skyboxSize: string;
        skyboxPosition: string;
    } {
        const object = this.expectObjectLiteral(expression);
        this.validateObjectProperties(
            object,
            [
                "faceSize",
                "useCubemapSkybox",
                "skipGround",
                "skyboxSize",
                "skyboxPosition",
            ],
            "HDR environment options support faceSize, cubemap skybox, ground skipping, skybox size, and skybox position.",
        );
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

    public compileVec3(
        expression: ts.Expression,
        precision: "float" | "double" = "float",
    ): string {
        return this.evaluator.compileVec3(
            expression,
            precision,
        );
    }

    public compileVec2(expression: ts.Expression): string {
        return this.evaluator.compileVec2(expression);
    }

    public compileBoolean(expression: ts.Expression): string {
        return this.evaluator.compileBoolean(expression);
    }

    public compileCondition(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (ts.isPrefixUnaryExpression(unwrapped) && unwrapped.operator === ts.SyntaxKind.ExclamationToken) {
            return `!(${this.compileCondition(unwrapped.operand)})`;
        }
        if (ts.isBinaryExpression(unwrapped)) {
            const typed =
                this.dataLowerer.equalityComparison(
                    unwrapped,
                );
            if (typed) {
                return typed;
            }
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
            return `(${this.compileNumber(unwrapped.left, "double")} ${operator} ${this.compileNumber(unwrapped.right, "double")})`;
        }
        if (
            ts.isIdentifier(unwrapped) ||
            ts.isPropertyAccessExpression(unwrapped) ||
            ts.isElementAccessExpression(unwrapped)
        ) {
            const data =
                this.dataLowerer.conditionOperand(
                    unwrapped,
                );
            if (data) {
                return data;
            }
        }
        if (ts.isCallExpression(unwrapped)) {
            const value = this.compileValue(unwrapped);
            if (value.kind === "boolean") {
                return value.cpp;
            }
            if (
                value.kind === "data" &&
                value.dataType?.kind === "optional"
            ) {
                return `${value.cpp}.has_value()`;
            }
            this.fail(
                unwrapped,
                `Condition call must produce a boolean, received ${value.kind}.`,
            );
        }
        if (
            unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
            unwrapped.kind === ts.SyntaxKind.FalseKeyword ||
            ts.isIdentifier(unwrapped)
        ) {
            return this.compileBoolean(unwrapped);
        }
        this.fail(unwrapped, "Expected a reached callback condition.");
    }

    public compileFrameCallback(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (ts.isIdentifier(unwrapped)) {
            return this.compileNamedFrameCallback(unwrapped);
        }
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

        const start = this.body.length;
        const previousIndent = this.indentLevel;
        this.indentLevel = 0;
        this.pushScope(
            this.cppNamePrefixes.at(-1) ?? "",
        );
        try {
            if (
                parameter &&
                ts.isIdentifier(parameter.name)
            ) {
                this.defineVariable(parameter.name, {
                    kind: "number",
                    cpp: this.cppIdentifier(
                        parameter.name.text,
                    ),
                });
            }
            for (const statement of unwrapped.body
                .statements) {
                this.emitStatement(statement);
            }
        } finally {
            this.popScope();
            this.indentLevel = previousIndent;
        }
        const callbackBody = this.body.splice(start);
        const cppParameter = parameterName
            ? `float ${this.cppIdentifier(parameterName)}`
            : "float";
        return `[&](${cppParameter}) {\n${callbackBody.map((line) => `            ${line}`).join("\n")}\n        }`;
    }

    private compileNamedFrameCallback(
        identifier: ts.Identifier,
    ): string {
        const start = this.body.length;
        const previousIndent = this.indentLevel;
        this.indentLevel = 0;
        try {
            const value =
                this.userFunctions.compileReference(
                    this,
                    identifier,
                );
            if (!value) {
                this.fail(
                    identifier,
                    `Callback '${identifier.text}' does not resolve to a local function.`,
                );
            }
            if (value.cpp.length > 0) {
                this.emit(`${value.cpp};`);
            }
        } finally {
            this.indentLevel = previousIndent;
        }
        const callbackBody = this.body.splice(start);
        return `[&](float) {\n${callbackBody
            .map((line) => `            ${line}`)
            .join("\n")}\n        }`;
    }

    public compileColor3(expression: ts.Expression): string {
        return this.evaluator.compileColor3(expression);
    }

    public compileColor4(expression: ts.Expression): string {
        return this.evaluator.compileColor4(expression);
    }

    public compileNumber(
        expression: ts.Expression,
        precision: "float" | "double" = "float",
    ): string {
        return this.evaluator.compileNumber(
            expression,
            precision,
        );
    }

    private isNumberExpression(expression: ts.Expression): boolean {
        return this.evaluator.isNumberExpression(expression);
    }

    public expectObjectLiteral(expression: ts.Expression): ts.ObjectLiteralExpression {
        const unwrapped = this.unwrap(expression);
        if (!ts.isObjectLiteralExpression(unwrapped)) {
            this.fail(unwrapped, "Expected an object literal.");
        }
        return unwrapped;
    }

    public objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
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

    private requiredObjectNumber(
        object: ts.ObjectLiteralExpression,
        name: string,
        precision: "float" | "double" = "float",
    ): string {
        const value = this.objectProperty(object, name);
        if (!value) {
            this.fail(object, `Object literal is missing numeric property '${name}'.`);
        }
        return this.compileNumber(value, precision);
    }

    private propertyName(name: ts.PropertyName): string | undefined {
        if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
            return name.text;
        }
        return undefined;
    }

    public compileStringLiteral(expression: ts.Expression): string {
        return this.evaluator.compileStringLiteral(expression);
    }

    private importedCall(
        expression: ts.Expression,
        importedName: string,
    ): ts.CallExpression | undefined {
        const unwrapped = this.unwrap(expression);
        if (
            !ts.isCallExpression(unwrapped) ||
            !ts.isIdentifier(unwrapped.expression) ||
            this.symbols.importedName(unwrapped.expression) !==
                importedName
        ) {
            return undefined;
        }
        return unwrapped;
    }

    public compileEngineCreation(
        call: ts.CallExpression,
        cppName: string,
    ): Value {
        this.expectArgumentCount(call, 1, 2);
        let msaaSamples: 1 | 4 = 4;
        if (call.arguments[1]) {
            const options = this.expectObjectLiteral(
                call.arguments[1],
            );
            this.validateObjectProperties(
                options,
                ["msaaSamples", "requiredLimits"],
                "Reached engine options support msaaSamples and requiredLimits.",
            );
            const samples = this.objectProperty(
                options,
                "msaaSamples",
            );
            if (samples) {
                const value =
                    this.resolveStaticExpression(samples);
                if (
                    !ts.isNumericLiteral(value) ||
                    Number(value.text) !== 4
                ) {
                    this.fail(
                        samples,
                        "Native engine lowering currently supports explicit msaaSamples: 4 only.",
                    );
                }
                msaaSamples = 4;
            }
            const limits = this.objectProperty(
                options,
                "requiredLimits",
            );
            if (limits) {
                this.expectObjectLiteral(limits);
            }
        }
        if (this.defaultEngineCpp) {
            this.fail(
                call,
                "The prototype currently supports one engine per entry point.",
            );
        }
        this.emit(
            `auto ${cppName} = bbl::create_engine(bbl::EngineOptions{${this.cppString(this.options.title)}, ${this.options.width}, ${this.options.height}});`,
        );
        this.defaultEngineCpp = cppName;
        return {
            kind: "engine",
            cpp: cppName,
            engineCpp: cppName,
            msaaSamples,
        };
    }

    public allocateTemporaryCppName(label: string): string {
        while (true) {
            const candidate =
                `v_bblite_${label}_${this.temporaryIndex++}`;
            if (!this.sourceCppNames.has(candidate)) {
                this.sourceCppNames.add(candidate);
                return candidate;
            }
        }
    }

    public allocateUserFunctionPrefix(): string {
        return `fn${this.temporaryIndex++}_`;
    }

    public allocateBlockPrefix(): string {
        return `${this.cppNamePrefixes.at(-1) ?? ""}block${this.temporaryIndex++}_`;
    }

    private compileStaticString(expression: ts.Expression): string {
        return this.compileStringLiteral(expression);
    }

    public resolveStaticExpression(
        expression: ts.Expression,
        resolving: ReadonlySet<ts.Symbol> = new Set(),
    ): ts.Expression {
        return this.evaluator.resolveStaticExpression(
            expression,
            resolving,
        );
    }

    public lookupIdentifierValue(
        identifier: ts.Identifier,
    ): Value | undefined {
        return this.lookupOptional(identifier);
    }

    public compileTypedArrayArgument(
        expression: ts.Expression,
        kind: "f32array" | "u32array",
    ): string {
        return this.dataLowerer.compileForSink(
            expression,
            { kind },
        );
    }

    public probeStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression | undefined {
        const resolved =
            this.resolveStaticExpression(expression);
        return ts.isArrayLiteralExpression(resolved)
            ? resolved
            : undefined;
    }

    public cppLocalName(sourceName: string): string {
        return this.cppIdentifier(sourceName);
    }

    public isEntrySourceFile(
        file: ts.SourceFile,
    ): boolean {
        return file === this.sourceFile;
    }

    public reachJsData(): void {
        this.jsDataReached = true;
    }

    public snapshotAliasState(): Map<string, string> {
        return this.dataLowerer.snapshotAliasState();
    }

    public restoreAliasState(
        snapshot: Map<string, string>,
    ): void {
        this.dataLowerer.restoreAliasState(snapshot);
    }

    public defineThis(instance: Value | undefined): void {
        this.thisInstance = instance;
    }

    /**
     * True when an identifier names a local function declaration, so a
     * record property holding it is a method rather than a value.
     */
    public namesLocalFunction(
        identifier: ts.Identifier,
    ): boolean {
        if (this.lookupOptional(identifier)) {
            // A bound value wins: a local shadowing a function name is
            // that local.
            return false;
        }
        // A shorthand property's own identifier resolves to the
        // literal's property symbol, so the value symbol is what says
        // which declaration the name actually refers to.
        const symbol = this.symbols.valueSymbol(identifier);
        return (symbol?.declarations ?? []).some(
            (declaration) =>
                ts.isFunctionDeclaration(declaration) &&
                declaration.body !== undefined,
        );
    }

    /**
     * The value a property access reads out of a compile-time record,
     * or undefined when the owner is not one. Asking rather than
     * asserting, so the data lowerer can probe a path it may not own.
     */
    public resolveRecordMember(
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        const ownerExpression = this.unwrap(
            expression.expression,
        );
        const owner = ts.isIdentifier(ownerExpression)
            ? this.lookupOptional(ownerExpression)
            : ownerExpression.kind ===
                ts.SyntaxKind.ThisKeyword
              ? this.activeThis()
              : undefined;
        if (owner?.kind !== "record") {
            return undefined;
        }
        const accessor =
            owner.recordGetters?.[expression.name.text];
        if (accessor) {
            return this.compileRecordGetter(
                owner,
                accessor,
            );
        }
        return owner.recordProperties?.[
            expression.name.text
        ];
    }

    /**
     * Runs `work` with a record's captured scope chain in force, so a
     * method or getter of that record sees the state it closed over
     * even when the scope that built it has since been left.
     */
    private withRecordScopes<T>(
        owner: Value,
        work: () => T,
    ): T {
        if (!owner.recordScopes) {
            return work();
        }
        const saved = [...this.variableScopes];
        this.variableScopes.length = 0;
        this.variableScopes.push(...owner.recordScopes);
        try {
            return work();
        } finally {
            this.variableScopes.length = 0;
            this.variableScopes.push(...saved);
        }
    }

    /**
     * Reads a record getter by evaluating its accessor at the read
     * site, with the record's own scope restored. The subset covers
     * the shape the reached records use: a single `return` of an
     * expression over the state the record closed over.
     */
    private compileRecordGetter(
        owner: Value,
        accessor: ts.GetAccessorDeclaration,
    ): Value {
        const statements =
            accessor.body?.statements ?? [];
        const [only] = statements;
        if (
            statements.length !== 1 ||
            !only ||
            !ts.isReturnStatement(only) ||
            !only.expression
        ) {
            this.fail(
                accessor,
                `Getter '${accessor.name.getText()}' must be a single return statement.`,
            );
        }
        const expression = only.expression;
        return this.withRecordScopes(owner, () =>
            this.compileValue(expression),
        );
    }

    /**
     * Binds a class field to storage. A field whose declared type is
     * in the data model gets a real local of that type, so an array
     * field is a vector rather than the static tuple its empty literal
     * would otherwise fold to.
     */
    public bindClassField(
        name: ts.Identifier,
        initializer: ts.Expression,
    ): void {
        const dataType =
            this.dataLowerer.dataTypeAt(name);
        if (dataType) {
            const cppName = this.cppIdentifier(name.text);
            const cpp = this.dataLowerer.compileForSink(
                initializer,
                dataType,
            );
            this.emit(
                `${this.dataTypes.cppType(dataType)} ${cppName} = ${cpp};`,
            );
            this.dataLowerer.registerLocal(
                cppName,
                "owned",
            );
            // Numeric and boolean leaves keep their scalar kinds so
            // arithmetic and conditions treat them like any local.
            this.defineVariable(name, {
                kind:
                    dataType.kind === "number"
                        ? "number"
                        : dataType.kind === "boolean"
                          ? "boolean"
                          : "data",
                cpp: cppName,
                dataType,
            });
            return;
        }
        this.bindLocalValue(
            name,
            this.compileValue(initializer),
        );
    }

    public resolveThisField(
        name: string,
    ): Value | undefined {
        return this.thisInstance?.recordProperties?.[name];
    }

    public activeThis(): Value | undefined {
        return this.thisInstance;
    }

    public registerClassInstance(
        instance: Value,
        declaration: ts.ClassDeclaration,
    ): void {
        this.classInstances.set(instance, declaration);
    }

    public classOf(
        instance: Value,
    ): ts.ClassDeclaration | undefined {
        return this.classInstances.get(instance);
    }

    public defaultEngine(): string | undefined {
        return this.defaultEngineCpp;
    }

    public reachJsRandom(): void {
        this.jsRandomReached = true;
    }

    /**
     * Runs an emission body with indentation reset to column zero and
     * returns the produced lines, removing them from the main body stream.
     * Native function definitions and for-headers use this.
     */
    public captureEmittedLines(
        emitBody: () => void,
    ): string[] {
        const start = this.body.length;
        const previousIndent = this.indentLevel;
        this.indentLevel = 0;
        try {
            emitBody();
        } finally {
            this.indentLevel = previousIndent;
        }
        return this.body.splice(start);
    }

    public registerNativeFunction(
        prototype: string,
        definitionLines: string[],
    ): void {
        this.nativeFunctionPrototypes.push(prototype);
        this.nativeFunctionDefinitions.push(
            ...definitionLines,
            "",
        );
    }

    public beginNativeFunctionBody(
        returnType: DataType | undefined,
    ): void {
        this.returnFrames.push({
            kind: "native",
            type: returnType ?? "void",
        });
    }

    public endNativeFunctionBody(): void {
        this.returnFrames.pop();
    }

    public beginInlineFrame(wrapped: boolean): void {
        this.returnFrames.push({
            kind: "inline",
            wrapped,
        });
    }

    public endInlineFrame(): void {
        this.returnFrames.pop();
    }

    public activeNativeReturnType():
        | DataType
        | "void"
        | undefined {
        const top = this.returnFrames.at(-1);
        return top?.kind === "native"
            ? top.type
            : undefined;
    }

    public activeInlineWrapper(): boolean {
        const top = this.returnFrames.at(-1);
        return top?.kind === "inline" && top.wrapped;
    }

    public emitNativeReturn(
        statement: ts.ReturnStatement,
    ): void {
        const returnType = this.activeNativeReturnType();
        if (returnType === undefined) {
            this.fail(
                statement,
                "Return outside a native function.",
            );
        }
        if (returnType === "void") {
            if (statement.expression) {
                this.fail(
                    statement.expression,
                    "Void functions cannot return a value.",
                );
            }
            this.emit("return;");
            return;
        }
        if (!statement.expression) {
            this.fail(
                statement,
                "Non-void native functions must return a value.",
            );
        }
        if (returnType.kind === "number") {
            this.emit(
                `return ${this.compileNumber(statement.expression, "double")};`,
            );
            return;
        }
        if (returnType.kind === "boolean") {
            this.emit(
                `return ${this.compileCondition(statement.expression)};`,
            );
            return;
        }
        this.emit(
            `return ${this.dataLowerer.compileForSink(statement.expression, returnType)};`,
        );
    }

    public emitDataAssignment(
        expression: ts.BinaryExpression,
    ): boolean {
        return this.dataLowerer.emitAssignment(
            expression,
        );
    }

    public emitDataPostfix(
        expression: ts.PostfixUnaryExpression,
    ): boolean {
        return this.dataLowerer.emitPostfixUnary(
            expression,
        );
    }

    public dataIterationTarget(
        expression: ts.Expression,
    ):
        | { container: Value; element: DataType }
        | undefined {
        return this.dataLowerer.iterationTarget(
            expression,
        );
    }

    /**
     * Recognises `<scene>.meshes` as an iteration source. The scene keeps
     * handles rather than data, so this hands the loop the scene and engine
     * it needs and lets the statement lowering bind a mesh value.
     */
    public sceneMeshIterationTarget(
        expression: ts.Expression,
    ): { sceneCpp: string; engineCpp: string } | undefined {
        const unwrapped = this.unwrap(expression);
        if (
            !ts.isPropertyAccessExpression(unwrapped) ||
            unwrapped.name.text !== "meshes"
        ) {
            return undefined;
        }
        const owner = this.compileValue(unwrapped.expression);
        if (owner.kind !== "scene") {
            return undefined;
        }
        return {
            sceneCpp: owner.cpp,
            engineCpp: this.requireEngine(owner, unwrapped),
        };
    }

    public bindDataIterationVariable(
        name: ts.BindingName,
        itemCpp: string,
        element: DataType,
    ): void {
        this.dataLowerer.bindIterationVariable(
            name,
            itemCpp,
            element,
            (identifier, value) =>
                this.defineVariable(identifier, value),
        );
    }

    public registerAsset(
        source: string,
        kind: CompileAsset["kind"],
        faceSize?: number,
    ): CompileAsset {
        source = this.resolveBundledAsset(source);
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
                : kind === "dds-environment"
                    ? sourceName.replace(/\.dds$/i, ".bblhdr")
                // A drawn atlas names the module that draws it; what lands
                // beside the executable is the PNG that module returns.
                : kind === "sprite-atlas"
                    ? `${basenameWithoutExtension(sourceName)}.png`
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

    /**
     * A sprite atlas that is DRAWN rather than fetched.
     *
     * `getSpriteAtlasDataUrl()` builds its image with canvas2D and returns a
     * data URL, so there is no URL to materialize and no pixels to lower.
     * The call resolves to the module that draws them, and generation runs
     * that module in headless Chromium and bakes the PNG it returns — the
     * same executable route the pinned GGX prefilter already takes.
     */
    public registerSpriteAtlasAsset(
        expression: ts.Expression,
    ): string {
        const unwrapped = this.unwrap(expression);
        if (ts.isCallExpression(unwrapped)) {
            const callee = this.unwrap(unwrapped.expression);
            const modulePath = ts.isIdentifier(callee)
                ? this.symbols.declarationSourcePath(callee)
                : undefined;
            if (modulePath && ts.isIdentifier(callee)) {
                if (unwrapped.arguments.length !== 0) {
                    this.fail(
                        unwrapped,
                        "A drawn sprite atlas factory takes no arguments.",
                    );
                }
                const root = findRepositoryRoot(
                    dirname(resolve(this.options.fileName)),
                );
                const asset = this.registerAsset(
                    spriteAtlasAssetSource(
                        relative(root, modulePath)
                            .split(sep)
                            .join("/"),
                        callee.text,
                    ),
                    "sprite-atlas",
                );
                return this.cppString(asset.output);
            }
        }
        // A plain URL still works: the atlas is an image either way.
        const url = this.compileStringLiteral(expression);
        return this.cppString(
            this.registerAsset(url, "texture").output,
        );
    }

    public resolveBundledAsset(source: string): string {
        if (source === "/brdf-lut.png") {
            const pin = readUpstreamPin();
            return `https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/${pin.sourceVersion}/packages/babylon-lite/assets/brdf-lut.png`;
        }
        if (source.startsWith("/")) {
            // Root-relative asset paths always mean the pinned lab/public
            // root: corpus scenes and project-owned gates share the demo
            // asset conventions, and repository-local fixtures use
            // relative paths instead.
            const pin = readUpstreamPin();
            return (
                "https://raw.githubusercontent.com/" +
                `BabylonJS/Babylon-Lite/${pin.sourceVersion}` +
                `/lab/public${source}`
            );
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

    /**
     * `canvas.width` / `canvas.height` on the render canvas.
     *
     * The canvas itself is browser-only, but its size is not: it is the
     * size the drawing surface was created at, which native names as the
     * engine's own options. Scene code reads it to lay content out in
     * pixels (the pinned sprite grid centres itself in it), so the read
     * has to produce a number rather than being erased with its owner.
     */
    private canvasSizeProperty(
        expression: ts.Expression,
    ): "width" | "height" | undefined {
        const unwrapped = this.unwrap(expression);
        if (
            !ts.isPropertyAccessExpression(unwrapped) ||
            (unwrapped.name.text !== "width" &&
                unwrapped.name.text !== "height")
        ) {
            return undefined;
        }
        const ownerType = this.checker.getTypeAtLocation(
            unwrapped.expression,
        );
        return ownerType.getSymbol()?.getName() ===
            "HTMLCanvasElement"
            ? unwrapped.name.text
            : undefined;
    }

    public canvasSizeValue(
        expression: ts.Expression,
    ): Value | undefined {
        const property =
            this.canvasSizeProperty(expression);
        return property
            ? {
                  kind: "number",
                  cpp: `static_cast<double>(${this.requireDefaultEngine(
                      expression,
                  )}.options.${property})`,
                  dataType: { kind: "number" },
              }
            : undefined;
    }

    public isBrowserOnlyExpression(expression: ts.Expression): boolean {
        const unwrapped = this.unwrap(expression);
        if (this.canvasSizeProperty(unwrapped)) {
            return false;
        }
        if (ts.isIdentifier(unwrapped)) {
            if (
                [
                    "console",
                    "document",
                    "performance",
                    "window",
                ].includes(unwrapped.text)
            ) {
                return true;
            }
            return (
                this.lookupOptional(unwrapped)?.kind ===
                "browser"
            );
        }
        if (
            ts.isNewExpression(unwrapped) &&
            ts.isIdentifier(unwrapped.expression) &&
            unwrapped.expression.text === "URLSearchParams"
        ) {
            return true;
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            return this.isBrowserOnlyExpression(
                unwrapped.expression,
            );
        }
        if (ts.isBinaryExpression(unwrapped)) {
            return (
                this.isBrowserOnlyExpression(
                    unwrapped.left,
                ) ||
                this.isBrowserOnlyExpression(
                    unwrapped.right,
                )
            );
        }
        if (ts.isPrefixUnaryExpression(unwrapped)) {
            return this.isBrowserOnlyExpression(
                unwrapped.operand,
            );
        }
        if (ts.isCallExpression(unwrapped)) {
            if (
                ts.isPropertyAccessExpression(
                    unwrapped.expression,
                ) &&
                this.isBrowserOnlyExpression(
                    unwrapped.expression.expression,
                )
            ) {
                return true;
            }
            const browserArgument =
                unwrapped.arguments.some((argument) =>
                    this.isBrowserOnlyExpression(argument),
                );
            if (
                ts.isIdentifier(unwrapped.expression) &&
                ["isNaN", "parseFloat"].includes(
                    unwrapped.expression.text,
                )
            ) {
                return browserArgument;
            }
            if (
                ts.isPropertyAccessExpression(
                    unwrapped.expression,
                ) &&
                ts.isIdentifier(
                    unwrapped.expression.expression,
                ) &&
                unwrapped.expression.expression.text ===
                    "Number" &&
                unwrapped.expression.name.text === "isFinite"
            ) {
                return browserArgument;
            }
            return false;
        }
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

    public evaluateBrowserCondition(
        expression: ts.Expression,
    ): boolean | undefined {
        const value =
            this.evaluateBrowserValue(expression);
        return value?.kind === "boolean"
            ? value.value
            : undefined;
    }

    private evaluateBrowserValue(
        expression: ts.Expression,
    ): Value["browserValue"] | undefined {
        const unwrapped = this.unwrap(expression);
        if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) {
            return { kind: "boolean", value: true };
        }
        if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) {
            return { kind: "boolean", value: false };
        }
        if (unwrapped.kind === ts.SyntaxKind.NullKeyword) {
            return { kind: "null" };
        }
        if (ts.isStringLiteral(unwrapped)) {
            return {
                kind: "string",
                value: unwrapped.text,
            };
        }
        if (ts.isNumericLiteral(unwrapped)) {
            return {
                kind: "number",
                value: Number(unwrapped.text),
            };
        }
        if (ts.isIdentifier(unwrapped)) {
            return this.lookupOptional(unwrapped)
                ?.browserValue;
        }
        if (
            ts.isNewExpression(unwrapped) &&
            ts.isIdentifier(unwrapped.expression) &&
            unwrapped.expression.text === "URLSearchParams"
        ) {
            return { kind: "search-params" };
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.name.text === "search" &&
            ts.isPropertyAccessExpression(
                unwrapped.expression,
            ) &&
            unwrapped.expression.name.text === "location" &&
            ts.isIdentifier(
                unwrapped.expression.expression,
            ) &&
            unwrapped.expression.expression.text === "window"
        ) {
            return { kind: "string", value: "" };
        }
        if (
            ts.isPrefixUnaryExpression(unwrapped) &&
            unwrapped.operator ===
                ts.SyntaxKind.ExclamationToken
        ) {
            const operand = this.evaluateBrowserValue(
                unwrapped.operand,
            );
            const truthy = this.browserTruthy(operand);
            return truthy === undefined
                ? undefined
                : { kind: "boolean", value: !truthy };
        }
        if (ts.isBinaryExpression(unwrapped)) {
            const left = this.evaluateBrowserValue(
                unwrapped.left,
            );
            if (
                unwrapped.operatorToken.kind ===
                ts.SyntaxKind.AmpersandAmpersandToken
            ) {
                const truthy = this.browserTruthy(left);
                if (truthy === false) {
                    return {
                        kind: "boolean",
                        value: false,
                    };
                }
                return truthy
                    ? this.evaluateBrowserValue(
                          unwrapped.right,
                      )
                    : undefined;
            }
            if (
                unwrapped.operatorToken.kind ===
                ts.SyntaxKind.BarBarToken
            ) {
                const truthy = this.browserTruthy(left);
                if (truthy === true) {
                    return left;
                }
                return truthy === false
                    ? this.evaluateBrowserValue(
                          unwrapped.right,
                      )
                    : undefined;
            }
            return undefined;
        }
        if (ts.isCallExpression(unwrapped)) {
            if (
                ts.isPropertyAccessExpression(
                    unwrapped.expression,
                ) &&
                ts.isIdentifier(
                    unwrapped.expression.expression,
                )
            ) {
                const owner = this.lookupOptional(
                    unwrapped.expression.expression,
                )?.browserValue;
                if (owner?.kind === "search-params") {
                    if (
                        unwrapped.expression.name.text ===
                        "has"
                    ) {
                        return {
                            kind: "boolean",
                            value: false,
                        };
                    }
                    if (
                        unwrapped.expression.name.text ===
                        "get"
                    ) {
                        return { kind: "null" };
                    }
                }
            }
            if (
                ts.isIdentifier(unwrapped.expression) &&
                unwrapped.expression.text === "parseFloat"
            ) {
                const argument =
                    this.evaluateBrowserValue(
                        unwrapped.arguments[0]!,
                    );
                const text =
                    argument?.kind === "string"
                        ? argument.value
                        : "";
                return {
                    kind: "number",
                    value: Number.parseFloat(text),
                };
            }
            if (
                ts.isIdentifier(unwrapped.expression) &&
                unwrapped.expression.text === "isNaN"
            ) {
                const argument =
                    this.evaluateBrowserValue(
                        unwrapped.arguments[0]!,
                    );
                return argument?.kind === "number"
                    ? {
                          kind: "boolean",
                          value: Number.isNaN(
                              argument.value,
                          ),
                      }
                    : undefined;
            }
            if (
                ts.isPropertyAccessExpression(
                    unwrapped.expression,
                ) &&
                ts.isIdentifier(
                    unwrapped.expression.expression,
                ) &&
                unwrapped.expression.expression.text ===
                    "Number" &&
                unwrapped.expression.name.text === "isFinite"
            ) {
                const argument =
                    this.evaluateBrowserValue(
                        unwrapped.arguments[0]!,
                    );
                return argument?.kind === "number"
                    ? {
                          kind: "boolean",
                          value: Number.isFinite(
                              argument.value,
                          ),
                      }
                    : undefined;
            }
        }
        return undefined;
    }

    private browserTruthy(
        value: Value["browserValue"] | undefined,
    ): boolean | undefined {
        if (!value) {
            return undefined;
        }
        switch (value.kind) {
            case "boolean":
                return value.value;
            case "null":
                return false;
            case "number":
                return (
                    value.value !== 0 &&
                    !Number.isNaN(value.value)
                );
            case "search-params":
                return true;
            case "string":
                return value.value.length > 0;
        }
    }

    public isBrowserInstrumentationCall(call: ts.CallExpression): boolean {
        const objectAssign =
            ts.isPropertyAccessExpression(call.expression) &&
            ts.isIdentifier(call.expression.expression) &&
            call.expression.expression.text === "Object" &&
            call.expression.name.text === "assign";
        const deviceEvent =
            ts.isPropertyAccessExpression(call.expression) &&
            call.expression.name.text ===
                "addEventListener" &&
            ts.isPropertyAccessExpression(
                call.expression.expression,
            ) &&
            call.expression.expression.name.text ===
                "_device";
        return objectAssign || deviceEvent;
    }

    private lookupOptional(
        identifier: ts.Identifier,
    ): Value | undefined {
        const symbol =
            this.symbols.valueSymbol(identifier);
        if (!symbol) {
            return undefined;
        }
        for (
            let index = this.variableScopes.length - 1;
            index >= 0;
            index -= 1
        ) {
            const binding =
                this.variableScopes[index]!.get(symbol);
            if (binding) {
                return binding.value;
            }
        }
        return undefined;
    }

    private lookupRecordProperty(
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        if (
            ts.isPropertyAccessExpression(
                expression.expression,
            )
        ) {
            // A path resolves one link at a time, through this same
            // non-throwing lookup: an owner nobody here can name is
            // still the data lowerer's to try, not an error.
            const nested = this.lookupRecordProperty(
                expression.expression,
            );
            return nested
                ? this.readOwnerProperty(
                      nested,
                      expression,
                  )
                : undefined;
        }
        if (!ts.isIdentifier(expression.expression)) {
            return undefined;
        }
        const owner = this.lookupOptional(
            expression.expression,
        ) ?? (() => {
            const resolved =
                this.resolveStaticExpression(
                    expression.expression,
                );
            return resolved !== expression.expression
                ? this.compileValue(resolved)
                : undefined;
        })();
        return owner
            ? this.readOwnerProperty(owner, expression)
            : undefined;
    }

    /**
     * One link of a path, once the owner is resolved. Every read site
     * ends here -- the general property path, the static evaluator's
     * lookup, and each nested link -- so a path resolves the same way
     * wherever it is written and however deep it goes. The readings that
     * are not a declared field lookup live here because they are what
     * differs, and each used to sit in only one of the two paths:
     * `camera.target` and the geometry-task outputs resolved in an
     * expression but not in a numeric context.
     *
     * A record owner is the exception: this returns the property or
     * nothing, because the lookup path must stay non-throwing for the
     * data lowerer to try next. The general path handles records itself,
     * where a missing property is an error with a message.
     */
    private readOwnerProperty(
        owner: Value,
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        if (owner.kind === "record") {
            return owner.recordProperties?.[
                expression.name.text
            ];
        }
        // The same table the general property path reads. Keeping a
        // second copy here is what made `camera.ortho.halfHeight`
        // resolve in an expression but not in a numeric context: the
        // copy was never told about the orthographic bounds.
        const declared = readProperty(
            this,
            owner,
            expression.name.text,
            expression,
        );
        if (declared) {
            return declared;
        }
        if (
            owner.kind === "tuple" &&
            expression.name.text === "length"
        ) {
            const length =
                owner.tupleElements?.length ?? 0;
            return {
                kind: "number",
                cpp: `${length}.0f`,
                staticNumber: length,
            };
        }
        if (
            owner.kind === "engine" &&
            expression.name.text === "msaaSamples"
        ) {
            return {
                kind: "number",
                cpp: `${owner.msaaSamples ?? 4}.0f`,
                staticNumber: owner.msaaSamples ?? 4,
            };
        }
        if (
            owner.kind === "camera" &&
            expression.name.text === "target"
        ) {
            // Not a field but three of them: the record this synthesizes
            // is what makes `camera.target.x` and destructuring it read
            // the same components.
            const record = `${this.requireEngine(owner, expression)}.cameras[${owner.cpp}.value]`;
            const component = (
                name: "x" | "y" | "z",
            ): Value => ({
                kind: "number",
                cpp: `${record}.target.${name}`,
                ...(owner.engineCpp
                    ? { engineCpp: owner.engineCpp }
                    : {}),
            });
            return {
                kind: "record",
                cpp: "",
                recordProperties: {
                    x: component("x"),
                    y: component("y"),
                    z: component("z"),
                },
            };
        }
        if (owner.kind === "task" && owner.geometryTask) {
            return this.readGeometryTaskProperty(
                owner,
                owner.geometryTask,
                expression,
            );
        }
        return undefined;
    }

    /**
     * A geometry task's outputs, which are gated on what the task was
     * asked to write rather than on the property name alone.
     */
    private readGeometryTaskProperty(
        owner: Value,
        task: GeometryOutputTaskManifest,
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        const property = expression.name.text;
        const engineCpp = owner.engineCpp
            ? { engineCpp: owner.engineCpp }
            : {};
        if (property === "outputTexture") {
            if (!task.emitColor) {
                this.fail(
                    expression,
                    "Geometry task has no targetTexture output.",
                );
            }
            return {
                kind: "render-texture",
                cpp: `bbl::geometry_task_output_texture(${owner.cpp})`,
                ...engineCpp,
            };
        }
        const geometryProperties: Record<
            string,
            GeometryTextureTypeName
        > = {
            geometryIrradianceTexture: "IRRADIANCE",
            geometryWorldPositionTexture: "WORLD_POSITION",
            geometryLocalPositionTexture: "LOCAL_POSITION",
            geometryReflectivityTexture: "REFLECTIVITY",
            geometryViewDepthTexture: "VIEW_DEPTH",
            geometryNormalizedViewDepthTexture:
                "NORMALIZED_VIEW_DEPTH",
            geometryScreenspaceDepthTexture:
                "SCREENSPACE_DEPTH",
            geometryViewNormalTexture: "VIEW_NORMAL",
            geometryWorldNormalTexture: "WORLD_NORMAL",
            geometryAlbedoTexture: "ALBEDO",
            geometryLinearVelocityTexture: "LINEAR_VELOCITY",
        };
        const type = geometryProperties[property];
        if (!type) {
            return undefined;
        }
        if (!task.attachments.includes(type)) {
            this.fail(
                expression,
                `Geometry task did not request ${type}.`,
            );
        }
        return {
            kind: "render-texture",
            cpp: `bbl::geometry_task_texture(${owner.cpp}, bbl::GeometryTextureType::${this.geometryEnumMember(type)})`,
            ...engineCpp,
        };
    }

    public unwrap(expression: ts.Expression): ts.Expression {
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
        if (this.jsDataReached) {
            adaptations.push({
                id: "plain-data-value-model",
                category: "language",
                sourceSemantics: "JavaScript objects and arrays are heap references with garbage collection; sparse arrays read undefined.",
                nativeSemantics: "Plain-data objects compile to structs and vectors: a const local bound to an element or member binds a native reference, so writes through it reach the container, while a mutable local stays a copy that rejects writes; function object parameters pass by native reference; new Array elements zero-initialize. A structural mutation of a container makes references taken into it unusable, and later use is a compile error rather than a dangling read.",
                risk: "medium",
                validation: ["compiler data-model tests", "differential logic parity gates"],
            });
        }
        if (this.jsRandomReached) {
            adaptations.push({
                id: "deterministic-seeded-random",
                category: "determinism",
                sourceSemantics: "Math.random draws from the host's nondeterministic generator.",
                nativeSemantics: "Math.random lowers to a pinned mulberry32 sequence (seed 1); the browser reference capture installs the identical generator before module load.",
                risk: "medium",
                validation: ["seeded-random unit tests", "deterministic parity gates"],
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
        if (
            [...this.assets.values()].some(
                (asset) => asset.kind === "sprite-atlas",
            )
        ) {
            adaptations.push({
                id: "drawn-sprite-atlas",
                category: "asset-materialization",
                sourceSemantics:
                    "The atlas is drawn at run time with canvas2D and handed to loadSpriteAtlas as a data URL.",
                nativeSemantics:
                    "Generation runs the same module in headless Chromium and bakes the PNG it returns, so the pixels are a browser rasterizer's rather than a reimplementation. The bytes depend on the Chrome that compiled them, exactly as the pinned GGX prefilter already does.",
                risk: "medium",
                validation: [
                    "scene 50 parity against the browser golden",
                    "byte-stable across repeated compilations",
                ],
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
        if (this.reachedShaderPrograms.length > 0) {
            adaptations.push({
                id: "typed-reached-shader-variants",
                category: "rendering",
                sourceSemantics: `Babylon Lite composes the reached custom WGSL shader variant(s): ${this.reachedShaderPrograms.map(({ name }) => name).join(", ")}.`,
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
                nativeSemantics: "Generated task records preserve cameras, material overrides, geometry attachment order, depth-only targets, shader semantics, and source-derived integer viewport/scissor bounds while PAL executes SDL_GPU passes, reverse-depth views, MSAA resolve, and viewport blits.",
                risk: "high",
                validation: [
                    "geometry task compiler tests",
                    "pinned geometry shader marker tests",
                    "scene 116/145/146 native/reference parity",
                ],
            });
        }
        if (this.defaultRenderTaskAdapted) {
            adaptations.push({
                id: "readable-default-render-task",
                category: "rendering",
                sourceSemantics:
                    "Babylon Lite creates a default scene render task that resolves directly to the swapchain.",
                nativeSemantics:
                    "The compiler creates an equivalent readable MSAA target, resolves it to a single-sample target, then presents it so SDL_GPU screenshot capture never reads the swapchain.",
                risk: "medium",
                validation: [
                    "default render-task compiler test",
                    "scene 116 exact-source parity",
                ],
            });
        }
        return adaptations;
    }

    public lookup(identifier: ts.Identifier): Value {
        const symbol =
            this.symbols.valueSymbol(identifier);
        if (!symbol) {
            this.fail(
                identifier,
                `Unknown or unsupported variable '${identifier.text}'.`,
            );
        }
        for (
            let index = this.variableScopes.length - 1;
            index >= 0;
            index -= 1
        ) {
            const binding =
                this.variableScopes[index]!.get(symbol);
            if (binding) {
                return binding.value;
            }
        }
        this.fail(
            identifier,
            `Unknown or unsupported variable '${identifier.text}'.`,
        );
    }

    public defineVariable(
        identifier: ts.Identifier,
        value: Value,
    ): void {
        const symbol =
            this.symbols.valueSymbol(identifier);
        if (!symbol) {
            this.fail(
                identifier,
                `Unable to resolve variable '${identifier.text}'.`,
            );
        }
        const scope = this.variableScopes.at(-1)!;
        if (scope.has(symbol)) {
            this.fail(
                identifier,
                `Variable shadowing is not supported for '${identifier.text}' in the same scope.`,
            );
        }
        scope.set(symbol, {
            name: identifier.text,
            value,
        });
    }

    public bindLocalValue(
        identifier: ts.Identifier,
        value: Value,
    ): void {
        this.bindLocalOrParameterValue(
            identifier,
            value,
            false,
        );
    }

    /**
     * Binds an inlined user-function parameter. Unlike local
     * declarations (the pinned value model copies path-bound locals),
     * JavaScript object arguments alias, and the native-function path
     * already passes struct/vector/typed-array parameters by reference
     * — so the inline path binds through a forwarding reference:
     * lvalue arguments alias the caller's binding (writes through the
     * parameter mutate it) while temporaries stay owned.
     */
    public bindParameterValue(
        identifier: ts.Identifier,
        value: Value,
    ): void {
        this.bindLocalOrParameterValue(
            identifier,
            value,
            true,
        );
    }

    private bindLocalOrParameterValue(
        identifier: ts.Identifier,
        value: Value,
        parameter: boolean,
    ): void {
        if (value.kind === "void") {
            this.fail(
                identifier,
                `Variable '${identifier.text}' cannot receive void.`,
            );
        }
        if (value.kind === "browser") {
            this.defineVariable(identifier, value);
            return;
        }
        if (
            value.kind === "tuple" ||
            value.kind === "record" ||
            value.kind === "string" ||
            value.kind === "callback"
        ) {
            this.defineVariable(identifier, value);
            return;
        }
        const cppName = this.cppIdentifier(
            identifier.text,
        );
        const reference =
            value.kind === "engine" ||
            value.kind === "scene";
        const nativeType = reference
            ? "auto&"
            : value.kind === "number"
              ? "double"
              : value.kind === "boolean"
                ? "bool"
                : parameter
                  ? "auto&&"
                  : "auto";
        const initializerCpp =
            value.kind === "number" &&
            value.staticNumber !== undefined
                ? Number.isInteger(value.staticNumber)
                    ? `${value.staticNumber}.0`
                    : `${value.staticNumber}`
                : value.cpp;
        const maybeUnused =
            value.kind === "boolean"
                ? "[[maybe_unused]] "
                : "";
        this.emit(
            `${maybeUnused}${nativeType} ${cppName} = ${initializerCpp};`,
        );
        const stored: Value = {
            ...value,
            cpp: cppName,
        };
        if (value.kind === "animation-clip") {
            stored.animationFrameRate =
                `${cppName}.frame_rate`;
            stored.animationDuration =
                `${cppName}.duration`;
        }
        this.defineVariable(identifier, stored);
    }

    private visibleValues(): Value[] {
        const names = new Set<string>();
        const result: Value[] = [];
        for (
            let index = this.variableScopes.length - 1;
            index >= 0;
            index -= 1
        ) {
            for (const binding of this.variableScopes[
                index
            ]!.values()) {
                if (!names.has(binding.name)) {
                    names.add(binding.name);
                    result.push(binding.value);
                }
            }
        }
        return result;
    }

    public pushScope(cppPrefix: string): void {
        this.variableScopes.push(new Map());
        this.cppNamePrefixes.push(cppPrefix);
    }

    public popScope(): void {
        if (this.variableScopes.length === 1) {
            throw new Error(
                "Cannot pop the compiler root scope.",
            );
        }
        this.variableScopes.pop();
        this.cppNamePrefixes.pop();
    }

    public expectKind(value: Value, kind: ValueKind, node: ts.Node): void {
        if (value.kind !== kind) {
            this.fail(node, `Expected ${kind}, received ${value.kind}.`);
        }
    }

    public expectShaderVariant(
        value: Value,
        variant: string,
        node: ts.Node,
    ): void {
        if (value.shaderVariant !== variant) {
            this.fail(
                node,
                `Shader operation requires the '${variant}' reached variant.`,
            );
        }
    }

    public expectSameEngine(left: Value, right: Value, node: ts.Node): void {
        if (left.engineCpp && right.engineCpp && left.engineCpp !== right.engineCpp) {
            this.fail(node, "Values from different engines cannot be combined.");
        }
    }

    public requireEngine(value: Value, node: ts.Node): string {
        if (!value.engineCpp) {
            this.fail(node, `A ${value.kind} value is not associated with an engine.`);
        }
        return value.engineCpp;
    }

    public requireDefaultEngine(node: ts.Node): string {
        if (!this.defaultEngineCpp) {
            this.fail(node, "This intrinsic requires createEngine to run first.");
        }
        return this.defaultEngineCpp;
    }

    /**
     * Stamps setter options on the one scene-code material, the way the
     * pin's `setPbrSheen`/`setPbrClearCoat` stamp the props object onto the
     * material record. Identity beyond a single scene material is not
     * modeled, so more than one is a named failure rather than a guess.
     */
    private sceneMaterialForSetter(setter: string): ScenePbrMaterialManifest {
        if (this.scenePbrMaterials.length !== 1) {
            throw new Error(
                `${setter} targets one of ${this.scenePbrMaterials.length} ` +
                    "scene materials; setter identity beyond a single scene " +
                    "material is not modeled yet.",
            );
        }
        return this.scenePbrMaterials[0]!;
    }

    /**
     * Records a no-color view of the one scene material: the pin's view is
     * the same material record rendered with `PBR2_NO_COLOR_OUTPUT`, so the
     * derived entry copies its source and appends in creation order.
     */
    public recordScenePbrNoColorView(): void {
        const source = this.sceneMaterialForSetter(
            "createPbrNoColorMaterialView",
        );
        this.scenePbrMaterials.push({
            ...source,
            materialsBefore: this.recordSceneMaterialSlot(),
            noColorView: true,
        });
    }

    /**
     * Counts one scene-code material creation of any family. Every creator
     * bumps this: material handles are creation-ordered across families, so
     * a standard material shifts the next PBR handle.
     */
    public recordSceneMaterialSlot(): number {
        return this.sceneMaterialCount++;
    }

    public recordScenePbrUnlit(): void {
        this.sceneMaterialForSetter("setPbrUnlit").unlit = true;
    }

    public recordScenePbrSkybox(): void {
        this.sceneMaterialForSetter("setPbrSkybox").skyboxMode = true;
    }

    public recordScenePbrSheen(sheen: ScenePbrSheenManifest): void {
        this.sceneMaterialForSetter("setPbrSheen").sheen = sheen;
    }

    public recordScenePbrClearCoat(
        clearCoat: ScenePbrClearCoatManifest,
    ): void {
        this.sceneMaterialForSetter("setPbrClearCoat").clearCoat = clearCoat;
    }

    /** Records a scene-code mesh creation for the per-renderable variant key. */
    public recordSceneMesh(
        kind: string,
        streams?: {
            hasUv2: boolean;
            hasTangents: boolean;
            hasColors: boolean;
        },
    ): void {
        this.sceneMeshes.push({
            kind,
            gltfAssetsBefore: [...this.assets.values()].filter(
                (asset) => asset.kind === "gltf",
            ).length,
            ...(streams ?? {}),
        });
    }

    public reachFeature(feature: Feature): void {
        this.features.add(feature);
    }

    public ensureDefaultRenderTask(
        scene: Value,
        node: ts.Node,
    ): string | undefined {
        if (
            !scene.defaultRenderTask ||
            scene.defaultRenderTaskEmitted
        ) {
            return undefined;
        }
        scene.defaultRenderTaskEmitted = true;
        this.defaultRenderTaskAdapted = true;
        const engine = this.requireEngine(scene, node);
        this.reachFeature("renderer:pbr");
        this.reachFeature("renderer:geometry-output");
        const target =
            this.allocateTemporaryCppName(
                "default_target",
            );
        const resolveTarget =
            this.allocateTemporaryCppName(
                "default_resolve",
            );
        const renderTask =
            this.allocateTemporaryCppName(
                "default_render_task",
            );
        const resolveTask =
            this.allocateTemporaryCppName(
                "default_resolve_task",
            );
        const presentTask =
            this.allocateTemporaryCppName(
                "default_present_task",
            );
        return (
            `auto ${target} = bbl::create_render_target(${engine}, ` +
            `bbl::RenderTargetOptions{${scene.msaaSamples ?? 4}u, true, true, false, 0u, 0u});\n` +
            `        auto ${resolveTarget} = bbl::create_render_target(${engine}, ` +
            `bbl::RenderTargetOptions{1u, true, false, false, 0u, 0u});\n` +
            `        auto ${renderTask} = bbl::create_render_task(${engine}, ${scene.cpp}, ` +
            `bbl::RenderTaskOptions{"default-render-task", ` +
            `${target}, ` +
            `${scene.cpp}.clear_color, true, ` +
            `bbl::CameraHandle{}, false, true, true});\n` +
            `        bbl::add_task(${scene.cpp}, ${renderTask});\n` +
            `        auto ${resolveTask} = bbl::create_copy_to_texture_task(${engine}, ${scene.cpp}, ` +
            `bbl::CopyTaskOptions{"default-resolve", ` +
            `bbl::render_target_texture(${target}), ` +
            `bbl::RenderTargetHandle{}, ${resolveTarget}, false, ` +
            `bbl::NormalizedViewport{}});\n` +
            `        bbl::add_task(${scene.cpp}, ${resolveTask});\n` +
            `        auto ${presentTask} = bbl::create_copy_to_texture_task(${engine}, ${scene.cpp}, ` +
            `bbl::CopyTaskOptions{"default-present", ` +
            `bbl::render_target_texture(${resolveTarget}), ` +
            `bbl::swapchain_render_target(${engine}), ` +
            `bbl::RenderTargetHandle{}, false, ` +
            `bbl::NormalizedViewport{}});\n` +
            `        bbl::add_task(${scene.cpp}, ${presentTask})`
        );
    }

    public importedName(
        identifier: ts.Identifier,
    ): string | undefined {
        return this.symbols.importedName(identifier);
    }

    public eraseBrowserInstrumentation(
        position: number,
    ): void {
        this.erasedBrowserInstrumentation.add(position);
    }

    public recordGeometryOutputTask(
        manifest: GeometryOutputTaskManifest,
    ): void {
        this.geometryOutputTasks.push(manifest);
    }

    public requireDefaultScene(node: ts.Node): Value {
        const scenes = this.visibleValues().filter(
            (value) => value.kind === "scene",
        );
        if (scenes.length !== 1) {
            this.fail(
                node,
                "This intrinsic requires exactly one scene context.",
            );
        }
        return scenes[0]!;
    }

    public expectArgumentCount(call: ts.CallExpression, minimum: number, maximum: number): void {
        if (call.arguments.length < minimum || call.arguments.length > maximum) {
            const expected = minimum === maximum ? `${minimum}` : `${minimum}-${maximum}`;
            this.fail(call, `Expected ${expected} arguments, received ${call.arguments.length}.`);
        }
    }

    public cppIdentifier(sourceName: string): string {
        const prefix = this.cppNamePrefixes.at(-1) ?? "";
        return `v_${prefix}${sourceName.replace(/[^A-Za-z0-9_]/g, "_")}`;
    }

    public cppString(value: string): string {
        return JSON.stringify(value)
            .replace(/\u2028/g, "\\u2028")
            .replace(/\u2029/g, "\\u2029");
    }

    public emit(line: string): void {
        this.body.push(`${"    ".repeat(this.indentLevel)}${line}`);
    }

    public increaseIndent(): void {
        this.indentLevel += 1;
    }

    public decreaseIndent(): void {
        this.indentLevel -= 1;
    }

    private renderCpp(features: Feature[]): string {
        const cameraMathInclude =
            features.some((feature) =>
                feature.startsWith("camera:"),
            )
                ? "#include <bblite/upstream/camera_math.hpp>\n"
                : "";
        const jsDataInclude = this.jsDataReached
            ? "#include <bblite/js_data.hpp>\n"
            : "";
        const preambleSections: string[] = [];
        const dataPreamble =
            this.dataTypes.renderPreamble();
        if (dataPreamble.length > 0) {
            preambleSections.push(dataPreamble);
        }
        if (this.nativeFunctionPrototypes.length > 0) {
            preambleSections.push(
                [
                    "namespace bblscene {",
                    "",
                    ...this.nativeFunctionPrototypes,
                    "",
                    ...this.nativeFunctionDefinitions,
                    "}  // namespace bblscene",
                ].join("\n"),
            );
        }
        const preamble =
            preambleSections.length > 0
                ? `\n${preambleSections.join("\n\n")}\n`
                : "";
        const seedRandom = this.jsRandomReached
            ? "        bbl::js::seed_random(1u);\n"
            : "";
        return `// Generated by bblitec. Do not edit.
#include <bblite/runtime.hpp>
${jsDataInclude}${cameraMathInclude}
#include <cmath>
#include <exception>
#include <iostream>
${preamble}
int main() {
    try {
${seedRandom}${this.body.join("\n")}
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

    public fail(node: ts.Node, message: string): never {
        const file = node.getSourceFile();
        const position =
            file.getLineAndCharacterOfPosition(
                node.getStart(file),
            );
        throw new CompileError(
            file === this.sourceFile
                ? this.options.fileName
                : file.fileName,
            position.line + 1,
            position.character + 1,
            message,
        );
    }

    private failAtFile(message: string): never {
        throw new CompileError(this.options.fileName, 1, 1, message);
    }
}
