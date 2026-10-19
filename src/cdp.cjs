"use strict";

// Minimal Chrome DevTools Protocol client over the global WebSocket (Node >= 22).

async function waitFor(what, fn, { timeoutMs = 30_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${lastError ? ` (${lastError.message})` : ""}`);
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

class Cdp {
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`Cannot connect to ${wsUrl}`));
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    ws.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.id && this.pending.has(data.id)) {
        const { resolve, reject } = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) reject(new Error(`${data.error.message}`));
        else resolve(data.result);
        return;
      }
      this.events.push(data);
      this.waiters = this.waiters.filter((waiter) => !waiter(data));
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  // Resolves with the first event (already received or future) named `method`.
  event(method, timeoutMs) {
    const seen = this.events.find((event) => event.method === method);
    if (seen) return Promise.resolve(seen.params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${method}`)), timeoutMs);
      this.waiters.push((event) => {
        if (event.method !== method) return false;
        clearTimeout(timer);
        resolve(event.params);
        return true;
      });
    });
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  close() {
    this.ws.close();
  }
}

module.exports = { Cdp, targets, waitFor };
