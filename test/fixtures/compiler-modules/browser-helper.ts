export interface BrowserHandle {
    done(): void;
}

export function installBrowserHelper(
    canvas: HTMLElement,
    options: { estimatedBytes: number },
): BrowserHandle {
    const original = globalThis.fetch.bind(globalThis);
    if (options.estimatedBytes > 0) {
        canvas.dataset.loading = String(options.estimatedBytes);
    }
    return {
        done(): void {
            globalThis.fetch = original;
            delete canvas.dataset.loading;
        },
    };
}
