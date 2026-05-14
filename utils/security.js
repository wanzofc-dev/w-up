const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const PRIVATE_HOSTNAMES = new Set([
    'localhost',
    'localhost.localdomain',
]);

function hashApiKey(value = '') {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function getApiKeyPrefix(value = '') {
    return String(value).slice(0, 12);
}

function isPrivateIpv4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) return true;

    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;

    return false;
}

function isPrivateIpv6(ip) {
    const normalized = String(ip || '').toLowerCase();
    if (!normalized || normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fe80:')) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

    const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedIpv4) {
        return isPrivateIpv4(mappedIpv4[1]);
    }

    return false;
}

function isPrivateIpAddress(ip) {
    const ipVersion = net.isIP(ip);
    if (ipVersion === 4) return isPrivateIpv4(ip);
    if (ipVersion === 6) return isPrivateIpv6(ip);
    return true;
}

function sanitizePageTitle(value = '') {
    return String(value).replace(/\s+/g, ' ').trim().slice(0, 80);
}

function sanitizePlainText(value = '', maxLength = 500) {
    return String(value).replace(/\0/g, '').trim().slice(0, maxLength);
}

function sanitizeWebhookSecret(value = '') {
    return String(value).replace(/\0/g, '').trim().slice(0, 200);
}

async function assertSafeOutboundUrl(rawUrl) {
    let parsedUrl;
    try {
        parsedUrl = new URL(String(rawUrl || '').trim());
    } catch (error) {
        throw new Error('Invalid URL.');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Only HTTP and HTTPS URLs are allowed.');
    }

    if (parsedUrl.username || parsedUrl.password) {
        throw new Error('Credentials in URL are not allowed.');
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    if (
        PRIVATE_HOSTNAMES.has(hostname) ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal') ||
        hostname.endsWith('.localhost')
    ) {
        throw new Error('Private network targets are not allowed.');
    }

    if (net.isIP(hostname) && isPrivateIpAddress(hostname)) {
        throw new Error('Private IP targets are not allowed.');
    }

    const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!resolved.length) {
        throw new Error('Could not resolve target host.');
    }

    if (resolved.some(entry => isPrivateIpAddress(entry.address))) {
        throw new Error('Resolved target points to a private network.');
    }

    return parsedUrl.toString();
}

module.exports = {
    assertSafeOutboundUrl,
    getApiKeyPrefix,
    hashApiKey,
    sanitizePageTitle,
    sanitizePlainText,
    sanitizeWebhookSecret,
};
