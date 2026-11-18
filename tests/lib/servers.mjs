// Starts the project's own servers as child processes and resolves their loopback origin
// from the line each one prints when it begins listening.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function startServer({ label, file, cwd, port }) {
  const child = spawn(process.execPath, [path.resolve(cwd, file)], {
    cwd,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not report a URL within 30s\n${output}`)), 30000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ label, port: Number(match[1]), origin: `http://127.0.0.1:${match[1]}`, output });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited with code ${code}\n${output}`));
    });
  });
  return { ready, stop: () => { child.removeAllListeners('exit'); child.kill('SIGTERM'); } };
}

export async function stopAll(handles) {
  for (const handle of handles) handle.stop();
}

// The comparison suites need the reference project to exist; say so plainly instead of
// failing later with a connection error.
export function requireReference(root) {
  if (!existsSync(path.join(root, 'interactive_beta', 'data', 'catalog.json'))) {
    throw new Error(
      `Reference project not found at ${root}. Point YASIR_REFERENCE_ROOT at a yasir_pro checkout to run the comparison suites; the applications themselves need nothing outside this project.`);
  }
  return root;
}
