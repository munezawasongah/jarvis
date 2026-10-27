// All connected UI clients (phone PWA, laptop browser, ...). Jarvis is a single-user system,
// so everything the assistant says goes to every connected screen.
export const clients = new Set();

export function broadcast(msg) {
  const data = JSON.stringify(msg);
  let n = 0;
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(data);
      n++;
    }
  }
  return n;
}
