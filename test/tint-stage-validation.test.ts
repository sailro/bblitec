import assert from "node:assert/strict";
import {
    appendFileSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { findPinnedTint } from "../src/tint-tool.js";
import { validateTintStages } from "./tint-stage-validation.js";

const tint = findPinnedTint(
    resolve(import.meta.dirname, "../.."),
    discoverDevelopmentTools().cmake,
);

test(
    "raw Tint validation shares successes across paths and invalidates changed bytes, tool provenance and failures",
    { skip: !tint },
    (t) => {
        const directory = mkdtempSync(join(tmpdir(), "tint-validation-"));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const cache = join(directory, "cache");
        const first = join(directory, "first.wgsl"),
            second = join(directory, "second.wgsl");
        const shader = "@compute @workgroup_size(1) fn main() {}\n";
        writeFileSync(first, shader);
        writeFileSync(second, shader);
        const validate = () =>
            validateTintStages(tint!, [first, second], cache, true);
        assert.deepEqual(validate(), {
            unique: 1,
            compiled: 3,
            reused: 0,
            failures: [],
        });
        assert.deepEqual(validate(), {
            unique: 1,
            compiled: 0,
            reused: 3,
            failures: [],
        });
        writeFileSync(second, shader.replace("(1)", "(2)"));
        assert.deepEqual(validate(), {
            unique: 2,
            compiled: 3,
            reused: 3,
            failures: [],
        });
        writeFileSync(second, "invalid WGSL");
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = validate();
            assert.equal(result.compiled, 3);
            assert.equal(result.reused, 3);
            assert.equal(result.failures.length, 3);
            assert.ok(
                result.failures.every((failure) => failure.includes(second)),
            );
        }
        assert.deepEqual(validateTintStages(tint!, [first], cache, false), {
            unique: 1,
            compiled: 3,
            reused: 0,
            failures: [],
        });
        const toolDirectory = join(directory, "tool");
        mkdirSync(toolDirectory);
        const copy = join(toolDirectory, basename(tint!));
        copyFileSync(tint!, copy);
        copyFileSync(
            join(dirname(tint!), "provenance.json"),
            join(toolDirectory, "provenance.json"),
        );
        assert.equal(validateTintStages(copy, [first], cache, true).reused, 3);
        appendFileSync(copy, "\n");
        const changedTool = validateTintStages(copy, [first], cache, true);
        assert.equal(changedTool.compiled, 3);
        assert.deepEqual(changedTool.failures, []);
        writeFileSync(
            join(toolDirectory, "provenance.json"),
            "changed provenance",
        );
        assert.equal(
            validateTintStages(copy, [first], cache, true).compiled,
            3,
        );
    },
);
