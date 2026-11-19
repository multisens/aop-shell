// aop-application-catalog: the computation of the catalog at each scan
// (ABNT NBR 25608, 8.2; TV 3.0 Operational Guidelines, 8.2), the six
// scenarios of the implementation document, 7.5, the groupings, and the
// state in services:announced with Redis by a double.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const express = require('express');

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aop-catalog-'));
process.env.USER_DATA_PATH = USER_DATA;
after(() => fs.rmSync(USER_DATA, { recursive: true, force: true }));

// --- doubles -----------------------------------------------------------------
// services:announced as a Map; tipoErrado makes HGETALL answer WRONGTYPE,
// as the set of the previous schema version.
let anunciados = new Map();
let tipoErrado = false;
let fora = false;
let recusa = null;
const escritas = [];
const fakeRedis = {
    status: 'ready',
    once() {},
    async call(cmd, nome, numkeys, ...args) {
        if (cmd !== 'FCALL' || nome !== 'tv30_announced_services' || Number(numkeys) !== 0) {
            throw new Error(`call ${cmd} ${nome}: nao suportado pelo duble`);
        }
        if (fora) throw new Error('connect ECONNREFUSED (duble)');
        if (recusa) throw new Error(recusa);
        escritas.push(args.map(String));
        anunciados = new Map();
        for (let i = 0; i + 1 < args.length; i += 2) anunciados.set(String(args[i]), String(args[i + 1]));
        tipoErrado = false;
        return anunciados.size;
    },
    async hgetall(k) {
        if (fora) throw new Error('redis indisponivel (duble)');
        if (tipoErrado) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return k === 'services:announced' ? Object.fromEntries(anunciados) : {};
    },
    async hget(k, f) {
        if (fora) throw new Error('redis indisponivel (duble)');
        if (tipoErrado) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return k === 'services:announced' && anunciados.has(f) ? anunciados.get(f) : null;
    },
};
function stub(rel, exports) {
    const file = require.resolve(path.join(__dirname, '..', 'src', rel));
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
}
stub('redis-client', fakeRedis);
stub('core', {
    GUI: { app_catalogue: '/appcat', profile_chooser: '/prfchs', profile_creator: '/profile/create', bootstrap_app: '/btpapp' },
    getUserData: () => ({ name: 'Maria', avatar: null }),
    getCurrentUser: () => 'u1',
});

const { computeCatalog, catalogItems } = require('../src/modules/application-catalog/compute');
const lls = require('../src/modules/transport-layer-metadata-lls');
const catalog = require('../src/modules/application-catalog/catalog');
const catalogRouter = require('../src/modules/application-catalog');
const { platformErrorHandler } = require('../src/http-error');

const realError = console.error;
const realLog = console.log;
const logs = [];
console.error = console.log = (...a) => { logs.push(a.join(' ')); };
after(() => { console.error = realError; console.log = realLog; });

// --- builders ----------------------------------------------------------------
const ICON = '<svg xmlns="http://www.w3.org/2000/svg"/>';
const gsidOf = n => `urn:tv30:service:${n}`;
// An SLT entry: n is the serviceId, and also the minor of the virtual number.
function svc(n, { major = 10, minor = n, main = true, rq = 80, category = 30, gsid = gsidOf(n) } = {}) {
    return { serviceId: n, globalServiceId: gsid, serviceCategory: category, majorChannelNo: major,
        minorChannelNo: minor, mainAvOverTheAir: main, receptionQuality: rq };
}
// A detected RF channel with a BAM for each service.
function canal(bsid, services, { bandwidth = 6, groupingType } = {}) {
    const bamt = { BAM: services.map(s => ({ globalServiceId: s.globalServiceId, appVersion: 1, appName: `S${s.serviceId}`,
        backgroundColor: '#000000', foregroundColor: '#ffffff', appIcon: ICON, bannerIcon: ICON })) };
    if (groupingType) bamt.groupingType = groupingType;
    return { bsid, slt: { bsid: [bsid], bandwidth, Service: services }, bamt };
}
const ids = c => [...c.keys()];
const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

// --- 7.5 ---------------------------------------------------------------------
test('7.5: canal de 6 MHz com cinco servicos tipo 30 pelo ar: quatro no catalogo, sai o de maior numero virtual', () => {
    const c = computeCatalog([canal(10, range(1, 5).map(n => svc(n)))], new Map());
    assert.deepEqual(ids(c), range(1, 4).map(gsidOf));
});

test('7.5: quatro pelo ar e quatro so pela Internet, 6 MHz: oito no catalogo', () => {
    const services = [...range(1, 4).map(n => svc(n)), ...range(5, 4).map(n => svc(n, { main: false }))];
    assert.equal(computeCatalog([canal(10, services)], new Map()).size, 8);
});

test('7.5: canal so com servicos so pela Internet: nenhum do canal (ACFR-26)', () => {
    const c = computeCatalog([canal(10, range(1, 3).map(n => svc(n, { main: false }))), canal(11, [svc(9)])], new Map());
    assert.deepEqual(ids(c), [gsidOf(9)]);
});

test('7.5: mesmo globalServiceId em dois canais: um so, o que ja estava no catalogo (ACFR-12)', () => {
    const g = gsidOf(1);
    const canais = [canal(10, [svc(1, { gsid: g })]), canal(20, [svc(2, { gsid: g, major: 20 })])];
    const antes = computeCatalog([canal(20, [svc(2, { gsid: g, major: 20 })])], new Map());
    const c = computeCatalog(canais, antes);
    assert.deepEqual(ids(c), [g]);
    assert.equal(c.get(g).bsid, 20);
    // Without a previous catalog, the first in the order of the scan.
    assert.equal(computeCatalog(canais, new Map()).get(g).bsid, 10);
});

test('7.5: 61 servicos validos detectados agora: 60 no catalogo, sai o ultimo pela prioridade (ACFR-27, ACFR-28)', () => {
    const canais = range(1, 15).map(b => canal(b, range(b * 10, 4).map(n => svc(n, { major: b }))));
    canais.push(canal(16, [svc(500, { major: 16, rq: 10 })]));
    const c = computeCatalog(canais, new Map());
    assert.equal(c.size, 60);
    assert.ok(!c.has(gsidOf(500)), 'sai o de menor receptionQuality');
});

test('7.5: canal removido da declaracao, nova varredura: os servicos dele continuam (ACFR-21)', () => {
    const antes = computeCatalog([canal(10, [svc(1)]), canal(20, [svc(2, { major: 20 })])], new Map());
    const c = computeCatalog([canal(10, [svc(1)])], antes);
    assert.deepEqual(ids(c), [gsidOf(1), gsidOf(2)]);
});

// --- the other rules ---------------------------------------------------------
test('guia operacional 8.2: servico retirado de canal ainda detectado sai do catalogo; os presentes sao atualizados pelo BAM corrente', () => {
    const antes = computeCatalog([canal(10, [svc(1), svc(2)])], new Map());
    const agora = canal(10, [svc(1)]);
    agora.bamt.BAM[0].appName = 'Novo';
    const c = computeCatalog([agora], antes);
    assert.deepEqual(ids(c), [gsidOf(1)]);
    assert.equal(c.get(gsidOf(1)).bam.appName, 'Novo');
});

test('servico sem BAM na BAMT, de outra categoria ou canal sem BAMT: fora', () => {
    const c10 = canal(10, [svc(1), svc(2), svc(3, { category: 31 })]);
    c10.bamt.BAM = c10.bamt.BAM.filter(b => b.globalServiceId !== gsidOf(2));
    const c11 = { ...canal(11, [svc(4)]), bamt: undefined };
    assert.deepEqual(ids(computeCatalog([c10, c11], new Map())), [gsidOf(1)]);
});

test('limites por largura de banda: 7 MHz admite cinco e 8 MHz seis de cada tipo (ACFR-23, ACFR-24)', () => {
    assert.equal(computeCatalog([canal(10, range(1, 9).map(n => svc(n)), { bandwidth: 7 })], new Map()).size, 5);
    assert.equal(computeCatalog([canal(10, range(1, 9).map(n => svc(n)), { bandwidth: 8 })], new Map()).size, 6);
});

test('acima de 60: os retidos de canal nao detectado vem depois, pelo ar antes de so Internet (ACFR-28, 3 e 4)', () => {
    const antigos = [canal(90, [svc(901, { major: 90 }), svc(902, { major: 90, main: false })])];
    const antes = computeCatalog(antigos, new Map());
    const canais = range(1, 15).map(b => canal(b, range(b * 10, 4).map(n => svc(n, { major: b }))));
    let c = computeCatalog(canais, antes);
    assert.equal(c.size, 60);
    assert.ok(!c.has(gsidOf(901)) && !c.has(gsidOf(902)));
    canais.pop();
    c = computeCatalog(canais.slice(0, 14).concat([canal(15, range(150, 3).map(n => svc(n, { major: 15 })))]), antes);
    assert.equal(c.size, 59 + 1);
    assert.ok(c.has(gsidOf(901)) && !c.has(gsidOf(902)), 'o retido pelo ar fica, o so Internet sai');
});

test('ordem de apresentacao pelo numero virtual (ACFR-06)', () => {
    const c = computeCatalog([canal(20, [svc(3, { major: 2, minor: 1 })]), canal(10, [svc(1, { major: 1, minor: 5 }),
        svc(2, { major: 1, minor: 2 })])], new Map());
    assert.deepEqual(ids(c), [gsidOf(2), gsidOf(1), gsidOf(3)]);
});

test('agrupamento obrigatorio: um item, no lugar do menor numero virtual, com os membros em ordem (ACFR-32, ACFR-34)', () => {
    const c = computeCatalog([canal(10, [svc(1)]), canal(20, [svc(3, { major: 20 }), svc(2, { major: 20 })],
        { groupingType: 'mandatoryGrouping' })], new Map());
    const itens = catalogItems(c);
    assert.deepEqual(itens.map(i => i.gsid), [gsidOf(1), gsidOf(2)]);
    assert.deepEqual(itens[1].members.map(r => r.serviceId), [2, 3]);
    assert.equal(itens[0].members, null);
});

test('agrupamento opcional: expandido se tudo cabe em 40, agrupado se nao (ACFR-33, ACFR-35)', () => {
    const opcional = canal(5, [svc(1, { major: 5 }), svc(2, { major: 5 })], { groupingType: 'optionalGrouping' });
    let itens = catalogItems(computeCatalog([opcional, canal(10, [svc(3)])], new Map()));
    assert.ok(itens.every(i => i.members === null));
    assert.equal(itens.length, 3);
    const muitos = range(11, 10).map(b => canal(b, range(b * 10, 4).map(n => svc(n, { major: b }))));
    itens = catalogItems(computeCatalog([opcional, ...muitos], new Map()));
    assert.equal(itens.length, 41);
    assert.deepEqual(itens[0].members.map(r => r.serviceId), [1, 2]);
});

// --- state in services:announced ---------------------------------------------
const publicados = [];
const ultimo = () => publicados.filter(([t]) => t === 'aop/services').at(-1);
const lista = (...g) => JSON.stringify(g.map(serviceContextId => ({ serviceContextId })));
const marco = (...rf) => JSON.stringify({ completedAt: '2026-01-01T00:00:00Z', rfChannels: rf });
function recebeCanal(c) {
    lls.receive(JSON.stringify(c.slt), `tlm/lls/${c.bsid}/slt`);
    lls.receive(JSON.stringify(c.bamt), `tlm/lls/${c.bsid}/bamt`);
}

test('partida: publica o catalogo guardado, retido', async () => {
    anunciados = new Map([[gsidOf(7), JSON.stringify(computeCatalog([canal(70, [svc(7)])], new Map()).get(gsidOf(7)))]]);
    catalog.start((t, m) => publicados.push([t, m]));
    await settle();
    assert.deepEqual(ultimo(), ['aop/services', lista(gsidOf(7))]);
});

test('marco de varredura: grava services:announced inteiro e publica a lista em ordem; o mesmo resultado nao regrava', async () => {
    recebeCanal(canal(10, [svc(2), svc(1)]));
    await catalog.receiveScan(marco(10));
    assert.deepEqual([...anunciados.keys()], [gsidOf(1), gsidOf(2), gsidOf(7)]);
    assert.deepEqual(ultimo(), ['aop/services', lista(gsidOf(1), gsidOf(2), gsidOf(7))]);
    assert.equal(JSON.parse(anunciados.get(gsidOf(1))).bsid, 10);
    const n = escritas.length;
    await catalog.receiveScan(marco(10));
    assert.equal(escritas.length, n);
});

test('marco com canal cuja SLT ainda nao chegou: a varredura e pulada', async () => {
    const n = escritas.length;
    await catalog.receiveScan(marco(10, 99));
    assert.equal(escritas.length, n);
});

test('servico do catalogo: BAM, serviceId e bsid do registro; fora dele, undefined', async () => {
    const s = await catalog.service(gsidOf(1));
    assert.equal(s.serviceId, 1);
    assert.equal(s.bsid, 10);
    assert.equal(s.bam.appName, 'S1');
    assert.equal(await catalog.service('urn:fora'), undefined);
});

test('conjunto da versao anterior (WRONGTYPE) conta como vazio e e substituido', async () => {
    tipoErrado = true;
    assert.equal(await catalog.service(gsidOf(1)), undefined);
    await catalog.receiveScan(marco(10));
    assert.deepEqual([...anunciados.keys()], [gsidOf(1), gsidOf(2)]);
});

test('falha do Redis e recusa do esquema: nada publicado, motivo no log; o proximo marco tenta de novo', async () => {
    recebeCanal(canal(11, [svc(3, { major: 11 })]));
    const p = publicados.length;
    fora = true;
    await catalog.receiveScan(marco(10, 11));
    fora = false;
    recusa = 'TV30SCHEMA tv30_announced_services: services:announced field "x": member "bam" required';
    await catalog.receiveScan(marco(10, 11));
    recusa = null;
    assert.equal(publicados.length, p);
    assert.ok(logs.some(l => l.includes('TV30SCHEMA tv30_announced_services')));
    await catalog.receiveScan(marco(10, 11));
    assert.ok(anunciados.has(gsidOf(3)));
    assert.ok(logs.some(l => l.includes('written after 2 failure(s)')));
});

// --- Application Catalog screen ----------------------------------------------
async function pagina() {
    const app = express();
    app.use('/appcat', catalogRouter);
    app.use(platformErrorHandler);
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/appcat`);
        return { status: res.status, body: await res.text() };
    } finally { await new Promise(r => server.close(r)); }
}
const cartoes = html => [...html.matchAll(/selectParam="([^"]*)"/g)].map(m => m[1]);

test('tela do catalogo: os itens em ordem; o agrupamento com a classe grouping e o numero de membros', async () => {
    recebeCanal(canal(30, [svc(31, { major: 30 }), svc(32, { major: 30 })], { groupingType: 'mandatoryGrouping' }));
    await catalog.receiveScan(marco(10, 11, 30));
    const r = await pagina();
    assert.equal(r.status, 200);
    assert.deepEqual(cartoes(r.body), [gsidOf(1), gsidOf(2), gsidOf(3), gsidOf(31)]);
    assert.ok(r.body.includes('class="card grouping" data-members="2"'));
    assert.ok(r.body.includes('<span>S1</span>'));
});

test('tela do catalogo: falha do Redis -> 404 {error:200}', async () => {
    fora = true;
    try {
        const r = await pagina();
        assert.equal(r.status, 404);
        assert.equal(JSON.parse(r.body).error, 200);
    } finally { fora = false; }
});
