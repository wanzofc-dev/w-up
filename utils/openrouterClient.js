const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';
const DEFAULT_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS || 45000);
const DEFAULT_REASONING_EFFORT = process.env.OPENROUTER_REASONING_EFFORT || 'high';
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

const allowedActionTypes = new Set(['navigate', 'copy']);
const allowedRoutes = new Set([
    '/',
    '/dashboard',
    '/profile',
    '/billing',
    '/teams',
    '/docs',
    '/request'
]);

function isOpenRouterEnabled() {
    return Boolean(process.env.OPENROUTER_API_KEY);
}

function buildFactsBlock({ user, context, storageStats, recentFiles, workspaceIntel, schemaMap }) {
    return JSON.stringify({
        user: {
            username: user?.username || 'unknown',
            plan: user?.plan || 'free',
            role: user?.role || 'user',
            teamCount: Array.isArray(user?.teams) ? user.teams.length : 0
        },
        page: {
            route: context?.route || '/',
            title: context?.title || 'Unknown page',
            isMobile: Boolean(context?.isMobile),
            language: context?.language || 'en',
            theme: context?.theme || 'light',
            hasError: Boolean(context?.hasError),
            errorMessage: context?.errorMessage || null
        },
        storage: storageStats || null,
        workspaceIntel: workspaceIntel || null,
        schemaMap: schemaMap || null,
        recentFiles: Array.isArray(recentFiles)
            ? recentFiles.map(file => ({
                name: file.originalName,
                type: file.isFolder ? 'folder' : file.contentType,
                size: file.size,
                createdAt: file.createdAt
            }))
            : []
    });
}

function extractJsonObject(rawText) {
    if (!rawText || typeof rawText !== 'string') {
        return null;
    }

    const trimmed = rawText.trim();
    const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)```/i);
    const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;

    try {
        return JSON.parse(candidate);
    } catch (error) {
        const firstBrace = candidate.indexOf('{');
        const lastBrace = candidate.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
            return null;
        }

        try {
            return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
        } catch (nestedError) {
            return null;
        }
    }
}

function sanitizeAction(action) {
    if (!action || typeof action !== 'object' || !allowedActionTypes.has(action.type)) {
        return null;
    }

    if (action.type === 'navigate') {
        if (!allowedRoutes.has(action.url)) {
            return null;
        }

        return { type: 'navigate', url: action.url };
    }

    if (action.type === 'copy') {
        const text = typeof action.text === 'string' ? action.text.trim() : '';
        if (!text) {
            return null;
        }

        return { type: 'copy', text: text.slice(0, 1000) };
    }

    return null;
}

function sanitizeHistory(history) {
    if (!Array.isArray(history)) {
        return [];
    }

    return history
        .slice(-10)
        .map(message => {
            if (!message || typeof message !== 'object') {
                return null;
            }

            const role = message.role === 'assistant' ? 'assistant' : 'user';
            const content = typeof message.content === 'string' ? message.content.trim().slice(0, 4000) : '';
            if (!content) {
                return null;
            }

            const sanitized = { role, content };

            if (role === 'assistant' && Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0) {
                sanitized.reasoning_details = message.reasoning_details;
            }

            return sanitized;
        })
        .filter(Boolean);
}

async function requestOpenRouterReply({ message, history, user, context, storageStats, recentFiles, workspaceIntel, schemaMap }) {
    if (!isOpenRouterEnabled()) {
        return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    const developerPrompt = [
        'You are the AI assistant inside the w-up web application.',
        'You help users understand files, storage, uploads, teams, and navigation inside the app.',
        'You are answering from the deployed website through OpenRouter.',
        'You can analyze workspace intelligence, AI insights, AI logs, file requests, files, link visits, payment transactions, public requests, system configs, teams, upload sessions, and user security posture when those facts are provided.',
        'You should proactively highlight cyber-risk indicators such as suspicious login spikes, unscanned files, infected files, overly public assets, disabled 2FA, and unusual active sessions.',
        'Return valid JSON only with this exact shape: {"response":"markdown reply","action":null|{"type":"navigate","url":"allowed route"}|{"type":"copy","text":"value"}}.',
        'Allowed navigate routes are only: /, /dashboard, /profile, /billing, /teams, /docs, /request.',
        'Use action.copy only when the user explicitly asks to copy a value or link.',
        'Do not pretend you changed files, renamed uploads, shared documents, deleted data, or created folders unless the server already confirmed it elsewhere.',
        'For destructive or state-changing requests, give concise guidance and tell the user the built-in app actions may be needed.',
        'Answer in the same language as the user whenever possible.',
        'Keep the answer concise and practical.'
    ].join(' ');

    const messages = [
        {
            role: 'system',
            content: developerPrompt
        },
        {
            role: 'system',
            content: `Application facts: ${buildFactsBlock({ user, context, storageStats, recentFiles, workspaceIntel, schemaMap })}`
        },
        ...sanitizeHistory(history),
        {
            role: 'user',
            content: message
        }
    ];

    try {
        const response = await fetch(OPENROUTER_CHAT_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.APP_URL || 'https://localhost',
                'X-Title': process.env.APP_NAME || 'w-up'
            },
            body: JSON.stringify({
                model: DEFAULT_MODEL,
                messages,
                reasoning: {
                    effort: DEFAULT_REASONING_EFFORT
                }
            })
        });

        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload?.error?.message || `OpenRouter error ${response.status}`);
        }

        const choice = payload?.choices?.[0];
        const replyMessage = choice?.message || {};
        const rawContent = typeof replyMessage.content === 'string'
            ? replyMessage.content
            : Array.isArray(replyMessage.content)
                ? replyMessage.content.map(part => part?.text || '').join('\n')
                : '';

        const parsed = extractJsonObject(rawContent);
        if (!parsed || typeof parsed.response !== 'string' || !parsed.response.trim()) {
            return null;
        }

        return {
            response: parsed.response.trim(),
            action: sanitizeAction(parsed.action),
            assistantMessage: {
                role: 'assistant',
                content: rawContent,
                reasoning_details: Array.isArray(replyMessage.reasoning_details) ? replyMessage.reasoning_details : [],
                reasoning: typeof replyMessage.reasoning === 'string' ? replyMessage.reasoning : null
            },
            usage: payload?.usage || null,
            model: payload?.model || DEFAULT_MODEL
        };
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = {
    isOpenRouterEnabled,
    requestOpenRouterReply
};
