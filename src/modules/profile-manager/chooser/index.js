const core = require('../../../core');
const ejs = require('ejs');
const express = require('express');
const path = require('path');
const { DEFAULT_AVATAR_SVG } = require('../avatar');
const service = require('./service');

const router = express.Router();

router.get('/', async (req, res) => {
    // The chooser runs WITHOUT an active service: clears the retained
    // aop/currentService. A Redis failure gives 404 {error:200}.
    await core.unsetCurrentService();
    await core.refreshUserData();

    const html = await ejs.renderFile(path.join(__dirname, 'view.ejs'),
        {
            cards: await service.cards(),
            basepath: core.GUI.profile_chooser,
            defaultAvatar: DEFAULT_AVATAR_SVG,
        });
    res.send(html);
});

router.get('/create', (req, res) => {
    core.setDisplayGui(core.GUI.profile_creator);
    res.status(200).send();
});

router.get('/select', async (req, res) => {
    if (req.query.id) {
        // Writes lastAccess; a Redis failure gives 404 {error:200}.
        await core.setCurrentUser(req.query.id);
        core.setDisplayGui(core.GUI.app_catalogue);
        res.status(200).send();
        return;
    }
    res.status(400).send();
});


module.exports = router;