// The only write point of the platform to Redis: each write is an FCALL to
// the "tv30" library (infra/redis/functions.lua), which checks the schema
// and writes atomically; a refusal is a TV30SCHEMA error, nothing written.
const redis = require('./redis-client');

// Refusal by the profile limit (maxMembers of users:index in the schema).
const PROFILE_LIMIT_REFUSAL = /^TV30SCHEMA tv30_profile_write: users:index limit of (\d+) profiles reached/;
const SCHEMA_REFUSAL = /^TV30SCHEMA /;

// users:index, user:{id} rewritten whole and services added to
// user:{id}:consent, in a single operation; a new id beyond the profile
// limit is refused.
function profileWrite(id, services, fields) {
    return fcall('tv30_profile_write', [id, services.length, ...services, ...fieldPairs(fields)]);
}

// Returns the profile limit of a refusal by the limit; for another
// failure, null.
function profileLimitOf(err) {
    const match = PROFILE_LIMIT_REFUSAL.exec((err && err.message) || '');
    return match ? Number(match[1]) : null;
}

// lastAccess only of a profile in users:index (no stray hash); true if
// written.
async function profileLastAccess(id, ms) {
    return Number(await fcall('tv30_profile_last_access', [id, ms])) === 1;
}

// Removal of the profile: users:index, user:{id}, user:{id}:consent and
// every user:{id}:broadcaster-attrs:* in a single operation. Returns the
// number of keys and members removed.
async function profileRemove(id) {
    return Number(await fcall('tv30_profile_remove', [id]));
}

// services:announced rewritten whole with the records of catalog, a Map
// globalServiceId -> record; an empty catalog deletes it.
function announcedServices(catalog) {
    const args = [];
    for (const [gsid, record] of catalog) {
        args.push(gsid, JSON.stringify(record));
    }
    return fcall('tv30_announced_services', args);
}

// session:current-user; empty for no current user.
function sessionUser(id) {
    return fcall('tv30_session_user', [id]);
}

// session:current-service with the fields of Table C.8 (serviceContextId,
// serviceName, serviceId) and session:current-service-id, in a single
// operation.
function sessionService(fields) {
    return fcall('tv30_session_service', fieldPairs(fields));
}

// No current service: session:current-service deleted and
// session:current-service-id empty.
function sessionServiceClear() {
    return fcall('tv30_session_service', []);
}

// Refusal of data outside the schema (nothing written): repeating does not
// change the result.
function isSchemaRefusal(err) {
    return SCHEMA_REFUSAL.test((err && err.message) || '');
}

// numkeys 0: the functions derive the keys from the arguments.
function fcall(name, args) {
    return redis.call('FCALL', name, 0, ...args.map(String));
}

function fieldPairs(fields) {
    return Object.keys(fields).sort().flatMap((key) => [key, String(fields[key])]);
}

module.exports = {
    profileWrite,
    profileLimitOf,
    profileLastAccess,
    profileRemove,
    announcedServices,
    sessionUser,
    sessionService,
    sessionServiceClear,
    isSchemaRefusal,
};
