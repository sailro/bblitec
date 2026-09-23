import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import test from "node:test";

// The dispatcher's wiring, exercised through a spawned `scene-command`:
// the usage, the read-only commands, and the refusals the strict flag
// parser makes. A mis-wired flag is caught here rather than by hand.

const command = resolve("dist/src/scene-command.js");

function sceneCommand(...arguments_: string[]): {
    status: number | null;
    stdout: string;
    stderr: string;
} {
    const result = spawnSync(process.execPath, [command, ...arguments_], {
        encoding: "utf8",
        env: { ...process.env, BBLITE_DIST_LOCK_HELD: "1" },
    });
    return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
    };
}

test("help prints the usage generated from the command table and exits 0", () => {
    for (const invocation of [["help"], ["--help"], []]) {
        const result = sceneCommand(...invocation);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^Usage: scene-command <command>/);
        assert.match(
            result.stdout,
            /\n {2}check <check-id> \[--backend <value>\] \[--phase <value>\] \[--keep\] \[--observe\] \[--headed\]\n/,
        );
        assert.match(
            result.stdout,
            /\n {2}parity <id\|source\.ts\|all> \[--backend <value>\] \[--seek <value>\]/,
        );
        assert.match(
            result.stdout,
            /\n {2}validate <id\|source\.ts\|all> \[--cold\]\n/,
        );
    }
});

test("offers one command per question: the consolidated set, nothing else", () => {
    const help = sceneCommand("help");
    assert.equal(help.status, 0, help.stderr);
    const names = [...help.stdout.matchAll(/^ {2}([a-z]+)\b/gm)].map(
        (match) => match[1],
    );
    assert.deepEqual(names, [
        "help",
        "doctor",
        "setup",
        "list",
        "show",
        "status",
        "compile",
        "build",
        "process",
        "validate",
        "clean",
        "parity",
        "memory",
        "capture",
        "diff",
        "diagnose",
        "check",
        "measure",
        "probe",
        "neutrality",
        "survey",
    ]);
    // Each retired command is refused, not silently mapped.
    for (const retired of [
        "stability",
        "geometry",
        "uniforms",
        "compose",
        "observe",
        "probe-variants",
        "neutrality-generated",
    ]) {
        const result = sceneCommand(retired, "scene1");
        assert.equal(result.status, 1, retired);
        assert.match(result.stderr, new RegExp(`Unknown command '${retired}'`));
    }
});

test("refuses flag combinations across the consolidated readings", () => {
    const refusals: Array<[string[], RegExp]> = [
        [
            ["diff", "scene1", "--uniforms", "--compose"],
            /--uniforms and --compose are separate readings/,
        ],
        [["diff", "scene1", "--size", "64"], /--size does not apply/],
        [
            ["diff", "scene1", "--uniforms", "--backend", "dawn"],
            /--backend does not apply to --uniforms/,
        ],
        [
            ["diff", "scene1", "--compose", "--recapture"],
            /--recapture does not apply to --compose/,
        ],
        [["diff", "all"], /'all' applies to --compose only/],
        [
            ["check", "scene149", "--observe", "--keep"],
            /--keep selects native phases and does not compose with --observe/,
        ],
        [
            ["check", "scene149", "--headed"],
            /--headed shows the browser of --observe/,
        ],
        [
            ["neutrality", "baseline.txt", "--write"],
            /--write saves a generated-tree baseline and rides --generated/,
        ],
        [
            ["probe", "scene1", "--shader", "x", "--backend", "dawn"],
            /Unknown probe argument '--backend'/,
        ],
        [
            ["parity", "all", "--runs", "3"],
            /--runs requires one scene id or source path/,
        ],
        [
            ["parity", "scene1", "--differential"],
            /Unknown parity argument '--differential'/,
        ],
        [["survey", "no-such-entry.ts"], /survey: no TypeScript entry at /],
    ];
    for (const [invocation, message] of refusals) {
        const result = sceneCommand(...invocation);
        assert.equal(result.status, 1, invocation.join(" "));
        assert.match(result.stderr, message, invocation.join(" "));
    }
});

test("list prints every registered scene, as rows or JSON", () => {
    const rows = sceneCommand("list");
    assert.equal(rows.status, 0, rows.stderr);
    const lines = rows.stdout.trim().split(/\r?\n/);
    assert.ok(lines.length > 250);
    assert.ok(
        lines.some((line) =>
            line.startsWith("scene1\tScene 1 - BoomBox PBR\t"),
        ),
    );
    const json = sceneCommand("list", "--json");
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout) as Array<{ id: string }>;
    assert.equal(parsed.length, lines.length);
});

test("show prints the registry entry and needs an id", () => {
    const shown = sceneCommand("show", "scene1");
    assert.equal(shown.status, 0, shown.stderr);
    const entry = JSON.parse(shown.stdout) as {
        id: string;
        parity?: { maxFullMad: number };
    };
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
    assert.match(
        flag.stderr,
        /Unknown list argument '--bogus'\. Valid flags: --json\./,
    );
    const check = sceneCommand("check", "no-such-check");
    assert.equal(check.status, 1);
    assert.match(check.stderr, /No check is declared for 'no-such-check'/);
});

test("status reports a scene whose tree and binary are absent as not current", (t) => {
    mkdirSync(resolve("artifacts"), { recursive: true });
    const directory = mkdtempSync(resolve("artifacts/status-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const id = basename(directory).toLowerCase();
    const source = join(directory, `${id}.ts`);
    writeFileSync(source, "export {};\n");
    const result = sceneCommand("status", source);
    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(`status ${id}: NOT current`));
});
