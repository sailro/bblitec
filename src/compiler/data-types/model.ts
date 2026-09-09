export type HandleKind = "gpu-device" | "gpu-texture" | "device-recovery" | "gpu-environment" | "node-input" | "text-data" | "text-renderable" | "text-layer" | "text-renderer" | "text-run" | "text-run-ref" | "picking-info" | "offscreen-canvas" | "mesh" | "animation-group" | "flow-graph" | "flow-graph-runtime" | "audio-buffer" | "audio-context" | "camera" | "property-animation-group" | "ui-element" | "utility-layer" | "pointer-drag" | "gamepad" | "gamepad-button" | "scene" | "scene-node" | "light" | "shadow-generator" | "hierarchy-instance-pool" | "storage-buffer" | "material" | "physics-body" | "physics-aggregate" | "physics-viewer" | "physics-character-controller" | "physics-shape" | "billboard-sprite" | "billboard-system" | "sprite-layer" | "sprite-atlas" | "splat-mesh" | "texture" | "transform-node" | "skeleton" | "scene-skeleton" | "bone" | "navigation-obstacle";
export type TypedArrayKind = "u8array" | "f64array" | "f32array" | "u16array" | "i16array" | "u32array" | "i32array";
export interface DataKinds {
    "number": {
        kind: "number";
    };
    "boolean": {
        kind: "boolean";
    };
    "arraybuffer": {
        kind: "arraybuffer";
    };
    "dataview": {
        kind: "dataview";
    };
    "borrowed-platform-event": {
        kind: "borrowed-platform-event";
        event: "event" | "mouse" | "keyboard";
    };
    "string": {
        kind: "string";
    };
    "handle": {
        kind: "handle";
        handle: HandleKind;
    };
    "function": {
        kind: "function";
        parameters: DataType[];
        result?: DataType;
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
    };
    "struct": {
        kind: "struct";
        name: string;
    };
    "enum": {
        kind: "enum";
        name: string;
    };
    "json": {
        kind: "json";
    };
    "optional": {
        kind: "optional";
        inner: DataType;
    };
    "vector": {
        kind: "vector";
        element: DataType;
    };
    "map": {
        kind: "map";
        key: DataType;
        value: DataType;
    };
    "set": {
        kind: "set";
        element: DataType;
    };
    "span": {
        kind: "span";
        element: DataType;
    };
    "tuple": {
        kind: "tuple";
        arity: number;
    };
    "enummap": {
        kind: "enummap";
        enumName: string;
        element: DataType;
    };
    "table": {
        kind: "table";
        dimensions: number[];
    };
    "u8array": {
        kind: "u8array";
    };
    "f64array": {
        kind: "f64array";
    };
    "f32array": {
        kind: "f32array";
    };
    "u16array": {
        kind: "u16array";
    };
    "i16array": {
        kind: "i16array";
    };
    "u32array": {
        kind: "u32array";
    };
    "i32array": {
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
