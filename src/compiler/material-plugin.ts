import { EmissionSet, EmissionMap } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import { declaredSymbol, resolvedSymbol } from "./symbols.js";
/** Fold source plugin declarations and retain their live textures and UBO callbacks.
 * Shader injection, binding layout and enabled-plugin ordering execute the pin's
 * composers. The fold proves that bindTextures/getActiveTextures refer to the
 * same ordered texture identities. PBR supports vertex fields and a material UBO;
 * Standard retains its existing fragment texture contract.
 */
import ts from "typescript";
import { argumentAt } from "./syntax.js";
import { LoweringContext, sharedPinnedContext } from "../lowering/context.js";
import { tryResolveFunctionDeclaration } from "./user-functions.js";
import { executeApplicationFunction } from "./executed-application-function.js";
import type {
    MaterialPluginManifest,
    MaterialPluginSamplerManifest,
    MaterialPluginUniformManifest,
    MaterialPluginVaryingManifest,
} from "../pinned-material-plugins.js";
// Names already served by the generated Standard binding table.
import { standardBuiltinBindingNames } from "../pinned-standard-variants.js";
import type { Value } from "./types.js";

/** Which family's bind path the material a plugin attaches to takes. */
type MaterialPluginFamily = "standard" | "pbr";

/** The compiler surface a fold needs; the entry orchestrator supplies it. */
interface MaterialPluginContext extends Pick<
    LoweringServices,
    | "checker"
    | "resolveStaticExpression"
    | "unwrap"
    | "propertyName"
    | "probeStaticArrayLiteral"
    | "compileStaticString"
    | "compileValue"
    | "bindings"
    | "withRecordScopes"
    | "compileStoredDataFunction"
    | "dataLowerer"
    | "dataValue"
    | "fail"
> {}

export interface MaterialPluginResourceContext
    extends
        MaterialPluginContext,
        Pick<
            LoweringServices,
            | "emit"
            | "reachFeature"
            | "requireEngine"
            | "expectSameEngine"
            | "boundPixelsTextures"
            | "cppString"
        > {}

/** Retain the callbacks and textures the composed source bridge consumes. */
export function emitMaterialPluginResources(
    context: MaterialPluginResourceContext,
    target: Value,
    source: ts.Node,
    plugins: FoldedMaterialPlugins,
    signatureIndex = 0,
): void {
    const engine = context.requireEngine(target, source);
    context.reachFeature("material:plugin-index", source);
    context.emit(
        `bbl::set_material_plugins(${engine}, ${target.cpp}, static_cast<std::uint8_t>(${signatureIndex}));`,
    );
    const samplers = plugins.manifests.flatMap(
        (plugin) => plugin.samplers ?? [],
    );
    plugins.textures.forEach((texture, index) => {
        context.expectSameEngine(target, texture.value, texture.node);
        const storage = texture.value.textureStorage;
        if (storage === "pixels")
            context.boundPixelsTextures.add(texture.value.cpp);
        context.reachFeature("material:plugin-textures", texture.node);
        const helper =
            storage === "pixels"
                ? "add_material_plugin_pixels_texture"
                : storage === "stored"
                  ? "add_material_plugin_texture"
                  : "add_material_plugin_file_texture";
        const sampler = samplers[index]!;
        context.emit(
            `bbl::${helper}(${engine}, ${target.cpp}, ${texture.value.cpp}, ${context.cppString(sampler.texture)}, ${context.cppString(sampler.sampler)});`,
        );
    });
    for (const writer of plugins.uniformWriters) {
        context.emit(
            `bbl::add_material_plugin_uniform_writer(${engine}, ${target.cpp}, ${writer});`,
        );
    }
}

/** One texture a plugin's `bindTextures` binds, and where it came from. */
interface MaterialPluginTextureBinding {
    /** The `Texture2D` value, already lowered to its native local. */
    value: Value;
    /** The scene expression that named it, for a located refusal. */
    node: ts.Expression;
    /** What the scene named, resolved: the agreement proof's own subject. */
    identity: ResolvedTextureIdentity;
}

/**
 * What a plain texture reference NAMES, independent of what it renders as.
 *
 * The agreement proof between `bindTextures` and `getActiveTextures` used to
 * compare the two values' `cpp` spellings, which is a comparison of RENDERED
 * NAMES: two textures reached through different scopes that happened to
 * render the same spelling passed a check they should have failed, and the
 * disagreement it exists to catch is exactly the one that binds one texture
 * while keeping another alive.
 *
 * A reference the fold accepts is a read -- an identifier, or a property
 * path over identifiers -- so what it names is the declaration its root
 * resolves to plus the properties walked off it. Both members are folded at
 * one point in the walk, under the same bindings, so equal roots and equal
 * paths name one texture and nothing else does.
 */
interface ResolvedTextureIdentity {
    /**
     * The declaration the root resolves to. A `this` root is the plugin
     * object itself, which is one object for both members, so it resolves to
     * the shared marker rather than to a symbol.
     */
    root: ts.Symbol | "this";
    /** The properties read off that root, outermost last. */
    path: readonly string[];
}

/** Whether two folded references name one texture. */
function sameResolvedTexture(
    left: ResolvedTextureIdentity,
    right: ResolvedTextureIdentity,
): boolean {
    return (
        left.root === right.root &&
        left.path.length === right.path.length &&
        left.path.every((name, index) => name === right.path[index])
    );
}

/**
 * The identity of one plain reference, or a located refusal.
 *
 * `isPlainReference` has already accepted the shape; this walks the same
 * chain and resolves its root through the checker, following an import alias
 * so a texture named through a re-export resolves to the declaration a
 * direct read would.
 */
function resolveTextureIdentity(
    context: MaterialPluginContext,
    member: string,
    expression: ts.Expression,
): ResolvedTextureIdentity {
    const path: string[] = [];
    let node = context.unwrap(expression);
    while (ts.isPropertyAccessExpression(node)) {
        path.unshift(node.name.text);
        node = context.unwrap(node.expression);
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
        return { root: "this", path };
    }
    const symbol = ts.isIdentifier(node)
        ? resolvedSymbol(context.checker, node)
        : undefined;
    if (!symbol) {
        context.fail(
            expression,
            `MaterialPlugin.${member} names a texture the fold cannot ` +
                "resolve to a declaration, so it cannot prove the same " +
                "texture is bound and kept alive.",
        );
    }
    return { root: symbol, path };
}

/** A folded `material.plugins = [...]` right-hand side. */
interface FoldedMaterialPlugins {
    /** The plugin list, in the order the scene wrote it. */
    manifests: MaterialPluginManifest[];
    /**
     * Every texture the list binds, concatenated in the order
     * `bindPluginTextures` pushes them — plugin by plugin, and within one
     * plugin in `bindTextures` order, which is the order its `getSamplers`
     * declarations were composed in.
     */
    textures: readonly MaterialPluginTextureBinding[];
    uniformWriters: readonly string[];
}

/** The plugin members whose presence reaches machinery this port lacks. */
const refusedMembers: Readonly<Record<string, string>> = {
    priority:
        "orders the plugins on one material, which only a second plugin " +
        "can observe",
    isEnabled:
        "is the pin's toggle; a disabled plugin still takes an index, and " +
        "the toggle is a run-time rebuild",
};

/**
 * What the fold reads out of `plugin-bridge-shared.ts`.
 *
 * `FRAG_POINT_TO_SLOTS` and `VERT_POINT_TO_SLOT` are module-private
 * upstream, so the accepted injection points are read from the pinned
 * declarations rather than restated — a point the pin adds becomes accepted
 * here without an edit, and one it drops fails instead of composing
 * nothing. The two WGSL types `buildPluginFragment` defaults an omitted
 * sampler declaration to are read the same way, from the `??` beside the
 * property each one defaults.
 *
 * All of it comes from one module, so it is one memoised read: a second
 * `LoweringContext` over the same pinned file would parse it twice.
 */
interface PinnedPluginContract {
    fragmentPoints: ReadonlySet<string>;
    vertexPoints: ReadonlySet<string>;
    textureType: string;
    samplerType: string;
}

const PLUGIN_BRIDGE = "src/material/plugin/plugin-bridge-shared.ts";

let contract: PinnedPluginContract | undefined;

function pinnedPluginContract(): PinnedPluginContract {
    if (contract) return contract;
    const context = sharedPinnedContext();
    const file = context.sourceFile(PLUGIN_BRIDGE);
    const { declaration } = context.functionDeclaration(
        PLUGIN_BRIDGE,
        "buildPluginFragment",
    );
    const names = (constant: string): string[] =>
        context.objectInitializer(file, constant).properties.map((property) => {
            const name = property.name && context.propertyName(property.name);
            if (name === undefined) {
                return context.contractError(
                    property,
                    `Pinned ${constant} carries an entry that is not a ` +
                        "plain named injection point.",
                );
            }
            return name;
        });
    contract = {
        fragmentPoints: new EmissionSet([
            ...names("FRAG_POINT_TO_SLOTS"),
            definitionsPoint(context, declaration),
        ]),
        vertexPoints: new EmissionSet(names("VERT_POINT_TO_SLOT")),
        textureType: samplerTypeDefault(context, declaration, "textureType"),
        samplerType: samplerTypeDefault(context, declaration, "samplerType"),
    };
    return contract;
}

/**
 * The point `buildPluginFragment` handles ahead of the slot lookup.
 *
 * It appends to the fragment's helper functions rather than to a slot, so it
 * appears in neither table — the branch that recognizes it is the only place
 * upstream names it, and reading the literal from there is what keeps this
 * from being a spelling typed twice.
 */
function definitionsPoint(
    context: LoweringContext,
    declaration: ts.FunctionDeclaration,
): string {
    const [comparison] = context.findNodes(
        declaration,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
            ts.isStringLiteral(node.right),
    );
    if (!comparison) {
        return context.contractError(
            declaration,
            "Pinned buildPluginFragment no longer compares an injection " +
                "point against a string literal, so the helper-function " +
                "point cannot be read from it.",
        );
    }
    return (comparison.right as ts.StringLiteral).text;
}

/** One sampler-declaration type, from the `??` the pin defaults it with. */
function samplerTypeDefault(
    context: LoweringContext,
    declaration: ts.FunctionDeclaration,
    field: "textureType" | "samplerType",
): string {
    const [defaulted] = context.findNodes(
        declaration,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
            ts.isPropertyAccessExpression(node.left) &&
            node.left.name.text === field &&
            ts.isStringLiteral(node.right),
    );
    if (!defaulted) {
        return context.contractError(
            declaration,
            `Pinned buildPluginFragment no longer defaults ${field} to a ` +
                "string literal, so the composed binding's type cannot be " +
                "read from it.",
        );
    }
    return (defaulted.right as ts.StringLiteral).text;
}

/**
 * Folds `material.plugins = [...]`'s right-hand side.
 *
 * The array and every plugin in it are static: the pin reads the list once,
 * while `_indexFor` keys its cache on the values, so a list assembled at run
 * time would need a run-time signature and a variant this port never
 * composed.
 */
export function foldMaterialPluginList(
    context: MaterialPluginContext,
    expression: ts.Expression,
    family: MaterialPluginFamily,
): FoldedMaterialPlugins {
    const array = context.probeStaticArrayLiteral(expression);
    if (!array) {
        context.fail(
            expression,
            "material.plugins takes a static array of MaterialPlugin " +
                "objects; the pin reads the list once and keys its " +
                "per-signature index on the values it finds.",
        );
    }
    if (array.elements.length === 0) {
        context.fail(
            expression,
            "material.plugins is empty, which composes nothing and still " +
                "takes a signature index upstream; drop the assignment.",
        );
    }
    const declared = new EmissionMap<string, string>();
    const folded = array.elements.map((element) =>
        foldMaterialPlugin(context, element, family, declared),
    );
    return {
        manifests: folded.map((plugin) => plugin.manifest),
        textures: folded.flatMap((plugin) => plugin.textures),
        uniformWriters: folded.flatMap((plugin) =>
            plugin.uniformWriter ? [plugin.uniformWriter] : [],
        ),
    };
}

/** One folded plugin: what composes, and what its bindings are filled with. */
interface FoldedMaterialPlugin {
    manifest: MaterialPluginManifest;
    textures: readonly MaterialPluginTextureBinding[];
    uniformWriter?: string;
}

/**
 * The plugin object a scene expression stands for, and the scope its
 * members read.
 *
 * The module header states why the factory call is seen through; what this
 * carries is the result of doing so — the object literal, plus the
 * parameter bindings its members resolve against. A body with anything but
 * one return in it refuses: a statement could compute a name or a sampler
 * list this fold has no way to observe, and a branch would make the
 * composed fragment depend on which arm ran.
 */
interface PluginObjectSite {
    object: ts.ObjectLiteralExpression;
    /** The factory parameters, bound while the object's members are folded. */
    bindings: readonly { name: ts.Identifier; value: Value }[];
    owner?: Value;
}

function pluginObjectSite(
    context: MaterialPluginContext,
    expression: ts.Expression,
): PluginObjectSite {
    const resolved = context.unwrap(
        context.resolveStaticExpression(expression),
    );
    if (ts.isObjectLiteralExpression(resolved)) {
        return { object: resolved, bindings: [] };
    }
    if (ts.isCallExpression(resolved)) {
        return pluginFactorySite(context, resolved);
    }
    const owner = context.compileValue(expression);
    for (const method of Object.values(owner.recordMethods ?? {})) {
        if (
            !ts.isIdentifier(method) &&
            ts.isObjectLiteralExpression(method.parent)
        )
            return { object: method.parent, bindings: [], owner };
    }
    context.fail(
        expression,
        "A MaterialPlugin is a plain object literal upstream, written " +
            "inline or returned by a local factory; this port folds its " +
            "name, its custom code and its sampler declarations at " +
            "generation, so a value it cannot see through is refused.",
    );
}

/** The bounded local factory call shape, validated at the call site. */
function pluginFactorySite(
    context: MaterialPluginContext,
    call: ts.CallExpression,
): PluginObjectSite {
    const callee = context.unwrap(call.expression);
    if (!ts.isIdentifier(callee)) {
        context.fail(
            call.expression,
            "A MaterialPlugin factory is named by a plain identifier; a " +
                "call through a property or an expression names a target " +
                "this fold cannot resolve to one declaration.",
        );
    }
    // The compiler's own identifier-to-declaration resolver, so a factory
    // this fold sees through is exactly one the inliner would have lowered:
    // it follows the import alias and accepts the same four declaration
    // shapes, which is what lets `const make = (t) => ({ ... })` fold like
    // the `function` form.
    const declaration = tryResolveFunctionDeclaration(context.checker, callee);
    if (!declaration?.body) {
        context.fail(
            call.expression,
            `'${callee.text}' does not resolve to a function with a body, ` +
                "so the MaterialPlugin it returns cannot be folded.",
        );
    }
    const returned = foldSingleReturn(
        context,
        declaration,
        `The MaterialPlugin factory ${callee.text}'s body`,
    );
    const object = context.unwrap(returned);
    if (!ts.isObjectLiteralExpression(object)) {
        context.fail(
            returned,
            `'${callee.text}' returns a MaterialPlugin the pin reads as a ` +
                "plain object; a value assembled another way is refused.",
        );
    }
    if (call.arguments.length !== declaration.parameters.length) {
        context.fail(
            call,
            `'${callee.text}' takes ${declaration.parameters.length} ` +
                `argument(s) and the call passes ${call.arguments.length}; ` +
                "a defaulted or missing one would bind a value the fold " +
                "never saw.",
        );
    }
    const bindings = declaration.parameters.map((parameter, index) => {
        if (
            !ts.isIdentifier(parameter.name) ||
            parameter.dotDotDotToken ||
            parameter.initializer
        ) {
            context.fail(
                parameter,
                `'${callee.text}' binds its MaterialPlugin through a plain ` +
                    "named parameter; a destructured, defaulted or rest " +
                    "parameter is not folded.",
            );
        }
        return {
            name: parameter.name,
            value: context.compileValue(argumentAt(call, index)),
        };
    });
    return { object, bindings };
}

/** One `MaterialPlugin` object literal, inline or from a bounded factory. */
function foldMaterialPlugin(
    context: MaterialPluginContext,
    expression: ts.Expression,
    family: MaterialPluginFamily,
    declared: Map<string, string>,
): FoldedMaterialPlugin {
    const site = pluginObjectSite(context, expression);
    const fold = () =>
        context.bindings.withBoundParameters(site.bindings, () =>
            foldPluginObject(
                context,
                expression,
                site.object,
                family,
                declared,
                site.owner,
            ),
        );
    return site.owner ? context.withRecordScopes(site.owner, fold) : fold();
}

function foldPluginObject(
    context: MaterialPluginContext,
    expression: ts.Expression,
    object: ts.ObjectLiteralExpression,
    family: MaterialPluginFamily,
    declared: Map<string, string>,
    owner?: Value,
): FoldedMaterialPlugin {
    let name: string | undefined;
    let getCustomCode: ts.FunctionLikeDeclaration | undefined;
    let getSamplers: ts.FunctionLikeDeclaration | undefined;
    let bindTextures: ts.FunctionLikeDeclaration | undefined;
    let getActiveTextures: ts.FunctionLikeDeclaration | undefined;
    let uniforms: readonly MaterialPluginUniformManifest[] | undefined;
    let varyings: readonly MaterialPluginVaryingManifest[] | undefined;
    let defines:
        Readonly<Record<string, string | number | boolean>> | undefined;
    let uniformWriter: string | undefined;
    const method = (
        property: ts.ObjectLiteralElementLike,
        member: string,
    ): ts.FunctionLikeDeclaration => {
        if (ts.isMethodDeclaration(property)) return property;
        if (
            ts.isPropertyAssignment(property) &&
            (ts.isArrowFunction(property.initializer) ||
                ts.isFunctionExpression(property.initializer))
        ) {
            return property.initializer;
        }
        context.fail(
            property,
            `MaterialPlugin.${member} is a function upstream; this port ` +
                "folds its body, so it has to be written as one here.",
        );
    };
    for (const property of object.properties) {
        const member = property.name && context.propertyName(property.name);
        if (member === undefined) {
            context.fail(
                property,
                "A MaterialPlugin member has to be a plain named property.",
            );
        }
        const refusal = refusedMembers[member];
        if (refusal !== undefined) {
            context.fail(
                property,
                `MaterialPlugin.${member} ${refusal}, and no corpus scene ` +
                    "reaches it.",
            );
        }
        if (member === "name") {
            if (!ts.isPropertyAssignment(property)) {
                context.fail(property, "MaterialPlugin.name has no value.");
            }
            name = context.compileStaticString(property.initializer);
            continue;
        }
        if (member === "getCustomCode") {
            getCustomCode = method(property, member);
            continue;
        }
        if (member === "getSamplers") {
            getSamplers = method(property, member);
            continue;
        }
        if (member === "defines") {
            if (!ts.isPropertyAssignment(property))
                context.fail(
                    property,
                    "Plugin defines require a constant record.",
                );
            const record = context.compileValue(
                property.initializer,
            ).recordProperties;
            if (!record)
                context.fail(
                    property,
                    "Plugin defines require a constant record.",
                );
            defines = Object.fromEntries(
                Object.entries(record).map(([key, value]) => {
                    const constant =
                        value.staticBoolean ??
                        value.staticNumber ??
                        value.staticString;
                    if (constant === undefined)
                        context.fail(
                            property,
                            `Plugin define ${key} must be constant.`,
                        );
                    return [key, constant];
                }),
            );
            continue;
        }
        if (member === "getUniforms" || member === "getVaryings") {
            if (family !== "pbr")
                context.fail(
                    property,
                    "Standard plugin UBO and varying transport is not admitted.",
                );
            const declaration = method(property, member);
            let returned = foldSingleReturn(
                context,
                declaration,
                `MaterialPlugin.${member}`,
            );
            if (member === "getUniforms") {
                const object = context.unwrap(returned);
                if (
                    !ts.isObjectLiteralExpression(object) ||
                    object.properties.length !== 1
                )
                    context.fail(
                        returned,
                        "Plugin uniforms require exactly the ubo declaration array.",
                    );
                const property = object.properties.find(
                    (property) =>
                        property.name &&
                        context.propertyName(property.name) === "ubo",
                );
                if (!property || !ts.isPropertyAssignment(property))
                    context.fail(
                        returned,
                        "Plugin uniforms require a ubo declaration array.",
                    );
                returned = property.initializer;
            }
            const fields = foldPluginFieldDeclarations(
                context,
                returned,
                member === "getUniforms",
            );
            if (member === "getUniforms") uniforms = fields;
            else varyings = fields;
            continue;
        }
        if (member === "writeUbo") {
            if (family !== "pbr")
                context.fail(
                    property,
                    "Standard plugin UBO transport is not admitted.",
                );
            const declaration = method(property, member);
            if (
                !ts.isMethodDeclaration(declaration) &&
                !ts.isArrowFunction(declaration) &&
                !ts.isFunctionExpression(declaration)
            )
                context.fail(
                    declaration,
                    "Plugin writer requires a source method.",
                );
            uniformWriter = context.compileStoredDataFunction(
                declaration,
                {
                    kind: "function",
                    parameters: [
                        { kind: "f32array" },
                        {
                            kind: "map",
                            key: { kind: "string" },
                            value: { kind: "number" },
                        },
                    ],
                },
                owner,
            );
            continue;
        }
        if (member === "bindTextures") {
            bindTextures = method(property, member);
            continue;
        }
        if (member === "getActiveTextures") {
            getActiveTextures = method(property, member);
            continue;
        }
        context.fail(
            property,
            `MaterialPlugin.${member} is not part of the pinned plugin ` +
                "surface.",
        );
    }
    if (name === undefined) {
        context.fail(
            expression,
            "A MaterialPlugin declares a name; the pin's signature starts " +
                "with it.",
        );
    }
    if (!getCustomCode) {
        context.fail(
            expression,
            "A MaterialPlugin with no getCustomCode composes no WGSL and " +
                "still takes a signature index upstream.",
        );
    }
    const pinned = pinnedPluginContract();
    const fragment = foldCustomCode(
        context,
        getCustomCode,
        "fragment",
        pinned.fragmentPoints,
    );
    const vertex = foldCustomCode(
        context,
        getCustomCode,
        "vertex",
        pinned.vertexPoints,
    );
    if (!fragment && !vertex) {
        context.fail(
            expression,
            `MaterialPlugin "${name}" returns no custom code for either ` +
                "shader type, so it composes nothing.",
        );
    }
    const samplers = getSamplers
        ? foldSamplerDeclarations(context, name, getSamplers, declared, family)
        : undefined;
    const textures = foldPluginTextures(
        context,
        expression,
        name,
        samplers,
        bindTextures,
        getActiveTextures,
    );
    return {
        manifest: {
            name,
            ...(fragment ? { fragment } : {}),
            ...(vertex ? { vertex } : {}),
            ...(samplers ? { samplers } : {}),
            ...(defines ? { defines } : {}),
            ...(uniforms ? { uniforms } : {}),
            ...(varyings ? { varyings } : {}),
        },
        textures,
        ...(uniformWriter ? { uniformWriter } : {}),
    };
}

function foldPluginFieldDeclarations(
    context: MaterialPluginContext,
    expression: ts.Expression,
    uniform: boolean,
): readonly MaterialPluginUniformManifest[] {
    const array = context.probeStaticArrayLiteral(expression);
    if (!array)
        context.fail(
            expression,
            "Plugin shader fields require a static array.",
        );
    return array.elements.map((element) => {
        const object = context.unwrap(element);
        if (!ts.isObjectLiteralExpression(object))
            context.fail(
                element,
                "Plugin shader fields require named records.",
            );
        const fields: {
            name?: string;
            type?: string;
            visibility?: "vertex" | "fragment" | "vertex-fragment";
        } = {};
        for (const property of object.properties) {
            if (!ts.isPropertyAssignment(property))
                context.fail(
                    property,
                    "Plugin shader fields require named values.",
                );
            const key = context.propertyName(property.name);
            const value = context.compileStaticString(property.initializer);
            if (key === "name" || key === "type") fields[key] = value;
            else if (
                key === "visibility" &&
                uniform &&
                (value === "vertex" ||
                    value === "fragment" ||
                    value === "vertex-fragment")
            )
                fields.visibility = value;
            else context.fail(property, "Unrepresented plugin shader field.");
        }
        if (!fields.name || !fields.type)
            context.fail(
                element,
                "Plugin shader fields require name and type.",
            );
        return {
            name: fields.name,
            type: fields.type,
            ...(fields.visibility ? { visibility: fields.visibility } : {}),
        };
    });
}

/**
 * `getSamplers()` folded to the declarations `buildPluginFragment` composes.
 *
 * Every field is a WGSL spelling the composed fragment carries verbatim, so
 * the fold is over constants and the pin still turns them into bindings.
 * The two optional types are checked against the pin's own defaults rather
 * than a list retyped here: `sampler_non_filtering` is the one other value
 * the pinned type allows, and it would need a bind-group layout entry no
 * measurement covers, so it refuses by name.
 *
 * `declared` is the MATERIAL's set, not this plugin's: the pin composes one
 * fragment out of the whole list, so two plugins declaring one name declare
 * one WGSL global twice exactly as two entries of one plugin would.
 */
function foldSamplerDeclarations(
    context: MaterialPluginContext,
    plugin: string,
    declaration: ts.FunctionLikeDeclaration,
    declared: Map<string, string>,
    family: MaterialPluginFamily,
): readonly MaterialPluginSamplerManifest[] {
    const returned = foldSingleReturn(
        context,
        declaration,
        `MaterialPlugin "${plugin}"'s getSamplers`,
    );
    const array = context.probeStaticArrayLiteral(returned);
    if (!array) {
        context.fail(
            returned,
            "getSamplers returns a static array of texture and sampler " +
                "declarations; the pin reads it once, at composition.",
        );
    }
    const pinned = pinnedPluginContract();
    const builtins = standardBuiltinBindingNames();
    return array.elements.map((element) => {
        const object = context.unwrap(context.resolveStaticExpression(element));
        if (!ts.isObjectLiteralExpression(object)) {
            context.fail(
                element,
                "A PluginSamplerDecl is a plain object of WGSL names.",
            );
        }
        const folded: {
            texture?: string;
            sampler?: string;
            textureType?: string;
            samplerType?: string;
            visibility?: "vertex" | "fragment" | "vertex-fragment";
            depthTexture?: boolean;
        } = {};
        for (const property of object.properties) {
            const field = property.name && context.propertyName(property.name);
            if (field === undefined || !ts.isPropertyAssignment(property)) {
                context.fail(
                    property,
                    "A PluginSamplerDecl field is a plain named property " +
                        "with a value.",
                );
            }
            if (
                field !== "texture" &&
                field !== "sampler" &&
                field !== "textureType" &&
                field !== "samplerType" &&
                field !== "visibility" &&
                field !== "depthTexture"
            ) {
                context.fail(
                    property,
                    `PluginSamplerDecl.${field} is not part of the pinned ` +
                        "declaration.",
                );
            }
            if (field === "depthTexture") {
                const value = context.compileValue(
                    property.initializer,
                ).staticBoolean;
                if (value === undefined)
                    context.fail(
                        property,
                        "Plugin texture depth type must be constant.",
                    );
                folded.depthTexture = value;
                continue;
            }
            const value = context.compileStaticString(property.initializer);
            if (field === "visibility") {
                if (
                    value !== "vertex" &&
                    value !== "fragment" &&
                    value !== "vertex-fragment"
                )
                    context.fail(
                        property,
                        "Unrepresented plugin sampler visibility.",
                    );
                folded.visibility = value;
                continue;
            }
            if (field === "textureType" && value !== pinned.textureType) {
                context.fail(
                    property,
                    `PluginSamplerDecl.textureType '${value}' is not the ` +
                        `pin's own '${pinned.textureType}'; a plugin ` +
                        "texture binds through the sampled-2D path both " +
                        "backends upload, and nothing measures another.",
                );
            }
            if (
                field === "samplerType" &&
                value !== pinned.samplerType &&
                value !== "sampler_non_filtering"
            ) {
                context.fail(
                    property,
                    `PluginSamplerDecl.samplerType '${value}' is not the ` +
                        `pin's own '${pinned.samplerType}'; a ` +
                        "non-filtering sampler is a bind-group layout " +
                        "entry of its own and no measurement covers it.",
                );
            }
            folded[field] = value;
        }
        if (folded.texture === undefined || folded.sampler === undefined) {
            context.fail(
                element,
                "A PluginSamplerDecl names both its texture and its " +
                    "sampler; the pin declares one binding for each.",
            );
        }
        if (
            family === "standard" &&
            (folded.depthTexture ||
                (folded.visibility && folded.visibility !== "fragment") ||
                folded.samplerType === "sampler_non_filtering")
        ) {
            context.fail(
                element,
                "Standard plugin stage/depth transport is not admitted; a non-filtering sampler is a bind-group layout entry of its own.",
            );
        }
        for (const wgslName of [folded.texture, folded.sampler]) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(wgslName)) {
                context.fail(
                    element,
                    `'${wgslName}' is not a WGSL identifier, and the pin ` +
                        "declares the binding under exactly this spelling.",
                );
            }
            // The composed variants declare their own bindings under these
            // names, whether or not THIS material carries the texture
            // behind one: the fragment is composed per variant, so a
            // plugin naming `dT` composes a module that either declares
            // the name twice or hands the material's diffuse sampling the
            // plugin's texture, depending only on which arms the material
            // happened to reach.
            if (builtins.has(wgslName)) {
                context.fail(
                    element,
                    `'${wgslName}' is a name the pin's own Standard ` +
                        "bindings are declared under " +
                        "(standard_binding_resources), so a plugin " +
                        "declaring it composes a second binding for a " +
                        "name the variant already resolves.",
                );
            }
            const owner = declared.get(wgslName);
            if (owner !== undefined) {
                context.fail(
                    element,
                    `'${wgslName}' is declared twice by this material's ` +
                        `plugins (already by "${owner}"); the composed ` +
                        "fragment would declare one WGSL name for two " +
                        "bindings.",
                );
            }
            declared.set(wgslName, plugin);
        }
        // Assembled in the scene's own property order, because the pin's
        // `pluginSignature` stringifies the declaration as it was written.
        const manifest: MaterialPluginSamplerManifest = {
            texture: folded.texture,
            sampler: folded.sampler,
            ...(folded.textureType !== undefined
                ? { textureType: folded.textureType }
                : {}),
            ...(folded.samplerType !== undefined
                ? { samplerType: folded.samplerType }
                : {}),
            ...(folded.visibility !== undefined
                ? { visibility: folded.visibility }
                : {}),
            ...(folded.depthTexture !== undefined
                ? { depthTexture: folded.depthTexture }
                : {}),
        };
        return manifest;
    });
}

/**
 * `bindTextures(out)` and `getActiveTextures(out)`, folded and cross-checked.
 *
 * Upstream the two are independent callbacks over the same textures: the
 * first fills the bind-group entries `getSamplers` declared, the second
 * enumerates them for the acquire and release the pin's `_textures` hook
 * performs. Nothing upstream checks that they agree, because upstream calls
 * both on the live objects. Here they are folded, so the agreement is
 * proven instead — otherwise a plugin listing its textures in the wrong
 * order in one of the two would bind one texture and keep another alive.
 */
function foldPluginTextures(
    context: MaterialPluginContext,
    expression: ts.Expression,
    plugin: string,
    samplers: readonly MaterialPluginSamplerManifest[] | undefined,
    bindTextures: ts.FunctionLikeDeclaration | undefined,
    getActiveTextures: ts.FunctionLikeDeclaration | undefined,
): readonly MaterialPluginTextureBinding[] {
    const unbound = bindTextures ?? getActiveTextures;
    if (!samplers) {
        if (unbound) {
            context.fail(
                unbound,
                `MaterialPlugin "${plugin}" names textures but declares no ` +
                    "samplers, so the pin composes no binding for them.",
            );
        }
        return [];
    }
    if (!bindTextures) {
        context.fail(
            expression,
            `MaterialPlugin "${plugin}" declares samplers with no ` +
                "bindTextures, so the composed fragment would sample a " +
                "binding nothing fills.",
        );
    }
    const bound = foldTexturePushes(
        context,
        plugin,
        bindTextures,
        "bindTextures",
        // The pin's `PluginTextureBinding`: an object naming one texture.
        (argument) => pluginTextureBindingTexture(context, argument),
    );
    if (bound.length !== samplers.length) {
        context.fail(
            bindTextures,
            `MaterialPlugin "${plugin}" declares ${samplers.length} ` +
                `sampler pair(s) and binds ${bound.length} texture(s); ` +
                "the pin fills the declared bindings positionally, so the " +
                "two lists are the same length.",
        );
    }
    if (!getActiveTextures) {
        context.fail(
            expression,
            `MaterialPlugin "${plugin}" binds textures without ` +
                "getActiveTextures, which is what the pin's own _textures " +
                "hook enumerates for acquire and release.",
        );
    }
    const active = foldTexturePushes(
        context,
        plugin,
        getActiveTextures,
        "getActiveTextures",
        // `getActiveTextures` pushes the `Texture2D` itself.
        (argument) => argument,
    );
    if (active.length !== bound.length) {
        context.fail(
            getActiveTextures,
            `MaterialPlugin "${plugin}" binds ${bound.length} texture(s) ` +
                `and reports ${active.length} active; the two name the ` +
                "same textures upstream, one for the bind group and one " +
                "for the lifetime.",
        );
    }
    active.forEach((entry, index) => {
        const expected = bound[index]!;
        if (!sameResolvedTexture(entry.identity, expected.identity)) {
            context.fail(
                entry.node,
                `MaterialPlugin "${plugin}" reports a different texture at ` +
                    `position ${index} than it binds there; the pin binds ` +
                    "by position and keeps alive by identity, so a " +
                    "disagreement retires a texture a draw still samples.",
            );
        }
    });
    return bound;
}

/**
 * The textures one `out.push(...)` body names, in push order.
 *
 * Both members are the same statement shape upstream — a body of pushes
 * onto the array parameter — differing only in what is pushed:
 * `bindTextures` pushes `{ texture }` records and `getActiveTextures` the
 * `Texture2D` itself.
 */
function foldTexturePushes(
    context: MaterialPluginContext,
    plugin: string,
    declaration: ts.FunctionLikeDeclaration,
    member: string,
    pushedTexture: (argument: ts.Expression) => ts.Expression,
): readonly MaterialPluginTextureBinding[] {
    const parameter = declaration.parameters[0];
    if (
        declaration.parameters.length !== 1 ||
        !parameter ||
        !ts.isIdentifier(parameter.name)
    ) {
        context.fail(
            declaration,
            `MaterialPlugin.${member} takes the pin's own output array as ` +
                "its one parameter.",
        );
    }
    const outName = parameter.name.text;
    const body = declaration.body;
    if (!body || !ts.isBlock(body)) {
        context.fail(
            declaration,
            `MaterialPlugin.${member} pushes onto its output array, so its ` +
                "body is a block of push statements.",
        );
    }
    const textures: MaterialPluginTextureBinding[] = [];
    const aliases = new Map<ts.Symbol, ResolvedTextureIdentity>();
    const identityFor = (node: ts.Expression): ResolvedTextureIdentity => {
        const identity = resolveTextureIdentity(context, member, node);
        const alias =
            identity.root === "this" ? undefined : aliases.get(identity.root);
        return alias
            ? { root: alias.root, path: [...alias.path, ...identity.path] }
            : identity;
    };
    const elementsFor = (node: ts.Expression): readonly Value[] => {
        if (!isPlainReference(context, node))
            context.fail(
                node,
                "Plugin texture lists require an existing array reference.",
            );
        const array = context.compileValue(node);
        if (array.tupleElements || array.staticElements)
            return array.tupleElements ?? array.staticElements!;
        if (array.dataType?.kind === "product") {
            return array.dataType.elements.map((_type, index) =>
                context.dataLowerer.fixedTupleElement(array, index, node)!,
            );
        }
        const cardinality = array.collectionCardinality;
        const sourceType = context.checker.getTypeAtLocation(node);
        if (
            array.dataType?.kind === "vector" &&
            cardinality?.kind === "array" &&
            cardinality.count !== undefined &&
            cardinality.varyingIn.size === 0 &&
            context.checker.isTupleType(sourceType) &&
            (sourceType as ts.TupleTypeReference).target.readonly
        ) {
            const element = array.dataType.element;
            return Array.from({ length: cardinality.count }, (_unused, index) =>
                context.dataValue(`${array.cpp}[${index}]`, element),
            );
        }
        return context.fail(
            node,
            "Plugin texture lists require a fixed, generation-known order.",
        );
    };
    const walk = (statements: readonly ts.Statement[]): void => {
        for (const statement of statements) {
            if (ts.isForOfStatement(statement)) {
                if (
                    statement.awaitModifier ||
                    !ts.isVariableDeclarationList(statement.initializer) ||
                    statement.initializer.declarations.length !== 1
                )
                    context.fail(
                        statement,
                        "Plugin texture iteration requires one local binding.",
                    );
                const variable = statement.initializer.declarations[0]!;
                if (!ts.isIdentifier(variable.name))
                    context.fail(
                        variable,
                        "Plugin texture iteration requires a named local.",
                    );
                const name = variable.name;
                const symbol = declaredSymbol(context.checker, name);
                if (!symbol)
                    context.fail(
                        variable,
                        "Plugin texture iteration has no source binding.",
                    );
                const identity = identityFor(statement.expression);
                const elements = elementsFor(statement.expression);
                elements.forEach((value, index) => {
                    aliases.set(symbol, {
                        root: identity.root,
                        path: [...identity.path, `[${index}]`],
                    });
                    // This fold accepts only pushes of existing texture
                    // identities; no runtime iteration binding is needed.
                    context.bindings.withBoundParameters(
                        [{ name, value, compileTime: true }],
                        () =>
                            walk(
                                ts.isBlock(statement.statement)
                                    ? statement.statement.statements
                                    : [statement.statement],
                            ),
                    );
                });
                aliases.delete(symbol);
                continue;
            }
            if (!ts.isExpressionStatement(statement)) {
                context.fail(
                    statement,
                    `MaterialPlugin.${member}'s reached body is a sequence of ` +
                        `${outName}.push(...) calls; a statement that computes ` +
                        "would decide at run time what the pin reads once.",
                );
            }
            const call = context.unwrap(statement.expression);
            if (
                !ts.isCallExpression(call) ||
                !ts.isPropertyAccessExpression(call.expression) ||
                call.expression.name.text !== "push" ||
                !ts.isIdentifier(call.expression.expression) ||
                call.expression.expression.text !== outName
            ) {
                context.fail(
                    statement,
                    `MaterialPlugin.${member} fills the pin's output array ` +
                        `through ${outName}.push(...).`,
                );
            }
            for (const argument of call.arguments) {
                if (ts.isSpreadElement(argument)) {
                    if (member !== "getActiveTextures")
                        context.fail(
                            argument,
                            "Plugin binding records require explicit texture properties.",
                        );
                    const identity = identityFor(argument.expression);
                    elementsFor(argument.expression).forEach((value, index) =>
                        textures.push(
                            foldPluginTexture(
                                context,
                                plugin,
                                member,
                                argument.expression,
                                value,
                                {
                                    root: identity.root,
                                    path: [...identity.path, `[${index}]`],
                                },
                            ),
                        ),
                    );
                    continue;
                }
                const node = pushedTexture(argument);
                textures.push(
                    foldPluginTexture(
                        context,
                        plugin,
                        member,
                        node,
                        undefined,
                        identityFor(node),
                    ),
                );
            }
        }
    };
    walk(body.statements);
    return textures;
}

/** The texture a pushed `PluginTextureBinding` names. */
function pluginTextureBindingTexture(
    context: MaterialPluginContext,
    argument: ts.Expression,
): ts.Expression {
    const object = context.unwrap(argument);
    const [property, ...rest] = ts.isObjectLiteralExpression(object)
        ? object.properties
        : [];
    if (
        !property ||
        rest.length > 0 ||
        (!ts.isPropertyAssignment(property) &&
            !ts.isShorthandPropertyAssignment(property)) ||
        !property.name ||
        context.propertyName(property.name) !== "texture"
    ) {
        context.fail(
            argument,
            "bindTextures pushes the pin's own PluginTextureBinding, an " +
                "object carrying exactly one property, `texture`; the pin " +
                "reads no GPU handle off it.",
        );
    }
    return ts.isShorthandPropertyAssignment(property)
        ? property.name
        : property.initializer;
}

/** One pushed texture, lowered to the local the scene created it in. */
function foldPluginTexture(
    context: MaterialPluginContext,
    plugin: string,
    member: string,
    node: ts.Expression,
    knownValue?: Value,
    identity?: ResolvedTextureIdentity,
): MaterialPluginTextureBinding {
    // A plain reference, so lowering it reads a binding rather than
    // emitting: the two members name the SAME textures, so each is compiled
    // twice and a producing expression would create the texture twice --
    // once per member, in a body the pin calls per bind-group build.
    if (!isPlainReference(context, node)) {
        context.fail(
            node,
            `MaterialPlugin.${member} names a texture the scene already ` +
                "made, through a plain reference; an expression that " +
                "produces one runs per bind-group build upstream and would " +
                "be lowered once per member here.",
        );
    }
    const compiled = knownValue ?? context.compileValue(node);
    const value: Value =
        compiled.kind === "texture" &&
        !compiled.textureStorage &&
        compiled.dataType?.kind === "handle" &&
        compiled.dataType.handle === "texture"
            ? { ...compiled, textureStorage: "stored" }
            : compiled;
    if (value.kind !== "texture") {
        context.fail(
            node,
            `MaterialPlugin "${plugin}" names a ${value.kind} where its ` +
                `${member} takes a Texture2D.`,
        );
    }
    if (
        value.textureStorage !== "file" &&
        value.textureStorage !== "pixels" &&
        value.textureStorage !== "stored"
    ) {
        context.fail(
            node,
            `MaterialPlugin "${plugin}" binds a ` +
                `${value.textureStorage ?? "handle-backed"} texture; a ` +
                "plugin binding takes a loaded image or the texels " +
                "createTexture2DFromPixels was handed, which are the two " +
                "the material record stores.",
        );
    }
    return {
        value,
        node,
        identity: identity ?? resolveTextureIdentity(context, member, node),
    };
}

/** An identifier or a property path over identifiers -- a read, not a call. */
function isPlainReference(
    context: MaterialPluginContext,
    expression: ts.Expression,
): boolean {
    let node = context.unwrap(expression);
    while (ts.isPropertyAccessExpression(node)) {
        node = context.unwrap(node.expression);
    }
    return ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword;
}

/**
 * The one expression a folded plugin member returns.
 *
 * The pin calls each of these once, at composition, so the reached body is
 * a `return` or an arrow's expression — a statement before it would decide
 * the composed shape at run time.
 */
function foldSingleReturn(
    context: MaterialPluginContext,
    declaration: ts.FunctionLikeDeclaration,
    subject: string,
): ts.Expression {
    const body = declaration.body;
    if (!body) {
        context.fail(declaration, `${subject} is missing.`);
    }
    if (!ts.isBlock(body)) return body;
    const [statement, ...rest] = body.statements;
    if (
        !statement ||
        rest.length > 0 ||
        !ts.isReturnStatement(statement) ||
        !statement.expression
    ) {
        context.fail(
            body,
            `${subject} is one return of a value; the pin reads it once at ` +
                "composition, so a statement that computes is not folded.",
        );
    }
    return statement.expression;
}

/**
 * `getCustomCode(shaderType)` run at one argument.
 *
 * The pin calls it once per shader type at composition, so it is executed
 * at each argument value (`executeApplicationFunction`), closing over the
 * module constants and the enclosing bindings the compiler folds. What it
 * returns is `null` or the point-to-WGSL record read here; nothing in it
 * reaches a run time.
 */
function foldCustomCode(
    context: MaterialPluginContext,
    declaration: ts.FunctionLikeDeclaration,
    shaderType: "fragment" | "vertex",
    accepted: ReadonlySet<string>,
): Readonly<Record<string, string>> | undefined {
    const value = executeApplicationFunction(
        {
            checker: context.checker,
            fail: (node, message) => context.fail(node, message),
            foldEnclosing: (identifier) => {
                const folded = context.compileValue(identifier);
                return (
                    folded.staticString ??
                    folded.staticBoolean ??
                    folded.staticNumber
                );
            },
        },
        declaration,
        [shaderType],
        "getCustomCode",
    );
    if (value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
        return context.fail(
            declaration,
            "getCustomCode returns null or a record keyed by the pin's " +
                "injection points.",
        );
    }
    const code: Record<string, string> = {};
    for (const [point, text] of Object.entries(value)) {
        if (!accepted.has(point)) {
            context.fail(
                declaration,
                `${point} is not an injection point the pin maps onto a ` +
                    `template slot; it accepts ${[...accepted]
                        .sort()
                        .join(", ")}.`,
            );
        }
        if (typeof text !== "string") {
            context.fail(
                declaration,
                `getCustomCode maps ${point} to ${typeof text}, not WGSL text.`,
            );
        }
        code[point] = text;
    }
    return Object.keys(code).length > 0 ? code : undefined;
}
