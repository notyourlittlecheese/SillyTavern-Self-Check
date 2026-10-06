const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../index.js'), 'utf8').replace(/^import[^;]+;\r?\n/gm, '');
let adapters;
before(async () => { adapters = await import('../api-providers.mjs'); });

function harness() {
    const timers = new Map();
    let timerId = 0;
    const settings = { enabled: true, mode: 'dual_api', injection: {}, presets: [], dualApi: {
        endpoint: 'https://example.test/v1', apiKey: 'private-test-key', models: ['first', 'second', 'third'],
        fallbacks: [], timeoutSeconds: 120, maxTokens: 4096, retryTransient: true, contextMode: 'recent5',
    } };
    const context = { chat: [{ is_user: true, mes: 'request' }], chatId: 'chat-a', extensionSettings: { sillytavern_self_check: settings }, setExtensionPrompt() {} };
    const scope = vm.createContext({
        ...adapters,
        console: { warn() {}, error() {}, info() {} }, structuredClone, AbortController, URL, Blob,
        jQuery() {}, $: () => ({ text() {}, html() {} }), toastr: { warning() {}, success() {}, error() {} },
        SillyTavern: { getContext: () => context },
        setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
        clearTimeout(id) { timers.delete(id); }, settings,
    });
    vm.runInContext(source, scope);
    vm.runInContext(`const realSaveDiagnostic = saveDiagnostic; const realNormalizeSettings = normalizeSettings; normalizeSettings = () => settings;
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

test('two failures fall back to main API when takeover is selected', async () => {
    const h = harness(); h.settings.dualApi.failureMode = 'fallback_single'; h.mock(() => h.response(500, { error: 'unavailable' }));
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

test('IndexedDB keeps bounded run history and latest alias across in-memory resets', async () => {
    const h = harness(); const data = new Map();
    h.scope.indexedDB = { open() {
        const request = {};
        request.result = { createObjectStore() {}, transaction() {
            const tx = { objectStore: () => ({
                put(value, key) { data.set(key, structuredClone(value)); queueMicrotask(() => tx.oncomplete()); },
                delete(key) { data.delete(key); },
                get(key) { const read = {}; queueMicrotask(() => { read.result = structuredClone(data.get(key)); read.onsuccess(); }); return read; },
            }) }; return tx;
        } };
        queueMicrotask(() => { request.onupgradeneeded(); request.onsuccess(); }); return request;
    } };
    h.run("saveDiagnostic = realSaveDiagnostic; beginDetailedRun('test'); updateDetailedRun({status:'completed'}); beginDetailedRun('generation');");
    await h.run('diagnosticWriteQueue');
    h.run('detailedRun = null');
    const saved = await h.run("readDiagnostic('run')");
    assert.equal(data.size, 4); assert.equal(saved.kind, 'generation'); assert.equal(saved.attempts.length, 0);
    assert.equal(data.get('run-index').length,2);
    for (let i=0;i<15;i++) await h.run(`saveDiagnostic('run', {id:'run-'+${i},startedAt:${i}+10000000000000,attempts:[]})`);
    assert.equal(data.get('run-index').length,10);
    assert.equal([...data.keys()].filter(key=>key.startsWith('run:')).length,10);
    assert.equal(data.has('run:run-0'),false);
    assert.equal((await h.run("loadRunDetail('run-14')")).id,'run-14');
    h.settings.runtimeRecordLimit=3;
    await h.run("saveDiagnostic('prune',null)");
    assert.equal(data.get('run-index').length,3);
    assert.equal([...data.keys()].filter(key=>key.startsWith('run:')).length,3);
    assert.equal(data.has('prune'),false);
});

test('slow diagnostic storage never blocks capture before main request', async () => {
    const h = harness();
    h.run('saveDiagnostic = () => new Promise(() => {});');
    assert.equal(h.run("captureRealRequest({type:'normal',messages:[{role:'user',content:'real'}]})"), undefined);
    assert.equal(h.run('latestSnapshot.messages[0].content'), 'real');
});

test('hidden last assistant reply retains preceding user input in every context mode', async () => {
    for (const contextMode of ['recent5', 'custom', 'all']) {
        const h = harness();
        h.settings.dualApi.contextMode = contextMode;
        h.settings.dualApi.customTurns = 1;
        h.context.chat = [
            { is_user: true, is_system: false, mes: 'FLOOR100_VISIBLE_USER_INPUT' },
            { is_user: false, is_system: true, mes: 'FLOOR101_HIDDEN_ANSWER' },
        ];
        // SillyTavern removes hidden messages before calling extension interceptors.
        h.scope.outgoingChat = h.context.chat.filter(message => !message.is_system);
        // A normal generation must not read or require the composer.
        h.scope.document = { querySelector() { throw Error('Unexpected composer read'); } };
        h.mock(() => h.response(200, { text: h.good }));
        await h.run("sillyTavernSelfCheckInterceptor(outgoingChat, 0, () => { throw Error('Unexpected abort'); }, 'normal')");
        assert.equal(h.calls.length, 1);
        const userMessages = h.calls[0].messages.filter(message => message.role === 'user');
        assert.ok(userMessages.some(message => message.content === 'FLOOR100_VISIBLE_USER_INPUT'));
        assert.ok(!JSON.stringify(h.calls[0]).includes('FLOOR101_HIDDEN_ANSWER'));
        assert.equal(h.run('pendingRun.targetMessageFloor'), 2);
    }
});

test('direct generation without a new user message preserves the latest user turn', async () => {
    const h = harness();
    h.context.chat = [
        { is_user: true, is_system: false, mes: 'LAST_USER_INPUT' },
        { is_user: false, is_system: false, mes: 'VISIBLE_ANSWER' },
    ];
    h.scope.outgoingChat = h.context.chat;
    h.scope.document = { querySelector() { throw Error('Unexpected composer read'); } };
    h.mock(() => h.response(200, { text: h.good }));
    await h.run("sillyTavernSelfCheckInterceptor(outgoingChat, 0, () => {}, 'normal')");
    assert.ok(h.calls[0].messages.some(message => message.role === 'user' && message.content === 'LAST_USER_INPUT'));
});

test('mixed-provider fallback uses second channel after two attempts on first channel', async () => {
    const h = harness(); h.settings.dualApi.models = ['first'];
    h.settings.dualApi.fallbacks = [{ id:'native',provider:'claude',endpoint:'https://api.anthropic.com/v1',apiKey:'native-secret',models:['claude-sonnet-4-6'] }];
    h.mock(n => n <= 2 ? h.response(401, {error:'invalid key'}) : h.response(200,{content:[{type:'text',text:h.good}]}));
    const result = await h.call();
    assert.equal(h.calls.length,3); assert.equal(h.calls[2].chat_completion_source,'claude');
    assert.equal(h.calls[2].use_sysprompt,true); assert.equal(h.calls[2].proxy_password,'native-secret');
    assert.equal(result.text,h.good);
});

test('channel provider switch clears all selected models and secrets only on that channel', () => {
    const h = harness(); h.settings.dualApi.fallbacks = [{id:'native',provider:'custom',apiKey:'old-secret',model:'old',models:['old','old2']}];
    h.run("changeChannelProvider = changeChannelProvider; resetDualApiModelState = () => {};");
    h.run("changeChannelProvider(settings.dualApi.fallbacks[0], 'gemini')");
    assert.equal(h.settings.dualApi.apiKey,'private-test-key');
    assert.equal(h.settings.dualApi.fallbacks[0].apiKey,'');
    assert.equal(h.settings.dualApi.fallbacks[0].models.length,0);
    assert.equal(h.settings.dualApi.fallbacks[0].endpoint,adapters.API_PROVIDERS.gemini.endpoint);
});

test('connection test sends only the isolated probe, does not replace generation diagnostics', async () => {
    const h = harness(); h.run("renderSettingsTab = () => {}; beginDetailedRun('generation');");
    const id = h.run('detailedRun.id'); h.mock(() => h.response(200,{text:'OK'}));
    await h.run("testProviderChannel('primary')");
    assert.equal(h.calls.length,1); assert.deepEqual(h.calls[0].messages,[{role:'user',content:'Reply with OK only.'}]);
    assert.equal(h.run('detailedRun.id'),id); assert.equal(h.run("providerConnectionResults.get('primary').message"),'连接成功，已收到最终文本。');
});

test('manual model IDs remain selectable when absent from the remote list', () => {
    const h = harness();
    const html = h.run("dualApiModelChoicesHtml(settings.dualApi, ['remote-only'], {}, '')");
    assert.ok(html.includes('first')); assert.ok(html.includes('second')); assert.ok(html.includes('remote-only'));
});

test('manual model selections survive refresh and obsolete discovery results are ignored', async () => {
    const h = harness();
    h.run("updateDualApiModelControl = () => {}; markDirty = () => {}; fetchDualApiModelList = () => new Promise(resolve => { globalThis.resolveModels = resolve; });");
    const pending = h.run('fetchDualApiModels({force:true})');
    h.run('resetDualApiModelState()'); h.scope.resolveModels(['remote-only']); await pending;
    assert.equal(h.run('dualApiModels.length'),0); assert.deepEqual(h.settings.dualApi.models,['first','second','third']);
    h.run("fetchDualApiModelList = async () => ['remote-only'];"); await h.run('fetchDualApiModels({force:true})');
    assert.deepEqual(h.settings.dualApi.models,['first','second','third']);
});

test('imported greetings and ordinary code fences remain untouched', async () => {
    const h = harness(); const original = '```html\n<div>greeting</div>\n```';
    h.context.chat = [{is_user:false,mes:original}];
    await h.run('handleMessageReceived(0)'); assert.equal(h.context.chat[0].mes,original);
    h.scope.original = original;
    assert.equal(h.run('normalizeModelXmlText(original).source'),original);
});

test('provider controls cover all providers on primary and fallback channels without requests', () => {
    const h = harness();
    for (const key of ['primary','fallback-id']) {
        const html = h.run(`providerControlsHtml(settings.dualApi, '${key}')`);
        for (const id of Object.keys(adapters.API_PROVIDERS)) assert.ok(html.includes(`value="${id}"`));
        assert.ok(html.includes(`data-stsc-models="${key}"`)); assert.ok(html.includes(`data-stsc-probe="${key}"`));
    }
    assert.equal(h.calls.length,0);
});

test('manager renders every tab with populated questions and references', () => {
    const html = new Map();
    const chain = new Proxy({}, { get: (_, key) => key === 'length' ? 0 : () => chain });
    const scope = vm.createContext({
        ...adapters, console, structuredClone, AbortController, URL, Blob,
        jQuery() {},
        $(selector) { return new Proxy({}, { get: (_, key) => key === 'length' ? 0 : key === 'html' ? value => { html.set(selector, value); return chain; } : () => chain }); },
        SillyTavern: { getContext: () => ({ extensionSettings: {}, chat: [] }) },
        setTimeout() {}, clearTimeout() {},
        document: { getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } },
        window: { innerWidth: 1200, innerHeight: 800, matchMedia: () => ({matches:false}) },
    });
    vm.runInContext(source, scope);
    vm.runInContext(`
        const fixture = structuredClone(DEFAULT_SETTINGS);
        fixture.presets = [createBuiltInGeneralPreset()];
        fixture.references = [{id:'ref',name:'REFERENCE_SENTINEL',type:'restriction',enabled:true,scope:'global',content:'REFERENCE_CONTENT',position:'chat',depth:0,role:'system'}];
        fixture.temporaryInstructions = [{id:'temp',name:'COMMAND_SENTINEL',content:'COMMAND_CONTENT'}];
        fixture.dualApi.fallbacks = [{id:'fallback',provider:'custom',endpoint:'https://example.test/v1',models:['test-model'],apiKey:''}];
        fixture.mode = 'dual_api';
        normalizeSettings = () => fixture;
        initialized = true;
        renderAll();
    `, scope);
    for (const tab of ['status','latest','presets','references','temporary','settings','appearance','updates']) {
        assert.ok(html.get('#stsc_tab_' + tab)?.length > 100, tab + ' must render');
    }
    assert.ok(html.get('#stsc_tab_updates').includes('尚未检查远程版本'));
    assert.ok(html.get('#stsc_tab_presets').includes('data-question-id'));
    assert.ok(html.get('#stsc_tab_references').includes('REFERENCE_SENTINEL'));
    assert.ok(!html.get('#stsc_tab_presets').includes('data-stsc-provider'));
    assert.ok(!html.get('#stsc_tab_references').includes('data-stsc-provider'));
});

test('background and forced non-user update checks perform no network requests', async () => {
    const h = harness();
    h.scope.fetch = () => { throw Error('Unexpected update network request'); };
    h.run("getInstalledExtensionType = () => { throw Error('Unexpected extension lookup'); };");
    await h.run('checkForPluginUpdate()');
    await h.run('checkForPluginUpdate({force:true})');
    assert.equal(h.run('updateCheckInFlight'), false);
    assert.equal(JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../manifest.json'), 'utf8')).auto_update, false);
    assert.ok(!source.includes('updatePollTimer'));
    assert.ok(!source.includes('setTimeout(() => void checkForPluginUpdate'));
});

test('existing general presets inherit independent API setups; character presets do not bind APIs', () => {
    const h = harness();
    h.run(`settings.presets = [{id:'a',kind:'general'}, {id:'b',kind:'general'}, {id:'c',kind:'character'}];
        settings.generalPresetId = 'a'; syncPresetApiConfig(settings);`);
    assert.equal(h.run('settings.apiConfigPresetId'), 'a');
    assert.equal(h.run('settings.presets[0].apiConfig.dualApi.apiKey'), 'private-test-key');
    assert.equal(h.run('settings.presets[2].apiConfig'), undefined);
    h.run("settings.dualApi.models.push('new'); syncPresetApiConfig(settings);");
    assert.ok(!h.run('settings.presets[1].apiConfig.dualApi.models').includes('new'));
    assert.equal(h.run('syncPresetApiConfig(settings)'), false);
});

test('activating general presets restores mode, credentials, fallback channels, order and parameters', () => {
    const h = harness();
    h.run(`settings.presets = [{id:'a',kind:'general'}, {id:'b',kind:'general'}];
        settings.generalPresetId = 'a'; syncPresetApiConfig(settings);
        settings.dualApi.fallbacks = [{id:'fallback-a',provider:'claude',apiKey:'fallback-secret',models:['m2','m1'],enabled:true}];
        settings.dualApi.primaryIndex = 1; settings.dualApi.timeoutSeconds = 240;
        activateGeneralPreset(settings, settings.presets[1]);`);
    assert.equal(h.settings.dualApi.apiKey, 'private-test-key');
    assert.equal(h.settings.dualApi.fallbacks.length, 0);
    h.run(`settings.mode = 'single'; settings.dualApi.apiKey = 'b-secret';
        activateGeneralPreset(settings, settings.presets[0]);`);
    assert.equal(h.settings.mode, 'dual_api');
    assert.equal(h.settings.dualApi.timeoutSeconds, 240);
    assert.equal(h.settings.dualApi.primaryIndex, 1);
    assert.equal(h.settings.dualApi.fallbacks[0].apiKey, 'fallback-secret');
    assert.deepEqual(Array.from(h.settings.dualApi.fallbacks[0].models), ['m2','m1']);
    h.run('activateGeneralPreset(settings, settings.presets[1])');
    assert.equal(h.settings.mode, 'single'); assert.equal(h.settings.dualApi.apiKey, 'b-secret');
    // Disabling general questions and switching characters must not select a different API owner.
    h.run(`settings.generalEnabled = false; settings.characterEnabled = true;
        settings.presets.push({id:'c',kind:'character',apiConfig:{mode:'dual_api',dualApi:{apiKey:'wrong'}}});
        activateGeneralPreset(settings, settings.presets[2]); syncPresetApiConfig(settings);`);
    assert.equal(h.settings.dualApi.apiKey, 'b-secret');
});

test('deleting active preset restores the remaining preset without copying deleted credentials', () => {
    const h = harness();
    h.run(`settings.presets = [{id:'a',kind:'general'}, {id:'b',kind:'general'}];
        settings.generalPresetId = 'a'; syncPresetApiConfig(settings);
        settings.dualApi.apiKey = 'deleted-secret'; syncPresetApiConfig(settings);
        settings.presets.shift(); settings.generalPresetId = 'b'; syncPresetApiConfig(settings);`);
    assert.equal(h.settings.dualApi.apiKey, 'private-test-key');
    assert.equal(h.settings.apiConfigPresetId, 'b');
});

test('import binds current local APIs and ignores supplied credentials; export contains no API data', async () => {
    const h = harness();
    h.run(`settings.ui = {}; settings.presets = [createPreset('existing', 'general')];
        settings.generalPresetId = settings.presets[0].id; syncPresetApiConfig(settings);
        markDirty = () => syncPresetApiConfig(settings);`);
    const payload = h.run(`makePresetExportPayload({name:'imported',kind:'general',enabled:true,
        questions:[{text:'question',type:'open',length:'standard',enabled:true}],apiConfig:{apiKey:'hidden'}})`);
    assert.ok(!JSON.stringify(payload).includes('apiConfig'));
    payload.preset.apiConfig = {mode:'single',dualApi:{apiKey:'foreign-secret'}};
    h.scope.importFile = {size:500,text:async()=>JSON.stringify(payload)};
    await h.run('importPresetFile(importFile)');
    assert.equal(h.settings.presets.length, 2);
    assert.equal(h.settings.presets[1].apiConfig.dualApi.apiKey, 'private-test-key');
    assert.equal(h.settings.generalPresetId, h.settings.presets[0].id);
    assert.ok(!JSON.stringify(h.run('makePresetExportPayload(settings.presets[1])')).includes('private-test-key'));
});

test('draft API switching is isolated and saving persists the matching owner', () => {
    const h = harness();
    h.run(`settings.presets = [{id:'a',kind:'general'}, {id:'b',kind:'general'}];
        settings.generalPresetId = 'a'; syncPresetApiConfig(settings);
        updateSaveState = () => {}; applyTheme = () => {}; saveSettings = () => {};
        beginEditSession(); editDraft.dualApi.apiKey = 'draft-a'; markDirty();
        activateGeneralPreset(editDraft, editDraft.presets[1]); editDraft.dualApi.apiKey = 'draft-b'; markDirty();`);
    assert.equal(h.settings.dualApi.apiKey, 'private-test-key');
    h.run('discardEditDraft()');
    assert.equal(h.run('editDraft.generalPresetId'), 'a');
    assert.equal(h.run('editDraft.dualApi.apiKey'), 'private-test-key');
    h.run(`activateGeneralPreset(editDraft, editDraft.presets[1]); editDraft.dualApi.apiKey = 'saved-b';
        markDirty(); commitEditDraft({notify:false});`);
    const saved = h.context.extensionSettings.sillytavern_self_check;
    assert.equal(saved.generalPresetId, 'b'); assert.equal(saved.apiConfigPresetId, 'b');
    assert.equal(saved.presets[1].apiConfig.dualApi.apiKey, 'saved-b');
});

test('switching API preset invalidates pending model discovery and probe results', async () => {
    const h = harness();
    h.run(`settings.presets = [{id:'a',kind:'general'}, {id:'b',kind:'general'}];
        settings.generalPresetId = 'a'; syncPresetApiConfig(settings);
        updateDualApiModelControl = () => {}; markDirty = () => {};
        fetchDualApiModelList = () => new Promise(resolve => { globalThis.resolveList = resolve; });`);
    const pending = h.run('fetchDualApiModels({force:true})');
    h.run(`providerConnectionResults.set('primary',{message:'old result'});
        activateGeneralPreset(settings, settings.presets[1]);`);
    h.scope.resolveList(['stale-model']); await pending;
    assert.equal(h.run('dualApiModels.length'), 0);
    assert.equal(h.run('providerConnectionResults.size'), 0);
});


test('saved preset bindings survive full normalization and reload', () => {
    const h = harness();
    h.run(`normalizeSettings = realNormalizeSettings;
        const saved = normalizeSettings();
        const first = saved.presets.find(p => p.id === saved.generalPresetId);
        const second = createPreset('second', 'general'); saved.presets.push(second);
        syncPresetApiConfig(saved);
        saved.dualApi.apiKey = 'first-secret'; saved.dualApi.timeoutSeconds = 300;
        activateGeneralPreset(saved, second);
        saved.dualApi.apiKey = 'second-secret'; syncPresetApiConfig(saved);
        globalThis.firstId = first.id;
        globalThis.reloaded = JSON.parse(JSON.stringify(saved));`);
    h.context.extensionSettings.sillytavern_self_check = h.scope.reloaded;
    h.run(`const restored = normalizeSettings();
        activateGeneralPreset(restored, restored.presets.find(p => p.id === firstId));
        normalizeSettings();`);
    const saved = h.context.extensionSettings.sillytavern_self_check;
    assert.equal(saved.dualApi.apiKey, 'first-secret');
    assert.equal(saved.dualApi.timeoutSeconds, 300);
    assert.equal(saved.presets.find(p => p.name === 'second').apiConfig.dualApi.apiKey, 'second-secret');
});

function qrHarness() {
    const h = harness();
    const notices = [];
    h.scope.toastr = Object.fromEntries(['success','warning','error'].map(level => [level, (message, title, options) => notices.push({level,message,options})]));
    h.run(`settings.presets = [createPreset('1.0','general'), createPreset('2.0','general')];
        settings.generalPresetId = settings.presets[0].id; settings.generalEnabled = true;
        syncPresetApiConfig(settings); settings.presets[1].apiConfig.dualApi.apiKey = 'second-secret';
        settings.enabled = false; saveSettings = () => { globalThis.savedCount = (globalThis.savedCount || 0) + 1; };
        clearRuntimePrompts = () => {};`);
    let command;
    h.context.SlashCommandParser = {addCommandObject(value) { command = value; }};
    h.context.SlashCommand = {fromProps: value => value};
    h.context.SlashCommandArgument = {fromProps: value => value};
    h.context.ARGUMENT_TYPE = {STRING:'string'};
    h.context.getRequestHeaders = () => ({'Content-Type':'application/json'});
    const sets = new Map();
    const api = {
        settings: {isEnabled:false,config:{setList:[]},save() {}},
        getSetByName: name => sets.get(name),
        getQrByLabel: (name,label) => sets.get(name)?.qrList.find(q => q.label === label),
        async createSet(name, options) { const set = {name,...options,qrList:[],save:async()=>{}}; sets.set(name,set); return set; },
        createQuickReply(name,label,props) { const qr = {label,...props}; sets.get(name).qrList.push(qr); return qr; },
        updateQuickReply(name,label,props) { const qr=api.getQrByLabel(name,label); Object.assign(qr,props); return qr; },
        addGlobalSet(name,isVisible) { const set=sets.get(name); if (!api.settings.config.setList.some(x=>x.set===set)) api.settings.config.setList.push({set,isVisible}); },
    };
    h.scope.quickReplyApi = api;
    const writes=[];
    h.scope.fetch = async (url, init) => { writes.push({url,body:JSON.parse(init.body)}); return {ok:true}; };
    return {...h,notices,api,sets,writes,getCommand:()=>command};
}

test('native QR command enables 1.0, toggles off, switches to 2.0 with its API and notifies at top', () => {
    const h=qrHarness(); h.run('registerPresetQrCommand()');
    const command=h.getCommand(); assert.equal(command.name,'stsc-preset-toggle');
    const [a,b]=h.settings.presets;
    const click=p=>command.callback({},encodeURIComponent(p.id));
    assert.equal(click(a),''); assert.equal(h.settings.enabled,true);
    assert.equal(h.settings.dualApi.apiKey,'private-test-key');
    click(a); assert.equal(h.settings.enabled,false);
    click(a); click(b); assert.equal(h.settings.enabled,true);
    assert.equal(h.settings.generalPresetId,b.id); assert.equal(h.settings.dualApi.apiKey,'second-secret');
    click(b); assert.equal(h.settings.enabled,false);
    assert.equal(h.notices.length,5);
    assert.ok(h.notices.every(n=>n.options.positionClass==='toast-top-center' && n.options.escapeHtml));
    assert.equal(h.calls.length,0);
});

test('QR ID survives rename and deleted presets, dirty drafts and active runs do not change configuration', () => {
    const h=qrHarness(); const id=h.settings.presets[0].id; h.scope.id=id;
    h.settings.presets[0].name='renamed'; h.run('togglePresetFromQr(id)');
    assert.ok(h.notices.at(-1).message.includes('renamed'));
    h.run('editDirty = true; togglePresetFromQr(id)'); assert.equal(h.settings.enabled,true);
    h.run('editDirty = false; dualApiBusy = true; togglePresetFromQr(id)'); assert.equal(h.settings.enabled,true);
    h.run('dualApiBusy = false; pendingRun = {}; togglePresetFromQr(id)'); assert.equal(h.settings.enabled,true);
    h.run('pendingRun = null; settings.presets.shift(); togglePresetFromQr(id)'); assert.equal(h.settings.enabled,true);
    assert.equal(h.notices.at(-1).level,'warning');
});

test('QR enables a disabled general preset and refreshes a clean editor draft', () => {
    const h=qrHarness();
    h.run(`settings.enabled = true; settings.generalEnabled = false; settings.presets[0].enabled = false;
        editDraft = clone(settings); togglePresetFromQr(settings.presets[0].id);`);
    assert.equal(h.settings.enabled,true); assert.equal(h.settings.generalEnabled,true);
    assert.equal(h.settings.presets[0].enabled,true);
    assert.equal(h.run('editDraft.enabled'),true);
    h.run('togglePresetFromQr(settings.presets[1].id)');
    assert.equal(h.run('editDraft.generalPresetId'),h.settings.presets[1].id);
    assert.equal(h.run('editDraft.dualApi.apiKey'),'second-secret');
});

test('creates multiple native named QR buttons containing only preset IDs, enables visible global set', async () => {
    const h=qrHarness();
    assert.equal(await h.run("createPresetQr(settings.presets[0].id, '1.0')"),true);
    const set=[...h.sets.values()][0];
    h.api.settings.config.setList[0].isVisible=false;
    assert.equal(await h.run("createPresetQr(settings.presets[1].id, '2.0')"),true);
    assert.equal(set.qrList.length,2);
    assert.equal(set.qrList[0].message,'/stsc-preset-toggle '+encodeURIComponent(h.settings.presets[0].id));
    assert.equal(set.disableSend,false); assert.equal(set.injectInput,false);
    assert.equal(h.api.settings.isEnabled,true);
    assert.equal(h.api.settings.config.setList.length,1);
    assert.equal(h.api.settings.config.setList[0].isVisible,true);
    assert.ok(!JSON.stringify(h.writes).includes('private-test-key'));
    assert.ok(!JSON.stringify(h.writes).includes('second-secret'));
    const original = set.qrList[0];
    original.icon='fa-star'; original.showLabel=false;
    assert.equal(await h.run("createPresetQr(settings.presets[1].id, ' 1.0 ')"),true);
    assert.equal(set.qrList[0],original);
    assert.equal(original.icon,'fa-star'); assert.equal(original.showLabel,false);
    assert.equal(original.message,'/stsc-preset-toggle '+encodeURIComponent(h.settings.presets[1].id));
    assert.ok(original.title.includes('2.0'));
    assert.ok(h.notices.at(-1).message.includes('已覆盖 QR“1.0”'));
    assert.equal(h.notices.at(-1).options.positionClass,'toast-top-center');
    assert.equal(h.writes.at(-1).body.qrList[0].message,original.message);
    h.getCommand().callback({},encodeURIComponent(h.settings.presets[1].id));
    assert.equal(h.settings.generalPresetId,h.settings.presets[1].id);
    assert.equal(h.settings.dualApi.apiKey,'second-secret');
    assert.equal(set.qrList.length,2);
});

test('QR creation handles unavailable native extension, unsaved presets, save failure and duplicate clicks', async () => {
    const h=qrHarness();
    h.scope.quickReplyApi=null;
    assert.equal(await h.run("createPresetQr(settings.presets[0].id,'test')"),false);
    h.scope.quickReplyApi=h.api;
    h.run('editDirty=true');
    assert.equal(await h.run("createPresetQr(settings.presets[0].id,'test')"),false);
    h.run('editDirty=false');
    h.scope.fetch=async()=>({ok:false});
    assert.equal(await h.run("createPresetQr(settings.presets[0].id,'test')"),false);
    assert.equal(h.notices.at(-1).level,'error');
    let resolveSave;
    h.scope.fetch=()=>new Promise(resolve=>{resolveSave=resolve;});
    const pending=h.run("createPresetQr(settings.presets[0].id,'next')");
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(await h.run("createPresetQr(settings.presets[0].id,'next')"),false);
    resolveSave({ok:true}); assert.equal(await pending,true);
});

test('handoff fallback uses explicit field, short leading title, then original full text', () => {
    const h=harness();
    h.scope.q={text:'【硬事实】完整的方法论正文',handoffText:'  一句话题意  '};
    assert.equal(h.run('getQuestionHandoffText(q)'),'一句话题意');
    h.scope.q.handoffText='  '; assert.equal(h.run('getQuestionHandoffText(q)'),'【硬事实】');
    h.scope.q.text='没有可靠标题的完整问题'; assert.equal(h.run('getQuestionHandoffText(q)'),h.scope.q.text);
    assert.equal(h.run('getQuestionHandoffText({})'),'');
});

test('12 reviewer questions stay full while both handoff formats retain exact answer mapping and omit evidence', () => {
    const h=harness();
    h.run(`questions.splice(0, questions.length, ...Array.from({length:12},(_,i)=>({id:'stable-'+i,text:'FULL_METHODOLOGY_'+i,handoffText:'HANDOFF_'+i,enabled:true,requireEvidence:true})));
        globalThis.rawXml='<stsc_self_check>'+questions.map((q,i)=>'<item id="q'+(i+1)+'"><answer>ANSWER_'+i+'\\nsecond line</answer><evidence>EVIDENCE_'+i+'</evidence></item>').join('')+'</stsc_self_check>';
        globalThis.parsedCheck=parseModelOutput(rawXml,questions);`);
    const before=h.run('buildDualApiMessages([], questions, [], [], settings)');
    const old=h.run('buildDualApiMessages([], questions.map(({handoffText,...q})=>q), [], [], settings)');
    assert.deepEqual(JSON.parse(JSON.stringify(before)),JSON.parse(JSON.stringify(old)));
    for(const transform of [false,true]) {
        h.settings.dualApi.transformFormat=transform;
        const output=h.run('buildDualApiHandoffInjection(questions, parsedCheck, settings)');
        assert.ok(output.includes(h.run('buildDualApiAdjudicationPrompt()')));
        for(let i=0;i<12;i++) {
            assert.ok(JSON.stringify(before).includes('FULL_METHODOLOGY_'+i));
            assert.ok(output.includes('HANDOFF_'+i)); assert.ok(output.includes('ANSWER_'+i));
            assert.ok(!output.includes('FULL_METHODOLOGY_'+i)); assert.ok(!output.includes('EVIDENCE_'+i));
            const ui=h.run(`renderAnswerCard(parsedCheck.answers[${i}],${i})`);
            assert.ok(ui.includes('FULL_METHODOLOGY_'+i)); assert.ok(ui.includes('EVIDENCE_'+i));
            if(!transform) assert.ok(output.includes(`Q${i+1}：HANDOFF_${i}\nA${i+1}：ANSWER_${i}\nsecond line`));
        }
        h.run('questions[4].enabled=false');
        const filtered=h.run('buildDualApiHandoffInjection(questions, parsedCheck, settings)');
        assert.ok(!filtered.includes('HANDOFF_4')); assert.ok(filtered.includes('HANDOFF_5'));
        h.run('questions[4].enabled=true');
    }
});

test('live main injection and captured main request exclude full reviewer questions and evidence', async () => {
    const h=harness();
    h.run("questions[0].handoffText='HANDOFF_A'; questions[1].handoffText='HANDOFF_B';");
    h.mock(()=>h.response(200,{text:h.good}));
    await h.run("sillyTavernSelfCheckInterceptor([],0,()=>{},'normal')");
    assert.ok(JSON.stringify(h.calls[0]).includes('first question'));
    const text=h.run("runtimePromptTexts.get('stsc_dual_main')");
    assert.ok(text.includes('HANDOFF_A')); assert.ok(text.includes('A2：B'));
    assert.ok(!text.includes('first question')); assert.ok(!text.includes('A2依据'));
    h.scope.mainText=text;
    h.run("captureRealRequest({messages:[{role:'assistant',content:mainText}],model:'main'})");
    assert.ok(h.run('JSON.stringify(detailedRun.mainRequest)').includes('HANDOFF_A'));
    assert.ok(!h.run('JSON.stringify(detailedRun.mainRequest)').includes('first question'));
});

test('supplement and exhausted dual API fallback use handoff text; single mode retains full questions', async () => {
    for(const kind of ['partial','failed','single']) {
        const h=harness(); h.run("questions[0].handoffText='SHORT_A'; questions[1].handoffText='SHORT_B';");
        h.mock(()=>h.response(kind==='failed'?500:200,{text:'<stsc_self_check><item id="q2"><answer>B</answer><evidence>SECRET_EVIDENCE</evidence></item></stsc_self_check>'}));
        if(kind==='single') h.settings.mode='single';
        await h.run("sillyTavernSelfCheckInterceptor([],0,()=>{},'normal')");
        const text=h.run("[...runtimePromptTexts.values()].join('\\n')");
        if(kind==='single') assert.ok(text.includes('first question'));
        else {assert.ok(text.includes('SHORT_A')); assert.ok(!text.includes('first question')); assert.ok(!text.includes('second question')); assert.ok(!text.includes('SECRET_EVIDENCE'));}
    }
});

test('handoff field survives normalize, clone and preset export/import without a format bump', async () => {
    const h=harness();
    h.run(`settings.ui={}; const preset=createPreset('handoff-test','general');
        const q=createQuestion('FULL'); q.handoffText='SHORT'; preset.questions=[q];
        settings.presets=[preset]; settings.generalPresetId=preset.id;
        normalizeQuestion(q); globalThis.exported=makePresetExportPayload(clone(preset));
        markDirty=()=>{};`);
    assert.equal(h.scope.exported.preset.questions[0].handoffText,'SHORT');
    h.scope.importFile={size:500,text:async()=>JSON.stringify(h.scope.exported)};
    await h.run('importPresetFile(importFile)');
    assert.equal(h.settings.presets[1].questions[0].handoffText,'SHORT');
    assert.equal(h.settings.presets[1].questions[0].text,'FULL');
    delete h.scope.exported.preset.questions[0].handoffText;
    assert.equal(h.run('validateImportedPresetPayload(exported).questions[0].handoffText'),'');
});

test('replay test logs the same handoff builder while retaining full reviewer request and UI evidence', async () => {
    const h=harness();
    h.run(`questions[0].handoffText='REPLAY_A'; questions[1].handoffText='REPLAY_B';
        latestSnapshot={chatId:'chat-a',timestamp:Date.now(),removedInjections:0,messages:[{role:'user',content:'REAL_INPUT'}]};`);
    h.mock(()=>h.response(200,{text:h.good}));
    await h.run('testDualApiSelfCheckOnly()');
    assert.equal(h.run('detailedRun.status'),'test_completed');
    assert.equal(h.run('detailedRun.mainHandoffPreview'),h.run('buildDualApiHandoffInjection(questions,parseModelOutput('+JSON.stringify(h.good)+',questions),settings)'));
    assert.ok(JSON.stringify(h.calls[0]).includes('first question'));
    assert.ok(h.run('lastTestResult').includes('依据：E'));
});

test('channel plan attempts models 1/2 per enabled channel, skips model 3, honors channel order', async () => {
    const h=harness();
    h.settings.dualApi.fallbacks=[
        {id:'b',endpoint:'https://b.test/v1',models:['b1','b2','b3']},
        {id:'off',endpoint:'https://off.test/v1',models:['off'],enabled:false},
        {id:'c',endpoint:'https://c.test/v1',models:['c1']},
    ];
    h.settings.dualApi.primaryIndex=1;
    h.mock(()=>h.response(503,{error:'unavailable'}));
    await assert.rejects(h.call());
    assert.deepEqual(h.calls.map(c=>c.model),['b1','b2','c1','c1','first','second']);
});

test('stop option aborts generation and clears all plugin injections after failures or incomplete answers', async () => {
    for(const incomplete of [false,true]) {
        const h=harness(); h.settings.dualApi.failureMode='stop';
        h.settings.dualApi.fallbacks=[{id:'b',endpoint:'https://b.test/v1',models:['b1','b2']}];
        h.mock(()=>incomplete?h.response(200,{text:'<stsc_self_check><item id="q1"><answer>A</answer></item></stsc_self_check>'}):h.response(503,{error:'down'}));
        let aborts=0; h.scope.abortMain=()=>aborts++;
        await h.run("sillyTavernSelfCheckInterceptor([],0,abortMain,'normal')");
        assert.equal(aborts,1); assert.equal(h.run('pendingRun'),null);
        assert.equal(h.run('runtimePromptTexts.size'),0);
        assert.equal(h.run('detailedRun.decision'),'stop_generation');
        assert.equal(h.calls.length,incomplete?1:4);
    }
});

test('streaming resets inactivity timeout on received chunks and passes only final text to parsing', async () => {
    const h=harness();
    let streamController;
    const body=new ReadableStream({start(controller){streamController=controller;}});
    const encoder=new TextEncoder();
    const tick=()=>new Promise(resolve=>setImmediate(resolve));
    h.scope.fetch=async(_url,init)=>{
        const request=JSON.parse(init.body); assert.equal(request.stream,true);
        init.signal.addEventListener('abort',()=>streamController.error(new Error('aborted')));
        return {ok:true,status:200,headers:{get:()=> 'text/event-stream'},body};
    };
    const pending=h.call(); await tick();
    const firstId=[...h.timers.keys()][0];
    streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"not-an-answer"}}]}\n\n')); await tick();
    assert.ok(!h.timers.has(firstId)); assert.equal(h.timers.size,1);
    streamController.enqueue(encoder.encode('data: '+JSON.stringify({choices:[{delta:{content:h.good}}]})+'\n\n')); await tick();
    streamController.enqueue(encoder.encode('data: [DONE]\n\n'));
    const result=await pending;
    assert.equal(result.text,h.good); assert.equal(h.timers.size,0);
});

test('silent stream timeout never switches channel and obeys stop mode', async () => {
    const h=harness(); h.settings.dualApi.failureMode='stop';
    let streamController,aborts=0;
    h.scope.abortMain=()=>aborts++;
    h.scope.fetch=async(_url,init)=>{
        const body=new ReadableStream({start(controller){streamController=controller;}});
        init.signal.addEventListener('abort',()=>streamController.error(new Error('aborted')));
        return {ok:true,status:200,headers:{get:()=> 'text/event-stream'},body};
    };
    const pending=h.run("sillyTavernSelfCheckInterceptor([],0,abortMain,'normal')");
    await new Promise(resolve=>setImmediate(resolve));
    [...h.timers.values()].find(t=>t.ms===120000).fn(); await pending;
    assert.equal(aborts,1); assert.equal(h.run('detailedRun.attempts.length'),1);
    assert.equal(h.run('runtimePromptTexts.size'),0);
});

test('per-channel budgets use configured models and cycle only within that channel', async () => {
    const h=harness(); h.settings.dualApi.maxAttempts=3;
    h.settings.dualApi.fallbacks=[{id:'b',endpoint:'https://b.test/v1',models:['b1','b2'],maxAttempts:4},{id:'c',endpoint:'https://c.test/v1',models:['c1'],maxAttempts:1}];
    h.mock(()=>h.response(503,{error:'down'})); await assert.rejects(h.call());
    assert.deepEqual(h.calls.map(c=>c.model),['first','second','third','b1','b2','b1','b2','c1']);
    assert.equal(h.run('channelAttemptLimit({})'),2);
    assert.equal(h.run('channelAttemptLimit({maxAttempts:99})'),10);
    assert.equal(h.run('channelAttemptLimit({maxAttempts:0})'),1);
    assert.equal(h.run('channelAttemptLimit({maxAttempts:"invalid"})'),2);
});

test('model reorder keeps exact membership, changes execution order, and rejects stale lists', () => {
    const h=harness();
    assert.equal(h.run("applySelectedModelOrder(settings.dualApi,['third','first','second'])"),true);
    assert.deepEqual(Array.from(h.run('channelPlannedModels(settings.dualApi)')),['third','first']);
    assert.equal(h.run("applySelectedModelOrder(settings.dualApi,['third','first','first'])"),false);
    assert.equal(h.run("applySelectedModelOrder(settings.dualApi,['unknown','first','second'])"),false);
});

test('attempt budgets survive normalization and preset switching without sharing configurations', () => {
    const h=harness();
    h.run(`normalizeSettings=realNormalizeSettings;
        const current=normalizeSettings();
        current.dualApi.maxAttempts=4;
        current.dualApi.fallbacks=[{id:'b',endpoint:'https://b.test/v1',models:['b1'],maxAttempts:7}];
        const next=createPreset('next'); current.presets.push(next); syncPresetApiConfig(current);
        activateGeneralPreset(current,next); current.dualApi.maxAttempts=1; current.dualApi.fallbacks[0].maxAttempts=2;
        normalizeSettings(); activateGeneralPreset(current,current.presets[0]); normalizeSettings();`);
    assert.equal(h.settings.dualApi.maxAttempts,4);
    assert.equal(h.settings.dualApi.fallbacks[0].maxAttempts,7);
});


test('custom channel names reach candidate results and defaults stay compatible', async () => {
    const h = harness();
    h.settings.dualApi.name = ' 常用站 ';
    h.settings.dualApi.maxAttempts = 1;
    h.settings.dualApi.fallbacks = [{id:'b',name:'备用直连',endpoint:'https://b.test/v1',models:['b1']}];
    assert.equal(h.run('getDualApiCandidates(settings.dualApi)[0].apiName'), '常用站');
    h.mock(n => n === 1 ? h.response(503,{error:'down'}) : h.response(200,{text:h.good}));
    const result = await h.call();
    assert.equal(result.apiName, '备用直连');
    assert.equal(h.run('channelDisplayName({})'), '主API配置');
    assert.equal(h.run("channelDisplayName({name:'  '},2)"), '备用API 2');
});

test('channel names survive normalization and independent general preset switching', () => {
    const h = harness();
    h.run(`normalizeSettings=realNormalizeSettings;
        const current=normalizeSettings();
        current.dualApi.name=' 常用站 ';
        current.dualApi.fallbacks=[{id:'b',name:' 备用直连 ',endpoint:'https://b.test/v1',models:['b1']}];
        normalizeSettings();
        const next=createPreset('next'); current.presets.push(next); syncPresetApiConfig(current);
        activateGeneralPreset(current,next);
        current.dualApi.name='另一套主站'; current.dualApi.fallbacks[0].name='另一套备用站';
        normalizeSettings(); activateGeneralPreset(current,current.presets[0]); normalizeSettings();`);
    assert.equal(h.settings.dualApi.name,'常用站');
    assert.equal(h.settings.dualApi.fallbacks[0].name,'备用直连');
});


test('QR overwrite reports save failure and refuses unsupported update without duplicating buttons', async () => {
    const h=qrHarness();
    await h.run("createPresetQr(settings.presets[0].id,'A')");
    const set=[...h.sets.values()][0];
    const originalMessage=set.qrList[0].message;
    const update=h.api.updateQuickReply; delete h.api.updateQuickReply;
    assert.equal(await h.run("createPresetQr(settings.presets[1].id,'A')"),false);
    assert.equal(set.qrList[0].message,originalMessage);
    h.api.updateQuickReply=update;
    h.scope.fetch=async()=>({ok:false});
    assert.equal(await h.run("createPresetQr(settings.presets[1].id,'A')"),false);
    assert.equal(h.notices.at(-1).level,'error');
    assert.equal(set.qrList.length,1);
});


test('runtime retention trims logs only, preserves preset data and cannot be undone by stale editor draft', async () => {
    const h=harness();
    h.run(`normalizeSettings=realNormalizeSettings; normalizeSettings();
        settings.logs=Array.from({length:30},(_,i)=>({id:'log-'+i,timestamp:30-i}));
        globalThis.presetBefore=JSON.stringify(settings.presets);
        globalThis.apiBefore=JSON.stringify(settings.dualApi);
        editDraft=clone(settings); normalizeSettings();`);
    assert.equal(h.settings.logs.length,10);
    await h.run('applyRuntimeRecordLimit(3)');
    assert.equal(h.settings.logs.length,3);
    assert.equal(h.run('editDraft.logs.length'),3);
    assert.equal(h.run('JSON.stringify(settings.presets)===presetBefore'),true);
    assert.equal(h.run('JSON.stringify(settings.dualApi)===apiBefore'),true);
    assert.equal(h.run('runtimeRecordLimit({})'),10);
    assert.equal(h.run('runtimeRecordLimit({runtimeRecordLimit:-2})'),1);
});

test('log details link to their original run and escape raw provider errors', async () => {
    const h=harness();
    h.run(`normalizeSettings=realNormalizeSettings; normalizeSettings();
        addRuntimeLog=${source.match(/function addRuntimeLog[\s\S]*?\n}/)[0]};
        renderLogBadge=()=>{};
        beginDetailedRun('generation');
        addRuntimeLog('error','自检API','FULL ERROR private-test-key','full handling');`);
    const log=h.settings.logs[0];
    assert.equal(log.runId,h.run('detailedRun.id'));
    assert.ok(!log.detailMessage.includes('private-test-key'));
    h.scope.detail={startedAt:Date.now(),status:'failed',attempts:[{label:'站点 / model-x',httpStatus:429,error:'<script>bad</script>',rawResponse:'original failure',elapsedMs:1234}]};
    const html=h.run('runDetailHtml(detail)');
    assert.ok(html.includes('model-x')); assert.ok(html.includes('429')); assert.ok(html.includes('1.2 秒'));
    assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('original failure'));
});
