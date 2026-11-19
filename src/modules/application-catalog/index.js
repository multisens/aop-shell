const core = require('../../core');
const ejs = require('ejs');
const express = require('express');
const path = require('path');
const service = require('./service');

const router = express.Router();

// A Redis failure gives 404 {error:200}.
router.get('/', async (req, res) => {
    const html = await ejs.renderFile(path.join(__dirname, 'view.ejs'), {
        cards: await service.cards(),
        profile: service.profile(),
        basepath: core.GUI.app_catalogue,
    });
    res.send(html);
});

router.get('/profile', (req, res) => {
    core.setDisplayGui(core.GUI.profile_chooser);
    res.status(200).send();
});

// The initialMediaURL parameter, if given, goes on to the Bootstrap
// Application (BpAFR-11), which checks it.
router.get('/select', async (req, res) => {
    const initialMediaURL = req.query.initialMediaURL;
    if (!req.query.id || (initialMediaURL !== undefined && typeof initialMediaURL !== 'string')) {
        res.status(400).send();
        return;
    }
    await core.setCurrentService(req.query.id);
    core.setDisplayGui(bootstrapAddress(initialMediaURL));
    res.status(200).send();
});

function bootstrapAddress(initialMediaURL) {
    if (initialMediaURL === undefined) {
        return core.GUI.bootstrap_app;
    }
    return `${core.GUI.bootstrap_app}?initialMediaURL=${encodeURIComponent(initialMediaURL)}`;
}

module.exports = router;