// Provider adapters for SillyTavern's same-origin chat-completions backend.
// Never send browser requests (or SillyTavern's CSRF headers) to a provider.
export const API_PROVIDERS = Object.freeze({
    custom: { name: '自定义 OpenAI 兼容', endpoint: '', protocol: 'openai', models: true,
        hint: '填写服务商提供的基础地址；保留 /v1 或其他自定义路径。仅支持 Chat Completions，不支持 Responses 专用接口。' },
    volcengine: { name: '火山方舟 Plan', endpoint: 'https://ark.cn-beijing.volces.com/api/plan/v3', protocol: 'openai', models: false,
        hint: '使用 Plan 专属密钥与控制台模型 ID。Agent Plan 保留 /api/plan/v3；Coding Plan 可手动改为 /api/coding/v3，不会自动切换至按量付费地址。请确认套餐允许当前用途。' },
    qianfan: { name: '百度千帆 Plan', endpoint: 'https://qianfan.baidubce.com/v2/tokenplan/personal', protocol: 'openai', models: false,
        hint: '使用 Token Plan 专属密钥及套餐支持的模型 ID；保留 /v2/tokenplan/personal。请确认套餐允许当前用途。' },
    openai: { name: 'OpenAI / GPT', endpoint: 'https://api.openai.com/v1', protocol: 'openai', models: true,
        hint: '使用支持 Chat Completions 的文本模型；不支持仅限 Responses、图像、音频或 Realtime 的模型。' },
    deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com', protocol: 'openai', models: true,
        hint: '使用 DeepSeek 官方密钥；模型可从列表选择或按控制台名称手动填写。' },
    claude: { name: 'Anthropic / Claude（原生）', endpoint: 'https://api.anthropic.com/v1', protocol: 'claude', models: true,
        hint: '使用原生 Messages 协议，由酒馆 Claude 后端转发。第三方 OpenAI 兼容的 Claude 请选“自定义 OpenAI 兼容”。' },
    gemini: { name: 'Google Gemini（原生）', endpoint: 'https://generativelanguage.googleapis.com', protocol: 'gemini', models: true,
        hint: '使用 Gemini Developer API，由酒馆 Google AI Studio 后端转发；不是 Vertex AI。第三方 OpenAI 兼容的 Gemini 请选自定义模式。' },
    glm: { name: '智谱 GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai', models: false,
        hint: '默认使用智谱按量 API；模型 ID 请按控制台填写。其他套餐请使用对应的 OpenAI 兼容基础地址及密钥。' },
});

export function providerId(value) {
    return Object.hasOwn(API_PROVIDERS, value) ? value : 'custom';
}

export function getProvider(config = {}) {
    return API_PROVIDERS[providerId(config.provider)];
}

export function normalizeEndpoint(value, provider = 'custom') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        // Credentials and query-string keys belong in the separate secret field.
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
        let path = url.pathname.replace(/\/+$/, '');
        const protocol = API_PROVIDERS[providerId(provider)].protocol;
        if (protocol === 'claude') {
            path = path.replace(/\/messages$/i, '').replace(/\/models$/i, '');
            if (!path) path = '/v1';
        } else if (protocol === 'gemini') {
            path = path.replace(/\/v1beta(?:\/models(?:\/[^/]+:generateContent)?)?$/i, '');
            // The ST backend chooses the API version; do not accidentally double it.
            if (/\/v1(?:alpha)?(?:\/|$)/i.test(path)) return '';
        } else {
            // Responses is a different API, not a synonym for Chat Completions.
            if (/\/responses$/i.test(path)) return '';
            path = path.replace(/\/(?:chat\/completions|models)$/i, '');
        }
        url.pathname = path || '/';
        return url.toString().replace(/\/+$/, '');
    } catch {
        return '';
    }
}

export function connectionSignature(config = {}) {
    // Memory-only; never log this signature.
    return JSON.stringify([providerId(config.provider), normalizeEndpoint(config.endpoint, config.provider), String(config.apiKey || '')]);
}

export function switchProvider(config, nextProvider) {
    const id = providerId(nextProvider);
    if (id === providerId(config.provider)) return { ...config };
    // Do not reuse an old vendor's secret at the new endpoint.
    return { ...config, provider: id, endpoint: API_PROVIDERS[id].endpoint, apiKey: '', model: '' };
}

function validated(config, needsModel = false) {
    const id = providerId(config.provider);
    const provider = API_PROVIDERS[id];
    const endpoint = normalizeEndpoint(config.endpoint, id);
    const key = String(config.apiKey || '').trim();
    let model = String(config.model || '').trim();
    if (!endpoint) throw new Error('请填写有效的 HTTP(S) 基础地址，不要包含密钥、查询参数或 Responses 路径。');
    if (id !== 'custom' && !key) throw new Error('请填写该供应商的 API 密钥。');
    if (/[\r\n]/.test(key)) throw new Error('API 密钥不能含换行符。');
    if (provider.protocol === 'gemini') {
        model = model.replace(/^models\//, '');
        if (model && !/^[\w.-]+$/.test(model)) throw new Error('Gemini 模型 ID 格式不正确。');
    }
    if (needsModel && !model) throw new Error('请先手动填写或选择自检模型，并保存设置。');
    return { id, provider, endpoint, key, model };
}

export function buildGenerationRequest(config, messages) {
    const { id, provider, endpoint, key, model } = validated(config, true);
    const limit = Math.round(Math.min(12000, Math.max(256, Number(config.maxTokens) || 4096)));
    const common = { type: 'quiet', messages, model, stream: false };
    if (provider.protocol === 'claude') {
        return { ...common, chat_completion_source: 'claude', reverse_proxy: endpoint,
            proxy_password: key, max_tokens: limit, use_sysprompt: true, claude_use_sysprompt: true, include_reasoning: false };
    }
    if (provider.protocol === 'gemini') {
        return { ...common, chat_completion_source: 'makersuite', reverse_proxy: endpoint,
            proxy_password: key, max_tokens: limit, use_sysprompt: true, use_makersuite_sysprompt: true,
            include_reasoning: false, enable_web_search: false };
    }
    // The custom backend avoids ST's model-name heuristics and preserves Plan paths.
    // Explicitly override Authorization so the main API's saved key is never borrowed.
    const body = id === 'openai' ? { max_completion_tokens: limit } : { max_tokens: limit };
    return { ...common, chat_completion_source: 'custom', custom_url: endpoint,
        custom_include_headers: JSON.stringify({ Authorization: key ? 'Bearer ' + key : '' }),
        custom_include_body: JSON.stringify(body),
        // No temperature/top_p penalties: many reasoning models reject these.
        custom_exclude_body: JSON.stringify(['temperature', 'top_p', 'top_k', 'presence_penalty', 'frequency_penalty',
            id === 'openai' ? 'max_tokens' : 'max_completion_tokens']) };
}

export function buildModelsRequest(config) {
    const { provider, endpoint, key } = validated(config);
    if (!provider.models) return null;
    let base = endpoint;
    const headers = { Authorization: key ? 'Bearer ' + key : '' };
    if (provider.protocol === 'claude') {
        headers.Authorization = '';
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
    } else if (provider.protocol === 'gemini') {
        base += '/v1beta';
        headers.Authorization = '';
        headers['x-goog-api-key'] = key;
    }
    return { chat_completion_source: 'custom', custom_url: base,
        custom_include_headers: JSON.stringify(headers) };
}

export function extractModelIds(payload, config = {}) {
    const list = [payload?.data, payload?.data?.data, payload?.models, payload?.result].find(Array.isArray) || [];
    return [...new Set(list.filter(item => getProvider(config).protocol !== 'gemini'
        || !item?.supportedGenerationMethods || item.supportedGenerationMethods.includes('generateContent'))
        .map(item => typeof item === 'string' ? item : item?.id || item?.name || item?.model || '')
        .map(value => String(value).trim())
        .map(value => getProvider(config).protocol === 'gemini' ? value.replace(/^models\//, '') : value)
        .filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function textParts(content) {
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content.filter(part => !part?.thought && (!part?.type || ['text', 'output_text'].includes(part.type)))
        .map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')
        .join('\n').trim();
}

export function extractResponseText(payload) {
    // ST may preserve native content beside its OpenAI-shaped wrapper.
    if (Array.isArray(payload?.content)) return textParts(payload.content);
    if (Array.isArray(payload?.candidates)) return textParts(payload.candidates[0]?.content?.parts);
    return textParts(payload?.choices?.[0]?.message?.content)
        || textParts(payload?.choices?.[0]?.text)
        || textParts(payload?.content)
        || textParts(payload?.text);
    // Never fall back to reasoning_content/thinking or stringify objects as answers.
}

export function providerError(status, payload = {}) {
    // Classify upstream details, but do not display them: they may echo keys/prompts.
    const detail = JSON.stringify(payload?.error || payload?.message || '').toLowerCase();
    let message = '接口调用失败；请检查供应商、地址、密钥与模型，并确认酒馆版本支持该接口。';
    let transient = [408, 425, 429].includes(status) || status >= 500;
    let code = 'provider';
    if ([401, 403].includes(status) || /unauthori|forbidden|invalid.?api.?key|authentication|permission|access.denied/.test(detail)) {
        message = '密钥无效或没有权限；请检查是否使用了对应供应商／Plan 的专属密钥。';
        transient = false;
        code = 'auth';
    } else if (payload?.quota_error || /insufficient_quota|insufficient.balance|credit.balance|billing/.test(detail)) {
        message = '额度不足或套餐不可用；请检查供应商账户。';
        transient = false;
        code = 'quota';
    } else if (status === 429 || /rate.limit|too many requests|overload/.test(detail)) {
        message = '接口限流或繁忙，请稍后再试。';
        transient = true;
        code = 'rate_limit';
    } else if (status === 404 || /model.not.found|unknown.model/.test(detail)) {
        message = '地址或模型不存在；请核对基础路径和模型 ID。';
        transient = false;
    } else if (status === 400) {
        message = '接口不接受当前请求；请核对协议、模型和最大回复长度。';
        transient = false;
    } else if (payload?.error === true) {
        // Older native ST backends flatten even authentication failures into HTTP 500.
        transient = false;
    }
    const error = new Error(message);
    Object.assign(error, { code, httpStatus: status, transient });
    return error;
}

export async function requestProvider(route, body, { fetchImpl = globalThis.fetch, headers = {}, signal } = {}) {
    if (!['generate', 'status'].includes(route)) throw new Error('未知接口操作。');
    let response;
    let raw;
    try {
        response = await fetchImpl('/api/backends/chat-completions/' + route, {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal,
        });
        raw = await response.text();
    } catch (caught) {
        if (signal?.aborted || caught?.name === 'AbortError') {
            const error = new Error('API 请求已取消或超时。');
            error.name = 'AbortError';
            throw error;
        }
        const error = new Error('无法连接酒馆后端，请检查网络和酒馆服务。');
        error.transient = true;
        throw error;
    }
    let payload;
    try { payload = JSON.parse(raw); } catch {
        const error = new Error('接口未返回 JSON；请检查基础地址，勿填写网页地址。');
        error.transient = response.status >= 500;
        throw error;
    }
    if (!response.ok || payload?.error || payload?.type === 'error') throw providerError(response.status, payload);
    return payload;
}

export function readGenerationText(payload) {
    if (payload?.promptFeedback?.blockReason || ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT'].includes(payload?.candidates?.[0]?.finishReason)) {
        throw new Error('供应商未返回可用文本；请检查内容限制或更换可用模型。');
    }
    const text = extractResponseText(payload);
    if (!text) {
        const error = new Error('接口连接成功，但未返回最终文本；请确认模型支持文本回复，并尝试增加最大回复长度。');
        error.transient = true;
        throw error;
    }
    return text;
}

export async function testConnection(config, options = {}) {
    // No chat, character, references or self-check state are sent by this probe.
    const request = buildGenerationRequest(config, [{ role: 'user', content: 'Reply with OK only.' }]);
    const payload = await requestProvider('generate', request, options);
    readGenerationText(payload);
    return true;
}

// ST forwards provider SSE frames unchanged. Only final text deltas become answers.
export async function readSelfCheckStream(response, { signal, onActivity = () => {}, onProgress = () => {} } = {}) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', raw = '', text = '', finished = false, terminal = false;
    const fail = (message, explicit = false) => {
        const error = new Error(message);
        error.code = explicit ? 'provider_failure' : 'stream_interrupted';
        error.explicitFailure = explicit;
        return error;
    };
    const processFrame = frame => {
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) return;
        if (data.trim() === '[DONE]') { finished = true; return; }
        let payload;
        try { payload = JSON.parse(data); } catch { throw fail('自检流式数据格式异常；不自动重发。'); }
        if (payload.error || payload.type === 'error') {
            const error = providerError(Number(payload.error?.code) || 500, payload);
            const uncertain = /timeout|timed out|ECONNRESET|超时/i.test(JSON.stringify(payload.error || payload));
            error.code = uncertain ? 'timeout' : 'provider_failure';
            error.explicitFailure = !uncertain;
            throw error;
        }
        const candidate = payload.candidates?.[0];
        if (payload.promptFeedback?.blockReason || ['SAFETY','RECITATION','PROHIBITED_CONTENT'].includes(candidate?.finishReason)
            || payload.choices?.[0]?.finish_reason === 'content_filter') throw fail('供应商未返回可用文本；请检查内容限制或渠道配置。', true);
        let delta = '';
        if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') delta = payload.delta.text || '';
        else if (payload.type === 'content_block_start' && payload.content_block?.type === 'text') delta = payload.content_block.text || '';
        else if (candidate) delta = (candidate.content?.parts || []).filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
        else {
            const choice = payload.choices?.find(choice => !choice.index) || payload.choices?.[0];
            const content = choice?.delta?.content ?? choice?.message?.content ?? choice?.text;
            delta = typeof content === 'string' ? content : Array.isArray(content)
                ? content.filter(part => !part.thought && ['text','output_text'].includes(part.type)).map(part => part.text || '').join('') : '';
        }
        text += delta;
        onProgress({ textLength: text.length });
        if (payload.type === 'message_stop') finished = true;
        if (candidate?.finishReason || payload.choices?.some(choice => !choice.index && choice.finish_reason)) terminal = true;
    };
    try {
        while (!finished) {
            const part = await reader.read();
            if (signal?.aborted) throw fail('流式请求已停止。');
            if (part.done) break;
            if (part.value.byteLength) onActivity();
            const chunk = decoder.decode(part.value, {stream:true});
            raw += chunk;
            // Handle both LF and CRLF, including a CRLF split between network chunks.
            buffer += chunk;
            buffer = buffer.replace(/\r\n/g, '\n');
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
                processFrame(frame);
                if (finished) break;
            }
        }
        buffer += decoder.decode();
        if (!finished && buffer.trim()) processFrame(buffer);
        if (!finished && !terminal) throw fail('自检流式连接提前结束，未收到完成标记；不自动重发。');
        if (!text.trim()) throw fail('自检API已结束，但没有返回最终文本。', true);
        return { text, rawResponse: raw };
    } catch (error) {
        error.partialText = text;
        error.rawResponse = raw;
        throw error;
    } finally {
        try { await reader.cancel(); } catch { /* connection may already be closed */ }
        reader.releaseLock();
    }
}


// Relays may label SSE as JSON/plain text; inspect bytes instead of trusting the header.
export async function readSelfCheckResponse(response, options = {}) {
    if (!response.body?.getReader) {
        const rawResponse = await response.text();
        if (!/^\s*(?:data:|event:|id:|retry:|:)/.test(rawResponse)) return { transport: 'json', rawResponse };
        const bytes = new TextEncoder().encode(rawResponse);
        let consumed = false;
        const reader = { read: async () => consumed ? { done: true } : (consumed = true, { value: bytes, done: false }), cancel: async () => {}, releaseLock() {} };
        return { transport: 'stream', ...await readSelfCheckStream({ body: { getReader: () => reader } }, options) };
    }
    const reader = response.body.getReader();
    const chunks = [];
    const decoder = new TextDecoder();
    let prefix = '', ended = false;
    try {
        while (!ended && prefix.length < 8192) {
            const part = await reader.read(); ended = part.done;
            if (ended) break;
            chunks.push(part.value);
            if (part.value.byteLength) options.onActivity?.();
            prefix += decoder.decode(part.value, { stream: true });
            if (/^\s*(?:data:|event:|id:|retry:|:|[\[{])/.test(prefix) || (prefix.trim() && prefix.trimStart().includes('\n'))) break;
        }
        if (/^\s*(?:data:|event:|id:|retry:|:)/.test(prefix)) {
            const replay = { read: async () => chunks.length ? { value: chunks.shift(), done: false } : ended ? { done: true } : reader.read(), cancel: reason => reader.cancel(reason), releaseLock() {} };
            return { transport: 'stream', ...await readSelfCheckStream({ body: { getReader: () => replay } }, options) };
        }
        let rawResponse = prefix;
        while (!ended) {
            const part = await reader.read(); ended = part.done;
            if (!ended) {
                if (part.value.byteLength) options.onActivity?.();
                rawResponse += decoder.decode(part.value, { stream: true });
            }
        }
        rawResponse += decoder.decode();
        if (options.signal?.aborted) throw new Error('请求已停止');
        return { transport: 'json', rawResponse };
    } finally {
        try { await reader.cancel(); } catch { /* already closed */ }
        reader.releaseLock();
    }
}

export const SELF_CHECK_PARSER_VERSION = "sse-sniff-2";
