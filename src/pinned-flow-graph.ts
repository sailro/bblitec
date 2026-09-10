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
import ts from "typescript";
import { asObject, asIndex, GLTF_MESH_PLAN, type JsonRecord } from "./gltf-document.js";
import type {LoweringContext} from "./lowering/context.js";
import { pinnedModuleTextUrl } from "./pinned-shader-composer.js";
import {transpileForBrowser} from "./typescript-transpile.js";

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

interface PinnedAccessor {
    type: string;
    target?: object;
    get?: () => unknown;
    set?: (value: unknown) => void;
}

export interface PathConverterModule {
    resolvePointerAccessor(pointer: string, context: unknown): PinnedAccessor | null;
}

/** The feature executes intact except for its recording/runtime boundaries. */
export function gltfFlowGraphSourceUrl(context: LoweringContext): string {
    const module = "src/loader-gltf/gltf-feature-interactivity.ts";
    const file = context.sourceFile(module);
    const parameter = context.methodDeclaration(module, "feature.applyAsset").declaration.parameters[2]?.name;
    if (!parameter || !ts.isIdentifier(parameter)) context.contractError(file, "Expected the interactivity load context.");
    const transform = ts.transform(file, [visitorContext => root => {
        const visit: ts.Visitor = node => {
            if (ts.isCallExpression(node)) {
                const method = context.expressionMatchesShape(node.expression, "resolvePointerAccessor") ? "recordFlowAccessor"
                    : context.expressionMatchesShape(node.expression, "runFlowGraphs") ? "recordRunFlowGraphs"
                    : context.expressionMatchesShape(node.expression, "console.warn") ? "recordFlowRejection" : undefined;
                if (method) return ts.factory.updateCallExpression(node,
                    ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier(parameter.text), method), undefined, node.arguments);
            }
            return ts.visitEachChild(node, visit, visitorContext);
        };
        return ts.visitNode(root, visit, ts.isSourceFile)!;
    }]);
    try {
        return pinnedModuleTextUrl("loader-gltf/gltf-feature-interactivity.js",
            transpileForBrowser(ts.createPrinter().printFile(transform.transformed[0]!), module));
    } finally { transform.dispose(); }
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

/** The source feature resolves against its actual node/material maps. */
export class GltfFlowGraphRecording {
    private readonly accessors = new WeakMap<object, FlowGraphPointerAccessor>();
    private readonly unresolvedPointers = new Set<string>();
    private started: unknown;
    private runtimes: Promise<never[]> | undefined;

    public constructor(private readonly converter: PathConverterModule, private readonly document: JsonRecord,
        private readonly nodes: ReadonlyMap<object, number>, private readonly materials: ReadonlyMap<object, number>) {}

    public resolve(pointer: string, context: unknown): PinnedAccessor | null {
        const supplied = asObject(context);
        if (!supplied || supplied.json !== this.document || !Array.isArray(supplied.nodeMap) || !Array.isArray(supplied.materials) ||
            Object.keys(supplied).some(key => !["json", "nodeMap", "materials"].includes(key)))
            throw new Error("Unrepresented glTF flow-graph pointer context.");
        const roots: RecordingRoot[] = [];
        const map = (values: unknown[], indices: ReadonlyMap<object, number>, kind: "node" | "material") =>
            values.map(value => {
                if (value === undefined) return undefined;
                const object = asObject(value), index = object && indices.get(object);
                if (index === undefined) throw new Error(`Unrepresented glTF flow-graph ${kind} identity.`);
                const root = kind === "node" ? new RecordingRoot({kind, index}) : materialStandIn(this.document, index);
                roots.push(root);
                return root.proxy;
            });
        const accessor = this.converter.resolvePointerAccessor(pointer, {nodeMap: map(supplied.nodeMap, this.nodes, "node"),
            materials: map(supplied.materials, this.materials, "material"), json: this.document});
        if (!accessor) { this.unresolvedPointers.add(pointer); return null; }
        for (const root of roots) root.reset();
        accessor.get?.();
        accessor.set?.(probeValue(accessor.type));
        const target = roots.find(root => root.proxy === accessor.target)?.root;
        this.accessors.set(accessor, {pointer, type: accessor.type, ...(target ? {target} : {}),
            touches: roots.flatMap(root => root.touches()), writable: accessor.set !== undefined});
        return accessor;
    }

    public run(scene: unknown, graphs: unknown, animations: unknown): Promise<never[]> {
        if (!asObject(scene) || !Array.isArray(graphs) || animations !== undefined || this.started !== undefined)
            throw new Error("Unrepresented glTF flow-graph recording setup.");
        this.started = graphs;
        // Native startup owns the admitted graph runtimes. Recording executes
        // publication/cleanup registration without starting a scene event loop.
        return this.runtimes = Promise.resolve([]);
    }

    public package(value: unknown, publishedRuntimes: unknown): FlowGraphProgram[] {
        if (publishedRuntimes !== this.runtimes) throw new Error("Unrepresented glTF flow-runtime promise publication.");
        if (value === undefined) {
            if (this.started !== undefined) throw new Error("Unpublished glTF flow-graph setup.");
            return [];
        }
        if (!Array.isArray(value) || this.started !== value) throw new Error("Unrepresented glTF flow-graph publication.");
        const scope = asObject(value[0])?._assetScope;
        return value.map((value, graphIndex) => {
            const loaded = asObject(value), graph = asObject(loaded?.graph), accessors = asObject(loaded?.accessors);
            if (!graph || !accessors || loaded?.rightHanded !== true || typeof loaded.resolveAccessor !== "function" ||
                !asObject(loaded._assetScope) || loaded._assetScope !== scope) throw new Error("Unrepresented loaded glTF flow graph.");
            // The source omits unresolved constants from its accessor record;
            // its runtime resolver returns null again for the same context.
            const observed: FlowGraphProgram["accessors"] = Object.fromEntries([...this.unresolvedPointers].map(pointer => [pointer, null]));
            for (const [pointer, value] of Object.entries(accessors)) {
                const accessor = asObject(value), recording = accessor && this.accessors.get(accessor);
                if (!recording || recording.pointer !== pointer) throw new Error("Unrepresented glTF flow-graph accessor publication.");
                observed[pointer] = recording;
            }
            return graphProgram(graphIndex, graph, observed);
        });
    }
}

/**
 * A parser value as plain data: the pin's numbers, booleans, strings,
 * `fgInt` records, vector records and the document's own configuration
 * copy through as they are, so the pinned bodies' `typeof` and `in` tests
 * see what they see in the browser. A matrix (`Float32Array`, `fgMat`) is
 * the one parser value this port does not carry, and refuses by path.
 */
function plainValue(value: unknown, path: string): unknown {
    if (typeof value === "number" && !Number.isFinite(value))
        throw new Error(`KHR_interactivity: ${path} is not a finite packaged number.`);
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

function records(value: unknown, label: string): JsonRecord[] {
    if (!Array.isArray(value)) throw new Error(`Invalid glTF flow-graph ${label}.`);
    return value.map(value => {
        const record = asObject(value);
        if (!record) throw new Error(`Invalid glTF flow-graph ${label} entry.`);
        return record;
    });
}
function string(value: unknown): string {
    if (typeof value !== "string") throw new Error("Invalid glTF flow-graph string.");
    return value;
}
function scale(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid glTF flow-graph scale.");
    return value;
}
function configuration(value: unknown): JsonRecord {
    const result = asObject(plainValue(value ?? {}, "config"));
    if (!result) throw new Error("Invalid glTF flow-graph configuration.");
    return result;
}
function graphProgram(graphIndex: number, graph: JsonRecord, accessors: FlowGraphProgram["accessors"]): FlowGraphProgram {
    const variables = asObject(graph.variables);
    if (!variables) throw new Error("Invalid glTF flow-graph variables.");
    return {graphIndex, accessors, variables: Object.fromEntries(Object.entries(variables).map(([name, value]) => {
        const variable = asObject(value);
        if (!variable) throw new Error("Invalid glTF flow-graph variable.");
        return [name, {type: string(variable.type), value: plainValue(variable.value, `variables.${name}`)}];
    })), blocks: records(graph.blocks, "blocks").map(block => ({
        id: string(block.id), type: string(block.type), config: configuration(block.config),
        dataIn: records(block.dataIn, "data inputs").map(socket => {
            const source = asObject(socket.source);
            return {name: string(socket.name), type: string(socket.type),
                ...(source ? {source: {blockId: string(source.blockId), socket: string(source.socket),
                    ...(source.scale === undefined ? {} : {scale: scale(source.scale)})}} : {}),
                ...(socket.defaultValue === undefined ? {} : {defaultValue: plainValue(socket.defaultValue, "socket default")})};
        }), signalIn: records(block.signalIn, "signal inputs").map(socket => string(socket.name)),
        signalOut: records(block.signalOut, "signal outputs").map(socket => ({name: string(socket.name),
            targets: records(socket.targets, "signal targets").map(target => ({blockId: string(target.blockId), socket: string(target.socket)}))})),
        ...(block.event === undefined ? {} : {event: string(block.event)}),
    }))};
}

/** Graph construction and pointer mapping already executed in the mesh feature phase. */
export async function parseFlowGraphs(assetName: string, document: JsonRecord): Promise<FlowGraphProgram[]> {
    return packagedFlowGraphPrograms(document, assetName);
}

export function packagedFlowGraphPrograms(document: JsonRecord, assetName = "glTF"): FlowGraphProgram[] {
    const plan = asObject(document[GLTF_MESH_PLAN]);
    if (!plan || !Array.isArray(plan.flowGraphs)) throw new Error(`${assetName}: missing source flow-graph construction schedule.`);
    return plan.flowGraphs.map((value, index) => {
        const program = asObject(value), accessors = asObject(program?.accessors);
        if (!program || program.graphIndex !== index || !accessors) throw new Error("Invalid packaged glTF flow graph.");
        const observed: FlowGraphProgram["accessors"] = {};
        for (const [pointer, value] of Object.entries(accessors)) {
            if (value === null) { observed[pointer] = null; continue; }
            const accessor = asObject(value), target = asObject(accessor?.target);
            const root = (value: JsonRecord): FlowGraphRecordingRoot => {
                const index = asIndex(value.index);
                if ((value.kind !== "node" && value.kind !== "material") || index === undefined)
                    throw new Error("Invalid packaged glTF flow-graph target.");
                return {kind: value.kind, index};
            };
            if (!accessor || accessor.pointer !== pointer || typeof accessor.writable !== "boolean")
                throw new Error("Invalid packaged glTF flow-graph accessor.");
            observed[pointer] = {pointer, type: string(accessor.type), writable: accessor.writable,
                ...(target ? {target: root(target)} : {}), touches: records(accessor.touches, "accessor touches").map(touch => {
                    if (typeof touch.write !== "boolean") throw new Error("Invalid packaged glTF flow-graph touch.");
                    return {...root(touch), path: string(touch.path), write: touch.write};
                })};
        }
        const blocks = records(program.blocks, "blocks").map(block => {
            if (!Array.isArray(block.signalIn)) throw new Error("Invalid packaged glTF flow-graph signal inputs.");
            return {...block, signalIn: block.signalIn.map(name => ({name: string(name)}))};
        });
        return graphProgram(index, {...program, blocks}, observed);
    });
}
