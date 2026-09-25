import assert from "node:assert/strict";
import {
    asNumbers,
    asObject,
    asString,
    type JsonObject,
} from "../src/json-fields.js";

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
    const numbers = asNumbers(value);
    assert.ok(numbers, "Expected a numeric JSON array.");
    return numbers;
}

export function jsonString(value: unknown): string {
    const text = asString(value);
    assert.ok(text !== undefined, "Expected a JSON string.");
    return text;
}
