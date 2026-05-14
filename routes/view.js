const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const geoip = require('geoip-lite');
const File = require('../models/file');
const User = require('../models/user');
const Team = require('../models/team');
const LinkVisit = require('../models/linkVisit');
const FileRequest = require('../models/fileRequest');
const PaymentTransaction = require('../models/paymentTransaction');
const auth = require('../middleware/auth');
const { r2, GetObjectCommand, DeleteObjectCommand, getR2BucketName } = require('../utils/r2');
const { getBillingPricing } = require('../utils/billing');
const { getMidtransConfig, getSnapScriptUrl, hasMidtransConfig } = require('../utils/midtrans');

function getRequestOrigin(req) {
    return `${req.protocol}://${req.get('host')}`;
}

function escapeXml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

router.get('/', auth.checkAuthStatus, (req, res) => res.render('index'));

router.get('/login', auth.checkAuthStatus, (req, res) => 
    res.locals.isLoggedIn ? res.redirect('/dashboard') : res.render('login')
);

router.get('/register', auth.checkAuthStatus, (req, res) => 
    res.locals.isLoggedIn ? res.redirect('/dashboard') : res.render('register')
);

router.get('/logout', async (req, res) => {
    const refreshToken = req.cookies.refresh_token;
    if (refreshToken) {
        try {
            const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
            await User.updateOne({ _id: decoded.id }, { $pull: { sessions: { refreshToken } } });
        } catch(e) {}
    }
    res.clearCookie('token');
    res.clearCookie('refresh_token');
    res.clearCookie('temp_token');
    const cookies = req.cookies;
    for (const cookieName in cookies) {
        if (cookieName.startsWith('file_access_')) {
            res.clearCookie(cookieName);
        }
    }
    res.redirect('/login');
});

router.get('/profile', auth.protectView, (req, res) => {
    let currentDeviceId = '';
    const currentRefreshToken = req.cookies.refresh_token || '';

    if (currentRefreshToken) {
        try {
            const decoded = jwt.verify(currentRefreshToken, process.env.JWT_SECRET);
            currentDeviceId = decoded.deviceId || '';
        } catch (e) {}
    }

    res.render('profile', { currentDeviceId });
});

router.get('/docs', auth.checkAuthStatus, (req, res) => {
    res.render('docs');
});

router.get('/media/user/:userId/:assetType', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId).select('profilePhotoR2Key publicCoverR2Key branding.logoR2Key');
        if (!user) return res.status(404).send('Asset not found.');

        const assetMap = {
            'profile-photo': user.profilePhotoR2Key,
            'public-cover': user.publicCoverR2Key,
            'branding-logo': user.branding?.logoR2Key || ''
        };
        const r2Key = assetMap[req.params.assetType];
        if (!r2Key) return res.status(404).send('Asset not found.');

        const response = await r2.send(new GetObjectCommand({
            Bucket: getR2BucketName(),
            Key: r2Key
        }));

        if (response.ContentType) {
            res.setHeader('Content-Type', response.ContentType);
        }
        if (response.ContentLength !== undefined) {
            res.setHeader('Content-Length', response.ContentLength);
        }
        res.setHeader('Cache-Control', 'public, max-age=86400');
        response.Body.pipe(res);
    } catch (error) {
        console.error('User asset stream error:', error.message);
        res.status(500).send('Failed to load asset.');
    }
});

router.get('/u/:username', auth.checkAuthStatus, async (req, res) => {
    try {
        const targetUser = await User.findOne({ username: req.params.username, isPublicProfile: true });
        if (!targetUser) return res.status(404).render('404');
        
        const files = await File.find({ 
            owner: targetUser._id, 
            isHidden: false, 
            deletedAt: null, 
            isFolder: false 
        }).sort({ createdAt: -1 }).select('-base64 -password');

        const publicStats = {
            totalFiles: files.length,
            totalDownloads: files.reduce((sum, item) => sum + (item.downloads || 0), 0),
            totalSize: files.reduce((sum, item) => sum + (item.size || 0), 0)
        };
        
        res.render('public_profile', {
            targetUser,
            files,
            publicStats,
            publicDisplayTitle: targetUser.publicTitle || targetUser.branding?.pageTitle || `@${targetUser.username}`
        });
    } catch (e) { res.status(500).render('404'); }
});

router.get('/ref/:username/banner.svg', auth.checkAuthStatus, async (req, res) => {
    try {
        const referrer = await User.findOne({ username: req.params.username }).select('username referralCode referralCount branding profilePhotoUrl publicThemeColor');
        if (!referrer) return res.status(404).send('Referral banner not found.');

        const primary = escapeXml(referrer.branding?.primaryColor || referrer.publicThemeColor || '#1d4ed8');
        const username = escapeXml(referrer.username || 'user');
        const referralCode = escapeXml(referrer.referralCode || 'N/A');
        const referralCount = escapeXml(String(referrer.referralCount || 0));
        const profilePhotoUrl = typeof referrer.profilePhotoUrl === 'string' ? referrer.profilePhotoUrl.trim() : '';
        const encodedPhotoUrl = profilePhotoUrl ? escapeXml(profilePhotoUrl) : '';

        const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" fill="none">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop stop-color="#081226"/>
      <stop offset="0.58" stop-color="${primary}"/>
      <stop offset="1" stop-color="#F97316"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" rx="0" fill="url(#bg)"/>
  <circle cx="980" cy="120" r="150" fill="rgba(255,255,255,0.08)"/>
  <circle cx="180" cy="520" r="220" fill="rgba(255,255,255,0.08)"/>
  ${encodedPhotoUrl ? `<defs><clipPath id="avatarClip"><circle cx="1030" cy="425" r="84"/></clipPath></defs>` : ''}
  <text x="72" y="88" fill="white" font-size="34" font-weight="700" font-family="Arial, Helvetica, sans-serif">w upload referral</text>
  <text x="72" y="210" fill="white" font-size="72" font-weight="800" font-family="Arial, Helvetica, sans-serif">Gabung lewat @${username}</text>
  <text x="72" y="278" fill="rgba(255,255,255,0.88)" font-size="34" font-weight="500" font-family="Arial, Helvetica, sans-serif">Dapat bonus storage dan akses workspace yang lebih rapi.</text>
  <rect x="72" y="342" width="420" height="136" rx="24" fill="rgba(255,255,255,0.14)"/>
  <text x="108" y="390" fill="white" font-size="28" font-weight="600" font-family="Arial, Helvetica, sans-serif">Referral code</text>
  <text x="108" y="448" fill="white" font-size="48" font-weight="800" font-family="Arial, Helvetica, sans-serif">${referralCode}</text>
  <rect x="538" y="342" width="300" height="136" rx="24" fill="rgba(255,255,255,0.18)"/>
  <text x="574" y="390" fill="white" font-size="28" font-weight="600" font-family="Arial, Helvetica, sans-serif">Total referrals</text>
  <text x="574" y="448" fill="white" font-size="48" font-weight="800" font-family="Arial, Helvetica, sans-serif">${referralCount}</text>
  <circle cx="1030" cy="425" r="92" fill="rgba(255,255,255,0.18)"/>
  ${encodedPhotoUrl
            ? `<image href="${encodedPhotoUrl}" x="946" y="341" width="168" height="168" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>`
            : `<circle cx="1030" cy="425" r="84" fill="rgba(255,255,255,0.22)"/>
               <text x="1003" y="441" fill="white" font-size="58" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml((referrer.username || 'U').slice(0,1).toUpperCase())}</text>`}
  <rect x="72" y="532" width="330" height="10" rx="5" fill="#FEF3C7"/>
  <text x="72" y="580" fill="white" font-size="26" font-weight="600" font-family="Arial, Helvetica, sans-serif">Bonus 50 MB untuk referrer dan pengguna baru</text>
</svg>`;

        res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.send(svg);
    } catch (error) {
        res.status(500).send('Failed to generate referral banner.');
    }
});

router.get('/ref/:username', auth.checkAuthStatus, async (req, res) => {
    try {
        const referrer = await User.findOne({ username: req.params.username }).select('username referralCode referralCount publicBio branding plan');
        if (!referrer) return res.status(404).render('404');

        res.render('referral_landing', {
            referrer,
            referralRegisterUrl: `/register?ref=${encodeURIComponent(referrer.referralCode || '')}`,
            referralBannerUrl: `/ref/${encodeURIComponent(referrer.username)}/banner.svg`,
            originUrl: getRequestOrigin(req)
        });
    } catch (error) {
        res.status(500).render('404');
    }
});

router.get('/req/:slug', auth.checkAuthStatus, async (req, res) => {
    try {
        const request = await FileRequest.findOne({ slug: req.params.slug });
        if (!request) return res.status(404).send('Request not found or expired');
        res.render('file_request', { request });
    } catch (e) { res.status(500).send('Error'); }
});

router.get('/dashboard/teams', auth.protectView, async (req, res) => {
    try {
        const teams = await Team.find({ _id: { $in: req.user.teams } }).populate('members', 'username');
        res.render('teams', { teams });
    } catch (e) { res.status(500).send("Error fetching teams"); }
});

router.get('/dashboard/teams/:id', auth.protectView, async (req, res) => {
    try {
        const team = await Team.findOne({ _id: req.params.id, members: req.user.id }).populate('members', 'username');
        if (!team) return res.status(404).send('Team not found or you are not a member.');
        
        const teamMemberIds = team.members.map(m => m._id);
        const files = await File.find({ owner: { $in: teamMemberIds }, parentId: null, deletedAt: null }).populate('owner', 'username').sort({ isFolder: -1, createdAt: -1 });

        res.render('team_workspace', { team, files });
    } catch (e) {
        res.status(500).send("Error fetching team workspace");
    }
});

router.get('/dashboard/affiliate', auth.protectView, async (req, res) => {
    try {
        const referrals = await User.find({ referredBy: req.user.id }).select('username createdAt isVerified plan');
        res.render('affiliate', {
            referrals,
            referralLandingUrl: `${getRequestOrigin(req)}/ref/${req.user.username}`,
            referralBannerUrl: `/ref/${encodeURIComponent(req.user.username)}/banner.svg`
        });
    } catch (error) {
        res.status(500).send('Error loading affiliate dashboard.');
    }
});

router.get('/billing', auth.protectView, async (req, res) => {
    try {
        const { monthlyPrice, yearlyPrice } = getBillingPricing();
        const currentPlan = req.user.plan || 'free';
        const recentTransactions = await PaymentTransaction.find({ user: req.user.id })
            .sort({ createdAt: -1 })
            .limit(8)
            .select('orderId amount billingCycle status paymentMethod createdAt paidAt completedAt');
        const midtransConfig = getMidtransConfig();

        res.render('billing', {
            currentPlan,
            monthlyPrice,
            yearlyPrice,
            currentExpiry: req.user.subscriptionExpiresAt,
            recentTransactions,
            midtransEnabled: hasMidtransConfig(),
            midtransClientKey: midtransConfig.clientKey,
            midtransScriptUrl: getSnapScriptUrl()
        });
    } catch (error) {
        res.status(500).send('Error loading billing page.');
    }
});

router.post('/billing/upgrade', auth.protectView, async (req, res) => {
    res.status(410).json({
        message: 'Demo upgrade route has been retired. Use the real Midtrans checkout flow from /billing.'
    });
});

router.get('/dashboard', auth.protectView, async (req, res) => {
    try {
        const { q, sortBy, sortOrder, folderId, type, filter, tag } = req.query;
        let query = {};
        let currentFolder = null;
        let breadcrumbs = [];

        if (folderId) {
            currentFolder = await File.findOne({ 
                _id: folderId,
                $or: [{ owner: req.user.id }, { 'collaborators.user': req.user.id }]
            });

            if (!currentFolder) {
                return res.status(404).send("Folder not found or access denied.");
            }

            query = { parentId: folderId, deletedAt: null };

            let temp = currentFolder;
            while(temp) {
                breadcrumbs.unshift({ id: temp._id, name: temp.originalName });
                if(temp.parentId) temp = await File.findById(temp.parentId);
                else temp = null;
            }
        } else {
            if (filter === 'trash') {
                query = { owner: req.user.id, deletedAt: { $ne: null } };
            } else if (filter === 'shared') {
                query = { 'collaborators.user': req.user.id, deletedAt: null };
            } else if (filter === 'starred') {
                query = { owner: req.user.id, isStarred: true, deletedAt: null };
            } else {
                query = { 
                    owner: req.user.id,
                    parentId: null, 
                    deletedAt: null 
                };
            }
        }

        if (q) {
            const baseQuery = query;
            query = {
                ...baseQuery,
                $or: [
                    { originalName: { $regex: q, $options: 'i' } },
                    { tags: { $in: [q] } }
                ]
            };
        }

        if (type) {
            if (type === 'image') query.contentType = { $regex: '^image/' };
            else if (type === 'video') query.contentType = { $regex: '^video/' };
            else if (type === 'doc') query.contentType = { $regex: 'pdf|document|text' };
            else if (type === 'folder') query.isFolder = true;
        }

        if (tag) query.tags = tag;

        let sort = {};
        if (sortBy) sort[sortBy] = sortOrder === 'asc' ? 1 : -1;
        else sort = { isFolder: -1, createdAt: -1 };

        const files = await File.find(query).sort(sort).select('-base64 -versions.base64');
        
        const stats = await File.aggregate([
            { $match: { owner: req.user._id, deletedAt: null } },
            { $group: { _id: null, totalSize: { $sum: "$size" } } }
        ]);
        const currentUsage = stats.length > 0 ? stats[0].totalSize : 0;
        req.user.storageUsed = currentUsage;
        await req.user.save();

        const [ownedFiles, ownedFolders, sharedItems] = await Promise.all([
            File.countDocuments({ owner: req.user.id, deletedAt: null, isFolder: false }),
            File.countDocuments({ owner: req.user.id, deletedAt: null, isFolder: true }),
            File.countDocuments({ 'collaborators.user': req.user.id, deletedAt: null })
        ]);

        const dashboardStats = {
            ownedFiles,
            ownedFolders,
            sharedItems,
            totalDownloads: files.reduce((sum, item) => sum + (item.downloads || 0), 0),
            currentUsage
        };

        res.render('dashboard', { files, query: req.query, currentFolder, breadcrumbs, dashboardStats });
    } catch (error) {
        console.error(error);
        res.status(500).send("Error fetching user files.");
    }
});

router.get('/private/:linkId', auth.checkAuthStatus, async (req, res) => {
    try {
        const file = await File.findOne({ 'shareLinks.linkId': req.params.linkId }).select('customAlias shareLinks deletedAt');
        if (!file || file.deletedAt) return res.status(404).render('404');

        const link = file.shareLinks.find(item => item.linkId === req.params.linkId);
        if (!link) return res.status(404).render('404');
        if (link.expiresAt && link.expiresAt < new Date()) {
            return res.status(410).send('This private link has expired.');
        }

        res.redirect(`/w-upload/file/${encodeURIComponent(file.customAlias)}?share_id=${encodeURIComponent(req.params.linkId)}`);
    } catch (error) {
        res.status(500).render('404');
    }
});

router.get('/w-upload/file/:identifier', auth.checkAuthStatus, async (req, res) => {
    try {
        const file = await File.findOne({ customAlias: req.params.identifier })
            .populate('owner', 'username branding plan')
            .populate({
                path: 'comments.user',
                select: 'username'
            });
            
        if (!file || file.deletedAt) return res.status(404).render('404');
        
        const shareId = req.query.share_id;
        const hasOwnerAccess = !!(req.user && file.owner && file.owner._id && file.owner._id.equals(req.user._id));
        const hasCollaboratorAccess = !!(req.user && file.collaborators.some(c => c.user.equals(req.user._id)));
        let activeShareLink = null;
        if (shareId) {
            const link = file.shareLinks.find(link => link.linkId === shareId);
            if (!link) return res.status(403).send('This share link is invalid or has been revoked.');
            if (link.expiresAt && link.expiresAt < new Date()) return res.status(410).send('This share link has expired.');
            activeShareLink = link;
        }

        if (file.isHidden && !hasOwnerAccess && !hasCollaboratorAccess && !activeShareLink) {
            return res.status(403).send('This file is private. Use a private link or log in with access.');
        }

        const ip = req.ip || req.connection.remoteAddress;
        const geo = geoip.lookup(ip);
        
        // Simpan log kunjungan saat ini
        await new LinkVisit({
            file: file._id,
            shareLinkId: shareId || 'direct',
            ip,
            userAgent: req.headers['user-agent'],
            geo: geo ? { country: geo.country, city: geo.city } : undefined,
            type: 'view'
        }).save();
        
        // Hitung total kunjungan untuk file ini
        const totalViews = await LinkVisit.countDocuments({ file: file._id, type: 'view' });

        if (file.password) {
            const token = req.cookies[`file_access_${file._id}`];
            if (!token) return res.render('password_prompt', { file, hint: file.passwordHint, totalViews });
            try { jwt.verify(token, process.env.JWT_SECRET); } 
            catch (e) { return res.render('password_prompt', { file, hint: file.passwordHint, error: 'Session expired.', totalViews }); }
        }
        
        const downloadLink = file.isFolder ? `/api/files/${file._id}/zip` : `/w-upload/raw/${file.customAlias}${shareId ? '?share_id='+shareId : ''}`;
        const fileExtension = path.extname(file.originalName).toLowerCase();
        const isOwner = hasOwnerAccess;
        const isEditor = req.user && file.collaborators.some(c => c.user.equals(req.user._id) && c.role === 'editor');
        const canEdit = isOwner || isEditor;

        const renderOptions = {
            file,
            downloadLink,
            totalViews,
            isLoggedIn: res.locals.isLoggedIn
        };

        if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(fileExtension) && canEdit) {
            return res.render('editor_image', renderOptions);
        }
        if (fileExtension === '.pdf' && canEdit) {
            renderOptions.rawLink = downloadLink;
            return res.render('editor_pdf', renderOptions);
        }
        if (fileExtension === '.md' && canEdit) {
            renderOptions.rawLink = downloadLink;
            return res.render('editor_markdown', renderOptions);
        }
        if (['.js', '.css', '.html', '.py', '.java', '.c', '.cpp', '.xml', '.ts', '.jsx', '.json', '.sql', '.rb', '.go'].includes(fileExtension)) {
            renderOptions.rawLink = downloadLink;
            renderOptions.ext = fileExtension.substring(1);
            return res.render('viewer_code', renderOptions);
        }
        if (['.zip', '.rar'].includes(fileExtension)) {
             return res.render('viewer_archive', renderOptions);
        }

        res.render('download', renderOptions);
    } catch (error) {
        console.error(error);
        res.status(500).send("Server Error");
    }
});
router.post('/w-upload/file/:identifier/auth', async (req, res) => {
    const file = await File.findOne({ customAlias: req.params.identifier }).select('-base64');
    if (!file || !file.password) return res.redirect(`/w-upload/file/${req.params.identifier}`);
    
    const isMatch = await bcrypt.compare(req.body.password, file.password);
    if (isMatch) {
        const token = jwt.sign({ fileId: file._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.cookie(`file_access_${file._id}`, token, { httpOnly: true, maxAge: 3600000 });
        res.redirect(`/w-upload/file/${req.params.identifier}`);
    } else {
        res.render('password_prompt', { file, hint: file.passwordHint, error: 'Invalid password' });
    }
});

router.get('/w-upload/raw/:identifier', auth.checkAuthStatus, async (req, res) => {
    try {
        const file = await File.findOne({ customAlias: req.params.identifier });
        
        if (!file) return res.status(404).send('File not found in database.');
        if (file.deletedAt) return res.status(410).send('File has been deleted.');
        if (file.isFolder) return res.status(400).send('Cannot raw download a folder. Use zip.');

        const shareId = req.query.share_id;
        const hasOwnerAccess = !!(req.user && file.owner && file.owner.equals && file.owner.equals(req.user._id));
        const hasCollaboratorAccess = !!(req.user && file.collaborators.some(c => c.user.equals(req.user._id)));
        let activeShareLink = null;
        if (shareId) {
            const link = file.shareLinks.find(link => link.linkId === shareId);
            if (!link) return res.status(403).send('This share link is invalid or has been revoked.');
            if (link.expiresAt && link.expiresAt < new Date()) return res.status(410).send('This share link has expired.');
            activeShareLink = link;
        }

        if (file.isHidden && !hasOwnerAccess && !hasCollaboratorAccess && !activeShareLink) {
            return res.status(403).send('This file is private. Use the private link shared with you.');
        }

        if (file.expiresAt && file.expiresAt < new Date()) {
            file.deletedAt = new Date();
            await file.save();
            return res.status(410).send('Link has expired.');
        }

        if (file.downloadLimit !== undefined && file.downloadLimit <= 0) {
            file.deletedAt = new Date();
            await file.save();
            return res.status(410).send('Download limit reached.');
        }

        if (file.password) {
            const token = req.cookies[`file_access_${file._id}`];
            if (!token) return res.status(403).send('Password required.');
            try { jwt.verify(token, process.env.JWT_SECRET); } 
            catch (e) { return res.status(403).send('Access denied.'); }
        }
        
        const ip = req.ip || req.connection.remoteAddress;
        const geo = geoip.lookup(ip);
        await new LinkVisit({
            file: file._id,
            shareLinkId: shareId || 'direct',
            ip,
            userAgent: req.headers['user-agent'],
            geo: geo ? { country: geo.country, city: geo.city } : undefined,
            type: 'download'
        }).save();

        if (file.downloadLimit !== undefined) file.downloadLimit -= 1;
        file.downloads += 1;
        file.lastDownloadedAt = new Date();
        const today = new Date().setHours(0,0,0,0);
        const histIndex = file.downloadHistory.findIndex(h => new Date(h.date).getTime() === today);
        if(histIndex > -1) file.downloadHistory[histIndex].count++;
        else file.downloadHistory.push({ date: today, count: 1 });

        if (file.isBurnAfterRead) file.deletedAt = new Date();
        await file.save();

        if (file.storageType === 'r2' && file.r2Key) {
            try {
                const range = typeof req.headers.range === 'string' ? req.headers.range : '';
                const commandInput = {
                    Bucket: getR2BucketName(),
                    Key: file.r2Key
                };

                if (range) {
                    commandInput.Range = range;
                }

                const command = new GetObjectCommand(commandInput);
                
                const response = await r2.send(command);
                res.setHeader('Content-Type', file.contentType);
                res.setHeader('Content-Disposition', `inline; filename="${file.originalName}"`);
                res.setHeader('Accept-Ranges', 'bytes');

                if (range && response.ContentRange) {
                    res.status(206);
                    res.setHeader('Content-Range', response.ContentRange);
                    if (response.ContentLength !== undefined) {
                        res.setHeader('Content-Length', response.ContentLength);
                    }
                } else {
                    res.setHeader('Content-Length', file.size);
                }

                response.Body.pipe(res);

                if (file.isBurnAfterRead) {
                    await r2.send(new DeleteObjectCommand({ 
                        Bucket: getR2BucketName(), 
                        Key: file.r2Key 
                    }));
                }
            } catch (r2Error) {
                console.error("Cloudflare R2 Error:", r2Error);
                return res.status(500).send("Error retrieving file from Cloud Storage.");
            }
        } 
        else if (file.base64) {
            const fileBuffer = Buffer.from(file.base64.split(';base64,').pop(), 'base64');
            res.writeHead(200, {
                'Content-Type': file.contentType,
                'Content-Length': fileBuffer.length,
                'Content-Disposition': `inline; filename="${file.originalName}"`
            });
            res.end(fileBuffer);
        } 
        else {
            return res.status(500).send("File content corrupted or missing.");
        }
    } catch (error) {
        console.error("General Download Error:", error);
        res.status(500).send('Server Internal Error during download.');
    }
});

module.exports = router;
