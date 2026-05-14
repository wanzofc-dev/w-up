const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const DEFAULT_R2_ACCOUNT_ID = 'ec786e5c4cd0818807637b34da897d76';
const DEFAULT_R2_ENDPOINT = 'https://ec786e5c4cd0818807637b34da897d76.r2.cloudflarestorage.com';
const DEFAULT_R2_BUCKET_NAME = 'wanzofc';
const DEFAULT_R2_ACCESS_KEY_ID = 'e7ae1b337e897bac0cf15ab7c02f297e';
const DEFAULT_R2_SECRET_ACCESS_KEY = '678c88269339ab870b2e74724447a770394228bbf502ab8a7b93481dba286906';

function getR2AccountId() {
    return DEFAULT_R2_ACCOUNT_ID;
}

function getR2Endpoint() {
    const accountId = getR2AccountId();
    return accountId ? `https://${accountId}.r2.cloudflarestorage.com` : DEFAULT_R2_ENDPOINT;
}

function getR2BucketName() {
    return DEFAULT_R2_BUCKET_NAME;
}

function getR2Credentials() {
    return {
        accessKeyId: DEFAULT_R2_ACCESS_KEY_ID,
        secretAccessKey: DEFAULT_R2_SECRET_ACCESS_KEY,
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
