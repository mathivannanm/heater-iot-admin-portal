import type { StreamMessage } from "./types";

type Listener = (message: StreamMessage) => void;

/**
 * Tiny fan-out bus between the ingest layer and every connected SSE client.
 * Deliberately dependency-free; swap for Redis pub/sub when running more than
 * one server instance so every node sees every device update.
 */
export class EventBus {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(message: StreamMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // A broken client must never take down an ingest request.
        this.listeners.delete(listener);
      }
    }
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}
