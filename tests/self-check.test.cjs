const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../index.js'), 'utf8');

function harness() {
    const timers = new Map();
    let timerId = 0;
    const settings = { enabled: true, mode: 'dual_api', injection: {}, presets: [], dualApi: {
        endpoint: 'https://example.test/v1', apiKey: 'private-test-key', models: ['first', 'second', 'third'],
        fallbacks: [], timeoutSeconds: 120, maxTokens: 4096, retryTransient: true, contextMode: 'recent5',
    } };
    const context = { chat: [{ is_user: true, mes: 'request' }], chatId: 'chat-a', extensionSettings: { sillytavern_self_check: settings }, setExtensionPrompt() {} };
    const scope = vm.createContext({
        console: { warn() {}, error() {}, info() {} }, structuredClone, AbortController, URL, Blob,
        jQuery() {}, $: () => ({ text() {}, html() {} }), toastr: { warning() {}, success() {}, error() {} },
        SillyTavern: { getContext: () => context },
        setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
        clearTimeout(id) { timers.delete(id); }, settings,
    });
    vm.runInContext(source, scope);
    vm.runInContext(`const realSaveDiagnostic = saveDiagnostic; normalizeSettings = () => settings;
        saveDiagnostic = async () => {}; addRuntimeLog = () => {}; renderAll = () => {};
        getDualApiCharacterContext = () => 'card'; getReviewSource = () => null;
        selectedRepairDirectives = () => []; getCurrentEntity = () => ({ name: 'test', key: 'test' });
        getActiveQuestions = () => questions; getDualApiQuestions = () => questions;
        getActiveReferences = () => []; getSelectedTemporaryInstructions = () => [];
        const questions = [{id:'stable-a',text:'first question'}, {id:'stable-b',text:'second question',requireEvidence:true}];
    `, scope);
    const run = code => vm.runInContext(code, scope);
    const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });
    const good = '<stsc_self_check><item id="q1"><answer>A</answer></item><item id="q2"><answer>B</answer><evidence>E</evidence></item></stsc_self_check>';
    let calls = [];
    const mock = fn => { scope.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return fn(calls.length, init); }; };
    const call = options => run(`callDualApiSelfCheck({chat:[], questions, references:[],temporaryInstructions:[],settings}, ${JSON.stringify(options || {})})`);
    return { scope, run, response, good, mock, call, calls, settings, context, timers };
}

test('valid response stops after first candidate, including provider warning', async () => {
    for (const status of [200, 500]) {
        const h = harness();
        h.mock(() => h.response(status, { choices: [{ message: { content: h.good } }], ...(status === 500 ? { error: 'warning' } : {}) }));
        const result = await h.call();
        assert.equal(h.calls.length, 1);
        assert.equal(result.text, h.good);
    }
});

test('explicit failures never exceed two candidates and never retry same candidate', async () => {
    const h = harness(); h.mock(() => h.response(429, { error: { message: 'rate limit' } }));
    await assert.rejects(h.call());
    assert.deepEqual(h.calls.map(c => c.model), ['first', 'second']);
});

test('second candidate can succeed after explicit failure', async () => {
    const h = harness(); h.mock(n => h.response(n === 1 ? 401 : 200, n === 1 ? { error: 'invalid key' } : { text: h.good }));
    assert.equal((await h.call()).model, 'second'); assert.equal(h.calls.length, 2);
});

test('timeout waits configured 120 seconds, aborts once and never switches', async () => {
    const h = harness();
    h.mock((n, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const pending = h.call();
    const timer = [...h.timers.values()][0]; assert.equal(timer.ms, 120000); timer.fn();
    await assert.rejects(pending, error => error.code === 'timeout'); assert.equal(h.calls.length, 1);
});

test('network interruption and gateway timeout do not launch another paid request', async () => {
    for (const status of [0, 408, 504]) {
        const h = harness(); h.mock(() => { if (!status) throw new TypeError('network'); return h.response(status, { error: 'timeout' }); });
        await assert.rejects(h.call()); assert.equal(h.calls.length, 1);
    }
});

test('test and disabled fallback each limit to a single request', async () => {
    for (const testOnly of [true, false]) {
        const h = harness(); h.settings.dualApi.retryTransient = testOnly;
        h.mock(() => h.response(500, { error: 'failure' }));
        await assert.rejects(h.call(testOnly ? { candidateLimit: 1 } : {})); assert.equal(h.calls.length, 1);
    }
});

test('incomplete answers go to main supplement without any additional API request', async () => {
    const h = harness(); h.mock(() => h.response(200, { text: '<stsc_self_check><item id="q2"><answer>B</answer></item></stsc_self_check>' }));
    await h.run("sillyTavernSelfCheckInterceptor([], 0, () => {}, 'normal')");
    assert.equal(h.calls.length, 1);
    assert.equal(h.run('pendingRun.supplementQuestions.length'), 2);
    assert.equal(h.run('pendingRun.dualParsed.answers[0].answer'), '');
    assert.equal(h.run('pendingRun.dualParsed.answers[1].answer'), 'B');
    assert.equal(h.run("runtimePromptTexts.has('stsc_supplement')"), true);
});

test('two failures fall back to main API even with old stop setting', async () => {
    const h = harness(); h.settings.dualApi.failureMode = 'stop'; h.mock(() => h.response(500, { error: 'unavailable' }));
    await h.run("sillyTavernSelfCheckInterceptor([], 0, () => { throw Error('unexpected stop'); }, 'normal')");
    assert.equal(h.calls.length, 2); assert.equal(h.run('pendingRun.mode'), 'single');
    assert.equal(h.run("runtimePromptTexts.has('stsc_main')"), true);
});

test('manual stop cancels in-flight request and never falls back to main', async () => {
    const h = harness(); let aborted = false; h.scope.abortGeneration = () => { aborted = true; };
    h.mock((n, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const pending = h.run("sillyTavernSelfCheckInterceptor([], 0, abortGeneration, 'normal')");
    h.run('onGenerationStopped()'); await pending;
    assert.equal(h.calls.length, 1); assert.equal(aborted, true); assert.equal(h.run('pendingRun'), null);
    assert.equal(h.run('dualApiBusy'), false); assert.equal(h.run('runtimePromptTexts.size'), 0);
});

test('supplement merge preserves known answer, adds evidence and does not hide omissions', () => {
    const h = harness();
    h.run(`const initial = parseModelOutput('<stsc_self_check><item id="q2"><answer>keep B</answer></item></stsc_self_check>', questions);
        const missing = dualParsedMissingRequirements(initial, questions);
        const extra = parseModelOutput('<stsc_self_check><item id="q1"><answer>new A</answer></item><item id="q2"><answer>replace B</answer><evidence>new E</evidence></item></stsc_self_check>', missing);
        const merged = mergeSupplementAnswers(initial, extra, questions, missing);`);
    assert.equal(h.run('merged.answers[1].answer'), 'keep B'); assert.equal(h.run('merged.answers[1].evidence'), 'new E');
    assert.equal(h.run('dualParsedIsComplete(merged, questions)'), true);
    assert.equal(h.run("dualParsedIsComplete(mergeSupplementAnswers(initial, {answers:[]}, questions, missing), questions)"), false);
});

test('snapshot removes owned blocks precisely, preserves suffix, roles and multimodal parts', () => {
    const h = harness();
    h.run(`const messages = [{role:'system',content:'prefix<!-- STSC_INJECTION_START:stsc_main -->old<!-- STSC_INJECTION_END:stsc_main -->suffix'}, {role:'user',content:[{type:'text',text:'question'}, {type:'image_url', image_url:{url:'data:image/png;base64,abc'}}]}];
        const cleaned = cleanSnapshotMessages(messages);`);
    assert.equal(h.run('cleaned.messages[0].content'), 'prefixsuffix');
    assert.equal(h.run('cleaned.removedInjections'), 1);
    assert.equal(h.run('cleaned.messages[1].content[1].image_url.url'), 'data:image/png;base64,abc');
    assert.equal(h.run('messages[0].content.includes("old")'), true);
});

test('replay bypasses history truncation and does not append current chat output', async () => {
    const h = harness(); h.context.chat.push({ is_user: false, mes: 'NEW ANSWER MUST NOT LEAK' });
    h.run("latestSnapshot = {chatId:'chat-a',timestamp:1,removedInjections:1,messages:[{role:'user',content:'ORIGINAL PROMPT'}]}");
    h.mock(() => h.response(200, { text: h.good }));
    await h.run('testDualApiSelfCheckOnly()');
    assert.equal(h.calls.length, 1);
    const request = JSON.stringify(h.calls[0]); assert.ok(request.includes('ORIGINAL PROMPT')); assert.ok(!request.includes('NEW ANSWER MUST NOT LEAK'));
});

test('test never substitutes chat history when snapshot is absent or belongs to another chat', async () => {
    for (const snapshot of [null, { chatId: 'other', messages: [] }]) {
        const h = harness(); h.scope.otherSnapshot = snapshot;
        h.run('latestSnapshot = otherSnapshot; readDiagnostic = async () => null;');
        h.mock(() => { throw new Error('must not call'); }); await h.run('testDualApiSelfCheckOnly()'); assert.equal(h.calls.length, 0);
    }
});

test('diagnostics capture request and raw response, omit credentials and preserve long output', async () => {
    const h = harness(); h.run("beginDetailedRun('test')");
    h.mock(() => h.response(200, { text: 'x'.repeat(20000) + 'private-test-key' })); await h.call();
    const detail = h.run('JSON.stringify(detailedRun)'); assert.ok(!detail.includes('private-test-key')); assert.ok(!detail.includes('proxy_password')); assert.ok(detail.includes('x'.repeat(20000)));
    assert.equal(h.run('detailedRun.attempts.length'), 1); assert.equal(h.run('detailedRun.attempts[0].httpStatus'), 200);
});

test('quiet calls cannot overwrite the latest real snapshot', async () => {
    const h = harness(); h.run("latestSnapshot = {chatId:'chat-a',messages:[{role:'user',content:'keep'}]}");
    await h.run("captureRealRequest({type:'quiet',messages:[{role:'user',content:'discard'}]})");
    assert.equal(h.run('latestSnapshot.messages[0].content'), 'keep');
});

test('main response merges local supplement ids, strips the check block and retains the body', async () => {
    const h = harness();
    h.run(`getBoundPreset = () => null; refreshMessageDom = () => {}; updateMessageText = (m, body) => { m.mes = body; };
        saveLatestResult = async result => { globalThis.savedResult = result; }; addGenerationResultLog = () => {};
        questions.push({id:'stable-c',text:'third question'});`);
    h.mock(() => h.response(200, { text: '<stsc_self_check><item id="q1"><answer>A</answer></item><item id="q3"><answer>C</answer></item></stsc_self_check>' }));
    await h.run("sillyTavernSelfCheckInterceptor([], 0, () => {}, 'normal')");
    h.context.chat.push({ is_user: false, mes: '<stsc_self_check><item id="q1"><answer>B</answer><evidence>E</evidence></item></stsc_self_check>ACTUAL BODY' });
    await h.run('handleMessageReceived(1)');
    assert.equal(h.context.chat[1].mes, 'ACTUAL BODY');
    assert.equal(h.run('savedResult.answers[1].answer'), 'B');
    assert.equal(h.run('savedResult.answers[2].answer'), 'C');
    assert.equal(h.run('savedResult.formatIssues.length'), 0);
    assert.equal(h.calls.length, 1);
});

test('IndexedDB write queue keeps only the latest run and survives in-memory reset', async () => {
    const h = harness(); const data = new Map();
    h.scope.indexedDB = { open() {
        const request = {};
        request.result = { createObjectStore() {}, transaction() {
            const tx = { objectStore: () => ({
                put(value, key) { data.set(key, structuredClone(value)); queueMicrotask(() => tx.oncomplete()); },
                get(key) { const read = {}; queueMicrotask(() => { read.result = structuredClone(data.get(key)); read.onsuccess(); }); return read; },
            }) }; return tx;
        } };
        queueMicrotask(() => { request.onupgradeneeded(); request.onsuccess(); }); return request;
    } };
    h.run("saveDiagnostic = realSaveDiagnostic; beginDetailedRun('test'); updateDetailedRun({status:'completed'}); beginDetailedRun('generation');");
    await h.run('diagnosticWriteQueue');
    h.run('detailedRun = null');
    const saved = await h.run("readDiagnostic('run')");
    assert.equal(data.size, 1); assert.equal(saved.kind, 'generation'); assert.equal(saved.attempts.length, 0);
});

test('slow diagnostic storage never blocks capture before main request', async () => {
    const h = harness();
    h.run('saveDiagnostic = () => new Promise(() => {});');
    assert.equal(h.run("captureRealRequest({type:'normal',messages:[{role:'user',content:'real'}]})"), undefined);
    assert.equal(h.run('latestSnapshot.messages[0].content'), 'real');
});
