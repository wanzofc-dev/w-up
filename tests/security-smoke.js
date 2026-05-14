const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const {
    assertSafeOutboundUrl,
    getApiKeyPrefix,
    hashApiKey
} = require('../utils/security');
const { translateBatch } = require('../utils/tr');

async function expectReject(promiseFactory, matcher) {
    let rejected = false;
    try {
        await promiseFactory();
    } catch (error) {
        rejected = true;
        if (matcher) {
            assert.match(String(error.message || error), matcher);
        }
    }
    assert.ok(rejected, 'Expected promise to reject');
}

async function main() {
    const hashed = hashApiKey('wu_test_key');
    assert.strictEqual(hashed.length, 64);
    assert.strictEqual(getApiKeyPrefix('wu_test_key_123456'), 'wu_test_key_');

    const safeUrl = await assertSafeOutboundUrl('https://example.com/webhook');
    assert.ok(safeUrl.startsWith('https://example.com'));

    await expectReject(() => assertSafeOutboundUrl('http://127.0.0.1:3000'), /private/i);
    await expectReject(() => assertSafeOutboundUrl('http://localhost:3000'), /private/i);

    const translations = await translateBatch(['Dashboard', 'Profile'], 'id', 'en');
    assert.ok(Array.isArray(translations));
    assert.strictEqual(translations.length, 2);

    const html = await ejs.renderFile(path.resolve(__dirname, '..', 'views', 'editor_image.ejs'), {
        title: 'Image Editor',
        file: { _id: '1', originalName: 'sample.jpg', customAlias: 'sample.jpg' },
        downloadLink: '/w-upload/raw/sample.jpg',
        csrfToken: 'x',
        availableLanguages: [],
        locals: { isLoggedIn: false, currentUrl: '', systemConfig: null }
    });

    assert.ok(html.includes('window.__disablePageTranslation = true'));
    assert.ok(html.includes('bootImageEditor'));
    assert.ok(!html.includes("theme: 'dark'"));

    const docsHtml = await ejs.renderFile(path.resolve(__dirname, '..', 'views', 'docs.ejs'), {
        csrfToken: 'x',
        availableLanguages: [],
        locals: { isLoggedIn: false, currentUrl: '', systemConfig: null }
    });

    assert.ok(docsHtml.includes('Shown once on create'));
    assert.ok(docsHtml.includes('/api/upload'));

    const dashboardHtml = await ejs.renderFile(path.resolve(__dirname, '..', 'views', 'dashboard.ejs'), {
        csrfToken: 'x',
        availableLanguages: [],
        query: {},
        currentFolder: null,
        breadcrumbs: [],
        dashboardStats: {
            ownedFiles: 5,
            ownedFolders: 0,
            sharedItems: 0,
            totalDownloads: 2,
            currentUsage: 1024
        },
        files: [],
        user: { storageLimit: 10 * 1024 * 1024 * 1024, storageBonus: 0, storageUsed: 1024 },
        locals: { isLoggedIn: false, currentUrl: '', systemConfig: null }
    });

    assert.ok(dashboardHtml.includes('uploadProgressModal'));
    assert.ok(dashboardHtml.includes('statOwnedFiles'));
    assert.ok(dashboardHtml.includes('Live Upload Queue'));

    console.log('security-smoke: ok');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
