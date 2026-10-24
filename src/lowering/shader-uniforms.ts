import ts from "typescript";
import { jsToInt32Call } from "./pinned-operators.js";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { sameSource, soleBindingName } from "../compiler/syntax.js";

const modulePath = "src/material/shader/shader-material.ts";

/** GPU-buffer ownership is a native snapshot, initialized at the source group-build boundary. */
export function shaderUniformPublication(
    context: LoweringContext,
    record: string,
    scene = "scene",
): string {
    const source = "src/material/shader/shader-renderable.ts";
    const { declaration } = context.functionDeclaration(
        source,
        "buildMaterialRenderables",
    );
    const call = declaration.body!.statements.find(
        (statement) =>
            ts.isExpressionStatement(statement) &&
            context.expressionMatchesShape(
                statement.expression,
                "ensureCustomUbo(engine, material, bindings.customSpec)",
            ),
    );
    if (!call)
        return context.contractError(
            declaration,
            "Expected shader group construction to initialize its custom uniform buffer.",
        );
    const ensure = context.functionDeclaration(
        source,
        "ensureCustomUbo",
    ).declaration;
    context.assertStatementShapes(
        ensure,
        [ensure.body!.statements.at(-1)!],
        "updateCustomUbo(engine, material);",
        "Shader group initial uniform upload",
    );
    return `// ${context.provenance(source, "buildMaterialRenderables, ensureCustomUbo")}\n    if (${record}.shader_uniform_snapshot) ${record}.shader_uniform_snapshot(${record});\n    if (${record}.shader_packet_initialize) ${record}.shader_packet_initialize(${scene}, ${record});`;
}

/** Device-bound GPU data is replaced by the PAL; its source cache owner is invalidated with it. */
export function shaderUniformRecoveryReset(context: LoweringContext): string {
    const source = "src/material/shader/shader-pipeline.ts";
    const { declaration } = context.functionDeclaration(
        source,
        "getOrCreateShaderPipelineBindings",
    );
    for (const shape of [
        "state._shaderCustomUbo = state._shaderCustomData = state._shaderCustomBytes = null;",
        "state._shaderCustomVersion = -1;",
    ]) {
        if (
            !declaration.body!.statements.some(
                (statement) =>
                    ts.isExpressionStatement(statement) &&
                    context.expressionMatchesShape(
                        statement.expression,
                        shape.slice(0, -1),
                    ),
            )
        )
            return context.contractError(
                declaration,
                "Expected changed shader bindings to invalidate custom uniform data and revision.",
            );
    }
    return `// ${context.provenance(source, "getOrCreateShaderPipelineBindings")}\n    for (auto& material : engine.materials) material.shader_uniform_upload.reset();`;
}

/** Rebuilt renderables retain native row identities but acquire fresh source packet state. */
export function shaderUniformRecoveryPublication(
    context: LoweringContext,
    thinBindings = false,
): string {
    const source = "src/engine/recovery-rebuild.ts";
    const { declaration } = context.functionDeclaration(
        source,
        "rebuildSceneGpu",
    );
    if (
        !context.hasNode(
            declaration,
            (node) =>
                ts.isCallExpression(node) &&
                context.expressionMatchesShape(node, "build(scene, meshes)"),
        )
    )
        return context.contractError(
            declaration,
            "Expected scene recovery to rebuild material groups before rebuilding its frame graph.",
        );
    context.assertStatementShapes(
        declaration,
        [declaration.body!.statements.at(-1)!],
        "scene._frameGraph.build();",
        "Recovered explicit render-task construction",
    );
    return `// ${context.provenance(source, "rebuildSceneGpu")}
    for (const auto& registered : engine.scenes()) {
        if (!registered || registered->disposed) continue;
        const auto& scene = *registered;
        if (scene.state->source_material_publication) {
            for (const auto& output : scene.state->material_outputs) {
                if (output->shader_packet) output->shader_packet->reset();
                const auto& record = handle_at(engine.materials, output->material);
                ${shaderUniformPublication(context, "record")}
${
    thinBindings
        ? `                const auto replacement = create_thin_material_binding(engine, output->mesh, output->material);
                if (output->thin_binding) *output->thin_binding = *replacement;
                else output->thin_binding = replacement;`
        : ""
}
            }
        } else {
            for (const auto mesh : scene.meshes) {
                const auto material = handle_at(engine.meshes, mesh).material;
                if (material.value >= engine.materials.size()) continue;
                const auto& record = handle_at(engine.materials, material);
                ${shaderUniformPublication(context, "record")}
            }
        }
        for (const auto task_handle : scene.frame_passes()) {
            const auto& task = handle_at(engine.frame_tasks, task_handle);
            if (task.kind != FrameTaskKind::render) continue;
            const auto task_scene = Scene::from_state(task.source_scene ? task.source_scene : scene.state);
            for (const auto& entry : task.render_meshes) {
                if (entry.shader_packet) entry.shader_packet->reset();
                const auto material = render_task_mesh_material(engine, entry);
                if (material.value >= engine.materials.size()) continue;
                const auto& record = handle_at(engine.materials, material);
                ${shaderUniformPublication(context, "record", "task_scene")}
${
    thinBindings
        ? `                const auto replacement = create_thin_material_binding(engine, entry.mesh, material);
                if (entry.thin_binding) *entry.thin_binding = *replacement;
                else entry.thin_binding = replacement;`
        : ""
}
            }
        }
    }`;
}

/** Slot ownership is native transport; reads, rounded writes and revisions come from the pin. */
export function lowerShaderUniformApi(context: LoweringContext): string {
    const { file, declaration: getter } = context.functionDeclaration(
        modulePath,
        "getShaderUniform",
    );
    context.assertStatementShapes(
        getter,
        getter.body!.statements,
        'const slot = material._uniformValues.get(name); if (!slot) { throw new Error(`ShaderMaterial: uniform "${name}" was not declared.`); } return slot.value.length === 1 ? slot.value[0]! : slot.value;',
        "Shader uniform readback",
    );
    const read = lowerPinnedBody(file, getter.body!.statements.slice(1), {
        bindings: new Map<string, PinnedBinding>([
            ["name", { cpp: "name", type: "string" }],
            [
                "slot",
                { cpp: "slot", type: "opaque", absentCpp: "slot == nullptr" },
            ],
            [
                "slot.value",
                {
                    cpp: "slot->value",
                    type: "f32",
                    indexedRead: (owner, index) =>
                        `${owner}.load(static_cast<std::size_t>(${index}))`,
                },
            ],
        ]),
        calls: new Map(),
        returnValue: (expression, lowerer) => {
            if (!expression || !ts.isConditionalExpression(expression))
                return context.contractError(
                    getter,
                    "Expected the uniform getter's scalar/array choice.",
                );
            return `${lowerer.expression(expression.condition)} ? ShaderUniformRead{static_cast<double>(${lowerer.expression(expression.whenTrue)})} : ShaderUniformRead{${lowerer.expression(expression.whenFalse)}}`;
        },
    });
    const { declaration: setter } = context.functionDeclaration(
        modulePath,
        "setUniformValue",
    );
    const statements = setter.body!.statements;
    context.assertStatementShapes(
        setter,
        statements.slice(0, 2),
        'const slot = material._uniformValues.get(name); if (!slot) { throw new Error(`ShaderMaterial: uniform "${name}" was not declared.`); }',
        "Shader uniform slot lookup",
    );
    const writeBindings = new Map<string, PinnedBinding>([
        ["name", { cpp: "name", type: "string" }],
        ["slot", { cpp: "slot", type: "opaque", absentCpp: "slot == nullptr" }],
        [
            "slot.value",
            {
                cpp: "slot->value",
                type: "f32",
                indexedRead: (owner, index) =>
                    `${owner}.load(static_cast<std::size_t>(${index}))`,
                indexedStore: (owner, index, value) =>
                    `${owner}.store(static_cast<std::size_t>(${index}), static_cast<float>(${value}))`,
            },
        ],
        ["slot.decl.name", { cpp: "slot->name", type: "string" }],
        ["slot.decl.type", { cpp: "slot->type", type: "string" }],
        ["slot._v", { cpp: "slot->version", type: "scalar" }],
        ["material._uniformVersion", { cpp: "state.version", type: "scalar" }],
        ["material._uboVersion", { cpp: "state.ubo_version", type: "scalar" }],
        [
            "value",
            {
                cpp: "input",
                type: "f32",
                indexedRead: (owner, index) =>
                    `${owner}.load(static_cast<std::size_t>(${index}))`,
            },
        ],
    ]);
    const write = lowerPinnedBody(file, statements.slice(1), {
        bindings: writeBindings,
        calls: new Map(),
    });
    const defaults = context.functionDeclaration(
        modulePath,
        "defaultUniformValue",
    ).declaration;
    context.assertStatementShapes(
        defaults,
        defaults.body!.statements.slice(1),
        "const count = elementCount(decl.type); return count === 1 ? 0 : new Array(count).fill(0);",
        "Shader uniform default sequence construction",
    );
    const defaultValues = lowerPinnedBody(file, defaults.body!.statements, {
        bindings: new Map<string, PinnedBinding>([
            ["decl.name", { cpp: "name", type: "string" }],
            ["decl.type", { cpp: '""', type: "string" }],
        ]),
        calls: new Map([
            ["elementCount", () => "static_cast<double>(slot_count)"],
        ]),
        returnValue: (expression, lowerer) => {
            if (expression && ts.isConditionalExpression(expression)) {
                const fill = expression.whenFalse;
                if (
                    !ts.isCallExpression(fill) ||
                    !ts.isPropertyAccessExpression(fill.expression) ||
                    !ts.isNewExpression(fill.expression.expression)
                )
                    return context.contractError(
                        defaults,
                        "Expected the uniform default's array fill.",
                    );
                return `${lowerer.expression(expression.condition)} ? std::vector<float>{static_cast<float>(${lowerer.expression(expression.whenTrue)})} : std::vector<float>(static_cast<std::size_t>(${lowerer.expression(fill.expression.expression.arguments![0]!)}), static_cast<float>(${lowerer.expression(fill.arguments[0]!)}))`;
            }
            return `std::vector<float>{static_cast<float>(${lowerer.expression(expression!)})}`;
        },
    });
    const normalize = context.functionDeclaration(
        modulePath,
        "normalizeUniformValue",
    ).declaration;
    context.assertStatementShapes(
        normalize,
        normalize.body!.statements.slice(0, 2),
        'const count = elementCount(decl.type); const arr = typeof value === "number" ? new F32([value]) : value instanceof F32 ? new F32(value) : new F32(value);',
        "Shader uniform normalization copies its input",
    );
    const normalization = lowerPinnedBody(
        file,
        normalize.body!.statements.slice(2),
        {
            bindings: new Map<string, PinnedBinding>([
                ["decl.name", { cpp: "name", type: "string" }],
                ["decl.type", { cpp: "type", type: "string" }],
                [
                    "count",
                    { cpp: "static_cast<double>(slot_count)", type: "scalar" },
                ],
                ["arr", { cpp: "copy", type: "f32" }],
            ]),
            calls: new Map(),
            returnValue: (expression, lowerer) =>
                `js::F32Array(std::move(${lowerer.expression(expression!)}))`,
        },
    );
    const packet = context.functionDeclaration(
        "src/material/shader/shader-renderable.ts",
        "updatePacket",
    );
    const alpha = context.variableInitializer(
        packet.declaration,
        "alphaCutoff",
    );
    // The packet keys the live value only where its layout declares the
    // uniform; the gate (shader-system-cache.ts) lowers that selection.
    const selected = context.unwrapExpression(alpha);
    if (!ts.isConditionalExpression(selected))
        return context.contractError(
            alpha,
            "Expected the declared alpha cutoff selection.",
        );
    context.assertExpressionShape(
        selected.condition,
        "dependencies & ALPHA_CUTOFF",
        "Shader packet alpha cutoff dependency",
    );
    context.assertExpressionShape(
        selected.whenFalse,
        "0",
        "Undeclared shader packet alpha cutoff",
    );
    const live = context.unwrapExpression(selected.whenTrue);
    context.assertExpressionShape(
        live,
        'material._uniformValues.get("alphaCutoff")?.value[0] ?? 0.4',
        "Shader packet live alpha cutoff",
    );
    const alphaBody = `    const double alphaCutoff = ${new PinnedNumericLowerer(
        packet.file,
        {
            bindings: new Map<string, PinnedBinding>([
                [
                    'material._uniformValues.get("alphaCutoff")?.value[0]',
                    {
                        cpp: "slot->value.load(0)",
                        type: "scalar",
                        nullish: "slot == nullptr",
                    },
                ],
            ]),
            calls: new Map(),
        },
    ).expression(live)};`;
    return `// ${context.provenance(modulePath, "getShaderUniform")}
// ${context.provenance(modulePath, "setUniformValue")}
[[maybe_unused]] static std::vector<float> default_shader_uniform_values(const std::string& name, std::size_t slot_count) {
${defaultValues}
}

[[maybe_unused]] static js::F32Array normalize_shader_uniform_value(const std::string& name, const std::string& type, std::size_t slot_count, const std::vector<float>& values) {
    auto copy = values;
${normalization}
}

static ShaderUniformSlot* find_shader_uniform(ShaderUniformState& state, const std::string& name) {
    const auto found = std::find_if(state.slots.begin(), state.slots.end(), [&](const auto& slot) { return slot.name == name; });
    return found == state.slots.end() ? nullptr : &*found;
}

[[maybe_unused]] static double shader_material_alpha_cutoff(const MaterialRecord& material) {
    const auto* slot = find_shader_uniform(*material.shader_uniforms, "alphaCutoff");
${alphaBody}
    return alphaCutoff;
}

ShaderUniformRead get_shader_uniform(Engine& engine, MaterialHandle material, const std::string& name) {
    auto& state = *shader_material(engine, material).shader_uniforms;
    auto* slot = find_shader_uniform(state, name);
${read}
}

static void set_shader_uniform_slot(ShaderUniformState& state, ShaderUniformSlot* slot, const std::string& name, const ShaderUniformInput& input) {
${write}
}

void set_shader_uniform_input(Engine& engine, MaterialHandle material, const std::string& name, const ShaderUniformInput& input) {
    auto& state = *shader_material(engine, material).shader_uniforms;
    set_shader_uniform_slot(state, find_shader_uniform(state, name), name, input);
}
`;
}

/** The pin gates the whole packet by material version and cached slots by their own counters. */
export function lowerShaderUniformSnapshot(context: LoweringContext): string {
    const renderModule = "src/material/shader/shader-renderable.ts";
    const { file, declaration } = context.functionDeclaration(
        renderModule,
        "updateCustomUbo",
    );
    const guard = declaration.body!.statements.find(ts.isIfStatement)!;
    const tail = declaration.body!.statements.at(-1)!;
    const gateBindings = new Map<string, PinnedBinding>([
        ["customSpec", { cpp: "true", type: "bool" }],
        ["customUbo", { cpp: "true", type: "bool" }],
        ["customData", { cpp: "true", type: "bool" }],
        [
            "state._shaderCustomVersion",
            { cpp: "upload.version", type: "scalar" },
        ],
        ["material._uniformVersion", { cpp: "state.version", type: "scalar" }],
    ]);
    const gate = lowerPinnedBody(file, [guard], {
        bindings: gateBindings,
        calls: new Map(),
    });
    const stamp = lowerPinnedBody(file, [tail], {
        bindings: gateBindings,
        calls: new Map(),
    });
    const cachedModule =
        "src/material/shader/enable-shader-material-uniform-caching.ts";
    const cachedFile = context.sourceFile(cachedModule);
    const plan = context.functionDeclaration(
        cachedModule,
        "getCustomWritePlan",
    ).declaration;
    context.assertExpressionShape(
        context.propertyInitializer(
            context.objectInitializer(plan, "plan"),
            "versions",
        ),
        "new I32(slots.length).fill(-1)",
        "Cached uniform revision storage",
    );
    const cached = context.variableInitializer(
        cachedFile,
        "writeCachedCustomUniforms",
    );
    if (!ts.isArrowFunction(cached) || !ts.isBlock(cached.body))
        return context.contractError(
            cached,
            "Expected a cached custom uniform writer.",
        );
    const loop = cached.body.statements.find(ts.isForStatement);
    if (!loop || !ts.isBlock(loop.statement))
        return context.contractError(
            cached,
            "Expected the cached uniform slot loop.",
        );
    const skip = loop.statement.statements.find(ts.isIfStatement)!;
    const assignment = loop.statement.statements.find(
        (statement) =>
            ts.isExpressionStatement(statement) &&
            ts.isBinaryExpression(statement.expression) &&
            sameSource(statement.expression.left, "plan.versions[i]"),
    )!;
    const slotGate = lowerPinnedBody(
        cachedFile,
        [skip, assignment],
        {
            bindings: new Map<string, PinnedBinding>([
                ["version", { cpp: "slot.version", type: "scalar" }],
                [
                    "plan.versions",
                    {
                        cpp: "upload.slot_versions",
                        type: "f64-buffer",
                        indexedStore: (owner, index, value) =>
                            `${owner}[static_cast<std::size_t>(${index})] = ${jsToInt32Call(value)}`,
                    },
                ],
                ["i", { cpp: "index", type: "scalar" }],
            ]),
            calls: new Map(),
        },
        "            ",
    );
    return `// ${context.provenance(renderModule, "updateCustomUbo")}
// ${context.provenance(cachedModule, "writeCachedCustomUniforms")}
static void update_shader_uniform_snapshot(const MaterialRecord& material) {
    if (!material.shader_uniforms) throw std::runtime_error("Shader uniform ownership is absent.");
    const auto& state = *material.shader_uniforms;
    if (!material.shader_uniform_upload) {
        material.shader_uniform_upload = std::make_shared<ShaderUniformUploadState>();
        material.shader_uniform_upload->slot_versions.assign(state.slots.size(), -1);
        // ensureCustomUbo's new ArrayBuffer starts with zero bytes, including after recovery.
        std::fill(material.shader_uniform_values.begin(), material.shader_uniform_values.end(), 0.0f);
    }
    auto& upload = *material.shader_uniform_upload;
${gate}
    for (std::size_t index = 0; index < state.slots.size(); ++index) {
        const auto& slot = state.slots[index];
        if (slot.offset == invalid_handle) continue;
        if (shader_uniform_caching_enabled) {
${slotGate}
        }
        for (std::size_t lane = 0; lane < slot.value.size(); ++lane)
            material.shader_uniform_values.at(slot.offset + lane) = static_cast<float>(slot.value.load(lane));
    }
${stamp}
}

const std::vector<float>& shader_uniform_render_values(const MaterialRecord& material) {
    update_shader_uniform_snapshot(material);
    return material.shader_uniform_values;
}

`;
}

/**
 * `enableShaderUniformRangeUpdates`: the registration, the slot mark and the
 * version gate come from the pin. Its Proxy marks a slot on every element
 * write; natively a slot is marked when its value differs from the packed
 * bytes the UBO last received, which every draw gathers.
 */
export function lowerShaderUniformRangeUpdates(
    context: LoweringContext,
): string {
    const module = "src/material/shader/shader-uniform-range.ts";
    const { declaration: enable } = context.functionDeclaration(
        module,
        "enableShaderUniformRangeUpdates",
    );
    context.assertStatementShapes(
        enable,
        enable.body!.statements,
        "const state = material as RangeShaderMaterialState; if (!state._rangeUniformUpdate) { installRangeUpdater(state); } const registrations = (state._rangeUniformScenes ??= new WeakMap()); let callback = registrations.get(scene); if (!callback) { callback = () => state._rangeUniformUpdate!(scene.surface.engine); registrations.set(scene, callback); } if (!scene._beforeRender.includes(callback)) { scene._beforeRender.push(callback); }",
        "Shader uniform range registration",
    );
    const { file, declaration: install } = context.functionDeclaration(
        module,
        "installRangeUpdater",
    );
    const mark = context.variableInitializer(install, "mark");
    if (!ts.isArrowFunction(mark) || !ts.isBlock(mark.body))
        return context.contractError(
            install,
            "Expected the range updater's slot mark.",
        );
    context.assertStatementShapes(
        mark,
        mark.body.statements,
        "if (dirty.size === 0) { dirtyVersion = material._uniformVersion; } const slot = material._uniformValues.get(name)!; slot._v = (slot._v! | 0) + 1; dirty.add(name);",
        "Shader uniform range mark",
    );
    const updater = install.body!.statements.find(
        (statement): statement is ts.ExpressionStatement =>
            ts.isExpressionStatement(statement) &&
            ts.isBinaryExpression(statement.expression) &&
            context.propertyPath(statement.expression.left)?.join(".") ===
                "material._rangeUniformUpdate",
    );
    const update =
        updater && ts.isBinaryExpression(updater.expression)
            ? updater.expression.right
            : undefined;
    if (!update || !ts.isArrowFunction(update) || !ts.isBlock(update.body))
        return context.contractError(
            install,
            "Expected the range updater body.",
        );
    const statements = update.body.statements;
    context.assertStatementShapes(
        update,
        statements,
        "if (dirty.size === 0) { return; } const spec = material._shaderCustomSpec; const data = material._shaderCustomData; const buffer = material._shaderCustomUbo; if (!spec || !data || !buffer) { return; } const directMutation = material._uniformVersion === dirtyVersion; if (!directMutation && material._shaderCustomVersion === material._uniformVersion) { dirty.clear(); dirtyVersion = -1; return; } if (directMutation) { material._uniformVersion++; material._uboVersion = material._uniformVersion; } let min = 0x7fffffff; let max = -1; for (const name of dirty) { const slot = material._uniformValues.get(name)!; const offset = spec._offsets.get(name); if (offset === undefined) { continue; } writeTypedValue(data, offset, slot.decl.type, slot.value); min = Math.min(min, offset); max = Math.max(max, offset + slot.value.length * 4); } if (max > min) { engine._device.queue.writeBuffer(buffer, min, data, min, max - min); } dirty.clear(); dirtyVersion = -1; material._shaderCustomVersion = material._uniformVersion;",
        "Shader uniform range update",
    );
    const absent = "!material.shader_uniform_upload";
    const bindings = new Map<string, PinnedBinding>([
        [
            "dirty.size",
            { cpp: "static_cast<double>(dirty.size())", type: "scalar" },
        ],
        ["dirtyVersion", { cpp: "dirty_version", type: "scalar" }],
        ["material._uniformVersion", { cpp: "state.version", type: "scalar" }],
        ["material._uboVersion", { cpp: "state.ubo_version", type: "scalar" }],
        [
            "material._shaderCustomVersion",
            { cpp: "material.shader_uniform_upload->version", type: "scalar" },
        ],
        ["spec", { cpp: "material", type: "opaque", absentCpp: absent }],
        ["data", { cpp: "material", type: "opaque", absentCpp: absent }],
        ["buffer", { cpp: "material", type: "opaque", absentCpp: absent }],
        ["slot._v", { cpp: "slot.version", type: "scalar" }],
    ]);
    const calls = new Map<string, (args: readonly string[]) => string>([
        ["dirty.clear", () => "dirty.clear()"],
    ]);
    // The packed write and its ranged upload are the native transport below.
    const writes = statements.findIndex(ts.isForOfStatement);
    const packed = (statement: ts.Statement): boolean =>
        ts.isVariableStatement(statement) &&
        ["spec", "data", "buffer", "min", "max"].includes(
            soleBindingName(statement.declarationList.declarations[0]!.name),
        );
    const gate = lowerPinnedBody(
        file,
        statements.slice(0, writes).filter((statement) => !packed(statement)),
        { bindings, calls },
    );
    const tail = lowerPinnedBody(file, statements.slice(writes + 2), {
        bindings,
        calls,
    });
    const slotMark = lowerPinnedBody(
        file,
        [mark.body.statements[2]!],
        { bindings, calls },
        "                ",
    );
    return `// ${context.provenance(module, "enableShaderUniformRangeUpdates, installRangeUpdater")}
static void update_shader_uniform_ranges(Engine& engine, MaterialHandle handle) {
    auto& material = shader_material(engine, handle);
    auto& state = *material.shader_uniforms;
    std::vector<std::size_t> dirty;
    // A mark's version: the one the last packed upload stamped.
    double dirty_version = material.shader_uniform_upload ? material.shader_uniform_upload->version : -1.0;
    if (material.shader_uniform_upload) {
        for (std::size_t index = 0; index < state.slots.size(); ++index) {
            auto& slot = state.slots[index];
            if (slot.offset == invalid_handle) continue;
            bool differs = false;
            for (std::size_t lane = 0; lane < slot.value.size() && !differs; ++lane)
                differs = std::bit_cast<std::uint32_t>(static_cast<float>(slot.value.load(lane))) !=
                          std::bit_cast<std::uint32_t>(material.shader_uniform_values.at(slot.offset + lane));
            if (differs) {
${slotMark}
                dirty.push_back(index);
            }
        }
    }
${gate}
    for (const auto index : dirty) {
        const auto& slot = state.slots[index];
        for (std::size_t lane = 0; lane < slot.value.size(); ++lane)
            material.shader_uniform_values.at(slot.offset + lane) = static_cast<float>(slot.value.load(lane));
    }
${tail}
}

void enable_shader_uniform_range_updates(Engine& engine, Scene& scene, MaterialHandle material) {
    auto& state = *shader_material(engine, material).shader_uniforms;
    if (!state.range_updates) state.range_updates = std::make_shared<ShaderUniformRangeUpdates>();
    auto& registrations = state.range_updates->scenes;
    std::erase_if(registrations, [](const auto& entry) { return entry.first.expired(); });
    auto found = std::find_if(registrations.begin(), registrations.end(), [&](const auto& entry) {
        return entry.first.lock().get() == scene.identity();
    });
    if (found == registrations.end()) {
        js::Callback<void(double)> callback(
            [owner = std::weak_ptr<SceneState>(scene.state), material](double) {
                const auto shared = owner.lock();
                if (!shared) return;
                const auto registered = Scene::from_state(shared);
                if (!registered.engine) throw std::runtime_error("A scene uniform range update requires its engine.");
                update_shader_uniform_ranges(*registered.engine, material);
            });
        registrations.emplace_back(scene.state, std::move(callback));
        found = std::prev(registrations.end());
    }
    const auto callback = found->second;
    const auto& registered = std::as_const(scene.before_render);
    if (std::find(registered.begin(), registered.end(), callback) == registered.end())
        scene.before_render.push_back(callback);
}
`;
}
