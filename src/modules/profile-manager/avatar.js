// The avatar set in Redis (avatar:{name}) and its display. The avatar field
// of the profile is the name of an image of the set (Table 7: "Path
// indicating the file with the graphical representation of the viewer
// profile").
const redis = require('../../redis-client');
const { svgDataUri, imageHtml } = require('../../html');

const AVATAR_KEY_PREFIX = 'avatar:';
const SVG_TYPE = 'image/svg+xml';
const SCAN_COUNT = 100;

// The icon of a profile without an avatar.
const DEFAULT_AVATAR_SVG =
    '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="100" height="100" rx="30" fill="#4d7c5b"/>' +
        '<circle cx="50" cy="40" r="14" fill="none" stroke="#ffffff" stroke-width="5"/>' +
        '<path d="M 14 90 a 36 36 0 0 1 72 0" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/>' +
    '</svg>';

function avatarKey(name) {
    return AVATAR_KEY_PREFIX + name;
}

// The images of the set, ordered by label: { name, label, svg }.
async function avatarList() {
    const names = [];
    let cursor = '0';
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${AVATAR_KEY_PREFIX}*`, 'COUNT', SCAN_COUNT);
        cursor = next;
        for (const key of keys) {
            names.push(key.slice(AVATAR_KEY_PREFIX.length));
        }
    } while (cursor !== '0');

    const avatars = [];
    for (const name of names) {
        const image = await redis.hgetall(avatarKey(name));
        avatars.push({ name, label: image.label, svg: image.body });
    }
    avatars.sort((a, b) => a.label.localeCompare(b.label));
    return avatars;
}

async function avatarExists(name) {
    const exists = await redis.exists(avatarKey(name));
    return exists === 1;
}

// <img class="avatar"> with the image of the set as a data: URL; without an
// avatar, with a name outside the set or with an SVG refused by svgDataUri,
// the default icon. Embedded, not served by a route of the AoP: a route
// would serve the avatar of any profile without the restriction of Table
// C.75, and the SVG opened as a document would run script on the origin of
// the TV page.
async function avatarHtml(name) {
    let src = '';
    if (name) {
        const image = await redis.hgetall(avatarKey(name));
        if (image.type === SVG_TYPE) {
            src = svgDataUri(image.body);
        }
    }
    if (src === '') {
        src = svgDataUri(DEFAULT_AVATAR_SVG);
    }
    return imageHtml(src, { class: 'avatar', alt: '' });
}

module.exports = { DEFAULT_AVATAR_SVG, avatarList, avatarExists, avatarHtml };
