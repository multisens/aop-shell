// Profile manager of the platform. Writes through the Redis functions, which
// check Table 7; the validation here answers 400 to the screen, and a
// refusal of the function, except that of the profile limit, is a defect:
// 404 {error:200}.
const crypto = require('crypto');
const redis = require('../../redis-client');
const redisFunctions = require('../../redis-functions');
const avatars = require('./avatar');

// Error of the sent data (400 with the message). A storage failure is NOT a
// ValidationError: it is thrown and becomes 404 {error:200}.
class ValidationError extends Error {}

const VALID_RATINGS = ['L', '10', '12', '14', '16', '18'];
const VALID_SIDES = ['left', 'right'];

const LANGUAGE_FIELDS = ['audioLanguage', 'userInterfaceLanguage', 'closedCaptioningLanguage'];
// Visibility per service: the id of the service, as in aop/currentService
// (at most 256 characters).
const MAX_SERVICE_ID = 256;

// Unique in the receiver: the default profile is created only with an empty
// base.
const DEFAULT_NICKNAME = 'Viewer 1';

// The check of the set and the write, for the default profile and the
// removal, one at a time in this process (inSeries).
let queue = Promise.resolve();

// Table 7 (basic attributes of the viewer profile).
function validateProfile(userData) {
    const nickname = String(userData.nickname || userData.name || '').trim();
    if (!nickname) {
        throw new ValidationError('nickname é obrigatório');
    }
    if (nickname.length > 20) {
        throw new ValidationError('nickname deve ter no máximo 20 caracteres');
    }

    const parentalControl = !!userData.parentalControl;
    if (parentalControl && !userData.maxContentRating) {
        throw new ValidationError('maxContentRating é obrigatório quando parentalControl = true');
    }
    if (userData.maxContentRating && !VALID_RATINGS.includes(userData.maxContentRating)) {
        throw new ValidationError(`maxContentRating deve ser um de: ${VALID_RATINGS.join(', ')}`);
    }

    const closedSigning = !!userData.closedSigning;
    if (closedSigning) {
        if (userData.closedSigningWidth !== undefined) {
            const w = parseInt(userData.closedSigningWidth);
            if (isNaN(w) || w < 14 || w > 28) {
                throw new ValidationError('closedSigningWidth deve estar entre 14 e 28');
            }
        }
        if (userData.closedSigningSide && !VALID_SIDES.includes(userData.closedSigningSide)) {
            throw new ValidationError('closedSigningSide deve ser "left" ou "right"');
        }
    }

    // What the Redis schema also checks and the form does not limit.
    for (const f of LANGUAGE_FIELDS) {
        // The caption one is written only with closedCaptioning on
        // (createProfile).
        if (f === 'closedCaptioningLanguage' && !userData.closedCaptioning) {
            continue;
        }
        if (userData[f] !== undefined && userData[f] !== '' && !isLanguageTag(userData[f])) {
            throw new ValidationError(`${f} deve ser uma etiqueta de idioma IETF RFC 5646, como pt-BR`);
        }
    }
    if (userData.accessConsent !== undefined) {
        const ok = Array.isArray(userData.accessConsent) && userData.accessConsent.every(
            s => typeof s === 'string' && s.length > 0 && [...s].length <= MAX_SERVICE_ID);
        if (!ok) {
            throw new ValidationError(`accessConsent deve ser uma lista de ids de serviço (texto de 1 a ${MAX_SERVICE_ID} caracteres)`);
        }
    }
    return nickname;
}

// Writes lastAccess only of a profile in users:index (check and write are
// atomic in the function): no ghost hash, and a profile removed in between
// is not recreated.
async function touchLastAccess(id, now = Date.now()) {
    if (!id) {
        return false;
    }
    return redisFunctions.profileLastAccess(String(id), String(now));
}

// The avatar of the form: absent, or the name of an image of the set.
async function validAvatar(name) {
    if (name === undefined || name === null || name === '') {
        return undefined;
    }
    if (typeof name !== 'string' || !(await avatars.avatarExists(name))) {
        throw new ValidationError('avatar deve ser uma das imagens do conjunto de avatares');
    }
    return name;
}

// 10.3.3: at most five profiles, checked by the Redis function that writes
// (users:index in the schema); the sixth is refused and none is evicted.
async function createProfile(userData) {
    const nickname = validateProfile(userData);

    // Table 7: id "UUID string"; randomUUID generates version 4 of RFC 9562 in
    // lowercase, the format the Redis schema requires.
    const userId = crypto.randomUUID();
    const parentalControl = !!userData.parentalControl;
    const closedCaptioning = !!userData.closedCaptioning;
    const closedSigning = !!userData.closedSigning;

    // The current service, if any, is added to the visibility
    // (accessConsent) of the new profile.
    const currentService = (await redis.get('session:current-service-id')) || '';
    const accessConsent = Array.isArray(userData.accessConsent) ? userData.accessConsent.slice() : [];
    if (currentService && !accessConsent.includes(currentService)) {
        accessConsent.push(currentService);
    }

    // The avatar is the name of an image of the set (./avatar.js); absent,
    // the profile has no avatar.
    const avatar = await validAvatar(userData.avatar);
    const newUser = {
        id: userId,
        nickname,
        avatar,
        parentalControl,
        maxContentRating: parentalControl ? userData.maxContentRating : null,
        audioLanguage: userData.audioLanguage || 'pt-BR',
        closedCaptioningLanguage: closedCaptioning ? (userData.closedCaptioningLanguage || 'pt-BR') : null,
        userInterfaceLanguage: userData.userInterfaceLanguage || 'pt-BR',
        closedCaptioning,
        closedSigning,
        closedSigningSide: closedSigning ? (userData.closedSigningSide || 'right') : null,
        closedSigningWidth: closedSigning ? (userData.closedSigningWidth ? parseInt(userData.closedSigningWidth) : 28) : null,
        audioDescription: !!userData.audioDescription,
        dialogEnhancement: !!userData.dialogEnhancement,
        voiceGuidance: !!userData.voiceGuidance,
        lastAccess: Date.now(),
    };

    const hashFields = {};
    for (const [k, v] of Object.entries(newUser)) {
        if (v !== null && v !== undefined) {
            hashFields[k] = String(v);
        }
    }
    try {
        await redisFunctions.profileWrite(userId, accessConsent, hashFields);
    } catch (err) {
        const limit = redisFunctions.profileLimitOf(err);
        if (limit !== null) {
            throw new ValidationError(`O limite de ${limit} perfis foi atingido. O perfil não foi criado.`);
        }
        throw err;
    }

    return { user: { ...newUser, accessConsent } };
}

// Base without profiles: a default profile with the defaults of Table 7
// (optional and conditional attributes absent) and no visibility; null if
// there was already a profile.
function ensureDefaultProfile() {
    return inSeries(async () => {
        if ((await redis.smembers('users:index')).length > 0) {
            return null;
        }
        const id = crypto.randomUUID();
        const fields = {
            id,
            nickname: DEFAULT_NICKNAME,
            parentalControl: 'false',
            closedCaptioning: 'false',
            closedSigning: 'false',
            audioDescription: 'false',
            dialogEnhancement: 'false',
            voiceGuidance: 'false',
            lastAccess: String(Date.now()),
        };
        await redisFunctions.profileWrite(id, [], fields);
        return { id, nickname: DEFAULT_NICKNAME };
    });
}

// Removal by the viewer; messages in the language of the profile choice
// screen.
function removeProfile(id) {
    return inSeries(async () => {
        const ids = await redis.smembers('users:index');
        if (!id || !ids.includes(id)) {
            throw new ValidationError('This profile no longer exists.');
        }
        if (ids.length < 2) {
            throw new ValidationError('The only registered profile cannot be removed.');
        }

        await redisFunctions.profileRemove(id);
        return { id };
    });
}

// Table 7: languages in IETF RFC 5646. The same format check as the Redis
// function (languageOk in infra/redis/functions.lua): subtags of 1 to 8 letters
// or digits separated by '-', the first one letters only (2 to 8) or the
// singleton x/i. The IANA registry is not checked.
function isLanguageTag(v) {
    if (typeof v !== 'string') {
        return false;
    }
    const parts = v.split('-');
    if (!parts.every(p => /^[A-Za-z0-9]{1,8}$/.test(p))) {
        return false;
    }
    return /^[A-Za-z]{2,8}$/.test(parts[0]) || parts[0] === 'x' || parts[0] === 'i';
}
// Runs fn after the operations already in the queue; a failure of fn does
// not stop the next ones.
function inSeries(fn) {
    const result = runAfter(queue, fn);
    queue = result.catch(() => undefined);
    return result;
}

async function runAfter(previous, fn) {
    await previous;
    return fn();
}

module.exports = { createProfile, ensureDefaultProfile, removeProfile, touchLastAccess, ValidationError };
