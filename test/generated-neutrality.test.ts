import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
    compareGeneratedDigest,
    digestGeneratedTree,
    parseDigestBaseline,
} from "../src/generated-tree.js";

// `scene -- neutrality-generated`: the compile-and-digest half of the
// neutrality proof. The bar is the by-hand procedure it replaces — sha1
// every file under generated/, one `generated/<path>\t<hash>` line each —
// plus the footgun that procedure kept stepping on: entries no registry
// scene owns must be listed, never silently hashed.

function sha1(text: string): string {
    return createHash("sha1").update(text).digest("hex");
}

test("digests owned trees into sorted tab-separated sha1 lines", () => {
    const root = mkdtempSync(join(tmpdir(), "gen-digest-"));
    try {
        mkdirSync(join(root, "scene2", "nested"), { recursive: true });
        mkdirSync(join(root, "scene1"), { recursive: true });
        writeFileSync(join(root, "scene2", "nested", "b.txt"), "beta");
        writeFileSync(join(root, "scene1", "a.txt"), "alpha");
        const digest = digestGeneratedTree(root, [
            join(root, "scene1"),
            join(root, "scene2"),
            // Owned but not compiled on this checkout: contributes
            // nothing rather than failing the walk.
            join(root, "scene-not-on-disk"),
        ]);
        const prefix = basename(root);
        assert.deepEqual(digest.lines, [
            `${prefix}/scene1/a.txt\t${sha1("alpha")}`,
            `${prefix}/scene2/nested/b.txt\t${sha1("beta")}`,
        ]);
        assert.deepEqual(digest.strays, []);
        // Round trip: a digest compared against itself is neutral.
        const comparison = compareGeneratedDigest(
            parseDigestBaseline(`${digest.lines.join("\n")}\n`),
            digest.lines,
        );
        assert.deepEqual(comparison, {
            added: [],
            removed: [],
            changed: [],
            unchanged: 2,
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("an entry no registry scene owns is listed loudly, not hashed", () => {
    const root = mkdtempSync(join(tmpdir(), "gen-digest-"));
    try {
        mkdirSync(join(root, "scene1"), { recursive: true });
        writeFileSync(join(root, "scene1", "a.txt"), "alpha");
        // The corpus-sweep leftover and a stray top-level file: both are
        // strays, and neither may enter the digest — hashing them is how
        // two identical compiles digest differently.
        mkdirSync(join(root, "scene999"), { recursive: true });
        writeFileSync(join(root, "scene999", "junk.txt"), "junk");
        writeFileSync(join(root, "stray.txt"), "stray");
        const digest = digestGeneratedTree(root, [join(root, "scene1")]);
        assert.deepEqual(digest.strays, ["scene999", "stray.txt"]);
        assert.deepEqual(
            digest.lines,
            [`${basename(root)}/scene1/a.txt\t${sha1("alpha")}`],
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a missing root digests to nothing rather than failing", () => {
    assert.deepEqual(
        digestGeneratedTree(join(tmpdir(), "gen-digest-absent"), []),
        { lines: [], strays: [] },
    );
});

test("parses baseline lines strictly, refusing a malformed one", () => {
    const map = parseDigestBaseline("generated/a\t1111\ngenerated/b\t2222\n");
    assert.equal(map.size, 2);
    assert.equal(map.get("generated/a"), "1111");
    assert.equal(map.get("generated/b"), "2222");
    // A line without the tab-separated shape means the file is not a
    // digest baseline; tolerating it would let a truncated baseline pass.
    assert.throws(
        () => parseDigestBaseline("generated/a 1111\n"),
        /line 1 is not/,
    );
    assert.throws(
        () => parseDigestBaseline("generated/a\t1111\ngenerated/b\t\n"),
        /line 2 is not/,
    );
});

test("reports added, removed, changed and unchanged against a baseline", () => {
    const baseline = parseDigestBaseline(
        "generated/a\t1\ngenerated/b\t2\ngenerated/c\t3\n",
    );
    const comparison = compareGeneratedDigest(baseline, [
        "generated/a\t1",
        "generated/b\t9",
        "generated/d\t4",
    ]);
    assert.deepEqual(comparison, {
        added: ["generated/d"],
        removed: ["generated/c"],
        changed: ["generated/b"],
        unchanged: 1,
    });
});
