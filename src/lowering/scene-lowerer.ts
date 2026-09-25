import ts from "typescript";
import { assetRootTransformSource } from "./asset-root-transform.js";
import { LoweredSource, LoweringContext } from "./context.js";
import { lowerMat4InvertCpp } from "./pinned-function-lowerer.js";
import { lowerMat4DecomposeFull } from "./pinned-mat4-decompose.js";
import { sceneNodeTransformsSource } from "./scene-node-transforms.js";
import { PinnedNumericLowerer } from "./pinned-numeric-lowerer.js";
import { lowerAssetSceneAttachment } from "./asset-scene-attachment.js";
import { lowerMeshMaterialSetter } from "./mesh-material-setter.js";
import { lowerPbrMaterialGroups } from "./pbr-material-groups.js";
import { recordAt } from "../compiler/record-access.js";

const fogModulePath = "src/scene/scene-ubo-extras.ts";
const fogName = "setFog";
const clipPlaneModulePath = fogModulePath;
const clipPlaneName = "setClipPlane";

/**
 * cloneTransformNode's recursive copy over an import that carries its node
 * hierarchy: every node, the synthetic root included, is copied with its TRS
 * and raw matrix, linked and listed in the source's order, and each wrapper
 * copy hangs under its node's copy.
 */
function assetHierarchyCloneCpp(): string {
    return `
    const TransformNodeHandle source_root_node = source.root_node;
    const std::vector<TransformNodeHandle> source_nodes = source.nodes;
    if (source_root_node.value != invalid_handle) {
        std::unordered_map<std::uint32_t, TransformNodeHandle> copies;
        const auto copy_node = [&](const TransformNodeHandle& from) {
            // A copy, not a reference: the factory may grow the node table.
            const TransformNodeRecord original = ${recordAt("engine.transform_nodes", "from")};
            TransformNodeHandle made = create_transform_node(
                engine, original.name, original.position, original.rotation_quaternion,
                original.scaling);
            TransformNodeRecord& copy = ${recordAt("engine.transform_nodes", "made")};
            copy.rotation = original.rotation;
            copy.has_rotation_quaternion = original.has_rotation_quaternion;
            copy.local_matrix = original.local_matrix;
            copy.local_matrix_locked = original.local_matrix_locked;
            copies.emplace(from.value, made);
            return made;
        };
        const auto copied = [&](const TransformNodeHandle& from) {
            const auto found = copies.find(from.value);
            if (found == copies.end())
                throw std::runtime_error("Imported node hierarchy left its asset.");
            return found->second;
        };
        clone.root_node = copy_node(source_root_node);
        clone.nodes.resize(source_nodes.size());
        for (std::size_t index = 0; index < source_nodes.size(); ++index) {
            if (source_nodes[index].value != invalid_handle)
                clone.nodes[index] = copy_node(source_nodes[index]);
        }
        std::vector<TransformNodeHandle> originals{source_root_node};
        for (const TransformNodeHandle& node : source_nodes) {
            if (node.value != invalid_handle) originals.push_back(node);
        }
        for (const TransformNodeHandle& from : originals) {
            const TransformNodeRecord original = ${recordAt("engine.transform_nodes", "from")};
            const TransformNodeHandle made = copied(from);
            if (original.parent.value != invalid_handle)
                set_transform_node_parent(engine, made, copied(original.parent));
            for (const TransformNodeChild& child : original.children) {
                if (const auto* mesh = std::get_if<MeshHandle>(&child))
                    push_transform_node_child(engine, made, cloned_handle(*mesh));
                else
                    push_transform_node_child(
                        engine, made, copied(std::get<TransformNodeHandle>(child)));
            }
        }
        for (const MeshHandle cloned_mesh : clone.meshes) {
            const TransformNodeHandle node =
                ${recordAt("engine.meshes", "cloned_mesh")}.transform_parent;
            if (node.value != invalid_handle)
                set_mesh_transform_parent(engine, cloned_mesh, copied(node));
        }
    }`;
}

/** The arms of the scene core a scene reaches, each gating an emitted unit. */
interface SceneCoreOptions {
    fog?: boolean;
    /** The scene reaches `setClipPlane`. */
    clipPlane?: boolean;
    /** The scene reaches `enableMirroredMeshes`. */
    mirroredMeshes?: boolean;
    parenting?: boolean;
    visibility?: boolean;
    geometryAccess?: boolean;
    animationManagers?: boolean;
    /** The scene baked a vertex animation texture (mesh:vat). */
    vat?: boolean;
    /** The scene reaches `createTransformNode`. */
    transformNodes?: boolean;
    /** A retained SceneNode union reaches a TRS read or write. */
    sceneNodeTransforms?: boolean;
    /** Retained text entities participate in scene disposal. */
    text?: boolean;
    /** Node materials capture texture slots in deferred scene groups. */
    nodeMaterials?: boolean;
    pbrSceneHooks?: boolean;
}

export class SceneLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerCore(options: SceneCoreOptions = {}): LoweredSource {
        const modulePath = "src/scene/scene-core.ts";
        const createName = "createSceneContext";
        const addName = "addToScene";
        const beforeName = "onBeforeRender";
        const disposeName = "onSceneDispose";
        const registerName = "registerScene";
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            createName,
        );
        const scene = this.context.objectInitializer(declaration, "ctxLocal");
        const callbackDelta = new PinnedNumericLowerer(file, {
            bindings: new Map([
                [
                    "ctx.fixedDeltaMs",
                    { cpp: "scene.fixed_delta_ms", type: "scalar" },
                ],
                [
                    "eng._currentDelta",
                    { cpp: "engine_delta_ms", type: "scalar" },
                ],
            ]),
            calls: new Map(),
        }).expression(this.context.variableInitializer(declaration, "d"));
        this.context.assertExpressionShape(
            this.context.propertyInitializer(scene, "fog"),
            "null",
            "Pinned initial fog identity",
        );
        if (
            scene.properties.some(
                (property) =>
                    property.name &&
                    this.context.propertyName(property.name) === "_envTextures",
            )
        ) {
            this.context.contractError(
                scene,
                "Expected a new scene to have no environment texture object.",
            );
        }
        const clearExpression = this.context.propertyInitializer(
            scene,
            "clearColor",
        );
        if (!ts.isObjectLiteralExpression(clearExpression)) {
            throw new Error(
                "Upstream scene clearColor is not an object literal.",
            );
        }
        const clear = (name: string): number =>
            this.context.numericValue(
                this.context.propertyInitializer(clearExpression, name),
                file,
            );
        const { declaration: addToScene } = this.context.functionDeclaration(
            modulePath,
            addName,
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(addToScene, "kids"),
            "(entity as unknown as SceneNode).children",
            "Pinned addToScene child traversal",
        );
        const addChildrenLoops = this.context.findNodes(
            addToScene,
            (node): node is ts.ForOfStatement =>
                ts.isForOfStatement(node) &&
                this.context.propertyPath(node.expression)?.join(".") ===
                    "kids",
        );
        if (addChildrenLoops.length !== 1) {
            this.context.contractError(
                addToScene,
                "Expected addToScene to walk its ordered children exactly once.",
            );
        }
        const addChildrenLoop = addChildrenLoops[0]!;
        const childParentWrites = this.context.findNodes(
            addChildrenLoop.statement,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                this.context.propertyPath(node.left)?.join(".") ===
                    "child.parent" &&
                this.context.propertyPath(node.right)?.join(".") === "entity",
        );
        const childRecursiveAdds = this.context.findNodes(
            addChildrenLoop.statement,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === addName &&
                node.arguments.length === 2 &&
                this.context.propertyPath(node.arguments[0]!)?.join(".") ===
                    "scene" &&
                this.context.propertyPath(node.arguments[1]!)?.join(".") ===
                    "child",
        );
        if (
            childParentWrites.length !== 1 ||
            childRecursiveAdds.length !== 1 ||
            childParentWrites[0]!.end >= childRecursiveAdds[0]!.pos
        ) {
            this.context.contractError(
                addChildrenLoop,
                "Expected addToScene to set each child parent before recursing.",
            );
        }
        const { declaration: createSceneNodeCore } =
            this.context.functionDeclaration(
                "src/scene/scene-node.ts",
                "initSceneNodeTransform",
            );
        const parentSetters = this.context.findNodes(
            createSceneNodeCore,
            (node): node is ts.SetAccessorDeclaration =>
                ts.isSetAccessorDeclaration(node) &&
                this.context.propertyName(node.name) === "parent",
        );
        const parentSetter = parentSetters[0];
        if (
            parentSetters.length !== 1 ||
            !parentSetter?.body ||
            parentSetter.body.statements.length !== 1 ||
            !ts.isExpressionStatement(parentSetter.body.statements[0]!)
        ) {
            this.context.contractError(
                createSceneNodeCore,
                "Expected SceneNode.parent to be one direct world-state write.",
            );
        }
        this.context.assertExpressionShape(
            parentSetter.body.statements[0].expression,
            "wm.parent = v",
            "Pinned direct SceneNode parent write",
        );
        if (
            this.context.hasNode(
                parentSetter.body,
                (node) =>
                    ts.isPropertyAccessExpression(node) &&
                    node.name.text === "children",
            )
        ) {
            this.context.contractError(
                parentSetter,
                "A direct SceneNode.parent write must not mutate children.",
            );
        }
        const transformNodeModulePath = "src/scene/transform-node.ts";
        const { declaration: cloneTransformNode } =
            this.context.functionDeclaration(
                transformNodeModulePath,
                "cloneTransformNode",
            );
        if (
            !this.context.hasNode(
                cloneTransformNode,
                (node) =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
                    ts.isStringLiteral(node.left) &&
                    node.left.text === "_gpu" &&
                    ts.isIdentifier(node.right) &&
                    node.right.text === "src",
            ) ||
            !this.context.hasNode(
                cloneTransformNode,
                (node) =>
                    ts.isForOfStatement(node) &&
                    this.context.propertyPath(node.expression)?.join(".") ===
                        "src.children",
            ) ||
            !this.context.hasCall(cloneTransformNode, "cloneTransformNode")
        ) {
            this.context.contractError(
                cloneTransformNode,
                "Expected cloneTransformNode to route meshes and recursively clone children.",
            );
        }
        const cloneChildPushes = this.context.findNodes(
            cloneTransformNode,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                this.context.propertyPath(node.expression)?.join(".") ===
                    "clone.children.push",
        );
        if (cloneChildPushes.length !== 1) {
            this.context.contractError(
                cloneTransformNode,
                "Expected cloneTransformNode to append each cloned child to the traversal list.",
            );
        }
        const { declaration: cloneMeshNode } = this.context.functionDeclaration(
            transformNodeModulePath,
            "cloneMeshNode",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(cloneMeshNode, "meshClone"),
            `initMeshTransform({...mesh, name: mesh.name + "_clone", children: [], _gpu: mesh._gpu, _localMatrix: undefined, _localMatrixLocked: undefined},
        mesh.position.x, mesh.position.y, mesh.position.z, 0, 0, 0,
        mesh.scaling.x, mesh.scaling.y, mesh.scaling.z)`,
            "Mesh cloning starts a fresh transform state over shared geometry",
        );
        if (
            !this.context.hasNode(
                cloneMeshNode,
                (node) =>
                    ts.isPropertyAssignment(node) &&
                    this.context.propertyName(node.name) === "_gpu" &&
                    this.context.propertyPath(node.initializer)?.join(".") ===
                        "mesh._gpu",
            ) ||
            !this.context.hasCall(cloneMeshNode, "retain")
        ) {
            this.context.contractError(
                cloneMeshNode,
                "Expected mesh clones to retain and share their GPU-backed resources.",
            );
        }
        // The pinned clone naming: `mesh.name + "_clone"`. The suffix
        // flows into the emitted record copy so a scene searching by name
        // never matches a clone under the source's own name.
        const cloneSuffixes = this.context
            .findNodes(
                cloneMeshNode,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
                    this.context.propertyPath(node.left)?.join(".") ===
                        "mesh.name" &&
                    ts.isStringLiteral(
                        this.context.unwrapExpression(node.right),
                    ),
            )
            .map(
                (concat) =>
                    (
                        this.context.unwrapExpression(
                            concat.right,
                        ) as ts.StringLiteral
                    ).text,
            );
        if (cloneSuffixes.length !== 1) {
            this.context.contractError(
                cloneMeshNode,
                "Expected one pinned clone-name suffix.",
            );
        }
        const cloneSuffix = cloneSuffixes[0]!;
        // A scene that writes SceneNode transforms loads glTF assets with
        // their node hierarchy, which the root edit, setParent and cloning
        // then address.
        const nodeHierarchy =
            options.sceneNodeTransforms === true &&
            options.transformNodes === true;
        for (const property of ["entities", "_gpu", "material", "lightType"]) {
            if (
                !this.context.hasNode(
                    addToScene,
                    (node) =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
                        ts.isStringLiteral(node.left) &&
                        node.left.text === property &&
                        ts.isIdentifier(node.right) &&
                        node.right.text === "entity",
                )
            ) {
                this.context.contractError(
                    addToScene,
                    `Expected '${property}' entity routing.`,
                );
            }
        }
        const { declaration: onBeforeRender } =
            this.context.functionDeclaration(modulePath, beforeName);
        if (
            !this.context.hasNode(
                onBeforeRender,
                (node) =>
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.name.text === "unshift" &&
                    ts.isPropertyAccessExpression(node.expression.expression) &&
                    node.expression.expression.name.text === "_beforeRender" &&
                    node.arguments.length === 1 &&
                    ts.isIdentifier(node.arguments[0]!) &&
                    node.arguments[0].text === "cb",
            )
        ) {
            this.context.contractError(
                onBeforeRender,
                "Expected before-render callbacks to be prepended.",
            );
        }
        const { declaration: onSceneDispose } =
            this.context.functionDeclaration(modulePath, disposeName);
        if (
            !this.context.hasNode(
                onSceneDispose,
                (node) =>
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.name.text === "push" &&
                    ts.isPropertyAccessExpression(node.expression.expression) &&
                    node.expression.expression.name.text === "_disposables" &&
                    node.arguments.length === 1 &&
                    ts.isIdentifier(node.arguments[0]!) &&
                    node.arguments[0].text === "cb",
            )
        ) {
            this.context.contractError(
                onSceneDispose,
                "Expected scene-disposal callbacks to be appended.",
            );
        }
        const { declaration: registerScene } = this.context.functionDeclaration(
            modulePath,
            registerName,
        );
        if (
            !this.context.hasCall(registerScene, "isRenderingContextRegistered")
        ) {
            this.context.contractError(
                registerScene,
                "Expected idempotent rendering-context registration.",
            );
        }
        const registrationGuard = registerScene.body!.statements.find(
            ts.isIfStatement,
        );
        if (
            !registrationGuard ||
            !this.context.expressionMatchesShape(
                registrationGuard.expression,
                "isRenderingContextRegistered(surface, ctx)",
            )
        ) {
            this.context.contractError(
                registerScene,
                "Expected the scene identity guard before deferred construction.",
            );
        }
        const buildCall = this.context.findNodes(
            registerScene,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                node.expression.getText() === "buildScene",
        )[0];
        if (!buildCall || registrationGuard.end >= buildCall.pos) {
            this.context.contractError(
                registerScene,
                "Scene registration must guard identity before building or publishing.",
            );
        }
        const buildScene = this.context.functionDeclaration(
            modulePath,
            "buildScene",
        ).declaration;
        const drain = this.context.findNodes(
            buildScene,
            (node): node is ts.WhileStatement => ts.isWhileStatement(node),
        )[0];
        if (!drain || !ts.isBlock(drain.statement)) {
            this.context.contractError(
                buildScene,
                "Expected the repeated deferred scene drain.",
            );
        }
        this.context.assertExpressionShape(
            drain.expression,
            "ctx._deferredBuilders.length",
            "Deferred drain condition",
        );
        this.context.assertStatementInventory(
            drain,
            drain.statement.statements,
            "buildScene",
            "snapshot deferred drain",
            ["variable statement", "expression statement"],
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(drain, "builders"),
            "ctx._deferredBuilders.splice(0)",
            "Deferred drain snapshot",
        );
        this.context.expectShapeCount(
            drain,
            "Promise.all(builders.map((b) => b()))",
            "Ordered deferred builder invocation",
        );
        if (options.fog) {
            const { declaration: setFog } = this.context.functionDeclaration(
                fogModulePath,
                fogName,
            );
            if (
                !this.context.hasNode(
                    setFog,
                    (node) =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                        this.context.propertyPath(node.left)?.join(".") ===
                            "scene.fog" &&
                        ts.isIdentifier(node.right) &&
                        node.right.text === "config",
                )
            ) {
                this.context.contractError(
                    setFog,
                    "Expected setFog to store the fog config on the scene.",
                );
            }
            if (
                !this.context.hasCall(
                    setFog,
                    // 1.23 renamed this from `registerContributor`; the body
                    // is the same store-then-register pair.
                    "_registerSceneUboContributor",
                )
            ) {
                this.context.contractError(
                    setFog,
                    "Expected setFog to register the fog scene-uniform contributor.",
                );
            }
            // The fog UBO writer's field inventory, paired with the
            // emitted `set_scene_fog` stores: the generated Scene
            // carries exactly the fields the pinned writer consumes
            // (mode, start, end, density, color), so a pin that grows
            // the fog slice fails generation instead of rendering with a
            // silently missing term. The writer's float offsets (80-86
            // in the browser scene UBO) are deliberately NOT asserted:
            // nothing in the generated tree uses them — fog reaches the
            // native shaders through the pinned scene block the PALs
            // fill, and the WGSL component reads are the pin's own
            // WGSL_FOG inside every composed module, so they track the
            // pin without a copy here.
            const { declaration: writeFogUbo } =
                this.context.functionDeclaration(fogModulePath, "writeFogUbo");
            const fogReads = new Set<string>();
            for (const access of this.context.findNodes(
                writeFogUbo,
                (node): node is ts.PropertyAccessExpression =>
                    ts.isPropertyAccessExpression(node),
            )) {
                const path = this.context.propertyPath(access);
                if (path && path.length === 2 && path[0] === "fog") {
                    fogReads.add(path[1]!);
                }
            }
            const expectedFogFields = [
                "mode",
                "start",
                "end",
                "density",
                "color",
            ];
            if (
                fogReads.size !== expectedFogFields.length ||
                expectedFogFields.some((name) => !fogReads.has(name))
            ) {
                this.context.contractError(
                    writeFogUbo,
                    `Expected the fog UBO writer to consume exactly ` +
                        `{${expectedFogFields.join(", ")}}, found ` +
                        `{${[...fogReads].sort().join(", ")}}.`,
                );
            }
        }
        if (options.clipPlane) {
            // `setClipPlane`, the fog setter's sibling in the same module: store
            // the plane, then register the contributor that writes it. The store
            // is what the emitted record mirrors, and the registration is what
            // makes the lane reach the scene UBO at all.
            const { declaration: setClipPlane } =
                this.context.functionDeclaration(
                    clipPlaneModulePath,
                    clipPlaneName,
                );
            if (
                !this.context.hasNode(
                    setClipPlane,
                    (node) =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                        this.context.propertyPath(node.left)?.join(".") ===
                            "scene.clipPlane" &&
                        ts.isIdentifier(node.right) &&
                        node.right.text === "plane",
                )
            ) {
                this.context.contractError(
                    setClipPlane,
                    "Expected setClipPlane to store the plane on the scene.",
                );
            }
            if (
                !this.context.hasCall(
                    setClipPlane,
                    "_registerSceneUboContributor",
                )
            ) {
                this.context.contractError(
                    setClipPlane,
                    "Expected setClipPlane to register the clip-plane scene-uniform " +
                        "contributor.",
                );
            }
            // The writer's own lanes, asserted as the ORDER they are written in
            // rather than by their float offsets: the native block is the pin's
            // `SceneUniforms` mirrored from its WGSL declaration, so the offsets
            // are already the pin's and what this has to hold is that the four
            // components go in as `[0], [1], [2], [3]`. A pin that reordered or
            // grew them refuses here instead of clipping against a permuted
            // plane.
            const { declaration: writeClipPlaneUbo } =
                this.context.functionDeclaration(
                    clipPlaneModulePath,
                    "writeClipPlaneUbo",
                );
            const clipPlaneComponents: number[] = [];
            for (const access of this.context.findNodes(
                writeClipPlaneUbo,
                (node): node is ts.ElementAccessExpression =>
                    ts.isElementAccessExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "clipPlane",
            )) {
                const index = access.argumentExpression;
                if (ts.isNumericLiteral(index)) {
                    clipPlaneComponents.push(Number(index.text));
                }
            }
            if (
                clipPlaneComponents.length !== 4 ||
                clipPlaneComponents.some((component, at) => component !== at)
            ) {
                this.context.contractError(
                    writeClipPlaneUbo,
                    "Expected the clip-plane UBO writer to consume the plane's four " +
                        `components in order, found [${clipPlaneComponents.join(", ")}].`,
                );
            }
        }
        const value = (input: number): string =>
            this.context.floatLiteral(input);
        const meshDirtySource = this.meshDirtySource();
        const visibilitySource = this.visibilitySource(options);
        // src/scene/transform-node.ts createTransformNode and the
        // ObservableVec3/ObservableQuat setters a scene writes on the node
        // it made. Each setter is the field write plus the version bump a
        // child's world recomposes against, which is what `markLocalDirty` does
        // upstream; the world itself is composed lazily in the render plan,
        // as `createWorldMatrixState` composes it there.
        const transformNodeSource = this.transformNodeSource(options);
        // src/mesh/enable-mirrored-meshes.ts is one statement: it awaits
        // the support module and installs it on the scene. The
        // pipeline-side half of that install is a compile-time question
        // here -- a scene that never opts in composes no winding
        // resolution at all -- so what remains at run time is the flag the
        // per-frame watcher reads.
        const mirroredSource = this.mirroredSource(options);
        const parentMatrixHelpers = options.parenting
            ? [
                  "using upstream::mat4_multiply_into;",
                  lowerMat4InvertCpp(this.context),
                  lowerMat4DecomposeFull(this.context),
              ].join("\n\n")
            : "";
        const parentingSource = this.parentingSource(
            options,
            parentMatrixHelpers,
        );
        const geometryAccessSource = this.geometryAccessSource(options);
        const fogSource = this.fogSource(options);
        const clipPlaneSource = this.clipPlaneSource(options);
        // The emitted removal is the pinned mesh arm — removeFromScene
        // dispatches a mesh to removeMeshFromScene, whose scene-list
        // splice plus mutation mark is what the native erase and
        // membership bump mirror. Anchored on the splice pair itself
        // rather than only on the dispatcher's existence, so a
        // restructured mesh arm refuses generation instead of leaving the
        // native erase mirroring a branch the pin no longer has.
        this.context.functionDeclaration(
            "src/scene/scene-remove.ts",
            "removeFromScene",
        );
        const { declaration: meshRemoval } = this.context.functionDeclaration(
            "src/scene/scene-remove.ts",
            "removeMeshFromScene",
        );
        const meshSplices = this.context.findNodes(
            meshRemoval,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                this.context.propertyPath(node.expression)?.join(".") ===
                    "scene.meshes.splice",
        );
        if (meshSplices.length !== 1) {
            this.context.contractError(
                meshRemoval,
                "Pinned removeMeshFromScene no longer splices " +
                    "scene.meshes exactly once.",
            );
        }
        this.context.assertExpressionShape(
            this.context.variableInitializer(meshRemoval, "mi2"),
            "scene.meshes.indexOf(mesh)",
            "Pinned mesh-removal index",
        );
        // A manager created with this engine owns animation time for the
        // groups attached to it, and a scene it drives has no other way to
        // reach them: the measured seek walks the scene's seekers, so a
        // registering scene contributes one per manager. Not a pinned
        // step -- upstream seeks by calling goToFrame on the groups
        // themselves, which is what this reproduces.
        // A baked mesh has no animation group left to seek -- attachVat drops
        // the live skeleton and stops every clip -- so its deterministic pose
        // comes from the settings block instead. Registered here for the same
        // reason the manager seeker is: the seek walks the scene's seekers,
        // and register_scene is the first point that runs after every bake.
        const vatSeek = this.vatSeek(options);
        const managerSeek = this.managerSeek(options);
        return {
            modulePath,
            symbolName: `${createName},${addName},cloneTransformNode,removeFromScene,${beforeName},${disposeName},${registerName}${options.fog ? `,${fogName}` : ""}${options.clipPlane ? `,${clipPlaneName}` : ""}`,
            header: "",
            source: `// ${this.context.provenance(modulePath, `${createName}, ${addName}, ${beforeName}, ${disposeName}, ${registerName}`, `${transformNodeModulePath}#cloneTransformNode, cloneMeshNode`)}
#include <bblite/runtime.hpp>
${options.text ? "#include <bblite/upstream_text_records.hpp>" : ""}
#include <bblite/upstream/pinned_matrix.hpp>
#include <bblite/upstream/pinned_world_transform.hpp>
#include <bblite/js_data.hpp>
${options.nodeMaterials ? "#include <bblite/node_material.hpp>" : ""}
${
    options.mirroredMeshes || options.geometryAccess || options.parenting
        ? `// The mirrored-mesh watcher this scene installs calls the render
// plan's own determinant pass; a scene that never opts in includes
// neither. Geometry access and setParent also read the plan's emitted
// world matrix.
#include <bblite/upstream/renderer_plan.hpp>`
        : ""
}
#include <algorithm>
#include <array>
#include <cmath>
#include <exception>
#include <optional>
#include <stdexcept>
#include <utility>

namespace bbl {
namespace {

void require_scene_engine(const Scene& scene) {
    if (!scene.engine) throw std::runtime_error("Scene is not associated with an engine.");
}

std::uint32_t material_family_bit(
    const Engine& engine,
    MeshHandle mesh) {
    if (mesh.value >= engine.meshes.size()) return 0;
    const MaterialHandle material = ${recordAt("engine.meshes", "mesh")}.material;
    if (material.value >= engine.materials.size()) return 0;
    const MaterialRecord& record = ${recordAt("engine.materials", "material")};
    return bbl::material_family_bit(record);
}

std::uint32_t scene_material_families(const Scene& scene) {
    std::uint32_t result = 0;
    if (scene.state->source_material_publication) {
        for (const auto& output : scene.state->material_outputs) result |= bbl::material_family_bit(${recordAt("scene.engine->materials", "output->material")});
        return result;
    }
    for (const MeshHandle mesh : scene.meshes) {
        result |= material_family_bit(*scene.engine, mesh);
    }
    return result;
}

} // namespace

${lowerMeshMaterialSetter(this.context)}
${this.sceneCreationSource(callbackDelta, value, clear, options)}${options.pbrSceneHooks ? lowerPbrMaterialGroups(this.context) : ""}${this.meshMembershipSource(options)}${this.assetCloneSource(cloneSuffix, nodeHierarchy)}${this.assetRootSource(nodeHierarchy)}${this.assetMembershipSource(options)}${this.eventRegistrationSource()}${this.sceneLifecycleSource(managerSeek, vatSeek, options)}void enable_scene_transmission(Scene& scene) {
    require_scene_engine(scene);
    scene.transmission_enabled = true;
}
${fogSource}${clipPlaneSource}${meshDirtySource}${visibilitySource}${transformNodeSource}${mirroredSource}${parentingSource}${geometryAccessSource}
${options.sceneNodeTransforms ? sceneNodeTransformsSource(options.transformNodes === true) : ""}
} // namespace bbl
`,
        };
    }

    private meshDirtySource(): string {
        return `
void mark_mesh_dirty(Engine& engine, MeshHandle mesh) {
    if (mesh.value >= engine.meshes.size()) return;
    MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
    ++record.transform_version;
    for (const MeshHandle child : record.parented_meshes) {
        mark_mesh_dirty(engine, child);
    }
}

// The same one level up. A node reaches the record arena through a factory
// or through a physics body's pose write, so the marker is unconditional.
void mark_transform_node_dirty(
    Engine& engine,
    TransformNodeHandle node) {
    if (node.value >= engine.transform_nodes.size()) return;
    TransformNodeRecord& record = ${recordAt("engine.transform_nodes", "node")};
    ++record.transform_version;
    for (const MeshHandle child : record.parented_meshes) {
        mark_mesh_dirty(engine, child);
    }
    for (const TransformNodeHandle& child : record.parented_nodes) {
        mark_transform_node_dirty(engine, child);
    }
}
`;
    }

    private visibilitySource(options: SceneCoreOptions): string {
        return options.visibility
            ? `
// ${this.context.provenance("src/scene/visibility.ts", "setSubtreeVisible")}
namespace {
// The cascade half: writes the subtree, reports whether any flag moved.
bool set_mesh_visible_cascade(
    Engine& engine,
    MeshHandle mesh,
    bool visible) {
    MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
    bool changed = record.visible != visible;
    record.visible = visible;
    for (const MeshHandle child : record.children) {
        // The pin writes a disposed child too; once a later mesh holds its
        // slot nothing can observe that write.
        if (!current_mesh_record(engine, child)) continue;
        if (set_mesh_visible_cascade(engine, child, visible)) {
            changed = true;
        }
    }
    return changed;
}
} // namespace

void set_mesh_visible(
    Engine& engine,
    MeshHandle mesh,
    bool visible) {
    if (set_mesh_visible_cascade(engine, mesh, visible)) {
        // The pin's visibility epoch feeds the shared native draw-list
        // membership epoch. A bare \`visible\` field write deliberately does
        // not bump it, and a same-value call stays a true no-op.
        ++engine.draw_list_epoch;
    }
}
`
            : "";
    }

    private transformNodeSource(options: SceneCoreOptions): string {
        return options.transformNodes
            ? `
// ${this.context.provenance("src/scene/transform-node.ts", "createTransformNode")}
TransformNodeHandle create_transform_node(
    Engine& engine,
    std::string name,
    Vec3d position,
    Vec4 rotation_quaternion,
    Vec3 scaling) {
    TransformNodeRecord node;
    node.name = std::move(name);
    node.position = position;
    node.rotation_quaternion = rotation_quaternion;
    // The pin stores the quaternion unconditionally; the record's Euler
    // lane exists only so one composition serves nodes and meshes alike,
    // and a node never writes it.
    node.has_rotation_quaternion = true;
    node.scaling = scaling;
    // A node lives as long as a handle to it (\`TransformNodeLease\`); the
    // records of those whose last handle went take the next nodes.
    reclaim_transform_nodes(engine);
    std::uint32_t slot = 0;
    if (!engine.free_transform_node_slots.empty()) {
        slot = engine.free_transform_node_slots.back();
        engine.free_transform_node_slots.pop_back();
        node.generation = engine.transform_nodes[slot].generation + 1;
        engine.transform_nodes[slot] = std::move(node);
    } else {
        slot = static_cast<std::uint32_t>(engine.transform_nodes.size());
        engine.transform_nodes.push_back(std::move(node));
    }
    const std::uint32_t generation = engine.transform_nodes[slot].generation;
    return TransformNodeHandle{
        slot, generation, js::make_gc_shared<TransformNodeLease>(engine, slot, generation)};
}

namespace {
// scene-node.ts onWmDirty, which every TRS lane write runs: the write hands
// a raw local matrix back to the TRS lanes -- unless the node is locked, as
// a loaded glTF \`matrix\` node is until setParent releases it, when the
// write changes nothing the node composes.
void transform_node_trs_written(
    Engine& engine,
    TransformNodeHandle node) {
    TransformNodeRecord& record = ${recordAt("engine.transform_nodes", "node")};
    if (record.local_matrix_locked) return;
    record.local_matrix.reset();
    mark_transform_node_dirty(engine, node);
}
} // namespace

void set_transform_node_position(
    Engine& engine,
    TransformNodeHandle node,
    Vec3d position) {
    ${recordAt("engine.transform_nodes", "node")}.position = position;
    transform_node_trs_written(engine, node);
}

void set_transform_node_scaling(
    Engine& engine,
    TransformNodeHandle node,
    Vec3 scaling) {
    ${recordAt("engine.transform_nodes", "node")}.scaling = scaling;
    transform_node_trs_written(engine, node);
}

void set_transform_node_rotation(
    Engine& engine,
    TransformNodeHandle node,
    Vec3 rotation) {
    TransformNodeRecord& record = ${recordAt("engine.transform_nodes", "node")};
    record.rotation = rotation;
    // The pinned Euler proxy writes its quaternion source of truth. The
    // record expresses that same selection by composing the Euler lane when
    // this flag is false; pinnedTrsComposition performs eulerXYZToQuatTuple from the
    // upstream function before the matrix write.
    record.has_rotation_quaternion = false;
    transform_node_trs_written(engine, node);
}

void set_transform_node_rotation_quaternion(
    Engine& engine,
    TransformNodeHandle node,
    Vec4 rotation) {
    TransformNodeRecord& record = ${recordAt("engine.transform_nodes", "node")};
    record.rotation_quaternion = rotation;
    record.has_rotation_quaternion = true;
    transform_node_trs_written(engine, node);
}

// The parent SETTER is the pin's own _addChild trigger: it registers the
// child for invalidation, where the children array is only the traversal
// list. Registering here rather than at that array's push is what makes a
// scene which writes the link and never pushes still follow its parent.
void set_mesh_transform_parent(
    Engine& engine,
    MeshHandle mesh,
    TransformNodeHandle parent) {
    if (mesh.value >= engine.meshes.size()) {
        throw std::runtime_error("Invalid mesh child handle.");
    }
    if (parent.value >= engine.transform_nodes.size()) {
        throw std::runtime_error("Invalid transform-node parent handle.");
    }
    MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
    if (
        record.transform_parent.value == parent.value &&
        record.parent.value >= engine.meshes.size()) {
        return;
    }
    unregister_from_parents(engine, record, mesh);
    record.parent = MeshHandle{};
    record.transform_parent = parent;
    mark_mesh_dirty(engine, mesh);
    if (parent.value < engine.transform_nodes.size()) {
        std::vector<MeshHandle>& new_children =
            ${recordAt("engine.transform_nodes", "parent")}.parented_meshes;
        if (std::find(new_children.begin(), new_children.end(), mesh) ==
            new_children.end()) {
            new_children.push_back(mesh);
        }
    }
}

// The same trigger one level up. mark_transform_node_dirty already
// recurses into parented_nodes, and transform_node_world already
// composes record.parent; this is the write that links the two, so a
// node hung under another follows it exactly as a mesh does.
namespace {
void require_acyclic_transform_node_parent(
    const Engine& engine,
    TransformNodeHandle node,
    TransformNodeHandle parent) {
    if (node.value >= engine.transform_nodes.size()) {
        throw std::runtime_error("Invalid transform-node child handle.");
    }
    if (parent.value >= engine.transform_nodes.size()) {
        throw std::runtime_error("Invalid transform-node parent handle.");
    }
    TransformNodeHandle cursor = parent;
    std::size_t depth = 0;
    while (cursor.value < engine.transform_nodes.size()) {
        if (
            cursor.value == node.value ||
            depth++ >= engine.transform_nodes.size()) {
            throw std::runtime_error(
                "Transform-node parent cycle detected.");
        }
        cursor = ${recordAt("engine.transform_nodes", "cursor")}.parent;
    }
    if (cursor.value != invalid_handle) {
        throw std::runtime_error(
            "Invalid transform-node handle in parent chain.");
    }
}
} // namespace

void set_transform_node_parent(
    Engine& engine,
    TransformNodeHandle node,
    TransformNodeHandle parent) {
    require_acyclic_transform_node_parent(engine, node, parent);
    TransformNodeRecord& record = ${recordAt("engine.transform_nodes", "node")};
    if (record.parent.value == parent.value) return;
    if (record.parent.value < engine.transform_nodes.size()) {
        std::vector<TransformNodeHandle>& old_children =
            ${recordAt("engine.transform_nodes", "record.parent")}.parented_nodes;
        old_children.erase(
            std::remove(old_children.begin(), old_children.end(), node),
            old_children.end());
    }
    record.parent = parent;
    mark_transform_node_dirty(engine, node);
    if (parent.value < engine.transform_nodes.size()) {
        std::vector<TransformNodeHandle>& new_children =
            ${recordAt("engine.transform_nodes", "parent")}.parented_nodes;
        if (std::find(new_children.begin(), new_children.end(), node) ==
            new_children.end()) {
            new_children.push_back(node);
        }
    }
}

void push_transform_node_child(
    Engine& engine,
    TransformNodeHandle node,
    MeshHandle child) {
    if (node.value >= engine.transform_nodes.size()) {
        throw std::runtime_error("Invalid transform-node handle.");
    }
    if (child.value >= engine.meshes.size()) {
        throw std::runtime_error("Invalid mesh child handle.");
    }
    ${recordAt("engine.transform_nodes", "node")}.children.emplace_back(child);
}

void push_transform_node_child(
    Engine& engine,
    TransformNodeHandle node,
    TransformNodeHandle child) {
    if (node.value >= engine.transform_nodes.size()) {
        throw std::runtime_error("Invalid transform-node handle.");
    }
    if (child.value >= engine.transform_nodes.size()) {
        throw std::runtime_error("Invalid transform-node child handle.");
    }
    ${recordAt("engine.transform_nodes", "node")}.children.emplace_back(child);
}

namespace {
void validate_transform_node_traversal(
    const Engine& engine,
    TransformNodeHandle node,
    std::vector<bool>& active) {
    if (node.value >= engine.transform_nodes.size()) {
        throw std::runtime_error("Invalid transform-node handle.");
    }
    if (active[node.value]) {
        throw std::runtime_error(
            "Transform-node traversal cycle detected.");
    }
    active[node.value] = true;
    const TransformNodeRecord& record = ${recordAt("engine.transform_nodes", "node")};
    for (const TransformNodeChild& entry : record.children) {
        if (const auto* mesh = std::get_if<MeshHandle>(&entry)) {
            if (mesh->value >= engine.meshes.size()) {
                throw std::runtime_error(
                    "Invalid mesh handle in transform-node traversal.");
            }
            continue;
        }
        validate_transform_node_traversal(
            engine,
            std::get<TransformNodeHandle>(entry),
            active);
    }
    active[node.value] = false;
}

void add_transform_node_children(
    Scene& scene,
    TransformNodeHandle node) {
    Engine& engine = *scene.engine;
    const TransformNodeRecord& record = ${recordAt("engine.transform_nodes", "node")};
    for (const TransformNodeChild& entry : record.children) {
        if (const auto* mesh = std::get_if<MeshHandle>(&entry)) {
            set_mesh_transform_parent(engine, *mesh, node);
            add_to_scene(scene, *mesh);
            continue;
        }
        const TransformNodeHandle child =
            std::get<TransformNodeHandle>(entry);
        set_transform_node_parent(engine, child, node);
        add_transform_node_children(scene, child);
    }
}
} // namespace

// ${this.context.provenance("src/scene/scene-core.ts", "addToScene")}
void add_to_scene(Scene& scene, TransformNodeHandle node) {
    require_scene_engine(scene);
    std::vector<bool> active(scene.engine->transform_nodes.size(), false);
    validate_transform_node_traversal(*scene.engine, node, active);
    add_transform_node_children(scene, node);
}
`
            : "";
    }

    private mirroredSource(options: SceneCoreOptions): string {
        return options.mirroredMeshes
            ? `
// ${this.context.provenance("src/mesh/enable-mirrored-meshes.ts", "enableMirroredMeshes")}
void enable_mirrored_meshes(Scene& scene) {
    require_scene_engine(scene);
    scene.mirrored_meshes = true;
    // installMirroredMeshSupport seeds every mesh present now -- the signs
    // their renderables are about to be built with, since registerScene
    // follows this call -- and then APPENDS its watcher to the scene's own
    // before-render list, so it observes the transforms this frame's
    // callbacks produced. Both halves are the pin's, and pushing the
    // watcher here rather than calling it from a frame loop is what keeps
    // the frame position the pin's rather than a comment's.
    Engine& engine = *scene.engine;
    static_cast<void>(
        upstream::refresh_mirrored_meshes(scene, engine));
    std::weak_ptr<SceneState> watched_state = scene.state;
    scene.before_render.push_back([watched_state](float) {
        std::shared_ptr<SceneState> retained = watched_state.lock();
        if (!retained) return;
        Scene watched = Scene::from_state(std::move(retained));
        Engine& owner = *watched.engine;
        if (upstream::refresh_mirrored_meshes(watched, owner)) {
            // frontFace is baked into the pipeline object, so a flip goes
            // through a rebuild. The pin raises enqueueMaterialSwap for
            // it; here the render plan is where a pipeline is
            // chosen, and its membership version is what rebuilds it.
            ++watched.render_topology_version;
        }
    });
}
`
            : "";
    }

    /**
     * set-parent.ts setParent over a transform-node child, the node's world
     * preserved exactly: the child's local becomes inverse(parentWorld) *
     * childWorld through applyLocal, which writes the decomposed TRS, keeps
     * the exact affine local as the node's raw matrix and releases a
     * loaded glTF \`matrix\` node's lock. A transform node hangs only under
     * another transform node here, so the parent is one or none.
     */
    private transformNodeReparentSource(): string {
        return `
namespace {
// set-parent.ts applyLocal.
void apply_transform_node_local(
    Engine& engine,
    TransformNodeHandle node,
    const std::array<float, 16>& local,
    bool preserve_matrix) {
    const PinnedParentDecomposed decomposed = pinned_parent_mat4_decompose(local);
    TransformNodeRecord& record = ${recordAt("engine.transform_nodes", "node")};
    record.local_matrix.reset();
    record.local_matrix_locked = false;
    record.position = Vec3d{
        decomposed.translation.x, decomposed.translation.y, decomposed.translation.z};
    record.rotation_quaternion = Vec4{
        static_cast<float>(decomposed.rotation.x),
        static_cast<float>(decomposed.rotation.y),
        static_cast<float>(decomposed.rotation.z),
        static_cast<float>(decomposed.rotation.w)};
    record.has_rotation_quaternion = true;
    record.scaling = Vec3{
        static_cast<float>(decomposed.scale.x),
        static_cast<float>(decomposed.scale.y),
        static_cast<float>(decomposed.scale.z)};
    if (preserve_matrix) record.local_matrix = local;
    mark_transform_node_dirty(engine, node);
}

bool is_transform_node_child(
    const TransformNodeChild& candidate,
    const TransformNodeHandle& child) {
    const auto* node = std::get_if<TransformNodeHandle>(&candidate);
    return node && *node == child;
}
} // namespace

// ${this.context.provenance("src/scene/set-parent.ts", "setParent")}
void reparent_transform_node(
    Engine& engine,
    TransformNodeHandle child,
    TransformNodeHandle parent) {
    // 1. The child's world, before either parent link moves.
    const std::array<float, 16> child_world =
        upstream::transform_node_world(engine, child);
    // 2. The link, and the traversal lists kept in step with it.
    const TransformNodeHandle old_parent =
        ${recordAt("engine.transform_nodes", "child")}.parent;
    if (!(old_parent == parent)) {
        if (old_parent.value < engine.transform_nodes.size()) {
            auto& old_children = ${recordAt("engine.transform_nodes", "old_parent")}.children;
            const auto found = std::find_if(
                old_children.begin(), old_children.end(),
                [&child](const TransformNodeChild& candidate) {
                    return is_transform_node_child(candidate, child);
                });
            if (found != old_children.end()) old_children.erase(found);
        }
        if (parent.value < engine.transform_nodes.size()) {
            auto& new_children = ${recordAt("engine.transform_nodes", "parent")}.children;
            if (std::none_of(
                    new_children.begin(), new_children.end(),
                    [&child](const TransformNodeChild& candidate) {
                        return is_transform_node_child(candidate, child);
                    })) {
                new_children.emplace_back(child);
            }
        }
    }
    // 3. No parent: the local is the old world.
    if (parent.value >= engine.transform_nodes.size()) {
        TransformNodeRecord& record = ${recordAt("engine.transform_nodes", "child")};
        if (record.parent.value < engine.transform_nodes.size()) {
            auto& registered =
                ${recordAt("engine.transform_nodes", "record.parent")}.parented_nodes;
            registered.erase(
                std::remove(registered.begin(), registered.end(), child),
                registered.end());
        }
        record.parent = TransformNodeHandle{};
        apply_transform_node_local(engine, child, child_world, true);
        return;
    }
    set_transform_node_parent(engine, child, parent);
    // 4. inverse(parentWorld) * childWorld, or, under a singular parent,
    // the old world position over the TRS the node already had.
    const std::optional<std::array<float, 16>> inverse_parent =
        mat4_invert(upstream::transform_node_world(engine, parent));
    if (!inverse_parent) {
        const TransformNodeRecord& record = ${recordAt("engine.transform_nodes", "child")};
        if (record.local_matrix) {
            const std::array<float, 16> raw = *record.local_matrix;
            apply_transform_node_local(engine, child, raw, false);
        }
        set_transform_node_position(
            engine, child, Vec3d{child_world[12], child_world[13], child_world[14]});
        return;
    }
    // 5. The exact affine local.
    std::array<float, 16> local{};
    mat4_multiply_into(local, 0, *inverse_parent, 0, child_world, 0);
    apply_transform_node_local(engine, child, local, true);
}
`;
    }

    private parentingSource(
        options: SceneCoreOptions,
        parentMatrixHelpers: string,
    ): string {
        return options.parenting
            ? `
namespace {

${parentMatrixHelpers}

void apply_parent_local(
    MeshRecord& record,
    const PinnedParentDecomposed& local) {
    // An imported record's root edit and loaded parent world stand for the
    // hierarchy it leaves. Once setParent writes a decomposed local TRS,
    // they have served the same purpose as the pin's raw local matrix and
    // must be cleared before the observable TRS becomes authoritative.
    record.parent_world.reset();
    record.outer_position = Vec3d{};
    record.outer_rotation = Vec3d{};
    record.outer_scaling = {1, 1, 1};
    record.outer_has_rotation_quaternion = false;
    record.position = Vec3d{
        local.translation.x,
        local.translation.y,
        local.translation.z};
    record.rotation = Vec3{};
    record.rotation_quaternion = Vec4{
        static_cast<float>(local.rotation.x),
        static_cast<float>(local.rotation.y),
        static_cast<float>(local.rotation.z),
        static_cast<float>(local.rotation.w)};
    record.has_rotation_quaternion = true;
    record.scaling = Vec3{
        static_cast<float>(local.scale.x),
        static_cast<float>(local.scale.y),
        static_cast<float>(local.scale.z)};
}

bool is_mesh_child(
    MeshHandle candidate,
    MeshHandle child) {
    return candidate == child;
}

bool is_mesh_child(
    const TransformNodeChild& candidate,
    MeshHandle child) {
    const auto* mesh = std::get_if<MeshHandle>(&candidate);
    return mesh && *mesh == child;
}

template <typename Children>
void unlink_child_links(
    Children& children,
    std::vector<MeshHandle>& registered,
    MeshHandle child) {
    const auto traversal = std::find_if(
        children.begin(),
        children.end(),
        [child](const auto& candidate) {
            return is_mesh_child(candidate, child);
        });
    if (traversal != children.end()) {
        // setParent removes the first public traversal entry. Explicit
        // duplicate pushes remain observable, exactly as Array.splice does.
        children.erase(traversal);
    }
    registered.erase(
        std::remove(registered.begin(), registered.end(), child),
        registered.end());
}

template <typename Children>
void link_child_links(
    Children& children,
    std::vector<MeshHandle>& registered,
    MeshHandle child) {
    if (
        std::find_if(
            children.begin(),
            children.end(),
            [child](const auto& candidate) {
                return is_mesh_child(candidate, child);
            }) == children.end()) {
        children.push_back(child);
    }
    if (std::find(registered.begin(), registered.end(), child) == registered.end()) {
        registered.push_back(child);
    }
}

void unlink_parent(
    Engine& engine,
    MeshHandle child,
    const MeshRecord& child_record) {
    if (child_record.transform_parent.value < engine.transform_nodes.size()) {
        TransformNodeRecord& old_parent =
            ${recordAt("engine.transform_nodes", "child_record.transform_parent")};
        unlink_child_links(
            old_parent.children, old_parent.parented_meshes, child);
    }
    if (child_record.parent.value < engine.meshes.size()) {
        MeshRecord& old_parent = ${recordAt("engine.meshes", "child_record.parent")};
        unlink_child_links(
            old_parent.children, old_parent.parented_meshes, child);
        offer_retired_mesh_slot(engine, child_record.parent);
    }
}

void link_parent(
    Engine& engine,
    MeshHandle child,
    MeshHandle parent) {
    if (parent.value >= engine.meshes.size()) return;
    MeshRecord& new_parent = ${recordAt("engine.meshes", "parent")};
    require_live_mesh_parent(new_parent);
    link_child_links(
        new_parent.children, new_parent.parented_meshes, child);
}

void link_parent(
    Engine& engine,
    MeshHandle child,
    TransformNodeHandle parent) {
    if (parent.value >= engine.transform_nodes.size()) return;
    TransformNodeRecord& new_parent = ${recordAt("engine.transform_nodes", "parent")};
    link_child_links(
        new_parent.children, new_parent.parented_meshes, child);
}

void apply_preserved_parent_local(
    Engine& engine,
    MeshHandle child,
    const std::array<float, 16>& child_world,
    const std::optional<std::array<float, 16>>& parent_world) {
    MeshRecord& child_record = ${recordAt("engine.meshes", "child")};
    if (!parent_world) {
        apply_parent_local(
            child_record,
            pinned_parent_mat4_decompose(child_world));
        mark_mesh_dirty(engine, child);
        return;
    }

    const std::optional<std::array<float, 16>> inverse_parent =
        mat4_invert(*parent_world);
    if (!inverse_parent) {
        // The pin cannot preserve a full transform beneath a singular
        // parent. It keeps the new link, clears a raw matrix override, copies
        // the old world position, and retains the existing rotation/scale.
        child_record.outer_position = Vec3d{};
        child_record.outer_rotation = Vec3d{};
        child_record.outer_scaling = {1, 1, 1};
        child_record.outer_has_rotation_quaternion = false;
        child_record.parent_world.reset();
        child_record.position = Vec3d{
            child_world[12], child_world[13], child_world[14]};
        mark_mesh_dirty(engine, child);
        return;
    }

    std::array<float, 16> local{};
    mat4_multiply_into(local, 0, *inverse_parent, 0, child_world, 0);
    apply_parent_local(
        child_record,
        pinned_parent_mat4_decompose(local));
    mark_mesh_dirty(engine, child);
}

void require_acyclic_mesh_parent(
    const Engine& engine,
    MeshHandle child,
    MeshHandle parent) {
    MeshHandle cursor = parent;
    std::size_t depth = 0;
    while (cursor.value < engine.meshes.size()) {
        if (
            cursor.value == child.value ||
            depth++ >= engine.meshes.size()) {
            throw std::runtime_error("Mesh parent cycle detected.");
        }
        cursor = ${recordAt("engine.meshes", "cursor")}.parent;
    }
}

} // namespace

// The bare \`child.parent = mesh\` write, for the parent lane a MESH holds.
// Its transform-node twin is \`set_mesh_transform_parent\` beside the
// transform-node factories, under that feature's own gate; the pin has one
// nullable \`parent\` field and this port has two handle tables, so the two
// entry points are what one field becomes. Like that twin this registers
// the child for invalidation and leaves \`children\` alone -- upstream the
// traversal list is filled by its own push -- and unlike \`set_mesh_parent\`
// below it does not preserve the child's world, because the field write
// upstream runs none of setParent's decomposition.
void set_mesh_transform_parent(
    Engine& engine,
    MeshHandle mesh,
    MeshHandle parent) {
    if (mesh.value >= engine.meshes.size()) {
        throw std::runtime_error("Invalid mesh child handle.");
    }
    if (parent.value >= engine.meshes.size()) {
        throw std::runtime_error("Invalid mesh parent handle.");
    }
    require_acyclic_mesh_parent(engine, mesh, parent);
    require_live_mesh_parent(${recordAt("engine.meshes", "parent")});
    MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
    if (
        record.parent.value == parent.value &&
        record.transform_parent.value >= engine.transform_nodes.size()) {
        return;
    }
    unregister_from_parents(engine, record, mesh);
    record.transform_parent = TransformNodeHandle{};
    record.parent = parent;
    mark_mesh_dirty(engine, mesh);
    std::vector<MeshHandle>& new_children =
        ${recordAt("engine.meshes", "parent")}.parented_meshes;
    if (
        std::find(new_children.begin(), new_children.end(), mesh) ==
        new_children.end()) {
        new_children.push_back(mesh);
    }
}

// \`mesh.children.push(child)\`: the traversal half, the twin of
// \`push_transform_node_child\`. MeshRecord::children is the list the
// visibility cascade walks, and upstream a bare parent write never fills
// it, so a scene that wants both performs both.
void push_mesh_child(
    Engine& engine,
    MeshHandle mesh,
    MeshHandle child) {
    if (mesh.value >= engine.meshes.size()) {
        throw std::runtime_error("Invalid mesh handle.");
    }
    if (child.value >= engine.meshes.size()) {
        throw std::runtime_error("Invalid mesh child handle.");
    }
    ${recordAt("engine.meshes", "mesh")}.children.emplace_back(child);
}

// ${this.context.provenance("src/scene/set-parent.ts", "setParent")}
void set_mesh_parent(
    Engine& engine,
    MeshHandle child,
    MeshHandle parent) {
    MeshRecord& child_record = ${recordAt("engine.meshes", "child")};
    // setParent snapshots the old world before touching either parent link.
    // The local TRS written below therefore preserves the visible transform,
    // including a mirrored signed scale, across attach and detach.
    const std::array<float, 16> child_world =
        upstream::mesh_world_matrix(engine, child_record);
    const bool link_changed =
        child_record.parent != parent ||
        child_record.transform_parent.value < engine.transform_nodes.size();
    if (link_changed) {
        unlink_parent(engine, child, child_record);
        child_record.transform_parent = TransformNodeHandle{};
        child_record.parent = parent;
        link_parent(engine, child, parent);
    }

    if (parent.value >= engine.meshes.size()) {
        apply_preserved_parent_local(
            engine, child, child_world, std::nullopt);
        return;
    }

    const std::array<float, 16> parent_world =
        upstream::mesh_world_matrix(engine, ${recordAt("engine.meshes", "parent")});
    apply_preserved_parent_local(
        engine, child, child_world, parent_world);
}

void set_mesh_parent(
    Engine& engine,
    MeshHandle child,
    TransformNodeHandle parent) {
    MeshRecord& child_record = ${recordAt("engine.meshes", "child")};
    const std::array<float, 16> child_world =
        upstream::mesh_world_matrix(engine, child_record);
    const bool link_changed =
        child_record.transform_parent.value != parent.value ||
        child_record.parent.value < engine.meshes.size();
    if (link_changed) {
        unlink_parent(engine, child, child_record);
        child_record.parent = MeshHandle{};
        child_record.transform_parent = parent;
        link_parent(engine, child, parent);
    }

    const std::array<float, 16> parent_world =
        upstream::transform_node_world(engine, parent);
    apply_preserved_parent_local(
        engine, child, child_world, parent_world);
}
${options.transformNodes ? this.transformNodeReparentSource() : ""}
void set_asset_root_parent(
    Engine& engine,
    AssetHandle child,
    TransformNodeHandle parent) {
    if (child.value >= engine.assets.size()) {
        throw std::runtime_error("Invalid imported root handle.");
    }${
        options.transformNodes
            ? `
    AssetRecord& asset = ${recordAt("engine.assets", "child")};
    if (asset.root_node.value != invalid_handle) {
        // A node-carrying import: the synthetic root is the node setParent
        // moves, and the root edit reads its TRS back.
        reparent_transform_node(engine, asset.root_node, parent);
        const TransformNodeRecord& root =
            ${recordAt("engine.transform_nodes", "asset.root_node")};
        asset.root_position = root.position;
        asset.root_rotation_quaternion = Vec4d{
            root.rotation_quaternion.x, root.rotation_quaternion.y,
            root.rotation_quaternion.z, root.rotation_quaternion.w};
        asset.root_scaling = Vec3d{root.scaling.x, root.scaling.y, root.scaling.z};
        ++asset.root_quaternion_version;
        return;
    }`
            : ""
    }
    // The loader flattened the imported hierarchy nodes. Reparent every
    // rendered leaf as one operation; each leaf snapshots its own current
    // world, so their relative arrangement is preserved exactly.
    for (const MeshHandle mesh : ${recordAt("engine.assets", "child")}.meshes) {
        set_mesh_parent(engine, mesh, parent);
    }
}

namespace {

HierarchyInstancePoolRecord& hierarchy_instance_pool(
    Engine& engine,
    HierarchyInstancePoolHandle handle) {
    if (handle.value >= engine.hierarchy_instance_pools.size()) {
        throw std::runtime_error("Invalid hierarchy instance pool handle.");
    }
    return ${recordAt("engine.hierarchy_instance_pools", "handle")};
}

std::size_t hierarchy_instance_index(
    double value,
    std::size_t limit,
    const char* message) {
    if (
        !std::isfinite(value) || value < 0.0 ||
        std::floor(value) != value || value >= static_cast<double>(limit)) {
        throw std::runtime_error(message);
    }
    return static_cast<std::size_t>(value);
}

std::array<float, 16> hierarchy_instance_matrix(
    const std::vector<float>& matrix) {
    if (matrix.size() < 16) {
        throw std::runtime_error(
            "Hierarchy instance matrix requires sixteen values.");
    }
    std::array<float, 16> result{};
    std::copy_n(matrix.data(), 16, result.data());
    return result;
}

void write_hierarchy_instance_matrix(
    Engine& engine,
    HierarchyInstancePoolRecord& pool,
    std::size_t index,
    const std::array<float, 16>& root_matrix,
    bool mark_dirty) {
    for (const HierarchyInstancePoolBinding& binding : pool.bindings) {
        MeshRecord& mesh = ${recordAt("engine.meshes", "binding.mesh")};
        mat4_multiply_into(
            pool.scratch, 0, root_matrix, 0, binding.mesh_world, 0);
        mat4_multiply_into(
            mesh.instance_matrices.at(index), 0,
            binding.mesh_world_inverse, 0, pool.scratch, 0);
        if (mark_dirty) ++mesh.instance_version;
    }
}

} // namespace

// src/mesh/hierarchy-instance-pool.ts, preserving its fixed-capacity
// per-descendant pools and meshWorld^-1 * rootMatrix * meshWorld expansion.
HierarchyInstancePoolHandle create_hierarchy_instance_pool(
    Engine& engine,
    AssetHandle root_handle,
    double capacity_value) {
    if (
        !std::isfinite(capacity_value) || capacity_value < 0.0 ||
        std::floor(capacity_value) != capacity_value ||
        capacity_value > static_cast<double>(
            std::numeric_limits<std::uint32_t>::max())) {
        throw std::runtime_error(
            "createHierarchyInstancePool capacity must be a non-negative integer");
    }
    if (root_handle.value >= engine.assets.size()) {
        throw std::runtime_error("Invalid imported root handle.");
    }
    HierarchyInstancePoolRecord pool;
    pool.root = root_handle;
    pool.capacity = static_cast<std::uint32_t>(capacity_value);
    pool.meshes = ${recordAt("engine.assets", "root_handle")}.meshes;
    if (pool.meshes.empty()) {
        throw std::runtime_error(
            "createHierarchyInstancePool requires at least one mesh in the source hierarchy");
    }
    pool.bindings.reserve(pool.meshes.size());
    for (const MeshHandle handle : pool.meshes) {
        MeshRecord& mesh = ${recordAt("engine.meshes", "handle")};
        if (mesh.thin_instanced) {
            throw std::runtime_error(
                "createHierarchyInstancePool source mesh already has thin instances");
        }
        // The pin snapshots mesh.worldMatrix, including edits to the imported
        // root: the instance conjugation uses the same world as the draw.
        const std::array<float, 16> mesh_world =
            upstream::mesh_world_matrix(engine, mesh);
        const std::optional<std::array<float, 16>> inverse =
            mat4_invert(mesh_world);
        if (!inverse) {
            throw std::runtime_error(
                "createHierarchyInstancePool requires an invertible world matrix");
        }
        mesh.instance_matrices.resize(pool.capacity);
        mesh.thin_instanced = true;
        mesh.instance_count = 0;
        mesh.instance_source = nullptr;
        ++mesh.instance_version;
        pool.bindings.push_back(HierarchyInstancePoolBinding{
            handle, mesh_world, *inverse});
    }
    const HierarchyInstancePoolHandle handle{
        static_cast<std::uint32_t>(engine.hierarchy_instance_pools.size())};
    engine.hierarchy_instance_pools.push_back(std::move(pool));
    return handle;
}

void set_hierarchy_instance_count(
    Engine& engine,
    HierarchyInstancePoolHandle handle,
    double count_value) {
    HierarchyInstancePoolRecord& pool =
        hierarchy_instance_pool(engine, handle);
    if (
        !std::isfinite(count_value) || count_value < 0.0 ||
        std::floor(count_value) != count_value ||
        count_value > static_cast<double>(pool.capacity)) {
        throw std::runtime_error(
            "setHierarchyInstanceCount count must be an integer within pool capacity");
    }
    pool.count = static_cast<std::uint32_t>(count_value);
    for (const MeshHandle mesh_handle : pool.meshes) {
        MeshRecord& mesh = ${recordAt("engine.meshes", "mesh_handle")};
        mesh.instance_count = pool.count;
        ++mesh.instance_version;
    }
}

double add_hierarchy_instance(
    Engine& engine,
    HierarchyInstancePoolHandle handle,
    const std::vector<float>& matrix) {
    HierarchyInstancePoolRecord& pool =
        hierarchy_instance_pool(engine, handle);
    if (pool.count >= pool.capacity) {
        throw std::runtime_error("addHierarchyInstance exceeded pool capacity");
    }
    const std::size_t index = pool.count;
    write_hierarchy_instance_matrix(
        engine, pool, index, hierarchy_instance_matrix(matrix), false);
    set_hierarchy_instance_count(
        engine, handle, static_cast<double>(index + 1));
    return static_cast<double>(index);
}

void set_hierarchy_instance_matrix(
    Engine& engine,
    HierarchyInstancePoolHandle handle,
    double index_value,
    const std::vector<float>& matrix) {
    HierarchyInstancePoolRecord& pool =
        hierarchy_instance_pool(engine, handle);
    const std::size_t index = hierarchy_instance_index(
        index_value, pool.count,
        "setHierarchyInstanceMatrix index must reference an active hierarchy instance");
    write_hierarchy_instance_matrix(
        engine, pool, index, hierarchy_instance_matrix(matrix), true);
}

void remove_hierarchy_instance(
    Engine& engine,
    HierarchyInstancePoolHandle handle,
    double index_value) {
    HierarchyInstancePoolRecord& pool =
        hierarchy_instance_pool(engine, handle);
    const std::size_t index = hierarchy_instance_index(
        index_value, pool.count,
        "removeHierarchyInstance index must reference an active hierarchy instance");
    const std::size_t last = pool.count - 1;
    if (index != last) {
        for (const MeshHandle mesh_handle : pool.meshes) {
            MeshRecord& mesh = ${recordAt("engine.meshes", "mesh_handle")};
            mesh.instance_matrices[index] = mesh.instance_matrices[last];
        }
    }
    set_hierarchy_instance_count(
        engine, handle, static_cast<double>(last));
}
`
            : "";
    }

    private geometryAccessSource(options: SceneCoreOptions): string {
        return options.geometryAccess
            ? `
// src/mesh/mesh.ts retained CPU arrays. The native geometry record retains
// every lane the pin exposes, and these copies preserve typed-array value
// semantics for scene code that only reads them.
std::vector<float> mesh_cpu_positions(
    const Engine& engine,
    MeshHandle mesh) {
    const ModelGeometry& geometry =
        engine.geometries.at(${recordAt("engine.meshes", "mesh")}.geometry);
    std::vector<float> result;
    result.reserve(geometry.vertices.size() * 3);
    for (const ModelVertex& vertex : geometry.vertices) {
        result.push_back(vertex.position.x);
        result.push_back(vertex.position.y);
        result.push_back(vertex.position.z);
    }
    return result;
}

std::vector<float> mesh_cpu_normals(
    const Engine& engine,
    MeshHandle mesh) {
    const ModelGeometry& geometry =
        engine.geometries.at(${recordAt("engine.meshes", "mesh")}.geometry);
    std::vector<float> result;
    result.reserve(geometry.vertices.size() * 3);
    for (const ModelVertex& vertex : geometry.vertices) {
        result.push_back(vertex.normal.x);
        result.push_back(vertex.normal.y);
        result.push_back(vertex.normal.z);
    }
    return result;
}

std::vector<float> mesh_cpu_uvs(
    const Engine& engine,
    MeshHandle mesh) {
    const ModelGeometry& geometry =
        engine.geometries.at(${recordAt("engine.meshes", "mesh")}.geometry);
    std::vector<float> result;
    result.reserve(geometry.vertices.size() * 2);
    for (const ModelVertex& vertex : geometry.vertices) {
        result.push_back(vertex.uv.x);
        result.push_back(vertex.uv.y);
    }
    return result;
}

std::vector<std::uint32_t> mesh_cpu_indices(
    const Engine& engine,
    MeshHandle mesh) {
    return engine.geometries.at(
        ${recordAt("engine.meshes", "mesh")}.geometry).indices;
}

js::Array<double> asset_root_world_matrix_array(Engine& engine, AssetHandle asset) {
    const auto world = asset_root_world_matrix(engine, asset);
    return js::Array<double>(world.begin(), world.end());
}

js::Array<double> mesh_world_matrix_array(
    const Engine& engine,
    MeshHandle mesh) {
    const std::array<float, 16> world =
        upstream::mesh_world_matrix(engine, ${recordAt("engine.meshes", "mesh")});
    return js::Array<double>(world.begin(), world.end());
}

js::Array<double> mesh_bound_min_array(
    const Engine& engine,
    MeshHandle mesh) {
    const MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
    Vec3 bounds{};
    if (record.geometry < engine.geometries.size()) {
        bounds = engine.geometries[record.geometry].bounds_min;
    }
    Vec3 maximum{};
    apply_mesh_bound_overrides(record, bounds, maximum);
    return {bounds.x, bounds.y, bounds.z};
}

js::Array<double> mesh_bound_max_array(
    const Engine& engine,
    MeshHandle mesh) {
    const MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
    Vec3 bounds{};
    if (record.geometry < engine.geometries.size()) {
        bounds = engine.geometries[record.geometry].bounds_max;
    }
    Vec3 minimum{};
    apply_mesh_bound_overrides(record, minimum, bounds);
    return {bounds.x, bounds.y, bounds.z};
}
`
            : "";
    }

    private fogSource(options: SceneCoreOptions): string {
        return options.fog
            ? `
// ${this.context.provenance(fogModulePath, `${fogName}, writeFogUbo`)}
void set_scene_fog(
    Scene& scene,
    float mode,
    float density,
    float start,
    float end,
    Color3 color) {
    require_scene_engine(scene);
    scene.state->fog_identity = next_scene_uniform_object_identity();
    scene.fog_mode = mode;
    scene.fog_density = density;
    scene.fog_start = start;
    scene.fog_end = end;
    scene.fog_color = color;
}
`
            : "";
    }

    private clipPlaneSource(options: SceneCoreOptions): string {
        return options.clipPlane
            ? `
// ${this.context.provenance(
                  clipPlaneModulePath,
                  `${clipPlaneName}, writeClipPlaneUbo`,
              )}
void set_scene_clip_plane(Scene& scene, Vec4 plane) {
    require_scene_engine(scene);
    scene.clip_plane = plane;
}
`
            : "";
    }

    private vatSeek(options: SceneCoreOptions): string {
        return options.vat
            ? `
    if (!scene.seeks_vat) {
        scene.seeks_vat = true;
        Engine* engine = scene.engine;
        scene.animation_seekers.push_back(
            [engine](double time) { seek_vat(*engine, time); });
    }`
            : "";
    }

    private managerSeek(options: SceneCoreOptions): string {
        return options.animationManagers
            ? `
    if (!scene.seeks_animation_managers) {
        scene.seeks_animation_managers = true;
        Engine* engine = scene.engine;
        scene.animation_seekers.push_back(
            [engine](double time) {
                // Walked when the seek fires, not when it is attached:
                // a manager created after this scene registered still
                // owns animation time for the groups on it.
                for (
                    const PropertyAnimationManager& manager :
                    engine->animation_managers) {
                    seek_animation_manager(manager, *engine, time);
                }
            });
    }`
            : "";
    }

    private sceneCreationSource(
        callbackDelta: string,
        value: (input: number) => string,
        clear: (name: string) => number,
        options: SceneCoreOptions,
    ): string {
        return `double scene_callback_delta(const Scene& scene, double engine_delta_ms) {
    return ${callbackDelta};
}

Scene create_scene_context(Engine& engine) {
    Scene scene;
    scene.engine = &engine;
${options.pbrSceneHooks ? "    scene.state->source_material_publication = true;\n" : ""}\
#if BBLITE_HAS_UI
    scene.surface_canvas = engine.surface_canvas;
#endif
    scene.clear_color = Color4{
        ${value(clear("r"))},
        ${value(clear("g"))},
        ${value(clear("b"))},
        ${value(clear("a"))},
    };
    return scene;
}

Surface create_surface(Engine& engine, UiElementHandle canvas) {
    Surface surface;
    surface.engine = &engine;
    surface.canvas = canvas;
#if BBLITE_HAS_UI
    if (canvas.value < engine.ui_elements.size()) {
        ${recordAt("engine.ui_elements", "canvas")}.client_rect_requested = true;
    }
#endif
    return surface;
}

void dispose_surface(Surface& surface) {
    if (surface.disposed) {
        *surface.disposed = true;
    }
}

Scene create_scene_context(Surface& surface) {
    if (!surface.engine || !surface.disposed || *surface.disposed) {
        throw std::runtime_error(
            "Cannot create a scene from a disposed surface.");
    }
    Scene scene = create_scene_context(*surface.engine);
    scene.surface_canvas = surface.canvas;
    return scene;
}

`;
    }

    private meshMembershipSource(options: SceneCoreOptions): string {
        return `void add_to_scene(Scene& scene, MeshHandle mesh) {
    require_scene_engine(scene);
    if (mesh.value >= scene.engine->meshes.size()) {
        throw std::runtime_error(
            "Invalid mesh handle " + std::to_string(mesh.value) +
            " for " + std::to_string(scene.engine->meshes.size()) +
            " meshes.");
    }
    if (!mesh_handle_current(*scene.engine, mesh)) {
        throw std::runtime_error(
            "Mesh handle " + std::to_string(mesh.value) +
            " names a mesh that was removed from the scene and whose slot "
            "another mesh now holds; re-adding a removed mesh is outside the "
            "reached subset.");
    }
    if (${recordAt("scene.engine->meshes", "mesh")}.retired) {
        throw std::runtime_error(
            "Mesh '" + ${recordAt("scene.engine->meshes", "mesh")}.name +
            "' was removed from the scene and its geometry reclaimed; "
            "re-adding a removed mesh is outside the reached subset.");
    }
    register_mesh_material_scene(scene, mesh);
    scene.meshes.push_back(mesh);
    if (!scene.state->source_material_publication) ++scene.render_topology_version;
    if (!scene.state->source_material_publication) scene.material_family_mask |= material_family_bit(*scene.engine, mesh);
${options.nodeMaterials ? "    queue_node_material_group(scene, mesh);\n" : ""}\
${options.pbrSceneHooks ? "    queue_pbr_material_group(scene, mesh);\n" : ""}\
}

// The observable quaternion's setter: the quaternion becomes the rotation
// source of truth, as the pin's ObservableQuat is, and the world-matrix
// state's \`markLocalDirty\` pushes through the registered subtree.
void set_mesh_rotation_quaternion(
    Engine& engine,
    MeshHandle mesh,
    Vec4 quaternion) {
    MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
    record.rotation_quaternion = quaternion;
    record.has_rotation_quaternion = true;
    mark_mesh_dirty(engine, mesh);
}

namespace {
// \`list.splice(list.indexOf(mesh), 1)\`: the first entry only, as the pin
// removes it.
void erase_first_mesh(std::vector<MeshHandle>& list, MeshHandle mesh) {
    const auto found = std::find(list.begin(), list.end(), mesh);
    if (found != list.end()) list.erase(found);
}

// \`mesh.parent = null\`, the pin's parent setter: the old parent's
// invalidation registry lets the mesh go (\`_removeChild\`); the parent's
// traversal \`children\` list keeps its entry.
void clear_mesh_parent(Engine& engine, MeshHandle mesh) {
    MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
    if (record.parent.value == invalid_handle &&
        record.transform_parent.value == invalid_handle) {
        return;
    }
    unregister_from_parents(engine, record, mesh);
    record.parent = MeshHandle{};
    record.transform_parent = TransformNodeHandle{};
    mark_mesh_dirty(engine, mesh);
}
} // namespace

// ${this.context.provenance("src/scene/scene-remove.ts", "removeFromScene")}
//
// removeMeshFromScene in the pin's order, then the mesh's own children.
// Every scene render task drops the mesh's entries (\`task._removeMesh\` and
// \`_removeMeshFromRenderTask\`: native \`render_meshes\` holds both the
// tracked and the bound entries), the scene list and its renderables drop
// it, every material group and the material swap queue drop it, and its
// parent link clears. Leaving its last scene -- or none, for a mesh never
// added -- disposes it (\`disposeMeshGpu\`), which \`retire_mesh_record\`
// stands for: the geometry goes with the last claim and the record's slot
// is offered to the next mesh. Tables the pin leaves naming the mesh (a
// physics body, an animation target, a light's include list, a shadow
// caster array, a parent's traversal list) keep its handle, whose
// generation tells it apart from the slot's next occupant. The
// material-family mask stays monotonic: it gates which pipelines the
// backend created, and a removal never invalidates one.
void remove_from_scene(Scene& scene, MeshHandle mesh) {
    require_scene_engine(scene);
    Engine& engine = *scene.engine;
    // A disposed mesh whose slot another mesh took: removing it again
    // changes nothing upstream.
    if (!mesh_handle_current(engine, mesh)) return;
    for (const TaskHandle task : scene.tasks) {
        std::erase_if(
            ${recordAt("engine.frame_tasks", "task")}.render_meshes,
            [mesh](const RenderTaskMesh& entry) { return entry.mesh == mesh; });
    }
    const auto listed = std::find(scene.meshes.begin(), scene.meshes.end(), mesh);
    if (listed != scene.meshes.end()) {
        scene.meshes.erase(listed);
        ++scene.render_topology_version;
    }
    std::erase_if(scene.state->material_outputs, [mesh](const auto& output) { return output->mesh == mesh; });
${options.nodeMaterials ? "    for (const auto& group : scene.state->node_material_groups) erase_first_mesh(group->meshes, mesh);\n" : ""}\
    if (scene.state->source_material_groups) {
        for (const auto& [builder, group] : *scene.state->source_material_groups) {
            if (group) erase_first_mesh(group->meshes, mesh);
        }
    }
    erase_first_mesh(scene.state->pbr_material_swap_queue, mesh);
    clear_mesh_parent(engine, mesh);
    if (unregister_mesh_material_scene(scene, mesh)) retire_mesh_record(engine, mesh);
    // removeChildren: a copy, since each removal may edit the list.
    const std::vector<MeshHandle> children = ${recordAt("engine.meshes", "mesh")}.children;
    for (const MeshHandle child : children) remove_from_scene(scene, child);
}


// Light removal is a topology mutation rather than a light-record disposal:
// handles stay stable in the engine, while the scene list and receiver render
// plan are rebuilt from the surviving membership. An old shadow task stays
// scheduled until the replacement rebuild succeeds, matching the pin's
// failure-safe retirement order.
void remove_from_scene(Scene& scene, LightHandle light) {
    require_scene_engine(scene);
    const auto found = std::find_if(
        scene.lights.begin(),
        scene.lights.end(),
        [light](const LightHandle candidate) {
            return candidate.value == light.value;
        });
    if (found == scene.lights.end()) return;
#if BBLITE_HAS_SHADOWS
    if (light.value < scene.engine->lights.size()) {
        const LightRecord& record = ${recordAt("scene.engine->lights", "light")};
        const ShadowGeneratorHandle generator = record.shadow_generator;
        if (
            generator.value < scene.engine->shadow_generators.size() &&
            std::none_of(
                scene.pending_shadow_retirements.begin(),
                scene.pending_shadow_retirements.end(),
                [generator](const ShadowGeneratorHandle candidate) {
                    return candidate.value == generator.value;
                })) {
            scene.pending_shadow_retirements.push_back(generator);
        }
    }
#endif
    scene.lights.erase(found);
    scene.topology_rebuild_pending = true;
    ++scene.render_topology_version;
}

void add_to_scene(Scene& scene, LightHandle light) {
    require_scene_engine(scene);
    if (light.value >= scene.engine->lights.size()) throw std::runtime_error("Invalid light handle.");
    scene.lights.push_back(light);
    ++scene.render_topology_version;
}

namespace {

`;
    }

    private assetCloneSource(
        cloneSuffix: string,
        nodeHierarchy: boolean,
    ): string {
        return `AssetRecord& asset_record(Engine& engine, std::uint32_t asset) {
    if (asset >= engine.assets.size()) {
        throw std::runtime_error("Invalid asset handle.");
    }
    return engine.assets[asset];
}

}  // namespace

/**
 * src/scene/transform-node.ts cloneTransformNode/cloneMeshNode over the
 * imported synthetic root. The clone is an AssetRecord of distinct mesh
 * wrappers sharing the source geometry/material state -- and, for an import
 * that carries its node hierarchy, copies of every node with each wrapper
 * under its node's copy -- without the container's animation groups, tick,
 * camera, lights or scene setup. The source runtime callback mirrors the
 * retained skeleton resource by registering each skinned wrapper against
 * the same pose evaluator.
 */
AssetHandle clone_asset_root(Engine& engine, AssetHandle asset) {
    const AssetRecord& source = asset_record(engine, asset.value);
    if (!source.lights.empty() || source.has_camera) {
        throw std::runtime_error(
            "Cloning an imported root with light or camera descendants is not supported.");
    }
    const std::vector<MeshHandle> source_meshes = source.meshes;
    const auto clone_animation = source.clone_mesh_animation;
    AssetRecord clone;
    clone.source_mesh_walks = source.source_mesh_walks;
    clone.root_position = source.root_position;
    clone.root_rotation = source.root_rotation;
    clone.root_scaling = source.root_scaling;
    clone.root_rotation_quaternion = source.root_rotation_quaternion;
    clone.root_quaternion_version = source.root_quaternion_version;
    clone.root_synced_quaternion_version = source.root_synced_quaternion_version;
    clone.clone_mesh_animation = clone_animation;
    clone.meshes.reserve(source_meshes.size());
    for (const MeshHandle source_mesh : source_meshes) {
        if (source_mesh.value >= engine.meshes.size()) {
            throw std::runtime_error("Invalid mesh handle in imported root.");
        }
        MeshRecord record = ${recordAt("engine.meshes", "source_mesh")};
        if (record.retired) {
            throw std::runtime_error(
                "Mesh '" + record.name +
                "' cannot be cloned: it was disposed when it left its last "
                "scene.");
        }
        if (record.geometry < engine.geometries.size()) {
            ++engine.geometries[record.geometry].owners;
        }
        record.name += "${cloneSuffix}";
        const MeshHandle cloned_mesh =
            store_mesh_record(engine, std::move(record));
        clone.meshes.push_back(cloned_mesh);
        if (clone_animation) {
            clone_animation(source_mesh, cloned_mesh);
        }
    }
    // Mesh links among the source's records map to the clone's copies.
    const auto cloned_handle = [&](MeshHandle source_mesh) {
        const auto found = std::find(source_meshes.begin(), source_meshes.end(), source_mesh);
        return found == source_meshes.end()
            ? source_mesh
            : clone.meshes[static_cast<std::size_t>(found - source_meshes.begin())];
    };
    for (const MeshHandle cloned_mesh : clone.meshes) {
        MeshRecord& record = ${recordAt("engine.meshes", "cloned_mesh")};
        record.parent = cloned_handle(record.parent);
        for (MeshHandle& child : record.children) child = cloned_handle(child);
        for (MeshHandle& child : record.parented_meshes) child = cloned_handle(child);
    }${nodeHierarchy ? assetHierarchyCloneCpp() : ""}
    const AssetHandle cloned_asset{
        static_cast<std::uint32_t>(engine.assets.size())};
    engine.assets.push_back(std::move(clone));
    return cloned_asset;
}

/**
 * src/scene/transform-node.ts cloneMeshNode, reached through
 * cloneTransformNode's own \`"_gpu" in src\` arm when the cloned node is a
 * mesh rather than an imported root. The record copy is the pin's
 * \`{ ...mesh }\` spread: position, rotation quaternion, scaling, material
 * and every GPU-backed reference travel with it, and the geometry owner
 * count is the native form of the pin's \`retain\`. The clone starts with
 * no children of its own, exactly as the pin's \`children: []\` does.
 */
MeshHandle clone_mesh_node(Engine& engine, MeshHandle mesh) {
    if (mesh.value >= engine.meshes.size()) {
        throw std::runtime_error("Invalid mesh handle.");
    }
    if (!mesh_handle_current(engine, mesh)) {
        throw std::runtime_error(
            "Mesh handle " + std::to_string(mesh.value) +
            " cannot be cloned: its mesh was disposed when it left its last "
            "scene and another mesh now holds its slot.");
    }
    if (${recordAt("engine.meshes", "mesh")}.retired) {
        throw std::runtime_error(
            "Mesh '" + ${recordAt("engine.meshes", "mesh")}.name +
            "' cannot be cloned: it was disposed when it left its last "
            "scene.");
    }
    if (!${recordAt("engine.meshes", "mesh")}.children.empty()) {
        throw std::runtime_error(
            "Mesh '" + ${recordAt("engine.meshes", "mesh")}.name +
            "' has children; the pin clones a node's children recursively "
            "and no reached scene clones a parented mesh.");
    }
    MeshRecord record = ${recordAt("engine.meshes", "mesh")};
    if (record.parent_world) {
        // The pin's clone starts a fresh world state with no parent: it
        // keeps the imported mesh's local lanes and its own TRS but leaves
        // the node hierarchy, root mirror included.
        record.parent_world.reset();
        record.detached_imported_mesh = true;
        record.clockwise_front_face = false;
        record.authored_clockwise_front_face = false;
    }
    if (record.geometry < engine.geometries.size()) {
        ++engine.geometries[record.geometry].owners;
    }
    record.name += "${cloneSuffix}";
    record.parent = {};
    record.transform_parent = {};
    record.outer_position = {};
    record.outer_rotation = {};
    record.outer_scaling = {1, 1, 1};
    record.outer_has_rotation_quaternion = false;
    record.parented_meshes.clear();
    return store_mesh_record(engine, std::move(record));
}

`;
    }

    private assetRootSource(nodeHierarchy: boolean): string {
        return `${assetRootTransformSource(this.context, nodeHierarchy)}
void add_asset_meshes(Scene& scene, const AssetRecord& record) {
    if (record.source_mesh_walks && record.source_mesh_walks->scene) {
        for (const auto index : *record.source_mesh_walks->scene) {
            add_to_scene(scene, record.meshes.at(index));
        }
    } else {
        for (const MeshHandle mesh : record.meshes) add_to_scene(scene, mesh);
    }
}

void add_to_scene(Scene& scene, AssetHandle asset) {
    require_scene_engine(scene);
    AssetRecord& record =
        asset_record(*scene.engine, asset.value);
${lowerAssetSceneAttachment(this.context)}
    if (record.animation_seek) {
        scene.animation_seekers.push_back(record.animation_seek);
    }
}

/**
 * A container's entities, which is what a scene iterating entities and
 * calling addToScene per entity adds: the pinned container arm's own entity
 * recursion and nothing else. Its animation groups, their per-frame
 * tick, its camera and its clear colour are container-level wiring the
 * pin performs for the container itself, and a scene iterating entities
 * is usually avoiding exactly that — it drives those groups from its own
 * AnimationManager instead.
 *
 * The pin seeds a glTF container with its root node and lets each loader
 * feature append its own entities, so adding them one by one adds the
 * loader's meshes and its lights — which is what this adds in one step.
 * Generation refuses any other container.
 *
 * The animation seeker is not part of the pinned walk: it is this port's
 * deterministic-pose entry point (BBLITE_ANIMATION_SEEK_SECONDS),
 * standing for the goToFrame the browser harness calls on the same
 * groups, so it follows the asset rather than the way it was added.
 */
`;
    }

    private assetMembershipSource(options: SceneCoreOptions): string {
        return `void add_asset_entities(Scene& scene, AssetHandle asset) {
    require_scene_engine(scene);
    const AssetRecord& record =
        asset_record(*scene.engine, asset.value);
    add_asset_meshes(scene, record);
    for (const LightHandle light : record.lights) add_to_scene(scene, light);
    if (record.animation_seek) {
        scene.animation_seekers.push_back(record.animation_seek);
    }
}

void add_to_scene(Scene& scene, const SceneNodeHandle& node) {
    std::visit(
        [&scene](const auto& concrete) {
            using Handle = std::decay_t<decltype(concrete)>;
            if constexpr (std::is_same_v<Handle, AssetHandle>) {
                add_asset_entities(scene, concrete);
            } else if constexpr (std::is_same_v<Handle, TransformNodeHandle>) {
                ${
                    options.transformNodes
                        ? "add_to_scene(scene, concrete);"
                        : 'throw std::runtime_error("No transform-node factory is reached by this scene.");'
                }
            } else {
                add_to_scene(scene, concrete);
            }
        },
        node);
}

`;
    }

    private eventRegistrationSource(): string {
        return `void on_before_render(
    Scene& scene,
    js::Callback<void(float)> callback) {
    scene.before_render.insert(
        scene.before_render.begin(),
        std::move(callback));
}

void on_scene_dispose(
    Scene& scene,
    js::Callback<void()> callback) {
    scene.disposables.push_back(std::move(callback));
}

void on_key_down(
    Engine& engine,
    std::size_t identity,
    std::function<void(const PlatformKeyboardEvent&)> callback,
    bool once) {
    engine.key_down_callbacks.add(identity, std::move(callback), once);
}
void off_key_down(Engine& engine, std::size_t identity) {
    engine.key_down_callbacks.remove(identity);
}

void on_key_up(
    Engine& engine,
    std::size_t identity,
    std::function<void(const PlatformKeyboardEvent&)> callback,
    bool once) {
    engine.key_up_callbacks.add(identity, std::move(callback), once);
}
void off_key_up(Engine& engine, std::size_t identity) {
    engine.key_up_callbacks.remove(identity);
}

void on_pointer_down(
    Engine& engine,
    std::size_t identity,
    std::function<void()> callback,
    bool once) {
    engine.pointer_down_callbacks.add(identity, std::move(callback), once);
}
void off_pointer_down(Engine& engine, std::size_t identity) {
    engine.pointer_down_callbacks.remove(identity);
}

void on_canvas_click(
    Engine& engine,
    std::size_t identity,
    std::function<void()> callback,
    bool once) {
    engine.canvas_click_callbacks.add(identity, std::move(callback), once);
}
void off_canvas_click(Engine& engine, std::size_t identity) {
    engine.canvas_click_callbacks.remove(identity);
}

void on_mouse_down(
    Engine& engine,
    std::size_t identity,
    std::function<void(const PlatformMouseEvent&)> callback,
    bool once) {
    engine.mouse_down_callbacks.add(identity, std::move(callback), once);
}
void off_mouse_down(Engine& engine, std::size_t identity) {
    engine.mouse_down_callbacks.remove(identity);
}

void on_mouse_up(
    Engine& engine,
    std::size_t identity,
    std::function<void(const PlatformMouseEvent&)> callback,
    bool once) {
    engine.mouse_up_callbacks.add(identity, std::move(callback), once);
}
void off_mouse_up(Engine& engine, std::size_t identity) {
    engine.mouse_up_callbacks.remove(identity);
}

void on_mouse_move(
    Engine& engine,
    std::size_t identity,
    std::function<void(const PlatformMouseEvent&)> callback,
    bool once) {
    engine.mouse_move_callbacks.add(identity, std::move(callback), once);
}
void off_mouse_move(Engine& engine, std::size_t identity) {
    engine.mouse_move_callbacks.remove(identity);
}

void on_mouse_wheel(
    Engine& engine,
    std::size_t identity,
    std::function<void(const PlatformMouseEvent&)> callback,
    bool once) {
    engine.mouse_wheel_callbacks.add(identity, std::move(callback), once);
}
void off_mouse_wheel(Engine& engine, std::size_t identity) {
    engine.mouse_wheel_callbacks.remove(identity);
}

void on_mouse_cancel(
    Engine& engine,
    std::size_t identity,
    std::function<void(const PlatformMouseEvent&)> callback,
    bool once) {
    engine.mouse_cancel_callbacks.add(identity, std::move(callback), once);
}
void off_mouse_cancel(Engine& engine, std::size_t identity) {
    engine.mouse_cancel_callbacks.remove(identity);
}

void on_window_resize(
    Engine& engine,
    std::size_t identity,
    std::function<void()> callback,
    bool once) {
    engine.window_resize_callbacks.add(identity, std::move(callback), once);
}
void off_window_resize(Engine& engine, std::size_t identity) {
    engine.window_resize_callbacks.remove(identity);
}

void on_pointer_lock_change(
    Engine& engine,
    std::size_t identity,
    std::function<void()> callback,
    bool once) {
    engine.pointer_lock_change_callbacks.add(identity, std::move(callback), once);
}
void off_pointer_lock_change(Engine& engine, std::size_t identity) {
    engine.pointer_lock_change_callbacks.remove(identity);
}

void set_canvas_cursor(Engine& engine, std::string cursor) {
    engine.canvas_cursor = std::move(cursor);
}

void focus_canvas(Engine& engine) {
    engine.canvas_focused = true;
#if BBLITE_HAS_UI
    // Canvas focus replaces DOM focus, just as button focus replaces canvas
    // focus. Otherwise a stale button still reports activeElement and paints
    // its focus-visible outline after the source has focused the canvas.
    engine.ui_focused_element = {};
    ++engine.ui_focus_revision;
#endif
}

void request_pointer_lock(Engine& engine) {
    engine.pointer_lock_requested = true;
}

void exit_pointer_lock(Engine& engine) {
    engine.pointer_lock_requested = false;
}

void on_visibility_change(
    Engine& engine,
    std::size_t identity,
    std::function<void(bool)> callback,
    bool once) {
    engine.visibility_change_callbacks.add(identity, std::move(callback), once);
}
void off_visibility_change(Engine& engine, std::size_t identity) {
    engine.visibility_change_callbacks.remove(identity);
}

`;
    }

    private sceneLifecycleSource(
        managerSeek: string,
        vatSeek: string,
        options: SceneCoreOptions,
    ): string {
        const { file, declaration: buildScene } =
            this.context.functionDeclaration(
                "src/scene/scene-core.ts",
                "buildScene",
            );
        const built = this.context.findNodes(
            buildScene,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                node.left.getText(file) === "ctx._built",
        );
        if (built.length !== 1)
            this.context.contractError(
                buildScene,
                "Expected one scene build completion flag.",
            );
        const builtValue = new PinnedNumericLowerer(file, {
            bindings: new Map(),
            calls: new Map(),
        }).expression(built[0]!.right);
        return `void drain_scene_deferred_builders(Scene& scene) {
    while (!scene.deferred_builders.empty()) {
        auto builders = std::move(scene.deferred_builders);
        scene.deferred_builders.clear();
        // Array.map stops on a synchronous throw. Async wrappers instead
        // reject, allowing every callback in this batch to run first.
        std::exception_ptr failure;
        for (const auto& builder : builders) {
            try {
                builder();
            } catch (...) {
                if (builder.failure_mode == SceneDeferredFailure::synchronous_throw) throw;
                if (!failure) failure = std::current_exception();
            }
        }
        if (failure) std::rethrow_exception(failure);
    }
}

void register_scene(Scene& scene) {
    require_scene_engine(scene);
    const auto found = std::find_if(
        scene.engine->registered_scenes.begin(),
        scene.engine->registered_scenes.end(),
        [&scene](const std::shared_ptr<Scene>& registered) {
            return registered && registered->shares_identity(scene);
        });
    if (found != scene.engine->registered_scenes.end()) return;${managerSeek}${vatSeek}
${options.pbrSceneHooks ? "    prepare_pbr_scene_build(scene);\n" : ""}\
    drain_scene_deferred_builders(scene);
${options.pbrSceneHooks ? "    finish_pbr_scene_build(scene);\n" : ""}\
    scene.state->source_built = ${builtValue};
    // The source builders read public material arrays when registration
    // creates their UBOs; direct later array writes do not bump _uboVersion.
    for (const auto mesh : scene.meshes) {
        const auto material = ${recordAt("scene.engine->meshes", "mesh")}.material;
        if (material.value < scene.engine->materials.size()) {
            auto& record = ${recordAt("scene.engine->materials", "material")};
            if (!record.source_colors_registered) {
                project_material_source_colors(record);
                record.source_colors_registered = true;
            }
        }
    }
    scene.material_family_mask = scene_material_families(scene);
${
    options.text
        ? `    std::stable_sort(scene.state->text_renderables.begin(), scene.state->text_renderables.end(),
        [](const auto& a, const auto& b) { return a->order < b->order; });\n`
        : ""
}\
    scene.engine->registered_scenes.push_back(
        std::make_shared<Scene>(scene));
}

void unregister_scene(Scene& scene) {
    require_scene_engine(scene);
    scene.engine->registered_scenes.erase(
        std::remove_if(
            scene.engine->registered_scenes.begin(),
            scene.engine->registered_scenes.end(),
            [&scene](const std::shared_ptr<Scene>& registered) {
                return registered && registered->shares_identity(scene);
            }),
        scene.engine->registered_scenes.end());
}

void dispose_scene(Scene& scene) {
    if (scene.disposed) return;
    scene.disposed = true;
    unregister_scene(scene);
    auto disposables = std::move(scene.disposables);
    scene.disposables.clear();
    for (const auto& dispose : disposables) {
        dispose();
    }
    for (const auto mesh : scene.meshes) unregister_mesh_material_scene(scene, mesh);
    scene.meshes.clear();
    scene.lights.clear();
    scene.tasks.clear();
#if BBLITE_HAS_SHADOWS
    scene.pending_shadow_retirements.clear();
#endif
    scene.animation_groups.clear();
#if BBLITE_HAS_SPRITES
    scene.billboard_systems.clear();
    scene.depth_hosted_sprite_layers.clear();
#endif
    scene.splat_meshes.clear();
${options.text ? "    scene.state->text_renderables.clear();\n" : ""}\
    scene.before_render.clear();
    scene.animation_seekers.clear();
    scene.deferred_builders.clear();
${options.nodeMaterials ? "    scene.state->node_material_groups.clear();\n" : ""}\
${
    options.pbrSceneHooks
        ? `    scene.state->pbr_material_group.reset();
    scene.state->source_material_groups.reset();
    scene.state->material_outputs.clear();
    scene.state->material_runtime_error = nullptr;
    scene.state->pbr_material_swap_queue.clear();
    scene.state->material_group_rebuild_pending = false;
    scene.state->process_material_groups = nullptr;
    scene.state->enqueue_material_group = nullptr;
    scene.state->complete_material_group = nullptr;
`
        : ""
}\
    scene.camera = {};
}

void rebuild_scene_renderables(Scene& scene) {
    require_scene_engine(scene);
${options.pbrSceneHooks ? "    rebuild_pbr_material_group(scene, false, true);\n" : ""}\
#if BBLITE_HAS_SHADOWS
    for (const ShadowGeneratorHandle generator :
         scene.pending_shadow_retirements) {
        if (generator.value >= scene.engine->shadow_generators.size()) {
            continue;
        }
        const bool still_active = std::any_of(
            scene.lights.begin(),
            scene.lights.end(),
            [&](const LightHandle light) {
                return
                    light.value < scene.engine->lights.size() &&
                    ${recordAt("scene.engine->lights", "light")}
                            .shadow_generator.value == generator.value;
            });
        if (still_active) continue;
        ShadowGeneratorRecord& shadow =
            ${recordAt("scene.engine->shadow_generators", "generator")};
        // Every caster pass the generator built: one for a single-map
        // generator, one per cascade layer for a cascaded one.
        const std::vector<TaskHandle> retired = shadow.caster_tasks;
        scene.tasks.erase(
            std::remove_if(
                scene.tasks.begin(),
                scene.tasks.end(),
                [&retired](const TaskHandle candidate) {
                    return std::any_of(
                        retired.begin(),
                        retired.end(),
                        [candidate](const TaskHandle task) {
                            return candidate.value == task.value;
                        });
                }),
            scene.tasks.end());
        shadow.caster_tasks.clear();
        shadow.map_target = RenderTargetHandle{};
        for (LightRecord& light : scene.engine->lights) {
            if (light.shadow_generator.value == generator.value) {
                light.shadow_generator = ShadowGeneratorHandle{};
            }
        }
    }
    scene.pending_shadow_retirements.clear();
#endif
    scene.topology_rebuild_pending = false;
    ++scene.render_topology_version;
}

`;
    }
}
