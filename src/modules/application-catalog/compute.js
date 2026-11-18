// The Bootstrap Applications of the Application Catalog after a scan
// (ABNT NBR 25608, 8.2: ACFR-06, ACFR-12, ACFR-21 and ACFR-23 to ACFR-28;
// TV 3.0 Operational Guidelines, 8.2) and their grouping (ACFR-32 to
// ACFR-35). Pure functions: the inputs are the tables of the RF channels
// detected and the previous catalog.

const BOOTSTRAP_CATEGORY = 30;
const MAX_CATALOG = 60;
const MAX_VISIBLE = 40;
// ACFR-23 and ACFR-24: per RF channel bandwidth, in MHz.
const LIMITS = { 6: 4, 7: 5, 8: 6 };
const MANDATORY = 'mandatoryGrouping';
const OPTIONAL = 'optionalGrouping';

// channels: [{ bsid, slt, bamt }] of the RF channels detected in the scan,
// in the order of the scan; bamt may be undefined. previous: Map
// globalServiceId -> record. Gives the new catalog, a Map in presentation
// order; a record is { bsid, serviceId, majorChannelNo, minorChannelNo,
// mainAvOverTheAir, receptionQuality, groupingType, bam }.
function computeCatalog(channels, previous) {
    const detected = new Set(channels.map((channel) => channel.bsid));
    const candidates = [];
    for (const channel of channels) {
        candidates.push(...keptOfChannel(channel));
    }
    const chosen = deduplicate(candidates, previous, detected);
    const retained = [];
    for (const [gsid, record] of previous) {
        if (!detected.has(record.bsid) && !chosen.has(gsid)) {
            retained.push({ gsid, record, detectedNow: false });
        }
    }
    let entries = [...chosen].map(([gsid, record]) => ({ gsid, record, detectedNow: true }));
    entries = entries.concat(retained);
    if (entries.length > MAX_CATALOG) {
        entries.sort(byPriority);
        entries = entries.slice(0, MAX_CATALOG);
    }
    return orderCatalog(new Map(entries.map((entry) => [entry.gsid, entry.record])));
}

// The catalog in presentation order (ACFR-06): virtual number increasing,
// then globalServiceId.
function orderCatalog(catalog) {
    const entries = [...catalog];
    entries.sort(([oneId, one], [otherId, other]) => byVirtualNumber(one, other) || compareText(oneId, otherId));
    return new Map(entries);
}

// The items to show, in order: a single Bootstrap Application, or a
// grouping represented by its member of lowest virtual number. catalog is
// the Map of computeCatalog. Item: { gsid, record, members } with members
// the grouped records in virtual number order, or null.
function catalogItems(catalog) {
    const groups = new Map();
    for (const [gsid, record] of catalog) {
        if (record.groupingType !== MANDATORY && record.groupingType !== OPTIONAL) {
            continue;
        }
        const key = record.bsid;
        if (!groups.has(key)) {
            groups.set(key, { groupingType: record.groupingType, members: [] });
        }
        groups.get(key).members.push({ gsid, record });
    }
    let singles = 0;
    let optionalMembers = 0;
    let mandatoryGroups = 0;
    for (const record of catalog.values()) {
        if (record.groupingType !== MANDATORY && record.groupingType !== OPTIONAL) {
            singles++;
        }
    }
    for (const group of groups.values()) {
        if (group.groupingType === MANDATORY) {
            mandatoryGroups++;
        } else {
            optionalMembers += group.members.length;
        }
    }
    const expandOptional = singles + mandatoryGroups + optionalMembers <= MAX_VISIBLE;

    const items = [];
    const placed = new Set();
    for (const [gsid, record] of catalog) {
        const group = groups.get(record.bsid);
        const grouped = group && (group.groupingType === MANDATORY || !expandOptional)
            && (record.groupingType === MANDATORY || record.groupingType === OPTIONAL);
        if (!grouped) {
            items.push({ gsid, record, members: null });
            continue;
        }
        if (placed.has(record.bsid)) {
            continue;
        }
        placed.add(record.bsid);
        items.push({ gsid, record, members: group.members.map((member) => member.record) });
    }
    return items;
}

// ACFR-23 to ACFR-26 on one RF channel: its category 30 services with a BAM
// in the BAMT, none if no one is over the air, at most the limit of the
// bandwidth over the air and as many only over the Internet, by virtual
// number.
function keptOfChannel(channel) {
    const bams = new Map();
    const groupingType = channel.bamt ? channel.bamt.groupingType : undefined;
    for (const bam of (channel.bamt && channel.bamt.BAM) || []) {
        bams.set(bam.globalServiceId, bam);
    }
    const announced = [];
    for (const service of channel.slt.Service || []) {
        if (service.serviceCategory === BOOTSTRAP_CATEGORY && bams.has(service.globalServiceId)) {
            announced.push(recordOf(channel.bsid, service, bams.get(service.globalServiceId), groupingType));
        }
    }
    if (!announced.some((record) => record.mainAvOverTheAir)) {
        return [];
    }
    const limit = LIMITS[channel.slt.bandwidth] || 0;
    const overTheAir = announced.filter((record) => record.mainAvOverTheAir).sort(byVirtualNumber);
    const internetOnly = announced.filter((record) => !record.mainAvOverTheAir).sort(byVirtualNumber);
    return overTheAir.slice(0, limit).concat(internetOnly.slice(0, limit));
}

// ACFR-12: one record per globalServiceId. A service already in the catalog
// keeps the instance of its RF channel; if that channel was not detected,
// the previous record is retained and the new instances are disregarded.
// Otherwise the first instance in the order of the scan.
function deduplicate(candidates, previous, detected) {
    const byService = new Map();
    for (const record of candidates) {
        const gsid = record.bam.globalServiceId;
        if (!byService.has(gsid)) {
            byService.set(gsid, []);
        }
        byService.get(gsid).push(record);
    }
    const chosen = new Map();
    for (const [gsid, instances] of byService) {
        const before = previous.get(gsid);
        if (!before) {
            chosen.set(gsid, instances[0]);
            continue;
        }
        const same = instances.find((record) => record.bsid === before.bsid);
        if (same) {
            chosen.set(gsid, same);
        } else if (detected.has(before.bsid)) {
            chosen.set(gsid, instances[0]);
        }
    }
    return chosen;
}

function recordOf(bsid, service, bam, groupingType) {
    const record = {
        bsid,
        serviceId: service.serviceId,
        mainAvOverTheAir: service.mainAvOverTheAir === true,
        receptionQuality: service.receptionQuality,
        bam,
    };
    if (service.majorChannelNo !== undefined) {
        record.majorChannelNo = service.majorChannelNo;
    }
    if (service.minorChannelNo !== undefined) {
        record.minorChannelNo = service.minorChannelNo;
    }
    if (groupingType !== undefined) {
        record.groupingType = groupingType;
    }
    return record;
}

// ACFR-28: detected now before not detected, over the air before only over
// the Internet; among those detected, receptionQuality decreasing; then the
// virtual number.
function byPriority(one, other) {
    const rank = (entry) => (entry.detectedNow ? 0 : 2) + (entry.record.mainAvOverTheAir ? 0 : 1);
    const byRank = rank(one) - rank(other);
    if (byRank !== 0) {
        return byRank;
    }
    if (one.detectedNow) {
        const byQuality = other.record.receptionQuality - one.record.receptionQuality;
        if (byQuality !== 0) {
            return byQuality;
        }
    }
    return byVirtualNumber(one.record, other.record) || compareText(one.gsid, other.gsid);
}

// (majorChannelNo, minorChannelNo) increasing; without them, at the end.
function byVirtualNumber(one, other) {
    const major = numberOrLast(one.majorChannelNo) - numberOrLast(other.majorChannelNo);
    if (major !== 0) {
        return major;
    }
    return numberOrLast(one.minorChannelNo) - numberOrLast(other.minorChannelNo);
}

function numberOrLast(value) {
    return value === undefined ? Number.MAX_SAFE_INTEGER : value;
}

function compareText(one, other) {
    if (one < other) {
        return -1;
    }
    return one > other ? 1 : 0;
}

module.exports = { computeCatalog, catalogItems, orderCatalog, MAX_CATALOG };
