/**
 * The pinned `KHR_interactivity` parser, executed at generation.
 *
 * A flow graph is asset data: `gltf-feature-interactivity.ts` reads the
 * extension off the glTF document and hands each graph to
 * `parseInteractivityGraph`, which maps every glTF operation to a Lite block
 * through the declaration mapper, types each socket from the graph's own
 * type table, resolves the constant pointer templates and wires the data
 * and flow edges. None of that depends on the scene or the engine, and all
 * of it is the part of the subsystem the pin's own docs call spec-volatile
 * (`51-flow-graph.md`, "keep the translation layer isolated") -- so this port
 * runs the pin's parser rather than restating its op table, and lowers the
 * graph it produced (`src/lowering/flow-graph-lowerer.ts`).
 *
 * What travels to the lowerer is the parsed graph serialized: the blocks
 * with their typed sockets, defaults, sources and signal targets, the
 * graph's variables, and the pointers the parser resolved. Everything the
 * block bodies later decide from that data is decided by evaluating the
 * pinned bodies over it.
 */
import { asObject, gltfInteractivityGraphs, type JsonRecord } from "./gltf-document.js";
import { importPinnedModule } from "./pinned-shader-composer.js";

export interface FlowGraphSocket {
    name: string;
    /** The pin's `FgType` tag (`"number"`, `"Vector2"`, `"boolean"`, ...). */
    type: string;
    source?: { blockId: string; socket: string; scale?: number };
    /**
     * The parser's own default: a number, boolean, string, `fgInt` record
     * or vector record, carried as it is so the pinned bodies' `typeof`
     * and `in` tests see what they see in the browser.
     */
    defaultValue?: unknown;
}

export interface FlowGraphSignalOutput {
    name: string;
    targets: { blockId: string; socket: string }[];
}

export interface FlowGraphBlock {
    id: string;
    /** The pin's `FgBlockType` value (`"Add"`, `"SetVariable"`, ...). */
    type: string;
    config: Record<string, unknown>;
    dataIn: FlowGraphSocket[];
    signalIn: string[];
    signalOut: FlowGraphSignalOutput[];
    /** The pin's `FgEventType` for an event block. */
    event?: string;
}

/** A recording stand-in for one entity of the loaded asset. */
export interface FlowGraphRecordingRoot {
    kind: "node" | "material";
    index: number;
}

/** One leaf member the pin's accessor read or wrote on a stand-in. */
export interface FlowGraphTouch extends FlowGraphRecordingRoot {
    /** Dotted member path on the stand-in (`baseColorTexture.uOffset`). */
    path: string;
    write: boolean;
}

/**
 * What the pin's path converter binds a constant pointer to, observed by
 * executing `resolvePointerAccessor` over recording stand-ins built the way
 * the load prepass builds its node and material maps: the accessor's
 * declared type, the stand-in its `target` names, and the leaf members its
 * getter reads and its setter writes. The lowering maps those members to
 * native fields and refuses an accessor that touches anything else.
 */
export interface FlowGraphPointerAccessor {
    pointer: string;
    /** The pin's `FgType` name (`"boolean"`, `"Vector2"`, ...). */
    type: string;
    target?: FlowGraphRecordingRoot;
    touches: FlowGraphTouch[];
    /** Whether the pin exposes a setter for the pointer. */
    writable: boolean;
}

export interface FlowGraphProgram {
    graphIndex: number;
    blocks: FlowGraphBlock[];
    /** Each variable's `FgType` and the parser's own seed value. */
    variables: Record<string, { type: string; value: unknown }>;
    /**
     * Every constant pointer the parser resolved, in first-use order; null
     * where the pin binds nothing and the block reads its type's default.
     */
    accessors: Record<string, FlowGraphPointerAccessor | null>;
}

/** One asset's graphs, keyed by the packaged file the loader reads. */
export interface FlowGraphAssetPrograms {
    /** The packaged asset's output name (`<hash>-Calculator.glb`). */
    asset: string;
    graphs: FlowGraphProgram[];
}

interface PinnedGraph {
    blocks: Array<{
        id: string;
        type: string;
        config?: Record<string, unknown>;
        dataIn: Array<{
            name: string;
            type: string;
            source?: { blockId: string; socket: string; scale?: number };
            defaultValue?: unknown;
        }>;
        dataOut: Array<{ name: string; type: string }>;
        signalIn: Array<{ name: string }>;
        signalOut: Array<{
            name: string;
            targets: Array<{ blockId: string; socket: string }>;
        }>;
        event?: string;
    }>;
    variables: Record<string, { type: string; value: unknown }>;
}

interface InteractivityParserModule {
    parseInteractivityGraph(
        json: unknown,
    ): Promise<{ graph: PinnedGraph; pointers: string[] }>;
}

interface PinnedAccessor {
    type: string;
    target?: object;
    get?: () => unknown;
    set?: (value: unknown) => void;
}

interface PathConverterModule {
    resolvePointerAccessor(pointer: string, context: unknown): PinnedAccessor | null;
}

/**
 * A stand-in for one loaded entity. Every member read yields another
 * stand-in that is truthy, callable, iterable and numeric zero, so any walk
 * the pin's accessor makes over it completes, and every access lands in
 * `touches`; members named in `absent` read as undefined, the way the
 * loaded entity lacks them.
 */
class RecordingRoot {
    private readonly touched = new Map<string, boolean>();
    public readonly proxy: object;

    public constructor(
        public readonly root: FlowGraphRecordingRoot,
        private readonly absent: ReadonlySet<string> = new Set(),
    ) {
        this.proxy = this.member("");
    }

    private member(path: string): object {
        const at = (key: string): string => (path ? `${path}.${key}` : key);
        return new Proxy(function standIn(): void {}, {
            get: (_, key) => {
                if (typeof key === "symbol") {
                    if (key === Symbol.toPrimitive) return () => 0;
                    if (key === Symbol.iterator) return function* (): Generator<never> {};
                    return undefined;
                }
                if (key === "then") return undefined;
                if (path === "" && this.absent.has(key)) return undefined;
                this.touched.set(at(key), this.touched.get(at(key)) ?? false);
                return this.member(at(key));
            },
            set: (_, key) => {
                if (typeof key !== "symbol") this.touched.set(at(key), true);
                return true;
            },
            has: () => true,
            apply: () => undefined,
        });
    }

    /** Resolving an accessor walks the stand-in too; only its use counts. */
    public reset(): void {
        this.touched.clear();
    }

    /** Leaf members only: `children` read on the way to `children.length` is the walk. */
    public touches(): FlowGraphTouch[] {
        const paths = [...this.touched.keys()];
        return paths
            .filter((path) => !paths.some((other) => other.startsWith(`${path}.`)))
            .map((path) => ({ ...this.root, path, write: this.touched.get(path)! }));
    }
}

/** A value of the accessor's declared type, for the setter to write. */
function probeValue(type: string): unknown {
    switch (type) {
        case "boolean":
            return true;
        case "number":
        case "FlowGraphInteger":
            return 1;
        case "Vector2":
            return { x: 1, y: 2 };
        case "Vector3":
            return { x: 1, y: 2, z: 3 };
        case "Vector4":
        case "Quaternion":
            return { x: 1, y: 2, z: 3, w: 4 };
        default:
            return undefined;
    }
}

/**
 * The loader's runtime material for glTF material `index`, as a stand-in:
 * the texture slots the document gives it are present, the others absent
 * (`privateTexture` then finds nothing to write).
 */
function materialStandIn(document: JsonRecord, index: number): RecordingRoot {
    const materials = Array.isArray(document.materials) ? document.materials : [];
    const material = asObject(materials[index]);
    const pbr = asObject(material?.pbrMetallicRoughness);
    const absent = new Set<string>();
    if (!pbr?.baseColorTexture) absent.add("baseColorTexture");
    if (!material?.emissiveTexture) absent.add("emissiveTexture");
    if (!material?.normalTexture) absent.add("normalTexture");
    if (!material?.occlusionTexture) {
        absent.add("occlusionTexture");
        absent.add("ormTexture");
    }
    return new RecordingRoot({ kind: "material", index }, absent);
}

/**
 * `buildMaterialMap`: the materials the load prepass offers the resolver are
 * those a primitive of a node with a mesh names, keyed by material index.
 */
function materialsReachedByPrimitives(document: JsonRecord): number[] {
    const nodes = Array.isArray(document.nodes) ? document.nodes : [];
    const meshes = Array.isArray(document.meshes) ? document.meshes : [];
    const reached = new Set<number>();
    for (const node of nodes) {
        const meshIndex = asObject(node)?.mesh;
        if (typeof meshIndex !== "number") continue;
        const primitives = asObject(meshes[meshIndex])?.primitives;
        for (const primitive of Array.isArray(primitives) ? primitives : []) {
            const material = asObject(primitive)?.material;
            if (typeof material === "number") reached.add(material);
        }
    }
    return [...reached].sort((left, right) => left - right);
}

/**
 * `applyAsset`'s constant-pointer prepass, executed over recording
 * stand-ins: the pin's `resolvePointerAccessor` binds each pointer against
 * the same node and material maps the loader builds, then the accessor's
 * getter and setter run once so the members they touch are on record.
 */
async function resolvePointerAccessors(
    document: JsonRecord,
    pointers: readonly string[],
): Promise<Record<string, FlowGraphPointerAccessor | null>> {
    const converter = await importPinnedModule<PathConverterModule>(
        "flow-graph/gltf/path-converter.js",
    );
    const nodeCount = Array.isArray(document.nodes) ? document.nodes.length : 0;
    const materialIndices = materialsReachedByPrimitives(document);
    const accessors: Record<string, FlowGraphPointerAccessor | null> = {};
    for (const pointer of pointers) {
        const nodes = Array.from(
            { length: nodeCount },
            (_, index) => new RecordingRoot({ kind: "node", index }),
        );
        const materials = materialIndices.map((index) => materialStandIn(document, index));
        const materialMap: object[] = [];
        for (const material of materials) materialMap[material.root.index] = material.proxy;
        const accessor = converter.resolvePointerAccessor(pointer, {
            nodeMap: nodes.map((node) => node.proxy),
            materials: materialMap,
            json: document,
        });
        if (!accessor) {
            accessors[pointer] = null;
            continue;
        }
        const roots = [...nodes, ...materials];
        for (const root of roots) root.reset();
        accessor.get?.();
        accessor.set?.(probeValue(accessor.type));
        const target = roots.find((root) => root.proxy === accessor.target)?.root;
        accessors[pointer] = {
            pointer,
            type: accessor.type,
            ...(target ? { target } : {}),
            touches: roots.flatMap((root) => root.touches()),
            writable: accessor.set !== undefined,
        };
    }
    return accessors;
}

/**
 * A parser value as plain data: the pin's numbers, booleans, strings,
 * `fgInt` records, vector records and the document's own configuration
 * copy through as they are, so the pinned bodies' `typeof` and `in` tests
 * see what they see in the browser. A matrix (`Float32Array`, `fgMat`) is
 * the one parser value this port does not carry, and refuses by path.
 */
function plainValue(value: unknown, path: string): unknown {
    if (
        value === null ||
        value === undefined ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "string"
    ) {
        return value;
    }
    if (ArrayBuffer.isView(value)) {
        throw new Error(`KHR_interactivity: ${path} is a matrix, which this port does not carry.`);
    }
    if (Array.isArray(value)) {
        return value.map((entry, index) => plainValue(entry, `${path}[${index}]`));
    }
    if (typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            result[key] = plainValue(entry, `${path}.${key}`);
        }
        return result;
    }
    throw new Error(`KHR_interactivity: ${path} is a ${typeof value}, which this port does not carry.`);
}

/**
 * Parse every graph of one packaged glTF document through the pin.
 *
 * The pin skips a graph its parser rejects with a console warning and runs
 * the rest; a rejected graph here is a generation error naming the asset,
 * because a demo whose browser build silently drops behavior is not one to
 * integrate on a golden that shows the drop. The Babylon editor JSON the
 * same loader feature also accepts (`BABYLON_flow_graph`) is refused at
 * packaging (`asset-specializer.ts`).
 */
export async function parseFlowGraphs(
    assetName: string,
    document: JsonRecord,
): Promise<FlowGraphProgram[]> {
    const graphs = gltfInteractivityGraphs(document);
    if (graphs.length === 0) return [];
    const parser = await importPinnedModule<InteractivityParserModule>(
        "flow-graph/gltf/interactivity-parser.js",
    );
    const programs: FlowGraphProgram[] = [];
    for (const [graphIndex, graph] of graphs.entries()) {
        let parsed: { graph: PinnedGraph; pointers: string[] };
        try {
            parsed = await parser.parseInteractivityGraph(graph);
        } catch (error) {
            throw new Error(
                `${assetName}: KHR_interactivity graph ${graphIndex} is rejected ` +
                    `by the pinned parser (${error instanceof Error ? error.message : String(error)}); ` +
                    `the browser would run the asset without it.`,
                { cause: error },
            );
        }
        const variables: FlowGraphProgram["variables"] = {};
        for (const [name, variable] of Object.entries(parsed.graph.variables)) {
            variables[name] = {
                type: variable.type,
                value: plainValue(variable.value, `variables.${name}`),
            };
        }
        programs.push({
            graphIndex,
            blocks: parsed.graph.blocks.map((block) => ({
                id: block.id,
                type: block.type,
                config: plainValue(block.config ?? {}, `${block.id}.config`) as Record<string, unknown>,
                dataIn: block.dataIn.map((socket) => ({
                    name: socket.name,
                    type: socket.type,
                    ...(socket.source
                        ? {
                              source: {
                                  blockId: socket.source.blockId,
                                  socket: socket.source.socket,
                                  ...(socket.source.scale !== undefined
                                      ? { scale: socket.source.scale }
                                      : {}),
                              },
                          }
                        : {}),
                    ...(socket.defaultValue !== undefined
                        ? { defaultValue: plainValue(socket.defaultValue, `${block.id}.${socket.name}`) }
                        : {}),
                })),
                signalIn: block.signalIn.map((socket) => socket.name),
                signalOut: block.signalOut.map((socket) => ({
                    name: socket.name,
                    targets: socket.targets.map((target) => ({
                        blockId: target.blockId,
                        socket: target.socket,
                    })),
                })),
                ...(block.event !== undefined ? { event: block.event } : {}),
            })),
            variables,
            accessors: await resolvePointerAccessors(document, parsed.pointers),
        });
    }
    return programs;
}
