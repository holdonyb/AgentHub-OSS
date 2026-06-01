import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const webPort = '43073';
const apiPort = '43080';

function resolvePythonExecutable() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(repoRoot, '.venv', 'Scripts', 'python.exe'),
        path.join(repoRoot, '.venv', 'Scripts', 'uvicorn.exe'),
      ]
    : [
        path.join(repoRoot, '.venv', 'bin', 'python'),
        path.join(repoRoot, '.venv', 'bin', 'uvicorn'),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function spawnManaged(name, command, args, extraEnv = {}, options = {}) {
  const { fatalOnExit = true } = options;
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }

    if (signal) {
      console.error(`[${name}] exited from signal ${signal}`);
      if (fatalOnExit) {
        shutdown(1);
      }
      return;
    }

    if (code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
      if (fatalOnExit) {
        shutdown(code ?? 1);
      }
    }
  });

  return child;
}

const pythonExecutable = resolvePythonExecutable();
if (!pythonExecutable) {
  console.error('Local mode requires a project .venv. Run `python -m venv .venv` and install API dependencies first.');
  process.exit(1);
}

const apiArgs = pythonExecutable.endsWith('uvicorn.exe') || pythonExecutable.endsWith('/uvicorn')
  ? ['app.main:app', '--app-dir', 'apps/api', '--host', '127.0.0.1', '--port', apiPort]
  : ['-m', 'uvicorn', 'app.main:app', '--app-dir', 'apps/api', '--host', '127.0.0.1', '--port', apiPort];

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

let shuttingDown = false;
const children = [];

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  setTimeout(() => process.exit(exitCode), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

children.push(
  spawnManaged('api', pythonExecutable, apiArgs, {}, { fatalOnExit: false }),
  spawnManaged('web', npmCommand, ['run', 'web:dev'], {
    VITE_AGENTHUB_WEB_PORT: webPort,
    VITE_AGENTHUB_API_PROXY_URL: `http://127.0.0.1:${apiPort}`,
  }),
);

console.log(`AgentHub local mode running on http://127.0.0.1:${webPort} (API http://127.0.0.1:${apiPort})`);
