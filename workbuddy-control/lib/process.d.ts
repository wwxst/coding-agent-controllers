export interface WorkBuddyService {
    readonly baseUrl: string;
    readonly pid: number;
    request(path: string, init?: RequestInit): Promise<unknown>;
    close(): Promise<void>;
}
export interface StartWorkBuddyOptions {
    command?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
}
export declare function startWorkBuddy(options?: StartWorkBuddyOptions): Promise<WorkBuddyService>;
