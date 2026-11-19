// Tests of src/app-hosts.js and of the launch and origin registration in
// src/core.js (MQTT and Redis doubles): origin by Application Context ID,
// Host, origins:associated, precedence of the broadband entry point and the
// tuning. Also the current profile in the core (default profile at startup
// and profile removal) and the LLS delivered to the unit that owns the list
// of services.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

// Fixed configuration: the core reads it once, when loaded.
process.env.APPS_DOMAIN = 'apps.localhost';
process.env.AOP_PUBLIC_PORT = '8080';
process.env.OBJECT_PROXY_PUBLIC_PORT = '8081';

const appHosts = require('../src/app-hosts');

// --- doubles -----------------------------------------------------------------
const FAIL = 'redis indisponivel (duble de teste)';
const store = new Map();
let down = false;
const hashOf = k => (store.get(k) instanceof Map ? store.get(k) : new Map());
// ['FCALL', function, ...args] of each write.
const writes = [];
const fakeRedis = {
    status: 'ready',
    once() {},
    on() {},
};
// The double mimics the EFFECT of the origin and profile functions
// (call('FCALL', function, 0, ...)), without checking the schema; the
// lastAccess of an unknown profile gives 0.
const ORIGENS = 'origins:associated';
const INDICE = 'users:index';
const indice = () => (store.get(INDICE) instanceof Set ? store.get(INDICE) : new Set());
// [function, message]: the function answers as for data outside the schema.
let recusa = null;
for (const [name, fn] of Object.entries({
    async call(cmd, nome, numkeys, ...args) {
        if (cmd !== 'FCALL' || Number(numkeys) !== 0) throw new Error(`call ${cmd} ${numkeys}: nao suportado pelo duble`);
        const a = args.map(String);
        if (recusa && recusa[0] === nome) throw new Error(recusa[1]);
        writes.push(['FCALL', nome, ...a]);
        const h = hashOf(ORIGENS);
        switch (nome) {
            case 'tv30_origins_clear': return store.delete(ORIGENS) ? 1 : 0;
            case 'tv30_origin_register': h.set(a[0], a[1]); store.set(ORIGENS, h); return 1;
            case 'tv30_origin_remove': return h.delete(a[0]) ? 1 : 0;
            case 'tv30_profile_write': {
                const [id, n] = a;
                const campos = new Map();
                for (let i = 2 + Number(n); i + 1 < a.length; i += 2) campos.set(a[i], a[i + 1]);
                store.set(INDICE, indice().add(id));
                store.set(`user:${id}`, campos);
                return 1;
            }
            case 'tv30_profile_last_access': return indice().has(a[0]) ? 1 : 0;
            // The Application Catalog, rewritten at each scan marker.
            case 'tv30_announced_services': {
                const catalogo = new Map();
                for (let i = 0; i + 1 < a.length; i += 2) catalogo.set(a[i], a[i + 1]);
                store.set('services:announced', catalogo);
                return catalogo.size;
            }
            default: throw new Error('ERR Function not found');
        }
    },
    async smembers(k) { return k === INDICE ? [...indice()] : []; },
    async hgetall(k) { return Object.fromEntries(hashOf(k)); },
    async hget(k, f) { return hashOf(k).has(f) ? hashOf(k).get(f) : null; },
})) {
    fakeRedis[name] = async (...args) => { if (down) throw new Error(FAIL); return fn(...args); };
}
const origins = () => Object.fromEntries(hashOf('origins:associated'));

// [topic, message, retained]
const published = [];
const fakeMqtt = new EventEmitter();
fakeMqtt.publish = (t, m, o) => { published.push([t, String(m), !!(o && o.retain)]); };
// [filter] of each subscribe and unsubscribe.
const subscribed = [];
const unsubscribed = [];
fakeMqtt.subscribe = (filter) => { subscribed.push(filter); };
fakeMqtt.unsubscribe = (filter) => { unsubscribed.push(filter); };
const lastGraphics = () => {
    const g = published.filter(([t]) => t === 'aop/display/layers/graphics');
    return g.length ? g[g.length - 1][1] : undefined;
};

function stubFile(file, exports) {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
}
stubFile(require.resolve(path.join(__dirname, '..', 'src', 'redis-client')), fakeRedis);
stubFile(require.resolve('mqtt'), { connect: () => fakeMqtt });

const realLog = console.log;
const realError = console.error;
// The core logs connection, profiles and proxy.
console.log = () => undefined;
console.error = () => undefined;
after(() => { console.log = realLog; console.error = realError; });

// An orphan origin of a previous run: the boot cleanup of the core deletes
// it.
store.set('origins:associated', new Map([['http://orfa.apps.localhost:8080', 'svc-velho']]));
const core = require('../src/core');
const bootstrap = require('../src/modules/bootstrap-application/service');
fakeMqtt.emit('connect');

// --- origins ----------------------------------------------------------------
const CFG = { domain: 'apps.localhost', port: 8080, proxyPort: 8081 };

test('appsConfig: padrao apps.localhost, porta PORT ou 8080 e 8081 da comporta; valor invalido lanca erro', () => {
    assert.deepEqual({ ...appHosts.appsConfig({}) }, CFG);
    assert.deepEqual({ ...appHosts.appsConfig({ PORT: '8099' }) }, { ...CFG, port: 8099 });
    assert.deepEqual({ ...appHosts.appsConfig({ PORT: '8099', AOP_PUBLIC_PORT: '18080' }) }, { ...CFG, port: 18080 });
    assert.deepEqual({ ...appHosts.appsConfig({ OBJECT_PROXY_PUBLIC_PORT: '18081' }) }, { ...CFG, proxyPort: 18081 });
    assert.deepEqual({ ...appHosts.appsConfig({ APPS_DOMAIN: ' .Apps.TV30.lan. ' }) }, { ...CFG, domain: 'apps.tv30.lan' });
    assert.throws(() => appHosts.appsConfig({ APPS_DOMAIN: 'apps_tv.lan' }), /APPS_DOMAIN invalido/);
    assert.throws(() => appHosts.appsConfig({ APPS_DOMAIN: 'a..b' }), /APPS_DOMAIN invalido/);
    assert.throws(() => appHosts.appsConfig({ AOP_PUBLIC_PORT: '80a' }), /AOP_PUBLIC_PORT invalida/);
    assert.throws(() => appHosts.appsConfig({ OBJECT_PROXY_PUBLIC_PORT: '70000' }), /OBJECT_PROXY_PUBLIC_PORT invalida/);
});

test('contextLabel e contextOrigin: ctx- e 16 hexadecimais do SHA-256 do appContextId (5.4), na porta da comporta', () => {
    const label = appHosts.contextLabel('urn:sbtvd:app:1002:carrossel');
    assert.match(label, /^ctx-[0-9a-f]{16}$/);
    assert.equal(label, `ctx-${crypto.createHash('sha256').update('urn:sbtvd:app:1002:carrossel').digest('hex').slice(0, 16)}`);
    assert.notEqual(label, appHosts.contextLabel('urn:sbtvd:app:1002:outra'));
    assert.equal(appHosts.contextOrigin('urn:a', CFG), `http://${appHosts.contextLabel('urn:a')}.apps.localhost:8081`);
    assert.equal(appHosts.contextOrigin('urn:a', { ...CFG, proxyPort: 80 }), `http://${appHosts.contextLabel('urn:a')}.apps.localhost`);
    assert.equal(appHosts.serviceProxyBase(1002, CFG), 'http://apps.localhost:8081/svc/1002');
});

test('broadcastLaunch e broadbandLaunch: origem e URL de entrada; bband que nao e URL HTTP absoluta da null', () => {
    const origin = appHosts.contextOrigin('urn:a', CFG);
    assert.deepEqual(appHosts.broadcastLaunch('urn:a', 'index.html', CFG), { origin, url: `${origin}/index.html` });
    assert.deepEqual(appHosts.broadbandLaunch('http://localhost:8082/services/1001/app/index.html'),
        { origin: 'http://localhost:8082', url: 'http://localhost:8082/services/1001/app/index.html' });
    assert.equal(appHosts.broadbandLaunch('nao-e-url'), null);
    assert.equal(appHosts.broadbandLaunch('ftp://bcast/x'), null);
});

test('hostLabel: so o que esta no dominio das aplicacoes; porta e caixa nao importam', () => {
    const cfg = { domain: 'apps.localhost', port: 8080 };
    assert.equal(appHosts.hostLabel('webmedia.apps.localhost:8080', cfg), 'webmedia');
    assert.equal(appHosts.hostLabel('WebMedia.Apps.Localhost', cfg), 'webmedia');
    assert.equal(appHosts.hostLabel('webmedia.apps.localhost.:8080', cfg), 'webmedia');
    assert.equal(appHosts.hostLabel('a.b.apps.localhost:8080', cfg), 'a.b');
    for (const h of ['localhost:8080', 'apps.localhost:8080', '127.0.0.1:8080', '[::1]:8080', 'xapps.localhost', '', undefined]) {
        assert.equal(appHosts.hostLabel(h, cfg), null, String(h));
    }
});

// --- origin registration (core) ----------------------------------------------
test('boot: a limpeza de origins:associated apaga a origem orfa', async () => {
    await new Promise(r => setImmediate(r));
    assert.deepEqual(origins(), {});
});

// --- current profile (core) --------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function ate(cond) {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(cond(), 'condicao nao atingida');
}
function perfilNoDuble(id, nickname) {
    store.set(INDICE, indice().add(id));
    store.set(`user:${id}`, new Map([['id', id], ['nickname', nickname]]));
}
function tiraDoDuble(id) {
    indice().delete(id);
    store.delete(`user:${id}`);
}

test('boot com a base sem perfil: o gestor cria o perfil padrao (Viewer 1, id UUID), que vira o perfil corrente', async () => {
    await ate(() => core.getUserList().length === 1 && core.getCurrentUser() !== '');
    const [u] = core.getUserList();
    assert.equal(u.name, 'Viewer 1');
    assert.match(u.id, UUID_RE);
    assert.equal(core.getCurrentUser(), u.id);
    const grava = writes.filter(w => w[1] === 'tv30_profile_write');
    assert.equal(grava.length, 1, 'um perfil padrao so');
    assert.equal(grava[0][3], '0', 'sem visibilidade para servico algum');
    assert.ok(published.some(([t, m, ret]) => t === 'aop/currentUser' && m === u.id && ret));
});

test('remocao do perfil corrente: aop/currentUser vazio (retido), aop/removedUser com o id e volta ao seletor; o corrente passa ao escolhido', async () => {
    const atual = core.getCurrentUser();
    const B = '5a9d2f4e-1c3b-4d6a-8e7f-9b0c1d2e3f4a';
    const C = '9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    perfilNoDuble(B, 'B');
    perfilNoDuble(C, 'C');
    await core.refreshUserData();
    assert.equal(core.getUserList().length, 3);

    // Storage no longer has the profile (tv30_profile_remove) when the core is
    // told.
    tiraDoDuble(atual);
    let n0 = published.length;
    core.profileRemoved(atual);
    assert.deepEqual(published.slice(n0), [
        ['aop/currentUser', '', true],
        ['aop/removedUser', atual, false],
        ['aop/display/layers/rxgui', '/prfchs', false],
    ]);
    assert.equal(core.getCurrentUser(), '');
    assert.deepEqual(core.getUserList().map(u => u.id).sort(), [B, C].sort());

    // The chooser reloads the profiles without choosing one by itself.
    n0 = published.length;
    await core.refreshUserData();
    assert.equal(core.getCurrentUser(), '');
    assert.deepEqual(published.slice(n0).filter(([t]) => t === 'aop/currentUser'), []);

    await core.setCurrentUser(B);
    assert.deepEqual(published.at(-1), ['aop/currentUser', B, true]);

    // A profile that is not the current one: aop/currentUser stays.
    tiraDoDuble(C);
    n0 = published.length;
    core.profileRemoved(C);
    assert.deepEqual(published.slice(n0), [['aop/removedUser', C, false], ['aop/display/layers/rxgui', '/prfchs', false]]);
    assert.equal(core.getCurrentUser(), B);
    assert.deepEqual(core.getUserList().map(u => u.id), [B]);
});

const SID = 'urn:tv30:service:users-test';
const SERVICE_ID = 1001;
const CONTEXT = 'urn:tv30:appcontext:ctx1';
const CONTEXT_ORIGIN = appHosts.contextOrigin(CONTEXT, CFG);
const BALD = { EntryPackage: [{
    appContextId: CONTEXT,
    appId: 'urn:tv30:app:k1a2b3',
    appName: 'Trocar Usuario',
    appType: 'TV30-Ginga-HTML5',
    bcastEntryPackageUrl: 'app.pkg',
    bcastEntryPointUrl: 'index.html',
    controlCode: 'AUTOSTART',
}] };
const app = (name) => ({ appId: `urn:tv30:app:${name}`, origin: `http://${name}.apps.localhost:8081`,
    url: `http://${name}.apps.localhost:8081/index.html` });

const tick = () => new Promise((r) => setImmediate(r));
const available = (location) => fakeMqtt.emit('message', `tlm/object/${SERVICE_ID}/available`,
    Buffer.from(JSON.stringify({ serviceId: SERVICE_ID, contentLocation: location })));
const RECORD = JSON.stringify({ serviceId: SERVICE_ID, bsid: 10, bam: { globalServiceId: SID, appName: 'Users' } });

test('lancamento pela BALD: espera o ponto de entrada passar no carrossel, abre na origem do appContextId e a registra', async () => {
    store.set('services:announced', new Map([[SID, RECORD]]));
    await core.setCurrentService(SID);
    assert.ok(subscribed.includes(`tlm/object/${SERVICE_ID}/+`));
    fakeMqtt.emit('message', `tlm/sls/${SERVICE_ID}/bald`, Buffer.from(JSON.stringify(BALD)));
    await bootstrap.fullscreen();
    await tick();
    assert.deepEqual(origins(), {});
    assert.notEqual(lastGraphics(), `${CONTEXT_ORIGIN}/index.html`);

    available('app.pkg');
    await tick();
    assert.deepEqual(origins(), {});
    available('index.html');
    await tick();
    await tick();
    assert.deepEqual(origins(), { [CONTEXT_ORIGIN]: SID });
    assert.equal(lastGraphics(), `${CONTEXT_ORIGIN}/index.html`);
});

test('com os dois pontos de entrada, o de banda larga primeiro (10.1), sem esperar; bband invalido cai no de radiodifusao', async () => {
    const both = { EntryPackage: [{ ...BALD.EntryPackage[0], bbandEntryPointUrl: 'http://localhost:8082/services/1001/app/index.html' }] };
    fakeMqtt.emit('message', `tlm/sls/${SERVICE_ID}/bald`, Buffer.from(JSON.stringify(both)));
    await bootstrap.fullscreen();
    assert.deepEqual(origins(), { 'http://localhost:8082': SID });
    assert.equal(lastGraphics(), 'http://localhost:8082/services/1001/app/index.html');

    // index.html is still available: the broadcast launch does not wait.
    const invalid = { EntryPackage: [{ ...BALD.EntryPackage[0], bbandEntryPointUrl: 'nao-e-url' }] };
    fakeMqtt.emit('message', `tlm/sls/${SERVICE_ID}/bald`, Buffer.from(JSON.stringify(invalid)));
    await bootstrap.fullscreen();
    await tick();
    await tick();
    assert.deepEqual(origins(), { [CONTEXT_ORIGIN]: SID });
    fakeMqtt.emit('message', `tlm/sls/${SERVICE_ID}/bald`, Buffer.from(JSON.stringify(BALD)));
});

test('expirado o ponto de entrada, ou deixado o servico, o lancamento por radiodifusao nao abre', async () => {
    await core.setDisplayGraphics();
    fakeMqtt.emit('message', `tlm/object/${SERVICE_ID}/expired`,
        Buffer.from(JSON.stringify({ serviceId: SERVICE_ID, contentLocation: 'index.html' })));
    await bootstrap.fullscreen();
    await tick();
    assert.deepEqual(origins(), {});
    core.unsetCurrentService();
    available('index.html');
    await tick();
    await tick();
    assert.deepEqual(origins(), {});
    await core.setCurrentService(SID);
    fakeMqtt.emit('message', `tlm/sls/${SERVICE_ID}/bald`, Buffer.from(JSON.stringify(BALD)));
});

test('SLS do servico corrente: a MPD (XML) e os demais fragmentos nao sao lidos aqui; BALD que nao e JSON vai ao log, sem derrubar', () => {
    const errors = [];
    const realError = console.error;
    console.error = (...a) => { errors.push(a.join(' ')); };
    try {
        assert.doesNotThrow(() => fakeMqtt.emit('message', `tlm/sls/${SERVICE_ID}/mpd`, Buffer.from('<?xml version="1.0"?><MPD/>')));
        assert.doesNotThrow(() => fakeMqtt.emit('message', `tlm/sls/${SERVICE_ID}/stsid`, Buffer.from('{"RS":[]}')));
        assert.doesNotThrow(() => fakeMqtt.emit('message', `tlm/sls/9/bald`, Buffer.from('<nao e json>')));
    } finally { console.error = realError; }
    assert.equal(core.getServiceSLS().mpd, undefined);
    assert.equal(core.getServiceSLS().stsid, undefined);
    assert.ok(errors.some(l => l.includes('BALD of tlm/sls/9/bald ignored')));
    // The BALD received before stays.
    assert.deepEqual(core.getServiceSLS().bald, BALD);
});

test('troca de aplicacao: remove a origem anterior e registra a nova; relancar a mesma nao a remove', async () => {
    await core.setDisplayGraphics(app('w9'));
    assert.deepEqual(origins(), { 'http://w9.apps.localhost:8081': SID });
    assert.equal(lastGraphics(), 'http://w9.apps.localhost:8081/index.html');

    writes.length = 0;
    await core.setDisplayGraphics(app('w9'));
    assert.deepEqual(writes.filter(w => w[1] === 'tv30_origin_remove'), []);
    assert.deepEqual(origins(), { 'http://w9.apps.localhost:8081': SID });
});

test('registro e remocao da origem saem pelas funcoes do Redis (tv30_origin_*), na ordem remove-registra', async () => {
    writes.length = 0;
    await core.setDisplayGraphics(app('p4'));
    await core.setDisplayGraphics(app('p5'));
    assert.deepEqual(writes, [
        ['FCALL', 'tv30_origin_remove', 'http://w9.apps.localhost:8081'],
        ['FCALL', 'tv30_origin_register', 'http://p4.apps.localhost:8081', SID],
        ['FCALL', 'tv30_origin_remove', 'http://p4.apps.localhost:8081'],
        ['FCALL', 'tv30_origin_register', 'http://p5.apps.localhost:8081', SID],
    ]);
});

test('estado da aplicacao: started ao abrir, ended antes de started na troca, ended ao encerrar', async () => {
    const STATE = 'aop/application-lifecycle-manager/application-state';
    await core.setDisplayGraphics();
    const n0 = published.length;
    const states = () => published.slice(n0).filter(([t]) => t === STATE).map(([, m, ret]) => ({ ...JSON.parse(m), retained: ret }));
    await core.setDisplayGraphics(app('s1'));
    await core.setDisplayGraphics(app('s2'));
    await core.setDisplayGraphics();
    const o1 = 'http://s1.apps.localhost:8081';
    const o2 = 'http://s2.apps.localhost:8081';
    assert.deepEqual(states(), [
        { serviceContextId: SID, appId: 'urn:tv30:app:s1', origin: o1, state: 'started', retained: false },
        { serviceContextId: SID, appId: 'urn:tv30:app:s1', origin: o1, state: 'ended', retained: false },
        { serviceContextId: SID, appId: 'urn:tv30:app:s2', origin: o2, state: 'started', retained: false },
        { serviceContextId: SID, appId: 'urn:tv30:app:s2', origin: o2, state: 'ended', retained: false },
    ]);
});

test('registro recusado pela funcao (esquema): o lancamento rejeita com a mensagem (rota HTTP: 404 {error:200})', async () => {
    const msg = 'TV30SCHEMA tv30_origin_register: origins:associated field name: host must be in lowercase';
    recusa = ['tv30_origin_register', msg];
    try {
        await assert.rejects(core.setDisplayGraphics(app('q')), { message: msg });
    } finally { recusa = null; }
    await core.setDisplayGraphics(app('p5'));
});

test('encerramento (tecla de saida): remove a origem e esvazia a camada grafica', async () => {
    await core.openServiceInfo();
    assert.deepEqual(origins(), {});
    assert.equal(lastGraphics(), '');
});

test('BALD sem ponto de entrada utilizavel: nada registrado nem aberto', async () => {
    const without = { EntryPackage: [{ ...BALD.EntryPackage[0], bcastEntryPointUrl: undefined, bbandEntryPointUrl: 'ftp://x/y' }] };
    fakeMqtt.emit('message', `tlm/sls/${SERVICE_ID}/bald`, Buffer.from(JSON.stringify(without)));
    await bootstrap.fullscreen();
    assert.deepEqual(origins(), {});
    assert.equal(lastGraphics(), '');
});

test('Redis fora do ar: o lancamento rejeita (rota HTTP responde 404 {error:200})', async () => {
    down = true;
    try {
        await assert.rejects(core.setDisplayGraphics(app('r')), { message: FAIL });
    } finally { down = false; }
    // Clears the state (the origin was never written).
    await core.setDisplayGraphics();
    assert.deepEqual(origins(), {});
});

test('catalogo no core: SLT e BAMT vao a LLS; o marco de varredura grava services:announced e publica aop/services retido; o servico corrente vem do catalogo, com o serviceId do SLS', async () => {
    const servicos = () => published.filter(([t]) => t === 'aop/services');
    // At startup, the stored catalog (empty).
    await ate(() => servicos().length > 0);
    assert.deepEqual(servicos()[0], ['aop/services', '[]', true]);
    const BAM = { globalServiceId: SID, appVersion: 1, appName: 'Users', appIcon: '<svg/>', bannerIcon: '<svg/>', backgroundColor: '#000000', foregroundColor: '#ffffff' };
    const SLT = { bsid: [10], bandwidth: 6, Service: [{ serviceId: SERVICE_ID, globalServiceId: SID, serviceCategory: 30,
        majorChannelNo: 10, minorChannelNo: 1, mainAvOverTheAir: true, receptionQuality: 80 }] };
    const marco = rf => Buffer.from(JSON.stringify({ completedAt: '2026-01-01T00:00:00Z', rfChannels: rf }));
    fakeMqtt.emit('message', 'tlm/lls/10/slt', Buffer.from(JSON.stringify(SLT)));
    fakeMqtt.emit('message', 'tlm/lls/10/bamt', Buffer.from(JSON.stringify({ BAM: [BAM] })));
    fakeMqtt.emit('message', 'tlm/scan', marco([10]));
    await ate(() => servicos().at(-1)[1] !== '[]');
    assert.deepEqual(servicos().at(-1), ['aop/services', JSON.stringify([{ serviceContextId: SID }]), true]);
    assert.deepEqual([...store.get('services:announced').keys()], [SID]);
    assert.equal(JSON.parse(store.get('services:announced').get(SID)).bsid, 10);
    await core.setCurrentService(SID);
    assert.equal(core.getCurrentService().bam.appName, 'Users');
    assert.equal(core.getCurrentService().serviceId, SERVICE_ID);
    assert.deepEqual(subscribed.slice(-2), [`tlm/sls/${SERVICE_ID}/#`, `tlm/object/${SERVICE_ID}/+`]);
    // The tuning (5.2), retained: the service, its RF channel and the instant.
    const tuned = published.filter(([t]) => t === 'tlm/tuned').at(-1);
    assert.equal(tuned[2], true);
    const tuning = JSON.parse(tuned[1]);
    assert.deepEqual({ serviceId: tuning.serviceId, rfChannelId: tuning.rfChannelId }, { serviceId: SERVICE_ID, rfChannelId: 10 });
    assert.ok(!Number.isNaN(Date.parse(tuning.tunedAt)));
    // BAMT removed from a channel still detected: the service leaves the
    // catalog.
    fakeMqtt.emit('message', 'tlm/lls/10/bamt', Buffer.from(''));
    fakeMqtt.emit('message', 'tlm/scan', marco([10]));
    await ate(() => servicos().at(-1)[1] === '[]');
    assert.equal(store.get('services:announced').size, 0);
    core.unsetCurrentService();
    assert.deepEqual(unsubscribed.slice(-2), [`tlm/sls/${SERVICE_ID}/#`, `tlm/object/${SERVICE_ID}/+`]);
    assert.deepEqual(published.filter(([t]) => t === 'tlm/tuned').at(-1), ['tlm/tuned', '', true]);
    fakeMqtt.emit('message', 'tlm/lls/10/slt', Buffer.from(''));
});
