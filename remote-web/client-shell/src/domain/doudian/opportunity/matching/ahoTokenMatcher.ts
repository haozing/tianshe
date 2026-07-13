type TrieNode = {
  next: Map<string, number>;
  fail: number;
  outputs: string[];
};

function normalize(value: unknown) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

export class AhoTokenMatcher {
  private readonly nodes: TrieNode[] = [{ next: new Map(), fail: 0, outputs: [] }];

  constructor(tokens: string[]) {
    const normalized = new Map<string, string>();
    for (const token of tokens) {
      const key = normalize(token);
      if (Array.from(key).length <= 1 || normalized.has(key)) continue;
      normalized.set(key, String(token).trim());
    }
    for (const [key, original] of normalized.entries()) this.insert(key, original);
    this.buildFailures();
  }

  match(input: string): string[] {
    const hits = new Set<string>();
    let state = 0;
    for (const char of Array.from(normalize(input))) {
      while (state && !this.nodes[state].next.has(char)) state = this.nodes[state].fail;
      state = this.nodes[state].next.get(char) ?? 0;
      for (const token of this.nodes[state].outputs) hits.add(token);
    }
    return Array.from(hits);
  }

  private insert(key: string, original: string) {
    let state = 0;
    for (const char of Array.from(key)) {
      const existing = this.nodes[state].next.get(char);
      if (existing !== undefined) {
        state = existing;
        continue;
      }
      const nextIndex = this.nodes.length;
      this.nodes.push({ next: new Map(), fail: 0, outputs: [] });
      this.nodes[state].next.set(char, nextIndex);
      state = nextIndex;
    }
    this.nodes[state].outputs.push(original);
  }

  private buildFailures() {
    const queue: number[] = [];
    for (const child of this.nodes[0].next.values()) {
      this.nodes[child].fail = 0;
      queue.push(child);
    }
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head];
      for (const [char, child] of this.nodes[current].next.entries()) {
        let fail = this.nodes[current].fail;
        while (fail && !this.nodes[fail].next.has(char)) fail = this.nodes[fail].fail;
        this.nodes[child].fail = this.nodes[fail].next.get(char) ?? 0;
        this.nodes[child].outputs.push(...this.nodes[this.nodes[child].fail].outputs);
        queue.push(child);
      }
    }
  }
}
