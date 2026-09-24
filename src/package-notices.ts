/**
 * The third-party notices a release package owes, for every platform: one
 * entry per dependency the build links, named by what the generated scene
 * reaches and read from where the dependency was built -- the trimmed SDL,
 * RmlUi, LabSound and Dawn artifacts carry their own notices, vcpkg ports
 * their `copyright` files. Every vcpkg port the linked ports depend on (the
 * install's `vcpkg/status` graph) is included too, so a transitive library
 * is never left out. The desktop packager calls `packageNotices`; the
 * Android and iOS scripts run the command line below over their build.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCacheConfiguration } from "./build-stamp.js";
import { discoverDevelopmentTools } from "./development-tools.js";
import { imageCodecs } from "./image-codec-manifest.js";
import { findRepositoryRoot } from "./repository-root.js";
import { readShippingProfile } from "./shipping-profile.js";
import { isMainModule, parseFlags } from "./tooling/flags.js";

export type NoticePlatform = "windows" | "linux" | "macos" | "android" | "ios";

const noticePlatforms: readonly NoticePlatform[] = [
    "windows",
    "linux",
    "macos",
    "android",
    "ios",
];

export interface NoticeRequest {
    platform: NoticePlatform;
    /** The build's CMake cache. */
    cache: Readonly<Record<string, string>>;
    /** The generated scene's runtime features and image codecs. */
    runtime: readonly string[];
    codecs: readonly string[];
    /** Android: the NDK whose libc++_shared.so the package carries. */
    ndk?: string;
}

export interface PackageNotice {
    /** The file name under the package's `licenses` directory. */
    name: string;
    source: string;
}

const repositoryRoot = (): string =>
    findRepositoryRoot(dirname(fileURLToPath(import.meta.url)));

/** A vcpkg port the notice table names: its notice file and the port. */
interface PortNotice {
    name: string;
    port: string;
}

/**
 * The ports a scene's reached features link, with the notice file names
 * packages use. A dependency `native/vcpkg.json` names must appear here
 * (test/package-notices.test.ts).
 */
export function linkedPortNotices(request: NoticeRequest): PortNotice[] {
    const has = (feature: string): boolean => request.runtime.includes(feature);
    const cache = (name: string): string => request.cache[name] ?? "";
    const unix = request.platform !== "windows";
    const ports: PortNotice[] = [];
    if (!cache("BBLITE_SDL_DIR"))
        ports.push({ name: "SDL3.txt", port: "sdl3" });
    // The features native/CMakeLists.txt links nlohmann-json for.
    if (["loader:gltf", "loader:babylon", "data:json"].some(has))
        ports.push({ name: "nlohmann-json.txt", port: "nlohmann-json" });
    if (
        request.platform === "macos" ||
        request.platform === "ios" ||
        (request.platform === "android" && has("ui:rml"))
    )
        ports.push({ name: "Boost.Charconv.txt", port: "boost-charconv" });
    const codecs = new Set(request.codecs);
    // Capture writes PNG screenshots through SDL_image.
    if (cache("BBLITE_VISUAL_CAPTURE") !== "OFF") codecs.add("png");
    for (const codec of codecs) {
        const metadata = imageCodecs.find((entry) => entry.codec === codec);
        if (!metadata)
            throw new Error(
                `Unknown BBLITE_IMAGE_CODECS entry '${codec}'; regenerate the scene.`,
            );
        ports.push({ name: "SDL3_image.txt", port: "sdl3-image" });
        for (const [name, port] of Object.entries(metadata.licenses))
            ports.push({ name, port });
    }
    if (has("physics:world"))
        ports.push({ name: "bullet3.txt", port: "bullet3" });
    if (has("navigation:recast"))
        ports.push({ name: "recastnavigation.txt", port: "recastnavigation" });
    if (has("ui:rml") || has("text:layout"))
        ports.push({ name: "FreeType.txt", port: "freetype" });
    if (has("ui:rml") && unix) {
        // freetype[png] on these platforms: the system color fonts use PNG glyphs.
        ports.push({ name: "libpng.txt", port: "libpng" });
        ports.push({ name: "zlib.txt", port: "zlib" });
    }
    if (has("text:layout"))
        ports.push({ name: "HarfBuzz.txt", port: "harfbuzz" });
    // The RmlUi SVG plugin links LunaSVG where ui:inline-svg is reached, and
    // in every development build (native/dependency-features.cmake).
    if (
        has("ui:rml") &&
        (has("ui:inline-svg") || cache("BBLITE_MINSIZE") !== "ON")
    ) {
        ports.push({ name: "LunaSVG.txt", port: "lunasvg" });
        ports.push({ name: "PlutoVG.txt", port: "plutovg" });
    }
    if (has("data:locale") && unix)
        ports.push({ name: "ICU.txt", port: "icu" });
    if (has("platform:http") && unix)
        ports.push({ name: "curl.txt", port: "curl" });
    return ports;
}

interface InstalledPort {
    depends: Set<string>;
    /** From the port's own paragraph (a feature paragraph carries none). */
    version?: string;
}

/** The installed ports of `triplet` in a vcpkg install's status database, with their dependencies. */
function installedPorts(
    installed: string,
    triplet: string,
): Map<string, InstalledPort> {
    const statusPath = join(installed, "vcpkg", "status");
    if (!existsSync(statusPath))
        throw new Error(`vcpkg status database not found: ${statusPath}`);
    const ports = new Map<string, InstalledPort>();
    for (const paragraph of readFileSync(statusPath, "utf8").split(
        /\r?\n\r?\n/,
    )) {
        const fields = new Map<string, string>();
        for (const line of paragraph.split(/\r?\n/)) {
            const split = line.indexOf(": ");
            if (split > 0)
                fields.set(line.slice(0, split), line.slice(split + 2).trim());
        }
        const name = fields.get("Package");
        if (
            !name ||
            fields.get("Architecture") !== triplet ||
            fields.get("Status") !== "install ok installed"
        )
            continue;
        const port = ports.get(name) ?? { depends: new Set<string>() };
        const version = fields.get("Version");
        if (version !== undefined) port.version = version;
        for (const dependency of (fields.get("Depends") ?? "").split(",")) {
            const [depName, depTriplet] = dependency
                .trim()
                .replace(/\[[^\]]*\]/, "")
                .split(":");
            // A host tool (another triplet) links nothing into the package.
            if (depName && (depTriplet === undefined || depTriplet === triplet))
                port.depends.add(depName);
        }
        ports.set(name, port);
    }
    return ports;
}

/** Build helpers vcpkg installs for ports, which link no code. */
const buildOnlyPort = (port: string): boolean =>
    port.startsWith("vcpkg-") || port === "pkgconf";

/**
 * Whether the installed `port` holds only files under `share/` -- CMake
 * helpers and vcpkg metadata such as boost-uninstall's, which Boost's ports
 * depend on -- so it compiles and links nothing into the package. Read from
 * the file list vcpkg records for it (`vcpkg/info/<port>_<version>_<triplet>.list`).
 */
function sharesOnly(
    installed: string,
    triplet: string,
    name: string,
    port: InstalledPort,
): boolean {
    if (port.version === undefined)
        throw new Error(
            `vcpkg port '${name}' has no version in ${join(installed, "vcpkg", "status")}.`,
        );
    const list = join(
        installed,
        "vcpkg",
        "info",
        `${name}_${port.version}_${triplet}.list`,
    );
    if (!existsSync(list))
        throw new Error(`vcpkg file list not found for '${name}': ${list}`);
    return readFileSync(list, "utf8")
        .split(/\r?\n/)
        .filter((file) => file !== "" && !file.endsWith("/"))
        .every((file) => file.startsWith(`${triplet}/share/`));
}

/** The notices the package of `request`'s build owes, in a stable order. */
export function packageNotices(
    request: NoticeRequest,
    root = repositoryRoot(),
): PackageNotice[] {
    const cache = (name: string): string => request.cache[name] ?? "";
    const has = (feature: string): boolean => request.runtime.includes(feature);
    const required = (name: string, why: string): string => {
        const value = cache(name);
        if (!value)
            throw new Error(`${why}, but the build records no ${name}.`);
        return value;
    };
    const installed = required(
        "VCPKG_INSTALLED_DIR",
        "Package notices come from the build's vcpkg install",
    );
    const triplet = required(
        "VCPKG_TARGET_TRIPLET",
        "Package notices come from the build's vcpkg install",
    );
    const share = join(installed, triplet, "share");
    const notices = new Map<string, string>();
    const add = (name: string, source: string): void => {
        const previous = notices.get(name);
        if (previous !== undefined && resolve(previous) !== resolve(source))
            throw new Error(
                `Two notices claim ${name}: ${previous} and ${source}.`,
            );
        notices.set(name, source);
    };

    notices.set(
        "Babylon-Lite.txt",
        join(root, "node_modules", "@babylonjs", "lite", "LICENSE"),
    );
    const sdl = cache("BBLITE_SDL_DIR");
    // A trimmed SDL carries the notices of exactly the code it compiles
    // (tools/build-sdl-min.ps1); vcpkg's sdl3 notice covers its own build.
    if (sdl) add("SDL3.txt", join(sdl, "NOTICES.txt"));
    const linked = linkedPortNotices(request);
    for (const { name, port } of linked)
        add(name, join(share, port, "copyright"));
    // What the linked ports themselves depend on, transitively.
    const ports = installedPorts(installed, triplet);
    const named = new Set(linked.map(({ port }) => port));
    const pending = [...named];
    const reached = new Map<string, InstalledPort>();
    while (pending.length > 0) {
        const port = pending.pop()!;
        if (reached.has(port)) continue;
        const entry = ports.get(port);
        if (!entry)
            throw new Error(
                `The package links vcpkg port '${port}', which the install at ${installed} (${triplet}) does not hold.`,
            );
        reached.set(port, entry);
        for (const dependency of entry.depends) {
            if (buildOnlyPort(dependency)) continue;
            // The trimmed SDL replaces vcpkg's at link time.
            if (dependency === "sdl3" && sdl) continue;
            pending.push(dependency);
        }
    }
    const byName = [...reached].sort(([left], [right]) =>
        left < right ? -1 : 1,
    );
    for (const [port, entry] of byName) {
        if (!named.has(port) && !sharesOnly(installed, triplet, port, entry))
            add(`${port}.txt`, join(share, port, "copyright"));
    }

    if (has("ui:rml")) {
        // RmlUi arrives as the pinned artifact (tools/build-rmlui.ps1), not
        // vcpkg; its license travels inside the install the configure recorded.
        add(
            "RmlUi.txt",
            join(
                required("BBLITE_RMLUI_DIR", "The scene reaches ui:rml"),
                "RmlUi-LICENSE.txt",
            ),
        );
        // PAL font/control compatibility code retains its upstream notices.
        for (const notice of ["Skia", "Chromium"])
            add(
                `${notice}.txt`,
                join(root, "native", "notices", `${notice}.txt`),
            );
    }
    if (has("audio:engine")) {
        const labSound = required(
            "BBLITE_LABSOUND_DIR",
            "The scene reaches audio:engine",
        );
        const files = ["LabSound-LICENSE.txt", "LabSound-COPYING.txt"];
        // libnyquist links for capture or decoded audio (native/CMakeLists.txt).
        if (
            cache("BBLITE_AUDIO_CAPTURE") === "ON" ||
            has("audio:decoded-buffer")
        )
            files.push("libnyquist-LICENSE.txt", "libnyquist-COPYING.txt");
        for (const file of files) add(file, join(labSound, file));
    }
    const backend = cache("BBLITE_BACKEND");
    if (backend === "DAWN" || backend === "BOTH")
        add(
            "Dawn.txt",
            join(
                required("BBLITE_DAWN_DIR", `The build compiles ${backend}`),
                "LICENSE.txt",
            ),
        );
    if (request.platform === "android") {
        if (!request.ndk)
            throw new Error("Android notices need the NDK the package links.");
        add("NDK-toolchain.txt", join(request.ndk, "NOTICE.toolchain"));
        if (has("ui:rml"))
            add(
                "NotoSansSymbols2.txt",
                join(root, "native", "android", "fonts", "OFL.txt"),
            );
    }
    const result = [...notices.entries()]
        .map(([name, source]) => ({ name, source }))
        .sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        );
    for (const notice of result) {
        if (!existsSync(notice.source))
            throw new Error(
                `Notice ${notice.name} not found: ${notice.source}. Rebuild the dependency that provides it.`,
            );
    }
    return result;
}

/** Copies `notices` into `directory`. */
export function copyPackageNotices(
    notices: readonly PackageNotice[],
    directory: string,
): void {
    mkdirSync(directory, { recursive: true });
    for (const notice of notices)
        copyFileSync(notice.source, join(directory, notice.name));
}

/**
 * `node dist/src/package-notices.js --build-directory <dir> --platform <p>
 * --output <licenses> [--ndk <ndk>] [--cmake <cmake>]`: the notices of that
 * build, copied into the licenses directory.
 */
function main(): void {
    const parsed = parseFlags(
        process.argv.slice(2),
        {
            value: [
                "--build-directory",
                "--platform",
                "--output",
                "--ndk",
                "--cmake",
            ],
        },
        "package-notices",
    );
    const buildDirectory = parsed.values.get("--build-directory");
    const platform = noticePlatforms.find(
        (candidate) => candidate === parsed.values.get("--platform"),
    );
    const output = parsed.values.get("--output");
    if (!buildDirectory || !platform || !output)
        throw new Error(
            `package-notices: --build-directory <dir> --platform ${noticePlatforms.join("|")} --output <licenses> [--ndk <ndk>] [--cmake <cmake>]`,
        );
    const cache = readCacheConfiguration(buildDirectory);
    if (!cache)
        throw new Error(
            `No CMake cache in ${buildDirectory}; configure it first.`,
        );
    const cmake =
        parsed.values.get("--cmake") ?? discoverDevelopmentTools().cmake;
    if (!cmake)
        throw new Error("Package notices need CMake; run npm run doctor.");
    const generated = cache.BBLITE_GENERATED_DIR;
    if (!generated)
        throw new Error(`${buildDirectory} records no BBLITE_GENERATED_DIR.`);
    const profile = readShippingProfile(cmake, generated);
    const ndk = parsed.values.get("--ndk");
    const notices = packageNotices({
        platform,
        cache,
        runtime: profile.runtime,
        codecs: profile.codecs,
        ...(ndk !== undefined ? { ndk } : {}),
    });
    copyPackageNotices(notices, output);
    console.log(
        `Package notices: ${notices.map((notice) => notice.name).join(", ")}`,
    );
}

if (isMainModule(import.meta.url)) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
