import { compileSource } from "./compiler.js";
import { observeIntrinsicRouting, type IntrinsicRoute } from "./compiler/intrinsics/registry.js";
import type { ApiSnapshot } from "./api-surface.js";

export interface ApiBinding {
    name: string;
    owner: string;
    status: "route-found" | "no-route-observed" | "probe-error";
    lowerer?: string;
    diagnostic?: string;
}

/**
 * Name-level dispatch only. Missing arguments never establish overload
 * support. `owners` restricts the probes to the functions a report is about.
 */
export function inspectApiBindings(snapshot: ApiSnapshot, owners?: ReadonlySet<string>): ApiBinding[] {
    const functions = new Set(snapshot.items.filter(item => item.kind === "function").map(item => item.owner));
    return Object.entries(snapshot.exports).filter(([, owner]) => functions.has(owner) && (owners === undefined || owners.has(owner)))
        .map(([name, owner]) => {
        let route: IntrinsicRoute | undefined;
        let failure: unknown;
        const restore = observeIntrinsicRouting(value => { if (value.name === name) route = value; });
        try {
            compileSource(`import { ${JSON.stringify(name)} as entry } from "@babylonjs/lite"; entry();`);
        } catch (error) { failure = error; }
        finally { restore(); }
        const diagnostic = failure instanceof Error ? failure.message : undefined;
        return { name, owner,
            status: route?.outcome === "missing" ? "no-route-observed" : route ? "route-found" : "probe-error",
            ...(route?.lowerer ? { lowerer: route.lowerer } : {}), ...(diagnostic ? { diagnostic } : {}) };
    });
}
