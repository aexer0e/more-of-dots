// Compares two .repsim files frame by frame. The static record is compared without
// player_labels, which the desktop engine renders and the web page draws itself.
import fs from 'node:fs';
import readline from 'node:readline';

const lines = file => readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })[Symbol.asyncIterator]();
const [a, b] = process.argv.slice(2).map(lines);
let frames = 0, different = 0, first = null;
for (;;) {
  const [x, y] = await Promise.all([a.next(), b.next()]);
  if (x.done || y.done) { if (x.done !== y.done) { different++; first ??= `length at line ${frames}`; } break; }
  let [left, right] = [x.value, y.value];
  if (frames === 0) [left, right] = [left, right].map(text => { const row = JSON.parse(text); delete row.player_labels; return JSON.stringify(row); });
  if (left !== right) {
    different++;
    if (first === null) { let i = 0; while (left[i] === right[i]) i++; first = `line ${frames} column ${i}: ${left.slice(i - 40, i + 40)} | ${right.slice(i - 40, i + 40)}`; }
  }
  frames++;
}
console.log(different ? `DIFFERENT ${different}/${frames} first ${first}` : `identical ${frames} records`);
process.exit(different ? 1 : 0);
