import vm from "node:vm";

/**
 * A small deterministic DOM boundary for the selectors this adapter consumes.
 * It models visibility, document order, attributes, mutation subscriptions and
 * teardown; it is not a claim about the live provider's markup.
 */
export class FixtureElement {
  readonly children: FixtureElement[] = [];
  readonly attributes = new Map<string, string>();
  parent: FixtureElement | undefined;
  hidden = false;
  complete = true;
  naturalWidth = 1024;
  naturalHeight = 572;
  get currentSrc(): string {
    return this.getAttribute("src") ?? "";
  }

  constructor(
    readonly tag: string,
    private ownText = "",
    attributes: Readonly<Record<string, string>> = {},
  ) {
    for (const [key, value] of Object.entries(attributes)) this.attributes.set(key, value);
  }

  get textContent(): string {
    return [this.ownText, ...this.children.map((child) => child.textContent)].join(" ");
  }
  get parentElement(): FixtureElement | null {
    return this.parent ?? null;
  }

  get classList(): { contains: (value: string) => boolean } {
    return {
      contains: (value) => (this.attributes.get("class") ?? "").split(/\s+/).includes(value),
    };
  }

  append(...elements: FixtureElement[]): this {
    for (const element of elements) {
      element.parent = this;
      this.children.push(element);
    }
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getClientRects(): readonly number[] {
    return this.hidden ? [] : [1];
  }
  remove(): void {
    const index = this.parent?.children.indexOf(this);
    if (index !== undefined && index >= 0) this.parent?.children.splice(index, 1);
  }

  cloneNode(): FixtureElement {
    const clone = new FixtureElement(this.tag, this.ownText, Object.fromEntries(this.attributes));
    clone.append(...this.children.map((child) => child.cloneNode()));
    return clone;
  }

  private descendants(): FixtureElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  private matches(selector: string): boolean {
    const last =
      selector
        .trim()
        .split(/\s+(?![^[]*\])/)
        .at(-1) ?? "";
    const tag = last.match(/^[a-z][\w-]*/i)?.[0];
    if (tag && tag !== this.tag) return false;
    const classes = [...last.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
    if (classes.some((name) => !this.classList.contains(name))) return false;
    return [...last.matchAll(/\[([\w-]+)(?:(\^?=)["']?([^"'\]]*)["']?)?\]/g)].every((match) =>
      match[2] === undefined
        ? this.hasAttribute(match[1])
        : match[2] === "^="
          ? this.getAttribute(match[1])?.startsWith(match[3]) === true
          : this.getAttribute(match[1]) === match[3],
    );
  }

  querySelectorAll(selector: string): FixtureElement[] {
    return this.descendants().filter((element) =>
      selector.split(",").some((part) => element.matches(part)),
    );
  }

  querySelector(selector: string): FixtureElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getRootNode(): FixtureElement {
    return this.parent?.getRootNode() ?? this;
  }

  compareDocumentPosition(other: FixtureElement): number {
    const root = this.getRootNode();
    const order = [root, ...root.descendants()];
    return order.indexOf(other) > order.indexOf(this) ? 4 : 2;
  }
}

export function fixtureDom(): {
  readonly root: FixtureElement;
  readonly evaluate: (expression: string) => Promise<unknown>;
  readonly mutate: (action: () => void) => void;
  readonly expire: () => void;
  readonly observers: () => number;
  readonly timers: () => number;
} {
  const root = new FixtureElement("html");
  const subscribers = new Set<() => void>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  class Observer {
    constructor(private readonly callback: () => void) {}
    observe(): void {
      subscribers.add(this.callback);
    }
    disconnect(): void {
      subscribers.delete(this.callback);
    }
  }
  const context = vm.createContext({
    document: {
      documentElement: root,
      querySelectorAll: (selector: string) => root.querySelectorAll(selector),
      querySelector: (selector: string) => root.querySelector(selector),
      getElementById: (id: string) => root.querySelector(`[id="${id}"]`),
    },
    location: {
      hostname: "gemini.google.com",
      origin: "https://gemini.google.com",
      href: "https://gemini.google.com/app/fixture",
    },
    Element: FixtureElement,
    HTMLImageElement: FixtureElement,
    HTMLVideoElement: FixtureElement,
    HTMLAudioElement: FixtureElement,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    MutationObserver: Observer,
    getComputedStyle: (element: FixtureElement) => ({
      visibility: element.hidden ? "hidden" : "visible",
    }),
    setTimeout: (callback: () => void) => {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  return {
    root,
    evaluate: async (expression) => vm.runInContext(expression, context),
    mutate: (action) => {
      action();
      for (const notify of subscribers) notify();
    },
    expire: () => {
      for (const timeout of timers.values()) timeout();
    },
    observers: () => subscribers.size,
    timers: () => timers.size,
  };
}
