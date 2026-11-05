/** HH:MM in Central time, for commit messages (matches the Mac mini's format). */
export function centralTime(d = new Date()) {
  return d.toLocaleTimeString('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit' });
}
