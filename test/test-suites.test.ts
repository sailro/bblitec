import assert from "node:assert/strict";
import {
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { testSuites } from "./test-suites.js";

test("focused suites partition every test and follow subprocess helpers through cycles", (t) => {
    const directory = mkdtempSync(join(tmpdir(), "test-suites-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const [name, source] of Object.entries({
        "pure.test.ts": "import { strict as assert } from 'node:assert';",
        "direct.test.ts": "import { spawnSync } from 'node:child_process';",
        "indirect.test.ts": "import './helper.js';",
        "helper.ts": "export * from './cycle.js';",
        "cycle.ts": "import './helper.js'; import('node:child_process');",
        "pinned-variant-shaders.test.ts": "import './helper.js';",
    }))
        writeFileSync(join(directory, name), source);
    assert.deepEqual(testSuites(directory), {
        fast: ["pure.test.ts"],
        native: ["direct.test.ts", "indirect.test.ts"],
        shaders: ["pinned-variant-shaders.test.ts"],
    });
    const root = resolve(import.meta.dirname, "../..");
    const files = Object.values(testSuites(join(root, "test")))
        .flat()
        .sort();
    assert.deepEqual(
        files,
        readdirSync(join(root, "test"))
            .filter((file) => file.endsWith(".test.ts"))
            .sort(),
    );
    assert.equal(new Set(files).size, files.length);
    assert.match(
        readFileSync(join(root, "package.json"), "utf8"),
        /dist\/test\/\*\.test\.js/,
    );
});
