import ts from "typescript";

import { dataTypesEqual, isTypedArrayType, type DataType, type TypedArrayKind } from "../data-types.js";
import type { Value } from "../types.js";

import { pickedMeshHandleCpp } from "../properties.js";
import type { DataSinkHost, DataSinkOperations } from "./contracts.js";

function expressionHandle(dataType: DataType<"handle">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    // Storing a resource into plain data: the sink takes
    // the handle value produced by the intrinsic that
    // created it (or read back out of another container).
    let rawValue = lowerer.context.compileValue(unwrapped);
    if (dataType.handle === "text-run-ref" && (rawValue.kind === "number" || rawValue.kind === "text-run"))
        return lowerer.compileKnownValueForSink(rawValue, dataType, unwrapped);
    if (dataType.handle === "mesh" &&
        rawValue.kind === "picked-node") {
        return lowerer.compileKnownValueForSink(rawValue, dataType, unwrapped);
    }
    if (dataType.handle ===
        "property-animation-group" &&
        rawValue.kind === "animation-group" &&
        rawValue.animationGroupSource === "property") {
        return rawValue.cpp;
    }
    if (dataType.handle === "sprite-atlas" &&
        rawValue.kind !== "record") {
        const staticExpression = lowerer.context.resolveStaticExpression(unwrapped);
        const constInitializer = ts.isIdentifier(unwrapped)
            ? lowerer.context.checker.getSymbolAtLocation(unwrapped)?.valueDeclaration
            : undefined;
        const atlasExpression = staticExpression !== unwrapped
            ? staticExpression
            : constInitializer &&
                ts.isVariableDeclaration(constInitializer) &&
                constInitializer.initializer &&
                ts.isVariableDeclarationList(constInitializer.parent) &&
                (constInitializer.parent.flags &
                    ts.NodeFlags.Const) !==
                    0
                ? constInitializer.initializer
                : undefined;
        if (atlasExpression) {
            rawValue =
                lowerer.context.compileValue(atlasExpression);
        }
    }
    const value = rawValue.kind === "data"
        ? lowerer.narrowOptional(rawValue, unwrapped)
        : rawValue;
    if (dataType.handle === "sprite-atlas" &&
        value.kind === "record") {
        const atlas = lowerer.context.compileSpriteAtlasRecord(value, unwrapped);
        if (atlas)
            return atlas;
    }
    if (value.kind !== dataType.handle) {
        lowerer.context.fail(unwrapped, `Expected a ${dataType.handle} value, received ${value.kind}.`);
    }
    return lowerer.compileKnownValueForSink(value, dataType, unwrapped);
}

function expressionArraybufferOrDataview(dataType: DataType<"arraybuffer" | "dataview">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    const value = lowerer.requireDataValue(unwrapped, dataType);
    lowerer.markEscaped(value);
    return value.cpp;
}

function bufferViewValue(_type: DataType<"bufferview">, lowerer: DataSinkHost, value: Value, node: ts.Node): string | undefined {
    if (value.dataType?.kind === "bufferview") return value.cpp;
    if (value.dataType?.kind === "dataview" || (value.dataType && isTypedArrayType(value.dataType))) {
        if (value.borrowedData || value.nativeVectorData) {
            lowerer.context.fail(node, "ArrayBufferView storage requires a retained typed array or DataView.");
        }
        lowerer.markEscaped(value);
        return `bbl::js::ArrayBufferView(${value.cpp})`;
    }
    return undefined;
}

function expressionView(type: DataType<"bufferview" | "numberindex">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    return lowerer.compileKnownValueForSink(lowerer.narrowOptional(lowerer.context.compileValue(unwrapped), unwrapped), type, unwrapped);
}

function numericViewValue(_type: DataType<"numberindex">, lowerer: DataSinkHost, value: Value, node: ts.Node): string | undefined {
    const source = value.dataType;
    if (source?.kind === "numberindex") return value.cpp;
    if (source && (isTypedArrayType(source) || source.kind === "tuple" ||
        (source.kind === "vector" && source.element.kind === "number"))) {
        if (value.borrowedData || value.nativeVectorData) {
            lowerer.context.fail(node, "Numeric index storage requires a retained array.");
        }
        lowerer.invalidateEscapingCollection(value);
        lowerer.markEscaped(value);
        return `bbl::js::NumericArrayView(${value.cpp})`;
    }
    return undefined;
}

function expressionTypedArray(dataType: DataType<TypedArrayKind>, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    if (ts.isNewExpression(unwrapped)) {
        const value = lowerer.compileTypedArrayNew(unwrapped);
        if (value?.dataType &&
            dataTypesEqual(value.dataType, dataType)) {
            return value.cpp;
        }
    }
    const value = lowerer.requireDataValue(unwrapped, dataType);
    lowerer.markEscaped(value);
    return value.cpp;
}

function valueResource(dataType: DataType<"arraybuffer" | "dataview" | TypedArrayKind | "handle">, lowerer: DataSinkHost, value: Value, node: ts.Node): string | undefined {
    if (dataType.kind === "handle" && dataType.handle === "mesh" && value.kind === "picked-node") {
        return pickedMeshHandleCpp(lowerer.context, value, node);
    }
    if (dataType.kind === "handle" && dataType.handle === "text-run-ref" &&
        (value.kind === "number" || value.kind === "text-run"))
        return `bbl::TextRunRef{${value.cpp}}`;
    if (dataType.kind === "handle" &&
        dataType.handle === "scene-node" &&
        (value.kind === "mesh" ||
            value.kind === "transform-node" ||
            value.kind === "asset-root")) {
        return `bbl::SceneNodeHandle{${value.cpp}}`;
    }
    if (dataType.kind === "handle" &&
        dataType.handle ===
            "property-animation-group" &&
        value.kind === "animation-group" &&
        value.animationGroupSource === "property") {
        return value.cpp;
    }
    if (dataType.kind === "handle" &&
        value.kind === dataType.handle) {
        if (dataType.handle === "texture") {
            if (value.textureStorage === "solid") {
                return `bbl::StoredTexture{bbl::solid_texture_file(${value.cpp})}`;
            }
            if (value.textureStorage === "pixels" || value.textureStorage === "file") {
                return `bbl::StoredTexture{${value.cpp}}`;
            }
            if (!(value.dataType?.kind === "handle" && value.dataType.handle === "texture")) {
                lowerer.context.fail(node, "Texture2D data storage supports file, pixel, and solid textures.");
            }
        }
        return value.cpp;
    }
    if (value.dataType &&
        dataTypesEqual(value.dataType, dataType)) {
        return value.cpp;
    }
    return undefined;
}

export const resourcesSinks: DataSinkOperations<"handle" | "arraybuffer" | "dataview" | "bufferview" | "numberindex" | TypedArrayKind> = {
    "bufferview": { expression: expressionView, value: bufferViewValue },
    "numberindex": { expression: expressionView, value: numericViewValue },
    "handle": { expression: expressionHandle, value: valueResource },
    "arraybuffer": { expression: expressionArraybufferOrDataview, value: valueResource },
    "dataview": { expression: expressionArraybufferOrDataview, value: valueResource },
    "i8array": { expression: expressionTypedArray, value: valueResource },
    "u8array": { expression: expressionTypedArray, value: valueResource },
    "f64array": { expression: expressionTypedArray, value: valueResource },
    "f32array": { expression: expressionTypedArray, value: valueResource },
    "u16array": { expression: expressionTypedArray, value: valueResource },
    "i16array": { expression: expressionTypedArray, value: valueResource },
    "u32array": { expression: expressionTypedArray, value: valueResource },
    "i32array": { expression: expressionTypedArray, value: valueResource }
};
