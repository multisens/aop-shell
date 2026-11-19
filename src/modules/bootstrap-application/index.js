const ejs = require('ejs');
const express = require('express');
const path = require('path');
const core = require('../../core');
const logger = require('../../logger');
const service = require('./service');

const router = express.Router();

// initialMediaURL (BpAFR-11) out of its form: 400, and nothing changes.
router.get('/', async (req, res) => {
    let initialMediaURL;
    try {
        initialMediaURL = service.initialMediaParameter(req.query.initialMediaURL);
    } catch (err) {
        logger.error(`[bootstrap] ${err.message}`);
        res.status(400).type('text/plain').send(err.message);
        return;
    }
    service.openBootstrapApp(req.query.mode, initialMediaURL);

    const html = await ejs.renderFile(path.join(__dirname, 'view.ejs'),
        Object.assign({
            profile: service.profile(),
            basepath: core.GUI.bootstrap_app
        },
        service.bootstrapAppData(),
        service.esgData()
    ));
    res.send(html);
});

router.get('/profile', (req, res) => {
    service.closeBootstrapApp(core.GUI.profile_chooser);
    res.status(200).send();
});

router.get('/appcat', (req, res) => {
    service.closeBootstrapApp(core.GUI.app_catalogue);
    res.status(200).send();
});

router.get('/fullscr', (req, res) => {
    service.fullscreen();
    res.status(200).send();
});

module.exports = router;