/**
 * One run at a time per key; a duplicate arriving while it runs shares the
 * first run's result instead of repeating the work.
 *
 * The browser gives up on a slow request (a Drive upload, an offer letter
 * that renders a PDF and emails it) while the server carries on and
 * finishes. People then press the button again — and the second request
 * used to upload the same file twice, or send the candidate a second offer.
 * Joining the run already in flight makes that second press harmless.
 *
 * In memory, which is enough: the API runs as one process (see
 * ecosystem.config.js — fork mode, one instance).
 */
export class SingleFlight {
  private readonly running = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.running.get(key);
    if (existing) return existing as Promise<T>;
    const p = work().finally(() => this.running.delete(key));
    this.running.set(key, p);
    return p;
  }

  isRunning(key: string): boolean {
    return this.running.has(key);
  }
}
