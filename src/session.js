import { runAgent } from './agent.js';
import { broadcast } from './hub.js';

// One continuous conversation shared by every screen. Requests are queued so two devices
// talking at once cannot interleave tool calls.
export class Session {
  constructor({ client } = {}) {
    this.client = client;
    this.history = [];
    this.chain = Promise.resolve();
  }

  ask(text, { source = 'user', send = broadcast } = {}) {
    const run = this.chain.then(() => runAgent({ history: this.history, text, send, client: this.client, source }));
    this.chain = run.catch(() => {});
    return run;
  }

  reset() {
    this.history.length = 0;
  }
}
