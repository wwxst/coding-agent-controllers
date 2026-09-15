export class WorkBuddyControl {
    request;
    constructor(request) {
        this.request = request;
    }
    async run(cwd, prompt) {
        const response = await this.request('/api/v1/jobs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                cwd,
                prompt,
                model: 'deepseek-v4.1-flash',
                effort: 'high',
                permissionMode: 'auto',
            }),
        });
        return { jobId: this.data(response).id };
    }
    async status(jobId) {
        const job = await this.job(jobId);
        return {
            jobId: job.id,
            state: job.state,
            settled: job.settled,
            ...(job.status === undefined ? {} : { status: job.status }),
            ...(job.detail === undefined ? {} : { detail: job.detail }),
        };
    }
    async result(jobId) {
        const job = await this.job(jobId);
        const terminal = {
            jobId: job.id,
            state: job.state,
            settled: job.settled,
            ...(job.status === undefined ? {} : { status: job.status }),
            ...(job.detail === undefined ? {} : { detail: job.detail }),
        };
        if (!job.settled)
            return { ready: false, ...terminal, settled: false };
        const result = job.state === 'done'
            ? job.output?.result ?? await this.transcriptResult(jobId)
            : undefined;
        return {
            ready: true,
            ...terminal,
            settled: true,
            ...(result === undefined ? {} : { result }),
        };
    }
    async cancel(jobId) {
        const response = await this.request(`/api/v1/jobs/${encodeURIComponent(jobId)}/stop`, { method: 'POST' });
        return { jobId, stopped: this.data(response).stopped };
    }
    async resume(jobId, prompt) {
        const before = await this.job(jobId);
        const response = await this.request(`/api/v1/jobs/${encodeURIComponent(jobId)}/reply`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: prompt }),
        });
        const reply = this.data(response);
        return {
            jobId,
            ...(before.sessionId === undefined ? {} : { sessionId: before.sessionId }),
            delivered: reply.delivered,
        };
    }
    async job(jobId) {
        const response = await this.request(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
        return this.data(response).job;
    }
    async transcriptResult(jobId) {
        const response = await this.request(`/api/v1/jobs/${encodeURIComponent(jobId)}/transcript`);
        const updates = this.data(response).updates;
        const lastUserIndex = updates.findLastIndex(update => update.sessionUpdate === 'user_message_chunk');
        const chunks = updates.slice(lastUserIndex + 1)
            .filter(update => update.sessionUpdate === 'agent_message_chunk'
            && update.content?.type === 'text'
            && typeof update.content.text === 'string')
            .map(update => update.content?.text);
        return chunks.length === 0 ? undefined : chunks.join('');
    }
    data(response) {
        return response.data;
    }
}
