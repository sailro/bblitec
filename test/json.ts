import assert from "node:assert/strict";
import { asObject, type JsonObject } from "../src/gltf-document.js";

export function jsonObject(value: unknown): JsonObject {
    const record = asObject(value);
    assert.ok(record, "Expected a JSON object.");
    return record;
}

export function jsonArray(value: unknown): unknown[] {
    assert.ok(Array.isArray(value), "Expected a JSON array.");
    return value;
}

export function jsonRecords(value: unknown): JsonObject[] {
    return jsonArray(value).map(jsonObject);
}

export function jsonNumbers(value: unknown): number[] {
    return jsonArray(value).map((entry) => {
        assert.ok(typeof entry === "number", "Expected a numeric JSON array.");
        return entry;
    });
}

export function jsonString(value: unknown): string {
    assert.ok(typeof value === "string", "Expected a JSON string.");
    return value;
}
