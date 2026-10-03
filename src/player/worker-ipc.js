let sequence = 0;
const pending = new Map();
export function invoke(command, args = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    postMessage({ kind: "invoke", id, command, args });
  });
}
export function receiveReply(message) {
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error));
  else request.resolve(message.result);
}
