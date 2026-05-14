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

function formatStorageAmount(bytes = 0) {
    const value = Number(bytes || 0);
    if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`;
    return `${value.toFixed(0)} B`;
}

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
        used: formatStorageAmount(storage.used),
        limit: formatStorageAmount(storage.total),
        available: formatStorageAmount(storage.available),
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

const getSecuritySeverity = (security) => {
    if (!security) {
        return { level: 'unknown', label: 'UNKNOWN', summary: 'Data keamanan belum lengkap.' };
    }

    if (
        security.infectedFiles > 0 ||
        security.failedLoginAttempts24h >= 5 ||
        (security.publicUnprotectedFiles > 0 && !security.twoFactorEnabled)
    ) {
        return {
            level: 'critical',
            label: 'CRITICAL',
            summary: 'Ada risiko tinggi yang perlu ditangani segera sebelum file atau akun disalahgunakan.'
        };
    }

    if (
        security.publicUnprotectedFiles > 0 ||
        security.unscannedFiles > 0 ||
        !security.twoFactorEnabled ||
        security.activeSessions > 3
    ) {
        return {
            level: 'warning',
            label: 'WARNING',
            summary: 'Ada beberapa titik lemah yang belum darurat, tetapi cukup penting untuk segera dirapikan.'
        };
    }

    return {
        level: 'safe',
        label: 'SAFE',
        summary: 'Tidak ada indikator risiko besar yang menonjol saat ini.'
    };
};

const formatWorkspaceSecurityReport = (intel) => {
    if (!intel) return 'Data keamanan workspace belum tersedia.';

    const severity = getSecuritySeverity(intel.security);
    const risks = [];
    if (intel.security.failedLoginAttempts24h > 0) risks.push(`Terdapat **${intel.security.failedLoginAttempts24h}** percobaan login gagal dalam 24 jam terakhir.`);
    if (intel.security.unscannedFiles > 0) risks.push(`Ada **${intel.security.unscannedFiles}** file yang belum discan malware.`);
    if (intel.security.infectedFiles > 0) risks.push(`Ada **${intel.security.infectedFiles}** file yang ditandai terinfeksi.`);
    if (intel.security.publicUnprotectedFiles > 0) risks.push(`Ada **${intel.security.publicUnprotectedFiles}** file publik tanpa proteksi password.`);
    if (!intel.security.twoFactorEnabled) risks.push('2FA belum aktif untuk akun ini.');
    if (intel.security.activeSessions > 3) risks.push(`Sesi aktif cukup banyak: **${intel.security.activeSessions}** device/session.`);

    const fallback = 'Tidak ada indikator kritis yang menonjol saat ini, tetapi tetap disarankan scan file rutin dan audit akses publik secara berkala.';
    const recommendations = [
        intel.security.infectedFiles > 0 ? 'Isolasi atau hapus file yang terdeteksi infected sebelum dibagikan lagi.' : null,
        intel.security.failedLoginAttempts24h > 0 ? 'Review percobaan login gagal dan ganti password jika ada aktivitas yang tidak dikenal.' : null,
        intel.security.unscannedFiles > 0 ? 'Jalankan scan pada file yang belum diperiksa.' : null,
        intel.security.publicUnprotectedFiles > 0 ? 'Lindungi file publik sensitif dengan password atau ubah ke private.' : null,
        !intel.security.twoFactorEnabled ? 'Aktifkan 2FA di halaman profile.' : null,
        intel.security.activeSessions > 3 ? 'Audit session aktif dan logout device yang tidak dikenal.' : null,
        intel.security.verifiedAccount ? null : 'Verifikasi akun agar pemulihan dan notifikasi keamanan lebih kuat.'
    ].filter(Boolean);

    return [
        `**Security Posture: ${severity.label}**`,
        severity.summary,
        `- File publik tanpa password: **${intel.security.publicUnprotectedFiles}**`,
        `- File belum discan: **${intel.security.unscannedFiles}**`,
        `- File terinfeksi: **${intel.security.infectedFiles}**`,
        `- Percobaan login gagal 24 jam: **${intel.security.failedLoginAttempts24h}**`,
        `- Sesi aktif: **${intel.security.activeSessions}**`,
        `- 2FA: **${intel.security.twoFactorEnabled ? 'Enabled' : 'Disabled'}**`,
        `- Akun terverifikasi: **${intel.security.verifiedAccount ? 'Yes' : 'No'}**`,
        '\n**Temuan utama**',
        risks.length ? risks.map(item => `- ${item}`).join('\n') : fallback,
        recommendations.length ? `\n**Checklist tindakan langsung**\n${recommendations.map(item => `- [ ] ${item}`).join('\n')}` : '\n**Checklist tindakan langsung**\n- [ ] Tidak ada tindakan mendesak saat ini. Lanjutkan monitoring rutin.'
    ].join('\n\n');
};

const formatWorkspaceRiskSummary = (intel) => {
    if (!intel) return 'Risiko cyber utama belum dapat dihitung.';

    if (intel.security.infectedFiles > 0) {
        return `Risiko cyber paling penting saat ini adalah **file terinfeksi**. Terdeteksi **${intel.security.infectedFiles}** file dengan status malware/infected. Prioritas: isolasi file, nonaktifkan share link, lalu lakukan review manual.`;
    }

    if (intel.security.publicUnprotectedFiles > 0) {
        return `Risiko cyber paling penting saat ini adalah **file publik tanpa proteksi**. Ada **${intel.security.publicUnprotectedFiles}** file yang dapat diakses publik tanpa password. Prioritas: ubah visibility atau tambahkan password.`;
    }

    if (intel.security.unscannedFiles > 0) {
        return `Risiko cyber paling penting saat ini adalah **file belum discan**. Ada **${intel.security.unscannedFiles}** file yang belum melewati pemeriksaan keamanan. Prioritas: jalankan malware scan dan review file yang baru diupload.`;
    }

    if (!intel.security.twoFactorEnabled) {
        return 'Risiko cyber paling penting saat ini adalah **2FA belum aktif**. Jika cookie atau password bocor, akun lebih mudah diambil alih. Prioritas: aktifkan 2FA di halaman profile.';
    }

    return 'Risiko cyber utama saat ini tergolong rendah. Status keseluruhan berada di level **SAFE**, tetapi tetap pantau upload baru, session aktif, dan file publik secara berkala.';
};

module.exports = {
    readOnlyConn,
    AI_SCHEMA_MAP,
    privacyFilter,
    getUserProfile,
    getStorageStats,
    getWorkspaceIntelligence,
    formatStorageAmount,
    getSecuritySeverity,
    formatWorkspaceSecurityReport,
    formatWorkspaceRiskSummary,
    searchUsers,
    getTeamData,
    getActivityLog
};
