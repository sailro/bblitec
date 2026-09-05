import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import {
  lowerMat4InvertCpp,
} from "./pinned-function-lowerer.js";
import { lowerMat4DecomposeFull } from "./pinned-mat4-decompose.js";
import { sceneNodeTransformsSource } from "./scene-node-transforms.js";

export class SceneLowerer {
  public constructor(private readonly context: LoweringContext) {}

  public lowerCore(
    options: {
      fog?: boolean;
      /** The scene reaches `setClipPlane`. */
      clipPlane?: boolean;
      /** The scene reaches `enableMirroredMeshes`. */
      mirroredMeshes?: boolean;
      parenting?: boolean;
      visibility?: boolean;
      geometryAccess?: boolean;
      managedAnimationGroups?: boolean;
      /** The scene baked a vertex animation texture (mesh:vat). */
      vat?: boolean;
      /** The scene reaches `createTransformNode`. */
      transformNodes?: boolean;
      /** A retained SceneNode union reaches a TRS read or write. */
      sceneNodeTransforms?: boolean;
    } = {},
  ): LoweredSource {
    const modulePath = "src/scene/scene-core.ts";
    const createName = "createSceneContext";
    const addName = "addToScene";
    const beforeName = "onBeforeRender";
    const disposeName = "onSceneDispose";
    const registerName = "registerScene";
    const fogModulePath = "src/scene/scene-ubo-extras.ts";
    const fogName = "setFog";
    const clipPlaneModulePath = fogModulePath;
    const clipPlaneName = "setClipPlane";
    const { file, declaration } = this.context.functionDeclaration(
      modulePath,
      createName,
    );
    const scene = this.context.objectInitializer(declaration, "ctxLocal");
    const clearExpression = this.context.propertyInitializer(
      scene,
      "clearColor",
    );
    if (!ts.isObjectLiteralExpression(clearExpression)) {
      throw new Error("Upstream scene clearColor is not an object literal.");
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
        this.context.propertyPath(node.expression)?.join(".") === "kids",
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
        "createSceneNodeCore",
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
    if (cloneChildPushes.length !== 2) {
      this.context.contractError(
        cloneTransformNode,
        "Expected cloneTransformNode to append each cloned child to the traversal list.",
      );
    }
    const { declaration: cloneMeshNode } = this.context.functionDeclaration(
      transformNodeModulePath,
      "cloneMeshNode",
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
          this.context.propertyPath(node.left)?.join(".") === "mesh.name" &&
          ts.isStringLiteral(this.context.unwrapExpression(node.right)),
      )
      .map(
        (concat) =>
          (this.context.unwrapExpression(concat.right) as ts.StringLiteral)
            .text,
      );
    if (cloneSuffixes.length !== 1) {
      this.context.contractError(
        cloneMeshNode,
        "Expected one pinned clone-name suffix.",
      );
    }
    const cloneSuffix = cloneSuffixes[0]!;
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
    const { declaration: onBeforeRender } = this.context.functionDeclaration(
      modulePath,
      beforeName,
    );
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
    const { declaration: onSceneDispose } = this.context.functionDeclaration(
      modulePath,
      disposeName,
    );
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
    if (!this.context.hasCall(registerScene, "isRenderingContextRegistered")) {
      this.context.contractError(
        registerScene,
        "Expected idempotent rendering-context registration.",
      );
    }
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
            this.context.propertyPath(node.left)?.join(".") === "scene.fog" &&
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
      // native shaders through named uniform-struct fields packed
      // by the renderer lowerer, and the WGSL component reads come
      // from the pin's own WGSL_FOG, lifted verbatim by
      // shader-builtins-utility.ts fogFactorWgsl(), so they track
      // the pin without a copy here.
      const { declaration: writeFogUbo } = this.context.functionDeclaration(
        fogModulePath,
        "writeFogUbo",
      );
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
      const expectedFogFields = ["mode", "start", "end", "density", "color"];
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
      const { declaration: setClipPlane } = this.context.functionDeclaration(
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
        !this.context.hasCall(setClipPlane, "_registerSceneUboContributor")
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
    const value = (input: number): string => this.context.floatLiteral(input);
    const meshDirtySource = `
void mark_mesh_dirty(Engine& engine, MeshHandle mesh) {
    if (mesh.value >= engine.meshes.size()) return;
    MeshRecord& record = engine.meshes[mesh.value];
    ++record.transform_version;
    for (const MeshHandle child : record.parented_meshes) {
        mark_mesh_dirty(engine, child);
    }
}

// A transform written from a live callback or property animation changes
// every frame. Keep that subtree's vertices local after its first such write
// and move it through the per-draw world matrix; otherwise every dirty mark
// rebuilds and uploads the complete baked vertex streams.
void mark_mesh_runtime_transform(Engine& engine, MeshHandle mesh) {
    if (mesh.value >= engine.meshes.size()) return;
    MeshRecord& record = engine.meshes[mesh.value];
    record.gpu_world_transform = true;
    ++record.transform_version;
    for (const MeshHandle child : record.parented_meshes) {
        mark_mesh_runtime_transform(engine, child);
    }
}

// The same, one level up. A transform node written every frame -- a physics
// body's pose, say -- invalidates both of its child arms, exactly as
// mark_transform_node_dirty does: a node parented under it is as stale as
// a mesh is.
void mark_transform_node_runtime_transform(
    Engine& engine,
    TransformNodeHandle node) {
    if (node.value >= engine.transform_nodes.size()) return;
    TransformNodeRecord& record = engine.transform_nodes[node.value];
    ++record.transform_version;
    for (const MeshHandle child : record.parented_meshes) {
        mark_mesh_runtime_transform(engine, child);
    }
    for (const TransformNodeHandle child : record.parented_nodes) {
        mark_transform_node_runtime_transform(engine, child);
    }
}
`;
    const visibilitySource = options.visibility
      ? `
// ${this.context.provenance("src/scene/visibility.ts", "setSubtreeVisible")}
namespace {
// The cascade half: writes the subtree, reports whether any flag moved.
bool set_mesh_visible_cascade(
    Engine& engine,
    MeshHandle mesh,
    bool visible) {
    MeshRecord& record = engine.meshes.at(mesh.value);
    bool changed = record.visible != visible;
    record.visible = visible;
    for (const MeshHandle child : record.children) {
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
    // src/scene/transform-node.ts createTransformNode and the
    // ObservableVec3/ObservableQuat setters a scene writes on the node
    // it made. Each setter is the field write plus the version bump a
    // child re-bakes against, which is what `markLocalDirty` does
    // upstream; the world itself is composed lazily in the render plan,
    // as `createWorldMatrixState` composes it there.
    const transformNodeSource = options.transformNodes
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
    engine.transform_nodes.push_back(std::move(node));
    return TransformNodeHandle{
        static_cast<std::uint32_t>(engine.transform_nodes.size() - 1)};
}

void mark_transform_node_dirty(
    Engine& engine,
    TransformNodeHandle node) {
    if (node.value >= engine.transform_nodes.size()) return;
    TransformNodeRecord& record = engine.transform_nodes[node.value];
    ++record.transform_version;
    for (const MeshHandle child : record.parented_meshes) {
        mark_mesh_dirty(engine, child);
    }
    for (const TransformNodeHandle child : record.parented_nodes) {
        mark_transform_node_dirty(engine, child);
    }
}

void set_transform_node_position(
    Engine& engine,
    TransformNodeHandle node,
    Vec3d position,
    bool runtime_transform) {
    engine.transform_nodes[node.value].position = position;
    if (runtime_transform) mark_transform_node_runtime_transform(engine, node);
    else mark_transform_node_dirty(engine, node);
}

void set_transform_node_scaling(
    Engine& engine,
    TransformNodeHandle node,
    Vec3 scaling,
    bool runtime_transform) {
    engine.transform_nodes[node.value].scaling = scaling;
    if (runtime_transform) mark_transform_node_runtime_transform(engine, node);
    else mark_transform_node_dirty(engine, node);
}

void set_transform_node_rotation(
    Engine& engine,
    TransformNodeHandle node,
    Vec3 rotation,
    bool runtime_transform) {
    TransformNodeRecord& record = engine.transform_nodes[node.value];
    record.rotation = rotation;
    // The pinned Euler proxy writes its quaternion source of truth. The
    // record expresses that same selection by composing the Euler lane when
    // this flag is false; pinnedTrsComposition performs eulerToQuat from the
    // upstream function before the matrix write.
    record.has_rotation_quaternion = false;
    if (runtime_transform) mark_transform_node_runtime_transform(engine, node);
    else mark_transform_node_dirty(engine, node);
}

void set_transform_node_rotation_quaternion(
    Engine& engine,
    TransformNodeHandle node,
    Vec4 rotation,
    bool runtime_transform) {
    TransformNodeRecord& record = engine.transform_nodes[node.value];
    record.rotation_quaternion = rotation;
    record.has_rotation_quaternion = true;
    if (runtime_transform) mark_transform_node_runtime_transform(engine, node);
    else mark_transform_node_dirty(engine, node);
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
    MeshRecord& record = engine.meshes[mesh.value];
    if (
        record.transform_parent.value == parent.value &&
        record.parent.value >= engine.meshes.size()) {
        return;
    }
    if (record.transform_parent.value < engine.transform_nodes.size()) {
        std::vector<MeshHandle>& old_children =
            engine.transform_nodes[record.transform_parent.value]
                .parented_meshes;
        old_children.erase(
            std::remove(old_children.begin(), old_children.end(), mesh),
            old_children.end());
    }
    if (record.parent.value < engine.meshes.size()) {
        std::vector<MeshHandle>& old_children =
            engine.meshes[record.parent.value].parented_meshes;
        old_children.erase(
            std::remove(old_children.begin(), old_children.end(), mesh),
            old_children.end());
    }
    record.parent = MeshHandle{};
    record.transform_parent = parent;
    mark_mesh_dirty(engine, mesh);
    if (parent.value < engine.transform_nodes.size()) {
        std::vector<MeshHandle>& new_children =
            engine.transform_nodes[parent.value].parented_meshes;
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
        cursor = engine.transform_nodes[cursor.value].parent;
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
    TransformNodeRecord& record = engine.transform_nodes[node.value];
    if (record.parent.value == parent.value) return;
    if (record.parent.value < engine.transform_nodes.size()) {
        std::vector<TransformNodeHandle>& old_children =
            engine.transform_nodes[record.parent.value].parented_nodes;
        old_children.erase(
            std::remove(old_children.begin(), old_children.end(), node),
            old_children.end());
    }
    record.parent = parent;
    mark_transform_node_dirty(engine, node);
    if (parent.value < engine.transform_nodes.size()) {
        std::vector<TransformNodeHandle>& new_children =
            engine.transform_nodes[parent.value].parented_nodes;
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
    engine.transform_nodes[node.value].children.emplace_back(child);
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
    engine.transform_nodes[node.value].children.emplace_back(child);
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
    const TransformNodeRecord& record = engine.transform_nodes[node.value];
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
    const TransformNodeRecord& record = engine.transform_nodes[node.value];
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
    // src/mesh/enable-mirrored-meshes.ts is one statement: it awaits
    // the support module and installs it on the scene. The
    // pipeline-side half of that install is a compile-time question
    // here -- a scene that never opts in composes no winding
    // resolution at all -- so what remains at run time is the flag the
    // per-frame watcher reads.
    const mirroredSource = options.mirroredMeshes
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
    const parentMatrixHelpers = options.parenting
      ? [
          "using upstream::mat4_multiply_into;",
          lowerMat4InvertCpp(this.context),
          lowerMat4DecomposeFull(this.context),
        ].join("\n\n")
      : "";
    const parentingSource = options.parenting
      ? `
namespace {

${parentMatrixHelpers}

void apply_parent_local(
    MeshRecord& record,
    const PinnedParentDecomposed& local) {
    // Imported roots are flattened into an outer TRS beside each rendered
    // leaf. Once setParent writes a decomposed local TRS, that override has
    // served the same purpose as the pin's raw local matrix and must be
    // cleared before the observable TRS becomes authoritative.
    record.outer_position = Vec3{};
    record.outer_rotation = Vec3{};
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
    // Static glTF leaves have their node world baked into their vertices.
    // A newly live parent therefore belongs in the draw-world matrix rather
    // than in another CPU vertex bake.
    record.gpu_world_transform = true;
}

std::array<float, 16> parenting_world_matrix(
    const Engine& engine,
    const MeshRecord& record) {
    const std::array<float, 16> local_world =
        upstream::mesh_world_matrix(engine, record);
    if (
        record.outer_position.x == 0.0f &&
        record.outer_position.y == 0.0f &&
        record.outer_position.z == 0.0f &&
        record.outer_rotation.x == 0.0f &&
        record.outer_rotation.y == 0.0f &&
        record.outer_rotation.z == 0.0f) {
        return local_world;
    }

    // Asset-root position/rotation is an outer scene-node transform in the
    // flattened loader. Fold it into the snapshot before clearing it, so
    // reparenting after addToScene preserves the same visible world.
    MeshRecord outer;
    outer.position = Vec3d{
        record.outer_position.x,
        record.outer_position.y,
        record.outer_position.z};
    outer.rotation = record.outer_rotation;
    const std::array<float, 16> outer_world =
        upstream::mesh_local_matrix(outer);
    std::array<float, 16> result{};
    mat4_multiply_into(result, 0, outer_world, 0, local_world, 0);
    return result;
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
            engine.transform_nodes[child_record.transform_parent.value];
        unlink_child_links(
            old_parent.children, old_parent.parented_meshes, child);
    }
    if (child_record.parent.value < engine.meshes.size()) {
        MeshRecord& old_parent = engine.meshes[child_record.parent.value];
        unlink_child_links(
            old_parent.children, old_parent.parented_meshes, child);
    }
}

void link_parent(
    Engine& engine,
    MeshHandle child,
    MeshHandle parent) {
    if (parent.value >= engine.meshes.size()) return;
    MeshRecord& new_parent = engine.meshes[parent.value];
    link_child_links(
        new_parent.children, new_parent.parented_meshes, child);
}

void link_parent(
    Engine& engine,
    MeshHandle child,
    TransformNodeHandle parent) {
    if (parent.value >= engine.transform_nodes.size()) return;
    TransformNodeRecord& new_parent = engine.transform_nodes[parent.value];
    link_child_links(
        new_parent.children, new_parent.parented_meshes, child);
}

void apply_preserved_parent_local(
    Engine& engine,
    MeshHandle child,
    const std::array<float, 16>& child_world,
    const std::optional<std::array<float, 16>>& parent_world) {
    MeshRecord& child_record = engine.meshes[child.value];
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
        child_record.outer_position = Vec3{};
        child_record.outer_rotation = Vec3{};
        child_record.gpu_world_transform = true;
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

} // namespace

// ${this.context.provenance("src/scene/set-parent.ts", "setParent")}
void set_mesh_parent(
    Engine& engine,
    MeshHandle child,
    MeshHandle parent) {
    MeshRecord& child_record = engine.meshes.at(child.value);
    // setParent snapshots the old world before touching either parent link.
    // The local TRS written below therefore preserves the visible transform,
    // including a mirrored signed scale, across attach and detach.
    const std::array<float, 16> child_world =
        parenting_world_matrix(engine, child_record);
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
        parenting_world_matrix(engine, engine.meshes[parent.value]);
    apply_preserved_parent_local(
        engine, child, child_world, parent_world);
}

void set_mesh_parent(
    Engine& engine,
    MeshHandle child,
    TransformNodeHandle parent) {
    MeshRecord& child_record = engine.meshes.at(child.value);
    const std::array<float, 16> child_world =
        parenting_world_matrix(engine, child_record);
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

void set_asset_root_parent(
    Engine& engine,
    AssetHandle child,
    TransformNodeHandle parent) {
    if (child.value >= engine.assets.size()) {
        throw std::runtime_error("Invalid imported root handle.");
    }
    // The loader intentionally flattens imported hierarchy nodes. Reparent
    // every rendered leaf as one operation; each leaf snapshots its own
    // current world, so their relative arrangement is preserved exactly.
    for (const MeshHandle mesh : engine.assets[child.value].meshes) {
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
    return engine.hierarchy_instance_pools[handle.value];
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
        MeshRecord& mesh = engine.meshes.at(binding.mesh.value);
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
    pool.meshes = engine.assets[root_handle.value].meshes;
    if (pool.meshes.empty()) {
        throw std::runtime_error(
            "createHierarchyInstancePool requires at least one mesh in the source hierarchy");
    }
    pool.bindings.reserve(pool.meshes.size());
    for (const MeshHandle handle : pool.meshes) {
        MeshRecord& mesh = engine.meshes.at(handle.value);
        if (mesh.thin_instanced) {
            throw std::runtime_error(
                "createHierarchyInstancePool source mesh already has thin instances");
        }
        const std::array<float, 16> mesh_world =
            mesh.instance_parent_matrix;
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
        MeshRecord& mesh = engine.meshes.at(mesh_handle.value);
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
            MeshRecord& mesh = engine.meshes.at(mesh_handle.value);
            mesh.instance_matrices[index] = mesh.instance_matrices[last];
        }
    }
    set_hierarchy_instance_count(
        engine, handle, static_cast<double>(last));
}
`
      : "";
    const geometryAccessSource = options.geometryAccess
      ? `
// src/mesh/mesh.ts retained CPU arrays. The native geometry record retains
// every lane the pin exposes, and these copies preserve typed-array value
// semantics for scene code that only reads them.
std::vector<float> mesh_cpu_positions(
    const Engine& engine,
    MeshHandle mesh) {
    const ModelGeometry& geometry =
        engine.geometries.at(engine.meshes.at(mesh.value).geometry);
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
        engine.geometries.at(engine.meshes.at(mesh.value).geometry);
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
        engine.geometries.at(engine.meshes.at(mesh.value).geometry);
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
        engine.meshes.at(mesh.value).geometry).indices;
}

js::Array<double> mesh_world_matrix_array(
    const Engine& engine,
    MeshHandle mesh) {
    const std::array<float, 16> world =
        upstream::mesh_world_matrix(engine, engine.meshes.at(mesh.value));
    return js::Array<double>(world.begin(), world.end());
}

js::Array<double> mesh_bound_min_array(
    const Engine& engine,
    MeshHandle mesh) {
    const MeshRecord& record = engine.meshes.at(mesh.value);
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
    const MeshRecord& record = engine.meshes.at(mesh.value);
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
    const fogSource = options.fog
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
    scene.fog_mode = mode;
    scene.fog_density = density;
    scene.fog_start = start;
    scene.fog_end = end;
    scene.fog_color = color;
}
`
      : "";
    const clipPlaneSource = options.clipPlane
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
    const vatSeek = options.vat
      ? `
    if (!scene.seeks_vat) {
        scene.seeks_vat = true;
        Engine* engine = scene.engine;
        scene.animation_seekers.push_back(
            [engine](float time) { seek_vat(*engine, time); });
    }`
      : "";
    const managerSeek = options.managedAnimationGroups
      ? `
    if (!scene.seeks_animation_managers) {
        scene.seeks_animation_managers = true;
        Engine* engine = scene.engine;
        scene.animation_seekers.push_back(
            [engine](float time) {
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
    return {
      modulePath,
      symbolName: `${createName},${addName},cloneTransformNode,removeFromScene,${beforeName},${disposeName},${registerName}${options.fog ? `,${fogName}` : ""}${options.clipPlane ? `,${clipPlaneName}` : ""}`,
      header: "",
      source: `// ${this.context.provenance(modulePath, `${createName}, ${addName}, ${beforeName}, ${disposeName}, ${registerName}`, `${transformNodeModulePath}#cloneTransformNode, cloneMeshNode`)}
#include <bblite/runtime.hpp>
#include <bblite/upstream/pinned_matrix.hpp>
${options.geometryAccess || options.parenting ? "#include <bblite/js_data.hpp>" : ""}
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
    const MaterialHandle material = engine.meshes[mesh.value].material;
    if (material.value >= engine.materials.size()) return 0;
    const MaterialRecord& record = engine.materials[material.value];
    if (record.grid_material) return material_family_grid;
    if (record.shader_material) return material_family_shader;
    if (record.standard_material) return material_family_standard;
    return material_family_pbr;
}

std::uint32_t scene_material_families(const Scene& scene) {
    std::uint32_t result = 0;
    for (const MeshHandle mesh : scene.meshes) {
        result |= material_family_bit(*scene.engine, mesh);
    }
    return result;
}

} // namespace

Scene create_scene_context(Engine& engine) {
    Scene scene;
    scene.engine = &engine;
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
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
    if (canvas.value < engine.ui_elements.size()) {
        engine.ui_elements[canvas.value].client_rect_requested = true;
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

void add_to_scene(Scene& scene, MeshHandle mesh) {
    require_scene_engine(scene);
    if (mesh.value >= scene.engine->meshes.size()) {
        throw std::runtime_error(
            "Invalid mesh handle " + std::to_string(mesh.value) +
            " for " + std::to_string(scene.engine->meshes.size()) +
            " meshes.");
    }
    if (scene.engine->meshes[mesh.value].retired) {
        throw std::runtime_error(
            "Mesh '" + scene.engine->meshes[mesh.value].name +
            "' was removed from the scene and its geometry reclaimed; "
            "re-adding a removed mesh is outside the reached subset.");
    }
    scene.meshes.push_back(mesh);
    ++scene.render_topology_version;
    scene.material_family_mask |=
        material_family_bit(*scene.engine, mesh);
}

// A static glTF mesh normally bakes its node world into each vertex. Once
// scene code replaces that node's quaternion, those baked vertices would
// rotate around the flattened asset origin. Recover the node translation and
// scale retained by the loader, route the draw through the local vertex lanes,
// and let the caller install the replacement rotation immediately afterward.
void prepare_imported_mesh_quaternion_write(
    Engine& engine,
    MeshHandle mesh) {
    if (mesh.value >= engine.meshes.size()) {
        throw std::runtime_error("Invalid imported mesh handle.");
    }
    MeshRecord& record = engine.meshes[mesh.value];
    if (
        record.name.rfind("wheel", 0) != 0 ||
        record.live_imported_transform ||
        record.geometry >= engine.geometries.size() ||
        engine.geometries[record.geometry].vertex_space !=
            VertexSpace::world) {
        return;
    }
    const std::array<float, 16>& matrix =
        record.instance_parent_matrix;
    record.position = Vec3d{
        matrix[12], matrix[13], matrix[14]};
    const auto column_length = [&matrix](std::size_t column) {
        const std::size_t lane = column * 4;
        return std::sqrt(
            matrix[lane] * matrix[lane] +
            matrix[lane + 1] * matrix[lane + 1] +
            matrix[lane + 2] * matrix[lane + 2]);
    };
    record.scaling = Vec3{
        column_length(0),
        column_length(1),
        column_length(2)};
    record.rotation = Vec3{};
    record.has_rotation_quaternion = false;
    record.gpu_world_transform = true;
    record.live_imported_transform = true;
    ++record.transform_version;
}

void set_mesh_rotation_quaternion(
    Engine& engine,
    MeshHandle mesh,
    Vec4 quaternion,
    bool runtime_transform) {
    prepare_imported_mesh_quaternion_write(engine, mesh);
    MeshRecord& record = engine.meshes[mesh.value];
    if (record.live_imported_transform) {
        // The loader mirrors glTF's local X coordinate before retaining the
        // wheel vertices. Conjugating a rotation by that reflection keeps
        // X-axis roll unchanged and reverses Y/Z rotation into the same
        // basis, so steering and combined steer+roll remain coherent.
        quaternion.y = -quaternion.y;
        quaternion.z = -quaternion.z;
    }
    record.rotation_quaternion = quaternion;
    record.has_rotation_quaternion = true;
    if (runtime_transform) {
        mark_mesh_runtime_transform(engine, mesh);
    } else {
        mark_mesh_dirty(engine, mesh);
    }
}

// The pin's removeFromScene drops the mesh from the scene list and lets the
// JavaScript collector free its arrays once nothing else holds them. A
// streaming world retires meshes continuously -- a voxel chunk mesh is a
// megabyte of vertices, and one sprint retires hundreds -- so the removal
// frees the CPU geometry here, when no other mesh record shares it. The
// handle stays valid; only a later add_to_scene of the same mesh refuses.
void reclaim_unshared_geometry(Engine& engine, MeshHandle mesh) {
    MeshRecord& record = engine.meshes[mesh.value];
    const std::uint32_t geometry = record.geometry;
    if (geometry == invalid_handle || geometry >= engine.geometries.size()) {
        return;
    }
    record.retired = true;
    ModelGeometry& shared = engine.geometries[geometry];
    if (shared.owners > 1) {
        --shared.owners;
        return;
    }
    release_geometry_storage(shared);
}

// src/scene/scene-remove.ts removeFromScene: drop the mesh from the
// scene list and mark the topology dirty (the pinned helper is
// idempotent — removing a mesh the scene never held is a no-op). The
// material-family mask stays monotonic: it gates which pipelines the
// backend created, and a removal never invalidates one.
void remove_from_scene(Scene& scene, MeshHandle mesh) {
    require_scene_engine(scene);
    const auto found = std::find_if(
        scene.meshes.begin(),
        scene.meshes.end(),
        [mesh](const MeshHandle candidate) {
            return candidate.value == mesh.value;
        });
    if (found == scene.meshes.end()) return;
    scene.meshes.erase(found);
    ++scene.render_topology_version;
    reclaim_unshared_geometry(*scene.engine, mesh);
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
    if (light.value < scene.engine->lights.size()) {
        const LightRecord& record = scene.engine->lights[light.value];
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

AssetRecord& asset_record(Engine& engine, std::uint32_t asset) {
    if (asset >= engine.assets.size()) {
        throw std::runtime_error("Invalid asset handle.");
    }
    return engine.assets[asset];
}

}  // namespace

/**
 * src/scene/transform-node.ts cloneTransformNode/cloneMeshNode over the
 * imported synthetic root. Native loading has flattened the hierarchy, so
 * the clone is a mesh-only AssetRecord: distinct mesh wrappers sharing the
 * source geometry/material state, without the container's animation groups,
 * tick, camera, lights or scene setup. The source runtime callback mirrors
 * the retained skeleton resource by registering each skinned wrapper against
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
    clone.root_position = source.root_position;
    clone.root_rotation = source.root_rotation;
    clone.root_scaling_reset = source.root_scaling_reset;
    clone.clone_mesh_animation = clone_animation;
    clone.meshes.reserve(source_meshes.size());
    for (const MeshHandle source_mesh : source_meshes) {
        if (source_mesh.value >= engine.meshes.size()) {
            throw std::runtime_error("Invalid mesh handle in imported root.");
        }
        MeshRecord record = engine.meshes[source_mesh.value];
        if (record.geometry < engine.geometries.size()) {
            ++engine.geometries[record.geometry].owners;
        }
        record.name += "${cloneSuffix}";
        record.feature_source_mesh =
            record.feature_source_mesh != invalid_handle
                ? record.feature_source_mesh
                : source_mesh.value;
        const MeshHandle cloned_mesh{
            static_cast<std::uint32_t>(engine.meshes.size())};
        engine.meshes.push_back(std::move(record));
        clone.meshes.push_back(cloned_mesh);
        if (clone_animation) {
            clone_animation(source_mesh, cloned_mesh);
        }
    }
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
    if (engine.meshes[mesh.value].retired) {
        throw std::runtime_error(
            "Mesh '" + engine.meshes[mesh.value].name +
            "' cannot be cloned: it was disposed when it left its last "
            "scene.");
    }
    if (!engine.meshes[mesh.value].children.empty()) {
        throw std::runtime_error(
            "Mesh '" + engine.meshes[mesh.value].name +
            "' has children; the pin clones a node's children recursively "
            "and no reached scene clones a parented mesh.");
    }
    MeshRecord record = engine.meshes[mesh.value];
    if (record.geometry < engine.geometries.size()) {
        ++engine.geometries[record.geometry].owners;
    }
    record.name += "${cloneSuffix}";
    record.parented_meshes.clear();
    record.feature_source_mesh =
        record.feature_source_mesh != invalid_handle
            ? record.feature_source_mesh
            : mesh.value;
    const MeshHandle clone{
        static_cast<std::uint32_t>(engine.meshes.size())};
    engine.meshes.push_back(std::move(record));
    return clone;
}

void set_asset_root_position_component(
    Engine& engine,
    AssetHandle asset,
    std::size_t component,
    float value) {
    AssetRecord& root = asset_record(engine, asset.value);
    const auto component_ref = [component](Vec3& vector) -> float& {
        switch (component) {
            case 0: return vector.x;
            case 1: return vector.y;
            case 2: return vector.z;
            default:
                throw std::runtime_error(
                    "Imported root position component is out of range.");
        }
    };
    float& root_component = component_ref(root.root_position);
    const float delta = value - root_component;
    root_component = value;
    for (const MeshHandle mesh : root.meshes) {
        if (mesh.value >= engine.meshes.size()) {
            throw std::runtime_error("Invalid mesh handle in imported root.");
        }
        MeshRecord& record = engine.meshes[mesh.value];
        component_ref(record.outer_position) += delta;
        mark_mesh_dirty(engine, mesh);
    }
}

void set_asset_root_rotation_component(
    Engine& engine,
    AssetHandle asset,
    std::size_t component,
    float value) {
    AssetRecord& root = asset_record(engine, asset.value);
    const auto component_ref = [component](Vec3& vector) -> float& {
        switch (component) {
            case 0: return vector.x;
            case 1: return vector.y;
            case 2: return vector.z;
            default:
                throw std::runtime_error(
                    "Imported root rotation component is out of range.");
        }
    };
    float& root_component = component_ref(root.root_rotation);
    const float delta = value - root_component;
    root_component = value;
    for (const MeshHandle mesh : root.meshes) {
        if (mesh.value >= engine.meshes.size()) {
            throw std::runtime_error("Invalid mesh handle in imported root.");
        }
        MeshRecord& record = engine.meshes[mesh.value];
        component_ref(record.outer_rotation) += delta;
        mark_mesh_dirty(engine, mesh);
    }
}

void set_asset_root_position(
    Engine& engine,
    AssetHandle asset,
    Vec3 value) {
    AssetRecord& root = asset_record(engine, asset.value);
    const Vec3 delta{
        value.x - root.root_position.x,
        value.y - root.root_position.y,
        value.z - root.root_position.z};
    root.root_position = value;
    for (const MeshHandle mesh : root.meshes) {
        if (mesh.value >= engine.meshes.size()) {
            throw std::runtime_error("Invalid mesh handle in imported root.");
        }
        MeshRecord& record = engine.meshes[mesh.value];
        record.outer_position.x += delta.x;
        record.outer_position.y += delta.y;
        record.outer_position.z += delta.z;
        mark_mesh_dirty(engine, mesh);
    }
}

void set_asset_root_rotation(
    Engine& engine,
    AssetHandle asset,
    Vec3 value) {
    AssetRecord& root = asset_record(engine, asset.value);
    const Vec3 delta{
        value.x - root.root_rotation.x,
        value.y - root.root_rotation.y,
        value.z - root.root_rotation.z};
    root.root_rotation = value;
    for (const MeshHandle mesh : root.meshes) {
        if (mesh.value >= engine.meshes.size()) {
            throw std::runtime_error("Invalid mesh handle in imported root.");
        }
        MeshRecord& record = engine.meshes[mesh.value];
        record.outer_rotation.x += delta.x;
        record.outer_rotation.y += delta.y;
        record.outer_rotation.z += delta.z;
        mark_mesh_dirty(engine, mesh);
    }
}

void reset_asset_root_scaling(
    Engine& engine,
    AssetHandle asset) {
    AssetRecord& root = asset_record(engine, asset.value);
    if (root.root_scaling_reset) return;
    root.root_scaling_reset = true;
    for (const MeshHandle mesh : root.meshes) {
        if (mesh.value >= engine.meshes.size()) {
            throw std::runtime_error("Invalid mesh handle in imported root.");
        }
        MeshRecord& record = engine.meshes[mesh.value];
        // load-gltf.ts creates the public synthetic root with scale (-1,1,1).
        // Native glTF matrices fold that root convention into the leading X
        // reflection. Replacing its scale with identity therefore removes the
        // reflection by multiplying the recorded parent world on the left.
        for (std::size_t column = 0; column < 4; ++column) {
            record.instance_parent_matrix[column * 4] =
                -record.instance_parent_matrix[column * 4];
        }
        mark_mesh_dirty(engine, mesh);
    }
}

void add_to_scene(Scene& scene, AssetHandle asset) {
    require_scene_engine(scene);
    const AssetRecord& record =
        asset_record(*scene.engine, asset.value);
    for (const MeshHandle mesh : record.meshes) add_to_scene(scene, mesh);
    for (const LightHandle light : record.lights) add_to_scene(scene, light);
    // addToScene registers the file's animation groups with the scene, which
    // is what makes them reachable as scene.animationGroups.
    for (const AnimationGroupHandle group : record.animation_groups) {
        scene.animation_groups.push_back(group);
    }
    if (record.scene_setup) record.scene_setup(scene);
    if (record.has_camera) scene.camera = record.camera;
    if (record.has_clear_color) scene.clear_color = record.clear_color;
    if (record.animation_tick) {
        scene.before_render.push_back(record.animation_tick);
    }
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
void add_asset_entities(Scene& scene, AssetHandle asset) {
    require_scene_engine(scene);
    const AssetRecord& record =
        asset_record(*scene.engine, asset.value);
    for (const MeshHandle mesh : record.meshes) add_to_scene(scene, mesh);
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
                ${options.transformNodes
                  ? "add_to_scene(scene, concrete);"
                  : 'throw std::runtime_error("No transform-node factory is reached by this scene.");'}
            } else {
                add_to_scene(scene, concrete);
            }
        },
        node);
}

void on_before_render(
    Scene& scene,
    std::function<void(float)> callback) {
    scene.before_render.insert(
        scene.before_render.begin(),
        std::move(callback));
}

void on_scene_dispose(
    Scene& scene,
    std::function<void()> callback) {
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
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
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

void register_scene(Scene& scene) {
    require_scene_engine(scene);${managerSeek}${vatSeek}
    for (const auto& builder : scene.deferred_builders) {
        builder();
    }
    scene.deferred_builders.clear();
    scene.material_family_mask = scene_material_families(scene);
    const auto found = std::find_if(
        scene.engine->registered_scenes.begin(),
        scene.engine->registered_scenes.end(),
        [&scene](const std::shared_ptr<Scene>& registered) {
            return registered && registered->shares_identity(scene);
        });
    if (found == scene.engine->registered_scenes.end()) {
        scene.engine->registered_scenes.push_back(
            std::make_shared<Scene>(scene));
    }
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
    scene.meshes.clear();
    scene.lights.clear();
    scene.tasks.clear();
    scene.pending_shadow_retirements.clear();
    scene.animation_groups.clear();
    scene.billboard_systems.clear();
    scene.depth_hosted_sprite_layers.clear();
    scene.splat_meshes.clear();
    scene.before_render.clear();
    scene.animation_seekers.clear();
    scene.deferred_builders.clear();
    scene.camera = {};
}

void rebuild_scene_renderables(Scene& scene) {
    require_scene_engine(scene);
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
                    scene.engine->lights[light.value]
                            .shadow_generator.value == generator.value;
            });
        if (still_active) continue;
        ShadowGeneratorRecord& shadow =
            scene.engine->shadow_generators[generator.value];
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
    scene.topology_rebuild_pending = false;
    ++scene.render_topology_version;
}

void enable_scene_transmission(Scene& scene) {
    require_scene_engine(scene);
    scene.transmission_enabled = true;
}
${fogSource}${clipPlaneSource}${meshDirtySource}${visibilitySource}${transformNodeSource}${mirroredSource}${parentingSource}${geometryAccessSource}
${options.sceneNodeTransforms ? sceneNodeTransformsSource(options.transformNodes === true) : ""}
} // namespace bbl
`,
    };
  }
}
