#!/usr/bin/env node
// Attributes executable bytes to their contributing libraries from an
// MSVC linker map (BBLITE_MINSIZE links emit one beside the
// executable via /MAP). Symbol sizes are approximated by successive
// public-symbol address deltas within each section, which is accurate
// to symbol granularity for code and initialized data.
//
//   node tools/map-size-report.mjs native/build-scene1-min-sdl/Release/bblite_native.map

import { readFileSync } from "node:fs";

const mapPath = process.argv[2];
if (!mapPath) {
    console.error("Usage: node tools/map-size-report.mjs <bblite_native.map>");
    process.exit(2);
}

const publicPattern =
    /^\s+([0-9a-f]{4}):([0-9a-f]{8})\s+(\S+)\s+([0-9a-f]{16})\s+(?:f\s+)?(?:i\s+)?(\S+)$/i;

/** @type {Array<{ section: number, offset: number, origin: string }>} */
const rows = [];
let inPublics = false;
for (const line of readFileSync(mapPath, "utf8").split(/\r?\n/)) {
    if (line.includes("Publics by Value")) {
        inPublics = true;
        continue;
    }
    if (!inPublics) {
        continue;
    }
    const match = publicPattern.exec(line);
    if (!match) {
        continue;
    }
    const [, section, offset, , , origin] = match;
    if (section === undefined || offset === undefined || origin === undefined)
        throw new Error(`unparsed public symbol line: ${line}`);
    // Import thunks and absolute symbols carry addresses outside the
    // image and would corrupt the delta arithmetic.
    if (origin.startsWith("<absolute>")) {
        continue;
    }
    rows.push({
        section: Number.parseInt(section, 16),
        offset: Number.parseInt(offset, 16),
        origin,
    });
}

rows.sort((a, b) => a.section - b.section || a.offset - b.offset);

/** @param {string} origin */
function libraryOf(origin) {
    const colon = origin.indexOf(":");
    const library = (colon < 0 ? origin : origin.slice(0, colon)).toLowerCase();
    if (
        /^(libucrt|libcmt|libcpmt|libvcruntime|libconcrt|oldnames)/.test(
            library,
        )
    ) {
        return "[static CRT]";
    }
    if (library.endsWith(".obj")) {
        return "[engine objects]";
    }
    if (
        /^(kernel32|user32|gdi32|advapi32|shell32|ole32|oleaut32|uuid|winmm|imm32|version|setupapi|onecore)/.test(
            library,
        )
    ) {
        return "[system import libs]";
    }
    return library;
}

/** @type {Map<string, number>} */
const byLibrary = new Map();
for (const [index, row] of rows.entries()) {
    const next = rows[index + 1];
    const size =
        next && next.section === row.section ? next.offset - row.offset : 0;
    if (size <= 0 || size > 0x1000000) {
        continue;
    }
    const library = libraryOf(row.origin);
    byLibrary.set(library, (byLibrary.get(library) ?? 0) + size);
}

const entries = [...byLibrary.entries()].sort((a, b) => b[1] - a[1]);
const total = entries.reduce((sum, [, size]) => sum + size, 0);
console.log(
    `Attributed ${(total / 1048576).toFixed(2)} MiB across ${entries.length} contributors:`,
);
for (const [library, size] of entries) {
    if (size < 4096) {
        continue;
    }
    const share = ((size / total) * 100).toFixed(1).padStart(5);
    console.log(
        `${Math.round(size / 1024)
            .toString()
            .padStart(8)} KiB ${share}%  ${library}`,
    );
}
