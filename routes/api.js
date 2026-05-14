const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const jimp = require('jimp');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const axios = require('axios');
const nodemailer = require('nodemailer');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const unzipper = require('unzipper');
const docxConverter = require('docx-pdf');
const mammoth = require('mammoth');
const archiver = require('archiver');
//const { v4: uuidv4 } = require('uuid');
const File = require('../models/file');
const User = require('../models/user');
const Team = require('../models/team');
const PaymentTransaction = require('../models/paymentTransaction');
const AiInsight = require('../models/aiInsight');
const DeveloperRequestLog = require('../models/developerRequestLog');
const {
    r2,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    getR2BucketName
} = require('../utils/r2');
const FileRequest = require('../models/fileRequest');
const UploadSession = require('../models/uploadSession');
const auth = require('../middleware/auth');
const LinkVisit = require('../models/linkVisit');
const {
    generatePasskeyRegistrationOptions,
    verifyPasskeyRegistration,
    generatePasskeyLoginOptions,
    verifyPasskeyLogin
} = require('../utils/passkey');
const { translateBatch, languages } = require('../utils/tr');
const { triggerWebhook } = require('../utils/webhook');
const {
    assertSafeOutboundUrl,
    getApiKeyPrefix,
    hashApiKey,
    sanitizePageTitle,
    sanitizePlainText,
    sanitizeWebhookSecret,
} = require('../utils/security');
const {
    getBillingAmount,
    activateProPlan,
    getPlanSummary,
    getPlanCatalog,
    hasProPlanAccess,
    syncUserPlanState
} = require('../utils/billing');
const { getUserStorageSnapshot } = require('../utils/storage');
const {
    hasMidtransConfig,
    createSnapClient,
    createCoreApiClient,
    verifyMidtransSignature
} = require('../utils/midtrans');
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

const API_KEY_LIMITS = {
    free: 3,
    pro: 25
};
const MAX_REMOTE_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_CHUNK_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_CHUNK_SESSION_BYTES = 150 * 1024 * 1024 * 1024;
const MAX_STANDARD_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_IMAGE_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_OCR_BYTES = 10 * 1024 * 1024;
const MAX_CONVERT_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACT_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_FILES = 250;
const DEVELOPER_CENTER_ENDPOINTS = [
    { method: 'GET', path: '/api/profile/api-keys', feature: 'api_keys', description: 'List masked API keys and current plan limit.' },
    { method: 'POST', path: '/api/profile/api-key', feature: 'api_keys', description: 'Create a new API key for server-to-server usage.' },
    { method: 'DELETE', path: '/api/profile/api-key/:keyId', feature: 'api_keys', description: 'Revoke an active API key immediately.' },
    { method: 'GET', path: '/api/profile/webhook', feature: 'webhook', description: 'Fetch webhook config and recent delivery logs.' },
    { method: 'POST', path: '/api/profile/webhook', feature: 'webhook', description: 'Save webhook endpoint and secret.' },
    { method: 'POST', path: '/api/profile/webhook/test', feature: 'webhook', description: 'Send a test ping and inspect delivery result.' },
    { method: 'POST', path: '/api/upload', feature: 'upload', description: 'Standard base64 upload for third-party integrations.' },
    { method: 'POST', path: '/api/upload/remote', feature: 'remote_upload', description: 'Store a public URL directly into the workspace.' },
    { method: 'POST', path: '/api/upload/chunk/init', feature: 'chunk_upload', description: 'Begin multipart upload session for large files.' },
    { method: 'POST', path: '/api/upload/chunk/finalize', feature: 'chunk_upload', description: 'Finalize chunk upload into a stored file.' },
    { method: 'PUT', path: '/api/files/:id/meta', feature: 'metadata', description: 'Update description and tags for a file.' },
    { method: 'PUT', path: '/api/files/:id/visibility', feature: 'metadata', description: 'Set public/private visibility.' },
    { method: 'GET', path: '/api/files/:id/analytics', feature: 'analytics', description: 'Fetch views/downloads by country.' },
    { method: 'POST', path: '/api/files/:id/ocr', feature: 'ocr', description: 'Extract text from an image file.' },
    { method: 'POST', path: '/api/files/:id/extract', feature: 'ai_extract', description: 'AI-assisted archive extract workflow.' },
    { method: 'POST', path: '/api/billing/checkout', feature: 'billing', description: 'Create Midtrans checkout session.' },
    { method: 'POST', path: '/api/billing/sync/:orderId', feature: 'billing', description: 'Manual sync for payment status after popup flow.' },
    { method: 'POST', path: '/api/profile/branding', feature: 'branding', description: 'Save PRO branding logo, color, and title.' }
];

async function sendEmail(to, subject, htmlContent) {
    try {
        const mailOptions = {
            from: `"w upload" <${process.env.EMAIL_USER}>`,
            to: to,
            subject: subject,
            html: htmlContent
        };
        await transporter.sendMail(mailOptions);
        return true;
    } catch (error) {
        return false;
    }
}

function isSupportedLanguage(code) {
    return languages.some(language => language.code === code);
}

function sanitizeFilename(name) {
    if (typeof name !== 'string') return '';
    return name.replace(/\0/g, '')
        .replace(/(\.\.(\/|\\|$))+/g, '')
        .replace(/[^\w\s.\-()]/gi, '_')
        .trim();
}

function normalizeAlias(value, fallback = 'file') {
    const source = sanitizeFilename(value) || fallback;
    const normalized = source.replace(/[^a-zA-Z0-9._-]/g, '_');
    return normalized || `${fallback}_${Date.now()}`;
}

function validateMagicBytes(buffer, contentType) {
    const hex = buffer.toString('hex', 0, 8).toUpperCase();
    
    if (hex.startsWith('4D5A')) return false; 

    const signatures = {
        'image/jpeg': ['FFD8FF'],
        'image/png': ['89504E47'],
        'image/gif': ['47494638'],
        'application/pdf': ['25504446'],
        'application/zip': ['504B0304'],
        'application/x-rar-compressed': ['52617221']
    };

    if (signatures[contentType]) {
        return signatures[contentType].some(sig => hex.startsWith(sig));
    }

    return true; 
}

function isTruthy(value) {
    return value === true || value === 'true' || value === '1' || value === 1 || value === 'on';
}

function parseDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') {
        throw new Error('Invalid file payload.');
    }

    const match = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/);
    if (!match) {
        throw new Error('Base64 payload must be a valid data URL.');
    }

    return {
        contentType: match[1] || 'application/octet-stream',
        buffer: Buffer.from(match[2], 'base64')
    };
}

function sanitizeTagList(tags) {
    if (!tags) return [];
    const source = Array.isArray(tags) ? tags : String(tags).split(',');
    return source
        .map(tag => sanitizeFilename(String(tag).trim()))
        .filter(Boolean);
}

function serializeDashboardFile(file) {
    if (!file) return null;
    return {
        id: String(file._id),
        originalName: file.originalName,
        customAlias: file.customAlias,
        contentType: file.contentType,
        size: Number(file.size || 0),
        isHidden: Boolean(file.isHidden),
        isFolder: Boolean(file.isFolder),
        isStarred: Boolean(file.isStarred),
        downloads: Number(file.downloads || 0),
        description: file.description || '',
        tags: Array.isArray(file.tags) ? file.tags : [],
        parentId: file.parentId ? String(file.parentId) : null,
        createdAt: file.createdAt
    };
}

function isFileOwner(file, userId) {
    return Boolean(file?.owner && userId && file.owner.equals && file.owner.equals(userId));
}

function getCollaboratorRole(file, userId) {
    if (!file?.collaborators || !userId) return null;
    const collaborator = file.collaborators.find(entry => entry.user && entry.user.equals(userId));
    return collaborator?.role || null;
}

function canUserAccessFile(file, user, options = {}) {
    if (!file || file.deletedAt) return false;

    const {
        requireOwner = false,
        allowedCollaboratorRoles = [],
        allowPublic = false
    } = options;

    if (!user?._id) {
        return allowPublic && !file.isHidden;
    }

    if (isFileOwner(file, user._id)) return true;
    if (requireOwner) return false;

    const collaboratorRole = getCollaboratorRole(file, user._id);
    if (collaboratorRole) {
        return allowedCollaboratorRoles.length === 0 || allowedCollaboratorRoles.includes(collaboratorRole);
    }

    return allowPublic && !file.isHidden;
}

async function loadAccessibleFileById(fileId, user, options = {}) {
    const file = await File.findById(fileId);
    if (!file || !canUserAccessFile(file, user, options)) {
        return null;
    }
    return file;
}

async function findUserByApiKey(token) {
    if (!token) return null;

    const keyHash = hashApiKey(token);
    let user = await User.findOne({ 'apiKeys.keyHash': keyHash }).select('-password');
    if (user) {
        const entry = user.apiKeys.find(item => item.keyHash === keyHash);
        if (entry) {
            entry.lastUsed = new Date();
            await user.save();
        }
        return user;
    }

    user = await User.findOne({ 'apiKeys.key': token }).select('-password');
    if (!user) return null;

    const legacyEntry = user.apiKeys.find(item => item.key === token);
    if (legacyEntry) {
        legacyEntry.keyHash = keyHash;
        legacyEntry.keyPrefix = legacyEntry.keyPrefix || getApiKeyPrefix(token);
        legacyEntry.key = undefined;
        legacyEntry.lastUsed = new Date();
        await user.save();
    }

    return user;
}

function maskApiKeys(apiKeys = []) {
    return apiKeys.map(key => ({
        _id: key._id,
        label: key.label,
        keyPrefix: key.keyPrefix || '',
        lastUsed: key.lastUsed || null,
        createdAt: key.createdAt || null
    }));
}

function streamToBuffer(stream) {
    if (!stream) return Promise.resolve(Buffer.alloc(0));
    if (Buffer.isBuffer(stream)) return Promise.resolve(stream);
    if (typeof stream.transformToByteArray === 'function') {
        return stream.transformToByteArray().then(bytes => Buffer.from(bytes));
    }

    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

async function getR2ObjectBuffer(key) {
    const { Body } = await r2.send(new GetObjectCommand({
        Bucket: getR2BucketName(),
        Key: key
    }));

    return streamToBuffer(Body);
}

async function uploadBufferToR2(ownerId, alias, buffer, contentType) {
    const r2Key = `${ownerId.toString()}/${Date.now()}_${crypto.randomUUID()}_${alias}`;
    await r2.send(new PutObjectCommand({
        Bucket: getR2BucketName(),
        Key: r2Key,
        Body: buffer,
        ContentType: contentType
    }));
    return r2Key;
}

async function storeUserImageAsset(ownerId, dataUrl, aliasBase) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed.contentType.startsWith('image/')) {
        throw new Error('Only image assets are supported.');
    }
    if (parsed.buffer.length > MAX_INLINE_IMAGE_ASSET_BYTES) {
        throw new Error('Image asset is too large.');
    }

    const extensionMap = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'image/gif': '.gif'
    };
    const extension = extensionMap[parsed.contentType] || '.bin';
    const alias = normalizeAlias(`${aliasBase}${extension}`, aliasBase);
    const r2Key = await uploadBufferToR2(ownerId, alias, parsed.buffer, parsed.contentType);
    return { r2Key };
}

async function ensureUniqueAlias(candidate, fallbackName = 'file') {
    const fallbackAlias = normalizeAlias(fallbackName, 'file');
    const parsedExt = path.extname(fallbackAlias);
    const parsedBase = path.basename(fallbackAlias, parsedExt);
    let alias = normalizeAlias(candidate, fallbackAlias);
    let counter = 1;

    while (await File.findOne({ customAlias: alias })) {
        alias = `${parsedBase}_${counter}${parsedExt}`;
        counter++;
    }

    return alias;
}

async function saveFileWithUniqueAlias(fileDoc, fallbackName) {
    const parsedExt = path.extname(fallbackName || fileDoc.originalName || '');
    const parsedBase = path.basename(fallbackName || fileDoc.originalName || 'file', parsedExt);

    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await fileDoc.save();
            return fileDoc;
        } catch (error) {
            if (error && error.code === 11000 && error.keyPattern && error.keyPattern.customAlias) {
                fileDoc.customAlias = `${normalizeAlias(parsedBase, 'file')}_${Date.now()}_${crypto.randomBytes(2).toString('hex')}${parsedExt}`;
                continue;
            }
            throw error;
        }
    }

    throw new Error('Could not allocate a unique file alias after multiple attempts.');
}

function formatInsightSize(size = 0) {
    const bytes = Number(size || 0);
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

function buildUploadInsightPayload(file, source = 'standard_upload') {
    const suggestions = [];
    let severity = 'info';
    let summary = `${file.originalName} berhasil dianalisis setelah upload.`;

    if (file.contentType.startsWith('image/')) {
        summary = `${file.originalName} terdeteksi sebagai gambar ${formatInsightSize(file.size)}. File ini cocok untuk OCR, watermark, atau publish ke public page.`;
        suggestions.push('Coba OCR jika gambar berisi teks.');
        suggestions.push('Aktifkan watermark jika file akan dibagikan publik.');
    } else if (file.contentType.startsWith('video/')) {
        summary = `${file.originalName} terdeteksi sebagai video ${formatInsightSize(file.size)}. AI menandainya siap untuk playback dan distribusi link langsung.`;
        suggestions.push('Gunakan halaman download/video untuk preview sebelum dibagikan.');
        suggestions.push('Tambahkan deskripsi agar file lebih mudah dicari lewat AI assistant.');
    } else if (file.contentType.includes('zip') || file.originalName.toLowerCase().endsWith('.zip') || file.originalName.toLowerCase().endsWith('.rar')) {
        summary = `${file.originalName} adalah arsip ${formatInsightSize(file.size)}. File ini bisa diekstrak langsung dari dashboard tanpa upload ulang.`;
        severity = 'success';
        suggestions.push('Gunakan fitur extract archive dari dashboard.');
        suggestions.push('Periksa isi arsip sebelum dibagikan ke collaborator.');
    } else {
        summary = `${file.originalName} tersimpan sebagai ${file.contentType || 'file umum'} dengan ukuran ${formatInsightSize(file.size)}.`;
        suggestions.push('Tambahkan tag atau deskripsi agar AI lebih akurat saat mencari file.');
    }

    if (file.size >= 250 * 1024 * 1024) {
        severity = 'warning';
        suggestions.push('Ukuran file cukup besar, pantau storage dan share bandwidth-nya.');
    }

    return {
        severity,
        title: `Upload analyzed: ${file.originalName}`,
        summary,
        suggestions
    };
}

async function createUploadInsight(user, file, source = 'standard_upload') {
    if (!user?._id || !file?._id) return;

    try {
        const payload = buildUploadInsightPayload(file, source);
        await AiInsight.create({
            user: user._id,
            kind: 'upload_analysis',
            title: payload.title,
            summary: payload.summary,
            severity: payload.severity,
            metadata: {
                fileId: file._id,
                alias: file.customAlias,
                filename: file.originalName,
                contentType: file.contentType,
                source,
                size: file.size,
                suggestions: payload.suggestions
            }
        });
    } catch (error) {
        console.error('AI insight creation failed:', error.message);
    }
}

async function createArchiveExtractInsight(user, archiveFile, extractedFiles = []) {
    if (!user?._id || !archiveFile?._id) return;

    try {
        const sampleNames = extractedFiles.slice(0, 5).map(item => item.originalName);
        const totalBytes = extractedFiles.reduce((sum, item) => sum + Number(item.size || 0), 0);
        await AiInsight.create({
            user: user._id,
            kind: 'archive_extract',
            title: `AI extract selesai untuk ${archiveFile.originalName}`,
            summary: `${extractedFiles.length} file berhasil diekstrak dari arsip ${archiveFile.originalName} ke folder yang sama. Total hasil extract ${formatInsightSize(totalBytes)}.`,
            severity: extractedFiles.length > 50 ? 'warning' : 'info',
            metadata: {
                fileId: archiveFile._id,
                alias: archiveFile.customAlias,
                filename: archiveFile.originalName,
                source: 'archive_extract',
                extractedCount: extractedFiles.length,
                totalSize: totalBytes,
                extractedNames: sampleNames,
                suggestions: [
                    'Tinjau file hasil extract sebelum dibagikan ke public link.',
                    'Jalankan malware scan pada hasil extract jika arsip berasal dari pihak luar.'
                ]
            }
        });
    } catch (error) {
        console.error('Archive extract insight failed:', error.message);
    }
}

async function deleteR2Keys(keys = []) {
    const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
    if (!uniqueKeys.length) return;

    await Promise.allSettled(
        uniqueKeys.map((key) => r2.send(new DeleteObjectCommand({
            Bucket: getR2BucketName(),
            Key: key
        })))
    );
}

async function getOwnedFileTree(ownerId, rootIds = []) {
    const seen = new Map();
    let frontier = rootIds.filter(Boolean);

    while (frontier.length) {
        const docs = await File.find({
            owner: ownerId,
            $or: [
                { _id: { $in: frontier } },
                { parentId: { $in: frontier } }
            ]
        });

        const nextFrontier = [];
        for (const doc of docs) {
            const id = String(doc._id);
            if (seen.has(id)) continue;
            seen.set(id, doc);
            if (doc.isFolder) {
                nextFrontier.push(doc._id);
            }
        }

        frontier = nextFrontier;
    }

    return Array.from(seen.values());
}

async function permanentlyDeleteOwnedFiles(ownerId, rootIds = []) {
    const tree = await getOwnedFileTree(ownerId, rootIds);
    if (!tree.length) {
        return { deletedCount: 0 };
    }

    const r2Keys = [];
    for (const file of tree) {
        if (file.r2Key) r2Keys.push(file.r2Key);
        if (Array.isArray(file.versions)) {
            file.versions.forEach((version) => {
                if (version?.r2Key) r2Keys.push(version.r2Key);
            });
        }
        if (Array.isArray(file.signatureRequests)) {
            file.signatureRequests.forEach((entry) => {
                if (entry?.signedFileR2Key) r2Keys.push(entry.signedFileR2Key);
            });
        }
    }

    await deleteR2Keys(r2Keys);
    await File.deleteMany({ _id: { $in: tree.map((file) => file._id) } });

    return { deletedCount: tree.length };
}

async function setOwnedTreeDeletedAt(ownerId, rootIds = [], deletedAt) {
    const tree = await getOwnedFileTree(ownerId, rootIds);
    if (!tree.length) return { affectedCount: 0 };

    await File.updateMany(
        { _id: { $in: tree.map((file) => file._id) } },
        { $set: { deletedAt } }
    );

    return { affectedCount: tree.length };
}

async function getDashboardSummaryForUser(userId, visibleFiles = []) {
    const storage = await getUserStorageSnapshot(userId);
    const [ownedFiles, ownedFolders, sharedItems] = await Promise.all([
        File.countDocuments({ owner: userId, deletedAt: null, isFolder: false }),
        File.countDocuments({ owner: userId, deletedAt: null, isFolder: true }),
        File.countDocuments({ 'collaborators.user': userId, deletedAt: null })
    ]);

    return {
        ownedFiles,
        ownedFolders,
        sharedItems,
        totalDownloads: Array.isArray(visibleFiles) ? visibleFiles.reduce((sum, item) => sum + Number(item.downloads || 0), 0) : 0,
        currentUsage: storage.used,
        availableStorage: storage.available,
        totalStorage: storage.total,
        storagePercentage: storage.percentage,
        fileCount: storage.fileCount
    };
}

async function ensureUserCanStoreBytes(user, incomingBytes = 0) {
    await syncUserPlanState(user);
    const snapshot = await getUserStorageSnapshot(user._id);
    const projectedUsage = snapshot.used + Math.max(0, Number(incomingBytes || 0));

    if (snapshot.used > snapshot.total) {
        return {
            ok: false,
            code: 409,
            message: `Storage plan Anda sudah melebihi batas ${getPlanSummary(user.plan).name}. Hapus file dulu sebelum upload baru.`,
            storage: snapshot
        };
    }

    if (projectedUsage > snapshot.total) {
        return {
            ok: false,
            code: 413,
            message: `Upload diblok karena akan melewati batas storage ${getPlanSummary(user.plan).name}. Sisa storage Anda ${Math.max(0, snapshot.available)} byte.`,
            storage: snapshot
        };
    }

    return { ok: true, storage: snapshot };
}

function detectDeveloperAuthType(req) {
    if (req.headers['x-api-key']) return 'api_key';
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) return 'bearer';
    if (req.cookies?.token) return 'cookie';
    return 'system';
}

async function logDeveloperRequest(req, feature, options = {}) {
    if (!req?.user?._id || !feature) return;
    try {
        await DeveloperRequestLog.create({
            user: req.user._id,
            feature,
            category: options.category || 'developer',
            method: req.method,
            path: req.originalUrl || req.path || '',
            statusCode: Number(options.statusCode || 200),
            authType: detectDeveloperAuthType(req),
            bytes: Number(options.bytes || 0),
            meta: options.meta || {}
        });
    } catch (error) {
        console.error('Developer request log failed:', error.message);
    }
}

async function getOptionalAuthenticatedUser(req) {
    let token = req.cookies.token;

    if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (!token && req.headers['x-api-key']) {
        token = req.headers['x-api-key'];
    }

    if (!token) return null;

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select('-password');
        if (user && !user.isBanned) {
            return user;
        }
    } catch (e) {}

    try {
        const user = await findUserByApiKey(token);
        if (user && !user.isBanned) {
            return user;
        }
    } catch (e) {}

    return null;
}

function getPpobConfig() {
    return {
        url: process.env.PPOB_API_URL || 'https://jagoanpedia.com/api/ppob',
        key: process.env.PPOB_API_KEY || '2169-de6d54a0-73d9-4380-ab2e-a51bb2a76d33'
    };
}

function getApiKeyLimitForPlan(plan = 'free') {
    return plan === 'pro' ? 25 : 3;
}

function buildMidtransEnabledPayments(selectedMethod) {
    const method = String(selectedMethod || '').toLowerCase();
    if (method === 'qris') return ['qris'];
    if (method === 'bank_transfer') return ['bank_transfer'];
    if (method === 'ewallet') return ['gopay', 'shopeepay'];
    return undefined;
}

function mapMidtransStatus(transactionStatus, fraudStatus) {
    if (transactionStatus === 'capture') {
        return fraudStatus === 'challenge' ? 'challenge' : 'paid';
    }
    if (transactionStatus === 'settlement') return 'paid';
    if (transactionStatus === 'pending') return 'pending';
    if (transactionStatus === 'deny') return 'deny';
    if (transactionStatus === 'cancel') return 'cancel';
    if (transactionStatus === 'expire') return 'expire';
    if (transactionStatus === 'refund') return 'refund';
    if (transactionStatus === 'partial_refund') return 'partial_refund';
    return 'failure';
}

async function syncPaymentRecordFromMidtrans(transaction, statusPayload, rawPayload) {
    if (!transaction || !statusPayload) return null;

    const nextStatus = mapMidtransStatus(statusPayload.transaction_status, statusPayload.fraud_status);
    const previousStatus = transaction.status;
    const wasPaid = transaction.status === 'paid';

    transaction.status = nextStatus;
    transaction.transactionStatus = statusPayload.transaction_status || transaction.transactionStatus;
    transaction.fraudStatus = statusPayload.fraud_status || transaction.fraudStatus;
    transaction.midtransTransactionId = statusPayload.transaction_id || transaction.midtransTransactionId;
    transaction.midtransStatusCode = statusPayload.status_code || transaction.midtransStatusCode;
    transaction.paymentMethod = statusPayload.payment_type || transaction.paymentMethod;

    if (statusPayload.expiry_time) {
        transaction.expiresAt = new Date(statusPayload.expiry_time);
    }
    if (statusPayload.transaction_time && nextStatus === 'paid') {
        transaction.paidAt = new Date(statusPayload.transaction_time);
    }
    if (rawPayload) {
        transaction.rawNotifications = [rawPayload, ...(transaction.rawNotifications || [])].slice(0, 10);
    }

    let webhookUser = null;
    if (!wasPaid && nextStatus === 'paid') {
        const user = await User.findById(transaction.user);
        if (user) {
            await activateProPlan(user, transaction.billingCycle);
            transaction.completedAt = new Date();
            if (!transaction.paidAt) transaction.paidAt = new Date();
            webhookUser = user;
        }
    }

    await transaction.save();

    if (previousStatus !== nextStatus) {
        webhookUser = webhookUser || await User.findById(transaction.user);
        if (webhookUser) {
            triggerWebhook(webhookUser, 'billing.payment_updated', {
                orderId: transaction.orderId,
                status: nextStatus,
                previousStatus,
                billingCycle: transaction.billingCycle,
                amount: transaction.amount,
                paymentMethod: transaction.paymentMethod,
                paidAt: transaction.paidAt,
                completedAt: transaction.completedAt
            });
        }
    }

    if (!wasPaid && nextStatus === 'paid' && webhookUser) {
        const storage = await getUserStorageSnapshot(webhookUser._id);
        triggerWebhook(webhookUser, 'billing.subscription_activated', {
            orderId: transaction.orderId,
            plan: webhookUser.plan,
            billingCycle: transaction.billingCycle,
            amount: transaction.amount,
            expiresAt: webhookUser.subscriptionExpiresAt,
            storage: {
                used: storage.used,
                total: storage.total,
                available: storage.available,
                percentage: storage.percentage
            }
        });
    }

    return transaction;
}

router.get('/billing/history', auth.protectApi, async (req, res) => {
    try {
        const transactions = await PaymentTransaction.find({ user: req.user.id })
            .sort({ createdAt: -1 })
            .limit(12)
            .select('orderId amount billingCycle status paymentMethod createdAt completedAt paidAt snapRedirectUrl');

        res.json({ transactions });
    } catch (error) {
        res.status(500).json({ message: 'Failed to load billing history.' });
    }
});

router.get('/profile/storage', auth.protectApi, async (req, res) => {
    try {
        const storage = await getUserStorageSnapshot(req.user._id);

        res.json({
            used: storage.used,
            total: storage.total,
            available: storage.available,
            percentage: storage.percentage,
            fileCount: storage.fileCount
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to load storage usage.' });
    }
});

router.get('/dashboard/summary', auth.protectApi, async (req, res) => {
    try {
        const summary = await getDashboardSummaryForUser(req.user._id);
        res.json({ stats: summary });
    } catch (error) {
        res.status(500).json({ message: 'Failed to load dashboard summary.' });
    }
});

router.get('/developer/overview', auth.protectApi, async (req, res) => {
    try {
        const storage = await getUserStorageSnapshot(req.user._id);

        let recentLogs = [];
        let paidTransactions = 0;

        try {
            recentLogs = await DeveloperRequestLog.find({ user: req.user._id })
                .sort({ createdAt: -1 })
                .limit(12)
                .lean();
        } catch (error) {
            console.error('Developer overview logs error:', error.message);
        }

        try {
            paidTransactions = await PaymentTransaction.countDocuments({ user: req.user._id, status: 'paid' });
        } catch (error) {
            console.error('Developer overview payments error:', error.message);
        }

        const featureCounts = recentLogs.reduce((acc, item) => {
            const featureName = item && item.feature ? item.feature : 'unknown';
            acc[featureName] = (acc[featureName] || 0) + 1;
            return acc;
        }, {});

        res.json({
            plan: getPlanSummary(req.user.plan),
            storage,
            apiKeys: {
                used: Array.isArray(req.user.apiKeys) ? req.user.apiKeys.length : 0,
                limit: API_KEY_LIMITS[req.user.plan] || API_KEY_LIMITS.free
            },
            webhook: {
                isActive: Boolean(req.user.webhook?.isActive),
                url: req.user.webhook?.url || '',
                deliveries: req.user.webhook?.deliveries || []
            },
            branding: {
                available: hasProPlanAccess(req.user),
                configured: Boolean(req.user.branding?.logoUrl || req.user.branding?.pageTitle || req.user.branding?.primaryColor)
            },
            payments: {
                paidTransactions
            },
            logs: recentLogs,
            featureCounts,
            endpoints: DEVELOPER_CENTER_ENDPOINTS
        });
    } catch (error) {
        console.error('Developer overview error:', error.message);
        res.status(500).json({ message: 'Failed to load developer overview.' });
    }
});

router.get('/developer/logs', auth.protectApi, async (req, res) => {
    try {
        const logs = await DeveloperRequestLog.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(40).lean();
        res.json({ logs });
    } catch (error) {
        console.error('Developer logs endpoint error:', error.message);
        res.status(500).json({ message: 'Failed to load developer logs.' });
    }
});

router.get('/developer/endpoints', auth.protectApi, async (req, res) => {
    res.json({ endpoints: DEVELOPER_CENTER_ENDPOINTS });
});

router.post('/billing/checkout', auth.protectApi, async (req, res) => {
    try {
        if (!hasMidtransConfig()) {
            return res.status(503).json({ message: 'Midtrans is not configured yet.' });
        }

        const billingCycle = req.body.billingCycle === 'yearly' ? 'yearly' : 'monthly';
        const selectedMethod = typeof req.body.paymentMethod === 'string' ? req.body.paymentMethod : 'auto';
        const amount = getBillingAmount(billingCycle);
        const orderId = `PRO-${billingCycle === 'yearly' ? 'YR' : 'MO'}-${String(req.user._id).slice(-6).toUpperCase()}-${Date.now()}`;
        const planLabel = billingCycle === 'yearly' ? 'PRO Yearly Plan' : 'PRO Monthly Plan';
        const enabledPayments = buildMidtransEnabledPayments(selectedMethod);
        const snap = createSnapClient();

        const transactionPayload = {
            transaction_details: {
                order_id: orderId,
                gross_amount: amount
            },
            customer_details: {
                first_name: req.user.username,
                email: req.user.email || `${req.user.username}@wupload.local`
            },
            item_details: [{
                id: billingCycle === 'yearly' ? 'pro-yearly' : 'pro-monthly',
                price: amount,
                quantity: 1,
                name: planLabel
            }],
            custom_field1: req.user.username,
            custom_field2: billingCycle,
            metadata: {
                userId: String(req.user._id),
                username: req.user.username
            }
        };

        if (enabledPayments && enabledPayments.length > 0) {
            transactionPayload.enabled_payments = enabledPayments;
        }

        const snapResponse = await snap.createTransaction(transactionPayload);
        const transaction = new PaymentTransaction({
            user: req.user.id,
            orderId,
            amount,
            billingCycle,
            paymentMethod: selectedMethod,
            snapToken: snapResponse.token,
            snapRedirectUrl: snapResponse.redirect_url,
            metadata: {
                username: req.user.username,
                selectedMethod,
                currentPlan: req.user.plan
            }
        });

        await transaction.save();
        await logDeveloperRequest(req, 'billing', {
            meta: { action: 'checkout', billingCycle, amount, selectedMethod, orderId }
        });

        res.json({
            orderId,
            token: snapResponse.token,
            redirectUrl: snapResponse.redirect_url,
            amount,
            billingCycle,
            message: 'Payment session created.'
        });
    } catch (error) {
        console.error('Billing checkout error:', error.response?.data || error.message);
        res.status(500).json({ message: 'Failed to create Midtrans payment session.' });
    }
});

router.post('/billing/sync/:orderId', auth.protectApi, async (req, res) => {
    try {
        if (!hasMidtransConfig()) {
            return res.status(503).json({ message: 'Midtrans is not configured yet.' });
        }

        const transaction = await PaymentTransaction.findOne({
            orderId: req.params.orderId,
            user: req.user.id
        });
        if (!transaction) {
            return res.status(404).json({ message: 'Transaction not found.' });
        }

        const coreApi = createCoreApiClient();
        const statusPayload = await coreApi.transaction.status(transaction.orderId);
        await syncPaymentRecordFromMidtrans(transaction, statusPayload, {
            source: 'manual-sync',
            syncedAt: new Date().toISOString()
        });
        const refreshedUser = await User.findById(req.user.id).select('plan subscriptionExpiresAt');
        const storage = await getUserStorageSnapshot(req.user._id);
        await logDeveloperRequest(req, 'billing', {
            meta: { action: 'sync', orderId: transaction.orderId, status: transaction.status }
        });

        res.json({
            status: transaction.status,
            paidAt: transaction.paidAt,
            completedAt: transaction.completedAt,
            plan: refreshedUser?.plan || req.user.plan,
            expiresAt: refreshedUser?.subscriptionExpiresAt || null,
            planSummary: getPlanSummary(refreshedUser?.plan || req.user.plan),
            storage: {
                used: storage.used,
                total: storage.total,
                available: storage.available,
                percentage: storage.percentage,
                fileCount: storage.fileCount
            }
        });
    } catch (error) {
        console.error('Billing sync error:', error.response?.data || error.message);
        res.status(500).json({ message: 'Failed to sync payment status.' });
    }
});

router.post('/payments/midtrans/notification', async (req, res) => {
    try {
        if (!hasMidtransConfig()) {
            return res.status(503).json({ message: 'Midtrans is not configured yet.' });
        }

        if (!verifyMidtransSignature(req.body)) {
            return res.status(403).json({ message: 'Invalid Midtrans signature.' });
        }

        const transaction = await PaymentTransaction.findOne({ orderId: req.body.order_id });
        if (!transaction) {
            return res.status(404).json({ message: 'Transaction not found.' });
        }

        const coreApi = createCoreApiClient();
        const statusPayload = await coreApi.transaction.status(transaction.orderId);
        await syncPaymentRecordFromMidtrans(transaction, statusPayload, req.body);

        res.json({ received: true, status: transaction.status });
    } catch (error) {
        console.error('Midtrans notification error:', error.response?.data || error.message);
        res.status(500).json({ message: 'Failed to process Midtrans notification.' });
    }
});

router.get('/ppob/services', auth.protectApi, async (req, res) => {
    try {
        const config = getPpobConfig();
        if (!config.key) {
            return res.status(503).json({ message: 'PPOB API key is not configured yet.' });
        }

        const response = await axios.post(config.url, {
            key: config.key,
            action: 'services'
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });

        if (!response.data || response.data.success !== true) {
            return res.status(400).json({ message: response.data?.error || 'Failed to load PPOB services.' });
        }

        let services = [];
        if (Array.isArray(response.data.data)) {
            services = response.data.data;
        } else if (response.data.data) {
            services = [response.data.data];
        }

        const search = String(req.query.search || '').trim().toLowerCase();
        const category = String(req.query.category || '').trim().toLowerCase();
        const operator = String(req.query.operator || '').trim().toLowerCase();

        const filtered = services.filter(service => {
            const serviceName = String(service.name || '').toLowerCase();
            const serviceCategory = String(service.category || '').toLowerCase();
            const serviceOperator = String(service.operator || '').toLowerCase();

            if (search && !`${serviceName} ${serviceCategory} ${serviceOperator}`.includes(search)) return false;
            if (category && serviceCategory !== category) return false;
            if (operator && serviceOperator !== operator) return false;
            return true;
        });

        res.json({
            services: filtered,
            total: filtered.length,
            source: 'jagoanpedia'
        });
    } catch (error) {
        console.error('PPOB services error:', error.response?.data || error.message);
        res.status(500).json({ message: 'Failed to fetch PPOB services.' });
    }
});

router.post('/folder', auth.protectApi, async (req, res) => {
    try {
        const { name, parentId } = req.body;
        const cleanName = sanitizeFilename(name); 
        
        const newFolder = new File({
            originalName: cleanName,
            customAlias: await ensureUniqueAlias(`folder_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`, cleanName),
            contentType: 'application/vnd.google-apps.folder',
            size: 0,
            base64: '',
            owner: req.user.id,
            isFolder: true,
            parentId: parentId || null
        });
        await saveFileWithUniqueAlias(newFolder, cleanName);
        res.status(201).json({ status: 'success', folder: newFolder });
    } catch (error) {
        res.status(500).json({ message: 'Error creating folder' });
    }
});

router.post('/i18n/translate', async (req, res) => {
    try {
        const { texts, targetLang, sourceLang } = req.body;

        if (!Array.isArray(texts) || texts.length === 0) {
            return res.status(400).json({ message: 'Texts array is required.' });
        }

        if (!targetLang || (targetLang !== 'original' && !isSupportedLanguage(targetLang))) {
            return res.status(400).json({ message: 'Unsupported target language.' });
        }

        if (targetLang === 'original') {
            return res.json({ translations: texts });
        }

        const sanitizedTexts = texts
            .slice(0, 250)
            .map(text => typeof text === 'string' ? text.trim() : '')
            .map(text => text.slice(0, 5000));

        const translations = await translateBatch(sanitizedTexts, targetLang, sourceLang || 'auto');
        res.json({ translations });
    } catch (error) {
        console.error('I18N Translation Error:', error);
        res.status(500).json({ message: 'Translation failed.' });
    }
});
// --- UPLOAD LOGIC (Diperbaiki: Menggunakan crypto.randomUUID) ---
router.post('/upload', async (req, res) => {
    try {
        let user = await getOptionalAuthenticatedUser(req);
        let ownerId = 'guest';

        if (req.body.publicProfileUsername) {
            const publicUser = await User.findOne({ username: req.body.publicProfileUsername, isPublicProfile: true });
            if (!publicUser) return res.status(403).json({ message: 'Public profile not found or uploads not allowed.' });
            user = publicUser;
            ownerId = publicUser._id;
        } else if (user) {
            ownerId = user._id;
        } else if (req.body.fileRequestSlug) {
            const reqObj = await FileRequest.findOne({ slug: req.body.fileRequestSlug });
            if (reqObj) {
                user = await User.findById(reqObj.owner);
                ownerId = user._id;
                req.body.parentId = reqObj.destinationFolder;
            }
        } else if (process.env.ALLOW_GUEST_UPLOAD !== 'true') {
            return res.status(401).json({ message: 'Authentication required.' });
        }

        const {
            filename, contentType, base64, watermarkText, parentId, description, tags,
            hidden, expires, limit, password, hint, geo, burn, customAlias, stripMetadata
        } = req.body;
        const cleanFilename = sanitizeFilename(filename);
        let finalContentType = contentType;

        if (!base64 || !cleanFilename || !contentType) {
            return res.status(400).json({ message: 'Missing required fields: filename, contentType, base64.' });
        }

        const parsedPayload = parseDataUrl(base64);
        let buffer = parsedPayload.buffer;
        if (user?._id) {
            const quotaCheck = await ensureUserCanStoreBytes(user, buffer.length);
            if (!quotaCheck.ok) {
                return res.status(quotaCheck.code).json({ message: quotaCheck.message, storage: quotaCheck.storage });
            }
        }
        if (buffer.length > MAX_STANDARD_UPLOAD_BYTES) {
            return res.status(413).json({
                message: 'Standard upload supports up to 20 MB. Use chunk upload for larger files.'
            });
        }

        if (!validateMagicBytes(buffer, finalContentType)) {
            return res.status(400).json({ message: 'File rejected due to security policy.' });
        }

        if (finalContentType.startsWith('image/') && isTruthy(stripMetadata)) {
            buffer = await sharp(buffer).withMetadata(false).toBuffer();
        }

        if (finalContentType.startsWith('image/') && watermarkText) {
            const image = await jimp.read(buffer);
            const font = await jimp.loadFont(jimp.FONT_SANS_32_WHITE);
            image.print(font, 10, image.bitmap.height - 40, watermarkText);
            buffer = await image.getBufferAsync(jimp.MIME_PNG);
            finalContentType = 'image/png';
        }

        const hash = crypto.createHash('md5').update(buffer).digest('hex');
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

        if (ownerId !== 'guest') {
            const duplicate = await File.findOne({ owner: ownerId, md5Hash: hash, deletedAt: null });
            if (duplicate) {
                return res.status(200).json({
                    status: 'success',
                    duplicate: true,
                    message: 'Duplicate file detected',
                    url: `${req.protocol}://${req.get('host')}/w-upload/file/${duplicate.customAlias}`,
                    filename: duplicate.customAlias,
                    file: serializeDashboardFile(duplicate)
                });
            }
        }

        const finalAlias = await ensureUniqueAlias(customAlias || cleanFilename, cleanFilename);

        let allowedGeo;
        if (geo) {
            try {
                allowedGeo = typeof geo === 'string' ? JSON.parse(geo) : geo;
            } catch (e) {
                return res.status(400).json({ message: 'Invalid geo restriction payload.' });
            }
        }

        const r2Key = await uploadBufferToR2(ownerId, finalAlias, buffer, finalContentType);

        const newFile = new File({
            originalName: cleanFilename,
            customAlias: finalAlias,
            contentType: finalContentType,
            size: buffer.length,
            storageType: 'r2',
            r2Key: r2Key,
            owner: ownerId !== 'guest' ? ownerId : null,
            parentId: parentId || null,
            description,
            tags: sanitizeTagList(tags),
            isHidden: isTruthy(hidden),
            md5Hash: hash,
            sha256Hash: sha256,
            isBurnAfterRead: isTruthy(burn),
            passwordHint: hint,
            allowedGeo,
            expiresAt: expires ? new Date(Date.now() + Number(expires) * 3600000) : undefined,
            downloadLimit: limit ? parseInt(limit, 10) : undefined
        });

        if (password) {
            newFile.password = await bcrypt.hash(password, 10);
        }

        await saveFileWithUniqueAlias(newFile, cleanFilename);

        if (user) {
            await createUploadInsight(user, newFile, req.body.publicProfileUsername ? 'public_profile_upload' : req.body.fileRequestSlug ? 'file_request_upload' : 'standard_upload');
            triggerWebhook(user, 'file.uploaded', {
                fileId: newFile._id,
                filename: newFile.originalName,
                alias: newFile.customAlias,
                size: newFile.size,
                contentType: newFile.contentType,
                url: `${req.protocol}://${req.get('host')}/w-upload/file/${newFile.customAlias}`,
                uploadedAt: newFile.createdAt
            });
            await logDeveloperRequest(req, 'upload', {
                statusCode: 201,
                bytes: newFile.size,
                meta: { alias: newFile.customAlias, contentType: newFile.contentType }
            });
        }

        res.status(201).json({
            status: 'success',
            url: `${req.protocol}://${req.get('host')}/w-upload/file/${finalAlias}`,
            filename: finalAlias,
            file: serializeDashboardFile(newFile)
        });
    } catch (error) {
        console.error("Upload Error:", error);
        res.status(500).json({ status: 'error', message: 'Upload failed' });
    }
});

router.post('/upload/remote', auth.protectApi, async (req, res) => {
    try {
        const { url, parentId } = req.body;
        const safeUrl = await assertSafeOutboundUrl(url);
        const response = await axios.get(safeUrl, {
            responseType: 'arraybuffer',
            timeout: 15000,
            maxRedirects: 0,
            maxContentLength: MAX_REMOTE_UPLOAD_BYTES,
            maxBodyLength: MAX_REMOTE_UPLOAD_BYTES
        });
        const contentType = response.headers['content-type'] || 'application/octet-stream';
        const buffer = Buffer.from(response.data, 'binary');
        if (buffer.length > MAX_REMOTE_UPLOAD_BYTES) {
            return res.status(413).json({ message: 'Remote file is too large.' });
        }
        const quotaCheck = await ensureUserCanStoreBytes(req.user, buffer.length);
        if (!quotaCheck.ok) {
            return res.status(quotaCheck.code).json({ message: quotaCheck.message, storage: quotaCheck.storage });
        }
        
        if (!validateMagicBytes(buffer, contentType)) {
            return res.status(400).json({ message: 'Remote file type validation failed.' });
        }

        let filename = path.basename(url) || `remote_${Date.now()}`;
        filename = sanitizeFilename(filename);
        const alias = await ensureUniqueAlias(`remote_${Date.now()}_${filename}`, filename);

        const r2Key = await uploadBufferToR2(req.user.id, alias, buffer, contentType);
        
        const newFile = new File({
            originalName: filename,
            customAlias: alias,
            contentType,
            size: buffer.length,
            storageType: 'r2',
            r2Key,
            owner: req.user.id,
            parentId: parentId || null,
            md5Hash: crypto.createHash('md5').update(buffer).digest('hex'),
            sha256Hash: crypto.createHash('sha256').update(buffer).digest('hex')
        });
        await saveFileWithUniqueAlias(newFile, filename);
        await createUploadInsight(req.user, newFile, 'remote_upload');
        await logDeveloperRequest(req, 'remote_upload', {
            statusCode: 201,
            bytes: newFile.size,
            meta: { alias: newFile.customAlias, sourceUrl: safeUrl }
        });
        res.status(201).json({ message: 'Remote upload success', file: newFile });
    } catch (error) {
        res.status(500).json({ message: 'Remote upload failed' });
    }
});

router.post('/upload/chunk/init', auth.protectApi, async (req, res) => {
    const { filename, totalSize, contentType } = req.body;
    const cleanName = sanitizeFilename(filename);
    if (Number(totalSize || 0) > MAX_CHUNK_SESSION_BYTES) {
        return res.status(413).json({ message: 'Chunk upload exceeds maximum allowed size.' });
    }
    const quotaCheck = await ensureUserCanStoreBytes(req.user, Number(totalSize || 0));
    if (!quotaCheck.ok) {
        return res.status(quotaCheck.code).json({ message: quotaCheck.message, storage: quotaCheck.storage });
    }
    const alias = await ensureUniqueAlias(`chunk_${Date.now()}_${cleanName}`, cleanName);
    const multipart = await r2.send(new CreateMultipartUploadCommand({
        Bucket: getR2BucketName(),
        Key: alias,
        ContentType: contentType || 'application/octet-stream'
    }));
    const sessionId = crypto.randomBytes(16).toString('hex');
    const session = new UploadSession({
        sessionId,
        owner: req.user.id,
        filename: cleanName,
        contentType: contentType || 'application/octet-stream',
        totalSize,
        r2Key: alias,
        r2UploadId: multipart.UploadId,
        parts: []
    });
    await session.save();
    await logDeveloperRequest(req, 'chunk_upload', {
        meta: { phase: 'init', filename: cleanName, totalSize: Number(totalSize || 0) }
    });
    res.json({ sessionId, chunkSize: MAX_CHUNK_SIZE_BYTES });
});

router.post('/upload/chunk', auth.protectApi, async (req, res) => {
    const { sessionId, chunkIndex, base64Chunk } = req.body;
    const session = await UploadSession.findOne({ sessionId, owner: req.user.id });
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (typeof base64Chunk !== 'string' || base64Chunk.length === 0) {
        return res.status(400).json({ message: 'Chunk payload is required.' });
    }

    const payloadSize = Buffer.byteLength(base64Chunk, 'utf8');
    if (payloadSize > MAX_CHUNK_SIZE_BYTES * 2) {
        return res.status(413).json({ message: 'Chunk payload is too large.' });
    }

    const parsedChunk = parseDataUrl(base64Chunk);
    const chunkBuffer = parsedChunk.buffer;
    if (chunkBuffer.length > MAX_CHUNK_SIZE_BYTES) {
        return res.status(413).json({ message: 'Decoded chunk is too large.' });
    }

    const partNumber = Number(chunkIndex) + 1;
    const uploadPartResponse = await r2.send(new UploadPartCommand({
        Bucket: getR2BucketName(),
        Key: session.r2Key,
        UploadId: session.r2UploadId,
        PartNumber: partNumber,
        Body: chunkBuffer
    }));

    const previousPart = session.parts.find(part => part.partNumber === partNumber);
    session.parts = session.parts.filter(part => part.partNumber !== partNumber);
    session.parts.push({
        partNumber,
        etag: uploadPartResponse.ETag,
        size: chunkBuffer.length
    });
    session.uploadedSize = Math.max(0, (session.uploadedSize || 0) - Number(previousPart?.size || 0)) + chunkBuffer.length;
    if (session.uploadedSize > MAX_CHUNK_SESSION_BYTES) {
        await r2.send(new AbortMultipartUploadCommand({
            Bucket: getR2BucketName(),
            Key: session.r2Key,
            UploadId: session.r2UploadId
        }));
        await UploadSession.deleteOne({ _id: session._id });
        return res.status(413).json({ message: 'Chunk upload exceeds maximum allowed size.' });
    }
    await session.save();
    res.json({ message: 'Chunk received', uploadedSize: session.uploadedSize });
});

router.post('/upload/chunk/finalize', auth.protectApi, async (req, res) => {
    const { sessionId, parentId } = req.body;
    const session = await UploadSession.findOne({ sessionId, owner: req.user.id });
    if (!session) return res.status(404).json({ message: 'Session not found' });

    const resolvedContentType = session.contentType || 'application/octet-stream';
    const sortedParts = [...session.parts].sort((a, b) => a.partNumber - b.partNumber);
    if (!sortedParts.length) {
        return res.status(400).json({ message: 'No chunks uploaded for this session.' });
    }

    await r2.send(new CompleteMultipartUploadCommand({
        Bucket: getR2BucketName(),
        Key: session.r2Key,
        UploadId: session.r2UploadId,
        MultipartUpload: {
            Parts: sortedParts.map(part => ({
                ETag: part.etag,
                PartNumber: part.partNumber
            }))
        }
    }));

    const newFile = new File({
        originalName: sanitizeFilename(session.filename),
        customAlias: session.r2Key,
        contentType: resolvedContentType, 
        size: Number(session.totalSize || session.uploadedSize || 0),
        storageType: 'r2',
        r2Key: session.r2Key,
        owner: req.user.id,
        parentId: parentId || null,
        md5Hash: '',
        sha256Hash: ''
    });

    await saveFileWithUniqueAlias(newFile, session.filename);
    await UploadSession.deleteOne({ _id: session._id });
    await createUploadInsight(req.user, newFile, 'chunk_upload');
    await logDeveloperRequest(req, 'chunk_upload', {
        statusCode: 201,
        bytes: newFile.size,
        meta: { phase: 'finalize', alias: newFile.customAlias }
    });
    res.status(201).json({
        message: 'File assembled successfully',
        file: serializeDashboardFile(newFile),
        url: `${req.protocol}://${req.get('host')}/w-upload/file/${newFile.customAlias}`
    });
});

router.put('/files/:id/rename', auth.protectApi, async (req, res) => {
    try {
        const cleanName = sanitizeFilename(req.body.newName);
        await File.findOneAndUpdate({ _id: req.params.id, owner: req.user.id }, { originalName: cleanName });
        res.json({ message: 'Renamed successfully' });
    } catch (e) { res.status(500).json({ message: 'Error' }); }
});
router.get('/files/:id/share-details', auth.protectApi, async (req, res) => {
    try {
        const file = await File.findOne({ _id: req.params.id, owner: req.user.id })
                                 .populate('collaborators.user', 'username');

        if (!file) {
            return res.status(404).json({ message: 'File not found.' });
        }
        res.json({
            collaborators: file.collaborators,
            shareLinks: file.shareLinks,
            isHidden: !!file.isHidden
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error.' });
    }
});

router.put('/files/:id/visibility', auth.protectApi, async (req, res) => {
    try {
        const file = await File.findOne({ _id: req.params.id, owner: req.user.id });
        if (!file) {
            return res.status(404).json({ message: 'File not found.' });
        }

        file.isHidden = isTruthy(req.body.isHidden);
        await file.save();

        res.json({
            message: file.isHidden ? 'File set to private.' : 'File set to public.',
            isHidden: file.isHidden,
            file: serializeDashboardFile(file)
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update file visibility.' });
    }
});

router.put('/files/:id/meta', auth.protectApi, async (req, res) => {
    try {
        const { description, tags, isHidden } = req.body;
        const file = await File.findOne({ _id: req.params.id, owner: req.user.id });
        if (!file) {
            return res.status(404).json({ message: 'File not found.' });
        }

        if (description !== undefined) {
            file.description = sanitizePlainText(String(description), 2000);
        }

        if (tags !== undefined) {
            file.tags = sanitizeTagList(tags);
        }

        if (isHidden !== undefined) {
            file.isHidden = isTruthy(isHidden);
        }

        await file.save();
        await logDeveloperRequest(req, 'metadata', {
            meta: {
                fileId: String(file._id),
                hasDescription: Boolean(file.description),
                tagCount: Array.isArray(file.tags) ? file.tags.length : 0,
                visibility: file.isHidden ? 'private' : 'public'
            }
        });
        res.json({
            message: 'Metadata updated.',
            file: {
                ...serializeDashboardFile(file),
                description: file.description || '',
                tags: file.tags || []
            }
        });
    } catch (e) { res.status(500).json({ message: 'Error' }); }
});

router.put('/files/:id/protect', auth.protectApi, async (req, res) => {
    try {
        const file = await File.findOne({ _id: req.params.id, owner: req.user.id });
        if (!file) return res.status(404).json({ message: 'File not found.' });

        const { password, expires, limit, hint } = req.body;
        if (password) file.password = await bcrypt.hash(password, 10);
        else if (req.body.removePassword) file.password = undefined;

        if (hint) file.passwordHint = hint;
        if (expires) file.expiresAt = new Date(Date.now() + expires * 60 * 60 * 1000);
        if (limit) file.downloadLimit = parseInt(limit, 10);

        await file.save();
        await logDeveloperRequest(req, 'metadata', {
            meta: { fileId: String(file._id), visibility: file.isHidden ? 'private' : 'public' }
        });
        res.status(200).json({ message: 'Protection updated.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error.' });
    }
});

router.delete('/files/:id', auth.protectApi, async(req, res) => {
    const file = await File.findOne({ _id: req.params.id, owner: req.user.id });
    if (!file) return res.status(404).json({ message: 'File not found.' });

    if (file.deletedAt) {
        const result = await permanentlyDeleteOwnedFiles(req.user.id, [file._id]);
        const stats = await getDashboardSummaryForUser(req.user._id);
        return res.json({ message: `Item deleted permanently (${result.deletedCount} item).`, stats });
    }

    const deletedAt = new Date();
    await setOwnedTreeDeletedAt(req.user.id, [file._id], deletedAt);
    const stats = await getDashboardSummaryForUser(req.user._id);
    res.json({ message:'File moved to trash', stats });
});

router.post('/files/bulk', auth.protectApi, async (req, res) => {
    const { fileIds, action, targetFolderId } = req.body;
    if (!fileIds || !Array.isArray(fileIds)) return res.status(400).json({ message: 'Invalid files' });

    try {
        const query = { _id: { $in: fileIds }, owner: req.user.id };
        if (action === 'delete') {
            const files = await File.find(query).select('_id deletedAt');
            const trashedIds = files.filter((file) => file.deletedAt).map((file) => file._id);
            const activeIds = files.filter((file) => !file.deletedAt).map((file) => file._id);

            if (activeIds.length) {
                await setOwnedTreeDeletedAt(req.user.id, activeIds, new Date());
            }
            if (trashedIds.length) {
                await permanentlyDeleteOwnedFiles(req.user.id, trashedIds);
            }
        }
        else if (action === 'restore') await setOwnedTreeDeletedAt(req.user.id, fileIds, null);
        else if (action === 'move') await File.updateMany(query, { parentId: targetFolderId || null });
        else if (action === 'star') await File.updateMany(query, { isStarred: true });
        else if (action === 'unstar') await File.updateMany(query, { isStarred: false });

        const stats = await getDashboardSummaryForUser(req.user._id);
        res.json({ message: 'Bulk action completed', stats });
    } catch (e) {
        res.status(500).json({ message: 'Bulk action failed' });
    }
});

router.delete('/trash/empty', auth.protectApi, async (req, res) => {
    const trashedRoots = await File.find({ owner: req.user.id, deletedAt: { $ne: null } }).select('_id');
    const result = await permanentlyDeleteOwnedFiles(req.user.id, trashedRoots.map((file) => file._id));
    const stats = await getDashboardSummaryForUser(req.user._id);
    res.json({ message: `Trash emptied permanently (${result.deletedCount} item).`, stats });
});

router.post('/files/:id/collaborator', auth.protectApi, async (req, res) => {
    const { username, role } = req.body;
    const file = await File.findOne({ _id: req.params.id, owner: req.user.id });
    if (!file) return res.status(404).json({ message: 'File not found' });
    
    const collabUser = await User.findOne({ username });
    if (!collabUser) return res.status(404).json({ message: 'User not found' });
    
    const existingCollabIndex = file.collaborators.findIndex(c => c.user.equals(collabUser._id));
    if (existingCollabIndex > -1) {
        file.collaborators[existingCollabIndex].role = role || 'viewer';
    } else {
        file.collaborators.push({ user: collabUser._id, role: role || 'viewer' });
    }
    await file.save();
    
    if (collabUser.email) {
        const link = `${req.protocol}://${req.get('host')}/dashboard?folderId=${file._id}`; 
        const html = `<h3>You've been invited to collaborate!</h3>
                      <p>${req.user.username} has invited you to collaborate on: <b>${file.originalName}</b> with '${role}' permissions.</p>
                      <p><a href="${link}">Open Item</a></p>`;
        await sendEmail(collabUser.email, `Collaboration Invite: ${file.originalName}`, html);
    }

    res.json({ message: 'Collaborator added/updated and notified' });
});

router.delete('/files/:id/collaborator/:username', auth.protectApi, async (req, res) => {
    const file = await File.findOne({ _id: req.params.id, owner: req.user.id });
    if (!file) return res.status(404).json({ message: 'File not found' });

    const collabUser = await User.findOne({ username: req.params.username });
    if (!collabUser) return res.status(404).json({ message: 'User not found' });

    const before = file.collaborators.length;
    file.collaborators = file.collaborators.filter(entry => !entry.user.equals(collabUser._id));
    if (file.collaborators.length === before) {
        return res.status(404).json({ message: 'Collaborator not found' });
    }

    await file.save();
    res.json({ message: 'Collaborator removed.' });
});
router.post('/files/:id/email-share', auth.protectApi, async (req, res) => {
    const { email } = req.body;
    const file = await File.findOne({ _id: req.params.id, owner: req.user.id });
    if (!file) return res.status(404).json({ message: 'File not found' });
    
    const existingUser = await User.findOne({ email });
    if (existingUser && !file.collaborators.some(collab => collab.user && collab.user.equals(existingUser._id))) {
        file.collaborators.push({ user: existingUser._id, role: 'viewer' });
        await file.save();
    }

    let link;
    if (file.isFolder) {
        link = `${req.protocol}://${req.get('host')}/dashboard?folderId=${file._id}`; 
    } else {
        link = `${req.protocol}://${req.get('host')}/w-upload/file/${file.customAlias}`;
    }

    const htmlContent = `
        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
            <h2 style="color: #4f46e5;">File Shared with You</h2>
            <p><strong>${req.user.username}</strong> has shared a ${file.isFolder ? 'folder' : 'file'} with you.</p>
            <div style="margin: 20px 0; padding: 15px; background: #f9fafb; border-radius: 5px;">
                <p style="margin: 0; font-weight: bold;">${file.originalName}</p>
                <p style="margin: 5px 0 0 0; color: #666; font-size: 0.9em;">Size: ${(file.size / 1024 / 1024).toFixed(2)} MB</p>
            </div>
            <a href="${link}" style="display: inline-block; background: #4f46e5; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Open ${file.isFolder ? 'Folder' : 'File'}</a>
            <p style="font-size: 0.8em; color: #888; margin-top: 20px;">If the button doesn't work, copy this link: <br>${link}</p>
        </div>
    `;

    await sendEmail(email, `${req.user.username} shared "${file.originalName}"`, htmlContent);
    res.json({ message: 'Email sent successfully' });
});

router.get('/files/:id/zip', auth.protectApi, async (req, res) => {
    try {
        const folderId = req.params.id;
        const folder = await File.findOne({ 
            _id: folderId, 
            $or: [{ owner: req.user.id }, { 'collaborators.user': req.user.id }] 
        });

        if (!folder || !folder.isFolder) return res.status(404).send('Folder not found or access denied');

        const files = await File.find({ parentId: folderId, isFolder: false, deletedAt: null });

        const archive = archiver('zip', { zlib: { level: 9 } });

        res.attachment(`${folder.originalName}.zip`);
        archive.pipe(res);

        for (const file of files) {
            if (file.storageType === 'r2' && file.r2Key) {
                const buffer = await getR2ObjectBuffer(file.r2Key);
                archive.append(buffer, { name: file.originalName });
            } else if (file.base64) {
                const base64Data = file.base64.split(';base64,').pop();
                const buffer = Buffer.from(base64Data, 'base64');
                archive.append(buffer, { name: file.originalName });
            }
        }

        await archive.finalize();
    } catch (e) {
        console.error(e);
        res.status(500).send('Error creating zip');
    }
});

router.post('/files/zip', auth.protectApi, async (req, res) => {
    try {
        const { fileIds } = req.body;
        if (!fileIds || !Array.isArray(fileIds)) return res.status(400).send('Invalid files');

        const files = await File.find({ 
            _id: { $in: fileIds }, 
            $or: [{ owner: req.user.id }, { 'collaborators.user': req.user.id }],
            isFolder: false 
        });

        const archive = archiver('zip', { zlib: { level: 9 } });

        res.attachment('files.zip');
        archive.pipe(res);

        for (const file of files) {
            if (file.storageType === 'r2' && file.r2Key) {
                const buffer = await getR2ObjectBuffer(file.r2Key);
                archive.append(buffer, { name: file.originalName });
            } else if (file.base64) {
                const base64Data = file.base64.split(';base64,').pop();
                const buffer = Buffer.from(base64Data, 'base64');
                archive.append(buffer, { name: file.originalName });
            }
        }

        await archive.finalize();
    } catch (e) {
        res.status(500).send('Error generating zip');
    }
});

router.post('/files/:alias/comment', auth.protectApi, async (req, res) => {
    const { text } = req.body;
    const file = await File.findOne({ customAlias: req.params.alias });
    if (!file) return res.status(404).json({ message: 'File not found' });

    const mentions = [];
    const usersToNotify = new Set();
    const mentionRegex = /@(\w{3,})/g;
    let match;

    while ((match = mentionRegex.exec(text)) !== null) {
        const user = await User.findOne({ username: match[1] });
        if (user) {
            mentions.push(user._id);
            if (user.email) {
                usersToNotify.add(user.email);
            }
        }
    }
    
    const comment = { user: req.user.id, username: req.user.username, text, mentions };
    file.comments.push(comment);
    await file.save();

    usersToNotify.forEach(email => {
        const link = `${req.protocol}://${req.get('host')}/w-upload/file/${file.customAlias}`;
        const html = `<p>${req.user.username} mentioned you in a comment on <b>${file.originalName}</b>:</p><blockquote>${text.replace(/\n/g, '<br>')}</blockquote><p><a href="${link}">View Comment</a></p>`;
        sendEmail(email, `You were mentioned by ${req.user.username}`, html);
    });

    res.json({ message: 'Comment added', comment: file.comments[file.comments.length-1] });
});
router.post('/profile/branding', auth.protectApi, async (req, res) => {
    const { logoUrl, logoBase64, primaryColor, pageTitle } = req.body;
    if (!hasProPlanAccess(req.user)) {
        return res.status(403).json({ message: 'Branding is a Pro feature.' });
    }

    let finalLogoUrl = typeof logoUrl === 'string' ? logoUrl.trim() : '';
    let logoR2Key = req.user.branding?.logoR2Key || '';
    if (typeof logoBase64 === 'string' && logoBase64.startsWith('data:image/')) {
        try {
            const storedLogo = await storeUserImageAsset(req.user.id, logoBase64, 'branding_logo');
            logoR2Key = storedLogo.r2Key;
            finalLogoUrl = `/media/user/${req.user.id}/branding-logo?v=${Date.now()}`;
        } catch (error) {
            return res.status(413).json({ message: error.message });
        }
    }

    req.user.branding = {
        logoUrl: finalLogoUrl,
        logoR2Key,
        primaryColor: typeof primaryColor === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(primaryColor.trim())
            ? primaryColor.trim()
            : '#4F46E5',
        pageTitle: sanitizePageTitle(pageTitle)
    };
    await req.user.save();
    await logDeveloperRequest(req, 'branding', {
        meta: { hasLogo: Boolean(finalLogoUrl), primaryColor: req.user.branding.primaryColor }
    });
    res.json({ message: 'Branding settings updated.' });
});

router.post('/files/:id/transfer-ownership', auth.protectApi, async (req, res) => {
    const { username } = req.body;
    const file = await File.findOne({ _id: req.params.id, owner: req.user.id });
    if (!file) return res.status(404).json({ message: 'File not found or you are not the owner.' });

    const newOwner = await User.findOne({ username });
    if (!newOwner) return res.status(404).json({ message: 'New owner user not found.' });

    file.owner = newOwner._id;
    file.collaborators = file.collaborators.filter(c => !c.user.equals(newOwner._id));
    await file.save();
    res.json({ message: `Ownership successfully transferred to ${newOwner.username}` });
});

router.post('/files/:id/share-links', auth.protectApi, async (req, res) => {
    const file = await File.findOne({ _id: req.params.id, owner: req.user.id });
    if (!file) return res.status(404).json({ message: 'File not found.' });

    const requestedSlug = typeof req.body.customSlug === 'string' ? req.body.customSlug.trim() : '';
    const normalizedSlug = requestedSlug
        ? normalizeAlias(requestedSlug.toLowerCase().replace(/\s+/g, '-'), `share_${crypto.randomBytes(4).toString('hex')}`)
        : crypto.randomBytes(8).toString('hex');

    const existingLink = await File.findOne({ 'shareLinks.linkId': normalizedSlug });
    if (existingLink) {
        return res.status(400).json({ message: 'Custom link already in use. Choose another one.' });
    }

    const newLink = {
        linkId: normalizedSlug,
    };
    file.shareLinks.push(newLink);
    await file.save();

    res.status(201).json({ message: 'New share link created.', link: newLink });
});

router.delete('/files/:id/share-links/:linkId', auth.protectApi, async (req, res) => {
    await File.updateOne(
        { _id: req.params.id, owner: req.user.id },
        { $pull: { shareLinks: { linkId: req.params.linkId } } }
    );
    res.json({ message: 'Share link revoked.' });
});

router.post('/files/:id/request-signature', auth.protectApi, async (req, res) => {
    const { username } = req.body;
    const file = await File.findOne({ _id: req.params.id, owner: req.user.id });
    if (!file || file.contentType !== 'application/pdf') {
        return res.status(400).json({ message: 'File not found or is not a PDF.' });
    }

    const targetUser = await User.findOne({ username });
    if (!targetUser) return res.status(404).json({ message: 'User to sign not found.' });

    file.signatureRequests.push({ user: targetUser._id });
    await file.save();
    res.json({ message: `Signature requested from ${username}` });
});

router.post('/files/:id/annotations', auth.protectApi, async (req, res) => {
    const { type, data } = req.body;
    const file = await loadAccessibleFileById(req.params.id, req.user, {
        allowedCollaboratorRoles: ['editor']
    });
    if (!file) return res.status(404).json({ message: 'File not found' });

    file.annotations.push({ type, data, createdBy: req.user.id });
    await file.save();
    res.status(201).json({ message: 'Annotation saved.' });
});

router.get('/files/:id/analytics', auth.protectApi, async (req, res) => {
    const file = await File.findOne({ _id: req.params.id, owner: req.user.id });
    if (!file) return res.status(404).json({ message: 'File not found.' });

    const analytics = await LinkVisit.aggregate([
        { $match: { file: file._id } },
        { $group: { 
            _id: "$geo.country",
            views: { $sum: { $cond: [{ $eq: ["$type", "view"] }, 1, 0] } },
            downloads: { $sum: { $cond: [{ $eq: ["$type", "download"] }, 1, 0] } }
        }},
        { $sort: { downloads: -1, views: -1 } }
    ]);
    await logDeveloperRequest(req, 'analytics', {
        meta: { fileId: String(file._id), buckets: analytics.length }
    });
    res.json(analytics);
});
router.post('/files/:alias/react', auth.protectApi, async (req, res) => {
    const { type } = req.body;
    const file = await File.findOne({ customAlias: req.params.alias });
    if (!file) return res.status(404).json({ message: 'File not found' });

    const userId = req.user.id;
    if (!file.reactions) file.reactions = { like: [], love: [] };
    
    const list = file.reactions[type];
    const idx = list.indexOf(userId);
    if (idx === -1) list.push(userId); else list.splice(idx, 1);
    
    await file.save();
    res.json({ message: 'Reaction updated', counts: { like: file.reactions.like.length, love: file.reactions.love.length } });
});

router.post('/teams', auth.protectApi, async (req, res) => {
    const { name } = req.body;
    const cleanName = sanitizeFilename(name);
    const team = new Team({ name: cleanName, owner: req.user.id, members: [req.user.id] });
    await team.save();
    req.user.teams.push(team._id);
    await req.user.save();
    res.status(201).json({ message: 'Team created', team });
});

router.post('/teams/:id/add', auth.protectApi, async (req, res) => {
    const { username } = req.body;
    const team = await Team.findOne({ _id: req.params.id, owner: req.user.id });
    if (!team) return res.status(404).json({ message: 'Team not found' });
    
    const member = await User.findOne({ username });
    if (!member) return res.status(404).json({ message: 'User not found' });
    
    if (!team.members.includes(member._id)) {
        team.members.push(member._id);
        await team.save();
        member.teams.push(team._id);
        await member.save();
    }
    res.json({ message: 'Member added' });
});

router.post('/file-requests', auth.protectApi, async (req, res) => {
    const { v4: uuidv4 } = await import('uuid');
    const { label, folderId } = req.body;
    const slug = uuidv4().substring(0, 8);
    const reqFile = new FileRequest({
        owner: req.user.id,
        slug,
        label: sanitizeFilename(label),
        destinationFolder: folderId || null
    });
    await reqFile.save();
    res.status(201).json({ link: `${req.protocol}://${req.get('host')}/req/${slug}` });
});

router.post('/files/:alias/request-access', auth.protectApi, async (req, res) => {
    const file = await File.findOne({ customAlias: req.params.alias });
    if (!file) return res.status(404).json({ message: 'File not found' });
    
    if (file.accessRequests.some(r => r.user.equals(req.user.id))) {
        return res.status(400).json({ message: 'Request already sent' });
    }
    file.accessRequests.push({ user: req.user.id });
    await file.save();
    res.json({ message: 'Access requested' });
});

router.put('/files/:id/access/:reqId', auth.protectApi, async (req, res) => {
    const { status } = req.body;
    const file = await File.findOne({ _id: req.params.id, owner: req.user.id });
    const reqItem = file.accessRequests.id(req.params.reqId);
    
    if (!reqItem) return res.status(404).json({ message: 'Request not found' });
    reqItem.status = status;
    
    if (status === 'approved' && !file.collaborators.some(collab => collab.user && collab.user.equals(reqItem.user))) {
        file.collaborators.push({ user: reqItem.user, role: 'viewer' });
    }
    await file.save();
    res.json({ message: `Request ${status}` });
});

router.put('/profile/settings', auth.protectApi, async (req, res) => {
    const {
        isPublicProfile,
        publicBio,
        email,
        publicTitle,
        publicThemeColor,
        profilePhotoBase64,
        publicCoverBase64
    } = req.body;
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const normalizedTitle = typeof publicTitle === 'string' ? publicTitle.trim() : '';
    const normalizedThemeColor = typeof publicThemeColor === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(publicThemeColor.trim())
        ? publicThemeColor.trim()
        : '#2563eb';

    if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ message: 'Email format is invalid.' });
    }

    if (normalizedEmail) {
        const existingUser = await User.findOne({ email: normalizedEmail, _id: { $ne: req.user.id } });
        if (existingUser) {
            return res.status(400).json({ message: 'Email already in use.' });
        }
    }

    req.user.isPublicProfile = isPublicProfile;
    req.user.publicBio = sanitizePlainText(publicBio, 500);
    req.user.email = normalizedEmail || '';
    req.user.publicTitle = normalizedTitle;
    req.user.publicThemeColor = normalizedThemeColor;
    if (typeof profilePhotoBase64 === 'string' && profilePhotoBase64.startsWith('data:image/')) {
        try {
            const storedProfilePhoto = await storeUserImageAsset(req.user.id, profilePhotoBase64, 'profile_photo');
            req.user.profilePhotoR2Key = storedProfilePhoto.r2Key;
            req.user.profilePhotoUrl = `/media/user/${req.user.id}/profile-photo?v=${Date.now()}`;
        } catch (error) {
            return res.status(413).json({ message: error.message });
        }
    }
    if (typeof publicCoverBase64 === 'string' && publicCoverBase64.startsWith('data:image/')) {
        try {
            const storedPublicCover = await storeUserImageAsset(req.user.id, publicCoverBase64, 'public_cover');
            req.user.publicCoverR2Key = storedPublicCover.r2Key;
            req.user.publicCoverUrl = `/media/user/${req.user.id}/public-cover?v=${Date.now()}`;
        } catch (error) {
            return res.status(413).json({ message: error.message });
        }
    }
    await req.user.save();
    res.json({
        message: 'Profile updated',
        profilePhotoUrl: req.user.profilePhotoUrl,
        publicCoverUrl: req.user.publicCoverUrl
    });
});

router.post('/profile/2fa/setup', auth.protectApi, async (req, res) => {
    const secret = speakeasy.generateSecret({ name: `w-upload (${req.user.username})` });
    req.user.twoFactorSecret = secret;
    await req.user.save();
    qrcode.toDataURL(secret.otpauth_url, (err, data_url) => {
        res.json({ qrCodeUrl: data_url, secret: secret.ascii });
    });
});

router.post('/profile/2fa/verify', auth.protectApi, async (req, res) => {
    const { token } = req.body;
    const verified = speakeasy.totp.verify({
        secret: req.user.twoFactorSecret.ascii,
        encoding: 'ascii',
        token
    });
    if (verified) {
        req.user.isTwoFactorEnabled = true;
        await req.user.save();
        res.status(200).json({ message: '2FA enabled.' });
    } else {
        res.status(400).json({ message: 'Invalid token.' });
    }
});

router.get('/profile/api-keys', auth.protectApi, async (req, res) => {
    const apiKeyLimit = API_KEY_LIMITS[req.user.plan] || API_KEY_LIMITS.free;
    res.json({ keys: maskApiKeys(req.user.apiKeys), limit: apiKeyLimit });
});

router.post('/profile/api-key', auth.protectApi, async (req, res) => {
    const { label } = req.body;
    const apiKeyLimit = API_KEY_LIMITS[req.user.plan] || API_KEY_LIMITS.free;
    if ((req.user.apiKeys || []).length >= apiKeyLimit) {
        return res.status(400).json({
            message: `API key limit reached for ${req.user.plan.toUpperCase()} plan.`,
            limit: apiKeyLimit
        });
    }
    const key = `wu_${crypto.randomBytes(24).toString('hex')}`;
    
    req.user.apiKeys.push({
        keyHash: hashApiKey(key),
        keyPrefix: getApiKeyPrefix(key),
        label: sanitizePlainText(label || 'Unnamed Key', 40)
    });
    await req.user.save();
    await logDeveloperRequest(req, 'api_keys', {
        statusCode: 201,
        meta: { action: 'create', used: req.user.apiKeys.length, limit: apiKeyLimit }
    });
    
    res.status(201).json({
        message: 'API Key generated.',
        key,
        label: sanitizePlainText(label || 'Unnamed Key', 40),
        limit: apiKeyLimit,
        used: req.user.apiKeys.length
    });
});

router.delete('/profile/api-key/:keyId', auth.protectApi, async (req, res) => {
    await User.updateOne(
        { _id: req.user.id },
        { $pull: { apiKeys: { _id: req.params.keyId } } }
    );
    await logDeveloperRequest(req, 'api_keys', {
        meta: { action: 'delete', keyId: req.params.keyId }
    });
    res.json({ message: 'API Key revoked.' });
});

// --- Routes Management Webhook ---

router.get('/profile/webhook', auth.protectApi, async (req, res) => {
    res.json({
        webhook: {
            url: req.user.webhook?.url || '',
            isActive: Boolean(req.user.webhook?.isActive),
            secret: req.user.webhook?.secret ? 'configured' : '',
            deliveries: (req.user.webhook?.deliveries || []).map((entry) => ({
                event: entry.event,
                status: entry.status,
                responseStatus: entry.responseStatus || 0,
                retryCount: entry.retryCount || 0,
                maxRetries: entry.maxRetries || 0,
                endpoint: entry.endpoint || '',
                error: entry.error || '',
                deliveredAt: entry.deliveredAt || null,
                lastAttemptAt: entry.lastAttemptAt || null
            }))
        }
    });
});

router.post('/profile/webhook', auth.protectApi, async (req, res) => {
    const { url, secret, isActive } = req.body;
    let safeUrl = '';

    if (typeof url === 'string' && url.trim()) {
        try {
            safeUrl = await assertSafeOutboundUrl(url);
        } catch (error) {
            return res.status(400).json({ message: error.message });
        }
    }
    
    req.user.webhook = {
        url: safeUrl,
        secret: secret ? sanitizeWebhookSecret(secret) : req.user.webhook.secret,
        isActive: isActive === undefined ? true : isActive
    };
    
    await req.user.save();
    await logDeveloperRequest(req, 'webhook', {
        meta: { action: 'save', isActive: req.user.webhook.isActive, hasSecret: Boolean(req.user.webhook.secret) }
    });
    res.json({
        message: 'Webhook configuration saved.',
        webhook: {
            url: req.user.webhook.url,
            isActive: req.user.webhook.isActive,
            secret: req.user.webhook.secret ? 'configured' : '',
            deliveries: (req.user.webhook?.deliveries || []).map((entry) => ({
                event: entry.event,
                status: entry.status,
                responseStatus: entry.responseStatus || 0,
                retryCount: entry.retryCount || 0,
                maxRetries: entry.maxRetries || 0,
                endpoint: entry.endpoint || '',
                error: entry.error || '',
                deliveredAt: entry.deliveredAt || null,
                lastAttemptAt: entry.lastAttemptAt || null
            }))
        }
    });
});

router.post('/profile/webhook/test', auth.protectApi, async (req, res) => {
    const result = await triggerWebhook(req.user, 'test.ping', { message: 'This is a test webhook.' });
    await logDeveloperRequest(req, 'webhook', {
        meta: { action: 'test', delivered: Boolean(result?.delivered), responseStatus: result?.responseStatus || 0 }
    });
    res.json({
        message: result?.delivered ? 'Test webhook delivered.' : 'Test webhook attempted.',
        delivery: result || null,
        webhook: {
            deliveries: (req.user.webhook?.deliveries || []).map((entry) => ({
                event: entry.event,
                status: entry.status,
                responseStatus: entry.responseStatus || 0,
                retryCount: entry.retryCount || 0,
                maxRetries: entry.maxRetries || 0,
                endpoint: entry.endpoint || '',
                error: entry.error || '',
                deliveredAt: entry.deliveredAt || null,
                lastAttemptAt: entry.lastAttemptAt || null
            }))
        }
    });
});
router.get('/profile/devices', auth.protectApi, async (req, res) => {
    const user = await User.findById(req.user.id);
    res.json({ sessions: user.sessions });
});

router.delete('/profile/devices/:deviceId', auth.protectApi, async (req, res) => {
    await User.updateOne(
        { _id: req.user.id },
        { $pull: { sessions: { deviceId: req.params.deviceId } } }
    );
    res.json({ message: 'Device logged out.' });
});

router.delete('/profile/devices', auth.protectApi, async (req, res) => {
    const currentToken = req.cookies.refresh_token; 
    await User.updateOne(
        { _id: req.user.id },
        { $pull: { sessions: { refreshToken: { $ne: currentToken } } } }
    );
    res.json({ message: 'All other devices logged out.' });
});

router.post('/files/:id/import', auth.protectApi, async (req, res) => {
    try {
        const originalFile = await loadAccessibleFileById(req.params.id, req.user, {
            allowedCollaboratorRoles: ['viewer', 'uploader', 'editor']
        });
        if (!originalFile || originalFile.deletedAt) return res.status(404).json({ message: 'File not found' });

        const newAlias = await ensureUniqueAlias(
            `${path.basename(originalFile.originalName, path.extname(originalFile.originalName))}_imported_${Date.now()}${path.extname(originalFile.originalName)}`,
            originalFile.originalName
        );
        
        const newFile = new File({
            originalName: originalFile.originalName,
            customAlias: newAlias,
            contentType: originalFile.contentType,
            size: originalFile.size,
            base64: originalFile.base64,
            storageType: originalFile.storageType,
            r2Key: originalFile.r2Key,
            owner: req.user.id,
            md5Hash: originalFile.md5Hash,
            sha256Hash: originalFile.sha256Hash,
            virusScan: originalFile.virusScan
        });

        await saveFileWithUniqueAlias(newFile, originalFile.originalName);
        res.status(201).json({ message: 'File saved to your account successfully.', url: `/w-upload/file/${newAlias}` });
    } catch (error) {
        res.status(500).json({ message: 'Import failed.' });
    }
});

router.get('/files/:alias/qrcode', async (req, res) => {
    try {
        const file = await File.findOne({ customAlias: req.params.alias });
        if (!file) return res.status(404).send('File not found');
        
        const url = `${req.protocol}://${req.get('host')}/w-upload/file/${file.customAlias}`;
        const qr = await qrcode.toDataURL(url);
        res.json({ qrCode: qr });
    } catch (e) {
        res.status(500).json({ message: 'QR Generation failed' });
    }
});

router.post('/files/:id/scan', auth.protectApi, async (req, res) => {
    try {
        const file = await loadAccessibleFileById(req.params.id, req.user, {
            allowedCollaboratorRoles: ['viewer', 'uploader', 'editor']
        });
        if (!file) return res.status(404).json({ message: 'File not found' });
        if (!file.virusScan) {
            file.virusScan = { status: 'unscanned' };
        }

        if (file.virusScan.status === 'clean' || file.virusScan.status === 'infected') {
            return res.json({ status: file.virusScan.status, permalink: file.virusScan.permalink });
        }

        if (!file.sha256Hash) {
            let buffer;
            if (file.storageType === 'r2' && file.r2Key) {
                buffer = await getR2ObjectBuffer(file.r2Key);
            } else if (file.base64) {
                buffer = Buffer.from(file.base64.split(',')[1], 'base64');
            } else {
                return res.status(400).json({ message: 'File content unavailable for scanning.' });
            }
            file.sha256Hash = crypto.createHash('sha256').update(buffer).digest('hex');
            await file.save();
        }

        const vtResponse = await axios.get(`https://www.virustotal.com/api/v3/files/${file.sha256Hash}`, {
            headers: { 'x-apikey': process.env.VT_API_KEY }
        });

        const stats = vtResponse.data.data.attributes.last_analysis_stats;
        const status = stats.malicious > 0 ? 'infected' : 'clean';
        const permalink = vtResponse.data.data.links.self; 

        file.virusScan = { status, lastChecked: new Date(), permalink };
        await file.save();

        res.json({ status, permalink });
    } catch (error) {
        if (error.response && error.response.status === 404) {
             return res.json({ status: 'unknown', message: 'File not found in VirusTotal database yet.' });
        }
        res.status(500).json({ message: 'Scan failed' });
    }
});

router.post('/report/:identifier', async (req, res) => {
    const { reason, category } = req.body;
    const file = await File.findOne({ customAlias: req.params.identifier });
    if (!file) return res.status(404).json({ message: 'File not found.' });
    file.reports.push({ reason: category ? `${category}: ${reason}` : reason });
    await file.save();
    res.status(200).json({ message: 'Report submitted.' });
});

router.post('/profile/passkey/register-options', auth.protectApi, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(401).json({ error: "User not authenticated." });
        }
        
        const options = await generatePasskeyRegistrationOptions(user);
        res.json(options);
    } catch (e) {
        console.error("API Error - Register Options:", e);
        res.status(500).json({ error: e.message || "Server error generating passkey options." });
    }
});

router.post('/profile/passkey/verify-registration', auth.protectApi, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(401).json({ error: "User not authenticated." });
        
        // Mengirim req.body utuh sangat penting
        const verification = await verifyPasskeyRegistration(user, req.body);
        res.json({ verified: verification.verified });
    } catch (error) {
        console.error("API Error - Verify Registration:", error);
        res.status(400).json({ error: error.message });
    }
});

router.delete('/profile/passkey/:id', auth.protectApi, async (req, res) => {
    try {
        // Handle base64url or standard base64 from URL params
        const credentialIdBuffer = Buffer.from(req.params.id, 'base64url');
        
        await User.updateOne(
            { _id: req.user.id },
            { $pull: { passkeys: { credentialID: credentialIdBuffer } } }
        );

        res.json({ message: 'Passkey removed.' });
    } catch (e) {
        console.error("API Error - Remove Passkey:", e);
        res.status(500).json({ error: 'Failed to remove passkey.' });
    }
});

// --- PASSKEY LOGIN (PUBLIC) ---

router.post('/auth/passkey/login-options', async (req, res) => {
    try {
        const { username } = req.body;
        
        let user;
        if (username) {
            user = await User.findOne({ username });
        }

        const options = await generatePasskeyLoginOptions(user);
        
        // Simpan challenge sementara di session/cookie jika user tidak ditemukan (opsional)
        // Namun karena implementasi passkey.js Anda menyimpan challenge di DB User, 
        // maka username wajib ada untuk flow ini.
        if (!user) {
             return res.status(404).json({ error: "User not found." });
        }

        res.json(options);
    } catch (e) {
        console.error("API Error - Login Options:", e);
        res.status(500).json({ error: "Server error generating login options." });
    }
});

router.post('/auth/passkey/verify-login', async (req, res) => {
    try {
        const { username, response } = req.body;
        
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(404).json({ error: "User not found." });
        }

        const verification = await verifyPasskeyLogin(user, response);
        
        if (verification.verified) {
            // Generate JWT Token atau Session di sini sesuai logika auth Anda
            // Contoh: const token = signToken(user._id);
            // res.json({ verified: true, token });
            
            res.json({ verified: true, message: "Login successful" });
        } else {
            res.status(400).json({ error: "Verification failed." });
        }
    } catch (error) {
        console.error("API Error - Verify Login:", error);
        res.status(400).json({ error: error.message });
    }
});

router.post('/files/:id/ocr', auth.protectApi, async (req, res) => {
    try {
        const file = await loadAccessibleFileById(req.params.id, req.user, {
            allowedCollaboratorRoles: ['editor']
        });
        if (!file || !file.contentType.startsWith('image/')) {
            return res.status(404).json({ message: 'Image file not found.' });
        }
        if (file.storageType !== 'r2' || !file.r2Key) {
            return res.status(400).json({ message: 'File is not stored in a processable location.' });
        }
        if (Number(file.size || 0) > MAX_OCR_BYTES) {
            return res.status(413).json({ message: 'Image is too large for inline OCR processing.' });
        }

        const buffer = await getR2ObjectBuffer(file.r2Key);

        const { data: { text } } = await Tesseract.recognize(buffer, 'eng');
        await logDeveloperRequest(req, 'ocr', {
            bytes: Number(file.size || 0),
            meta: { fileId: String(file._id), extractedChars: text.length }
        });
        res.json({ text });
    } catch (error) {
        res.status(500).json({ message: 'OCR process failed.', error: error.message });
    }
});

// Endpoint untuk konversi file
router.post('/files/:id/convert', auth.protectApi, async (req, res) => {
    const { toFormat } = req.body; // e.g., 'pdf', 'jpg'
    try {
        const file = await loadAccessibleFileById(req.params.id, req.user, {
            allowedCollaboratorRoles: ['editor']
        });
        if (!file) return res.status(404).json({ message: 'File not found.' });
        if (file.storageType !== 'r2') return res.status(400).json({ message: 'File not processable.' });
        if (Number(file.size || 0) > MAX_CONVERT_BYTES) {
            return res.status(413).json({ message: 'File is too large for inline conversion.' });
        }
        const targetFormat = String(toFormat || '').toLowerCase();
        const inputBuffer = await getR2ObjectBuffer(file.r2Key);

        let outputBuffer;
        let newContentType;
        const tempDir = path.join(__dirname, '..', 'temp');
        const tempFilePath = path.join(tempDir, file.r2Key.split('/').pop());
        const outputFilePath = `${tempFilePath}.${targetFormat}`;

        if (file.contentType.includes('docx') && targetFormat === 'pdf') {
            await fs.promises.mkdir(tempDir, { recursive: true });
            await fs.promises.writeFile(tempFilePath, inputBuffer);
            await new Promise((resolve, reject) => {
                docxConverter(tempFilePath, outputFilePath, (err, result) => {
                    if (err) return reject(err);
                    resolve(result);
                });
            });
            outputBuffer = await fs.promises.readFile(outputFilePath);
            newContentType = 'application/pdf';
        } else if (file.contentType.startsWith('image/') && ['jpg', 'jpeg', 'png', 'webp'].includes(targetFormat)) {
            const transformer = sharp(inputBuffer);
            if (targetFormat === 'png') outputBuffer = await transformer.png().toBuffer();
            else if (targetFormat === 'webp') outputBuffer = await transformer.webp().toBuffer();
            else outputBuffer = await transformer.jpeg().toBuffer();
            newContentType = targetFormat === 'png' ? 'image/png' : targetFormat === 'webp' ? 'image/webp' : 'image/jpeg';
        } else {
            return res.status(400).json({ message: 'Conversion not supported.' });
        }

        const finalAlias = await ensureUniqueAlias(
            `${path.basename(file.originalName, path.extname(file.originalName))}_converted.${targetFormat}`,
            `${path.basename(file.originalName, path.extname(file.originalName))}.${targetFormat}`
        );
        const r2Key = await uploadBufferToR2(req.user.id, finalAlias, outputBuffer, newContentType);

        const newFile = new File({
            originalName: finalAlias,
            customAlias: finalAlias,
            contentType: newContentType,
            size: outputBuffer.length,
            storageType: 'r2',
            r2Key,
            owner: req.user.id,
            parentId: file.parentId
        });
        await saveFileWithUniqueAlias(newFile, finalAlias);
        await fs.promises.rm(tempFilePath, { force: true }).catch(() => {});
        await fs.promises.rm(outputFilePath, { force: true }).catch(() => {});
        
        triggerWebhook(req.user, 'file.converted', { originalFileId: file._id, newFileId: newFile._id, newFileAlias: newFile.customAlias });
        res.status(201).json({ message: 'File converted successfully.', newFile });
    } catch (error) {
        res.status(500).json({ message: 'Conversion failed.', error: error.message });
    }
});

// Endpoint untuk mengekstrak arsip
// Endpoint untuk mengekstrak arsip (SEKARANG PUBLIK)
router.post('/files/:id/extract', auth.protectApi, async (req, res) => {
    try {
        const user = req.user;
        const file = await loadAccessibleFileById(req.params.id, user, {
            allowedCollaboratorRoles: ['editor']
        });
        if (!file || !file.contentType.includes('zip') || file.storageType !== 'r2') {
            return res.status(400).json({ message: 'File is not a processable zip archive.' });
        }
        if (Number(file.size || 0) > MAX_EXTRACT_ARCHIVE_BYTES) {
            return res.status(413).json({ message: 'Archive is too large for inline extraction.' });
        }

        const ownerId = user._id;
        const destinationParentId = file.parentId || null;
        const folderCache = new Map();
        folderCache.set('', destinationParentId ? String(destinationParentId) : '');

        async function ensureArchiveFolder(relativePath = '') {
            const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            if (!normalized) return destinationParentId;
            if (folderCache.has(normalized)) {
                const cached = folderCache.get(normalized);
                return cached || null;
            }

            const segments = normalized.split('/').filter(Boolean);
            let currentParentId = destinationParentId;
            let builtPath = '';

            for (const segment of segments) {
                builtPath = builtPath ? `${builtPath}/${segment}` : segment;
                if (folderCache.has(builtPath)) {
                    currentParentId = folderCache.get(builtPath) || null;
                    continue;
                }

                const safeSegment = sanitizeFilename(segment) || 'folder';
                const existingFolder = await File.findOne({
                    owner: ownerId,
                    parentId: currentParentId || null,
                    isFolder: true,
                    deletedAt: null,
                    originalName: safeSegment
                });

                if (existingFolder) {
                    currentParentId = existingFolder._id;
                    folderCache.set(builtPath, String(existingFolder._id));
                    continue;
                }

                const folderDoc = new File({
                    originalName: safeSegment,
                    customAlias: await ensureUniqueAlias(`${safeSegment}_${Date.now()}`, safeSegment),
                    isFolder: true,
                    contentType: 'application/vnd.google-apps.folder',
                    owner: ownerId,
                    parentId: currentParentId || null,
                    size: 0
                });

                await saveFileWithUniqueAlias(folderDoc, safeSegment);
                currentParentId = folderDoc._id;
                folderCache.set(builtPath, String(folderDoc._id));
            }

            return currentParentId;
        }

        const { Body } = await r2.send(new GetObjectCommand({ Bucket: getR2BucketName(), Key: file.r2Key }));
        
        const extractedFiles = [];
        const stream = Body.pipe(unzipper.Parse({ forceStream: true }));

        for await (const entry of stream) {
            if (extractedFiles.length >= MAX_EXTRACTED_FILES) {
                throw new Error('Archive contains too many files.');
            }
            const entryPath = String(entry.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
            const cleanEntryPath = entryPath
                .split('/')
                .map((segment) => sanitizeFilename(segment))
                .filter(Boolean)
                .join('/');

            if (entry.type === 'Directory') {
                await ensureArchiveFolder(cleanEntryPath);
                entry.autodrain();
                continue;
            }

            const buffer = await entry.buffer();
            const relativeDir = path.posix.dirname(cleanEntryPath);
            const targetParentId = await ensureArchiveFolder(relativeDir === '.' ? '' : relativeDir);
            const finalName = sanitizeFilename(path.posix.basename(cleanEntryPath)) || `extracted_${Date.now()}`;
            const finalAlias = await ensureUniqueAlias(`${Date.now()}_${finalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`, finalName);
            const r2Key = `${ownerId}/${finalAlias}`;
            
            await r2.send(new PutObjectCommand({
                Bucket: getR2BucketName(), Key: r2Key, Body: buffer, ContentType: 'application/octet-stream'
            }));

            const newFile = new File({
                originalName: finalName,
                customAlias: finalAlias,
                contentType: 'application/octet-stream',
                size: buffer.length,
                storageType: 'r2',
                r2Key,
                owner: ownerId,
                parentId: targetParentId || null,
                virusScan: { status: 'unscanned' }
            });
            await saveFileWithUniqueAlias(newFile, finalName);
            extractedFiles.push(newFile);
        }

        await createArchiveExtractInsight(user, file, extractedFiles);
        await logDeveloperRequest(req, 'ai_extract', {
            bytes: Number(file.size || 0),
            meta: { fileId: String(file._id), extractedCount: extractedFiles.length }
        });

        res.status(201).json({ 
            message: 'AI extract selesai di folder yang sama dengan arsip.',
            destinationFolderId: destinationParentId,
            archiveParentId: destinationParentId,
            extractedCount: extractedFiles.length,
            extractedNames: extractedFiles.slice(0, 12).map((item) => item.originalName),
            files: extractedFiles.map((item) => ({
                id: item._id,
                name: item.originalName,
                url: `${req.protocol}://${req.get('host')}/w-upload/file/${item.customAlias}`
            }))
        });
    } catch (error) {
        console.error("Extraction Error:", error);
        res.status(500).json({ message: 'Extraction failed.', error: error.message });
    }
});

// Endpoint untuk menyimpan file yang diedit dari frontend
router.post('/files/:id/save-version', auth.protectApi, async (req, res) => {
    try {
        const { base64 } = req.body;
        const file = await File.findOne({ _id: req.params.id, owner: req.user.id });
        if (!file) return res.status(404).json({ message: 'File not found.' });

        const buffer = Buffer.from(base64.split(',')[1], 'base64');
        const newR2Key = `${req.user.id}/${Date.now()}_v${file.versions.length + 2}_${file.originalName}`;
        
        await r2.send(new PutObjectCommand({
            Bucket: getR2BucketName(),
            Key: newR2Key,
            Body: buffer,
            ContentType: file.contentType
        }));

        file.versions.push({
            version: file.versions.length + 1,
            r2Key: file.r2Key,
            size: file.size,
            uploadedAt: file.updatedAt
        });

        file.r2Key = newR2Key;
        file.size = buffer.length;
        file.updatedAt = new Date();
        await file.save();

        triggerWebhook(req.user, 'file.updated', { fileId: file._id, alias: file.customAlias, newVersion: file.versions.length + 1 });
        res.json({ message: 'New version saved successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to save new version.', error: error.message });
    }
});
module.exports = router;
