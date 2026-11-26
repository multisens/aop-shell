const core = require('../../core');
const catalog = require('./catalog');
const { avatarHtml } = require('../profile-manager/avatar');
// appName, appIcon and globalServiceId (BAM of the broadcaster) and nickname
// (POST /profile/create) are escaped: the view shows this HTML with <%- %>.
const { escapeHtml, svgImageHtml } = require('../../html');

const CARDS_PER_LINE = 4;

// The items of the Application Catalog; a grouping is shown by the BAM of
// its member of lowest virtual number. A Redis failure rejects.
async function cards() {
    const items = await catalog.items();
    const count = items.length;

    let html = '';
    items.forEach((item, i) => {
        html += cardHtml(item, i, count);
    });
    return html;
}

async function profile() {
    const user = core.getUserData(core.getCurrentUser());
    return `<span>${escapeHtml(user.name || '')}</span>${await avatarHtml(user.avatar)}`;
}

// The card i of count, with the navigation to its neighbors; a grouping
// card has the class grouping and the number of members.
function cardHtml(item, i, count) {
    const bam = item.record.bam;
    let move = `moveleft="${i % CARDS_PER_LINE === 0 ? 'menumenu' : `card${i - 1}`}"`;
    if (i % CARDS_PER_LINE !== CARDS_PER_LINE - 1 && i + 1 < count) {
        move += ` moveright="card${i + 1}"`;
    }
    if (i < CARDS_PER_LINE) {
        move += ' moveup="profile"';
    } else {
        move += ` moveup="card${i - CARDS_PER_LINE}"`;
    }
    if (i + CARDS_PER_LINE <= count) {
        move += ` movedown="card${i + CARDS_PER_LINE}"`;
    }
    const icon = svgImageHtml(bam.appIcon, { alt: '' }, `appIcon do BAM de ${bam.globalServiceId}`);
    const grouping = item.members ? ` grouping" data-members="${item.members.length}` : '';
    return `<div id="card${i}" class="card${grouping}" ${move} select="selectService" `
        + `selectParam="${escapeHtml(bam.globalServiceId)}">`
        + `<span>${escapeHtml(bam.appName)}</span>`
        + `<div class="logo">${icon}</div>`
        + '</div>';
}

module.exports = {
    cards,
    profile,
};
