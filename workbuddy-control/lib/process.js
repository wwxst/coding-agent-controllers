import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
const readyPattern = /(?:^|\r?\n)\s*Endpoint\s+(http:\/\/127\.0\.0\.1:\d+)\s*(?:\r?\n|$)/;
export async function startWorkBuddy(options = {}) {
    const password = randomBytes(32).toString('hex');
    const command = options.command ?? process.env.WORKBUDDY_CODEBUDDY_BIN ?? 'codebuddy';
    const child = spawn(command, [...(options.args ?? []), '--serve', '--port', '0', '--agent', 'cli'], {
        env: {
            ...process.env,
            ...options.env,
            CODEBUDDY_GATEWAY_AUTH: 'password',
            CODEBUDDY_GATEWAY_PASSWORD: password,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
    });
    const baseUrl = await readyUrl(child);
    const pid = child.pid;
    if (pid === undefined)
        throw new Error('codebuddy process has no pid');
    let closeTask;
    const close = () => {
        closeTask ??= stopProcessTree(child);
        return closeTask;
    };
    return {
        baseUrl,
        pid,
        request: async (path, init) => {
            const response = await fetch(`${baseUrl}${path}`, {
                ...init,
                headers: {
                    ...init?.headers,
                    'X-CodeBuddy-Request': '1',
                    Authorization: `Bearer ${password}`,
                },
            });
            const body = await response.json();
            if (!response.ok)
                throw new Error(`WorkBuddy Jobs API ${response.status}: ${JSON.stringify(body)}`);
            return body;
        },
        close,
    };
}
function readyUrl(child) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        const onData = (chunk) => {
            stdout += chunk.toString('utf8');
            const match = readyPattern.exec(stdout);
            if (match?.[1] !== undefined) {
                cleanup();
                child.stdout.resume();
                child.stderr.resume();
                resolve(match[1]);
            }
        };
        const onError = (error) => { cleanup(); reject(error); };
        const onExit = (code) => { cleanup(); reject(new Error(`codebuddy exited before ready (${code ?? 'signal'})`)); };
        const cleanup = () => {
            child.stdout.off('data', onData);
            child.off('error', onError);
            child.off('exit', onExit);
        };
        child.stdout.on('data', onData);
        child.once('error', onError);
        child.once('exit', onExit);
    });
}
async function stopProcessTree(child) {
    if (child.exitCode !== null || child.signalCode !== null)
        return;
    child.stdin.end();
    if (process.platform === 'win32') {
        await new Promise((resolve, reject) => {
            execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, error => {
                if (error === null || child.exitCode !== null || child.signalCode !== null)
                    resolve();
                else
                    reject(error);
            });
        });
    }
    else {
        try {
            process.kill(-child.pid, 'SIGTERM');
        }
        catch (error) {
            if (error.code !== 'ESRCH')
                throw error;
        }
        await waitForExit(child, 500);
        try {
            process.kill(-child.pid, 'SIGKILL');
        }
        catch (error) {
            if (error.code !== 'ESRCH')
                throw error;
        }
    }
    if (child.exitCode === null && child.signalCode === null) {
        await new Promise(resolve => child.once('exit', () => resolve()));
    }
}
async function waitForExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null)
        return;
    await new Promise(resolve => {
        const timer = setTimeout(resolve, timeoutMs);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}
