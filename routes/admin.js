const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const os = require('os');
const User = require('../models/user');
const File = require('../models/file');
const SystemConfig = require('../models/systemConfig');
const PublicRequest = require('../models/publicRequest');
const auth = require('../middleware/auth');
const { applyPlanToUser, getPlanCatalog } = require('../utils/billing');

router.use(auth.protectView, auth.protectAdmin);

router.get('/', async (req, res) => {
    try {
        const userCount = await User.countDocuments();
        const fileCount = await File.countDocuments();
        const totalStorage = await File.aggregate([{ $group: { _id: null, total: { $sum: "$size" } } }]);
        const users = await User.find().sort({ createdAt: -1 }).limit(50);
        const topAffiliates = await User.find({ referralCount: { $gt: 0 } }).sort({ walletBalance: -1 }).limit(10);
        const config = await SystemConfig.getConfig();
        const publicRequests = await PublicRequest.find({ status: 'Pending' }).sort({ createdAt: -1 }).limit(20);

        const cpus = os.cpus();
        const serverStats = {
            platform: os.platform(),
            cpu: cpus && cpus.length > 0 ? cpus[0].model : 'Unknown',
            cores: cpus ? cpus.length : 1,
            memoryUsage: (1 - os.freemem() / os.totalmem()) * 100,
            uptime: os.uptime() / 3600, 
            load: os.loadavg() ? os.loadavg()[0] : 0
        };

        res.render('admin_dashboard', {
            userCount,
            fileCount,
            totalSize: totalStorage[0] ? totalStorage[0].total : 0,
            users,
            topAffiliates,
            config,
            serverStats,
            publicRequests
        });
    } catch (e) {
        res.status(500).send(`Admin Error: ${e.message}`);
    }
});

router.post('/config', async (req, res) => {
    try {
        const { maintenanceMode, globalAnnouncement, adsEnabled, adScript, adsTxtContent } = req.body;
        await SystemConfig.findOneAndUpdate({}, {
            maintenanceMode: maintenanceMode === 'on',
            globalAnnouncement,
            adsEnabled: adsEnabled === 'on',
            adScript,
            adsTxtContent
        }, { upsert: true });
        res.redirect('/admin');
    } catch (e) {
        res.status(500).send('Config Update Error');
    }
});

router.post('/users/:id/update', async (req, res) => {
    try {
        const { action, value } = req.body;
        const userId = req.params.id;

        if (action === 'ban') {
            await User.findByIdAndUpdate(userId, { isBanned: true, banReason: value || 'Violation' });
        } else if (action === 'unban') {
            await User.findByIdAndUpdate(userId, { isBanned: false, banReason: null });
        } else if (action === 'role') {
            await User.findByIdAndUpdate(userId, { role: value });
        } else if (action === 'verify') {
            await User.findByIdAndUpdate(userId, { isVerified: true });
        } else if (action === 'bandwidth') {
            await User.findByIdAndUpdate(userId, { bandwidthLimit: parseInt(value) || 0 });
        } else if (action === 'plan') {
            const user = await User.findById(userId);
            if (!user) return res.status(404).send('User not found');

            const plan = getPlanCatalog()[value] ? value : 'free';
            applyPlanToUser(user, plan);
            if (plan === 'pro') {
                user.subscriptionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            } else {
                user.subscriptionExpiresAt = null;
            }
            await user.save();
        }
        res.redirect('/admin');
    } catch (e) {
        res.status(500).send('Update User Error');
    }
});

router.post('/payout/:id', async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.params.id, { walletBalance: 0 });
        res.redirect('/admin');
    } catch (e) {
        res.status(500).send('Payout Error');
    }
});

router.get('/impersonate/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).send('User not found');

        const token = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.cookie('token', token, { httpOnly: true });
        res.redirect('/dashboard');
    } catch (e) {
        res.status(500).send('Impersonate Error');
    }
});

module.exports = router;
