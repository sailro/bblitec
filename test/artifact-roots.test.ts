import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
    ARTIFACT_ROOTS,
    artifactDirectory,
    isOwnedArtifact,
} from "../src/tooling/artifacts.js";
import { listFiles } from "../src/tooling/records.js";

// `clean --artifacts` deletes every artifacts/ entry the table does not
// name, so a writer the table forgot loses its state to the next clean:
// the native ccache, the shipping plans, the Android and iOS dependency
// installs and the scene149-transport reference once all did. Every
// `artifacts/<name>` a maintained source spells must be listed.

const scannedRoots = ["src", "tools", "checks"];
const nativeBuildScripts = readdirSync("native")
    .filter((name) => name === "CMakeLists.txt" || name.endsWith(".cmake"))
    .map((name) => join("native", name));

/** Every top-level artifacts/ name a source spells, by path or path parts. */
function referencedRoots(): Map<string, string> {
    const found = new Map<string, string>();
    const files = [
        ...scannedRoots.flatMap((root) => listFiles(root)),
        ...nativeBuildScripts,
    ].filter((file) => /\.(ts|mjs|js|json|ps1|psm1|cmake|txt)$/.test(file));
    const patterns = [
        // artifacts/<name> and artifacts\<name>
        /\bartifacts[\\/]+([A-Za-z0-9_.@-]+)/g,
        // "artifacts", "<name>" (join/resolve parts, one or several lines)
        /["']artifacts["'],\s*["']([A-Za-z0-9_.@-]+)["']/g,
    ];
    for (const file of files) {
        const text = readFileSync(file, "utf8");
        for (const pattern of patterns) {
            for (const match of text.matchAll(pattern)) {
                // A trailing period ends a sentence, not a name.
                const name = match[1]!.replace(/\.+$/, "");
                if (!found.has(name)) found.set(name, file);
            }
        }
    }
    return found;
}

test("every artifacts/ root a tool writes is owned, so clean --artifacts keeps it", () => {
    const referenced = referencedRoots();
    assert.ok(referenced.size > 10, "the scan finds the writers");
    const unowned = [...referenced]
        .filter(([name]) => !isOwnedArtifact(name))
        .map(([name, file]) => `${name} (${file})`);
    assert.deepEqual(unowned, []);
});

test("the owned-root table names each entry once, with a writer", () => {
    const names = ARTIFACT_ROOTS.map((root) => root.name);
    assert.equal(new Set(names).size, names.length);
    for (const root of ARTIFACT_ROOTS) {
        assert.notEqual(root.owner, "", root.name);
    }
    // Nothing writes a validate root; the old table kept one anyway.
    assert.ok(!isOwnedArtifact("validate"));
    // A prefix family owns its members, not unrelated names.
    assert.ok(isOwnedArtifact("ios-vcpkg-min-audio-codecs"));
    assert.ok(!isOwnedArtifact("ios-vcpkg-minimal"));
    assert.ok(!isOwnedArtifact("project-audit-tests"));
    assert.equal(
        artifactDirectory("capture", "scene1"),
        join("artifacts", "capture", "scene1"),
    );
});
