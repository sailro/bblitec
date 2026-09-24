/**
 * The clustered light field as one generated translation unit.
 *
 * The container and its lights are `runtime.hpp` records the emitted scene
 * fills, because both reached scenes build a thousand lights inside a loop.
 * Both halves of `buildClusteredLightGpuState` are lowered from its own
 * body: the build, which sizes the three data textures and seeds the params
 * block when the container is added, and the per-frame `refresh` closure,
 * which re-bins every light against the live camera and rewrites the light
 * payload.
 *
 * What is not translated is the platform around that arithmetic, and each
 * boundary is named by the statements it replaces rather than skipped by
 * default, so a statement the pin adds reaches the translator and either
 * lowers or refuses:
 *
 *  - GPU objects. The uniform buffer and the three data textures are the
 *    backend's, created from the extents the build stores on the record,
 *    and every `writeBuffer`/`writeDataTexture` is the backend's upload of
 *    the record's payload once the refresh bumps its version.
 *  - The dirty key. Upstream compares camera identity, `_cameraChangeKey`,
 *    the target extent and the effective aspect -- four proxies for one
 *    question, whether this frame projects lights into different tiles than
 *    the last did -- and scans every light for edits. This port has no way
 *    to mutate a light after creating it (`markClusteredLightContainerDirty`
 *    refuses at generation and no setter exists), so the scan could only
 *    answer "nothing moved"; the snapshot it keeps is not allocated, and the
 *    two matrices the cull reads answer the camera half directly.
 *  - Lights added after the container. The compiler refuses them at
 *    generation, which is the capacity the pin's refresh throws on.
 */
import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";
import {
    clusteredAddLightToClusters,
    clusteredCalls,
    clusteredConeWriter,
    clusteredLightMembers,
    clusteredModule,
    clusteredParameterNames,
    clusteredProjectedBounds,
    clusteredScalarHelpers,
    clusteredSpotMethod,
    clusteredSpotStride,
} from "./clustered-light-lowerer.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import { recordAt } from "../compiler/record-access.js";

const buildSymbol = "buildClusteredLightGpuState";

/**
 * The WebGPU default for `maxTextureDimension2D`. The pin's `createEngine`
 * requests no limits unless its options name some, so this is the value
 * `engine._device.limits.maxTextureDimension2D` reads in the browser the
 * reference captures come from -- which the pin then clamps to its own
 * `MAX_DATA_TEXTURE_WIDTH`.
 */
const WEBGPU_DEFAULT_MAX_TEXTURE_DIMENSION_2D = 8192;

/**
 * The build's locals the record keeps, by the native field that holds each.
 *
 * `count` is a whole number both halves read; `f32`/`u32` is one of the
 * three payloads, allocated by the pin's own `new F32(...)`/`new U32(...)`;
 * `rows` is a data texture, whose only native trace is the row count the
 * pin's `createDataTexture` sizes it with -- the backend creates the
 * texture itself from that count.
 */
const RECORD_STORAGE: ReadonlyMap<
    string,
    { field: string; kind: "count" | "f32" | "u32" | "rows" }
> = new Map<string, { field: string; kind: "count" | "f32" | "u32" | "rows" }>([
    ["tileCountX", { field: "tile_count_x", kind: "count" }],
    ["tileCountY", { field: "tile_count_y", kind: "count" }],
    ["zSlices", { field: "slice_count", kind: "count" }],
    ["lightTexels", { field: "light_texels", kind: "count" }],
    ["maskTexels", { field: "mask_texels", kind: "count" }],
    ["dataTextureWidth", { field: "data_texture_width", kind: "count" }],
    ["lightData", { field: "light_data", kind: "f32" }],
    ["sliceData", { field: "slice_data", kind: "u32" }],
    ["maskData", { field: "mask_data", kind: "u32" }],
    ["lightsTexture", { field: "light_rows", kind: "rows" }],
    ["cellsTexture", { field: "slice_rows", kind: "rows" }],
    ["indicesTexture", { field: "mask_rows", kind: "rows" }],
]);

/** The pin's typed-array constructors for each payload width. */
const PAYLOAD_CONSTRUCTORS = {
    f32: ["F32", "Float32Array"],
    u32: ["U32", "Uint32Array"],
} as const;

/** The name a variable statement declares, when it declares exactly one. */
function declaredName(statement: ts.Statement): string | undefined {
    if (!ts.isVariableStatement(statement)) return undefined;
    const [declaration, ...rest] = statement.declarationList.declarations;
    return declaration && rest.length === 0 && ts.isIdentifier(declaration.name)
        ? declaration.name.text
        : undefined;
}

/** The callee a call statement names by its text, when it is one. */
function calledName(
    statement: ts.Statement,
    file: ts.SourceFile,
): string | undefined {
    if (!ts.isExpressionStatement(statement)) return undefined;
    const call = statement.expression;
    return ts.isCallExpression(call)
        ? call.expression.getText(file).replace("?.", ".")
        : undefined;
}

/** Every identifier reference to `name` under `root`, declarations aside. */
function references(
    context: LoweringContext,
    root: ts.Node,
    name: string,
): ts.Identifier[] {
    return context.findNodes(
        root,
        (node): node is ts.Identifier =>
            ts.isIdentifier(node) &&
            node.text === name &&
            !(
                ts.isVariableDeclaration(node.parent) &&
                node.parent.name === node
            ) &&
            !(
                ts.isPropertyAccessExpression(node.parent) &&
                node.parent.name === node
            ) &&
            !(
                ts.isPropertyAssignment(node.parent) &&
                node.parent.name === node
            ),
    );
}

/**
 * The pin's `_ClusteredActiveLight`, as the native struct the refresh
 * collects into: each light record member a pointer into the container
 * (the pin holds the object), each number a double, an optional member
 * null when absent. Read off the interface so a member the pin adds or
 * renames moves the struct, and every literal and destructuring below is
 * checked against it.
 */
function activeLightMembers(
    context: LoweringContext,
): readonly { name: string; record: boolean; optional: boolean }[] {
    const file = context.sourceFile(clusteredModule);
    const declared = file.statements.find(
        (statement): statement is ts.InterfaceDeclaration =>
            ts.isInterfaceDeclaration(statement) &&
            statement.name.text === "_ClusteredActiveLight",
    );
    if (!declared) {
        return context.contractError(
            file,
            "Expected the pinned _ClusteredActiveLight record.",
        );
    }
    return declared.members.map((member) => {
        const type = ts.isPropertySignature(member) ? member.type : undefined;
        if (!ts.isPropertySignature(member) || !type) {
            return context.contractError(
                member,
                "Expected a typed _ClusteredActiveLight member.",
            );
        }
        const record =
            ts.isTypeReferenceNode(type) &&
            ts.isIdentifier(type.typeName) &&
            ["ClusteredPointLight", "ClusteredSpotLight"].includes(
                type.typeName.text,
            );
        if (!record && type.kind !== ts.SyntaxKind.NumberKeyword) {
            context.contractError(
                member,
                "Expected each _ClusteredActiveLight member to be a light " +
                    "record or a number.",
            );
        }
        const name = context.propertyName(member.name);
        if (name === undefined) {
            return context.contractError(
                member,
                "Expected a named _ClusteredActiveLight member.",
            );
        }
        return { name, record, optional: member.questionToken !== undefined };
    });
}

function activeLightStruct(context: LoweringContext): string {
    const fields = activeLightMembers(context).map(({ name, record }) =>
        record
            ? `    const ClusteredLight* ${name} = nullptr;`
            : `    double ${name} = 0.0;`,
    );
    return `// ${context.provenance(clusteredModule, "_ClusteredActiveLight")}
struct ClusteredActiveLight {
${fields.join("\n")}
};`;
}

/**
 * The spellings both halves share: the pin's two light lists over the
 * record's one, the payloads and params block on the record, the installed
 * spot support, and the per-frame active list.
 */
function sharedScope(context: LoweringContext): {
    bindings: Map<string, PinnedBinding>;
    calls: Map<string, (args: readonly string[]) => string>;
    methods: NonNullable<PinnedNumericScope["methods"]>;
} {
    const stride = clusteredSpotStride(context);
    const bindings = new Map<string, PinnedBinding>([
        // `container._spotSupport` is installed by the first spot light and
        // is what `has_spots` records; its `_stride` is the pin's own.
        [
            "spotSupport",
            {
                cpp: "container",
                type: "opaque",
                absentCpp: "!container.has_spots",
                optional: {
                    present: "container.has_spots",
                    members: new Map([
                        ["_stride", { cpp: context.doubleLiteral(stride) }],
                    ]),
                },
            },
        ],
        // One `ArrayBuffer(32)`, viewed both ways: the record keeps the
        // eight lanes as words, and a store through the float view writes a
        // float's bytes into its lane.
        ["params", { cpp: "container.params", type: "opaque" }],
        ["paramsU", { cpp: "container.params", type: "u32", mutable: true }],
        [
            "paramsF",
            {
                cpp: "container.params",
                type: "f32",
                indexedStore: (owner, index, value) =>
                    `store_clustered_f32_lane(${owner}, ${index}, ${value})`,
            },
        ],
        [
            "engine._device.limits.maxTextureDimension2D",
            {
                cpp: context.doubleLiteral(
                    WEBGPU_DEFAULT_MAX_TEXTURE_DIMENSION_2D,
                ),
                type: "scalar",
            },
        ],
        ["container.horizontalTiles", scalar("container.horizontal_tiles")],
        ["container.verticalTiles", scalar("container.vertical_tiles")],
        ["container.zSlices", scalar("container.z_slices")],
        ...lightList("container.pointLights", "clustered_point_lights"),
        ...lightList("container.spotLights", "clustered_spot_lights"),
        ["activeLights", { cpp: "active", type: "opaque" }],
        ["activeLights.length", scalar("static_cast<double>(active.size())")],
    ]);
    const calls = clusteredCalls();
    calls.set(
        "addLightToClusters",
        (args) => `add_light_to_clusters(${args.join(", ")})`,
    );
    calls.set(
        "spotSupport._write",
        (args) =>
            `(container.has_spots ? write_clustered_cone(${args.join(", ")}) : void())`,
    );
    const methods: NonNullable<PinnedNumericScope["methods"]> = new Map([
        [
            "fill",
            (receiver, args, binding) => {
                const value =
                    binding.type === "u32"
                        ? `static_cast<std::uint32_t>(${args[0]})`
                        : `static_cast<float>(${args[0]})`;
                if (args.length === 1)
                    return `bbl::js::array_fill(${receiver}, ${value})`;
                if (args.length === 3)
                    return `bbl::js::array_fill_range(${receiver}, ${value}, ${args[1]}, ${args[2]})`;
                throw new Error(
                    `Unsupported pinned fill arity ${args.length} on ${receiver}.`,
                );
            },
        ],
    ]);
    return { bindings, calls, methods };
}

function scalar(cpp: string): PinnedBinding {
    return { cpp, type: "scalar" };
}

/** The pin's `pointLights`/`spotLights` array: its length and its range. */
function lightList(pinned: string, range: string): [string, PinnedBinding][] {
    return [
        [pinned, { cpp: `${range}(container)`, type: "opaque" }],
        [
            `${pinned}.length`,
            scalar(
                `static_cast<double>(std::ranges::distance(${range}(container)))`,
            ),
        ],
    ];
}

/** Each record-held local's spelling, once the build has stored it. */
function recordBindings(): [string, PinnedBinding][] {
    return [...RECORD_STORAGE].flatMap(
        ([pinned, { field, kind }]): [string, PinnedBinding][] =>
            kind === "count"
                ? [[pinned, scalar(`static_cast<double>(container.${field})`)]]
                : kind === "rows"
                  ? []
                  : [
                        [
                            pinned,
                            {
                                cpp: `container.${field}`,
                                type: kind,
                                mutable: true,
                            },
                        ],
                    ],
    );
}

/**
 * `createDataTexture`'s own row count for one texture: the `height` it
 * computes before handing the descriptor to the device, lowered over the
 * call's texel count and width.
 */
function dataTextureRows(
    context: LoweringContext,
    call: ts.CallExpression,
    lowerer: PinnedNumericLowerer,
): string {
    const { file, declaration } = context.functionDeclaration(
        clusteredModule,
        "createDataTexture",
    );
    const names = clusteredParameterNames(context, declaration);
    if (names.length !== call.arguments.length) {
        return context.contractError(
            call,
            "Expected createDataTexture's own arity at its call.",
        );
    }
    const height = context.variableInitializer(declaration, "height");
    const rows = new PinnedNumericLowerer(file, {
        bindings: new Map(
            ["texels", "dataTextureWidth"].map(
                (name): [string, PinnedBinding] => {
                    const index = names.indexOf(name);
                    const argument = call.arguments[index];
                    if (index < 0 || !argument) {
                        return context.contractError(
                            declaration,
                            `Expected createDataTexture to take '${name}'.`,
                        );
                    }
                    return [name, scalar(lowerer.expression(argument))];
                },
            ),
        ),
        calls: pinnedNumericMathCalls(),
    });
    return rows.expression(height);
}

/** A `for (const light of <list>)` over one of the pin's light lists. */
function lightListForOf(
    lists: ReadonlyMap<string, string>,
): NonNullable<PinnedNumericScope["forOf"]> {
    return (iterated, element) => {
        const range = lists.get(iterated);
        return range === undefined
            ? undefined
            : {
                  range,
                  bindings: new Map<string, PinnedBinding>([
                      [element, { cpp: element, type: "opaque" }],
                      ...clusteredLightMembers(element, `${element}.`),
                  ]),
              };
    };
}

/**
 * The build: `buildClusteredLightGpuState` from its first statement to its
 * last, over the record the container is.
 */
function lowerBuild(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        clusteredModule,
        buildSymbol,
    );
    const statements = declaration.body!.statements;
    const shared = sharedScope(context);
    const bindings = new Map<string, PinnedBinding>([
        ...shared.bindings,
        [
            "camera",
            {
                cpp: "scene_camera()",
                type: "opaque",
                absentCpp: "scene.camera.value >= engine.cameras.size()",
            },
        ],
        ["camera.nearPlane", scalar("scene_camera().near_plane")],
        ["camera.farPlane", scalar("scene_camera().far_plane")],
    ]);
    // Locals whose every read is a statement the backend owns: the canvas
    // extent feeds only the first `state.refresh`, which the backend's
    // per-frame refresh is; the rest are the GPU state, its uniform buffer,
    // and the dirty key and change scan the matrices stand in for. The
    // refresh's own active list is a local of the native refresh.
    const platformLocals = new Set([
        "width",
        "height",
        "lightSnapshot",
        "activeLights",
        "paramsBuffer",
        "lastCamera",
        "lastCameraVersion",
        "lastTargetWidth",
        "lastTargetHeight",
        "lastAspect",
        "lastContainerVersion",
        "lastLightCount",
        "state",
    ]);
    // The snapshot's NaN seed, the GPU state's spot mark (the record's
    // `has_spots` is that mark), and the first refresh.
    const platformCalls = new Set([
        "lightSnapshot.fill",
        "spotSupport._markState",
        "state.refresh",
    ]);
    const dropped = new Set<ts.Statement>();
    const stored = new Set<string>();
    const statement: NonNullable<PinnedNumericScope["statement"]> = (
        node,
        lowerer,
        indent,
    ) => {
        const name = declaredName(node);
        const storage = name ? RECORD_STORAGE.get(name) : undefined;
        if (name && storage && ts.isVariableStatement(node)) {
            stored.add(name);
            const declared = node.declarationList.declarations[0]!.initializer;
            if (!declared) {
                return context.contractError(
                    node,
                    `Expected '${name}' to be initialized.`,
                );
            }
            const initializer = context.unwrapExpression(declared);
            const target = `container.${storage.field}`;
            if (storage.kind === "count") {
                const value = lowerer.expression(initializer);
                bindings.set(name, scalar(`static_cast<double>(${target})`));
                return [
                    `${indent}${target} = static_cast<std::uint32_t>(${value});`,
                ];
            }
            if (storage.kind === "rows") {
                if (
                    !ts.isCallExpression(initializer) ||
                    initializer.expression.getText(file) !== "createDataTexture"
                ) {
                    return context.contractError(
                        initializer,
                        `Expected '${name}' to be a createDataTexture texture.`,
                    );
                }
                return [
                    `${indent}${target} = static_cast<std::uint32_t>(` +
                        `${dataTextureRows(context, initializer, lowerer)});`,
                ];
            }
            const constructors: readonly string[] =
                PAYLOAD_CONSTRUCTORS[storage.kind];
            const count = ts.isNewExpression(initializer)
                ? initializer.arguments?.[0]
                : undefined;
            if (
                !ts.isNewExpression(initializer) ||
                !constructors.includes(initializer.expression.getText(file)) ||
                initializer.arguments?.length !== 1 ||
                !count
            ) {
                return context.contractError(
                    initializer,
                    `Expected '${name}' to allocate a ${storage.kind} payload.`,
                );
            }
            const size = lowerer.expression(count);
            bindings.set(name, {
                cpp: target,
                type: storage.kind,
                mutable: true,
            });
            return [
                `${indent}${target}.assign(static_cast<std::size_t>(${size}), ` +
                    `${storage.kind === "f32" ? "0.0f" : "0u"});`,
            ];
        }
        const callee = calledName(node, file);
        if (
            (name && platformLocals.has(name)) ||
            (callee && platformCalls.has(callee)) ||
            (ts.isReturnStatement(node) &&
                node.expression &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "state")
        ) {
            dropped.add(node);
            return [];
        }
        return undefined;
    };
    const body = lowerPinnedBody(file, statements, {
        bindings,
        calls: shared.calls,
        methods: shared.methods,
        statement,
    });
    // Every boundary must have been met, and no translated statement may
    // read a platform local: a pin that starts using one for the CPU half
    // fails here instead of losing it.
    const declared = new Set(
        [...dropped].map(
            (node) => declaredName(node) ?? calledName(node, file),
        ),
    );
    for (const name of [...platformLocals, ...platformCalls]) {
        if (!declared.has(name)) {
            context.contractError(
                declaration,
                `Expected ${buildSymbol} to reach '${name}'.`,
            );
        }
    }
    for (const name of platformLocals) {
        for (const reference of references(context, declaration, name)) {
            const owner = statements.find(
                (candidate) =>
                    candidate.pos <= reference.pos &&
                    reference.end <= candidate.end,
            );
            if (!owner || !dropped.has(owner)) {
                context.contractError(
                    reference,
                    `Expected '${name}' to feed only the GPU state.`,
                );
            }
        }
    }
    for (const name of RECORD_STORAGE.keys()) {
        if (!stored.has(name)) {
            context.contractError(
                declaration,
                `Expected ${buildSymbol} to declare '${name}'.`,
            );
        }
    }
    return body;
}

/**
 * The per-frame half: the `refresh` closure's re-bin and payload rewrite,
 * from its `if (topologyDirty)` through its `if (lightDataDirty)`.
 */
function lowerRefresh(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        clusteredModule,
        buildSymbol,
    );
    const refresh = context.findNodes(
        declaration,
        (node): node is ts.MethodDeclaration & { body: ts.Block } =>
            ts.isMethodDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "refresh" &&
            node.body !== undefined,
    );
    const method = refresh[0];
    if (refresh.length !== 1 || !method) {
        return context.contractError(
            declaration,
            `Expected ${buildSymbol}'s state to declare one refresh.`,
        );
    }
    const guarded = (name: string): number => {
        const index = method.body.statements.findIndex(
            (statement) =>
                ts.isIfStatement(statement) &&
                ts.isIdentifier(statement.expression) &&
                statement.expression.text === name,
        );
        if (index < 0) {
            context.contractError(
                method,
                `Expected refresh to guard a block on '${name}'.`,
            );
        }
        return index;
    };
    const first = guarded("topologyDirty");
    const last = guarded("lightDataDirty");
    if (last < first) {
        context.contractError(
            method,
            "Expected refresh to re-bin before it rewrites the light payload.",
        );
    }
    const range = method.body.statements.slice(first, last + 1);
    const lightStride = declaration.body!.statements.find(
        (statement) => declaredName(statement) === "lightStride",
    );
    if (!lightStride) {
        return context.contractError(
            declaration,
            `Expected ${buildSymbol} to declare 'lightStride'.`,
        );
    }

    const shared = sharedScope(context);
    const members = activeLightMembers(context);
    const bindings = new Map<string, PinnedBinding>([
        ...shared.bindings,
        ...recordBindings(),
        // Past the matrices' dirty key the tiles have moved by
        // construction; the payload flag is the pin's own local.
        ["topologyDirty", { cpp: "true", type: "bool", staticBoolean: true }],
        ["lightDataDirty", { cpp: "lightDataDirty", type: "bool" }],
        // The frame's two matrices are this function's parameters, so the
        // pin's `getViewMatrix`/`getProjectionMatrix` locals resolve to them.
        ["view", { cpp: "view", type: "f32" }],
        ["proj", { cpp: "proj", type: "f32" }],
        ["activeCamera.nearPlane", scalar("near_plane")],
        ["activeCamera.farPlane", scalar("far_plane")],
    ]);
    // The refresh's own `pointLights`/`spotLights` locals: the pin reads
    // them off the container, and the record's two filters are those lists.
    const lists = new Map([
        ["pointLights", "clustered_point_lights(container)"],
        ["spotLights", "clustered_spot_lights(container)"],
    ]);
    const isActiveList = (node: ts.Expression): boolean =>
        ts.isIdentifier(node) && bindings.get(node.text)?.cpp === "active";

    const statement: PinnedNumericScope["statement"] = (
        node,
        lowerer,
        indent,
    ) => {
        // The backend's uploads: a single call, or a guard around only them.
        const upload = (candidate: ts.Statement): boolean => {
            const callee = calledName(candidate, file);
            return (
                callee === "writeDataTexture" ||
                callee === "engine._device.queue.writeBuffer"
            );
        };
        if (upload(node)) return [];
        if (
            ts.isIfStatement(node) &&
            !node.elseStatement &&
            ts.isBlock(node.thenStatement) &&
            node.thenStatement.statements.length > 0 &&
            node.thenStatement.statements.every(upload)
        ) {
            return [];
        }
        if (ts.isExpressionStatement(node)) {
            const expression = node.expression;
            // `activeLights.length = 0`: the native list starts each
            // refresh empty and is cleared the way the pin truncates it.
            if (
                ts.isBinaryExpression(expression) &&
                expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(expression.left) &&
                expression.left.name.text === "length" &&
                isActiveList(expression.left.expression) &&
                ts.isNumericLiteral(expression.right) &&
                Number(expression.right.text) === 0
            ) {
                return [`${indent}active.clear();`];
            }
            if (
                ts.isCallExpression(expression) &&
                ts.isPropertyAccessExpression(expression.expression)
            ) {
                const callee = expression.expression;
                if (
                    callee.name.text === "sort" &&
                    isActiveList(callee.expression)
                ) {
                    return [activeLightSort(context, file, expression, indent)];
                }
                if (
                    callee.name.text === "push" &&
                    isActiveList(callee.expression)
                ) {
                    return [
                        `${indent}active.push_back(${activeLightLiteral(context, members, expression, lowerer)});`,
                    ];
                }
                // `spotSupport?._collect(activeLights, spotLights, view)`:
                // the spot opt-in's own collection, lowered where it runs.
                if (
                    callee.name.text === "_collect" &&
                    calledName(node, file) === "spotSupport._collect"
                ) {
                    return spotCollect(
                        context,
                        members,
                        expression,
                        bindings,
                        lists,
                        indent,
                    );
                }
            }
        }
        // `const { light, depth } = activeLights[i]!`: one active light,
        // read through the native struct's members.
        if (ts.isVariableStatement(node)) {
            const [entry, ...others] = node.declarationList.declarations;
            const source = entry?.initializer
                ? context.unwrapExpression(entry.initializer)
                : undefined;
            if (
                entry &&
                others.length === 0 &&
                ts.isObjectBindingPattern(entry.name) &&
                source &&
                ts.isElementAccessExpression(source) &&
                isActiveList(source.expression)
            ) {
                const element = "active_light";
                const lines = [
                    `${indent}const ClusteredActiveLight& ${element} = active[static_cast<std::size_t>(${lowerer.expression(source.argumentExpression)})];`,
                ];
                for (const binding of entry.name.elements) {
                    const pinned = ts.isIdentifier(binding.name)
                        ? binding.name.text
                        : undefined;
                    const member = members.find(
                        (candidate) => candidate.name === pinned,
                    );
                    if (
                        !pinned ||
                        !member ||
                        binding.propertyName ||
                        binding.dotDotDotToken
                    ) {
                        return context.contractError(
                            binding,
                            "Expected a _ClusteredActiveLight member.",
                        );
                    }
                    const field = `${element}.${pinned}`;
                    if (!member.record) {
                        bindings.set(pinned, scalar(field));
                        continue;
                    }
                    bindings.set(pinned, {
                        cpp: member.optional ? field : `(*${field})`,
                        type: "opaque",
                        ...(member.optional
                            ? { absentCpp: `${field} == nullptr` }
                            : {}),
                    });
                    for (const [path, value] of clusteredLightMembers(
                        pinned,
                        `${field}->`,
                    )) {
                        bindings.set(path, value);
                    }
                }
                return lines;
            }
        }
        return undefined;
    };

    const scope = {
        calls: shared.calls,
        methods: shared.methods,
        arrayCopy: (receiver: string, source: string, offset: string) =>
            `std::transform(${source}.begin(), ${source}.end(), ${receiver}.begin() + static_cast<std::ptrdiff_t>(${offset}), [](double value) { return static_cast<float>(value); })`,
        booleanAnd: true,
        forOf: lightListForOf(lists),
        statement,
    };
    const stride = lowerPinnedBody(file, [lightStride], {
        ...scope,
        bindings,
    });
    const body = lowerPinnedBody(file, range, { ...scope, bindings });
    return `${stride}\n${body}`;
}

/**
 * `activeLights.sort((a, b) => a.depth - b.depth)`: the pin's comparator,
 * lowered, under the stable sort `Array.prototype.sort` has been since
 * ES2019 -- ties keep collection order, and a tie broken differently would
 * move which light a slice's range starts at.
 */
function activeLightSort(
    context: LoweringContext,
    file: ts.SourceFile,
    call: ts.CallExpression,
    indent: string,
): string {
    const comparator = call.arguments[0]
        ? context.unwrapExpression(call.arguments[0])
        : undefined;
    const names =
        comparator && ts.isArrowFunction(comparator)
            ? clusteredParameterNames(context, comparator)
            : [];
    if (
        !comparator ||
        !ts.isArrowFunction(comparator) ||
        call.arguments.length !== 1 ||
        names.length !== 2 ||
        ts.isBlock(comparator.body)
    ) {
        return context.contractError(
            call,
            "Expected the active lights sorted by a two-parameter comparator.",
        );
    }
    const bindings = new Map<string, PinnedBinding>();
    for (const name of names) {
        bindings.set(name, { cpp: name, type: "opaque" });
        for (const { name: member, record } of activeLightMembers(context)) {
            if (!record)
                bindings.set(`${name}.${member}`, scalar(`${name}.${member}`));
        }
    }
    const compare = new PinnedNumericLowerer(file, {
        bindings,
        calls: pinnedNumericMathCalls(),
    }).expression(comparator.body);
    const [a, b] = names;
    return (
        `${indent}std::stable_sort(active.begin(), active.end(), ` +
        `[](const ClusteredActiveLight& ${a}, const ClusteredActiveLight& ${b}) { ` +
        `return ${compare} < 0.0; });`
    );
}

/** An `activeLights.push({...})` literal as the native struct, member by member. */
function activeLightLiteral(
    context: LoweringContext,
    members: ReturnType<typeof activeLightMembers>,
    call: ts.CallExpression,
    lowerer: PinnedNumericLowerer,
): string {
    const literal = call.arguments[0]
        ? context.unwrapExpression(call.arguments[0])
        : undefined;
    if (
        !literal ||
        !ts.isObjectLiteralExpression(literal) ||
        call.arguments.length !== 1
    ) {
        return context.contractError(
            call,
            "Expected one _ClusteredActiveLight literal pushed.",
        );
    }
    const values = new Map<string, ts.Expression>();
    for (const property of literal.properties) {
        const name = property.name
            ? context.propertyName(property.name)
            : undefined;
        if (!name || !members.some((member) => member.name === name)) {
            context.contractError(
                property,
                "Expected a _ClusteredActiveLight member.",
            );
        }
        values.set(
            name,
            ts.isShorthandPropertyAssignment(property)
                ? property.name
                : ts.isPropertyAssignment(property)
                  ? property.initializer
                  : context.contractError(property, "Expected a member value."),
        );
    }
    const fields = members.map(({ name, record, optional }) => {
        const value = values.get(name);
        if (!value) {
            return optional
                ? "nullptr"
                : context.contractError(
                      literal,
                      `Expected the active light to carry '${name}'.`,
                  );
        }
        const lowered = lowerer.expression(value);
        return record ? `&${lowered}` : lowered;
    });
    return `ClusteredActiveLight{${fields.join(", ")}}`;
}

/**
 * `spotSupport?._collect(activeLights, spotLights, view)`: the spot
 * opt-in's collection, lowered from its own method over the call's
 * arguments, and run only once a spot installed the support.
 */
function spotCollect(
    context: LoweringContext,
    members: ReturnType<typeof activeLightMembers>,
    call: ts.CallExpression,
    outer: ReadonlyMap<string, PinnedBinding>,
    outerLists: ReadonlyMap<string, string>,
    indent: string,
): string[] {
    const { file, method } = clusteredSpotMethod(context, "_collect");
    const names = clusteredParameterNames(context, method);
    if (names.length !== call.arguments.length) {
        return context.contractError(
            call,
            "Expected _collect's own arity at its call.",
        );
    }
    const bindings = new Map<string, PinnedBinding>();
    const lists = new Map<string, string>();
    names.forEach((name, index) => {
        const argument = context.unwrapExpression(call.arguments[index]!);
        const text = argument.getText(call.getSourceFile());
        const list = outerLists.get(text);
        if (list !== undefined) {
            lists.set(name, list);
            return;
        }
        const bound = outer.get(text);
        if (!bound) {
            context.contractError(
                argument,
                `Unbound _collect argument '${text}'.`,
            );
        }
        bindings.set(name, bound);
        for (const [path, value] of outer) {
            if (path.startsWith(`${text}.`)) {
                bindings.set(`${name}${path.slice(text.length)}`, value);
            }
        }
    });
    const inner = lowerPinnedBody(
        file,
        method.body.statements,
        {
            bindings,
            calls: pinnedNumericMathCalls(),
            booleanAnd: true,
            forOf: lightListForOf(lists),
            statement: (node, nested, nestedIndent) => {
                if (
                    ts.isExpressionStatement(node) &&
                    ts.isCallExpression(node.expression) &&
                    ts.isPropertyAccessExpression(node.expression.expression) &&
                    node.expression.expression.name.text === "push" &&
                    bindings.get(
                        node.expression.expression.expression.getText(file),
                    )?.cpp === "active"
                ) {
                    return [
                        `${nestedIndent}active.push_back(${activeLightLiteral(context, members, node.expression, nested)});`,
                    ];
                }
                return undefined;
            },
        },
        `${indent}    `,
    );
    return [`${indent}if (container.has_spots) {`, inner, `${indent}}`];
}

/** The clustered light field's generated header and translation unit. */
export function lowerClusteredLights(context: LoweringContext): LoweredSource {
    const header = `#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <numbers>
#include <ranges>
#include <vector>

#include "bblite/js_data.hpp"
#include "bblite/runtime.hpp"

namespace bbl::upstream {

${clusteredScalarHelpers(context)}

${clusteredConeWriter(context)}

${clusteredProjectedBounds(context)}

${clusteredAddLightToClusters(context)}

${activeLightStruct(context)}

/** The pin keeps \`pointLights\` and \`spotLights\` apart; the record keeps
 *  one list in creation order and flags each spot, so the two are its two
 *  filters, each in the pin's own order. */
inline auto clustered_point_lights(const ClusteredLightContainer& container) {
    return container.lights |
        std::views::filter([](const ClusteredLight& light) { return !light.spot; });
}
inline auto clustered_spot_lights(const ClusteredLightContainer& container) {
    return container.lights |
        std::views::filter([](const ClusteredLight& light) { return light.spot; });
}

/** A store through the pin's \`F32\` view of the params \`ArrayBuffer\`: the
 *  lane holds that float's bytes. */
inline void store_clustered_f32_lane(
    std::array<std::uint32_t, 8>& params,
    double index,
    double value) {
    const float lane = static_cast<float>(value);
    std::memcpy(&params[static_cast<std::size_t>(index)], &lane, sizeof lane);
}

/** \`buildClusteredLightGpuState\`, once when the container is added: the
 *  record takes the extents, the zeroed payloads and the seeded params the
 *  backend creates its GPU objects from. */
void size_clustered_light_state(
    Engine& engine,
    Scene& scene,
    ClusteredLightContainer& container);

/** The pin's per-frame \`refresh\`: re-bin every light against the frame's
 *  own two matrices, and rewrite whatever payload that moved. */
void refresh_clustered_lights(
    ClusteredLightContainer& container,
    const std::array<float, 16>& view,
    const std::array<float, 16>& proj,
    double near_plane,
    double far_plane);

/** The container a handle names, for the backend that binds it. Const
 *  because a backend resolving a uniform block holds the engine that way,
 *  and mutable because the frame's re-bin writes through it. */
const ClusteredLightContainer* clustered_container(
    const Engine& engine,
    ClusteredLightContainerHandle handle);
ClusteredLightContainer* clustered_container(
    Engine& engine,
    ClusteredLightContainerHandle handle);

}  // namespace bbl::upstream

namespace bbl {

// The scene surface, at the pin's own four entry points.
ClusteredLightContainerHandle create_clustered_light_container(
    Engine& engine,
    double horizontal_tiles,
    double vertical_tiles,
    double z_slices);

void create_clustered_point_light(
    Engine& engine,
    ClusteredLightContainerHandle container,
    const Vec3d& position,
    const Vec3d& diffuse,
    double range,
    double intensity);

void create_clustered_spot_light(
    Engine& engine,
    ClusteredLightContainerHandle container,
    const Vec3d& position,
    const Vec3d& diffuse,
    double range,
    double intensity,
    const Vec3d& direction,
    double angle);

void add_clustered_light_container(
    Engine& engine,
    Scene& scene,
    ClusteredLightContainerHandle container);

}  // namespace bbl
`;
    const source = `// ${context.provenance(clusteredModule, buildSymbol)}
#include "bblite/upstream/clustered_light.hpp"

#include <stdexcept>

namespace bbl::upstream {

void size_clustered_light_state(
    Engine& engine,
    Scene& scene,
    ClusteredLightContainer& container) {
    const auto scene_camera = [&]() -> const CameraRecord& {
        return ${recordAt("engine.cameras", "scene.camera")};
    };
${lowerBuild(context)}
}

void refresh_clustered_lights(
    ClusteredLightContainer& container,
    const std::array<float, 16>& view,
    const std::array<float, 16>& proj,
    double near_plane,
    double far_plane) {
    // The frame's own two matrices, which the caller already built, are
    // the dirty key: nothing else the pin's four proxies stand for can move
    // the tiles a light lands in.
    if (container.binned && container.last_view == view &&
        container.last_proj == proj) {
        return;
    }
    bool lightDataDirty = false;
    std::vector<ClusteredActiveLight> active;
${lowerRefresh(context)}
    container.last_view = view;
    container.last_proj = proj;
    container.binned = true;
    container.upload_version++;
}

const ClusteredLightContainer* clustered_container(
    const Engine& engine,
    ClusteredLightContainerHandle handle) {
    return handle.value < engine.clustered_light_containers.size()
        ? &${recordAt("engine.clustered_light_containers", "handle")}
        : nullptr;
}

ClusteredLightContainer* clustered_container(
    Engine& engine,
    ClusteredLightContainerHandle handle) {
    return const_cast<ClusteredLightContainer*>(clustered_container(
        static_cast<const Engine&>(engine), handle));
}

}  // namespace bbl::upstream

namespace bbl {

ClusteredLightContainerHandle create_clustered_light_container(
    Engine& engine,
    double horizontal_tiles,
    double vertical_tiles,
    double z_slices) {
    auto& containers = engine.clustered_light_containers;
    containers.push_back(ClusteredLightContainer{});
    auto& container = containers.back();
    container.horizontal_tiles = horizontal_tiles;
    container.vertical_tiles = vertical_tiles;
    container.z_slices = z_slices;
    return ClusteredLightContainerHandle{
        static_cast<std::uint32_t>(containers.size() - 1)};
}

void create_clustered_point_light(
    Engine& engine,
    ClusteredLightContainerHandle handle,
    const Vec3d& position,
    const Vec3d& diffuse,
    double range,
    double intensity) {
    auto* container = upstream::clustered_container(engine, handle);
    if (!container) return;
    container->lights.push_back(ClusteredLight{
        {position.x, position.y, position.z},
        {diffuse.x, diffuse.y, diffuse.z},
        range,
        intensity,
        {},
        0.0,
        false});
}

void create_clustered_spot_light(
    Engine& engine,
    ClusteredLightContainerHandle handle,
    const Vec3d& position,
    const Vec3d& diffuse,
    double range,
    double intensity,
    const Vec3d& direction,
    double angle) {
    auto* container = upstream::clustered_container(engine, handle);
    if (!container) return;
    container->lights.push_back(ClusteredLight{
        {position.x, position.y, position.z},
        {diffuse.x, diffuse.y, diffuse.z},
        range,
        intensity,
        {direction.x, direction.y, direction.z},
        angle,
        true});
    container->has_spots = true;
}

void add_clustered_light_container(
    Engine& engine,
    Scene& scene,
    ClusteredLightContainerHandle handle) {
    auto* container = upstream::clustered_container(engine, handle);
    if (!container) {
        throw std::runtime_error(
            "addClusteredLightContainer: unknown container.");
    }
    scene.clustered_lights = handle;
    upstream::size_clustered_light_state(engine, scene, *container);
}

}  // namespace bbl
`;
    return {
        header,
        source,
        modulePath: clusteredModule,
        symbolName: buildSymbol,
    };
}
