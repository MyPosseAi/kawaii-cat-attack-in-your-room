// Tiny logger: console + the 2D page's #log line (not visible inside the headset;
// use chrome://inspect on the PC for the Quest Browser console).
const lines = [];
export function log(msg) {
  const line = `[kca-vr ${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  lines.push(msg);
  if (lines.length > 4) lines.shift();
  const el = typeof document !== 'undefined' && document.getElementById('log');
  if (el) el.textContent = lines.join('\n');
}
