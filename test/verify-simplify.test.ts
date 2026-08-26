import { strict as assert } from "node:assert";
import test from "node:test";
import { validateRecord } from "../src/verify-simplify.js";

test("a record with no angles is not evidence", () => {
    const problems = validateRecord({ angles: [], findings: [] });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /at least three review angles/);
});

test("four angles and nothing found is a real answer", () => {
    assert.deepEqual(
        validateRecord({
            angles: ["reuse", "simplification", "efficiency", "altitude"],
            findings: [],
        }),
        [],
    );
});

test("a finding must say whether it was applied", () => {
    const problems = validateRecord({
        angles: ["reuse", "simplification", "efficiency"],
        findings: [{ summary: "duplicated walk" }],
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /findings\[0\]\.applied must be true or false/);
});

test("an unapplied finding needs a real blocker and a durable home", () => {
    const problems = validateRecord({
        angles: ["reuse", "simplification", "efficiency"],
        findings: [{ summary: "collapse the arms", applied: false }],
    });
    assert.equal(problems.length, 2);
    assert.match(problems[0]!, /blockedBy/);
    assert.match(problems[1]!, /filedIn/);
});

test("\"out of scope\" is not a blocker", () => {
    const problems = validateRecord({
        angles: ["reuse", "simplification", "efficiency"],
        findings: [
            {
                summary: "collapse the arms",
                applied: false,
                blockedBy: "later",
                filedIn: "TODO.md",
            },
        ],
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /blockedBy/);
});

test("an applied finding needs neither", () => {
    assert.deepEqual(
        validateRecord({
            angles: ["reuse", "simplification", "efficiency", "altitude"],
            findings: [{ summary: "one shared walk", applied: true }],
        }),
        [],
    );
});

test("a missing findings array is named rather than ignored", () => {
    const problems = validateRecord({ angles: ["a", "b", "c"] });
    assert.deepEqual(problems, [
        "`findings` must be an array, empty if nothing was found.",
    ]);
});
