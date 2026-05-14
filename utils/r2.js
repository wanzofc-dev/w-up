const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const DEFAULT_R2_ACCOUNT_ID = 'ec786e5c4cd0818807637b34da897d76';
const DEFAULT_R2_ENDPOINT = 'https://ec786e5c4cd0818807637b34da897d76.r2.cloudflarestorage.com';
const DEFAULT_R2_BUCKET_NAME = 'wanzofc';

function getR2AccountId() {
    return process.env.R2_ACCOUNT_ID || DEFAULT_R2_ACCOUNT_ID;
}

function getR2Endpoint() {
    if (process.env.R2_ENDPOINT) {
        return process.env.R2_ENDPOINT;
    }

    const accountId = getR2AccountId();
    return accountId
        ? `https://${accountId}.r2.cloudflarestorage.com`
        : DEFAULT_R2_ENDPOINT;
}

function getR2BucketName() {
    return process.env.R2_BUCKET_NAME || DEFAULT_R2_BUCKET_NAME;
}

function getR2Credentials() {
    if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
        throw new Error('R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be defined.');
    }

    return {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    };
}

const r2 = new S3Client({
    region: 'auto',
    endpoint: getR2Endpoint(),
    credentials: getR2Credentials(),
});

module.exports = {
    r2,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    getSignedUrl,
    getR2AccountId,
    getR2BucketName,
    getR2Endpoint,
    getR2Credentials,
};
