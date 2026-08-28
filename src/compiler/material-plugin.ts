/**
 * The `MaterialPlugin` a scene declares, folded to plain data.
 *
 * A plugin is a plain object upstream (`material/plugin/material-plugin.ts`
 * is types only), and everything the pin's bridges read off one for the
 * reached slice is a constant the scene wrote: its `name`, and the WGSL
 * `getCustomCode(shaderType)` returns per injection point. So the plugin is
 * folded rather than executed — the fidelity rule's first answer, and the
 * one available here because the value is literal text rather than something
 * only an engine can produce.
 *
 * What the fold does NOT do is decide where that text lands. The injection
 * point to template slot mapping, the concatenation of several plugins into
 * one slot, and the per-signature index that keys the compose and pipeline
 * caches are all `plugin-bridge-shared.ts`, executed at composition
 * (`src/pinned-material-plugins.ts`). This module only reads the scene's
 * declaration and checks each point name against the pin's own two tables,
 * so a plugin naming a point upstream has no slot for fails here with a
 * source location instead of composing a fragment that silently drops it.
 *
 * Everything past the reached slice refuses by name: `priority`,
 * `isEnabled`, `defines`, `getUniforms`, `getSamplers`, `writeUbo`,
 * `bindTextures` and `getActiveTextures`. Each of the last four would put a
 * uniform block, a binding or a texture into the composed fragment, which is
 * a native bind-group contract this port has nothing to bind — the reached
 * slice adds no binding at all, which is what makes it free.
 */
import ts from "typescript";
import { LoweringContext } from "../lowering/context.js";
import { sharedUpstreamStore } from "../upstream-source.js";
import type { MaterialPluginManifest } from "../pinned-material-plugins.js";

/** The compiler surface a fold needs; the entry orchestrator supplies it. */
export interface MaterialPluginContext {
    resolveStaticExpression(expression: ts.Expression): ts.Expression;
    unwrap(expression: ts.Expression): ts.Expression;
    propertyName(name: ts.PropertyName): string | undefined;
    probeStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression | undefined;
    compileStaticString(expression: ts.Expression): string;
    fail(node: ts.Node, message: string): never;
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
    getSamplers:
        "declares texture and sampler bindings the composed fragment " +
        "reads, which this port does not build a bind group for",
    writeUbo: "fills the uniforms getUniforms declares",
    bindTextures: "binds the textures getSamplers declares",
    getActiveTextures: "enumerates those textures for acquire and release",
};

/**
 * The injection points the pin maps onto a template slot.
 *
 * `FRAG_POINT_TO_SLOTS` and `VERT_POINT_TO_SLOT` are module-private
 * upstream, so they are read from the pinned declaration rather than
 * restated — a point the pin adds becomes accepted here without an edit, and
 * one it drops fails instead of composing nothing.
 */
interface InjectionPoints {
    fragment: ReadonlySet<string>;
    vertex: ReadonlySet<string>;
}

const PLUGIN_BRIDGE = "src/material/plugin/plugin-bridge-shared.ts";

let points: InjectionPoints | undefined;

function injectionPoints(): InjectionPoints {
    if (points) return points;
    const context = new LoweringContext(sharedUpstreamStore());
    const file = context.sourceFile(PLUGIN_BRIDGE);
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
    points = {
        fragment: new Set([
            ...names("FRAG_POINT_TO_SLOTS"),
            definitionsPoint(context),
        ]),
        vertex: new Set(names("VERT_POINT_TO_SLOT")),
    };
    return points;
}

/**
 * The point `buildPluginFragment` handles ahead of the slot lookup.
 *
 * It appends to the fragment's helper functions rather than to a slot, so it
 * appears in neither table — the branch that recognizes it is the only place
 * upstream names it, and reading the literal from there is what keeps this
 * from being a spelling typed twice.
 */
function definitionsPoint(context: LoweringContext): string {
    const { declaration } = context.functionDeclaration(
        PLUGIN_BRIDGE,
        "buildPluginFragment",
    );
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
): MaterialPluginManifest[] {
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
    return array.elements.map((element) =>
        foldMaterialPlugin(context, element),
    );
}

/** One `MaterialPlugin` object literal. */
function foldMaterialPlugin(
    context: MaterialPluginContext,
    expression: ts.Expression,
): MaterialPluginManifest {
    const object = context.unwrap(context.resolveStaticExpression(expression));
    if (!ts.isObjectLiteralExpression(object)) {
        context.fail(
            expression,
            "A MaterialPlugin is a plain object literal upstream; this " +
                "port folds its name and its custom code at generation, so " +
                "a value it cannot see through is refused.",
        );
    }
    let name: string | undefined;
    let getCustomCode: ts.FunctionLikeDeclaration | undefined;
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
            if (ts.isMethodDeclaration(property)) {
                getCustomCode = property;
                continue;
            }
            if (
                ts.isPropertyAssignment(property) &&
                (ts.isArrowFunction(property.initializer) ||
                    ts.isFunctionExpression(property.initializer))
            ) {
                getCustomCode = property.initializer;
                continue;
            }
            context.fail(
                property,
                "MaterialPlugin.getCustomCode is a function of the shader " +
                    "type.",
            );
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
    const accepted = injectionPoints();
    const fragment = foldCustomCode(
        context,
        getCustomCode,
        "fragment",
        accepted.fragment,
    );
    const vertex = foldCustomCode(
        context,
        getCustomCode,
        "vertex",
        accepted.vertex,
    );
    if (!fragment && !vertex) {
        context.fail(
            expression,
            `MaterialPlugin "${name}" returns no custom code for either ` +
                "shader type, so it composes nothing.",
        );
    }
    return {
        name,
        ...(fragment ? { fragment } : {}),
        ...(vertex ? { vertex } : {}),
    };
}

/**
 * `getCustomCode(shaderType)` evaluated at one argument.
 *
 * The reached body is the corpus's own shape: a guard returning null for the
 * other shader type, then one object literal of point-to-WGSL entries. Both
 * halves are constants, so the call is folded at each of the pin's two
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
    if (!body || !ts.isBlock(body)) {
        context.fail(
            declaration,
            "getCustomCode's body is a block that returns null for one " +
                "shader type and an injection-point record for the other.",
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
                !guardExcludes(
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
 * Whether `condition` is the guard that excludes `shaderType`.
 *
 * The reached form is the corpus's `shaderType !== "fragment"`. Its mirror
 * `shaderType === "vertex"` means the same thing over the pin's two values
 * and would be as foldable, but nothing reaches it — so it refuses by shape
 * like every unreached plugin member above, rather than carrying an arm no
 * measurement covers.
 */
function guardExcludes(
    context: MaterialPluginContext,
    condition: ts.Expression,
    parameterName: string | undefined,
    shaderType: "fragment" | "vertex",
): boolean {
    const expression = context.unwrap(condition);
    if (
        !ts.isBinaryExpression(expression) ||
        expression.operatorToken.kind !==
            ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
        context.fail(
            condition,
            "getCustomCode's guard is `shaderType !== \"<type>\"`, which is " +
                "the one form the corpus writes.",
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
    return right.text !== shaderType;
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
