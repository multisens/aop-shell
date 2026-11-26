// Unit tests of the platform (node:test, without real Redis or MQTT): a
// Redis client that fails fast (REAL ioredis against a closed port and a
// silent server), routes that answer 404 {error:200} and the profile
// manager.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const Redis = require('ioredis');
const express = require('express');

const { FAIL_FAST_OPTIONS, redisOptions, logRedisEvents, whenReady } = require('../src/redis-options');
const { platformErrorHandler } = require('../src/http-error');

// Profile ids as UUIDs (Table 7): the double does not check the schema, but
// the ids have the format Redis accepts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UM = '0b6f3e2a-7c1d-4e5f-9a8b-2c3d4e5f6a7b';
const perfil = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

// --- doubles -----------------------------------------------------------------
const FAIL = 'redis indisponivel (duble de teste)';
const store = new Map();
let down = false;
const setOf = k => (store.get(k) instanceof Set ? store.get(k) : new Set());
// The double mimics the EFFECT of the profile functions (call('FCALL',
// function, 0, ...)), without checking the schema; fcalls keeps each call
// and recusa makes the function answer as for data outside the schema. The
// profile limit is the maxMembros of users:index, with the refusal of the
// function.
const fcalls = [];
// [function, message]
let recusa = null;
const TETO = 5;
const recusaDoTeto = id => `TV30SCHEMA tv30_profile_write: users:index limit of ${TETO} profiles reached (10.3.3): "${id}" not written`;
const fakeRedis = new Proxy({
    async call(cmd, nome, numkeys, ...args) {
        if (cmd !== 'FCALL' || Number(numkeys) !== 0) throw new Error(`call ${cmd} ${numkeys}: nao suportado pelo duble`);
        const a = args.map(String);
        fcalls.push([nome, ...a]);
        if (recusa && recusa[0] === nome) throw new Error(recusa[1]);
        switch (nome) {
            case 'tv30_profile_last_access': {
                const [id, ms] = a;
                if (!setOf('users:index').has(id)) return 0;
                store.set(`user:${id}`, { ...(store.get(`user:${id}`) || {}), lastAccess: ms });
                return 1;
            }
            case 'tv30_profile_write': {
                const [id, n] = a;
                const k = Number(n);
                const h = {};
                for (let i = 2 + k; i + 1 < a.length; i += 2) h[a[i]] = a[i + 1];
                const idx = setOf('users:index');
                if (!idx.has(id) && idx.size >= TETO) throw new Error(recusaDoTeto(id));
                idx.add(id); store.set('users:index', idx);
                store.set(`user:${id}`, h);
                if (k > 0) { const s = setOf(`user:${id}:consent`); a.slice(2, 2 + k).forEach(x => s.add(x)); store.set(`user:${id}:consent`, s); }
                return 1;
            }
            case 'tv30_profile_remove': {
                const [id] = a;
                let n = setOf('users:index').delete(id) ? 1 : 0;
                for (const key of [...store.keys()]) {
                    if (key === `user:${id}` || key === `user:${id}:consent` || key.startsWith(`user:${id}:broadcaster-attrs:`)) { store.delete(key); n++; }
                }
                return n;
            }
            default: throw new Error('ERR Function not found');
        }
    },
    async scard(k) { return setOf(k).size; },
    async smembers(k) { return [...setOf(k)]; },
    async hgetall(k) { return { ...(store.get(k) || {}) }; },
    async exists(k) { return store.has(k) ? 1 : 0; },
    async scan(cursor, match, pattern) {
        const prefix = pattern.slice(0, -1);
        return ['0', [...store.keys()].filter(k => k.startsWith(prefix))];
    },
    async get(k) { return typeof store.get(k) === 'string' ? store.get(k) : null; },
}, {
    get(target, prop) {
        const f = target[prop];
        if (typeof f !== 'function') return f;
        return async (...args) => { if (down) throw new Error(FAIL); return f(...args); };
    },
});

function stub(rel, exports) {
    const file = require.resolve(path.join(__dirname, '..', 'src', rel));
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
}
stub('redis-client', fakeRedis);
const refreshed = [];
// Ids passed to core.profileRemoved.
const removidos = [];
stub('core', { refreshUserData: async () => { refreshed.push(1); }, profileRemoved: id => { removidos.push(id); } });

const profiles = require('../src/modules/profile-manager/service');
const managerRouter = require('../src/modules/profile-manager/manager');

// --- utilities ---------------------------------------------------------------
async function closedPort() {
    const s = net.createServer().listen(0, '127.0.0.1');
    await new Promise(r => s.once('listening', r));
    const p = s.address().port;
    await new Promise(r => s.close(r));
    return p;
}
async function elapsed(p) {
    const t0 = Date.now();
    try { await p; return { ms: Date.now() - t0 }; }
    catch (err) { return { ms: Date.now() - t0, err }; }
}
async function withApp(mount, fn) {
    const app = express();
    app.use(express.json());
    mount(app);
    app.use(platformErrorHandler);
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try { return await fn(`http://127.0.0.1:${server.address().port}`); }
    finally { await new Promise(r => server.close(r)); }
}
const realError = console.error;
// The handler logs each error; silenced in the test.
console.error = () => undefined;
after(() => { console.error = realError; });

// --- Redis client ------------------------------------------------------------
test('opcoes: limite por comando, poucas tentativas, fila offline ligada', () => {
    const o = redisOptions();
    assert.equal(o.maxRetriesPerRequest, 1);
    assert.ok(o.commandTimeout < 2000);
    assert.ok(o.connectTimeout <= 2000);
    assert.equal(o.enableOfflineQueue, true);
    assert.equal(redisOptions({ port: 1 }).port, 1);
    assert.ok(Object.isFrozen(FAIL_FAST_OPTIONS));
});

test('Redis fora do ar (porta fechada): o comando rejeita em menos de 1,5 s', async () => {
    const c = new Redis(redisOptions({ host: '127.0.0.1', port: await closedPort() }));
    c.on('error', () => undefined);
    try {
        const r = await elapsed(c.get('x'));
        assert.ok(r.err, 'esperava rejeicao');
        assert.ok(r.ms < 1500, `levou ${r.ms} ms`);
    } finally { c.disconnect(); }
});

test('Redis congelado (aceita e nao responde): o comando rejeita no commandTimeout', async () => {
    const accepted = [];
    const silent = net.createServer(s => accepted.push(s)).listen(0, '127.0.0.1');
    await new Promise(r => silent.once('listening', r));
    const c = new Redis(redisOptions({ host: '127.0.0.1', port: silent.address().port, enableReadyCheck: false }));
    c.on('error', () => undefined);
    try {
        const r = await elapsed(c.get('x'));
        assert.match(r.err ? r.err.message : '', /timed out/i);
        assert.ok(r.ms >= 1400 && r.ms < 2000, `levou ${r.ms} ms`);
    } finally {
        c.disconnect();
        accepted.forEach(s => s.destroy());
        await new Promise(r => silent.close(r));
    }
});

test('log de eventos: primeira falha de cada sequencia, perda e recuperacao', () => {
    const ev = new EventEmitter();
    const lines = [];
    const realLog = console.log;
    console.log = m => lines.push(`LOG ${m}`);
    try {
        logRedisEvents(ev, 'h:1', m => lines.push(m));
        ev.emit('error', new Error('connect ECONNREFUSED'));
        ev.emit('error', new Error('connect ECONNREFUSED'));
        ev.emit('ready');
        ev.emit('close');
    } finally { console.log = realLog; }
    assert.deepEqual(lines, [
        '[redis] ERRO em h:1: connect ECONNREFUSED',
        'LOG [redis] pronto em h:1 (restabelecido apos 2 falha(s))',
        '[redis] conexao com h:1 perdida; comandos falham com erro ate reconectar',
    ]);
});

test('whenReady: tarefa de boot roda uma vez, no primeiro ready', async () => {
    const ev = new EventEmitter();
    ev.status = 'connecting';
    let runs = 0;
    whenReady(ev, 'teste', async () => { runs++; });
    ev.emit('ready');
    ev.emit('ready');
    await new Promise(r => setImmediate(r));
    assert.equal(runs, 1);
});

// --- lastAccess --------------------------------------------------------------
test('touchLastAccess grava so em perfil existente (sem hash fantasma)', async () => {
    store.clear();
    store.set('users:index', new Set([UM]));
    store.set(`user:${UM}`, { nickname: 'Um' });
    assert.equal(await profiles.touchLastAccess(UM, 1234), true);
    assert.equal(store.get(`user:${UM}`).lastAccess, '1234');
    assert.equal(await profiles.touchLastAccess('desconhecido', 1234), false);
    assert.equal(store.has('user:desconhecido'), false);
    assert.equal(await profiles.touchLastAccess(''), false);
});

// --- profile creation route --------------------------------------------------
test('POST /profile/create: dado invalido 400; Redis fora 404 {error:200}; ok 201', async () => {
    store.clear();
    await withApp(app => app.use('/profile', managerRouter), async base => {
        const post = body => fetch(`${base}/profile/create`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });

        let r = await post({ nickname: '' });
        assert.equal(r.status, 400);
        assert.match((await r.json()).error, /nickname/);

        down = true;
        try {
            r = await post({ nickname: 'Novo' });
            assert.equal(r.status, 404);
            const j = await r.json();
            assert.equal(j.error, 200);
            assert.match(j.description, /indisponivel/);
        } finally { down = false; }

        const before = refreshed.length;
        r = await post({ nickname: 'Novo' });
        assert.equal(r.status, 201);
        assert.equal(refreshed.length, before + 1);
    });
});

// --- profile writes by the Redis functions -----------------------------------
test('createProfile: UMA chamada tv30_profile_write com a visibilidade do servico ativo e a Tabela 7 em texto', async () => {
    store.clear();
    fcalls.length = 0;
    store.set('session:current-service-id', 'urn:tv30:service:users-test');
    const { user } = await profiles.createProfile({ nickname: ' Novo ', closedSigning: true, accessConsent: ['urn:a'] });
    assert.equal(fcalls.length, 1);
    const [nome, id, n, ...resto] = fcalls[0];
    assert.equal(nome, 'tv30_profile_write');
    assert.equal(id, user.id);
    assert.equal(n, '2');
    assert.deepEqual(resto.slice(0, 2), ['urn:a', 'urn:tv30:service:users-test']);
    const h = {};
    for (let i = 2; i < resto.length; i += 2) h[resto[i]] = resto[i + 1];
    assert.equal(h.id, user.id);
    assert.equal(h.nickname, 'Novo');
    assert.equal(h.closedSigning, 'true');
    assert.equal(h.closedSigningSide, 'right');
    assert.equal(h.closedSigningWidth, '28');
    assert.equal(h.parentalControl, 'false');
    assert.equal(h.maxContentRating, undefined, 'condicional falso fica fora do hash');
    assert.match(h.lastAccess, /^[1-9]\d*$/);
    // Id as a UUID (Table 7), the RFC 9562 format in lowercase; two profiles
    // never get the same one.
    assert.match(user.id, UUID_RE);
    const { user: outro } = await profiles.createProfile({ nickname: 'Outro' });
    assert.match(outro.id, UUID_RE);
    assert.notEqual(outro.id, user.id);
});

test('limite de cinco: a recusa da funcao que grava vira ValidationError com a mensagem da tela, sem despejo', async () => {
    store.clear();
    fcalls.length = 0;
    const idx = new Set();
    for (let i = 1; i <= 5; i++) {
        idx.add(perfil(i));
        store.set(`user:${perfil(i)}`, { nickname: `P${i}`, lastAccess: String(1000 + i) });
    }
    store.set(`user:${perfil(3)}:broadcaster-attrs:urn:s`, { a: '1' });
    store.set('users:index', idx);
    await assert.rejects(profiles.createProfile({ nickname: 'Sexto' }),
        err => err instanceof profiles.ValidationError && err.message === 'O limite de 5 perfis foi atingido. O perfil não foi criado.');
    assert.deepEqual(fcalls.map(c => c[0]), ['tv30_profile_write'], 'sem leitura previa: a conferencia e da funcao');
    assert.equal(setOf('users:index').size, 5);
    assert.equal(store.has(`user:${perfil(3)}:broadcaster-attrs:urn:s`), true);

    // The limit of the message is the one of the refusal; another refusal of
    // the function is still a defect.
    recusa = ['tv30_profile_write', 'TV30SCHEMA tv30_profile_write: users:index limit of 3 profiles reached (10.3.3): "x" not written'];
    try {
        await assert.rejects(profiles.createProfile({ nickname: 'Outro' }),
            err => err instanceof profiles.ValidationError && err.message === 'O limite de 3 perfis foi atingido. O perfil não foi criado.');
        recusa = ['tv30_profile_write', 'TV30SCHEMA tv30_profile_write: users:index in Redis is string, the schema asks for set (nada gravado)'];
        await assert.rejects(profiles.createProfile({ nickname: 'Outro' }), err => !(err instanceof profiles.ValidationError) && /in Redis is string/.test(err.message));
    } finally { recusa = null; }

    // With four, the fifth is created.
    idx.delete(perfil(5));
    store.delete(`user:${perfil(5)}`);
    const { user } = await profiles.createProfile({ nickname: 'Quinto' });
    assert.match(user.id, UUID_RE);
});

test('POST /profile/create: idioma ou visibilidade fora do esquema 400 (antes de gravar); recusa da funcao 404 {error:200}', async () => {
    store.clear();
    await withApp(app => app.use('/profile', managerRouter), async base => {
        const post = body => fetch(`${base}/profile/create`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        fcalls.length = 0;
        for (const body of [
            { nickname: 'X', audioLanguage: 'Português' },
            { nickname: 'X', userInterfaceLanguage: 'pt_BR' },
            { nickname: 'X', closedCaptioning: true, closedCaptioningLanguage: 'p' },
            { nickname: 'X', accessConsent: [''] },
            { nickname: 'X', accessConsent: 'urn:a' },
            { nickname: 'X', accessConsent: ['x'.repeat(257)] },
        ]) {
            const r = await post(body);
            assert.equal(r.status, 400, JSON.stringify(body));
        }
        assert.deepEqual(fcalls, [], 'nada chega a funcao');
        // A caption language with captions off is not written: no refusal.
        let r = await post({ nickname: 'X', closedCaptioning: false, closedCaptioningLanguage: 'qualquer coisa' });
        assert.equal(r.status, 201);

        const msg = `TV30SCHEMA tv30_profile_write: user:${UM} field nickname: has 21 characters, maximum 20`;
        recusa = ['tv30_profile_write', msg];
        try {
            r = await post({ nickname: 'Novo' });
            assert.equal(r.status, 404);
            const j = await r.json();
            assert.equal(j.error, 200);
            assert.ok(j.description.includes(msg), j.description);
        } finally { recusa = null; }
    });
});

// --- avatar = name of an image of the set (Table 7: "file path") ------------
// The form sends the name of an image of avatar:{name}; the avatar field gets
// it. Absent, the profile has no avatar; a name outside the set is a
// ValidationError and nothing is written.
const AVATAR = 'green.svg';
const imagemDoConjunto = name => store.set(`avatar:${name}`, { label: name, type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
// Fields of the hash in the call
// tv30_profile_write <id> <n> <consent x n> <field value ...>
const hashOfCall = call => {
    const [, , n, ...resto] = call;
    const h = {};
    for (let i = Number(n); i + 1 < resto.length; i += 2) h[resto[i]] = resto[i + 1];
    return h;
};

test('createProfile grava o nome da imagem do conjunto no campo avatar', async () => {
    store.clear();
    fcalls.length = 0;
    imagemDoConjunto(AVATAR);
    const { user } = await profiles.createProfile({ nickname: 'Verde', avatar: AVATAR });
    assert.equal(user.avatar, AVATAR);
    assert.equal(hashOfCall(fcalls[0]).avatar, AVATAR, 'campo avatar gravado no Redis = nome da imagem');

    // Through the route: the response carries the name.
    await withApp(app => app.use('/profile', managerRouter), async base => {
        const r = await fetch(`${base}/profile/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname: 'Rota', avatar: AVATAR }) });
        assert.equal(r.status, 201);
        assert.equal((await r.json()).user.avatar, AVATAR);
    });
});

test('avatar ausente: perfil sem avatar', async () => {
    for (const avatar of [undefined, null, '']) {
        store.clear();
        fcalls.length = 0;
        const { user } = await profiles.createProfile({ nickname: 'Sem', avatar });
        assert.equal(user.avatar, undefined, JSON.stringify(avatar));
        assert.equal('avatar' in hashOfCall(fcalls[0]), false, JSON.stringify(avatar));
    }
});

test('avatar fora do conjunto: ValidationError, nada gravado; POST /profile/create responde 400', async () => {
    store.clear();
    imagemDoConjunto(AVATAR);
    for (const avatar of ['blue.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'a.png', 42, ['green.svg']]) {
        fcalls.length = 0;
        await assert.rejects(profiles.createProfile({ nickname: 'Fora', avatar }), profiles.ValidationError, JSON.stringify(avatar));
        assert.deepEqual(fcalls, [], JSON.stringify(avatar));
    }
    await withApp(app => app.use('/profile', managerRouter), async base => {
        const r = await fetch(`${base}/profile/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname: 'Fora', avatar: 'blue.svg' }) });
        assert.equal(r.status, 400);
        assert.equal((await r.json()).error, 'avatar deve ser uma das imagens do conjunto de avatares');
    });
});

test('o sexto perfil e recusado pela funcao; POST /profile/create responde 400 com a mensagem', async () => {
    store.clear();
    fcalls.length = 0;
    const idx = new Set();
    for (let i = 1; i <= 5; i++) {
        idx.add(perfil(i));
        store.set(`user:${perfil(i)}`, { nickname: `P${i}`, lastAccess: String(1000 + i) });
    }
    store.set('users:index', idx);
    await withApp(app => app.use('/profile', managerRouter), async base => {
        const r = await fetch(`${base}/profile/create`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'Sexto' }),
        });
        assert.equal(r.status, 400);
        assert.equal((await r.json()).error, 'O limite de 5 perfis foi atingido. O perfil não foi criado.');
    });
    assert.deepEqual(fcalls.map(c => c[0]), ['tv30_profile_write']);
});

// --- removal by the viewer and default profile -------------------------------
const perfilNoDuble = (id, campos = {}) => {
    store.set('users:index', setOf('users:index').add(id));
    store.set(`user:${id}`, { id, nickname: `N${id.slice(-2)}`, ...campos });
};

test('removeProfile: o unico perfil registrado e o perfil inexistente nao sao removidos (ValidationError, nada chamado)', async () => {
    store.clear();
    fcalls.length = 0;
    perfilNoDuble(UM);
    await assert.rejects(profiles.removeProfile(UM),
        err => err instanceof profiles.ValidationError && err.message === 'The only registered profile cannot be removed.');
    for (const id of [perfil(9), '', undefined]) {
        await assert.rejects(profiles.removeProfile(id),
            err => err instanceof profiles.ValidationError && err.message === 'This profile no longer exists.', String(id));
    }
    assert.deepEqual(fcalls, []);
    assert.ok(store.has(`user:${UM}`));
});

test('removeProfile: perfil, visibilidade e atributos de emissora pela tv30_profile_remove; a imagem do conjunto fica', async () => {
    store.clear();
    fcalls.length = 0;
    imagemDoConjunto(AVATAR);
    const [A, B] = [perfil(1), perfil(2)];
    perfilNoDuble(A, { avatar: AVATAR });
    store.set(`user:${A}:consent`, new Set(['urn:s']));
    store.set(`user:${A}:broadcaster-attrs:urn:s`, { cor: 'azul' });
    store.set(`user:${A}:broadcaster-attrs:urn:t`, { k: 'v' });
    perfilNoDuble(B, { avatar: AVATAR });

    assert.deepEqual(await profiles.removeProfile(A), { id: A });
    assert.deepEqual(fcalls, [['tv30_profile_remove', A]]);
    assert.deepEqual([...store.keys()].filter(k => k.startsWith(`user:${A}`)), []);
    assert.equal(setOf('users:index').has(A), false);
    assert.ok(store.has(`avatar:${AVATAR}`), 'a imagem do conjunto nao e apagada');
    // B is alone.
    await assert.rejects(profiles.removeProfile(B), /only registered profile/);
    assert.deepEqual([...setOf('users:index')], [B]);
});

test('removeProfile: duas remocoes ao mesmo tempo com dois perfis deixam um perfil', async () => {
    store.clear();
    fcalls.length = 0;
    perfilNoDuble(perfil(1));
    perfilNoDuble(perfil(2));
    const r = await Promise.allSettled([profiles.removeProfile(perfil(1)), profiles.removeProfile(perfil(2))]);
    assert.deepEqual(r.map(x => x.status).sort(), ['fulfilled', 'rejected']);
    assert.ok(r.find(x => x.status === 'rejected').reason instanceof profiles.ValidationError);
    assert.equal(setOf('users:index').size, 1);
});

test('com cinco perfis, remover um permite criar outro', async () => {
    store.clear();
    const ids = [];
    for (let i = 1; i <= 5; i++) ids.push((await profiles.createProfile({ nickname: `P${i}` })).user.id);
    await assert.rejects(profiles.createProfile({ nickname: 'Sexto' }), profiles.ValidationError);
    await profiles.removeProfile(ids[2]);
    const { user } = await profiles.createProfile({ nickname: 'Sexto' });
    assert.equal(setOf('users:index').size, 5);
    assert.ok(setOf('users:index').has(user.id));
});

test('POST /profile/remove: 400 com a mensagem (perfil unico, inexistente); Redis fora 404 {error:200}; ok 200 e core.profileRemoved', async () => {
    store.clear();
    removidos.length = 0;
    perfilNoDuble(UM);
    await withApp(app => app.use('/profile', managerRouter), async base => {
        const post = body => fetch(`${base}/profile/remove`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        let r = await post({ id: UM });
        assert.equal(r.status, 400);
        assert.deepEqual(await r.json(), { error: 'The only registered profile cannot be removed.' });
        r = await post({});
        assert.equal(r.status, 400);
        assert.deepEqual(await r.json(), { error: 'This profile no longer exists.' });

        perfilNoDuble(perfil(1));
        down = true;
        try {
            r = await post({ id: UM });
            assert.equal(r.status, 404);
            assert.equal((await r.json()).error, 200);
        } finally { down = false; }
        assert.deepEqual(removidos, []);

        r = await post({ id: UM });
        assert.equal(r.status, 200);
        assert.deepEqual(await r.json(), { id: UM });
        assert.deepEqual(removidos, [UM], 'o core publica a remocao e volta ao seletor');
        assert.equal(store.has(`user:${UM}`), false);
    });
});

test('ensureDefaultProfile: base vazia ganha um perfil com os padroes da Tabela 7, id UUID e nickname Viewer 1, sem visibilidade; com perfil, nada', async () => {
    store.clear();
    fcalls.length = 0;
    const p = await profiles.ensureDefaultProfile();
    assert.match(p.id, UUID_RE);
    assert.equal(p.nickname, 'Viewer 1');
    assert.equal(fcalls.length, 1);
    const [nome, id, n] = fcalls[0];
    assert.equal(nome, 'tv30_profile_write');
    assert.equal(id, p.id);
    assert.equal(n, '0', 'sem visibilidade para servico algum');
    const h = hashOfCall(fcalls[0]);
    const { lastAccess, ...basicos } = h;
    assert.match(lastAccess, /^[1-9]\d*$/);
    assert.deepEqual(basicos, {
        id: p.id, nickname: 'Viewer 1', parentalControl: 'false', closedCaptioning: 'false', closedSigning: 'false',
        audioDescription: 'false', dialogEnhancement: 'false', voiceGuidance: 'false',
    });

    fcalls.length = 0;
    assert.equal(await profiles.ensureDefaultProfile(), null);
    assert.deepEqual(fcalls, []);

    // Two simultaneous calls on an empty base: a single profile.
    store.clear();
    const r = await Promise.all([profiles.ensureDefaultProfile(), profiles.ensureDefaultProfile()]);
    assert.equal(r.filter(Boolean).length, 1);
    assert.equal(setOf('users:index').size, 1);
});

test('platformErrorHandler: excecao em rota async vira 404 {error:200}', async () => {
    await withApp(app => app.get('/x', async () => { throw new Error('falhou'); }), async base => {
        const r = await fetch(`${base}/x`);
        assert.equal(r.status, 404);
        assert.deepEqual(await r.json(), { error: 200, description: 'Platform resource unavailable: falhou' });
    });
});
