// aop-transport-layer-metadata-lls (ABNT NBR 25608, 7.2.2): receives the SLT
// and the BAMT of each RF channel, in their JSON form, from the retained topics
// of the acquisition, and keeps the last ones for the Application Catalog.
const logger = require('../../logger');

const TOPIC = 'tlm/lls/#';
const SLT_TABLE = 'slt';
const BAMT_TABLE = 'bamt';

// { slt, bamt } of each RF channel, by the bsid of the topic.
const channels = new Map();

// tlm/lls/<bsid>/slt and tlm/lls/<bsid>/bamt; an empty message removes the
// table of the RF channel. A table that is not JSON is ignored and the
// previous one stays.
function receive(message, topic) {
    const parts = topic.split('/');
    if (parts.length !== 4 || !parts[2]) {
        return;
    }
    const bsid = parts[2];
    const table = parts[3];
    if (table !== SLT_TABLE && table !== BAMT_TABLE) {
        return;
    }
    const tables = channels.get(bsid) || {};
    if (!message) {
        delete tables[table];
    } else {
        try {
            tables[table] = JSON.parse(message);
        } catch (err) {
            logger.error(`[lls] ${table.toUpperCase()} of ${bsid} ignored: ${err.message}`);
            return;
        }
    }
    if (tables.slt === undefined && tables.bamt === undefined) {
        channels.delete(bsid);
        return;
    }
    channels.set(bsid, tables);
}

// { slt, bamt } of the RF channel, either one possibly undefined, or
// undefined when nothing was received for it.
function channel(bsid) {
    return channels.get(String(bsid));
}

// The Service element of the SLT of the RF channel with this serviceId, or
// undefined.
function service(bsid, serviceId) {
    const tables = channel(bsid);
    if (!tables || !tables.slt) {
        return undefined;
    }
    return (tables.slt.Service || []).find((entry) => entry.serviceId === Number(serviceId));
}

module.exports = { TOPIC, receive, channel, service };
