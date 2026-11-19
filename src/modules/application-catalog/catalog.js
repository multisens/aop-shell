// State of aop-application-catalog: the catalog lives in services:announced
// (Redis), one record per Bootstrap Application, and is recomputed at each
// scan marker of the acquisition (tlm/scan) from the LLS tables of the RF
// channels detected. The listed globalServiceIds go to the retained topic
// aop/services.
const logger = require('../../logger');
const redis = require('../../redis-client');
const redisFunctions = require('../../redis-functions');
const { whenReady } = require('../../redis-options');
const lls = require('../transport-layer-metadata-lls');
const { computeCatalog, catalogItems, orderCatalog } = require('./compute');

const SCAN_TOPIC = 'tlm/scan';
const SERVICES_TOPIC = 'aop/services';
const SERVICES_KEY = 'services:announced';
const WRONG_TYPE = /^WRONGTYPE/;

let publish = null;
let chain = Promise.resolve();
let failures = 0;

// publish(topic, message) publishes retained; the stored catalog is
// published once Redis is ready.
function start(pub) {
    publish = pub;
    whenReady(redis, `publication of ${SERVICES_TOPIC}`, async () => {
        publishList(await stored());
    });
}

// One scan at a time. A scan with an RF channel whose SLT was not received
// yet is skipped; the next marker comes in a cycle of the acquisition.
function receiveScan(message) {
    chain = chain.then(() => scan(message));
    return chain;
}

// The items of the Application Catalog, in order (catalogItems); a Redis
// failure rejects.
async function items() {
    return catalogItems(await stored());
}

// { serviceContextId, bam, serviceId, bsid } of a listed service, or
// undefined; a Redis failure rejects. A key of another type counts as empty.
async function service(gsid) {
    let value;
    try {
        value = await redis.hget(SERVICES_KEY, gsid);
    } catch (err) {
        if (WRONG_TYPE.test(err.message)) {
            return undefined;
        }
        throw err;
    }
    if (value === null || value === undefined) {
        return undefined;
    }
    const record = JSON.parse(value);
    return { serviceContextId: gsid, bam: record.bam, serviceId: record.serviceId, bsid: record.bsid };
}

async function scan(message) {
    if (!message) {
        return;
    }
    let marker;
    try {
        marker = JSON.parse(message);
    } catch (err) {
        logger.error(`[catalog] scan marker ignored: ${err.message}`);
        return;
    }
    const detected = [];
    for (const bsid of marker.rfChannels || []) {
        const tables = lls.channel(bsid);
        if (!tables || !tables.slt) {
            logger.debug(`[catalog] scan skipped: no SLT of RF channel ${bsid} yet`);
            return;
        }
        detected.push({ bsid, slt: tables.slt, bamt: tables.bamt });
    }
    try {
        const previous = await stored();
        const next = computeCatalog(detected, previous);
        if (canonical([...previous]) === canonical([...next])) {
            return;
        }
        await redisFunctions.announcedServices(next);
        if (failures > 0) {
            logger.info(`[catalog] ${SERVICES_KEY} written after ${failures} failure(s)`);
        }
        failures = 0;
        publishList(next);
    } catch (err) {
        failures++;
        if (failures === 1 || redisFunctions.isSchemaRefusal(err)) {
            logger.error(`[catalog] ${SERVICES_KEY} not written: ${err.message}`);
        }
    }
}

// The stored catalog, in presentation order. A key of another type (the set
// of a previous version) counts as empty: the next write replaces it.
async function stored() {
    let hash;
    try {
        hash = await redis.hgetall(SERVICES_KEY);
    } catch (err) {
        if (WRONG_TYPE.test(err.message)) {
            return new Map();
        }
        throw err;
    }
    const catalog = new Map();
    for (const [gsid, value] of Object.entries(hash || {})) {
        catalog.set(gsid, JSON.parse(value));
    }
    return orderCatalog(catalog);
}

function publishList(catalog) {
    if (!publish) {
        return;
    }
    const message = [...catalog.keys()].map((gsid) => ({ serviceContextId: gsid }));
    publish(SERVICES_TOPIC, JSON.stringify(message));
}

// JSON with the object keys sorted, to compare records.
function canonical(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

module.exports = { SCAN_TOPIC, SERVICES_TOPIC, SERVICES_KEY, start, receiveScan, items, service };
