import { EmissionMap } from "./emission-transaction.js";
import { renameCppIdentifiers } from "./cpp-identifiers.js";

/** Intern native definitions modulo their explicitly owned local bindings. */
export class SharedNativeFunctions {
    private readonly names = new EmissionMap<string, string>();

    intern(name: string, definition: string, localBindings: ReadonlySet<string>): { name: string; added: boolean } {
        const locals = new Map<string, string>();
        const key = renameCppIdentifiers(definition, (token, qualified) => {
            if (qualified) return undefined;
            if (token === name) return "$function";
            if (!localBindings.has(token)) return undefined;
            let canonical = locals.get(token);
            if (canonical === undefined) {
                canonical = `$local${locals.size}`;
                locals.set(token, canonical);
            }
            return canonical;
        });
        const previous = this.names.get(key);
        if (previous !== undefined) return { name: previous, added: false };
        this.names.set(key, name);
        return { name, added: true };
    }
}
