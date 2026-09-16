export declare class DesktopUnavailableError extends Error {
    readonly code = "WORKBUDDY_DESKTOP_UNAVAILABLE";
    constructor(message?: string);
}
export declare function getDesktopPipePath(): string;
export declare const DEFAULT_DESKTOP_PIPE_PATH: string;
export declare class DesktopPipeClient {
    private readonly pipePath;
    constructor(pipePath?: string);
    invoke<T>(channel: string, args: unknown[]): Promise<T>;
    invokeDetached(channel: string, args: unknown[]): Promise<void>;
    ping(): Promise<{
        extensionVersion: string;
        appVersion?: string;
    }>;
    private request;
}
