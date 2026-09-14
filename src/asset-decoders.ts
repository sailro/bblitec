import {createHash} from "node:crypto";

export interface AssetDecoderConfiguration {
    ktx2?: {javascript: string; wasmUrls?: Record<string, Record<string, string>>};
    draco?: {javascript: string; wasm: string};
}

export interface DracoDecoderAssets {javascript: Uint8Array; wasm: Uint8Array;}
export interface Ktx2DecoderAssets {
    url: string;
    wasmUrls?: Record<string, Record<string, string>>;
    resources: Record<string, Uint8Array>;
}
export interface AssetDecoders {
    ktx2?: () => Promise<Ktx2DecoderAssets>;
    draco?: () => Promise<DracoDecoderAssets>;
}

/** A configured decoder is read only when an asset actually reaches it. */
export function prepareAssetDecoders(
    configuration: AssetDecoderConfiguration | undefined,
    read: (source: string) => Promise<Uint8Array>,
): AssetDecoders {
    const once = <T>(load: () => Promise<T>): (() => Promise<T>) => {
        let pending: Promise<T> | undefined;
        return () => pending ??= load().catch(error => {pending = undefined; throw error;});
    };
    const result: AssetDecoders = {};
    if (configuration?.draco) {
        const {javascript, wasm} = configuration.draco;
        result.draco = once(async () => {
            const [js, binary] = await Promise.all([read(javascript), read(wasm)]);
            return {javascript: js, wasm: binary};
        });
    }
    if (configuration?.ktx2) {
        const {javascript, wasmUrls} = configuration.ktx2;
        result.ktx2 = once(async () => {
            const sources = new Map<string, string>();
            const served = (source: string): string => {
                let path = sources.get(source);
                if (!path) {
                    const name = source.split(/[?#]/)[0]!.split(/[\/\\]/).filter(Boolean).at(-1) ?? "decoder.bin";
                    path = `/asset-decoders/${createHash("sha256").update(source).digest("hex").slice(0, 16)}/${name}`;
                    sources.set(source, path);
                }
                return path;
            };
            const url = served(javascript);
            const mapped = wasmUrls && Object.fromEntries(Object.entries(wasmUrls).map(([name, fields]) =>
                [name, Object.fromEntries(Object.entries(fields).map(([field, source]) => [field, served(source)]))]));
            const resources = Object.fromEntries(await Promise.all([...sources].map(async ([source, path]) =>
                [path, await read(source)] as const)));
            return {url, ...(mapped ? {wasmUrls: mapped} : {}), resources};
        });
    }
    return result;
}
