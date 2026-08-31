import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import {
  lowerMat4InvertCpp,
  lowerMat4MultiplyWriterCpp,
} from "./pinned-function-lowerer.js";
import { lowerMat4DecomposeFull } from "./pinned-mat4-decompose.js";

export class SceneLowerer {
  public constructor(private readonly context: LoweringContext) {}

  public lowerCore(
    options: {
      fog?: boolean;
      /** The scene reaches `enableMirroredMeshes`. */
      mirroredMeshes?: boolean;
      parenting?: boolean;
      visibility?: boolean;
      geometryAccess?: boolean;
      managedAnimationGroups?: boolean;
      /** The scene reaches `createTransformNode`. */
      transformNodes?: boolean;
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
`;
    const visibilitySource = options.visibility
      ? `
// ${this.context.provenance("src/scene/visibility.ts", "setSubtreeVisible")}
void set_mesh_visible(
    Engine& engine,
    MeshHandle mesh,
    bool visible) {
    MeshRecord& record = engine.meshes.at(mesh.value);
    record.visible = visible;
    for (const MeshHandle child : record.children) {
        set_mesh_visible(engine, child, visible);
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
    Vec3d position) {
    engine.transform_nodes[node.value].position = position;
    mark_transform_node_dirty(engine, node);
}

void set_transform_node_scaling(
    Engine& engine,
    TransformNodeHandle node,
    Vec3 scaling) {
    engine.transform_nodes[node.value].scaling = scaling;
    mark_transform_node_dirty(engine, node);
}

void set_transform_node_rotation_quaternion(
    Engine& engine,
    TransformNodeHandle node,
    Vec4 rotation) {
    TransformNodeRecord& record = engine.transform_nodes[node.value];
    record.rotation_quaternion = rotation;
    record.has_rotation_quaternion = true;
    mark_transform_node_dirty(engine, node);
}

// The parent SETTER is the pin's own _addChild trigger: it registers the
// child for invalidation, where the children array is only the traversal
// list. Registering here rather than at that array's push is what makes a
// scene which writes the link and never pushes still follow its parent.
void set_mesh_transform_parent(
    Engine& engine,
    MeshHandle mesh,
    TransformNodeHandle parent) {
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

void push_transform_node_child(
    Engine& engine,
    TransformNodeHandle node,
    MeshHandle child) {
    engine.transform_nodes[node.value].children.push_back(child);
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
    Scene* const watched = &scene;
    scene.before_render.push_back([watched](float) {
        Engine& owner = *watched->engine;
        if (upstream::refresh_mirrored_meshes(*watched, owner)) {
            // frontFace is baked into the pipeline object, so a flip goes
            // through a rebuild. The pin raises enqueueMaterialSwap for
            // it; here the render plan is where a pipeline is
            // chosen, and its membership version is what rebuilds it.
            ++watched->render_topology_version;
        }
    });
}
`
      : "";
    const parentMatrixHelpers = options.parenting
      ? [
          lowerMat4MultiplyWriterCpp(this.context),
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

void unlink_child_links(
    std::vector<MeshHandle>& children,
    std::vector<MeshHandle>& registered,
    MeshHandle child) {
    children.erase(
        std::remove(children.begin(), children.end(), child),
        children.end());
    registered.erase(
        std::remove(registered.begin(), registered.end(), child),
        registered.end());
}

void link_child_links(
    std::vector<MeshHandle>& children,
    std::vector<MeshHandle>& registered,
    MeshHandle child) {
    if (std::find(children.begin(), children.end(), child) == children.end()) {
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
    js::F32Array result;
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
    js::F32Array result;
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
    js::F32Array result;
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
    if (record.has_bounds_min_override) bounds = record.bounds_min_override;
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
    if (record.has_bounds_max_override) bounds = record.bounds_max_override;
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
      symbolName: `${createName},${addName},cloneTransformNode,removeFromScene,${beforeName},${disposeName},${registerName}${options.fog ? `,${fogName}` : ""}`,
      header: "",
      source: `// ${this.context.provenance(modulePath, `${createName}, ${addName}, ${beforeName}, ${disposeName}, ${registerName}`, `${transformNodeModulePath}#cloneTransformNode, cloneMeshNode`)}
#include <bblite/runtime.hpp>
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

void add_to_scene(Scene& scene, MeshHandle mesh) {
    require_scene_engine(scene);
    if (mesh.value >= scene.engine->meshes.size()) throw std::runtime_error("Invalid mesh handle.");
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
    clone.clone_mesh_animation = clone_animation;
    clone.meshes.reserve(source_meshes.size());
    for (const MeshHandle source_mesh : source_meshes) {
        if (source_mesh.value >= engine.meshes.size()) {
            throw std::runtime_error("Invalid mesh handle in imported root.");
        }
        MeshRecord record = engine.meshes[source_mesh.value];
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
    std::function<void(const PlatformKeyboardEvent&)> callback) {
    engine.key_down_callbacks.push_back(std::move(callback));
}

void on_key_up(
    Engine& engine,
    std::function<void(const PlatformKeyboardEvent&)> callback) {
    engine.key_up_callbacks.push_back(std::move(callback));
}

void on_pointer_down(
    Engine& engine,
    std::function<void()> callback) {
    engine.pointer_down_callbacks.push_back(std::move(callback));
}

void on_mouse_down(
    Engine& engine,
    std::function<void(const PlatformMouseEvent&)> callback) {
    engine.mouse_down_callbacks.push_back(std::move(callback));
}

void on_mouse_up(
    Engine& engine,
    std::function<void(const PlatformMouseEvent&)> callback) {
    engine.mouse_up_callbacks.push_back(std::move(callback));
}

void on_mouse_move(
    Engine& engine,
    std::function<void(const PlatformMouseEvent&)> callback) {
    engine.mouse_move_callbacks.push_back(std::move(callback));
}

void on_mouse_wheel(
    Engine& engine,
    std::function<void(const PlatformMouseEvent&)> callback) {
    engine.mouse_wheel_callbacks.push_back(std::move(callback));
}

void on_mouse_cancel(
    Engine& engine,
    std::function<void(const PlatformMouseEvent&)> callback) {
    engine.mouse_cancel_callbacks.push_back(std::move(callback));
}

void on_window_resize(
    Engine& engine,
    std::function<void()> callback) {
    engine.window_resize_callbacks.push_back(std::move(callback));
}

void on_pointer_lock_change(
    Engine& engine,
    std::function<void()> callback) {
    engine.pointer_lock_change_callbacks.push_back(std::move(callback));
}

void request_pointer_lock(Engine& engine) {
    engine.pointer_lock_requested = true;
}

void exit_pointer_lock(Engine& engine) {
    engine.pointer_lock_requested = false;
}

void on_visibility_change(
    Engine& engine,
    std::function<void(bool)> callback) {
    engine.visibility_change_callbacks.push_back(std::move(callback));
}

void register_scene(Scene& scene) {
    require_scene_engine(scene);${managerSeek}
    for (const auto& builder : scene.deferred_builders) {
        builder();
    }
    scene.deferred_builders.clear();
    scene.material_family_mask = scene_material_families(scene);
    const auto found = std::find(
        scene.engine->registered_scenes.begin(),
        scene.engine->registered_scenes.end(),
        &scene);
    if (found == scene.engine->registered_scenes.end()) {
        scene.engine->registered_scenes.push_back(&scene);
    }
}

void unregister_scene(Scene& scene) {
    require_scene_engine(scene);
    scene.engine->registered_scenes.erase(
        std::remove(
            scene.engine->registered_scenes.begin(),
            scene.engine->registered_scenes.end(),
            &scene),
        scene.engine->registered_scenes.end());
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
        const TaskHandle task = shadow.task;
        scene.tasks.erase(
            std::remove_if(
                scene.tasks.begin(),
                scene.tasks.end(),
                [task](const TaskHandle candidate) {
                    return candidate.value == task.value;
                }),
            scene.tasks.end());
        shadow.task = TaskHandle{};
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
${fogSource}${meshDirtySource}${visibilitySource}${transformNodeSource}${mirroredSource}${parentingSource}${geometryAccessSource}
} // namespace bbl
`,
    };
  }
}
