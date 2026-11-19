// aop-transport-layer-metadata-lls: the SLT and the BAMT of each RF channel,
// kept from the retained topics of the acquisition.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const lls = require('../src/modules/transport-layer-metadata-lls');

const realError = console.error;
const logs = [];
console.error = (...a) => { logs.push(a.join(' ')); };
after(() => { console.error = realError; });

const SLT = { bsid: [10], bandwidth: 6, Service: [{ serviceId: 1001, globalServiceId: 'urn:tv30:service:a' }] };
const BAMT = { groupingType: 'noGrouping', BAM: [{ globalServiceId: 'urn:tv30:service:a', appName: 'A' }] };

test('SLT e BAMT de cada canal RF, pelo bsid do topico', () => {
    assert.equal(lls.channel(10), undefined);
    lls.receive(JSON.stringify(SLT), 'tlm/lls/10/slt');
    assert.deepEqual(lls.channel(10), { slt: SLT });
    lls.receive(JSON.stringify(BAMT), 'tlm/lls/10/bamt');
    assert.deepEqual(lls.channel('10'), { slt: SLT, bamt: BAMT });
});

test('mensagem vazia tira a tabela; sem as duas, o canal sai', () => {
    lls.receive('', 'tlm/lls/10/bamt');
    assert.deepEqual(lls.channel(10), { slt: SLT });
    lls.receive('', 'tlm/lls/10/slt');
    assert.equal(lls.channel(10), undefined);
});

test('tabela que nao e JSON vai ao log e a anterior fica; outras tabelas e topicos sao ignorados', () => {
    lls.receive(JSON.stringify(SLT), 'tlm/lls/11/slt');
    lls.receive('nao e json', 'tlm/lls/11/slt');
    assert.deepEqual(lls.channel(11), { slt: SLT });
    assert.ok(logs.some((l) => l.includes('SLT of 11 ignored')));
    lls.receive('{"x":1}', 'tlm/lls/11/tbsat');
    lls.receive('{"x":1}', 'tlm/lls/11/extra/bamt');
    assert.deepEqual(lls.channel(11), { slt: SLT });
});

test('o elemento Service da SLT de um canal, pelo serviceId', () => {
    lls.receive(JSON.stringify(SLT), 'tlm/lls/12/slt');
    assert.deepEqual(lls.service(12, '1001'), SLT.Service[0]);
    assert.equal(lls.service(12, 1002), undefined);
    assert.equal(lls.service(13, 1001), undefined);
});
