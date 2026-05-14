const axios = require('axios');
const crypto = require('crypto');
const { assertSafeOutboundUrl } = require('./security');

async function triggerWebhook(user, event, data) {
    if (!user.webhook || !user.webhook.isActive || !user.webhook.url) return;

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

    try {
        const safeUrl = await assertSafeOutboundUrl(user.webhook.url);
        await axios.post(safeUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'X-Webhook-Signature': signature,
                'User-Agent': 'W-Upload-Webhook/1.0'
            },
            timeout: 5000,
            maxRedirects: 0
        });
    } catch (error) {
        console.error(`Webhook failed for user ${user._id}:`, error.message);
    }
}

module.exports = { triggerWebhook };
