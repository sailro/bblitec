/**
 * A value read through an import reads the declaration the import stands
 * for (`resolvedSymbol`), so an imported name lowers as its own module's
 * binding does rather than as a second, importer-local copy.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

test("an imported module table is defined once, in its declaring module", () => {
    // Scene 96 indexes `SCENE96_BAND_OFFSETS`, a constant table its shared
    // module declares, by a row it computes at run time.
    const fileName = resolve(
        "corpus/babylon-lite/lab/lite/src/lite/scene96.ts",
    );
    const result = compileSource(readFileSync(fileName, "utf8"), { fileName });
    const definitions = [...result.cppFiles]
        .filter(
            ([file, text]) =>
                file.endsWith(".cpp") &&
                /^const [^\n;]*\bSCENE96_BAND_OFFSETS\b[^\n;]*\{/m.test(text),
        )
        .map(([file]) => file);
    assert.deepEqual(definitions, ["sources/_shared/scroll-tile-image.cpp"]);
    // Each row is read in place from that one constant table.
    assert.match(
        result.cppFiles.get("main.cpp") ?? "",
        /const bbl::js::Tuple<2>& v_block\d+_offset = bbl::js::array_index_checked\(bblscene::SCENE96_BAND_OFFSETS(\(\))?,/,
    );
});
