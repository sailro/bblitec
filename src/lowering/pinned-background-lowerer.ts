/**
 * `pinned_backgrounds.hpp`: the pin's background arms as a table both
 * backends build their pipelines from, and the lowered builders that fill
 * each arm's buffers from the scene's own values.
 *
 * Everything in the table is what generation read back from executing the
 * pin's factories (`pinned-background-modules.ts`): the stage stems, the
 * vertex layouts, the rasterizer, depth and blend state, the group-1 layout
 * entries and the index width. The buffers are the pin's own functions,
 * lowered: each arm's geometry builder (`createGroundBuffers`,
 * `createSkyboxBuffers`) and mesh-block writer (`createBgMeshUBO` and its
 * three siblings), with the factory's call to each read off its AST so the
 * arguments the native side passes are the ones the pin passes. The image
 * skybox's loader writes its world block from constants, so that block ships
 * as the pin wrote it, and its box is the lowered `createBoxData`.
 */
import ts from "typescript";
import { snakeCase } from "../cpp-literals.js";
import type {
    PinnedBackgroundArm,
    PinnedBackgroundArmName,
} from "../pinned-background-modules.js";
import type { LoweringContext } from "./context.js";
import {
    lowerPinnedFunction,
    type PinnedFunctionParameter,
} from "./pinned-function-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

/** The native enumerator for each arm. */
const armKinds: Readonly<Record<PinnedBackgroundArmName, string>> = {
    ground: "ground",
    groundDither: "ground_dither",
    ddsSkybox: "dds_skybox",
    ddsSkyboxNoDither: "dds_skybox_no_dither",
    hdrSkybox: "hdr_skybox",
    solidSkybox: "solid_skybox",
    imageSkybox: "image_skybox",
};

/**
 * Per factory module: the function that builds the arm's geometry and the
 * one that writes its mesh block, as the factory calls them.
 */
interface LoweredFactory {
    modulePath: string;
    factory: string;
    builder: string;
    writer: string;
    /** The C++ names the two lower to. */
    geometryCpp: string;
    blockCpp: string;
}

const loweredFactories: ReadonlyMap<string, LoweredFactory> = new Map(
    [
        {
            modulePath: "src/material/pbr/background-ground.ts",
            factory: "buildGroundRenderable",
            builder: "createGroundBuffers",
            writer: "createBgMeshUBO",
            geometryCpp: "pinned_ground_geometry",
            blockCpp: "pinned_ground_mesh_block",
        },
        {
            modulePath: "src/material/pbr/background-dds-skybox.ts",
            factory: "buildDdsSkyboxRenderable",
            builder: "createSkyboxBuffers",
            writer: "createDdsMeshUBO",
            geometryCpp: "pinned_dds_skybox_geometry",
            blockCpp: "pinned_dds_skybox_mesh_block",
        },
        {
            modulePath: "src/material/pbr/background-hdr-skybox.ts",
            factory: "buildHdrSkyboxRenderable",
            builder: "createSkyboxBuffers",
            writer: "createSkyHdrMeshUBO",
            geometryCpp: "pinned_hdr_skybox_geometry",
            blockCpp: "pinned_hdr_skybox_mesh_block",
        },
        {
            modulePath: "src/material/pbr/background-solid-skybox.ts",
            factory: "buildSolidSkyboxRenderable",
            builder: "createSkyboxBuffers",
            writer: "createSkyMeshUBO",
            geometryCpp: "pinned_solid_skybox_geometry",
            blockCpp: "pinned_solid_skybox_mesh_block",
        },
    ].map((entry) => [entry.modulePath, entry]),
);

const imageSkyboxModule = "src/loader-skybox/load-skybox.ts";

/**
 * The native value behind each scene path a factory passes on. These are
 * the records the pin's factories read -- the environment the loaders
 * size and colour, the scene's image processing and clear colour -- in the
 * native `Scene` that mirrors them. `skyHalfSize` is the half the entry
 * points take of the skybox size before calling the factory; that halving
 * is asserted against both entries in `assertSkyHalfSize`.
 */
const nativeScenePaths: ReadonlyMap<string, string> = new Map([
    ["groundSize", "scene.environment.ground_size"],
    ["skyHalfSize", "scene.environment.skybox_size / 2.0"],
    ["size", "scene.environment.image_skybox_size"],
    [
        "scene.imageProcessing.exposure",
        "static_cast<double>(scene.environment.exposure)",
    ],
    [
        "scene.imageProcessing.contrast",
        "static_cast<double>(scene.environment.contrast)",
    ],
    ["scene.clearColor", "scene.clear_color"],
    ["scene.clearColor.r", "static_cast<double>(scene.clear_color.r)"],
    ["scene.clearColor.g", "static_cast<double>(scene.clear_color.g)"],
    ["scene.clearColor.b", "static_cast<double>(scene.clear_color.b)"],
]);

/** The two tuples every factory receives, by the root the arm draws at. */
function tupleArguments(arm: PinnedBackgroundArmName): Map<string, string> {
    const position = arm.startsWith("ground")
        ? "scene.environment.ground_position"
        : "scene.environment.skybox_position";
    return new Map([
        [
            "rootPosition",
            `std::array<double, 3>{${position}.x, ${position}.y, ${position}.z}`,
        ],
        [
            "primaryColor",
            "std::array<double, 3>{static_cast<double>(scene.environment.primary_color.r), " +
                "static_cast<double>(scene.environment.primary_color.g), " +
                "static_cast<double>(scene.environment.primary_color.b)}",
        ],
    ]);
}

/**
 * The C++ value of one argument a factory passes, resolved through the
 * factory's own locals (`const cc = scene.clearColor`) down to a scene path
 * or one of the factory's parameters.
 */
function nativeArgument(
    context: LoweringContext,
    factory: ts.FunctionDeclaration,
    argument: ts.Expression,
    tuples: ReadonlyMap<string, string>,
): string {
    const expression = context.unwrapExpression(argument);
    if (ts.isArrayLiteralExpression(expression)) {
        return `std::array<double, ${expression.elements.length}>{${expression.elements
            .map((element) => nativeArgument(context, factory, element, tuples))
            .join(", ")}}`;
    }
    const local = ts.isIdentifier(expression)
        ? factoryLocal(context, factory, expression)
        : undefined;
    if (local) return nativeArgument(context, factory, local, tuples);
    const path = scenePath(context, factory, expression);
    const native = tuples.get(path) ?? nativeScenePaths.get(path);
    if (native === undefined) {
        context.contractError(
            argument,
            `Pinned background argument '${path}' has no native value.`,
        );
    }
    return native;
}

/**
 * The initializer of the factory local `name` reads, or undefined for one of
 * the factory's parameters.
 */
function factoryLocal(
    context: LoweringContext,
    factory: ts.FunctionDeclaration,
    name: ts.Identifier,
): ts.Expression | undefined {
    if (
        factory.parameters.some(
            (parameter) =>
                ts.isIdentifier(parameter.name) &&
                parameter.name.text === name.text,
        )
    ) {
        return undefined;
    }
    const locals = context.findNodes(
        factory,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === name.text &&
            node.initializer !== undefined,
    );
    if (locals.length !== 1) {
        context.contractError(
            name,
            `Expected pinned '${name.text}' to be a parameter or one local.`,
        );
    }
    return locals[0]!.initializer!;
}

/** The dotted path an argument reads, with the factory's locals inlined. */
function scenePath(
    context: LoweringContext,
    factory: ts.FunctionDeclaration,
    expression: ts.Expression,
): string {
    const unwrapped = context.unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(unwrapped)) {
        return `${scenePath(context, factory, unwrapped.expression)}.${unwrapped.name.text}`;
    }
    if (!ts.isIdentifier(unwrapped)) {
        context.contractError(
            expression,
            "Expected a pinned background argument to read a path.",
        );
    }
    const local = factoryLocal(context, factory, unwrapped);
    return local ? scenePath(context, factory, local) : unwrapped.text;
}

/** The one call to `callee` inside a pinned factory. */
function factoryCall(
    context: LoweringContext,
    factory: ts.FunctionDeclaration,
    callee: string,
): ts.CallExpression {
    const calls = context.findNodes(
        factory,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === callee,
    );
    if (calls.length !== 1) {
        context.contractError(
            factory,
            `Expected pinned ${factory.name?.text ?? "factory"} to call ${callee} once.`,
        );
    }
    return calls[0]!;
}

/**
 * Both entry points halve the skybox size before a skybox factory sees it:
 * `loadEnvironment` names the half `skyHalfSize`, and
 * `addDdsEnvironmentBackground` passes `skyboxSize / 2` straight on.
 */
function assertSkyHalfSize(context: LoweringContext): void {
    const loadEnv = context.functionDeclaration(
        "src/loader-env/load-env.ts",
        "loadEnvironment",
    );
    const halves = context.findNodes(
        loadEnv.declaration,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "skyHalfSize" &&
            node.initializer !== undefined,
    );
    if (halves.length !== 1) {
        context.contractError(
            loadEnv.declaration,
            "Expected pinned loadEnvironment to name one skyHalfSize.",
        );
    }
    context.assertExpressionShape(
        halves[0]!.initializer!,
        "autoSkyboxSize / 2",
        "Pinned loadEnvironment skyHalfSize",
    );
    const dds = context.functionDeclaration(
        "src/material/pbr/background-dds-environment.ts",
        "addDdsEnvironmentBackground",
    );
    const call = factoryCall(
        context,
        dds.declaration,
        "buildDdsSkyboxRenderable",
    );
    context.assertExpressionShape(
        call.arguments[1]!,
        "skyboxSize / 2",
        "Pinned addDdsEnvironmentBackground skybox half size",
    );
}

/** A writer or builder parameter, from its pinned annotation. */
function loweredParameter(
    context: LoweringContext,
    parameter: ts.ParameterDeclaration,
    memberBindings: Map<string, PinnedBinding>,
): PinnedFunctionParameter {
    const file = parameter.getSourceFile();
    if (!ts.isIdentifier(parameter.name) || !parameter.type) {
        context.contractError(
            parameter,
            "Expected an annotated pinned background parameter.",
        );
    }
    const pinned = parameter.name.text;
    const cpp = snakeCase(pinned);
    const annotation = parameter.type.getText(file);
    switch (annotation) {
        case "EngineContext":
            return {
                pinned,
                kind: "record",
                annotation,
                cpp,
                cppType: "Engine",
                specialized: true,
                binding: { cpp, type: "opaque" },
            };
        case "number":
            return { pinned, kind: "number", cpp };
        case "[number, number, number]":
            return {
                pinned,
                kind: "record",
                annotation,
                cpp,
                cppType: "std::array<double, 3>",
                binding: { cpp, type: "f64-buffer" },
            };
        case "GPUColorDict":
            for (const lane of ["r", "g", "b", "a"]) {
                memberBindings.set(`${pinned}.${lane}`, {
                    cpp: `static_cast<double>(${cpp}.${lane})`,
                    type: "scalar",
                });
            }
            return {
                pinned,
                kind: "record",
                annotation,
                cpp,
                cppType: "Color4",
                binding: { cpp, type: "opaque" },
            };
        default:
            context.contractError(
                parameter,
                `Pinned background parameter '${pinned}: ${annotation}' has no native shape.`,
            );
    }
}

function loweredParameters(
    context: LoweringContext,
    declaration: ts.FunctionDeclaration,
): {
    parameters: PinnedFunctionParameter[];
    memberBindings: Map<string, PinnedBinding>;
} {
    const memberBindings = new Map<string, PinnedBinding>();
    return {
        parameters: declaration.parameters.map((parameter) =>
            loweredParameter(context, parameter, memberBindings),
        ),
        memberBindings,
    };
}

/** The native call of a lowered function at the factory's own arguments. */
function nativeCall(
    context: LoweringContext,
    factory: ts.FunctionDeclaration,
    call: ts.CallExpression,
    parameters: readonly PinnedFunctionParameter[],
    cppName: string,
    tuples: ReadonlyMap<string, string>,
): string {
    if (call.arguments.length !== parameters.length) {
        context.contractError(
            call,
            `Expected the pinned call to pass ${parameters.length} arguments.`,
        );
    }
    const args = call.arguments.flatMap((argument, index) =>
        parameters[index]!.specialized
            ? []
            : [nativeArgument(context, factory, argument, tuples)],
    );
    return `${cppName}(${args.join(", ")})`;
}

/**
 * One geometry builder, lowered: its typed-array locals translate as the
 * pin states them, and its return -- an object or a tuple of
 * `createMappedBuffer(engine, <array>, BU.<usage>)` -- becomes the arrays
 * the draw binds, in the draw's slot order.
 */
function lowerGeometryBuilder(
    context: LoweringContext,
    factory: LoweredFactory,
    arm: PinnedBackgroundArm,
): string {
    const { declaration } = context.functionDeclaration(
        factory.modulePath,
        factory.builder,
    );
    const { parameters } = loweredParameters(context, declaration);
    return lowerPinnedFunction(
        context,
        factory.modulePath,
        factory.builder,
        parameters,
        {
            cppName: factory.geometryCpp,
            inline: true,
            returns: {
                type: "PinnedBackgroundGeometry",
                value: (lowerer, expression) => {
                    const returned = expression
                        ? context.unwrapExpression(expression)
                        : undefined;
                    const entries = new Map<string, ts.Expression>();
                    if (returned && ts.isObjectLiteralExpression(returned)) {
                        for (const property of returned.properties) {
                            if (
                                !ts.isPropertyAssignment(property) ||
                                !ts.isIdentifier(property.name)
                            ) {
                                context.contractError(
                                    property,
                                    `Expected pinned ${factory.builder} to return named buffers.`,
                                );
                            }
                            entries.set(
                                property.name.text,
                                property.initializer,
                            );
                        }
                    } else if (
                        returned &&
                        ts.isArrayLiteralExpression(returned)
                    ) {
                        returned.elements.forEach((element, index) =>
                            entries.set(String(index), element),
                        );
                    } else {
                        context.contractError(
                            returned ?? declaration,
                            `Expected pinned ${factory.builder} to return its buffers.`,
                        );
                    }
                    const array = (key: string, usage: string): string => {
                        const created = entries.get(key);
                        const call = created
                            ? context.unwrapExpression(created)
                            : undefined;
                        if (
                            !call ||
                            !ts.isCallExpression(call) ||
                            call.arguments.length !== 3
                        ) {
                            return context.contractError(
                                created ?? declaration,
                                `Expected pinned ${factory.builder} '${key}' to be one createMappedBuffer.`,
                            );
                        }
                        context.assertExpressionShape(
                            call,
                            `createMappedBuffer(engine, ${call.arguments[1]!.getText()}, BU.${usage})`,
                            `Pinned ${factory.builder} '${key}'`,
                        );
                        return `pinned_background_bytes(${lowerer.expression(call.arguments[1]!)})`;
                    };
                    return (
                        "PinnedBackgroundGeometry{{" +
                        arm.draw.vertexSlots
                            .map((key) => array(key, "VERTEX"))
                            .join(", ") +
                        `}, ${array(arm.draw.index, "INDEX")}}`
                    );
                },
            },
        },
    );
}

/**
 * One mesh-block writer, lowered: it fills `new F32(<SIZE> / 4)` and hands
 * the array to `createUniformBuffer`; the lowering returns the array, whose
 * size is asserted against the block the recorded draw bound.
 */
function lowerMeshBlockWriter(
    context: LoweringContext,
    factory: LoweredFactory,
    arm: PinnedBackgroundArm,
): string {
    const { declaration } = context.functionDeclaration(
        factory.modulePath,
        factory.writer,
    );
    const storage = context.findNodes(
        declaration,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "data" &&
            node.initializer !== undefined,
    )[0]?.initializer;
    const allocation = storage ? context.unwrapExpression(storage) : undefined;
    const size =
        allocation &&
        ts.isNewExpression(allocation) &&
        allocation.arguments?.length === 1
            ? context.unwrapExpression(allocation.arguments[0]!)
            : undefined;
    if (
        !size ||
        !ts.isBinaryExpression(size) ||
        !ts.isIdentifier(size.left) ||
        size.operatorToken.kind !== ts.SyntaxKind.SlashToken
    ) {
        return context.contractError(
            declaration,
            `Expected pinned ${factory.writer} to fill new F32(<SIZE> / 4).`,
        );
    }
    const bytes = context.pinnedNumber(factory.modulePath, size.left.text);
    if (bytes !== arm.meshBlockBytes) {
        context.contractError(
            size,
            `Pinned ${size.left.text} is ${bytes} bytes; the drawn mesh block is ${arm.meshBlockBytes}.`,
        );
    }
    const floats = bytes / 4;
    const { parameters, memberBindings } = loweredParameters(
        context,
        declaration,
    );
    return lowerPinnedFunction(
        context,
        factory.modulePath,
        factory.writer,
        parameters,
        {
            cppName: factory.blockCpp,
            inline: true,
            memberBindings,
            localStorage: [
                {
                    pinned: "data",
                    initializer: `new F32(${size.left.text} / 4)`,
                    binding: { cpp: "data", type: "f32" },
                    declaration: `std::array<float, ${floats}> data{};`,
                },
            ],
            returns: {
                type: `std::array<float, ${floats}>`,
                value: (_lowerer, expression) => {
                    if (!expression) {
                        return context.contractError(
                            declaration,
                            `Expected pinned ${factory.writer} to return its buffer.`,
                        );
                    }
                    context.assertExpressionShape(
                        expression,
                        "createUniformBuffer(engine, data)",
                        `Pinned ${factory.writer} return`,
                    );
                    return "data";
                },
            },
        },
    );
}

/** The image skybox's box, as `loadSkybox` builds it. */
function imageSkyboxGeometry(
    context: LoweringContext,
    arm: PinnedBackgroundArm,
): string {
    const loader = context.functionDeclaration(imageSkyboxModule, "loadSkybox");
    const call = factoryCall(context, loader.declaration, "createBoxData");
    context.assertExpressionShape(
        call,
        "createBoxData(size)",
        "Pinned loadSkybox box",
    );
    // createBoxData(number) spans that one number on all three axes; the
    // native `create_box_data` is the options arm's width/height/depth.
    const box = context.functionDeclaration(
        "src/mesh/create-box.ts",
        "createBoxData",
    );
    const numberArm = context.findNodes(
        box.declaration,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.left) &&
            node.left.text === "dimensions" &&
            ts.isArrayLiteralExpression(node.right) &&
            node.right.elements.every(
                (element) =>
                    ts.isIdentifier(element) && element.text === "options",
            ),
    );
    if (numberArm.length !== 1) {
        context.contractError(
            box.declaration,
            "Expected pinned createBoxData to span a number on all three axes.",
        );
    }
    const members = new Set(["positions", "normals", "uvs", "indices"]);
    for (const key of [...arm.draw.vertexSlots, arm.draw.index]) {
        if (!members.has(key)) {
            context.contractError(
                call,
                `Pinned loadSkybox draws createBoxData '${key}', which MeshData does not carry.`,
            );
        }
    }
    return `// ${context.provenance(imageSkyboxModule, "loadSkybox", "src/mesh/create-box.ts#createBoxData")}
inline PinnedBackgroundGeometry pinned_image_skybox_geometry(double size) {
    const MeshData box = create_box_data(size, size, size);
    return PinnedBackgroundGeometry{{${arm.draw.vertexSlots
        .map((key) => `pinned_background_bytes(box.${key})`)
        .join(", ")}}, pinned_background_bytes(box.${arm.draw.index})};
}`;
}

const vertexFormats: ReadonlyMap<string, string> = new Map([
    ["float32x2", "float32x2"],
    ["float32x3", "float32x3"],
    ["float32x4", "float32x4"],
]);

const bindingKinds: Readonly<
    Record<PinnedBackgroundArm["bindings"][number]["kind"], string>
> = {
    uniformBuffer: "uniformBuffer",
    texture2d: "texture2d",
    textureCube: "textureCube",
    sampler: "sampler",
};

/** Emits `upstream/include/bblite/upstream/pinned_backgrounds.hpp`. */
export function pinnedBackgroundsHeader(
    context: LoweringContext,
    arms: readonly PinnedBackgroundArm[],
): string {
    const attributes: string[] = [];
    const streams: string[] = [];
    const bindings: string[] = [];
    const rows: string[] = [];
    for (const arm of arms) {
        const firstStream = streams.length;
        for (const buffer of arm.vertexBuffers) {
            const firstAttribute = attributes.length;
            for (const attribute of buffer.attributes) {
                const format = vertexFormats.get(attribute.format);
                if (!format) {
                    throw new Error(
                        `Pinned ${arm.symbolName} reads a '${attribute.format}' vertex attribute; no native format is mapped.`,
                    );
                }
                attributes.push(
                    `    PinnedVertexAttribute{${attribute.shaderLocation}u, ${attribute.offset}u, PinnedVertexFormat::${format}},`,
                );
            }
            streams.push(
                `    PinnedVertexStream{${buffer.arrayStride}u, ${firstAttribute}u, ${buffer.attributes.length}u},`,
            );
        }
        const firstBinding = bindings.length;
        for (const binding of arm.bindings) {
            bindings.push(
                `    PinnedVariantBinding{${binding.binding}u, "${binding.name}", PinnedBindingKind::${bindingKinds[binding.kind]}, ${binding.vertex}, ${binding.fragment}},`,
            );
        }
        const blend = arm.pipeline.blend;
        rows.push(`    // ${context.provenance(arm.modulePath, arm.symbolName)}
    PinnedBackgroundArm{
        PinnedBackgroundArmKind::${armKinds[arm.name]},
        "${arm.vertex.stem}",
        "${arm.fragment.stem}",
        ${firstStream}u,
        ${arm.vertexBuffers.length}u,
        ${firstBinding}u,
        ${arm.bindings.length}u,
        RenderCullMode::${arm.pipeline.cullMode},
        ${arm.pipeline.clockwiseFrontFace},
        ${arm.pipeline.depthWrite},
        ${blend !== undefined},
        BlendFactors{${
            blend
                ? [
                      blend.srcColor,
                      blend.dstColor,
                      blend.srcAlpha,
                      blend.dstAlpha,
                  ]
                      .map((factor) => `BlendFactor::${factor}`)
                      .join(", ")
                : ""
        }},
        ${arm.draw.indexFormat === "uint32"},
        ${arm.meshBlockBytes}u,
    },`);
    }

    // One lowered builder and writer per factory module; two arms of one
    // module (the dithered and undithered ground) share both, and must
    // draw the builder's results through the same slots.
    const lowered: string[] = [];
    const cases: string[] = [];
    const byModule = new Map<string, PinnedBackgroundArm>();
    const hasSkybox = arms.some(
        (arm) => arm.name !== "imageSkybox" && !arm.name.startsWith("ground"),
    );
    if (hasSkybox) assertSkyHalfSize(context);
    for (const arm of arms) {
        const kind = `PinnedBackgroundArmKind::${armKinds[arm.name]}`;
        if (arm.name === "imageSkybox") {
            const block = arm.constantMeshBlock;
            if (!block || block.length * 4 !== arm.meshBlockBytes) {
                throw new Error(
                    "Pinned loadSkybox's world block was not read back whole.",
                );
            }
            lowered.push(imageSkyboxGeometry(context, arm));
            const loader = context.functionDeclaration(
                imageSkyboxModule,
                "loadSkybox",
            ).declaration;
            const size = nativeArgument(
                context,
                loader,
                factoryCall(context, loader, "createBoxData").arguments[0]!,
                new Map(),
            );
            cases.push(`    case ${kind}: {
        // loadSkybox's own world: new F32(16) with the diagonal set,
        // written from constants and read back as the pin wrote it.
        static constexpr std::array<float, ${block.length}> world{${block
            .map((value) => context.floatLiteral(value))
            .join(", ")}};
        PinnedBackgroundGeometry geometry = pinned_image_skybox_geometry(${size});
        return {std::move(geometry.vertex), std::move(geometry.indices), pinned_background_bytes(world)};
    }`);
            continue;
        }
        const factory = loweredFactories.get(arm.modulePath);
        if (!factory) {
            throw new Error(
                `Pinned ${arm.modulePath} has no lowered background builder.`,
            );
        }
        const sibling = byModule.get(arm.modulePath);
        if (sibling) {
            if (
                JSON.stringify(sibling.draw) !== JSON.stringify(arm.draw) ||
                sibling.meshBlockBytes !== arm.meshBlockBytes
            ) {
                throw new Error(
                    `Pinned ${factory.factory} draws its arms through different buffers.`,
                );
            }
        } else {
            byModule.set(arm.modulePath, arm);
            lowered.push(
                lowerGeometryBuilder(context, factory, arm),
                lowerMeshBlockWriter(context, factory, arm),
            );
        }
        const factoryDeclaration = context.functionDeclaration(
            factory.modulePath,
            factory.factory,
        ).declaration;
        const tuples = tupleArguments(arm.name);
        const geometry = nativeCall(
            context,
            factoryDeclaration,
            factoryCall(context, factoryDeclaration, factory.builder),
            loweredParameters(
                context,
                context.functionDeclaration(factory.modulePath, factory.builder)
                    .declaration,
            ).parameters,
            factory.geometryCpp,
            tuples,
        );
        const block = nativeCall(
            context,
            factoryDeclaration,
            factoryCall(context, factoryDeclaration, factory.writer),
            loweredParameters(
                context,
                context.functionDeclaration(factory.modulePath, factory.writer)
                    .declaration,
            ).parameters,
            factory.blockCpp,
            tuples,
        );
        cases.push(`    case ${kind}: {
        PinnedBackgroundGeometry geometry = ${geometry};
        return {std::move(geometry.vertex), std::move(geometry.indices), pinned_background_bytes(${block})};
    }`);
    }

    return `// Generated by src/lowering/pinned-background-lowerer.ts from the pin's
// executed background factories and their lowered builders.
#pragma once

#include <bblite/runtime.hpp>
#include <bblite/upstream/pinned_variant_bindings.hpp>
#include <bblite/upstream/renderer_plan.hpp>

#include <array>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace bbl::upstream {

/** Every background arm the pin builds; a scene's table carries the reached ones. */
enum class PinnedBackgroundArmKind : std::uint8_t {
    ground,
    ground_dither,
    dds_skybox,
    dds_skybox_no_dither,
    hdr_skybox,
    solid_skybox,
    image_skybox,
};

enum class PinnedVertexFormat : std::uint8_t {
    float32x2,
    float32x3,
    float32x4,
};

struct PinnedVertexAttribute {
    std::uint32_t location;
    std::uint32_t offset;
    PinnedVertexFormat format;
};

/** One vertex buffer layout: its stride and its attributes' row range. */
struct PinnedVertexStream {
    std::uint32_t stride;
    std::uint32_t first_attribute;
    std::uint32_t attribute_count;
};

/**
 * One arm, as the pin's factory built its pipeline: the two stage stems,
 * its vertex layouts and group-1 entries (row ranges into the tables
 * below), its rasterizer, depth and blend state, and its index width. The
 * depth compare and sample count are the pass's, as they are the pin's
 * target signature's.
 */
struct PinnedBackgroundArm {
    PinnedBackgroundArmKind kind;
    std::string_view vertex_stem;
    std::string_view fragment_stem;
    std::uint32_t first_stream;
    std::uint32_t stream_count;
    std::uint32_t first_binding;
    std::uint32_t binding_count;
    RenderCullMode cull;
    bool clockwise_front_face;
    bool depth_write;
    bool blend;
    BlendFactors blend_factors;
    bool index_uint32;
    std::uint32_t mesh_block_bytes;
};

inline constexpr std::array<PinnedVertexAttribute, ${attributes.length}> pinned_background_attributes{{
${attributes.join("\n")}
}};

inline constexpr std::array<PinnedVertexStream, ${streams.length}> pinned_background_streams{{
${streams.join("\n")}
}};

inline constexpr std::array<PinnedVariantBinding, ${bindings.length}> pinned_background_bindings{{
${bindings.join("\n")}
}};

inline constexpr std::array<PinnedBackgroundArm, ${rows.length}> pinned_background_arms{{
${rows.join("\n")}
}};

/** The composed arm of \`kind\`; one generation did not compose is refused. */
inline const PinnedBackgroundArm& pinned_background_arm(PinnedBackgroundArmKind kind) {
    for (const PinnedBackgroundArm& arm : pinned_background_arms) {
        if (arm.kind == kind)
            return arm;
    }
    throw std::runtime_error("Background arm " +
                             std::to_string(static_cast<int>(kind)) +
                             " was not composed at generation.");
}

/** A pinned typed array's bytes, as the pin uploads them. */
template <typename Values>
std::vector<std::uint8_t> pinned_background_bytes(const Values& values) {
    std::vector<std::uint8_t> bytes(values.size() * sizeof(typename Values::value_type));
    if (!bytes.empty())
        std::memcpy(bytes.data(), values.data(), bytes.size());
    return bytes;
}

/** A geometry builder's result: the buffers the draw binds, by vertex slot. */
struct PinnedBackgroundGeometry {
    std::vector<std::vector<std::uint8_t>> vertex;
    std::vector<std::uint8_t> indices;
};

/** Everything one arm uploads: its vertex slots, its indices, its mesh block. */
struct PinnedBackgroundBuffers {
    std::vector<std::vector<std::uint8_t>> vertex;
    std::vector<std::uint8_t> indices;
    std::vector<std::uint8_t> mesh_block;
};

${lowered.join("\n\n")}

/**
 * The buffers an arm uploads, built once from the scene's values where the
 * pin's deferred builder builds them: each factory snapshots its sizes,
 * colours and image processing into buffers it never rewrites.
 */
inline PinnedBackgroundBuffers pinned_background_buffers(const PinnedBackgroundArm& arm,
                                                         const Scene& scene) {
    switch (arm.kind) {
${cases.join("\n")}
    default:
        break;
    }
    throw std::runtime_error("Background arm " +
                             std::to_string(static_cast<int>(arm.kind)) +
                             " was not composed at generation.");
}

} // namespace bbl::upstream
`;
}
