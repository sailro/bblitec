import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// `bblitec`'s usage line is generated from its option table; the parser
// is a switch over the same names. Both must name one set, or an accepted
// option goes undocumented (as --initial-search did) or a documented one
// is refused.

test("bblitec usage names exactly the options the parser accepts", () => {
    const result = spawnSync(process.execPath, [resolve("dist/src/cli.js")], {
        encoding: "utf8",
        env: { ...process.env, BBLITE_DIST_LOCK_HELD: "1" },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(
        result.stderr,
        /^Usage: bblitec <entry\.ts> \(--out <directory> \| --survey <census\.json>\) /,
    );
    const documented = new Set(
        [...result.stderr.matchAll(/(--[a-z-]+)/g)].map((match) => match[1]),
    );
    const parsed = new Set(
        [
            ...readFileSync("src/cli.ts", "utf8").matchAll(
                /case "(--[a-z-]+)":/g,
            ),
        ].map((match) => match[1]),
    );
    assert.ok(parsed.has("--initial-search"));
    assert.deepEqual([...documented].sort(), [...parsed].sort());
});
