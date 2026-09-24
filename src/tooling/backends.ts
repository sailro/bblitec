/**
 * The GPU backend names every command and build option spells, parsed in
 * one place. A leaf module, so the build options and the measuring tools
 * can share it without importing each other.
 */

/**
 * Every backend a measured run can select. One list, because a command
 * that accepted a different set would be measuring something the others
 * cannot.
 */
export const NATIVE_BACKENDS = ["sdl_gpu", "dawn"] as const;

export type NativeBackend = (typeof NATIVE_BACKENDS)[number];

/** A native backend, or both of them. */
export type BackendSelection = NativeBackend | "both";

/**
 * The renderer set a build directory compiles, as CMake's `BBLITE_BACKEND`
 * spells a selection: the same names in upper case.
 */
export type CompiledBackend = Uppercase<BackendSelection>;

const COMPILED_BACKENDS = {
    sdl_gpu: "SDL_GPU",
    dawn: "DAWN",
    both: "BOTH",
} as const satisfies { readonly [S in BackendSelection]: Uppercase<S> };

export function compiledBackend(selection: BackendSelection): CompiledBackend {
    return COMPILED_BACKENDS[selection];
}

/** The selection a compiled renderer set measures: every backend it compiles. */
export function compiledSelection(backend: CompiledBackend): BackendSelection {
    return parseBackendName(backend, "BBLITE_BACKEND", true);
}

/**
 * The one backend-name parser. Case-insensitive, `-` and `_` alike, and
 * `gpu` accepted for `sdl_gpu` because that is the token the artifact
 * filenames carry; `both` only where the caller measures or builds both.
 * `source` names the flag or variable in the refusal.
 */
export function parseBackendName(
    value: string,
    source: string,
    allowBoth: true,
): BackendSelection;
export function parseBackendName(
    value: string,
    source: string,
    allowBoth: false,
): NativeBackend;
export function parseBackendName(
    value: string,
    source: string,
    allowBoth: boolean,
): BackendSelection {
    const normalized = value.toLowerCase().replaceAll("-", "_");
    const canonical = normalized === "gpu" ? "sdl_gpu" : normalized;
    if (canonical === "sdl_gpu" || canonical === "dawn") return canonical;
    if (allowBoth && canonical === "both") return canonical;
    throw new Error(
        `${source} must be sdl_gpu|dawn${allowBoth ? "|both" : ""} (got '${value}').`,
    );
}
