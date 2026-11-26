const core = require('../../../core');
const { avatarHtml } = require('../avatar');
// nickname and id come from POST /profile/create and are escaped: the view
// shows this HTML with <%- %>.
const { escapeHtml } = require('../../../html');

const NEW_CARD = 'new';
const NEW_AVATAR_SVG =
    '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="100" height="100" rx="30" fill="#2a2a5a"/>' +
        '<line x1="30" y1="50" x2="70" y2="50" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/>' +
        '<line x1="50" y1="30" x2="50" y2="70" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/>' +
    '</svg>';

// The cards of the registered profiles and the card of a new profile, with
// the navigation between them.
async function cards() {
    const users = core.getUserList();
    const count = users.length;
    // The only registered profile cannot be removed: no option.
    const removable = count > 1;

    let html = '';
    for (let i = 0; i < count; i++) {
        html += await profileCardHtml(users[i], i, count, removable);
    }

    let move = '';
    if (count > 0) {
        move = `moveleft="card${count - 1}" moveright="card0"`;
    }
    html += `<div id="card${NEW_CARD}" class="card focused" ${move} select="createProfile">` +
        NEW_AVATAR_SVG +
        '<span>Create new<br/>profile</span>' +
        '</div>';
    return html;
}

// The card i of count; with removable, the option to remove it below.
async function profileCardHtml(user, i, count, removable) {
    const left = i - 1 >= 0 ? `card${i - 1}` : `card${NEW_CARD}`;
    const right = i + 1 < count ? `card${i + 1}` : `card${NEW_CARD}`;
    const id = escapeHtml(user.id);

    let down = '';
    let remove = '';
    if (removable) {
        const removeLeft = `remove${(i + count - 1) % count}`;
        const removeRight = `remove${(i + 1) % count}`;
        down = ` movedown="remove${i}"`;
        remove = `<div id="remove${i}" class="remove" moveup="card${i}" moveleft="${removeLeft}" ` +
            `moveright="${removeRight}" select="confirmRemoval" selectParam="${id}">Remove</div>`;
    }

    return `<div id="card${i}" class="card" moveleft="${left}" moveright="${right}"${down} ` +
        `select="selectProfile" selectParam="${id}">` +
        await avatarHtml(user.avatar) +
        `<span>${escapeHtml(user.name)}</span>` +
        remove +
        '</div>';
}

module.exports = { cards };
