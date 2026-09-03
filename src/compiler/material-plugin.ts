/**
 * The `MaterialPlugin` a scene declares, folded to plain data.
 *
 * A plugin is a plain object upstream (`material/plugin/material-plugin.ts`
 * is types only), and everything the pin's bridges read off one for the
 * reached slice is a constant the scene wrote: its `name`, the WGSL
 * `getCustomCode(shaderType)` returns per injection point, and the texture
 * and sampler NAMES `getSamplers()` declares. So the plugin is folded
 * rather than executed — the fidelity rule's first answer, and the one
 * available here because the value is literal text rather than something
 * only an engine can produce.
 *
 * What the fold does NOT do is decide where that text lands. The injection
 * point to template slot mapping, the concatenation of several plugins into
 * one slot, the binding declarations the sampler pairs become and the
 * per-signature index that keys the compose and pipeline caches are all
 * `plugin-bridge-shared.ts`, executed at composition
 * (`src/pinned-material-plugins.ts`). This module only reads the scene's
 * declaration and checks each point name against the pin's own two tables,
 * so a plugin naming a point upstream has no slot for fails here with a
 * source location instead of composing a fragment that silently drops it.
 *
 * The two texture members are folded as a pair. `getSamplers` declares the
 * bindings, `bindTextures` fills them positionally, and `getActiveTextures`
 * enumerates the same textures for the pin's acquire and release — upstream
 * trusts the plugin author to keep the three in step, and a mismatch there
 * binds the wrong texture or retires a live one. Nothing runs at generation
 * that could observe the disagreement, so the fold proves it instead: equal
 * counts, and the same RESOLVED texture at each position — the declaration
 * each reference names, never the C++ spelling it renders as.
 *
 * A plugin reached through a factory folds the same way. Scene code writes
 * `mat.plugins = [createStudMaterialPlugin(studs)]` as readily as it writes
 * the object inline, because the texture members close over the argument.
 * The call is therefore seen THROUGH rather than executed: the callee is
 * resolved by the compiler's own identifier-to-declaration resolver, its
 * body has to be one return of an object literal, and its parameters are
 * bound to the values the call site passed. No statement runs and no branch
 * is taken, so the object folded is the one the pin would have been handed.
 *
 * The declared names are checked against the WHOLE material's composition,
 * because that is the scope the pin composes in: one fragment out of the
 * whole plugin list, spliced into a variant that already declares the
 * Standard family's own bindings. So a name is refused when a second plugin
 * in the same list declares it, and when it is one the composed variant
 * declares for itself — the latter read from the one list the generated
 * `standard_binding_resources` table is rendered from, never restated here.
 *
 * Everything past that refuses by name: `priority`, `isEnabled`, `defines`,
 * `getUniforms` and `writeUbo`. The last two would put a uniform block into
 * the PBR material UBO or build the Standard self-managed `pluginUbo`,
 * which is a second bind-group contract no measurement covers. So does a
 * PBR material's `getSamplers`, whose entries the pin appends inside
 * `createPbrMeshBindGroup` against a row keyed by material index — a
 * different path from the Standard record lane this port binds.
 */
import ts from "typescript";
import { LoweringContext } from "../lowering/context.js";
import { sharedUpstreamStore } from "../upstream-source.js";
import { tryResolveFunctionDeclaration } from "./user-functions.js";
import type {
    MaterialPluginManifest,
    MaterialPluginSamplerManifest,
} from "../pinned-material-plugins.js";
// The pin's own Standard binding names, from the one list the generated
// `standard_binding_resources` table is rendered from.
import { standardBuiltinBindingNames } from "../pinned-standard-variants.js";
import type { Value } from "./types.js";

/** Which family's bind path the material a plugin attaches to takes. */
export type MaterialPluginFamily = "standard" | "pbr";

/** The compiler surface a fold needs; the entry orchestrator supplies it. */
export interface MaterialPluginContext {
    readonly checker: ts.TypeChecker;
    resolveStaticExpression(expression: ts.Expression): ts.Expression;
    unwrap(expression: ts.Expression): ts.Expression;
    propertyName(name: ts.PropertyName): string | undefined;
    probeStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression | undefined;
    compileStaticString(expression: ts.Expression): string;
    compileValue(expression: ts.Expression): Value;
    /** Runs `work` with an inlined function's parameters bound in a scope. */
    withBoundParameters<T>(
        parameters: readonly { name: ts.Identifier; value: Value }[],
        work: () => T,
    ): T;
    fail(node: ts.Node, message: string): never;
}

/** One texture a plugin's `bindTextures` binds, and where it came from. */
export interface MaterialPluginTextureBinding {
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
    return left.root === right.root &&
        left.path.length === right.path.length &&
        left.path.every((name, index) => name === right.path[index]);
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
        ? context.checker.getSymbolAtLocation(node)
        : undefined;
    if (!symbol) {
        context.fail(
            expression,
            `MaterialPlugin.${member} names a texture the fold cannot ` +
                "resolve to a declaration, so it cannot prove the same " +
                "texture is bound and kept alive.",
        );
    }
    return {
        root: symbol.flags & ts.SymbolFlags.Alias
            ? context.checker.getAliasedSymbol(symbol)
            : symbol,
        path,
    };
}

/** A folded `material.plugins = [...]` right-hand side. */
export interface FoldedMaterialPlugins {
    /** The plugin list, in the order the scene wrote it. */
    manifests: MaterialPluginManifest[];
    /**
     * Every texture the list binds, concatenated in the order
     * `bindPluginTextures` pushes them — plugin by plugin, and within one
     * plugin in `bindTextures` order, which is the order its `getSamplers`
     * declarations were composed in.
     */
    textures: readonly MaterialPluginTextureBinding[];
}

/** The plugin members whose presence reaches machinery this port lacks. */
const refusedMembers: Readonly<Record<string, string>> = {
    priority:
        "orders the plugins on one material, which only a second plugin " +
        "can observe",
    isEnabled:
        "is the pin's toggle; a disabled plugin still takes an index, and " +
        "the toggle is a run-time rebuild",
    defines: "folds into the signature and reaches no composed WGSL here",
    getUniforms:
        "puts fields into the PBR material UBO and builds the Standard " +
        "self-managed pluginUbo, neither of which this port binds",
    writeUbo: "fills the uniforms getUniforms declares",
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
    const context = new LoweringContext(sharedUpstreamStore());
    const file = context.sourceFile(PLUGIN_BRIDGE);
    const { declaration } = context.functionDeclaration(
        PLUGIN_BRIDGE,
        "buildPluginFragment",
    );
    const names = (constant: string): string[] =>
        context.objectInitializer(file, constant).properties.map(
            (property) => {
                const name = property.name &&
                    context.propertyName(property.name);
                if (name === undefined) {
                    return context.contractError(
                        property,
                        `Pinned ${constant} carries an entry that is not a ` +
                            "plain named injection point.",
                    );
                }
                return name;
            },
        );
    contract = {
        fragmentPoints: new Set([
            ...names("FRAG_POINT_TO_SLOTS"),
            definitionsPoint(context, declaration),
        ]),
        vertexPoints: new Set(names("VERT_POINT_TO_SLOT")),
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
            node.operatorToken.kind ===
                ts.SyntaxKind.EqualsEqualsEqualsToken &&
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
            node.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken &&
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
    const declared = new Map<string, string>();
    const folded = array.elements.map((element) =>
        foldMaterialPlugin(context, element, family, declared),
    );
    return {
        manifests: folded.map((plugin) => plugin.manifest),
        textures: folded.flatMap((plugin) => plugin.textures),
    };
}

/** One folded plugin: what composes, and what its bindings are filled with. */
interface FoldedMaterialPlugin {
    manifest: MaterialPluginManifest;
    textures: readonly MaterialPluginTextureBinding[];
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
}

function pluginObjectSite(
    context: MaterialPluginContext,
    expression: ts.Expression,
): PluginObjectSite {
    const resolved = context.unwrap(context.resolveStaticExpression(expression));
    if (ts.isObjectLiteralExpression(resolved)) {
        return { object: resolved, bindings: [] };
    }
    if (ts.isCallExpression(resolved)) {
        return pluginFactorySite(context, resolved);
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
            value: context.compileValue(call.arguments[index]!),
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
    return context.withBoundParameters(site.bindings, () =>
        foldPluginObject(context, expression, site.object, family, declared),
    );
}

function foldPluginObject(
    context: MaterialPluginContext,
    expression: ts.Expression,
    object: ts.ObjectLiteralExpression,
    family: MaterialPluginFamily,
    declared: Map<string, string>,
): FoldedMaterialPlugin {
    let name: string | undefined;
    let getCustomCode: ts.FunctionLikeDeclaration | undefined;
    let getSamplers: ts.FunctionLikeDeclaration | undefined;
    let bindTextures: ts.FunctionLikeDeclaration | undefined;
    let getActiveTextures: ts.FunctionLikeDeclaration | undefined;
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
            if (family === "pbr") {
                // The family constraint refuses at the declaration rather
                // than at the assignment, so nothing downstream compiles a
                // texture value for a binding this port cannot build.
                context.fail(
                    property,
                    "A PBR material plugin declaring samplers needs the " +
                        "PBR family's own plugin bind-group contract: its " +
                        "draw resolves the variant by material index and " +
                        "appends the plugin's entries in " +
                        "createPbrMeshBindGroup, which is a different path " +
                        "from the Standard record lane this port binds and " +
                        "which no scene measures.",
                );
            }
            getSamplers = method(property, member);
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
        ? foldSamplerDeclarations(context, name, getSamplers, declared)
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
        },
        textures,
    };
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
        const object = context.unwrap(
            context.resolveStaticExpression(element),
        );
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
        } = {};
        for (const property of object.properties) {
            const field = property.name &&
                context.propertyName(property.name);
            if (field === undefined || !ts.isPropertyAssignment(property)) {
                context.fail(
                    property,
                    "A PluginSamplerDecl field is a plain named property " +
                        "with a value.",
                );
            }
            if (
                field !== "texture" && field !== "sampler" &&
                field !== "textureType" && field !== "samplerType"
            ) {
                context.fail(
                    property,
                    `PluginSamplerDecl.${field} is not part of the pinned ` +
                        "declaration.",
                );
            }
            const value = context.compileStaticString(property.initializer);
            if (field === "textureType" && value !== pinned.textureType) {
                context.fail(
                    property,
                    `PluginSamplerDecl.textureType '${value}' is not the ` +
                        `pin's own '${pinned.textureType}'; a plugin ` +
                        "texture binds through the sampled-2D path both " +
                        "backends upload, and nothing measures another.",
                );
            }
            if (field === "samplerType" && value !== pinned.samplerType) {
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
    for (const statement of body.statements) {
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
            textures.push(
                foldPluginTexture(
                    context,
                    plugin,
                    member,
                    pushedTexture(argument),
                ),
            );
        }
    }
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
        !ts.isPropertyAssignment(property) ||
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
    return property.initializer;
}

/** One pushed texture, lowered to the local the scene created it in. */
function foldPluginTexture(
    context: MaterialPluginContext,
    plugin: string,
    member: string,
    node: ts.Expression,
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
    const value = context.compileValue(node);
    if (value.kind !== "texture") {
        context.fail(
            node,
            `MaterialPlugin "${plugin}" names a ${value.kind} where its ` +
                `${member} takes a Texture2D.`,
        );
    }
    if (
        value.textureStorage !== "file" &&
        value.textureStorage !== "pixels"
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
        identity: resolveTextureIdentity(context, member, node),
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
 * `getCustomCode(shaderType)` evaluated at one argument.
 *
 * Two body shapes reach: a block whose shader-type guard returns null for
 * the other type and an injection-point record for this one, and the arrow
 * whose whole body is that choice as a conditional expression. Both halves
 * are constants either way, so the call is folded at each of the pin's two
 * argument values rather than lowered — nothing in it reaches a run time.
 */
function foldCustomCode(
    context: MaterialPluginContext,
    declaration: ts.FunctionLikeDeclaration,
    shaderType: "fragment" | "vertex",
    accepted: ReadonlySet<string>,
): Readonly<Record<string, string>> | undefined {
    const parameter = declaration.parameters[0];
    const parameterName = parameter && ts.isIdentifier(parameter.name)
        ? parameter.name.text
        : undefined;
    const body = declaration.body;
    if (!body) {
        context.fail(declaration, "getCustomCode has no body.");
    }
    if (!ts.isBlock(body)) {
        return foldCustomCodeChoice(
            context,
            body,
            parameterName,
            shaderType,
            accepted,
        );
    }
    for (const statement of body.statements) {
        if (ts.isIfStatement(statement)) {
            if (statement.elseStatement) {
                context.fail(
                    statement,
                    "getCustomCode's shader-type guard takes no else branch.",
                );
            }
            if (
                !guardHolds(
                    context,
                    statement.expression,
                    parameterName,
                    shaderType,
                )
            ) {
                continue;
            }
            const returned = onlyReturn(statement.thenStatement);
            if (!returned) {
                context.fail(
                    statement,
                    "getCustomCode's shader-type guard returns a value.",
                );
            }
            return foldCustomCodeValue(context, returned, accepted);
        }
        if (ts.isReturnStatement(statement)) {
            if (!statement.expression) {
                context.fail(
                    statement,
                    "getCustomCode returns a value or null.",
                );
            }
            return foldCustomCodeValue(
                context,
                statement.expression,
                accepted,
            );
        }
        context.fail(
            statement,
            "getCustomCode's reached body is a shader-type guard and a " +
                "return; a statement that computes is not folded, because " +
                "the pin calls it at generation and never again.",
        );
    }
    context.fail(
        declaration,
        "getCustomCode falls off its body without returning.",
    );
}

/**
 * An arrow whose whole body is the shader-type choice.
 *
 * `shaderType === "fragment" ? { ... } : null` is the same fold as the
 * block's guard-and-return, written as one expression — which is how the
 * corpus writes it. The condition is evaluated at each of the pin's two
 * argument values and the arm it selects is folded.
 */
function foldCustomCodeChoice(
    context: MaterialPluginContext,
    body: ts.Expression,
    parameterName: string | undefined,
    shaderType: "fragment" | "vertex",
    accepted: ReadonlySet<string>,
): Readonly<Record<string, string>> | undefined {
    const expression = context.unwrap(body);
    if (!ts.isConditionalExpression(expression)) {
        return foldCustomCodeValue(context, expression, accepted);
    }
    const selected = guardHolds(
        context,
        expression.condition,
        parameterName,
        shaderType,
    )
        ? expression.whenTrue
        : expression.whenFalse;
    return foldCustomCodeValue(context, selected, accepted);
}

/** The single `return` a guard's branch carries. */
function onlyReturn(branch: ts.Statement): ts.Expression | undefined {
    const statement = ts.isBlock(branch)
        ? branch.statements.length === 1 ? branch.statements[0] : undefined
        : branch;
    return statement && ts.isReturnStatement(statement)
        ? statement.expression
        : undefined;
}

/**
 * Whether the shader-type guard holds at `shaderType`.
 *
 * Both spellings reach: the statement form writes `shaderType !== "<type>"`
 * before an early `return null`, and the expression form writes
 * `shaderType === "<type>"` before the record. Over the pin's two argument
 * values each is decided by one string comparison, so both fold — a guard
 * comparing anything else refuses, because the pin calls this once at
 * composition and the answer has to be a constant.
 */
function guardHolds(
    context: MaterialPluginContext,
    condition: ts.Expression,
    parameterName: string | undefined,
    shaderType: "fragment" | "vertex",
): boolean {
    const expression = context.unwrap(condition);
    if (!ts.isBinaryExpression(expression)) {
        context.fail(
            condition,
            "getCustomCode's guard compares its shader-type parameter " +
                "against a string literal with `===` or `!==`.",
        );
    }
    const operator = expression.operatorToken.kind;
    if (
        operator !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
        operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
        context.fail(
            condition,
            "getCustomCode's guard compares its shader-type parameter " +
                "against a string literal with `===` or `!==`.",
        );
    }
    const left = context.unwrap(expression.left);
    const right = context.unwrap(expression.right);
    if (
        !ts.isIdentifier(left) ||
        left.text !== parameterName ||
        !ts.isStringLiteral(right)
    ) {
        context.fail(
            condition,
            "getCustomCode's guard compares its shader-type parameter " +
                "against a string literal.",
        );
    }
    return operator === ts.SyntaxKind.EqualsEqualsEqualsToken
        ? right.text === shaderType
        : right.text !== shaderType;
}

/** `null`, or the point-to-WGSL record a `return` hands back. */
function foldCustomCodeValue(
    context: MaterialPluginContext,
    expression: ts.Expression,
    accepted: ReadonlySet<string>,
): Readonly<Record<string, string>> | undefined {
    const value = context.unwrap(context.resolveStaticExpression(expression));
    if (value.kind === ts.SyntaxKind.NullKeyword) return undefined;
    if (!ts.isObjectLiteralExpression(value)) {
        context.fail(
            expression,
            "getCustomCode returns null or an object literal keyed by the " +
                "pin's injection points.",
        );
    }
    const code: Record<string, string> = {};
    for (const property of value.properties) {
        if (!ts.isPropertyAssignment(property)) {
            context.fail(
                property,
                "An injection point maps to its WGSL by a plain property.",
            );
        }
        const point = context.propertyName(property.name);
        if (point === undefined) {
            context.fail(property.name, "An injection point has a name.");
        }
        if (!accepted.has(point)) {
            context.fail(
                property.name,
                `${point} is not an injection point the pin maps onto a ` +
                    `template slot; it accepts ${
                        [...accepted].sort().join(", ")
                    }.`,
            );
        }
        // The pin splices this text into the composed fragment at
        // generation, so a value assembled from state would need a shader
        // this port never composed -- `compileStaticString` accepts exactly
        // the compile-time forms.
        code[point] = context.compileStaticString(property.initializer);
    }
    return Object.keys(code).length > 0 ? code : undefined;
}
