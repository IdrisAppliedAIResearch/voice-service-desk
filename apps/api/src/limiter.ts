export function createRateLimiter(): (key: string, limit: number) => boolean {
  let window = 0;
  const hits = new Map<string, number>();
  return (key, limit) => {
    const current = Math.floor(Date.now() / 60_000);
    if (current !== window) {
      window = current;
      hits.clear();
    }
    const count = (hits.get(key) ?? 0) + 1;
    hits.set(key, count);
    return count <= limit;
  };
}
