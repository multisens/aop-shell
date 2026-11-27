// Creation and removal of profiles: views and backend of the platform itself
// (../service.js).
const ejs = require('ejs');
const express = require('express');
const path = require('path');
const core = require('../../../core');
const service = require('../service');
const { avatarList } = require('../avatar');
const router = express.Router();

router.get('/create', async (req, res) => {
    const html = await ejs.renderFile(path.join(__dirname, 'view.ejs'), {
        avatars: await avatarList(),
    });
    res.send(html);
});

// Only a validation error answers 400 {error: message}; a storage failure is
// thrown and becomes 404 {error:200} (platformErrorHandler).
router.post('/create', async (req, res) => {
    let result;
    try {
        result = await service.createProfile(req.body || {});
    } catch (err) {
        if (err instanceof service.ValidationError) {
            res.status(400).json({ error: err.message });
            return;
        }
        throw err;
    }
    await core.refreshUserData();
    res.status(201).json(result);
});

// Removal by the viewer, from the profile choice screen; the same error
// contract as the creation.
router.post('/remove', async (req, res) => {
    const id = String((req.body && req.body.id) || '');
    try {
        await service.removeProfile(id);
    } catch (err) {
        if (err instanceof service.ValidationError) {
            res.status(400).json({ error: err.message });
            return;
        }
        throw err;
    }
    await core.profileRemoved(id);
    res.status(200).json({ id });
});

module.exports = router;
