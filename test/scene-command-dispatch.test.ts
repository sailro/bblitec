import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

// The dispatcher's wiring, exercised through a spawned `scene-command`:
// the usage, the read-only commands, and the refusals the strict flag
// parser makes. A mis-wired flag is caught here rather than by hand.

const command = resolve("dist/src/scene-command.js");

function sceneCommand(...arguments_: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [command, ...arguments_], {
        encoding: "utf8",
        env: { ...process.env, BBLITE_DIST_LOCK_HELD: "1" },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("help prints the usage generated from the command table and exits 0", () => {
    for (const invocation of [["help"], ["--help"], []]) {
        const result = sceneCommand(...invocation);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^Usage: scene-command <command>/);
        assert.match(result.stdout, /\n  check <check-id> \[--backend <value>\] \[--phase <value>\] \[--keep\]\n/);
        assert.match(result.stdout, /\n  parity <id\|source\.ts\|all> \[--exe <value>\]/);
        assert.match(result.stdout, /\n  validate <id\|source\.ts\|all> \[--cold\]\n/);
    }
});

test("list prints every registered scene, as rows or JSON", () => {
    const rows = sceneCommand("list");
    assert.equal(rows.status, 0, rows.stderr);
    const lines = rows.stdout.trim().split(/\r?\n/);
    assert.ok(lines.length > 250);
    assert.ok(lines.some((line) => line.startsWith("scene1\tScene 1 - BoomBox PBR\t")));
    const json = sceneCommand("list", "--json");
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout) as Array<{ id: string }>;
    assert.equal(parsed.length, lines.length);
});

test("show prints the registry entry and needs an id", () => {
    const shown = sceneCommand("show", "scene1");
    assert.equal(shown.status, 0, shown.stderr);
    const entry = JSON.parse(shown.stdout) as { id: string; parity?: { maxFullMad: number } };
    assert.equal(entry.id, "scene1");
    assert.equal(entry.parity?.maxFullMad, 0.002);
    const missing = sceneCommand("show");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /show needs <id\|source\.ts>/);
});

test("refuses an unknown command and an unknown flag, naming the valid set", () => {
    const unknown = sceneCommand("bogus");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown command 'bogus'/);
    const flag = sceneCommand("list", "--bogus");
    assert.equal(flag.status, 1);
    assert.match(flag.stderr, /Unknown list argument '--bogus'\. Valid flags: --json\./);
    const check = sceneCommand("check", "no-such-check");
    assert.equal(check.status, 1);
    assert.match(check.stderr, /No check is declared for 'no-such-check'/);
});

test("status reports a scene whose tree and binary are absent as not current", () => {
    const result = sceneCommand("status", "primitives");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /status primitives: NOT current/);
});
