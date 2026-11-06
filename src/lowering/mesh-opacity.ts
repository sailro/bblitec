/**
 * Per-mesh opacity, from the pin's own modules (`src/mesh/opacity/`).
 *
 * `setMeshOpacity` stores the clamped value on the mesh rather than on its
 * material and sets `_skipColorDraw` at zero; below 1 the mesh-feature
 * encoder `ensureInstalled` installs adds the opacity bit, which routes the
 * mesh to the transparent pass: the Standard extension's `_meshFeatures`
 * adds its own bit and `MATERIAL_ALPHA_BLEND`, and the PBR renderable ORs
 * `PBR_HAS_ALPHA_BLEND` out of the mesh word. Both extensions compose their
 * fragment and their `meshOpacity` block at generation
 * (`registerPinnedMeshOpacity`); the per-binding policy and the block's
 * values are lowered here, beside the setter, the getter and the material
 * validator.
 *
 * What the native port holds instead of the pin's binding records: a draw
 * reads the record's opacity and its binding's policy when it fills the
 * block, so a write is live in every binding at once, and a device loss
 * leaves no stale buffer to retire.
 */
import ts from "typescript";
import {
    sharedPinnedContext,
    type LoweredSource,
    type LoweringContext,
} from "./context.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { jsToUint32Call } from "./pinned-operators.js";
import { recordAt } from "../compiler/record-access.js";
import { finalReturn } from "../compiler/loop-control.js";
import { conditionalExpression, selectionArms } from "../compiler/syntax.js";
import { javascriptModuleUrl } from "../data-url.js";
import { transpileForBrowser } from "../typescript-transpile.js";
import { importPinnedModule } from "../pinned-shader-composer.js";

const MODULE = "src/mesh/opacity/mesh-opacity.ts";
const STANDARD_MODULE = "src/mesh/opacity/mesh-opacity-standard.ts";
const PBR_MODULE = "src/mesh/opacity/mesh-opacity-pbr.ts";
const PBR_RENDERABLE = "src/material/pbr/pbr-renderable.ts";

/** `ensureInstalled`, whose every install has a native counterpart named below. */
function ensureInstalled(context: LoweringContext): ts.FunctionDeclaration {
    const { declaration } = context.functionDeclaration(
        MODULE,
        "ensureInstalled",
    );
    // - the two extensions: composition, registered at generation;
    // - the mesh-feature encoder: `pinned_mesh_feature_extra`;
    // - the PBR binding-context transport: the disposers that own a
    //   binding's buffer, which the native draw has no use for because it
    //   fills the block from the record;
    // - the material validator: `validate_mesh_opacity_material`, which
    //   `set_mesh_material` and scene registration call.
    context.assertFunctionBodyShape(
        declaration,
        `{
    if (_installed) { return; }
    _registerStdExt(meshOpacityStandardExt);
    _registerPbrExt(meshOpacityPbrExt);
    _installMeshFeatureExtra((mesh) => {
        if (_bindings) { retireStaleBindings(mesh); }
        return getMeshOpacity(mesh) < 1 ? 1 << 22 : 0;
    });
    _installPbrBindingContext((context, _id, disposers) => { context._disposers = disposers; });
    _installMeshMaterialValidator((mesh, material) => validateMaterial(mesh, material, getMeshOpacity(mesh)));
    _installed = true;
}`,
        "Mesh opacity installation",
    );
    return declaration;
}

/** The encoder's `getMeshOpacity(mesh) < 1 ? <bit> : 0`. */
function featureEncoder(context: LoweringContext): {
    file: ts.SourceFile;
    encoder: ts.ConditionalExpression;
} {
    const declaration = ensureInstalled(context);
    const install = context.findNodes(
        declaration,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            context.expressionMatchesShape(
                node.expression,
                "_installMeshFeatureExtra",
            ),
    )[0];
    const arrow = install?.arguments[0];
    const body =
        arrow && ts.isArrowFunction(arrow) && ts.isBlock(arrow.body)
            ? arrow.body
            : undefined;
    const returned = finalReturn(body)?.expression;
    const encoder = returned && conditionalExpression(returned);
    if (!encoder)
        return context.contractError(
            declaration,
            "Expected the mesh opacity feature encoder.",
        );
    return { file: declaration.getSourceFile(), encoder };
}

/**
 * The mesh-feature bit the encoder sets below opacity 1, which both
 * extensions read: the Standard one tests it in `_meshFeatures`, the PBR
 * one under its own feature-local name.
 */
export function meshOpacityFeatureBit(): number {
    const context = sharedPinnedContext();
    const { file, encoder } = featureEncoder(context);
    const bit = context.numericValue(selectionArms(encoder)[0], file);
    if (context.pinnedNumber(PBR_MODULE, "MESH_OPACITY_MESH_BIT") !== bit)
        context.contractError(
            encoder,
            "The PBR mesh opacity extension reads another mesh-feature bit.",
        );
    return bit;
}

let registered: Promise<void> | undefined;

/**
 * `ensureInstalled`'s two registrations, for a scene that reaches
 * `setMeshOpacity`. The Standard extension contributes only for a mesh word
 * carrying the opacity bit and the PBR one composes nothing without it, so
 * the registry stays inert for every word this scene composes without it.
 */
export function registerPinnedMeshOpacity(): Promise<void> {
    registered ??= (async () => {
        ensureInstalled(sharedPinnedContext());
        const [standardFlags, pbrFlags, standard, pbr] = await Promise.all([
            importPinnedModule<{ _registerStdExt: (ext: unknown) => void }>(
                "material/standard/standard-flags.js",
            ),
            importPinnedModule<{ _registerPbrExt: (ext: unknown) => void }>(
                "material/pbr/pbr-flags.js",
            ),
            importPinnedModule<{ meshOpacityStandardExt: unknown }>(
                "mesh/opacity/mesh-opacity-standard.js",
            ),
            importPinnedModule<{ meshOpacityPbrExt: unknown }>(
                "mesh/opacity/mesh-opacity-pbr.js",
            ),
        ]);
        standardFlags._registerStdExt(standard.meshOpacityStandardExt);
        pbrFlags._registerPbrExt(pbr.meshOpacityPbrExt);
    })();
    return registered;
}

/**
 * `buildPbrRenderables`' feature word: the material's own features with
 * `PBR_HAS_ALPHA_BLEND` ORed out of the mesh word outside the caster views.
 * The same pinned expression feeds the generation evaluator below and the
 * C++ lowering in `meshOpacityHeader`.
 */
function pbrRenderableFeatures(context: LoweringContext): {
    file: ts.SourceFile;
    initializer: ts.Expression;
    flags: ReadonlyMap<string, number>;
} {
    const { file, declaration } = context.functionDeclaration(
        PBR_RENDERABLE,
        "buildPbrRenderables",
    );
    const initializer = context.variableInitializer(declaration, "features");
    context.assertExpressionShape(
        initializer,
        "renderFeatures.features | (!(features2 & (PBR2_NO_COLOR_OUTPUT | PBR2_ESM_SHADOW_OUTPUT)) ? (meshFeatures >>> 16) & PBR_HAS_ALPHA_BLEND : 0)",
        "PBR renderable feature word",
    );
    return {
        file,
        initializer,
        flags: new Map(
            [
                "PBR2_NO_COLOR_OUTPUT",
                "PBR2_ESM_SHADOW_OUTPUT",
                "PBR_HAS_ALPHA_BLEND",
            ].map((name) => [name, context.pinnedNumber(file, name)]),
        ),
    };
}

type PbrRenderableFeatures = (
    features: number,
    features2: number,
    meshFeatures: number,
) => number;

let executedPbrFeatures: Promise<PbrRenderableFeatures> | undefined;

/** The PBR renderable's feature word, executed from the pin's own expression. */
export function pinnedPbrRenderableFeatures(): Promise<PbrRenderableFeatures> {
    if (executedPbrFeatures) return executedPbrFeatures;
    const { file, initializer, flags } = pbrRenderableFeatures(
        sharedPinnedContext(),
    );
    const source = `
${[...flags].map(([name, value]) => `const ${name} = ${value};`).join("\n")}
export function features(materialFeatures, features2, meshFeatures) {
    const renderFeatures = { features: materialFeatures };
    return ${initializer.getText(file)};
}
`;
    executedPbrFeatures = import(
        javascriptModuleUrl(transpileForBrowser(source, PBR_RENDERABLE))
    ).then((module: { features: PbrRenderableFeatures }) => module.features);
    return executedPbrFeatures;
}

/** A flag the pinned module names, as a C++ unsigned literal binding. */
function flagBinding(
    context: LoweringContext,
    module: string | ts.SourceFile,
    name: string,
): [string, PinnedBinding] {
    return [
        name,
        { cpp: `${context.pinnedNumber(module, name)}u`, type: "scalar" },
    ];
}

/** The one method an extension object literal carries under `name`. */
function extensionMethod(
    context: LoweringContext,
    module: string,
    extension: string,
    name: string,
): ts.MethodDeclaration & { body: ts.Block } {
    const file = context.sourceFile(module);
    return context.objectMethod(
        context.objectInitializer(file, extension),
        name,
    );
}

/** The expression a one-statement method returns. */
function onlyReturned(
    context: LoweringContext,
    method: ts.MethodDeclaration & { body: ts.Block },
    label: string,
): ts.Expression {
    const [only] = method.body.statements;
    if (
        method.body.statements.length !== 1 ||
        !only ||
        !ts.isReturnStatement(only) ||
        !only.expression
    )
        context.contractError(method, `Expected ${label} to return one word.`);
    return only.expression;
}

/**
 * `upstream/include/bblite/upstream/mesh_opacity.hpp`: the parts every
 * draw reads -- the encoder, the Standard mesh-phase bits, the PBR word,
 * the PBR binding policy and the block they fill.
 */
function meshOpacityHeader(context: LoweringContext): string {
    const { file, encoder } = featureEncoder(context);
    const extra = new PinnedNumericLowerer(file, {
        bindings: new Map(),
        calls: new Map(),
        expression(node) {
            return ts.isCallExpression(node) &&
                context.expressionMatchesShape(node, "getMeshOpacity(mesh)")
                ? "mesh.opacity"
                : undefined;
        },
    }).expression(encoder);
    const standardFile = context.sourceFile(STANDARD_MODULE);
    const standardFeatures = onlyReturned(
        context,
        extensionMethod(
            context,
            STANDARD_MODULE,
            "meshOpacityStandardExt",
            "_meshFeatures",
        ),
        "meshOpacityStandardExt._meshFeatures",
    );
    context.assertExpressionShape(
        standardFeatures,
        "meshFeatures & (1 << 22) && !((material?._renderFeatures?.features ?? 0) & (NO_COLOR_OUTPUT | ESM_SHADOW_OUTPUT)) ? STD_MESH_OPACITY_BIT | MATERIAL_ALPHA_BLEND : 0",
        "Standard mesh opacity bits",
    );
    const standard = new PinnedNumericLowerer(standardFile, {
        bindings: new Map<string, PinnedBinding>([
            ["meshFeatures", { cpp: "mesh_features", type: "scalar" }],
            [
                "(material?._renderFeatures?.features ?? 0)",
                { cpp: "render_features", type: "scalar" },
            ],
            ...[
                "NO_COLOR_OUTPUT",
                "ESM_SHADOW_OUTPUT",
                "STD_MESH_OPACITY_BIT",
                "MATERIAL_ALPHA_BLEND",
            ].map((name) => flagBinding(context, standardFile, name)),
        ]),
        calls: new Map(),
    }).expression(standardFeatures);
    const renderable = pbrRenderableFeatures(context);
    const pbrFeatures = new PinnedNumericLowerer(renderable.file, {
        bindings: new Map<string, PinnedBinding>([
            ["renderFeatures.features", { cpp: "features", type: "scalar" }],
            ["features2", { cpp: "features2", type: "scalar" }],
            ["meshFeatures", { cpp: "mesh_features", type: "scalar" }],
            ...[...renderable.flags.keys()].map((name) =>
                flagBinding(context, renderable.file, name),
            ),
        ]),
        calls: new Map(),
    }).expression(renderable.initializer);
    const policy = pbrBindingPolicy(context);
    const block = bindingBlock(context);
    return `#pragma once
#include <bblite/runtime.hpp>
#include <cstdint>

namespace bbl::upstream {
// ${context.provenance(MODULE, "ensureInstalled", "the installed mesh-feature encoder")}
// Its \`retireStaleBindings\` call retires buffers a lost device owned; a
// native draw fills its block from the record, so there are none.
inline std::uint32_t pinned_mesh_feature_extra(const MeshRecord& mesh) {
    return ${jsToUint32Call(extra)};
}
// ${context.provenance(STANDARD_MODULE, "meshOpacityStandardExt._meshFeatures")}
// \`render_features\` is the drawn material's word, a caster view's pass
// bit included.
inline std::uint32_t standard_mesh_opacity_features(
    std::uint32_t mesh_features, std::uint32_t render_features) {
    return ${jsToUint32Call(standard)};
}
// ${context.provenance(PBR_RENDERABLE, "buildPbrRenderables", "features")}
inline std::uint32_t pbr_renderable_features(
    std::uint32_t features, std::uint32_t features2, std::uint32_t mesh_features) {
    return ${jsToUint32Call(pbrFeatures)};
}
${policy}
${block}
} // namespace bbl::upstream
`;
}

/**
 * `meshOpacityPbrExt.bind`'s policy: 1 for a material with no alpha policy
 * of its own, from the drawn material's `_renderFeatures`. A forward draw
 * reads the material it draws, a geometry view its source -- natively the
 * same record, because a geometry pass draws the item's material itself.
 */
function pbrBindingPolicy(context: LoweringContext): string {
    const method = extensionMethod(
        context,
        PBR_MODULE,
        "meshOpacityPbrExt",
        "bind",
    );
    const file = method.getSourceFile();
    context.assertStatementShapes(
        method,
        method.body.statements,
        `if (!ctx._mesh) { throw new Error("PBR mesh opacity binding requires its mesh."); }
const material = ctx._material as Partial<MaterialView>;
const features = (ctx._features & PBR_HAS_ALPHA_BLEND ? material : (material.source ?? material))._renderFeatures;
const policy = features && !(features.features & (PBR_HAS_ALPHA_BLEND | PBR_HAS_ALPHA_TEST)) ? 1 : 0;
return _bindMeshOpacity(ctx._mesh, ctx._engine, entries, binding, ctx._disposers, "PBR", policy);`,
        "PBR mesh opacity binding",
    );
    // The asserted shape makes the policy `features && test ? 1 : 0`;
    // every PBR record carries its feature word, so its condition is `test`.
    const policy = conditionalExpression(
        context.variableInitializer(method, "policy"),
    );
    const condition = policy && context.unwrapExpression(policy.condition);
    if (!policy || !condition || !ts.isBinaryExpression(condition))
        return context.contractError(
            method,
            "Expected the PBR mesh opacity policy.",
        );
    const test = condition.right;
    const [whenTrue, whenFalse] = selectionArms(policy);
    const lowerer = new PinnedNumericLowerer(file, {
        bindings: new Map<string, PinnedBinding>([
            ["features.features", { cpp: "material_features", type: "scalar" }],
            flagBinding(context, file, "PBR_HAS_ALPHA_BLEND"),
            flagBinding(context, file, "PBR_HAS_ALPHA_TEST"),
        ]),
        calls: new Map(),
    });
    return `// ${context.provenance(PBR_MODULE, "meshOpacityPbrExt.bind", "policy")}
inline double pbr_mesh_opacity_policy(std::uint32_t material_features) {
    return ${lowerer.expression(test)} ? ${lowerer.expression(whenTrue)} : ${lowerer.expression(whenFalse)};
}`;
}

/**
 * `_bindMeshOpacity`'s block: \`_initialValue\` holds the opacity, then the
 * policy (Standard's binding passes the default 0 and its struct reads the
 * value alone). Padded to the 16 bytes a uniform binding takes.
 */
function bindingBlock(context: LoweringContext): string {
    const { declaration } = context.functionDeclaration(
        MODULE,
        "_bindMeshOpacity",
    );
    const stores = context.findNodes(
        declaration,
        (node): node is ts.ExpressionStatement =>
            ts.isExpressionStatement(node) &&
            ts.isBinaryExpression(node.expression) &&
            node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isElementAccessExpression(node.expression.left),
    );
    context.assertStatementShapes(
        declaration,
        stores,
        "_initialValue[0] = getMeshOpacity(mesh);\n_initialValue[1] = policy;",
        "Mesh opacity block layout",
    );
    context.assertExpressionShape(
        context.variableInitializer(
            context.sourceFile(MODULE),
            "_initialValue",
        ),
        "new F32(2)",
        "Mesh opacity block size",
    );
    return `// ${context.provenance(MODULE, "_bindMeshOpacity", "_initialValue")}
struct MeshOpacityUniforms {
    float value = 1.0f;
    float policy = 0.0f;
    float padding[2]{};
    bool operator==(const MeshOpacityUniforms&) const = default;
};
inline MeshOpacityUniforms mesh_opacity_uniforms(const MeshRecord& mesh, double policy) {
    MeshOpacityUniforms block;
    block.value = static_cast<float>(mesh.opacity);
    block.policy = static_cast<float>(policy);
    return block;
}`;
}

/** The record lanes the setter, the getter and the validator read. */
function meshBindings(): Map<string, PinnedBinding> {
    return new Map<string, PinnedBinding>([
        ["mesh._disposed", { cpp: "record.retired", type: "bool" }],
        ["mesh.name", { cpp: "record.name", type: "string" }],
        ["mesh._opacity", { cpp: "record.opacity", type: "scalar" }],
        [
            "mesh._skipColorDraw",
            { cpp: "record.skip_color_draw", type: "bool" },
        ],
    ]);
}

/**
 * `validateMaterial`: below 1 the drawn material must be Standard or PBR.
 * The family is the one `bind_render_item` decodes from the record's kind
 * flags (`material_family_name`).
 */
function lowerValidateMaterial(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        MODULE,
        "validateMaterial",
    );
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings: new Map<string, PinnedBinding>([
            ...meshBindings(),
            ["opacity", { cpp: "opacity", type: "scalar" }],
            [
                "material",
                {
                    cpp: "has_material",
                    type: "bool",
                },
            ],
            [
                "material._buildGroup?._materialFamily",
                { cpp: "family", type: "string" },
            ],
            ["family", { cpp: "family", type: "string" }],
        ]),
        calls: new Map(),
        statement(statement) {
            // `const family = material._buildGroup?._materialFamily` reads
            // the bound family itself.
            if (
                ts.isVariableStatement(statement) &&
                statement.declarationList.declarations.length === 1 &&
                context.expressionMatchesShape(
                    statement.declarationList.declarations[0]!.initializer!,
                    "material._buildGroup?._materialFamily",
                )
            )
                return [];
            return undefined;
        },
    });
    return `// ${context.provenance(MODULE, "validateMaterial")}
void validate_mesh_opacity_material(
    const Engine& engine, MeshHandle mesh, MaterialHandle material, double opacity) {
    const MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
    const bool has_material = material.value < engine.materials.size();
    const std::string family =
        has_material ? std::string(material_family_name(${recordAt("engine.materials", "material")})) : std::string();
${body}
}`;
}

/**
 * `setMeshOpacity`'s body up to its live binding writes. The compiler
 * admits Mesh values alone (`compileSetMeshOpacity`), the registrations are
 * composition done at generation, and a crossing of 1 rebuilds the mesh's
 * renderables: the native render plan is where a bucket and a pipeline are
 * chosen, so a scene publishing no material outputs rebuilds it from its
 * membership version, as the mirrored-mesh watcher does.
 */
function lowerSetter(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        MODULE,
        "setMeshOpacity",
    );
    const statements = declaration.body!.statements;
    // The binding records the tail writes are the native draw's own block,
    // filled from the record: nothing is left to write.
    context.assertStatementShapes(
        declaration,
        statements.slice(-2),
        `const records = retireStaleBindings(mesh);
if (records) {
    _value[0] = value;
    for (const record of records) {
        record._device.queue.writeBuffer(record._buffer, 0, _value);
    }
}`,
        "Mesh opacity live binding writes",
    );
    return lowerPinnedBody(file, statements.slice(0, -2), {
        bindings: new Map<string, PinnedBinding>([
            ...meshBindings(),
            ["opacity", { cpp: "opacity", type: "scalar" }],
        ]),
        calls: new Map(),
        statement(statement, lowerer, indent) {
            if (!ts.isExpressionStatement(statement)) return undefined;
            const expression = statement.expression;
            if (
                context.expressionMatchesShape(
                    expression,
                    'assertMesh(mesh, "setMeshOpacity")',
                ) ||
                context.expressionMatchesShape(expression, "ensureInstalled()")
            )
                return [];
            if (
                ts.isCallExpression(expression) &&
                context.expressionMatchesShape(
                    expression,
                    "validateMaterial(mesh, mesh.material, value)",
                )
            )
                return [
                    `${indent}validate_mesh_opacity_material(engine, mesh, record.material, ${lowerer.expression(expression.arguments[2]!)});`,
                ];
            if (
                context.expressionMatchesShape(
                    expression,
                    "markMeshRenderableDirty(mesh)",
                )
            )
                return [
                    `${indent}mark_mesh_renderable_dirty(engine, mesh);`,
                    `${indent}rebuild_mesh_render_plans(engine, mesh);`,
                ];
            return undefined;
        },
    });
}

/** `upstream/src/mesh_opacity.cpp` and its header. */
export function lowerMeshOpacity(context: LoweringContext): LoweredSource {
    const getter = context.functionDeclaration(MODULE, "getMeshOpacity");
    const getterBody = lowerPinnedBody(
        getter.file,
        getter.declaration.body!.statements,
        {
            bindings: meshBindings(),
            calls: new Map(),
            statement(statement) {
                return ts.isExpressionStatement(statement) &&
                    context.expressionMatchesShape(
                        statement.expression,
                        'assertMesh(mesh, "getMeshOpacity")',
                    )
                    ? []
                    : undefined;
            },
            returnValue: (expression, lowerer) =>
                expression ? lowerer.expression(expression) : "",
        },
    );
    return {
        modulePath: MODULE,
        symbolName: "setMeshOpacity,getMeshOpacity",
        header: meshOpacityHeader(context),
        source: `// ${context.provenance(MODULE, "setMeshOpacity")}
#include <bblite/runtime.hpp>
#include <bblite/upstream/mesh_opacity.hpp>

#include <cmath>
#include <stdexcept>
#include <string>

namespace bbl {

${lowerValidateMaterial(context)}

// ${context.provenance("src/frame-graph/render-task-transaction.ts", "resolvePendingTaskMeshes")}
// An explicit task resolves its entries' renderables once, at its record or
// at an add after it, and draws them until it resolves them again: their
// encoder bits are those renderables'. An entry that follows its mesh
// (\`enableRenderTaskMeshRefresh\`, no override) rebinds with the scene's
// generation and reads them live instead.
void resolve_render_task_mesh_extras(const Engine& engine, const FrameTaskRecord& task) {
    for (const RenderTaskMesh& entry : task.render_meshes) {
        if (entry.follows_material || entry.mesh_feature_extra) continue;
        entry.mesh_feature_extra =
            upstream::pinned_mesh_feature_extra(${recordAt("engine.meshes", "entry.mesh")});
    }
}

namespace {
// The scenes that own a mesh rebuild their render plans.
void rebuild_mesh_render_plans(Engine& engine, MeshHandle mesh) {
    const auto owners = engine.mesh_material_scenes.find(mesh.value);
    if (owners == engine.mesh_material_scenes.end() || !owners->second) return;
    for (const auto& owner : *owners->second) {
        const auto state = owner.lock();
        if (!state) continue;
        auto scene = Scene::from_state(state);
        if (!scene.state->source_material_publication) ++scene.render_topology_version;
    }
}
} // namespace

void set_mesh_opacity(Engine& engine, MeshHandle mesh, double opacity) {
    MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
${lowerSetter(context)}
}

// ${context.provenance(MODULE, "getMeshOpacity")}
double get_mesh_opacity(const Engine& engine, MeshHandle mesh) {
    const MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
${getterBody}
}

} // namespace bbl
`,
    };
}
