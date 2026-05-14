const axios = require('axios');
const crypto = require('crypto');
const { assertSafeOutboundUrl } = require('./security');

async function triggerWebhook(user, event, data) {
    if (!user.webhook || !user.webhook.isActive || !user.webhook.url) return null;

    const payload = {
        event: event,
        timestamp: new Date().toISOString(),
        data: data
    };

    const payloadString = JSON.stringify(payload);
    const signature = crypto
        .createHmac('sha256', user.webhook.secret || '')
        .update(payloadString)
        .digest('hex');

    const safeUrl = await assertSafeOutboundUrl(user.webhook.url);
    const maxRetries = 2;
    let responseStatus = 0;
    let lastError = '';
    let delivered = false;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
            const response = await axios.post(safeUrl, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Webhook-Signature': signature,
                    'User-Agent': 'W-Upload-Webhook/1.0'
                },
                timeout: 5000,
                maxRedirects: 0,
                validateStatus: () => true
            });

            responseStatus = Number(response.status || 0);
            if (response.status >= 200 && response.status < 300) {
                delivered = true;
                lastError = '';
                break;
            }

            lastError = `Endpoint responded with status ${response.status}`;
        } catch (error) {
            responseStatus = Number(error.response?.status || 0);
            lastError = error.message;
        }
    }

    try {
        user.webhook.deliveries = [{
            event,
            status: delivered ? 'delivered' : 'failed',
            responseStatus,
            retryCount: maxRetries,
            maxRetries,
            endpoint: safeUrl,
            error: lastError,
            deliveredAt: delivered ? new Date() : null,
            lastAttemptAt: new Date()
        }, ...(user.webhook.deliveries || [])].slice(0, 25);
        await user.save();
    } catch (saveError) {
        console.error(`Webhook log save failed for user ${user._id}:`, saveError.message);
    }

    if (!delivered) {
        console.error(`Webhook failed for user ${user._id}:`, lastError || `HTTP ${responseStatus}`);
    }

    return {
        delivered,
        responseStatus,
        retryCount: maxRetries,
        error: lastError
    };
}

module.exports = { triggerWebhook };
