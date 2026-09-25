/**
 * The pin's glTF node hierarchy, packaged for a scene that writes SceneNode
 * transforms.
 *
 * `buildNodeHierarchy` (load-gltf.ts) builds one TransformNode per glTF node
 * -- from its TRS, or from its raw `matrix` through createSceneNodeFromMatrix,
 * which locks TRS writes out -- under a synthetic `__root__`, and hangs each
 * primitive's mesh under its node with an identity TRS. A scene that moves
 * nodes moves everything beneath them, so the loader carries the whole tree
 * rather than flattening it onto the meshes. Every value here is read off the
 * pin's live nodes, after addToScene linked their parents.
 */
import { asIndex, asObject } from "./gltf-document.js";
import type { GltfGeometryPacker } from "./gltf-mesh-geometry.js";

/** A node's TRS lanes, as the pin's observable vectors hold them. */
interface GltfNodeTransform {
    translation: [number, number, number];
    rotation: [number, number, number, number];
    scaling: [number, number, number];
}

/** One glTF node the pin built. */
interface GltfHierarchyNode extends GltfNodeTransform {
    /** The pin's node name: `node.name ?? node_<index>`. */
    name: string;
    /** The parent's glTF node index, or -1 under the synthetic root. */
    parent: number;
    /** A `matrix` node's raw local (a 4-column accessor), which TRS does not drive. */
    matrix?: number;
    /** `_localMatrixLocked`: TRS writes leave the raw local in force. */
    locked: boolean;
}

export interface GltfNodeHierarchy {
    /** The synthetic `__root__`'s own TRS. */
    root: GltfNodeTransform;
    /** The root's children, the scene's root nodes, in the pin's order. */
    rootChildren: number[];
    /** By glTF node index; null for a node the scene does not reach. */
    nodes: Array<GltfHierarchyNode | null>;
}

interface RecordedNode {
    name?: unknown;
    position?: { x?: unknown; y?: unknown; z?: unknown };
    rotationQuaternion?: { x?: unknown; y?: unknown; z?: unknown; w?: unknown };
    scaling?: { x?: unknown; y?: unknown; z?: unknown };
    _localMatrix?: unknown;
    _localMatrixLocked?: unknown;
    parent?: unknown;
    children?: unknown;
}

function finite(values: unknown[]): number[] {
    if (
        !values.every(
            (value): value is number =>
                typeof value === "number" && Number.isFinite(value),
        )
    )
        throw new Error("Invalid constructed glTF node transform.");
    return values;
}

function transform(node: RecordedNode): GltfNodeTransform {
    const { position: p, rotationQuaternion: q, scaling: s } = node;
    if (!p || !q || !s)
        throw new Error("Invalid constructed glTF node transform.");
    const [px, py, pz] = finite([p.x, p.y, p.z]);
    const [qx, qy, qz, qw] = finite([q.x, q.y, q.z, q.w]);
    const [sx, sy, sz] = finite([s.x, s.y, s.z]);
    return {
        translation: [px!, py!, pz!],
        rotation: [qx!, qy!, qz!, qw!],
        scaling: [sx!, sy!, sz!],
    };
}

/** Package the live hierarchy the pin's loader built and addToScene linked. */
export function packageNodeHierarchy(
    root: object,
    nodeMap: readonly (object | undefined)[],
    packer: GltfGeometryPacker,
): GltfNodeHierarchy {
    const indices = new Map<unknown, number>();
    nodeMap.forEach((node, index) => {
        if (node) indices.set(node, index);
    });
    const indexOf = (node: unknown): number => {
        const index = indices.get(node);
        if (index === undefined)
            throw new Error("Constructed glTF hierarchy left its node map.");
        return index;
    };
    const rootNode: RecordedNode = root;
    if (
        rootNode._localMatrix !== undefined ||
        !Array.isArray(rootNode.children)
    )
        throw new Error("Unrepresented constructed glTF root.");
    return {
        root: transform(rootNode),
        rootChildren: rootNode.children.map(indexOf),
        nodes: nodeMap.map((value) => {
            if (value === undefined) return null;
            const node: RecordedNode = value;
            if (typeof node.name !== "string")
                throw new Error("Invalid constructed glTF node name.");
            const matrix = node._localMatrix;
            if (
                matrix !== undefined &&
                !(Array.isArray(matrix) && matrix.length === 16)
            )
                throw new Error("Invalid constructed glTF node matrix.");
            return {
                name: node.name,
                parent: node.parent === root ? -1 : indexOf(node.parent),
                ...transform(node),
                ...(matrix === undefined
                    ? {}
                    : {
                          matrix: packer.float32(
                              Float32Array.from(finite(matrix)),
                              4,
                          ),
                      }),
                locked: node._localMatrixLocked === true,
            };
        }),
    };
}

function lanes(value: unknown, length: number): number[] | undefined {
    if (!Array.isArray(value) || value.length !== length) return undefined;
    return value.every(
        (lane): lane is number =>
            typeof lane === "number" && Number.isFinite(lane),
    )
        ? value
        : undefined;
}

function readTransform(value: unknown): GltfNodeTransform {
    const node = asObject(value);
    const translation = lanes(node?.translation, 3),
        rotation = lanes(node?.rotation, 4),
        scaling = lanes(node?.scaling, 3);
    if (!translation || !rotation || !scaling)
        throw new Error("Invalid packaged glTF node transform.");
    return {
        translation: [translation[0]!, translation[1]!, translation[2]!],
        rotation: [rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!],
        scaling: [scaling[0]!, scaling[1]!, scaling[2]!],
    };
}

/** Read and validate a packaged hierarchy against its document. */
export function readNodeHierarchy(
    value: unknown,
    nodeCount: number,
    accessorCount: number,
): GltfNodeHierarchy {
    const hierarchy = asObject(value);
    const rootChildren = hierarchy?.rootChildren;
    if (
        !hierarchy ||
        !Array.isArray(rootChildren) ||
        !rootChildren.every((index) => {
            const node = asIndex(index);
            return node !== undefined && node < nodeCount;
        }) ||
        !Array.isArray(hierarchy.nodes) ||
        hierarchy.nodes.length !== nodeCount
    )
        throw new Error("Invalid packaged glTF node hierarchy.");
    const nodes = hierarchy.nodes.map((entry): GltfHierarchyNode | null => {
        if (entry === null) return null;
        const node = asObject(entry);
        const parent = node?.parent;
        const matrix = node?.matrix;
        if (
            !node ||
            typeof node.name !== "string" ||
            typeof node.locked !== "boolean" ||
            typeof parent !== "number" ||
            !Number.isInteger(parent) ||
            parent < -1 ||
            parent >= nodeCount ||
            (matrix !== undefined &&
                (asIndex(matrix) === undefined ||
                    (asIndex(matrix) ?? accessorCount) >= accessorCount))
        )
            throw new Error("Invalid packaged glTF hierarchy node.");
        return {
            name: node.name,
            parent,
            ...readTransform(node),
            ...(matrix === undefined ? {} : { matrix: asIndex(matrix)! }),
            locked: node.locked,
        };
    });
    return {
        root: readTransform(hierarchy.root),
        rootChildren: rootChildren.map((index) => asIndex(index)!),
        nodes,
    };
}
