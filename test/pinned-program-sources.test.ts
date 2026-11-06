import assert from "node:assert/strict";
import test from "node:test";
import { pinnedProgramSources } from "../src/pinned-program-sources.js";
import { sharedUpstreamStore } from "../src/upstream-source.js";
import { vendoredPackages } from "../src/vendored-package-sources.js";

test("vendored packages are source-available only as their exact installed TypeScript", () => {
    const packages = vendoredPackages(sharedUpstreamStore().packageRoot);
    const navcat = packages.get("navcat");
    const mathcat = packages.get("mathcat");
    assert.ok(navcat?.available && mathcat?.available);
    assert.equal(navcat.version, "0.4.1");
    assert.equal(navcat.entries.get("."), "src/index.ts");
    assert.ok(navcat.modules.has("src/query/find-path.ts"));
    // A module of types only stays a declaration; a barrel of re-exports is
    // its module's source.
    assert.ok(mathcat.modules.has("src/types.d.ts"));
    assert.ok(mathcat.modules.has("src/index.ts"));
    // Bundled WebAssembly glue carries no TypeScript.
    assert.equal(packages.get("@recast-navigation/wasm")?.available, false);
});

test("pinned modules over a source-available vendored package compile as program code", () => {
    const sources = pinnedProgramSources();
    for (const name of [
        "createNavcatManager",
        "findNavcatPath",
        "setNavcatFilter",
        "createNavcatDebugGeometry",
        "NavcatManager",
    ])
        assert.ok(sources.exports.has(name), name);
    for (const name of ["createBox", "createNavMesh", "Vec3"])
        assert.equal(sources.exports.get(name), undefined, name);
    const typings = sources.typings(
        "export declare function createNavcatManager(json: string): Promise<NavcatManager>;\nexport declare interface NavcatManager {}\n",
    );
    assert.doesNotMatch(typings, /declare function createNavcatManager/);
    assert.match(
        typings,
        /import \{[^}]*createNavcatManager[^}]*\} from "\.\/src\/navigation\/navcat\.js";/,
    );
});
