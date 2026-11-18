// aop-transport-layer-metadata-lls (7.2.2): receives the SLT and the BAMT of
// each RF channel and owns the list of announced services
// (services:announced in Redis and the retained topic aop/services), one per
// BAM, by the globalServiceId. The SLT gives the serviceId of each
// globalServiceId, the key of the SLS topics.
const logger = require('../../logger');
const redis = require('../../redis-client');
const redisFunctions = require('../../redis-functions');

const TOPIC = 'tlm/lls/#';
const SERVICES_TOPIC = 'aop/services';
const SERVICES_KEY = 'services:announced';
const RETRY_MAX_MS = 10000;
const RETRY_STEP_MS = 2000;
const SLT_TABLE = 'slt';
const BAMT_TABLE = 'bamt';

// BAM list of each RF channel (<bsid>); the one received last is at the end.
const bamts = new Map();
// globalServiceId to serviceId, for each RF channel (<bsid>); the one
// received last is at the end.
const slts = new Map();
let publish = null;
let chain = Promise.resolve();
let retryTimer = null;
let failures = 0;

// publish(topic, message) publishes retained. The first write, with no BAMT
// yet, removes from Redis the list of the previous start.
function start(pub) {
    publish = pub;
    return commit();
}

// tlm/lls/<bsid>/slt and tlm/lls/<bsid>/bamt, in the JSON form of the
// tables (BAMT = { BAM: [...] }); an empty message removes the table of the
// RF channel. Only the BAMT changes the list.
function receive(message, topic) {
    const parts = topic.split('/');
    if (parts.length !== 4 || !parts[2]) {
        return Promise.resolve();
    }
    const bsid = parts[2];
    switch (parts[3]) {
        case SLT_TABLE:
            receiveSlt(bsid, message);
            return Promise.resolve();
        case BAMT_TABLE:
            return receiveBamt(bsid, message);
        default:
            return Promise.resolve();
    }
}

// For the Application Catalog: those in services:announced, with the BAM;
// without a received BAM there is nothing to show. A Redis failure rejects.
async function services() {
    const inStore = new Set(await redis.smembers(SERVICES_KEY));
    return announced().filter((service) => inStore.has(service.serviceContextId));
}

// { serviceContextId, bam, serviceId } of the announced service, or
// undefined; serviceId is undefined while no SLT lists the service.
function service(scid) {
    const found = announced().find((announcedService) => announcedService.serviceContextId === scid);
    if (!found) {
        return undefined;
    }
    return { ...found, serviceId: serviceIdOf(scid) };
}

function receiveSlt(bsid, message) {
    slts.delete(bsid);
    if (!message) {
        return;
    }
    let slt;
    try {
        slt = JSON.parse(message);
    } catch (err) {
        logger.error(`[lls] SLT of ${bsid} ignored: ${err.message}`);
        return;
    }
    const ids = new Map();
    for (const entry of slt.Service || []) {
        ids.set(entry.globalServiceId, entry.serviceId);
    }
    slts.set(bsid, ids);
}

function receiveBamt(bsid, message) {
    if (!message) {
        if (!bamts.delete(bsid)) {
            return Promise.resolve();
        }
        return commit();
    }
    let bamt;
    try {
        bamt = JSON.parse(message);
    } catch (err) {
        logger.error(`[lls] BAMT of ${bsid} ignored: ${err.message}`);
        return Promise.resolve();
    }
    bamts.delete(bsid);
    const valid = Array.isArray(bamt.BAM) ? bamt.BAM.filter(isAnnounced) : [];
    bamts.set(bsid, valid);
    return commit();
}

// From the SLT received last that lists the globalServiceId.
function serviceIdOf(scid) {
    let serviceId;
    for (const ids of slts.values()) {
        if (ids.has(scid)) {
            serviceId = ids.get(scid);
        }
    }
    return serviceId;
}

// [{ serviceContextId, bam }]: the globalServiceId is the serviceContextId
// (C.3.5); repeated in more than one BAMT, the BAM of the one received last
// prevails.
function announced() {
    const out = new Map();
    for (const bamt of bamts.values()) {
        for (const bam of bamt) {
            const known = out.get(bam.globalServiceId);
            if (known) {
                known.bam = bam;
            } else {
                out.set(bam.globalServiceId, { serviceContextId: bam.globalServiceId, bam });
            }
        }
    }
    return [...out.values()];
}

// One write at a time, of the current state; the topic is published only
// with Redis written. A Redis failure is retried; a schema refusal is not.
function commit() {
    chain = chain.then(write);
    return chain;
}

async function write() {
    const ids = announced().map((announcedService) => announcedService.serviceContextId);
    try {
        await redisFunctions.announcedServices(ids);
    } catch (err) {
        failures++;
        const refused = redisFunctions.isSchemaRefusal(err);
        if (refused || failures === 1) {
            logger.error(`[lls] ${SERVICES_KEY} not written (${ids.length} service(s)): ${err.message}`);
        }
        if (!refused) {
            retry();
        }
        return;
    }
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    if (failures) {
        logger.info(`[lls] ${SERVICES_KEY} written after ${failures} failure(s)`);
    }
    failures = 0;
    if (publish) {
        const message = ids.map((id) => ({ serviceContextId: id }));
        publish(SERVICES_TOPIC, JSON.stringify(message));
    }
}

function retry() {
    if (retryTimer) {
        return;
    }
    const delay = Math.min(failures * RETRY_STEP_MS, RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
        retryTimer = null;
        commit();
    }, delay);
    retryTimer.unref();
}

function isAnnounced(bam) {
    return bam && typeof bam.globalServiceId === 'string' && bam.globalServiceId;
}

module.exports = { TOPIC, SERVICES_TOPIC, SERVICES_KEY, start, receive, services, service };
