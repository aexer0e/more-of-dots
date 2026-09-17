import { spawn } from 'node:child_process';
import path from 'node:path';
import { seedExamples, project } from './dev-data.mjs';

try {
  await seedExamples();
  const child = spawn(process.execPath, [path.join(project, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', ...process.argv.slice(2)], {
    cwd: project, stdio: 'inherit', env: { ...process.env, VITE_EXAMPLE_DATA: '1' },
  });
  child.on('exit', (code) => { process.exitCode = code ?? 0; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
} catch (error) { console.error(error.message); process.exitCode = 1; }
