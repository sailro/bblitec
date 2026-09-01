import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Ports that install no code into the shipped executable — build-system
// helpers only. Everything else the manifest names is linkable, so the
// packager must carry a notice entry for it; exclusions live here, by
// name, where a review can see them.
const NOTICE_EXEMPT: ReadonlySet<string> = new Set([
    "vcpkg-cmake",
    "vcpkg-cmake-config",
]);

function dependencyNames(value: unknown, location: string): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        assert.fail(`${location} must be an array.`);
    }
    return value.map((entry: unknown, index) => {
        if (typeof entry === "string") return entry;
        if (
            entry === null ||
            typeof entry !== "object" ||
            Array.isArray(entry) ||
            !("name" in entry)
        ) {
            assert.fail(`${location}[${index}] must be a name or a named object.`);
        }
        const { name } = entry;
        if (typeof name !== "string") {
            assert.fail(`${location}[${index}].name must be a string.`);
        }
        return name;
    });
}

test("packager ships a third-party notice for every linkable dependency", () => {
    const manifest: unknown = JSON.parse(
        readFileSync("native/vcpkg.json", "utf8"),
    );
    if (
        manifest === null ||
        typeof manifest !== "object" ||
        Array.isArray(manifest)
    ) {
        assert.fail("native/vcpkg.json must contain an object.");
    }
    const names = new Set<string>(
        dependencyNames(
            "dependencies" in manifest ? manifest.dependencies : undefined,
            "dependencies",
        ),
    );
    const features = "features" in manifest ? manifest.features : undefined;
    if (features !== undefined) {
        if (
            features === null ||
            typeof features !== "object" ||
            Array.isArray(features)
        ) {
            assert.fail("native/vcpkg.json features must be an object.");
        }
        const definitions: ReadonlyArray<[string, unknown]> =
            Object.entries(features);
        for (const [feature, definition] of definitions) {
            if (
                definition === null ||
                typeof definition !== "object" ||
                Array.isArray(definition)
            ) {
                assert.fail(`features.${feature} must be an object.`);
            }
            for (const name of dependencyNames(
                "dependencies" in definition
                    ? definition.dependencies
                    : undefined,
                `features.${feature}.dependencies`,
            )) {
                names.add(name);
            }
        }
    }
    // RmlUi is the pinned artifact tools/build-rmlui.ps1 installs
    // (upstream/rmlui.json), not vcpkg, so the manifest never names it;
    // its notice is owed all the same wherever the ui feature links it.
    names.add("rmlui");

    const script = readFileSync("tools/package-demo.ps1", "utf8");
    const begin = script.indexOf(
        "# Third-party notices apply to every linked dependency.",
    );
    const end = script.indexOf("# End of third-party notices.");
    assert.ok(
        begin >= 0,
        "tools/package-demo.ps1 must open its notice table with the third-party marker comment",
    );
    assert.ok(
        end > begin,
        "tools/package-demo.ps1 must close its notice table with the end-of-notices marker comment",
    );
    const region = script.slice(begin, end);

    for (const name of [...names].sort()) {
        if (NOTICE_EXEMPT.has(name)) continue;
        // Whole-token match: 'sdl3' inside 'sdl3-image' proves nothing
        // about an sdl3 notice, so the name must stand on its own.
        const token = new RegExp(
            `(?<![A-Za-z0-9_-])${name.replaceAll(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&",
            )}(?![A-Za-z0-9_-])`,
        );
        assert.match(
            region,
            token,
            `tools/package-demo.ps1 ships no notice for linkable dependency '${name}'; add it to the notice table (or, for a non-linkable port, to NOTICE_EXEMPT here).`,
        );
    }
});
