export class BrowserHud {
    private readonly element: HTMLDivElement;

    private constructor() {
        this.element = document.createElement("div");
        document.body.appendChild(this.element);
    }

    public static async create(): Promise<BrowserHud | null> {
        try {
            const response = await fetch("/hud.bin");
            if (!response.ok) return null;
            return new BrowserHud();
        } catch {
            return null;
        }
    }

    public update(value: number): void {
        this.element.textContent = String(value);
    }
}
