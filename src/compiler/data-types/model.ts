export type HandleKind =
    | "custom-event"
    | "dom-event"
    | "dom-event-identity"
    | "worker-media-query"
    | "worker-mutation-observer"
    | AudioHandleKind
    | "engine"
    | "asset"
    | "gpu-device"
    | "gpu-texture"
    | "device-recovery"
    | "gpu-environment"
    | "procedural-sky-environment"
    | "node-input"
    | "text-data"
    | "text-renderable"
    | "text-layer"
    | "text-renderer"
    | "text-run"
    | "text-run-ref"
    | "picking-info"
    | "offscreen-canvas"
    | "mesh"
    | "animation-group"
    | "flow-graph"
    | "flow-graph-runtime"
    | "audio-buffer"
    | "audio-engine"
    | "audio-source"
    | "audio-context"
    | "camera"
    | "property-animation-group"
    | "ui-element"
    | "utility-layer"
    | "pointer-drag"
    | "gamepad"
    | "gamepad-button"
    | "scene"
    | "render-target"
    | "scene-node"
    | "light"
    | "shadow-generator"
    | "hierarchy-instance-pool"
    | "thin-instance-pool"
    | "storage-buffer"
    | "compute-storage-texture"
    | "compute-texture-resource"
    | "compute-sampler"
    | "compute-binding-decl"
    | "compute-binding-set"
    | "compute-shader"
    | "compute-dispatch"
    | "compute-task"
    | "compute-one-shot"
    | "compute-uniform-arena"
    | "compute-uniform-writer"
    | "compute-uniform-layout"
    | "uniform-buffer"
    | "material"
    | "physics-world"
    | "physics-native-body"
    | "physics-module"
    | "physics-thin-context"
    | "physics-body-list"
    | "physics-body"
    | "physics-constraint"
    | "physics-aggregate"
    | "physics-viewer"
    | "physics-character-controller"
    | "physics-shape"
    | "billboard-sprite"
    | "billboard-system"
    | "sprite-layer"
    | "sprite-atlas"
    | "splat-mesh"
    | "texture"
    | "transform-node"
    | "skeleton"
    | "scene-skeleton"
    | "bone"
    | "navigation-obstacle";
type AudioHandleKind =
    "audio-node" | "audio-param" | "media-stream" | "media-stream-track";
export type TypedArrayKind =
    | "u8array"
    | "i8array"
    | "f64array"
    | "f32array"
    | "u16array"
    | "i16array"
    | "u32array"
    | "i32array";
interface DataKinds {
    "module-namespace": { kind: "module-namespace"; module: string };
    undefined: { kind: "undefined" };
    error: { kind: "error" };
    "event-target": { kind: "event-target" };
    "deferred-dom-object": {
        kind: "deferred-dom-object";
        name: "AbortController" | "AbortSignal";
    };
    "http-response": { kind: "http-response" };
    "gpu-adapter": { kind: "gpu-adapter" };
    "gpu-adapter-info": { kind: "gpu-adapter-info" };
    "search-params": { kind: "search-params" };
    promise: { kind: "promise"; result?: DataType };
    "weak-ref": { kind: "weak-ref"; target: DataType };
    storage: { kind: "storage" };
    date: { kind: "date" };
    "date-time-format": { kind: "date-time-format" };
    "text-decoder": { kind: "text-decoder" };
    "text-encoder": { kind: "text-encoder" };
    collator: { kind: "collator" };
    number: {
        kind: "number";
    };
    "weak-key": { kind: "weak-key" };
    boolean: {
        kind: "boolean";
    };
    arraybuffer: {
        kind: "arraybuffer";
    };
    dataview: {
        kind: "dataview";
    };
    bufferview: {
        kind: "bufferview";
    };
    numberindex: {
        kind: "numberindex";
    };
    "borrowed-platform-event": {
        kind: "borrowed-platform-event";
        event: "event" | "mouse" | "keyboard" | "error" | "rejection";
    };
    string: {
        kind: "string";
    };
    handle: {
        kind: "handle";
        handle: HandleKind;
    };
    function: {
        kind: "function";
        parameters: DataType[];
        /** Owned table of the reached concrete signatures of a generic callable. */
        generic?: string;
        /** Native parameter index of the final, freshly packed rest array. */
        restParameter?: number;
        result?: DataType;
        /** The represented callable's source completion is provably undefined. */
        undefinedCompletion?: true;
        /**
         * The container this function is stored in observes its JavaScript
         * identity -- a Set membership, a Map key. Such a value carries the
         * identity of the declaration it was materialized from so `delete`
         * and a duplicate `add` answer the way the source does.
         */
        identity?: true;
        /**
         * Source parameters whose type is void/never and therefore have no
         * native argument. Their expressions are still validated at calls; no
         * placeholder runtime value is invented.
         */
        erasedParameters?: number[];
        /** Native parameter positions which accept an omitted source argument. */
        optionalParameters?: number[];
    };
    struct: {
        kind: "struct";
        name: string;
    };
    enum: {
        kind: "enum";
        name: string;
    };
    json: {
        kind: "json";
    };
    optional: {
        kind: "optional";
        /** The absent state is known to be undefined, including resized tuple lanes. */
        undefinedOnly?: true;
        inner: DataType;
    };
    union: {
        kind: "union";
        members: DataType[];
    };
    vector: {
        kind: "vector";
        element: DataType;
    };
    arguments: {
        kind: "arguments";
        element: DataType;
    };
    map: {
        kind: "map";
        /** Erased object identity, with concrete ownership proven at each key sink. */
        weak?: true;
        /** Source object index signature; a JavaScript Map has no enumerable entries. */
        dictionary?: true;
        key: DataType;
        value: DataType;
    };
    set: {
        kind: "set";
        element: DataType;
    };
    iterator: {
        kind: "iterator";
        element: DataType;
        asynchronous?: true;
        traced?: true;
    };
    span: {
        kind: "span";
        element: DataType;
    };
    tuple: {
        kind: "tuple";
        arity: number;
    };
    product: {
        kind: "product";
        elements: DataType[];
    };
    enummap: {
        kind: "enummap";
        enumName: string;
        element: DataType;
    };
    table: {
        kind: "table";
        dimensions: number[];
    };
    u8array: {
        kind: "u8array";
    };
    i8array: { kind: "i8array" };
    f64array: {
        kind: "f64array";
    };
    f32array: {
        kind: "f32array";
    };
    u16array: {
        kind: "u16array";
    };
    i16array: {
        kind: "i16array";
    };
    u32array: {
        kind: "u32array";
    };
    i32array: {
        kind: "i32array";
    };
}
export type DataKind = keyof DataKinds;
/** The mapped union preserves the correlation between a kind and its payload. */
export type DataType<K extends DataKind = DataKind> = {
    [P in K]: DataKinds[P] & {
        kind: P;
    };
}[K];
