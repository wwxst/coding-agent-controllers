import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { connect } from 'node:net';
export class DesktopUnavailableError extends Error {
    code = 'WORKBUDDY_DESKTOP_UNAVAILABLE';
    constructor(message = 'WorkBuddy Desktop or the workbuddy-control Desktop Extension is unavailable.') {
        super(message);
        this.name = 'DesktopUnavailableError';
    }
}
export function getDesktopPipePath() {
    const userKey = createHash('sha256').update(homedir().toLowerCase()).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\workbuddy-control-desktop-v1-${userKey}`;
}
export const DEFAULT_DESKTOP_PIPE_PATH = getDesktopPipePath();
export class DesktopPipeClient {
    pipePath;
    constructor(pipePath = DEFAULT_DESKTOP_PIPE_PATH) {
        this.pipePath = pipePath;
    }
    invoke(channel, args) {
        return this.request('invoke', { channel, args });
    }
    invokeDetached(channel, args) {
        return this.request('invokeDetached', { channel, args });
    }
    ping() {
        return this.request('ping', {});
    }
    request(method, params) {
        return new Promise((resolve, reject) => {
            const id = randomUUID();
            const socket = connect(this.pipePath);
            let responseText = '';
            let settled = false;
            const finish = (error, value) => {
                if (settled)
                    return;
                settled = true;
                socket.destroy();
                if (error !== undefined)
                    reject(error);
                else
                    resolve(value);
            };
            socket.setEncoding('utf8');
            socket.setTimeout(30_000);
            socket.once('connect', () => {
                socket.write(`${JSON.stringify({ id, method, params })}\n`);
            });
            socket.on('data', chunk => {
                responseText += chunk;
                const newline = responseText.indexOf('\n');
                if (newline < 0)
                    return;
                try {
                    const response = JSON.parse(responseText.slice(0, newline));
                    if (response.id !== id)
                        throw new Error('Desktop Extension returned a mismatched response id.');
                    if (!response.ok) {
                        const error = new Error(response.error?.message ?? 'Desktop Extension request failed.');
                        if (response.error?.code !== undefined)
                            Object.assign(error, { code: response.error.code });
                        finish(error);
                        return;
                    }
                    finish(undefined, response.result);
                }
                catch (error) {
                    finish(error instanceof Error ? error : new Error(String(error)));
                }
            });
            socket.once('timeout', () => finish(new DesktopUnavailableError('WorkBuddy Desktop Extension pipe timed out.')));
            socket.once('error', error => finish(new DesktopUnavailableError(`WorkBuddy Desktop Extension pipe is unavailable: ${error.message}`)));
            socket.once('end', () => {
                if (!settled)
                    finish(new DesktopUnavailableError('WorkBuddy Desktop Extension pipe closed without a response.'));
            });
        });
    }
}
