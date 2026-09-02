/** Identical-prompt cache. Hits are local and free (zero tokens, zero dollars). */

export interface CacheEntry {
  prompt: string;
  response: string;
  ownerWhenCached: string;
  createdAt: number;
}

export class PromptCache {
  private map = new Map<string, CacheEntry>();

  static normalize(prompt: string): string {
    return prompt.replace(/\s+/g, " ").trim();
  }

  has(prompt: string): boolean {
    return this.map.has(PromptCache.normalize(prompt));
  }

  get(prompt: string): CacheEntry | undefined {
    return this.map.get(PromptCache.normalize(prompt));
  }

  set(prompt: string, response: string, ownerWhenCached: string): void {
    const key = PromptCache.normalize(prompt);
    this.map.set(key, {
      prompt: key,
      response,
      ownerWhenCached,
      createdAt: Date.now(),
    });
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export const defaultCache = new PromptCache();
