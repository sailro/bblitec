// Node-material lowering: the graph a scene hands the pin, read statically.
//
// `parseNodeMaterialFromSnippet` either fetches a snippet or takes the graph
// inline. Only the inline form reaches native, because a fetch is a network
// read at page load and generation has no later moment to perform it in --
// the same boundary every other asset crosses, except that a graph is not a
// URL to materialize but a value already present in the source.
//
// The corpus writes that value two ways, and each gets the answer it deserves.
// A module exporting the object outright is read here as data: object, array,
// string, number, boolean and null, and nothing else -- the fold, because a
// literal cannot drift. A module that BUILDS its graph at load, through id
// counters, spread-composed inputs and arrays it pushes into, is code this
// compiler does not lower; that one is executed at generation, the way a drawn
// atlas and a computed pixel buffer are, and only the module and export travel
// from here.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { pinnedLibraryRoot } from "../pinned-shader-composer.js";
import {
    staticGraphDocument,
    type ExecutedModuleReferenceContext,
} from "./assets.js";
import {
    staticNumberValue,
    validateObjectProperties,
    type ObjectValidationContext,
    type PositiveIntegerContext,
} from "./option-helpers.js";
import { babylonPackages } from "./symbols.js";
import {
    resolveFunctionDeclaration,
    unwrapExpression as unwrapLoaderExpression,
} from "./user-functions.js";
import type {
    CompiledNodeMaterial,
    NodeMaterialBlockEmitter,
    NodeShadowLight,
    Value,
} from "./types.js";

export interface NodeMaterialContext
    extends ObjectValidationContext,
        PositiveIntegerContext,
        ExecutedModuleReferenceContext {
    readonly checker: ts.TypeChecker;
    readonly reachedNodeMaterials: CompiledNodeMaterial[];
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
    compileStaticString(expression: ts.Expression): string;
    compileValue(expression: ts.Expression): Value;
    expectKind(
        value: Value,
        kind: Value["kind"],
        node: ts.Node,
    ): void;
    expectStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression;
    /** The filter and light slot one recorded generator was built with. */
    shadowGeneratorLight(
        index: number,
        node: ts.Node,
    ): { lightIndex: number };
}

/** One entry of a call's `textures`, under the binding name it is keyed by. */
export interface NodeMaterialTexture {
    /** The pin's own binding name -- `options.textures` is keyed by it. */
    name: string;
    /** The `loadTexture2D` value the scene supplied for that binding. */
    texture: Value;
}

/** What one reached `parseNodeMaterialFromSnippet` call resolved to. */
export interface CompiledNodeMaterialCall {
    /** The graph's index in the composed variant table. */
    index: number;
    /** The textures the call named, in the source's own order. */
    textures: readonly NodeMaterialTexture[];
}

/** How a recorded graph is compared, so two reaches of one share an index. */
function nodeMaterialKey(material: CompiledNodeMaterial): string {
    const document = material.kind === "literal"
        ? `literal:${JSON.stringify(material.graph)}`
        : `module:${material.module}#${material.exportName}`;
    return `${document}|emitters:${JSON.stringify(material.blockEmitters ?? [])}`;
}

const nodeBlockModulePrefixes = babylonPackages.map(
    (packageName) => `${packageName}/`,
);
const nodeBlockModuleDirectory = "material/node/blocks";
let pinnedNodeBlockModules: ReadonlySet<string> | undefined;

/** The actual block modules shipped by the installed pinned package. */
function pinnedNodeBlockModuleInventory(): ReadonlySet<string> {
    pinnedNodeBlockModules ??= new Set(
        readdirSync(
            join(pinnedLibraryRoot(), nodeBlockModuleDirectory),
            { withFileTypes: true },
        )
            .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
            .map((entry) => `${nodeBlockModuleDirectory}/${entry.name}`),
    );
    return pinnedNodeBlockModules;
}

/**
 * Resolve the one custom-loader shape generation can replay exactly.
 *
 * A caller may close its bundle over a switch of block class names, with
 * each case returning only one pinned `material/node/blocks/*` module's
 * `emitter` export and the default throwing. The map, rather than executable
 * scene code, then travels to composition. Anything wider would let an
 * arbitrary callback choose graph semantics at generation and therefore
 * remains refused.
 */
function compileBlockLoader(
    context: NodeMaterialContext,
    expression: ts.Expression | undefined,
): readonly NodeMaterialBlockEmitter[] | undefined {
    if (!expression) return undefined;
    const loader = unwrapLoaderExpression(expression);
    const declaration = ts.isIdentifier(loader)
        ? resolveFunctionDeclaration(
              context.checker,
              loader,
              (node, message) => context.fail(node, message),
          )
        : undefined;
    if (!declaration) {
        context.fail(
            expression,
            "A node material blockLoader must name a local closed switch " +
                "over pinned block emitter modules.",
        );
    }
    if (
        declaration.parameters.length !== 1 ||
        !ts.isIdentifier(declaration.parameters[0]!.name) ||
        !declaration.body ||
        !ts.isBlock(declaration.body) ||
        declaration.body.statements.length !== 1 ||
        !ts.isSwitchStatement(declaration.body.statements[0]!)
    ) {
        context.fail(
            declaration,
            "A node material blockLoader is one parameter and one closed " +
                "switch statement.",
        );
    }
    const parameter = declaration.parameters[0]!.name;
    const statement = declaration.body.statements[0]!;
    const discriminant = unwrapLoaderExpression(statement.expression);
    if (
        !ts.isIdentifier(discriminant) ||
        context.checker.getSymbolAtLocation(discriminant) !==
            context.checker.getSymbolAtLocation(parameter)
    ) {
        context.fail(
            statement.expression,
            "A node material blockLoader switch must dispatch on its class " +
                "name parameter.",
        );
    }

    const emitters: NodeMaterialBlockEmitter[] = [];
    const classNames = new Set<string>();
    let hasRefusingDefault = false;
    for (const clause of statement.caseBlock.clauses) {
        if (ts.isDefaultClause(clause)) {
            if (
                hasRefusingDefault ||
                clause.statements.length !== 1 ||
                !ts.isThrowStatement(clause.statements[0]!)
            ) {
                context.fail(
                    clause,
                    "A node material blockLoader default arm must contain " +
                        "one throw statement.",
                );
            }
            hasRefusingDefault = true;
            continue;
        }
        if (
            !ts.isStringLiteralLike(clause.expression) ||
            clause.statements.length !== 1 ||
            !ts.isReturnStatement(clause.statements[0]!) ||
            !clause.statements[0]!.expression
        ) {
            context.fail(
                clause,
                "Each node material blockLoader case must return one pinned " +
                    "block emitter.",
            );
        }
        const className = clause.expression.text;
        if (classNames.has(className)) {
            context.fail(
                clause.expression,
                `A node material blockLoader repeats '${className}'.`,
            );
        }
        classNames.add(className);

        const returned = unwrapLoaderExpression(
            clause.statements[0]!.expression,
        );
        if (
            !ts.isPropertyAccessExpression(returned) ||
            returned.name.text !== "emitter"
        ) {
            context.fail(
                returned,
                "A node material blockLoader case returns only a pinned " +
                    "material/node/blocks module's emitter export.",
            );
        }
        const awaited = unwrapLoaderExpression(returned.expression);
        if (!ts.isAwaitExpression(awaited)) {
            context.fail(
                awaited,
                "A node material blockLoader case must await its pinned " +
                    "block module import.",
            );
        }
        const imported = unwrapLoaderExpression(awaited.expression);
        if (
            !ts.isCallExpression(imported) ||
            imported.expression.kind !== ts.SyntaxKind.ImportKeyword ||
            imported.arguments.length !== 1 ||
            !ts.isStringLiteralLike(imported.arguments[0]!)
        ) {
            context.fail(
                imported,
                "A node material blockLoader case must dynamically import " +
                    "one pinned block module.",
            );
        }
        const specifier = imported.arguments[0]!.text;
        const prefix = nodeBlockModulePrefixes.find((candidate) =>
            specifier.startsWith(candidate),
        );
        const module = prefix ? specifier.slice(prefix.length) : "";
        if (!/^material\/node\/blocks\/[a-z0-9][a-z0-9-]*\.js$/.test(module)) {
            context.fail(
                imported.arguments[0]!,
                "A node material blockLoader may import only the pinned " +
                    "material/node/blocks emitter modules.",
            );
        }
        if (!pinnedNodeBlockModuleInventory().has(module)) {
            context.fail(
                imported.arguments[0]!,
                `A node material blockLoader module '${specifier}' does ` +
                    "not exist in the pinned material/node/blocks inventory.",
            );
        }
        emitters.push({ className, module });
    }
    if (!hasRefusingDefault) {
        context.fail(
            statement.caseBlock,
            "A node material blockLoader switch requires a refusing default " +
                "arm.",
        );
    }
    if (emitters.length === 0) {
        context.fail(
            statement.caseBlock,
            "A node material blockLoader switch must map at least one class " +
                "to a pinned block emitter.",
        );
    }
    return emitters;
}

/**
 * Lower one `parseNodeMaterialFromSnippet` call to the index of the graph it
 * reached. Graphs are recorded in reach order, which is the generated node
 * variant table's index order.
 */
export function compileNodeMaterialOptions(
    context: NodeMaterialContext,
    snippetExpression: ts.Expression,
    optionsExpression: ts.Expression | undefined,
): CompiledNodeMaterialCall {
    const snippetId = context.compileStaticString(snippetExpression);
    if (snippetId !== "") {
        context.fail(
            snippetExpression,
            "A node material snippet id fetches the graph from the snippet " +
                "server at load; pass the graph through 'json' instead.",
        );
    }
    if (!optionsExpression) {
        context.fail(
            snippetExpression,
            "A node material requires its graph through 'json'.",
        );
    }
    const object = context.expectObjectLiteral(optionsExpression);
    validateObjectProperties(
        context,
        object,
        [
            "json",
            "textures",
            "shadowGenerators",
            "shadowLightIndices",
            "blockLoader",
        ],
        "Reached node materials take an inline 'json' graph, its " +
            "'textures', its 'shadowGenerators', and a closed pinned " +
            "blockLoader only; skinning and instancing are not lowered.",
    );
    const jsonExpression = context.objectProperty(object, "json");
    if (!jsonExpression) {
        context.fail(
            object,
            "A node material requires its graph through 'json'.",
        );
    }
    const textures = compileTextures(
        context,
        context.objectProperty(object, "textures"),
    );
    const textureNames = textures.map((entry) => entry.name);
    const shadowLights = compileShadowLights(
        context,
        context.objectProperty(object, "shadowGenerators"),
        context.objectProperty(object, "shadowLightIndices"),
    );
    const blockEmitters = compileBlockLoader(
        context,
        context.objectProperty(object, "blockLoader"),
    );
    const document = staticGraphDocument(
        context,
        jsonExpression,
        "node material",
        // A module that COMPUTES the document would need the pin's own
        // graph loader to run, which is the boundary this family keeps.
        "export-only",
    );
    const material: CompiledNodeMaterial =
        document.kind === "literal"
            ? {
                  kind: "literal",
                  graph: document.graph,
                  textureNames,
                  shadowLights,
                  ...(blockEmitters ? { blockEmitters } : {}),
              }
            : {
                  kind: "module",
                  module: document.module,
                  exportName: document.exportName,
                  textureNames,
                  shadowLights,
                  ...(blockEmitters ? { blockEmitters } : {}),
              };
    // Two calls naming the same document compose one module and one variant,
    // so a repeat reach returns the first index. Linear over the reached
    // list, which no scene grows past a handful — a keyed map would have to
    // live on the compiler rather than here, and module-level state in a
    // compiler outlives the compile.
    const key = nodeMaterialKey(material);
    const existing = context.reachedNodeMaterials.findIndex(
        (candidate) => nodeMaterialKey(candidate) === key,
    );
    if (existing >= 0) {
        // The names belong to the graph, so two calls on one graph name the
        // same bindings; only the images may differ, and those ride the
        // material record. A differing set means the two calls do not
        // describe one graph, which the shared variant table cannot express.
        const shared = context.reachedNodeMaterials[existing]!.textureNames;
        if (
            shared.length !== textureNames.length ||
            shared.some((name, index) => name !== textureNames[index])
        ) {
            context.fail(
                object,
                "Two node materials share a graph but name different " +
                    "texture bindings; the composed variant declares one set.",
            );
        }
        return { index: existing, textures };
    }
    context.reachedNodeMaterials.push(material);
    return {
        index: context.reachedNodeMaterials.length - 1,
        textures,
    };
}

/**
 * The `shadowGenerators` a call named, paired with the `scene.lights` slot
 * of each one's light.
 *
 * The pin defaults the indices to `[0, 1, ...]` when the caller omits them,
 * so a call that supplies the list is checked against the slot the generator
 * was built on and a call that omits it takes that slot. What the FILTER is
 * stays composition's to answer, off the pinned factory the generator's kind
 * names.
 */
function compileShadowLights(
    context: NodeMaterialContext,
    generatorsExpression: ts.Expression | undefined,
    indicesExpression: ts.Expression | undefined,
): NodeShadowLight[] {
    if (!generatorsExpression) {
        if (indicesExpression) {
            context.fail(
                indicesExpression,
                "A node material's shadowLightIndices names the lights of " +
                    "its shadowGenerators, which this call does not pass.",
            );
        }
        return [];
    }
    const generators = context.expectStaticArrayLiteral(generatorsExpression);
    const indices = indicesExpression
        ? context.expectStaticArrayLiteral(indicesExpression).elements
        : undefined;
    if (indices && indices.length !== generators.elements.length) {
        context.fail(
            indicesExpression!,
            "A node material's shadowLightIndices must name one light per " +
                "shadow generator.",
        );
    }
    return generators.elements.map((element, position) => {
        const value = context.compileValue(element);
        context.expectKind(value, "shadow-generator", element);
        if (value.shadowGeneratorIndex === undefined) {
            context.fail(
                element,
                "A node material's shadowGenerators takes the generator a " +
                    "filter factory returned.",
            );
        }
        const generator = context.shadowGeneratorLight(
            value.shadowGeneratorIndex,
            element,
        );
        // A call that names the slot is checked against the one the
        // generator was built on; a call that omits the list takes the
        // pin's own `[0, 1, ...]` default, which for a reached scene IS
        // that slot -- so only a stated disagreement can fail here.
        const named = indices?.[position];
        if (named) {
            const lightIndex = staticNumberValue(context, named);
            if (lightIndex === undefined) {
                context.fail(
                    named,
                    "A node material's shadowLightIndices are compile-time " +
                        "numbers: the composed fragment names its bindings " +
                        "by the light's slot.",
                );
            }
            if (lightIndex !== generator.lightIndex) {
                context.fail(
                    named,
                    `A node material names light ${lightIndex} for a ` +
                        "shadow generator built on light " +
                        `${generator.lightIndex}; the composed fragment ` +
                        "binds by that slot.",
                );
            }
        }
        return {
            lightIndex: generator.lightIndex,
            generatorIndex: value.shadowGeneratorIndex,
        };
    });
}

/**
 * The `textures` record, read as the pin reads it: a binding name to the
 * texture that binding samples.
 *
 * The pin looks each declared binding up in this record by name
 * (`options.textures?.[tb._name]`), so what the compiler has to carry is the
 * key beside the value; which pair a name lands on is the composition's
 * answer, not this call's. A binding the graph declares and the record omits
 * is the pin's own render-time error, raised at generation here instead --
 * `src/compose-pipeline.ts` holds that check, because only the composed
 * graph knows what it declared.
 */
function compileTextures(
    context: NodeMaterialContext,
    expression: ts.Expression | undefined,
): readonly NodeMaterialTexture[] {
    if (!expression) return [];
    const record = context.expectObjectLiteral(expression);
    const textures: NodeMaterialTexture[] = [];
    for (const property of record.properties) {
        // `{ diffuse }` and `{ AtlasUV: atlas }` are both written by the
        // corpus, so the value expression is the shorthand's own name or the
        // assignment's initializer.
        const value = ts.isShorthandPropertyAssignment(property)
            ? property.name
            : ts.isPropertyAssignment(property)
                ? property.initializer
                : undefined;
        if (!value) {
            context.fail(
                property,
                "A node material's 'textures' record takes named " +
                    "properties only.",
            );
        }
        const name = property.name
            ? context.propertyName(property.name)
            : undefined;
        if (name === undefined) {
            context.fail(
                property,
                "A node material texture binding is named by an identifier " +
                    "or a string.",
            );
        }
        const texture = context.compileValue(value);
        context.expectKind(texture, "texture", value);
        // File-backed images and the pin's 1x1 solid factory both normalize
        // to the FileTexture record the native node-material slots upload.
        // Pixel buffers and render attachments have independent lifetimes
        // and still refuse rather than falling into a neighbouring overload.
        if (
            texture.textureStorage !== "file" &&
            texture.textureStorage !== "solid"
        ) {
            context.fail(
                value,
                "Reached node-material textures come from loadTexture2D " +
                    "or createSolidTexture2D.",
            );
        }
        textures.push({ name, texture });
    }
    return textures;
}
