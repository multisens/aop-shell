// Tests of src/app-hosts.js and of src/core.js (MQTT and Redis doubles):
// the domain and ports of the applications, the Host, the application that
// aop-application-lifecycle-manager puts in the graphics layer and the end
// request, and the tuning. Also the current profile in the core (default
// profile at startup and profile removal) and the LLS delivered to the unit
// that owns the list of services.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const USERS_INDEX = 'users:index';
const CFG = { domain: 'apps.localhost', port: 8080, proxyPort: 8081 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SID = 'urn:tv30:service:users-test';
const SERVICE_ID = 1001;
const GRAPHICS_APP = 'aop/application-lifecycle-manager/graphics-application';
const END_REQUEST = 'aop/application-lifecycle-manager/end-request';
const RECORD = JSON.stringify({ serviceId: SERVICE_ID, bsid: 10, bam: { globalServiceId: SID, appName: 'Users' } });
const APP = { serviceContextId: SID, appId: 'urn:tv30:app:k1a2b3', origin: 'http://ctx-0123456789abcdef.apps.localhost:8081',
    url: 'http://ctx-0123456789abcdef.apps.localhost:8081/index.html' };

// --- doubles -----------------------------------------------------------------
const store = new Map();
// ['FCALL', function, ...args] of each write.
const writes = [];
const fakeRedis = {
    status: 'ready',
    once() {},
    on() {},
};
// [topic, message, retained]
const published = [];
const fakeMqtt = new EventEmitter();
// [filter] of each subscribe and unsubscribe.
const subscribed = [];
const unsubscribed = [];
const realLog = console.log;
const realError = console.error;

// Fixed configuration: the core reads it once, when loaded.
process.env.APPS_DOMAIN = 'apps.localhost';
process.env.AOP_PUBLIC_PORT = '8080';
process.env.OBJECT_PROXY_PUBLIC_PORT = '8081';
const appHosts = require('../src/app-hosts');

// The double mimics the EFFECT of the profile and catalog functions
// (call('FCALL', function, 0, ...)), without checking the schema; the
// lastAccess of an unknown profile gives 0.
for (const [name, fn] of Object.entries({
    async call(cmd, fnName, numkeys, ...args) {
        if (cmd !== 'FCALL' || Number(numkeys) !== 0) {
            throw new Error(`call ${cmd} ${numkeys}: nao suportado pelo duble`);
        }
        const a = args.map(String);
        writes.push(['FCALL', fnName, ...a]);
        switch (fnName) {
            case 'tv30_profile_write': {
                const [id, n] = a;
                store.set(USERS_INDEX, usersIndex().add(id));
                store.set(`user:${id}`, pairsOf(a, 2 + Number(n)));
                return 1;
            }
            case 'tv30_profile_last_access':
                return usersIndex().has(a[0]) ? 1 : 0;
            // The Application Catalog, rewritten at each scan marker.
            case 'tv30_announced_services': {
                const catalog = pairsOf(a, 0);
                store.set('services:announced', catalog);
                return catalog.size;
            }
            // The session, written before the topic is published.
            case 'tv30_session_user':
                store.set('session:current-user', a[0]);
                return 1;
            case 'tv30_session_service': {
                const fields = pairsOf(a, 0);
                store.set('session:current-service', fields);
                store.set('session:current-service-id', fields.get('serviceContextId') || '');
                return 1;
            }
            default:
                throw new Error('ERR Function not found');
        }
    },
    async smembers(k) {
        return k === USERS_INDEX ? [...usersIndex()] : [];
    },
    async hgetall(k) {
        return Object.fromEntries(hashOf(k));
    },
    async hget(k, f) {
        return hashOf(k).has(f) ? hashOf(k).get(f) : null;
    },
})) {
    fakeRedis[name] = fn;
}
fakeMqtt.publish = (t, m, o) => {
    published.push([t, String(m), !!(o && o.retain)]);
};
fakeMqtt.subscribe = (filter) => {
    subscribed.push(filter);
};
fakeMqtt.unsubscribe = (filter) => {
    unsubscribed.push(filter);
};
stubFile(require.resolve(path.join(__dirname, '..', 'src', 'redis-client')), fakeRedis);
stubFile(require.resolve('mqtt'), { connect: () => fakeMqtt });
// The core logs connection, profiles and proxy.
console.log = () => undefined;
console.error = () => undefined;
after(() => {
    console.log = realLog;
    console.error = realError;
});
const core = require('../src/core');
const bootstrap = require('../src/modules/bootstrap-application/service');
fakeMqtt.emit('connect');

// --- origins ----------------------------------------------------------------
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

test('serviceProxyBase: a familia de servico da comporta, sem a porta 80', () => {
    assert.equal(appHosts.serviceProxyBase(1002, CFG), 'http://apps.localhost:8081/svc/1002');
    assert.equal(appHosts.serviceProxyBase(1002, { ...CFG, proxyPort: 80 }), 'http://apps.localhost/svc/1002');
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

// --- current profile (core) --------------------------------------------------
test('boot com a base sem perfil: o gestor cria o perfil padrao (Viewer 1, id UUID), que vira o perfil corrente', async () => {
    await waitUntil(() => core.getUserList().length === 1 && core.getCurrentUser() !== '');
    const [u] = core.getUserList();
    assert.equal(u.name, 'Viewer 1');
    assert.match(u.id, UUID_RE);
    assert.equal(core.getCurrentUser(), u.id);
    const profileWrites = writes.filter(w => w[1] === 'tv30_profile_write');
    assert.equal(profileWrites.length, 1, 'um perfil padrao so');
    assert.equal(profileWrites[0][3], '0', 'sem visibilidade para servico algum');
    assert.ok(published.some(([t, m, ret]) => t === 'aop/currentUser' && m === u.id && ret));
});

test('remocao do perfil corrente: aop/currentUser vazio (retido), aop/removedUser com o id e volta ao seletor; o corrente passa ao escolhido', async () => {
    const current = core.getCurrentUser();
    const B = '5a9d2f4e-1c3b-4d6a-8e7f-9b0c1d2e3f4a';
    const C = '9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    addProfile(B, 'B');
    addProfile(C, 'C');
    await core.refreshUserData();
    assert.equal(core.getUserList().length, 3);

    // Storage no longer has the profile (tv30_profile_remove) when the core is
    // told.
    removeProfile(current);
    let n0 = published.length;
    await core.profileRemoved(current);
    assert.deepEqual(published.slice(n0), [
        ['aop/currentUser', '', true],
        ['aop/removedUser', current, false],
        ['aop/display/layers/rxgui', '/prfchs', false],
    ]);
    assert.equal(core.getCurrentUser(), '');
    assert.equal(store.get('session:current-user'), '');
    assert.deepEqual(core.getUserList().map(u => u.id).sort(), [B, C].sort());

    // The chooser reloads the profiles without choosing one by itself.
    n0 = published.length;
    await core.refreshUserData();
    assert.equal(core.getCurrentUser(), '');
    assert.deepEqual(published.slice(n0).filter(([t]) => t === 'aop/currentUser'), []);

    await core.setCurrentUser(B);
    assert.deepEqual(published.at(-1), ['aop/currentUser', B, true]);

    // A profile that is not the current one: aop/currentUser stays.
    removeProfile(C);
    n0 = published.length;
    await core.profileRemoved(C);
    assert.deepEqual(published.slice(n0), [['aop/removedUser', C, false], ['aop/display/layers/rxgui', '/prfchs', false]]);
    assert.equal(core.getCurrentUser(), B);
    assert.deepEqual(core.getUserList().map(u => u.id), [B]);
});

test('aplicacao do gerente de ciclo de vida: substitui a Bootstrap, com o video em tela cheia', async () => {
    store.set('services:announced', new Map([[SID, RECORD]]));
    await core.setCurrentService(SID);
    assert.ok(subscribed.includes(GRAPHICS_APP));
    graphicsApp(APP);
    assert.equal(lastGraphics(), APP.url);
    assert.deepEqual(lastOf('aop/display/layers/rxgui'), ['aop/display/layers/rxgui', '', false]);
    assert.deepEqual(JSON.parse(lastOf('aop/display/layers/video/size')[1]), { top: '0', left: '0', width: '100%', height: '100%' });
});

test('Bootstrap aberta depois da substituicao: toca a midia sem encolher o video da aplicacao', () => {
    const n0 = published.length;
    bootstrap.openBootstrapApp('info', undefined);
    assert.ok(!published.slice(n0).some(([t]) => t === 'aop/display/layers/video/size'));
});

test('Esc com a aplicacao: pede o fim ao gerente, sem mexer na camada; o fim traz de volta a Bootstrap com as informacoes', () => {
    const n0 = published.length;
    core.openServiceInfo();
    assert.deepEqual(published.slice(n0), [[END_REQUEST, JSON.stringify({ serviceContextId: SID, appId: APP.appId }), false]]);
    graphicsApp(null);
    assert.equal(lastGraphics(), '');
    assert.deepEqual(lastOf('aop/display/layers/rxgui'), ['aop/display/layers/rxgui', '/btpapp?mode=info', false]);
});

test('Esc sem aplicacao: so as informacoes da Bootstrap; a Bootstrap em tela cheia so esconde as informacoes', () => {
    bootstrap.fullscreen();
    assert.deepEqual(lastOf('aop/display/layers/rxgui'), ['aop/display/layers/rxgui', '', false]);
    const n0 = published.length;
    core.openServiceInfo();
    assert.deepEqual(published.slice(n0).map(([t]) => t), ['aop/display/layers/rxgui']);
    assert.ok(!published.slice(n0).some(([t]) => t === END_REQUEST));
});

test('fim de aplicacao sem servico sintonizado: a camada esvazia e a Bootstrap nao volta', async () => {
    graphicsApp(APP);
    await core.unsetCurrentService();
    const n0 = published.length;
    graphicsApp(null);
    assert.deepEqual(published.slice(n0), [['aop/display/layers/graphics', '', false]]);
});

test('SLS do servico corrente: so a MPD vai a aop-dash-streams; a BALD nao e lida aqui', () => {
    assert.doesNotThrow(() => fakeMqtt.emit('message', `tlm/sls/${SERVICE_ID}/mpd`, Buffer.from('<?xml version="1.0"?><MPD/>')));
    assert.doesNotThrow(() => fakeMqtt.emit('message', `tlm/sls/${SERVICE_ID}/bald`, Buffer.from('<nao e json>')));
    assert.deepEqual(core.getServiceSLS(), {});
});

test('catalogo no core: SLT e BAMT vao a LLS; o marco de varredura grava services:announced e publica aop/services retido; o servico corrente vem do catalogo, com o serviceId do SLS', async () => {
    const servicesPublished = () => published.filter(([t]) => t === 'aop/services');
    // At startup, the stored catalog (empty).
    await waitUntil(() => servicesPublished().length > 0);
    assert.deepEqual(servicesPublished()[0], ['aop/services', '[]', true]);
    const BAM = { globalServiceId: SID, appVersion: 1, appName: 'Users', appIcon: '<svg/>', bannerIcon: '<svg/>', backgroundColor: '#000000', foregroundColor: '#ffffff' };
    const SLT = { bsid: [10], bandwidth: 6, Service: [{ serviceId: SERVICE_ID, globalServiceId: SID, serviceCategory: 30,
        majorChannelNo: 10, minorChannelNo: 1, mainAvOverTheAir: true, receptionQuality: 80 }] };
    const scanMark = rf => Buffer.from(JSON.stringify({ completedAt: '2026-01-01T00:00:00Z', rfChannels: rf }));
    fakeMqtt.emit('message', 'tlm/lls/10/slt', Buffer.from(JSON.stringify(SLT)));
    fakeMqtt.emit('message', 'tlm/lls/10/bamt', Buffer.from(JSON.stringify({ BAM: [BAM] })));
    fakeMqtt.emit('message', 'tlm/scan', scanMark([10]));
    await waitUntil(() => servicesPublished().at(-1)[1] !== '[]');
    assert.deepEqual(servicesPublished().at(-1), ['aop/services', JSON.stringify([{ serviceContextId: SID }]), true]);
    assert.deepEqual([...store.get('services:announced').keys()], [SID]);
    assert.equal(JSON.parse(store.get('services:announced').get(SID)).bsid, 10);
    await core.setCurrentService(SID);
    // The session of Table C.8, from the catalog entry.
    assert.deepEqual(Object.fromEntries(store.get('session:current-service')), { serviceContextId: SID, serviceName: 'Users', serviceId: String(SERVICE_ID) });
    assert.deepEqual(published.filter(([t]) => t === 'aop/currentService').at(-1), ['aop/currentService', SID, true]);
    assert.equal(core.getCurrentService().bam.appName, 'Users');
    assert.equal(core.getCurrentService().serviceId, SERVICE_ID);
    assert.deepEqual(subscribed.slice(-1), [`tlm/sls/${SERVICE_ID}/#`]);
    // The tuning, retained: the service, its RF channel and the instant.
    const tuned = published.filter(([t]) => t === 'tlm/tuned').at(-1);
    assert.equal(tuned[2], true);
    const tuning = JSON.parse(tuned[1]);
    assert.deepEqual({ serviceId: tuning.serviceId, rfChannelId: tuning.rfChannelId }, { serviceId: SERVICE_ID, rfChannelId: 10 });
    assert.ok(!Number.isNaN(Date.parse(tuning.tunedAt)));
    // BAMT removed from a channel still detected: the service leaves the
    // catalog.
    fakeMqtt.emit('message', 'tlm/lls/10/bamt', Buffer.from(''));
    fakeMqtt.emit('message', 'tlm/scan', scanMark([10]));
    await waitUntil(() => servicesPublished().at(-1)[1] === '[]');
    assert.equal(store.get('services:announced').size, 0);
    await core.unsetCurrentService();
    assert.equal(store.get('session:current-service-id'), '');
    assert.deepEqual(writes.at(-1), ['FCALL', 'tv30_session_service']);
    assert.deepEqual(unsubscribed.slice(-1), [`tlm/sls/${SERVICE_ID}/#`]);
    assert.deepEqual(published.filter(([t]) => t === 'tlm/tuned').at(-1), ['tlm/tuned', '', true]);
    fakeMqtt.emit('message', 'tlm/lls/10/slt', Buffer.from(''));
});

// --- helpers -----------------------------------------------------------------
function hashOf(k) {
    return store.get(k) instanceof Map ? store.get(k) : new Map();
}

function usersIndex() {
    return store.get(USERS_INDEX) instanceof Set ? store.get(USERS_INDEX) : new Set();
}

// Field and value pairs of the arguments from a[i].
function pairsOf(a, i) {
    const fields = new Map();
    for (let k = i; k + 1 < a.length; k += 2) {
        fields.set(a[k], a[k + 1]);
    }
    return fields;
}

function lastGraphics() {
    const g = published.filter(([t]) => t === 'aop/display/layers/graphics');
    return g.length ? g[g.length - 1][1] : undefined;
}

function lastOf(topic) {
    return published.filter(([t]) => t === topic).at(-1);
}

function graphicsApp(app) {
    fakeMqtt.emit('message', GRAPHICS_APP, Buffer.from(app ? JSON.stringify(app) : ''));
}

function stubFile(file, exports) {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
}

async function waitUntil(cond) {
    for (let i = 0; i < 200 && !cond(); i++) {
        await new Promise(r => setTimeout(r, 5));
    }
    assert.ok(cond(), 'condicao nao atingida');
}

function addProfile(id, nickname) {
    store.set(USERS_INDEX, usersIndex().add(id));
    store.set(`user:${id}`, new Map([['id', id], ['nickname', nickname]]));
}

function removeProfile(id) {
    usersIndex().delete(id);
    store.delete(`user:${id}`);
}
