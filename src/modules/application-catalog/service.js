const core = require('../../core');
const lls = require('../transport-layer-metadata-lls');
const { avatarHtml } = require('../profile-manager/avatar');
// appName, appIcon and globalServiceId (BAM of the broadcaster) and nickname
// (POST /profile/create) are escaped: the view shows this HTML with <%- %>.
const { escapeHtml, svgImageHtml } = require('../../html');

const CARDS_PER_LINE = 4;

// The announced services; a Redis failure rejects.
async function cards() {
    const services = await lls.services();
    const count = services.length;

    let html = '';
    services.forEach((service, i) => {
        html += cardHtml(service.bam, i, count);
    });
    return html;
}

function profile() {
    const user = core.getUserData(core.getCurrentUser());
    return `<span>${escapeHtml(user.name || '')}</span>${avatarHtml(user.avatar)}`;
}

// The card i of count, with the navigation to its neighbors.
function cardHtml(bam, i, count) {
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
        move += ` movedown="app${i + CARDS_PER_LINE}"`;
    }
    const icon = svgImageHtml(bam.appIcon, { alt: '' }, `appIcon do BAM de ${bam.globalServiceId}`);
    return `<div id="card${i}" class="card" ${move} select="selectService" `
        + `selectParam="${escapeHtml(bam.globalServiceId)}">`
        + `<span>${escapeHtml(bam.appName)}</span>`
        + `<div class="logo">${icon}</div>`
        + '</div>';
}

module.exports = {
    cards,
    profile,
};
