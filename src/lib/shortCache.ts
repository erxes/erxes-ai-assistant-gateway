type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

export class ShortCache<T> {
  private values = new Map<string, CacheEntry<T>>();
  private inFlight = new Map<string, Promise<T>>();

  constructor(private ttlMs: number) {}

  get(key: string) {
    const cached = this.values.get(key);

    if (!cached) {
      return undefined;
    }

    if (cached.expiresAt <= Date.now()) {
      this.values.delete(key);
      return undefined;
    }

    return cached.value;
  }

  set(key: string, value: T) {
    this.values.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });

    return value;
  }

  clear(key?: string) {
    if (key) {
      this.values.delete(key);
      return;
    }

    this.values.clear();
  }

  getOrLoad(key: string, loader: () => Promise<T>) {
    const cached = this.get(key);

    if (cached !== undefined) {
      return Promise.resolve(cached);
    }

    const active = this.inFlight.get(key);

    if (active) {
      return active;
    }

    const promise = loader()
      .then((value) => this.set(key, value))
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);

    return promise;
  }
}
