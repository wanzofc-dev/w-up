const mongoose = require('mongoose');
const User = require('../models/user');
const File = require('../models/file');
const Team = require('../models/team');
const AiLog = require('../models/aiLog');
const AiInsight = require('../models/aiInsight');
const FileRequest = require('../models/fileRequest');
const LinkVisit = require('../models/linkVisit');
const PaymentTransaction = require('../models/paymentTransaction');
const PublicRequest = require('../models/publicRequest');
const SystemConfig = require('../models/systemConfig');
const UploadSession = require('../models/uploadSession');
const { getUserStorageSnapshot } = require('../utils/storage');

const readOnlyConn = mongoose.createConnection(process.env.MONGO_URI);

const AI_SCHEMA_MAP = {
    User: 'username, email, role, plan, storageUsed, storageLimit, storageBonus, isVerified, sessions, failedLogins, createdAt',
    File: 'originalName, size, contentType, downloads, virusScan, isHidden, password, tags, deletedAt, createdAt',
    Team: 'name, members, storageQuota, usedStorage, createdAt',
    AiInsight: 'kind, title, summary, severity, metadata, deliveredAt, createdAt',
    AiLog: 'query, response, feedback, ip, timestamp',
    FileRequest: 'slug, label, destinationFolder, expiresAt, createdAt',
    LinkVisit: 'file, shareLinkId, ip, userAgent, geo, type, timestamp',
    PaymentTransaction: 'orderId, billingCycle, amount, status, paymentMethod, paidAt, createdAt',
    PublicRequest: 'requestType, contactEmail, details, status, createdAt',
    SystemConfig: 'maintenanceMode, globalAnnouncement, adsEnabled, updatedAt',
    UploadSession: 'filename, contentType, totalSize, uploadedSize, createdAt'
};

const privacyFilter = (data) => {
    if (!data) return null;
    const obj = data.toObject ? data.toObject() : data;
    const { password, twoFactorSecret, apiKeys, __v, sessions, ...safeData } = obj;
    return safeData;
};

const getUserProfile = async (userId) => {
    const user = await User.findById(userId).select('-password -twoFactorSecret -apiKeys');
    return privacyFilter(user);
};

const getStorageStats = async (userId) => {
    const user = await User.findById(userId);
    const storage = await getUserStorageSnapshot(userId);
    return {
        files: storage.fileCount,
        used: (storage.used / 1024 / 1024).toFixed(2) + ' MB',
        limit: (storage.total / 1024 / 1024 / 1024).toFixed(2) + ' GB',
        available: (storage.available / 1024 / 1024 / 1024).toFixed(2) + ' GB',
        percentage: storage.percentage.toFixed(1) + '%',
        plan: user.plan
    };
};

const getWorkspaceIntelligence = async (userId) => {
    const user = await User.findById(userId).select('-password -twoFactorSecret -apiKeys');
    if (!user) return null;

    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
        storage,
        fileCounts,
        requestCounts,
        totalVisits,
        recentInsights,
        recentAiLogs,
        paymentSummary,
        uploadSessions,
        systemConfig
    ] = await Promise.all([
        getUserStorageSnapshot(userId),
        Promise.all([
            File.countDocuments({ owner: userId, deletedAt: null, isFolder: false }),
            File.countDocuments({ owner: userId, deletedAt: null, isFolder: true }),
            File.countDocuments({ owner: userId, deletedAt: { $ne: null } }),
            File.countDocuments({ owner: userId, deletedAt: null, isHidden: false, password: { $in: [null, ''] } }),
            File.countDocuments({ owner: userId, deletedAt: null, 'virusScan.status': 'infected' }),
            File.countDocuments({
                owner: userId,
                deletedAt: null,
                $or: [
                    { virusScan: { $exists: false } },
                    { 'virusScan.status': { $in: ['unscanned', null] } }
                ]
            })
        ]),
        Promise.all([
            FileRequest.countDocuments({ owner: userId }),
            PublicRequest.countDocuments({ status: { $in: ['Pending', 'In Progress'] } })
        ]),
        LinkVisit.aggregate([
            {
                $lookup: {
                    from: 'files',
                    localField: 'file',
                    foreignField: '_id',
                    as: 'fileDoc'
                }
            },
            { $unwind: '$fileDoc' },
            {
                $match: {
                    timestamp: { $gte: weekAgo },
                    'fileDoc.owner': user._id
                }
            },
            { $count: 'total' }
        ]),
        AiInsight.find({ user: userId }).sort({ createdAt: -1 }).limit(3).lean(),
        AiLog.find({ user: userId }).sort({ timestamp: -1 }).limit(3).lean(),
        Promise.all([
            PaymentTransaction.countDocuments({ user: userId, status: 'paid' }),
            PaymentTransaction.countDocuments({ user: userId, status: 'pending' })
        ]),
        UploadSession.find({ owner: userId }).sort({ createdAt: -1 }).limit(5).lean(),
        SystemConfig.getConfig()
    ]);

    const [ownedFiles, ownedFolders, trashedFiles, publicUnprotectedFiles, infectedFiles, unscannedFiles] = fileCounts;
    const [fileRequestCount, openPublicRequests] = requestCounts;
    const [paidTransactions, pendingTransactions] = paymentSummary;
    const ownedVisitCount = Number(totalVisits?.[0]?.total || 0);

    return {
        collections: {
            aiinsights: await AiInsight.countDocuments({ user: userId }),
            ailogs: await AiLog.countDocuments({ user: userId }),
            filerequests: fileRequestCount,
            files: ownedFiles,
            folders: ownedFolders,
            trashedFiles,
            linkvisits7d: ownedVisitCount,
            paymenttransactions: paidTransactions + pendingTransactions,
            publicrequestsOpen: openPublicRequests,
            systemconfigs: systemConfig ? 1 : 0,
            teams: Array.isArray(user.teams) ? user.teams.length : 0,
            uploadsessionsActive: uploadSessions.length,
            usersVisibleToAssistant: 1
        },
        storage,
        recentInsights: recentInsights.map(item => ({
            title: item.title,
            severity: item.severity,
            summary: item.summary
        })),
        recentAiLogs: recentAiLogs.map(item => ({
            query: item.query,
            feedback: item.feedback,
            timestamp: item.timestamp
        })),
        security: {
            failedLoginAttempts24h: (user.failedLogins || []).filter(item => item.date && item.date >= dayAgo).length,
            activeSessions: Array.isArray(user.sessions) ? user.sessions.length : 0,
            publicUnprotectedFiles,
            infectedFiles,
            unscannedFiles,
            maintenanceMode: Boolean(systemConfig?.maintenanceMode),
            adsEnabled: Boolean(systemConfig?.adsEnabled),
            webhookEnabled: Boolean(user.webhook?.isActive),
            twoFactorEnabled: Boolean(user.isTwoFactorEnabled),
            verifiedAccount: Boolean(user.isVerified)
        }
    };
};

const searchUsers = async (query, requesterRole) => {
    if (requesterRole !== 'admin') return "Access Denied: Admin privileges required to search users.";
    
    const users = await User.find({ 
        $or: [{ username: { $regex: query, $options: 'i' } }, { email: { $regex: query, $options: 'i' } }] 
    }).limit(5).select('username email role plan isVerified');
    
    return users.length ? users.map(u => `${u.username} (${u.role}) - ${u.plan}`).join('\n') : "No users found.";
};

const getTeamData = async (userId) => {
    const user = await User.findById(userId);
    const teams = await Team.find({ _id: { $in: user.teams } }).populate('members', 'username email');
    
    if (!teams.length) return "You are not in any team.";
    
    return teams.map(t => {
        const members = t.members.map(m => m.username).join(', ');
        return `Team: ${t.name}\nMembers: ${members}\nStorage: ${(t.usedStorage/1024/1024).toFixed(2)} MB`;
    }).join('\n\n');
};

const getActivityLog = async (userId) => {
    const user = await User.findById(userId);
    if (!user.loginHistory || user.loginHistory.length === 0) return "No activity logs found.";
    
    return user.loginHistory.slice(0, 5).map(log => 
        `- ${new Date(log.date).toLocaleString()}: IP ${log.ip} (${log.os})`
    ).join('\n');
};

module.exports = {
    readOnlyConn,
    AI_SCHEMA_MAP,
    privacyFilter,
    getUserProfile,
    getStorageStats,
    getWorkspaceIntelligence,
    searchUsers,
    getTeamData,
    getActivityLog
};
